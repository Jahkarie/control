// payments.js: payment instructions, pay-by deadline, auto-expiry and reminder emails.
import { WM_LITE } from './brand.js';
import { renderEmail } from './emails.js';
import { promoLabel } from './pricing.js';
import { getSizeLock, isSizeLocked } from './pickup.js';
import { CUR } from './events.js';
import { qrSecret } from './liveqr.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ANTIGUA_MS = 4 * 60 * 60 * 1000; // Antigua is UTC-4 all year (no daylight saving)
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// SQL for a reserved order's deadline (NULL = none). p is the placeholder holding the current pay_days, e.g. '$1'.
// New orders store their deadline in pay_by. Older ones keep the days-to-pay they were reserved under
// (orders.pay_days; 0 = no deadline), and the oldest, from before that column, use the current setting.
export const dueSql = (p) => `COALESCE(o.pay_by, CASE WHEN COALESCE(o.pay_days, ${p}::int) > 0
    THEN o.created_at + make_interval(days => COALESCE(o.pay_days, ${p}::int)) END)`;

// The "How to pay" text: the general instructions, then the package's own cash details.
const howToPay = (instructions, payNote) => [instructions, payNote].map((t) => (t || '').trim()).filter(Boolean).join('\n\n');

export function registerPayments({ app, pool, resend, EMAIL_FROM, FRONTEND_URL, TOKEN_SECRET, requireAuth, requireRole, escapeHtml, beforeExpire }) {
  // pay_rule 'days': pay within pay_days days of reserving (0 = no deadline).
  // pay_rule 'weekday': pay by the next pay_weekday (0 = Sunday) at pay_time, Antigua time.
  async function getSettings() {
    const r = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('payment_instructions', 'pay_days', 'pay_rule', 'pay_weekday', 'pay_time')");
    const s = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
    const days = parseInt(s.pay_days, 10);
    const weekday = parseInt(s.pay_weekday, 10);
    return {
      instructions: s.payment_instructions || '',
      payDays: Number.isNaN(days) ? 3 : days,
      payRule: s.pay_rule === 'weekday' ? 'weekday' : 'days',
      payWeekday: weekday >= 0 && weekday <= 6 ? weekday : 5,
      payTime: TIME_RE.test(s.pay_time || '') ? s.pay_time : '18:00'
    };
  }

  // The deadline for a reservation made at createdAt under these settings (from getSettings()), or null for none.
  // With the weekday rule it's the first chosen weekday at the chosen time that is at least 24 hours away.
  function deadlineFor(createdAt, settings) {
    const start = new Date(createdAt).getTime();
    if (settings.payRule !== 'weekday') return settings.payDays > 0 ? new Date(start + settings.payDays * DAY_MS) : null;
    const [h, m] = settings.payTime.split(':').map(Number);
    const earliest = start + DAY_MS;
    const local = new Date(earliest - ANTIGUA_MS); // Antigua's clock, read with the UTC getters
    const ahead = (settings.payWeekday - local.getUTCDay() + 7) % 7;
    let due = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + ahead, h, m) + ANTIGUA_MS;
    if (due < earliest) due += 7 * DAY_MS;
    return new Date(due);
  }

  const payBy = (createdAt, payDays) => new Date(new Date(createdAt).getTime() + payDays * DAY_MS);
  const fmt = (d) => d.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Antigua' });

  // Sends an email built by renderEmail(). Returns an error (or null). Never throws.
  // attachments: optional [{ filename, content: Buffer }].
  async function send(to, subject, email, attachments) {
    try {
      const { error } = await resend.emails.send({ from: EMAIL_FROM, to, subject, html: email.html, text: email.text, ...(attachments ? { attachments } : {}) });
      if (error) { console.error('Email failed:', subject, error); return error; }
      return null;
    } catch (err) {
      console.error('Email threw:', subject, err);
      return err;
    }
  }

  async function tick() {
    try {
      const { instructions, payDays } = await getSettings();
      // PayPal payments that went through must count before anything is cancelled (see paypal.js).
      if (beforeExpire) await beforeExpire(payDays).catch((err) => console.error('PayPal check error:', err.message));
      // Each order's deadline (see dueSql). NULL = no deadline, so the comparisons below are never true for it.
      const DUE = dueSql('$1');

      // 1. Expire unpaid orders past the deadline (this also frees capacity). A PayPal checkout started in the
      //    last 30 minutes, or a PayPal payment PayPal is still processing, gets more time.
      const expired = await pool.query(
        `UPDATE orders o SET status = 'CANCELLED' FROM packages p
         WHERE p.id = o.package_id AND o.status = 'RESERVED' AND o.event_id = ${CUR}
           AND ${DUE} < NOW()
           AND (o.paypal_started_at IS NULL OR o.paypal_started_at < NOW() - INTERVAL '30 minutes')
           AND o.paypal_status IS DISTINCT FROM 'PENDING'
         RETURNING o.guest_email, o.reference_code, p.name AS package_name`, [payDays]);
      for (const o of expired.rows) {
        await send(o.guest_email, "Your reservation expired — On D' Road", renderEmail({
          tone: 'bad', tag: 'Reservation expired', title: 'Time ran out',
          lines: [`Your reservation for ${o.package_name} was cancelled because it wasn't paid in time.`,
            'If spots are still open, you can reserve again from your account.'],
          details: [['Reference', o.reference_code, true]],
          cta: { text: 'Open my account', url: FRONTEND_URL }
        }));
      }

      // 2. One reminder, about 24 hours before the deadline (only when the guest had 2+ days to pay, and not for a
      //    deadline that already passed: those are orders the PayPal exceptions above kept).
      {
        const due = await pool.query(
          `UPDATE orders o SET reminder_sent_at = NOW() FROM packages p
           WHERE p.id = o.package_id AND o.status = 'RESERVED' AND o.event_id = ${CUR} AND o.reminder_sent_at IS NULL
             AND ${DUE} - INTERVAL '24 hours' < NOW() AND ${DUE} > NOW()
             AND ${DUE} - o.created_at >= INTERVAL '48 hours'
           RETURNING o.guest_email, o.reference_code, ${DUE} AS due, p.name AS package_name, p.pay_note`, [payDays]);
        for (const o of due.rows) {
          const due = fmt(o.due);
          const how = howToPay(instructions, o.pay_note);
          await send(o.guest_email, "Pay soon to keep your spot — On D' Road", renderEmail({
            tone: 'warn', tag: 'Payment reminder', title: 'Pay by tomorrow',
            preheader: `Your reservation expires ${due}.`,
            lines: [`Your reservation for ${o.package_name} expires on ${due}.`, 'Unpaid reservations are cancelled automatically.'],
            details: [['Package', o.package_name], ['Reference', o.reference_code, true], ['Pay by', due]],
            callout: how ? { label: 'How to pay', text: how } : null,
            cta: { text: 'View my order', url: FRONTEND_URL }
          }));
        }
      }
    } catch (err) {
      console.error('Payment job error:', err.message);
    }
  }
  setTimeout(tick, 30 * 1000).unref();
  setInterval(tick, 10 * 60 * 1000).unref();

  // Replaces the existing /api/my-order (this is registered first): adds the deadline, how to pay, what the guest
  // owes (tier, code) and pickup. price_cents is the order's amount too, for older copies of the guest site.
  // Only the current event's order: a pass from a past event is history (see events.js).
  // promo_kind is the code's kind ('TRACK' = a tracking code, full price), so the guest site words it right.
  // A paid order also carries qr_secret: the guest site turns it into the pass's live QR (liveqr.js), which changes every
  // 30 seconds. Only the guest's own session gets it, and only while the order is PAID.
  app.get('/api/my-order', requireAuth, async (req, res) => {
    try {
      const [{ instructions, payDays }, sizeLock] = await Promise.all([getSettings(), getSizeLock(pool)]);
      const r = await pool.query(
        `SELECT o.id, o.status, o.reference_code, o.created_at, o.cancel_requested_at, o.size, o.pay_days, ${dueSql('$2')} AS due,
                COALESCE(o.amount_cents, p.price_cents) AS amount_cents, COALESCE(o.list_cents, p.price_cents) AS list_cents,
                o.discount_cents, COALESCE(o.currency, p.currency) AS currency, o.promo_code, o.tier_name, o.paid_via,
                o.picked_up_at, o.paypal_order_id IS NOT NULL AS paypal_started, pc.kind AS promo_kind, pc.value AS promo_value, o.qr_version,
                p.name AS package_name, p.includes, p.sizes AS package_sizes, p.pay_note
         FROM orders o JOIN packages p ON p.id = o.package_id LEFT JOIN promo_codes pc ON pc.code = o.promo_code
         WHERE o.guest_email = $1 AND o.status <> 'CANCELLED' AND o.event_id = ${CUR} ORDER BY o.id DESC LIMIT 1`, [req.userEmail, payDays]);
      if (!r.rowCount) return res.json(null);
      const { due, promo_kind: kind, promo_value: value, qr_version: qrVersion, ...o } = r.rows[0];
      if (o.status === 'PAID' && TOKEN_SECRET) o.qr_secret = qrSecret(TOKEN_SECRET, o.reference_code, qrVersion || 1);
      o.promo_kind = o.promo_code ? kind || null : null;
      const open = o.status === 'RESERVED';
      o.price_cents = o.amount_cents;
      // A code's row can't be deleted once used, but if it's gone, describe what it took off.
      o.promo_label = o.promo_code
        ? promoLabel(kind ? { kind, value } : { kind: 'AMOUNT', value: o.discount_cents }, o.currency) : null;
      o.size_locked = !!o.picked_up_at || isSizeLocked(sizeLock, o.status); // a collected package keeps its size
      o.pay_by = open && due ? new Date(due).toISOString() : null;
      o.payment_instructions = open ? instructions : '';
      o.pay_note = open ? o.pay_note || '' : '';
      res.json(o);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  app.get('/api/admin/payment-settings', requireRole('OWNER', 'ADMIN'), async (req, res) => {
    try {
      const s = await getSettings();
      res.json({ instructions: s.instructions, pay_days: s.payDays, pay_rule: s.payRule, pay_weekday: s.payWeekday, pay_time: s.payTime });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // Everything but the instructions is optional: a setting left out keeps its current value.
  app.post('/api/admin/payment-settings', requireRole('OWNER', 'ADMIN'), async (req, res) => {
    const b = req.body || {};
    const instructions = typeof b.instructions === 'string' ? b.instructions.trim().slice(0, 2000) : '';
    const days = b.pay_days === undefined ? null : parseInt(b.pay_days, 10);
    if (days !== null && !(days >= 0 && days <= 30)) return res.status(400).json({ error: 'Days must be between 0 and 30.' });
    if (b.pay_rule !== undefined && !['days', 'weekday'].includes(b.pay_rule)) {
      return res.status(400).json({ error: 'Choose how the deadline works.' });
    }
    if (b.pay_weekday !== undefined && !/^[0-6]$/.test(String(b.pay_weekday))) {
      return res.status(400).json({ error: 'Choose a day of the week.' });
    }
    if (b.pay_time !== undefined && !TIME_RE.test(String(b.pay_time))) {
      return res.status(400).json({ error: 'Enter a time like 18:00.' });
    }
    try {
      const cur = await getSettings();
      const rows = [
        ['payment_instructions', instructions], ['pay_days', String(days ?? cur.payDays)],
        ['pay_rule', b.pay_rule ?? cur.payRule], ['pay_weekday', String(b.pay_weekday ?? cur.payWeekday)],
        ['pay_time', String(b.pay_time ?? cur.payTime)]
      ];
      // One statement, so the settings are saved together or not at all.
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ${rows.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ')}
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, rows.flat());
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  const PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0a0a0b">
<title>Payment settings | On D' Road</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
/* Night Kinetic, admin edition: matte charcoal, one sharp accent (safety orange), hairline rules and square corners.
   Concrete is kept for utility surfaces (previews, dialogs, toasts). Calm and dense for daily work. */
:root { --bg: #0a0a0b; --surface: #141416; --surface-2: #1a1a1d; --raise: #232327; --well: #0a0a0b; --line: rgba(236, 235, 230, .1); --line-strong: rgba(236, 235, 230, .24); --text: #ecebe6; --muted: #a6a59f; --dim: #8a8983; --accent: #ff5a1f; --accent-hi: #ff7440; --accent-ink: #141416; --good: #b6ff3b; --warn: #ffc02e; --bad: #ff7a6b; --cyan: #22e1ff; --concrete: #c9c8c3; --concrete-2: #e4e3df; --ink: #141416; --ink-2: #47463f; --display: 'Archivo', 'Helvetica Neue', Arial, sans-serif; --body: 'Archivo', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; --mono: 'Space Mono', ui-monospace, SFMono-Regular, Menlo, monospace; --chev: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none' stroke='%23ecebe6' stroke-width='1.6'%3E%3Cpath d='M1 1.5l5 5 5-5'/%3E%3C/svg%3E"); --xh: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28' fill='none' stroke='%23141416' stroke-opacity='0.55' stroke-width='1'%3E%3Ccircle cx='14' cy='14' r='6.5'/%3E%3Cpath d='M14 0v28M0 14h28'/%3E%3C/svg%3E"); --wm: ${WM_LITE}; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 var(--body); -webkit-font-smoothing: antialiased; }
::selection { background: var(--accent); color: var(--accent-ink); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.top { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; gap: 10px 16px; flex-wrap: wrap; min-height: 60px; padding: 10px clamp(16px, 3vw, 32px); background: var(--wm) 0 0 / 260px 150px, rgba(10, 10, 11, .9); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.brand .mark { flex: none; width: 30px; height: 18px; overflow: visible; }
.brand b { font-family: var(--display); font-stretch: 125%; font-weight: 900; font-size: 16px; line-height: 1; letter-spacing: .01em; white-space: nowrap; }
.brand b span { color: var(--accent); }
.brand b i { font-style: normal; font-weight: 200; }
.brand .sub { font-family: var(--mono); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); white-space: nowrap; }
.brand .sub::before { content: '[ '; color: var(--dim); }
.brand .sub::after { content: ' ]'; color: var(--dim); }
.back { display: inline-flex; align-items: center; min-height: 38px; padding: 0 14px; font-size: 13px; font-weight: 600; color: var(--text); text-decoration: none; border: 1px solid var(--line-strong); white-space: nowrap; transition: border-color .15s, background .15s; }
.back:hover { border-color: var(--text); background: rgba(236, 235, 230, .05); }
h1 { font-family: var(--display); font-stretch: 125%; font-weight: 800; font-size: clamp(30px, 5vw, 48px); line-height: .98; letter-spacing: -.01em; text-transform: uppercase; margin: 0; overflow-wrap: break-word; }
h2 { font-family: var(--display); font-stretch: 118%; font-weight: 800; font-size: 19px; line-height: 1.1; letter-spacing: .01em; text-transform: uppercase; margin: 0 0 8px; }
/* The title block closes with a hairline and a short orange tab on it */
.lead { position: relative; color: var(--muted); margin: 14px 0 28px; padding-bottom: 22px; border-bottom: 1px solid var(--line); }
.lead::after { content: ''; position: absolute; left: 0; bottom: -1px; width: 56px; height: 2px; background: var(--accent); }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 0; padding: clamp(20px, 3vw, 28px); }
/* Buttons: square blocks. Safety orange with ink text for the main action; outlines for the rest. */
button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 42px; font-family: var(--display); font-weight: 700; font-stretch: 112%; font-size: 13px; line-height: 1; letter-spacing: .05em; text-transform: uppercase; padding: 0 18px; border-radius: 0; cursor: pointer; color: var(--accent-ink); background: var(--accent); border: 1px solid var(--accent); transition: background .15s, border-color .15s, color .15s; }
button:hover { background: var(--accent-hi); border-color: var(--accent-hi); }
button:active { transform: translateY(1px); }
button:disabled { opacity: .5; cursor: progress; transform: none; }
button.ghost { color: var(--text); background: transparent; border-color: var(--line-strong); }
button.ghost:hover { border-color: var(--text); background: rgba(236, 235, 230, .05); }
.msg { font-size: 14px; font-weight: 600; }
.msg.ok { color: var(--good); } .msg.err { color: var(--bad); }
@media (max-width: 560px) { .brand .sub { display: none; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } button:active { transform: none; } }
.wrap { max-width: 720px; margin: 0 auto; padding: clamp(24px, 4vw, 48px) clamp(16px, 3vw, 32px) 80px; }
label, .lbl { display: block; font-family: var(--mono); font-size: 11px; font-weight: 400; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 24px 0 8px; }
label:first-child { margin-top: 0; }
textarea, input, select { width: 100%; min-height: 44px; font: 500 15px var(--body); color: var(--text); background: var(--well); border: 1px solid var(--line-strong); border-radius: 0; padding: 11px 13px; transition: border-color .15s, box-shadow .15s; }
textarea:hover, input:hover, select:hover { border-color: rgba(236, 235, 230, .42); }
textarea { min-height: 150px; resize: vertical; line-height: 1.55; }
input { max-width: 160px; }
select { width: auto; cursor: pointer; padding-right: 38px; -webkit-appearance: none; appearance: none; background: var(--well) var(--chev) no-repeat right 13px center / 12px 8px; }
select option { background: var(--surface-2); color: var(--text); }
textarea:focus, input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
textarea::placeholder { color: var(--dim); }
small { display: block; color: var(--dim); font-size: 13px; margin-top: 8px; }
.rule { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 12px; padding: 12px 14px; margin-top: 8px; border: 1px solid var(--line); border-left: 2px solid var(--line); transition: border-color .15s, opacity .15s, background .15s; }
.rule:not(.on) { opacity: .62; }
.rule.on { border-color: var(--line-strong); border-left-color: var(--accent); background: var(--surface-2); }
.rule label { display: inline; margin: 0; font-family: var(--body); font-size: 15px; font-weight: 600; letter-spacing: 0; text-transform: none; color: var(--text); cursor: pointer; }
.rule input[type=radio] { flex: none; width: 18px; height: 18px; min-height: 0; margin: 0; padding: 0; accent-color: var(--accent); cursor: pointer; }
.rule input[type=radio]:focus { box-shadow: none; }
.rule input[type=radio]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.rule .unit { color: var(--muted); font-size: 14px; }
#days { max-width: 90px; }
#time { max-width: 140px; }
.ex { margin: 14px 0 0; color: var(--muted); font-size: 14px; }
.ex b { color: var(--text); font-weight: 700; }
.ex:empty { display: none; }
/* What guests see: a concrete panel, like the order panel's "How to pay" on the guest site */
.preview { margin-top: 26px; padding: 20px 20px 22px; color: var(--ink); background: var(--xh) no-repeat right 8px top 8px / 18px, var(--concrete); }
.preview b { display: block; margin-bottom: 10px; font-family: var(--mono); font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--ink); }
.preview b::before { content: '[ '; color: var(--ink-2); font-weight: 400; }
.preview b::after { content: ' ]'; color: var(--ink-2); font-weight: 400; }
.preview span { white-space: pre-line; font-size: 15px; }
.preview .none { color: var(--ink-2); font-style: italic; }
.pp { margin: 0; color: var(--muted); }
.pp b { color: var(--text); font-weight: 700; }
.foot { display: flex; align-items: center; gap: 14px; margin-top: 26px; flex-wrap: wrap; }
#msg { font-size: 14px; font-weight: 600; }
#msg.ok { color: var(--good); } #msg.err { color: var(--bad); }
</style></head><body>
<header class="top">
  <div class="brand"><svg class="mark" viewBox="0 0 30 18" aria-hidden="true" focusable="false"><path fill="#e4e3df" d="M0 6h30v12H0z"/><path fill="#0a0a0b" d="M18.2 0h5.6l-4.6 18h-5.6z"/><path fill="#ff5a1f" d="M19.6 0h2.8l-4.6 18h-2.8z"/></svg><b>ON D<span>'</span> <i>ROAD</i></b><span class="sub">Command Center</span></div>
  <a class="back" href="/admin">&larr; Back to overview</a>
</header>
<main class="wrap">
  <h1>Payment settings</h1>
  <p class="lead">What guests see after they reserve a package, and how long they have to pay.</p>
  <div class="card">
    <label for="instr">How guests pay</label>
    <textarea id="instr" maxlength="2000" placeholder="Example: Cash at Twan Headquarters, Fridays 4-5 PM. Bring your reference code."></textarea>
    <small>Shown on the guest's order, in the order email and in the reminder email. Line breaks are kept. A package can add its own cash details (edit it in the Packages tab); guests see those under this.</small>

    <p class="lbl" id="rule-l">Payment deadline</p>
    <div role="radiogroup" aria-labelledby="rule-l">
      <div class="rule">
        <input type="radio" name="rule" id="r-days" value="days">
        <label for="r-days">A number of days after reserving</label>
        <input id="days" type="number" min="0" max="30" inputmode="numeric" aria-label="Days to pay after reserving">
        <span class="unit">days</span>
      </div>
      <div class="rule">
        <input type="radio" name="rule" id="r-weekday" value="weekday">
        <label for="r-weekday">The next</label>
        <select id="wd" aria-label="Day of the week">
          <option value="0">Sunday</option><option value="1">Monday</option><option value="2">Tuesday</option><option value="3">Wednesday</option>
          <option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option>
        </select>
        <span class="unit">at</span>
        <input id="time" type="time" aria-label="Time, Antigua time">
        <span class="unit">Antigua time</span>
      </div>
    </div>
    <small>Guests always get at least 24 hours. Changes only affect new reservations.</small>
    <small>Unpaid reservations are cancelled automatically at the deadline; 0 days means no deadline. A reminder goes out 24 hours before the deadline when the guest had 2 or more days to pay.</small>
    <p id="ex" class="ex" aria-live="polite"></p>

    <div class="preview" aria-live="polite"><b>Guest preview: How to pay</b><span id="pv"></span></div>

    <div class="foot"><button id="save" type="button">Save settings</button><span id="msg" role="status"></span></div>
  </div>
  <div class="card" style="margin-top:22px">
    <label style="margin-top:0">PayPal</label>
    <p id="pp" class="pp" aria-live="polite">Checking...</p>
  </div>
</main>
<script>
var $ = function (id) { return document.getElementById(id); };
function preview() {
  var v = $('instr').value.trim();
  $('pv').textContent = v || 'Nothing set yet. Guests will be told you will follow up with how to pay.';
  $('pv').className = v ? '' : 'none';
}
$('instr').addEventListener('input', preview);
fetch('/api/admin/paypal').then(function (r) { return r.json(); }).then(function (d) {
  var t = !d.configured
    ? '<b>Not set up.</b> Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to the server settings in Render to let guests pay online.'
    : d.live
    ? '<b>On.</b> Guests with a reservation can pay with PayPal or a card, and are confirmed right away. XCD prices are charged in USD at 2.70 to the dollar. The instructions above show as "Other ways to pay".'
    : d.testers.length
    ? '<b>Test mode</b> (PayPal sandbox, no real money). Only these guests see PayPal: ' + d.testers.map(esc).join(', ') + '. Set PAYPAL_ENV to live, with your live keys, when you are ready.'
    : '<b>Test mode</b>, but nobody is listed in PAYPAL_TESTERS, so no guest sees PayPal yet.';
  $('pp').innerHTML = t;
}).catch(function () { $('pp').textContent = 'Could not check PayPal.'; });
function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
var DAY = 864e5, AST = 4 * 36e5; // Antigua is UTC-4 all year
function rule() { return $('r-weekday').checked ? 'weekday' : 'days'; }
// The deadline someone reserving right now would get (the same rule as deadlineFor() in payments.js).
// null = no deadline, undefined = not filled in yet.
function dueNow() {
  var now = Date.now();
  if (rule() === 'days') {
    var n = parseInt($('days').value, 10);
    return n >= 0 && n <= 30 ? (n ? new Date(now + n * DAY) : null) : undefined;
  }
  var t = $('time').value.split(':');
  if (t.length < 2) return undefined;
  var earliest = now + DAY, l = new Date(earliest - AST); // Antigua's clock, read with the UTC getters
  var due = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate() + (Number($('wd').value) - l.getUTCDay() + 7) % 7, Number(t[0]), Number(t[1])) + AST;
  if (due < earliest) due += 7 * DAY;
  return new Date(due);
}
function example() {
  document.querySelectorAll('.rule').forEach(function (row) { row.classList.toggle('on', row.querySelector('[type=radio]').checked); });
  var d = dueNow(), ex = $('ex');
  ex.textContent = '';
  if (d === null) ex.textContent = 'No deadline: reservations stay held until they are paid or cancelled.';
  if (!d) return;
  var b = document.createElement('b');
  b.textContent = d.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Antigua' });
  ex.append('Someone reserving now would have until ', b, ' Antigua time.');
}
// Clicking in a row, or changing one of its fields, picks that row.
document.querySelectorAll('.rule').forEach(function (row) {
  function pick() { row.querySelector('[type=radio]').checked = true; example(); }
  row.addEventListener('pointerdown', pick);
  row.addEventListener('input', pick);
  row.addEventListener('change', pick);
});
fetch('/api/admin/payment-settings').then(function (r) { return r.json(); }).then(function (d) {
  $('instr').value = d.instructions || '';
  $('days').value = d.pay_days;
  $(d.pay_rule === 'weekday' ? 'r-weekday' : 'r-days').checked = true;
  $('wd').value = String(d.pay_weekday == null ? 5 : d.pay_weekday);
  $('time').value = d.pay_time || '18:00';
  preview();
  example();
}).catch(function () { $('msg').textContent = 'Could not load settings.'; $('msg').className = 'err'; });
$('save').addEventListener('click', function () {
  var b = $('save'); b.disabled = true;
  $('msg').textContent = ''; $('msg').className = '';
  // The rule not in use may be left blank: the server then keeps what it had.
  var w = rule() === 'weekday', days = $('days').value.trim(), time = $('time').value;
  fetch('/api/admin/payment-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instructions: $('instr').value, pay_rule: rule(), pay_weekday: $('wd').value,
      pay_days: w && !days ? undefined : days, pay_time: !w && !time ? undefined : time })
  }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); }).then(function (x) {
    $('msg').textContent = x.ok ? 'Saved.' : (x.d.error || 'Could not save.');
    $('msg').className = x.ok ? 'ok' : 'err';
  }).catch(function () { $('msg').textContent = 'Could not save.'; $('msg').className = 'err'; })
    .then(function () { b.disabled = false; });
});
</script></body></html>`;

  app.get('/admin/payments', requireRole('OWNER', 'ADMIN'), (req, res) => res.type('html').send(PAGE));

  // Shared with server.js so every order email uses the same look and new orders get the same deadline.
  return { getSettings, deadlineFor, payBy, fmt, send, howToPay };
}
