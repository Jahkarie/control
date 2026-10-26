// event.js: event details guests see in their account, and email updates to groups of guests.
// The details belong to the current event (columns on its events row, see events.js); its name is the title of the
// guest's event page. "When", the general details and the poster show to every approved guest. The paid-only details
// (meetup spot, pickup info), the location and the event guide (guide.js, once published) are only sent to guests whose
// order for this event is paid.
// Guests still waiting for approval, or declined, get nothing.
import { WM_LITE } from './brand.js';
import { renderEmail } from './emails.js';
import { CUR } from './events.js';
import { publishedGuide, guideAdmin } from './guide.js';

// The poster is an https:// link, or an image in the guest site repo like "art/poster.jpg": the same checks site.js
// uses for sponsor logos, so the guest site can load it the same way.
const POSTER_PATH = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.(png|jpe?g|svg|webp|gif)$/;
function isHttpsUrl(v) {
  if (v.length > 500 || !/^https:\/\/[^\s"'<>\\]+$/.test(v)) return false;
  try { return new URL(v).protocol === 'https:'; } catch { return false; }
}
const isPoster = (v) => isHttpsUrl(v) || POSTER_PATH.test(v);

// Who each group email goes to. Paid and reserved are the current event's orders; everyone approved is the roster.
const AUDIENCES = {
  paid: `SELECT DISTINCT LOWER(guest_email) AS email FROM orders WHERE status = 'PAID' AND event_id = ${CUR}`,
  reserved: `SELECT DISTINCT LOWER(guest_email) AS email FROM orders WHERE status = 'RESERVED' AND event_id = ${CUR}`,
  // Approved guests only: people still waiting for approval, or declined, get no group emails (they'd carry the
  // event details that /api/event keeps from them, and a declined request gets no email at all).
  all: "SELECT DISTINCT LOWER(email) AS email FROM guests WHERE approval = 'APPROVED'"
};
const BATCH = 100; // Resend's batch limit

export function registerEvent({ app, pool, resend, EMAIL_FROM, FRONTEND_URL, requireAuth, requireRole, mail }) {
  // Field -> column on the events row (fixed names, never from a request).
  const KEYS = { when: 'event_when', info: 'event_info', paid_info: 'event_paid_info', location: 'event_location', poster: 'event_poster' };
  const LIMITS = { when: 120, info: 3000, paid_info: 3000, location: 300, poster: 500 };

  // The current event's name and details.
  async function getEvent() {
    const r = await pool.query("SELECT * FROM events WHERE status = 'current'");
    const s = r.rows[0] || {};
    const poster = s.event_poster || '';
    return { name: s.name || '', when: s.event_when || '', info: s.event_info || '', paid_info: s.event_paid_info || '',
      location: s.event_location || '', poster: isPoster(poster) ? poster : '' };
  }

  // Builds an organizer update. withPaid adds the paid-only details (paid audience and tests only).
  function buildUpdate(subject, message, ev, withPaid) {
    const details = ev ? [ev.info, withPaid ? ev.paid_info : ''].filter(Boolean).join('\n\n') : '';
    return renderEmail({
      tone: 'accent', tag: 'From the organizers', title: subject,
      lines: message.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
      // The location stays out of emails: paid guests see it in their account, and the organizers reveal it
      // by group email (in the message itself) when they choose.
      details: ev && ev.when ? [['When', ev.when]] : [],
      callout: details ? { label: 'Event details', text: details } : null,
      cta: { text: 'Open my account', url: FRONTEND_URL }
    });
  }

  // ---------- Guest ----------
  const NOTHING = { when: '', info: '', paid: false, paid_info: '', has_paid_info: false, location: '', poster: '' };
  // name: the current event's, for the title of the guest's event page (an older guest site ignores it).
  app.get('/api/event', requireAuth, async (req, res) => {
    try {
      // Only approved guests see the event. Pending and declined requests (and removed guests) get empty details.
      const g = await pool.query('SELECT approval FROM guests WHERE LOWER(email) = $1 ORDER BY id LIMIT 1', [req.userEmail]);
      if (!g.rowCount || (g.rows[0].approval && g.rows[0].approval !== 'APPROVED')) return res.json(NOTHING);
      const ev = await getEvent();
      const paid = await pool.query(`SELECT 1 FROM orders WHERE LOWER(guest_email) = $1 AND status = 'PAID' AND event_id = ${CUR} LIMIT 1`, [req.userEmail]);
      // The guide: the published copy, for a paid guest of this event only (a free pass counts). Everyone else gets no
      // guide key at all, and an older guest site ignores it.
      const guide = paid.rowCount ? await publishedGuide(pool) : null;
      res.json({
        name: ev.name,
        when: ev.when, info: ev.info,
        paid: !!paid.rowCount,
        paid_info: paid.rowCount ? ev.paid_info : '',
        has_paid_info: !!ev.paid_info,
        // Like paid_info: only once the guest's order is paid.
        location: paid.rowCount ? ev.location : '',
        poster: ev.poster,
        ...(guide ? { guide } : {})
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ---------- Admin: event details ----------
  app.get('/api/admin/event', requireRole('OWNER', 'ADMIN'), async (req, res) => {
    try {
      res.json(await getEvent());
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // Saves the fields sent. One left out keeps its value, so an older copy of the page can't wipe the newer ones.
  app.post('/api/admin/event', requireRole('OWNER', 'ADMIN'), async (req, res) => {
    const b = req.body || {};
    const vals = {};
    for (const field of Object.keys(KEYS)) {
      if (b[field] === undefined || b[field] === null) continue;
      vals[field] = typeof b[field] === 'string' ? b[field].trim().slice(0, LIMITS[field]) : '';
    }
    if (vals.poster && !isPoster(vals.poster)) {
      return res.status(400).json({ error: 'The poster needs to be an https:// image link, or a file in the guest site like art/poster.jpg.' });
    }
    try {
      const cols = Object.keys(vals);
      if (cols.length) {
        // One statement, on the current event's row.
        await pool.query(`UPDATE events SET ${cols.map((f, n) => `${KEYS[f]} = $${n + 1}`).join(', ')} WHERE status = 'current'`, cols.map((f) => vals[f]));
      }
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ---------- Admin: email updates ----------
  app.get('/api/admin/broadcasts', requireRole('OWNER', 'ADMIN'), async (req, res) => {
    try {
      const counts = {};
      for (const [k, q] of Object.entries(AUDIENCES)) {
        counts[k] = parseInt((await pool.query(`SELECT COUNT(*) FROM (${q}) x`)).rows[0].count, 10);
      }
      // The current event's sends (?event=all: every event's, for the reset page's copy).
      const all = req.query.event === 'all';
      const log = await pool.query(
        `SELECT b.id, b.audience, b.subject, b.recipients, b.sent, b.failed, b.created_at, b.event_id, b.kind${all ? ', b.message' : ''}
         FROM broadcasts b ${all ? '' : `WHERE b.event_id = ${CUR}`} ORDER BY b.id DESC ${all ? '' : 'LIMIT 20'}`);
      res.json({ counts, log: log.rows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  app.post('/api/admin/broadcast', requireRole('OWNER', 'ADMIN'), async (req, res) => {
    const audience = req.body?.audience;
    const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim().slice(0, 120) : '';
    const message = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, 5000) : '';
    const includeEvent = !!req.body?.include_event;
    const testTo = typeof req.body?.test_email === 'string' ? req.body.test_email.trim().toLowerCase() : '';
    if (!subject || !message) return res.status(400).json({ error: 'Write a subject and a message.' });
    if (!testTo && !AUDIENCES[audience]) return res.status(400).json({ error: 'Choose who to send it to.' });
    if (testTo && !/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(testTo)) return res.status(400).json({ error: 'Enter a valid test email.' });

    try {
      const ev = includeEvent ? await getEvent() : null;
      const fullSubject = `${subject} — On D' Road`;

      // A test goes to one address and shows what the selected group would get.
      if (testTo) {
        const email = buildUpdate(subject, message, ev, !audience || audience === 'paid');
        const error = await mail.send(testTo, `[Test] ${fullSubject}`, email);
        return error ? res.status(502).json({ error: 'The test email could not be sent.' }) : res.json({ success: true, test: true });
      }

      const recipients = (await pool.query(AUDIENCES[audience])).rows.map((r) => r.email);
      if (!recipients.length) return res.status(400).json({ error: 'Nobody is in that group yet.' });

      const email = buildUpdate(subject, message, ev, audience === 'paid');
      let sent = 0, failed = 0;
      for (let i = 0; i < recipients.length; i += BATCH) {
        const chunk = recipients.slice(i, i + BATCH);
        try {
          const { error } = await resend.batch.send(chunk.map((to) => ({ from: EMAIL_FROM, to, subject: fullSubject, html: email.html, text: email.text })));
          if (error) { console.error('Broadcast batch failed:', error); failed += chunk.length; } else sent += chunk.length;
        } catch (err) {
          console.error('Broadcast batch threw:', err);
          failed += chunk.length;
        }
        if (i + BATCH < recipients.length) await new Promise((r) => setTimeout(r, 600)); // stay under Resend's rate limit
      }
      await pool.query(
        `INSERT INTO broadcasts (audience, subject, message, recipients, sent, failed, event_id) VALUES ($1, $2, $3, $4, $5, $6, ${CUR})`,
        [audience, subject, message, recipients.length, sent, failed]);
      res.json({ success: true, recipients: recipients.length, sent, failed });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // The Guide section (guide.js): its editor, the live preview and the publish bar.
  const GUIDE = guideAdmin({ FRONTEND_URL, WM: WM_LITE });
  const PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0a0a0b">
<title>Event &amp; messages | On D' Road</title>
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
.card { margin-bottom: 22px; }
.card > p { color: var(--muted); margin: 0; }
.card > p b { color: var(--text); font-weight: 700; }
.card > p a { color: var(--text); text-decoration-color: var(--accent); text-underline-offset: 3px; }
label { display: block; font-family: var(--mono); font-size: 11px; font-weight: 400; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 24px 0 8px; }
textarea, input, select { width: 100%; min-height: 44px; font: 500 15px var(--body); color: var(--text); background: var(--well); border: 1px solid var(--line-strong); border-radius: 0; padding: 11px 13px; transition: border-color .15s, box-shadow .15s; }
textarea:hover, input:hover, select:hover { border-color: rgba(236, 235, 230, .42); }
textarea { min-height: 120px; resize: vertical; line-height: 1.55; }
select { cursor: pointer; padding-right: 38px; -webkit-appearance: none; appearance: none; background: var(--well) var(--chev) no-repeat right 13px center / 12px 8px; }
select option { background: var(--surface-2); color: var(--text); }
textarea:focus, input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
textarea::placeholder, input::placeholder { color: var(--dim); }
small { display: block; color: var(--dim); font-size: 13px; margin-top: 8px; }
code { font: 400 12.5px var(--mono); color: var(--text); background: rgba(236, 235, 230, .07); padding: 1px 6px; }
.check { display: flex; align-items: center; gap: 10px; margin-top: 20px; font-family: var(--body); font-size: 14px; font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--text); cursor: pointer; }
.check input { width: 18px; height: 18px; min-height: 0; margin: 0; padding: 0; accent-color: var(--accent); }
.check input:focus { box-shadow: none; }
.check input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.foot { display: flex; align-items: center; gap: 12px; margin-top: 24px; flex-wrap: wrap; }
.test { display: flex; gap: 10px; margin-top: 22px; padding-top: 22px; border-top: 1px solid var(--line); flex-wrap: wrap; }
.test input { flex: 1 1 220px; width: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 14px; }
th { text-align: left; font-family: var(--mono); font-size: 10.5px; font-weight: 400; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); padding: 8px 8px 8px 0; border-bottom: 1px solid var(--line); }
td { padding: 10px 8px 10px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
td.num { white-space: nowrap; font-variant-numeric: tabular-nums; }
td .bad { color: var(--bad); }
.empty { color: var(--dim); font-style: italic; margin-top: 14px; }
/* Poster preview: the image as guests will load it, on the dark canvas */
.poster { display: flex; align-items: center; gap: 14px; margin-top: 12px; }
.poster .frame { flex: none; width: 96px; height: 96px; border: 1px dashed var(--line-strong); background: var(--well); display: grid; place-items: center; overflow: hidden; }
.poster img { width: 100%; height: 100%; object-fit: cover; display: block; }
.poster .frame span { font-family: var(--mono); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--dim); text-align: center; padding: 6px; }
.poster p { margin: 0; color: var(--muted); font-size: 13px; }
${GUIDE.css}
</style></head><body>
<header class="top">
  <div class="brand"><svg class="mark" viewBox="0 0 30 18" aria-hidden="true" focusable="false"><path fill="#e4e3df" d="M0 6h30v12H0z"/><path fill="#0a0a0b" d="M18.2 0h5.6l-4.6 18h-5.6z"/><path fill="#ff5a1f" d="M19.6 0h2.8l-4.6 18h-2.8z"/></svg><b>ON D<span>'</span> <i>ROAD</i></b><span class="sub">Command Center</span></div>
  <a class="back" href="/admin">&larr; Back to overview</a>
</header>
<main class="wrap">
  <h1>Event &amp; messages</h1>
  <p class="lead">What guests see about the event in their account, and email updates to groups of guests.</p>

  <section class="card" aria-labelledby="ev-h">
    <h2 id="ev-h">Event details</h2>
    <p>For the current event, <b id="ev-name"></b> (rename it or start a new one on <a href="/admin/events">Events</a>). Shown in every approved guest's account. Guests still waiting for approval see none of it. Leave everything empty to hide the section.</p>
    <label for="when">When</label>
    <input id="when" maxlength="120" placeholder="Example: Carnival Tuesday, August 4 · 9:00 AM">
    <label for="info">Details for everyone</label>
    <textarea id="info" maxlength="3000" placeholder="Example: Wear your package gear. Bring water and ID."></textarea>
    <small>Every approved guest can see this, paid or not.</small>
    <label for="paid">Details for paid guests only</label>
    <textarea id="paid" maxlength="3000" placeholder="Example: Meet at Twan Headquarters, 3:30 AM. Package pickup Saturday 2-6 PM, bring your reference code."></textarea>
    <small>Meetup spot, pickup times and anything else only paying guests should know. Unpaid guests see that more details unlock once they pay.</small>
    <label for="loc">Location, for paid guests only</label>
    <input id="loc" maxlength="300" placeholder="Example: Meet at the Botanical Gardens gate, St. John's">
    <small>Until they pay, guests see "Secret location, revealed once you've paid". Paid guests see this, or "Details coming soon" while it's empty.</small>
    <label for="poster">Poster image</label>
    <input id="poster" maxlength="500" inputmode="url" placeholder="art/poster.jpg or https://..." aria-describedby="poster-help">
    <div class="poster"><div class="frame" id="poster-frame"><span>Our art</span></div><p id="poster-cap">Empty: guests see the site's own paint art.</p></div>
    <small id="poster-help">The cover at the top of each approved guest's account. Add the file to the guest site repo and enter its path, like <code>art/poster.jpg</code>, or paste any https:// image link. PNG, JPG, SVG, WebP or GIF; a wide image works best.</small>
    <div class="foot"><button id="ev-save" type="button">Save details</button><span id="ev-msg" class="msg" role="status"></span></div>
  </section>

${GUIDE.html}

  <section class="card" aria-labelledby="bc-h">
    <h2 id="bc-h">Email guests</h2>
    <p>Sends one email to everyone in the group. Paid and reserved mean this event's orders. Send yourself a test first.</p>
    <label for="aud">Send to</label>
    <select id="aud">
      <option value="paid">Paid guests</option>
      <option value="reserved">Reserved, not paid</option>
      <option value="all">Everyone approved</option>
    </select>
    <label for="subj">Subject</label>
    <input id="subj" maxlength="120" placeholder="Example: Final details for Monday">
    <label for="body">Message</label>
    <textarea id="body" maxlength="5000" placeholder="Each line becomes its own paragraph."></textarea>
    <label class="check"><input type="checkbox" id="inc" checked> Add the event details below the message</label>
    <small>Paid guests also get the paid-only details. Other groups only get "When" and the details for everyone.</small>
    <div class="test">
      <input id="test-to" type="email" placeholder="Your email, for a test" autocomplete="email" aria-label="Test email address">
      <button class="ghost" id="test-btn" type="button">Send test</button>
    </div>
    <div class="foot"><button id="send-btn" type="button">Send to group</button><span id="bc-msg" class="msg" role="status"></span></div>
  </section>

  <section class="card" aria-labelledby="log-h">
    <h2 id="log-h">Sent</h2>
    <p>The last 20 emails sent from this page for this event.</p>
    <div id="log"></div>
  </section>
</main>
<script>
var $ = function (id) { return document.getElementById(id); };
var counts = {};
var LABELS = { paid: 'Paid guests', reserved: 'Reserved, not paid', all: 'Everyone approved' };
function say(id, text, ok) { $(id).textContent = text; $(id).className = 'msg ' + (ok ? 'ok' : 'err'); }
function post(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); });
}
function fmt(iso) { return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Antigua' }); }

// Where the guest site loads the poster from, or '' when it would skip it (same rule as the server's check).
var SITE = ${JSON.stringify(FRONTEND_URL.replace(/\/$/, ''))};
var PATH_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
function posterSrc(v) {
  if (!v) return '';
  if (v.indexOf('https://') === 0) return v.indexOf(' ') < 0 && v.indexOf('"') < 0 && v.indexOf('<') < 0 ? v : '';
  var dot = v.lastIndexOf('.'), ext = v.slice(dot + 1);
  if (dot < 1 || ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif'].indexOf(ext) < 0) return '';
  var parts = v.slice(0, dot).split('/');
  var ok = parts.every(function (p) { return p.length > 0 && p.split('').every(function (c) { return PATH_CHARS.indexOf(c) >= 0; }); });
  return ok ? SITE + '/' + v : '';
}
function showPoster() {
  var v = $('poster').value.trim(), src = posterSrc(v), frame = $('poster-frame');
  frame.replaceChildren();
  if (!src) {
    var s = document.createElement('span'); s.textContent = v ? 'Not valid' : 'Our art'; frame.appendChild(s);
    $('poster-cap').textContent = v ? 'Use an https:// link or a path like art/poster.jpg.' : "Empty: guests see the site's own paint art.";
    return;
  }
  var img = document.createElement('img'); img.alt = 'Poster preview'; img.src = src;
  img.onerror = function () { frame.replaceChildren(); var s = document.createElement('span'); s.textContent = 'Not found'; frame.appendChild(s); $('poster-cap').textContent = v.indexOf('https://') === 0 ? "Can't load this image." : 'Not found on the guest site yet. Add the file to the repo first.'; };
  frame.appendChild(img);
  $('poster-cap').textContent = 'Shown as the cover of the event page.';
}
$('poster').addEventListener('input', showPoster);

fetch('/api/admin/event').then(function (r) { return r.json(); }).then(function (d) {
  $('ev-name').textContent = d.name || '';
  $('when').value = d.when || ''; $('info').value = d.info || ''; $('paid').value = d.paid_info || '';
  $('loc').value = d.location || ''; $('poster').value = d.poster || '';
  showPoster();
}).catch(function () { say('ev-msg', 'Could not load details.'); });

function loadLog() {
  fetch('/api/admin/broadcasts').then(function (r) { return r.json(); }).then(function (d) {
    counts = d.counts || {};
    Array.prototype.forEach.call($('aud').options, function (o) { o.textContent = LABELS[o.value] + ' (' + (counts[o.value] || 0) + ')'; });
    var box = $('log'); box.replaceChildren();
    if (!d.log || !d.log.length) { var p = document.createElement('p'); p.className = 'empty'; p.textContent = 'Nothing sent yet.'; box.appendChild(p); return; }
    var t = document.createElement('table');
    t.innerHTML = '<thead><tr><th>Sent</th><th>Subject</th><th>To</th><th>Delivered</th></tr></thead>';
    var tb = document.createElement('tbody');
    d.log.forEach(function (x) {
      var tr = document.createElement('tr');
      [fmt(x.created_at), (x.kind === 'GUIDE' ? '[ Guide ] ' : '') + x.subject, LABELS[x.audience] || x.audience].forEach(function (v) { var td = document.createElement('td'); td.textContent = v; tr.appendChild(td); });
      var td = document.createElement('td'); td.className = 'num'; td.textContent = x.sent + ' of ' + x.recipients;
      if (x.failed) { var s = document.createElement('span'); s.className = 'bad'; s.textContent = ' · ' + x.failed + ' failed'; td.appendChild(s); }
      tr.appendChild(td); tb.appendChild(tr);
    });
    t.appendChild(tb); box.appendChild(t);
  }).catch(function () { $('log').textContent = 'Could not load the list.'; });
}
loadLog();

$('ev-save').addEventListener('click', function () {
  var b = this; b.disabled = true; $('ev-msg').textContent = '';
  post('/api/admin/event', { when: $('when').value, info: $('info').value, paid_info: $('paid').value, location: $('loc').value, poster: $('poster').value.trim() })
    .then(function (x) { say('ev-msg', x.ok ? 'Saved. Guests see it now.' : (x.d.error || 'Could not save.'), x.ok); })
    .catch(function () { say('ev-msg', 'Could not save.'); })
    .then(function () { b.disabled = false; });
});

function message() { return { audience: $('aud').value, subject: $('subj').value, message: $('body').value, include_event: $('inc').checked }; }

$('test-btn').addEventListener('click', function () {
  var b = this, m = message();
  if (!$('test-to').value) return say('bc-msg', 'Enter your email for the test.');
  m.test_email = $('test-to').value;
  b.disabled = true; $('bc-msg').textContent = '';
  post('/api/admin/broadcast', m)
    .then(function (x) { say('bc-msg', x.ok ? 'Test sent to ' + m.test_email + '.' : (x.d.error || 'Could not send.'), x.ok); })
    .catch(function () { say('bc-msg', 'Could not send.'); })
    .then(function () { b.disabled = false; });
});

$('send-btn').addEventListener('click', function () {
  var b = this, m = message(), n = counts[m.audience] || 0;
  if (!m.subject.trim() || !m.message.trim()) return say('bc-msg', 'Write a subject and a message.');
  if (!confirm('Email ' + n + (n === 1 ? ' person' : ' people') + ' (' + LABELS[m.audience] + ')? This can\\'t be undone.')) return;
  b.disabled = true; say('bc-msg', 'Sending…', true);
  post('/api/admin/broadcast', m)
    .then(function (x) {
      if (!x.ok) return say('bc-msg', x.d.error || 'Could not send.');
      say('bc-msg', 'Sent to ' + x.d.sent + ' of ' + x.d.recipients + (x.d.failed ? '. ' + x.d.failed + ' failed; check the server log.' : '.'), !x.d.failed);
      if (!x.d.failed) { $('subj').value = ''; $('body').value = ''; }
      loadLog();
    })
    .catch(function () { say('bc-msg', 'Lost connection. Check the Sent list before trying again.'); })
    .then(function () { b.disabled = false; });
});
</script>
<script>${GUIDE.js}</script></body></html>`;

  app.get('/admin/event', requireRole('OWNER', 'ADMIN'), (req, res) => res.type('html').send(PAGE));
}
