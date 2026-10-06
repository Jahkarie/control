// payments.js: payment instructions, pay-by deadline, auto-expiry and reminder emails.
const DAY_MS = 24 * 60 * 60 * 1000;

export function registerPayments({ app, pool, resend, EMAIL_FROM, FRONTEND_URL, requireAuth, requireAdmin, escapeHtml }) {
  async function getSettings() {
    const r = await pool.query("SELECT key, value FROM settings WHERE key IN ('payment_instructions', 'pay_days')");
    const s = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
    const days = parseInt(s.pay_days, 10);
    return { instructions: s.payment_instructions || '', payDays: Number.isNaN(days) ? 3 : days };
  }

  const payBy = (createdAt, payDays) => new Date(new Date(createdAt).getTime() + payDays * DAY_MS);
  const fmt = (d) => d.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Antigua' });

  async function send(to, subject, html) {
    try {
      const { error } = await resend.emails.send({ from: EMAIL_FROM, to, subject, html });
      if (error) { console.error('Payment email failed:', error); return error; }
      return null;
    } catch (err) {
      console.error('Payment email threw:', err);
      return err;
    }
  }

  const shell = (tag, title, headBg, bodyHtml) => `
<div style="background-color: #f4f1ea; padding: 32px 16px; font-family: Arial, Helvetica, sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 540px; margin: 0 auto;">
<tr><td style="background-color: ${headBg}; border: 3px solid #0d0d0d; padding: 28px 24px 24px;">
<p style="display: inline-block; font-size: 11px; font-weight: 800; letter-spacing: 2px; color: #0d0d0d; border: 2px solid #0d0d0d; border-radius: 999px; padding: 5px 12px; margin: 0 0 16px;">${tag}</p>
<h1 style="font-family: Arial Black, Arial, sans-serif; font-size: 30px; line-height: 1; text-transform: uppercase; color: #0d0d0d; margin: 0;">${title}</h1>
</td></tr>
<tr><td style="background-color: #0d0d0d; border: 3px solid #0d0d0d; border-top: none; padding: 26px 24px;">
${bodyHtml}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 26px auto 6px;">
<tr><td style="background-color: #ff6a1f; border: 3px solid #f4f1ea; border-radius: 999px;">
<a href="${FRONTEND_URL}" style="display: inline-block; padding: 15px 32px; font-family: Arial Black, Arial, sans-serif; font-size: 13px; letter-spacing: 1.5px; text-transform: uppercase; color: #0d0d0d; text-decoration: none;">Open My Account</a>
</td></tr>
</table>
</td></tr>
</table>
</div>`;

  const p1 = 'color: #f4f1ea; font-size: 15px; font-weight: 700; line-height: 1.5; margin: 0 0 8px;';
  const p2 = 'color: #b8b3a6; font-size: 13px; font-weight: 600; line-height: 1.5; margin: 0 0 8px;';

  const instrBlock = (instructions) => instructions
    ? `<p style="${p2}"><strong style="color:#f4f1ea;">How to pay:</strong><br>${escapeHtml(instructions).replace(/\n/g, '<br>')}</p>`
    : '';

  async function tick() {
    try {
      const { instructions, payDays } = await getSettings();
      if (payDays < 1) return; // 0 = no deadline

      // 1. Expire unpaid orders past the deadline (this also frees capacity).
      const expired = await pool.query(
        `UPDATE orders o SET status = 'CANCELLED' FROM packages p
         WHERE p.id = o.package_id AND o.status = 'RESERVED'
           AND o.created_at + make_interval(days => $1::int) < NOW()
         RETURNING o.guest_email, o.reference_code, p.name AS package_name`, [payDays]);
      for (const o of expired.rows) {
        await send(o.guest_email, "Your reservation expired — On D' Road",
          shell('RESERVATION EXPIRED', 'Time ran out', '#ffd400',
            `<p style="${p1}">Your reservation for ${escapeHtml(o.package_name)} (${escapeHtml(o.reference_code)}) was cancelled because it wasn't paid in time.</p>
             <p style="${p2}">If spots are still open, you can reserve again from your account.</p>`));
      }

      // 2. One reminder, about 24 hours before the deadline (needs a deadline of 2+ days).
      if (payDays >= 2) {
        const due = await pool.query(
          `UPDATE orders o SET reminder_sent_at = NOW() FROM packages p
           WHERE p.id = o.package_id AND o.status = 'RESERVED' AND o.reminder_sent_at IS NULL
             AND o.created_at + make_interval(days => $1::int) - INTERVAL '24 hours' < NOW()
           RETURNING o.guest_email, o.reference_code, o.created_at, p.name AS package_name`, [payDays]);
        for (const o of due.rows) {
          await send(o.guest_email, "Pay soon to keep your spot — On D' Road",
            shell('PAYMENT REMINDER', 'Pay by tomorrow', '#ff6a1f',
              `<p style="${p1}">Your reservation for ${escapeHtml(o.package_name)} (${escapeHtml(o.reference_code)}) expires on ${fmt(payBy(o.created_at, payDays))}.</p>
               ${instrBlock(instructions)}
               <p style="${p2}">Unpaid reservations are cancelled automatically.</p>`));
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
        `SELECT o.id, o.status, o.reference_code, o.created_at, o.cancel_requested_at,
                p.name AS package_name, p.price_cents, p.currency, p.includes
         FROM orders o JOIN packages p ON p.id = o.package_id
         WHERE o.guest_email = $1 AND o.status <> 'CANCELLED' ORDER BY o.id DESC LIMIT 1`, [req.userEmail]);
      const o = r.rows[0];
      if (!o) return res.json(null);
      const open = o.status === 'RESERVED';
      o.pay_by = open && payDays > 0 ? payBy(o.created_at, payDays).toISOString() : null;
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
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payment settings | On D' Road</title>
<style>
body { margin: 0; background: #08050a; color: #f6efe6; font-family: Arial, Helvetica, sans-serif; padding: 24px 16px; }
.box { max-width: 640px; margin: 0 auto; border: 1px solid rgba(233,180,76,.35); border-radius: 14px; padding: 22px; background: #14090f; }
h1 { margin: 0 0 4px; font-size: 22px; color: #e9b44c; letter-spacing: 1px; }
p.s { margin: 0 0 18px; color: #b8b3a6; font-size: 13px; }
label { display: block; font-weight: 700; font-size: 13px; margin: 16px 0 6px; }
textarea, input { width: 100%; box-sizing: border-box; background: #08050a; color: #f6efe6; border: 1px solid rgba(233,180,76,.35); border-radius: 10px; padding: 12px; font-size: 15px; font-family: inherit; }
textarea { min-height: 150px; }
small { color: #b8b3a6; font-size: 12px; }
button { margin-top: 18px; background: #e9b44c; color: #14060e; border: 0; border-radius: 999px; padding: 12px 24px; font-weight: 800; font-size: 14px; cursor: pointer; }
a { color: #e9b44c; font-size: 13px; }
#msg { margin-top: 12px; font-weight: 700; font-size: 14px; }
</style></head><body>
<div class="box">
<h1>PAYMENT SETTINGS</h1>
<p class="s"><a href="/admin">&larr; Back to Command Center</a></p>
<label for="instr">How guests pay</label>
<textarea id="instr" maxlength="2000" placeholder="Example: Cash at [place], Fridays 4-6 PM. Bring your reference code."></textarea>
<small>Shown on the guest's order and in the reminder email. Line breaks are kept.</small>
<label for="days">Days to pay after reserving</label>
<input id="days" type="number" min="0" max="30">
<small>Unpaid orders are cancelled automatically after this many days. Use 0 for no deadline. A reminder goes out 24 hours before (needs 2 or more days).</small>
<button id="save">Save</button>
<p id="msg"></p>
</div>
<script>
var $ = function (id) { return document.getElementById(id); };
fetch('/api/admin/payment-settings').then(function (r) { return r.json(); }).then(function (d) {
  $('instr').value = d.instructions || '';
  $('days').value = d.pay_days;
}).catch(function () { $('msg').textContent = 'Could not load settings.'; });
$('save').addEventListener('click', function () {
  fetch('/api/admin/payment-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instructions: $('instr').value, pay_days: $('days').value })
  }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); }).then(function (x) {
    $('msg').textContent = x.ok ? 'Saved.' : (x.d.error || 'Could not save.');
  }).catch(function () { $('msg').textContent = 'Could not save.'; });
});
</script></body></html>`;

  app.get('/admin/payments', requireAdmin, (req, res) => res.type('html').send(PAGE));

  // Shared with server.js so every order email uses the same look.
  return { getSettings, payBy, fmt, send, shell, p1, p2, instrBlock };
}
