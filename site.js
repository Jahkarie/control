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
<meta name="robots" content="noindex"><meta name="theme-color" content="#09080b">
<title>Contact, terms &amp; FAQ | On D' Road</title>
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
.card { margin-bottom: 22px; }
.card > p { color: var(--muted); margin: 0; }
label, .lbl { display: block; font-family: var(--mono); font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 24px 0 8px; }
textarea, input { width: 100%; font: 500 15px var(--body); color: var(--text); background: var(--well); border: 1px solid var(--line-strong); border-radius: 8px; padding: 13px 14px; transition: border-color .15s, box-shadow .15s; }
textarea:hover, input:hover { border-color: rgba(246, 241, 232, .32); }
textarea { min-height: 420px; resize: vertical; line-height: 1.55; }
textarea:focus, input:focus { outline: none; border-color: var(--cyan); box-shadow: 0 0 0 3px rgba(30, 227, 255, .16); }
textarea::placeholder, input::placeholder { color: var(--dim); }
small { display: block; color: var(--dim); font-size: 13px; margin-top: 8px; }
.note { margin-top: 16px; padding: 12px 14px; border-radius: 8px; font-size: 14px; background: rgba(255, 229, 0, .06); border: 1px solid rgba(255, 229, 0, .35); border-left: 4px solid var(--warn); color: var(--warn); }
.note.ok { background: rgba(246, 241, 232, .04); border-color: var(--line); border-left-color: var(--good); color: var(--muted); }
.foot { display: flex; align-items: center; gap: 12px; margin-top: 24px; flex-wrap: wrap; }
.msg.dim { color: var(--muted); font-weight: 500; }
.hidden { display: none !important; }
code { font: 400 12.5px var(--mono); color: var(--text); background: rgba(246, 241, 232, .07); padding: 1px 6px; border-radius: 5px; }
button.sm { padding: 9px 15px 8px; font-size: 13px; }
.sp-list { display: grid; gap: 12px; margin-top: 20px; }
.sp-row { display: grid; grid-template-columns: 132px minmax(0, 1fr) auto; gap: 16px; align-items: start; padding: 16px; border: 1px solid var(--line); border-radius: 10px; background: var(--well); }
.sp-thumb { height: 72px; display: flex; align-items: center; justify-content: center; padding: 10px; border-radius: 8px; background: var(--bg); border: 1px dashed var(--line-strong); font-size: 12px; line-height: 1.35; text-align: center; color: var(--dim); overflow: hidden; }
.sp-thumb img { display: none; height: 32px; width: auto; max-width: 100%; object-fit: contain; }
.sp-thumb.on { border-style: solid; border-color: var(--line); }
.sp-thumb.on img { display: block; }
.sp-thumb.on span { display: none; }
.sp-thumb.bad { border-color: rgba(255, 77, 77, .45); }
.sp-thumb.bad span { color: var(--bad); }
.sp-fields { display: grid; gap: 12px; }
.sp-fields label { margin: 0 0 6px; }
.sp-fields input { padding: 10px 12px; font-size: 14px; }
.empty { color: var(--dim); font-size: 14px; margin: 18px 0 0; }
.add { margin-top: 14px; }
/* Preview of the guest site's sponsor row */
.strip { display: flex; flex-wrap: wrap; align-items: center; gap: 16px 26px; min-height: 66px; padding: 16px 18px; border-radius: 10px; background: var(--bg); border: 1px dashed var(--line-strong); }
.strip .with { font-family: var(--mono); font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--accent-ink); background: var(--good); padding: 5px 10px 4px; clip-path: var(--torn); transform: rotate(-3deg); }
.strip .none { color: var(--dim); font-size: 14px; }
.strip a { display: block; border-radius: 4px; }
.strip img { display: block; height: 32px; width: auto; max-width: 160px; object-fit: contain; opacity: .65; filter: grayscale(1); transition: opacity .15s, filter .15s; }
.strip img:hover, .strip a:focus-visible img { opacity: 1; filter: none; }
@media (max-width: 600px) { .sp-row { grid-template-columns: minmax(0, 1fr); } .sp-row > button { justify-self: start; } }
</style></head><body>
<header class="top">
  <div class="brand"><svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path fill="currentColor" d="M29.1 16.4C28.6 17 25.8 17.4 24.9 17.9C24 18.3 24 18.6 23.9 19.1C23.7 19.5 23.6 19.9 23.7 20.5C23.7 21.1 24.2 22 24.2 22.6C24.2 23.3 24.2 24.2 23.8 24.6C23.3 24.9 22.3 24.7 21.6 24.6C20.9 24.6 20.1 24.2 19.5 24.1C18.9 24 18.5 23.7 18.1 24.2C17.7 24.6 17.7 25.9 17.2 26.7C16.8 27.5 16.1 29.2 15.6 28.9C15.1 28.6 14.7 25.8 14.2 25C13.8 24.1 13.6 24.1 13.1 24C12.7 23.8 12.3 23.9 11.7 24C11.2 24.1 10.5 24.3 9.7 24.5C8.9 24.7 7.5 25.4 6.8 25.2C6 25.1 5.4 24.5 5.4 23.8C5.4 23.1 6.4 21.7 6.7 21C7 20.2 7.6 19.6 7.2 19.1C6.7 18.7 4.6 18.7 4 18.2C3.4 17.8 3 16.9 3.6 16.4C4.2 15.9 6.6 15.5 7.4 15.1C8.1 14.7 8 14.4 8 13.9C8.1 13.5 8 13 7.9 12.5C7.7 11.9 7.4 11.1 7.3 10.4C7.3 9.7 7.2 8.7 7.5 8.3C7.9 7.9 8.7 7.8 9.4 7.8C10 7.8 10.9 8.3 11.4 8.2C12 8.1 12.2 8 12.6 7.1C12.9 6.2 13 3.5 13.5 3C14 2.5 15 3.2 15.6 3.9C16.2 4.6 16.6 6.5 17 7.3C17.5 8 17.8 8 18.2 8.3C18.6 8.7 18.9 9 19.3 9.2C19.7 9.4 19.9 9.6 20.6 9.5C21.3 9.5 22.6 8.7 23.2 8.8C23.9 8.8 24.5 9.3 24.6 9.9C24.6 10.5 23.7 11.7 23.5 12.4C23.4 13 23.1 13.4 23.9 13.7C24.7 14 27.4 13.9 28.2 14.4C29.1 14.8 29.7 15.8 29.1 16.4ZM12.7 3.8a1.5 1.5 0 1 1 3.1 0a1.5 1.5 0 1 1 -3.1 0ZM23 9a1.4 1.4 0 1 1 2.9 0a1.4 1.4 0 1 1 -2.9 0ZM27.1 15.5a1.6 1.6 0 1 1 3.1 0a1.6 1.6 0 1 1 -3.1 0ZM14.5 28.9a1.5 1.5 0 1 1 3 0a1.5 1.5 0 1 1 -3 0ZM5.5 23.7a1.4 1.4 0 1 1 2.8 0a1.4 1.4 0 1 1 -2.8 0ZM1.4 17.3a1.5 1.5 0 1 1 3.1 0a1.5 1.5 0 1 1 -3.1 0ZM27.4 5.4a1.2 1.2 0 1 1 2.4 0a1.2 1.2 0 1 1 -2.4 0ZM2.6 27a1 1 0 1 1 2 0a1 1 0 1 1 -2 0ZM26.6 28.2a0.8 0.8 0 1 1 1.6 0a0.8 0.8 0 1 1 -1.6 0Z"/></svg><b>ON D<span>'</span> ROAD</b><span class="sub">Command Center</span></div>
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
