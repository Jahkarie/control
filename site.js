// site.js: the contact details, terms, FAQ and sponsor logos the guest site shows, edited at /admin/site
// ("Site, contact, terms & FAQ"), which also has the site lock's switch, unlock time and preview link (see lock.js).
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

export function registerSite({ app, pool, express, requireAdmin, lock, FRONTEND_URL = process.env.FRONTEND_URL || 'https://controlfrontend.onrender.com' }) {
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

  // Public: the guest site shows these before anyone logs in. It's also how the guest site learns about the site lock:
  // while locked (and without a valid preview header) the answer is only { locked: true }, nothing else.
  // Otherwise the usual details plus locked: false, and preview: true when the preview header is what let it in.
  app.get('/api/site', async (req, res) => {
    try {
      const gate = lock ? await lock.check(req) : { locked: false, preview: false };
      res.set('Cache-Control', 'no-store');
      if (gate.locked) return res.json({ locked: true });
      res.json({ ...(await getSite()), locked: false, ...(gate.preview ? { preview: true } : {}) });
    } catch (err) { fail(res, err); }
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
<meta name="robots" content="noindex"><meta name="theme-color" content="#0a0a0b">
<title>Site, contact, terms &amp; FAQ | On D' Road</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
/* Night Kinetic, admin edition: matte charcoal, one sharp accent (safety orange), hairline rules and square corners.
   Concrete is kept for utility surfaces (previews, dialogs, toasts). Calm and dense for daily work. */
:root { --bg: #0a0a0b; --surface: #141416; --surface-2: #1a1a1d; --raise: #232327; --well: #0a0a0b; --line: rgba(236, 235, 230, .1); --line-strong: rgba(236, 235, 230, .24); --text: #ecebe6; --muted: #a6a59f; --dim: #8a8983; --accent: #ff5a1f; --accent-hi: #ff7440; --accent-ink: #141416; --good: #b6ff3b; --warn: #ffc02e; --bad: #ff7a6b; --cyan: #22e1ff; --concrete: #c9c8c3; --concrete-2: #e4e3df; --ink: #141416; --ink-2: #47463f; --display: 'Archivo', 'Helvetica Neue', Arial, sans-serif; --body: 'Archivo', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; --mono: 'Space Mono', ui-monospace, SFMono-Regular, Menlo, monospace; --chev: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none' stroke='%23ecebe6' stroke-width='1.6'%3E%3Cpath d='M1 1.5l5 5 5-5'/%3E%3C/svg%3E"); --xh: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28' fill='none' stroke='%23141416' stroke-opacity='0.55' stroke-width='1'%3E%3Ccircle cx='14' cy='14' r='6.5'/%3E%3Cpath d='M14 0v28M0 14h28'/%3E%3C/svg%3E"); color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 var(--body); -webkit-font-smoothing: antialiased; }
::selection { background: var(--accent); color: var(--accent-ink); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.top { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; gap: 10px 16px; flex-wrap: wrap; min-height: 60px; padding: 10px clamp(16px, 3vw, 32px); background: rgba(10, 10, 11, .9); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-bottom: 1px solid var(--line); }
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
.card { margin-bottom: 22px; }
.card > p { color: var(--muted); margin: 0; }
label, .lbl { display: block; font-family: var(--mono); font-size: 11px; font-weight: 400; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 24px 0 8px; }
textarea, input { width: 100%; min-height: 44px; font: 500 15px var(--body); color: var(--text); background: var(--well); border: 1px solid var(--line-strong); border-radius: 0; padding: 11px 13px; transition: border-color .15s, box-shadow .15s; }
textarea:hover, input:hover { border-color: rgba(236, 235, 230, .42); }
textarea { min-height: 420px; resize: vertical; line-height: 1.55; }
textarea:focus, input:focus { outline: none; border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
textarea::placeholder, input::placeholder { color: var(--dim); }
small { display: block; color: var(--dim); font-size: 13px; margin-top: 8px; }
.note { margin-top: 16px; padding: 11px 14px; font-size: 14px; background: rgba(255, 192, 46, .06); border: 1px solid rgba(255, 192, 46, .32); border-left: 3px solid var(--warn); color: var(--warn); }
.note.ok { background: var(--surface-2); border-color: var(--line); border-left-color: var(--good); color: var(--muted); }
.foot { display: flex; align-items: center; gap: 12px; margin-top: 24px; flex-wrap: wrap; }
.msg.dim { color: var(--muted); font-weight: 500; }
.hidden { display: none !important; }
code { font: 400 12.5px var(--mono); color: var(--text); background: rgba(236, 235, 230, .07); padding: 1px 6px; }
button.sm { min-height: 36px; padding: 0 14px; font-size: 12px; }
.sp-list { display: grid; gap: 10px; margin-top: 20px; }
.sp-row { display: grid; grid-template-columns: 132px minmax(0, 1fr) auto; gap: 16px; align-items: start; padding: 16px; border: 1px solid var(--line); background: var(--well); }
.sp-thumb { height: 72px; display: flex; align-items: center; justify-content: center; padding: 10px; background: var(--bg); border: 1px dashed var(--line-strong); font-size: 12px; line-height: 1.35; text-align: center; color: var(--dim); overflow: hidden; }
.sp-thumb img { display: none; height: 32px; width: auto; max-width: 100%; object-fit: contain; }
.sp-thumb.on { border-style: solid; border-color: var(--line); }
.sp-thumb.on img { display: block; }
.sp-thumb.on span { display: none; }
.sp-thumb.bad { border-color: rgba(255, 122, 107, .45); }
.sp-thumb.bad span { color: var(--bad); }
.sp-fields { display: grid; gap: 12px; }
.sp-fields label { margin: 0 0 6px; }
.sp-fields input { min-height: 40px; padding: 9px 12px; font-size: 14px; }
.empty { color: var(--dim); font-size: 14px; margin: 18px 0 0; }
.add { margin-top: 14px; }
/* Preview of the guest site's sponsor row, on the footer's dark canvas */
.strip { display: flex; flex-wrap: wrap; align-items: center; gap: 16px 26px; min-height: 66px; padding: 16px 18px; background: var(--bg); border: 1px solid var(--line); border-top-color: var(--line-strong); }
.strip .with { font-family: var(--mono); font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--dim); }
.strip .none { color: var(--dim); font-size: 14px; }
.strip a { display: block; }
.strip img { display: block; height: 32px; width: auto; max-width: 160px; object-fit: contain; opacity: .7; filter: grayscale(1) brightness(1.4); transition: opacity .15s, filter .15s; }
.strip img:hover, .strip a:focus-visible img { opacity: 1; filter: none; }
@media (max-width: 600px) { .sp-row { grid-template-columns: minmax(0, 1fr); } .sp-row > button { justify-self: start; } }
/* Site lock: a big two-way switch (orange = locked, acid green = open) over the state line */
.lock-card { border-top: 2px solid var(--line-strong); }
.lock-card.is-locked { border-top-color: var(--accent); }
.lock-card.is-open { border-top-color: var(--good); }
.lock-switch { display: grid; grid-template-columns: 1fr 1fr; align-items: stretch; justify-content: stretch; gap: 4px; width: 100%; max-width: 440px; min-height: 72px; margin-top: 20px; padding: 4px; color: var(--dim); background: var(--well); border: 1px solid var(--line-strong); }
.lock-switch:hover { background: var(--well); border-color: var(--text); }
.lock-switch:disabled { cursor: progress; }
.ls-opt { display: flex; align-items: center; justify-content: center; gap: 10px; font-family: var(--display); font-stretch: 125%; font-weight: 800; font-size: 20px; letter-spacing: .02em; transition: background .15s, color .15s; }
.ls-opt::before { content: ''; width: 9px; height: 9px; border: 1.5px solid currentColor; }
.lock-switch[aria-checked=true] .ls-locked { background: var(--accent); color: var(--accent-ink); }
.lock-switch[aria-checked=false] .ls-open { background: var(--good); color: var(--accent-ink); }
.lock-switch[aria-checked=true] .ls-locked::before, .lock-switch[aria-checked=false] .ls-open::before { background: currentColor; }
.card > p.lock-state { margin: 16px 0 0; font-family: var(--mono); font-size: 13px; letter-spacing: .02em; color: var(--text); }
.row { display: flex; flex-wrap: wrap; gap: 8px; }
.row input { flex: 1 1 220px; width: auto; }
input:disabled, .row input:disabled { opacity: .5; cursor: not-allowed; }
.link-row code { display: block; padding: 11px 13px; font-size: 12.5px; line-height: 1.5; word-break: break-all; background: var(--well); border: 1px solid var(--line); }
/* Dialog: a concrete utility panel with registration marks */
dialog { width: min(480px, calc(100vw - 32px)); padding: 0; border: 0; border-radius: 0; color: var(--ink); background: var(--xh) no-repeat 8px 8px / 18px, var(--xh) no-repeat right 8px bottom 8px / 18px, var(--concrete); box-shadow: 0 30px 80px -20px rgba(0, 0, 0, .9); }
dialog::backdrop { background: rgba(5, 5, 6, .76); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
dialog :focus-visible { outline-color: var(--ink); }
dialog form { padding: 34px 26px 24px; }
dialog h3 { margin: 0; font-family: var(--display); font-size: 24px; font-weight: 800; font-stretch: 122%; line-height: 1.05; text-transform: uppercase; color: var(--ink); }
dialog p { margin: 10px 0 0; color: var(--ink-2); font-size: 14.5px; }
dialog button { border-color: var(--ink); }
dialog button.ghost { color: var(--ink); border-color: rgba(20, 20, 22, .45); }
dialog button.ghost:hover { border-color: var(--ink); background: rgba(20, 20, 22, .06); }
dialog button.danger-solid { background: #b3261e; border-color: #b3261e; color: #fff; }
dialog button.danger-solid:hover { background: #941c15; border-color: #941c15; }
.dlg-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 24px; }
</style></head><body>
<header class="top">
  <div class="brand"><svg class="mark" viewBox="0 0 30 18" aria-hidden="true" focusable="false"><path fill="#e4e3df" d="M0 6h30v12H0z"/><path fill="#0a0a0b" d="M18.2 0h5.6l-4.6 18h-5.6z"/><path fill="#ff5a1f" d="M19.6 0h2.8l-4.6 18h-2.8z"/></svg><b>ON D<span>'</span> <i>ROAD</i></b><span class="sub">Command Center</span></div>
  <a class="back" href="/admin">&larr; Back to overview</a>
</header>
<main class="wrap">
  <h1>Site, contact, terms &amp; FAQ</h1>
  <p class="lead">Whether the site is open, how guests reach you, the terms they agree to when they reserve a package, answers to the questions they ask most, and your sponsors.</p>

  <section class="card lock-card" id="site-lock" aria-labelledby="l-h">
    <h2 id="l-h">Site lock</h2>
    <p>While the site is locked, everyone sees only the trailer. Logins, invites and sign-ups are off. Your preview link shows you the real site.</p>
    <button class="lock-switch" id="l-switch" type="button" role="switch" aria-checked="true" aria-label="Site locked" aria-describedby="l-state" disabled>
      <span class="ls-opt ls-locked">Locked</span><span class="ls-opt ls-open">Open</span>
    </button>
    <p id="l-state" class="lock-state" role="status">Loading&hellip;</p>
    <label for="l-at">Unlock automatically at</label>
    <div class="row"><input id="l-at" type="datetime-local" autocomplete="off"><button id="l-set" type="button">Set time</button><button id="l-clear" class="ghost" type="button">Clear</button></div>
    <small id="l-at-help">Antigua time. The site opens by itself then. Leave it empty to keep it locked until you switch it open.</small>
    <div class="lbl">Preview link</div>
    <div class="link-row"><code id="l-url">&hellip;</code></div>
    <div class="foot"><button id="l-copy" class="ghost" type="button">Copy preview link</button><button id="l-rotate" class="ghost" type="button">Reset preview link</button><span id="l-msg" class="msg" role="status"></span></div>
    <small>Opens the real site on any phone or laptop while it's locked. It's yours: don't share it. Resetting it makes the old link stop working.</small>
  </section>

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
<dialog id="dlg" aria-labelledby="dlg-title" aria-describedby="dlg-text">
  <form id="dlg-form" method="dialog">
    <h3 id="dlg-title"></h3>
    <p id="dlg-text"></p>
    <div class="dlg-actions">
      <button class="ghost" type="button" id="dlg-cancel">Cancel</button>
      <button type="submit" id="dlg-ok">Confirm</button>
    </div>
  </form>
</dialog>
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

// Styled replacement for confirm(): resolves true when confirmed.
function ask(o) {
  return new Promise(function (resolve) {
    var dlg = $('dlg'), done = false;
    $('dlg-title').textContent = o.title;
    $('dlg-text').textContent = o.text || '';
    $('dlg-ok').textContent = o.ok || 'Confirm';
    $('dlg-ok').className = o.danger ? 'danger-solid' : '';
    function finish(v) { if (done) return; done = true; $('dlg-form').onsubmit = null; $('dlg-cancel').onclick = null; dlg.onclose = null; if (dlg.open) dlg.close(); resolve(v); }
    $('dlg-form').onsubmit = function (e) { e.preventDefault(); finish(true); };
    $('dlg-cancel').onclick = function () { finish(false); };
    dlg.onclose = function () { finish(false); };
    dlg.showModal();
    $('dlg-cancel').focus();
  });
}

// ---------- Site lock ----------
// The unlock time is a datetime-local input in Antigua time (UTC-4 all year, no daylight saving); "-04:00" is added when sending.
var AST = 4 * 36e5, lockNow = null;
function toInput(iso) { return iso ? new Date(new Date(iso).getTime() - AST).toISOString().slice(0, 16) : ''; }
function fromInput(v) { return v ? v + '-04:00' : ''; }
// "Sat 1 Nov, 8:00 PM" in Antigua time.
function antiguaTime(iso) {
  var p = {};
  new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Antigua' })
    .formatToParts(new Date(iso)).forEach(function (x) { p[x.type] = x.value; });
  return p.weekday + ' ' + p.day + ' ' + p.month + ', ' + p.hour + ':' + p.minute + ' ' + p.dayPeriod;
}
function lockCall(path, body) {
  return fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)
    .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'Something went wrong.'); return d; }); });
}
// Which controls work: the time only matters while locked, and Clear only when a time is set.
function lockControls(busy) {
  var d = lockNow || {};
  $('l-switch').disabled = busy || !lockNow;
  $('l-at').disabled = $('l-set').disabled = busy || !d.locked;
  $('l-clear').disabled = busy || !d.locked || !d.site_unlock_at;
  $('l-rotate').disabled = busy || !lockNow;
}
function lockBusy(on) { lockControls(on); }
function showLock(d) {
  lockNow = d;
  var auto = !d.locked && d.site_lock === 'on' && d.site_unlock_at;
  $('site-lock').className = 'card lock-card ' + (d.locked ? 'is-locked' : 'is-open');
  $('l-switch').setAttribute('aria-checked', d.locked ? 'true' : 'false');
  $('l-state').textContent = d.locked
    ? (d.site_unlock_at ? 'Locked. Opens on ' + antiguaTime(d.site_unlock_at) + ' (Antigua time).' : 'Locked. It stays locked until you switch it open.')
    : auto ? 'Opened automatically on ' + antiguaTime(d.site_unlock_at) + ' (Antigua time).' : 'Open. Everyone with an invite can get in.';
  $('l-at').value = d.locked ? toInput(d.site_unlock_at) : '';
  $('l-at').min = toInput(new Date().toISOString());
  lockControls(false);
  $('l-at-help').textContent = d.locked
    ? 'Antigua time. The site opens by itself then. Leave it empty to keep it locked until you switch it open.'
    : 'The site is open, so there is nothing to schedule. Lock it again to set a time.';
  $('l-url').textContent = d.preview_url;
}
function lockSave(body, done) {
  lockBusy(true); $('l-msg').textContent = '';
  return lockCall('/api/admin/site-lock', body).then(function (d) { showLock(d); say('l-msg', done(d), true); })
    .catch(function (e) { say('l-msg', e.message); }).then(function () { lockBusy(false); });
}
$('l-switch').addEventListener('click', function () {
  if (!lockNow) return;
  var open = lockNow.locked;
  ask(open
    ? { title: 'Open the site?', text: 'Everyone sees the real site straight away. Logins, invites and sign-ups work again.', ok: 'Open the site' }
    : { title: 'Lock the site?', text: "Everyone sees only the trailer from now on, and guests can't log in, sign up or use their account until you open it again. Your preview link keeps working.", ok: 'Lock the site', danger: true })
    .then(function (yes) {
      if (!yes) return $('l-switch').focus();
      lockSave({ site_lock: open ? 'off' : 'on' }, function (d) { return d.locked ? 'Locked. Guests see only the trailer.' : 'Open. Guests see the site now.'; })
        .then(function () { $('l-switch').focus(); });
    });
});
$('l-set').addEventListener('click', function () {
  var v = $('l-at').value;
  if (!v) { say('l-msg', 'Pick a date and time first.'); return $('l-at').focus(); }
  lockSave({ site_unlock_at: fromInput(v) }, function (d) { return 'Saved. The site opens on ' + antiguaTime(d.site_unlock_at) + '.'; });
});
$('l-clear').addEventListener('click', function () {
  $('l-at').value = '';
  lockSave({ site_unlock_at: '' }, function () { return 'Cleared. The site stays locked until you switch it open.'; });
});
$('l-copy').addEventListener('click', function () {
  if (!lockNow) return;
  navigator.clipboard.writeText(lockNow.preview_url).then(function () { say('l-msg', 'Preview link copied.', true); },
    function () { say('l-msg', 'Copy failed. Select the link above and copy it.'); });
});
$('l-rotate').addEventListener('click', function () {
  ask({ title: 'Reset the preview link?', text: 'The link you have now stops working straight away, everywhere it was opened. You get a new one to copy.', ok: 'Reset link', danger: true })
    .then(function (yes) {
      if (!yes) return $('l-rotate').focus();
      lockBusy(true); $('l-msg').textContent = '';
      lockCall('/api/admin/site-lock/preview-reset', {}).then(function (d) { showLock(d); say('l-msg', 'New preview link ready. The old one no longer works.', true); })
        .catch(function (e) { say('l-msg', e.message); }).then(function () { lockBusy(false); $('l-rotate').focus(); });
    });
});
lockCall('/api/admin/site-lock').then(showLock).catch(function (e) { $('l-state').textContent = 'Could not load the site lock: ' + e.message; });

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
