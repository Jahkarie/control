// event.js: event details guests see in their account, and email updates to groups of guests.
// "When" and the general details show to every logged-in guest. The paid-only details
// (meetup spot, pickup info) are only sent to guests whose order is paid.
import { renderEmail } from './emails.js';

// Who each group email goes to.
const AUDIENCES = {
  paid: "SELECT DISTINCT LOWER(guest_email) AS email FROM orders WHERE status = 'PAID'",
  reserved: "SELECT DISTINCT LOWER(guest_email) AS email FROM orders WHERE status = 'RESERVED'",
  all: 'SELECT DISTINCT LOWER(email) AS email FROM guests'
};
const BATCH = 100; // Resend's batch limit

export function registerEvent({ app, pool, resend, EMAIL_FROM, FRONTEND_URL, requireAuth, requireAdmin, mail }) {
  const KEYS = { when: 'event_when', info: 'event_info', paid_info: 'event_paid_info' };
  const LIMITS = { when: 120, info: 3000, paid_info: 3000 };

  async function getEvent() {
    const r = await pool.query('SELECT key, value FROM settings WHERE key = ANY($1)', [Object.values(KEYS)]);
    const s = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
    return { when: s.event_when || '', info: s.event_info || '', paid_info: s.event_paid_info || '' };
  }

  // Builds an organizer update. withPaid adds the paid-only details (paid audience and tests only).
  function buildUpdate(subject, message, ev, withPaid) {
    const details = ev ? [ev.info, withPaid ? ev.paid_info : ''].filter(Boolean).join('\n\n') : '';
    return renderEmail({
      tone: 'accent', tag: 'From the organizers', title: subject,
      lines: message.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
      details: ev && ev.when ? [['When', ev.when]] : [],
      callout: details ? { label: 'Event details', text: details } : null,
      cta: { text: 'Open my account', url: FRONTEND_URL }
    });
  }

  // ---------- Guest ----------
  app.get('/api/event', requireAuth, async (req, res) => {
    try {
      const ev = await getEvent();
      const paid = await pool.query("SELECT 1 FROM orders WHERE LOWER(guest_email) = $1 AND status = 'PAID' LIMIT 1", [req.userEmail]);
      res.json({
        when: ev.when, info: ev.info,
        paid: !!paid.rowCount,
        paid_info: paid.rowCount ? ev.paid_info : '',
        has_paid_info: !!ev.paid_info
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

  app.post('/api/admin/event', requireAdmin, async (req, res) => {
    try {
      for (const [field, key] of Object.entries(KEYS)) {
        const v = typeof req.body?.[field] === 'string' ? req.body[field].trim().slice(0, LIMITS[field]) : '';
        await pool.query(
          'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, v]);
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
<meta name="robots" content="noindex"><meta name="theme-color" content="#0b0a09">
<title>Event &amp; messages | On D' Road</title>
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
textarea, input, select { width: 100%; font: 500 15px 'Inter', system-ui, sans-serif; color: var(--text); background: rgba(0, 0, 0, .35); border: 1px solid var(--line-strong); border-radius: 10px; padding: 13px 14px; transition: border-color .15s, box-shadow .15s; }
textarea { min-height: 120px; resize: vertical; line-height: 1.55; }
textarea:focus, input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(255, 91, 31, .16); }
textarea::placeholder, input::placeholder { color: var(--dim); }
small { display: block; color: var(--dim); font-size: 13px; margin-top: 8px; }
.check { display: flex; align-items: center; gap: 10px; margin-top: 20px; font-size: 14px; letter-spacing: 0; text-transform: none; color: var(--text); cursor: pointer; }
.check input { width: 18px; height: 18px; margin: 0; padding: 0; accent-color: var(--accent); }
.foot { display: flex; align-items: center; gap: 12px; margin-top: 24px; flex-wrap: wrap; }
.test { display: flex; gap: 10px; margin-top: 22px; padding-top: 22px; border-top: 1px solid var(--line); flex-wrap: wrap; }
.test input { flex: 1 1 220px; width: auto; }
button { font: 600 14px 'Inter', system-ui, sans-serif; padding: 13px 22px; border-radius: 10px; cursor: pointer; color: var(--accent-ink); background: var(--accent); border: 1px solid var(--accent); }
button.ghost { color: var(--text); background: transparent; border-color: var(--line-strong); }
button:hover { filter: brightness(1.08); }
button:disabled { opacity: .5; cursor: progress; }
.msg { font-size: 14px; font-weight: 600; }
.msg.ok { color: var(--good); } .msg.err { color: var(--bad); }
table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 14px; }
th { text-align: left; font-size: 11px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); padding: 8px 8px 8px 0; border-bottom: 1px solid var(--line); }
td { padding: 10px 8px 10px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
td.num { white-space: nowrap; }
td .bad { color: var(--bad); }
.empty { color: var(--dim); font-style: italic; margin-top: 14px; }
</style></head><body>
<header class="top">
  <div class="brand"><b>ON D<span>'</span> ROAD</b><span class="sub">Command Center</span></div>
  <a class="back" href="/admin">&larr; Back to overview</a>
</header>
<main class="wrap">
  <h1>Event &amp; messages</h1>
  <p class="lead">What guests see about the event in their account, and email updates to groups of guests.</p>

  <section class="card" aria-labelledby="ev-h">
    <h2 id="ev-h">Event details</h2>
    <p>Shown in every guest's account. Leave everything empty to hide the section.</p>
    <label for="when">When</label>
    <input id="when" maxlength="120" placeholder="Example: J'ouvert Monday, August 3 · 4:00 AM">
    <label for="info">Details for everyone</label>
    <textarea id="info" maxlength="3000" placeholder="Example: Wear your package gear. Bring water and ID."></textarea>
    <small>Every guest who is logged in can see this, paid or not.</small>
    <label for="paid">Details for paid guests only</label>
    <textarea id="paid" maxlength="3000" placeholder="Example: Meet at Twan Headquarters, 3:30 AM. Package pickup Saturday 2-6 PM, bring your reference code."></textarea>
    <small>Meetup spot, pickup times and anything else only paying guests should know. Unpaid guests see that more details unlock once they pay.</small>
    <div class="foot"><button id="ev-save" type="button">Save details</button><span id="ev-msg" class="msg" role="status"></span></div>
  </section>

  <section class="card" aria-labelledby="bc-h">
    <h2 id="bc-h">Email guests</h2>
    <p>Sends one email to everyone in the group. Send yourself a test first.</p>
    <label for="aud">Send to</label>
    <select id="aud">
      <option value="paid">Paid guests</option>
      <option value="reserved">Reserved, not paid</option>
      <option value="all">Everyone on the list</option>
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
var LABELS = { paid: 'Paid guests', reserved: 'Reserved, not paid', all: 'Everyone on the list' };
function say(id, text, ok) { $(id).textContent = text; $(id).className = 'msg ' + (ok ? 'ok' : 'err'); }
function post(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); });
}
function fmt(iso) { return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Antigua' }); }

fetch('/api/admin/event').then(function (r) { return r.json(); }).then(function (d) {
  $('when').value = d.when || ''; $('info').value = d.info || ''; $('paid').value = d.paid_info || '';
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
  post('/api/admin/event', { when: $('when').value, info: $('info').value, paid_info: $('paid').value })
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
