// adminapp.js: the installable admin app (a PWA) and its notifications.
// - /admin/manifest.webmanifest ("On D' Road Admin", start_url /admin/app, scope /admin), the icons (icons.js), and the
//   service worker /admin/sw.js. The worker caches the static shell only (the offline page, icons, manifest, fonts) and
//   never an API answer or a signed-in page; offline, a page shows the calm offline page.
// - /admin/app (OWNER and ADMIN): the phone home screen. Locks, requests waiting (approve or decline right there), sales
//   today, deposits due in the next 7 days, flagged orders (empty for now: /api/admin/flags keeps its shape for later),
//   the live door (polled every 10 seconds while the page is visible), the recent alerts and links to every admin page.
// - Web push (web-push, VAPID keys from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT; without keys push is off
//   and the app says so). Each device chooses what it gets (PREFS). notify(kind, …) is called where things happen (a new
//   request, a sale, a deposit or a balance due tomorrow, a refund request); every alert is also kept in admin_alerts so
//   the app lists it, push or not. A payload holds at most a first name, never an email or anything else personal.
//   A subscription the push service has dropped (404 or 410) is deleted.
import { ICONS } from './icons.js';
import { CUR } from './events.js';
import { baseHead, MARK, UI_JS, DIALOG_HTML } from './admin-ui.js';
import { deviceLabel } from './auth.js';

export const PREFS = {
  requests: 'New requests',
  sales: 'A sale (pass, ticket or table)',
  deposits: 'A deposit paid, or a balance due tomorrow',
  refunds: 'A refund requested',
  flags: 'Flagged orders',
  daily: 'The daily report (coming later)'
};
const DEFAULT_PREFS = { requests: true, sales: true, deposits: true, refunds: true, flags: true, daily: false };
const cleanPrefs = (p) => Object.fromEntries(Object.keys(PREFS).map((k) => [k, p && typeof p[k] === 'boolean' ? p[k] : DEFAULT_PREFS[k]]));

export async function ensureAppSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      keys JSONB NOT NULL,
      prefs JSONB NOT NULL DEFAULT '{}',
      device TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_ok_at TIMESTAMPTZ,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS admin_alerts (
      id SERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '/admin/app',
      pushed INTEGER NOT NULL DEFAULT 0
    );
    -- Door scans that were refused (old screenshot, cancelled, another event …), for the app's live door counts.
    -- Admitted and repeat scans are already in checkins / ticket_checkins.
    CREATE TABLE IF NOT EXISTS door_refusals (
      id SERIAL PRIMARY KEY,
      scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      work TEXT NOT NULL,
      event_id INTEGER,
      result TEXT NOT NULL,
      ref TEXT,
      device TEXT,
      client_id TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS door_refusals_event_idx ON door_refusals (work, event_id, scanned_at DESC);
    -- Who marked a ticket order's balance paid by hand, and the "balance due tomorrow" alert (once per order).
    ALTER TABLE ticket_payments ADD COLUMN IF NOT EXISTS by_name TEXT;
    ALTER TABLE ticket_payments ADD COLUMN IF NOT EXISTS by_user_id INTEGER;
    ALTER TABLE ticket_orders ADD COLUMN IF NOT EXISTS balance_alert_at TIMESTAMPTZ;
  `);
}

const today = "(NOW() AT TIME ZONE 'America/Antigua')::date";
const dayOf = (col) => `(${col} AT TIME ZONE 'America/Antigua')::date`;

export function createAdminApp({ pool, ADMIN_EMAIL = '', PUBLIC_URL = '' }) {
  // ---------- Push ----------
  const VAPID = { pub: process.env.VAPID_PUBLIC_KEY || '', priv: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || (ADMIN_EMAIL ? 'mailto:' + ADMIN_EMAIL : PUBLIC_URL.startsWith('https:') ? PUBLIC_URL : 'mailto:admin@ondroad.xyz') };
  let webpush = null;
  const ready = VAPID.pub && VAPID.priv
    ? import('web-push').then((m) => { const w = m.default || m; w.setVapidDetails(VAPID.subject, VAPID.pub, VAPID.priv); webpush = w; })
      .catch((err) => console.log('Push is off:', err.message))
    : Promise.resolve();

  // One push to one device. The body is encrypted for it by web-push; the request goes out with fetch (so a test can
  // point an endpoint at a plain-http stand-in for the push service). 404 / 410: the service dropped it, so it's deleted.
  async function sendOne(sub, payload) {
    try {
      const d = webpush.generateRequestDetails({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 6 * 3600, urgency: 'high' });
      const headers = { ...d.headers }; delete headers['Content-Length']; delete headers['content-length'];
      const r = await fetch(d.endpoint, { method: d.method, headers, body: d.body, signal: AbortSignal.timeout(10000) });
      if (r.status === 404 || r.status === 410) { await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]); return 'gone'; }
      if (r.ok) { await pool.query('UPDATE push_subscriptions SET last_ok_at = NOW(), last_error = NULL WHERE id = $1', [sub.id]); return 'ok'; }
      await pool.query('UPDATE push_subscriptions SET last_error = $2 WHERE id = $1', [sub.id, `HTTP ${r.status}`]);
      return 'error';
    } catch (err) {
      await pool.query('UPDATE push_subscriptions SET last_error = $2 WHERE id = $1', [sub.id, String(err.message).slice(0, 200)]).catch(() => {});
      return 'error';
    }
  }

  // Something happened. kind is one of PREFS. title/body: no personal data beyond a first name. Never throws.
  async function notify(kind, { title, body = '', url = '/admin/app' }) {
    try {
      await ready;
      const a = (await pool.query('INSERT INTO admin_alerts (kind, title, body, url) VALUES ($1, $2, $3, $4) RETURNING id',
        [kind, String(title).slice(0, 120), String(body).slice(0, 240), url])).rows[0];
      await pool.query('DELETE FROM admin_alerts WHERE id < $1 - 500', [a.id]);
      if (!webpush) return { pushed: 0 };
      const subs = (await pool.query(
        `SELECT s.* FROM push_subscriptions s JOIN admin_users u ON u.id = s.user_id
         WHERE u.active AND u.role IN ('OWNER', 'ADMIN') AND COALESCE((s.prefs ->> $1)::boolean, $2)`, [kind, !!DEFAULT_PREFS[kind]])).rows;
      const results = await Promise.all(subs.map((s) => sendOne(s, { title, body, url, kind, tag: kind + '-' + a.id })));
      const pushed = results.filter((x) => x === 'ok').length;
      await pool.query('UPDATE admin_alerts SET pushed = $2 WHERE id = $1', [a.id, pushed]);
      return { pushed, gone: results.filter((x) => x === 'gone').length };
    } catch (err) {
      console.error('Notify error:', err.message);
      return { pushed: 0 };
    }
  }

  // ---------- The dashboard's numbers ----------
  async function summary(locks) {
    const [settings, requests, pass, tix, tables, money, deposits, alerts] = await Promise.all([
      pool.query("SELECT key, value FROM settings WHERE key IN ('site_unlock_at', 'tickets_unlock_at')"),
      pool.query(
        `SELECT g.email, g.full_name, g.instagram, g.approval, g.applied_at,
                date_part('year', age((NOW() AT TIME ZONE 'America/Antigua')::date, g.birth_date))::int AS age,
                inv.inviter_email AS invited_by, inv.note AS invite_note,
                COALESCE((SELECT pr.name FROM promoters pr WHERE pr.id = inv.promoter_id AND inv.inviter_email = 'PROMOTER'),
                         (SELECT x.full_name FROM guests x WHERE LOWER(x.email) = LOWER(inv.inviter_email) LIMIT 1)) AS invited_by_name
         FROM guests g
         LEFT JOIN LATERAL (SELECT i.inviter_email, i.note, i.promoter_id FROM invites i WHERE i.invitee_email = LOWER(g.email) AND i.status = 'ACCEPTED'
                            ORDER BY i.accepted_at DESC NULLS LAST, i.id DESC LIMIT 1) inv ON TRUE
         WHERE g.approval = 'PENDING' ORDER BY g.applied_at NULLS LAST, g.id LIMIT 100`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE COALESCE(paid_via, '') <> 'COMP')::int AS paid, COUNT(*) FILTER (WHERE paid_via = 'COMP')::int AS free
                  FROM orders WHERE status = 'PAID' AND event_id = ${CUR} AND ${dayOf('paid_at')} = ${today}`),
      pool.query(`SELECT COALESCE(SUM(i.qty * i.tickets_included), 0)::int AS n FROM ticket_order_items i JOIN ticket_orders o ON o.id = i.order_id
                  WHERE i.kind = 'TICKET' AND o.status = 'PAID' AND ${dayOf('o.paid_at')} = ${today}`),
      pool.query(`SELECT COALESCE(SUM(i.qty), 0)::int AS n FROM ticket_order_items i JOIN ticket_orders o ON o.id = i.order_id
                  WHERE i.kind = 'TABLE' AND o.status IN ('PAID', 'DEPOSIT_PAID') AND ${dayOf('COALESCE(o.deposit_paid_at, o.paid_at)')} = ${today}`),
      pool.query(`SELECT currency, SUM(cents)::bigint AS cents FROM (
                    SELECT COALESCE(o.currency, p.currency) AS currency, COALESCE(o.amount_cents, p.price_cents) AS cents FROM orders o JOIN packages p ON p.id = o.package_id
                    WHERE o.status = 'PAID' AND o.event_id = ${CUR} AND ${dayOf('o.paid_at')} = ${today}
                    UNION ALL
                    SELECT o.currency, t.amount_cents FROM ticket_payments t JOIN ticket_orders o ON o.id = t.order_id WHERE ${dayOf('t.created_at')} = ${today}
                  ) x GROUP BY currency HAVING SUM(cents) > 0 ORDER BY currency`),
      pool.query(`SELECT o.id, o.ref, o.buyer_name, o.total_cents - o.paid_cents AS balance_cents, o.currency, o.balance_due_at, e.name AS event, e.id AS event_id
                  FROM ticket_orders o JOIN ticket_events e ON e.id = o.event_id
                  WHERE o.status = 'DEPOSIT_PAID' AND o.balance_due_at < NOW() + INTERVAL '7 days' ORDER BY o.balance_due_at, o.id LIMIT 50`),
      pool.query('SELECT id, at, kind, title, body, url, pushed FROM admin_alerts ORDER BY id DESC LIMIT 30')
    ]);
    const s = Object.fromEntries(settings.rows.map((r) => [r.key, r.value]));
    await ready;
    return {
      locks: { site: { locked: locks.site, unlock_at: s.site_unlock_at || '' }, tickets: { locked: locks.tickets, unlock_at: s.tickets_unlock_at || '' } },
      requests: requests.rows,
      sales_today: { passes: pass.rows[0].paid, free_passes: pass.rows[0].free, tickets: tix.rows[0].n, tables: tables.rows[0].n,
        money: money.rows.map((r) => ({ currency: r.currency, cents: Number(r.cents) })) },
      // The buyer's first name only.
      deposits_due: deposits.rows.map((o) => ({ ...o, buyer_name: undefined, buyer: String(o.buyer_name || '').split(' ')[0] })),
      flags: { count: 0, items: [] },
      alerts: alerts.rows,
      push: { enabled: !!webpush, public_key: webpush ? VAPID.pub : null, prefs: PREFS }
    };
  }

  // The live door: the current event and every ticket event on today. In = checked in; refused = scans the door turned
  // away; duplicates = repeat scans of a pass already in; last = the 10 latest scans and what happened.
  async function door(ticketDoor) {
    const out = [];
    const ev = (await pool.query("SELECT id, name FROM events WHERE status = 'current'")).rows[0];
    if (ev) {
      const [n, last] = await Promise.all([
        pool.query(`SELECT COUNT(*) FILTER (WHERE o.status = 'PAID')::int AS paid, COUNT(*) FILTER (WHERE o.status = 'PAID' AND o.checked_in_at IS NOT NULL)::int AS inside,
                      (SELECT COUNT(*)::int FROM checkins c JOIN orders o2 ON o2.id = c.order_id WHERE o2.event_id = $1 AND c.kind = 'DUPLICATE') AS duplicates,
                      (SELECT COUNT(*)::int FROM door_refusals r WHERE r.work = 'odr' AND r.event_id = $1) AS refused
                    FROM orders o WHERE o.event_id = $1`, [ev.id]),
        pool.query(`(SELECT c.scanned_at AS at, c.kind AS result, o.reference_code AS ref, c.device FROM checkins c JOIN orders o ON o.id = c.order_id
                      WHERE o.event_id = $1 AND c.kind IN ('ENTRY', 'MANUAL', 'OVERRIDE', 'DUPLICATE', 'UNDO'))
                    UNION ALL
                    (SELECT r.scanned_at, r.result, r.ref, r.device FROM door_refusals r WHERE r.work = 'odr' AND r.event_id = $1)
                    ORDER BY at DESC LIMIT 10`, [ev.id])]);
      out.push({ kind: 'odr', id: ev.id, name: ev.name, ...n.rows[0], last: last.rows });
    }
    const tevs = ticketDoor ? (await ticketDoor.events()).filter((e) => {
      const start = new Date(e.starts_at), end = e.ends_at ? new Date(e.ends_at) : new Date(start.getTime() + 12 * 3600 * 1000);
      const day = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/Antigua' });
      return day(start) === day(new Date()) || (start <= new Date() && end >= new Date());
    }) : [];
    for (const t of tevs) {
      const [n, last] = await Promise.all([
        pool.query(`SELECT COUNT(*) FILTER (WHERE t.kind = 'PERSON' AND t.status = 'VALID' AND o.status = 'PAID')::int AS paid,
                      COUNT(*) FILTER (WHERE t.kind = 'PERSON' AND t.checked_in_at IS NOT NULL AND t.status = 'VALID')::int AS inside,
                      COUNT(*) FILTER (WHERE t.kind = 'CAR' AND t.checked_in_at IS NOT NULL)::int AS cars,
                      (SELECT COUNT(*)::int FROM ticket_checkins c JOIN tickets t2 ON t2.id = c.ticket_id JOIN ticket_orders o2 ON o2.id = t2.order_id WHERE o2.event_id = $1 AND c.kind = 'DUPLICATE') AS duplicates,
                      (SELECT COUNT(*)::int FROM door_refusals r WHERE r.work = 'tickets' AND r.event_id = $1) AS refused
                    FROM tickets t JOIN ticket_orders o ON o.id = t.order_id WHERE o.event_id = $1`, [t.id]),
        pool.query(`(SELECT c.scanned_at AS at, c.kind AS result, t.ref, c.device, t.kind AS ticket_kind FROM ticket_checkins c JOIN tickets t ON t.id = c.ticket_id JOIN ticket_orders o ON o.id = t.order_id
                      WHERE o.event_id = $1)
                    UNION ALL
                    (SELECT r.scanned_at, r.result, r.ref, r.device, NULL FROM door_refusals r WHERE r.work = 'tickets' AND r.event_id = $1)
                    ORDER BY at DESC LIMIT 10`, [t.id])]);
      out.push({ kind: 'tickets', id: t.id, name: t.name, when: t.when, ...n.rows[0], last: last.rows });
    }
    return { at: new Date().toISOString(), events: out };
  }

  // A scan the door refused, for the counts above. Safe to repeat (client_id). Never throws.
  const REFUSED = ['STALE', 'CANCELLED', 'UNPAID', 'NOT_FOUND', 'MISMATCH', 'OTHER_EVENT', 'TRANSFERRED'];
  async function doorRefused(ev, result) {
    if (!REFUSED.includes(result?.result)) return;
    try {
      const work = ev?.ticket ? 'tickets' : 'odr';
      const eventId = ev?.ticket ? (parseInt(ev.event_id, 10) || null) : (await pool.query("SELECT id FROM events WHERE status = 'current'")).rows[0]?.id || null;
      await pool.query(`INSERT INTO door_refusals (work, event_id, result, ref, device, client_id, scanned_at) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()))
                        ON CONFLICT (client_id) DO NOTHING`,
        [work, eventId, result.result, String(ev?.ref || '').toUpperCase().slice(0, 32) || null, String(ev?.device || '').slice(0, 60) || null,
          ev?.client_id ? String(ev.client_id).slice(0, 64) : null, ev?.scanned_at && !Number.isNaN(Date.parse(ev.scanned_at)) && Date.parse(ev.scanned_at) <= Date.now() + 300000 ? ev.scanned_at : null]);
    } catch (err) { console.error('Door refusal log error:', err.message); }
  }

  // ---------- Routes ----------
  function register({ app, requireRole, publicRoute, lock, ticketsLock, ticketDoor, express }) {
    const ADMINS = requireRole('OWNER', 'ADMIN');
    const json = express.json({ limit: '8kb' });
    const fail = (res, err) => { console.error('App error:', err); res.status(500).json({ error: 'Server error.' }); };

    app.get('/admin/manifest.webmanifest', publicRoute, (req, res) => res.type('application/manifest+json').set('Cache-Control', 'public, max-age=3600').send(MANIFEST));
    app.get('/admin/icons/:name.png', publicRoute, (req, res) => {
      const png = ICONS[req.params.name];
      if (!png) return res.status(404).type('text/plain').send('Not found.');
      res.type('png').set('Cache-Control', 'public, max-age=604800').send(png);
    });
    app.get('/admin/sw.js', publicRoute, (req, res) => res.type('application/javascript').set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/admin' }).send(SW));
    app.get('/admin/offline', publicRoute, (req, res) => res.type('html').set('Cache-Control', 'no-cache').send(OFFLINE_PAGE));

    app.get('/admin/app', ADMINS, (req, res) => res.type('html').send(APP_PAGE));
    app.get('/api/admin/app/summary', ADMINS, async (req, res) => {
      try {
        const [site, tickets] = await Promise.all([lock.lockedNow(), ticketsLock.lockedNow()]);
        res.set('Cache-Control', 'no-store').json({ me: { name: req.admin.name, role: req.admin.role }, ...(await summary({ site, tickets })) });
      } catch (err) { fail(res, err); }
    });
    app.get('/api/admin/app/door', ADMINS, async (req, res) => {
      try { res.set('Cache-Control', 'no-store').json(await door(ticketDoor)); } catch (err) { fail(res, err); }
    });
    // Flagged orders: nothing flags orders yet. The shape a later part fills: { count, items: [{ id, kind, ref, reason, at, url }] }.
    app.get('/api/admin/flags', ADMINS, (req, res) => res.set('Cache-Control', 'no-store').json({ count: 0, items: [] }));

    // Push: this device's subscription and what it gets.
    app.get('/api/admin/push', ADMINS, async (req, res) => {
      try {
        await ready;
        const mine = req.admin.id ? (await pool.query('SELECT id, endpoint, prefs, device, created_at, last_ok_at FROM push_subscriptions WHERE user_id = $1 ORDER BY id', [req.admin.id])).rows : [];
        res.set('Cache-Control', 'no-store').json({ enabled: !!webpush, public_key: webpush ? VAPID.pub : null, labels: PREFS, defaults: DEFAULT_PREFS,
          devices: mine.map((s) => ({ id: s.id, endpoint_hash: hashEndpoint(s.endpoint), device: s.device, prefs: cleanPrefs(s.prefs), created_at: s.created_at, last_ok_at: s.last_ok_at })) });
      } catch (err) { fail(res, err); }
    });
    const subOf = (b) => {
      const s = b?.subscription || {};
      const endpoint = typeof s.endpoint === 'string' ? s.endpoint.trim() : '';
      const keys = s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string' ? { p256dh: s.keys.p256dh.slice(0, 200), auth: s.keys.auth.slice(0, 100) } : null;
      return /^https?:\/\/[^\s]{8,}$/.test(endpoint) && endpoint.length <= 1000 && keys ? { endpoint, keys } : null;
    };
    app.post('/api/admin/push/subscribe', ADMINS, json, async (req, res) => {
      try {
        await ready;
        if (!webpush) return res.status(409).json({ error: 'Notifications are off on the server.', code: 'PUSH_OFF' });
        if (!req.admin.id) return res.status(400).json({ error: 'Sign in with your account first.' });
        const s = subOf(req.body);
        if (!s) return res.status(400).json({ error: "That isn't a push subscription." });
        const prefs = cleanPrefs(req.body?.prefs);
        const r = await pool.query(
          `INSERT INTO push_subscriptions (user_id, endpoint, keys, prefs, device) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, keys = EXCLUDED.keys, prefs = EXCLUDED.prefs, device = EXCLUDED.device RETURNING id`,
          [req.admin.id, s.endpoint, s.keys, prefs, deviceLabel(req.get('user-agent'))]);
        req.auditExtra = { prefs };
        res.json({ success: true, id: r.rows[0].id, prefs });
      } catch (err) { fail(res, err); }
    });
    const mineByEndpoint = async (req) => (await pool.query('SELECT * FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2',
      [String(req.body?.endpoint || ''), req.admin.id || 0])).rows[0];
    app.post('/api/admin/push/prefs', ADMINS, json, async (req, res) => {
      try {
        const s = await mineByEndpoint(req);
        if (!s) return res.status(404).json({ error: "This phone isn't set up for notifications.", code: 'NOT_SUBSCRIBED' });
        const prefs = cleanPrefs({ ...cleanPrefs(s.prefs), ...(req.body?.prefs || {}) });
        await pool.query('UPDATE push_subscriptions SET prefs = $2 WHERE id = $1', [s.id, prefs]);
        req.auditExtra = { prefs };
        res.json({ success: true, id: s.id, prefs });
      } catch (err) { fail(res, err); }
    });
    app.post('/api/admin/push/unsubscribe', ADMINS, json, async (req, res) => {
      try {
        const r = await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2 RETURNING id', [String(req.body?.endpoint || ''), req.admin.id || 0]);
        res.json({ success: true, id: r.rows[0]?.id || null });
      } catch (err) { fail(res, err); }
    });
    app.post('/api/admin/push/test', ADMINS, json, async (req, res) => {
      try {
        await ready;
        const s = await mineByEndpoint(req);
        if (!webpush || !s) return res.status(404).json({ error: "This phone isn't set up for notifications.", code: 'NOT_SUBSCRIBED' });
        const r = await sendOne(s, { title: 'Test from ODR Admin', body: `Notifications work on this phone, ${String(req.admin.name).split(' ')[0]}.`, url: '/admin/app#alerts', kind: 'test', tag: 'test' });
        res.json({ success: r === 'ok', result: r, id: s.id });
      } catch (err) { fail(res, err); }
    });
  }
  const hashEndpoint = (e) => Buffer.from(e).toString('base64url').slice(-16);

  return { notify, register, doorRefused, ready: () => ready, pushEnabled: () => !!webpush };
}

// ---------- The manifest and the service worker ----------
const MANIFEST = JSON.stringify({
  name: "On D' Road Admin", short_name: 'ODR Admin', id: '/admin/app', start_url: '/admin/app', scope: '/admin',
  display: 'standalone', orientation: 'portrait', background_color: '#0a0a0b', theme_color: '#0a0a0b',
  description: "Requests, sales, the door and alerts for On D' Road's organizers.",
  icons: [
    { src: '/admin/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/admin/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/admin/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: '/admin/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ],
  shortcuts: [
    { name: 'Requests', url: '/admin/app#requests', icons: [{ src: '/admin/icons/icon-192.png', sizes: '192x192' }] },
    { name: 'Live door', url: '/admin/app#door', icons: [{ src: '/admin/icons/icon-192.png', sizes: '192x192' }] }
  ]
});

// The static shell only: never an API answer, never a signed-in page (they carry the session's CSRF token and personal
// data). Pages come from the network; with no network, the offline page.
const SW = `const CACHE = 'odr-admin-shell-v1';
const SHELL = ['/admin/offline', '/admin/manifest.webmanifest', '/admin/icons/icon-192.png', '/admin/icons/badge-96.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    if (url.origin !== self.location.origin) return;
    e.respondWith(fetch(req).catch(() => caches.match('/admin/offline')));
    return;
  }
  const shell = url.origin === self.location.origin && (SHELL.includes(url.pathname) || url.pathname.indexOf('/admin/icons/') === 0);
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!shell && !fonts) return;
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  })));
});
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (er) { d = { title: e.data ? e.data.text() : 'ODR Admin' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'ODR Admin', {
    body: d.body || '', icon: '/admin/icons/icon-192.png', badge: '/admin/icons/badge-96.png', tag: d.tag || undefined,
    data: { url: d.url || '/admin/app' }
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/admin/app', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if (c.url.indexOf(self.location.origin + '/admin') === 0 && 'focus' in c) { c.navigate(url); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
`;

const OFFLINE_PAGE = `${baseHead('Offline', `
body { min-height: 100vh; min-height: 100svh; display: flex; flex-direction: column; }
main { flex: 1; width: 100%; max-width: 480px; margin: 0 auto; padding: 56px 16px 40px; }
h1 { font-size: clamp(44px, 13vw, 66px); line-height: .92; margin-bottom: 18px; }
h1 b { font-weight: 900; } h1 i { font-style: normal; font-weight: 200; }
.slash { display: block; width: 72px; height: 4px; margin: 0 0 22px; background: linear-gradient(90deg, var(--cyan) 0 30%, var(--accent) 30%); transform: skewX(-24deg); }
p { color: var(--muted); font-size: 16px; }
.row a, .row button { flex: 1 1 160px; }
`)}
<body>
<header class="top"><span class="brand">${MARK}<b>ON D<span>'</span> <i>ROAD</i></b><span class="sub">Admin</span></span></header>
<main>
  <p class="eb">No signal</p>
  <h1><b>You're</b><br><i>offline</i></h1>
  <span class="slash" aria-hidden="true"></span>
  <p>The admin needs a connection to show live numbers. Nothing you did is lost. Try again when you have signal.</p>
  <p>The door scanner keeps working offline once it has its list.</p>
  <div class="row"><button type="button" onclick="location.reload()">Try again</button><a class="btn ghost" href="/door">Door scanner</a></div>
</main>
</body></html>`;

// ---------- /admin/app ----------
const APP_CSS = `
body { padding-bottom: calc(76px + env(safe-area-inset-bottom)); }
.top .me { font: 400 11px/1.2 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); max-width: 40vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app { max-width: 720px; margin: 0 auto; padding: 18px 16px 24px; }
.view { display: none; }
.view.on { display: block; }
.app h1 { font-size: clamp(30px, 9vw, 44px); margin: 6px 0 4px; }
.sub-l { color: var(--muted); margin: 0 0 18px; font-size: 14px; }
.sec { margin: 0 0 18px; padding: 16px; background: var(--surface); border: 1px solid var(--line); }
.sec h2 { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; font-size: 15px; margin: 0 0 12px; }
.sec h2 .n { font: 700 12px/1 var(--mono); color: var(--muted); letter-spacing: .06em; }
.locks { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.lockc { display: flex; flex-direction: column; justify-content: space-between; gap: 10px; min-height: 108px; padding: 12px; border: 1px solid var(--line-strong); text-decoration: none; color: var(--text); }
.lockc .t { font: 400 10.5px/1.2 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
.lockc b { font-family: var(--display); font-stretch: 125%; font-weight: 900; font-size: 22px; line-height: 1; text-transform: uppercase; }
.lockc.locked b { color: var(--warn); } .lockc.open b { color: var(--good); }
.lockc small { color: var(--dim); font-size: 12px; }
.kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); }
.kpi { background: var(--surface); padding: 12px 10px; min-width: 0; }
.kpi b { display: block; font-family: var(--display); font-stretch: 125%; font-weight: 900; font-size: 30px; line-height: 1; font-variant-numeric: tabular-nums; }
.kpi span { display: block; margin-top: 6px; font: 400 10.5px/1.2 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.money { margin: 12px 0 0; display: flex; flex-wrap: wrap; gap: 6px 18px; font: 700 15px/1.4 var(--mono); }
.money .lbl { width: 100%; font: 400 10.5px/1.2 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.empty { color: var(--dim); font-size: 14px; margin: 0; }
.items { list-style: none; margin: 0; padding: 0; }
.items > li { padding: 12px 0; border-top: 1px solid var(--line); }
.items > li:first-child { border-top: 0; padding-top: 0; }
.items b { font-weight: 700; overflow-wrap: anywhere; }
.items small { display: block; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.items .note { margin: 6px 0 0; padding-left: 10px; border-left: 2px solid var(--line-strong); color: var(--muted); font-size: 13.5px; }
.req-acts { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
.req-acts button { width: 100%; }
.doorev { margin: 0 0 18px; }
.doorev .big { display: flex; align-items: baseline; gap: 10px; margin: 2px 0 12px; }
.doorev .big b { font-family: var(--display); font-stretch: 125%; font-weight: 900; font-size: 56px; line-height: .9; font-variant-numeric: tabular-nums; }
.doorev .big span { color: var(--muted); }
.meter { height: 6px; background: rgba(236, 235, 230, .08); margin: 0 0 12px; }
.meter i { display: block; height: 100%; width: 0; background: var(--good); transition: width .3s; }
.dstats { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--line); border: 1px solid var(--line); margin-bottom: 12px; }
.dstats div { background: var(--surface); padding: 10px; }
.dstats b { display: block; font: 700 22px/1 var(--mono); }
.dstats span { font: 400 10.5px/1.2 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.dstats .bad b { color: var(--bad); } .dstats .warn b { color: var(--warn); }
.scans { list-style: none; margin: 0; padding: 0; font-size: 13.5px; }
.scans li { display: grid; grid-template-columns: 64px minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 8px 0; border-top: 1px solid var(--line); }
.scans time { font: 400 12px/1 var(--mono); color: var(--muted); }
.scans .r { font-weight: 700; }
.scans .r.ok { color: var(--good); } .scans .r.bad { color: var(--bad); } .scans .r.warn { color: var(--warn); }
.scans .ref { font: 400 11.5px/1.2 var(--mono); color: var(--dim); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 34vw; }
.live { display: inline-flex; align-items: center; gap: 8px; font: 400 11px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
.live i { width: 8px; height: 8px; background: var(--good); animation: blink 1.6s steps(2) infinite; }
@keyframes blink { 50% { opacity: .25; } }
.prefs label.chk { justify-content: space-between; border-top: 1px solid var(--line); color: var(--text); }
.prefs label.chk:first-child { border-top: 0; }
.prefs label.chk.off { color: var(--dim); }
.links { list-style: none; margin: 0; padding: 0; }
.links a { display: flex; justify-content: space-between; align-items: center; min-height: 52px; padding: 0 2px; border-top: 1px solid var(--line); color: var(--text); text-decoration: none; font-weight: 600; }
.links li:first-child a { border-top: 0; }
.links a::after { content: '→'; color: var(--accent); font-family: var(--mono); }
.install { position: relative; margin: 0 0 18px; padding: 16px 16px 16px 18px; background: var(--concrete-2); color: var(--ink); border-left: 3px solid var(--accent); }
.install h2 { color: var(--ink); font-size: 15px; margin: 0 0 6px; }
.install p { margin: 0; color: var(--ink-2); font-size: 14px; }
.install .row { margin-top: 12px; }
.install button.ghost { color: var(--ink); border-color: rgba(20, 20, 22, .42); }
.install .share { display: inline-block; width: 16px; height: 18px; vertical-align: -3px; }
.nav { position: fixed; left: 0; right: 0; bottom: 0; z-index: 20; display: grid; grid-template-columns: repeat(5, 1fr); background: rgba(10, 10, 11, .96); border-top: 1px solid var(--line-strong); padding-bottom: env(safe-area-inset-bottom); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
.nav a { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; min-height: 60px; color: var(--muted); text-decoration: none; font: 400 10px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; }
.nav a svg { width: 22px; height: 22px; }
.nav a[aria-current="page"] { color: var(--text); }
.nav a[aria-current="page"]::before { content: ''; position: absolute; top: -1px; left: 22%; right: 22%; height: 2px; background: var(--accent); }
.nav .badge { position: absolute; top: 8px; left: 56%; min-width: 18px; height: 18px; padding: 0 5px; background: var(--accent); color: var(--ink); font: 700 10.5px/18px var(--mono); text-align: center; }
@media (min-width: 900px) { .app { max-width: 760px; } }
`;
const icon = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${d}</svg>`;
const APP_PAGE = `${baseHead('Admin app', APP_CSS)}
<body>
<header class="top"><a class="brand" href="/admin/app#home">${MARK}<b>ON D<span>'</span> <i>ROAD</i></b><span class="sub">App</span></a><span class="me" id="me"></span></header>
<main class="app">
  <section class="view" id="v-home" aria-labelledby="h-home">
    <h1 id="h-home">Today</h1>
    <p class="sub-l" id="today"></p>
    <div class="install hidden" id="install">
      <h2>Install the app</h2>
      <p id="install-text">Put ODR Admin on your home screen: it opens full screen and can send you alerts.</p>
      <div class="row"><button type="button" id="install-go" class="hidden">Install</button><button class="ghost" type="button" id="install-x">Not now</button></div>
    </div>
    <div class="sec" id="s-locks"><h2>Sites</h2><div class="locks">
      <a class="lockc" id="lk-site" href="/admin/site"><span class="t">Invite-only site</span><b>…</b><small></small></a>
      <a class="lockc" id="lk-tix" href="/admin/tickets#lock"><span class="t">Ticket site</span><b>…</b><small></small></a>
    </div></div>
    <div class="sec" id="s-sales"><h2>Sales today <span class="n">Antigua day</span></h2>
      <div class="kpis"><div class="kpi"><b id="k-pass">0</b><span>Passes</span></div><div class="kpi"><b id="k-tix">0</b><span>Tickets</span></div><div class="kpi"><b id="k-tab">0</b><span>Tables</span></div></div>
      <div class="money" id="money"></div>
    </div>
    <div class="sec" id="s-requests-mini"><h2>Requests waiting <span class="n" id="rq-n">0</span></h2><p class="empty" id="rq-mini">Nobody is waiting.</p><a class="btn ghost small hidden" id="rq-open" href="#requests">Review</a></div>
    <div class="sec" id="s-deposits"><h2>Deposits due <span class="n">Next 7 days</span></h2><ul class="items" id="deposits"></ul></div>
    <div class="sec" id="s-flags"><h2>Flagged orders <span class="n" id="fl-n">0</span></h2><ul class="items" id="flags"></ul></div>
  </section>

  <section class="view" id="v-requests" aria-labelledby="h-req">
    <h1 id="h-req">Requests</h1>
    <p class="sub-l">People waiting for approval, oldest first. Approving emails them; declining doesn't.</p>
    <div class="sec"><ul class="items" id="requests"></ul></div>
  </section>

  <section class="view" id="v-door" aria-labelledby="h-door">
    <h1 id="h-door">Live door</h1>
    <p class="sub-l"><span class="live"><i></i><span id="door-at">Updating every 10 seconds</span></span></p>
    <div id="door"></div>
  </section>

  <section class="view" id="v-alerts" aria-labelledby="h-alerts">
    <h1 id="h-alerts">Alerts</h1>
    <p class="sub-l">What happened lately, and what this phone tells you about.</p>
    <div class="sec" id="s-push"><h2>Notifications on this phone</h2>
      <p class="empty" id="push-state">Checking…</p>
      <div class="row"><button type="button" id="push-on" class="hidden">Turn on notifications</button><button class="ghost hidden" type="button" id="push-test">Send a test</button><button class="ghost hidden" type="button" id="push-off">Turn off on this phone</button></div>
      <div class="prefs hidden" id="prefs"></div>
    </div>
    <div class="sec"><h2>Recent</h2><ul class="items" id="alerts"></ul></div>
  </section>

  <section class="view" id="v-more" aria-labelledby="h-more">
    <h1 id="h-more">Everything</h1>
    <p class="sub-l">The full admin pages. They work on a phone too.</p>
    <div class="sec"><ul class="links">
      <li><a href="/admin">Command Center</a></li>
      <li><a href="/admin/events">Events</a></li>
      <li><a href="/admin#orders">Orders</a></li>
      <li><a href="/admin/payments">Payment settings</a></li>
      <li><a href="/admin/pricing">Prices, codes &amp; promoters</a></li>
      <li><a href="/admin/pickup">Sizes &amp; pickup</a></li>
      <li><a href="/admin/event">Event &amp; messages</a></li>
      <li><a href="/admin/site">Site, contact, terms &amp; FAQ</a></li>
      <li><a href="/admin/tickets">Tickets &amp; tables</a></li>
      <li><a href="/door">Door scanner</a></li>
      <li><a href="/admin/audit">Audit log</a></li>
      <li class="owner-only"><a href="/admin/team">Team</a></li>
      <li class="owner-only"><a href="/admin/reset">Reset</a></li>
      <li><a href="/admin/account">Your account</a></li>
    </ul></div>
    <button class="ghost" type="button" data-logout style="width:100%">Log out</button>
  </section>
</main>
<nav class="nav" aria-label="App">
  <a href="#home" data-v="home">${icon('<path d="M3 11l9-7 9 7v9h-6v-6H9v6H3z"/>')}Today</a>
  <a href="#requests" data-v="requests">${icon('<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>')}Requests<span class="badge hidden" id="nav-rq"></span></a>
  <a href="#door" data-v="door">${icon('<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2v2h-2zM18 14h2v2h-2z"/>')}Door</a>
  <a href="#alerts" data-v="alerts">${icon('<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>')}Alerts</a>
  <a href="#more" data-v="more">${icon('<path d="M4 6h16M4 12h16M4 18h16"/>')}More</a>
</nav>
${DIALOG_HTML}
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>
${UI_JS}
let data = null, view = 'home', doorTimer = null, sumTimer = null;
const RESULT = { ENTRY: ['Admitted', 'ok'], MANUAL: ['Let in after ID check', 'warn'], OVERRIDE: ['Let in anyway', 'warn'], DUPLICATE: ['Blocked: already in', 'bad'], UNDO: ['Check-in undone', ''],
  STALE: ['Blocked: old screenshot', 'bad'], CANCELLED: ['Blocked: cancelled', 'bad'], UNPAID: ['Blocked: not paid', 'bad'], NOT_FOUND: ['Not on the list', 'bad'],
  MISMATCH: ['Blocked: wrong guest', 'bad'], OTHER_EVENT: ['Blocked: another event', 'bad'], TRANSFERRED: ['Blocked: transferred', 'bad'] };
function money(c, cur) { return (cur === 'XCD' ? 'EC$' : cur === 'USD' ? 'US$' : (cur || '') + ' ') + (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function clock(iso) { return iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Antigua' }) : ''; }
function show(v) {
  if (!['home', 'requests', 'door', 'alerts', 'more'].includes(v)) v = 'home';
  view = v;
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('on', s.id === 'v-' + v));
  document.querySelectorAll('.nav a').forEach((a) => { if (a.dataset.v === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  window.scrollTo(0, 0);
  if (v === 'door') loadDoor();
  if (v === 'alerts') loadPush();
}
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
function lockCard(id, st) {
  const c = $(id); c.className = 'lockc ' + (st.locked ? 'locked' : 'open');
  c.querySelector('b').textContent = st.locked ? 'Locked' : 'Open';
  c.querySelector('small').textContent = st.locked ? (st.unlock_at ? 'Opens ' + when(st.unlock_at) : 'Trailer only') : 'Live for guests';
}
function invitedBy(g) { return !g.invited_by ? '' : g.invited_by === 'CONTROL' ? 'You' : g.invited_by === 'PROMOTER' ? 'Promoter ' + (g.invited_by_name || '') : (g.invited_by_name || g.invited_by); }
function renderRequests() {
  const ul = $('requests'); ul.replaceChildren();
  const list = data.requests;
  $('rq-n').textContent = String(list.length);
  $('nav-rq').textContent = String(list.length); $('nav-rq').classList.toggle('hidden', !list.length);
  $('rq-mini').textContent = list.length ? list.slice(0, 3).map((g) => g.full_name || g.email).join(', ') + (list.length > 3 ? ' and ' + (list.length - 3) + ' more' : '') : 'Nobody is waiting.';
  $('rq-open').classList.toggle('hidden', !list.length);
  if (!list.length) { ul.appendChild(el('li', 'Nobody is waiting for approval.', 'empty')); return; }
  list.forEach((g) => {
    const li = el('li'); li.dataset.email = g.email;
    li.appendChild(el('b', g.full_name || g.email));
    li.appendChild(el('small', [g.age !== null && g.age !== undefined ? g.age + ' years old' : null, g.instagram ? '@' + g.instagram : null].filter(Boolean).join(' · ')));
    li.appendChild(el('small', g.email));
    if (g.invited_by) li.appendChild(el('small', 'Invited by ' + invitedBy(g) + (g.applied_at ? ' · asked ' + when(g.applied_at) : '')));
    if (g.invite_note) li.appendChild(el('p', g.invite_note, 'note'));
    const acts = el('div', undefined, 'req-acts');
    const ok = el('button', 'Approve', 'good'); ok.type = 'button';
    ok.onclick = async () => {
      const who = g.full_name || g.email;
      const v = await ask('Approve ' + who + '?', (g.approval === 'DECLINED' ? 'You declined them before. ' : '') + "They get an email saying they're in, and can pick a package.", 'Approve');
      if (!v) return;
      ok.disabled = true;
      try { const r = await api('/api/admin/guests/approve', { email: g.email }); toast(r.already ? who + ' was already approved.' : r.emailed ? 'Approved. ' + who + ' has been emailed.' : 'Approved, but the email failed to send.'); load(); }
      catch (er) { toast(er.message, true); ok.disabled = false; }
    };
    const no = el('button', 'Decline', 'danger'); no.type = 'button';
    no.onclick = async () => {
      const who = g.full_name || g.email;
      const inviter = g.invited_by === 'CONTROL' ? 'you' : g.invited_by === 'PROMOTER' ? 'promoter ' + (g.invited_by_name || '') : (g.invited_by_name || g.invited_by || 'whoever invited them');
      const v = await ask('Decline ' + who + '?', "They won't get an email. Their invite stays used, and " + inviter + " doesn't get it back. You can still approve them later from Declined.", 'Decline', { danger: true });
      if (!v) return;
      no.disabled = true;
      try { await api('/api/admin/guests/decline', { email: g.email }); toast('Request declined.'); load(); }
      catch (er) { toast(er.message, true); no.disabled = false; }
    };
    acts.appendChild(ok); acts.appendChild(no); li.appendChild(acts);
    ul.appendChild(li);
  });
}
function render() {
  $('me').textContent = data.me.name;
  $('today').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Antigua' }) + ' · Antigua';
  lockCard('lk-site', data.locks.site); lockCard('lk-tix', data.locks.tickets);
  const s = data.sales_today;
  $('k-pass').textContent = String(s.passes + s.free_passes); $('k-tix').textContent = String(s.tickets); $('k-tab').textContent = String(s.tables);
  const m = $('money'); m.replaceChildren(); m.appendChild(el('span', 'Money received today', 'lbl'));
  if (!s.money.length) m.appendChild(el('span', 'None yet', 'empty')); else s.money.forEach((x) => m.appendChild(el('span', money(x.cents, x.currency))));
  if (s.free_passes) m.appendChild(el('span', s.free_passes + ' free ' + (s.free_passes === 1 ? 'pass' : 'passes'), 'empty'));
  const dep = $('deposits'); dep.replaceChildren();
  if (!data.deposits_due.length) dep.appendChild(el('li', 'No balances due in the next 7 days.', 'empty'));
  data.deposits_due.forEach((o) => {
    const li = el('li'); const a = el('a'); a.href = '/admin/tickets?event=' + o.event_id + '&order=' + encodeURIComponent(o.ref); a.style.color = 'inherit'; a.style.textDecoration = 'none';
    a.appendChild(el('b', money(o.balance_cents, o.currency) + ' · ' + o.ref));
    const late = new Date(o.balance_due_at) < new Date();
    a.appendChild(el('small', (o.buyer ? o.buyer + ' · ' : '') + o.event + ' · ' + (late ? 'was due ' : 'due ') + when(o.balance_due_at)));
    li.appendChild(a); dep.appendChild(li);
  });
  $('fl-n').textContent = String(data.flags.count);
  const fl = $('flags'); fl.replaceChildren();
  if (!data.flags.items.length) fl.appendChild(el('li', 'Nothing flagged. Orders that need a second look will show here.', 'empty'));
  data.flags.items.forEach((f) => { const li = el('li'); li.appendChild(el('b', f.ref + ' · ' + f.reason)); li.appendChild(el('small', when(f.at))); fl.appendChild(li); });
  renderRequests();
  const al = $('alerts'); al.replaceChildren();
  if (!data.alerts.length) al.appendChild(el('li', 'No alerts yet.', 'empty'));
  data.alerts.forEach((x) => { const li = el('li'); const a = el('a'); a.href = x.url; a.style.color = 'inherit'; a.style.textDecoration = 'none'; a.appendChild(el('b', x.title)); a.appendChild(el('small', (x.body ? x.body + ' · ' : '') + when(x.at))); li.appendChild(a); al.appendChild(li); });
}
async function load() {
  try { data = await api('/api/admin/app/summary'); render(); } catch (er) { if (er.status !== 401) toast(er.message, true); }
}
async function loadDoor() {
  if (view !== 'door' || document.visibilityState !== 'visible') return;
  let d;
  try { d = await api('/api/admin/app/door'); } catch (er) { $('door-at').textContent = 'Offline: numbers may be old'; return; }
  $('door-at').textContent = 'Updated ' + clock(d.at) + ' · every 10 seconds';
  const box = $('door'); box.replaceChildren();
  if (!d.events.length) box.appendChild(el('p', 'Nothing on at the door today.', 'empty'));
  d.events.forEach((e) => {
    const s = el('div', undefined, 'sec doorev'); s.dataset.kind = e.kind; s.dataset.id = e.id;
    const h = el('h2'); h.appendChild(el('span', e.name)); h.appendChild(el('span', e.kind === 'odr' ? "On D' Road" : 'Tickets', 'n')); s.appendChild(h);
    const big = el('div', undefined, 'big'); const b = el('b', String(e.inside)); b.className = 'in-n'; big.appendChild(b); big.appendChild(el('span', 'in, of ' + e.paid + (e.kind === 'odr' ? ' paid' : ' tickets') + (e.cars ? ' · ' + e.cars + ' cars' : ''))); s.appendChild(big);
    const mt = el('div', undefined, 'meter'); const bar = el('i'); bar.style.width = (e.paid ? Math.min(100, Math.round(e.inside / e.paid * 100)) : 0) + '%'; mt.appendChild(bar); s.appendChild(mt);
    const st = el('div', undefined, 'dstats');
    const r = el('div', undefined, e.refused ? 'bad' : ''); r.appendChild(el('b', String(e.refused))); r.appendChild(el('span', 'Refused')); st.appendChild(r);
    const du = el('div', undefined, e.duplicates ? 'warn' : ''); du.appendChild(el('b', String(e.duplicates))); du.appendChild(el('span', 'Repeat scans')); st.appendChild(du);
    s.appendChild(st);
    const ul = el('ul', undefined, 'scans');
    if (!e.last.length) ul.appendChild(el('li', 'No scans yet.', 'empty'));
    e.last.forEach((x) => {
      const li = el('li'); const t = el('time', clock(x.at)); li.appendChild(t);
      const meta = RESULT[x.result] || [x.result, ''];
      li.appendChild(el('span', (x.ticket_kind === 'CAR' && x.result === 'ENTRY' ? 'Car let in' : meta[0]), 'r ' + meta[1]));
      li.appendChild(el('span', (x.ref || '') + (x.device ? ' · ' + x.device : ''), 'ref'));
      ul.appendChild(li);
    });
    s.appendChild(ul); box.appendChild(s);
  });
}
// ---------- Notifications ----------
let swReg = null;
function keyBytes(b64) { const s = String(b64).split('-').join('+').split('_').join('/'); const pad = '='.repeat((4 - s.length % 4) % 4); const bin = atob(s + pad); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
async function currentSub() { try { return swReg && swReg.pushManager ? await swReg.pushManager.getSubscription() : null; } catch (er) { return null; } }
async function loadPush() {
  let info;
  try { info = await api('/api/admin/push'); } catch (er) { $('push-state').textContent = er.message; return; }
  const st = $('push-state'), on = $('push-on'), off = $('push-off'), test = $('push-test'), prefs = $('prefs');
  [on, off, test, prefs].forEach((x) => x.classList.add('hidden'));
  if (!info.enabled) { st.textContent = "Notifications are off on the server: the VAPID keys aren't set yet. Alerts still show below."; return; }
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    st.textContent = ios && !standalone() ? 'On iPhone, add the app to your home screen first (Share, then Add to Home Screen), then open it from there.' : "This browser can't show notifications.";
    return;
  }
  const sub = await currentSub();
  const mine = sub && info.devices.find((d) => d.endpoint_hash === endpointHash(sub.endpoint));
  if (Notification.permission === 'denied') { st.textContent = 'Notifications are blocked for this app. Allow them in your phone’s settings, then come back.'; return; }
  if (!mine) { st.textContent = 'Get a notification on this phone when something needs you.'; on.classList.remove('hidden'); return; }
  st.textContent = 'On. Choose what this phone tells you about:';
  off.classList.remove('hidden'); test.classList.remove('hidden');
  prefs.replaceChildren(); prefs.classList.remove('hidden');
  Object.keys(info.labels).forEach((k) => {
    const l = el('label', undefined, 'chk' + (k === 'daily' ? ' off' : '')); const sp = el('span', info.labels[k]); l.appendChild(sp);
    const c = el('input'); c.type = 'checkbox'; c.checked = !!mine.prefs[k]; c.dataset.k = k; if (k === 'daily') c.disabled = true;
    c.onchange = async () => { const p = {}; p[k] = c.checked; try { await api('/api/admin/push/prefs', { endpoint: sub.endpoint, prefs: p }); toast('Saved.'); } catch (er) { c.checked = !c.checked; toast(er.message, true); } };
    l.appendChild(c); prefs.appendChild(l);
  });
}
function endpointHash(e) { return b64u(new TextEncoder().encode(e)).slice(-16); }
$('push-on').addEventListener('click', async () => {
  try {
    const info = await api('/api/admin/push');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications were not allowed.', true); return loadPush(); }
    const sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(info.public_key) });
    await api('/api/admin/push/subscribe', { subscription: sub.toJSON(), prefs: info.defaults });
    toast('Notifications are on.'); loadPush();
  } catch (er) { toast(er.message || 'Could not turn on notifications.', true); }
});
$('push-off').addEventListener('click', async () => {
  const sub = await currentSub(); if (!sub) return loadPush();
  try { await api('/api/admin/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); toast('Notifications are off on this phone.'); } catch (er) { toast(er.message, true); }
  loadPush();
});
$('push-test').addEventListener('click', async () => {
  const sub = await currentSub(); if (!sub) return loadPush();
  try { const r = await api('/api/admin/push/test', { endpoint: sub.endpoint }); toast(r.success ? 'Test sent.' : 'The push service did not take it (' + r.result + ').', !r.success); } catch (er) { toast(er.message, true); }
});
// ---------- Install ----------
let deferred = null;
function dismissed() { try { return localStorage.getItem('odr_install_x') === '1'; } catch (er) { return false; } }
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferred = e;
  if (standalone() || dismissed()) return;
  $('install-text').textContent = 'Put ODR Admin on your home screen: it opens full screen and can send you alerts.';
  $('install-go').classList.remove('hidden'); $('install').classList.remove('hidden');
});
$('install-go').addEventListener('click', async () => { if (!deferred) return; deferred.prompt(); try { await deferred.userChoice; } catch (er) {} deferred = null; $('install').classList.add('hidden'); });
$('install-x').addEventListener('click', () => { $('install').classList.add('hidden'); try { localStorage.setItem('odr_install_x', '1'); } catch (er) {} });
window.addEventListener('appinstalled', () => $('install').classList.add('hidden'));
if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone() && !dismissed()) {
  const t = $('install-text'); t.replaceChildren();
  t.appendChild(document.createTextNode('On iPhone: tap Share '));
  const sh = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); sh.setAttribute('viewBox', '0 0 16 18'); sh.setAttribute('class', 'share'); sh.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', 'M8 1v10M4.5 4.5L8 1l3.5 3.5M3 8H1.5v9h13V8H13'); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.5'); sh.appendChild(p); t.appendChild(sh);
  t.appendChild(document.createTextNode(', then Add to Home Screen. Open ODR Admin from there to get alerts.'));
  $('install').classList.remove('hidden');
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin' }).then((r) => { swReg = r; if (view === 'alerts') loadPush(); }).catch(() => {});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { load(); loadDoor(); } });
doorTimer = setInterval(loadDoor, 10000);
sumTimer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60000);
show(location.hash.slice(1) || 'home');
load();
</script>
</body></html>`;
