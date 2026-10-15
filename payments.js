// payments.js: payment instructions, pay-by deadline, auto-expiry and reminder emails.
import { renderEmail } from './emails.js';
import { promoLabel } from './pricing.js';
import { getSizeLock, isSizeLocked } from './pickup.js';

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

export function registerPayments({ app, pool, resend, EMAIL_FROM, FRONTEND_URL, requireAuth, requireAdmin, escapeHtml, beforeExpire }) {
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
         WHERE p.id = o.package_id AND o.status = 'RESERVED'
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
           WHERE p.id = o.package_id AND o.status = 'RESERVED' AND o.reminder_sent_at IS NULL
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
  app.get('/api/my-order', requireAuth, async (req, res) => {
    try {
      const [{ instructions, payDays }, sizeLock] = await Promise.all([getSettings(), getSizeLock(pool)]);
      const r = await pool.query(
        `SELECT o.id, o.status, o.reference_code, o.created_at, o.cancel_requested_at, o.size, o.pay_days, ${dueSql('$2')} AS due,
                COALESCE(o.amount_cents, p.price_cents) AS amount_cents, COALESCE(o.list_cents, p.price_cents) AS list_cents,
                o.discount_cents, COALESCE(o.currency, p.currency) AS currency, o.promo_code, o.tier_name, o.paid_via,
                o.picked_up_at, o.paypal_order_id IS NOT NULL AS paypal_started, pc.kind AS promo_kind, pc.value AS promo_value,
                p.name AS package_name, p.includes, p.sizes AS package_sizes, p.pay_note
         FROM orders o JOIN packages p ON p.id = o.package_id LEFT JOIN promo_codes pc ON pc.code = o.promo_code
         WHERE o.guest_email = $1 AND o.status <> 'CANCELLED' ORDER BY o.id DESC LIMIT 1`, [req.userEmail, payDays]);
      if (!r.rowCount) return res.json(null);
      const { due, promo_kind: kind, promo_value: value, ...o } = r.rows[0];
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

  app.get('/api/admin/payment-settings', requireAdmin, async (req, res) => {
    try {
      const s = await getSettings();
      res.json({ instructions: s.instructions, pay_days: s.payDays, pay_rule: s.payRule, pay_weekday: s.payWeekday, pay_time: s.payTime });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // Everything but the instructions is optional: a setting left out keeps its current value.
  app.post('/api/admin/payment-settings', requireAdmin, async (req, res) => {
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
<meta name="robots" content="noindex"><meta name="theme-color" content="#09080b">
<title>Payment settings | On D' Road</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
/* Paint & Powder, admin edition: the guest site's black canvas and neon paint, kept calm for daily work. */
:root { --bg: #09080b; --surface: #131117; --surface-2: #18151d; --raise: #201c26; --well: #0c0b0f; --line: rgba(246, 241, 232, .09); --line-strong: rgba(246, 241, 232, .2); --text: #f6f1e8; --muted: #b4adbb; --dim: #8f8898; --accent: #ff2e93; --accent-ink: #0b0a0d; --good: #a3ff2b; --warn: #ffe500; --bad: #ff4d4d; --cyan: #1ee3ff; --display: 'Archivo', 'Arial Narrow', 'Roboto Condensed', Impact, sans-serif; --body: 'Archivo', system-ui, -apple-system, sans-serif; --mono: 'Space Mono', ui-monospace, monospace; --torn: polygon(0 14%, 3% 0, 22% 7%, 46% 0, 71% 6%, 93% 0, 100% 9%, 97% 34%, 100% 58%, 97% 82%, 100% 100%, 78% 93%, 53% 100%, 28% 94%, 6% 100%, 0 88%, 3% 63%, 0 38%); --drip: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 24' preserveAspectRatio='none'%3E%3Cpath d='M0 1.5C20 .5 40 2.5 60 1.2S100 .4 120 1.6V6.4C110 7.2 100 5.8 90 6.6S70 7.4 60 6.2 40 5.6 30 6.8 10 7.2 0 6.2ZM11.5 5.4Q10.3 6 10.3 8V11a1.3 1.3 0 0 1 -2.6 0V8Q7.7 6 6.5 5.4ZM29.9 5.4Q28.7 6 28.7 8V18a1.7 1.7 0 0 1 -3.4 0V8Q25.3 6 24.1 5.4ZM52.4 5.4Q51.2 6 51.2 8V9a1.2 1.2 0 0 1 -2.4 0V8Q48.8 6 47.6 5.4ZM73.7 5.4Q72.5 6 72.5 8V15a1.5 1.5 0 0 1 -3 0V8Q69.5 6 68.3 5.4ZM98.5 5.4Q97.3 6 97.3 8V11.5a1.3 1.3 0 0 1 -2.6 0V8Q94.7 6 93.5 5.4ZM113.3 5.4Q112.1 6 112.1 8V9a1.1 1.1 0 0 1 -2.2 0V8Q109.9 6 108.7 5.4ZM25.7 22.2a1.3 1.3 0 1 1 2.6 0a1.3 1.3 0 1 1 -2.6 0ZM69.9 19.4a1.1 1.1 0 1 1 2.2 0a1.1 1.1 0 1 1 -2.2 0Z'/%3E%3C/svg%3E"); color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 var(--body); -webkit-font-smoothing: antialiased; }
::selection { background: var(--warn); color: var(--accent-ink); }
:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }
.top { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px clamp(16px, 3vw, 32px); background: rgba(9, 8, 11, .88); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.brand .mark { flex: none; width: 28px; height: 28px; overflow: visible; color: var(--accent); transform: rotate(-14deg); }
.brand b { font-family: var(--display); font-weight: 900; font-stretch: 62%; font-size: 25px; line-height: 1; letter-spacing: .01em; white-space: nowrap; }
.brand b span { color: var(--warn); }
.brand .sub { font-family: var(--mono); font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); padding-left: 12px; border-left: 1px solid var(--line-strong); white-space: nowrap; }
.back { font-size: 13px; font-weight: 600; color: var(--muted); text-decoration: none; padding: 7px 13px; border: 1px solid var(--line); border-radius: 999px; white-space: nowrap; transition: color .15s, border-color .15s, background .15s; }
.back:hover { color: var(--text); border-color: var(--line-strong); background: rgba(246, 241, 232, .05); }
h1 { font-family: var(--display); font-weight: 900; font-stretch: 62%; font-size: clamp(46px, 7vw, 64px); line-height: .88; letter-spacing: .005em; text-transform: uppercase; margin: 0; }
/* A short neon drip under the page title */
h1::after { content: ''; display: block; width: 132px; height: 26px; margin-top: 8px; background: var(--accent); -webkit-mask: var(--drip) left top / 100% 100% no-repeat; mask: var(--drip) left top / 100% 100% no-repeat; }
h2 { font-family: var(--display); font-weight: 900; font-stretch: 62%; font-size: 30px; line-height: 1; letter-spacing: .01em; text-transform: uppercase; margin: 0 0 6px; }
.lead { color: var(--muted); margin: 6px 0 26px; max-width: 620px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: clamp(20px, 3vw, 28px); }
/* Buttons: paint stickers. Pink with ink text and a small misprinted yellow shadow. */
button { font-family: var(--display); font-weight: 800; font-stretch: 78%; font-size: 14.5px; line-height: 1; letter-spacing: .045em; text-transform: uppercase; padding: 13px 21px 12px; border-radius: 999px; cursor: pointer; color: var(--accent-ink); background: var(--accent); border: 1px solid var(--accent); box-shadow: 3px 3px 0 var(--warn); transition: transform .12s, box-shadow .12s, background .15s, border-color .15s, color .15s; }
button:hover { transform: translate(-1px, -1px); box-shadow: 4px 4px 0 var(--warn); }
button:active { transform: translate(2px, 2px); box-shadow: 1px 1px 0 var(--warn); }
button:disabled { opacity: .5; cursor: progress; transform: none; }
button.ghost { color: var(--text); background: transparent; border-color: var(--line-strong); box-shadow: none; }
button.ghost:hover { color: var(--cyan); border-color: var(--cyan); background: rgba(30, 227, 255, .06); transform: none; }
button.ghost:active { transform: translateY(1px); }
.msg { font-size: 14px; font-weight: 700; }
.msg.ok { color: var(--good); } .msg.err { color: var(--bad); }
@media (max-width: 560px) { .brand .sub { display: none; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } button:hover, button:active { transform: none; } }
.wrap { max-width: 720px; margin: 0 auto; padding: clamp(24px, 4vw, 48px) clamp(16px, 3vw, 32px) 80px; }
label, .lbl { display: block; font-family: var(--mono); font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 24px 0 8px; }
label:first-child { margin-top: 0; }
textarea, input, select { width: 100%; font: 500 15px var(--body); color: var(--text); background: var(--well); border: 1px solid var(--line-strong); border-radius: 8px; padding: 13px 14px; transition: border-color .15s, box-shadow .15s; }
textarea:hover, input:hover, select:hover { border-color: rgba(246, 241, 232, .32); }
textarea { min-height: 150px; resize: vertical; line-height: 1.55; }
input { max-width: 160px; }
select { width: auto; cursor: pointer; padding-right: 36px; -webkit-appearance: none; appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--warn) 50%), linear-gradient(135deg, var(--warn) 50%, transparent 50%); background-position: calc(100% - 18px) 50%, calc(100% - 13px) 50%; background-size: 5px 5px; background-repeat: no-repeat; }
select option { background: var(--surface-2); color: var(--text); }
textarea:focus, input:focus, select:focus { outline: none; border-color: var(--cyan); box-shadow: 0 0 0 3px rgba(30, 227, 255, .16); }
textarea::placeholder { color: var(--dim); }
small { display: block; color: var(--dim); font-size: 13px; margin-top: 8px; }
.rule { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 12px; padding: 12px 14px; margin-top: 10px; border: 1px solid var(--line); border-radius: 10px; transition: border-color .15s, opacity .15s, background .15s; }
.rule:not(.on) { opacity: .62; }
.rule.on { border-color: rgba(255, 46, 147, .55); background: rgba(255, 46, 147, .05); }
.rule label { display: inline; margin: 0; font-family: var(--body); font-size: 15px; font-weight: 600; letter-spacing: 0; text-transform: none; color: var(--text); cursor: pointer; }
.rule input[type=radio] { flex: none; width: 18px; height: 18px; margin: 0; padding: 0; accent-color: var(--accent); cursor: pointer; }
.rule input[type=radio]:focus { box-shadow: none; }
.rule input[type=radio]:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }
.rule .unit { color: var(--muted); font-size: 14px; }
#days { max-width: 90px; }
#time { max-width: 140px; }
.ex { margin: 14px 0 0; color: var(--muted); font-size: 14px; }
.ex b { color: var(--text); font-weight: 700; }
.ex:empty { display: none; }
/* What guests see, styled like the guest site's "How to pay" box */
.preview { margin-top: 26px; padding: 16px 18px; border-radius: 8px; background: rgba(30, 227, 255, .05); border: 1px dashed rgba(30, 227, 255, .45); }
.preview b { display: block; width: fit-content; margin-bottom: 10px; padding: 5px 10px 4px; font-family: var(--mono); font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--accent-ink); background: var(--cyan); clip-path: var(--torn); transform: rotate(-1.5deg); }
.preview span { white-space: pre-line; font-size: 15px; }
.preview .none { color: var(--dim); font-style: italic; }
.pp { margin: 0; color: var(--muted); }
.pp b { color: var(--text); font-weight: 700; }
.foot { display: flex; align-items: center; gap: 14px; margin-top: 26px; flex-wrap: wrap; }
#msg { font-size: 14px; font-weight: 700; }
#msg.ok { color: var(--good); } #msg.err { color: var(--bad); }
</style></head><body>
<header class="top">
  <div class="brand"><svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path fill="currentColor" d="M29.1 16.4C28.6 17 25.8 17.4 24.9 17.9C24 18.3 24 18.6 23.9 19.1C23.7 19.5 23.6 19.9 23.7 20.5C23.7 21.1 24.2 22 24.2 22.6C24.2 23.3 24.2 24.2 23.8 24.6C23.3 24.9 22.3 24.7 21.6 24.6C20.9 24.6 20.1 24.2 19.5 24.1C18.9 24 18.5 23.7 18.1 24.2C17.7 24.6 17.7 25.9 17.2 26.7C16.8 27.5 16.1 29.2 15.6 28.9C15.1 28.6 14.7 25.8 14.2 25C13.8 24.1 13.6 24.1 13.1 24C12.7 23.8 12.3 23.9 11.7 24C11.2 24.1 10.5 24.3 9.7 24.5C8.9 24.7 7.5 25.4 6.8 25.2C6 25.1 5.4 24.5 5.4 23.8C5.4 23.1 6.4 21.7 6.7 21C7 20.2 7.6 19.6 7.2 19.1C6.7 18.7 4.6 18.7 4 18.2C3.4 17.8 3 16.9 3.6 16.4C4.2 15.9 6.6 15.5 7.4 15.1C8.1 14.7 8 14.4 8 13.9C8.1 13.5 8 13 7.9 12.5C7.7 11.9 7.4 11.1 7.3 10.4C7.3 9.7 7.2 8.7 7.5 8.3C7.9 7.9 8.7 7.8 9.4 7.8C10 7.8 10.9 8.3 11.4 8.2C12 8.1 12.2 8 12.6 7.1C12.9 6.2 13 3.5 13.5 3C14 2.5 15 3.2 15.6 3.9C16.2 4.6 16.6 6.5 17 7.3C17.5 8 17.8 8 18.2 8.3C18.6 8.7 18.9 9 19.3 9.2C19.7 9.4 19.9 9.6 20.6 9.5C21.3 9.5 22.6 8.7 23.2 8.8C23.9 8.8 24.5 9.3 24.6 9.9C24.6 10.5 23.7 11.7 23.5 12.4C23.4 13 23.1 13.4 23.9 13.7C24.7 14 27.4 13.9 28.2 14.4C29.1 14.8 29.7 15.8 29.1 16.4ZM12.7 3.8a1.5 1.5 0 1 1 3.1 0a1.5 1.5 0 1 1 -3.1 0ZM23 9a1.4 1.4 0 1 1 2.9 0a1.4 1.4 0 1 1 -2.9 0ZM27.1 15.5a1.6 1.6 0 1 1 3.1 0a1.6 1.6 0 1 1 -3.1 0ZM14.5 28.9a1.5 1.5 0 1 1 3 0a1.5 1.5 0 1 1 -3 0ZM5.5 23.7a1.4 1.4 0 1 1 2.8 0a1.4 1.4 0 1 1 -2.8 0ZM1.4 17.3a1.5 1.5 0 1 1 3.1 0a1.5 1.5 0 1 1 -3.1 0ZM27.4 5.4a1.2 1.2 0 1 1 2.4 0a1.2 1.2 0 1 1 -2.4 0ZM2.6 27a1 1 0 1 1 2 0a1 1 0 1 1 -2 0ZM26.6 28.2a0.8 0.8 0 1 1 1.6 0a0.8 0.8 0 1 1 -1.6 0Z"/></svg><b>ON D<span>'</span> ROAD</b><span class="sub">Command Center</span></div>
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

  app.get('/admin/payments', requireAdmin, (req, res) => res.type('html').send(PAGE));

  // Shared with server.js so every order email uses the same look and new orders get the same deadline.
  return { getSettings, deadlineFor, payBy, fmt, send, howToPay };
}
