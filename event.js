// event.js: event details guests see in their account, and email updates to groups of guests.
// "When", the general details and the poster show to every approved guest. The paid-only details
// (meetup spot, pickup info) and the location are only sent to guests whose order is paid.
// Guests still waiting for approval, or declined, get nothing.
import { renderEmail } from './emails.js';

// The poster is an https:// link, or an image in the guest site repo like "art/poster.jpg": the same checks site.js
// uses for sponsor logos, so the guest site can load it the same way.
const POSTER_PATH = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.(png|jpe?g|svg|webp|gif)$/;
function isHttpsUrl(v) {
  if (v.length > 500 || !/^https:\/\/[^\s"'<>\\]+$/.test(v)) return false;
  try { return new URL(v).protocol === 'https:'; } catch { return false; }
}
const isPoster = (v) => isHttpsUrl(v) || POSTER_PATH.test(v);

// Who each group email goes to.
const AUDIENCES = {
  paid: "SELECT DISTINCT LOWER(guest_email) AS email FROM orders WHERE status = 'PAID'",
  reserved: "SELECT DISTINCT LOWER(guest_email) AS email FROM orders WHERE status = 'RESERVED'",
  // Approved guests only: people still waiting for approval, or declined, get no group emails (they'd carry the
  // event details that /api/event keeps from them, and a declined request gets no email at all).
  all: "SELECT DISTINCT LOWER(email) AS email FROM guests WHERE approval = 'APPROVED'"
};
const BATCH = 100; // Resend's batch limit

export function registerEvent({ app, pool, resend, EMAIL_FROM, FRONTEND_URL, requireAuth, requireAdmin, mail }) {
  const KEYS = { when: 'event_when', info: 'event_info', paid_info: 'event_paid_info', location: 'event_location', poster: 'event_poster' };
  const LIMITS = { when: 120, info: 3000, paid_info: 3000, location: 300, poster: 500 };

  async function getEvent() {
    const r = await pool.query('SELECT key, value FROM settings WHERE key = ANY($1)', [Object.values(KEYS)]);
    const s = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
    const poster = s.event_poster || '';
    return { when: s.event_when || '', info: s.event_info || '', paid_info: s.event_paid_info || '',
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
  app.get('/api/event', requireAuth, async (req, res) => {
    try {
      // Only approved guests see the event. Pending and declined requests (and removed guests) get empty details.
      const g = await pool.query('SELECT approval FROM guests WHERE LOWER(email) = $1 ORDER BY id LIMIT 1', [req.userEmail]);
      if (!g.rowCount || (g.rows[0].approval && g.rows[0].approval !== 'APPROVED')) return res.json(NOTHING);
      const ev = await getEvent();
      const paid = await pool.query("SELECT 1 FROM orders WHERE LOWER(guest_email) = $1 AND status = 'PAID' LIMIT 1", [req.userEmail]);
      res.json({
        when: ev.when, info: ev.info,
        paid: !!paid.rowCount,
        paid_info: paid.rowCount ? ev.paid_info : '',
        has_paid_info: !!ev.paid_info,
        // Like paid_info: only once the guest's order is paid.
        location: paid.rowCount ? ev.location : '',
        poster: ev.poster
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ---------- Admin: event details ----------
  app.get('/api/admin/event', requireAdmin, async (req, res) => {
    try {
      res.json(await getEvent());
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // Saves the fields sent. One left out keeps its value, so an older copy of the page can't wipe the newer ones.
  app.post('/api/admin/event', requireAdmin, async (req, res) => {
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
      for (const [field, v] of Object.entries(vals)) {
        await pool.query(
          'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [KEYS[field], v]);
      }
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  // ---------- Admin: email updates ----------
  app.get('/api/admin/broadcasts', requireAdmin, async (req, res) => {
    try {
      const counts = {};
      for (const [k, q] of Object.entries(AUDIENCES)) {
        counts[k] = parseInt((await pool.query(`SELECT COUNT(*) FROM (${q}) x`)).rows[0].count, 10);
      }
      const log = await pool.query(
        'SELECT id, audience, subject, recipients, sent, failed, created_at FROM broadcasts ORDER BY id DESC LIMIT 20');
      res.json({ counts, log: log.rows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  app.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
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
        'INSERT INTO broadcasts (audience, subject, message, recipients, sent, failed) VALUES ($1, $2, $3, $4, $5, $6)',
        [audience, subject, message, recipients.length, sent, failed]);
      res.json({ success: true, recipients: recipients.length, sent, failed });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  const PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#09080b">
<title>Event &amp; messages | On D' Road</title>
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
label { display: block; font-family: var(--mono); font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 24px 0 8px; }
textarea, input, select { width: 100%; font: 500 15px var(--body); color: var(--text); background: var(--well); border: 1px solid var(--line-strong); border-radius: 8px; padding: 13px 14px; transition: border-color .15s, box-shadow .15s; }
textarea:hover, input:hover, select:hover { border-color: rgba(246, 241, 232, .32); }
textarea { min-height: 120px; resize: vertical; line-height: 1.55; }
select { cursor: pointer; padding-right: 36px; -webkit-appearance: none; appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--warn) 50%), linear-gradient(135deg, var(--warn) 50%, transparent 50%); background-position: calc(100% - 18px) 50%, calc(100% - 13px) 50%; background-size: 5px 5px; background-repeat: no-repeat; }
select option { background: var(--surface-2); color: var(--text); }
textarea:focus, input:focus, select:focus { outline: none; border-color: var(--cyan); box-shadow: 0 0 0 3px rgba(30, 227, 255, .16); }
textarea::placeholder, input::placeholder { color: var(--dim); }
small { display: block; color: var(--dim); font-size: 13px; margin-top: 8px; }
.check { display: flex; align-items: center; gap: 10px; margin-top: 20px; font-family: var(--body); font-size: 14px; font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--text); cursor: pointer; }
.check input { width: 18px; height: 18px; margin: 0; padding: 0; accent-color: var(--accent); }
.check input:focus { box-shadow: none; }
.check input:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }
.foot { display: flex; align-items: center; gap: 12px; margin-top: 24px; flex-wrap: wrap; }
.test { display: flex; gap: 10px; margin-top: 22px; padding-top: 22px; border-top: 1px dashed var(--line-strong); flex-wrap: wrap; }
.test input { flex: 1 1 220px; width: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 14px; }
th { text-align: left; font-family: var(--mono); font-size: 10.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); padding: 8px 8px 8px 0; border-bottom: 1px solid var(--line); }
td { padding: 10px 8px 10px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
td.num { white-space: nowrap; font-variant-numeric: tabular-nums; }
td .bad { color: var(--bad); }
.empty { color: var(--dim); font-style: italic; margin-top: 14px; }
/* Poster preview: the image as guests will load it, on the dark canvas */
.poster { display: flex; align-items: center; gap: 14px; margin-top: 12px; }
.poster .frame { flex: none; width: 96px; height: 96px; border-radius: 10px; border: 1px dashed var(--line-strong); background: var(--well); display: grid; place-items: center; overflow: hidden; }
.poster img { width: 100%; height: 100%; object-fit: cover; display: block; }
.poster .frame span { font-family: var(--mono); font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--dim); text-align: center; padding: 6px; }
.poster p { margin: 0; color: var(--muted); font-size: 13px; }
</style></head><body>
<header class="top">
  <div class="brand"><svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path fill="currentColor" d="M29.1 16.4C28.6 17 25.8 17.4 24.9 17.9C24 18.3 24 18.6 23.9 19.1C23.7 19.5 23.6 19.9 23.7 20.5C23.7 21.1 24.2 22 24.2 22.6C24.2 23.3 24.2 24.2 23.8 24.6C23.3 24.9 22.3 24.7 21.6 24.6C20.9 24.6 20.1 24.2 19.5 24.1C18.9 24 18.5 23.7 18.1 24.2C17.7 24.6 17.7 25.9 17.2 26.7C16.8 27.5 16.1 29.2 15.6 28.9C15.1 28.6 14.7 25.8 14.2 25C13.8 24.1 13.6 24.1 13.1 24C12.7 23.8 12.3 23.9 11.7 24C11.2 24.1 10.5 24.3 9.7 24.5C8.9 24.7 7.5 25.4 6.8 25.2C6 25.1 5.4 24.5 5.4 23.8C5.4 23.1 6.4 21.7 6.7 21C7 20.2 7.6 19.6 7.2 19.1C6.7 18.7 4.6 18.7 4 18.2C3.4 17.8 3 16.9 3.6 16.4C4.2 15.9 6.6 15.5 7.4 15.1C8.1 14.7 8 14.4 8 13.9C8.1 13.5 8 13 7.9 12.5C7.7 11.9 7.4 11.1 7.3 10.4C7.3 9.7 7.2 8.7 7.5 8.3C7.9 7.9 8.7 7.8 9.4 7.8C10 7.8 10.9 8.3 11.4 8.2C12 8.1 12.2 8 12.6 7.1C12.9 6.2 13 3.5 13.5 3C14 2.5 15 3.2 15.6 3.9C16.2 4.6 16.6 6.5 17 7.3C17.5 8 17.8 8 18.2 8.3C18.6 8.7 18.9 9 19.3 9.2C19.7 9.4 19.9 9.6 20.6 9.5C21.3 9.5 22.6 8.7 23.2 8.8C23.9 8.8 24.5 9.3 24.6 9.9C24.6 10.5 23.7 11.7 23.5 12.4C23.4 13 23.1 13.4 23.9 13.7C24.7 14 27.4 13.9 28.2 14.4C29.1 14.8 29.7 15.8 29.1 16.4ZM12.7 3.8a1.5 1.5 0 1 1 3.1 0a1.5 1.5 0 1 1 -3.1 0ZM23 9a1.4 1.4 0 1 1 2.9 0a1.4 1.4 0 1 1 -2.9 0ZM27.1 15.5a1.6 1.6 0 1 1 3.1 0a1.6 1.6 0 1 1 -3.1 0ZM14.5 28.9a1.5 1.5 0 1 1 3 0a1.5 1.5 0 1 1 -3 0ZM5.5 23.7a1.4 1.4 0 1 1 2.8 0a1.4 1.4 0 1 1 -2.8 0ZM1.4 17.3a1.5 1.5 0 1 1 3.1 0a1.5 1.5 0 1 1 -3.1 0ZM27.4 5.4a1.2 1.2 0 1 1 2.4 0a1.2 1.2 0 1 1 -2.4 0ZM2.6 27a1 1 0 1 1 2 0a1 1 0 1 1 -2 0ZM26.6 28.2a0.8 0.8 0 1 1 1.6 0a0.8 0.8 0 1 1 -1.6 0Z"/></svg><b>ON D<span>'</span> ROAD</b><span class="sub">Command Center</span></div>
  <a class="back" href="/admin">&larr; Back to overview</a>
</header>
<main class="wrap">
  <h1>Event &amp; messages</h1>
  <p class="lead">What guests see about the event in their account, and email updates to groups of guests.</p>

  <section class="card" aria-labelledby="ev-h">
    <h2 id="ev-h">Event details</h2>
    <p>Shown in every approved guest's account. Guests still waiting for approval see none of it. Leave everything empty to hide the section.</p>
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

  <section class="card" aria-labelledby="bc-h">
    <h2 id="bc-h">Email guests</h2>
    <p>Sends one email to everyone in the group. Send yourself a test first.</p>
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
    <p>The last 20 emails sent from this page.</p>
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
      [fmt(x.created_at), x.subject, LABELS[x.audience] || x.audience].forEach(function (v) { var td = document.createElement('td'); td.textContent = v; tr.appendChild(td); });
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
</script></body></html>`;

  app.get('/admin/event', requireAdmin, (req, res) => res.type('html').send(PAGE));
}
