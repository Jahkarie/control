// site.js: the contact details, terms, FAQ and sponsor logos the guest site shows, edited at /admin/site.
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

// Used until the organizers save their own FAQ (an empty saved FAQ hides it). "# " starts a question, the lines
// below it are the answer, and "- " starts a bullet point.
export const DEFAULT_FAQ = `# Where's my login email?
It can take a minute or two. Still nothing?
- Check your spam, promotions and updates folders, or search your inbox for "On D' Road".
- Make sure you used the email address your invite was sent to.
- Each link works once and expires after 15 minutes. If yours expired, ask for a new one.
- Still stuck? Contact us using the details at the bottom of this page.

# How do invites work?
On D' Road is invite only. Once you're in, you get 2 invites to bring your people.
- Send them from your account. Each invite works once, and only with the email address you sent it to.
- Your guest accepts with that email and confirms they're 18 or older.
- Sent one to the wrong address? Contact us before it's accepted. We can cancel it and give you the invite back.

# Is there an age limit?
Yes. On D' Road is 18+ only. Bring photo ID, because you may be asked for it at the entrance and when you pick up your package.

# How do I pay?
- Reserve your package in your account. That holds your spot until the pay-by date shown there.
- Pay online with PayPal if you see the button (PayPal charges in US dollars), or use the cash payment details shown in your account.
- Paying in person? Bring your reference code. It starts with ODR-.
- Once your payment is confirmed, your entry pass shows up in your account and we email it to you.

# What if I miss the payment deadline?
Your reservation is cancelled automatically and the spot goes to someone else. We usually send a reminder the day before.
If spots are still open after that, you can reserve again from your account, but the price may have changed.

# Have a code?
Enter it when you reserve, or add it to your reservation before you pay. One code per order, and it can't be added once you've started paying with PayPal.
A code that covers the full price confirms your spot straight away.

# Can I change my size?
Yes, in your account, until sizes are locked. After that, contact us if yours needs to change.

# When and where is it?
Check your account. The date and details are posted there, and more unlock once your payment is confirmed.

# How does package pickup work?
- Once you've paid, pickup details show in your account. We'll email you too, closer to the date.
- Bring your entry pass and photo ID.
- Packages only go to the guest themselves, one per person. Nobody can collect yours for you.

# What do I wear?
Your full costume or full package gear. Regular clothes with makeup, dressing all in black or a few accessories don't count.
Without proper costume or gear you can be refused drinks and food and turned away from the band, with no refund.

# Can I get a refund?
- Haven't paid yet? Cancel your reservation in your account. Nothing is owed.
- Already paid? Request a refund in your account before the event. Your pass keeps working until we approve it, and you can change your mind until then.
- PayPal payments are refunded through PayPal. Cash payments are refunded in cash where you paid.
- The terms explain when refunds aren't given.

# Can I give my pass to someone else?
No. Passes are personal and can't be transferred, sold or shared. Want to bring someone? Send them one of your invites.
Can't make it? Request a refund in your account.

# I lost my phone or my pass.
No problem. The door team can find you by your email or reference code.
Your pass is also attached to your "You're confirmed" email, and you can log in from any phone to see it.`;

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

// Sponsor logos are an https:// link, or a file in the guest site repo like "sponsors/acme.png".
// The guest site only shows logos that pass the same checks.
const MAX_SPONSORS = 12;
const LOGO_PATH = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.(png|jpe?g|svg|webp|gif)$/;
function isHttpsUrl(v) {
  if (v.length > 500 || !/^https:\/\/[^\s"'<>\\]+$/.test(v)) return false;
  try { return new URL(v).protocol === 'https:'; } catch { return false; }
}
// Checks one sponsor from the admin page. Returns { sponsor } or { error } naming it (n counts from 1).
function checkSponsor(s, n) {
  const text = (k) => (s && typeof s[k] === 'string' ? s[k].trim() : '');
  const name = text('name'), logo = text('logo'), url = text('url');
  if (!name) return { error: `Give sponsor ${n} a name.` };
  if (name.length > 60) return { error: `The name of sponsor ${n} is too long. Keep it to 60 characters.` };
  if (!logo) return { error: `Add a logo for ${name}.` };
  if (!isHttpsUrl(logo) && !LOGO_PATH.test(logo)) {
    return { error: `The logo for ${name} needs to be an https:// link, or a file like sponsors/acme.png.` };
  }
  if (url && !isHttpsUrl(url)) return { error: `The link for ${name} needs to start with https://, or be left empty.` };
  return { sponsor: { name, logo, url } };
}
// The saved list, skipping anything that wouldn't pass the checks above. [] if none or unreadable.
function parseSponsors(raw) {
  let list;
  try { list = JSON.parse(raw || '[]'); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_SPONSORS).map((s, i) => checkSponsor(s, i + 1).sponsor).filter(Boolean);
}

export function registerSite({ app, pool, express, requireAdmin, FRONTEND_URL = process.env.FRONTEND_URL || 'https://controlfrontend.onrender.com' }) {
  const json = express.json({ limit: '100kb' }); // the terms and FAQ can be longer than the app-wide 10kb limit
  const KEYS = ['contact_whatsapp', 'contact_instagram', 'contact_email', 'terms', 'terms_updated_at', 'faq', 'sponsors'];
  // The admin page previews logos like "sponsors/acme.png" from the guest site, where they're served.
  const GUEST_SITE = FRONTEND_URL.replace(/\/$/, '') + '/';
  const save = (key, value) => pool.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
  const fail = (res, err) => { console.error(err); res.status(500).json({ error: 'Server error.' }); };

  async function getSite() {
    const r = await pool.query('SELECT key, value FROM settings WHERE key = ANY($1)', [KEYS]);
    const s = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
    return {
      contact: { whatsapp: s.contact_whatsapp || '', instagram: s.contact_instagram || '', email: s.contact_email || '' },
      terms: s.terms || DEFAULT_TERMS,
      terms_updated_at: s.terms_updated_at || null,
      faq: s.faq === undefined ? DEFAULT_FAQ : s.faq || '', // saved empty = hidden
      sponsors: parseSponsors(s.sponsors)
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
    try { res.json({ ...(await getSite()), default_terms: DEFAULT_TERMS, default_faq: DEFAULT_FAQ }); } catch (err) { fail(res, err); }
  });

  // Saves any of { contact: { whatsapp, instagram, email } }, { terms }, { faq } and { sponsors: [{ name, logo, url }] }.
  app.post('/api/admin/site', requireAdmin, json, async (req, res) => {
    const b = req.body || {};
    const bad = (error) => res.status(400).json({ error });
    try {
      // The FAQ and sponsors are checked before anything is saved.
      let faq, sponsors;
      if (b.faq !== undefined) {
        if (typeof b.faq !== 'string') return bad('The FAQ must be text.');
        faq = b.faq.replace(/\r\n?/g, '\n').trim();
        if (faq.length > 20000) return bad('The FAQ is too long. Keep it under 20,000 characters.');
      }
      if (b.sponsors !== undefined) {
        if (!Array.isArray(b.sponsors)) return bad('The sponsors must be a list.');
        if (b.sponsors.length > MAX_SPONSORS) return bad(`You can show up to ${MAX_SPONSORS} sponsors.`);
        sponsors = [];
        for (const [i, s] of b.sponsors.entries()) {
          const r = checkSponsor(s, i + 1);
          if (r.error) return bad(r.error);
          sponsors.push(r.sponsor);
        }
      }
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
      // Saving the original draft removes the saved copy, so guests keep getting the latest DEFAULT_FAQ.
      if (faq === DEFAULT_FAQ) await pool.query("DELETE FROM settings WHERE key = 'faq'");
      else if (faq !== undefined) await save('faq', faq);
      if (sponsors) await save('sponsors', JSON.stringify(sponsors));
      await refresh();
      res.json({ success: true, ...(await getSite()) });
    } catch (err) { fail(res, err); }
  });

  const PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0b0a09">
<title>Contact, terms &amp; FAQ | On D' Road</title>
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
label, .lbl { display: block; font-size: 11px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); margin: 22px 0 8px; }
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
.msg.ok { color: var(--good); } .msg.err { color: var(--bad); } .msg.dim { color: var(--muted); font-weight: 500; }
.hidden { display: none !important; }
code { font: 500 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--text); background: rgba(243, 236, 226, .07); padding: 1px 6px; border-radius: 5px; }
button.sm { padding: 9px 14px; font-size: 13px; }
.sp-list { display: grid; gap: 12px; margin-top: 20px; }
.sp-row { display: grid; grid-template-columns: 132px minmax(0, 1fr) auto; gap: 16px; align-items: start; padding: 16px; border: 1px solid var(--line); border-radius: 12px; background: rgba(0, 0, 0, .2); }
.sp-thumb { height: 72px; display: flex; align-items: center; justify-content: center; padding: 10px; border-radius: 10px; background: var(--bg); border: 1px solid var(--line); font-size: 12px; line-height: 1.35; text-align: center; color: var(--dim); overflow: hidden; }
.sp-thumb img { display: none; height: 32px; width: auto; max-width: 100%; object-fit: contain; }
.sp-thumb.on img { display: block; }
.sp-thumb.on span { display: none; }
.sp-thumb.bad { border-color: rgba(255, 106, 92, .35); }
.sp-thumb.bad span { color: var(--bad); }
.sp-fields { display: grid; gap: 12px; }
.sp-fields label { margin: 0 0 6px; }
.sp-fields input { padding: 10px 12px; font-size: 14px; }
.empty { color: var(--dim); font-size: 14px; margin: 18px 0 0; }
.add { margin-top: 14px; }
.strip { display: flex; flex-wrap: wrap; align-items: center; gap: 16px 26px; min-height: 66px; padding: 16px 18px; border-radius: 10px; background: var(--bg); border: 1px solid var(--line); }
.strip .with { font-size: 11px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
.strip .none { color: var(--dim); font-size: 14px; }
.strip a { display: block; border-radius: 4px; }
.strip img { display: block; height: 32px; width: auto; max-width: 160px; object-fit: contain; opacity: .65; transition: opacity .15s; }
.strip img:hover, .strip a:focus-visible img { opacity: 1; }
@media (max-width: 600px) { .sp-row { grid-template-columns: minmax(0, 1fr); } .sp-row > button { justify-self: start; } }
@media (max-width: 560px) { .brand .sub { display: none; } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style></head><body>
<header class="top">
  <div class="brand"><b>ON D<span>'</span> ROAD</b><span class="sub">Command Center</span></div>
  <a class="back" href="/admin">&larr; Back to overview</a>
</header>
<main class="wrap">
  <h1>Contact, terms &amp; FAQ</h1>
  <p class="lead">How guests reach you, the terms they agree to when they reserve a package, answers to the questions they ask most, and your sponsors.</p>

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

  <section class="card" aria-labelledby="f-h">
    <h2 id="f-h">FAQ</h2>
    <p>Shown on the site under "Good to know", to everyone, logged in or not.</p>
    <div id="f-state" class="note" role="status"></div>
    <label for="faq">Questions and answers</label>
    <textarea id="faq" maxlength="20000"></textarea>
    <small>Start each question with # and put its answer on the lines below. Start a line with - for a bullet point. Leave a blank line between questions. To hide the FAQ, empty the box and save.</small>
    <div class="foot">
      <button id="f-save" type="button">Save FAQ</button>
      <button id="f-reset" class="ghost" type="button">Use the original draft</button>
      <span id="f-msg" class="msg" role="status"></span>
    </div>
  </section>

  <section class="card" aria-labelledby="s-h">
    <h2 id="s-h">Sponsors</h2>
    <p>Their logos show in a small row at the bottom of the site, each linked to the sponsor's page if you add a link. Up to ${MAX_SPONSORS}.</p>
    <div id="sp-list" class="sp-list"></div>
    <p id="sp-empty" class="empty">No sponsors yet. The row stays hidden on the site until you add one.</p>
    <button id="sp-add" class="ghost sm add" type="button">+ Add sponsor</button>
    <small>For a logo, add the file to the <code>sponsors/</code> folder of the guest site repo and enter it as <code>sponsors/name.png</code>, or paste any https:// image link. PNG, JPG, SVG, WebP or GIF. A light or white logo on a transparent background shows up best on the dark footer.</small>
    <div class="lbl">How it looks on the site</div>
    <div id="sp-strip" class="strip"></div>
    <div class="foot"><button id="sp-save" type="button">Save sponsors</button><span id="sp-msg" class="msg" role="status"></span></div>
  </section>
</main>
<script>
var $ = function (id) { return document.getElementById(id); };
var GUEST_SITE = ${JSON.stringify(GUEST_SITE).replace(/</g, '\\u003c')};
var LOGO_PATH = new RegExp(${JSON.stringify(LOGO_PATH.source)});
var MAX_SPONSORS = ${MAX_SPONSORS};
var defaults = '', defaultFaq = '';
function say(id, text, ok) { $(id).textContent = text; $(id).className = 'msg ' + (ok ? 'ok' : 'err'); }
function post(body) {
  return fetch('/api/admin/site', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); });
}
function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }
function phone(d) { return /^1\\d{10}$/.test(d) ? '+1 ' + d.slice(1, 4) + ' ' + d.slice(4, 7) + ' ' + d.slice(7) : (d ? '+' + d : ''); }
function showContact(d) {
  $('wa').value = phone(d.contact.whatsapp);
  $('ig').value = d.contact.instagram ? '@' + d.contact.instagram : '';
  $('em').value = d.contact.email;
}
function showTerms(d) {
  $('terms').value = d.terms;
  var custom = !!d.terms_updated_at;
  $('t-state').className = 'note' + (custom ? ' ok' : '');
  $('t-state').textContent = custom
    ? 'Last changed ' + new Date(d.terms_updated_at).toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'America/Antigua' }) + '.'
    : "Guests see the original draft. Read it, change anything that doesn't match how you run things, and save.";
}
// Lines starting with "# " are questions, counted the way the guest site reads them.
function questions(text) {
  return text.split(/\\r?\\n/).filter(function (l) { return /^# +\\S/.test(l.trim()); }).length;
}
function showFaq(d) {
  $('faq').value = d.faq;
  var n = questions(d.faq), mine = n && d.faq !== defaultFaq;
  $('f-state').className = 'note' + (mine ? ' ok' : '');
  $('f-state').textContent = !d.faq ? 'The FAQ is hidden on the site. Add questions and save to show it, or start from the original draft.'
    : d.faq === defaultFaq ? "Guests see the original draft. Read it, change anything that doesn't match how you run things, and save."
    : !n ? 'There are no questions (lines starting with # ), so the FAQ is hidden on the site.'
    : 'Guests see your FAQ: ' + n + (n === 1 ? ' question.' : ' questions.');
}

// Sponsors: one row per sponsor, with a preview of its logo as the guest site will load it.
var rows = [], seq = 0, timer = null;
// Where the guest site loads a logo from, or '' when it would skip it.
function logoSrc(v) {
  if (/^https:\\/\\/\\S+$/.test(v)) return v;
  return LOGO_PATH.test(v) ? GUEST_SITE + v : '';
}
function preview(row) {
  var v = row.logo.value.trim(), src = logoSrc(v);
  row.rm.setAttribute('aria-label', 'Remove ' + (row.name.value.trim() || 'this sponsor'));
  if (v === row.v) return;
  row.v = v; row.src = src;
  if (!src) {
    row.img.removeAttribute('src');
    row.thumb.className = 'sp-thumb' + (v ? ' bad' : '');
    row.cap.textContent = v ? 'Not a valid logo link' : 'No logo yet';
    return;
  }
  row.thumb.className = 'sp-thumb';
  row.cap.textContent = 'Loading...';
  row.img.src = src;
}
function addRow(s) {
  var row = { el: el('div', 'sp-row'), thumb: el('div', 'sp-thumb'), img: el('img'), cap: el('span'), v: null, src: '' };
  var fields = el('div', 'sp-fields');
  function field(label, value, props) {
    var id = 'sp' + (++seq), wrap = el('div'), l = el('label', '', label), i = el('input');
    l.htmlFor = i.id = id;
    i.autocomplete = 'off';
    for (var k in props) i[k] = props[k];
    i.value = value || '';
    i.addEventListener('input', changed);
    wrap.appendChild(l); wrap.appendChild(i); fields.appendChild(wrap);
    return i;
  }
  row.name = field('Name', s.name, { maxLength: 60, placeholder: 'Acme Rum' });
  row.logo = field('Logo', s.logo, { maxLength: 500, inputMode: 'url', placeholder: 'sponsors/acme.png or https://...' });
  row.url = field('Link (optional)', s.url, { maxLength: 500, inputMode: 'url', placeholder: 'https://acme.com' });
  row.img.alt = '';
  row.img.addEventListener('load', function () { row.thumb.className = 'sp-thumb on'; });
  row.img.addEventListener('error', function () {
    row.thumb.className = 'sp-thumb bad';
    row.cap.textContent = /^https:/.test(row.src) ? "Can't load this image" : 'Not found on the guest site';
  });
  row.rm = el('button', 'ghost sm', 'Remove');
  row.rm.type = 'button';
  row.rm.addEventListener('click', function () {
    rows.splice(rows.indexOf(row), 1);
    row.el.remove();
    layout(); changed();
    $('sp-add').focus();
  });
  row.thumb.appendChild(row.img); row.thumb.appendChild(row.cap);
  row.el.appendChild(row.thumb); row.el.appendChild(fields); row.el.appendChild(row.rm);
  $('sp-list').appendChild(row.el);
  rows.push(row);
  preview(row);
  return row;
}
// The footer row as guests will see it: logos at their real size, muted until hovered.
function strip() {
  var box = $('sp-strip');
  box.replaceChildren();
  var shown = rows.filter(function (r) { return r.src && r.name.value.trim(); });
  if (!shown.length) return box.appendChild(el('span', 'none', 'Logos you add show up here.'));
  box.appendChild(el('span', 'with', 'With'));
  shown.forEach(function (r) {
    var img = el('img'), url = r.url.value.trim(), node = img;
    img.src = r.src; img.alt = img.title = r.name.value.trim();
    if (/^https:\\/\\/\\S+$/.test(url)) {
      node = el('a'); node.href = url; node.target = '_blank'; node.rel = 'noopener'; node.appendChild(img);
    }
    img.addEventListener('error', function () { node.remove(); });
    box.appendChild(node);
  });
}
function layout() {
  var full = rows.length >= MAX_SPONSORS;
  $('sp-empty').classList.toggle('hidden', rows.length > 0);
  $('sp-add').disabled = full;
  $('sp-add').textContent = full ? MAX_SPONSORS + ' is the most you can show' : '+ Add sponsor';
}
function changed() {
  $('sp-msg').textContent = 'Not saved yet.';
  $('sp-msg').className = 'msg dim';
  clearTimeout(timer);
  timer = setTimeout(function () { rows.forEach(preview); strip(); }, 350);
}
function showSponsors(list) {
  rows.forEach(function (r) { r.el.remove(); });
  rows = [];
  list.forEach(function (s) { addRow(s); });
  layout(); strip();
}

fetch('/api/admin/site').then(function (r) { return r.json(); }).then(function (d) {
  defaults = d.default_terms; defaultFaq = d.default_faq;
  showContact(d); showTerms(d); showFaq(d); showSponsors(d.sponsors || []);
}).catch(function () { say('c-msg', 'Could not load the settings.'); });

$('c-save').addEventListener('click', function () {
  var b = this; b.disabled = true; $('c-msg').textContent = '';
  post({ contact: { whatsapp: $('wa').value, instagram: $('ig').value, email: $('em').value } })
    .then(function (x) { if (!x.ok) return say('c-msg', x.d.error || 'Could not save.'); showContact(x.d); say('c-msg', 'Saved.', true); })
    .catch(function () { say('c-msg', 'Could not save.'); })
    .then(function () { b.disabled = false; });
});
$('t-save').addEventListener('click', function () {
  var b = this; b.disabled = true; $('t-msg').textContent = '';
  post({ terms: $('terms').value })
    .then(function (x) { if (!x.ok) return say('t-msg', x.d.error || 'Could not save.'); showTerms(x.d); say('t-msg', 'Saved. Guests see the new terms now.', true); })
    .catch(function () { say('t-msg', 'Could not save.'); })
    .then(function () { b.disabled = false; });
});
$('t-reset').addEventListener('click', function () {
  if (!confirm('Replace the text in the box with the original draft? Nothing changes for guests until you save.')) return;
  $('terms').value = defaults;
  say('t-msg', 'Original draft loaded. Save to use it.', true);
});
$('f-save').addEventListener('click', function () {
  var b = this; b.disabled = true; $('f-msg').textContent = '';
  post({ faq: $('faq').value })
    .then(function (x) {
      if (!x.ok) return say('f-msg', x.d.error || 'Could not save.');
      showFaq(x.d);
      var n = questions(x.d.faq);
      if (!x.d.faq) say('f-msg', 'Saved. The FAQ is hidden now.', true);
      else if (n) say('f-msg', 'Saved. Guests see the new FAQ now.', true);
      else say('f-msg', "Saved, but there are no questions, so guests don't see it.");
    })
    .catch(function () { say('f-msg', 'Could not save.'); })
    .then(function () { b.disabled = false; });
});
$('f-reset').addEventListener('click', function () {
  if (!confirm('Replace the text in the box with the original draft? Nothing changes for guests until you save.')) return;
  $('faq').value = defaultFaq;
  say('f-msg', 'Original draft loaded. Save to use it.', true);
});
$('sp-add').addEventListener('click', function () {
  if (rows.length >= MAX_SPONSORS) return;
  var row = addRow({});
  layout();
  row.name.focus();
});
$('sp-save').addEventListener('click', function () {
  var b = this;
  // Rows left completely empty are dropped first, so "sponsor 2" in an error is the second row on screen.
  rows.slice().forEach(function (r) {
    if (r.name.value.trim() || r.logo.value.trim() || r.url.value.trim()) return;
    rows.splice(rows.indexOf(r), 1);
    r.el.remove();
  });
  layout();
  b.disabled = true; $('sp-msg').textContent = '';
  post({ sponsors: rows.map(function (r) { return { name: r.name.value, logo: r.logo.value, url: r.url.value }; }) })
    .then(function (x) {
      if (!x.ok) return say('sp-msg', x.d.error || 'Could not save.');
      clearTimeout(timer);
      showSponsors(x.d.sponsors);
      say('sp-msg', x.d.sponsors.length ? 'Saved. The logos are on the site now.' : 'Saved. The sponsor row is hidden on the site.', true);
    })
    .catch(function () { say('sp-msg', 'Could not save.'); })
    .then(function () { b.disabled = false; });
});
</script></body></html>`;

  app.get('/admin/site', requireAdmin, (req, res) => res.type('html').send(PAGE));

  return { refresh };
}
