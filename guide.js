// guide.js: the event guide, a pre-event guide for paid guests that lives in their account next to their pass, and the
// short email that tells them it's ready.
// Stored on the current event's row (see events.js): events.guide is the draft the organizers edit, guide_published the
// copy guests see (publishing copies the draft over, so half-done edits never show), guide_published_at,
// guide_notified_at (the last "Your guide is ready" email) and guide_updated_at (the draft's last save). A new event
// starts with none of it. /api/event (event.js) adds the published copy as `guide` only for a guest with a PAID order
// for the current event (a free pass counts): the meeting point is as secret as the location.
// Sections, each optional (an empty one is hidden): the meeting point (place, day, time, sharp, map, how to get there,
// a picture), the route (up to 20 stops), the schedule (up to 30 times), parking (text, map, picture, the "not an
// official car park" line) and rules (up to 30, each Do / Don't / Heads up).
// The admin routes are registered before the app-wide 10kb JSON limit (a full guide can be bigger), with their own.
// The guide's view (GUIDE_VIEW_JS, GUIDE_VIEW_CSS) is the same code as the guest site's: the admin preview runs it.
import { renderEmail } from './emails.js';

export const GUIDE_LIMITS = { place: 120, how: 2000, title: 100, note: 300, rule: 200, parking: 2000, link: 600, image: 500, stops: 20, schedule: 30, rules: 30 };
const KINDS = { DO: 'DO', DONT: 'DONT', "DON'T": 'DONT', HEADS_UP: 'HEADS_UP', 'HEADS UP': 'HEADS_UP', HEADSUP: 'HEADS_UP' };
const BATCH = 100; // Resend's batch limit

// A bad field: a 400 with the field's path (e.g. "meet.map", "schedule.3.time") so the page can point at it.
class GuideError extends Error { constructor(field, message) { super(message); this.field = field; } }

// The poster's rule (event.js): an https:// link, or a file in the guest site repo like "art/meet.jpg".
const IMAGE_PATH = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.(png|jpe?g|svg|webp|gif)$/;
function isHttpsUrl(v) {
  if (typeof v !== 'string' || v.length > GUIDE_LIMITS.link || !/^https:\/\/[^\s"'<>\\]+$/.test(v)) return false;
  try { const u = new URL(v); return u.protocol === 'https:' && !!u.hostname; } catch { return false; }
}
export const isGuideImage = (v) => isHttpsUrl(v) || IMAGE_PATH.test(v);

// One line: control characters and runs of spaces become one space. A block keeps its line breaks (at most one blank line).
const line = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f\u200b-\u200d\u2028\u2029\ufeff]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim() : '');
const block = (v, max) => (typeof v === 'string'
  ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200d\ufeff]/g, '').replace(/\u2028|\u2029/g, '\n')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max).trim()
  : '');

// ---------- map links ----------
// A pin from "17.0123, -61.7654" (or "17.0123 -61.7654"), rounded to 6 places (about 10 cm).
const LATLNG = /^\s*(?:loc:\s*)?(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*\+?(-?\d{1,3}(?:\.\d+)?)(?:\s*\(.*\))?\s*$/;
function pin(lat, lng) {
  const a = Number(lat), b = Number(lng);
  if (!isFinite(a) || !isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180 || (a === 0 && b === 0)) return null;
  return { lat: Math.round(a * 1e6) / 1e6, lng: Math.round(b * 1e6) / 1e6 };
}
function pinOf(text) {
  const m = LATLNG.exec(String(text || ''));
  return m ? pin(m[1], m[2]) : null;
}
// A map link or a pasted pin -> { lat, lng } (Google ?q= / ?query= / ?ll= / @lat,lng / !3d…!4d…, Apple ?ll= / ?q= / ?sll=,
// a raw "lat, lng"), else { url } (any other https link, e.g. a short maps.app.goo.gl link), or null when empty.
export function parseMap(v, field = 'map') {
  if (v && typeof v === 'object') {
    if (typeof v.lat === 'number' && typeof v.lng === 'number') {
      const p = pin(v.lat, v.lng);
      if (!p) throw new GuideError(field, 'That pin is off the map. Paste a map link or a pin like 17.0123, -61.7654.');
      return p;
    }
    v = v.url;
  }
  const s = line(v, GUIDE_LIMITS.link + 1);
  if (!s) return null;
  const raw = pinOf(s);
  if (raw) return raw;
  if (s.length > GUIDE_LIMITS.link) throw new GuideError(field, 'That map link is too long. Use the Share link from the maps app.');
  let u;
  try { u = new URL(s); } catch { u = null; }
  if (!u || !/^https?:$/.test(u.protocol)) throw new GuideError(field, 'Paste a Google or Apple Maps link (https://…), or a pin like 17.0123, -61.7654.');
  // Place names in links can carry quotes (Nelson's Dockyard): kept, escaped like a browser would.
  const href = u.href.replace(/'/g, '%27').replace(/"/g, '%22');
  if (u.protocol !== 'https:' || !isHttpsUrl(href)) throw new GuideError(field, 'Map links need to start with https://.');
  const decoded = (x) => { try { return decodeURIComponent(x); } catch { return x; } };
  const whole = decoded(u.pathname + u.search + u.hash);
  // The place's own pin (Google's data=…!3d<lat>!4d<lng>) beats the view's centre (@lat,lng).
  const d = /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/.exec(whole);
  if (d && pin(d[1], d[2])) return pin(d[1], d[2]);
  for (const k of ['q', 'query', 'll', 'sll', 'center', 'destination', 'daddr', 'coordinate', 'saddr']) {
    const p = pinOf(u.searchParams.get(k));
    if (p) return p;
  }
  const at = /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/.exec(whole);
  if (at && pin(at[1], at[2])) return pin(at[1], at[2]);
  const path = /\/(-?\d{1,2}\.\d+),\+?(-?\d{1,3}\.\d+)(?:[/,?]|$)/.exec(decoded(u.pathname));
  if (path && pin(path[1], path[2])) return pin(path[1], path[2]);
  return { url: href };
}

// ---------- times (Antigua time) ----------
const isRealDay = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
const two = (n) => String(n).padStart(2, '0');
// '' | 'YYYY-MM-DD' (a real date)
export function cleanDay(v, field) {
  const s = line(v, 40);
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m || !isRealDay(+m[1], +m[2], +m[3]) || +m[1] < 2000 || +m[1] > 2100) throw new GuideError(field, 'Use a real date, like 2026-11-01.');
  return s;
}
// '' | 'HH:MM' | 'YYYY-MM-DDTHH:MM' (Antigua time). Takes "9:30", "21:30:00", or an ISO datetime: one without a zone is
// Antigua time, one with a zone (Z, +01:00) is turned into Antigua time.
export function cleanTime(v, field) {
  const s = line(v, 40);
  if (!s) return '';
  let m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (m) {
    if (+m[1] > 23 || +m[2] > 59) throw new GuideError(field, 'Use a time like 21:30.');
    return two(+m[1]) + ':' + m[2];
  }
  m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (!m || !isRealDay(+m[1], +m[2], +m[3]) || +m[4] > 23 || +m[5] > 59) throw new GuideError(field, 'Use a time like 21:30.');
  if (!m[6]) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
  const t = new Date(Date.parse(s.replace(' ', 'T')) - 4 * 3600e3); // Antigua is UTC-4 all year
  if (isNaN(t)) throw new GuideError(field, 'Use a time like 21:30.');
  return `${t.getUTCFullYear()}-${two(t.getUTCMonth() + 1)}-${two(t.getUTCDate())}T${two(t.getUTCHours())}:${two(t.getUTCMinutes())}`;
}

function cleanImage(v, field) {
  const s = line(v, GUIDE_LIMITS.image + 1);
  if (!s) return '';
  if (s.length > GUIDE_LIMITS.image || !isGuideImage(s)) throw new GuideError(field, 'Pictures need an https:// image link, or a file in the guest site like art/meet.jpg.');
  return s;
}
const list = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// The guide as stored: every field present, trimmed and capped; empty list rows dropped. Throws a GuideError.
export function cleanGuide(input) {
  const g = obj(input), m = obj(g.meet), p = obj(g.parking);
  const L = GUIDE_LIMITS;
  const meet = {
    place: line(m.place, L.place),
    date: cleanDay(m.date, 'meet.date'),
    time: cleanTime(m.time, 'meet.time'),
    sharp: m.sharp === true,
    map: parseMap(m.map, 'meet.map'),
    how: block(m.how, L.how),
    image: cleanImage(m.image, 'meet.image')
  };
  // A meet time given as a full date and time sets the day.
  if (meet.time.length === 16) { meet.date = meet.time.slice(0, 10); meet.time = meet.time.slice(11); }
  const route = [];
  list(g.route).forEach((x, i) => {
    const r = { title: line(obj(x).title, L.title), note: line(obj(x).note, L.note) };
    if (!r.title && !r.note) return;
    if (!r.title) throw new GuideError(`route.${i}.title`, `Give stop ${route.length + 1} a name.`);
    route.push(r);
  });
  if (route.length > L.stops) throw new GuideError('route', `Up to ${L.stops} route stops.`);
  const schedule = [];
  list(g.schedule).forEach((x, i) => {
    const o = obj(x), r = { time: cleanTime(o.time, `schedule.${i}.time`), title: line(o.title, L.title), note: line(o.note, L.note) };
    if (!r.time && !r.title && !r.note) return;
    if (!r.title) throw new GuideError(`schedule.${i}.title`, 'Say what happens at each time.');
    if (!r.time) throw new GuideError(`schedule.${i}.time`, `Add a time for "${r.title}".`);
    schedule.push(r);
  });
  if (schedule.length > L.schedule) throw new GuideError('schedule', `Up to ${L.schedule} times in the schedule.`);
  const rules = [];
  list(g.rules).forEach((x, i) => {
    const o = obj(x), text = line(o.text, L.rule);
    if (!text) return;
    const kind = KINDS[String(o.kind || 'DO').trim().toUpperCase().replace(/[’`]/g, "'")];
    if (!kind) throw new GuideError(`rules.${i}.kind`, 'Mark each rule Do, Don\'t or Heads up.');
    rules.push({ kind, text });
  });
  if (rules.length > L.rules) throw new GuideError('rules', `Up to ${L.rules} rules.`);
  const parking = { text: block(p.text, L.parking), map: parseMap(p.map, 'parking.map'), image: cleanImage(p.image, 'parking.image'), disclaimer: p.disclaimer === true };
  return { version: 1, meet, route, schedule, parking, rules };
}
export const EMPTY_GUIDE = Object.freeze({ version: 1, meet: { place: '', date: '', time: '', sharp: false, map: null, how: '', image: '' }, route: [], schedule: [], parking: { text: '', map: null, image: '', disclaimer: false }, rules: [] });
// Nothing a guest would see (a lone "sharp" or disclaimer tick doesn't count).
export function guideIsEmpty(g) {
  const m = obj(g?.meet), p = obj(g?.parking);
  return !(m.place || m.time || m.how || m.image || m.map || list(g?.route).length || list(g?.schedule).length || p.text || p.map || p.image || list(g?.rules).length);
}
// A stored guide read back (an older or hand-edited row is cleaned again; one that can't be is treated as empty).
function readGuide(v) {
  if (!v) return null;
  try { return cleanGuide(typeof v === 'string' ? JSON.parse(v) : v); } catch { return null; }
}
const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

// The published guide for /api/event (event.js calls this only for a paid guest of the current event), or null.
export async function publishedGuide(db) {
  const r = await db.query("SELECT guide_published, guide_published_at FROM events WHERE status = 'current'");
  const row = r.rows[0];
  const g = row && readGuide(row.guide_published);
  if (!g || guideIsEmpty(g) || !row.guide_published_at) return null;
  const at = new Date(row.guide_published_at).toISOString();
  return { ...g, published_at: at, updated_at: at };
}

// The nudge: no place, no time, no stops, nothing that a forward would give away. Just the button to the account.
export function guideEmail(eventName, FRONTEND_URL) {
  const name = eventName || "On D' Road";
  return {
    subject: `Your guide for ${name} is ready`,
    email: renderEmail({
      tone: 'accent', tag: 'Your guide', title: 'Your guide is ready',
      preheader: 'Meeting point, times and the plan for the night are in your account.',
      lines: ['Meeting point, times and the plan for the night are in your account.', "Open it before you head out: it stays on your phone, so it works with bad signal too."],
      cta: { text: 'Open your guide', url: `${String(FRONTEND_URL).replace(/\/$/, '')}/?guide=1` },
      fine: "For your eyes only: it's in your account, not in this email."
    })
  };
}

export function registerGuide({ app, pool, express, resend, EMAIL_FROM, FRONTEND_URL, requireRole }) {
  const json = express.json({ limit: '64kb' }); // a full guide is bigger than the app-wide 10kb
  const ADMINS = requireRole('OWNER', 'ADMIN');
  // Paid guests of this event (approved, with a PAID order for it; a free pass counts). Same group as the guest side.
  const PAID = `SELECT DISTINCT LOWER(o.guest_email) AS email FROM orders o
    WHERE o.status = 'PAID' AND o.event_id = $1
      AND EXISTS (SELECT 1 FROM guests g WHERE LOWER(g.email) = LOWER(o.guest_email) AND g.approval = 'APPROVED')`;

  async function state(db = pool) {
    const ev = (await db.query("SELECT id, name, guide, guide_published, guide_published_at, guide_notified_at, guide_updated_at FROM events WHERE status = 'current'")).rows[0];
    if (!ev) return null;
    const draft = readGuide(ev.guide) || EMPTY_GUIDE, published = ev.guide_published_at ? readGuide(ev.guide_published) : null;
    const paid = (await db.query(`SELECT COUNT(*)::int AS n FROM (${PAID}) x`, [ev.id])).rows[0].n;
    const last = (await db.query(`SELECT recipients, sent, failed, created_at FROM broadcasts WHERE kind = 'GUIDE' AND event_id = $1 ORDER BY id DESC LIMIT 1`, [ev.id])).rows[0] || null;
    return {
      event: { id: ev.id, name: ev.name }, draft, published,
      published_at: published ? ev.guide_published_at : null, notified_at: ev.guide_notified_at, saved_at: ev.guide_updated_at,
      changed: !!published && !same(draft, published), empty: guideIsEmpty(draft), paid, last_notice: last, site: FRONTEND_URL
    };
  }
  const bad = (res, err) => res.status(400).json({ error: err.message, field: err.field, code: 'GUIDE_INVALID' });

  app.get('/api/admin/event/guide', ADMINS, async (req, res) => {
    try {
      const s = await state();
      if (!s) return res.status(409).json({ error: 'There is no current event.' });
      res.set('Cache-Control', 'no-store').json(s);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error.' }); }
  });

  // Saves the draft. Guests don't see it until it's published.
  app.post('/api/admin/event/guide', ADMINS, json, async (req, res) => {
    let g;
    try { g = cleanGuide(req.body?.guide); } catch (err) { if (err instanceof GuideError) return bad(res, err); throw err; }
    try {
      const r = await pool.query("UPDATE events SET guide = $1, guide_updated_at = NOW() WHERE status = 'current' RETURNING id", [JSON.stringify(g)]);
      if (!r.rowCount) return res.status(409).json({ error: 'There is no current event.' });
      res.json({ success: true, ...(await state()) });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error.' }); }
  });

  // Publishes the draft (and saves the one sent with it first, when there is one). notify: true emails every paid guest
  // of this event "Your guide is ready" (no details), in batches of 100, logged in broadcasts as kind GUIDE.
  app.post('/api/admin/event/guide/publish', ADMINS, json, async (req, res) => {
    let sent;
    try { sent = req.body?.guide !== undefined ? cleanGuide(req.body.guide) : null; } catch (err) { if (err instanceof GuideError) return bad(res, err); throw err; }
    const notify = req.body?.notify === true;
    const client = await pool.connect();
    let ev;
    try {
      await client.query('BEGIN');
      ev = (await client.query("SELECT id, name, guide FROM events WHERE status = 'current' FOR UPDATE")).rows[0];
      if (!ev) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'There is no current event.' }); }
      const draft = sent || readGuide(ev.guide) || EMPTY_GUIDE;
      if (guideIsEmpty(draft)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'The guide is empty. Fill in a section first.', code: 'GUIDE_EMPTY' }); }
      await client.query(`UPDATE events SET guide = $1, guide_published = $1, guide_published_at = NOW()${sent ? ', guide_updated_at = NOW()' : ''} WHERE id = $2`,
        [JSON.stringify(draft), ev.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(err);
      return res.status(500).json({ error: 'Server error.' });
    } finally { client.release(); }

    let notified = null;
    try {
      if (notify) {
        const recipients = (await pool.query(PAID, [ev.id])).rows.map((r) => r.email);
        notified = { recipients: recipients.length, sent: 0, failed: 0 };
        if (recipients.length) {
          const { subject, email } = guideEmail(ev.name, FRONTEND_URL);
          for (let i = 0; i < recipients.length; i += BATCH) {
            const chunk = recipients.slice(i, i + BATCH);
            try {
              const { error } = await resend.batch.send(chunk.map((to) => ({ from: EMAIL_FROM, to, subject, html: email.html, text: email.text })));
              if (error) { console.error('Guide email batch failed:', error); notified.failed += chunk.length; } else notified.sent += chunk.length;
            } catch (err) {
              console.error('Guide email batch threw:', err);
              notified.failed += chunk.length;
            }
            if (i + BATCH < recipients.length) await new Promise((r) => setTimeout(r, 600)); // stay under Resend's rate limit
          }
          await pool.query(`INSERT INTO broadcasts (audience, subject, message, recipients, sent, failed, event_id, kind) VALUES ('paid', $1, $2, $3, $4, $5, $6, 'GUIDE')`,
            [subject, 'Your guide is ready (no details in the email)', recipients.length, notified.sent, notified.failed, ev.id]);
          if (notified.sent) await pool.query('UPDATE events SET guide_notified_at = NOW() WHERE id = $1', [ev.id]);
        }
        req.auditExtra = { notified };
      }
      res.json({ success: true, notified, ...(await state()) });
    } catch (err) {
      console.error(err);
      // Published either way; only the emails (or the answer) went wrong.
      res.json({ success: true, notified, error_notify: 'Published, but the emails could not all be sent. Check the Sent list.' });
    }
  });

  // Takes the guide away from guests (their phones drop the saved copy next time they're online). The draft stays.
  app.post('/api/admin/event/guide/unpublish', ADMINS, json, async (req, res) => {
    try {
      const r = await pool.query("UPDATE events SET guide_published = NULL, guide_published_at = NULL WHERE status = 'current' RETURNING id");
      if (!r.rowCount) return res.status(409).json({ error: 'There is no current event.' });
      res.json({ success: true, ...(await state()) });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error.' }); }
  });
}

// ---------- the guide's view, shared with the guest site ----------
// GUIDE_VIEW_JS defines GUIDE (render, nowNext, …) in the browser; GUIDE_VIEW_CSS styles .gd with the guest site's
// tokens. Both are copied word for word from controlfrontend/index.html (between the guide:render and guide:css
// markers), so the admin preview is exactly what a paid guest sees.
export const GUIDE_VIEW_JS = `  // guide:render:start. The event guide's view, shared word for word by the guest site (controlfrontend/index.html)
  // and the admin preview (control/guide.js, GUIDE_VIEW_JS): change one, copy it to the other. Plain DOM, textContent
  // only, links https only. No backticks, dollar-braces or backslashes in here (it also lives in a template literal).
  const GUIDE = (function () {
    const NS = 'http://www.w3.org/2000/svg';
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const AST = 4 * 3600000; // Antigua is UTC-4 all year
    const DAY_MS = 86400000;
    const KINDS = { DO: ['r-do', 'Do'], DONT: ['r-dont', "Don't"], HEADS_UP: ['r-heads', 'Heads up'] };
    const ICONS = {
      pin: ['M12 21s-6.5-6.1-6.5-11a6.5 6.5 0 0 1 13 0c0 4.9-6.5 11-6.5 11z', 'M12 7.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z'],
      'r-do': ['M5 12.5l4.5 4.5L19 7.5'],
      'r-dont': ['M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17z', 'M6 6l12 12'],
      'r-heads': ['M12 3.5l9.5 17h-19z', 'M12 10v4.5', 'M12 17.2v.6']
    };
    const num = (s, a, b) => parseInt(String(s).slice(a, b), 10);
    const isHm = (s) => typeof s === 'string' && s.length === 5 && s[2] === ':' && num(s, 0, 2) >= 0 && num(s, 0, 2) < 24 && num(s, 3, 5) >= 0 && num(s, 3, 5) < 60;
    const isDay = (s) => typeof s === 'string' && s.length === 10 && s[4] === '-' && s[7] === '-' && num(s, 0, 4) > 2000 && num(s, 5, 7) > 0 && num(s, 8, 10) > 0;
    const isFull = (s) => typeof s === 'string' && s.length === 16 && s[10] === 'T' && isDay(s.slice(0, 10)) && isHm(s.slice(11));
    const mins = (hm) => num(hm, 0, 2) * 60 + num(hm, 3, 5);
    const at = (day, hm) => Date.UTC(num(day, 0, 4), num(day, 5, 7) - 1, num(day, 8, 10), num(hm, 0, 2), num(hm, 3, 5)) + AST;
    function el(tag, cls, text) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined && text !== null && text !== '') e.textContent = text;
      return e;
    }
    function icon(name) {
      const s = document.createElementNS(NS, 'svg');
      s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
      s.setAttribute('stroke-width', '1.8'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
      (ICONS[name] || []).forEach((d) => { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p); });
      return s;
    }
    // '21:30' or '2026-11-01T21:30' (Antigua time) -> '9:30 PM'
    function fmtTime(s) {
      const hm = isFull(s) ? s.slice(11) : s;
      if (!isHm(hm)) return '';
      const h = num(hm, 0, 2);
      return ((h + 11) % 12 + 1) + ':' + hm.slice(3, 5) + ' ' + (h < 12 ? 'AM' : 'PM');
    }
    // '2026-11-01' -> 'Sun 1 Nov'
    function fmtDay(s) {
      if (!isDay(s)) return '';
      const d = new Date(Date.UTC(num(s, 0, 4), num(s, 5, 7) - 1, num(s, 8, 10)));
      return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
    }
    // An ISO instant -> 'Sun 25 Oct, 9:14 PM' in Antigua time
    function fmtStamp(iso) {
      const t = Date.parse(iso);
      if (isNaN(t)) return '';
      const d = new Date(t - AST), two = (n) => (n < 10 ? '0' : '') + n;
      return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ', ' + fmtTime(two(d.getUTCHours()) + ':' + two(d.getUTCMinutes()));
    }
    // The schedule in time order. The day is the meeting point's (or the first full date in the schedule); a time more
    // than six hours before the meet time counts as the next morning, after midnight. when: the moment, once the day is known.
    function timeline(g) {
      const meet = (g && g.meet) || {}, list = (g && Array.isArray(g.schedule)) ? g.schedule : [];
      let day = isDay(meet.date) ? meet.date : '';
      if (!day) { const f = list.find((x) => isFull(x && x.time)); if (f) day = f.time.slice(0, 10); }
      const m0 = isHm(meet.time) ? mins(meet.time) : null;
      return list.map((x, i) => {
        const t = String((x && x.time) || ''), full = isFull(t), hm = full ? t.slice(11) : isHm(t) ? t : '';
        const late = !full && hm && m0 !== null && mins(hm) < m0 - 360 ? 1 : 0;
        const when = full ? at(t.slice(0, 10), hm) : hm && day ? at(day, hm) + late * DAY_MS : null;
        const key = when !== null ? when : hm ? (late * 1440 + mins(hm)) * 60000 : Infinity;
        return { item: x, i, hm, when, key };
      }).sort((a, b) => (a.key - b.key) || (a.i - b.i));
    }
    // What's on now and what's next, on the day only: from midnight (Antigua) until three hours after the last item.
    function nowNext(g, now) {
      const rows = timeline(g).filter((r) => r.when !== null);
      if (!rows.length) return null;
      const first = rows[0].when, last = rows[rows.length - 1].when;
      const dayStart = first - ((first - AST) % DAY_MS + DAY_MS) % DAY_MS;
      if (now < dayStart || now > last + 3 * 3600000) return null;
      let cur = null, next = null;
      rows.forEach((r) => { if (r.when <= now) cur = r; else if (!next) next = r; });
      return { now: cur, next };
    }
    // [label, https link] for each map button: both apps from a pin, or the one link that was pasted.
    function mapLinks(map, label) {
      if (!map || typeof map !== 'object') return [];
      if (typeof map.lat === 'number' && typeof map.lng === 'number' && isFinite(map.lat) && isFinite(map.lng)) {
        const ll = map.lat + ',' + map.lng;
        return [['Open in Google Maps', 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(ll)],
          ['Open in Apple Maps', 'https://maps.apple.com/?ll=' + encodeURIComponent(ll) + (label ? '&q=' + encodeURIComponent(label) : '')]];
      }
      if (typeof map.url !== 'string' || map.url.indexOf('https://') !== 0) return [];
      let host = '';
      try { host = new URL(map.url).hostname.toLowerCase(); } catch (e) { return []; }
      const apple = host === 'maps.apple.com' || host.slice(-10) === '.apple.com';
      const google = host.indexOf('google.') >= 0 || host === 'goo.gl' || host === 'maps.app.goo.gl';
      return [[apple ? 'Open in Apple Maps' : google ? 'Open in Google Maps' : 'Open the map', map.url]];
    }
    // An https:// image, or a file in the guest site like "art/meet.jpg" (the poster's rule). site: where such files live.
    const PATH_OK = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
    function imageSrc(v, site) {
      if (typeof v !== 'string' || !v) return '';
      if (v.indexOf('https://') === 0) { try { return new URL(v).protocol === 'https:' && v.indexOf('"') < 0 && v.indexOf(' ') < 0 ? v : ''; } catch (e) { return ''; } }
      const dot = v.lastIndexOf('.'), ext = v.slice(dot + 1).toLowerCase();
      if (dot < 1 || ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif'].indexOf(ext) < 0) return '';
      const ok = v.slice(0, dot).split('/').every((p) => p.length > 0 && p.split('').every((c) => PATH_OK.indexOf(c) >= 0));
      return ok ? (site || '') + v : '';
    }
    const has = (v) => typeof v === 'string' && v.trim() !== '';
    const sections = (g) => {
      const m = (g && g.meet) || {}, p = (g && g.parking) || {};
      return {
        meet: has(m.place) || has(m.time) || has(m.how) || has(m.image) || mapLinks(m.map).length > 0,
        route: !!(g && Array.isArray(g.route) && g.route.length),
        schedule: !!(g && Array.isArray(g.schedule) && g.schedule.length),
        parking: has(p.text) || has(p.image) || mapLinks(p.map).length > 0,
        rules: !!(g && Array.isArray(g.rules) && g.rules.length)
      };
    };
    const isEmpty = (g) => { const s = sections(g); return !(s.meet || s.route || s.schedule || s.parking || s.rules); };

    function mapButtons(box, map, label) {
      const links = mapLinks(map, label);
      if (!links.length) return;
      const row = el('div', 'gd-maps');
      links.forEach(([text, href]) => {
        const a = el('a', 'gd-map');
        a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.append(icon('pin'), el('span', '', text));
        row.appendChild(a);
      });
      box.appendChild(row);
    }
    function picture(box, src, alt, site) {
      const v = imageSrc(src, site);
      if (!v) return;
      const f = el('figure', 'gd-fig'), img = el('img');
      img.alt = alt; img.loading = 'lazy'; img.decoding = 'async';
      img.onerror = () => f.remove();
      img.src = v;
      f.appendChild(img);
      box.appendChild(f);
    }
    // The schedule's rows and its Now / Next lines; redrawn by tick() on the day.
    function drawSchedule(box, g, now) {
      box.replaceChildren();
      const nn = nowNext(g, now);
      if (nn && (nn.now || nn.next)) {
        const line = el('div', 'gd-nn');
        if (nn.now) { const p = el('p', 'is-now'); p.append(el('span', '', 'Now'), el('b', '', nn.now.item.title || '')); line.appendChild(p); }
        if (nn.next) { const p = el('p', 'is-next'); p.append(el('span', '', 'Next'), el('b', '', [fmtTime(nn.next.hm), nn.next.item.title].filter(Boolean).join(' · '))); line.appendChild(p); }
        box.appendChild(line);
      }
      const ol = el('ol', 'gd-tl');
      timeline(g).forEach((r) => {
        const li = el('li', 'gd-item');
        const state = nn && nn.now && nn.now.i === r.i ? 'now' : nn && nn.next && nn.next.i === r.i ? 'next' : nn && r.when !== null && r.when < now ? 'past' : '';
        if (state) li.classList.add('is-' + state);
        li.appendChild(el('span', 'gd-at', fmtTime(r.hm) || '·'));
        li.appendChild(el('b', '', r.item.title || ''));
        if (state === 'now' || state === 'next') li.appendChild(el('span', 'gd-tag', state === 'now' ? 'Now' : 'Next'));
        if (has(r.item.note)) li.appendChild(el('p', '', r.item.note));
        ol.appendChild(li);
      });
      box.appendChild(ol);
    }
    // o: { name (the event's), site (where relative images live), saved (shown from this phone's copy), now (ms) }.
    function render(root, g, o) {
      o = o || {};
      g = g || {};
      root.replaceChildren();
      root.classList.add('gd');
      const s = sections(g);
      const head = el('header', 'gd-head');
      head.appendChild(el('p', 'gd-k', 'Your guide'));
      if (has(o.name)) head.appendChild(el('h2', 'gd-title', o.name));
      const meta = el('p', 'gd-meta');
      if (o.saved) meta.appendChild(el('span', 'gd-saved', 'Saved on this phone'));
      const stamp = fmtStamp(g.updated_at || g.published_at);
      if (stamp) meta.appendChild(el('span', '', 'Updated ' + stamp));
      if (meta.childNodes.length) head.appendChild(meta);
      head.appendChild(el('p', 'gd-only', "For paid guests only. Keep it in the crew: don't share it."));
      root.appendChild(head);
      let n = 0;
      const section = (key, title) => {
        const sec = el('section', 'gd-sec gd-' + key);
        const h = el('h3', 'gd-h');
        h.append(el('span', 'gd-n', String(++n).padStart(2, '0')), el('span', '', title));
        sec.appendChild(h);
        root.appendChild(sec);
        return sec;
      };
      if (s.meet) {
        const m = g.meet, sec = section('meet', 'Meeting point');
        if (has(m.place)) sec.appendChild(el('p', 'gd-place', m.place));
        if (fmtTime(m.time)) {
          const t = el('p', 'gd-time');
          t.appendChild(el('b', '', fmtTime(m.time)));
          if (m.sharp) t.appendChild(el('span', 'gd-sharp', 'Sharp'));
          sec.appendChild(t);
        }
        const when = [fmtDay(m.date), fmtTime(m.time) ? 'Antigua time' : ''].filter(Boolean).join(' · ');
        if (when) sec.appendChild(el('p', 'gd-date', when));
        mapButtons(sec, m.map, m.place);
        if (has(m.how)) { sec.appendChild(el('p', 'gd-sub', 'How to get there')); sec.appendChild(el('p', 'gd-text', m.how)); }
        picture(sec, m.image, 'The meeting point', o.site);
      }
      if (s.route) {
        const sec = section('route', 'Route');
        const ol = el('ol', 'gd-stops');
        g.route.forEach((x, i) => {
          const li = el('li', 'gd-stop' + (i === 0 ? ' is-start' : '') + (i === g.route.length - 1 && i > 0 ? ' is-end' : ''));
          const dot = el('span', 'gd-dot', String(i + 1));
          dot.setAttribute('aria-hidden', 'true');
          const body = el('div', 'gd-stop-t');
          body.appendChild(el('b', '', x.title || ''));
          if (has(x.note)) body.appendChild(el('p', '', x.note));
          li.append(dot, body);
          ol.appendChild(li);
        });
        sec.appendChild(ol);
      }
      if (s.schedule) {
        const sec = section('schedule', 'Schedule');
        sec.appendChild(el('p', 'gd-hint', 'Antigua time'));
        const box = el('div', 'gd-sched');
        sec.appendChild(box);
        drawSchedule(box, g, typeof o.now === 'number' ? o.now : Date.now());
        root.gdTick = (now) => drawSchedule(box, g, typeof now === 'number' ? now : Date.now());
      } else root.gdTick = null;
      if (s.parking) {
        const p = g.parking, sec = section('parking', 'Parking');
        if (has(p.text)) sec.appendChild(el('p', 'gd-text', p.text));
        mapButtons(sec, p.map, 'Parking');
        picture(sec, p.image, 'Parking', o.site);
        if (p.disclaimer) {
          const w = el('p', 'gd-warn');
          w.append(icon('r-heads'), el('span', '', 'Use at your own risk: not an official car park.'));
          sec.appendChild(w);
        }
      }
      if (s.rules) {
        const sec = section('rules', 'Rules');
        const ul = el('ul', 'gd-rlist');
        g.rules.forEach((r) => {
          const k = KINDS[r.kind] || KINDS.HEADS_UP;
          const li = el('li', 'gd-rule ' + k[0]);
          const ic = el('span', 'gd-ic');
          ic.appendChild(icon(k[0]));
          li.append(ic, el('span', 'gd-rk', k[1]), el('p', '', r.text || ''));
          ul.appendChild(li);
        });
        sec.appendChild(ul);
      }
    }
    return { render, nowNext, timeline, fmtTime, fmtDay, fmtStamp, mapLinks, imageSrc, sections, isEmpty };
  })();
  // guide:render:end
`;
export const GUIDE_VIEW_CSS = `    /* guide:css:start. The event guide's look, shared word for word by the guest site and the admin preview
       (control/guide.js, GUIDE_VIEW_CSS): change one, copy it to the other. It uses the guest site's tokens. */
    .gd { --gd-do: var(--acid); --gd-dont: var(--red); --gd-heads: var(--amber); position: relative; isolation: isolate; color: var(--text); font-family: var(--body); font-variant-numeric: tabular-nums; }
    .gd::before { content: ''; position: absolute; inset: 0; z-index: -1; background: var(--wm) 0 0 / 260px 150px; pointer-events: none; }
    :where(.gd) :where(p, h2, h3, ol, ul, figure) { margin: 0; }
    .gd-head { padding-bottom: 22px; border-bottom: 1px solid var(--line-2); }
    .gd-k { font: 400 12px/1.2 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
    .gd-k::before { content: '[ '; } .gd-k::after { content: ' ]'; }
    .gd-title { margin-top: 12px; font: 900 clamp(30px, 8.6vw, 44px)/.95 var(--wide); font-stretch: 125%; letter-spacing: -.01em; text-transform: uppercase; overflow-wrap: anywhere; }
    .gd-meta { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 12px; font: 400 12.5px/1.5 var(--mono); color: var(--muted); }
    .gd-saved { color: var(--gd-do); }
    .gd-saved::before { content: ''; display: inline-block; width: 7px; height: 7px; margin-right: 8px; background: currentColor; vertical-align: 1px; }
    .gd-only { margin-top: 10px; color: var(--muted); font-size: 14.5px; line-height: 1.5; }
    .gd-sec { padding: 30px 0; border-bottom: 1px solid var(--line); }
    .gd-sec:last-child { border-bottom: 0; padding-bottom: 4px; }
    .gd-h { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; font: 400 12px/1.2 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--text); }
    .gd-h::after { content: ''; flex: 1; height: 1px; background: var(--line); }
    .gd-n { color: var(--orange); font-weight: 700; }
    .gd-place { font: 900 clamp(26px, 7.6vw, 38px)/1 var(--wide); font-stretch: 125%; letter-spacing: -.005em; text-transform: uppercase; overflow-wrap: anywhere; }
    .gd-time { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 16px; margin-top: 16px; }
    .gd-time b { font: 900 clamp(46px, 15vw, 72px)/.88 var(--wide); font-stretch: 125%; letter-spacing: -.02em; white-space: nowrap; }
    .gd-sharp { display: inline-flex; align-items: center; min-height: 30px; padding: 0 10px; background: var(--orange); color: var(--ink); font: 700 12px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; }
    .gd-date { margin-top: 12px; font: 400 13px/1.4 var(--mono); letter-spacing: .04em; color: var(--muted); }
    .gd-maps { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 8px; margin-top: 22px; }
    .gd-map { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 0 16px; border: 1px solid var(--line-2); color: var(--text); text-decoration: none; font: 700 14px/1.2 var(--wide); font-stretch: 112%; letter-spacing: .04em; text-transform: uppercase; transition: border-color .2s, background .2s; }
    .gd-map svg { width: 18px; height: 18px; flex: none; color: var(--orange); }
    .gd-map span { flex: 1; }
    .gd-map::after { content: '↗'; font: 400 16px/1 var(--mono); color: var(--muted); }
    .gd-map:hover { border-color: var(--text); background: rgba(236, 235, 230, .05); }
    .gd-sub { margin-top: 26px; font: 400 12px/1.2 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
    .gd-text { margin-top: 10px; font-size: 16px; line-height: 1.6; white-space: pre-line; overflow-wrap: anywhere; }
    .gd-fig { margin-top: 22px; border: 1px solid var(--line); background: var(--black); }
    .gd-fig img { display: block; width: 100%; height: auto; max-height: 440px; object-fit: cover; }
    .gd-hint { margin: -8px 0 16px; font: 400 12px/1.4 var(--mono); color: var(--muted); }
    /* The route: one line down the stops, each a numbered marker; the start is orange, the end solid chalk. */
    .gd-stops { list-style: none; padding: 0; }
    .gd-stop { position: relative; display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 0 16px; padding-bottom: 24px; }
    .gd-stop:last-child { padding-bottom: 0; }
    .gd-stop::before { content: ''; position: absolute; left: 14px; top: 30px; bottom: 0; width: 2px; background: var(--line-2); }
    .gd-stop.is-start::before { background: linear-gradient(var(--orange), var(--line-2)); }
    .gd-stop:last-child::before { display: none; }
    .gd-dot { position: relative; display: grid; place-items: center; width: 30px; height: 30px; border: 2px solid var(--text); background: var(--char); color: var(--text); font: 700 12px/1 var(--mono); }
    .gd-stop.is-start .gd-dot { background: var(--orange); border-color: var(--orange); color: var(--ink); }
    .gd-stop.is-end .gd-dot { background: var(--text); color: var(--ink); }
    .gd-stop-t { padding-top: 4px; min-width: 0; }
    .gd-stop-t b { display: block; font: 800 17px/1.25 var(--wide); font-stretch: 112%; letter-spacing: .02em; text-transform: uppercase; overflow-wrap: anywhere; }
    .gd-stop-t p { margin-top: 4px; color: var(--muted); font-size: 15px; line-height: 1.5; overflow-wrap: anywhere; }
    /* The schedule: time, what, and on the day a Now / Next line and marks. */
    .gd-nn { display: grid; gap: 8px; margin-bottom: 18px; }
    .gd-nn p { display: flex; align-items: baseline; gap: 12px; padding: 13px 14px; background: var(--char-2); border-left: 3px solid var(--gd-do); font-size: 16px; line-height: 1.35; }
    .gd-nn span { flex: none; min-width: 3.6em; font: 700 11.5px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--gd-do); }
    .gd-nn b { overflow-wrap: anywhere; }
    .gd-nn .is-next { border-left-color: var(--text); }
    .gd-nn .is-next span { color: var(--text); }
    .gd-tl { list-style: none; padding: 0; border-top: 1px solid var(--line); }
    .gd-item { display: grid; grid-template-columns: 84px minmax(0, 1fr) auto; align-items: baseline; gap: 4px 12px; padding: 15px 0; border-bottom: 1px solid var(--line); }
    .gd-at { font: 700 14px/1.3 var(--mono); white-space: nowrap; }
    .gd-item b { font-size: 16px; line-height: 1.35; overflow-wrap: anywhere; }
    .gd-item p { grid-column: 2 / -1; color: var(--muted); font-size: 14.5px; line-height: 1.5; overflow-wrap: anywhere; }
    .gd-tag { padding: 5px 7px; font: 700 11px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; }
    .gd-item.is-now, .gd-item.is-next { padding-left: 12px; }
    .gd-item.is-now { box-shadow: inset 3px 0 0 var(--gd-do); background: linear-gradient(90deg, rgba(182, 255, 59, .08), transparent 70%); }
    .gd-item.is-now .gd-tag { background: var(--gd-do); color: var(--ink); }
    .gd-item.is-next { box-shadow: inset 3px 0 0 var(--text); }
    .gd-item.is-next .gd-tag { box-shadow: inset 0 0 0 1px var(--text); }
    .gd-item.is-past .gd-at, .gd-item.is-past b { color: var(--muted); font-weight: 400; }
    /* Parking's disclaimer, and the rules: an icon and a label in each one's colour. */
    .gd-warn { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 12px; align-items: start; margin-top: 22px; padding: 14px 16px; border: 1px solid var(--line-2); border-left: 3px solid var(--gd-heads); font-size: 15px; line-height: 1.5; }
    .gd-warn svg { width: 22px; height: 22px; color: var(--gd-heads); }
    .gd-rlist { list-style: none; padding: 0; border-top: 1px solid var(--line); }
    .gd-tl > li:last-child, .gd-rlist > li:last-child { border-bottom: 0; padding-bottom: 0; }
    .gd-rule { display: grid; grid-template-columns: 40px minmax(0, 1fr); align-items: start; gap: 2px 14px; padding: 15px 0; border-bottom: 1px solid var(--line); }
    .gd-ic { grid-row: span 2; display: grid; place-items: center; width: 40px; height: 40px; border: 1px solid currentColor; }
    .gd-ic svg { width: 20px; height: 20px; }
    .gd-rk { font: 700 11.5px/1.4 var(--mono); letter-spacing: .14em; text-transform: uppercase; }
    .gd-rule p { color: var(--text); font-size: 16px; line-height: 1.45; overflow-wrap: anywhere; }
    .gd-rule.r-do { color: var(--gd-do); } .gd-rule.r-dont { color: var(--gd-dont); } .gd-rule.r-heads { color: var(--gd-heads); }
    .gd-rule.r-dont .gd-ic { border-style: dashed; }
    @media (prefers-reduced-motion: reduce) { .gd-map { transition: none; } }
    /* guide:css:end */
`;

// ---------- the Guide section of /admin/event ("Event & messages") ----------
// An editor for each section (rows added, removed and moved with buttons), a live preview drawn by the guest site's own
// code (GUIDE_VIEW_JS / GUIDE_VIEW_CSS) with the guest site's tokens, and Save draft / Publish / Unpublish. Side by side
// from 1100px; on a phone, Edit and Preview tabs. Client code sits in a template literal: no backticks or backslashes.
export function guideAdmin({ FRONTEND_URL, WM }) {
  const SITE = JSON.stringify(String(FRONTEND_URL).replace(/\/$/, '') + '/');
  const css = `
/* The preview runs the guest site's guide view, so it gets the guest site's tokens here. */
.ge-host { --char: #141416; --char-2: #1a1a1d; --char-3: #232327; --black: #0a0a0b; --line: rgba(236, 235, 230, .12); --line-2: rgba(236, 235, 230, .26);
  --text: #ecebe6; --muted: #a6a59f; --dim: #86857f; --ink: #141416; --orange: #ff5a1f; --cyan: #22e1ff; --acid: #b6ff3b; --red: #ff7a6b; --amber: #ffb020;
  --wide: 'Archivo', 'Arial Narrow', sans-serif; --body: 'Archivo', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --mono: 'Space Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; --wm: ${WM};
  background: var(--char); color: var(--text); font: 400 16px/1.55 var(--body); padding: 24px 18px 28px; border: 1px solid var(--line); }
${GUIDE_VIEW_CSS}
.ge-card { padding-bottom: 0; }
#guide { scroll-margin-top: 76px; }
.hidden { display: none !important; }
.card > .ge-state { display: inline-flex; align-items: center; gap: 10px; margin: 16px 0 0; font: 400 13px/1.4 var(--mono); color: var(--muted); }
.ge-state::before { content: ''; flex: none; width: 9px; height: 9px; border: 1px solid var(--muted); }
.card > .ge-state.on { color: var(--text); } .ge-state.on::before { background: var(--good); border-color: var(--good); }
.ge-state.dirty::before { background: var(--warn); border-color: var(--warn); }
.ge-tabs { display: flex; margin: 20px 0 0; border: 1px solid var(--line-strong); }
.ge-tabs button { flex: 1; min-height: 44px; background: transparent; color: var(--muted); border: 0; }
.ge-tabs button[aria-selected="true"] { background: var(--text); color: var(--ink); }
.ge-cols { display: block; margin-top: 4px; }
.ge-cols[data-tab="edit"] .ge-prev, .ge-cols[data-tab="preview"] .ge-form { display: none; }
.ge-fs { margin: 26px 0 0; padding: 0; border: 0; min-width: 0; }
.ge-fs > legend { display: flex; align-items: center; gap: 10px; width: 100%; padding: 0 0 12px; border-bottom: 1px solid var(--line); font: 800 15px/1.1 var(--display); font-stretch: 112%; letter-spacing: .03em; text-transform: uppercase; color: var(--text); }
.ge-fs > legend span { font: 700 12px/1 var(--mono); color: var(--accent); }
.ge-fs > label:first-of-type { margin-top: 16px; }
.ge-2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0 12px; }
.ge-hint { display: block; color: var(--dim); font-size: 13px; margin-top: 8px; }
.ge-hint.ok { color: var(--good); } .ge-hint.err { color: var(--bad); }
.ge-rows { list-style: none; margin: 14px 0 0; padding: 0; border-top: 1px solid var(--line); counter-reset: none; }
.ge-row { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 8px 10px; padding: 12px 0; border-bottom: 1px solid var(--line); }
.ge-row .n { padding-top: 12px; font: 700 12px/1 var(--mono); color: var(--accent); }
.ge-row .f { display: grid; gap: 8px; min-width: 0; }
.ge-row .f2 { display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: 8px; }
.ge-row .ctl { grid-column: 2; display: flex; gap: 6px; justify-content: flex-end; }
.ge-row .ctl button { width: 44px; min-height: 44px; padding: 0; font: 400 16px/1 var(--mono); }
.ge-row input, .ge-row select { min-height: 44px; }
.ge-row.err input, .ge-row.err select { border-color: var(--bad); }
.ge-empty { margin: 12px 0 0; color: var(--dim); font-size: 14px; font-style: italic; }
.ge-add { margin-top: 12px; }
.ge-prev-k { margin: 26px 0 10px; font: 400 11px/1.2 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
.ge-at { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 12px 0 0; font-family: var(--body); font-size: 13px; letter-spacing: 0; text-transform: none; color: var(--muted); }
.ge-at input { width: auto; flex: 1 1 200px; min-height: 40px; font-size: 14px; }
.ge-bar { position: sticky; bottom: 0; z-index: 5; margin: 26px calc(-1 * clamp(20px, 3vw, 28px)) 0; padding: 14px clamp(20px, 3vw, 28px) calc(14px + env(safe-area-inset-bottom)); background: rgba(20, 20, 22, .96); border-top: 1px solid var(--line-strong); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); }
.ge-bar .check { margin: 0 0 12px; min-height: 32px; }
.ge-bar .foot { margin-top: 0; }
.ge-bar .msg { flex: 1 1 100%; }
button.bad-ghost { color: var(--bad); background: transparent; border-color: rgba(255, 122, 107, .5); }
button.bad-ghost:hover { background: rgba(255, 122, 107, .08); border-color: var(--bad); }
#gd-dlg { width: min(460px, calc(100vw - 32px)); padding: 26px; border: 0; border-top: 3px solid var(--accent); background: var(--concrete-2); color: var(--ink); }
#gd-dlg::backdrop { background: rgba(5, 5, 6, .74); }
#gd-dlg h3 { margin: 0 0 10px; font: 800 19px/1.15 var(--display); font-stretch: 112%; text-transform: uppercase; color: var(--ink); }
#gd-dlg p { margin: 0; color: var(--ink-2); }
#gd-dlg .foot { justify-content: flex-end; }
#gd-dlg button.ghost { color: var(--ink); border-color: rgba(20, 20, 22, .4); }
@media (min-width: 1100px) {
  #guide { width: min(1240px, calc(100vw - 64px)); margin-left: calc((100% - min(1240px, 100vw - 64px)) / 2); }
  .ge-tabs { display: none; }
  .ge-cols, .ge-cols[data-tab] { display: grid; grid-template-columns: minmax(0, 1fr) minmax(380px, 460px); gap: 40px; align-items: start; }
  .ge-cols[data-tab] .ge-form, .ge-cols[data-tab] .ge-prev { display: block; }
  .ge-prev { position: sticky; top: 76px; max-height: calc(100vh - 250px); overflow-y: auto; }
  .ge-row { grid-template-columns: 30px minmax(0, 1fr) auto; }
  .ge-row .ctl { grid-column: 3; align-self: start; }
  .ge-prev-k { margin-top: 26px; }
}
@media (max-width: 420px) { .ge-row .f2 { grid-template-columns: 1fr; } }
`;
  const html = `
  <section class="card ge-card" id="guide" aria-labelledby="gd-h">
    <h2 id="gd-h">Guide</h2>
    <p>The plan for the night, for paid guests only: where and when to meet, the route, the times, parking and the rules. It sits in their account next to their pass (and stays on their phone for bad signal) once you publish it. Empty sections stay hidden. Guests never see the draft.</p>
    <p class="ge-state" id="gd-state" role="status">Loading…</p>
    <div class="ge-tabs" role="tablist" aria-label="Guide">
      <button type="button" role="tab" id="gd-tab-edit" aria-selected="true" aria-controls="gd-form">Edit</button>
      <button type="button" role="tab" id="gd-tab-prev" aria-selected="false" aria-controls="gd-prev" tabindex="-1">Preview</button>
    </div>
    <div class="ge-cols" id="gd-cols" data-tab="edit">
      <div class="ge-form" id="gd-form" role="tabpanel" aria-labelledby="gd-tab-edit">
        <fieldset class="ge-fs"><legend><span>01</span> Meeting point</legend>
          <label for="g-place">Place</label>
          <input id="g-place" maxlength="120" placeholder="Example: The Dockyard gate" data-path="meet.place">
          <div class="ge-2">
            <div><label for="g-date">Day</label><input id="g-date" type="date" data-path="meet.date"></div>
            <div><label for="g-time">Meet time</label><input id="g-time" type="time" data-path="meet.time"></div>
          </div>
          <small class="ge-hint">Antigua time. The day lets guests see what's on now and next on the night.</small>
          <label class="check"><input type="checkbox" id="g-sharp" data-path="meet.sharp"> Sharp: we leave on time</label>
          <label for="g-map">Map link or pin</label>
          <input id="g-map" inputmode="url" maxlength="600" placeholder="Google or Apple Maps link, or 17.0123, -61.7654" data-path="meet.map" aria-describedby="g-map-hint">
          <small class="ge-hint" id="g-map-hint">Paste the Share link from Google or Apple Maps, or a pin.</small>
          <label for="g-how">How to get there</label>
          <textarea id="g-how" maxlength="2000" placeholder="Example: Taxis drop at the main gate. Walk past the bakery; we're on the left." data-path="meet.how"></textarea>
          <label for="g-img">Picture (optional)</label>
          <input id="g-img" maxlength="500" inputmode="url" placeholder="art/meet.jpg or https://…" data-path="meet.image" aria-describedby="g-img-hint">
          <small class="ge-hint" id="g-img-hint">A file in the guest site repo, like art/meet.jpg, or any https:// image link.</small>
        </fieldset>
        <fieldset class="ge-fs"><legend><span>02</span> Route</legend>
          <small class="ge-hint">The stops in order. Guests see them on a line, first to last.</small>
          <ol class="ge-rows" id="g-route"></ol>
          <button type="button" class="ghost ge-add" id="g-add-route">Add stop</button>
        </fieldset>
        <fieldset class="ge-fs"><legend><span>03</span> Schedule</legend>
          <small class="ge-hint">Guests see these in time order, with Now and Next on the day. A time more than 6 hours before the meet time counts as after midnight.</small>
          <ol class="ge-rows" id="g-schedule"></ol>
          <button type="button" class="ghost ge-add" id="g-add-schedule">Add a time</button>
        </fieldset>
        <fieldset class="ge-fs"><legend><span>04</span> Parking</legend>
          <label for="g-park">Where to park</label>
          <textarea id="g-park" maxlength="2000" placeholder="Example: Park in the field behind the church. No parking along the route." data-path="parking.text"></textarea>
          <label for="g-pmap">Map link or pin</label>
          <input id="g-pmap" inputmode="url" maxlength="600" placeholder="Google or Apple Maps link, or 17.0123, -61.7654" data-path="parking.map" aria-describedby="g-pmap-hint">
          <small class="ge-hint" id="g-pmap-hint">Optional.</small>
          <label for="g-pimg">Picture (optional)</label>
          <input id="g-pimg" maxlength="500" inputmode="url" placeholder="art/parking.jpg or https://…" data-path="parking.image">
          <label class="check"><input type="checkbox" id="g-disc" data-path="parking.disclaimer"> Add "Use at your own risk: not an official car park."</label>
        </fieldset>
        <fieldset class="ge-fs"><legend><span>05</span> Rules</legend>
          <small class="ge-hint">Each one is a Do, a Don't or a Heads up, with its own mark and colour.</small>
          <ol class="ge-rows" id="g-rules"></ol>
          <button type="button" class="ghost ge-add" id="g-add-rules">Add rule</button>
        </fieldset>
      </div>
      <div class="ge-prev" id="gd-prev" role="tabpanel" aria-labelledby="gd-tab-prev">
        <p class="ge-prev-k">What paid guests see</p>
        <div class="ge-host"><div id="gd-preview"></div></div>
        <label class="ge-at">See it as at <input type="datetime-local" id="gd-at" aria-label="Preview the guide as at this Antigua time"></label>
      </div>
    </div>
    <div class="ge-bar">
      <label class="check" id="g-notify-wrap"><input type="checkbox" id="g-notify" checked> <span id="g-notify-l">Email paid guests that it's ready</span></label>
      <div class="foot">
        <button type="button" id="g-publish">Publish</button>
        <button type="button" class="ghost" id="g-save">Save draft</button>
        <button type="button" class="bad-ghost hidden" id="g-unpub">Unpublish</button>
        <span id="g-msg" class="msg" role="status"></span>
      </div>
    </div>
  </section>
  <dialog id="gd-dlg" aria-labelledby="gd-dlg-h"><h3 id="gd-dlg-h"></h3><p id="gd-dlg-p"></p>
    <div class="foot"><button type="button" class="ghost" id="gd-dlg-no">Cancel</button><button type="button" id="gd-dlg-ok">Confirm</button></div></dialog>`;
  const js = `
${GUIDE_VIEW_JS}
(function () {
  const q = (id) => document.getElementById(id);
  const SITE = ${SITE};
  const KIND_LABEL = { DO: 'Do', DONT: "Don't", HEADS_UP: 'Heads up' };
  const LISTS = {
    route: { max: 20, blank: () => ({ title: '', note: '' }), what: 'stop', fields: [['title', 'Name', 'Example: Start: the Dockyard gate', 100], ['note', 'Note (optional)', 'Example: Water stop', 300]] },
    schedule: { max: 30, blank: () => ({ time: '', title: '', note: '' }), what: 'time', fields: [['time', 'Time', '', 5], ['title', 'What', 'Example: Swim time', 100], ['note', 'Note (optional)', '', 300]] },
    rules: { max: 30, blank: () => ({ kind: 'DO', text: '' }), what: 'rule', fields: [['kind', 'Kind', '', 0], ['text', 'Rule', 'Example: No swimming at the pier', 200]] }
  };
  let S = null, G = null, dirty = false, timer = null, busy = false, atTime = null;
  const copy = (x) => JSON.parse(JSON.stringify(x));
  const plain = (m) => (m && typeof m === 'object' ? (typeof m.lat === 'number' ? m.lat + ', ' + m.lng : m.url || '') : m || '');

  // Map links, as the server reads them (guide.js parseMap): a pin, else the link kept as it is.
  function pin(a, b) { a = Number(a); b = Number(b); return isFinite(a) && isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 && !(a === 0 && b === 0) ? { lat: Math.round(a * 1e6) / 1e6, lng: Math.round(b * 1e6) / 1e6 } : null; }
  function pinOf(s) { const m = /^(?:loc:)?[ ]*(-?[0-9]{1,2}(?:[.][0-9]+)?)[ ]*[, ][ ]*[+]?(-?[0-9]{1,3}(?:[.][0-9]+)?)(?:[ ]*[(].*[)])?[ ]*$/.exec(String(s || '').trim()); return m ? pin(m[1], m[2]) : null; }
  function mapOf(v) {
    if (v && typeof v === 'object') return v;
    const s = String(v || '').trim();
    if (!s) return null;
    const ll = pinOf(s); if (ll) return ll;
    if (s.indexOf('https://') !== 0) return { bad: true };
    let u; try { u = new URL(s); } catch (e) { return { bad: true }; }
    let whole = u.pathname + u.search + u.hash; try { whole = decodeURIComponent(whole); } catch (e) {}
    let m = /!3d(-?[0-9]{1,2}[.][0-9]+)!4d(-?[0-9]{1,3}[.][0-9]+)/.exec(whole);
    if (m && pin(m[1], m[2])) return pin(m[1], m[2]);
    for (const k of ['q', 'query', 'll', 'sll', 'center', 'destination', 'daddr', 'coordinate', 'saddr']) { const p = pinOf(u.searchParams.get(k)); if (p) return p; }
    m = /@(-?[0-9]{1,2}[.][0-9]+),(-?[0-9]{1,3}[.][0-9]+)/.exec(whole);
    if (m && pin(m[1], m[2])) return pin(m[1], m[2]);
    let path = u.pathname; try { path = decodeURIComponent(path); } catch (e) {}
    m = /[/](-?[0-9]{1,2}[.][0-9]+),[+]?(-?[0-9]{1,3}[.][0-9]+)/.exec(path);
    if (m && pin(m[1], m[2])) return pin(m[1], m[2]);
    return { url: u.href };
  }
  function mapHint(id, v, empty) {
    const h = q(id), m = mapOf(v);
    h.className = 'ge-hint';
    if (!m) { h.textContent = empty; return; }
    if (m.bad) { h.className = 'ge-hint err'; h.textContent = 'Use an https:// map link, or a pin like 17.0123, -61.7654.'; return; }
    if (typeof m.lat === 'number') { h.className = 'ge-hint ok'; h.textContent = 'Pin found: ' + m.lat + ', ' + m.lng + '. Guests get Google Maps and Apple Maps buttons.'; return; }
    h.textContent = 'Kept as a link: guests get one button that opens it.';
  }
  function imgHint(v) {
    const h = q('g-img-hint');
    h.className = 'ge-hint' + (v && !GUIDE.imageSrc(v, SITE) ? ' err' : '');
    h.textContent = v && !GUIDE.imageSrc(v, SITE) ? 'Use an https:// image link, or a path like art/meet.jpg.' : 'A file in the guest site repo, like art/meet.jpg, or any https:// image link.';
  }
  // What a guest would see right now: the form as it stands, map links read the way the server will.
  function view() {
    const g = copy(G);
    g.meet.map = mapOf(G.meet.map); if (g.meet.map && g.meet.map.bad) g.meet.map = null;
    g.parking.map = mapOf(G.parking.map); if (g.parking.map && g.parking.map.bad) g.parking.map = null;
    g.route = g.route.filter((x) => x.title.trim()).map((x) => ({ title: x.title.trim(), note: x.note.trim() }));
    g.schedule = g.schedule.filter((x) => x.title.trim() && x.time);
    g.rules = g.rules.filter((x) => x.text.trim());
    ['place', 'how', 'image'].forEach((k) => { g.meet[k] = String(g.meet[k] || '').trim(); });
    g.parking.text = String(g.parking.text || '').trim(); g.parking.image = String(g.parking.image || '').trim();
    if (S && S.published_at) g.updated_at = S.published_at;
    return g;
  }
  function preview() {
    timer = null;
    const box = q('gd-preview');
    GUIDE.render(box, view(), { name: S ? S.event.name : '', site: SITE, now: atTime === null ? Date.now() : atTime });
    if (GUIDE.isEmpty(view())) { const p = document.createElement('p'); p.className = 'gd-only'; p.textContent = 'Nothing to show yet. Fill in a section and it appears here.'; box.appendChild(p); }
  }
  const later = () => { if (!timer) timer = setTimeout(preview, 120); };
  function stateLine() {
    const st = q('gd-state'), parts = [];
    if (S.published_at) {
      parts.push('Published ' + GUIDE.fmtStamp(S.published_at));
      if (S.notified_at && S.last_notice) parts.push('emailed ' + S.last_notice.sent + (S.last_notice.sent === 1 ? ' guest' : ' guests'));
    } else parts.push('Draft', 'not published');
    if (dirty) parts.push('unsaved changes');
    else if (S.changed) parts.push("the draft has changes guests don't see yet");
    st.textContent = parts.join(' · ');
    st.className = 'ge-state' + (S.published_at ? ' on' : '') + (dirty || S.changed ? ' dirty' : '');
    q('g-unpub').classList.toggle('hidden', !S.published_at);
    q('g-publish').textContent = S.published_at ? 'Publish changes' : 'Publish';
  }
  function touch() { dirty = true; stateLine(); later(); }
  function say(text, ok) { const m = q('g-msg'); m.textContent = text; m.className = 'msg ' + (ok ? 'ok' : 'err'); }

  // ---- the fixed fields ----
  function getPath(p) { const [a, b] = p.split('.'); return G[a][b]; }
  function setPath(p, v) { const [a, b] = p.split('.'); G[a][b] = v; }
  document.querySelectorAll('#gd-form [data-path]').forEach((input) => {
    input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', () => {
      setPath(input.dataset.path, input.type === 'checkbox' ? input.checked : input.value);
      if (input.id === 'g-map') mapHint('g-map-hint', input.value, 'Paste the Share link from Google or Apple Maps, or a pin.');
      if (input.id === 'g-pmap') mapHint('g-pmap-hint', input.value, 'Optional.');
      if (input.id === 'g-img') imgHint(input.value.trim());
      input.removeAttribute('aria-invalid');
      touch();
    });
  });
  function fill() {
    document.querySelectorAll('#gd-form [data-path]').forEach((input) => {
      const v = getPath(input.dataset.path);
      if (input.type === 'checkbox') input.checked = !!v;
      else input.value = /map$/.test(input.dataset.path) ? plain(v) : v || '';
    });
    mapHint('g-map-hint', q('g-map').value, 'Paste the Share link from Google or Apple Maps, or a pin.');
    mapHint('g-pmap-hint', q('g-pmap').value, 'Optional.');
    imgHint(q('g-img').value.trim());
    Object.keys(LISTS).forEach(rows);
  }

  // ---- the lists: route stops, schedule times, rules ----
  function rows(name, focus) {
    const L = LISTS[name], ol = q('g-' + name), items = G[name];
    ol.replaceChildren();
    if (!items.length) { const p = document.createElement('li'); p.className = 'ge-empty'; p.textContent = 'None yet.'; ol.appendChild(p); }
    items.forEach((it, i) => {
      const li = document.createElement('li'); li.className = 'ge-row'; li.dataset.i = i;
      const n = document.createElement('span'); n.className = 'n'; n.textContent = String(i + 1).padStart(2, '0'); n.setAttribute('aria-hidden', 'true');
      const f = document.createElement('div'); f.className = 'f';
      let pair = null;
      L.fields.forEach(([k, label, ph, max]) => {
        let input;
        if (k === 'kind') {
          input = document.createElement('select');
          Object.keys(KIND_LABEL).forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = KIND_LABEL[v]; input.appendChild(o); });
          input.value = it.kind || 'DO';
        } else {
          input = document.createElement('input');
          if (k === 'time') input.type = 'time';
          if (max) input.maxLength = max;
          if (ph) input.placeholder = ph;
          input.value = it[k] && k === 'time' && it[k].length === 16 ? it[k].slice(11) : it[k] || '';
        }
        input.dataset.k = k;
        input.setAttribute('aria-label', label + ', ' + L.what + ' ' + (i + 1));
        input.addEventListener(k === 'kind' ? 'change' : 'input', () => { it[k] = input.value; li.classList.remove('err'); touch(); });
        // The time and the kind sit beside the next field.
        if (k === 'time' || k === 'kind') { pair = document.createElement('div'); pair.className = 'f2'; pair.appendChild(input); f.appendChild(pair); }
        else if (pair) { pair.appendChild(input); pair = null; }
        else f.appendChild(input);
      });
      const ctl = document.createElement('div'); ctl.className = 'ctl';
      [['up', '↑', 'Move ' + L.what + ' ' + (i + 1) + ' up', i === 0], ['down', '↓', 'Move ' + L.what + ' ' + (i + 1) + ' down', i === items.length - 1], ['del', '✕', 'Remove ' + L.what + ' ' + (i + 1), false]].forEach(([act, t, label, off]) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'ghost'; b.textContent = t; b.dataset.act = act;
        b.setAttribute('aria-label', label); b.disabled = off;
        b.addEventListener('click', () => move(name, i, act));
        ctl.appendChild(b);
      });
      li.append(n, f, ctl);
      ol.appendChild(li);
    });
    q('g-add-' + name).disabled = items.length >= L.max;
    q('g-add-' + name).textContent = items.length >= L.max ? 'Up to ' + L.max : ({ route: 'Add stop', schedule: 'Add a time', rules: 'Add rule' })[name];
    if (focus) {
      const li = ol.children[focus.i];
      const el = li && (focus.act ? li.querySelector('[data-act="' + focus.act + '"]:not(:disabled)') || li.querySelector('[data-act]:not(:disabled)') : li.querySelector('input, select'));
      (el || q('g-add-' + name)).focus();
    }
  }
  function move(name, i, act) {
    const items = G[name];
    if (act === 'del') { items.splice(i, 1); rows(name, items.length ? { i: Math.min(i, items.length - 1), act: 'del' } : null); if (!items.length) q('g-add-' + name).focus(); }
    else {
      const j = act === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= items.length) return;
      const t = items[i]; items[i] = items[j]; items[j] = t;
      rows(name, { i: j, act });
    }
    touch();
  }
  Object.keys(LISTS).forEach((name) => q('g-add-' + name).addEventListener('click', () => {
    if (G[name].length >= LISTS[name].max) return;
    G[name].push(LISTS[name].blank());
    rows(name, { i: G[name].length - 1 });
    touch();
  }));

  // ---- tabs (phones) ----
  function tab(which) {
    q('gd-cols').dataset.tab = which;
    [['edit', q('gd-tab-edit')], ['preview', q('gd-tab-prev')]].forEach(([w, b]) => { b.setAttribute('aria-selected', String(w === which)); b.tabIndex = w === which ? 0 : -1; });
    if (which === 'preview') preview();
  }
  q('gd-tab-edit').addEventListener('click', () => tab('edit'));
  q('gd-tab-prev').addEventListener('click', () => tab('preview'));
  q('gd-tab-edit').parentNode.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = q('gd-cols').dataset.tab === 'edit' ? 'preview' : 'edit';
    tab(next); (next === 'edit' ? q('gd-tab-edit') : q('gd-tab-prev')).focus();
  });
  // "See it as at": an Antigua time, for checking Now and Next.
  q('gd-at').addEventListener('input', () => {
    const v = q('gd-at').value;
    atTime = v ? Date.parse(v + ':00Z') + 4 * 3600000 : null;
    if (atTime !== null && isNaN(atTime)) atTime = null;
    preview();
  });
  setInterval(() => { if (atTime === null && document.visibilityState === 'visible') preview(); }, 30000);

  // ---- loading and saving ----
  function load(s) {
    S = s; G = copy(s.draft); dirty = false;
    ['route', 'schedule', 'rules'].forEach((k) => { if (!Array.isArray(G[k])) G[k] = []; });
    fill(); stateLine(); preview();
    const n = S.paid, again = !!S.notified_at;
    q('g-notify').checked = !again;
    q('g-notify-l').textContent = (again ? 'Email paid guests again' : "Email paid guests that it's ready") + ' (' + n + ')';
  }
  // A field the server refused: "meet.map", "schedule.3.time", "rules".
  const FIELDS = { 'meet.place': 'g-place', 'meet.date': 'g-date', 'meet.time': 'g-time', 'meet.map': 'g-map', 'meet.how': 'g-how', 'meet.image': 'g-img', 'parking.text': 'g-park', 'parking.map': 'g-pmap', 'parking.image': 'g-pimg' };
  function point(field) {
    if (!field) return;
    if (FIELDS[field]) { const i = q(FIELDS[field]); i.setAttribute('aria-invalid', 'true'); tab('edit'); i.focus(); return; }
    const [name, i, k] = field.split('.');
    const li = q('g-' + name) && q('g-' + name).children[Number(i)];
    if (li) { tab('edit'); li.classList.add('err'); const el = li.querySelector('[data-k="' + k + '"]') || li.querySelector('input'); if (el) el.focus(); }
  }
  async function call(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, d };
  }
  function ask(title, text, ok) {
    return new Promise((resolve) => {
      const dlg = q('gd-dlg');
      q('gd-dlg-h').textContent = title; q('gd-dlg-p').textContent = text; q('gd-dlg-ok').textContent = ok;
      const done = (v) => { dlg.close(); q('gd-dlg-ok').onclick = null; q('gd-dlg-no').onclick = null; dlg.oncancel = null; resolve(v); };
      q('gd-dlg-ok').onclick = () => done(true);
      q('gd-dlg-no').onclick = () => done(false);
      dlg.oncancel = (e) => { e.preventDefault(); done(false); };
      dlg.showModal(); q('gd-dlg-ok').focus();
    });
  }
  async function act(btn, fn) {
    if (busy) return;
    busy = true; btn.disabled = true;
    try { await fn(); } catch (e) { say('Lost connection. Check the status before trying again.'); }
    busy = false; btn.disabled = false;
  }
  q('g-save').addEventListener('click', () => act(q('g-save'), async () => {
    const x = await call('/api/admin/event/guide', { guide: G });
    if (!x.ok) { say(x.d.error || 'Could not save.'); return point(x.d.field); }
    load(x.d); say("Draft saved. Guests don't see it until you publish.", true);
  }));
  q('g-publish').addEventListener('click', () => act(q('g-publish'), async () => {
    if (GUIDE.isEmpty(view())) return say('The guide is empty. Fill in a section first.');
    const notify = q('g-notify').checked, n = S.paid;
    const text = 'Paid guests (' + n + ') see it in their account straight away.' + (notify ? " They also get a short email that it's ready, with no details in it." : ' No email goes out.');
    if (!(await ask(S.published_at ? 'Publish your changes?' : 'Publish the guide?', text, notify && n ? 'Publish and email' : 'Publish'))) return;
    say('Publishing…', true);
    const x = await call('/api/admin/event/guide/publish', { guide: G, notify });
    if (!x.ok) { say(x.d.error || 'Could not publish.'); return point(x.d.field); }
    if (x.d.error_notify) { say(x.d.error_notify); return; }
    load(x.d);
    const m = x.d.notified;
    say(!m ? 'Published. No email sent.' : !m.recipients ? 'Published. No paid guests to email yet.' : 'Published. Emailed ' + m.sent + ' of ' + m.recipients + (m.failed ? '; ' + m.failed + ' failed (check the server log).' : '.'), !(m && m.failed));
    if (typeof loadLog === 'function') loadLog();
  }));
  q('g-unpub').addEventListener('click', () => act(q('g-unpub'), async () => {
    if (!(await ask('Unpublish the guide?', "Paid guests stop seeing it, and phones drop their saved copy the next time they're online. Your draft stays here.", 'Unpublish'))) return;
    const x = await call('/api/admin/event/guide/unpublish', {});
    if (!x.ok) return say(x.d.error || 'Could not unpublish.');
    load(x.d); say('Unpublished. Guests no longer see the guide.', true);
  }));
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  fetch('/api/admin/event/guide', { cache: 'no-store' }).then((r) => r.json().then((d) => ({ ok: r.ok, d }))).then((x) => {
    if (!x.ok) { q('gd-state').textContent = x.d.error || 'Could not load the guide.'; return; }
    load(x.d);
    if (location.hash === '#guide') q('guide').scrollIntoView();
  }).catch(() => { q('gd-state').textContent = 'Could not load the guide.'; });
})();
`;
  return { css, html, js };
}
