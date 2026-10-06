// site.js: the contact details and terms the guest site shows, edited at /admin/site.
// The contact details also go at the bottom of every email (see setContact in emails.js).
import { setContact } from './emails.js';

// Used until the organizers save their own version. In the text, "# " starts a heading and "- " a bullet point.
export const DEFAULT_TERMS = `# The short version
On D' Road is invite only and 18+. Your invite, your account and your pass are yours alone. Wear your full costume or package gear, pay by your deadline, and look out for each other.

# 1. Invites and accounts
- Invites are personal, single-use and tied to one email address. Don't forward or post them.
- Your account and entry pass are for you only. We can cancel passes that are sold, swapped or shared.

# 2. Age
- You must be 18 or older. Bring photo ID, because you may be asked for it at the entrance.
- If you can't show you're 18 or older, you won't be let in and you won't get a refund.

# 3. Reserving and paying
- Reserving a package holds your spot until the pay-by date shown in your account.
- Unpaid reservations are cancelled automatically after that date, and the spot goes to someone else.
- Your spot is confirmed only once we've received your payment. Bring your reference code when you pay.

# 4. Cancelling and refunds
- Haven't paid yet? Cancel the reservation in your account. Nothing is owed.
- Already paid? Request a refund in your account before the event. Once we approve it, your pass stops working and the refund is paid in cash where you paid.
- There are no refunds once the event has started, for no-shows, or if you're refused entry or removed for breaking these terms.
- If we cancel the event, every paid guest gets a full refund.

# 5. Costume and package rules
- Wear your full costume or full package gear. Regular clothes with makeup, dressing all in black, or a few accessories don't count.
- If you're not in proper costume or package gear, you can be refused drinks and food and turned away from the band, even if you've paid. There's no refund in that case.

# 6. Your entry pass
- One pass lets one person in, once. The first scan at the entrance is the one that counts.
- Don't share screenshots of your pass. If someone else uses it first, you may not get in.
- Lost your phone? The door team can find you by your email or reference code.

# 7. Safety
- Follow the instructions of the organizers, security and police.
- We can remove anyone who is violent, threatening, harassing others, stealing or putting people at risk, with no refund.
- Drink responsibly. You take part at your own risk, as far as the law allows, and you're responsible for your own belongings.

# 8. Photos and video
- The event may be photographed and filmed. By attending, you agree that you may appear in photos and videos we use to share and promote On D' Road.

# 9. Changes
- Times, meeting points and routes can change. We'll post updates in your account and email you.
- If we change these terms, we'll email you about anything important.

# 10. Your information
- We keep your email address, orders and check-ins to run the event. We don't sell your information.
- We email you about your account, your orders and the event.
- Want your information deleted? Contact us. We keep the payment records we're required to keep.`;

// "+1 (268) 555-1234", "268 555 1234" or "555 1234" -> "12685551234". Antigua numbers can skip the country code.
function cleanWhatsApp(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (/^268\d{7}$/.test(d)) d = '1' + d;
  else if (/^\d{7}$/.test(d)) d = '1268' + d;
  return d;
}
// "@ondroad" or "https://www.instagram.com/ondroad/" -> "ondroad".
const cleanInstagram = (v) => String(v || '').trim()
  .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '');
const isValidEmail = (v) => v.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(v);

export function registerSite({ app, pool, express, requireAdmin }) {
  const json = express.json({ limit: '100kb' }); // the terms can be longer than the app-wide 10kb limit
  const KEYS = ['contact_whatsapp', 'contact_instagram', 'contact_email', 'terms', 'terms_updated_at'];
  const save = (key, value) => pool.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
  const fail = (res, err) => { console.error(err); res.status(500).json({ error: 'Server error.' }); };

  async function getSite() {
    const r = await pool.query('SELECT key, value FROM settings WHERE key = ANY($1)', [KEYS]);
    const s = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
    return {
      contact: { whatsapp: s.contact_whatsapp || '', instagram: s.contact_instagram || '', email: s.contact_email || '' },
      terms: s.terms || DEFAULT_TERMS,
      terms_updated_at: s.terms_updated_at || null
    };
  }

  // Puts the saved contact details in the email footer. Runs once the database is ready, and after each save.
  async function refresh() {
    try { setContact((await getSite()).contact); } catch (err) { console.error('Could not load contact details:', err.message); }
  }

  // Public: the guest site shows these before anyone logs in.
  app.get('/api/site', async (req, res) => {
    try { res.json(await getSite()); } catch (err) { fail(res, err); }
  });

  app.get('/api/admin/site', requireAdmin, async (req, res) => {
    try { res.json({ ...(await getSite()), default_terms: DEFAULT_TERMS }); } catch (err) { fail(res, err); }
  });

  // Saves { contact: { whatsapp, instagram, email } } and/or { terms }.
  app.post('/api/admin/site', requireAdmin, json, async (req, res) => {
    const b = req.body || {};
    try {
      if (b.contact) {
        const whatsapp = cleanWhatsApp(b.contact.whatsapp);
        const instagram = cleanInstagram(b.contact.instagram);
        const email = String(b.contact.email || '').trim().toLowerCase();
        if (whatsapp && !/^\d{8,15}$/.test(whatsapp)) return res.status(400).json({ error: 'Enter the WhatsApp number with its country code, e.g. +1 268 555 1234.' });
        if (instagram && !/^[A-Za-z0-9._]{1,30}$/.test(instagram)) return res.status(400).json({ error: 'Enter just the Instagram username, e.g. @ondroad.' });
        if (email && !isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
        await save('contact_whatsapp', whatsapp);
        await save('contact_instagram', instagram);
        await save('contact_email', email);
      }
      if (b.terms !== undefined) {
        const terms = typeof b.terms === 'string' ? b.terms.trim().slice(0, 20000) : '';
        if (!terms) return res.status(400).json({ error: "The terms can't be empty. Use the original draft to start again." });
        if (terms !== (await getSite()).terms) {
          await save('terms', terms);
          await save('terms_updated_at', new Date().toISOString());
        }
      }
      await refresh();
      res.json({ success: true, ...(await getSite()) });
    } catch (err) { fail(res, err); }
  });

  const PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0b0a09">
<title>Contact &amp; terms | On D' Road</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root { --bg: #0b0a09; --surface: #141210; --surface-2: #1b1815; --line: rgba(243, 236, 226, .09); --line-strong: rgba(243, 236, 226, .2); --text: #f3ece2; --muted: #9b9389; --dim: #6c665e; --accent: #ff5b1f; --accent-ink: #120703; --good: #4fc3a1; --warn: #f0b43c; --bad: #ff6a5c; }
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
h2 { font-family: 'Anton', Impact, sans-serif; font-weight: 400; font-size: 26px; text-transform: uppercase; margin: 0 0 4px; }
.lead { color: var(--muted); margin: 10px 0 26px; }
.card { background: linear-gradient(180deg, var(--surface-2), var(--surface)); border: 1px solid var(--line); border-radius: 14px; padding: clamp(20px, 3vw, 28px); margin-bottom: 22px; }
.card > p { color: var(--muted); margin: 0; }
label { display: block; font-size: 11px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); margin: 22px 0 8px; }
textarea, input { width: 100%; font: 500 15px 'Inter', system-ui, sans-serif; color: var(--text); background: rgba(0, 0, 0, .35); border: 1px solid var(--line-strong); border-radius: 10px; padding: 13px 14px; transition: border-color .15s, box-shadow .15s; }
textarea { min-height: 420px; resize: vertical; line-height: 1.55; }
textarea:focus, input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(255, 91, 31, .16); }
textarea::placeholder, input::placeholder { color: var(--dim); }
small { display: block; color: var(--dim); font-size: 13px; margin-top: 8px; }
.note { margin-top: 16px; padding: 12px 14px; border-radius: 10px; font-size: 14px; background: rgba(240, 180, 60, .07); border: 1px solid rgba(240, 180, 60, .3); color: var(--warn); }
.note.ok { background: rgba(243, 236, 226, .04); border-color: var(--line); color: var(--muted); }
.foot { display: flex; align-items: center; gap: 12px; margin-top: 24px; flex-wrap: wrap; }
button { font: 600 14px 'Inter', system-ui, sans-serif; padding: 13px 22px; border-radius: 10px; cursor: pointer; color: var(--accent-ink); background: var(--accent); border: 1px solid var(--accent); }
button.ghost { color: var(--text); background: transparent; border-color: var(--line-strong); }
button:hover { filter: brightness(1.08); }
button:disabled { opacity: .5; cursor: progress; }
.msg { font-size: 14px; font-weight: 600; }
.msg.ok { color: var(--good); } .msg.err { color: var(--bad); }
</style></head><body>
<header class="top">
  <div class="brand"><b>ON D<span>'</span> ROAD</b><span class="sub">Command Center</span></div>
  <a class="back" href="/admin">&larr; Back to overview</a>
</header>
<main class="wrap">
  <h1>Contact &amp; terms</h1>
  <p class="lead">How guests reach you, and the terms they agree to when they reserve a package.</p>

  <section class="card" aria-labelledby="c-h">
    <h2 id="c-h">Contact details</h2>
    <p>Shown at the bottom of the site and of every email. Leave a field empty to hide it.</p>
    <label for="wa">WhatsApp number</label>
    <input id="wa" inputmode="tel" placeholder="268 555 1234" autocomplete="off">
    <small>Include the country code. Antigua numbers can be typed as 268 555 1234.</small>
    <label for="ig">Instagram</label>
    <input id="ig" placeholder="@ondroad" autocomplete="off">
    <label for="em">Email</label>
    <input id="em" type="email" placeholder="hello@ondroad.xyz" autocomplete="off">
    <div class="foot"><button id="c-save" type="button">Save contact details</button><span id="c-msg" class="msg" role="status"></span></div>
  </section>

  <section class="card" aria-labelledby="t-h">
    <h2 id="t-h">Terms</h2>
    <p>Guests tick "I agree to the terms" when they reserve a package. Anyone can read them from the bottom of the site.</p>
    <div id="t-state" class="note" role="status"></div>
    <label for="terms">Text</label>
    <textarea id="terms" maxlength="20000"></textarea>
    <small>Start a line with # for a heading and - for a bullet point. Leave a blank line between sections.</small>
    <div class="foot">
      <button id="t-save" type="button">Save terms</button>
      <button id="t-reset" class="ghost" type="button">Use the original draft</button>
      <span id="t-msg" class="msg" role="status"></span>
    </div>
  </section>
</main>
<script>
var $ = function (id) { return document.getElementById(id); };
var defaults = '';
function say(id, text, ok) { $(id).textContent = text; $(id).className = 'msg ' + (ok ? 'ok' : 'err'); }
function post(body) {
  return fetch('/api/admin/site', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); });
}
function phone(d) { return /^1\\d{10}$/.test(d) ? '+1 ' + d.slice(1, 4) + ' ' + d.slice(4, 7) + ' ' + d.slice(7) : (d ? '+' + d : ''); }
function show(d) {
  $('wa').value = phone(d.contact.whatsapp);
  $('ig').value = d.contact.instagram ? '@' + d.contact.instagram : '';
  $('em').value = d.contact.email;
  $('terms').value = d.terms;
  var custom = !!d.terms_updated_at;
  $('t-state').className = 'note' + (custom ? ' ok' : '');
  $('t-state').textContent = custom
    ? 'Last changed ' + new Date(d.terms_updated_at).toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'America/Antigua' }) + '.'
    : "Guests see the original draft. Read it, change anything that doesn't match how you run things, and save.";
}
fetch('/api/admin/site').then(function (r) { return r.json(); }).then(function (d) { defaults = d.default_terms; show(d); })
  .catch(function () { say('c-msg', 'Could not load the settings.'); });

$('c-save').addEventListener('click', function () {
  var b = this; b.disabled = true; $('c-msg').textContent = '';
  post({ contact: { whatsapp: $('wa').value, instagram: $('ig').value, email: $('em').value } })
    .then(function (x) {
      if (!x.ok) return say('c-msg', x.d.error || 'Could not save.');
      var t = $('terms').value; show(x.d); $('terms').value = t; // keep unsaved edits to the terms
      say('c-msg', 'Saved.', true);
    })
    .catch(function () { say('c-msg', 'Could not save.'); })
    .then(function () { b.disabled = false; });
});
$('t-save').addEventListener('click', function () {
  var b = this; b.disabled = true; $('t-msg').textContent = '';
  post({ terms: $('terms').value })
    .then(function (x) { if (!x.ok) return say('t-msg', x.d.error || 'Could not save.'); show(x.d); say('t-msg', 'Saved. Guests see the new terms now.', true); })
    .catch(function () { say('t-msg', 'Could not save.'); })
    .then(function () { b.disabled = false; });
});
$('t-reset').addEventListener('click', function () {
  if (!confirm('Replace the text in the box with the original draft? Nothing changes for guests until you save.')) return;
  $('terms').value = defaults;
  say('t-msg', 'Original draft loaded. Save to use it.', true);
});
</script></body></html>`;

  app.get('/admin/site', requireAdmin, (req, res) => res.type('html').send(PAGE));

  return { refresh };
}
