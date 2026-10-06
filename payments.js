// payments.js: payment instructions, pay-by deadline, auto-expiry and reminder emails.
import { renderEmail } from './emails.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function registerPayments({ app, pool, resend, EMAIL_FROM, FRONTEND_URL, requireAuth, requireAdmin, escapeHtml, beforeExpire }) {
  async function getSettings() {
    const r = await pool.query("SELECT key, value FROM settings WHERE key IN ('payment_instructions', 'pay_days')");
    const s = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
    const days = parseInt(s.pay_days, 10);
    return { instructions: s.payment_instructions || '', payDays: Number.isNaN(days) ? 3 : days };
  }

  const payBy = (createdAt, payDays) => new Date(new Date(createdAt).getTime() + payDays * DAY_MS);
  const fmt = (d) => d.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Antigua' });

  // Sends an email built by renderEmail(). Returns an error (or null). Never throws.
  async function send(to, subject, email) {
    try {
      const { error } = await resend.emails.send({ from: EMAIL_FROM, to, subject, html: email.html, text: email.text });
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
      // Each order keeps the days-to-pay it was reserved under (orders.pay_days; 0 = no deadline). Orders from
      // before that column existed use the current setting.
      const DAYS = 'COALESCE(o.pay_days, $1::int)';

      // 1. Expire unpaid orders past the deadline (this also frees capacity). A PayPal checkout started in the
      //    last 30 minutes, or a PayPal payment PayPal is still processing, gets more time.
      const expired = await pool.query(
        `UPDATE orders o SET status = 'CANCELLED' FROM packages p
         WHERE p.id = o.package_id AND o.status = 'RESERVED'
           AND ${DAYS} > 0 AND o.created_at + make_interval(days => ${DAYS}) < NOW()
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

      // 2. One reminder, about 24 hours before the deadline (needs a deadline of 2+ days).
      {
        const due = await pool.query(
          `UPDATE orders o SET reminder_sent_at = NOW() FROM packages p
           WHERE p.id = o.package_id AND o.status = 'RESERVED' AND o.reminder_sent_at IS NULL
             AND ${DAYS} >= 2 AND o.created_at + make_interval(days => ${DAYS}) - INTERVAL '24 hours' < NOW()
           RETURNING o.guest_email, o.reference_code, o.created_at, ${DAYS} AS days, p.name AS package_name`, [payDays]);
        for (const o of due.rows) {
          const due = fmt(payBy(o.created_at, o.days));
          await send(o.guest_email, "Pay soon to keep your spot — On D' Road", renderEmail({
            tone: 'warn', tag: 'Payment reminder', title: 'Pay by tomorrow',
            preheader: `Your reservation expires ${due}.`,
            lines: [`Your reservation for ${o.package_name} expires on ${due}.`, 'Unpaid reservations are cancelled automatically.'],
            details: [['Package', o.package_name], ['Reference', o.reference_code, true], ['Pay by', due]],
            callout: instructions ? { label: 'How to pay', text: instructions } : null,
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

  // Replaces the existing /api/my-order (this is registered first): adds the deadline and instructions.
  app.get('/api/my-order', requireAuth, async (req, res) => {
    try {
      const { instructions, payDays } = await getSettings();
      const r = await pool.query(
        `SELECT o.id, o.status, o.reference_code, o.created_at, o.cancel_requested_at, o.size, o.pay_days,
                p.name AS package_name, p.price_cents, p.currency, p.includes, p.sizes AS package_sizes
         FROM orders o JOIN packages p ON p.id = o.package_id
         WHERE o.guest_email = $1 AND o.status <> 'CANCELLED' ORDER BY o.id DESC LIMIT 1`, [req.userEmail]);
      const o = r.rows[0];
      if (!o) return res.json(null);
      const open = o.status === 'RESERVED';
      const days = o.pay_days ?? payDays;
      o.pay_by = open && days > 0 ? payBy(o.created_at, days).toISOString() : null;
      o.payment_instructions = open ? instructions : '';
      res.json(o);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  app.get('/api/admin/payment-settings', requireAdmin, async (req, res) => {
    try {
      const { instructions, payDays } = await getSettings();
      res.json({ instructions, pay_days: payDays });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  app.post('/api/admin/payment-settings', requireAdmin, async (req, res) => {
    const instructions = typeof req.body?.instructions === 'string' ? req.body.instructions.trim().slice(0, 2000) : '';
    const days = parseInt(req.body?.pay_days, 10);
    if (!(days >= 0 && days <= 30)) return res.status(400).json({ error: 'Days must be between 0 and 30.' });
    try {
      for (const [k, v] of [['payment_instructions', instructions], ['pay_days', String(days)]]) {
        await pool.query(
          'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, v]);
      }
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  const PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0b0a09">
<title>Payment settings | On D' Road</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root { --bg: #0b0a09; --surface: #141210; --surface-2: #1b1815; --line: rgba(243, 236, 226, .09); --line-strong: rgba(243, 236, 226, .2); --text: #f3ece2; --muted: #9b9389; --dim: #6c665e; --accent: #ff5b1f; --accent-ink: #120703; --good: #4fc3a1; --bad: #ff6a5c; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 'Inter', system-ui, -apple-system, sans-serif; -webkit-font-smoothing: antialiased; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.top { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px clamp(16px, 3vw, 32px); background: rgba(11, 10, 9, .8); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 14px; }
.brand b { font-family: 'Anton', Impact, sans-serif; font-weight: 400; font-size: 20px; letter-spacing: .04em; }
.brand b span { color: var(--accent); }
.brand .sub { font-size: 12px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); padding-left: 14px; border-left: 1px solid var(--line-strong); }
.back { font-size: 13px; font-weight: 500; color: var(--muted); text-decoration: none; padding: 8px 12px; border-radius: 8px; }
.back:hover { color: var(--text); background: rgba(243, 236, 226, .05); }
.wrap { max-width: 720px; margin: 0 auto; padding: clamp(24px, 4vw, 48px) clamp(16px, 3vw, 32px) 80px; }
h1 { font-family: 'Anton', Impact, sans-serif; font-weight: 400; font-size: clamp(36px, 6vw, 52px); line-height: .95; text-transform: uppercase; margin: 0; }
.lead { color: var(--muted); margin: 10px 0 26px; }
.card { background: linear-gradient(180deg, var(--surface-2), var(--surface)); border: 1px solid var(--line); border-radius: 14px; padding: clamp(20px, 3vw, 28px); }
label { display: block; font-size: 11px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); margin: 22px 0 8px; }
label:first-child { margin-top: 0; }
textarea, input { width: 100%; font: 500 15px 'Inter', system-ui, sans-serif; color: var(--text); background: rgba(0, 0, 0, .35); border: 1px solid var(--line-strong); border-radius: 10px; padding: 13px 14px; transition: border-color .15s, box-shadow .15s; }
textarea { min-height: 150px; resize: vertical; line-height: 1.55; }
input { max-width: 160px; }
textarea:focus, input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(255, 91, 31, .16); }
textarea::placeholder { color: var(--dim); }
small { display: block; color: var(--dim); font-size: 13px; margin-top: 8px; }
.preview { margin-top: 26px; padding: 16px 18px; border-radius: 10px; background: rgba(243, 236, 226, .04); border: 1px solid var(--line); }
.preview b { display: block; font-size: 11px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--accent); margin-bottom: 8px; }
.preview span { white-space: pre-line; font-size: 15px; }
.preview .none { color: var(--dim); font-style: italic; }
.pp { margin: 0; color: var(--muted); }
.pp b { color: var(--text); font-weight: 600; }
.foot { display: flex; align-items: center; gap: 14px; margin-top: 26px; flex-wrap: wrap; }
button { font: 600 14px 'Inter', system-ui, sans-serif; padding: 13px 22px; border-radius: 10px; cursor: pointer; color: var(--accent-ink); background: var(--accent); border: 1px solid var(--accent); }
button:hover { filter: brightness(1.08); }
button:disabled { opacity: .5; cursor: progress; }
#msg { font-size: 14px; font-weight: 600; }
#msg.ok { color: var(--good); } #msg.err { color: var(--bad); }
</style></head><body>
<header class="top">
  <div class="brand"><b>ON D<span>'</span> ROAD</b><span class="sub">Command Center</span></div>
  <a class="back" href="/admin">&larr; Back to overview</a>
</header>
<main class="wrap">
  <h1>Payment settings</h1>
  <p class="lead">What guests see after they reserve a package, and how long they have to pay.</p>
  <div class="card">
    <label for="instr">How guests pay</label>
    <textarea id="instr" maxlength="2000" placeholder="Example: Cash at Twan Headquarters, Fridays 4-5 PM. Bring your reference code."></textarea>
    <small>Shown on the guest's order, in the order email and in the reminder email. Line breaks are kept.</small>

    <label for="days">Days to pay after reserving</label>
    <input id="days" type="number" min="0" max="30" inputmode="numeric">
    <small>Unpaid reservations are cancelled automatically after this many days. Use 0 for no deadline. Changing this only affects new reservations; existing ones keep the deadline they were given. A reminder goes out 24 hours before the deadline (needs 2 or more days).</small>

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
fetch('/api/admin/payment-settings').then(function (r) { return r.json(); }).then(function (d) {
  $('instr').value = d.instructions || '';
  $('days').value = d.pay_days;
  preview();
}).catch(function () { $('msg').textContent = 'Could not load settings.'; $('msg').className = 'err'; });
$('save').addEventListener('click', function () {
  var b = $('save'); b.disabled = true;
  $('msg').textContent = ''; $('msg').className = '';
  fetch('/api/admin/payment-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instructions: $('instr').value, pay_days: $('days').value })
  }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); }).then(function (x) {
    $('msg').textContent = x.ok ? 'Saved.' : (x.d.error || 'Could not save.');
    $('msg').className = x.ok ? 'ok' : 'err';
  }).catch(function () { $('msg').textContent = 'Could not save.'; $('msg').className = 'err'; })
    .then(function () { b.disabled = false; });
});
</script></body></html>`;

  app.get('/admin/payments', requireAdmin, (req, res) => res.type('html').send(PAGE));

  // Shared with server.js so every order email uses the same look.
  return { getSettings, payBy, fmt, send };
}
