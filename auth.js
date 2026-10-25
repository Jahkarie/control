// auth.js: admin accounts. Each person has their own login (email + password, then a 6-digit code from an authenticator
// app, a single-use recovery code, or a passkey), a role (OWNER, ADMIN or DOOR) and sessions that can be seen and ended.
// - Passwords: scrypt (N 2^15, r 8, p 3, a salt per user), stored with their parameters so they can be raised later.
// - 2FA: TOTP (RFC 6238: SHA-1, 6 digits, 30-second steps, one step either side), the secret encrypted at rest with
//   AES-256-GCM under a key derived from TOKEN_SECRET with HKDF (or from ADMIN_ENC_KEY when set). A code's step is
//   remembered, so the same code (or an older one) never works twice. 10 recovery codes, stored only as HMACs, each
//   single-use.
// - Passkeys (optional, WebAuthn through @simplewebauthn/server): a passkey with Face ID / fingerprint signs in on its
//   own (it is both factors). If the library can't load, passkeys are simply off.
// - Sessions: a random 32-byte token in the cookie odr_admin (HttpOnly, Secure except on plain-http localhost,
//   SameSite=Strict, Path=/); the database holds only its SHA-256. 7 days at most; signed out after 2 idle hours
//   (OWNER/ADMIN; 12 on an installed app the person marked as trusted) or 14 (DOOR).
// - CSRF: a change (anything but GET/HEAD/OPTIONS) needs a same-origin request (as before) and the session's x-csrf
//   token, which every signed-in admin page carries in <meta name="odr-csrf"> and sends from its fetch() calls.
// - Lockout: 5 wrong passwords or codes lock the account for 15 minutes, then 30, 60 … up to 24 hours; the same per IP.
//   The answer is always "Wrong email, password or code."
// - requireRole(...roles) guards every admin page and API route (server.js and each module); a page without a session
//   redirects to /admin/login (or /admin/setup while there are no accounts). checkRoutes() refuses to boot if an
//   /admin or /api/admin route has neither a role nor the public marker.
// - ADMIN_KEY: only for /admin/setup (the first OWNER, while there are no accounts) and /admin/recover (emails the
//   owner a link to reset their password and 2FA). With ALLOW_ADMIN_KEY_API=1 (the test harness only; off by default)
//   the x-admin-key header and HTTP Basic (password = ADMIN_KEY) still act as an OWNER, as they did before accounts.
import crypto from 'crypto';
import QRCode from 'qrcode';
import { LOGIN_PAGE, SETUP_PAGE, RECOVER_PAGE, JOIN_PAGE, ACCOUNT_PAGE, TEAM_PAGE, forbiddenPage } from './auth-pages.js';
import { PWA_TAGS } from './admin-ui.js';

export const ROLES = ['OWNER', 'ADMIN', 'DOOR'];
const ROLE_NAME = { OWNER: 'Owner', ADMIN: 'Admin', DOOR: 'Door' };
const SAFE = ['GET', 'HEAD', 'OPTIONS'];
const COOKIE = 'odr_admin';
const ABSOLUTE_MS = 7 * 24 * 3600 * 1000;
const IDLE_MS = { OWNER: 2 * 3600 * 1000, ADMIN: 2 * 3600 * 1000, DOOR: 14 * 3600 * 1000 };
const TRUSTED_IDLE_MS = 12 * 3600 * 1000;
const GENERIC = { error: 'Wrong email, password or code.', code: 'LOGIN_FAILED' };
const ISSUER = "On D' Road Admin";

export async function ensureAuthSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'DOOR')),
      password_hash TEXT NOT NULL,
      totp_secret TEXT,
      totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      totp_last_step BIGINT NOT NULL DEFAULT 0,
      recovery_codes TEXT[] NOT NULL DEFAULT '{}',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ,
      failed_count INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      password_changed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      ip TEXT,
      ip_block TEXT,
      user_agent TEXT,
      device TEXT,
      trusted BOOLEAN NOT NULL DEFAULT FALSE,
      method TEXT,
      revoked_at TIMESTAMPTZ,
      revoked_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS admin_sessions_user_idx ON admin_sessions (user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS admin_links (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('INVITE', 'RECOVER')),
      email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      role TEXT,
      user_id INTEGER REFERENCES admin_users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS admin_passkeys (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      counter BIGINT NOT NULL DEFAULT 0,
      transports TEXT[] NOT NULL DEFAULT '{}',
      name TEXT NOT NULL DEFAULT 'Passkey',
      rp_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ
    );
    -- Who marked a pass paid by hand (the admin's name as it was then), and the same for a ticket order's payment.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS marked_paid_by TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS marked_paid_by_id INTEGER;
  `);
}

// ---------- Crypto ----------
const SCRYPT = { N: 32768, r: 8, p: 3, keylen: 64 };
const scryptAsync = (pw, salt, o) => new Promise((resolve, reject) =>
  crypto.scrypt(pw, salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: 256 * o.N * o.r }, (e, k) => (e ? reject(e) : resolve(k))));
const nfkc = (pw) => String(pw).normalize('NFKC');
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(nfkc(pw), salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
export async function verifyPassword(pw, stored) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]+)\$([\w-]+)$/.exec(String(stored || ''));
  if (!m) return false;
  const want = Buffer.from(m[5], 'base64url');
  const got = await scryptAsync(nfkc(pw), Buffer.from(m[4], 'base64url'), { N: +m[1], r: +m[2], p: +m[3], keylen: want.length });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
// A password: 12 to 200 characters, not just one character over and over, and not the email.
export function passwordProblem(pw, email = '') {
  const s = String(pw || '');
  if ([...s].length < 12) return 'Use at least 12 characters.';
  if (s.length > 200) return 'Use at most 200 characters.';
  if (new Set(s).size < 4) return 'Use a mix of characters.';
  if (email && s.toLowerCase().includes(String(email).split('@')[0].toLowerCase()) && String(email).split('@')[0].length >= 4) return "Don't use your email in your password.";
  return null;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function unbase32(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const c of clean) { value = (value << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
// RFC 6238 / 4226: HMAC-SHA1 of the 8-byte step, dynamic truncation, 6 digits.
export function totpCode(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const o = h[19] & 15;
  const n = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000;
  return String(n).padStart(6, '0');
}
export const totpStep = (ms = Date.now()) => Math.floor(ms / 30000);
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
// The step a code matches (this step, or one either side), newer than lastStep; else null.
function matchTotp(secret, code, lastStep) {
  const now = totpStep();
  for (const s of [now - 1, now, now + 1]) if (s > lastStep && eq(totpCode(secret, s), code)) return s;
  return null;
}

// ---------- Small helpers ----------
const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const validEmail = (v) => v.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(v);
const cleanName = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 60) : '');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rnd = (n = 32) => crypto.randomBytes(n).toString('base64url');
const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const first = (name) => String(name || '').trim().split(/\s+/)[0] || '';

// A browser sends a saved Basic login (and, within this site, the session cookie) with any request here. A change must
// come from our own pages: browsers mark those same-origin (Sec-Fetch-Site, or a matching Origin on older ones), and
// they send JSON, which a plain form can't.
export const crossSite = (req) => {
  const site = req.get('sec-fetch-site');
  if (site) return site !== 'same-origin';
  const origin = req.get('origin');
  if (origin) {
    try { if (new URL(origin).host !== req.get('host')) return true; } catch { return true; }
  }
  return !req.is('application/json');
};

// "Safari on iPhone", "Chrome on Windows" … from the user agent (for the sessions list and the new-device check).
export function deviceLabel(ua) {
  ua = String(ua || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /CrOS/.test(ua) ? 'Chromebook'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'an unknown device';
  const br = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /CriOS|Chrome\//.test(ua) ? 'Chrome'
    : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /node|curl|undici|python/i.test(ua) ? 'A script' : 'A browser';
  return `${br} on ${os}`;
}
// The IP's block: a.b.c.0/24 for IPv4, the first 48 bits for IPv6.
export function ipBlock(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(s);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (s.includes(':')) return s.split(':').slice(0, 3).join(':') + '::/48';
  return s || 'unknown';
}
const antigua = (d = new Date()) => d.toLocaleString('en-US', { timeZone: 'America/Antigua', dateStyle: 'medium', timeStyle: 'short' });

// Where to go after signing in: a path on this site the role may open, else the role's home.
function nextFor(role, next) {
  const n = typeof next === 'string' ? next : '';
  const ok = /^\/(admin|door)(\/|$|\?|#)/.test(n) && !n.startsWith('//') && !/^\/admin\/(login|setup|recover|join)/.test(n);
  if (role === 'DOOR') return ok && /^\/(door|admin\/pickup|admin\/account)(\/|$|\?|#)/.test(n) ? n : '/door';
  return ok ? n : '/admin';
}

export function createAuth({ pool, TOKEN_SECRET, ADMIN_KEY, safeEqual, mail, renderEmail, audit, rateLimit, PUBLIC_URL = '' }) {
  const ALLOW_KEY = process.env.ALLOW_ADMIN_KEY_API === '1';
  const ENC_KEY = Buffer.from(crypto.hkdfSync('sha256', process.env.ADMIN_ENC_KEY || TOKEN_SECRET, 'odr-admin-v1', 'totp-secret', 32));
  const MAC_KEY = Buffer.from(crypto.hkdfSync('sha256', TOKEN_SECRET, 'odr-admin-v1', 'admin-mac', 32));
  const mac = (s) => crypto.createHmac('sha256', MAC_KEY).update(s).digest();
  const csrfOf = (sid) => mac('csrf:' + sid).toString('base64url').slice(0, 32);

  // AES-256-GCM: 'v1.' + base64url(iv | tag | ciphertext).
  function seal(buf) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
    const ct = Buffer.concat([c.update(buf), c.final()]);
    return 'v1.' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
  }
  function open(s) {
    const b = Buffer.from(String(s || '').replace(/^v1\./, ''), 'base64url');
    if (b.length < 29) return null;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]);
    } catch { return null; }
  }

  // Recovery codes: 10 of "xxxxx-xxxxx" (base32, lowercase), kept only as HMACs.
  const recoveryNorm = (c) => String(c || '').toLowerCase().replace(/[^a-z2-7]/g, '');
  const recoveryHash = (c) => mac('rc:' + recoveryNorm(c)).toString('hex');
  function newRecoveryCodes() {
    const codes = Array.from({ length: 10 }, () => { const s = base32(crypto.randomBytes(7)).slice(0, 10).toLowerCase(); return s.slice(0, 5) + '-' + s.slice(5); });
    return { codes, hashes: codes.map(recoveryHash) };
  }

  const DUMMY = hashPassword(rnd(16)); // compared against when the email is unknown, so the timing is the same

  // ---------- In-memory: half-finished sign-ins and enrolments, WebAuthn challenges, per-IP failures ----------
  const pending = new Map();
  const challenges = new Map();
  const ipFails = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
    for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k);
    for (const [k, v] of ipFails) if (v.until < now && now - v.at > 24 * 3600 * 1000) ipFails.delete(k);
  }, 60 * 1000).unref();
  const newPending = (data, ms = 15 * 60 * 1000) => { const t = rnd(24); pending.set(t, { ...data, exp: Date.now() + ms, tries: 0 }); return t; };
  const getPending = (t, kind) => { const p = pending.get(String(t || '')); return p && p.kind === kind && p.exp > Date.now() ? p : null; };

  // 5, 10, 15 … failures: locked for 15, 30, 60 … minutes, at most a day.
  const lockMinutes = (n) => (n > 0 && n % 5 === 0 ? Math.min(15 * 2 ** (n / 5 - 1), 1440) : 0);
  const ipLocked = (ip) => { const x = ipFails.get(ip); return !!(x && x.until > Date.now()); };
  function ipFail(ip) {
    const x = ipFails.get(ip) || { n: 0, until: 0, at: 0 };
    x.n++; x.at = Date.now();
    const m = lockMinutes(x.n); if (m) x.until = Date.now() + m * 60000;
    ipFails.set(ip, x);
    return m;
  }
  async function userFail(id) {
    const r = await pool.query(
      `UPDATE admin_users SET failed_count = failed_count + 1,
         locked_until = CASE WHEN (failed_count + 1) % 5 = 0 THEN NOW() + LEAST(15 * POWER(2, (failed_count + 1) / 5 - 1), 1440) * INTERVAL '1 minute' ELSE locked_until END
       WHERE id = $1 RETURNING failed_count, locked_until`, [id]);
    return r.rows[0];
  }
  const isLocked = (u) => !!(u.locked_until && new Date(u.locked_until) > new Date());

  let usersExist = false;
  async function hasUsers() {
    if (usersExist) return true;
    usersExist = (await pool.query('SELECT EXISTS (SELECT 1 FROM admin_users) AS e')).rows[0].e;
    return usersExist;
  }

  // ---------- Sessions ----------
  const cookieToken = (req) => {
    for (const part of String(req.get('cookie') || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; } }
    }
    return '';
  };
  const plainLocal = (req) => !req.secure && /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(req.hostname || '');
  function setCookie(req, res, value, maxAge) {
    const parts = [`${COOKIE}=${value}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAge}`];
    if (!plainLocal(req)) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
  }
  const clearCookie = (req, res) => setCookie(req, res, '', 0);

  async function sessionOf(req) {
    if (req._odrSession !== undefined) return req._odrSession;
    req._odrSession = null;
    const token = cookieToken(req);
    if (!token || token.length > 100) return null;
    const sid = sha256(token);
    const r = await pool.query(
      `SELECT s.id AS sid, s.created_at AS session_created_at, s.last_seen_at, s.expires_at, s.trusted, s.device, s.revoked_at,
              u.id, u.email, u.name, u.role, u.active, u.totp_enabled
       FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id WHERE s.id = $1`, [sid]);
    const s = r.rows[0];
    if (!s || s.revoked_at || !s.active) return null;
    const now = Date.now();
    const idle = s.trusted && s.role !== 'DOOR' ? TRUSTED_IDLE_MS : IDLE_MS[s.role];
    if (new Date(s.expires_at).getTime() <= now || now - new Date(s.last_seen_at).getTime() > idle) {
      await pool.query("UPDATE admin_sessions SET revoked_at = NOW(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL",
        [sid, new Date(s.expires_at).getTime() <= now ? 'EXPIRED' : 'IDLE']);
      return null;
    }
    if (now - new Date(s.last_seen_at).getTime() > 60 * 1000) await pool.query('UPDATE admin_sessions SET last_seen_at = NOW() WHERE id = $1', [sid]);
    req._odrSession = s;
    return s;
  }
  const adminOf = (s) => ({ id: s.id, email: s.email, name: s.name, role: s.role });
  const KEY_ADMIN = { id: null, email: 'admin-key', name: 'Admin key', role: 'OWNER' };

  // Who is asking: a session, or (ALLOW_ADMIN_KEY_API=1 only) the admin key in x-admin-key or HTTP Basic.
  async function identity(req) {
    const s = await sessionOf(req);
    if (s) return { admin: adminOf(s), via: 'session', session: s };
    if (!ALLOW_KEY) return null;
    let key = req.get('x-admin-key');
    const basic = /^Basic (.+)$/.exec(req.get('authorization') || '');
    const viaBasic = !key && !!basic;
    if (viaBasic) { const d = Buffer.from(basic[1], 'base64').toString(); key = d.slice(d.indexOf(':') + 1); }
    if (key && safeEqual(key, ADMIN_KEY)) return { admin: KEY_ADMIN, via: viaBasic ? 'basic' : 'key' };
    return null;
  }

  // A new session for a user who has passed both steps. Emails them when it's from a device and IP block they haven't
  // used before (not on their very first sign-in).
  async function startSession(req, res, u, { trusted = false, method }) {
    const token = rnd(32), sid = sha256(token);
    const ua = String(req.get('user-agent') || '').slice(0, 400);
    const device = deviceLabel(ua), block = ipBlock(req.ip);
    const seen = (await pool.query(
      `SELECT EXISTS (SELECT 1 FROM admin_sessions WHERE user_id = $1 AND device = $2 AND ip_block = $3) AS seen,
              EXISTS (SELECT 1 FROM admin_sessions WHERE user_id = $1) AS any`, [u.id, device, block])).rows[0];
    await pool.query(
      `INSERT INTO admin_sessions (id, user_id, expires_at, ip, ip_block, user_agent, device, trusted, method)
       VALUES ($1, $2, NOW() + INTERVAL '7 days', $3, $4, $5, $6, $7, $8)`, [sid, u.id, req.ip, block, ua, device, !!trusted && u.role !== 'DOOR', method]);
    await pool.query('UPDATE admin_users SET last_login_at = NOW(), failed_count = 0, locked_until = NULL WHERE id = $1', [u.id]);
    setCookie(req, res, token, ABSOLUTE_MS / 1000);
    usersExist = true;
    const actor = { id: u.id, email: u.email, name: u.name, role: u.role };
    await audit.log(actor, 'login.success', { target_type: 'admin_user', target_id: u.id, ip: req.ip, details: { method, device, trusted: !!trusted } });
    if (!seen.seen && seen.any) {
      audit.log(actor, 'login.new_device', { target_type: 'admin_user', target_id: u.id, ip: req.ip, details: { device, ip_block: block } });
      const base = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
      mail.send(u.email, "New sign-in to On D' Road admin", renderEmail({
        tone: 'warn', tag: 'New sign-in', title: 'Was this you?',
        preheader: `${device} signed in to your admin account.`,
        lines: [`Someone signed in to your On D' Road admin account from a device or place we haven't seen for you before.`,
          "If it was you, there's nothing to do. If it wasn't, log out everywhere and change your password."],
        details: [['Device', device], ['Place', req.ip ? `IP ${String(req.ip).replace(/^::ffff:/, '')}` : 'Unknown'], ['Time', antigua() + ' (Antigua)']],
        cta: { text: "Wasn't you? Log out everywhere", url: `${base}/admin/account?logout-all=1#sessions` },
        fine: 'That link opens your account page. You sign in first, then confirm.'
      })).catch?.(() => {});
    }
    return { sid, csrf: csrfOf(sid) };
  }

  // ---------- requireRole ----------
  // The CSRF token, the role and the app's tags go into every admin page this guard serves, with a small script that
  // adds x-csrf to the page's own fetch() writes and sends the browser to the sign-in page when the session ends.
  const SESSION_JS = `(function () {
  var m = document.querySelector('meta[name="odr-csrf"]'), t = m ? m.content : '';
  var r = document.querySelector('meta[name="odr-role"]');
  document.documentElement.setAttribute('data-role', r ? r.content : '');
  var f = window.fetch;
  window.fetch = function (input, init) {
    init = init || {};
    var url = new URL(typeof input === 'string' ? input : input.url, location.href);
    var method = String(init.method || (input && input.method) || 'GET').toUpperCase();
    var same = url.origin === location.origin;
    if (same && t && method !== 'GET' && method !== 'HEAD') {
      var h = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
      if (!h.has('x-csrf')) h.set('x-csrf', t);
      init = Object.assign({}, init, { headers: h });
    }
    return f.call(this, input, init).then(function (res) {
      if (res.status === 401 && same && url.pathname.indexOf('/api/admin/') === 0 && t) {
        res.clone().json().then(function (d) { if (d && d.code === 'AUTH_REQUIRED') location.href = '/admin/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash); }).catch(function () {});
      }
      return res;
    });
  };
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('[data-logout]');
    if (!a) return;
    e.preventDefault();
    window.fetch('/api/admin/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).finally(function () { location.href = '/admin/login'; });
  });
  if (r && r.content === 'DOOR') document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('a.back[href="/admin"]').forEach(function (a) { a.href = '/door'; a.textContent = 'Back to the scanner'; });
  });
})();`;
  const ROLE_CSS = `<style>html[data-role="ADMIN"] .owner-only, html[data-role="DOOR"] .owner-only, html[data-role="DOOR"] .admin-only { display: none !important; }</style>`;
  function inject(html, who) {
    const csrf = who.session ? csrfOf(who.session.sid) : '';
    const tags = `<meta name="odr-csrf" content="${csrf}"><meta name="odr-role" content="${who.admin.role}"><meta name="odr-user" content="${escAttr(who.admin.name)}">`
      + (html.includes('rel="manifest"') ? '' : PWA_TAGS) + ROLE_CSS + `<script>${SESSION_JS}</script>`;
    const at = html.search(/<meta charset="UTF-8">/i);
    if (at >= 0) { const end = at + '<meta charset="UTF-8">'.length; return html.slice(0, end) + tags + html.slice(end); }
    return html.replace(/<head>/i, (h) => h + tags);
  }

  function requireRole(...roles) {
    const mw = async (req, res, next) => {
      try {
        const page = !req.path.startsWith('/api/');
        const who = await identity(req);
        if (!who) {
          if (page && SAFE.includes(req.method)) {
            return res.redirect(302, (await hasUsers()) ? '/admin/login?next=' + encodeURIComponent(req.originalUrl) : '/admin/setup');
          }
          return res.status(401).json({ error: 'Sign in again.', code: 'AUTH_REQUIRED' });
        }
        if (!roles.includes(who.admin.role)) {
          audit.log(who.admin, 'access.denied', { ip: req.ip, details: { method: req.method, path: req.originalUrl.split('?')[0] } });
          if (page) return res.status(403).type('html').send(forbiddenPage(who.admin));
          return res.status(403).json({ error: "Your role can't do that.", code: 'FORBIDDEN' });
        }
        if (!SAFE.includes(req.method)) {
          if (who.via === 'session') {
            if (crossSite(req)) return res.status(403).json({ error: 'Make changes from the admin pages.' });
            if (!eq(req.get('x-csrf') || '', csrfOf(who.session.sid))) {
              audit.log(who.admin, 'csrf.fail', { ip: req.ip, details: { method: req.method, path: req.originalUrl.split('?')[0] } });
              return res.status(403).json({ error: 'This page is out of date. Reload it and try again.', code: 'CSRF' });
            }
          } else if (who.via === 'basic' && crossSite(req)) {
            return res.status(403).json({ error: 'Make changes from the admin pages.' });
          }
        }
        req.admin = who.admin;
        req.adminVia = who.via;
        req.adminSession = who.session || null;
        if (!SAFE.includes(req.method)) await audit.hook(req, res);
        else if (page) {
          res.set('Cache-Control', 'no-store');
          const send = res.send;
          res.send = function (body) {
            if (typeof body === 'string' && /^\s*<!DOCTYPE html/i.test(body)) body = inject(body, who);
            return send.call(this, body);
          };
        }
        next();
      } catch (err) {
        console.error('Auth error:', err);
        res.status(500).json({ error: 'Server error.' });
      }
    };
    mw.roles = roles;
    return mw;
  }
  // Marks a route under /admin or /api/admin that needs no account (sign-in, setup, the app's icons …).
  const publicRoute = (req, res, next) => next();
  publicRoute.public = true;

  // The door's API accepts a session of any role (with the CSRF token on writes), besides DOOR_KEY. Returns
  // { admin } for a session, { forbidden } for a write without the token, or null (no session: try the key).
  async function doorIdentity(req) {
    const s = await sessionOf(req);
    if (!s) return null;
    if (!SAFE.includes(req.method) && (crossSite(req) || !eq(req.get('x-csrf') || '', csrfOf(s.sid)))) return { forbidden: true };
    return { admin: adminOf(s) };
  }

  // ---------- Enrolment (a new 2FA secret): the otpauth URI, its QR (drawn here) and the secret for typing in ----------
  async function totpPayload(email, secret) {
    const b32 = base32(secret);
    const label = encodeURIComponent(ISSUER) + ':' + encodeURIComponent(email);
    const uri = `otpauth://totp/${label}?secret=${b32}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30`;
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 264, errorCorrectionLevel: 'M', color: { dark: '#0a0a0b', light: '#ffffff' } });
    return { otpauth: uri, qr, secret: b32, secret_text: b32.match(/.{1,4}/g).join(' ') };
  }

  // Saves a user's new 2FA secret (already confirmed with a code at step) and new recovery codes. Returns the codes.
  async function saveTotp(db, userId, secret, step) {
    const rc = newRecoveryCodes();
    await db.query('UPDATE admin_users SET totp_secret = $2, totp_enabled = TRUE, totp_last_step = $3, recovery_codes = $4 WHERE id = $1',
      [userId, seal(secret), step, rc.hashes]);
    return rc.codes;
  }

  // ---------- WebAuthn (passkeys): optional ----------
  let wa = null;
  const waReady = import('@simplewebauthn/server').then((m) => { wa = m; }).catch((err) => console.log('Passkeys are off:', err.message));
  const rpOf = (req) => ({ rpID: req.hostname, origin: `${req.protocol}://${req.get('host')}` });

  // ---------- Routes ----------
  function register({ app, express }) {
    const json = express.json({ limit: '20kb' });
    const sameOrigin = (req, res, next) => (crossSite(req) ? res.status(403).json({ error: 'Use the sign-in page.' }) : next());
    const limit = rateLimit(120, 15 * 60 * 1000);
    const pub = [publicRoute, limit, json, sameOrigin];
    const ANY = requireRole('OWNER', 'ADMIN', 'DOOR');
    const OWNER = requireRole('OWNER');
    const fail = (res, err) => { console.error('Auth error:', err); res.status(500).json({ error: 'Server error.' }); };
    const page = (html) => (req, res) => res.type('html').set('Cache-Control', 'no-store').send(html);

    // Pages before sign-in.
    app.get('/admin/login', publicRoute, async (req, res) => {
      try { if (!(await hasUsers())) return res.redirect(302, '/admin/setup'); page(LOGIN_PAGE)(req, res); } catch (err) { fail(res, err); }
    });
    app.get('/admin/setup', publicRoute, async (req, res) => {
      try { if (await hasUsers()) return res.redirect(302, '/admin/login'); page(SETUP_PAGE)(req, res); } catch (err) { fail(res, err); }
    });
    app.get('/admin/recover', publicRoute, page(RECOVER_PAGE));
    app.get('/admin/join', publicRoute, page(JOIN_PAGE));

    // What the sign-in pages need to know: whether setup is still to do, whether passkeys work here, who's signed in.
    app.get('/api/admin/auth/state', publicRoute, async (req, res) => {
      try {
        await waReady;
        const s = await sessionOf(req);
        res.set('Cache-Control', 'no-store').json({ setup_needed: !(await hasUsers()), passkeys: !!wa,
          me: s ? { name: s.name, role: s.role, next: nextFor(s.role, req.query.next) } : null });
      } catch (err) { fail(res, err); }
    });

    // ---- Sign in, step 1: email and password ----
    app.post('/api/admin/auth/login', ...pub, async (req, res) => {
      const email = norm(req.body?.email), password = String(req.body?.password || '').slice(0, 300);
      try {
        if (ipLocked(req.ip)) {
          await verifyPassword(password, await DUMMY);
          audit.log(null, 'login.locked', { ip: req.ip, details: { email, step: 'password', by: 'ip' } });
          return res.status(401).json(GENERIC);
        }
        const u = email ? (await pool.query('SELECT * FROM admin_users WHERE email = $1', [email])).rows[0] : null;
        if (!u || !u.active) {
          await verifyPassword(password, await DUMMY);
          const m = ipFail(req.ip);
          audit.log(null, m ? 'login.lockout' : 'login.fail', { ip: req.ip, details: { email, step: 'password', reason: u ? 'inactive' : 'unknown email', ...(m ? { by: 'ip', minutes: m } : {}) } });
          return res.status(401).json(GENERIC);
        }
        const actor = { id: u.id, email: u.email, name: u.name, role: u.role };
        if (isLocked(u)) {
          await verifyPassword(password, await DUMMY);
          ipFail(req.ip);
          audit.log(actor, 'login.locked', { target_type: 'admin_user', target_id: u.id, ip: req.ip, details: { step: 'password', by: 'account', until: u.locked_until } });
          return res.status(401).json(GENERIC);
        }
        if (!(await verifyPassword(password, u.password_hash))) {
          const f = await userFail(u.id);
          const m = ipFail(req.ip);
          const locked = lockMinutes(f.failed_count);
          audit.log(actor, locked || m ? 'login.lockout' : 'login.fail', { target_type: 'admin_user', target_id: u.id, ip: req.ip,
            details: { step: 'password', failed: f.failed_count, ...(locked ? { by: 'account', minutes: locked } : m ? { by: 'ip', minutes: m } : {}) } });
          return res.status(401).json(GENERIC);
        }
        const trusted = req.body?.trusted === true;
        // 2FA reset by the owner (or never set): set it up now, before any session.
        if (!u.totp_enabled || !u.totp_secret) {
          const secret = crypto.randomBytes(20);
          const ticket = newPending({ kind: 'enroll', uid: u.id, secret, trusted });
          return res.json({ step: 'enroll', ticket, ...(await totpPayload(u.email, secret)) });
        }
        await waReady;
        const keys = wa ? (await pool.query('SELECT COUNT(*)::int AS n FROM admin_passkeys WHERE user_id = $1', [u.id])).rows[0].n : 0;
        res.json({ step: 'code', ticket: newPending({ kind: 'login', uid: u.id, trusted }, 10 * 60 * 1000), passkey: keys > 0 });
      } catch (err) { fail(res, err); }
    });

    // ---- Sign in, step 2: the 6-digit code, or a recovery code ----
    app.post('/api/admin/auth/login/code', ...pub, async (req, res) => {
      const p = getPending(req.body?.ticket, 'login');
      const raw = String(req.body?.code || '').trim().slice(0, 40);
      try {
        if (!p) return res.status(401).json({ ...GENERIC, restart: true });
        const u = (await pool.query('SELECT * FROM admin_users WHERE id = $1', [p.uid])).rows[0];
        if (!u || !u.active) { pending.delete(req.body.ticket); return res.status(401).json({ ...GENERIC, restart: true }); }
        const actor = { id: u.id, email: u.email, name: u.name, role: u.role };
        if (ipLocked(req.ip) || isLocked(u)) {
          ipFail(req.ip);
          audit.log(actor, 'login.locked', { target_type: 'admin_user', target_id: u.id, ip: req.ip, details: { step: 'code', by: isLocked(u) ? 'account' : 'ip' } });
          return res.status(401).json(GENERIC);
        }
        let method = null, left = null;
        const digits = raw.replace(/\s/g, '');
        if (/^\d{6}$/.test(digits)) {
          const secret = open(u.totp_secret);
          const step = secret ? matchTotp(secret, digits, Number(u.totp_last_step)) : null;
          // The step is saved only if it's newer than the last one used, so the same code can't be used twice, even by
          // two requests at once.
          if (step !== null && (await pool.query('UPDATE admin_users SET totp_last_step = $2 WHERE id = $1 AND totp_last_step < $2', [u.id, step])).rowCount) method = 'totp';
        } else if (recoveryNorm(raw).length === 10) {
          const r = await pool.query(
            `UPDATE admin_users SET recovery_codes = array_remove(recovery_codes, $2) WHERE id = $1 AND $2 = ANY(recovery_codes)
             RETURNING cardinality(recovery_codes) AS left`, [u.id, recoveryHash(raw)]);
          if (r.rowCount) { method = 'recovery'; left = r.rows[0].left; }
        }
        if (!method) {
          const f = await userFail(u.id);
          const m = ipFail(req.ip);
          const locked = lockMinutes(f.failed_count);
          if (++p.tries >= 5) pending.delete(req.body.ticket);
          audit.log(actor, locked || m ? 'login.lockout' : 'login.fail', { target_type: 'admin_user', target_id: u.id, ip: req.ip,
            details: { step: 'code', failed: f.failed_count, ...(locked ? { by: 'account', minutes: locked } : m ? { by: 'ip', minutes: m } : {}) } });
          return res.status(401).json(GENERIC);
        }
        pending.delete(req.body.ticket);
        if (method === 'recovery') audit.log(actor, 'recovery.use', { target_type: 'admin_user', target_id: u.id, ip: req.ip, details: { left } });
        await startSession(req, res, u, { trusted: p.trusted || req.body?.trusted === true, method });
        res.json({ success: true, user: { name: u.name, role: u.role }, next: nextFor(u.role, req.body?.next), recovery_left: left });
      } catch (err) { fail(res, err); }
    });

    // ---- Sign in after the owner reset this person's 2FA: confirm a code from the new secret ----
    app.post('/api/admin/auth/login/enroll', ...pub, async (req, res) => {
      const p = getPending(req.body?.ticket, 'enroll');
      try {
        if (!p) return res.status(401).json({ ...GENERIC, restart: true });
        const step = matchTotp(p.secret, String(req.body?.code || '').replace(/\s/g, ''), 0);
        if (step === null) {
          if (++p.tries >= 5) pending.delete(req.body.ticket);
          return res.status(400).json({ error: "That code didn't match. Check the time on your phone and try the newest code.", code: 'CODE_WRONG' });
        }
        const u = (await pool.query('SELECT * FROM admin_users WHERE id = $1 AND active', [p.uid])).rows[0];
        if (!u) return res.status(401).json({ ...GENERIC, restart: true });
        pending.delete(req.body.ticket);
        const codes = await saveTotp(pool, u.id, p.secret, step);
        audit.log({ id: u.id, email: u.email, name: u.name, role: u.role }, '2fa.enroll', { target_type: 'admin_user', target_id: u.id, ip: req.ip });
        await startSession(req, res, u, { trusted: p.trusted, method: 'enroll' });
        res.json({ success: true, recovery_codes: codes, next: nextFor(u.role, req.body?.next) });
      } catch (err) { fail(res, err); }
    });

    // ---- Passkeys: sign in with one (it counts as both steps) ----
    // { ticket } after the password step limits it to that person's passkeys; without one, any passkey on the device.
    app.post('/api/admin/auth/passkey/options', ...pub, async (req, res) => {
      try {
        await waReady;
        if (!wa) return res.status(404).json({ error: "Passkeys aren't available.", code: 'PASSKEYS_OFF' });
        const p = req.body?.ticket ? getPending(req.body.ticket, 'login') : null;
        const allow = p ? (await pool.query('SELECT credential_id, transports FROM admin_passkeys WHERE user_id = $1', [p.uid])).rows : [];
        const { rpID } = rpOf(req);
        const options = await wa.generateAuthenticationOptions({ rpID, userVerification: 'required', timeout: 120000,
          allowCredentials: allow.map((c) => ({ id: c.credential_id, transports: c.transports })) });
        const id = rnd(18);
        challenges.set(id, { challenge: options.challenge, uid: p ? p.uid : null, exp: Date.now() + 5 * 60 * 1000 });
        res.json({ id, options });
      } catch (err) { fail(res, err); }
    });
    app.post('/api/admin/auth/passkey/verify', ...pub, async (req, res) => {
      const ch = challenges.get(String(req.body?.id || ''));
      challenges.delete(String(req.body?.id || ''));
      try {
        await waReady;
        if (!wa || !ch || ch.exp < Date.now() || ipLocked(req.ip)) return res.status(401).json(GENERIC);
        const credId = String(req.body?.response?.id || '');
        const row = (await pool.query(
          `SELECT k.*, u.email, u.name, u.role, u.active, u.locked_until FROM admin_passkeys k JOIN admin_users u ON u.id = k.user_id WHERE k.credential_id = $1`, [credId])).rows[0];
        const reject = (why) => {
          const m = ipFail(req.ip);
          audit.log(row ? { id: row.user_id, email: row.email, name: row.name, role: row.role } : null, m ? 'login.lockout' : 'login.fail',
            { target_type: row ? 'admin_user' : null, target_id: row ? row.user_id : null, ip: req.ip, details: { step: 'passkey', reason: why } });
          return res.status(401).json(GENERIC);
        };
        if (!row || !row.active || (ch.uid && ch.uid !== row.user_id)) return reject('unknown passkey');
        if (isLocked(row)) return reject('locked');
        const { rpID, origin } = rpOf(req);
        let v;
        try {
          v = await wa.verifyAuthenticationResponse({ response: req.body.response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID,
            requireUserVerification: true,
            credential: { id: row.credential_id, publicKey: Buffer.from(row.public_key, 'base64url'), counter: Number(row.counter), transports: row.transports } });
        } catch (e) { return reject('did not verify'); }
        if (!v.verified) return reject('did not verify');
        await pool.query('UPDATE admin_passkeys SET counter = $2, last_used_at = NOW() WHERE id = $1', [row.id, v.authenticationInfo.newCounter]);
        const u = (await pool.query('SELECT * FROM admin_users WHERE id = $1', [row.user_id])).rows[0];
        await startSession(req, res, u, { trusted: req.body?.trusted === true, method: 'passkey' });
        res.json({ success: true, user: { name: u.name, role: u.role }, next: nextFor(u.role, req.body?.next) });
      } catch (err) { fail(res, err); }
    });

    // ---- First owner: ADMIN_KEY, then 2FA, while there are no accounts ----
    async function keyOk(req, res, what) {
      if (ipLocked(req.ip)) { res.status(401).json({ error: 'That key is not right.' }); return false; }
      if (!safeEqual(String(req.body?.key || ''), ADMIN_KEY)) {
        const m = ipFail(req.ip);
        audit.log(null, m ? `${what}.lockout` : `${what}.fail`, { ip: req.ip, details: { reason: 'wrong key', email: norm(req.body?.email) } });
        res.status(401).json({ error: 'That key is not right.' });
        return false;
      }
      return true;
    }
    function accountInput(b, { needEmail = true } = {}) {
      const email = norm(b?.email), name = cleanName(b?.name), password = String(b?.password || '');
      if (needEmail && !validEmail(email)) return { error: 'Enter a valid email.', field: 'email' };
      if (name.length < 2) return { error: 'Enter your name.', field: 'name' };
      const why = passwordProblem(password, email);
      if (why) return { error: why, field: 'password' };
      return { email, name, password };
    }
    app.post('/api/admin/auth/setup/start', ...pub, async (req, res) => {
      try {
        if (await hasUsers()) return res.status(409).json({ error: 'Setup is done. Sign in instead.', code: 'SETUP_DONE' });
        if (!(await keyOk(req, res, 'setup'))) return;
        const a = accountInput(req.body);
        if (a.error) return res.status(400).json(a);
        const secret = crypto.randomBytes(20);
        const ticket = newPending({ kind: 'setup', email: a.email, name: a.name, hash: await hashPassword(a.password), secret });
        res.json({ ticket, ...(await totpPayload(a.email, secret)) });
      } catch (err) { fail(res, err); }
    });
    app.post('/api/admin/auth/setup/finish', ...pub, async (req, res) => {
      const p = getPending(req.body?.ticket, 'setup');
      if (!p) return res.status(400).json({ error: 'Start again: that setup expired.', code: 'RESTART' });
      const step = matchTotp(p.secret, String(req.body?.code || '').replace(/\s/g, ''), 0);
      if (step === null) {
        if (++p.tries >= 8) pending.delete(req.body.ticket);
        return res.status(400).json({ error: "That code didn't match. Check the time on your phone and try the newest code.", code: 'CODE_WRONG' });
      }
      let client, user, codes;
      try {
        client = await pool.connect();
        await client.query('BEGIN');
        await client.query('LOCK TABLE admin_users IN EXCLUSIVE MODE');
        if ((await client.query('SELECT 1 FROM admin_users LIMIT 1')).rowCount) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Setup is done. Sign in instead.', code: 'SETUP_DONE' });
        }
        user = (await client.query(
          `INSERT INTO admin_users (email, name, role, password_hash, password_changed_at) VALUES ($1, $2, 'OWNER', $3, NOW()) RETURNING *`,
          [p.email, p.name, p.hash])).rows[0];
        codes = await saveTotp(client, user.id, p.secret, step);
        await client.query('COMMIT');
      } catch (err) {
        await client?.query('ROLLBACK').catch(() => {});
        return fail(res, err);
      } finally { client?.release(); }
      pending.delete(req.body.ticket);
      usersExist = true;
      try {
        await audit.log({ id: user.id, email: user.email, name: user.name, role: 'OWNER' }, 'setup.owner', { target_type: 'admin_user', target_id: user.id, ip: req.ip });
        await startSession(req, res, user, { method: 'setup' });
        res.json({ success: true, recovery_codes: codes, next: '/admin' });
      } catch (err) { fail(res, err); }
    });

    // ---- Recovery: ADMIN_KEY + the owner's email → a link emailed to that owner (1 hour) ----
    app.post('/api/admin/auth/recover/request', ...pub, async (req, res) => {
      try {
        if (!(await keyOk(req, res, 'recover'))) return;
        const email = norm(req.body?.email);
        const generic = { success: true, message: "If that's an owner's email, a recovery link is on its way to it. It works for an hour." };
        const u = validEmail(email) ? (await pool.query("SELECT * FROM admin_users WHERE email = $1 AND role = 'OWNER' AND active", [email])).rows[0] : null;
        audit.log(u ? { id: u.id, email: u.email, name: u.name, role: u.role } : null, 'recover.request', { target_type: 'admin_user', target_id: u?.id ?? null, ip: req.ip, details: { email, sent: !!u } });
        if (!u) return res.json(generic);
        const token = rnd(32);
        await pool.query("UPDATE admin_links SET revoked_at = NOW() WHERE kind = 'RECOVER' AND user_id = $1 AND used_at IS NULL AND revoked_at IS NULL", [u.id]);
        await pool.query(`INSERT INTO admin_links (kind, email, name, role, user_id, token_hash, expires_at) VALUES ('RECOVER', $1, $2, $3, $4, $5, NOW() + INTERVAL '1 hour')`,
          [u.email, u.name, u.role, u.id, sha256(token)]);
        const base = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
        const err = await mail.send(u.email, "Reset your On D' Road admin sign-in", renderEmail({
          tone: 'warn', tag: 'Account recovery', title: 'Reset your sign-in',
          preheader: 'Set a new password and a new 2FA code. The link works for an hour.',
          lines: [`${first(u.name) || 'Hi'}, someone used the admin key to ask for a recovery link for your owner account.`,
            "The link lets you set a new password and a new authenticator code. It also signs out every device and removes your passkeys. It works once, for an hour.",
            "Didn't ask for this? Ignore this email: nothing changes. Then change the admin key, since someone else has it."],
          cta: { text: 'Reset my sign-in', url: `${base}/admin/recover?token=${token}`, fallback: true }
        }));
        if (err) console.error('Recovery email failed:', err.message || err);
        res.json(generic);
      } catch (err) { fail(res, err); }
    });
    const linkOf = async (token, kind) => (await pool.query(
      `SELECT * FROM admin_links WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`, [sha256(String(token || '')), kind])).rows[0];
    app.post('/api/admin/auth/recover/start', ...pub, async (req, res) => {
      try {
        const link = await linkOf(req.body?.token, 'RECOVER');
        if (!link) return res.status(400).json({ error: 'This recovery link has expired or been used. Ask for a new one.', code: 'LINK_INVALID' });
        const why = passwordProblem(req.body?.password, link.email);
        if (why) return res.status(400).json({ error: why, field: 'password' });
        const secret = crypto.randomBytes(20);
        const ticket = newPending({ kind: 'recover', uid: link.user_id, linkId: link.id, hash: await hashPassword(req.body.password), secret });
        res.json({ ticket, email: link.email, ...(await totpPayload(link.email, secret)) });
      } catch (err) { fail(res, err); }
    });
    app.post('/api/admin/auth/recover/finish', ...pub, async (req, res) => {
      const p = getPending(req.body?.ticket, 'recover');
      if (!p) return res.status(400).json({ error: 'Start again: that expired.', code: 'RESTART' });
      const step = matchTotp(p.secret, String(req.body?.code || '').replace(/\s/g, ''), 0);
      if (step === null) {
        if (++p.tries >= 8) pending.delete(req.body.ticket);
        return res.status(400).json({ error: "That code didn't match. Check the time on your phone and try the newest code.", code: 'CODE_WRONG' });
      }
      let client, u, codes;
      try {
        client = await pool.connect();
        await client.query('BEGIN');
        const used = await client.query('UPDATE admin_links SET used_at = NOW() WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()', [p.linkId]);
        if (!used.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'This recovery link has expired or been used. Ask for a new one.', code: 'LINK_INVALID' }); }
        u = (await client.query(
          `UPDATE admin_users SET password_hash = $2, password_changed_at = NOW(), failed_count = 0, locked_until = NULL, active = TRUE WHERE id = $1 RETURNING *`,
          [p.uid, p.hash])).rows[0];
        codes = await saveTotp(client, u.id, p.secret, step);
        await client.query('DELETE FROM admin_passkeys WHERE user_id = $1', [u.id]);
        await client.query("UPDATE admin_sessions SET revoked_at = NOW(), revoked_reason = 'RECOVERY' WHERE user_id = $1 AND revoked_at IS NULL", [u.id]);
        await client.query('COMMIT');
      } catch (err) {
        await client?.query('ROLLBACK').catch(() => {});
        return fail(res, err);
      } finally { client?.release(); }
      pending.delete(req.body.ticket);
      try {
        await audit.log({ id: u.id, email: u.email, name: u.name, role: u.role }, 'recover.complete', { target_type: 'admin_user', target_id: u.id, ip: req.ip });
        await startSession(req, res, u, { method: 'recovery-link' });
        res.json({ success: true, recovery_codes: codes, next: nextFor(u.role) });
      } catch (err) { fail(res, err); }
    });

    // ---- Joining the team from an invite link (48 hours) ----
    app.get('/api/admin/auth/join/info', publicRoute, limit, async (req, res) => {
      try {
        const link = await linkOf(req.query.token, 'INVITE');
        if (!link) return res.status(404).json({ error: 'This invite link has expired or been used. Ask the owner for a new one.', code: 'LINK_INVALID' });
        res.set('Cache-Control', 'no-store').json({ email: link.email, name: link.name, role: link.role, role_name: ROLE_NAME[link.role] });
      } catch (err) { fail(res, err); }
    });
    app.post('/api/admin/auth/join/start', ...pub, async (req, res) => {
      try {
        const link = await linkOf(req.body?.token, 'INVITE');
        if (!link) return res.status(400).json({ error: 'This invite link has expired or been used. Ask the owner for a new one.', code: 'LINK_INVALID' });
        const a = accountInput({ ...req.body, email: link.email });
        if (a.error) return res.status(400).json(a);
        const secret = crypto.randomBytes(20);
        const ticket = newPending({ kind: 'join', linkId: link.id, name: a.name, hash: await hashPassword(a.password), secret });
        res.json({ ticket, email: link.email, ...(await totpPayload(link.email, secret)) });
      } catch (err) { fail(res, err); }
    });
    app.post('/api/admin/auth/join/finish', ...pub, async (req, res) => {
      const p = getPending(req.body?.ticket, 'join');
      if (!p) return res.status(400).json({ error: 'Start again: that expired.', code: 'RESTART' });
      const step = matchTotp(p.secret, String(req.body?.code || '').replace(/\s/g, ''), 0);
      if (step === null) {
        if (++p.tries >= 8) pending.delete(req.body.ticket);
        return res.status(400).json({ error: "That code didn't match. Check the time on your phone and try the newest code.", code: 'CODE_WRONG' });
      }
      let client, u, codes, link;
      try {
        client = await pool.connect();
        await client.query('BEGIN');
        link = (await client.query(
          `UPDATE admin_links SET used_at = NOW() WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW() RETURNING *`, [p.linkId])).rows[0];
        if (!link) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'This invite link has expired or been used. Ask the owner for a new one.', code: 'LINK_INVALID' }); }
        if ((await client.query('SELECT 1 FROM admin_users WHERE email = $1', [link.email])).rowCount) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'There is already an account for this email. Sign in instead.', code: 'EXISTS' });
        }
        u = (await client.query(
          `INSERT INTO admin_users (email, name, role, password_hash, password_changed_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
          [link.email, p.name, link.role, p.hash])).rows[0];
        codes = await saveTotp(client, u.id, p.secret, step);
        await client.query('COMMIT');
      } catch (err) {
        await client?.query('ROLLBACK').catch(() => {});
        return fail(res, err);
      } finally { client?.release(); }
      pending.delete(req.body.ticket);
      try {
        await audit.log({ id: u.id, email: u.email, name: u.name, role: u.role }, 'team.join', { target_type: 'admin_user', target_id: u.id, ip: req.ip, details: { role: u.role, invited_by: link.created_by } });
        await startSession(req, res, u, { method: 'join' });
        res.json({ success: true, recovery_codes: codes, next: nextFor(u.role) });
      } catch (err) { fail(res, err); }
    });

    // ---- Signed in: who am I, sign out ----
    app.get('/api/admin/auth/me', ANY, async (req, res) => {
      try {
        await waReady;
        if (!req.adminSession) return res.json({ user: req.admin, via: req.adminVia, csrf: '' });
        const u = (await pool.query('SELECT cardinality(recovery_codes) AS rc, totp_enabled, (SELECT COUNT(*)::int FROM admin_passkeys WHERE user_id = admin_users.id) AS passkeys FROM admin_users WHERE id = $1', [req.admin.id])).rows[0];
        res.set('Cache-Control', 'no-store').json({ user: { ...req.admin, role_name: ROLE_NAME[req.admin.role] }, csrf: csrfOf(req.adminSession.sid),
          session: { device: req.adminSession.device, trusted: req.adminSession.trusted, created_at: req.adminSession.session_created_at },
          recovery_left: u.rc, totp: u.totp_enabled, passkeys: u.passkeys, webauthn: !!wa });
      } catch (err) { fail(res, err); }
    });
    app.post('/api/admin/auth/logout', ANY, async (req, res) => {
      try {
        if (req.adminSession) await pool.query("UPDATE admin_sessions SET revoked_at = NOW(), revoked_reason = 'LOGOUT' WHERE id = $1 AND revoked_at IS NULL", [req.adminSession.sid]);
        clearCookie(req, res);
        res.json({ success: true });
      } catch (err) { fail(res, err); }
    });
    app.post('/api/admin/auth/logout-all', ANY, async (req, res) => {
      try {
        if (!req.admin.id) return res.status(400).json({ error: 'Sign in with your account first.' });
        const r = await pool.query("UPDATE admin_sessions SET revoked_at = NOW(), revoked_reason = 'LOGOUT_ALL' WHERE user_id = $1 AND revoked_at IS NULL", [req.admin.id]);
        req.auditExtra = { sessions: r.rowCount };
        clearCookie(req, res);
        res.json({ success: true, ended: r.rowCount });
      } catch (err) { fail(res, err); }
    });

    // ---- Your account ----
    app.get('/admin/account', ANY, page(ACCOUNT_PAGE));
    const needAccount = (req, res) => { if (req.admin.id) return true; res.status(400).json({ error: 'Sign in with your account first.' }); return false; };
    async function checkPassword(req, res) {
      const u = (await pool.query('SELECT * FROM admin_users WHERE id = $1', [req.admin.id])).rows[0];
      if (u && !isLocked(u) && await verifyPassword(String(req.body?.current || ''), u.password_hash)) return u;
      if (u) await userFail(u.id);
      res.status(400).json({ error: "That isn't your current password.", field: 'current' });
      return null;
    }
    app.post('/api/admin/auth/account/password', ANY, async (req, res) => {
      try {
        if (!needAccount(req, res)) return;
        const why = passwordProblem(req.body?.password, req.admin.email);
        if (why) return res.status(400).json({ error: why, field: 'password' });
        if (!(await checkPassword(req, res))) return;
        await pool.query('UPDATE admin_users SET password_hash = $2, password_changed_at = NOW() WHERE id = $1', [req.admin.id, await hashPassword(req.body.password)]);
        const r = await pool.query("UPDATE admin_sessions SET revoked_at = NOW(), revoked_reason = 'PASSWORD' WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL", [req.admin.id, req.adminSession.sid]);
        req.auditExtra = { other_sessions_ended: r.rowCount };
        res.json({ success: true, other_sessions_ended: r.rowCount });
      } catch (err) { fail(res, err); }
    });
    app.post('/api/admin/auth/account/2fa/start', ANY, async (req, res) => {
      try {
        if (!needAccount(req, res)) return;
        if (!(await checkPassword(req, res))) return;
        const secret = crypto.randomBytes(20);
        const ticket = newPending({ kind: 'reenroll', uid: req.admin.id, secret });
        res.json({ ticket, ...(await totpPayload(req.admin.email, secret)) });
      } catch (err) { fail(res, err); }
    });
    app.post('/api/admin/auth/account/2fa/finish', ANY, async (req, res) => {
      try {
        const p = getPending(req.body?.ticket, 'reenroll');
        if (!p || p.uid !== req.admin.id) return res.status(400).json({ error: 'Start again: that expired.', code: 'RESTART' });
        const step = matchTotp(p.secret, String(req.body?.code || '').replace(/\s/g, ''), 0);
        if (step === null) {
          if (++p.tries >= 8) pending.delete(req.body.ticket);
          return res.status(400).json({ error: "That code didn't match. Check the time on your phone and try the newest code.", code: 'CODE_WRONG' });
        }
        pending.delete(req.body.ticket);
        res.json({ success: true, recovery_codes: await saveTotp(pool, req.admin.id, p.secret, step) });
      } catch (err) { fail(res, err); }
    });
    app.post('/api/admin/auth/account/recovery-codes', ANY, async (req, res) => {
      try {
        if (!needAccount(req, res)) return;
        if (!(await checkPassword(req, res))) return;
        const rc = newRecoveryCodes();
        await pool.query('UPDATE admin_users SET recovery_codes = $2 WHERE id = $1', [req.admin.id, rc.hashes]);
        res.json({ success: true, recovery_codes: rc.codes });
      } catch (err) { fail(res, err); }
    });
    app.get('/api/admin/auth/account/sessions', ANY, async (req, res) => {
      try {
        if (!req.admin.id) return res.json({ sessions: [] });
        const r = await pool.query(
          `SELECT substr(id, 1, 16) AS id, created_at, last_seen_at, expires_at, ip, device, trusted, method, id = $2 AS current
           FROM admin_sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW() ORDER BY last_seen_at DESC`, [req.admin.id, req.adminSession?.sid || '']);
        res.set('Cache-Control', 'no-store').json({ sessions: r.rows });
      } catch (err) { fail(res, err); }
    });
    app.post('/api/admin/auth/account/sessions/:id/revoke', ANY, async (req, res) => {
      try {
        if (!needAccount(req, res)) return;
        const id = String(req.params.id || '');
        if (!/^[0-9a-f]{16}$/.test(id)) return res.status(400).json({ error: 'Unknown session.' });
        const r = await pool.query("UPDATE admin_sessions SET revoked_at = NOW(), revoked_reason = 'REVOKED' WHERE user_id = $1 AND substr(id, 1, 16) = $2 AND revoked_at IS NULL RETURNING id",
          [req.admin.id, id]);
        if (!r.rowCount) return res.status(404).json({ error: 'That session has already ended.' });
        if (r.rows.some((x) => x.id === req.adminSession.sid)) clearCookie(req, res);
        res.json({ success: true, current: r.rows.some((x) => x.id === req.adminSession.sid) });
      } catch (err) { fail(res, err); }
    });
    // Passkeys of your own.
    app.get('/api/admin/auth/account/passkeys', ANY, async (req, res) => {
      try {
        await waReady;
        const r = req.admin.id ? await pool.query('SELECT id, name, created_at, last_used_at FROM admin_passkeys WHERE user_id = $1 ORDER BY id', [req.admin.id]) : { rows: [] };
        res.set('Cache-Control', 'no-store').json({ available: !!wa, passkeys: r.rows });
      } catch (err) { fail(res, err); }
    });
    app.post('/api/admin/auth/account/passkeys/options', ANY, async (req, res) => {
      try {
        await waReady;
        if (!wa) return res.status(404).json({ error: "Passkeys aren't available.", code: 'PASSKEYS_OFF' });
        if (!needAccount(req, res)) return;
        const mine = (await pool.query('SELECT credential_id, transports FROM admin_passkeys WHERE user_id = $1', [req.admin.id])).rows;
        const { rpID } = rpOf(req);
        const options = await wa.generateRegistrationOptions({ rpName: ISSUER, rpID, userName: req.admin.email, userDisplayName: req.admin.name,
          userID: new TextEncoder().encode('odr-admin-' + req.admin.id), attestationType: 'none', timeout: 120000,
          excludeCredentials: mine.map((c) => ({ id: c.credential_id, transports: c.transports })),
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' } });
        challenges.set('reg:' + req.admin.id, { challenge: options.challenge, exp: Date.now() + 5 * 60 * 1000 });
        res.json({ options });
      } catch (err) { fail(res, err); }
    });
    app.post('/api/admin/auth/account/passkeys/verify', ANY, async (req, res) => {
      try {
        await waReady;
        const ch = challenges.get('reg:' + req.admin.id);
        challenges.delete('reg:' + req.admin.id);
        if (!wa || !ch || ch.exp < Date.now()) return res.status(400).json({ error: 'Start again: that took too long.', code: 'RESTART' });
        const { rpID, origin } = rpOf(req);
        let v;
        try {
          v = await wa.verifyRegistrationResponse({ response: req.body?.response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
        } catch (e) { return res.status(400).json({ error: "That passkey couldn't be added. Try again." }); }
        if (!v.verified || !v.registrationInfo) return res.status(400).json({ error: "That passkey couldn't be added. Try again." });
        const c = v.registrationInfo.credential;
        const name = cleanName(req.body?.name) || deviceLabel(req.get('user-agent'));
        const r = await pool.query(
          `INSERT INTO admin_passkeys (user_id, credential_id, public_key, counter, transports, name, rp_id) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (credential_id) DO NOTHING RETURNING id`,
          [req.admin.id, c.id, Buffer.from(c.publicKey).toString('base64url'), c.counter || 0, c.transports || [], name, rpID]);
        if (!r.rowCount) return res.status(409).json({ error: 'That passkey is already added.' });
        req.auditExtra = { name };
        res.json({ success: true, id: r.rows[0].id });
      } catch (err) { fail(res, err); }
    });
    app.post('/api/admin/auth/account/passkeys/:id/delete', ANY, async (req, res) => {
      try {
        const r = await pool.query('DELETE FROM admin_passkeys WHERE id = $1 AND user_id = $2 RETURNING name', [parseInt(req.params.id, 10) || 0, req.admin.id]);
        if (!r.rowCount) return res.status(404).json({ error: 'That passkey is already gone.' });
        res.json({ success: true });
      } catch (err) { fail(res, err); }
    });

    // ---- The team (OWNER only) ----
    app.get('/admin/team', OWNER, page(TEAM_PAGE));
    app.get('/api/admin/team', OWNER, async (req, res) => {
      try {
        const [users, links] = await Promise.all([
          pool.query(`SELECT u.id, u.email, u.name, u.role, u.active, u.totp_enabled, u.created_at, u.last_login_at, u.locked_until, u.failed_count,
                        (SELECT COUNT(*)::int FROM admin_passkeys k WHERE k.user_id = u.id) AS passkeys,
                        (SELECT COUNT(*)::int FROM admin_sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > NOW()) AS sessions
                      FROM admin_users u ORDER BY u.active DESC, u.role, u.name, u.id`),
          pool.query(`SELECT l.id, l.email, l.name, l.role, l.created_at, l.expires_at, c.name AS created_by_name FROM admin_links l LEFT JOIN admin_users c ON c.id = l.created_by
                      WHERE l.kind = 'INVITE' AND l.used_at IS NULL AND l.revoked_at IS NULL AND l.expires_at > NOW() ORDER BY l.id DESC`)]);
        res.set('Cache-Control', 'no-store').json({ me: req.admin.id, users: users.rows, invites: links.rows });
      } catch (err) { fail(res, err); }
    });
    app.post('/api/admin/team/invite', OWNER, async (req, res) => {
      try {
        const email = norm(req.body?.email), name = cleanName(req.body?.name), role = String(req.body?.role || '');
        if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email.', field: 'email' });
        if (!ROLES.includes(role)) return res.status(400).json({ error: 'Pick a role.', field: 'role' });
        if ((await pool.query('SELECT 1 FROM admin_users WHERE email = $1', [email])).rowCount) return res.status(409).json({ error: 'That person already has an account.', field: 'email' });
        await pool.query("UPDATE admin_links SET revoked_at = NOW() WHERE kind = 'INVITE' AND email = $1 AND used_at IS NULL AND revoked_at IS NULL", [email]);
        const token = rnd(32);
        const r = await pool.query(`INSERT INTO admin_links (kind, email, name, role, token_hash, created_by, expires_at) VALUES ('INVITE', $1, $2, $3, $4, $5, NOW() + INTERVAL '48 hours') RETURNING id`,
          [email, name, role, sha256(token), req.admin.id]);
        const base = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
        const link = `${base}/admin/join?token=${token}`;
        const err = await mail.send(email, "You're invited to the On D' Road admin", renderEmail({
          tone: 'accent', tag: 'Team invite', title: 'Join the team',
          preheader: `${req.admin.name} added you as ${ROLE_NAME[role].toLowerCase()}. The link works for 48 hours.`,
          lines: [`${first(name) ? first(name) + ', ' : ''}${req.admin.name} invited you to the On D' Road admin as ${ROLE_NAME[role].toLowerCase()}.`,
            "You'll choose a password and set up a code app (like Google Authenticator or 1Password) for the 6-digit codes. The link works once, for 48 hours."],
          cta: { text: 'Set up my account', url: link, fallback: true }
        }));
        req.auditExtra = { email, role, emailed: !err };
        res.json({ success: true, id: r.rows[0].id, link, emailed: !err });
      } catch (err) { fail(res, err); }
    });
    app.post('/api/admin/team/invites/:id/revoke', OWNER, async (req, res) => {
      try {
        const r = await pool.query("UPDATE admin_links SET revoked_at = NOW() WHERE id = $1 AND kind = 'INVITE' AND used_at IS NULL AND revoked_at IS NULL", [parseInt(req.params.id, 10) || 0]);
        if (!r.rowCount) return res.status(404).json({ error: 'That invite has already been used or cancelled.' });
        res.json({ success: true });
      } catch (err) { fail(res, err); }
    });
    // { role } and/or { active }. Not on yourself, and never leaving no active owner.
    app.post('/api/admin/team/:id', OWNER, async (req, res) => {
      const id = parseInt(req.params.id, 10) || 0;
      const b = req.body || {};
      let client;
      try {
        if (req.admin.id && id === req.admin.id) return res.status(400).json({ error: "You can't change your own role or switch yourself off. Ask another owner." });
        if (b.role !== undefined && !ROLES.includes(b.role)) return res.status(400).json({ error: 'Pick a role.' });
        client = await pool.connect();
        await client.query('BEGIN');
        await client.query('LOCK TABLE admin_users IN SHARE ROW EXCLUSIVE MODE');
        const u = (await client.query('SELECT * FROM admin_users WHERE id = $1', [id])).rows[0];
        if (!u) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No such person.' }); }
        const role = b.role ?? u.role, active = b.active === undefined ? u.active : !!b.active;
        const owners = (await client.query("SELECT COUNT(*)::int AS n FROM admin_users WHERE role = 'OWNER' AND active AND id <> $1", [id])).rows[0].n;
        if (u.role === 'OWNER' && u.active && (role !== 'OWNER' || !active) && owners === 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Keep at least one active owner.' });
        }
        await client.query('UPDATE admin_users SET role = $2, active = $3 WHERE id = $1', [id, role, active]);
        // Switched off, or a role change: their sessions end, so the new role applies from their next sign-in.
        if (!active || role !== u.role) await client.query("UPDATE admin_sessions SET revoked_at = NOW(), revoked_reason = 'TEAM' WHERE user_id = $1 AND revoked_at IS NULL", [id]);
        await client.query('COMMIT');
        req.auditAction = role !== u.role ? 'team.role' : active !== u.active ? (active ? 'team.activate' : 'team.deactivate') : 'team.update';
        req.auditExtra = { before: { role: u.role, active: u.active }, after: { role, active }, person: u.email };
        res.json({ success: true });
      } catch (err) {
        await client?.query('ROLLBACK').catch(() => {});
        fail(res, err);
      } finally { client?.release(); }
    });
    // Their 2FA and passkeys are removed and their sessions end: at their next sign-in (password) they set up 2FA again.
    app.post('/api/admin/team/:id/reset-2fa', OWNER, async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10) || 0;
        if (req.admin.id && id === req.admin.id) return res.status(400).json({ error: 'Reset your own 2FA from your account page.' });
        const r = await pool.query("UPDATE admin_users SET totp_enabled = FALSE, totp_secret = NULL, recovery_codes = '{}' WHERE id = $1 RETURNING email", [id]);
        if (!r.rowCount) return res.status(404).json({ error: 'No such person.' });
        await pool.query('DELETE FROM admin_passkeys WHERE user_id = $1', [id]);
        await pool.query("UPDATE admin_sessions SET revoked_at = NOW(), revoked_reason = 'RESET_2FA' WHERE user_id = $1 AND revoked_at IS NULL", [id]);
        req.auditExtra = { person: r.rows[0].email };
        res.json({ success: true });
      } catch (err) { fail(res, err); }
    });
    app.post('/api/admin/team/:id/unlock', OWNER, async (req, res) => {
      try {
        const r = await pool.query('UPDATE admin_users SET failed_count = 0, locked_until = NULL WHERE id = $1 RETURNING email', [parseInt(req.params.id, 10) || 0]);
        if (!r.rowCount) return res.status(404).json({ error: 'No such person.' });
        req.auditExtra = { person: r.rows[0].email };
        res.json({ success: true });
      } catch (err) { fail(res, err); }
    });
  }

  // Every /admin and /api/admin route must have requireRole(...) or the public marker; the server refuses to start
  // otherwise. Returns the table [{ method, path, roles }] (roles = ['public'] for the open ones).
  function checkRoutes(app) {
    const table = [], missing = [];
    for (const layer of app._router.stack) {
      const r = layer.route;
      if (!r) continue;
      const paths = Array.isArray(r.path) ? r.path : [r.path];
      for (const path of paths) {
        if (typeof path !== 'string' || !/^\/(api\/)?admin(\/|$)/.test(path)) continue;
        const guard = r.stack.find((s) => s.handle.roles || s.handle.public);
        const methods = Object.keys(r.methods).map((m) => m.toUpperCase());
        for (const method of methods) {
          table.push({ method, path, roles: guard ? (guard.handle.public ? ['public'] : guard.handle.roles) : [] });
          if (!guard) missing.push(`${method} ${path}`);
        }
      }
    }
    if (missing.length) throw new Error('Admin routes without requireRole: ' + missing.join(', '));
    return table;
  }

  return { requireRole, publicRoute, register, checkRoutes, doorIdentity, sessionOf, allowKey: ALLOW_KEY, csrfOf };
}
