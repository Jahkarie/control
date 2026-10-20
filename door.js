// door.js: door check-in for event night.
// Staff open /door on their phones and sign in with DOOR_KEY (the admin key also works).
// Each phone keeps a copy of the guest list, so scanning still works with no signal;
// check-ins made offline sync to the server as soon as the phone is back online.
// The same scanner has a Pickup mode for handing out packages: a scan marks the package collected
// (once per order) and shows the guest's size. Pickup can also be marked from /admin/pickup (pickup.js).
// Pickup mode also searches guests by name (as on their ID), and a package found that way goes through a Check ID
// screen before it's handed over. On a laptop (900px+) Pickup mode turns into a desk: search and list beside the camera.
// Names are only shown in Pickup mode, and never saved in the recent-scans list.
// Only the current event's passes work (see events.js): the list holds just those, and a pass from a past event scans
// as OTHER_EVENT ("This pass is for <event>"), with nothing recorded.
import { CUR } from './events.js';

export function registerDoor({ app, pool, express, ADMIN_KEY, safeEqual, rateLimit, requireAdmin }) {
  const DOOR_KEY = process.env.DOOR_KEY || '';
  const json = express.json({ limit: '256kb' });
  const limit = rateLimit(600, 60 * 1000);

  // Wrong passwords are counted per IP so the key can't be guessed by brute force.
  const fails = new Map();
  setInterval(() => fails.clear(), 15 * 60 * 1000).unref();
  const requireDoor = (req, res, next) => {
    if ((fails.get(req.ip) || 0) >= 20) return res.status(429).json({ error: 'Too many wrong passwords. Try again in 15 minutes.' });
    const key = req.get('x-door-key') || '';
    if (key && (safeEqual(key, ADMIN_KEY) || (DOOR_KEY && safeEqual(key, DOOR_KEY)))) return next();
    fails.set(req.ip, (fails.get(req.ip) || 0) + 1);
    res.status(401).json({ error: 'Wrong staff password.' });
  };

  // sized: the package has sizes, so an order without one shows "No size picked" at pickup.
  // full_name is the guest's name as on their ID, for the Pickup desk's name search and Check ID screen (Entry never
  // shows it). Cancelled orders don't carry it, so door phones only hold names of guests who still have a pass.
  // The guest join is on a lowercased email, one row per email, so a pass is never listed twice.
  const PASS_SQL = `SELECT o.id, o.reference_code AS ref, LOWER(o.guest_email) AS email, o.status, o.event_id,
      o.checked_in_at, o.checked_in_by, (o.cancel_requested_at IS NOT NULL) AS refund_requested,
      o.size, o.picked_up_at, o.picked_up_by,
      p.name AS package, p.requires_compliance AS costume, (TRIM(REPLACE(p.sizes, ',', '')) <> '') AS sized,
      CASE WHEN o.status <> 'CANCELLED' THEN NULLIF(TRIM(g.full_name), '') END AS full_name
    FROM orders o JOIN packages p ON p.id = o.package_id
    LEFT JOIN (SELECT DISTINCT ON (LOWER(email)) LOWER(email) AS email, full_name FROM guests ORDER BY LOWER(email), id) g
      ON g.email = LOWER(o.guest_email)`;
  // A pass re-read after the first lookup: one that was cancelled meanwhile drops the name, as PASS_SQL would.
  const restate = (pass, now) => ({ ...pass, ...now, ...(now && now.status === 'CANCELLED' ? { full_name: null } : {}) });

  // A phone's clock can be off; never accept a scan time more than a few minutes in the future.
  const scanTime = (v) => {
    const d = new Date(v);
    if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 5 * 60 * 1000) return new Date();
    return d;
  };
  const KINDS = ['ENTRY', 'OVERRIDE', 'UNDO', 'PICKUP', 'PICKUP_UNDO'];
  const REPLAY = { ENTRY: 'ADMIT', OVERRIDE: 'ADMIT', UNDO: 'UNDONE', DUPLICATE: 'ALREADY',
    PICKUP: 'HANDED', PICKUP_DUP: 'PICKED_ALREADY', PICKUP_UNDO: 'PICKUP_UNDONE' };

  const record = (orderId, kind, clientId, device, at) => pool.query(
    `INSERT INTO checkins (order_id, kind, client_id, device, scanned_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (client_id) DO NOTHING`, [orderId, kind, clientId, device, at]);

  // Applies one scan. Safe to repeat: a scan with the same client_id is only ever counted once,
  // so a phone can resend its offline queue without double counting.
  async function applyScan(ev) {
    const kind = KINDS.includes(ev?.kind) ? ev.kind : 'ENTRY';
    const ref = String(ev?.ref || '').trim().toUpperCase().slice(0, 32);
    const email = String(ev?.email || '').trim().toLowerCase();
    const clientId = ev?.client_id ? String(ev.client_id).slice(0, 64) : null;
    const device = String(ev?.device || '').trim().slice(0, 40) || 'Door';
    const at = scanTime(ev?.scanned_at);
    if (!ref) return { result: 'NOT_FOUND' };

    const found = await pool.query(`${PASS_SQL} WHERE o.reference_code = $1`, [ref]);
    if (!found.rowCount) return { result: 'NOT_FOUND' };
    const pass = found.rows[0];
    // A pass from another event: not valid here, and nothing about it (not even the email) goes back to the phone.
    const evs = (await pool.query(`SELECT id, name, status FROM events WHERE id = $1 OR status = 'current'`, [pass.event_id])).rows;
    if (!evs.some((e) => e.status === 'current' && e.id === pass.event_id)) {
      const theirs = evs.find((e) => e.id === pass.event_id);
      return { result: 'OTHER_EVENT', event_name: theirs ? theirs.name : null };
    }
    if (email && email !== pass.email) return { result: 'MISMATCH', pass };

    if (clientId) {
      const seen = await pool.query('SELECT kind FROM checkins WHERE client_id = $1', [clientId]);
      if (seen.rowCount) return { result: REPLAY[seen.rows[0].kind] || 'ADMIT', override: seen.rows[0].kind === 'OVERRIDE', pass, replay: true };
    }

    if (kind === 'UNDO') {
      await pool.query('UPDATE orders SET checked_in_at = NULL, checked_in_by = NULL WHERE id = $1', [pass.id]);
      await record(pass.id, 'UNDO', clientId, device, at);
      return { result: 'UNDONE', pass: { ...pass, checked_in_at: null, checked_in_by: null } };
    }
    if (kind === 'PICKUP_UNDO') {
      await pool.query('UPDATE orders SET picked_up_at = NULL, picked_up_by = NULL WHERE id = $1', [pass.id]);
      await record(pass.id, 'PICKUP_UNDO', clientId, device, at);
      return { result: 'PICKUP_UNDONE', pass: { ...pass, picked_up_at: null, picked_up_by: null } };
    }
    if (pass.status === 'RESERVED') return { result: 'UNPAID', pass };
    if (pass.status !== 'PAID') return { result: 'CANCELLED', pass };
    if (kind === 'PICKUP') {
      // One package per order, even if two phones scan the same pass at the same moment. Still PAID when it's
      // saved, so an order refunded since the read above isn't handed out.
      const got = await pool.query(
        `UPDATE orders SET picked_up_at = $2, picked_up_by = $3 WHERE id = $1 AND picked_up_at IS NULL AND status = 'PAID'
         RETURNING picked_up_at, picked_up_by`, [pass.id, at, device]);
      if (got.rowCount) {
        await record(pass.id, 'PICKUP', clientId, device, at);
        return { result: 'HANDED', pass: { ...pass, ...got.rows[0] } };
      }
      // Cancelled meanwhile, or already handed out (maybe a moment ago by another phone, so read who and when again).
      // A repeat is logged as blocked.
      const now = (await pool.query('SELECT status, picked_up_at, picked_up_by FROM orders WHERE id = $1', [pass.id])).rows[0];
      if (!now || now.status !== 'PAID') return { result: 'CANCELLED', pass: restate(pass, now) };
      await record(pass.id, 'PICKUP_DUP', clientId, device, at);
      return { result: 'PICKED_ALREADY', pass: restate(pass, now) };
    }
    if (kind === 'OVERRIDE') {
      await record(pass.id, 'OVERRIDE', clientId, device, at);
      return { result: 'ADMIT', override: true, pass };
    }

    // Only one phone can win the first check-in, even if two scan at the same moment (and only while still PAID).
    const won = await pool.query(
      `UPDATE orders SET checked_in_at = $2, checked_in_by = $3 WHERE id = $1 AND checked_in_at IS NULL AND status = 'PAID'
       RETURNING checked_in_at, checked_in_by`, [pass.id, at, device]);
    if (won.rowCount) {
      await record(pass.id, 'ENTRY', clientId, device, at);
      return { result: 'ADMIT', pass: { ...pass, ...won.rows[0] } };
    }
    const cur = (await pool.query('SELECT status FROM orders WHERE id = $1', [pass.id])).rows[0];
    if (!cur || cur.status !== 'PAID') return { result: 'CANCELLED', pass: restate(pass, cur) };
    // A second scan of a pass that's already in. Logged so the admin can see attempted reuse.
    await record(pass.id, 'DUPLICATE', clientId, device, at);
    return { result: 'ALREADY', pass };
  }

  const fail = (res, err) => { console.error('Door error:', err); res.status(500).json({ error: 'Server error.' }); };

  app.get('/door', (req, res) => res.type('html').set('Cache-Control', 'no-cache').send(PAGE));
  app.get('/door-sw.js', (req, res) => res.type('application/javascript').set('Cache-Control', 'no-cache').send(SW));

  // The whole list, saved on each phone for offline scanning.
  app.get('/api/door/list', limit, requireDoor, async (req, res) => {
    try {
      const [r, ev] = await Promise.all([pool.query(`${PASS_SQL} WHERE o.event_id = ${CUR} ORDER BY o.id ASC`),
        pool.query("SELECT id, name FROM events WHERE status = 'current'")]);
      res.json({ generated_at: new Date().toISOString(), event: ev.rows[0] || null, passes: r.rows });
    } catch (err) { fail(res, err); }
  });

  app.post('/api/door/checkin', limit, requireDoor, json, async (req, res) => {
    try { res.json(await applyScan(req.body)); } catch (err) { fail(res, err); }
  });

  // Check-ins a phone made while offline, in the order they happened.
  app.post('/api/door/sync', limit, requireDoor, json, async (req, res) => {
    const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 200) : [];
    const results = [];
    for (const ev of events) {
      try { results.push({ client_id: ev?.client_id || null, ...(await applyScan(ev)) }); }
      catch (err) { console.error('Door sync error:', err); results.push({ client_id: ev?.client_id || null, result: 'ERROR' }); }
    }
    res.json({ results });
  });

  // Door log for the Command Center: the current event's (?event=<id> for another one, ?event=all for every event).
  app.get('/api/admin/checkins', requireAdmin, async (req, res) => {
    const all = req.query.event === 'all';
    const id = /^\d{1,9}$/.test(String(req.query.event || '')) ? Number(req.query.event) : null;
    try {
      const r = await pool.query(
        `SELECT c.id, c.kind, c.device, c.scanned_at, c.synced_at, o.reference_code AS ref, o.guest_email AS email, p.name AS package, o.event_id
         FROM checkins c JOIN orders o ON o.id = c.order_id JOIN packages p ON p.id = o.package_id
         ${all ? '' : id ? 'WHERE o.event_id = $1' : `WHERE o.event_id = ${CUR}`}
         ORDER BY c.scanned_at DESC, c.id DESC ${all ? '' : 'LIMIT 500'}`, id && !all ? [id] : []);
      res.json(r.rows);
    } catch (err) { fail(res, err); }
  });
}

// ---------- Service worker: keeps the scanner page and QR reader available offline ----------
const SW = `const CACHE = 'odr-door-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const page = url.origin === self.location.origin && url.pathname === '/door';
  const lib = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname);
  if (!page && !lib) return;
  e.respondWith(fetch(req).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
    return res;
  }).catch(() => caches.match(req).then((hit) => hit || Response.error())));
});
`;

// ---------- Scanner page ----------
const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0a0a0b">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="ODR Door">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Door | On D' Road</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js" defer></script>
<style>
/* Night Kinetic, door edition: matte charcoal, one sharp accent (safety orange), sharp corners and hairline rules,
   heavy expanded "ON D'" over a thin "ROAD", Space Mono for bracket tags and codes. Entry is orange, Pickup is cyan.
   Results stay flat, full-screen colour so they read at a glance in a dark street: green = in / hand over, red = stop,
   yellow = not paid. Check ID is a concrete card in an orange frame: stop and check. */
/* If the web fonts never load, headlines fall back to a local bold font. */
@font-face { font-family: 'Display Wide'; font-weight: 100 900; src: local('Arial Bold'), local('Arial-BoldMT'), local('Helvetica Neue Bold'), local('HelveticaNeue-Bold'), local('Roboto Bold'), local('Roboto-Bold'), local('Liberation Sans Bold'), local('LiberationSans-Bold'), local('DejaVu Sans Bold'), local('DejaVuSans-Bold'); }
:root {
  --black: #0a0a0b; --char: #141416; --char-2: #1a1a1d; --char-3: #232327; --well: rgba(10, 10, 11, .6);
  --line: rgba(236, 235, 230, .12); --line-2: rgba(236, 235, 230, .26);
  --text: #ecebe6; --muted: #a6a59f; --dim: #86857f;
  --ink: #141416; --ink-2: #47463f; --ink-line: rgba(20, 20, 22, .22); --concrete: #c9c8c3; --concrete-2: #e4e3df; --paper: #f4f3ef;
  --orange: #ff5a1f; --cyan: #22e1ff; --acid: #b6ff3b; --purple: #8b3dff;
  --accent: var(--orange);
  /* Result fills, each its own hue: --go is the acid green pushed toward green, so ADMIT never reads as the yellow
     warning; --stop leans crimson, so it never reads as the orange accent. */
  --go: #6dff45; --stop: #ff3346; --caution: #ffd60a;
  /* The same three as small text on charcoal */
  --good: var(--acid); --warn: var(--caution); --bad: #ff7a6b;
  --wide: 'Archivo', 'Display Wide', system-ui, sans-serif;
  --body: 'Archivo', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --mono: 'Space Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --ease: cubic-bezier(.2, .8, .2, 1);
  --matte: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='g' x='0' y='0' width='1' height='1'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' seed='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 .16 0 0 0 -.055'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23g)'/%3E%3C/svg%3E");
  --concrete-tex: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='640'%3E%3Cfilter id='b' x='0' y='0' width='1' height='1'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.0094' numOctaves='3' seed='4' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .1 0 0 0 0 .1 0 0 0 0 .1 .6 0 0 0 -.27'/%3E%3C/filter%3E%3Cfilter id='s' x='0' y='0' width='1' height='1'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.75' numOctaves='2' seed='9' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .08 0 0 0 0 .08 0 0 0 0 .08 1.6 0 0 0 -1.12'/%3E%3C/filter%3E%3Crect width='640' height='640' filter='url(%23b)'/%3E%3Crect width='640' height='640' filter='url(%23s)'/%3E%3C/svg%3E");
  --streak-ink: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='900' height='320' viewBox='0 0 900 320' fill='none' stroke='%23141416'%3E%3Cdefs%3E%3ClinearGradient id='f' x1='0' x2='1'%3E%3Cstop offset='0' stop-color='%23141416' stop-opacity='0'/%3E%3Cstop offset='1' stop-color='%23141416'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M20 250L560 125.3' stroke-opacity='.38'/%3E%3Cpath d='M180 214L520 135.5' stroke='url(%23f)' stroke-width='4' stroke-opacity='.7'/%3E%3Cpath d='M0 180L380 92.3' stroke-width='8' stroke-dasharray='1 2.2' stroke-opacity='.3'/%3E%3Cpath d='M470 300L860 210' stroke='url(%23f)' stroke-width='2' stroke-opacity='.5'/%3E%3Cpath d='M600 150L700 126.9' stroke-width='7' stroke-opacity='.45'/%3E%3Cpath d='M520 60L900 -27.7' stroke-opacity='.28'/%3E%3Cpath d='M60 300L240 258.4' stroke-width='3' stroke-opacity='.4'/%3E%3Cg fill='%23141416' stroke='none' fill-opacity='.45'%3E%3Crect x='724' y='168' width='6' height='6'/%3E%3Crect x='738' y='160' width='4' height='4'/%3E%3Crect x='748' y='174' width='9' height='4'/%3E%3Crect x='104' y='118' width='5' height='5'/%3E%3Crect x='118' y='112' width='3' height='3'/%3E%3C/g%3E%3C/svg%3E");
  --streak-lite: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='900' height='320' viewBox='0 0 900 320' fill='none' stroke='%23ecebe6'%3E%3Cdefs%3E%3ClinearGradient id='c' x1='0' x2='1'%3E%3Cstop offset='0' stop-color='%2322e1ff' stop-opacity='0'/%3E%3Cstop offset='.85' stop-color='%2322e1ff'/%3E%3Cstop offset='1' stop-color='%23d9fbff'/%3E%3C/linearGradient%3E%3ClinearGradient id='g' x1='0' x2='1'%3E%3Cstop offset='0' stop-color='%23b6ff3b' stop-opacity='0'/%3E%3Cstop offset='.6' stop-color='%23b6ff3b'/%3E%3Cstop offset='1' stop-color='%2322e1ff'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M20 250L560 125.3' stroke-opacity='.16'/%3E%3Cpath d='M180 214L520 135.5' stroke='url(%23c)' stroke-width='3' stroke-opacity='.75'/%3E%3Cpath d='M0 180L380 92.3' stroke-width='8' stroke-dasharray='1 2.2' stroke-opacity='.16'/%3E%3Cpath d='M470 300L860 210' stroke='url(%23g)' stroke-width='3' stroke-opacity='.6'/%3E%3Cpath d='M600 150L700 126.9' stroke='%238b3dff' stroke-width='7' stroke-opacity='.75'/%3E%3Cpath d='M520 60L900 -27.7' stroke-opacity='.1'/%3E%3Cpath d='M60 300L240 258.4' stroke='%238b3dff' stroke-width='5' stroke-opacity='.5'/%3E%3Cg fill='%23ecebe6' stroke='none' fill-opacity='.35'%3E%3Crect x='724' y='168' width='5' height='5'/%3E%3Crect x='738' y='160' width='3' height='3'/%3E%3Crect x='104' y='118' width='4' height='4'/%3E%3C/g%3E%3C/svg%3E");
  --xh-ink: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28' fill='none' stroke='%23141416' stroke-opacity='0.6' stroke-width='1'%3E%3Ccircle cx='14' cy='14' r='6.5'/%3E%3Cpath d='M14 0v28M0 14h28'/%3E%3C/svg%3E");
  --xh-lite: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28' fill='none' stroke='%23ecebe6' stroke-opacity='0.32' stroke-width='1'%3E%3Ccircle cx='14' cy='14' r='6.5'/%3E%3Cpath d='M14 0v28M0 14h28'/%3E%3C/svg%3E");
  --circ-ink-tr: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='340' height='230' viewBox='0 0 340 230' fill='none' stroke='%23141416' stroke-opacity='0.3' stroke-width='1'%3E%3Cpath d='M340 30H252l-16 16h-62'/%3E%3Cpath d='M340 46H260l-16 16v38l-14 14h-30'/%3E%3Cpath d='M340 62h-62l-12 12v74'/%3E%3Cpath d='M340 100h-30l-12 12v66l-14 14h-44'/%3E%3Cpath d='M340 164h-10v66'/%3E%3Cpath d='M212 0v12l-14 14h-50'/%3E%3Cpath d='M284 0v8l-8 8h-28'/%3E%3Cpath d='M302 0v18l12 12'/%3E%3Cpath d='M340 196h-28l-10 10v24'/%3E%3Ccircle cx='170' cy='46' r='3.2'/%3E%3Ccircle cx='196' cy='114' r='3.2'/%3E%3Ccircle cx='266' cy='152' r='3.2'/%3E%3Ccircle cx='236' cy='192' r='3.2'/%3E%3Ccircle cx='144' cy='26' r='3.2'/%3E%3Ccircle cx='244' cy='16' r='2.6'/%3E%3Ccircle cx='302' cy='230' r='2.6'/%3E%3Crect x='210' y='124' width='36' height='24'/%3E%3Cpath d='M216 124v-6M224 124v-6M232 124v-6M240 124v-6M216 148v6M224 148v6M232 148v6M240 148v6'/%3E%3C/svg%3E");
  --circ-lite-tr: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='340' height='230' viewBox='0 0 340 230' fill='none' stroke='%23ecebe6' stroke-opacity='0.1' stroke-width='1'%3E%3Cpath d='M340 30H252l-16 16h-62'/%3E%3Cpath d='M340 46H260l-16 16v38l-14 14h-30'/%3E%3Cpath d='M340 62h-62l-12 12v74'/%3E%3Cpath d='M340 100h-30l-12 12v66l-14 14h-44'/%3E%3Cpath d='M340 164h-10v66'/%3E%3Cpath d='M212 0v12l-14 14h-50'/%3E%3Cpath d='M284 0v8l-8 8h-28'/%3E%3Cpath d='M302 0v18l12 12'/%3E%3Cpath d='M340 196h-28l-10 10v24'/%3E%3Ccircle cx='170' cy='46' r='3.2'/%3E%3Ccircle cx='196' cy='114' r='3.2'/%3E%3Ccircle cx='266' cy='152' r='3.2'/%3E%3Ccircle cx='236' cy='192' r='3.2'/%3E%3Ccircle cx='144' cy='26' r='3.2'/%3E%3Ccircle cx='244' cy='16' r='2.6'/%3E%3Ccircle cx='302' cy='230' r='2.6'/%3E%3Crect x='210' y='124' width='36' height='24'/%3E%3Cpath d='M216 124v-6M224 124v-6M232 124v-6M240 124v-6M216 148v6M224 148v6M232 148v6M240 148v6'/%3E%3C/svg%3E");
  --circ-lite-bl: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='340' height='230' viewBox='0 0 340 230' fill='none' stroke='%23ecebe6' stroke-opacity='0.1' stroke-width='1'%3E%3Cg transform='translate(340 230) scale(-1 -1)'%3E%3Cpath d='M340 30H252l-16 16h-62'/%3E%3Cpath d='M340 46H260l-16 16v38l-14 14h-30'/%3E%3Cpath d='M340 62h-62l-12 12v74'/%3E%3Cpath d='M340 100h-30l-12 12v66l-14 14h-44'/%3E%3Cpath d='M340 164h-10v66'/%3E%3Cpath d='M212 0v12l-14 14h-50'/%3E%3Cpath d='M284 0v8l-8 8h-28'/%3E%3Cpath d='M302 0v18l12 12'/%3E%3Cpath d='M340 196h-28l-10 10v24'/%3E%3Ccircle cx='170' cy='46' r='3.2'/%3E%3Ccircle cx='196' cy='114' r='3.2'/%3E%3Ccircle cx='266' cy='152' r='3.2'/%3E%3Ccircle cx='236' cy='192' r='3.2'/%3E%3Ccircle cx='144' cy='26' r='3.2'/%3E%3Ccircle cx='244' cy='16' r='2.6'/%3E%3Ccircle cx='302' cy='230' r='2.6'/%3E%3Crect x='210' y='124' width='36' height='24'/%3E%3Cpath d='M216 124v-6M224 124v-6M232 124v-6M240 124v-6M216 148v6M224 148v6M232 148v6M240 148v6'/%3E%3C/g%3E%3C/svg%3E");
  /* Entry is orange, Pickup is cyan: the switch, the count, the camera border and its frame all follow. */
  --mode: var(--orange);
  color-scheme: dark;
}
body.pickup { --mode: var(--cyan); }
*, *::before, *::after { box-sizing: border-box; }
* { -webkit-tap-highlight-color: transparent; }
html, body { height: 100%; }
body { margin: 0; background: var(--char) var(--matte); color: var(--text); font: 400 15px/1.5 var(--body); font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; overscroll-behavior: none; overflow-x: hidden; }
::selection { background: var(--orange); color: var(--ink); }
.hidden { display: none !important; }
:focus-visible { outline: 2px solid var(--mode); outline-offset: 3px; }
.wrap { position: relative; max-width: 520px; margin: 0 auto; padding: max(16px, env(safe-area-inset-top)) 16px max(28px, env(safe-area-inset-bottom)); }

/* Wordmark: heavy expanded ON D' (orange apostrophe) and a thin ROAD; the phone's name is a bracket tag under it. */
.brand { font-family: var(--wide); font-stretch: 125%; font-size: 17px; line-height: 1.1; letter-spacing: .02em; text-transform: uppercase; white-space: nowrap; }
.brand b { font-weight: 900; }
.brand i { font-style: normal; font-weight: 200; }
.brand span { color: var(--orange); }
.brand em {
  display: block; width: fit-content; max-width: 100%; overflow: hidden; text-overflow: ellipsis; margin-top: 7px;
  font: 400 11px/1.3 var(--mono); font-stretch: 100%; letter-spacing: .14em; text-transform: uppercase; color: var(--mode);
}
.brand em::before { content: '[ '; content: '[ ' / ''; color: var(--muted); }
.brand em::after { content: ' ]'; content: ' ]' / ''; color: var(--muted); }
/* Eyebrow: a mono label with a hairline running off to the right */
.eb, h2 { display: flex; align-items: center; gap: 12px; font: 400 12px/1.2 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
.eb::after, h2::after { content: ''; flex: 1; min-width: 24px; height: 1px; background: var(--line); }

input { width: 100%; min-height: 52px; font: 400 16px/1.4 var(--body); color: var(--text); background: var(--well); border: 1px solid var(--line-2); border-radius: 0; padding: 13px 14px; -webkit-appearance: none; appearance: none; transition: border-color .2s, background .2s; }
input::placeholder { color: var(--dim); }
input:hover { border-color: rgba(236, 235, 230, .45); }
input:focus { outline: 2px solid var(--mode); outline-offset: 0; border-color: transparent; }

/* Buttons: sharp, flat orange with an arrow; ghosts are a hairline box. */
.btn {
  --b: var(--orange); display: inline-flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 54px; padding: 0 18px; cursor: pointer;
  font: 700 15px/1 var(--wide); font-stretch: 112%; letter-spacing: .05em; text-transform: uppercase; text-align: left;
  color: var(--ink); background: var(--b); border: 1px solid var(--b); border-radius: 0; transition: background .2s, border-color .2s, color .2s, filter .2s, transform .15s var(--ease);
}
.btn::after { content: '→'; content: '→' / ''; flex: none; font: 400 18px/1 var(--mono); transition: transform .25s var(--ease); }
.btn:active { transform: translateY(1px); }
.btn:disabled { opacity: .5; cursor: default; }
.btn.ghost { --b: transparent; justify-content: center; color: var(--text); border-color: var(--line-2); }
.btn.ghost::after { content: none; }
.btn.small { min-height: 40px; padding: 0 14px; font-size: 12px; letter-spacing: .08em; }
@media (hover: hover) {
  .btn:not(.ghost):hover { filter: brightness(1.1); }
  .btn:hover::after { transform: translateX(4px); }
  .btn.ghost:hover { border-color: var(--text); background: rgba(236, 235, 230, .05); }
}

/* ---------- Sign in ---------- */
/* Full width (so the streaks can run edge to edge, clipped here), with the content in a centred column */
.signin {
  max-width: none; min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; isolation: isolate; overflow: clip;
  background: var(--xh-lite) no-repeat 16px 16px / 24px, var(--xh-lite) no-repeat right 16px bottom 16px / 24px, var(--circ-lite-tr) no-repeat right top / 340px auto;
}
.signin > * { width: 100%; max-width: 488px; }
/* Speed streaks on the -13deg diagonal, in a band behind the wordmark and heading only, fading out above and below
   so they never run behind the small text */
.sig-head { position: relative; isolation: isolate; }
.kin {
  position: absolute; z-index: -1; top: -56px; bottom: -6px; left: calc(50% - 50vw); width: 100vw; overflow: hidden; pointer-events: none;
  -webkit-mask-image: linear-gradient(transparent, #000 24%, #000 76%, transparent); mask-image: linear-gradient(transparent, #000 24%, #000 76%, transparent);
}
.kin-field { position: absolute; inset: -60% -8%; transform: rotate(-13deg); }
.sk { position: absolute; display: block; left: var(--x); top: var(--y); width: var(--w); height: var(--h, 1px); opacity: var(--o, 1); animation: zip 1.15s var(--ease) both; animation-delay: calc(var(--d, 0) * 1ms + 120ms); }
.sk.c { background: linear-gradient(90deg, rgba(34, 225, 255, 0), rgba(34, 225, 255, .25) 35%, var(--cyan) 88%, #d9fbff); box-shadow: 0 0 14px 1px rgba(34, 225, 255, .45); }
.sk.g { background: linear-gradient(90deg, rgba(182, 255, 59, 0), var(--acid) 45%, #7ff0c8 72%, var(--cyan)); box-shadow: 0 0 16px 1px rgba(160, 255, 120, .35); }
.sk.p { background: var(--purple); box-shadow: 0 0 12px rgba(139, 61, 255, .55); }
.sk.w { background: linear-gradient(90deg, rgba(236, 235, 230, 0), rgba(236, 235, 230, .55)); }
.sk.n { background: repeating-linear-gradient(90deg, rgba(214, 213, 207, .5) 0 1px, rgba(214, 213, 207, 0) 1px 3px), linear-gradient(90deg, rgba(214, 213, 207, 0), rgba(214, 213, 207, .18) 40%, rgba(214, 213, 207, .08)); }
@keyframes zip { from { transform: translateX(-38%) scaleX(.4); opacity: 0; } 35% { opacity: var(--o, 1); } to { transform: none; opacity: var(--o, 1); } }
.signin .eb { margin: 40px 0 16px; }
.signin h1 { margin: 0 0 18px; font-family: var(--wide); font-stretch: 125%; font-size: clamp(42px, 13vw, 68px); line-height: .92; letter-spacing: -.015em; text-transform: uppercase; color: var(--text); }
.signin h1 b { font-weight: 900; }
.signin h1 i { font-style: normal; font-weight: 200; letter-spacing: .01em; }
.signin p.lead { color: var(--muted); font-size: 16px; line-height: 1.5; margin: 0 0 26px; }
/* The form is a concrete utility panel: crosshairs in the corners, circuit traces, ink type. */
.signin form {
  position: relative; padding: 34px 20px 22px; color: var(--ink);
  background: var(--xh-ink) no-repeat 8px 8px / 20px, var(--xh-ink) no-repeat right 8px bottom 8px / 20px, var(--circ-ink-tr) no-repeat right top / 280px auto, var(--concrete) var(--concrete-tex);
}
.signin label { display: block; font: 400 12px/1.2 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--ink-2); margin: 20px 0 8px; }
.signin label:first-child { margin-top: 0; }
.signin form input { color: var(--ink); background: rgba(244, 243, 239, .94); border-color: rgba(20, 20, 22, .42); }
.signin form input::placeholder { color: #6b6a64; }
.signin form input:hover { border-color: var(--ink); }
.signin form input:focus { outline: 2px solid var(--ink); border-color: var(--ink); background: var(--paper); }
.signin form :focus-visible { outline-color: var(--ink); }
.signin .btn { width: 100%; margin-top: 26px; box-shadow: 0 0 0 1px var(--ink); }
.msg { min-height: 22px; margin: 14px 0 0; font-size: 14.5px; font-weight: 600; color: #a3140c; }
.sig-data { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 16px; margin-top: 26px; padding-top: 14px; border-top: 1px solid var(--line); font: 400 11px/1.2 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--dim); }

/* ---------- Main ---------- */
.bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; padding: 4px 0 14px; border-bottom: 1px solid var(--line); }
.bar .brand { flex: 1 1 auto; min-width: 0; overflow: hidden; }
.net { flex: none; display: inline-flex; align-items: center; gap: 8px; min-height: 30px; padding: 0 10px; border: 1px solid currentColor; font: 700 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; white-space: nowrap; }
.net i { width: 7px; height: 7px; background: currentColor; }
.net.ok { color: var(--good); border-color: rgba(182, 255, 59, .45); }
.net.warn { color: var(--warn); }
/* Offline is a solid yellow block with a blinking square, hard to miss */
.net.off { color: var(--ink); background: var(--warn); border-color: var(--warn); }
.net.off i { animation: blink 1.2s steps(2, start) infinite; }
@keyframes blink { to { visibility: hidden; } }

/* Count: the big number, an orange (or cyan) slash, and what it counts */
.count { display: flex; align-items: center; gap: 14px; margin: 4px 0 20px; font: 400 12px/1.4 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
.count b#in-count { order: 0; font-family: var(--wide); font-stretch: 125%; font-weight: 900; font-size: 58px; line-height: .9; letter-spacing: -.02em; color: var(--text); }
.count::before { content: ''; order: 1; flex: none; width: 3px; height: 52px; margin: 0 4px; background: var(--mode); transform: rotate(24deg); box-shadow: 0 0 12px var(--mode); }
.count > span { order: 2; }
.count span b { color: var(--text); font-weight: 700; }

/* Entry / Pickup switch: two hairline cells; the chosen one fills with its mode colour. */
.mode { display: grid; grid-template-columns: 1fr 1fr; margin: 0 0 18px; border: 1px solid var(--line-2); background: var(--well); }
.mode label { position: relative; display: block; cursor: pointer; }
.mode label + label { border-left: 1px solid var(--line-2); }
.mode input { position: absolute; inset: 0; width: 100%; height: 100%; min-height: 0; margin: 0; padding: 0; border: 0; opacity: 0; cursor: pointer; }
.mode span {
  display: flex; align-items: center; justify-content: center; gap: 10px; min-height: 54px; padding: 0 10px;
  font: 700 15px/1 var(--wide); font-stretch: 118%; letter-spacing: .06em; text-transform: uppercase;
  color: var(--muted); transition: background .15s, color .15s;
}
.mode span::before { content: ''; flex: none; width: 8px; height: 8px; border: 1px solid currentColor; }
.mode input:checked + span { background: var(--mode); color: var(--ink); }
.mode input:checked + span::before { background: var(--ink); }
.mode input:focus-visible + span { outline: 2px solid var(--text); outline-offset: -6px; }
@media (hover: hover) { .mode input:not(:checked):hover + span { color: var(--text); background: rgba(236, 235, 230, .04); } }

.cam { position: relative; aspect-ratio: 1; overflow: hidden; background: var(--black); border: 1px solid var(--mode); }
/* The mode, as a tag in the camera's corner, so it shows even with the video running */
.cam::after { content: '[ Entry ]'; content: '[ Entry ]' / ''; position: absolute; z-index: 2; left: 12px; top: 12px; font: 700 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--mode); text-shadow: 0 1px 6px rgba(0, 0, 0, .9); pointer-events: none; }
body.pickup .cam::after { content: '[ Pickup ]'; content: '[ Pickup ]' / ''; }
.cam video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .3s; }
.cam.on video { opacity: 1; }
.frame { position: absolute; inset: 17%; pointer-events: none; opacity: 0; transition: opacity .3s;
  background:
    linear-gradient(var(--mode), var(--mode)) top left / 34px 3px no-repeat,
    linear-gradient(var(--mode), var(--mode)) top left / 3px 34px no-repeat,
    linear-gradient(var(--mode), var(--mode)) top right / 34px 3px no-repeat,
    linear-gradient(var(--mode), var(--mode)) top right / 3px 34px no-repeat,
    linear-gradient(var(--mode), var(--mode)) bottom left / 34px 3px no-repeat,
    linear-gradient(var(--mode), var(--mode)) bottom left / 3px 34px no-repeat,
    linear-gradient(var(--mode), var(--mode)) bottom right / 34px 3px no-repeat,
    linear-gradient(var(--mode), var(--mode)) bottom right / 3px 34px no-repeat; }
.cam.on .frame { opacity: 1; }
.frame::after { content: ''; position: absolute; left: 6%; right: 6%; top: 50%; height: 2px; background: var(--mode); box-shadow: 0 0 14px var(--mode); opacity: .85; animation: sweep 2.4s ease-in-out infinite; }
@keyframes sweep { 0%, 100% { top: 12%; } 50% { top: 88%; } }
.cam-idle {
  position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; padding: 24px; text-align: center;
  background: var(--xh-lite) no-repeat 12px calc(100% - 12px) / 22px, var(--xh-lite) no-repeat right 12px bottom 12px / 22px, var(--circ-lite-tr) no-repeat right top / 250px auto, var(--streak-lite) center 18% / 760px auto repeat-x;
}
.cam.on .cam-idle { display: none; }
.cam-idle .btn { --b: var(--mode); min-width: 230px; }
.cam-idle p { margin: 0; color: var(--muted); font-size: 15px; max-width: 280px; }
.cam-hint { position: absolute; left: 0; right: 0; bottom: 14px; margin: 0; text-align: center; font: 700 11px/1.3 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: #fff; text-shadow: 0 1px 6px rgba(0, 0, 0, .9); }
.cam:not(.on) .cam-hint { display: none; }
.btn.cam-stop { position: absolute; top: 8px; right: 8px; background: rgba(10, 10, 11, .72); }
.cam:not(.on) .cam-stop { display: none; }

.search { display: flex; gap: 8px; margin-top: 18px; }
.search input { flex: 1; min-width: 0; }
.matches { display: grid; gap: 6px; margin-top: 10px; }
/* A match is a hairline row; a mode-coloured bar slides in on the left when it's pressed or focused. */
.match { position: relative; display: grid; grid-template-columns: 1fr auto; gap: 3px 14px; align-items: center; text-align: left; width: 100%; padding: 13px 14px 13px 16px; border: 1px solid var(--line); border-radius: 0; background: var(--char-2); color: var(--text); font: inherit; cursor: pointer; transition: border-color .15s, background .15s; }
.match::before { content: ''; position: absolute; left: -1px; top: -1px; bottom: -1px; width: 3px; background: var(--mode); transform: scaleY(0); transform-origin: top; transition: transform .2s var(--ease); }
.match:active::before, .match:focus-visible::before { transform: none; }
.match:active { border-color: var(--line-2); }
.match .m-email { font-weight: 600; overflow-wrap: anywhere; }
.match .m-sub { grid-column: 1; font: 400 12px/1.45 var(--mono); color: var(--muted); }
.match .m-status { grid-column: 2; grid-row: 1 / span 2; display: inline-flex; align-items: center; gap: 7px; font: 700 11px/1.2 var(--mono); letter-spacing: .1em; text-transform: uppercase; white-space: nowrap; }
.match .m-status::before { content: ''; flex: none; width: 7px; height: 7px; background: currentColor; }
.st-ok { color: var(--good); } .st-in { color: var(--muted); } .st-warn { color: var(--warn); } .st-bad { color: var(--bad); }
.empty { color: var(--muted); font-size: 14px; margin: 4px 0; }
/* Pickup search: the guest's name leads, their email sits under it. */
.match.pick .m-status { grid-row: 1 / span 3; }
.match .m-name { font-weight: 700; font-size: 17px; line-height: 1.25; overflow-wrap: anywhere; }
.match .m-mail { grid-column: 1; font-size: 13.5px; color: var(--text); opacity: .86; overflow-wrap: anywhere; }
.match .m-mail.none { color: var(--dim); opacity: 1; font-style: italic; }
.match .m-ref { white-space: nowrap; }
@media (hover: hover) { .match:hover { border-color: var(--line-2); background: var(--char-3); } .match:hover::before { transform: none; } }
.empty.more { font: 400 12px/1.4 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.desk-h, .matches .idle { display: none; }

/* Section label: a mono eyebrow with a hairline */
h2 { margin: 34px 0 4px; }
.recent { list-style: none; margin: 0; padding: 0; }
.recent li { display: grid; grid-template-columns: 8px 1fr auto; gap: 3px 12px; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--line); }
.recent .dot { width: 8px; height: 8px; }
.recent .who { font-weight: 600; font-size: 14.5px; overflow-wrap: anywhere; }
.recent .what { grid-column: 2 / span 2; font-size: 13px; color: var(--muted); }
.recent .when { font: 400 11px/1 var(--mono); color: var(--dim); }
.recent .none { display: block; padding: 16px 0; color: var(--dim); font-size: 14px; }
.recent li:has(.none) { border-bottom: 0; }
.dot.ok { background: var(--good); } .dot.bad { background: var(--bad); } .dot.warn { background: var(--warn); } .dot.neutral { background: var(--dim); }

.foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 26px; padding-top: 16px; border-top: 1px solid var(--line); }
.foot .sync-text { flex: 1 1 100%; margin-bottom: 4px; font: 400 11.5px/1.4 var(--mono); color: var(--muted); }

/* Pickup desk on a laptop: camera, count and recent scans on the left; a big name search and a longer list on
   the right, on a concrete utility panel under a black header strip. Entry mode keeps the phone layout at every width. */
@media (min-width: 900px) {
  body.pickup #main {
    max-width: 1180px; padding-left: 28px; padding-right: 28px;
    display: grid; grid-template-columns: minmax(300px, 400px) minmax(0, 1fr); column-gap: 44px; align-items: start;
    grid-template-rows: auto auto auto auto auto 1fr auto;
    grid-template-areas: "bar bar" "mode desk" "count desk" "cam desk" "rh desk" "recent desk" "foot foot";
  }
  body.pickup #main > .bar { grid-area: bar; }
  body.pickup #main > .mode { grid-area: mode; }
  body.pickup #main > .count { grid-area: count; }
  body.pickup #main > .cam { grid-area: cam; }
  body.pickup #main > h2 { grid-area: rh; }
  body.pickup #main > .recent { grid-area: recent; }
  body.pickup #main > .foot { grid-area: foot; }
  body.pickup .desk {
    grid-area: desk; position: relative; min-width: 0; padding: 0 26px 30px; color: var(--ink); --muted: var(--ink-2); --dim: #5c5b55;
    background: var(--xh-ink) no-repeat 10px calc(100% - 10px) / 20px, var(--xh-ink) no-repeat right 10px bottom 10px / 20px, var(--circ-ink-tr) no-repeat right 52px / 300px auto, var(--concrete) var(--concrete-tex);
  }
  body.pickup .desk :focus-visible { outline-color: var(--ink); }
  body.pickup .desk-h { display: flex; position: relative; overflow: hidden; min-height: 52px; margin: 0 -26px 22px; padding: 0 26px; background: var(--ink); color: var(--concrete-2); }
  body.pickup .desk-h::before { content: ''; flex: none; width: 8px; height: 8px; background: var(--mode); }
  /* A cyan slash through the header strip, like the one on the guest's pass */
  body.pickup .desk-h::after { flex: none; min-width: 0; width: 3px; height: 74px; margin: 0 64px 0 auto; background: var(--mode); transform: rotate(24deg); box-shadow: 0 0 12px var(--mode); }
  body.pickup .search { margin-top: 0; }
  body.pickup .search input { min-height: 64px; padding: 16px 20px; font-size: 21px; font-weight: 500; color: var(--ink); background: rgba(244, 243, 239, .94); border-color: rgba(20, 20, 22, .42); }
  body.pickup .search input::placeholder { color: #6b6a64; }
  body.pickup .search input:hover { border-color: var(--ink); }
  body.pickup .search input:focus { outline: 2px solid var(--ink); border-color: var(--ink); background: var(--paper); }
  body.pickup .matches { margin-top: 14px; gap: 8px; }
  body.pickup .match { padding: 15px 18px 15px 20px; color: var(--ink); background: rgba(244, 243, 239, .6); border-color: var(--ink-line); }
  body.pickup .match::before { background: var(--ink); }
  body.pickup .match:active { border-color: var(--ink); }
  body.pickup .match .m-name { font-size: 21px; }
  body.pickup .match .m-mail { font-size: 14.5px; color: var(--ink); opacity: .82; }
  body.pickup .match .m-mail.none { color: var(--dim); opacity: 1; }
  body.pickup .match .m-sub { font-size: 12.5px; }
  body.pickup .match .m-status { font-size: 12px; }
  body.pickup .desk .st-ok { color: #17561f; } body.pickup .desk .st-in { color: var(--ink-2); } body.pickup .desk .st-warn { color: #7a4d00; } body.pickup .desk .st-bad { color: #a3140c; }
  body.pickup .matches .idle { display: block; margin-top: 4px; }
}
@media (min-width: 900px) and (hover: hover) { body.pickup .match:hover { border-color: var(--ink); background: rgba(244, 243, 239, .9); } }

/* ---------- Full-screen result ----------
   Flat, loud colour first; the kinetic art (ink speed streaks, crosshairs, circuit traces) stays faint in the
   background. The page scrolls if a long result doesn't fit a small phone. */
.result {
  position: fixed; inset: 0; z-index: 50; isolation: isolate; display: flex; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
  padding: max(58px, calc(env(safe-area-inset-top) + 40px)) 22px max(26px, env(safe-area-inset-bottom));
  animation: pop .16s var(--ease); --rc: var(--text);
}
@keyframes pop { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.result::before { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background: var(--xh-ink) no-repeat 12px 12px / 22px, var(--xh-ink) no-repeat right 12px bottom 12px / 22px, var(--circ-ink-tr) no-repeat right top / 320px auto; }
.result::after { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 300px; z-index: -1; pointer-events: none; background: var(--streak-ink) center -40px / 900px auto repeat-x; }
.result.ok { background: var(--go); color: var(--ink); --rc: var(--go); }
.result.bad { background: var(--stop); color: var(--ink); --rc: var(--stop); }
.result.warn { background: var(--caution); color: var(--ink); --rc: var(--caution); }
.result.neutral, .result.checking { background: var(--char) var(--matte); color: var(--text); --rc: var(--cyan); }
.result.neutral::before, .result.checking::before { background: var(--xh-lite) no-repeat 12px 12px / 22px, var(--xh-lite) no-repeat right 12px bottom 12px / 22px, var(--circ-lite-tr) no-repeat right top / 320px auto; }
.result.neutral::after, .result.checking::after { background-image: var(--streak-lite); }
.r-inner { width: 100%; max-width: 560px; margin: auto; }
@media (min-width: 900px) { .r-inner { max-width: 640px; } }
/* The label: an ink tag, the icon in a square of the result's colour */
.r-label {
  display: inline-flex; align-items: center; gap: 11px; max-width: 100%; min-height: 36px; margin: 0; padding: 4px 13px 4px 4px;
  font: 700 12.5px/1.35 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--rc); background: var(--ink);
}
/* A shape as well as a colour, for anyone who can't tell green from red: an ink glyph in a square of the result's
   colour, set inside the ink tag */
.r-label::before { flex: none; align-self: stretch; display: grid; place-items: center; width: 28px; min-height: 28px; font: 900 16px/1 var(--body); letter-spacing: 0; color: var(--ink); background: var(--rc); }
.result.ok .r-label::before { content: '✓'; content: '✓' / ''; }
.result.bad .r-label::before { content: '✕'; content: '✕' / ''; }
.result.warn .r-label::before { content: '!'; content: '!' / ''; }
.result.neutral .r-label::before { content: '↺'; content: '↺' / ''; }
.result.neutral .r-label, .result.checking .r-label { background: transparent; box-shadow: inset 0 0 0 1px var(--line-2); }
.result.checking .r-label { padding-left: 13px; color: var(--muted); }
.result.neutral .r-label { color: var(--cyan); }
.result h1 {
  font-family: var(--wide); font-stretch: 125%; font-weight: 900; text-transform: uppercase;
  font-size: clamp(54px, 17vw, 116px); line-height: .9; letter-spacing: -.015em; margin: 20px 0 18px;
  overflow-wrap: normal; word-break: keep-all; hyphens: none;
}
.result.checking h1 { color: var(--muted); }
/* Check ID (Pickup, from a name search): a concrete card in a thick orange frame, the guest's name as the headline,
   to hold up against their photo ID before anything is recorded. */
.result.idcheck { background: var(--concrete) var(--concrete-tex); color: var(--ink); --rc: var(--orange); box-shadow: inset 0 0 0 10px var(--orange); }
.result.idcheck::before { background: var(--xh-ink) no-repeat 20px 20px / 22px, var(--xh-ink) no-repeat right 20px bottom 20px / 22px, var(--circ-ink-tr) no-repeat right 10px top 10px / 320px auto; }
.result.idcheck::after { display: none; }
.result.idcheck .r-label::before { content: '?'; content: '?' / ''; }
/* Names get more line height than the result words: an accent on a capital (É) would touch the line above. */
.result h1.name { font-size: clamp(42px, 13vw, 100px); line-height: 1.02; letter-spacing: -.01em; }
.result h1.quiet { font-size: clamp(32px, 9.5vw, 58px); line-height: 1; }
/* The guest's name on Hand over, under the big result word */
.r-name {
  margin: -4px 0 16px; padding-top: 14px; border-top: 2px solid currentColor;
  font-family: var(--wide); font-stretch: 112%; font-weight: 800; text-transform: uppercase;
  font-size: clamp(32px, 10vw, 54px); line-height: 1.04; letter-spacing: -.005em; overflow-wrap: normal; word-break: keep-all; hyphens: none;
}
.r-name:empty { display: none; }
/* Two guests share this name: an ink strip with a yellow warning that can't be missed */
.r-warn {
  display: flex; align-items: center; gap: 14px; margin: 18px 0 0; padding: 12px 15px 12px 0;
  font-size: 17px; font-weight: 700; line-height: 1.35; color: var(--caution); background: var(--ink);
}
.r-warn::before { content: '!'; content: '!' / ''; flex: none; align-self: stretch; display: grid; place-items: center; width: 42px; margin: -12px 0; font: 900 20px/1 var(--body); color: var(--ink); background: var(--caution); }
.r-warn:empty { display: none; }
.r-email.hl { display: block; width: fit-content; max-width: 100%; padding: 8px 11px 7px; font-size: 16px; color: var(--caution); background: var(--ink); }
.r-pkg { margin: 0; font-family: var(--wide); font-stretch: 112%; font-weight: 700; font-size: 20px; line-height: 1.25; text-transform: uppercase; letter-spacing: .02em; overflow-wrap: anywhere; }
/* The size to hand over: a big ink block, readable from the stock shelf */
.r-size {
  display: block; width: fit-content; max-width: 100%; margin: 14px 0 0; padding: 12px 18px 10px; overflow-wrap: anywhere;
  font-family: var(--wide); font-stretch: 112%; font-weight: 900; font-size: clamp(46px, 14vw, 84px); line-height: .95; letter-spacing: -.01em; text-transform: uppercase;
  color: var(--rc); background: var(--ink);
}
.r-size:empty { display: none; }
.r-size.warn { padding: 12px 16px 11px; color: var(--caution); font: 700 19px/1.25 var(--body); letter-spacing: .01em; text-transform: none; }
.r-email { margin: 12px 0 0; font: 700 14px/1.4 var(--mono); overflow-wrap: anywhere; }
.r-note { margin: 18px 0 0; padding: 12px 15px; border-left: 3px solid currentColor; background: rgba(20, 20, 22, .08); font-size: 16px; font-weight: 500; line-height: 1.45; overflow-wrap: anywhere; }
.result.neutral .r-note { border-left-color: var(--cyan); background: rgba(236, 235, 230, .05); }
.r-note:empty { display: none; }
.r-actions { display: grid; gap: 12px; margin-top: 26px; }
.result .btn { --b: var(--ink); width: 100%; min-height: 62px; padding: 0 20px; font-size: 17px; color: var(--rc); }
.result .btn::after { font-size: 20px; }
.result .btn.ghost { --b: transparent; color: inherit; border: 2px solid currentColor; }
.result.neutral .btn:not(.ghost), .result.checking .btn:not(.ghost) { --b: var(--orange); color: var(--ink); }
.result.neutral .btn.ghost, .result.checking .btn.ghost { border: 1px solid var(--line-2); }
.result :focus-visible { outline: 3px solid var(--ink); outline-offset: 3px; }
.result.neutral :focus-visible, .result.checking :focus-visible { outline-color: var(--cyan); }
@media (hover: hover) { .result .btn.ghost:hover { background: rgba(20, 20, 22, .08); border-color: currentColor; } .result.neutral .btn.ghost:hover { background: rgba(236, 235, 230, .05); border-color: var(--text); } }
.r-timer { height: 4px; background: rgba(20, 20, 22, .2); margin-top: 18px; overflow: hidden; }
.r-timer i { display: block; height: 100%; width: 100%; background: var(--ink); transform-origin: left; }
.result.neutral .r-timer { background: var(--line); }
.result.neutral .r-timer i { background: var(--cyan); }
.r-timer.run i { animation: drain 3.5s linear forwards; }
@keyframes drain { to { transform: scaleX(0); } }
/* Short phones: tighter result type, so more of a long result fits without scrolling */
@media (max-height: 700px) {
  .result { padding-top: max(40px, calc(env(safe-area-inset-top) + 24px)); }
  .result h1 { font-size: clamp(46px, 15vw, 96px); margin: 14px 0 12px; }
  .result h1.name { font-size: clamp(36px, 11vw, 84px); }
  .r-name { font-size: clamp(28px, 8.6vw, 48px); padding-top: 10px; margin-bottom: 12px; }
  .r-size { font-size: clamp(40px, 12vw, 72px); margin-top: 10px; padding: 9px 15px 7px; }
  .r-note { margin-top: 14px; padding: 10px 13px; font-size: 15px; }
  .r-actions { gap: 10px; margin-top: 18px; }
  .result .btn { min-height: 54px; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
</style>
</head>
<body>

<section id="signin" class="wrap signin hidden">
  <div class="sig-head">
    <div class="kin" aria-hidden="true"><div class="kin-field">
      <i class="sk w" style="--x:8%;--y:47%;--w:42%"></i>
      <i class="sk c" style="--x:46%;--y:45%;--w:30%;--h:3px;--d:80"></i>
      <i class="sk n" style="--x:2%;--y:55%;--w:42%;--h:8px;--d:40"></i>
      <i class="sk g" style="--x:-2%;--y:63%;--w:28%;--h:4px;--d:160"></i>
      <i class="sk p" style="--x:63%;--y:55%;--w:10%;--h:8px;--d:220"></i>
      <i class="sk c" style="--x:70%;--y:39%;--w:22%;--h:2px;--o:.7;--d:260"></i>
      <i class="sk w" style="--x:52%;--y:65%;--w:34%;--o:.6;--d:120"></i>
      <i class="sk p" style="--x:24%;--y:69%;--w:6%;--h:6px;--o:.8;--d:300"></i>
      <i class="sk g" style="--x:76%;--y:61%;--w:18%;--h:3px;--o:.85;--d:200"></i>
    </div></div>
    <div class="brand"><b>ON D<span>'</span></b> <i>ROAD</i><em>Door</em></div>
    <p class="eb" aria-hidden="true">Crew</p>
    <h1><b>Staff</b><br><i>sign-in</i></h1>
  </div>
  <p class="lead">Do this once with signal before doors open. The guest list is saved on this phone, so scanning keeps working if the signal drops.</p>
  <form id="signin-form" autocomplete="on">
    <label for="key">Staff password</label>
    <input id="key" type="password" autocomplete="current-password" required>
    <label for="device">Name this phone</label>
    <input id="device" placeholder="e.g. Front gate" maxlength="40" required autocomplete="off">
    <button class="btn" type="submit">Start</button>
    <p id="signin-msg" class="msg" role="status"></p>
  </form>
  <div class="sig-data" aria-hidden="true"><span>[ 18+ | Antigua ]</span><span>17°07’N · 61°50’W</span></div>
</section>

<section id="main" class="wrap hidden">
  <header class="bar">
    <div class="brand"><b>ON D<span>'</span></b> <i>ROAD</i><em id="device-name">Door</em></div>
    <div class="net ok" id="net"><i></i><span id="net-text">Online</span></div>
  </header>
  <div class="mode" role="radiogroup" aria-label="Scanner mode">
    <label><input type="radio" name="mode" value="entry"><span>Entry</span></label>
    <label><input type="radio" name="mode" value="pickup"><span>Pickup</span></label>
  </div>
  <div class="count"><b id="in-count">0</b><span>of <b id="paid-count">0</b> <span id="count-what">paid guests checked in</span></span></div>

  <div class="cam" id="cam">
    <video id="video" playsinline muted autoplay></video>
    <div class="frame"></div>
    <div class="cam-idle">
      <button class="btn" id="cam-btn" type="button">Start scanning</button>
      <p id="cam-msg">Point the camera at the QR code on the guest's pass.</p>
    </div>
    <button class="btn ghost small cam-stop" id="cam-stop" type="button">Stop</button>
    <p class="cam-hint" id="cam-hint">Hold the pass inside the frame</p>
  </div>

  <div class="desk" id="desk">
    <h2 class="desk-h" aria-hidden="true">Find a guest</h2>
    <form class="search" id="search-form" autocomplete="off" role="search">
      <input id="q" placeholder="No QR? Search email or reference" aria-label="No QR? Search email or reference" type="search" enterkeyhint="search">
    </form>
    <div id="matches" class="matches"></div>
  </div>

  <h2>Recent scans</h2>
  <ul id="recent" class="recent"></ul>

  <footer class="foot">
    <span class="sync-text" id="sync-text"></span>
    <button class="btn ghost small" id="sync-btn" type="button">Sync now</button>
    <button class="btn ghost small" id="signout" type="button">Sign out</button>
  </footer>
</section>

<div id="result" class="result hidden" role="alertdialog" aria-modal="true" aria-labelledby="r-title">
  <div class="r-inner">
    <p class="r-label" id="r-label"></p>
    <h1 id="r-title"></h1>
    <p class="r-name" id="r-name"></p>
    <p class="r-pkg" id="r-pkg"></p>
    <p class="r-size" id="r-size"></p>
    <p class="r-email" id="r-email"></p>
    <p class="r-warn" id="r-warn"></p>
    <p class="r-note" id="r-note"></p>
    <div class="r-timer" id="r-timer"><i></i></div>
    <div class="r-actions">
      <button class="btn" id="r-primary" type="button">Next guest</button>
      <button class="btn ghost" id="r-secondary" type="button"></button>
    </div>
  </div>
</div>

<script>
var $ = function (id) { return document.getElementById(id); };
var store = {
  get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
};
var KEY = store.get('door_key', '');
var DEVICE = store.get('door_device', '');
var passes = store.get('door_passes', []);
var queue = store.get('door_queue', []);
var recent = store.get('door_recent', []);
var syncedAt = store.get('door_synced_at', null);
// 'entry' checks guests in at the gate; 'pickup' hands out packages (and never checks anyone in).
var MODE = store.get('door_mode', 'entry') === 'pickup' ? 'pickup' : 'entry';
var online = navigator.onLine !== false;
var syncing = false, busy = false, autoTimer = null;
// True while a Pickup-mode name search is being dealt with (Check ID, then Hand over), so Next guest clears the search.
var searchFlow = false;
// Laptop width: the Pickup desk layout, a longer match list, and the cursor goes back to the search after each guest.
var wideMq = window.matchMedia ? window.matchMedia('(min-width: 900px)') : null;
function wide() { return !!(wideMq && wideMq.matches); }

function el(tag, text, cls) { var e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = text; if (cls) e.className = cls; return e; }
// Search fold: lowercase, no accents, ' . , dropped and - read as a space, so "Mary-Ann O'Neil" is found by
// "mary ann oneil". Phones type curly apostrophes and long dashes, so those count too. Built with String.fromCharCode
// because this page sits inside a template literal, where backslash escapes don't survive.
var MARKS = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');
var FOLD_DROP = "'.," + String.fromCharCode(0x2019, 0x2018, 0x2bc, 0xb4, 0x60);
var FOLD_SPACE = '-' + String.fromCharCode(0x2010, 0x2011, 0x2013, 0x2014, 0x2212, 0xa0, 9, 10, 13);
function fold(s) {
  s = String(s || '').toLowerCase();
  if (s.normalize) s = s.normalize('NFD');
  s = s.replace(MARKS, '');
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (FOLD_DROP.indexOf(c) >= 0) continue;
    out += FOLD_SPACE.indexOf(c) >= 0 ? ' ' : c;
  }
  return out;
}
function foldWords(s) { return fold(s).split(' ').filter(Boolean); }
// The guest's name as on their ID. Lists saved before names existed have none, so this is '' for them.
function nameOf(p) { return String((p && p.full_name) || '').trim(); }
function fmtTime(iso) { return iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Antigua' }) : ''; }
// Pickup runs over several days, so pickup times show the date too.
function fmtWhen(iso) { return iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Antigua' }) : ''; }
function newId() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12); }
function savePasses() { store.set('door_passes', passes); }
function saveQueue() { store.set('door_queue', queue); }

// ---------- Network ----------
function api(path, body) {
  var ctrl = window.AbortController ? new AbortController() : null;
  var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 6000);
  return fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'x-door-key': KEY },
    body: body ? JSON.stringify(body) : undefined,
    signal: ctrl ? ctrl.signal : undefined,
    cache: 'no-store'
  }).then(function (res) {
    clearTimeout(timer);
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (res.status === 401) { var authErr = new Error(data.error || 'Wrong staff password.'); authErr.auth = true; throw authErr; }
      if (!res.ok) { var srvErr = new Error(data.error || 'Server error.'); srvErr.server = true; throw srvErr; }
      setOnline(true);
      return data;
    });
  }, function () {
    clearTimeout(timer);
    setOnline(false);
    var netErr = new Error('No connection'); netErr.offline = true; throw netErr;
  });
}
function setOnline(v) { online = v; renderNet(); }

// ---------- Local list ----------
var RANK = { PAID: 3, RESERVED: 2, CANCELLED: 1 };
function findPass(target) {
  if (target.ref) {
    for (var i = 0; i < passes.length; i++) if (passes[i].ref === target.ref) return passes[i];
    return null;
  }
  var best = null;
  passes.forEach(function (p) {
    if (p.email !== target.email) return;
    if (!best || (RANK[p.status] || 0) > (RANK[best.status] || 0) || ((RANK[p.status] || 0) === (RANK[best.status] || 0) && p.id > best.id)) best = p;
  });
  return best;
}
function mergePass(p) {
  for (var i = 0; i < passes.length; i++) if (passes[i].ref === p.ref) { passes[i] = p; savePasses(); return p; }
  passes.push(p); savePasses(); return p;
}
// Re-applies scans still waiting to sync on top of a freshly downloaded list.
function reapplyQueue() {
  queue.forEach(function (ev) {
    var p = findPass({ ref: ev.ref });
    if (!p) return;
    if (ev.kind === 'ENTRY' && !p.checked_in_at) { p.checked_in_at = ev.scanned_at; p.checked_in_by = ev.device; }
    if (ev.kind === 'UNDO') { p.checked_in_at = null; p.checked_in_by = null; }
    if (ev.kind === 'PICKUP' && !p.picked_up_at) { p.picked_up_at = ev.scanned_at; p.picked_up_by = ev.device; }
    if (ev.kind === 'PICKUP_UNDO') { p.picked_up_at = null; p.picked_up_by = null; }
  });
}
function decide(p, target, kind) {
  if (!p) return { result: 'NOT_FOUND' };
  if (target.ref && target.email && target.email !== p.email) return { result: 'MISMATCH', pass: p };
  if (kind === 'UNDO') return { result: 'UNDONE', pass: p };
  if (kind === 'PICKUP_UNDO') return { result: 'PICKUP_UNDONE', pass: p };
  if (p.status === 'RESERVED') return { result: 'UNPAID', pass: p };
  if (p.status !== 'PAID') return { result: 'CANCELLED', pass: p };
  if (kind === 'PICKUP') return { result: p.picked_up_at ? 'PICKED_ALREADY' : 'HANDED', pass: p };
  if (kind === 'OVERRIDE') return { result: 'ADMIT', override: true, pass: p };
  if (p.checked_in_at) return { result: 'ALREADY', pass: p };
  return { result: 'ADMIT', pass: p };
}

// Reads what the camera saw. Current passes hold ONDROAD:<reference>:<email>.
// Older passes held ONDROAD:<email>:<status>, so those are looked up by email.
function parse(text) {
  var t = String(text || '').trim();
  if (/^ODR-[0-9A-F]{8}$/i.test(t)) return { ref: t.toUpperCase() };
  if (t.slice(0, 8).toUpperCase() !== 'ONDROAD:') return null;
  var parts = t.split(':');
  if (parts.length < 3) return null;
  if (/^ODR-[0-9A-F]{8}$/i.test(parts[1])) return { ref: parts[1].toUpperCase(), email: parts.slice(2).join(':').trim().toLowerCase() };
  if (parts[1].indexOf('@') > 0) return { email: parts[1].trim().toLowerCase() };
  return null;
}

// ---------- Scanning a pass ----------
function handle(target, kind) {
  kind = kind || 'ENTRY';
  var pickup = kind === 'PICKUP' || kind === 'PICKUP_UNDO';
  if (!target) { show({ result: 'INVALID' }, false, pickup); return Promise.resolve(); }
  var local = findPass(target);
  var ref = target.ref || (local && local.ref) || '';
  if (!ref) { show(decide(null, target, kind), !online, pickup); return Promise.resolve(); }
  var ev = { client_id: newId(), ref: ref, email: target.ref ? (target.email || '') : '', kind: kind, scanned_at: new Date().toISOString(), device: DEVICE };
  showChecking();
  return api('/api/door/checkin', ev).then(function (r) {
    if (r.pass) mergePass(r.pass);
    show(r, false, pickup);
  }, function (err) {
    if (err.auth) { hideResult(); signOut(err.message); return; }
    // No signal (or the server hiccuped): decide from the list saved on this phone.
    var d = decide(local, target, kind);
    if (d.result === 'ADMIT' || d.result === 'UNDONE' || d.result === 'HANDED' || d.result === 'PICKUP_UNDONE') {
      queue.push(ev); saveQueue();
      if (d.result === 'ADMIT' && !d.override) { local.checked_in_at = ev.scanned_at; local.checked_in_by = DEVICE; }
      if (d.result === 'UNDONE') { local.checked_in_at = null; local.checked_in_by = null; }
      if (d.result === 'HANDED') { local.picked_up_at = ev.scanned_at; local.picked_up_by = DEVICE; }
      if (d.result === 'PICKUP_UNDONE') { local.picked_up_at = null; local.picked_up_by = null; }
      savePasses();
    }
    show(d, true, pickup);
  }).then(function () { renderNet(); renderCounts(); });
}

var RESULTS = {
  ADMIT: { cls: 'ok', label: 'Valid pass', title: 'Admit', tone: 'ok' },
  ALREADY: { cls: 'bad', label: 'Pass already used', title: 'Already in', tone: 'bad' },
  UNPAID: { cls: 'warn', label: 'Reserved, not paid', title: 'Not paid', tone: 'bad' },
  CANCELLED: { cls: 'bad', label: 'Cancelled or refunded', title: 'Cancelled', tone: 'bad' },
  NOT_FOUND: { cls: 'bad', label: 'Unknown code', title: 'Not on list', tone: 'bad' },
  MISMATCH: { cls: 'bad', label: 'Wrong guest', title: 'No match', tone: 'bad' },
  INVALID: { cls: 'bad', label: 'Not a pass', title: 'Not a pass', tone: 'bad' },
  OTHER_EVENT: { cls: 'bad', label: 'Another event', title: 'Wrong event', tone: 'bad' },
  UNDONE: { cls: 'neutral', label: 'Check-in removed', title: 'Undone', tone: 'neutral' },
  HANDED: { cls: 'ok', label: 'Package collected', title: 'Hand over', tone: 'ok' },
  PICKED_ALREADY: { cls: 'bad', label: 'Package already handed out', title: 'Already collected', tone: 'bad' },
  PICKUP_UNDONE: { cls: 'neutral', label: 'Pickup removed', title: 'Undone', tone: 'neutral' }
};
var PICKUP_RESULTS = { HANDED: 1, PICKED_ALREADY: 1, PICKUP_UNDONE: 1 };

function showChecking() {
  busy = true;
  clearTimeout(autoTimer);
  $('result').className = 'result checking';
  $('main').inert = true;
  $('r-label').textContent = 'Checking';
  $('r-title').textContent = '...';
  $('r-title').className = '';
  ['r-name', 'r-pkg', 'r-size', 'r-email', 'r-warn', 'r-note'].forEach(function (id) { $(id).textContent = ''; });
  $('r-size').className = 'r-size';
  $('r-email').className = 'r-email';
  $('r-timer').className = 'r-timer hidden';
  $('r-primary').classList.add('hidden');
  $('r-secondary').classList.add('hidden');
  $('r-primary').onclick = null;
  $('r-secondary').onclick = null;
}

// How many guests with a pass that isn't cancelled have this name (accents, case and ' . , - aside).
function sameName(p) {
  var key = foldWords(nameOf(p)).join(' ');
  if (!key) return 0;
  var seen = {}, n = 0;
  passes.forEach(function (x) {
    if (x.status === 'CANCELLED' || seen[x.email] || foldWords(nameOf(x)).join(' ') !== key) return;
    seen[x.email] = true;
    n++;
  });
  return n;
}

// Closes a result. After a Pickup name search it also clears the search for the next guest, and puts the cursor
// back in it on a laptop (on a phone that would pop the keyboard up over the list).
function nextGuest() {
  hideResult();
  if (!searchFlow) return;
  searchFlow = false;
  $('q').value = '';
  renderMatches();
  if (wide()) $('q').focus();
}

// pickup: the scan was made in Pickup mode, so shared results (not paid, wrong guest...) use pickup wording.
// Each screen sets its own buttons here.
function show(r, offline, pickup) {
  busy = true;
  clearTimeout(autoTimer);
  // The scanner behind the full-screen result can't be reached by Tab or tapped while it's open.
  $('main').inert = true;
  var p = r.pass || null;
  var primary = $('r-primary'), secondary = $('r-secondary'), size = $('r-size'), timer = $('r-timer');
  $('r-title').className = '';
  $('r-name').textContent = '';
  $('r-warn').textContent = '';
  $('r-email').className = 'r-email';

  // Check ID: a package found by a Pickup name search, before it's handed over. Nothing is recorded or logged
  // until Hand over, which saves the pickup exactly like scanning the pass. Back keeps the search and its list.
  if (r.result === 'CHECK_ID' && p) {
    var who = nameOf(p);
    $('result').className = 'result idcheck';
    $('r-label').textContent = 'Pickup · Check ID';
    $('r-title').textContent = who || 'No name on file';
    $('r-title').className = who ? 'name' : 'quiet';
    fitTitle();
    $('r-pkg').textContent = p.package;
    size.textContent = '';
    size.className = 'r-size';
    if (p.size) size.textContent = 'Size ' + p.size;
    else if (p.sized) { size.textContent = 'No size picked'; size.className = 'r-size warn'; }
    $('r-email').textContent = p.email;
    var twins = sameName(p);
    if (twins > 1) {
      $('r-warn').textContent = twins + ' guests with this name: confirm their email';
      $('r-email').className = 'r-email hl';
    }
    var idNote = who ? 'Ask for their photo ID. Hand over only if the name matches.' : 'Ask for their email and check their photo ID.';
    if (p.refund_requested) idNote += ' They asked for a refund. Check with the organizer first.';
    $('r-note').textContent = idNote;
    timer.className = 'r-timer hidden';
    primary.classList.remove('hidden');
    primary.textContent = 'Hand over';
    primary.onclick = function () { handle({ ref: p.ref }, 'PICKUP'); };
    secondary.textContent = 'Back';
    secondary.classList.remove('hidden');
    secondary.onclick = function () { searchFlow = false; hideResult(); backToMatch(p.ref); };
    primary.focus();
    return;
  }

  var cfg = RESULTS[r.result] || RESULTS.INVALID;
  $('result').className = 'result ' + cfg.cls;
  $('r-label').textContent = (pickup && !PICKUP_RESULTS[r.result] ? 'Pickup · ' : '') + (r.override ? 'Override · ' : '') + cfg.label + (offline ? ' · saved offline' : '');
  $('r-title').textContent = cfg.title;
  fitTitle();
  $('r-pkg').textContent = p ? p.package : '';
  $('r-email').textContent = p ? p.email : '';
  // The size to hand over, big enough to read from the stock shelf.
  size.textContent = '';
  size.className = 'r-size';
  if (r.result === 'HANDED' && p) {
    if (p.size) size.textContent = 'Size ' + p.size;
    else if (p.sized) { size.textContent = 'No size picked'; size.className = 'r-size warn'; }
  }
  var note = '';
  if (r.result === 'ADMIT') {
    if (r.override) note = 'Let in again by staff override. This is logged.';
    if (p && p.costume) note += (note ? ' ' : '') + 'Costume required: check their outfit.';
    if (p && p.refund_requested) note += (note ? ' ' : '') + 'They asked for a refund. Tell the organizer.';
  }
  if (r.result === 'ALREADY' && p) note = 'Checked in at ' + fmtTime(p.checked_in_at) + (p.checked_in_by ? ' by ' + p.checked_in_by : '') + '. Only let them in if you know it is a re-entry.';
  if (r.result === 'UNPAID') note = pickup ? 'Their reservation was never paid. No package until they pay.' : 'Their reservation was never paid, so this pass does not get them in.';
  if (r.result === 'CANCELLED') note = pickup ? 'This order was cancelled or refunded. No package for this pass.' : 'This order was cancelled or refunded. The pass no longer works.';
  if (r.result === 'HANDED' && p) {
    // The name big, so staff can hold the screen next to the photo ID.
    var name = nameOf(p);
    $('r-name').textContent = name;
    fitText($('r-name'), 26);
    note = name ? 'Check their photo ID says ' + name + '. Packages only go to the guest themselves.' : 'No name on file. Ask for their email and check their photo ID.';
    if (p.sized && !p.size) note += ' Ask which size they need and tell the organizer.';
    if (p.refund_requested) note += " They asked for a refund. Check with the organizer first, and tap Undo if you don't hand it over.";
  }
  if (r.result === 'PICKED_ALREADY' && p) note = (p.picked_up_at ? 'Handed out ' + fmtWhen(p.picked_up_at) + (p.picked_up_by ? ' by ' + p.picked_up_by : '') + '. ' : '') + 'One package per pass. If they say they never got it, contact the organizer.';
  if (r.result === 'PICKUP_UNDONE') note = 'Their package is no longer marked as collected.';
  if (r.result === 'NOT_FOUND') note = offline ? 'Not in the list saved on this phone. If they paid recently, get signal, tap Sync now and scan again.' : 'No order has this code. Try searching their email.';
  if (r.result === 'MISMATCH') note = 'This code belongs to a different guest. Check their ID.';
  if (r.result === 'INVALID') note = "That QR code is not an On D' Road pass. Ask them to open the pass in their account.";
  if (r.result === 'OTHER_EVENT') note = 'This pass is for ' + (r.event_name || 'another event') + ', not this event. ' + (pickup ? 'No package for this pass.' : 'It does not get them in.');
  if (r.result === 'UNDONE') note = 'They are no longer marked as checked in.';
  $('r-note').textContent = note;

  primary.classList.remove('hidden');
  primary.textContent = 'Next guest';
  primary.onclick = nextGuest;
  secondary.classList.add('hidden');
  secondary.onclick = null;
  if (r.result === 'ADMIT' && !r.override && p) {
    secondary.textContent = 'Undo';
    secondary.classList.remove('hidden');
    secondary.onclick = function () { handle({ ref: p.ref }, 'UNDO'); };
  }
  if (r.result === 'ALREADY' && p) {
    secondary.textContent = 'Let them in anyway';
    secondary.classList.remove('hidden');
    secondary.onclick = function () { handle({ ref: p.ref }, 'OVERRIDE'); };
  }
  if (r.result === 'HANDED' && p) {
    secondary.textContent = 'Undo';
    secondary.classList.remove('hidden');
    secondary.onclick = function () { handle({ ref: p.ref }, 'PICKUP_UNDO'); };
  }
  // A handed-out package stays on screen until staff tap Next guest, so the size is there while they fetch it.
  timer.className = 'r-timer hidden';
  if (r.result === 'ADMIT' || r.result === 'UNDONE' || r.result === 'PICKUP_UNDONE') {
    timer.className = 'r-timer';
    void timer.offsetWidth;
    timer.className = 'r-timer run';
    autoTimer = setTimeout(nextGuest, 3500);
  }
  feedback(cfg.tone);
  var item = { t: new Date().toISOString(), result: r.result, override: !!r.override, offline: !!offline, email: p ? p.email : '', ref: p ? p.ref : '' };
  if (pickup) { item.pickup = true; if (r.result === 'HANDED' && p && p.size) item.note = 'Size ' + p.size; }
  addRecent(item);
  primary.focus();
}

// Shrinks the big headline until every word fits on the screen, whatever font loaded.
function fitTitle() { fitText($('r-title'), 32); }
function fitText(h, min) {
  h.style.fontSize = '';
  var size = parseFloat(window.getComputedStyle(h).fontSize) || 96, guard = 0;
  while (h.scrollWidth > h.clientWidth + 1 && size > min && guard++ < 60) { size -= 3; h.style.fontSize = size + 'px'; }
}

function hideResult() {
  clearTimeout(autoTimer);
  $('result').className = 'result hidden';
  $('main').inert = false;
  busy = false;
  // The same pass is usually still in front of the camera: ignore it for a few seconds.
  lastAt = Date.now();
}

// Keyboard on a result (the pickup desk on a laptop): Escape goes Back from Check ID and closes the others like
// Next guest; Tab stays on the result's own buttons.
document.addEventListener('keydown', function (e) {
  if ($('result').classList.contains('hidden')) return;
  var btns = ['r-primary', 'r-secondary'].map($).filter(function (b) { return !b.classList.contains('hidden'); });
  if (e.key === 'Escape') {
    e.preventDefault();
    if (!btns.length) return;
    if ($('result').classList.contains('idcheck')) $('r-secondary').click();
    else nextGuest();
    return;
  }
  if (e.key !== 'Tab') return;
  e.preventDefault();
  if (!btns.length) return;
  var at = btns.indexOf(document.activeElement);
  btns[(at + (e.shiftKey ? btns.length - 1 : 1)) % btns.length].focus();
});

// Back from Check ID: the search and its list are still there; focus returns to the guest that was tapped.
function backToMatch(ref) {
  var hit = Array.prototype.filter.call($('matches').children, function (c) { return c.getAttribute('data-ref') === ref; })[0];
  if (hit) hit.focus(); else if (wide()) $('q').focus();
}

// Buzz and beep so staff notice without staring at the screen.
var audioCtx = null;
function feedback(tone) {
  try { if (navigator.vibrate) navigator.vibrate(tone === 'ok' ? 90 : tone === 'bad' ? [220, 90, 220] : 40); } catch (e) {}
  try {
    if (!audioCtx) return;
    var o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = tone === 'ok' ? 1046 : tone === 'bad' ? 196 : 523;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + (tone === 'bad' ? 0.45 : 0.16));
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.5);
  } catch (e) {}
}
function unlockAudio() {
  try { if (!audioCtx) { var AC = window.AudioContext || window.webkitAudioContext; if (AC) audioCtx = new AC(); } if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) {}
}

// ---------- Recent ----------
var LABELS = { ADMIT: 'Admitted', ALREADY: 'Blocked: already in', UNPAID: 'Blocked: not paid', CANCELLED: 'Blocked: cancelled', NOT_FOUND: 'Not on list', MISMATCH: 'Blocked: wrong guest', INVALID: 'Not a pass', UNDONE: 'Check-in undone', CONFLICT: 'Admitted twice', OTHER_EVENT: 'Blocked: another event', OTHER_VOID: 'Let in offline, but the pass is for another event',
  HANDED: 'Package handed over', PICKED_ALREADY: 'Blocked: package already collected', PICKUP_UNDONE: 'Pickup undone', PICKUP_CONFLICT: 'Handed out twice', PICKUP_VOID: 'Handed out, but the order was cancelled' };
// Pickup-mode scans that ended like an entry scan.
var PICKUP_LABELS = { UNPAID: 'No package: not paid', CANCELLED: 'No package: cancelled', MISMATCH: 'No package: wrong guest', OTHER_EVENT: 'No package: another event' };
var DOTS = { ADMIT: 'ok', UNDONE: 'neutral', UNPAID: 'warn', CONFLICT: 'warn', HANDED: 'ok', PICKUP_UNDONE: 'neutral', PICKUP_CONFLICT: 'warn' };
function addRecent(item) {
  recent.unshift(item);
  recent = recent.slice(0, 30);
  store.set('door_recent', recent);
  renderRecent();
}
function renderRecent() {
  var ul = $('recent'); ul.replaceChildren();
  if (!recent.length) { var li0 = el('li'); li0.appendChild(el('span', 'Nothing scanned yet.', 'none')); li0.style.display = 'block'; li0.style.padding = '0'; ul.appendChild(li0); return; }
  recent.slice(0, 12).forEach(function (it) {
    var li = el('li');
    li.appendChild(el('i', undefined, 'dot ' + (DOTS[it.result] || 'bad')));
    li.appendChild(el('span', it.email || it.ref || 'Unknown code', 'who'));
    li.appendChild(el('span', fmtTime(it.t), 'when'));
    var what = (it.override ? 'Admitted by override' : (it.pickup && PICKUP_LABELS[it.result]) || LABELS[it.result] || it.result) + (it.offline ? ' · offline' : '') + (it.note ? ' · ' + it.note : '');
    li.appendChild(el('span', what, 'what'));
    ul.appendChild(li);
  });
}

// ---------- Status bar ----------
function renderNet() {
  var n = $('net'), pending = queue.length;
  n.className = 'net ' + (online ? (pending ? 'warn' : 'ok') : 'off');
  $('net-text').textContent = online ? (pending ? pending + ' to sync' : 'Online') : 'Offline' + (pending ? ' · ' + pending + ' to sync' : '');
}
function renderCounts() {
  var paid = 0, inn = 0, pickup = MODE === 'pickup';
  passes.forEach(function (p) { if (p.status === 'PAID') { paid++; if (pickup ? p.picked_up_at : p.checked_in_at) inn++; } });
  $('in-count').textContent = inn;
  $('paid-count').textContent = paid;
  $('count-what').textContent = pickup ? 'paid packages collected' : 'paid guests checked in';
  $('sync-text').textContent = syncedAt ? 'Guest list updated ' + fmtTime(syncedAt) : 'Guest list not downloaded yet';
}

// ---------- Sync ----------
function pushQueue() {
  if (!queue.length) return Promise.resolve();
  var batch = queue.slice(0, 50);
  return api('/api/door/sync', { events: batch }).then(function (data) {
    (data.results || []).forEach(function (r, i) {
      var ev = batch[i];
      if (r.pass) mergePass(r.pass);
      // Admitted offline here, but another phone had already checked them in.
      if (ev && ev.kind === 'ENTRY' && r.result === 'ALREADY' && !r.replay && r.pass) {
        recent.unshift({ t: new Date().toISOString(), result: 'CONFLICT', email: r.pass.email, ref: r.pass.ref, note: 'first in at ' + fmtTime(r.pass.checked_in_at) + (r.pass.checked_in_by ? ' (' + r.pass.checked_in_by + ')' : '') });
      }
      // Handed out offline here, but the package had already gone (another phone, or marked in admin).
      if (ev && ev.kind === 'PICKUP' && r.result === 'PICKED_ALREADY' && !r.replay && r.pass) {
        recent.unshift({ t: new Date().toISOString(), result: 'PICKUP_CONFLICT', pickup: true, email: r.pass.email, ref: r.pass.ref, note: 'first handed out ' + fmtWhen(r.pass.picked_up_at) + (r.pass.picked_up_by ? ' (' + r.pass.picked_up_by + ')' : '') });
      }
      // Scanned offline from an old list, but the pass belongs to another event. Not recorded on the server.
      if (ev && r.result === 'OTHER_EVENT') {
        recent.unshift({ t: new Date().toISOString(), result: ev.kind === 'PICKUP' ? 'PICKUP_VOID' : 'OTHER_VOID', pickup: ev.kind === 'PICKUP', ref: ev.ref, note: 'pass for ' + (r.event_name || 'another event') });
      }
      // Handed out offline here, but the order was refunded before this phone synced. Not recorded on the server.
      if (ev && ev.kind === 'PICKUP' && (r.result === 'CANCELLED' || r.result === 'UNPAID') && r.pass) {
        recent.unshift({ t: new Date().toISOString(), result: 'PICKUP_VOID', pickup: true, email: r.pass.email, ref: r.pass.ref, note: 'tell the organizer' });
      }
    });
    var done = {};
    batch.forEach(function (e) { done[e.client_id] = true; });
    queue = queue.filter(function (e) { return !done[e.client_id]; });
    saveQueue();
    store.set('door_recent', recent.slice(0, 30));
    return pushQueue();
  });
}
function syncNow(manual) {
  if (syncing || !KEY) return Promise.resolve();
  syncing = true;
  $('sync-btn').disabled = true;
  if (manual) $('sync-text').textContent = 'Syncing...';
  return pushQueue().then(function () { return api('/api/door/list'); }).then(function (data) {
    passes = data.passes || [];
    reapplyQueue();
    syncedAt = data.generated_at || new Date().toISOString();
    savePasses();
    store.set('door_synced_at', syncedAt);
  }).catch(function (err) {
    if (err.auth) signOut(err.message);
  }).then(function () {
    syncing = false;
    $('sync-btn').disabled = false;
    renderNet(); renderCounts(); renderRecent();
  });
}
$('sync-btn').addEventListener('click', function () { syncNow(true); });

// ---------- Manual search ----------
function statusOf(p) {
  if (p.status === 'PAID' && MODE === 'pickup') return p.picked_up_at ? ['Collected', 'st-in'] : ['To collect', 'st-ok'];
  if (p.status === 'PAID') return p.checked_in_at ? ['In ' + fmtTime(p.checked_in_at), 'st-in'] : ['Paid', 'st-ok'];
  if (p.status === 'RESERVED') return ['Not paid', 'st-warn'];
  return ['Cancelled', 'st-bad'];
}
function renderMatches() {
  var q = $('q').value.trim().toLowerCase();
  var box = $('matches'); box.replaceChildren();
  if (MODE === 'pickup') { renderPickupMatches(q, box); return; }
  if (q.length < 2) return;
  var list = passes.filter(function (p) { return p.ref.toLowerCase().indexOf(q) >= 0 || p.email.indexOf(q) >= 0; });
  list.sort(function (a, b) { return (RANK[b.status] || 0) - (RANK[a.status] || 0); });
  if (!list.length) { box.appendChild(el('p', 'No match in the guest list on this phone.', 'empty')); return; }
  list.slice(0, 8).forEach(function (p) {
    var b = el('button', undefined, 'match');
    b.type = 'button';
    var st = statusOf(p);
    b.appendChild(el('span', p.email, 'm-email'));
    b.appendChild(el('span', st[0], 'm-status ' + st[1]));
    b.appendChild(el('span', p.package + (MODE === 'pickup' && p.size ? ' · Size ' + p.size : '') + ' · ' + p.ref, 'm-sub'));
    b.addEventListener('click', function () { unlockAudio(); $('q').value = ''; box.replaceChildren(); $('q').blur(); handle({ ref: p.ref }, scanKind()); });
    box.appendChild(b);
  });
}
// Pickup: every word typed must be in the guest's name, email or reference, in any order, so "oneil mary" finds
// Mary-Ann O'Neil. The name leads each row, with the email under it.
function renderPickupMatches(q, box) {
  var words = q.length < 2 ? [] : foldWords(q);
  if (!words.length) { box.appendChild(el('p', 'Type their name, email or pass reference.', 'empty idle')); return; }
  var list = passes.filter(function (p) {
    var hay = fold(nameOf(p) + ' ' + p.email + ' ' + p.ref);
    return words.every(function (w) { return hay.indexOf(w) >= 0; });
  });
  list.sort(function (a, b) { return (RANK[b.status] || 0) - (RANK[a.status] || 0); });
  if (!list.length) { box.appendChild(el('p', 'No match on this phone. Try their email, or tap Sync now.', 'empty')); return; }
  var max = wide() ? 12 : 8;
  list.slice(0, max).forEach(function (p) {
    var b = el('button', undefined, 'match pick'), who = nameOf(p), st = statusOf(p);
    b.type = 'button';
    b.setAttribute('data-ref', p.ref);
    b.appendChild(el('span', who || p.email, who ? 'm-name' : 'm-email'));
    b.appendChild(el('span', st[0], 'm-status ' + st[1]));
    b.appendChild(el('span', who ? p.email : 'No name on file', who ? 'm-mail' : 'm-mail none'));
    var sub = el('span', p.package + (p.size ? ' · Size ' + p.size : '') + ' · ', 'm-sub');
    sub.appendChild(el('span', p.ref, 'm-ref'));
    b.appendChild(sub);
    b.addEventListener('click', function () { pickFromSearch(p.ref); });
    box.appendChild(b);
  });
  if (list.length > max) box.appendChild(el('p', (list.length - max) + ' more, keep typing', 'empty more'));
}
// A package that's ready to hand over goes to Check ID first. Anything else (not paid, cancelled, already
// collected) goes straight to its usual screen. The search stays until Next guest.
function pickFromSearch(ref) {
  unlockAudio();
  $('q').blur();
  searchFlow = true;
  var p = findPass({ ref: ref });
  if (p && decide(p, { ref: ref }, 'PICKUP').result === 'HANDED') { show({ result: 'CHECK_ID', pass: p }, false, true); return; }
  handle({ ref: ref }, 'PICKUP');
}
$('q').addEventListener('input', renderMatches);
if (wideMq) {
  var onWide = function () { if (MODE === 'pickup') renderMatches(); };
  if (wideMq.addEventListener) wideMq.addEventListener('change', onWide); else if (wideMq.addListener) wideMq.addListener(onWide);
}
$('search-form').addEventListener('submit', function (e) { e.preventDefault(); renderMatches(); });

// ---------- Camera ----------
var video = $('video'), stream = null, detector = null, scanning = false, lastText = '', lastAt = 0, wakeLock = null;
var canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });

function startCamera() {
  unlockAudio();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('cam-msg').textContent = 'This browser cannot use the camera. Use the search box instead.'; return; }
  $('cam-msg').textContent = 'Starting camera...';
  navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }).then(function (s) {
    stream = s;
    video.srcObject = s;
    var played = video.play();
    if (played && played.catch) played.catch(function () {});
    if ('BarcodeDetector' in window) { try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; } }
    if (!detector && !window.jsQR) $('cam-msg').textContent = 'Scanner did not load. Get signal and reload once, or use the search box.';
    $('cam').classList.add('on');
    scanning = true;
    keepAwake();
    loop();
  }, function () {
    $('cam-msg').textContent = 'Camera blocked. Allow camera access for this site in your browser settings, or use the search box.';
  });
}
function stopCamera() {
  scanning = false;
  if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
  stream = null;
  $('cam').classList.remove('on');
  $('cam-msg').textContent = camText();
  if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
}
function loop() {
  if (!scanning) return;
  tick().then(function () { setTimeout(loop, 140); }, function () { setTimeout(loop, 140); });
}
function tick() {
  if (busy || video.readyState < 2) return Promise.resolve();
  if (detector) {
    return detector.detect(video).then(function (codes) {
      if (codes && codes.length) onCode(codes[0].rawValue);
    }, function () { detector = null; });
  }
  if (window.jsQR) {
    var w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return Promise.resolve();
    var scale = Math.min(1, 720 / Math.max(w, h));
    canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    if (code && code.data) onCode(code.data);
  }
  return Promise.resolve();
}
function onCode(text) {
  if (busy || !text) return;
  if (text === lastText && Date.now() - lastAt < 5000) return;
  lastText = text; lastAt = Date.now();
  // A scanned pass identifies the guest by itself, so it never goes through Check ID.
  searchFlow = false;
  handle(parse(text), scanKind());
}
function keepAwake() {
  try { if (navigator.wakeLock && !wakeLock) navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; l.addEventListener('release', function () { wakeLock = null; }); }, function () {}); } catch (e) {}
}
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible') return;
  if (scanning) {
    var live = stream && stream.getVideoTracks().some(function (t) { return t.readyState === 'live'; });
    if (!live) stopCamera(); else keepAwake();
  }
  if (KEY) syncNow();
});
$('cam-btn').addEventListener('click', startCamera);
$('cam-stop').addEventListener('click', stopCamera);

// ---------- Entry / Pickup ----------
// Pickup is for handing out packages before the event: a scan marks the package collected and shows the size.
// It never checks anyone in, so a phone left in Pickup mode can't use up a guest's entry.
var modeInputs = Array.prototype.slice.call(document.querySelectorAll('input[name=mode]'));
function scanKind() { return MODE === 'pickup' ? 'PICKUP' : 'ENTRY'; }
function camText() {
  return MODE === 'pickup' ? "Point the camera at the guest's pass to hand out their package. This does not check them in." : "Point the camera at the QR code on the guest's pass.";
}
function setMode(m) {
  MODE = m === 'pickup' ? 'pickup' : 'entry';
  store.set('door_mode', MODE);
  document.body.classList.toggle('pickup', MODE === 'pickup');
  modeInputs.forEach(function (i) { i.checked = i.value === MODE; });
  $('cam-msg').textContent = camText();
  $('cam-hint').textContent = MODE === 'pickup' ? 'Pickup · hold the pass inside the frame' : 'Hold the pass inside the frame';
  var ph = MODE === 'pickup' ? 'Search name, email or reference' : 'No QR? Search email or reference';
  $('q').placeholder = ph;
  $('q').setAttribute('aria-label', ph);
  renderCounts(); renderMatches();
}
modeInputs.forEach(function (i) { i.addEventListener('change', function () { if (i.checked) setMode(i.value); }); });

// ---------- Sign in / out ----------
function showMain() {
  $('signin').classList.add('hidden');
  $('main').classList.remove('hidden');
  $('device-name').textContent = DEVICE || 'Door';
  renderNet(); renderCounts(); renderRecent();
}
function showSignin(msg) {
  $('main').classList.add('hidden');
  $('signin').classList.remove('hidden');
  $('device').value = DEVICE || '';
  $('signin-msg').textContent = msg || '';
}
function signOut(msg) {
  stopCamera();
  KEY = '';
  store.del('door_key');
  showSignin(msg || '');
}
$('signout').addEventListener('click', function () {
  var what = queue.some(function (e) { return e.kind === 'PICKUP' || e.kind === 'PICKUP_UNDO'; }) ? ' scans' : ' check-ins';
  if (queue.length && !window.confirm(queue.length + what + ' have not synced yet. They stay on this phone and sync after you sign back in. Sign out anyway?')) return;
  passes = queue.length ? passes : [];
  if (!queue.length) { savePasses(); store.del('door_synced_at'); syncedAt = null; recent = []; store.set('door_recent', recent); }
  signOut('Signed out.');
});
$('signin-form').addEventListener('submit', function (e) {
  e.preventDefault();
  var key = $('key').value.trim(), device = $('device').value.trim();
  if (!key || !device) return;
  $('signin-msg').textContent = 'Checking...';
  KEY = key;
  api('/api/door/list').then(function (data) {
    DEVICE = device;
    store.set('door_key', KEY); store.set('door_device', DEVICE);
    passes = data.passes || [];
    reapplyQueue();
    syncedAt = data.generated_at || new Date().toISOString();
    savePasses(); store.set('door_synced_at', syncedAt);
    $('key').value = '';
    showMain();
    if (queue.length) syncNow();
  }, function (err) {
    KEY = '';
    $('signin-msg').textContent = err.auth ? 'Wrong staff password.' : 'No connection. You need signal once to sign in and download the guest list.';
  });
});

window.addEventListener('online', function () { setOnline(true); if (KEY) syncNow(); });
window.addEventListener('offline', function () { setOnline(false); });
setInterval(function () { if (KEY && !busy) syncNow(); }, 20000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/door-sw.js', { scope: '/door' }).catch(function () {});

setMode(MODE);
if (KEY && DEVICE) { showMain(); syncNow(); } else { showSignin(); }
</script>
</body>
</html>`;
