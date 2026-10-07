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
      // One package per order, even if two phones scan the same pass at the same moment.
      const got = await pool.query(
        `UPDATE orders SET picked_up_at = $2, picked_up_by = $3 WHERE id = $1 AND picked_up_at IS NULL
         RETURNING picked_up_at, picked_up_by`, [pass.id, at, device]);
      if (got.rowCount) {
        await record(pass.id, 'PICKUP', clientId, device, at);
        return { result: 'HANDED', pass: { ...pass, ...got.rows[0] } };
      }
      // Already handed out (maybe a moment ago by another phone, so read who and when again). Logged as a blocked repeat.
      const now = await pool.query('SELECT picked_up_at, picked_up_by FROM orders WHERE id = $1', [pass.id]);
      await record(pass.id, 'PICKUP_DUP', clientId, device, at);
      return { result: 'PICKED_ALREADY', pass: { ...pass, ...now.rows[0] } };
    }
    if (kind === 'OVERRIDE') {
      await record(pass.id, 'OVERRIDE', clientId, device, at);
      return { result: 'ADMIT', override: true, pass };
    }

    // Only one phone can win the first check-in, even if two scan at the same moment.
    const won = await pool.query(
      `UPDATE orders SET checked_in_at = $2, checked_in_by = $3 WHERE id = $1 AND checked_in_at IS NULL
       RETURNING checked_in_at, checked_in_by`, [pass.id, at, device]);
    if (won.rowCount) {
      await record(pass.id, 'ENTRY', clientId, device, at);
      return { result: 'ADMIT', pass: { ...pass, ...won.rows[0] } };
    }
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
<meta name="theme-color" content="#0b0a09">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="ODR Door">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Door | On D' Road</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js" defer></script>
<style>
:root {
  --bg: #0b0a09; --surface: #141210; --surface-2: #1b1815; --raise: #221e1a;
  --line: rgba(243, 236, 226, .09); --line-strong: rgba(243, 236, 226, .2);
  --text: #f3ece2; --muted: #9b9389; --dim: #6c665e;
  --accent: #ff5b1f; --accent-ink: #120703; --good: #4fc3a1; --warn: #f0b43c; --bad: #ff6a5c;
  --display: 'Anton', Impact, 'Arial Narrow', sans-serif; --body: 'Inter', system-ui, -apple-system, sans-serif; --mono: 'JetBrains Mono', ui-monospace, monospace;
}
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 var(--body); -webkit-font-smoothing: antialiased; overscroll-behavior: none; }
.hidden { display: none !important; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.wrap { max-width: 520px; margin: 0 auto; padding: max(14px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom)); }

.brand { font-family: var(--display); font-size: 19px; letter-spacing: .04em; }
.brand span { color: var(--accent); }
.brand em { font-style: normal; font-family: var(--body); font-size: 11px; font-weight: 600; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); margin-left: 10px; padding-left: 10px; border-left: 1px solid var(--line-strong); vertical-align: 3px; }

input { width: 100%; font: 500 16px var(--body); color: var(--text); background: rgba(0, 0, 0, .35); border: 1px solid var(--line-strong); border-radius: 12px; padding: 14px 15px; }
input::placeholder { color: var(--dim); }
input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(255, 91, 31, .16); }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; font: 700 14px var(--body); letter-spacing: .06em; padding: 15px 20px; border-radius: 12px; cursor: pointer; color: var(--accent-ink); background: var(--accent); border: 1px solid var(--accent); }
.btn:disabled { opacity: .5; }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--line-strong); }
.btn.small { padding: 9px 12px; font-size: 12px; border-radius: 10px; }

/* ---------- Sign in ---------- */
.signin { min-height: 100%; display: flex; flex-direction: column; justify-content: center; }
.signin h1 { font-family: var(--display); font-weight: 400; font-size: 56px; line-height: .92; text-transform: uppercase; margin: 26px 0 10px; }
.signin p.lead { color: var(--muted); margin: 0 0 24px; }
.signin label { display: block; font-size: 11px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); margin: 16px 0 8px; }
.signin .btn { width: 100%; margin-top: 22px; }
.msg { min-height: 22px; margin: 14px 0 0; font-size: 14px; font-weight: 600; color: var(--bad); }

/* ---------- Main ---------- */
.bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.bar .brand { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar .net { flex: none; }
.net { display: inline-flex; align-items: center; gap: 8px; padding: 7px 12px; border-radius: 999px; border: 1px solid var(--line-strong); font-size: 12px; font-weight: 600; white-space: nowrap; }
.net i { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.net.ok { color: var(--good); border-color: rgba(79, 195, 161, .35); }
.net.warn { color: var(--warn); border-color: rgba(240, 180, 60, .35); }
.net.off { color: var(--warn); border-color: rgba(240, 180, 60, .45); background: rgba(240, 180, 60, .08); }
.count { display: flex; align-items: baseline; gap: 10px; margin: 2px 0 14px; color: var(--muted); font-size: 14px; }
.count b#in-count { font-family: var(--display); font-weight: 400; font-size: 56px; line-height: 1; color: var(--text); }
.count span b { color: var(--text); font-weight: 600; }

.cam { position: relative; aspect-ratio: 1; border-radius: 20px; overflow: hidden; background: #000; border: 1px solid var(--line); }
.cam video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .3s; }
.cam.on video { opacity: 1; }
.frame { position: absolute; inset: 17%; border-radius: 18px; pointer-events: none; opacity: 0; transition: opacity .3s;
  background:
    linear-gradient(var(--accent), var(--accent)) top left / 34px 3px no-repeat,
    linear-gradient(var(--accent), var(--accent)) top left / 3px 34px no-repeat,
    linear-gradient(var(--accent), var(--accent)) top right / 34px 3px no-repeat,
    linear-gradient(var(--accent), var(--accent)) top right / 3px 34px no-repeat,
    linear-gradient(var(--accent), var(--accent)) bottom left / 34px 3px no-repeat,
    linear-gradient(var(--accent), var(--accent)) bottom left / 3px 34px no-repeat,
    linear-gradient(var(--accent), var(--accent)) bottom right / 34px 3px no-repeat,
    linear-gradient(var(--accent), var(--accent)) bottom right / 3px 34px no-repeat; }
.cam.on .frame { opacity: 1; }
.frame::after { content: ''; position: absolute; left: 8%; right: 8%; top: 50%; height: 2px; background: var(--accent); box-shadow: 0 0 14px var(--accent); opacity: .8; animation: sweep 2.4s ease-in-out infinite; }
@keyframes sweep { 0%, 100% { top: 12%; } 50% { top: 88%; } }
.cam-idle { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 24px; text-align: center; background: radial-gradient(80% 80% at 50% 40%, rgba(255, 91, 31, .14), transparent 70%); }
.cam.on .cam-idle { display: none; }
.cam-idle p { margin: 0; color: var(--muted); font-size: 14px; max-width: 260px; }
.cam-hint { position: absolute; left: 0; right: 0; bottom: 12px; text-align: center; font-size: 12px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: rgba(255, 255, 255, .75); text-shadow: 0 1px 6px rgba(0, 0, 0, .8); }
.cam:not(.on) .cam-hint { display: none; }
.cam-stop { position: absolute; top: 10px; right: 10px; padding: 7px 11px; font-size: 11px; background: rgba(0, 0, 0, .55); border-color: rgba(255, 255, 255, .25); color: #fff; }
.cam:not(.on) .cam-stop { display: none; }

.search { display: flex; gap: 8px; margin-top: 14px; }
.search input { flex: 1; min-width: 0; }
.matches { display: grid; gap: 8px; margin-top: 10px; }
.match { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; align-items: center; text-align: left; width: 100%; padding: 13px 14px; border-radius: 12px; border: 1px solid var(--line-strong); background: var(--surface); color: var(--text); font: inherit; cursor: pointer; }
.match .m-email { font-weight: 600; overflow-wrap: anywhere; }
.match .m-sub { grid-column: 1; font-size: 12px; color: var(--muted); font-family: var(--mono); }
.match .m-status { grid-column: 2; grid-row: 1 / span 2; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.st-ok { color: var(--good); } .st-in { color: var(--muted); } .st-warn { color: var(--warn); } .st-bad { color: var(--bad); }
.empty { color: var(--muted); font-size: 14px; margin: 4px 2px; }

h2 { font-size: 11px; font-weight: 600; letter-spacing: .16em; text-transform: uppercase; color: var(--dim); margin: 26px 0 8px; }
.recent { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: 14px; overflow: hidden; background: var(--surface); }
.recent li { display: grid; grid-template-columns: 10px 1fr auto; gap: 4px 12px; align-items: center; padding: 12px 14px; border-top: 1px solid var(--line); }
.recent li:first-child { border-top: 0; }
.recent .dot { width: 8px; height: 8px; border-radius: 50%; }
.recent .who { font-weight: 600; font-size: 14px; overflow-wrap: anywhere; }
.recent .what { grid-column: 2 / span 2; font-size: 12px; color: var(--muted); }
.recent .when { font-family: var(--mono); font-size: 11px; color: var(--dim); }
.recent .none { display: block; padding: 16px 14px; color: var(--dim); font-size: 14px; }
.dot.ok { background: var(--good); } .dot.bad { background: var(--bad); } .dot.warn { background: var(--warn); } .dot.neutral { background: var(--dim); }

.foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--line); }
.foot .sync-text { flex: 1; min-width: 160px; font-size: 12px; color: var(--muted); }

/* ---------- Full-screen result ---------- */
.result { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; padding: max(24px, env(safe-area-inset-top)) 22px max(24px, env(safe-area-inset-bottom)); animation: pop .18s ease-out; }
@keyframes pop { from { opacity: 0; transform: scale(1.03); } to { opacity: 1; transform: none; } }
.result.ok { background: var(--good); color: #03130d; }
.result.bad { background: var(--bad); color: #1a0402; }
.result.warn { background: var(--warn); color: #1a1204; }
.result.neutral, .result.checking { background: var(--surface-2); color: var(--text); }
.r-inner { width: 100%; max-width: 480px; }
.r-label { margin: 0; font-size: 13px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; opacity: .8; }
.result h1 { font-family: var(--display); font-weight: 400; text-transform: uppercase; font-size: clamp(64px, 21vw, 132px); line-height: .9; margin: 10px 0 18px; overflow-wrap: normal; word-break: keep-all; hyphens: none; }
.r-pkg { margin: 0; font-size: 24px; font-weight: 700; line-height: 1.2; }
.r-email { margin: 6px 0 0; font-family: var(--mono); font-size: 14px; opacity: .85; overflow-wrap: anywhere; }
.r-note { margin: 18px 0 0; padding: 14px 16px; border-radius: 12px; background: rgba(0, 0, 0, .14); font-size: 16px; font-weight: 600; line-height: 1.45; }
.r-note:empty { display: none; }
.r-actions { display: grid; gap: 10px; margin-top: 26px; }
.result .btn { width: 100%; padding: 18px; font-size: 16px; background: rgba(0, 0, 0, .86); color: #fff; border-color: transparent; }
.result .btn.ghost { background: transparent; color: inherit; border-color: currentColor; }
.result.neutral .btn, .result.checking .btn { background: var(--accent); color: var(--accent-ink); }
.r-timer { height: 4px; border-radius: 4px; background: rgba(0, 0, 0, .18); margin-top: 16px; overflow: hidden; }
.r-timer i { display: block; height: 100%; width: 100%; background: rgba(0, 0, 0, .45); transform-origin: left; }
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
  <div class="count"><b id="in-count">0</b><span>of <b id="paid-count">0</b> paid guests checked in</span></div>

  <div class="cam" id="cam">
    <video id="video" playsinline muted autoplay></video>
    <div class="frame"></div>
    <div class="cam-idle">
      <button class="btn" id="cam-btn" type="button">Start scanning</button>
      <p id="cam-msg">Point the camera at the QR code on the guest's pass.</p>
    </div>
    <button class="btn ghost small cam-stop" id="cam-stop" type="button">Stop</button>
    <p class="cam-hint">Hold the pass inside the frame</p>
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
var online = navigator.onLine !== false;
var syncing = false, busy = false, autoTimer = null;

function el(tag, text, cls) { var e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = text; if (cls) e.className = cls; return e; }
function fmtTime(iso) { return iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Antigua' }) : ''; }
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
  });
}
function decide(p, target, kind) {
  if (!p) return { result: 'NOT_FOUND' };
  if (target.ref && target.email && target.email !== p.email) return { result: 'MISMATCH', pass: p };
  if (kind === 'UNDO') return { result: 'UNDONE', pass: p };
  if (p.status === 'RESERVED') return { result: 'UNPAID', pass: p };
  if (p.status !== 'PAID') return { result: 'CANCELLED', pass: p };
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
  if (!target) { show({ result: 'INVALID' }, false); return Promise.resolve(); }
  var local = findPass(target);
  var ref = target.ref || (local && local.ref) || '';
  if (!ref) { show(decide(null, target, kind), !online); return Promise.resolve(); }
  var ev = { client_id: newId(), ref: ref, email: target.ref ? (target.email || '') : '', kind: kind, scanned_at: new Date().toISOString(), device: DEVICE };
  showChecking();
  return api('/api/door/checkin', ev).then(function (r) {
    if (r.pass) mergePass(r.pass);
    show(r, false);
  }, function (err) {
    if (err.auth) { hideResult(); signOut(err.message); return; }
    // No signal (or the server hiccuped): decide from the list saved on this phone.
    var d = decide(local, target, kind);
    if (d.result === 'ADMIT' || d.result === 'UNDONE') {
      queue.push(ev); saveQueue();
      if (d.result === 'ADMIT' && !d.override) { local.checked_in_at = ev.scanned_at; local.checked_in_by = DEVICE; }
      if (d.result === 'UNDONE') { local.checked_in_at = null; local.checked_in_by = null; }
      savePasses();
    }
    show(d, true);
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
  UNDONE: { cls: 'neutral', label: 'Check-in removed', title: 'Undone', tone: 'neutral' }
};

function showChecking() {
  busy = true;
  clearTimeout(autoTimer);
  $('result').className = 'result checking';
  $('r-label').textContent = 'Checking';
  $('r-title').textContent = '...';
  ['r-pkg', 'r-email', 'r-note'].forEach(function (id) { $(id).textContent = ''; });
  $('r-timer').className = 'r-timer hidden';
  $('r-primary').classList.add('hidden');
  $('r-secondary').classList.add('hidden');
}

function show(r, offline) {
  busy = true;
  clearTimeout(autoTimer);
  var cfg = RESULTS[r.result] || RESULTS.INVALID;
  var p = r.pass || null;
  $('result').className = 'result ' + cfg.cls;
  $('r-label').textContent = (r.override ? 'Override · ' : '') + cfg.label + (offline ? ' · saved offline' : '');
  $('r-title').textContent = cfg.title;
  fitTitle();
  $('r-pkg').textContent = p ? p.package : '';
  $('r-email').textContent = p ? p.email : '';
  var note = '';
  if (r.result === 'ADMIT') {
    if (r.override) note = 'Let in again by staff override. This is logged.';
    if (p && p.costume) note += (note ? ' ' : '') + 'Costume required: check their outfit.';
    if (p && p.refund_requested) note += (note ? ' ' : '') + 'They asked for a refund. Tell the organizer.';
  }
  if (r.result === 'ALREADY' && p) note = 'Checked in at ' + fmtTime(p.checked_in_at) + (p.checked_in_by ? ' by ' + p.checked_in_by : '') + '. Only let them in if you know it is a re-entry.';
  if (r.result === 'UNPAID') note = 'Their reservation was never paid, so this pass does not get them in.';
  if (r.result === 'CANCELLED') note = 'This order was cancelled or refunded. The pass no longer works.';
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
  var timer = $('r-timer');
  timer.className = 'r-timer hidden';
  if (r.result === 'ADMIT' || r.result === 'UNDONE') {
    timer.className = 'r-timer';
    void timer.offsetWidth;
    timer.className = 'r-timer run';
    autoTimer = setTimeout(hideResult, 3500);
  }
  feedback(cfg.tone);
  addRecent({ t: new Date().toISOString(), result: r.result, override: !!r.override, offline: !!offline, email: p ? p.email : '', ref: p ? p.ref : '' });
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
var LABELS = { ADMIT: 'Admitted', ALREADY: 'Blocked: already in', UNPAID: 'Blocked: not paid', CANCELLED: 'Blocked: cancelled', NOT_FOUND: 'Not on list', MISMATCH: 'Blocked: wrong guest', INVALID: 'Not a pass', UNDONE: 'Check-in undone', CONFLICT: 'Admitted twice' };
var DOTS = { ADMIT: 'ok', UNDONE: 'neutral', UNPAID: 'warn', CONFLICT: 'warn' };
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
    var what = (it.override ? 'Admitted by override' : LABELS[it.result] || it.result) + (it.offline ? ' · offline' : '') + (it.note ? ' · ' + it.note : '');
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
  var paid = 0, inn = 0;
  passes.forEach(function (p) { if (p.status === 'PAID') { paid++; if (p.checked_in_at) inn++; } });
  $('in-count').textContent = inn;
  $('paid-count').textContent = paid;
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
    b.appendChild(el('span', p.package + ' · ' + p.ref, 'm-sub'));
    b.addEventListener('click', function () { unlockAudio(); $('q').value = ''; box.replaceChildren(); $('q').blur(); handle({ ref: p.ref }, 'ENTRY'); });
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
  $('cam-msg').textContent = "Point the camera at the QR code on the guest's pass.";
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
  handle(parse(text), 'ENTRY');
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
  if (queue.length && !window.confirm(queue.length + ' check-ins have not synced yet. They stay on this phone and sync after you sign back in. Sign out anyway?')) return;
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

if (KEY && DEVICE) { showMain(); syncNow(); } else { showSignin(); }
</script>
</body>
</html>`;
