// lock.js: a site lock. While a site is locked its guest site shows only the trailer, and every guest API of that site
// answers 423 { code: 'SITE_LOCKED' }, so nothing works behind it either. The owner sees the real site through a private
// preview link (?preview=<token>), which the guest site sends back as an x-preview header.
// createLock() is used twice (server.js):
// - the main lock, for the invite-only site: settings site_lock 'on' | 'off' (missing = locked, so a fresh database or
//   a full reset starts locked), site_unlock_at (ISO time or ''; the site opens by itself from then on, checked on each
//   request) and preview_version (a counter in the preview token; resetting the link bumps it, so old links stop
//   working). Its guard covers every /api/ route but the open ones (OPEN_ROUTES); /api/site is handled by site.js.
// - the ticket lock, for the ticket site (tickets.js): tickets_lock, tickets_unlock_at and tickets_preview_version, the
//   same rules, covering /api/tickets/* only (except the open ticket routes: tickets.js passes applies()).
// Admin pages, the door scanner and the background jobs keep working under both.
import crypto from 'crypto';
import { parseWhen } from './pricing.js';

const CACHE_MS = 5000;
// Routes the MAIN lock leaves open: the admin API, the door scanner's API, the retired pass images, the promoters'
// private pages' API (promoter.js; sending an invite checks lockedNow() itself) and the ticket site's API, which has its
// own lock. Anything else under /api/ is a guest route of the invite-only site. The promoter pages
// (/promoter/<token>) aren't under /api/, so the guard never sees them.
const OPEN_ROUTES = /^\/api\/(admin|door|promoter)(\/|$)|^\/api\/pass\/|^\/api\/tickets(\/|$)/;
export const mainLockApplies = (path) => path.startsWith('/api/') && path !== '/api/site' && !OPEN_ROUTES.test(path);

// keys: the three settings; tokenPrefix: what the preview token signs before the version; applies(path): whether the
// guard covers a (lowercased) path; adminPath: the admin routes' base; what: the site's name in the log.
export function createLock({ pool, TOKEN_SECRET, safeEqual, SITE_URL,
  keys = { lock: 'site_lock', at: 'site_unlock_at', version: 'preview_version' }, tokenPrefix = 'preview:',
  applies = mainLockApplies, adminPath = '/api/admin/site-lock', what = 'Site' }) {
  const KEYS = [keys.lock, keys.at, keys.version];
  let cache = null, cachedAt = 0;

  // The three settings, cached for a few seconds (every guest request reads them). Saves clear the cache.
  async function settings() {
    if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
    const r = await pool.query('SELECT key, value FROM settings WHERE key = ANY($1)', [KEYS]);
    const s = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
    cache = { site_lock: s[keys.lock] === 'off' ? 'off' : 'on', site_unlock_at: s[keys.at] || '', preview_version: s[keys.version] || '0' };
    cachedAt = Date.now();
    return cache;
  }
  const forget = () => { cache = null; };

  // Locked unless switched off or the unlock time has passed. A time that can't be read never opens it.
  const isLocked = (s, now = Date.now()) => s.site_lock !== 'off' && !(s.site_unlock_at && now >= Date.parse(s.site_unlock_at));
  const previewToken = (version) => crypto.createHmac('sha256', TOKEN_SECRET).update(tokenPrefix + version).digest('base64url');
  const previewUrl = (s) => `${SITE_URL}/?preview=${previewToken(s.preview_version)}`;
  const previewOk = (req, s) => {
    const sent = req.get('x-preview');
    return !!sent && safeEqual(sent, previewToken(s.preview_version));
  };

  // { locked, preview }: locked = this request is shut out; preview = it's locked but the preview header let it in.
  async function check(req) {
    const s = await settings();
    if (!isLocked(s)) return { locked: false, preview: false };
    const ok = previewOk(req, s);
    return { locked: !ok, preview: ok };
  }

  // Whether the site is locked for everyone right now (a preview header doesn't count).
  const lockedNow = async () => isLocked(await settings());

  // Middleware for every request (registered right after CORS, so a 423 still carries the CORS headers and the
  // preflight for x-preview is answered first). Express matches routes ignoring case, so the check does too.
  async function guard(req, res, next) {
    if (!applies(req.path.toLowerCase())) return next();
    try {
      if (!(await check(req)).locked) return next();
      res.status(423).json({ error: 'Not open yet.', code: 'SITE_LOCKED' });
    } catch (err) {
      // Can't tell (database down): stay shut rather than let guest routes through.
      console.error(`${what} lock check failed:`, err.message);
      res.status(500).json({ error: 'Server error.' });
    }
  }

  const save = (db, key, value) => db.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
  const state = (s) => ({ site_lock: s.site_lock, site_unlock_at: s.site_unlock_at || '', locked: isLocked(s), preview_url: previewUrl(s) });
  const fail = (res, err) => { console.error(err); res.status(500).json({ error: 'Server error.' }); };

  // The admin routes: GET/POST <adminPath> and POST <adminPath>/preview-reset. json: a body parser for routes
  // registered before the app-wide one (the ticket lock's); the main lock's are registered after it.
  function register({ app, requireAdmin, json = (req, res, next) => next() }) {
    app.get(adminPath, requireAdmin, async (req, res) => {
      try { forget(); res.json(state(await settings())); } catch (err) { fail(res, err); }
    });

    // { site_lock: 'on' | 'off', site_unlock_at: ISO time | '' } (either one). The time must be in the future.
    // Switching it off clears the time (the site is open, nothing to wait for), and switching it on drops a time that
    // has already passed, which would otherwise open it again straight away.
    app.post(adminPath, requireAdmin, json, async (req, res) => {
      const b = req.body || {};
      const bad = (error) => res.status(400).json({ error });
      if (b.site_lock === undefined && b.site_unlock_at === undefined) return bad('Nothing to change.');
      if (b.site_lock !== undefined && b.site_lock !== 'on' && b.site_lock !== 'off') return bad("Choose whether the site is locked ('on') or open ('off').");
      let at;
      if (b.site_unlock_at !== undefined) {
        if (b.site_unlock_at !== null && typeof b.site_unlock_at !== 'string') return bad('Enter the unlock time as a date and time.');
        const when = parseWhen(b.site_unlock_at);
        if (when === undefined) return bad("That unlock time isn't a real date and time.");
        if (when && when.getTime() <= Date.now()) return bad('Pick an unlock time in the future.');
        at = when ? when.toISOString() : '';
      }
      try {
        forget();
        const now = await settings();
        const lock = b.site_lock || now.site_lock;
        if (at === undefined) at = now.site_unlock_at;
        if (lock === 'off' || (at && !(Date.parse(at) > Date.now()))) at = '';
        await save(pool, keys.lock, lock);
        await save(pool, keys.at, at);
        forget();
        const s = await settings();
        console.log(`${what} lock: ${s.site_lock}${s.site_unlock_at ? ', opens at ' + s.site_unlock_at : ''}.`);
        res.json({ success: true, ...state(s) });
      } catch (err) { fail(res, err); }
    });

    // A new preview link. The old one stops working at once.
    app.post(`${adminPath}/preview-reset`, requireAdmin, json, async (req, res) => {
      try {
        await pool.query(
          `INSERT INTO settings (key, value) VALUES ($1, '1') ON CONFLICT (key) DO UPDATE
           SET value = (CASE WHEN settings.value ~ '^[0-9]{1,9}$' THEN settings.value::int + 1 ELSE 1 END)::text`, [keys.version]);
        forget();
        res.json({ success: true, ...state(await settings()) });
      } catch (err) { fail(res, err); }
    });
  }

  return { guard, check, register, forget, lockedNow };
}
