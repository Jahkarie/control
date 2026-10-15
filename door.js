// door.js: door check-in for event night.
// Staff open /door on their phones and sign in with DOOR_KEY (the admin key also works).
// Each phone keeps a copy of the guest list, so scanning still works with no signal;
// check-ins made offline sync to the server as soon as the phone is back online.
// The same scanner has a Pickup mode for handing out packages: a scan marks the package collected
// (once per order) and shows the guest's size. Pickup can also be marked from /admin/pickup (pickup.js).

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
  const PASS_SQL = `SELECT o.id, o.reference_code AS ref, LOWER(o.guest_email) AS email, o.status,
      o.checked_in_at, o.checked_in_by, (o.cancel_requested_at IS NOT NULL) AS refund_requested,
      o.size, o.picked_up_at, o.picked_up_by,
      p.name AS package, p.requires_compliance AS costume, (TRIM(REPLACE(p.sizes, ',', '')) <> '') AS sized
    FROM orders o JOIN packages p ON p.id = o.package_id`;

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
      if (!now || now.status !== 'PAID') return { result: 'CANCELLED', pass: { ...pass, ...now } };
      await record(pass.id, 'PICKUP_DUP', clientId, device, at);
      return { result: 'PICKED_ALREADY', pass: { ...pass, ...now } };
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
    if (!cur || cur.status !== 'PAID') return { result: 'CANCELLED', pass: { ...pass, ...cur } };
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
      const r = await pool.query(`${PASS_SQL} ORDER BY o.id ASC`);
      res.json({ generated_at: new Date().toISOString(), passes: r.rows });
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

  // Door log for the Command Center.
  app.get('/api/admin/checkins', requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT c.id, c.kind, c.device, c.scanned_at, c.synced_at, o.reference_code AS ref, o.guest_email AS email, p.name AS package
         FROM checkins c JOIN orders o ON o.id = c.order_id JOIN packages p ON p.id = o.package_id
         ORDER BY c.scanned_at DESC, c.id DESC LIMIT 500`);
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
<meta name="theme-color" content="#09080b">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="ODR Door">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Door | On D' Road</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js" defer></script>
<style>
/* Paint & Powder, door edition: black canvas, neon paint, sticker buttons. Results stay flat, full-screen colour
   so they read at a glance in a dark street: green = in, red = stop, yellow = not paid. */
/* If the web fonts never load, headlines fall back to a local narrow bold font so the big words still fit. */
@font-face { font-family: 'Display Narrow'; font-weight: 100 900; src: local('Arial Narrow Bold'), local('ArialNarrow-Bold'), local('Roboto Condensed Bold'), local('RobotoCondensed-Bold'); }
@font-face { font-family: 'Display Wide'; font-weight: 100 900; size-adjust: 74%; src: local('Arial Bold'), local('Arial-BoldMT'), local('Helvetica Neue Bold'), local('HelveticaNeue-Bold'), local('Roboto Bold'), local('Roboto-Bold'), local('Liberation Sans Bold'), local('LiberationSans-Bold'), local('DejaVu Sans Bold'), local('DejaVuSans-Bold'); }
:root {
  --bg: #09080b; --surface: #131117; --surface-2: #1b1820; --well: #0c0b0f;
  --line: rgba(246, 241, 232, .10); --line-strong: rgba(246, 241, 232, .24);
  --text: #f6f1e8; --muted: #b4adbb; --dim: #8f8898; --ink: #0b0a0d; --paper: #f6f1e8;
  --pink: #ff2e93; --yellow: #ffe500; --cyan: #1ee3ff; --lime: #a3ff2b; --red: #ff4d4d;
  --accent: var(--pink); --accent-ink: var(--ink);
  /* --go is the brand lime pushed toward green, so ADMIT never reads as the yellow warning. */
  --go: #6dff45; --good: var(--lime); --warn: var(--yellow); --bad: var(--red);
  --display: 'Archivo', 'Display Narrow', 'Display Wide', Impact, sans-serif;
  --body: 'Archivo', system-ui, -apple-system, sans-serif;
  --mono: 'Space Mono', ui-monospace, monospace;
  --m-splat: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200' preserveAspectRatio='none'%3E%3Cpath d='M143.6 100C143.3 100.7 143 101.4 142.8 102.1C142.7 102.8 142.7 103.4 142.8 104.1C142.9 104.9 143.1 105.6 143.4 106.3C143.7 107.1 143.9 107.8 144.4 108.7C144.8 109.5 145.2 110.3 146.2 111.4C147.3 112.5 149.1 113.8 150.6 115.1C152.2 116.5 155 118.4 155.3 119.5C155.7 120.5 154.9 121.4 152.7 121.5C150.6 121.5 145.7 120.4 142.4 119.7C139.1 119 135.4 117.8 133.1 117.4C130.8 116.9 129.7 116.8 128.7 116.9C127.6 116.9 127.4 117.3 126.9 117.6C126.4 117.9 126.2 118.4 125.8 118.7C125.4 119.1 125.1 119.5 124.7 119.8C124.3 120.2 123.8 120.5 123.5 120.8C123.1 121.1 122.7 121.5 122.4 121.9C122.1 122.3 121.8 122.7 121.6 123.2C121.4 123.8 121.3 124.4 121.1 125C120.9 125.6 120.7 126.3 120.5 126.8C120.3 127.4 120 128 119.6 128.4C119.2 128.8 118.7 129.1 118.2 129.3C117.7 129.5 117.1 129.6 116.5 129.6C115.9 129.7 115.3 129.7 114.7 129.8C114.2 130 113.7 130.1 113.3 130.5C112.8 130.9 112.5 131.4 112.2 132.1C111.8 132.8 111.6 133.8 111.3 134.7C111 135.6 110.7 136.8 110.3 137.7C109.9 138.6 109.4 139.6 108.9 140.2C108.4 140.8 107.7 141.3 107.1 141.6C106.5 141.8 105.7 141.8 105.1 141.6C104.4 141.5 103.6 141.1 103 140.7C102.3 140.4 101.6 139.9 101 139.6C100.3 139.2 99.7 138.9 99.1 138.7C98.4 138.5 97.8 138.5 97.2 138.4C96.6 138.4 96 138.4 95.3 138.4C94.7 138.4 94.1 138.4 93.4 138.4C92.8 138.3 92.2 138.2 91.6 138.1C91 138 90.4 137.7 89.7 137.8C89 137.8 88.5 137.7 87.5 138.5C86.5 139.4 85.6 140.3 83.7 143C81.9 145.6 79.5 149.5 76.4 154.2C73.3 158.9 68.3 166.8 64.9 171.1C61.4 175.3 56.7 180.5 55.6 179.8C54.6 179.1 56.5 172.2 58.4 167C60.3 161.7 64.9 152.6 66.8 148.2C68.6 143.7 69.5 141.4 69.3 140.2C69 139 66.9 140.6 65.3 141.1C63.7 141.7 60.9 143.3 59.6 143.4C58.3 143.5 57.4 142.8 57.4 141.6C57.3 140.4 58.5 137.9 59.2 136.1C59.9 134.3 61.2 132.2 61.7 130.8C62.1 129.4 62.3 128.3 62 127.6C61.6 126.9 60.7 126.7 59.4 126.6C58.2 126.4 56.1 126.8 54.5 126.8C52.9 126.7 50.6 126.9 49.6 126.4C48.7 125.9 48.2 125 48.8 123.8C49.4 122.6 51.4 120.6 53.3 119C55.1 117.4 57.9 115.6 59.8 114.1C61.8 112.7 63.6 111.5 65 110.5C66.3 109.4 67.2 108.7 67.9 107.9C68.7 107.2 69.1 106.6 69.4 106C69.8 105.4 70 104.9 70 104.4C70.1 103.9 70 103.4 69.8 102.9C69.6 102.5 69.2 102 68.8 101.5C68.4 101 68 100.5 67.6 100C67.3 99.5 67.1 98.9 66.8 98.4C66.5 97.8 66.7 97.4 65.9 96.7C65 96 64.5 95.5 61.8 94.4C59 93.3 54.7 92 49.5 90.1C44.4 88.2 36.3 85.4 30.9 83C25.5 80.5 20.1 77.5 17.2 75.3C14.3 73.1 14 71.3 13.4 69.5C12.8 67.8 13.4 66.4 13.5 64.8C13.7 63.2 13.3 61.4 14.3 60.2C15.2 59 16.4 57.7 19.2 57.6C22 57.5 26.6 58.3 31.1 59.5C35.6 60.6 41.7 63 46.1 64.7C50.5 66.3 54.6 68.1 57.6 69.2C60.5 70.2 62.1 70.6 63.5 70.7C65 70.9 65.5 70.4 66.2 70.1C67 69.7 67.4 69.1 68 68.7C68.6 68.3 69.2 67.9 69.8 67.6C70.5 67.3 71.3 67.1 72 66.8C72.7 66.6 73.6 66.6 74.1 66.2C74.7 65.8 75.3 65.5 75.5 64.5C75.7 63.5 75.6 62.2 75.2 60C74.8 57.9 73.8 54.8 73.2 51.8C72.6 48.9 71.6 44.7 71.5 42.4C71.5 40.1 72 38.2 73 38C74 37.8 76.5 41.1 77.7 41.2C78.9 41.3 79.6 40.7 80.1 38.6C80.6 36.6 79.1 26.9 80.6 28.8C82.1 30.8 86.8 44.2 89 50.3C91.2 56.3 92.9 62.5 94 65.1C95.2 67.8 95.3 66.1 95.9 66.1C96.5 66.1 96.9 65.3 97.5 64.9C98 64.5 98.5 63.9 99.1 63.6C99.7 63.2 100.3 62.9 100.9 62.8C101.5 62.6 102.1 62.6 102.7 62.6C103.3 62.7 103.9 62.9 104.5 63C105.1 63.1 105.6 63.4 106.3 63.4C106.9 63.4 107.4 63.5 108.2 63C109 62.4 109.7 61.7 110.9 60C112.1 58.3 113.7 55.3 115.4 52.6C117.1 49.9 119.7 45.4 121.3 43.8C122.9 42.2 124.7 41.1 124.9 42.9C125.1 44.6 123.6 50.4 122.6 54.4C121.5 58.3 119.4 63.6 118.7 66.4C117.9 69.2 117.9 70.1 118 70.9C118.2 71.8 119 71.4 119.7 71.5C120.3 71.5 121.2 71.3 121.9 71.4C122.6 71.4 123.3 71.5 123.9 71.7C124.4 72 124.8 72.5 125.1 73C125.4 73.6 125.5 74.3 125.5 75.1C125.6 75.8 125.4 76.7 125.5 77.4C125.5 78.1 125.3 78.9 125.9 79.2C126.4 79.5 126.8 79.8 128.6 79.2C130.5 78.6 133.4 77.2 137.2 75.6C140.9 74.1 147.3 71.1 151.3 69.9C155.2 68.6 159.9 67.4 161 68C162 68.6 159.8 71.2 157.6 73.3C155.3 75.4 150.3 78.6 147.7 80.6C145 82.6 142.9 84.1 141.8 85.3C140.7 86.5 141 87 141.1 87.7C141.2 88.4 142 88.9 142.5 89.5C143 90.1 143.7 90.7 144.2 91.4C144.6 92 145 92.7 145.3 93.4C145.5 94.1 145.5 94.9 145.4 95.6C145.3 96.3 145 97.1 144.7 97.8C144.4 98.6 143.9 99.3 143.6 100ZM58.3 171.2a2.9 2.9 0 1 1 5.9 0a2.9 2.9 0 1 1 -5.9 0ZM22.5 79.8a4.5 4.5 0 1 1 9 0a4.5 4.5 0 1 1 -9 0ZM121.8 45a2.8 2.8 0 1 1 5.5 0a2.8 2.8 0 1 1 -5.5 0ZM76 25a3.7 3.7 0 1 1 7.5 0a3.7 3.7 0 1 1 -7.5 0ZM66 30.3a3.2 3.2 0 1 1 6.5 0a3.2 3.2 0 1 1 -6.5 0ZM164.1 64.9a2.9 2.9 0 1 1 5.8 0a2.9 2.9 0 1 1 -5.8 0ZM23 60.8a2.8 2.8 0 1 1 5.5 0a2.8 2.8 0 1 1 -5.5 0ZM50.8 148.1a2.7 2.7 0 1 1 5.3 0a2.7 2.7 0 1 1 -5.3 0ZM36.4 129a3.6 3.6 0 1 1 7.1 0a3.6 3.6 0 1 1 -7.1 0ZM22.9 72.6a4.5 4.5 0 1 1 9 0a4.5 4.5 0 1 1 -9 0ZM156.5 123.5a4.4 4.4 0 1 1 8.7 0a4.4 4.4 0 1 1 -8.7 0ZM49.3 44.4a1.8 1.8 0 1 1 3.6 0a1.8 1.8 0 1 1 -3.6 0ZM65.7 19.5a1.9 1.9 0 1 1 3.8 0a1.9 1.9 0 1 1 -3.8 0ZM98.3 172a1.2 1.2 0 1 1 2.4 0a1.2 1.2 0 1 1 -2.4 0ZM36.2 150.9a1.1 1.1 0 1 1 2.2 0a1.1 1.1 0 1 1 -2.2 0ZM120.4 54a1 1 0 1 1 1.9 0a1 1 0 1 1 -1.9 0ZM177.4 141.9a1.3 1.3 0 1 1 2.6 0a1.3 1.3 0 1 1 -2.6 0ZM140 152.4a1 1 0 1 1 2.1 0a1 1 0 1 1 -2.1 0ZM170.5 60.2a4 4 0 1 1 8 0a4 4 0 1 1 -8 0ZM165.7 56.6a0.7 0.7 0 1 1 1.4 0a0.7 0.7 0 1 1 -1.4 0ZM99.8 150.7a0.7 0.7 0 1 1 1.4 0a0.7 0.7 0 1 1 -1.4 0ZM107 177.9a2.1 2.1 0 1 1 4.2 0a2.1 2.1 0 1 1 -4.2 0ZM105.3 184.1a1.1 1.1 0 1 1 2.1 0a1.1 1.1 0 1 1 -2.1 0ZM140.6 67.7a0.7 0.7 0 1 1 1.4 0a0.7 0.7 0 1 1 -1.4 0ZM162.5 61.5a0.8 0.8 0 1 1 1.6 0a0.8 0.8 0 1 1 -1.6 0ZM141.8 67.5a3 3 0 1 1 6 0a3 3 0 1 1 -6 0ZM73.9 47a0.9 0.9 0 1 1 1.8 0a0.9 0.9 0 1 1 -1.8 0ZM51.4 80.4a3 3 0 1 1 5.9 0a3 3 0 1 1 -5.9 0ZM84 33.4a0.7 0.7 0 1 1 1.4 0a0.7 0.7 0 1 1 -1.4 0ZM143 74.2a3.3 3.3 0 1 1 6.6 0a3.3 3.3 0 1 1 -6.6 0ZM177.8 119.5a4.3 4.3 0 1 1 8.6 0a4.3 4.3 0 1 1 -8.6 0ZM175.1 77.5a1.1 1.1 0 1 1 2.3 0a1.1 1.1 0 1 1 -2.3 0ZM87.1 16.5a1.1 1.1 0 1 1 2.2 0a1.1 1.1 0 1 1 -2.2 0Z'/%3E%3C/svg%3E");
  --m-drip: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 70' preserveAspectRatio='none'%3E%3Cpath d='M0 7.3L0 7.3L5 3.3L10 3.4L15 3.6L20 3.9L25 4.3L30 4.6L35 4.8L40 5L45 5.1L50 5.1L55 5.1L60 5L65 4.9L70 4.8L75 4.8L80 4.8L85 5L90 5.2L95 5.6L100 6.1L105 6.5L110 7L115 7.4L120 7.7L125 7.9L130 8L135 7.9L140 7.7L145 7.4L150 6.9L155 6.5L160 6.1L165 5.7L170 5.4L175 5.2L180 5.1L185 5.1L190 5.1L195 5.2L200 5.3L205 5.4L210 5.4L215 5.3L220 5.1L225 4.8L230 4.5L235 4.1L240 3.8L245 3.5L250 3.2L255 3.1L260 3.2L265 3.3L270 3.6L275 4.1L280 4.5L285 5.1L290 5.6L295 6L300 6.4L305 6.6L310 6.8L315 6.8L320 9.7L320 12.6L315 16.2L310 16.9L305 17.8L300 18.7L295 19.2L290 18.8L285 17.6L280 16.3L275 15.3L270 14.7L265 14.3L260 14.1L255 14.1L250 14.2L245 14.4L240 14.7L235 15.6L230 16.6L225 15.5L220 14.2L215 13.6L210 13.4L205 13.4L200 14.1L195 15.8L190 16.2L185 15.5L180 15.7L175 16.3L170 16.8L165 17.4L160 18.4L155 18.8L150 17.7L145 16.5L140 16.1L135 16.5L130 17.2L125 17.6L120 17.2L115 16.5L110 16L105 15.6L100 15.3L95 14.8L90 14.2L85 13.7L80 13.3L75 13.3L70 14.1L65 15.1L60 15.3L55 14.8L50 14.7L45 15L40 15.4L35 15.7L30 16.6L25 17.8L20 17L15 15.8L10 15.4L5 15.5L0 12.7ZM28.9 14Q25.9 14 25.9 19L25.5 30.9A2.5 2.5 0 1 1 22.4 30.9L22 19Q22 14 19 14ZM69 14Q66 14 66 19L65.5 45.1A3.4 3.4 0 1 1 61.1 45.1L60.6 19Q60.6 14 57.6 14ZM61.5 52.9a1.8 1.8 0 1 1 3.5 0a1.8 1.8 0 1 1 -3.5 0ZM131.9 14Q128.9 14 128.9 19L128.3 28.8A4 4 0 1 1 123.1 28.8L122.4 19Q122.4 14 119.4 14ZM160.7 14Q157.7 14 157.7 19L157.2 44.2A3 3 0 1 1 153.3 44.2L152.9 19Q152.9 14 149.9 14ZM197.8 14Q194.8 14 194.8 19L194.4 54.6A2.3 2.3 0 1 1 191.5 54.6L191.1 19Q191.1 14 188.1 14ZM234.6 14Q231.6 14 231.6 19L231.2 36.8A2.4 2.4 0 1 1 228.1 36.8L227.7 19Q227.7 14 224.7 14ZM228.4 44.4a1.3 1.3 0 1 1 2.5 0a1.3 1.3 0 1 1 -2.5 0ZM299.6 14Q296.6 14 296.6 19L295.9 30.8A4.2 4.2 0 1 1 290.5 30.8L289.8 19Q289.8 14 286.8 14Z'/%3E%3C/svg%3E");
  --torn: polygon(0 14%, 3% 0, 22% 7%, 46% 0, 71% 6%, 93% 0, 100% 9%, 97% 34%, 100% 58%, 97% 82%, 100% 100%, 78% 93%, 53% 100%, 28% 94%, 6% 100%, 0 88%, 3% 63%, 0 38%);
  /* Entry is pink, Pickup is cyan: the switch, the count, the camera border and its frame all follow. */
  --mode: var(--pink); --mode-pop: var(--yellow);
}
body.pickup { --mode: var(--cyan); --mode-pop: var(--pink); }
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 var(--body); -webkit-font-smoothing: antialiased; overscroll-behavior: none; overflow-x: hidden; }
::selection { background: var(--yellow); color: var(--ink); }
.hidden { display: none !important; }
:focus-visible { outline: 3px solid var(--cyan); outline-offset: 3px; }
.wrap { position: relative; max-width: 520px; margin: 0 auto; padding: max(16px, env(safe-area-inset-top)) 16px max(28px, env(safe-area-inset-bottom)); }

/* Wordmark: ON D' ROAD with the yellow apostrophe; the phone's name is a strip of tape. */
.brand { font-family: var(--display); font-weight: 900; font-stretch: 62%; font-size: 27px; line-height: 1.1; letter-spacing: .01em; text-transform: uppercase; }
.brand span { color: var(--yellow); }
.brand em {
  display: inline-block; max-width: 56vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; position: relative; top: -3px;
  margin-left: 10px; padding: 5px 10px 4px; font-style: normal; font-family: var(--mono); font-stretch: 100%; font-size: 10.5px; font-weight: 700; line-height: 1.3; letter-spacing: .14em; text-transform: uppercase;
  color: var(--ink); background: var(--mode); clip-path: var(--torn); transform: rotate(-3deg);
}

input { width: 100%; font: 500 16px var(--body); color: var(--text); background: var(--well); border: 2px solid rgba(246, 241, 232, .16); border-radius: 8px; padding: 14px 15px; -webkit-appearance: none; appearance: none; transition: border-color .2s, box-shadow .2s; }
input::placeholder { color: var(--dim); }
input:focus { outline: none; border-color: var(--cyan); box-shadow: 0 0 0 4px rgba(30, 227, 255, .16), 0 0 26px -6px rgba(30, 227, 255, .55); }

/* Buttons: neon stickers with an ink die-cut edge and a misprinted shadow. */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 16px 22px 15px; cursor: pointer;
  font-family: var(--display); font-weight: 900; font-stretch: 75%; font-size: 20px; line-height: 1; letter-spacing: .05em; text-transform: uppercase;
  color: var(--ink); background: var(--yellow); border: 0; border-radius: 999px;
  box-shadow: 0 0 0 3px var(--ink), 5px 6px 0 3px var(--pink); transform: rotate(-.8deg); transition: transform .15s, box-shadow .2s;
}
.btn:active { transform: translate(3px, 3px); box-shadow: 0 0 0 3px var(--ink), 2px 2px 0 3px var(--pink); }
.btn:disabled { opacity: .5; cursor: default; }
.btn.ghost { background: transparent; color: var(--text); box-shadow: inset 0 0 0 2px var(--line-strong); transform: none; }
.btn.ghost:active { transform: translateY(1px); box-shadow: inset 0 0 0 2px var(--cyan); }
.btn.small { padding: 10px 14px 9px; font-size: 15px; letter-spacing: .06em; }
@media (hover: hover) {
  .btn:hover { transform: rotate(0) translateY(-2px); box-shadow: 0 0 0 3px var(--ink), 6px 8px 0 3px var(--pink), 0 0 30px rgba(255, 229, 0, .3); }
  .btn.ghost:hover { color: var(--cyan); transform: none; box-shadow: inset 0 0 0 2px var(--cyan); }
}

/* ---------- Sign in ---------- */
.signin { min-height: 100%; display: flex; flex-direction: column; justify-content: center; isolation: isolate; }
/* Paint thrown at the corners of the screen */
.signin::before, .signin::after { content: ''; position: fixed; z-index: -1; pointer-events: none; -webkit-mask: var(--m-splat) center / contain no-repeat; mask: var(--m-splat) center / contain no-repeat; }
.signin::before { width: 330px; height: 330px; top: -120px; right: -150px; background: var(--pink); transform: rotate(18deg); }
.signin::after { width: 220px; height: 220px; bottom: -96px; left: -104px; background: var(--cyan); opacity: .85; transform: rotate(-50deg); }
.signin h1 {
  position: relative; width: fit-content; margin: 30px 0 40px;
  font-family: var(--display); font-weight: 900; font-stretch: 62%; font-size: 84px; line-height: .84; letter-spacing: .005em; text-transform: uppercase; color: var(--text);
  text-shadow: -.012em -.012em 0 var(--ink), .012em -.012em 0 var(--ink), -.012em .012em 0 var(--ink), .012em .012em 0 var(--ink), .045em .045em 0 var(--ink), .075em .07em 0 var(--pink);
}
/* A neon drip hanging off the heading */
.signin h1::after {
  content: ''; position: absolute; left: .02em; right: -.04em; top: calc(100% - .03em); height: .26em; z-index: -1;
  background: var(--pink); -webkit-mask: var(--m-drip) left top / 100% 100% no-repeat; mask: var(--m-drip) left top / 100% 100% no-repeat;
  animation: drip-down 1.3s .2s cubic-bezier(.5, 0, .3, 1) both;
}
@keyframes drip-down { from { clip-path: inset(0 0 100% 0); } to { clip-path: inset(0 0 0 0); } }
.signin p.lead { color: var(--muted); font-size: 16px; margin: 0 0 22px; max-width: 420px; }
.signin label { display: block; font-family: var(--mono); font-size: 11.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 18px 0 8px; }
.signin .btn { width: 100%; margin-top: 28px; }
.msg { min-height: 22px; margin: 16px 0 0; font-size: 14.5px; font-weight: 600; color: var(--red); }

/* ---------- Main ---------- */
.bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 12px; margin-bottom: 16px; padding-bottom: 14px; border-bottom: 2px dashed var(--line); }
.bar .brand { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 3px 0; }
.bar .net { flex: none; }
.net { display: inline-flex; align-items: center; gap: 7px; padding: 6px 11px 5px; border-radius: 999px; border: 2px solid currentColor; font-family: var(--mono); font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
.net i { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.net.ok { color: var(--good); }
.net.warn { color: var(--warn); }
/* Offline is a yellow sticker, hard to miss */
.net.off { color: var(--ink); background: var(--warn); border-color: var(--warn); box-shadow: 2px 3px 0 var(--pink); transform: rotate(-2deg); }
.count { position: relative; isolation: isolate; display: flex; align-items: baseline; gap: 12px; margin: 6px 0 18px; color: var(--muted); font-family: var(--mono); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.count::before {
  content: ''; position: absolute; z-index: -1; left: -30px; top: -26px; width: 120px; height: 120px; opacity: .22; pointer-events: none;
  background: var(--mode); -webkit-mask: var(--m-splat) center / contain no-repeat; mask: var(--m-splat) center / contain no-repeat; transform: rotate(-20deg);
}
.count b#in-count {
  font-family: var(--display); font-weight: 900; font-stretch: 62%; font-size: 76px; line-height: .86; letter-spacing: 0; color: var(--text);
  text-shadow: .04em .04em 0 var(--ink), .07em .065em 0 var(--mode);
}
.count span b { color: var(--text); font-weight: 700; }

/* Entry / Pickup switch. The chosen mode is a sticker in its colour; Pickup tints everything cyan. */
.mode { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 5px; margin: 0 0 18px; border: 2px solid var(--line-strong); border-radius: 999px; background: var(--well); }
.mode label { position: relative; display: block; cursor: pointer; }
.mode input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; opacity: 0; cursor: pointer; }
.mode span {
  display: block; padding: 13px 10px 12px; border-radius: 999px; text-align: center;
  font-family: var(--display); font-weight: 900; font-stretch: 75%; font-size: 19px; line-height: 1; letter-spacing: .07em; text-transform: uppercase;
  color: var(--muted); transition: background .15s, color .15s, transform .15s, box-shadow .15s;
}
.mode input:checked + span { background: var(--mode); color: var(--ink); box-shadow: 0 0 0 2px var(--ink), 3px 4px 0 2px var(--mode-pop); transform: rotate(-1.5deg); }
.mode input:focus-visible + span { outline: 3px solid var(--text); outline-offset: 3px; }

.cam { position: relative; aspect-ratio: 1; border-radius: 16px; overflow: hidden; background: #000; border: 2px solid var(--mode); }
.cam video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .3s; }
.cam.on video { opacity: 1; }
.frame { position: absolute; inset: 17%; border-radius: 18px; pointer-events: none; opacity: 0; transition: opacity .3s;
  background:
    linear-gradient(var(--mode), var(--mode)) top left / 38px 5px no-repeat,
    linear-gradient(var(--mode), var(--mode)) top left / 5px 38px no-repeat,
    linear-gradient(var(--mode), var(--mode)) top right / 38px 5px no-repeat,
    linear-gradient(var(--mode), var(--mode)) top right / 5px 38px no-repeat,
    linear-gradient(var(--mode), var(--mode)) bottom left / 38px 5px no-repeat,
    linear-gradient(var(--mode), var(--mode)) bottom left / 5px 38px no-repeat,
    linear-gradient(var(--mode), var(--mode)) bottom right / 38px 5px no-repeat,
    linear-gradient(var(--mode), var(--mode)) bottom right / 5px 38px no-repeat; }
.cam.on .frame { opacity: 1; }
.frame::after { content: ''; position: absolute; left: 8%; right: 8%; top: 50%; height: 3px; border-radius: 3px; background: var(--mode); box-shadow: 0 0 16px var(--mode); opacity: .85; animation: sweep 2.4s ease-in-out infinite; }
@keyframes sweep { 0%, 100% { top: 12%; } 50% { top: 88%; } }
.cam-idle { position: absolute; inset: 0; isolation: isolate; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; padding: 24px; text-align: center; }
.cam-idle::before {
  content: ''; position: absolute; z-index: -1; width: 86%; aspect-ratio: 1; left: 7%; top: 4%; opacity: .2; pointer-events: none;
  background: var(--mode); -webkit-mask: var(--m-splat) center / contain no-repeat; mask: var(--m-splat) center / contain no-repeat; transform: rotate(24deg);
}
.cam.on .cam-idle { display: none; }
.cam-idle .btn { box-shadow: 0 0 0 3px var(--ink), 5px 6px 0 3px var(--mode); }
.cam-idle .btn:active { box-shadow: 0 0 0 3px var(--ink), 2px 2px 0 3px var(--mode); }
.cam-idle p { margin: 0; color: var(--text); font-size: 15px; font-weight: 500; max-width: 270px; text-shadow: 0 1px 10px var(--bg); }
.cam-hint { position: absolute; left: 0; right: 0; bottom: 12px; margin: 0; text-align: center; font-family: var(--mono); font-size: 11.5px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: #fff; text-shadow: 0 1px 6px rgba(0, 0, 0, .9); }
.cam:not(.on) .cam-hint { display: none; }
.btn.cam-stop { position: absolute; top: 10px; right: 10px; padding: 8px 13px 7px; font-size: 14px; background: rgba(0, 0, 0, .6); color: #fff; box-shadow: inset 0 0 0 2px rgba(255, 255, 255, .45); }
.cam:not(.on) .cam-stop { display: none; }

.search { display: flex; gap: 8px; margin-top: 18px; }
.search input { flex: 1; min-width: 0; }
.matches { display: grid; gap: 8px; margin-top: 10px; }
.match { display: grid; grid-template-columns: 1fr auto; gap: 3px 12px; align-items: center; text-align: left; width: 100%; padding: 13px 14px; border-radius: 10px; border: 2px solid var(--line); background: var(--surface); color: var(--text); font: inherit; cursor: pointer; transition: border-color .15s; }
.match:active { border-color: var(--mode); }
.match .m-email { font-weight: 700; overflow-wrap: anywhere; }
.match .m-sub { grid-column: 1; font-size: 12px; color: var(--muted); font-family: var(--mono); }
.match .m-status { grid-column: 2; grid-row: 1 / span 2; font-family: var(--mono); font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.st-ok { color: var(--good); } .st-in { color: var(--muted); } .st-warn { color: var(--warn); } .st-bad { color: var(--bad); }
.empty { color: var(--muted); font-size: 14px; margin: 4px 2px; }

/* Section label: a strip of torn tape */
h2 {
  width: fit-content; margin: 32px 0 12px; padding: 6px 12px 5px;
  font-family: var(--mono); font-size: 11px; font-weight: 700; line-height: 1.2; letter-spacing: .16em; text-transform: uppercase;
  color: var(--ink); background: var(--yellow); clip-path: var(--torn); transform: rotate(-2deg); transform-origin: left center;
}
.recent { list-style: none; margin: 0; padding: 0; border: 2px solid var(--line); border-radius: 12px; overflow: hidden; background: var(--surface); }
.recent li { display: grid; grid-template-columns: 12px 1fr auto; gap: 3px 12px; align-items: center; padding: 12px 14px; border-top: 2px dashed var(--line); }
.recent li:first-child { border-top: 0; }
/* Paint-drop dots */
.recent .dot { width: 10px; height: 10px; border-radius: 50% 50% 50% 8%; transform: rotate(-30deg); }
.recent .who { font-weight: 700; font-size: 14px; overflow-wrap: anywhere; }
.recent .what { grid-column: 2 / span 2; font-size: 12.5px; color: var(--muted); }
.recent .when { font-family: var(--mono); font-size: 11px; color: var(--dim); }
.recent .none { display: block; padding: 16px 14px; color: var(--dim); font-size: 14px; }
.dot.ok { background: var(--good); } .dot.bad { background: var(--bad); } .dot.warn { background: var(--warn); } .dot.neutral { background: var(--dim); }

.foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 26px; padding-top: 18px; border-top: 2px dashed var(--line); }
.foot .sync-text { flex: 1; min-width: 150px; font-family: var(--mono); font-size: 11.5px; color: var(--muted); }

/* ---------- Full-screen result ----------
   Flat, loud colour first; the paint (an ink splat and a drip off the top edge) stays in the background.
   The page scrolls if a long result doesn't fit a small phone. */
.result {
  position: fixed; inset: 0; z-index: 50; isolation: isolate; display: flex; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
  padding: max(58px, calc(env(safe-area-inset-top) + 40px)) 22px max(26px, env(safe-area-inset-bottom));
  animation: pop .18s ease-out; --rc: var(--text); --pop: var(--pink);
}
@keyframes pop { from { opacity: 0; transform: scale(1.03); } to { opacity: 1; transform: none; } }
.result::before {
  content: ''; position: absolute; z-index: -1; width: 380px; height: 380px; top: -70px; right: -150px; pointer-events: none; opacity: .1;
  background: var(--ink); -webkit-mask: var(--m-splat) center / contain no-repeat; mask: var(--m-splat) center / contain no-repeat; transform: rotate(14deg);
}
.result::after {
  content: ''; position: absolute; z-index: -1; left: 0; right: 0; top: 0; height: 56px; pointer-events: none;
  background: var(--ink); -webkit-mask: var(--m-drip) left top / 100% 100% no-repeat; mask: var(--m-drip) left top / 100% 100% no-repeat;
}
.result.ok { background: var(--go); color: var(--ink); --rc: var(--go); --pop: var(--pink); }
.result.bad { background: var(--red); color: var(--ink); --rc: var(--red); --pop: var(--yellow); }
.result.warn { background: var(--yellow); color: var(--ink); --rc: var(--yellow); --pop: var(--pink); }
.result.neutral, .result.checking { background: var(--surface-2); color: var(--text); --rc: var(--cyan); --pop: var(--pink); }
.result.neutral::before, .result.checking::before { background: var(--cyan); opacity: .14; }
.result.neutral::after, .result.checking::after { background: var(--pink); }
.r-inner { width: 100%; max-width: 480px; margin: auto; }
.r-label {
  display: inline-flex; align-items: center; gap: 9px; max-width: 100%; margin: 0; padding: 7px 13px 6px;
  font-family: var(--mono); font-size: 13px; font-weight: 700; line-height: 1.3; letter-spacing: .12em; text-transform: uppercase;
  color: var(--rc); background: var(--ink); clip-path: var(--torn); transform: rotate(-2deg); transform-origin: left center;
}
.result.neutral .r-label, .result.checking .r-label { color: var(--ink); background: var(--cyan); }
/* A shape as well as a colour, for anyone who can't tell green from red */
.r-label::before { flex: none; display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; font-family: var(--body); font-size: 13px; font-weight: 900; line-height: 1; letter-spacing: 0; color: var(--ink); background: var(--rc); }
.result.ok .r-label::before { content: '✓'; content: '✓' / ''; }
.result.bad .r-label::before { content: '✕'; content: '✕' / ''; }
.result.warn .r-label::before { content: '!'; content: '!' / ''; }
.result.neutral .r-label::before { content: '↺'; content: '↺' / ''; color: var(--cyan); background: var(--ink); }
.result h1 {
  font-family: var(--display); font-weight: 900; font-stretch: 62%; text-transform: uppercase;
  font-size: clamp(76px, 27vw, 150px); line-height: .84; letter-spacing: .005em; margin: 16px 0 18px;
  overflow-wrap: normal; word-break: keep-all; hyphens: none; text-shadow: .035em .035em 0 var(--pop);
}
.result.checking h1 { text-shadow: none; color: var(--muted); }
.r-pkg { margin: 0; font-size: 24px; font-weight: 800; line-height: 1.2; }
/* The size to hand over: a big ink sticker, readable from the stock shelf */
.r-size {
  display: inline-block; max-width: 100%; margin: 14px 0 0; padding: 10px 18px 4px; border-radius: 10px; overflow-wrap: anywhere;
  font-family: var(--display); font-weight: 900; font-stretch: 62%; font-size: clamp(56px, 18vw, 96px); line-height: .9; word-spacing: .12em; text-transform: uppercase;
  color: var(--rc); background: var(--ink); box-shadow: 5px 5px 0 var(--pop); transform: rotate(-1.5deg);
}
.r-size:empty { display: none; }
.r-size.warn { padding: 12px 16px 11px; color: var(--yellow); font: 800 20px/1.2 var(--body); letter-spacing: .02em; text-transform: none; }
.r-email { margin: 10px 0 0; font-family: var(--mono); font-size: 14px; font-weight: 700; overflow-wrap: anywhere; }
.r-note { margin: 18px 0 0; padding: 14px 16px; border-radius: 8px; border-left: 5px solid var(--ink); background: rgba(11, 10, 13, .1); font-size: 16px; font-weight: 600; line-height: 1.45; overflow-wrap: anywhere; }
.result.neutral .r-note { border-left-color: var(--cyan); background: rgba(246, 241, 232, .06); }
.r-note:empty { display: none; }
.r-actions { display: grid; gap: 16px; margin-top: 28px; }
.result .btn { width: 100%; padding: 19px 18px 18px; font-size: 22px; background: var(--ink); color: var(--paper); box-shadow: 5px 6px 0 var(--pop); }
.result .btn:active { transform: translate(3px, 3px); box-shadow: 2px 2px 0 var(--pop); }
.result .btn.ghost { background: transparent; color: inherit; box-shadow: inset 0 0 0 3px currentColor; transform: none; }
.result .btn.ghost:active { transform: translateY(1px); box-shadow: inset 0 0 0 3px currentColor; }
.result.neutral .btn:not(.ghost), .result.checking .btn:not(.ghost) { background: var(--yellow); color: var(--ink); box-shadow: 0 0 0 3px var(--ink), 5px 6px 0 3px var(--pink); }
.result :focus-visible { outline-color: var(--ink); }
.result.neutral :focus-visible, .result.checking :focus-visible { outline-color: var(--cyan); }
.r-timer { height: 6px; border-radius: 6px; background: rgba(11, 10, 13, .18); margin-top: 18px; overflow: hidden; }
.r-timer i { display: block; height: 100%; width: 100%; background: var(--ink); transform-origin: left; }
.result.neutral .r-timer { background: var(--line); }
.result.neutral .r-timer i { background: var(--cyan); }
.r-timer.run i { animation: drain 3.5s linear forwards; }
@keyframes drain { to { transform: scaleX(0); } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
</style>
</head>
<body>

<section id="signin" class="wrap signin hidden">
  <div class="brand">ON D<span>'</span> ROAD<em>Door</em></div>
  <h1>Staff<br>sign-in</h1>
  <p class="lead">Do this once with signal before doors open. The guest list is saved on this phone, so scanning keeps working if the signal drops.</p>
  <form id="signin-form" autocomplete="on">
    <label for="key">Staff password</label>
    <input id="key" type="password" autocomplete="current-password" required>
    <label for="device">Name this phone</label>
    <input id="device" placeholder="e.g. Front gate" maxlength="40" required autocomplete="off">
    <button class="btn" type="submit">Start</button>
    <p id="signin-msg" class="msg" role="status"></p>
  </form>
</section>

<section id="main" class="wrap hidden">
  <header class="bar">
    <div class="brand">ON D<span>'</span> ROAD<em id="device-name">Door</em></div>
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

  <form class="search" id="search-form" autocomplete="off">
    <input id="q" placeholder="No QR? Search email or reference" type="search" enterkeyhint="search">
  </form>
  <div id="matches" class="matches"></div>

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
    <p class="r-pkg" id="r-pkg"></p>
    <p class="r-size" id="r-size"></p>
    <p class="r-email" id="r-email"></p>
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

function el(tag, text, cls) { var e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = text; if (cls) e.className = cls; return e; }
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
  $('r-label').textContent = 'Checking';
  $('r-title').textContent = '...';
  ['r-pkg', 'r-size', 'r-email', 'r-note'].forEach(function (id) { $(id).textContent = ''; });
  $('r-size').className = 'r-size';
  $('r-timer').className = 'r-timer hidden';
  $('r-primary').classList.add('hidden');
  $('r-secondary').classList.add('hidden');
}

// pickup: the scan was made in Pickup mode, so shared results (not paid, wrong guest...) use pickup wording.
function show(r, offline, pickup) {
  busy = true;
  clearTimeout(autoTimer);
  var cfg = RESULTS[r.result] || RESULTS.INVALID;
  var p = r.pass || null;
  $('result').className = 'result ' + cfg.cls;
  $('r-label').textContent = (pickup && !PICKUP_RESULTS[r.result] ? 'Pickup · ' : '') + (r.override ? 'Override · ' : '') + cfg.label + (offline ? ' · saved offline' : '');
  $('r-title').textContent = cfg.title;
  fitTitle();
  $('r-pkg').textContent = p ? p.package : '';
  $('r-email').textContent = p ? p.email : '';
  // The size to hand over, big enough to read from the stock shelf.
  var size = $('r-size');
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
    note = 'Check their photo ID matches ' + p.email + '. Packages only go to the guest themselves.';
    if (p.sized && !p.size) note += ' Ask which size they need and tell the organizer.';
    if (p.refund_requested) note += " They asked for a refund. Check with the organizer first, and tap Undo if you don't hand it over.";
  }
  if (r.result === 'PICKED_ALREADY' && p) note = (p.picked_up_at ? 'Handed out ' + fmtWhen(p.picked_up_at) + (p.picked_up_by ? ' by ' + p.picked_up_by : '') + '. ' : '') + 'One package per pass. If they say they never got it, contact the organizer.';
  if (r.result === 'PICKUP_UNDONE') note = 'Their package is no longer marked as collected.';
  if (r.result === 'NOT_FOUND') note = offline ? 'Not in the list saved on this phone. If they paid recently, get signal, tap Sync now and scan again.' : 'No order has this code. Try searching their email.';
  if (r.result === 'MISMATCH') note = 'This code belongs to a different guest. Check their ID.';
  if (r.result === 'INVALID') note = "That QR code is not an On D' Road pass. Ask them to open the pass in their account.";
  if (r.result === 'UNDONE') note = 'They are no longer marked as checked in.';
  $('r-note').textContent = note;

  var primary = $('r-primary'), secondary = $('r-secondary');
  primary.classList.remove('hidden');
  primary.textContent = 'Next guest';
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
  var timer = $('r-timer');
  timer.className = 'r-timer hidden';
  if (r.result === 'ADMIT' || r.result === 'UNDONE' || r.result === 'PICKUP_UNDONE') {
    timer.className = 'r-timer';
    void timer.offsetWidth;
    timer.className = 'r-timer run';
    autoTimer = setTimeout(hideResult, 3500);
  }
  feedback(cfg.tone);
  var item = { t: new Date().toISOString(), result: r.result, override: !!r.override, offline: !!offline, email: p ? p.email : '', ref: p ? p.ref : '' };
  if (pickup) { item.pickup = true; if (r.result === 'HANDED' && p && p.size) item.note = 'Size ' + p.size; }
  addRecent(item);
  primary.focus();
}

// Shrinks the big headline until every word fits on the screen, whatever font loaded.
function fitTitle() {
  var h = $('r-title');
  h.style.fontSize = '';
  var size = parseFloat(window.getComputedStyle(h).fontSize) || 96, guard = 0;
  while (h.scrollWidth > h.clientWidth + 1 && size > 32 && guard++ < 60) { size -= 3; h.style.fontSize = size + 'px'; }
}

function hideResult() {
  clearTimeout(autoTimer);
  $('result').className = 'result hidden';
  busy = false;
  // The same pass is usually still in front of the camera: ignore it for a few seconds.
  lastAt = Date.now();
}
$('r-primary').addEventListener('click', hideResult);

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
var LABELS = { ADMIT: 'Admitted', ALREADY: 'Blocked: already in', UNPAID: 'Blocked: not paid', CANCELLED: 'Blocked: cancelled', NOT_FOUND: 'Not on list', MISMATCH: 'Blocked: wrong guest', INVALID: 'Not a pass', UNDONE: 'Check-in undone', CONFLICT: 'Admitted twice',
  HANDED: 'Package handed over', PICKED_ALREADY: 'Blocked: package already collected', PICKUP_UNDONE: 'Pickup undone', PICKUP_CONFLICT: 'Handed out twice', PICKUP_VOID: 'Handed out, but the order was cancelled' };
// Pickup-mode scans that ended like an entry scan.
var PICKUP_LABELS = { UNPAID: 'No package: not paid', CANCELLED: 'No package: cancelled', MISMATCH: 'No package: wrong guest' };
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
$('q').addEventListener('input', renderMatches);
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
