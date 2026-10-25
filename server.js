import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import pkg from 'pg';
import { Resend } from 'resend';
import { registerPayments } from './payments.js';
import { renderEmail } from './emails.js';
import { registerDoor } from './door.js';
import { registerEvent } from './event.js';
import { registerSite } from './site.js';
import { registerPayPal } from './paypal.js';
import { registerPricing, loadTiers, priceOf, checkPromo, discountFor, withStates, cleanCode,
  tooManyWrongCodes, countWrongCode, WRONG_CODES } from './pricing.js';
import { registerPickup, getSizeLock, isSizeLocked } from './pickup.js';
import { registerReset } from './reset.js';
import { createLock } from './lock.js';
import { CUR, INVITES_LEFT_SQL, migrateEvents, registerEvents } from './events.js';
import { registerPromoters } from './promoter.js';
import { registerTickets, ensureTicketSchema, createTicketDoor, TICKETS_URL } from './tickets.js';
import { WM_LITE, WM_PNG } from './brand.js';
import { createAuth, ensureAuthSchema } from './auth.js';
import { createAudit, ensureAuditSchema } from './audit.js';
import { createAdminApp, ensureAppSchema } from './adminapp.js';

const { Pool } = pkg;
// DATE columns (guests.birth_date) come back as their 'YYYY-MM-DD' text. pg would otherwise turn them into a JS Date
// at local midnight, which shifts the day when sent as JSON from a server that isn't on UTC.
pkg.types.setTypeParser(1082, (v) => v);

// ---------- Config ----------
const { TOKEN_SECRET, ADMIN_KEY } = process.env;
if (!TOKEN_SECRET || !ADMIN_KEY) {
  console.error('Missing TOKEN_SECRET or ADMIN_KEY environment variable.');
  process.exit(1);
}
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://controlfrontend.onrender.com').replace(/\/$/, '');
const EMAIL_FROM = process.env.EMAIL_FROM || process.env.EMAIL_USER || 'onboarding@resend.dev';
const resend = new Resend(process.env.RESEND_API_KEY || process.env.EMAIL_PASS);

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER || 'avnadmin',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'defaultdb',
  port: parseInt(process.env.DB_PORT || '25432', 10),
  // Set DB_CA to Aiven's CA certificate (PEM text) to enable full verification.
  ssl: process.env.DB_CA ? { ca: process.env.DB_CA } : { rejectUnauthorized: false },
  connectionTimeoutMillis: 5000
});
pool.on('error', (err) => console.error('DB pool error:', err.message));

// ---------- Helpers ----------
const normalizeEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const isValidEmail = (v) => v.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(v);
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
// "S, m , M, L" -> ['S', 'm', 'L']: trimmed, no repeats (ignoring case), at most 15 sizes of up to 15 characters.
const sizeList = (v) => {
  const out = [];
  for (const part of String(v || '').split(',')) {
    const size = part.trim().slice(0, 15);
    if (size && out.length < 15 && !out.some((x) => x.toLowerCase() === size.toLowerCase())) out.push(size);
  }
  return out;
};
// The package's own spelling of the size the guest picked, or null if it isn't one of them.
const pickSize = (sizes, v) => sizes.find((s) => s.toLowerCase() === String(v || '').trim().toLowerCase()) || null;
// A whole number from a JSON number or a string of digits, else NaN. Stricter than parseInt: "12abc" and 1.5 fail.
const toInt = (v) => (typeof v === 'number' || (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) ? Number(v) : NaN);
const money = (cents, cur) => (cur || 'XCD') + ' ' + (cents / 100).toFixed(2);
// A row id from the URL or body: a whole number Postgres can hold, else 0 (bigger ones would make the query fail).
const idOf = (v) => { const n = parseInt(v, 10); return n > 0 && n <= 2147483647 ? n : 0; };
const serverError = (res, err, msg = 'Server error.') => {
  console.error(err);
  res.status(500).json({ error: msg });
};

// ---------- Sign-up profile: name as on their ID, date of birth, Instagram ----------
// The name as typed, tidied: curly apostrophes and dashes made plain, invisible characters dropped, spaces collapsed.
// NFKC turns styled letters copied from a bio (\uD835\uDC09\uD835\uDC28\uD835\uDC21\uD835\uDC27, \uFF2A\uFF4F\uFF48\uFF4E) into plain ones, so staff can search and read them.
// The acute accent \u00B4 becomes ' before that, since NFKC would turn it into a space and an accent.
// Invisible characters include the Hangul fillers, which count as letters but show as blank.
// 2-80 characters of letters (any alphabet), accents and ' . , - starting with a letter, else null.
function cleanName(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u2019\u2018\u02BC\u00B4]/g, "'").normalize('NFKC')
    .replace(/[\u2019\u2018\u02BC\u00B4]/g, "'")
    .replace(/[\u2010\u2011\u2013\u2014\u2212]/g, '-')
    .replace(/[\t\n\r\v\f\p{Zs}\u2028\u2029]/gu, ' ')
    .replace(/[\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}]/gu, '')
    .normalize('NFC')
    .replace(/ {2,}/g, ' ').trim();
  const n = [...s].length;
  return n >= 2 && n <= 80 && /^\p{L}[\p{L}\p{M}' .,-]*$/u.test(s) ? s : null;
}
// Today's date in Antigua as 'YYYY-MM-DD'.
function antiguaToday() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Antigua', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
// Whole years between two 'YYYY-MM-DD' dates. Someone born on Feb 29 has a birthday on Mar 1 in other years.
function ageOn(birth, today = antiguaToday()) {
  const [by, bm, bd] = birth.split('-').map(Number), [ty, tm, td] = today.split('-').map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}
// 'YYYY-MM-DD', a real date, for someone 18 to 100 today in Antigua (turning 18 today counts).
// Returns { value, age } or { error: 'UNDER_18' | 'BAD_DATE' }.
function cleanBirthDate(v) {
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim()) : null;
  if (!m) return { error: 'BAD_DATE' };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return { error: 'BAD_DATE' };
  const age = ageOn(m[0]);
  if (age < 0 || age > 100) return { error: 'BAD_DATE' };
  if (age < 18) return { error: 'UNDER_18' };
  return { value: m[0], age };
}
// "@Name", "instagram.com/name" or "https://www.instagram.com/name/?hl=en" -> "name". Instagram's own rules:
// up to 30 of a-z 0-9 . _ with no dot at either end and no two dots in a row. Else null.
// A link must be a profile link: a post, reel or story link (instagram.com/p/..., /reel/..., /stories/...) is refused
// rather than saved as "p" or "reel".
const IG_LINK = /^(https?:\/\/)?(www\.|m\.)?instagram\.com\//i;
const IG_NOT_PROFILES = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'tv', 'accounts']);
function cleanInstagram(v) {
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(/^@/, '');
  if (IG_LINK.test(s)) {
    s = s.replace(IG_LINK, '').replace(/[?#].*$/, '').replace(/\/$/, '');
    if (s.includes('/') || IG_NOT_PROFILES.has(s.toLowerCase())) return null;
  }
  s = s.replace(/^@/, '').toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(s) && !s.startsWith('.') && !s.endsWith('.') && !s.includes('..') ? s : null;
}
const PROFILE_FIELDS = ['full_name', 'birth_date', 'instagram'];
const PROFILE_MSG = {
  full_name: { PROFILE_REQUIRED: 'Enter your full name as it shows on your ID.', NAME_INVALID: 'Enter your full name as it shows on your ID, in letters.' },
  birth_date: { PROFILE_REQUIRED: 'Enter your date of birth.', BAD_DATE: 'Check your date of birth.', UNDER_18: "On D' Road is 18+ only." },
  instagram: { PROFILE_REQUIRED: 'Enter your Instagram handle.', INSTAGRAM_INVALID: 'Check your Instagram handle, like @yourname.' }
};
const ADMIN_PROFILE_MSG = { NAME_INVALID: 'Enter their full name as it shows on their ID, in letters.', BAD_DATE: 'Check the date of birth.',
  UNDER_18: "That date of birth is under 18. On D' Road is 18+ only.", INSTAGRAM_INVALID: 'Check the Instagram handle, like @name.' };
// Checks the profile fields in body b. mode 'all': all three required (accepting an invite). 'some': only the ones
// sent, none of them blank (a guest's own edit). 'admin': only the ones sent; '' or null clears a field.
// Returns { fields } (cleaned values, null = clear) or { error: { error, code, field } } for a 400.
function profileInput(b, mode) {
  const fields = {};
  const fail = (field, why) => ({ error: { error: (mode === 'admin' && ADMIN_PROFILE_MSG[why]) || PROFILE_MSG[field][why],
    code: why === 'BAD_DATE' ? 'PROFILE_REQUIRED' : why, field } });
  for (const k of PROFILE_FIELDS) {
    const v = b?.[k];
    if (v === undefined) {
      if (mode === 'all') return fail(k, 'PROFILE_REQUIRED');
      continue;
    }
    if (v === null || (typeof v === 'string' && !v.trim())) {
      if (mode !== 'admin') return fail(k, 'PROFILE_REQUIRED');
      fields[k] = null;
      continue;
    }
    if (k === 'full_name') {
      fields[k] = cleanName(v);
      if (!fields[k]) return fail(k, 'NAME_INVALID');
    } else if (k === 'birth_date') {
      const d = cleanBirthDate(v);
      if (d.error) return fail(k, d.error);
      fields[k] = d.value;
    } else {
      fields[k] = cleanInstagram(v);
      if (!fields[k]) return fail(k, 'INSTAGRAM_INVALID');
    }
  }
  return { fields };
}
// Who invited each guest: their ACCEPTED invite's inviter ('CONTROL' for the admin, 'PROMOTER' for a promoter), with
// the inviter's name when they have one (a guest's full name, or the promoter's name), and the invite's note.
// Use with "FROM guests g"; select inviter.full_name as the name.
const INVITED_BY_SQL = `
  LEFT JOIN LATERAL (SELECT i.inviter_email, i.note, i.promoter_id FROM invites i WHERE i.invitee_email = LOWER(g.email) AND i.status = 'ACCEPTED'
                     ORDER BY i.accepted_at DESC NULLS LAST, i.id DESC LIMIT 1) inv ON TRUE
  LEFT JOIN LATERAL (SELECT COALESCE((SELECT pr.name FROM promoters pr WHERE pr.id = inv.promoter_id AND inv.inviter_email = 'PROMOTER'),
                                     (SELECT x.full_name FROM guests x WHERE LOWER(x.email) = LOWER(inv.inviter_email) LIMIT 1)) AS full_name) inviter ON TRUE`;

// ---------- Signed session tokens (no extra dependency) ----------
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sign = (data) => crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest('base64url');
const createToken = (email) => {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
};
const verifyToken = (token) => {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
  try {
    const { email, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return exp > Date.now() ? email : null;
  } catch {
    return null;
  }
};
const requireAuth = (req, res, next) => {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  const email = m && verifyToken(m[1]);
  if (!email) return res.status(401).json({ error: 'Session expired. Please log in again.' });
  req.userEmail = email;
  next();
};
// The answer to a sign-up request that's still waiting for approval, or was declined.
const notApproved = (approval) => ({
  error: approval === 'DECLINED' ? "Your request to join wasn't approved." : "You're not approved yet. We'll email you when you are.",
  code: 'NOT_APPROVED'
});
// After requireAuth: only approved guests still on the roster get through.
const requireApproved = async (req, res, next) => {
  try {
    const g = await pool.query('SELECT approval FROM guests WHERE LOWER(email) = $1 ORDER BY id LIMIT 1', [req.userEmail]);
    if (!g.rowCount) return res.status(403).json({ error: 'That account is no longer on the roster.' });
    if (g.rows[0].approval !== 'APPROVED') return res.status(403).json(notApproved(g.rows[0].approval));
    next();
  } catch (err) {
    serverError(res, err);
  }
};

// Simple in-memory fixed-window rate limiter, per IP by default. Pass perUser (after requireAuth) to count per
// account instead: guests on mobile data often share one IP, so per-IP limits would block real people.
const perUser = (req) => 'u:' + req.userEmail;
const rateLimit = (max, windowMs, keyOf = (req) => req.ip) => {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const key = keyOf(req);
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    if (n > max) return res.status(429).json({ error: 'Too many requests. Try again later.' });
    next();
  };
};

// The backend's own address, for links in emails (pass images, the admin's "Review requests" button, sign-in alerts).
// '' if unknown.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const ADMIN_EMAIL = normalizeEmail(process.env.ADMIN_EMAIL); // optional: gets refund requests and new sign-up requests

// ---------- Admin accounts, roles and the audit log (see auth.js and audit.js) ----------
// requireRole(...roles) guards every admin page and API route below and in each module; every admin write it lets
// through is written to the audit log. mail is set up further down, so it's reached through a wrapper.
const audit = createAudit({ pool });
const auth = createAuth({ pool, TOKEN_SECRET, ADMIN_KEY, safeEqual, mail: { send: (...a) => mail.send(...a) }, renderEmail, audit, rateLimit, PUBLIC_URL });
const { requireRole } = auth;
// The admin app's alerts and push notifications (see adminapp.js). notify() is called where things happen.
const adminApp = createAdminApp({ pool, ADMIN_EMAIL, PUBLIC_URL });
const { notify } = adminApp;
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

// ---------- App ----------
const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy

// Accept the configured frontend plus the production domains, the ticket site (and any extras, comma-separated, such
// as the static sites' *.onrender.com addresses).
const ALLOWED_ORIGINS = [...new Set([FRONTEND_URL, 'https://ondroad.xyz', 'https://www.ondroad.xyz', 'https://tickets.ondroad.xyz', TICKETS_URL,
  ...(process.env.EXTRA_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean)])];
// cors() reflects the request's Access-Control-Request-Headers, so the guest site's x-preview header (site lock) passes.
app.use(cors({ origin: ALLOWED_ORIGINS }));
// The site lock (see lock.js): while it's on, every guest API answers 423 SITE_LOCKED unless the owner's preview header
// comes with it. Before every route, so nothing a guest calls slips past it.
const lock = createLock({ pool, TOKEN_SECRET, safeEqual, SITE_URL: process.env.FRONTEND_URL ? FRONTEND_URL : 'https://ondroad.xyz' });
app.use(lock.guard);
// Door check-in (staff scanner at /door). Registered before the 10kb body limit because
// a phone coming back online can upload a batch of offline check-ins at once.
// The ticket site's side of the door (tickets.js): ticket events, their lists and check-ins.
const ticketDoor = createTicketDoor({ pool, TOKEN_SECRET });
registerDoor({ app, pool, express, ADMIN_KEY, TOKEN_SECRET, safeEqual, rateLimit, requireRole, ticketDoor, auth, onRefused: adminApp.doorRefused });
// Contact details and terms (see site.js). Also before the 10kb limit: the terms can be longer than that.
const site = registerSite({ app, pool, express, requireRole, lock });
// The ticket site (see tickets.js): its own lock (registered here, so it guards /api/tickets/* before any route), its API
// and /admin/tickets. Before the 10kb limit too: its routes bring their own body parsers. mail is set up further down,
// so it's reached through a wrapper.
const tickets = registerTickets({ app, pool, express, TOKEN_SECRET, safeEqual, requireRole, rateLimit, renderEmail, notify,
  mail: { send: (...a) => mail.send(...a) }, normalizeEmail, isValidEmail, cleanName, cleanBirthDate,
  SITE_URL: process.env.FRONTEND_URL ? FRONTEND_URL : 'https://ondroad.xyz', PUBLIC_URL: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '') });
// The emails' watermark tile (see brand.js and emails.js).
app.get('/brand/wm.png', (req, res) => res.type('png').set('Cache-Control', 'public, max-age=604800').send(WM_PNG));
app.use(express.json({ limit: '10kb' }));
// The site lock's admin routes: GET/POST /api/admin/site-lock and POST /api/admin/site-lock/preview-reset.
lock.register({ app, requireRole });
// Sign-in, setup, recovery, your account and the team (auth.js); the audit log page (audit.js); the admin app, its
// manifest, service worker and push (adminapp.js).
auth.register({ app, express });
audit.register({ app, requireRole });
adminApp.register({ app, requireRole, publicRoute: auth.publicRoute, lock, ticketsLock: tickets.lock, ticketDoor, express });

// Payment instructions, pay-by deadline, auto-expiry and reminders (see payments.js).
// Registered before the other routes on purpose: it replaces /api/my-order below.
// The same job runs the ticket site's checks (holds, PayPal, balance reminders and deadlines; see tickets.js).
const mail = registerPayments({ app, pool, resend, EMAIL_FROM, FRONTEND_URL, TOKEN_SECRET, requireAuth, requireRole, escapeHtml,
  beforeExpire: async (payDays) => {
    await paypal.syncDue(payDays).catch((err) => console.error('PayPal check error:', err.message));
    await tickets.sweep().catch((err) => console.error('Ticket job error:', err.message));
  } });
// Event details in guests' accounts and email updates to groups of guests (see event.js).
registerEvent({ app, pool, resend, EMAIL_FROM, FRONTEND_URL, requireAuth, requireRole, mail });
// Paying online with PayPal (see paypal.js). Off until the PAYPAL_* settings are added.
const paypal = registerPayPal({ app, pool, requireAuth, requireApproved, requireRole, rateLimit, perUser,
  onPaid: (o) => {
    sendPaidEmail(o.guest_email, o.package_name, o.reference_code);
    notify('sales', { title: 'Pass sold', body: `${o.package_name} · paid online · ${money(o.price_cents, o.currency)}`, url: '/admin/app#home' });
  } });
// Price tiers and promo codes (see pricing.js). A code that makes an unpaid reservation free confirms it straight away.
registerPricing({ app, pool, requireAuth, requireApproved, requireRole, rateLimit, perUser,
  onComp: (o) => {
    notify('sales', { title: 'Free pass claimed', body: `${o.package_name} · with a code`, url: '/admin/app#home' });
    return sendPaidEmail(o.guest_email, o.package_name, o.reference_code, { free: true });
  } });
// Size lock and package pickup tracking (see pickup.js).
registerPickup({ app, pool, requireRole });
// Clearing guest data (or everything) to start over (see reset.js). A full reset also clears the email footer's contact
// details, and deletes the site lock settings, so the site is locked again (the lock's cache is cleared too).
registerReset({ app, pool, requireRole, rateLimit, afterReset: () => { lock.forget(); tickets.lock.forget(); return site.refresh(); } });
// Where the "You're approved" email sends guests.
const SITE_URL = process.env.FRONTEND_URL ? FRONTEND_URL : 'https://ondroad.xyz';

// Creates the packages/orders/settings tables and any missing columns on startup,
// so no SQL has to be run by hand in Aiven. Safe to run every boot.
async function ensureSchema() {
  await pool.query(`
    -- Events: one current at a time (the partial unique index), the rest past. See events.js.
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'past' CHECK (status IN ('current', 'past')),
      invites_per_guest INTEGER NOT NULL DEFAULT 2,
      event_when TEXT NOT NULL DEFAULT '',
      event_info TEXT NOT NULL DEFAULT '',
      event_paid_info TEXT NOT NULL DEFAULT '',
      event_location TEXT NOT NULL DEFAULT '',
      event_poster TEXT NOT NULL DEFAULT '',
      rsvp_confirmed INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS events_one_current ON events (status) WHERE status = 'current';
    -- Per guest and event: the admin's extra invites for that guest.
    CREATE TABLE IF NOT EXISTS guest_event (
      email TEXT NOT NULL,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      invite_bonus INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (email, event_id)
    );
    CREATE TABLE IF NOT EXISTS promoters (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      token_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS promoter_event (
      promoter_id INTEGER NOT NULL REFERENCES promoters(id) ON DELETE CASCADE,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      invites INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (promoter_id, event_id)
    );
    CREATE TABLE IF NOT EXISTS packages (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'XCD',
      includes TEXT NOT NULL DEFAULT '',
      requires_compliance BOOLEAN NOT NULL DEFAULT TRUE,
      capacity INTEGER,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      guest_email TEXT NOT NULL,
      package_id INTEGER NOT NULL REFERENCES packages(id),
      status TEXT NOT NULL DEFAULT 'RESERVED',
      reference_code TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'XCD';
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS includes TEXT NOT NULL DEFAULT '';
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS requires_compliance BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS capacity INTEGER;
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS checked_in_by TEXT;
    CREATE TABLE IF NOT EXISTS checkins (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      device TEXT,
      client_id TEXT UNIQUE,
      scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS broadcasts (
      id SERIAL PRIMARY KEY,
      audience TEXT NOT NULL,
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      recipients INTEGER NOT NULL DEFAULT 0,
      sent INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE guests ADD COLUMN IF NOT EXISTS age_confirmed_at TIMESTAMPTZ;
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS sizes TEXT NOT NULL DEFAULT '';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS size TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_via TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS pay_days INTEGER;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS paypal_order_id TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS paypal_status TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS paypal_started_at TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS paypal_amount TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS paypal_capture_id TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS paypal_refund_id TEXT;
    CREATE TABLE IF NOT EXISTS package_tiers (
      id SERIAL PRIMARY KEY,
      package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      ends_at TIMESTAMPTZ,
      quantity INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS promo_codes (
      code TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      value INTEGER NOT NULL DEFAULT 0,
      package_id INTEGER REFERENCES packages(id) ON DELETE CASCADE,
      max_uses INTEGER,
      expires_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS pay_note TEXT NOT NULL DEFAULT '';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tier_id INTEGER REFERENCES package_tiers(id) ON DELETE SET NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS tier_name TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS list_cents INTEGER;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_cents INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount_cents INTEGER;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_code TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS pay_by TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS picked_up_at TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS picked_up_by TEXT;
    -- The live QR's version (liveqr.js): bumping it would re-issue the pass's secret.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS qr_version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE guests ADD COLUMN IF NOT EXISTS full_name TEXT;
    ALTER TABLE guests ADD COLUMN IF NOT EXISTS birth_date DATE;
    ALTER TABLE guests ADD COLUMN IF NOT EXISTS instagram TEXT;
    ALTER TABLE guests ADD COLUMN IF NOT EXISTS approval TEXT NOT NULL DEFAULT 'APPROVED';
    ALTER TABLE guests ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
    ALTER TABLE guests ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS orders_tier_idx ON orders (tier_id);
    CREATE INDEX IF NOT EXISTS orders_promo_idx ON orders (promo_code);
    -- Each event's own rows (filled in by migrateEvents() for rows from before events).
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS event_id INTEGER REFERENCES events(id);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS event_id INTEGER REFERENCES events(id);
    ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS event_id INTEGER REFERENCES events(id);
    ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS event_id INTEGER REFERENCES events(id);
    ALTER TABLE invites ADD COLUMN IF NOT EXISTS event_id INTEGER REFERENCES events(id);
    ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS promoter_id INTEGER REFERENCES promoters(id) ON DELETE SET NULL;
    ALTER TABLE invites ADD COLUMN IF NOT EXISTS promoter_id INTEGER REFERENCES promoters(id) ON DELETE SET NULL;
    -- A row written without an event_id (an older backend still running during a deploy, or SQL by hand) belongs to the
    -- current event. A column default can't hold a subquery, so it goes through this function.
    CREATE OR REPLACE FUNCTION current_event_id() RETURNS INTEGER LANGUAGE sql STABLE AS $fn$ SELECT id FROM events WHERE status = 'current' $fn$;
    ALTER TABLE packages ALTER COLUMN event_id SET DEFAULT current_event_id();
    ALTER TABLE orders ALTER COLUMN event_id SET DEFAULT current_event_id();
    ALTER TABLE promo_codes ALTER COLUMN event_id SET DEFAULT current_event_id();
    ALTER TABLE broadcasts ALTER COLUMN event_id SET DEFAULT current_event_id();
    ALTER TABLE invites ALTER COLUMN event_id SET DEFAULT current_event_id();
    CREATE INDEX IF NOT EXISTS orders_event_idx ON orders (event_id, status);
    CREATE INDEX IF NOT EXISTS packages_event_idx ON packages (event_id);
    CREATE INDEX IF NOT EXISTS invites_event_idx ON invites (event_id, inviter_email);
    CREATE INDEX IF NOT EXISTS promo_codes_promoter_idx ON promo_codes (promoter_id);
  `);
  // The first current event, and event_id on rows from before events (see events.js). Safe on every boot.
  await migrateEvents(pool);
  // The ticket site's tables (see tickets.js).
  await ensureTicketSchema(pool);
  // Admin accounts and sessions (auth.js), the audit log (audit.js), push subscriptions, alerts and the door's refused
  // scans (adminapp.js).
  await ensureAuthSchema(pool);
  await ensureAuditSchema(pool);
  await ensureAppSchema(pool);
  // Each order stores what it costs. Orders from before that keep the package price.
  await pool.query(
    `UPDATE orders o SET list_cents = p.price_cents, amount_cents = p.price_cents, currency = p.currency
     FROM packages p WHERE p.id = o.package_id AND o.amount_cents IS NULL`);
}

// --- VIP LOGIN: step 1, request a one-time link ---
// Always returns the same generic response whether or not the email is on the roster,
// so this endpoint can't be used to check who is or isn't invited.
// Per IP (generous, for shared mobile IPs) and per email address (so nobody can flood one inbox).
app.post('/api/login', rateLimit(40, 15 * 60 * 1000), rateLimit(5, 15 * 60 * 1000, (req) => 'e:' + normalizeEmail(req.body?.email)), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required' });
  const generic = { success: true, message: "If that email is on the roster, we've sent a login link." };
  try {
    const result = await pool.query('SELECT 1 FROM guests WHERE LOWER(email) = $1', [email]);
    if (!result.rowCount) return res.json(generic); // don't reveal roster membership
    const code = newInviteToken();
    await pool.query(
      `INSERT INTO login_links (code_hash, email, expires_at) VALUES ($1, $2, NOW() + INTERVAL '15 minutes')`,
      [hashToken(code), email]);
    const link = `${FRONTEND_URL}/?login=${code}`;
    const error = await sendLoginEmail(email, link);
    if (error) console.error('Login email failed:', error);
    res.json(generic);
  } catch (err) {
    serverError(res, err);
  }
});

// --- VIP LOGIN: step 2, exchange the one-time code for a session ---
app.post('/api/login/verify', rateLimit(60, 15 * 60 * 1000), async (req, res) => {
  const code = req.body?.code;
  if (!code) return res.status(400).json({ error: 'Missing login code.' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT id, email FROM login_links WHERE code_hash = $1 AND used_at IS NULL AND expires_at > NOW() FOR UPDATE`,
      [hashToken(code)]);
    if (!r.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This login link is invalid or has expired. Request a new one.' });
    }
    const email = r.rows[0].email;
    await client.query('UPDATE login_links SET used_at = NOW() WHERE id = $1', [r.rows[0].id]);
    const userRes = await client.query('SELECT * FROM guests WHERE LOWER(email) = $1', [email]);
    await client.query('COMMIT');
    if (!userRes.rowCount) return res.status(403).json({ error: 'That account is no longer on the roster.' });
    res.json({ success: true, user: userRes.rows[0], token: createToken(email) });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    serverError(res, err);
  } finally {
    client?.release();
  }
});

// The guest's row (birth_date as 'YYYY-MM-DD') plus has_paid (a PAID order for the current event, free passes
// included: their name and date of birth are locked and invites are open), who invited them (email, 'CONTROL' or
// 'PROMOTER', and the name) and invites_left for the current event (see events.js; the legacy guests.invites_left
// column is replaced by it). rsvp_status is the current event's attendance. null if not found.
async function guestStatus(db, email) {
  const r = await db.query(
    `SELECT g.*, inv.inviter_email AS invited_by, inviter.full_name AS invited_by_name,
            EXISTS (SELECT 1 FROM orders o WHERE LOWER(o.guest_email) = LOWER(g.email) AND o.status = 'PAID' AND o.event_id = ${CUR}) AS has_paid,
            ${INVITES_LEFT_SQL} AS invites_left
     FROM guests g ${INVITED_BY_SQL}
     WHERE LOWER(g.email) = $1 ORDER BY g.id LIMIT 1`, [email]);
  return r.rows[0] || null;
}

// --- FETCH USER DATA ---
app.get('/api/user-status', requireAuth, async (req, res) => {
  try {
    const guest = await guestStatus(pool, req.userEmail);
    if (!guest) return res.status(404).json({ error: 'Guest not found' });
    res.json(guest);
  } catch (err) {
    serverError(res, err);
  }
});

// --- SAVE THE GUEST'S PROFILE ---
// Name and date of birth can be filled in when empty, and changed until the guest has a paid order (a free pass
// counts). After that only the admin can change them. Instagram can change any time.
app.post('/api/profile', requireAuth, rateLimit(20, 60 * 60 * 1000, perUser), async (req, res) => {
  const { fields, error } = profileInput(req.body || {}, 'some');
  if (error) return res.status(400).json(error);
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'Nothing to save.', code: 'PROFILE_REQUIRED' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Locked like remove-guest does: no new order (a free pass is PAID at once) can slip in, and a payment going
    // through right now finishes before we look.
    const g = await client.query('SELECT id, full_name, birth_date, instagram FROM guests WHERE LOWER(email) = $1 ORDER BY id FOR UPDATE', [req.userEmail]);
    if (!g.rowCount) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'That account is no longer on the roster.' });
    }
    const cur = g.rows[0];
    // Paid for the current event: that's the pass staff check the name against.
    const open = await client.query(
      `SELECT status FROM orders WHERE LOWER(guest_email) = $1 AND status <> 'CANCELLED' AND event_id = ${CUR} ORDER BY id FOR UPDATE`, [req.userEmail]);
    const paid = open.rows.some((o) => o.status === 'PAID');
    const changes = Object.keys(fields).filter((k) => fields[k] !== cur[k]);
    if (paid && changes.some((k) => k !== 'instagram' && cur[k] !== null)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: "Your name and date of birth are locked now that you've paid. Message us to change them.", code: 'PROFILE_LOCKED' });
    }
    if (changes.length) {
      // Fixed column names from PROFILE_FIELDS, never from the request.
      await client.query(
        `UPDATE guests SET ${changes.map((k, n) => `${k} = $${n + 2}`).join(', ')},
                age_confirmed_at = CASE WHEN ${changes.includes('birth_date') ? 'TRUE' : 'birth_date IS NOT NULL'} THEN COALESCE(age_confirmed_at, NOW()) ELSE age_confirmed_at END
         WHERE id = $1`, [cur.id, ...changes.map((k) => fields[k])]);
    }
    await client.query('COMMIT');
    res.json({ success: true, guest: await guestStatus(pool, req.userEmail) });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    serverError(res, err);
  } finally {
    client?.release();
  }
});

// --- UPDATE SHIRT SIZE ---
app.post('/api/update-shirt', requireAuth, async (req, res) => {
  const shirt_size = typeof req.body?.shirt_size === 'string' ? req.body.shirt_size.trim() : '';
  if (!shirt_size || shirt_size.length > 20) return res.status(400).json({ error: 'Invalid shirt size.' });
  try {
    await pool.query('UPDATE guests SET shirt_size = $1 WHERE LOWER(email) = $2', [shirt_size, req.userEmail]);
    res.json({ success: true, shirt_size });
  } catch (err) {
    serverError(res, err);
  }
});

// --- UPDATE RSVP ---
// Attendance can only be confirmed once the guest has paid for the current event (a free pass counts), and it's locked
// once confirmed: pulling out goes through a refund request, whose approval sets it back to PENDING. Starting a new
// event sets everyone back to PENDING (see events.js).
app.post('/api/update-rsvp', requireAuth, async (req, res) => {
  const rsvp_status = typeof req.body?.rsvp_status === 'string' ? req.body.rsvp_status.trim() : '';
  if (!['CONFIRMED', 'PENDING'].includes(rsvp_status)) return res.status(400).json({ error: 'Invalid RSVP status.' });
  try {
    const g = await pool.query(
      `SELECT g.approval, g.rsvp_status,
              EXISTS (SELECT 1 FROM orders o WHERE LOWER(o.guest_email) = LOWER(g.email) AND o.status = 'PAID' AND o.event_id = ${CUR}) AS has_paid
       FROM guests g WHERE LOWER(g.email) = $1 ORDER BY g.id LIMIT 1`, [req.userEmail]);
    if (!g.rowCount) return res.status(403).json({ error: 'That account is no longer on the roster.' });
    const guest = g.rows[0];
    // Only approved guests: a request still waiting (or declined) mustn't count as confirmed attendance.
    if (guest.approval !== 'APPROVED') return res.status(403).json(notApproved(guest.approval));
    if (rsvp_status === 'PENDING') {
      if (guest.rsvp_status === 'CONFIRMED') {
        return res.status(403).json({ error: "You've confirmed, so it's locked. Can't make it? Request a refund instead.", code: 'RSVP_LOCKED' });
      }
      return res.json({ success: true, rsvp_status: 'PENDING' });
    }
    if (!guest.has_paid) return res.status(403).json({ error: "You can confirm once you've paid.", code: 'PAY_FIRST' });
    await pool.query("UPDATE guests SET rsvp_status = 'CONFIRMED' WHERE LOWER(email) = $1 AND approval = 'APPROVED'", [req.userEmail]);
    res.json({ success: true, rsvp_status: 'CONFIRMED' });
  } catch (err) {
    serverError(res, err);
  }
});

// ---------- Personal single-use invite links ----------
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newInviteToken = () => crypto.randomBytes(24).toString('base64url');
const inviteLink = (t) => `${FRONTEND_URL}/?invite=${t}`;

// Whether someone can't be invited (by a guest, a promoter or the admin's guest-style check): they're on the roster
// (pending and declined requests included), have a pending invite, or still hold an order for the current event that
// isn't cancelled (a guest removed while their pass was live). db = pool or a client.
async function inviteBlocked(db, email) {
  const r = await db.query(
    `SELECT 1 FROM guests WHERE LOWER(email) = $1
     UNION SELECT 1 FROM invites WHERE invitee_email = $1 AND status = 'PENDING'
     UNION SELECT 1 FROM orders WHERE LOWER(guest_email) = $1 AND status <> 'CANCELLED' AND event_id = ${CUR}`, [email]);
  return r.rowCount > 0;
}

// Sends the invite email via Resend and returns an error object (or null). Never throws —
// callers check the return value explicitly, so a failed send can never be reported as a success.
async function sendInviteEmail(to, from, note, link) {
  const byHost = from === "On D' Road";
  return mail.send(to, byHost ? "You're invited — On D' Road" : `${from} chose you — On D' Road`, renderEmail({
    tone: 'accent', tag: "You're invited", title: "You're on the list",
    lines: [
      byHost ? "You've been personally invited to On D' Road." : `${from} chose you as one of their two invites.`,
      "This invitation is personal and single-use. It only works with this email address, so don't forward it or post it."
    ],
    quote: note ? { from, text: note } : null,
    cta: { text: 'Accept invitation', url: link, fallback: true },
    fine: "Invites move through the chain. Getting yours later than someone else doesn't mean you were skipped."
  }));
}

// Sends a one-time login link. Returns an error object (or null). Never throws.
async function sendLoginEmail(to, link) {
  return mail.send(to, "Your login link — On D' Road", renderEmail({
    tone: 'accent', tag: 'Login link', title: 'Tap to log in',
    preheader: 'Your one-time login link. It expires in 15 minutes.',
    lines: ['Use the button below to log in. It works once and expires in 15 minutes.'],
    cta: { text: 'Log in', url: link, fallback: true },
    fine: "Didn't ask for this? You can ignore this email. Nobody can get into your account without this link."
  }));
}

// --- SEND A PERSONAL INVITE (uses one of the sender's invites for the current event) ---
app.post('/api/send-invite', requireAuth, rateLimit(20, 60 * 60 * 1000, perUser), async (req, res) => {
  const sender = req.userEmail;
  const recipient = normalizeEmail(req.body?.recipient_email);
  const note = typeof req.body?.custom_note === 'string' ? req.body.custom_note.trim().slice(0, 300) : '';
  if (!isValidEmail(recipient)) return res.status(400).json({ error: 'A valid recipient email is required.' });

  const token = newInviteToken();
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Held until the invite is saved, so a new event can't start halfway (see events.js).
    const ev = (await client.query("SELECT id FROM events WHERE status = 'current' FOR SHARE")).rows[0];

    // Only approved guests on the roster can invite. Their row stays locked until the invite is saved.
    const me = await client.query('SELECT approval FROM guests WHERE LOWER(email) = $1 ORDER BY id FOR UPDATE', [sender]);
    if (!me.rowCount || me.rows[0].approval !== 'APPROVED') {
      await client.query('ROLLBACK');
      return res.status(403).json(me.rowCount ? notApproved(me.rows[0].approval) : { error: 'That account is no longer on the roster.' });
    }

    // Invites open once the sender has paid for this event (a free pass counts).
    const paid = await client.query("SELECT 1 FROM orders WHERE LOWER(guest_email) = $1 AND status = 'PAID' AND event_id = $2 LIMIT 1", [sender, ev.id]);
    if (!paid.rowCount) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: "Invites open once you've paid.", code: 'PAY_FIRST' });
    }

    // Someone on the roster (pending and declined requests included) or with an open invite can't be invited again.
    // Once removed from the roster, they can be, unless they still hold an order for this event that isn't cancelled
    // (a guest removed while their pass was live; coming back as a new request would leave that pass working).
    if (await inviteBlocked(client, recipient)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'That person has already been invited.' });
    }

    // The allowance for this event (invites per guest + any bonus, less what they've sent; see events.js). The
    // sender's row is locked, so two quick sends can't both take the last one.
    const left = (await client.query(`SELECT ${INVITES_LEFT_SQL} AS n FROM guests g WHERE LOWER(g.email) = $1 ORDER BY g.id LIMIT 1`, [sender])).rows[0].n;
    if (left <= 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: "You've used all your invites." });
    }

    await client.query(
      'INSERT INTO invites (token_hash, inviter_email, invitee_email, note, event_id) VALUES ($1, $2, $3, $4, $5)',
      [hashToken(token), sender, recipient, note, ev.id]);

    const emailError = await sendInviteEmail(recipient, sender, note, inviteLink(token));
    if (emailError) throw Object.assign(new Error(emailError.message), { publicMessage: 'Email could not be delivered.' });

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(400).json({ error: 'That person has already been invited.' });
    serverError(res, err, err.publicMessage || 'Server error during dispatch.');
  } finally {
    client?.release();
  }
});

// --- LOOK UP AN INVITE LINK (public) ---
app.get('/api/invite/:token', rateLimit(120, 15 * 60 * 1000), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT i.inviter_email, i.note, i.status, pr.name AS promoter_name FROM invites i
       LEFT JOIN promoters pr ON pr.id = i.promoter_id WHERE i.token_hash = $1`, [hashToken(req.params.token)]);
    if (!r.rowCount || r.rows[0].status !== 'PENDING') {
      return res.status(404).json({ error: 'This invitation is invalid or has already been used.' });
    }
    // A promoter's invite shows their name, with inviter_kind so the guest site words it as theirs.
    const i = r.rows[0];
    if (i.inviter_email === 'PROMOTER') return res.json({ inviter: i.promoter_name || "On D' Road", inviter_kind: 'PROMOTER', note: i.note });
    res.json({ inviter: i.inviter_email, note: i.note });
  } catch (err) {
    serverError(res, err);
  }
});

// "Jane Doe (jane@x.com)", the email alone, "promoter Kai" for a promoter's invite, or "You" for the admin's own.
const inviterLabel = (inviterEmail, inviterName, you = 'You') =>
  inviterEmail === 'CONTROL' ? you : inviterEmail === 'PROMOTER' ? `promoter ${inviterName || '(unknown)'}`
    : inviterName ? `${inviterName} (${inviterEmail})` : inviterEmail || 'Unknown';

// Tells the admin someone is waiting for approval. Returns an error (or null). Never throws.
async function sendRequestEmail(g) {
  if (!ADMIN_EMAIL) return null;
  try {
    const by = inviterLabel(g.invited_by, g.invited_by_name);
    return await mail.send(ADMIN_EMAIL, `New request: ${g.full_name}`, renderEmail({
      tone: 'warn', tag: 'Waiting for you', title: 'New request',
      preheader: `${g.full_name} wants in. Invited by ${by}.`,
      lines: [`${g.full_name} accepted their invite and is waiting for your approval.`,
        ...(g.invited_by === 'PROMOTER' ? [`Invited by ${by}.`] : []),
        "Check they're someone you want on the road, then approve or decline them in the Requests tab. A declined request gets no email."],
      details: [['Name', g.full_name], ['Age', g.birth_date ? String(ageOn(g.birth_date)) : null], ['Instagram', g.instagram ? '@' + g.instagram : null],
        ['Email', g.email, true], ['Invited by', by.charAt(0).toUpperCase() + by.slice(1)]],
      quote: g.invite_note ? { from: by, text: g.invite_note } : null,
      cta: PUBLIC_URL ? { text: 'Review requests', url: `${PUBLIC_URL}/admin#requests` } : null
    }));
  } catch (err) {
    console.error('Request email error:', err);
    return err;
  }
}

// --- ACCEPT AN INVITE: joins the roster with two invites and logs in ---
// The sign-up form sends the guest's name as on their ID, date of birth and Instagram. They're checked before anything
// is written, so a mistake never uses up the invite. A new guest waits for the admin's approval (PENDING), except on
// the admin's own invites. Someone the admin had already added keeps their status and gets any missing details filled in.
app.post('/api/invite/accept', rateLimit(40, 15 * 60 * 1000), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const bad = 'Invitation invalid, already used, or not issued to that email.';
  const b = req.body || {};
  // A page cached from before the sign-up form sends none of the fields.
  if (!PROFILE_FIELDS.some((k) => b[k] !== undefined)) {
    return res.status(400).json({ error: 'Reload the page and fill in your details.', code: 'PROFILE_REQUIRED' });
  }
  const { fields: p, error } = profileInput(b, 'all');
  if (error) return res.status(400).json(error);
  let client, guest;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const r = await client.query(
      'SELECT id, invitee_email, inviter_email, note, status FROM invites WHERE token_hash = $1 FOR UPDATE', [hashToken(b.token)]);
    const inv = r.rows[0];
    if (!inv || inv.status !== 'PENDING' || inv.invitee_email !== email) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: bad });
    }
    const approval = inv.inviter_email === 'CONTROL' ? 'APPROVED' : 'PENDING';
    const created = await client.query(
      `INSERT INTO guests (email, rsvp_status, shirt_size, invites_left, full_name, birth_date, instagram, approval, applied_at, age_confirmed_at)
       SELECT $1::text, 'PENDING', 'Unassigned', 2, $2, $3::date, $4, $5, NOW(), NOW()
       WHERE NOT EXISTS (SELECT 1 FROM guests WHERE LOWER(email) = $1::text)`,
      [email, p.full_name, p.birth_date, p.instagram, approval]);
    if (!created.rowCount) {
      // Already on the roster (the admin added them): only fill in what's missing.
      await client.query(
        `UPDATE guests SET full_name = COALESCE(full_name, $2), birth_date = COALESCE(birth_date, $3::date),
                instagram = COALESCE(instagram, $4), age_confirmed_at = COALESCE(age_confirmed_at, NOW())
         WHERE LOWER(email) = $1`, [email, p.full_name, p.birth_date, p.instagram]);
    }
    await client.query("UPDATE invites SET status = 'ACCEPTED', accepted_at = NOW() WHERE id = $1", [inv.id]);
    guest = await guestStatus(client, email);
    if (guest) guest.invite_note = inv.note || '';
    await client.query('COMMIT');
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    return serverError(res, err);
  } finally {
    client?.release();
  }
  res.json({ success: true, token: createToken(email), user: { email, approval: guest?.approval || 'APPROVED' } });
  // Sent after responding so a slow email never holds up the guest. The admin app's alert carries only the first name.
  if (guest && guest.approval === 'PENDING') {
    sendRequestEmail(guest);
    notify('requests', { title: `New request: ${firstName(guest.full_name) || 'someone'}`, body: 'Waiting for your approval.', url: '/admin/app#requests' });
  }
});

// --- ADMIN: create an invite without using anyone's allowance; returns the link ---
app.post('/api/admin/create-invite', requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 300) : '';
  if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
  const token = newInviteToken();
  try {
    // As in send-invite: a removed guest whose order for this event isn't cancelled can't come back through an invite.
    const dup = await pool.query(
      `SELECT 1 FROM guests WHERE LOWER(email) = $1
       UNION SELECT 1 FROM invites WHERE invitee_email = $1 AND status = 'PENDING'`, [email]);
    if (dup.rowCount) return res.status(400).json({ error: 'That person is already on the roster or invited.' });
    const live = await pool.query(`SELECT 1 FROM orders WHERE LOWER(guest_email) = $1 AND status <> 'CANCELLED' AND event_id = ${CUR} LIMIT 1`, [email]);
    if (live.rowCount) return res.status(400).json({ error: 'They still have an order from before they were removed. Use "Add to roster" instead.' });
    await pool.query(
      `INSERT INTO invites (token_hash, inviter_email, invitee_email, note, event_id) VALUES ($1, 'CONTROL', $2, $3, ${CUR})`,
      [hashToken(token), email, note]);
    const link = inviteLink(token);
    const emailed = !(await sendInviteEmail(email, "On D' Road", note, link));
    res.json({ success: true, link, emailed });
  } catch (err) {
    serverError(res, err);
  }
});

// ---------- Packages (public read, admin write) ----------
// Each active package of the current event with what it costs right now. With price tiers, that's the tier on sale; when every tier
// has ended or sold out, sales_closed is true (price_cents is then the package price, only for display).
app.get('/api/packages', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.id, p.name, p.price_cents, p.currency, p.includes, p.requires_compliance, p.capacity, p.sizes, p.pay_note,
              GREATEST(0, COALESCE(p.capacity, 2147483647) - (SELECT COUNT(*) FROM orders o WHERE o.package_id = p.id AND o.status <> 'CANCELLED'))::int AS spots_left
       FROM packages p WHERE p.active = TRUE AND p.event_id = ${CUR} ORDER BY p.sort_order ASC, p.id ASC`);
    const tiers = await loadTiers(pool, r.rows.map((p) => p.id));
    const now = new Date();
    res.json(r.rows.map((p) => {
      const { tier, next, list_cents, closed } = priceOf(p, tiers.get(p.id) || [], now);
      return {
        ...p,
        price_cents: closed ? p.price_cents : list_cents,
        sales_closed: closed,
        tier: tier ? { id: tier.id, name: tier.name, ends_at: tier.ends_at,
          left: tier.quantity === null ? null : Math.max(0, tier.quantity - tier.sold) } : null,
        next_tier: next ? { name: next.name, price_cents: next.price_cents } : null
      };
    }));
  } catch (err) {
    serverError(res, err);
  }
});

// The current event's packages (?event=all: every event's, for the reset page's copy).
app.get('/api/admin/packages', requireRole('OWNER', 'ADMIN'), async (req, res) => {
  try {
    const all = req.query.event === 'all';
    const r = await pool.query(
      `SELECT p.*, (SELECT COUNT(*) FROM orders o WHERE o.package_id = p.id AND o.status <> 'CANCELLED') AS claimed,
              (SELECT COALESCE(json_object_agg(s.size, s.n), '{}'::json) FROM
                (SELECT o.size, COUNT(*) AS n FROM orders o
                 WHERE o.package_id = p.id AND o.status <> 'CANCELLED' AND o.size IS NOT NULL GROUP BY o.size) s) AS size_counts
       FROM packages p ${all ? '' : `WHERE p.event_id = ${CUR}`} ORDER BY ${all ? 'p.event_id, ' : ''}p.sort_order ASC, p.id ASC`);
    const tiers = await loadTiers(pool, r.rows.map((p) => p.id));
    const now = new Date();
    res.json(r.rows.map((p) => {
      const list = tiers.get(p.id) || [];
      const price = priceOf(p, list, now);
      return { ...p, tiers: withStates(list, now), price_now: price.list_cents, sales_closed: price.closed };
    }));
  } catch (err) {
    serverError(res, err);
  }
});

// Package fields shared by create and edit. Returns { error } for bad input; never turns it into 0.
function packageInput(b) {
  const out = {};
  if (typeof b.name === 'string') {
    out.name = b.name.trim().slice(0, 80);
    if (!out.name) return { error: 'Give the package a name.' };
  }
  if (b.price_cents !== undefined) {
    out.price_cents = toInt(b.price_cents);
    if (!(Number.isInteger(out.price_cents) && out.price_cents >= 0 && out.price_cents <= 10000000)) return { error: 'Enter a valid price.' };
  }
  if (b.capacity !== undefined) {
    out.capacity = b.capacity === '' || b.capacity === null ? null : toInt(b.capacity);
    if (out.capacity !== null && !(Number.isInteger(out.capacity) && out.capacity >= 1 && out.capacity <= 100000)) {
      return { error: 'Capacity must be a whole number, or blank for no limit.' };
    }
  }
  if (typeof b.includes === 'string') out.includes = b.includes.slice(0, 1000);
  if (typeof b.sizes === 'string') out.sizes = sizeList(b.sizes).join(', ');
  if (typeof b.pay_note === 'string') out.pay_note = b.pay_note.trim().slice(0, 1000);
  if (b.requires_compliance !== undefined) out.requires_compliance = !!b.requires_compliance;
  if (b.active !== undefined) out.active = !!b.active;
  if (b.sort_order !== undefined) out.sort_order = Math.max(-100000, Math.min(100000, parseInt(b.sort_order, 10) || 0));
  return { fields: out };
}

app.post('/api/admin/packages', requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const { error, fields: f } = packageInput({ ...req.body, price_cents: req.body?.price_cents ?? '' });
  if (error || !f.name) return res.status(400).json({ error: error || 'Give the package a name.' });
  const currency = ['XCD', 'USD'].includes(req.body?.currency) ? req.body.currency : 'XCD';
  try {
    const r = await pool.query(
      `INSERT INTO packages (name, price_cents, currency, includes, requires_compliance, capacity, sort_order, sizes, pay_note, event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${CUR}) RETURNING id`,
      [f.name, f.price_cents, currency, f.includes || '', !!f.requires_compliance, f.capacity ?? null, f.sort_order || 0,
        f.sizes || '', f.pay_note || '']);
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) {
    serverError(res, err);
  }
});

app.post('/api/admin/packages/:id', requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const id = idOf(req.params.id);
  const { error, fields: f } = packageInput(req.body || {});
  if (error) return res.status(400).json({ error });
  const cols = Object.keys(f); // fixed column names from packageInput, never from the request
  if (!id || !cols.length) return res.status(400).json({ error: 'Nothing to update.' });
  try {
    // Only the current event's packages can change; a past event's stay as they were sold.
    const r = await pool.query(`UPDATE packages SET ${cols.map((c, n) => `${c} = $${n + 1}`).join(', ')} WHERE id = $${cols.length + 1} AND event_id = ${CUR}`,
      [...cols.map((c) => f[c]), id]);
    if (!r.rowCount) return res.status(404).json({ error: "That package isn't part of the current event." });
    res.json({ success: true });
  } catch (err) {
    serverError(res, err);
  }
});

app.post('/api/admin/packages/:id/delete', requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid package.' });
  try {
    if (!(await pool.query(`SELECT 1 FROM packages WHERE id = $1 AND event_id = ${CUR}`, [id])).rowCount) {
      return res.status(404).json({ error: "That package isn't part of the current event." });
    }
    const used = await pool.query('SELECT 1 FROM orders WHERE package_id = $1 LIMIT 1', [id]);
    if (used.rowCount) {
      await pool.query('UPDATE packages SET active = FALSE WHERE id = $1', [id]);
      return res.json({ success: true, retired: true });
    }
    await pool.query('DELETE FROM packages WHERE id = $1', [id]);
    res.json({ success: true, retired: false });
  } catch (err) {
    serverError(res, err);
  }
});

// ---------- Orders ----------
const newRef = () => 'ODR-' + crypto.randomBytes(4).toString('hex').toUpperCase();

// Note: payments.js registers its own /api/my-order first (adds pay_by and payment_instructions).
// This one is only a fallback and is never reached while payments.js is loaded.
app.get('/api/my-order', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT o.id, o.status, o.reference_code, o.created_at, p.name AS package_name,
              COALESCE(o.amount_cents, p.price_cents) AS price_cents, COALESCE(o.currency, p.currency) AS currency, p.includes
       FROM orders o JOIN packages p ON p.id = o.package_id
       WHERE o.guest_email = $1 AND o.status <> 'CANCELLED' AND o.event_id = ${CUR} ORDER BY o.id DESC LIMIT 1`, [req.userEmail]);
    res.json(r.rows[0] || null);
  } catch (err) {
    serverError(res, err);
  }
});

app.post('/api/orders', requireAuth, rateLimit(10, 60 * 60 * 1000, perUser), rateLimit(300, 60 * 60 * 1000), async (req, res) => {
  const packageId = idOf(req.body?.package_id);
  if (!packageId) return res.status(400).json({ error: 'Choose a package.' });
  if (req.body?.terms !== true) return res.status(400).json({ error: 'Agree to the terms to reserve a package.', code: 'TERMS_REQUIRED' });
  if (cleanCode(req.body?.promo_code) && tooManyWrongCodes(req)) return res.status(429).json(WRONG_CODES);
  let client;
  try {
    // Read before taking a connection: the package row stays locked until the order is saved, so nothing in between
    // may wait for a second connection (a rush of reservations would use up the pool and fail).
    const settings = await mail.getSettings();
    client = await pool.connect();
    await client.query('BEGIN');
    // Held until the order is saved, so a new event can't start halfway and leave this one in the old event.
    const ev = (await client.query("SELECT id FROM events WHERE status = 'current' FOR SHARE")).rows[0];
    // The guest row stays locked until the order is saved, so two quick reservations can't both go through.
    const guest = await client.query(
      'SELECT approval, full_name, birth_date, instagram FROM guests WHERE LOWER(email) = $1 ORDER BY id FOR UPDATE', [req.userEmail]);
    if (!guest.rowCount) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'That account is no longer on the roster.' });
    }
    const g = guest.rows[0];
    if (g.approval !== 'APPROVED') {
      await client.query('ROLLBACK');
      return res.status(403).json(notApproved(g.approval));
    }
    // The date of birth is the 18+ check. The profile is saved through /api/profile, never here.
    // "Reload the page" is for a page cached from before the profile form, which can only show this message.
    if (!g.full_name || !g.birth_date || !g.instagram) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Finish your profile first: your name, date of birth and Instagram. Reload the page to add them.', code: 'PROFILE_REQUIRED' });
    }
    // One active order per guest per event: a pass from a past event doesn't count.
    const existing = await client.query("SELECT 1 FROM orders WHERE guest_email = $1 AND status <> 'CANCELLED' AND event_id = $2", [req.userEmail, ev.id]);
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You already have a package reserved. Cancel it first to choose another.' });
    }
    const pkg = await client.query(
      'SELECT id, name, price_cents, currency, capacity, active, sizes, pay_note, event_id FROM packages WHERE id = $1 FOR UPDATE', [packageId]);
    const p = pkg.rows[0];
    if (!p || !p.active || p.event_id !== ev.id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'That package is no longer available.' });
    }
    const sizes = sizeList(p.sizes);
    const size = pickSize(sizes, req.body?.size);
    if (sizes.length && !size) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Choose your size.', code: 'SIZE_REQUIRED' });
    }
    if (p.capacity !== null) {
      const claimed = await client.query("SELECT COUNT(*) FROM orders WHERE package_id = $1 AND status <> 'CANCELLED'", [packageId]);
      if (parseInt(claimed.rows[0].count, 10) >= p.capacity) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'That package just sold out.', code: 'SOLD_OUT' });
      }
    }
    // The price on sale now (see pricing.js). The package row is locked, so two guests can't both take a tier's last spot.
    const price = priceOf(p, (await loadTiers(client, [packageId])).get(packageId) || []);
    if (price.closed) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Sales for this package are closed.', code: 'SOLD_OUT' });
    }
    // The guest site sends the tier and price it showed. If either has moved on since (a new tier, or the admin edited
    // the price), the guest sees the new one first.
    const tierId = price.tier ? price.tier.id : null;
    const shown = req.body || {};
    if ((Object.hasOwn(shown, 'tier_id') && (shown.tier_id == null ? null : toInt(shown.tier_id)) !== tierId) ||
        (Object.hasOwn(shown, 'price_cents') && toInt(shown.price_cents) !== price.list_cents)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `The price just changed to ${money(price.list_cents, p.currency)}. Check it and try again.`,
        code: 'PRICE_CHANGED', price_cents: price.list_cents, tier_name: price.tier ? price.tier.name : null });
    }
    // Locking the code row stops two guests from both taking its last use.
    const code = cleanCode(req.body?.promo_code);
    let promo = null;
    if (code) {
      const check = await checkPromo(client, code, packageId, { lock: true });
      if (check.error) {
        await client.query('ROLLBACK');
        countWrongCode(req);
        return res.status(400).json({ error: check.error, code: 'PROMO_INVALID' });
      }
      promo = check.promo;
    }
    const list = price.list_cents;
    const discount = promo ? discountFor(promo, list) : 0;
    const amount = list - discount;
    const free = amount === 0; // a free pass is confirmed straight away
    // The order keeps the deadline worked out now, so changing the payment settings later only affects new
    // reservations. NOW() is the same for the whole transaction, so this is the new row's created_at.
    const now = (await client.query('SELECT NOW() AS now')).rows[0].now;
    const payBy = free ? null : mail.deadlineFor(now, settings);
    const ref = newRef();
    await client.query(
      `INSERT INTO orders (guest_email, package_id, reference_code, size, terms_accepted_at, pay_days, pay_by, tier_id, tier_name,
                           list_cents, discount_cents, amount_cents, currency, promo_code, status, paid_at, paid_via, event_id)
       VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [req.userEmail, packageId, ref, size, settings.payDays, payBy, tierId, price.tier ? price.tier.name : null,
        list, discount, amount, p.currency, promo ? promo.code : null,
        free ? 'PAID' : 'RESERVED', free ? now : null, free ? 'COMP' : null, ev.id]);
    await client.query('COMMIT');
    res.json({ success: true, reference_code: ref, status: free ? 'PAID' : 'RESERVED', amount_cents: amount, currency: p.currency });
    // Sent after responding so a slow email never holds up the guest.
    if (free) {
      sendPaidEmail(req.userEmail, p.name, ref, { free: true });
      notify('sales', { title: 'Free pass claimed', body: `${p.name}${promo ? ' · with a code' : ''}`, url: '/admin/app#home' });
    } else {
      sendOrderReceivedEmail(req.userEmail, {
        package_name: p.name, reference_code: ref, list_cents: list, discount_cents: discount, amount_cents: amount,
        currency: p.currency, promo_code: promo ? promo.code : null, pay_by: payBy, pay_note: p.pay_note
      }, settings.instructions).catch((e) => console.error('Order-received email error:', e));
    }
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    serverError(res, err);
  } finally {
    client?.release();
  }
});

// Lets a guest change the size on their current order (from the sizes the package offers), unless the organizers
// have locked sizes (see pickup.js) or the package has been collected. The admin can still change it from the Orders tab.
app.post('/api/orders/size', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT o.id, o.status, o.picked_up_at, p.sizes FROM orders o JOIN packages p ON p.id = o.package_id
       WHERE o.guest_email = $1 AND o.status <> 'CANCELLED' AND o.event_id = ${CUR} ORDER BY o.id DESC LIMIT 1`, [req.userEmail]);
    if (!r.rowCount) return res.status(400).json({ error: 'You have no order to change.' });
    // The size handed out is the one counted as collected, so it can't change afterwards.
    if (r.rows[0].picked_up_at) {
      return res.status(409).json({ error: "Your package has been collected, so your size can't change. Contact us if you need help.", code: 'SIZE_LOCKED' });
    }
    if (isSizeLocked(await getSizeLock(pool), r.rows[0].status)) {
      return res.status(409).json({ error: 'Sizes are locked now. Contact us if yours needs to change.', code: 'SIZE_LOCKED' });
    }
    const size = pickSize(sizeList(r.rows[0].sizes), req.body?.size);
    if (!size) return res.status(400).json({ error: 'Choose one of the sizes listed.' });
    await pool.query('UPDATE orders SET size = $1 WHERE id = $2', [size, r.rows[0].id]);
    res.json({ success: true, size });
  } catch (err) {
    serverError(res, err);
  }
});

app.post('/api/orders/cancel', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE orders SET status = 'CANCELLED' WHERE guest_email = $1 AND status = 'RESERVED' AND event_id = ${CUR}
       RETURNING reference_code, (SELECT name FROM packages WHERE id = orders.package_id) AS package_name`, [req.userEmail]);
    if (!r.rowCount) return res.status(400).json({ error: 'No reserved order to cancel.' });
    res.json({ success: true });
    const o = r.rows[0];
    mail.send(req.userEmail, "Reservation cancelled — On D' Road", renderEmail({
      tone: 'bad', tag: 'Reservation cancelled', title: 'Cancelled',
      lines: [`Your reservation for ${o.package_name} is cancelled.`,
        "You hadn't paid, so nothing is owed. If spots are still open, you can reserve again from your account."],
      details: [['Reference', o.reference_code, true]],
      cta: { text: 'Open my account', url: FRONTEND_URL }
    }));
  } catch (err) {
    serverError(res, err);
  }
});

// A paid guest asks to cancel and get their money back. The pass stays valid until the organizer approves.
app.post('/api/orders/request-refund', requireAuth, rateLimit(5, 60 * 60 * 1000, perUser), async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
  try {
    const r = await pool.query(
      `UPDATE orders SET cancel_requested_at = NOW(), cancel_reason = $2
       WHERE guest_email = $1 AND status = 'PAID' AND cancel_requested_at IS NULL AND event_id = ${CUR}
       RETURNING reference_code, amount_cents = 0 AS free,
                 (SELECT name FROM packages WHERE id = orders.package_id) AS package_name`, [req.userEmail, reason]);
    if (!r.rowCount) return res.status(400).json({ error: 'No paid order to cancel, or a request is already open.' });
    res.json({ success: true });
    const o = r.rows[0];
    // A free pass has nothing to refund: the guest is only asking to give the spot up.
    mail.send(req.userEmail, o.free ? "Cancellation request received — On D' Road" : "Refund request received — On D' Road", renderEmail({
      tone: 'warn', tag: 'Request received', title: 'We got your request',
      lines: o.free
        ? [`You asked to cancel your free pass for ${o.package_name}.`,
          "We'll email you once it's cancelled. Your pass keeps working until then."]
        : [`You asked to cancel ${o.package_name} and get your money back.`,
          "We'll email you when your refund is approved, with how to collect it. Your pass keeps working until then."],
      details: [['Package', o.package_name], ['Reference', o.reference_code, true]],
      cta: { text: 'Open my account', url: FRONTEND_URL },
      fine: 'Changed your mind? You can withdraw the request from your account.'
    }));
    notify('refunds', { title: o.free ? 'Cancellation requested' : 'Refund requested', body: `${o.package_name} · ${o.reference_code}`, url: '/admin#orders' });
    if (ADMIN_EMAIL) {
      mail.send(ADMIN_EMAIL, `${o.free ? 'Cancellation' : 'Refund'} requested: ${o.reference_code}`, renderEmail({
        tone: 'warn', tag: o.free ? 'Cancellation request' : 'Refund request', title: 'Action needed',
        lines: [o.free ? `${req.userEmail} wants to cancel their free pass for ${o.package_name}.`
          : `${req.userEmail} wants to cancel ${o.package_name} and get a refund.`,
          'Approve it in the Orders tab of the Command Center.'],
        details: [['Guest', req.userEmail], ['Package', o.package_name], ['Reference', o.reference_code, true], ['Reason', reason || 'None given']],
        cta: { text: 'Open Command Center', url: `${req.protocol}://${req.get('host')}/admin` }
      }));
    }
  } catch (err) {
    serverError(res, err);
  }
});

app.post('/api/orders/withdraw-refund', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE orders SET cancel_requested_at = NULL, cancel_reason = NULL
       WHERE guest_email = $1 AND status = 'PAID' AND cancel_requested_at IS NOT NULL AND event_id = ${CUR}`, [req.userEmail]);
    if (!r.rowCount) return res.status(400).json({ error: 'No open cancellation request.' });
    res.json({ success: true });
  } catch (err) {
    serverError(res, err);
  }
});

// The current event's orders; ?event=<id> for another event's, ?event=all for every event's (the reset page's copy).
app.get('/api/admin/orders', requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const all = req.query.event === 'all';
  const id = /^\d{1,9}$/.test(String(req.query.event || '')) ? Number(req.query.event) : null;
  try {
    const r = await pool.query(
      `SELECT o.id, o.package_id, o.guest_email, o.status, o.reference_code, o.created_at, o.paid_at,
              o.cancel_requested_at, o.cancel_reason, o.refunded_at, o.checked_in_at, o.checked_in_by, o.size,
              o.paid_via, o.paypal_status, o.paypal_amount, o.paypal_refund_id, o.tier_name, o.promo_code,
              o.discount_cents, o.picked_up_at, o.picked_up_by, o.marked_paid_by,
              COALESCE(o.amount_cents, p.price_cents) AS amount_cents, COALESCE(o.list_cents, p.price_cents) AS list_cents,
              COALESCE(o.amount_cents, p.price_cents) AS price_cents, COALESCE(o.currency, p.currency) AS currency,
              NOT EXISTS (SELECT 1 FROM guests g WHERE LOWER(g.email) = LOWER(o.guest_email)) AS removed_guest,
              p.name AS package_name, p.sizes AS package_sizes, o.event_id, e.name AS event_name, e.status = 'current' AS current_event
       FROM orders o JOIN packages p ON p.id = o.package_id LEFT JOIN events e ON e.id = o.event_id
       ${all ? '' : id ? 'WHERE o.event_id = $1' : `WHERE o.event_id = ${CUR}`}
       ORDER BY (o.status = 'PAID' AND o.cancel_requested_at IS NOT NULL) DESC, o.id DESC`, id && !all ? [id] : []);
    res.json(r.rows);
  } catch (err) {
    serverError(res, err);
  }
});

// "Your spot is held" email for a new reservation. o: package_name, reference_code, list_cents, discount_cents,
// amount_cents, currency, promo_code, pay_by (the stored deadline, or null) and pay_note (the package's own cash details).
async function sendOrderReceivedEmail(to, o, instructions) {
  const due = o.pay_by ? mail.fmt(new Date(o.pay_by)) : null;
  const howToPay = [instructions, o.pay_note].map((t) => (t || '').trim()).filter(Boolean).join('\n\n');
  const discounted = o.discount_cents > 0
    ? [['Price', money(o.list_cents, o.currency)], [`Code ${o.promo_code}`, `${money(o.discount_cents, o.currency)} off`]] : [];
  return mail.send(to, "Order received — On D' Road", renderEmail({
    tone: 'warn', tag: 'Order received', title: 'Your spot is held',
    preheader: due ? `Pay by ${due} to confirm your spot.` : 'Your spot is held until you pay.',
    lines: [`You reserved ${o.package_name}. Your spot is confirmed once you pay.`,
      'Your entry pass shows up in your account as soon as your payment is received.'],
    details: [['Package', o.package_name], ...discounted, [discounted.length ? 'You pay' : 'Amount', money(o.amount_cents, o.currency)],
      ['Reference', o.reference_code, true], ['Pay by', due]],
    callout: howToPay ? { label: 'How to pay', text: howToPay } : null,
    cta: { text: 'View my order', url: FRONTEND_URL },
    fine: due
      ? 'Bring your reference code when you pay. Unpaid reservations are cancelled automatically after the deadline.'
      : 'Bring your reference code when you pay.'
  }));
}

// ---------- The live pass (see liveqr.js) ----------
// Passes show a live QR on the guest site ("ONDROAD:<reference>:<code>", the code changing every 30 seconds), worked out
// in the browser from the secret /api/my-order sends to the paid guest. Emails carry no QR any more, only a button to
// the live pass. The still images that used to be emailed are retired: their old links answer 410.
app.get('/api/pass/:ref.png', (req, res) => res.status(410).type('text/plain').send('Open your live pass on your phone.'));

// "You're confirmed" email. free: a free pass (promo code or free package), so nothing was paid.
async function sendPaidEmail(to, packageName, ref, { free } = {}) {
  return mail.send(to, "You're confirmed — On D' Road", renderEmail({
    tone: 'good', tag: free ? 'Free pass' : 'Payment confirmed', title: "You're in",
    preheader: free ? 'Your free pass is confirmed. Open your pass on your phone.' : 'Payment received. Open your pass on your phone.',
    lines: [free ? 'Your free pass is confirmed.' : 'Payment received. Your spot is confirmed.',
      'Your entry pass is in your account. Open it on your phone at the entrance: the QR on it changes every 30 seconds. Final event details, location and package pickup info will follow closer to the date.'],
    details: [['Package', packageName], ['Reference', ref, true]],
    cta: { text: 'Open your pass', url: FRONTEND_URL },
    fine: "Screenshots won't work at the door; open your pass on your phone."
  }));
}

app.post('/api/admin/orders/:id/mark-paid', requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const id = idOf(req.params.id);
  try {
    const r = await pool.query(
      `UPDATE orders SET status = 'PAID', paid_at = NOW(), paid_via = 'MANUAL', marked_paid_by = $2, marked_paid_by_id = $3
       WHERE id = $1 AND status = 'RESERVED' AND event_id = ${CUR}
       RETURNING guest_email, reference_code, (SELECT name FROM packages WHERE id = orders.package_id) AS package_name`, [id, req.admin.name, req.admin.id]);
    if (!r.rowCount) return res.status(400).json({ error: 'Order not found or already resolved.' });
    const { guest_email, reference_code, package_name } = r.rows[0];
    const emailError = await sendPaidEmail(guest_email, package_name, reference_code);
    res.json({ success: true, emailed: !emailError });
  } catch (err) {
    serverError(res, err);
  }
});

// Cancels an unpaid reservation. Paid orders go through approve-refund instead.
app.post('/api/admin/orders/:id/cancel', requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const id = idOf(req.params.id);
  try {
    const r = await pool.query(
      `UPDATE orders SET status = 'CANCELLED' WHERE id = $1 AND status = 'RESERVED' AND event_id = ${CUR}
       RETURNING guest_email, reference_code, (SELECT name FROM packages WHERE id = orders.package_id) AS package_name`, [id]);
    if (!r.rowCount) return res.status(400).json({ error: 'Order not found or not an unpaid reservation.' });
    const o = r.rows[0];
    const emailError = await mail.send(o.guest_email, "Reservation cancelled — On D' Road", renderEmail({
      tone: 'bad', tag: 'Reservation cancelled', title: 'Cancelled',
      lines: [`Your reservation for ${o.package_name} was cancelled by the organizers.`,
        "You hadn't paid, so nothing is owed. If you think this is a mistake, contact the organizers."],
      details: [['Reference', o.reference_code, true]],
      cta: { text: 'Open my account', url: FRONTEND_URL }
    }));
    res.json({ success: true, emailed: !emailError });
  } catch (err) {
    serverError(res, err);
  }
});

// Cancels a paid order and records the refund. The guest's pass stops working immediately.
// A PayPal payment is refunded through PayPal first; if PayPal refuses, nothing changes here.
app.post('/api/admin/orders/:id/approve-refund', requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const id = idOf(req.params.id);
  try {
    const cur = await pool.query(
      `SELECT reference_code, paid_via, paypal_capture_id, paypal_amount, event_id = ${CUR} AS current FROM orders WHERE id = $1 AND status = 'PAID'`, [id]);
    if (!cur.rowCount) return res.status(400).json({ error: 'Order not found or not paid.' });
    // A past event's passes are history; its open refund requests had to be settled before it ended.
    if (!cur.rows[0].current) return res.status(400).json({ error: 'This order is from a past event.' });
    const pp = cur.rows[0].paid_via === 'PAYPAL' && cur.rows[0].paypal_capture_id ? cur.rows[0] : null;
    let refundId = null;
    if (pp) {
      const rf = await paypal.refund(pp);
      if (!rf.ok) return res.status(502).json({ error: `PayPal didn't accept the refund (${rf.error}), so nothing was changed. Try again, or refund it in PayPal and then approve it here.` });
      refundId = rf.id;
    }
    const r = await pool.query(
      `UPDATE orders o SET status = 'CANCELLED', refunded_at = NOW(), paypal_refund_id = COALESCE($2, o.paypal_refund_id) FROM packages p
       WHERE o.id = $1 AND p.id = o.package_id AND o.status = 'PAID' AND o.event_id = ${CUR}
       RETURNING o.guest_email, o.reference_code, p.name AS package_name,
                 COALESCE(o.amount_cents, p.price_cents) AS amount_cents, COALESCE(o.currency, p.currency) AS currency`, [id, refundId]);
    if (!r.rowCount) return res.status(400).json({ error: 'Order not found or not paid.' });
    const o = r.rows[0];
    // No pass, no attendance: confirmed attendance goes back to pending (it's locked only while they hold a pass).
    await pool.query(
      `UPDATE guests SET rsvp_status = 'PENDING' WHERE LOWER(email) = LOWER($1) AND rsvp_status = 'CONFIRMED'
         AND NOT EXISTS (SELECT 1 FROM orders WHERE LOWER(guest_email) = LOWER($1) AND status = 'PAID' AND event_id = ${CUR})`, [o.guest_email]);
    // A free pass has nothing to refund, so the guest just hears it's cancelled.
    const emailError = o.amount_cents === 0 && !pp ? await mail.send(o.guest_email, "Free pass cancelled — On D' Road", renderEmail({
      tone: 'bad', tag: 'Pass cancelled', title: 'Cancelled',
      lines: [`Your free pass for ${o.package_name} is cancelled.`,
        'Nothing was paid, so nothing is owed. Your entry pass no longer works.'],
      details: [['Package', o.package_name], ['Reference', o.reference_code, true]],
      cta: { text: 'Open my account', url: FRONTEND_URL }
    })) : await mail.send(o.guest_email, "Refund approved — On D' Road", renderEmail({
      tone: 'good', tag: 'Refund approved', title: 'Refund approved',
      lines: [`Your order for ${o.package_name} is cancelled and your refund is approved.`,
        pp ? 'The money is going back to the PayPal account or card you paid with. It can take a few days to show. Your entry pass no longer works.'
          : 'Refunds are paid in cash where you paid. Bring your reference code. Your entry pass no longer works.'],
      details: [['Package', o.package_name], ['Refund', pp ? `USD ${pp.paypal_amount}` : money(o.amount_cents, o.currency)], ['Reference', o.reference_code, true]]
    }));
    res.json({ success: true, emailed: !emailError });
  } catch (err) {
    serverError(res, err);
  }
});

// ---------- Admin ----------
// Every guest with their age today (Antigua), who invited them and the invite's note, and their invites for the
// current event (invites_left, invite_bonus and invites_sent), in one query.
app.get('/api/admin/guests', requireRole('OWNER', 'ADMIN'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT g.*, date_part('year', age((NOW() AT TIME ZONE 'America/Antigua')::date, g.birth_date))::int AS age,
              inv.inviter_email AS invited_by, inviter.full_name AS invited_by_name, inv.note AS invite_note,
              ${INVITES_LEFT_SQL} AS invites_left,
              COALESCE((SELECT ge.invite_bonus FROM guest_event ge WHERE ge.email = LOWER(g.email) AND ge.event_id = ${CUR}), 0) AS invite_bonus,
              (SELECT COUNT(*) FROM invites i WHERE LOWER(i.inviter_email) = LOWER(g.email) AND i.event_id = ${CUR} AND i.status <> 'REVOKED')::int AS invites_sent
       FROM guests g ${INVITED_BY_SQL}
       ORDER BY g.id ASC`);
    res.json(result.rows);
  } catch (err) {
    serverError(res, err);
  }
});

// Approves a sign-up request, pending or declined, and emails the guest. A second click finds nothing left to
// approve, so the email goes once.
app.post('/api/admin/guests/approve', requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
  try {
    const r = await pool.query(
      `UPDATE guests SET approval = 'APPROVED', decided_at = NOW()
       WHERE LOWER(email) = $1 AND approval IN ('PENDING', 'DECLINED') RETURNING email, full_name`, [email]);
    if (!r.rowCount) {
      const g = await pool.query('SELECT approval FROM guests WHERE LOWER(email) = $1', [email]);
      if (!g.rowCount) return res.status(404).json({ error: 'That guest is not on the roster.' });
      return res.json({ success: true, already: true, emailed: false });
    }
    const first = String(r.rows[0].full_name || '').split(' ')[0];
    const emailError = await mail.send(email, "You're approved — On D' Road", renderEmail({
      tone: 'good', tag: 'Approved', title: "You're approved",
      preheader: 'Pick your package to hold your spot.',
      lines: [`${first ? first + ', you' : 'You'}'re in. Pick your package.`,
        'Log in with this email address, choose your package and reserve it to hold your spot. Your entry pass shows up once you pay.'],
      cta: { text: 'Pick your package', url: SITE_URL }
    }));
    res.json({ success: true, emailed: !emailError });
  } catch (err) {
    serverError(res, err);
  }
});

// Declines a pending request. Nothing is sent, the invite stays used, and the inviter doesn't get it back.
app.post('/api/admin/guests/decline', requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
  try {
    const r = await pool.query(
      "UPDATE guests SET approval = 'DECLINED', decided_at = NOW() WHERE LOWER(email) = $1 AND approval = 'PENDING'", [email]);
    if (!r.rowCount) {
      const g = await pool.query('SELECT approval FROM guests WHERE LOWER(email) = $1', [email]);
      if (!g.rowCount) return res.status(404).json({ error: 'That guest is not on the roster.' });
      if (g.rows[0].approval === 'DECLINED') return res.json({ success: true, already: true });
      return res.status(409).json({ error: 'Only pending requests can be declined.' });
    }
    res.json({ success: true });
  } catch (err) {
    serverError(res, err);
  }
});

// The admin can always change a guest's name, date of birth and Instagram, paid or not. '' clears a field.
app.post('/api/admin/guests/profile', requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
  const { fields, error } = profileInput(req.body || {}, 'admin');
  if (error) return res.status(400).json(error);
  const cols = Object.keys(fields); // fixed names from PROFILE_FIELDS, never from the request
  try {
    const r = cols.length
      ? await pool.query(`UPDATE guests SET ${cols.map((c, n) => `${c} = $${n + 2}`).join(', ')} WHERE LOWER(email) = $1`,
        [email, ...cols.map((c) => fields[c])])
      : await pool.query('SELECT 1 FROM guests WHERE LOWER(email) = $1', [email]);
    if (!r.rowCount) return res.status(404).json({ error: 'That guest is not on the roster.' });
    res.json({ success: true, guest: await guestStatus(pool, email) });
  } catch (err) {
    serverError(res, err);
  }
});

// A guest's extra invites for the current event (on top of the event's invites per guest), in guest_event. The legacy
// guests.invites_left column isn't used any more (see events.js).
const setInviteBonus = (db, email, bonus) => db.query(
  `INSERT INTO guest_event (email, event_id, invite_bonus) VALUES ($1, ${CUR}, $2)
   ON CONFLICT (email, event_id) DO UPDATE SET invite_bonus = EXCLUDED.invite_bonus`, [email, bonus]);

// Back to the event's standard allowance: no bonus.
app.post('/api/admin/reset-invites', requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
  try {
    await setInviteBonus(pool, email, 0);
    res.json({ success: true });
  } catch (err) {
    serverError(res, err);
  }
});

app.post('/api/admin/add-guest', requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
  try {
    await pool.query(
      `INSERT INTO guests (email, rsvp_status, shirt_size, invites_left)
       SELECT $1::text, 'PENDING', 'Unassigned', 2
       WHERE NOT EXISTS (SELECT 1 FROM guests WHERE LOWER(email) = $1::text)`,
      [email]
    );
    res.json({ success: true });
  } catch (err) {
    serverError(res, err);
  }
});

// The current event's invites, plus pending ones from past events (their links still work, so they can be revoked).
// ?event=all: every invite. promoter_name is set on a promoter's invite (inviter_email 'PROMOTER').
app.get('/api/admin/invites', requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const all = req.query.event === 'all';
  try {
    const r = await pool.query(
      `SELECT i.id, i.inviter_email, i.invitee_email, i.note, i.status, i.created_at, i.accepted_at, i.event_id, i.promoter_id,
              pr.name AS promoter_name, e.name AS event_name, e.status = 'current' AS current_event
       FROM invites i LEFT JOIN promoters pr ON pr.id = i.promoter_id LEFT JOIN events e ON e.id = i.event_id
       ${all ? '' : `WHERE i.event_id = ${CUR} OR i.status = 'PENDING'`} ORDER BY i.id DESC`);
    res.json(r.rows);
  } catch (err) {
    serverError(res, err);
  }
});

app.post('/api/admin/revoke-invite', requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const id = idOf(req.body?.id);
  if (!id) return res.status(400).json({ error: 'Invalid invite.' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // The inviter (a guest or a promoter) gets it back: allowances count the invites that aren't revoked.
    const r = await client.query("UPDATE invites SET status = 'REVOKED' WHERE id = $1 AND status = 'PENDING' RETURNING inviter_email", [id]);
    if (!r.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only pending invites can be revoked.' });
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    serverError(res, err);
  } finally {
    client?.release();
  }
});

// How many invites a guest can still send for the current event: stored as their bonus, so that the event's invites
// per guest + bonus - invites sent = count.
app.post('/api/admin/set-invites', requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const count = parseInt(req.body?.count, 10);
  if (!isValidEmail(email) || !(count >= 0 && count <= 20)) return res.status(400).json({ error: 'Invalid email or count (0-20).' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // The guest's row is locked as send-invite locks it, so an invite going out right now is counted.
    const g = await client.query('SELECT 1 FROM guests WHERE LOWER(email) = $1 ORDER BY id FOR UPDATE', [email]);
    if (!g.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That guest is not on the roster.' });
    }
    const r = (await client.query(
      `SELECT (SELECT invites_per_guest FROM events WHERE status = 'current') AS per_guest,
              (SELECT COUNT(*) FROM invites WHERE LOWER(inviter_email) = $1 AND event_id = ${CUR} AND status <> 'REVOKED')::int AS sent`, [email])).rows[0];
    await setInviteBonus(client, email, count + r.sent - r.per_guest);
    await client.query('COMMIT');
    res.json({ success: true, invites_left: count });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    serverError(res, err);
  } finally {
    client?.release();
  }
});
app.post('/api/admin/remove-guest', requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
  // A paid guest must be refunded first, or their pass would keep working at the door.
  // Unpaid reservations are cancelled so the spots free up.
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Locked first, as /api/orders locks the guest row, so no new order (a free pass is PAID at once) can slip in.
    await client.query('SELECT 1 FROM guests WHERE LOWER(email) = $1 FOR UPDATE', [email]);
    // Their orders are locked too, so a payment or a free code being applied right now finishes before we look. Only the
    // current event's count: a past event's pass doesn't open the door any more.
    const open = await client.query(
      `SELECT status, reference_code FROM orders WHERE LOWER(guest_email) = $1 AND status <> 'CANCELLED' AND event_id = ${CUR} ORDER BY id FOR UPDATE`, [email]);
    const paid = open.rows.find((o) => o.status === 'PAID');
    if (paid) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `${email} has a paid order (${paid.reference_code}). Refund it in the Orders tab first, then remove them.` });
    }
    const cancelled = await client.query(
      "UPDATE orders SET status = 'CANCELLED' WHERE LOWER(guest_email) = $1 AND status = 'RESERVED'", [email]);
    await client.query('DELETE FROM guests WHERE LOWER(email) = $1', [email]);
    await client.query('COMMIT');
    res.json({ success: true, cancelled: cancelled.rowCount });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    serverError(res, err);
  } finally {
    client?.release();
  }
});

const ADMIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0a0a0b">
<title>Command Center | On D' Road</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
/* Night Kinetic, admin edition: matte charcoal, one sharp accent (safety orange), hairline rules and square corners.
   Concrete is kept for utility surfaces (dialogs, toasts). Calm and dense for daily work. */
:root {
  --bg: #0a0a0b; --surface: #141416; --surface-2: #1a1a1d; --raise: #232327; --well: #0a0a0b;
  --line: rgba(236, 235, 230, .1); --line-strong: rgba(236, 235, 230, .24);
  --text: #ecebe6; --muted: #a6a59f; --dim: #8a8983;
  --accent: #ff5a1f; --accent-hi: #ff7440; --accent-ink: #141416;
  --good: #b6ff3b; --warn: #ffc02e; --bad: #ff7a6b; --cyan: #22e1ff;
  --concrete: #c9c8c3; --concrete-2: #e4e3df; --ink: #141416; --ink-2: #47463f;
  --display: 'Archivo', 'Helvetica Neue', Arial, sans-serif; --body: 'Archivo', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; --mono: 'Space Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --chev: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none' stroke='%23ecebe6' stroke-width='1.6'%3E%3Cpath d='M1 1.5l5 5 5-5'/%3E%3C/svg%3E");
  --xh: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28' fill='none' stroke='%23141416' stroke-opacity='0.55' stroke-width='1'%3E%3Ccircle cx='14' cy='14' r='6.5'/%3E%3Cpath d='M14 0v28M0 14h28'/%3E%3C/svg%3E");
  /* The CASHCXDE ENT. watermark (brand.js), faint in the header band */
  --wm: ${WM_LITE};
  color-scheme: dark;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 var(--body); -webkit-font-smoothing: antialiased; }
.hidden { display: none !important; }
a { color: inherit; }
::selection { background: var(--accent); color: var(--accent-ink); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* ---------- Top bar ---------- */
.top {
  position: sticky; top: 0; z-index: 30; display: flex; align-items: center; justify-content: space-between; gap: 10px 20px; flex-wrap: wrap;
  min-height: 60px; padding: 10px clamp(16px, 3vw, 32px); background: var(--wm) 0 0 / 260px 150px, rgba(10, 10, 11, .92); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--line);
}
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.brand .mark { flex: none; width: 30px; height: 18px; overflow: visible; }
.brand b { font-family: var(--display); font-stretch: 125%; font-weight: 900; font-size: 16px; line-height: 1; letter-spacing: .01em; white-space: nowrap; }
.brand b span { color: var(--accent); }
.brand b i { font-style: normal; font-weight: 200; }
.brand .sub { font-family: var(--mono); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); white-space: nowrap; }
.brand .sub::before { content: '[ '; color: var(--dim); }
.brand .sub::after { content: ' ]'; color: var(--dim); }
.top-right { display: flex; align-items: center; flex-wrap: wrap; }
.top-link { position: relative; display: inline-flex; align-items: center; min-height: 36px; padding: 0 8px; font-size: 13px; font-weight: 500; color: var(--muted); text-decoration: none; transition: color .15s; }
.top-link::after { content: ''; position: absolute; left: 8px; right: 8px; bottom: 5px; height: 1px; background: var(--accent); transform: scaleX(0); transform-origin: left; transition: transform .2s; }
.top-link:hover { color: var(--text); }
.top-link:hover::after { transform: none; }
.clock { font-family: var(--mono); font-size: 11.5px; color: var(--dim); margin-left: 6px; padding-left: 12px; border-left: 1px solid var(--line); white-space: nowrap; }
@media (max-width: 1279px) { .brand .sub { display: none; } }
@media (max-width: 700px) {
  /* Phones: the bar scrolls away with the page, and the links become a compact grid of square chips */
  .top { position: static; }
  .top-right { gap: 6px; }
  .top-link { min-height: 36px; padding: 0 10px; font-size: 12.5px; border: 1px solid var(--line); }
  .top-link::after { content: none; }
  .clock { margin-left: 2px; padding-left: 8px; }
}

.wrap { max-width: 1240px; margin: 0 auto; padding: clamp(24px, 3vw, 40px) clamp(16px, 3vw, 32px) 80px; }
/* The title block closes with a hairline and a short orange tab on it */
.page-head { position: relative; display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; padding-bottom: 20px; border-bottom: 1px solid var(--line); }
.page-head::after { content: ''; position: absolute; left: 0; bottom: -1px; width: 56px; height: 2px; background: var(--accent); }
.page-head h1 { font-family: var(--display); font-stretch: 125%; font-weight: 800; font-size: clamp(34px, 5vw, 52px); line-height: .95; letter-spacing: -.01em; text-transform: uppercase; margin: 0; }
.page-head p { margin: 12px 0 0; font-family: var(--mono); font-size: 12px; letter-spacing: .02em; color: var(--muted); }
/* The current event, above the title */
.evtag { display: inline-block; margin-bottom: 12px; font-family: var(--mono); font-size: 11.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--text); text-decoration: none; overflow-wrap: anywhere; }
.evtag:empty { display: none; }
.evtag::before { content: '[ Event: '; color: var(--dim); } .evtag::after { content: ' ]'; color: var(--dim); }
.evtag:hover { color: var(--accent-hi); }
.past-note { margin: 0; padding: 10px 14px; border-bottom: 1px solid var(--line); border-left: 2px solid var(--cyan); background: var(--surface-2); font-size: 13.5px; color: var(--muted); }

/* ---------- Attention banner ---------- */
.alert {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 11px 14px 11px 14px; margin-bottom: 16px;
  background: rgba(255, 192, 46, .06); border: 1px solid rgba(255, 192, 46, .32); border-left: 3px solid var(--warn); color: var(--text); font-weight: 600;
}
.alert .btn { margin-left: auto; }
.alert > span { flex: 1 1 220px; min-width: 0; }
.alert::before { content: '!'; display: inline-grid; place-items: center; flex: none; width: 22px; height: 22px; background: var(--warn); color: var(--accent-ink); font: 700 13px/1 var(--mono); }
/* The site lock's status line: slimmer, in orange, while the site is locked */
.alert.lock-line { padding: 6px 8px 6px 14px; background: rgba(255, 90, 31, .06); border-color: rgba(255, 90, 31, .3); border-left-color: var(--accent); font-family: var(--mono); font-size: 13px; font-weight: 400; letter-spacing: .02em; }
.alert.lock-line::before { content: ''; width: 9px; height: 9px; background: var(--accent); }
.alert.lock-line b { font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
.alert.lock-line span span { color: var(--muted); }
/* The ticket site's line: cyan while open, orange while locked */
.alert.tix-line { border-left-color: var(--cyan); border-color: rgba(34, 225, 255, .28); background: rgba(34, 225, 255, .05); }
.alert.tix-line::before { background: var(--cyan); }
.alert.tix-line.locked { border-left-color: var(--accent); border-color: rgba(255, 90, 31, .3); background: rgba(255, 90, 31, .06); }
.alert.tix-line.locked::before { background: var(--accent); }

/* ---------- KPI row: hairline cells with registration ticks ---------- */
.kpis { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); margin-bottom: 18px; }
@media (max-width: 1100px) { .kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 560px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.stat { position: relative; background: var(--surface); padding: 20px 18px 16px; min-width: 0; }
.stat::before { content: ''; position: absolute; top: 8px; left: 8px; width: 7px; height: 7px; border-top: 1px solid var(--line-strong); border-left: 1px solid var(--line-strong); }
.stat .label { display: block; font-family: var(--mono); font-size: 11px; line-height: 1.35; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.stat .value { display: block; font-family: var(--display); font-stretch: 125%; font-weight: 800; font-size: 40px; letter-spacing: -.01em; line-height: 1; margin-top: 12px; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.stat .value.money { font-family: var(--mono); font-stretch: 100%; font-weight: 700; font-size: 18px; line-height: 1.3; letter-spacing: -.01em; margin-top: 14px; }
.stat .sub { display: block; font-size: 12.5px; color: var(--dim); margin-top: 8px; }
@media (max-width: 560px) { .stat .value { font-size: 34px; } .stat .value.money { font-size: 16px; } .stat { padding: 18px 14px 14px; } }

/* ---------- Cards ---------- */
.split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; margin-bottom: 32px; }
@media (max-width: 900px) { .split { grid-template-columns: 1fr; } }
.card { background: var(--surface); border: 1px solid var(--line); padding: 22px; min-width: 0; }
.card h2 { font-family: var(--display); font-stretch: 118%; font-weight: 800; font-size: 19px; line-height: 1.1; letter-spacing: .01em; text-transform: uppercase; margin: 0; }
.card .hint { font-size: 13.5px; color: var(--muted); margin: 8px 0 0; }
.form-block { margin-top: 20px; }
.form-block > span { display: block; font-family: var(--mono); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; }
.field-row { display: flex; gap: 8px; }
.field-row input { flex: 1; min-width: 0; }

input, select, textarea {
  font: 500 14px var(--body); color: var(--text); background: var(--well);
  border: 1px solid var(--line-strong); border-radius: 0; padding: 10px 12px; min-height: 42px; min-width: 0;
  transition: border-color .15s, box-shadow .15s;
}
input:hover, select:hover, textarea:hover { border-color: rgba(236, 235, 230, .42); }
select { padding-right: 36px; cursor: pointer; -webkit-appearance: none; appearance: none; background: var(--well) var(--chev) no-repeat right 12px center / 12px 8px; }
select option { background: var(--surface-2); color: var(--text); }
input::placeholder, textarea::placeholder { color: var(--dim); }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
textarea { resize: vertical; min-height: 84px; width: 100%; line-height: 1.5; }
input[type=checkbox] { width: 18px; height: 18px; min-height: 0; padding: 0; accent-color: var(--accent); }

/* Buttons: square blocks. Safety orange with ink text for the main action; outlines for the rest. */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px; white-space: nowrap;
  min-height: 42px; padding: 0 18px; border-radius: 0; cursor: pointer;
  font-family: var(--display); font-weight: 700; font-stretch: 112%; font-size: 13px; line-height: 1; letter-spacing: .05em; text-transform: uppercase;
  color: var(--accent-ink); background: var(--accent); border: 1px solid var(--accent);
  transition: background .15s, border-color .15s, color .15s;
  text-decoration: none;
}
.btn:hover { background: var(--accent-hi); border-color: var(--accent-hi); }
.btn:active { transform: translateY(1px); }
.btn:disabled { opacity: .5; cursor: progress; transform: none; }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--line-strong); }
.btn.ghost:hover { border-color: var(--text); background: rgba(236, 235, 230, .05); }
.btn.danger { background: transparent; color: var(--bad); border-color: rgba(255, 122, 107, .45); }
.btn.danger:hover { background: rgba(255, 122, 107, .1); border-color: var(--bad); }
.btn.good { background: var(--good); border-color: var(--good); color: var(--accent-ink); }
.btn.good:hover { background: #c9ff70; border-color: #c9ff70; }
.btn.danger-solid { background: var(--bad); border-color: var(--bad); color: var(--accent-ink); }
.btn.danger-solid:hover { background: #ff9286; border-color: #ff9286; }
.btn.small { min-height: 32px; padding: 0 12px; font-size: 11.5px; }

.result { margin-top: 16px; padding: 14px; background: var(--surface-2); border: 1px solid var(--line); border-left: 2px solid var(--cyan); font-size: 13.5px; }
.result .link-row { display: flex; gap: 8px; margin-top: 10px; }
.result code { flex: 1; min-width: 0; font-family: var(--mono); font-size: 12px; color: var(--text); background: var(--well); border: 1px solid var(--line); padding: 8px 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- Package sales (meters) ---------- */
.sales { margin-top: 18px; display: grid; gap: 18px; }
.meter-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.meter-name { font-weight: 700; }
.meter-val { font-family: var(--mono); font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.bar { display: flex; gap: 2px; height: 8px; margin-top: 10px; }
.seg { height: 100%; min-width: 3px; transition: filter .15s; }
.seg.paid { background: var(--good); }
.seg.reserved { background: var(--warn); }
.seg.left { background: rgba(236, 235, 230, .08); flex: 1; }
.seg.paid:hover, .seg.reserved:hover { filter: brightness(1.15); }
.legend { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 8px; font-size: 12.5px; color: var(--muted); }
.legend span { display: inline-flex; align-items: center; gap: 7px; }
.legend i { width: 8px; height: 8px; display: inline-block; }
.legend i.paid { background: var(--good); } .legend i.reserved { background: var(--warn); }
.tip { position: fixed; z-index: 60; pointer-events: none; background: var(--raise); border: 1px solid var(--line-strong); padding: 8px 10px; font-size: 12px; color: var(--muted); box-shadow: 0 12px 30px -10px rgba(0, 0, 0, .8); transform: translate(-50%, calc(-100% - 10px)); }
.tip b { display: block; color: var(--text); font-size: 15px; font-weight: 700; }
.empty { color: var(--muted); font-size: 14px; margin: 0; }

/* ---------- Tabs: underlined on laptops, a grid of cells on phones ---------- */
.tabs { display: flex; gap: 0; border-bottom: 1px solid var(--line); margin-bottom: 16px; max-width: 100%; overflow-x: auto; scrollbar-width: none; }
.tab { position: relative; display: inline-flex; align-items: center; gap: 8px; min-height: 46px; padding: 0 16px; font-family: var(--display); font-stretch: 112%; font-weight: 700; font-size: 12.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); background: transparent; border: 0; border-radius: 0; cursor: pointer; white-space: nowrap; transition: color .15s, background .15s; }
.tab::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: transparent; }
.tab:hover { color: var(--text); background: rgba(236, 235, 230, .03); }
.tab:focus-visible { outline-offset: -2px; }
.tab.on { color: var(--text); }
.tab.on::after { background: var(--accent); }
.count { font-family: var(--mono); font-size: 11px; font-weight: 400; letter-spacing: 0; color: var(--dim); }
.tab.on .count { color: var(--muted); }
@media (max-width: 600px) {
  .tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); overflow: visible; }
  .tab { justify-content: center; min-height: 44px; padding: 0 6px; font-size: 11.5px; background: var(--surface); }
  .tab .count { display: none; }
  .tab.on { background: var(--raise); }
}
.ping { width: 8px; height: 8px; background: var(--warn); }

/* ---------- Panels & tables ---------- */
.panel { background: var(--surface); border: 1px solid var(--line); overflow: hidden; }
.toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; padding: 14px; border-bottom: 1px solid var(--line); }
.toolbar .grow { flex: 1; min-width: 180px; }
.toolbar .spacer { flex: 1; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { position: sticky; top: 0; text-align: left; font-family: var(--mono); font-size: 10.5px; font-weight: 400; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); padding: 11px 14px; background: var(--surface); border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 12px 14px; border-bottom: 1px solid var(--line); vertical-align: middle; }
tbody tr { transition: background .12s; }
tbody tr:hover { background: rgba(236, 235, 230, .025); }
tbody tr:last-child td { border-bottom: 0; }
td.strong { font-weight: 700; }
td.mono, .mono { font-family: var(--mono); font-size: 12px; color: var(--muted); white-space: nowrap; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.actions { text-align: right; white-space: nowrap; }
td.actions .btn + .btn { margin-left: 6px; }
.subtext { display: block; font-size: 12.5px; font-weight: 500; color: var(--muted); margin-top: 4px; max-width: 280px; white-space: normal; }
.subtext.bad { color: var(--bad); }
td.num .subtext { margin-left: auto; }
.empty-row td { text-align: center; color: var(--muted); padding: 40px 14px; }
.subtext .pill { margin-top: 2px; }
td.note { max-width: 260px; white-space: normal; color: var(--muted); font-size: 13.5px; overflow-wrap: anywhere; }
a.ig { color: var(--text); font-weight: 600; text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 3px; overflow-wrap: anywhere; }
a.ig:hover { text-decoration-color: var(--accent); }

/* Status pills: square, outlined, tinted; the dot says the tone, the text stays readable */
.pill { display: inline-flex; align-items: center; gap: 7px; min-height: 22px; padding: 0 8px; border-radius: 0; font-family: var(--mono); font-size: 10.5px; font-weight: 700; letter-spacing: .08em; line-height: 1.3; text-transform: uppercase; white-space: nowrap; border: 1px solid var(--line-strong); color: var(--muted); }
.pill::before { content: ''; flex: none; width: 6px; height: 6px; background: currentColor; }
.pill.good { color: var(--good); background: rgba(182, 255, 59, .07); border-color: rgba(182, 255, 59, .36); }
.pill.warn { color: var(--warn); background: rgba(255, 192, 46, .07); border-color: rgba(255, 192, 46, .36); }
.pill.bad { color: var(--bad); background: rgba(255, 122, 107, .08); border-color: rgba(255, 122, 107, .42); }
.pill.neutral { color: var(--dim); }
.pill.neutral::before { background: transparent; box-shadow: inset 0 0 0 1px currentColor; }

.toggle { display: inline-flex; align-items: center; min-height: 28px; padding: 0 10px; font: 700 11px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; border-radius: 0; cursor: pointer; border: 1px solid var(--line-strong); background: transparent; color: var(--muted); transition: color .15s, border-color .15s, background .15s; }
.toggle:hover { border-color: var(--text); color: var(--text); }
.toggle.on { color: var(--good); border-color: rgba(182, 255, 59, .45); background: rgba(182, 255, 59, .07); }

/* Phones: each table row becomes a block. Labels come from the column headers. */
@media (max-width: 700px) {
  table.cards thead { display: none; }
  table.cards, table.cards tbody, table.cards tr, table.cards td { display: block; width: 100%; }
  table.cards tr { padding: 14px 16px; border-bottom: 1px solid var(--line); }
  table.cards tr:last-child { border-bottom: 0; }
  table.cards td { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 12px; border: 0; padding: 5px 0; text-align: right; }
  table.cards td::before { content: attr(data-label); font-family: var(--mono); font-size: 10.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); text-align: left; }
  table.cards td[data-label=""]::before { content: none; }
  table.cards td.strong { display: block; text-align: left; font-size: 15px; padding: 0 0 6px; overflow-wrap: anywhere; }
  table.cards td.strong::before { content: none; }
  table.cards td.idx { display: none; }
  table.cards td.actions { justify-content: flex-end; padding-top: 10px; }
  table.cards td.actions .btn { flex: 1; max-width: 220px; min-height: 40px; padding: 0 12px; font-size: 12px; }
  table.cards .subtext { flex-basis: 100%; max-width: none; text-align: right; margin-top: 0; }
  table.cards td.strong .subtext { text-align: left; margin-top: 4px; }
  table.cards tr.empty-row td { display: block; text-align: center; }
  table.cards tr.empty-row td::before { content: none; }
  tbody tr:hover { background: transparent; }
}

/* Reset link at the bottom of the page */
.danger-zone { display: flex; align-items: center; justify-content: flex-end; gap: 12px; flex-wrap: wrap; margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--line); font-size: 13px; color: var(--dim); }

/* Create-package form */
.create { padding: 20px; border-bottom: 1px solid var(--line); background: var(--surface-2); }
.create h3 { margin: 0 0 14px; font-family: var(--display); font-stretch: 118%; font-weight: 800; font-size: 15px; line-height: 1.1; letter-spacing: .02em; text-transform: uppercase; }
.create-grid { display: grid; grid-template-columns: 2fr 1fr 110px 1fr; gap: 10px; }
.create-grid textarea, .create-grid #p-sizes { grid-column: 1 / -1; }
.create .hint { font-size: 13.5px; color: var(--muted); margin: 10px 0 0; }
.create .hint a { color: var(--text); text-decoration-color: var(--accent); text-underline-offset: 3px; }
.create .hint a:hover { color: var(--accent-hi); }
.create-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
.check { display: inline-flex; align-items: center; gap: 10px; font-size: 14px; color: var(--text); cursor: pointer; }
@media (max-width: 700px) { .create-grid { grid-template-columns: 1fr 1fr; } .create-grid input:first-child { grid-column: 1 / -1; } }

/* ---------- Dialog: a concrete utility panel with registration marks ---------- */
dialog {
  --text: var(--ink); --muted: var(--ink-2); --dim: #57564f; --line: rgba(20, 20, 22, .16); --line-strong: rgba(20, 20, 22, .42); --well: #f4f3ef;
  width: min(480px, calc(100vw - 32px)); padding: 0; border: 0; border-radius: 0; color: var(--ink);
  background: var(--xh) no-repeat 8px 8px / 18px, var(--xh) no-repeat right 8px bottom 8px / 18px, var(--concrete);
  box-shadow: 0 30px 80px -20px rgba(0, 0, 0, .9);
}
dialog::backdrop { background: rgba(5, 5, 6, .76); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
dialog :focus-visible { outline-color: var(--ink); }
dialog form { padding: 34px 26px 24px; }
dialog h3 { margin: 0; font-family: var(--display); font-stretch: 122%; font-weight: 800; font-size: 24px; line-height: 1.05; letter-spacing: 0; text-transform: uppercase; }
dialog p { margin: 10px 0 0; color: var(--ink-2); font-size: 14.5px; }
dialog input, dialog textarea, dialog select { color: var(--ink); }
dialog input:hover, dialog textarea:hover { border-color: var(--ink); }
dialog input:focus, dialog textarea:focus { border-color: var(--ink); box-shadow: inset 0 0 0 1px var(--ink); }
dialog input::placeholder, dialog textarea::placeholder { color: #6b6a64; }
dialog input[type=checkbox] { accent-color: var(--ink); }
dialog .btn { border-color: var(--ink); }
dialog .btn.ghost { color: var(--ink); border-color: rgba(20, 20, 22, .45); }
dialog .btn.ghost:hover { border-color: var(--ink); background: rgba(20, 20, 22, .06); }
dialog .btn.danger-solid { background: #b3261e; border-color: #b3261e; color: #fff; }
dialog .btn.danger-solid:hover { background: #941c15; border-color: #941c15; }
.dlg-fields { display: grid; gap: 14px; margin-top: 18px; }
.dlg-fields .field span { display: block; font-family: var(--mono); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-2); margin-bottom: 7px; }
.dlg-fields .field input, .dlg-fields .field textarea { width: 100%; }
.dlg-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }

/* ---------- Toast: a concrete slip with an orange edge ---------- */
.toast { position: fixed; left: 50%; bottom: 24px; z-index: 80; transform: translate(-50%, 16px); width: max-content; max-width: calc(100vw - 32px); padding: 13px 18px 13px 16px; border-left: 3px solid var(--accent); background: var(--concrete-2); color: var(--ink); font-size: 14px; font-weight: 600; line-height: 1.4; opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s; box-shadow: 0 20px 50px -10px rgba(0, 0, 0, .8); }
.toast.show { opacity: 1; transform: translate(-50%, 0); }
.toast.bad { border-left-color: #b3261e; background: #ffd9d4; color: #3a0d09; }

@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } .btn:active { transform: none; } }
</style>
</head>
<body>
<header class="top">
  <div class="brand"><svg class="mark" viewBox="0 0 30 18" aria-hidden="true" focusable="false"><path fill="#e4e3df" d="M0 6h30v12H0z"/><path fill="#0a0a0b" d="M18.2 0h5.6l-4.6 18h-5.6z"/><path fill="#ff5a1f" d="M19.6 0h2.8l-4.6 18h-2.8z"/></svg><b>ON D<span>'</span> <i>ROAD</i></b><span class="sub">Command Center</span></div>
  <nav class="top-right">
    <a class="top-link" href="/admin/events">Events</a>
    <a class="top-link" href="/door" target="_blank" rel="noopener">Door scanner</a>
    <a class="top-link" href="/admin/payments">Payment settings</a>
    <a class="top-link" href="/admin/pricing">Prices, codes &amp; promoters</a>
    <a class="top-link" href="/admin/pickup">Sizes &amp; pickup</a>
    <a class="top-link" href="/admin/event">Event &amp; messages</a>
    <a class="top-link" href="/admin/site">Site, contact, terms &amp; FAQ</a>
    <a class="top-link" href="/admin/tickets">Tickets &amp; tables</a>
    <a class="top-link" href="/admin/audit">Audit log</a>
    <a class="top-link owner-only" href="/admin/team">Team</a>
    <a class="top-link" href="/admin/app">App</a>
    <a class="top-link" href="/admin/account" id="nav-account">Your account</a>
    <a class="top-link" href="/admin/login" data-logout>Log out</a>
    <a class="top-link" href="${FRONTEND_URL}" target="_blank" rel="noopener">View site &#8599;</a>
    <span id="clock" class="clock"></span>
  </nav>
</header>

<main class="wrap">
  <div class="page-head">
    <div>
      <a class="evtag" id="ev-tag" href="/admin/events" title="Events"></a>
      <h1>Overview</h1>
      <p id="updated">Loading&hellip;</p>
    </div>
    <button class="btn ghost" id="refresh-btn" type="button">Refresh</button>
  </div>

  <div id="lock-alert" class="alert lock-line hidden" role="status"><span><b>Site is locked</b><span id="lock-alert-when"></span></span><a class="btn small ghost" href="/admin/site">Manage</a></div>
  <div id="tix-line" class="alert lock-line tix-line hidden" role="status"><span><b id="tix-state">Ticket site</b><span id="tix-sold"></span></span><a class="btn small ghost" href="/admin/tickets">Manage</a></div>
  <div id="alert" class="alert hidden"><span id="alert-text"></span><button class="btn small" id="alert-go" type="button">Review</button></div>
  <div id="req-alert" class="alert hidden"><span id="req-alert-text"></span><button class="btn small" id="req-alert-go" type="button">Review</button></div>

  <section class="kpis" id="stats" aria-label="Key numbers"></section>

  <div class="split">
    <section class="card">
      <h2>Add people</h2>
      <p class="hint">Add someone straight to the roster, or create a personal single-use invite link.</p>
      <form class="form-block" id="add-form">
        <span>Add to roster</span>
        <div class="field-row"><input type="email" id="new-email" placeholder="email@example.com" required autocomplete="off"><button class="btn" type="submit">Add</button></div>
      </form>
      <form class="form-block" id="inv-form">
        <span>Create invite link</span>
        <div class="field-row"><input type="email" id="inv-email" placeholder="email@example.com" required autocomplete="off"><button class="btn ghost" type="submit">Create link</button></div>
      </form>
      <div id="msg" class="result hidden"></div>
    </section>

    <section class="card">
      <h2>Package sales</h2>
      <p class="hint">Spots claimed per package. A reservation holds a spot until it's paid or expires.</p>
      <div id="sales" class="sales"></div>
    </section>
  </div>

  <div class="tabs" role="tablist" aria-label="Sections">
    <button class="tab on" id="tab-g" role="tab" aria-selected="true" type="button">Guests <span class="count" id="c-g"></span></button>
    <button class="tab" id="tab-r" role="tab" aria-selected="false" type="button">Requests <span class="count" id="c-r"></span><span class="ping hidden" id="r-ping"></span></button>
    <button class="tab" id="tab-i" role="tab" aria-selected="false" type="button">Invites <span class="count" id="c-i"></span></button>
    <button class="tab" id="tab-p" role="tab" aria-selected="false" type="button">Packages <span class="count" id="c-p"></span></button>
    <button class="tab" id="tab-o" role="tab" aria-selected="false" type="button">Orders <span class="count" id="c-o"></span><span class="ping hidden" id="o-ping"></span></button>
    <button class="tab" id="tab-d" role="tab" aria-selected="false" type="button">Door <span class="count" id="c-d"></span></button>
  </div>

  <section class="panel" id="guests-panel" role="tabpanel">
    <div class="toolbar">
      <input id="search" class="grow" placeholder="Search name, email or Instagram" type="search">
      <select id="filter" aria-label="Attendance filter"><option value="">All attendance</option><option value="CONFIRMED">Confirmed</option><option value="PENDING">Pending</option></select>
      <button class="btn ghost" id="csv-btn" type="button">Export CSV</button>
    </div>
    <div class="scroll"><table class="cards"><thead><tr><th class="num">#</th><th>Guest</th><th>Attendance</th><th>Package</th><th class="num">Invites left</th><th></th></tr></thead><tbody id="roster"></tbody></table></div>
  </section>

  <section class="panel hidden" id="requests-panel" role="tabpanel">
    <div class="toolbar">
      <input id="req-search" class="grow" placeholder="Search name, email or Instagram" type="search">
      <select id="req-filter" aria-label="Request filter"><option value="PENDING">Pending</option><option value="DECLINED">Declined</option></select>
    </div>
    <div class="scroll"><table class="cards"><thead><tr><th>Name</th><th class="num">Age</th><th>Instagram</th><th>Email</th><th>Invited by</th><th>Note</th><th>Applied</th><th></th></tr></thead><tbody id="reqlist"></tbody></table></div>
  </section>

  <section class="panel hidden" id="invites-panel" role="tabpanel">
    <div class="toolbar">
      <input id="inv-search" class="grow" placeholder="Search by email" type="search">
      <select id="inv-filter" aria-label="Invite status filter"><option value="">All statuses</option><option value="PENDING">Pending</option><option value="ACCEPTED">Accepted</option><option value="REVOKED">Revoked</option></select>
    </div>
    <div class="scroll"><table class="cards"><thead><tr><th>Invited</th><th>Invited by</th><th>Status</th><th>Sent</th><th></th></tr></thead><tbody id="invlist"></tbody></table></div>
  </section>

  <section class="panel hidden" id="products-panel" role="tabpanel">
    <form class="create" id="p-form">
      <h3>Create a package</h3>
      <div class="create-grid">
        <input id="p-name" placeholder="Name, e.g. Full Package" required aria-label="Package name">
        <input id="p-price" type="number" step="0.01" min="0" placeholder="Price, e.g. 250.00" required aria-label="Price">
        <select id="p-currency" aria-label="Currency"><option value="XCD">XCD</option><option value="USD">USD</option></select>
        <input id="p-capacity" type="number" min="1" placeholder="Capacity (blank = no limit)" aria-label="Capacity">
        <textarea id="p-includes" placeholder="What's included, one item per line" aria-label="What's included"></textarea>
        <input id="p-sizes" placeholder="Sizes guests choose from, e.g. S, M, L, XL (leave blank if no size is needed)" aria-label="Sizes">
        <textarea id="p-paynote" maxlength="1000" placeholder="Cash payment details for this package (optional). Shown under the general payment instructions, e.g. who to pay and where." aria-label="Cash payment details for this package (optional)"></textarea>
      </div>
      <p class="hint">Want early bird pricing or promo codes? Create the package, then set them up in <a href="/admin/pricing">Prices, codes &amp; promoters</a>.</p>
      <div class="create-foot">
        <label class="check"><input type="checkbox" id="p-compliance" checked> Requires costume compliance</label>
        <button class="btn" type="submit">Create package</button>
      </div>
    </form>
    <div class="scroll"><table class="cards"><thead><tr><th>Package</th><th class="num">Price</th><th class="num">Claimed</th><th>Visibility</th><th></th></tr></thead><tbody id="productlist"></tbody></table></div>
  </section>

  <section class="panel hidden" id="orders-panel" role="tabpanel">
    <div class="toolbar">
      <select id="order-event" class="hidden" aria-label="Event"></select>
      <input id="order-search" class="grow" placeholder="Search name, email or reference" type="search">
      <select id="order-filter" aria-label="Order status filter"><option value="">All orders</option><option value="REFUND">Refund requests</option><option value="RESERVED">Awaiting payment</option><option value="PAID">Paid</option><option value="COMP">Free passes</option><option value="COLLECTED">Package collected</option><option value="UNCOLLECTED">Paid, not collected</option><option value="CHECKED">Checked in</option><option value="CANCELLED">Cancelled</option></select>
      <button class="btn ghost" id="orders-csv-btn" type="button">Export orders CSV</button>
    </div>
    <p id="order-past" class="past-note hidden" role="status"></p>
    <div class="scroll"><table class="cards"><thead><tr><th>Guest</th><th>Package</th><th class="num">Amount</th><th>Status</th><th>Reference</th><th>Reserved</th><th></th></tr></thead><tbody id="orderlist"></tbody></table></div>
  </section>
  <section class="panel hidden" id="door-panel" role="tabpanel">
    <div class="toolbar">
      <select id="door-source" class="hidden" aria-label="Door of"></select>
      <input id="door-search" class="grow" placeholder="Search email or reference" type="search">
      <select id="door-filter" aria-label="Door event filter"><option value="">All door activity</option><option value="ENTRY">Entries</option><option value="OVERRIDE">Overrides</option><option value="DUPLICATE">Blocked repeat scans</option><option value="UNDO">Undone</option><option value="PICKUP">Packages collected</option><option value="PICKUP_DUP">Blocked repeat pickups</option><option value="PICKUP_UNDO">Pickups undone</option></select>
      <a class="btn ghost" href="/door" target="_blank" rel="noopener">Open scanner</a>
    </div>
    <div class="scroll"><table class="cards"><thead><tr><th>Guest</th><th>Event</th><th>Package</th><th>Time</th><th>Phone</th><th>Reference</th></tr></thead><tbody id="doorlist"></tbody></table></div>
  </section>

  <footer class="danger-zone owner-only">
    <span>Starting over after testing?</span>
    <a class="btn small danger" id="reset-link" href="/admin/reset">Reset data&hellip;</a>
  </footer>
</main>

<dialog id="dlg" aria-labelledby="dlg-title">
  <form id="dlg-form">
    <h3 id="dlg-title"></h3>
    <p id="dlg-text"></p>
    <div id="dlg-fields" class="dlg-fields"></div>
    <div class="dlg-actions">
      <button class="btn ghost" type="button" id="dlg-cancel">Cancel</button>
      <button class="btn" type="submit" id="dlg-ok">Confirm</button>
    </div>
  </form>
</dialog>
<div id="tip" class="tip hidden" role="tooltip"></div>
<div id="toast" class="toast" role="status" aria-live="polite"></div>

<script>
const $ = (id) => document.getElementById(id);
const NL = String.fromCharCode(10);
let guests = [], invites = [], products = [], orders = [], checkins = [];
// Events (for the event tag and the Orders tab's event picker), and the orders the Orders tab shows: the current
// event's, or a past event's (read-only) picked in #order-event.
let events = { current: null, past: [] }, viewOrders = null, viewEvent = '';
let guestByEmail = new Map();

async function api(path, body) {
  const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined;
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
  return data;
}
function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = text; if (cls) e.className = cls; return e; }
function td(tr, text, cls) { const c = el('td', text, cls); tr.appendChild(c); return c; }
function pill(text, tone) { return el('span', text, 'pill ' + (tone || 'neutral')); }
function money(cents, cur) { return (cur || 'XCD') + ' ' + (Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function shortDate(iso) { return iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Antigua' }) : ''; }
function timeOf(iso) { return iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Antigua' }) : ''; }
function longDate(iso) { return iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Antigua' }) : ''; }
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
function emptyRow(tbody, cols, text) { const tr = el('tr', undefined, 'empty-row'); const c = td(tr, text); c.colSpan = cols; tbody.appendChild(tr); c.setAttribute('data-label', ''); }

let toastTimer;
function toast(text, bad) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast' + (bad ? ' bad' : ''); }, 4000);
}

// Styled replacement for confirm()/prompt(). Resolves to the field values, or null if cancelled.
function ask(o) {
  return new Promise((resolve) => {
    const dlg = $('dlg'), form = $('dlg-form'), box = $('dlg-fields');
    $('dlg-title').textContent = o.title;
    $('dlg-text').textContent = o.text || '';
    $('dlg-text').classList.toggle('hidden', !o.text);
    box.replaceChildren();
    box.classList.toggle('hidden', !(o.fields && o.fields.length));
    const inputs = {};
    (o.fields || []).forEach((f) => {
      let input;
      if (f.type === 'checkbox') {
        const wrap = el('label', undefined, 'check');
        input = el('input'); input.type = 'checkbox'; input.checked = !!f.value;
        wrap.appendChild(input); wrap.appendChild(el('span', f.label));
        box.appendChild(wrap);
      } else {
        const wrap = el('label', undefined, 'field');
        wrap.appendChild(el('span', f.label));
        input = el(f.type === 'textarea' ? 'textarea' : 'input');
        if (f.type !== 'textarea') input.type = f.type || 'text';
        if (f.step) input.step = f.step;
        if (f.min !== undefined) input.min = f.min;
        if (f.max !== undefined) input.max = f.max;
        if (f.placeholder) input.placeholder = f.placeholder;
        if (f.required) input.required = true;
        input.value = f.value === null || f.value === undefined ? '' : f.value;
        wrap.appendChild(input);
        box.appendChild(wrap);
      }
      inputs[f.name] = input;
    });
    const ok = $('dlg-ok');
    ok.textContent = o.ok || 'Confirm';
    ok.className = 'btn' + (o.danger ? ' danger-solid' : '');
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      form.onsubmit = null; $('dlg-cancel').onclick = null; dlg.onclose = null;
      if (dlg.open) dlg.close();
      resolve(val);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const vals = {};
      Object.keys(inputs).forEach((k) => { const i = inputs[k]; vals[k] = i.type === 'checkbox' ? i.checked : i.value; });
      finish(vals);
    };
    $('dlg-cancel').onclick = () => finish(null);
    dlg.onclose = () => finish(null);
    dlg.showModal();
    const first = box.querySelector('input:not([type=checkbox]), textarea');
    (first || ok).focus();
    if (first && first.select) first.select();
  });
}

// Button that runs an action, then reloads everything. fn returns false when the user backs out.
function actionBtn(label, cls, fn) {
  const b = el('button', label, 'btn small ' + (cls || ''));
  b.type = 'button';
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const result = await fn();
      if (result === false) return;
      await refresh();
      if (typeof result === 'string') toast(result);
    } catch (e) { toast(e.message, true); }
    finally { b.disabled = false; }
  });
  return b;
}

// ---------- Search ----------
// Lowercase, without accents or apostrophes, so "zoe oneil" finds "Zoë O'Neil". Built without regexes: this script
// sits inside a template literal on the server, which would eat their backslashes.
const MARKS = [768, 879]; // combining accents, U+0300 to U+036F, left over once letters are decomposed
const APOSTROPHES = "'" + String.fromCharCode(8216, 8217, 700, 96, 180);
const FOLD = {};
[[248, 'o'], [216, 'o'], [322, 'l'], [321, 'l'], [223, 'ss'], [230, 'ae'], [198, 'ae'], [339, 'oe'], [338, 'oe'], [273, 'd'], [272, 'd'], [240, 'd'], [208, 'd'], [254, 'th'], [222, 'th'], [305, 'i']]
  .forEach((p) => { FOLD[String.fromCharCode(p[0])] = p[1]; });
function fold(v) {
  return Array.from(String(v === null || v === undefined ? '' : v).normalize('NFD'))
    .filter((c) => { const n = c.charCodeAt(0); return (n < MARKS[0] || n > MARKS[1]) && !APOSTROPHES.includes(c); })
    .map((c) => FOLD[c] || c).join('').toLowerCase();
}
// Every word typed must appear somewhere in the fields, in any order.
function matches(q, fields) {
  const words = fold(q).split(' ').filter(Boolean);
  if (!words.length) return true;
  const hay = fold(fields.join(' '));
  return words.every((w) => hay.includes(w));
}
const nameOf = (email) => { const g = guestByEmail.get(String(email).toLowerCase()); return (g && g.full_name) || ''; };

// ---------- Derived data ----------
const isRefundRequest = (o) => o.status === 'PAID' && !!o.cancel_requested_at;
const amountOf = (o) => Number(o.amount_cents ?? o.price_cents);
const isFree = (o) => o.paid_via === 'COMP' || amountOf(o) === 0; // nothing was paid, so nothing to refund
function latestOrderFor(email) {
  const e = String(email).toLowerCase();
  return orders.find((o) => String(o.guest_email).toLowerCase() === e && o.status !== 'CANCELLED') || null;
}
function totals(list) {
  const t = {};
  list.forEach((o) => { const c = o.currency || 'XCD'; t[c] = (t[c] || 0) + amountOf(o); });
  const keys = Object.keys(t);
  return keys.length ? keys.map((c) => money(t[c], c)).join(' + ') : money(0, 'XCD');
}
// Sign-up approval: pending and declined requests get a pill; approved guests don't.
function approvalPill(g) {
  if (g.approval === 'PENDING') return pill('Pending approval', 'warn');
  if (g.approval === 'DECLINED') return pill('Declined', 'bad');
  return null;
}
// Who invited them, for the admin: the admin's own invites are "You", a promoter's "Promoter <name>".
function invitedBy(g) { return !g.invited_by ? '' : g.invited_by === 'CONTROL' ? 'You' : g.invited_by === 'PROMOTER' ? 'Promoter ' + (g.invited_by_name || '') : (g.invited_by_name || g.invited_by); }
function igLink(handle) {
  const a = el('a', '@' + handle, 'ig');
  a.href = 'https://instagram.com/' + encodeURIComponent(handle);
  a.target = '_blank'; a.rel = 'noopener noreferrer';
  return a;
}
const hasPaid = (email) => orders.some((o) => String(o.guest_email).toLowerCase() === String(email).toLowerCase() && o.status === 'PAID');
const profileMissing = (g) => !g.full_name || !g.birth_date || !g.instagram;
async function approve(g) {
  const who = g.full_name || g.email;
  const v = await ask({ title: 'Approve ' + who + '?', text: (g.approval === 'DECLINED' ? 'You declined them before. ' : '') + "They get an email saying they're in, and can pick a package.", ok: 'Approve' });
  if (!v) return false;
  const r = await api('/api/admin/guests/approve', { email: g.email });
  return r.already ? who + ' was already approved.' : r.emailed ? 'Approved. ' + who + ' has been emailed.' : 'Approved, but the email failed to send.';
}

function orderPill(o) {
  if (!o) return pill('None', 'neutral');
  if (isRefundRequest(o)) return pill(isFree(o) ? 'Cancel requested' : 'Refund requested', 'warn');
  if (o.status === 'PAID') return o.paid_via === 'COMP' ? pill('Free pass', 'good') : pill('Paid', 'good');
  if (o.status === 'RESERVED') return pill('Awaiting payment', 'warn');
  if (o.status === 'CANCELLED' && o.refunded_at) return isFree(o) ? pill('Pass cancelled', 'neutral') : pill('Refunded', 'bad');
  return pill('Cancelled', 'neutral');
}

// ---------- Render ----------
function renderStats() {
  const paid = orders.filter((o) => o.status === 'PAID');
  const reserved = orders.filter((o) => o.status === 'RESERVED');
  const confirmed = guests.filter((g) => g.rsvp_status === 'CONFIRMED').length;
  const pending = invites.filter((i) => i.status === 'PENDING').length;
  const accepted = invites.filter((i) => i.status === 'ACCEPTED').length;
  const unused = guests.reduce((a, g) => a + (Number(g.invites_left) || 0), 0);
  const items = [
    { label: 'Guests', value: guests.length.toLocaleString('en-US'), sub: confirmed + ' confirmed attendance' },
    { label: 'Paid orders', value: paid.length.toLocaleString('en-US'), sub: plural(orders.length, 'order', 'orders') + ' in total' },
    { label: 'Received', value: totals(paid), sub: 'From paid orders', money: true },
    { label: 'Awaiting payment', value: reserved.length.toLocaleString('en-US'), sub: reserved.length ? totals(reserved) + ' outstanding' : 'Nothing outstanding' },
    { label: 'Invites pending', value: pending.toLocaleString('en-US'), sub: accepted + ' accepted · ' + unused + ' unused' },
    { label: 'Checked in', value: paid.filter((o) => o.checked_in_at).length.toLocaleString('en-US'), sub: 'of ' + paid.length + ' paid at the door' }
  ];
  const box = $('stats'); box.replaceChildren();
  items.forEach((it) => {
    const d = el('div', undefined, 'stat');
    d.appendChild(el('span', it.label, 'label'));
    d.appendChild(el('span', it.value, 'value' + (it.money ? ' money' : '')));
    d.appendChild(el('span', it.sub, 'sub'));
    box.appendChild(d);
  });

  const refunds = orders.filter(isRefundRequest).length;
  $('alert').classList.toggle('hidden', !refunds);
  $('alert-text').textContent = plural(refunds, 'refund request is', 'refund requests are') + ' waiting for your approval.';
  const waiting = guests.filter((g) => g.approval === 'PENDING').length;
  $('req-alert').classList.toggle('hidden', !waiting);
  $('req-alert-text').textContent = plural(waiting, 'person', 'people') + ' waiting for approval';
}

function showTip(e, value, label) {
  const t = $('tip');
  t.replaceChildren(el('b', value), el('span', label));
  t.classList.remove('hidden');
  t.style.left = e.clientX + 'px';
  t.style.top = e.clientY + 'px';
}
function hideTip() { $('tip').classList.add('hidden'); }

function renderSales() {
  const box = $('sales'); box.replaceChildren();
  const list = products.filter((p) => p.active || Number(p.claimed) > 0);
  if (!list.length) { box.appendChild(el('p', 'No packages yet. Create one in the Packages tab.', 'empty')); return; }
  list.forEach((p) => {
    const paidN = orders.filter((o) => o.package_id === p.id && o.status === 'PAID').length;
    const resN = orders.filter((o) => o.package_id === p.id && o.status === 'RESERVED').length;
    const claimed = paidN + resN;
    const cap = p.capacity === null || p.capacity === undefined ? null : Number(p.capacity);
    const row = el('div', undefined, 'meter');
    const head = el('div', undefined, 'meter-head');
    head.appendChild(el('span', p.name + (p.active ? '' : ' (hidden)'), 'meter-name'));
    head.appendChild(el('span', cap !== null ? claimed + ' of ' + cap + ' claimed' : claimed + ' claimed · no limit', 'meter-val'));
    row.appendChild(head);

    const bar = el('div', undefined, 'bar');
    const denom = cap !== null ? Math.max(cap, claimed, 1) : Math.max(claimed, 1);
    const segs = [];
    if (paidN) segs.push(['paid', paidN, 'Paid']);
    if (resN) segs.push(['reserved', resN, 'Awaiting payment']);
    segs.forEach((s, i) => {
      const seg = el('i', undefined, 'seg ' + s[0] + (i === segs.length - 1 ? ' end' : ''));
      seg.style.width = (s[1] / denom * 100) + '%';
      seg.addEventListener('pointermove', (e) => showTip(e, String(s[1]), s[2]));
      seg.addEventListener('pointerleave', hideTip);
      bar.appendChild(seg);
    });
    if (cap !== null && claimed < cap) bar.appendChild(el('i', undefined, 'seg left end'));
    if (!segs.length && cap === null) bar.appendChild(el('i', undefined, 'seg left end'));
    row.appendChild(bar);

    const legend = el('div', undefined, 'legend');
    const key = (cls, text) => { const s = el('span'); s.appendChild(el('i', undefined, cls)); s.appendChild(document.createTextNode(text)); return s; };
    legend.appendChild(key('paid', paidN + ' paid'));
    legend.appendChild(key('reserved', resN + ' awaiting payment'));
    if (cap !== null) legend.appendChild(el('span', Math.max(cap - claimed, 0) + ' left'));
    row.appendChild(legend);
    box.appendChild(row);
  });
}

function renderGuests() {
  const q = $('search').value.trim(), f = $('filter').value;
  const tbody = $('roster'); tbody.replaceChildren();
  const list = guests.filter((g) => matches(q, [g.full_name, g.email, g.instagram]) && (!f || (g.rsvp_status || 'PENDING') === f));
  if (!list.length) return emptyRow(tbody, 6, guests.length ? 'No guests match.' : 'No guests yet. Add someone above.');
  list.forEach((g, i) => {
    const tr = el('tr');
    td(tr, i + 1, 'num mono idx');
    // The name as on their ID, the email under it, then their profile and a Pending/Declined pill.
    const who = td(tr, g.full_name || g.email, 'strong');
    if (g.full_name) who.appendChild(el('span', g.email, 'subtext'));
    const facts = [];
    if (g.age !== null && g.age !== undefined) facts.push('Age ' + g.age);
    if (g.instagram) facts.push('@' + g.instagram);
    if (facts.length) who.appendChild(el('span', facts.join(' · '), 'subtext'));
    else if (profileMissing(g)) who.appendChild(el('span', 'Profile not filled in yet', 'subtext'));
    const ap = approvalPill(g);
    if (ap) { const w = el('span', undefined, 'subtext'); w.appendChild(ap); who.appendChild(w); }
    td(tr, '').appendChild(g.rsvp_status === 'CONFIRMED' ? pill('Confirmed', 'good') : pill('Pending', 'neutral'));
    td(tr, '').appendChild(orderPill(latestOrderFor(g.email)));
    td(tr, g.invites_left, 'num');
    const act = td(tr, '', 'actions');
    if (g.approval === 'PENDING' || g.approval === 'DECLINED') act.appendChild(actionBtn('Approve', 'good', () => approve(g)));
    act.appendChild(actionBtn('Edit profile', 'ghost', async () => {
      const paidNote = hasPaid(g.email) ? ' They have paid, so only you can change their name and date of birth now.' : '';
      const v = await ask({ title: 'Edit profile', text: g.email + '.' + paidNote + ' An empty field is cleared.', ok: 'Save profile', fields: [
        { name: 'full_name', label: 'Full name (as on their ID)', value: g.full_name || '' },
        { name: 'birth_date', label: 'Date of birth', type: 'date', value: g.birth_date || '', min: '1900-01-01' },
        { name: 'instagram', label: 'Instagram', value: g.instagram ? '@' + g.instagram : '', placeholder: '@handle' }
      ] });
      if (!v) return false;
      await api('/api/admin/guests/profile', { email: g.email, full_name: v.full_name, birth_date: v.birth_date, instagram: v.instagram });
      return 'Profile saved.';
    }));
    act.appendChild(actionBtn('Set invites', 'ghost', async () => {
      const ev = events.current;
      const v = await ask({ title: 'Set invites', text: 'How many invites ' + g.email + ' can still send for ' + (ev ? ev.name : 'this event') + '.' +
        (ev ? ' Everyone gets ' + plural(ev.invites_per_guest, 'invite', 'invites') + ' for it, and they have sent ' + (Number(g.invites_sent) || 0) + '.' : ''),
        ok: 'Save', fields: [{ name: 'count', label: 'Invites left (0 to 20)', type: 'number', min: 0, max: 20, value: g.invites_left, required: true }] });
      if (!v) return false;
      await api('/api/admin/set-invites', { email: g.email, count: v.count });
      return 'Invites updated.';
    }));
    act.appendChild(actionBtn('Remove', 'danger', async () => {
      const v = await ask({ title: 'Remove guest?', text: g.email + ' will be taken off the roster and can no longer log in. An unpaid reservation is cancelled. A paid order must be refunded first.', ok: 'Remove', danger: true });
      if (!v) return false;
      const r = await api('/api/admin/remove-guest', { email: g.email });
      return r.cancelled ? 'Guest removed and their reservation cancelled.' : 'Guest removed.';
    }));
    tbody.appendChild(tr);
  });
  labelCells(tbody);
}

// Sign-up requests: people who accepted an invite and are waiting for approval, or were declined.
function renderRequests() {
  const f = $('req-filter').value || 'PENDING', q = $('req-search').value.trim();
  const tbody = $('reqlist'); tbody.replaceChildren();
  const all = guests.filter((g) => g.approval === f);
  // Oldest first, so whoever has waited longest is at the top.
  const list = all.filter((g) => matches(q, [g.full_name, g.email, g.instagram]))
    .sort((a, b) => String(a.applied_at || '').localeCompare(String(b.applied_at || '')) || a.id - b.id);
  if (!list.length) return emptyRow(tbody, 8, all.length ? 'No requests match.' : f === 'PENDING' ? 'Nobody is waiting for approval.' : 'No declined requests.');
  list.forEach((g) => {
    const tr = el('tr');
    const name = td(tr, g.full_name || g.email, 'strong');
    if (!g.full_name) name.appendChild(el('span', 'No name given', 'subtext'));
    td(tr, g.age === null || g.age === undefined ? '' : g.age, 'num');
    const ig = td(tr, '');
    if (g.instagram) ig.appendChild(igLink(g.instagram));
    td(tr, g.email);
    const by = td(tr, invitedBy(g));
    if (g.invited_by && g.invited_by !== 'CONTROL' && g.invited_by !== 'PROMOTER' && g.invited_by_name) by.appendChild(el('span', g.invited_by, 'subtext'));
    td(tr, g.invite_note || '', 'note');
    const when = td(tr, shortDate(g.applied_at), 'mono'); when.title = longDate(g.applied_at);
    if (g.approval === 'DECLINED' && g.decided_at) when.appendChild(el('span', 'Declined ' + shortDate(g.decided_at), 'subtext'));
    const act = td(tr, '', 'actions');
    act.appendChild(actionBtn('Approve', 'good', () => approve(g)));
    if (g.approval === 'PENDING') act.appendChild(actionBtn('Decline', 'danger', async () => {
      const who = g.full_name || g.email;
      const inviter = g.invited_by === 'CONTROL' ? 'you' : g.invited_by === 'PROMOTER' ? 'promoter ' + (g.invited_by_name || '') : (g.invited_by_name || g.invited_by || 'whoever invited them');
      const v = await ask({ title: 'Decline ' + who + '?', text: "They won't get an email. Their invite stays used, and " + inviter + " doesn't get it back. You can still approve them later from Declined.", ok: 'Decline', danger: true });
      if (!v) return false;
      await api('/api/admin/guests/decline', { email: g.email });
      return 'Request declined.';
    }));
    tbody.appendChild(tr);
  });
  labelCells(tbody);
}

function renderInvites() {
  const q = $('inv-search').value.trim().toLowerCase(), f = $('inv-filter').value;
  const tbody = $('invlist'); tbody.replaceChildren();
  const list = invites.filter((v) => (!f || v.status === f) && (String(v.invitee_email).toLowerCase().includes(q) || String(v.inviter_email).toLowerCase().includes(q) || String(v.promoter_name || '').toLowerCase().includes(q)));
  if (!list.length) return emptyRow(tbody, 5, invites.length ? 'No invites match.' : 'No invites sent yet.');
  list.forEach((v) => {
    const tr = el('tr');
    td(tr, v.invitee_email, 'strong');
    const from = td(tr, v.inviter_email === 'CONTROL' ? "On D' Road" : v.inviter_email === 'PROMOTER' ? 'Promoter ' + (v.promoter_name || '') : v.inviter_email);
    if (v.current_event === false) from.appendChild(el('span', 'From ' + (v.event_name || 'a past event'), 'subtext'));
    td(tr, '').appendChild(v.status === 'ACCEPTED' ? pill('Accepted', 'good') : v.status === 'PENDING' ? pill('Pending', 'warn') : pill(v.status === 'REVOKED' ? 'Revoked' : v.status, 'neutral'));
    const sent = td(tr, shortDate(v.created_at), 'mono'); sent.title = longDate(v.created_at);
    const act = td(tr, '', 'actions');
    if (v.status === 'PENDING') act.appendChild(actionBtn('Revoke', 'danger', async () => {
      const ok = await ask({ title: 'Revoke this invite?', text: 'The link sent to ' + v.invitee_email + ' will stop working.', ok: 'Revoke', danger: true });
      if (!ok) return false;
      await api('/api/admin/revoke-invite', { id: v.id });
      return 'Invite revoked.';
    }));
    tbody.appendChild(tr);
  });
  labelCells(tbody);
}

function renderProducts() {
  const tbody = $('productlist'); tbody.replaceChildren();
  if (!products.length) return emptyRow(tbody, 5, 'No packages yet. Create your first one above.');
  products.forEach((p) => {
    const tr = el('tr');
    const name = td(tr, p.name, 'strong');
    const lines = String(p.includes || '').split(NL).map((s) => s.trim()).filter(Boolean);
    const meta = [];
    if (lines.length) meta.push(plural(lines.length, 'item', 'items') + ' included');
    if (p.requires_compliance) meta.push('Costume compliance');
    if (p.sizes) meta.push('Sizes: ' + p.sizes);
    if (p.pay_note) meta.push('Own cash payment details');
    if (meta.length) name.appendChild(el('span', meta.join(' · '), 'subtext'));
    // How many active orders picked each size, in the package's own size order.
    const counts = p.size_counts || {};
    const order = String(p.sizes || '').split(',').map((s) => s.trim()).filter(Boolean);
    Object.keys(counts).forEach((k) => { if (order.indexOf(k) < 0) order.push(k); });
    const picked = order.filter((k) => counts[k]).map((k) => k + ' ' + counts[k]);
    if (picked.length) name.appendChild(el('span', 'Ordered: ' + picked.join(' · '), 'subtext'));
    // With price tiers, the price now is the tier on sale (see Prices & codes).
    const tiers = p.tiers || [];
    const price = td(tr, p.sales_closed ? 'Closed' : money(p.price_now ?? p.price_cents, p.currency), 'num');
    if (tiers.length) {
      const i = tiers.findIndex((t) => t.state === 'CURRENT');
      const next = i < 0 ? null : tiers.slice(i + 1).find((t) => t.state === 'UPCOMING');
      price.appendChild(el('span', p.sales_closed || i < 0 ? 'Sales closed: every tier has ended or sold out'
        : tiers[i].name + ' now' + (next ? ' · then ' + next.name + ' ' + money(next.price_cents, p.currency) : ''), 'subtext' + (p.sales_closed ? ' bad' : '')));
    }
    td(tr, p.claimed + (p.capacity !== null && p.capacity !== undefined ? ' / ' + p.capacity : ''), 'num');
    const vis = td(tr, '');
    const t = el('button', p.active ? 'Visible' : 'Hidden', 'toggle' + (p.active ? ' on' : ''));
    t.type = 'button';
    t.title = p.active ? 'Guests can see and reserve this package. Click to hide it.' : 'Hidden from guests. Click to show it.';
    t.addEventListener('click', async () => {
      t.disabled = true;
      try { await api('/api/admin/packages/' + p.id, { active: !p.active }); await refresh(); toast(p.active ? 'Package hidden.' : 'Package visible.'); }
      catch (e) { toast(e.message, true); } finally { t.disabled = false; }
    });
    vis.appendChild(t);
    const act = td(tr, '', 'actions');
    const prices = el('a', 'Prices', 'btn small ghost');
    prices.href = '/admin/pricing#p' + p.id;
    prices.title = 'Price tiers and promo codes for this package';
    act.appendChild(prices);
    act.appendChild(actionBtn('Edit', 'ghost', async () => {
      const v = await ask({ title: 'Edit package', ok: 'Save changes', fields: [
        { name: 'name', label: 'Name', value: p.name, required: true },
        { name: 'price', label: 'Price (' + (p.currency || 'XCD') + ')' + (tiers.length ? ', not used while it has tiers' : ''), type: 'number', step: '0.01', min: 0, value: (p.price_cents / 100).toFixed(2), required: true },
        { name: 'capacity', label: 'Capacity (blank = no limit)', type: 'number', min: 1, value: p.capacity },
        { name: 'includes', label: "What's included (one per line)", type: 'textarea', value: p.includes },
        { name: 'sizes', label: 'Sizes (comma-separated, blank = no size)', value: p.sizes, placeholder: 'S, M, L, XL' },
        { name: 'pay_note', label: 'Cash payment details for this package (optional)', type: 'textarea', value: p.pay_note, placeholder: 'Shown under the general payment instructions' },
        { name: 'requires_compliance', label: 'Requires costume compliance', type: 'checkbox', value: p.requires_compliance }
      ] });
      if (!v) return false;
      const price = parseFloat(v.price);
      if (!v.name.trim() || !(price >= 0)) throw new Error('Name and a valid price are required.');
      await api('/api/admin/packages/' + p.id, { name: v.name, price_cents: Math.round(price * 100), capacity: v.capacity, includes: v.includes, sizes: v.sizes, pay_note: v.pay_note, requires_compliance: v.requires_compliance });
      return 'Package saved.';
    }));
    act.appendChild(actionBtn('Delete', 'danger', async () => {
      const used = Number(p.claimed) > 0;
      const v = await ask({ title: 'Delete ' + p.name + '?', text: used ? 'It has orders, so it will be hidden and kept for your records instead of deleted.' : 'This removes the package for good.', ok: used ? 'Hide package' : 'Delete', danger: true });
      if (!v) return false;
      const r = await api('/api/admin/packages/' + p.id + '/delete', {});
      return r.retired ? 'Package hidden (it has orders).' : 'Package deleted.';
    }));
    tbody.appendChild(tr);
  });
  labelCells(tbody);
}

// Order filters beyond a plain status match.
const ORDER_FILTERS = {
  REFUND: isRefundRequest,
  CHECKED: (o) => !!o.checked_in_at,
  COMP: (o) => o.paid_via === 'COMP',
  COLLECTED: (o) => !!o.picked_up_at,
  UNCOLLECTED: (o) => o.status === 'PAID' && !o.picked_up_at
};
// The event picker above the orders: the current event, then past ones (shown only once there are past events).
function renderEventPicker() {
  const sel = $('order-event');
  sel.classList.toggle('hidden', !events.past.length);
  sel.replaceChildren();
  const add = (v, t) => { const o = el('option', t); o.value = v; sel.appendChild(o); };
  if (events.current) add('', events.current.name + ' (current)');
  events.past.forEach((e) => add(String(e.id), e.name + ' (past)'));
  sel.value = viewEvent;
  if (sel.value !== viewEvent) { viewEvent = ''; viewOrders = null; sel.value = ''; }
  $('ev-tag').textContent = events.current ? events.current.name : '';
}
async function pickEvent(v) {
  viewEvent = v || '';
  viewOrders = viewEvent ? await api('/api/admin/orders?event=' + encodeURIComponent(viewEvent)) : null;
  renderOrders();
}
function renderOrders() {
  const f = $('order-filter').value, q = $('order-search').value.trim();
  const tbody = $('orderlist'); tbody.replaceChildren();
  // A past event's orders are read-only: its passes are history.
  const all = viewOrders || orders, past = !!viewOrders;
  const pastEv = past ? events.past.find((e) => String(e.id) === viewEvent) : null;
  $('order-past').classList.toggle('hidden', !past);
  $('order-past').textContent = past ? (pastEv ? pastEv.name : 'A past event') + ' is over: its orders are read-only. Its passes no longer open the door.' : '';
  const list = all.filter((o) => (!f || (ORDER_FILTERS[f] ? ORDER_FILTERS[f](o) : o.status === f)) &&
    matches(q, [nameOf(o.guest_email), o.guest_email, o.reference_code]));
  if (!list.length) return emptyRow(tbody, 7, all.length ? 'No orders match.' : 'No orders yet.');
  list.forEach((o) => {
    const tr = el('tr');
    const name = nameOf(o.guest_email);
    const who = td(tr, name || o.guest_email, 'strong');
    if (name) who.appendChild(el('span', o.guest_email, 'subtext'));
    const pk = td(tr, o.package_name);
    if (o.size) pk.appendChild(el('span', 'Size ' + o.size, 'subtext'));
    // What this guest owes or paid: the tier price at reservation, less any code.
    const amt = td(tr, money(amountOf(o), o.currency), 'num');
    if (o.tier_name) amt.appendChild(el('span', o.tier_name + ' price', 'subtext'));
    if (o.paid_via === 'COMP') amt.appendChild(el('span', 'Free pass' + (o.promo_code ? ' (code ' + o.promo_code + ')' : ''), 'subtext'));
    else if (o.promo_code) amt.appendChild(el('span', 'Code ' + o.promo_code + (Number(o.discount_cents) > 0 ? ': ' + money(o.discount_cents, o.currency) + ' off' : ''), 'subtext'));
    const st = td(tr, '');
    st.appendChild(orderPill(o));
    const ppNote = { CREATED: 'PayPal checkout started', PENDING: 'PayPal is still processing the payment', AMOUNT_MISMATCH: "PayPal amount didn't match. Check PayPal." }[o.paypal_status];
    if (o.status === 'RESERVED' && ppNote) st.appendChild(el('span', ppNote, 'subtext'));
    if (o.removed_guest && o.status !== 'CANCELLED') st.appendChild(el('span', 'Guest was removed from the roster', 'subtext bad'));
    if (o.status === 'CANCELLED' && o.refunded_at && o.paid_via === 'PAYPAL') st.appendChild(el('span', 'Refunded through PayPal', 'subtext'));
    if (isRefundRequest(o)) {
      st.appendChild(el('span', 'Requested ' + shortDate(o.cancel_requested_at) + (o.cancel_reason ? ': ' + o.cancel_reason : ''), 'subtext'));
    } else if (o.status === 'PAID' && o.paid_at && !o.checked_in_at) {
      st.appendChild(el('span', o.paid_via === 'COMP' ? 'Confirmed ' + shortDate(o.paid_at)
        : 'Paid ' + (o.paid_via === 'PAYPAL' ? 'with PayPal (USD ' + o.paypal_amount + ') ' : '') + shortDate(o.paid_at), 'subtext'));
    }
    if (o.marked_paid_by && (o.status === 'PAID' || o.refunded_at)) st.appendChild(el('span', 'Marked paid by ' + o.marked_paid_by, 'subtext marked-by'));
    if (o.picked_up_at) st.appendChild(el('span', 'Package collected ' + timeOf(o.picked_up_at) + (o.picked_up_by ? ' · ' + o.picked_up_by : ''), 'subtext'));
    if (o.checked_in_at) st.appendChild(el('span', 'Checked in ' + timeOf(o.checked_in_at) + (o.checked_in_by ? ' · ' + o.checked_in_by : ''), 'subtext'));
    td(tr, o.reference_code, 'mono');
    const when = td(tr, shortDate(o.created_at), 'mono'); when.title = longDate(o.created_at);
    const act = td(tr, '', 'actions');
    if (past) { tbody.appendChild(tr); return; }
    // The admin can change a size even when sizes are locked for guests.
    if (o.status !== 'CANCELLED' && o.package_sizes) {
      act.appendChild(actionBtn('Size', 'ghost', async () => {
        const v = await ask({ title: 'Change size', text: o.guest_email + ' (' + o.reference_code + '). This works even when sizes are locked for guests.', ok: 'Save size', fields: [
          { name: 'size', label: 'Size', value: o.size || '', placeholder: o.package_sizes, required: true }
        ] });
        if (!v) return false;
        const r = await api('/api/admin/orders/' + o.id + '/size', { size: v.size });
        return r.size ? 'Size set to ' + r.size + '.' : 'Size updated.';
      }));
    }
    if (o.status === 'RESERVED') {
      act.appendChild(actionBtn('Mark paid', 'good', async () => {
        const v = await ask({ title: 'Mark as paid?', text: money(amountOf(o), o.currency) + ' from ' + o.guest_email + ' (' + o.reference_code + '). They get a confirmation email and their entry pass.', ok: 'Mark paid' });
        if (!v) return false;
        const r = await api('/api/admin/orders/' + o.id + '/mark-paid', {});
        return r.emailed ? 'Marked paid. Confirmation sent.' : 'Marked paid, but the email failed to send.';
      }));
      act.appendChild(actionBtn('Cancel', 'danger', async () => {
        const v = await ask({ title: 'Cancel this reservation?', text: o.guest_email + ' will be emailed that it was cancelled. Nothing was paid.', ok: 'Cancel reservation', danger: true });
        if (!v) return false;
        await api('/api/admin/orders/' + o.id + '/cancel', {});
        return 'Reservation cancelled.';
      }));
    } else if (o.status === 'PAID') {
      const req = isRefundRequest(o), free = isFree(o);
      const label = free ? (req ? 'Approve cancel' : 'Cancel pass') : (req ? 'Approve refund' : 'Cancel + refund');
      act.appendChild(actionBtn(label, req ? '' : 'danger', async () => {
        const inAlready = o.checked_in_at ? 'Heads up: they already checked in at the door (' + timeOf(o.checked_in_at) + '). ' : '';
        const how = free
          ? 'Cancels the free pass of ' + o.guest_email + '. Nothing was paid, so there is no refund. '
          : o.paid_via === 'PAYPAL'
            ? 'Cancels the order and sends USD ' + o.paypal_amount + ' back to ' + o.guest_email + ' through PayPal right away. '
            : 'Cancels the order and records a refund of ' + money(amountOf(o), o.currency) + ' to ' + o.guest_email + '. ';
        const title = free ? 'Cancel this free pass?' : req ? 'Approve this refund?' : 'Cancel and refund?';
        const v = await ask({ title, text: inAlready + how + 'Their entry pass stops working right away.', ok: free ? 'Cancel pass' : req ? 'Approve refund' : 'Cancel and refund', danger: true });
        if (!v) return false;
        await api('/api/admin/orders/' + o.id + '/approve-refund', {});
        return free ? 'Pass cancelled. The guest has been emailed.' : 'Refund recorded. The guest has been emailed.';
      }));
    }
    tbody.appendChild(tr);
  });
  labelCells(tbody);
}

const DOOR_EVENTS = { ENTRY: ['Entry', 'good'], MANUAL: ['Let in after ID check', 'warn'], OVERRIDE: ['Override', 'warn'], DUPLICATE: ['Blocked repeat', 'bad'], UNDO: ['Undone', 'neutral'],
  PICKUP: ['Package collected', 'good'], PICKUP_DUP: ['Blocked repeat pickup', 'bad'], PICKUP_UNDO: ['Pickup undone', 'neutral'] };
// The Door tab shows the invite-only event's door log, or a ticket event's (picked in #door-source).
let ticketEvents = [], ticketScans = null;
function renderDoorSource() {
  const sel = $('door-source'), v = sel.value;
  sel.classList.toggle('hidden', !ticketEvents.length);
  sel.replaceChildren();
  const o = el('option', "On D' Road"); o.value = ''; sel.appendChild(o);
  ticketEvents.forEach((e) => { const x = el('option', 'Tickets · ' + e.name); x.value = String(e.id); sel.appendChild(x); });
  sel.value = ticketEvents.some((e) => String(e.id) === v) ? v : '';
}
$('door-source').addEventListener('change', async () => {
  const v = $('door-source').value;
  ticketScans = null;
  if (v) { try { ticketScans = await api('/api/admin/ticket-checkins?event=' + encodeURIComponent(v)); } catch (e) { toast(e.message, true); } }
  renderDoor();
});
function renderDoor() {
  const q = $('door-search').value.trim().toLowerCase(), f = $('door-filter').value;
  const tbody = $('doorlist'); tbody.replaceChildren();
  if (ticketScans) {
    const tl = ticketScans.filter((c) => (!f || c.kind === f) && (String(c.ref).toLowerCase().includes(q) || String(c.order_ref).toLowerCase().includes(q) || String(c.label).toLowerCase().includes(q)));
    if (!tl.length) return emptyRow(tbody, 6, ticketScans.length ? 'No door activity matches.' : 'No ticket scans yet for this event.');
    tl.forEach((c) => {
      const tr = el('tr');
      td(tr, c.ticket_kind === 'CAR' ? 'Car pass' : 'Ticket', 'strong');
      const ev = DOOR_EVENTS[c.kind] || [c.kind, 'neutral'];
      td(tr, '').appendChild(pill(ev[0], ev[1]));
      td(tr, c.label);
      td(tr, timeOf(c.scanned_at), 'mono');
      td(tr, c.device || '');
      td(tr, c.ref + ' · ' + c.order_ref, 'mono');
      tbody.appendChild(tr);
    });
    return labelCells(tbody);
  }
  const list = checkins.filter((c) => (!f || c.kind === f) && (String(c.email).toLowerCase().includes(q) || String(c.ref).toLowerCase().includes(q)));
  if (!list.length) return emptyRow(tbody, 6, checkins.length ? 'No door activity matches.' : 'No check-ins yet. They show up here as staff scan passes at the door.');
  list.forEach((c) => {
    const tr = el('tr');
    td(tr, c.email, 'strong');
    const ev = DOOR_EVENTS[c.kind] || [c.kind, 'neutral'];
    td(tr, '').appendChild(pill(ev[0], ev[1]));
    td(tr, c.package);
    const when = td(tr, timeOf(c.scanned_at), 'mono');
    if (c.synced_at && new Date(c.synced_at) - new Date(c.scanned_at) > 120000) when.title = 'Scanned offline, synced ' + timeOf(c.synced_at);
    td(tr, c.device || '');
    td(tr, c.ref, 'mono');
    tbody.appendChild(tr);
  });
  labelCells(tbody);
}

function renderCounts() {
  $('c-g').textContent = guests.length;
  const waiting = guests.filter((g) => g.approval === 'PENDING').length;
  $('c-r').textContent = waiting;
  $('r-ping').classList.toggle('hidden', !waiting);
  $('c-i').textContent = invites.length;
  $('c-p').textContent = products.length;
  $('c-o').textContent = orders.length;
  $('c-d').textContent = checkins.filter((c) => c.kind === 'ENTRY').length;
  $('o-ping').classList.toggle('hidden', !orders.some(isRefundRequest));
}

// Copies each column header onto its cells so the phone card layout can label them.
function labelCells(tbody) {
  const heads = Array.from(tbody.closest('table').querySelectorAll('thead th')).map((th) => th.textContent.trim());
  Array.from(tbody.rows).forEach((tr) => Array.from(tr.cells).forEach((c, i) => c.setAttribute('data-label', tr.classList.contains('empty-row') ? '' : (heads[i] || ''))));
}
function renderAll() { renderEventPicker(); renderStats(); renderSales(); renderGuests(); renderRequests(); renderInvites(); renderProducts(); renderOrders(); renderDoor(); renderCounts(); }

// The site lock's status line: shown while the site is locked, with the unlock time when one is set.
async function refreshLock() {
  try {
    const d = await api('/api/admin/site-lock');
    $('lock-alert').classList.toggle('hidden', !d.locked);
    $('lock-alert-when').textContent = d.locked && d.site_unlock_at ? ' · Opens ' + timeOf(d.site_unlock_at) + ' Antigua time' : ' · Guests see only the trailer';
  } catch (e) { /* the status line is only a reminder */ }
  // The ticket site's line: locked or open, and the tickets paid for today.
  try {
    const [t, evs] = await Promise.all([api('/api/admin/tickets/summary'), api('/api/admin/tickets/events')]);
    $('tix-line').classList.remove('hidden');
    $('tix-line').classList.toggle('locked', !!t.locked);
    $('tix-state').textContent = 'Ticket site: ' + (t.locked ? 'locked' : 'open');
    $('tix-sold').textContent = ' · ' + plural(t.sold_today, 'ticket', 'tickets') + ' sold today' + (t.on_sale ? ' · ' + plural(t.on_sale, 'event', 'events') + ' on sale' : '');
    ticketEvents = evs.filter((e) => e.status !== 'DRAFT');
    renderDoorSource();
  } catch (e) { /* only a reminder */ }
}

async function refresh() {
  refreshLock();
  try {
    const r = await Promise.all([api('/api/admin/guests'), api('/api/admin/invites'), api('/api/admin/packages'), api('/api/admin/orders'), api('/api/admin/checkins'),
      api('/api/admin/events').catch(() => null), viewEvent ? api('/api/admin/orders?event=' + encodeURIComponent(viewEvent)) : null]);
    guests = r[0]; invites = r[1]; products = r[2]; orders = r[3]; checkins = Array.isArray(r[4]) ? r[4] : [];
    if (r[5]) events = { current: r[5].current, past: r[5].past || [] };
    viewOrders = r[6];
    guestByEmail = new Map(guests.map((g) => [String(g.email).toLowerCase(), g]));
  } catch (e) { toast(e.message, true); return; }
  renderAll();
  $('updated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Antigua' }) + ' Antigua time';
}

// ---------- Tabs ----------
const panels = ['guests-panel', 'requests-panel', 'invites-panel', 'products-panel', 'orders-panel', 'door-panel'];
const tabs = ['tab-g', 'tab-r', 'tab-i', 'tab-p', 'tab-o', 'tab-d'];
function showTab(which) {
  panels.forEach((p, i) => $(p).classList.toggle('hidden', tabs[i] !== which));
  tabs.forEach((t) => { $(t).classList.toggle('on', t === which); $(t).setAttribute('aria-selected', t === which ? 'true' : 'false'); });
  // /admin#requests (the link in the "New request" email) opens the Requests tab, and stays on it after a reload.
  if (which === 'tab-r' && location.hash !== '#requests') history.replaceState(null, '', '#requests');
  else if (which !== 'tab-r' && location.hash === '#requests') history.replaceState(null, '', location.pathname + location.search);
}
tabs.forEach((t) => $(t).addEventListener('click', () => showTab(t)));
$('alert-go').addEventListener('click', () => { $('order-filter').value = 'REFUND'; renderOrders(); showTab('tab-o'); $('orders-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
$('req-alert-go').addEventListener('click', () => { $('req-filter').value = 'PENDING'; renderRequests(); showTab('tab-r'); $('requests-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
function tabFromHash() { if (location.hash === '#requests') showTab('tab-r'); if (location.hash === '#orders') showTab('tab-o'); }
// /admin?event=<id>#orders (from the Events page) opens that event's orders.
(function () { const v = new URLSearchParams(location.search).get('event'); if (v && /^[0-9]+$/.test(v)) viewEvent = v; })();
$('order-event').addEventListener('change', (e) => { pickEvent(e.target.value).catch((err) => toast(err.message, true)); });
window.addEventListener('hashchange', tabFromHash);
tabFromHash();

// ---------- Filters ----------
$('search').addEventListener('input', renderGuests);
$('req-search').addEventListener('input', renderRequests);
$('req-filter').addEventListener('change', renderRequests);
$('filter').addEventListener('change', renderGuests);
$('inv-search').addEventListener('input', renderInvites);
$('inv-filter').addEventListener('change', renderInvites);
$('order-search').addEventListener('input', renderOrders);
$('order-filter').addEventListener('change', renderOrders);
$('door-search').addEventListener('input', renderDoor);
$('door-filter').addEventListener('change', renderDoor);
$('refresh-btn').addEventListener('click', async () => { await refresh(); toast('Up to date.'); });

// ---------- Forms ----------
$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('new-email').value.trim(); if (!email) return;
  try { await api('/api/admin/add-guest', { email }); $('new-email').value = ''; toast('Added ' + email + ' to the roster.'); await refresh(); }
  catch (err) { toast(err.message, true); }
});
$('inv-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('inv-email').value.trim(); if (!email) return;
  try {
    const r = await api('/api/admin/create-invite', { email });
    $('inv-email').value = '';
    const box = $('msg'); box.replaceChildren();
    box.appendChild(el('div', r.emailed ? 'Invite emailed to ' + email + '. You can also share the link yourself:' : "The email didn't send. Share this link with " + email + ' yourself:'));
    const row = el('div', undefined, 'link-row');
    row.appendChild(el('code', r.link));
    const copy = el('button', 'Copy', 'btn small ghost'); copy.type = 'button';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(r.link); toast('Link copied.'); } catch (err) { toast('Copy failed. Select the link and copy it manually.', true); }
    });
    row.appendChild(copy);
    box.appendChild(row);
    box.classList.remove('hidden');
    await refresh();
  } catch (err) { toast(err.message, true); }
});
$('p-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('p-name').value.trim(), price = parseFloat($('p-price').value);
  if (!name || !(price >= 0)) return toast('Name and a valid price are required.', true);
  try {
    await api('/api/admin/packages', {
      name, price_cents: Math.round(price * 100), currency: $('p-currency').value, includes: $('p-includes').value,
      requires_compliance: $('p-compliance').checked, capacity: $('p-capacity').value || null, sizes: $('p-sizes').value,
      pay_note: $('p-paynote').value
    });
    ['p-name', 'p-price', 'p-includes', 'p-capacity', 'p-sizes', 'p-paynote'].forEach((id) => { $(id).value = ''; });
    toast('Package created.');
    await refresh();
  } catch (err) { toast(err.message, true); }
});

// A cell starting with = + - @ (or a tab or return) would run as a formula in Excel or Sheets, and some come from
// outside (guests' emails, a door phone's name), so those get a leading ' and stay plain text.
const FORMULA_START = '=+-@' + String.fromCharCode(9, 13);
function downloadCsv(filename, rows) {
  const q = (v) => {
    let s = String(v === null || v === undefined ? '' : v);
    if (s && FORMULA_START.includes(s[0])) s = "'" + s;
    return '"' + s.split('"').join('""') + '"';
  };
  const a = document.createElement('a');
  // The byte-order mark makes Excel read the file as UTF-8, so accented names come out right.
  a.href = URL.createObjectURL(new Blob([String.fromCharCode(0xFEFF) + rows.map((r) => r.map(q).join(',')).join(NL)], { type: 'text/csv;charset=utf-8' }));
  a.download = filename; a.click();
}
$('csv-btn').addEventListener('click', () => {
  downloadCsv('ondroad-guests.csv', [['email', 'name', 'birth_date', 'age', 'instagram', 'invited_by', 'approval', 'attendance', 'invites_left', 'package', 'size', 'order_status', 'reference', 'checked_in_at']].concat(guests.map((g) => {
    const o = latestOrderFor(g.email);
    return [g.email, g.full_name, g.birth_date, g.age, g.instagram, g.invited_by === 'CONTROL' ? "On D' Road" : g.invited_by, g.approval || 'APPROVED',
      g.rsvp_status || 'PENDING', g.invites_left, o ? o.package_name : '', o && o.size ? o.size : '', o ? (isRefundRequest(o) ? 'REFUND_REQUESTED' : o.status) : '', o ? o.reference_code : '', o && o.checked_in_at ? o.checked_in_at : ''];
  })));
});
// Every order, newest first. Amounts are in the order's currency, e.g. 250.00.
$('orders-csv-btn').addEventListener('click', () => {
  const amount = (c) => (c === null || c === undefined ? '' : (Number(c) / 100).toFixed(2));
  const list = viewOrders || orders;
  downloadCsv('ondroad-orders.csv', [['reference', 'email', 'name', 'package', 'tier', 'size', 'list', 'discount', 'code', 'amount', 'currency', 'status', 'paid_via', 'reserved_at', 'paid_at', 'picked_up_at', 'checked_in_at']].concat(
    list.slice().sort((a, b) => b.id - a.id).map((o) => [o.reference_code, o.guest_email, nameOf(o.guest_email), o.package_name, o.tier_name, o.size, amount(o.list_cents ?? o.price_cents),
      amount(o.discount_cents || 0), o.promo_code, amount(amountOf(o)), o.currency, isRefundRequest(o) ? 'REFUND_REQUESTED' : o.status, o.paid_via,
      o.created_at, o.paid_at, o.picked_up_at, o.checked_in_at])));
});

const tick = () => { $('clock').textContent = new Date().toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Antigua' }); };
tick(); setInterval(tick, 15000);
refresh();
</script>
</body>
</html>`;

// Events (see events.js): /admin/events and its API.
registerEvents({ app, pool, requireRole });
// Promoters (see promoter.js): their private pages, their API and the admin routes. Registered here, after the invite
// helpers it shares with /api/send-invite.
registerPromoters({ app, pool, TOKEN_SECRET, safeEqual, requireRole, rateLimit, lock, mail, renderEmail, normalizeEmail, isValidEmail,
  hashToken, newInviteToken, inviteLink, inviteBlocked, SITE_URL, PUBLIC_URL });

app.get('/admin', requireRole('OWNER', 'ADMIN'), (req, res) => res.send(ADMIN_PAGE));

// Every /admin and /api/admin route above (and in the modules) must carry requireRole(...) or the public marker: the
// server refuses to start otherwise. PRINT_ROUTES=1 prints the route → role table.
const ROUTE_TABLE = auth.checkRoutes(app);
if (process.env.PRINT_ROUTES === '1') console.log(ROUTE_TABLE.map((r) => `${r.method.padEnd(5)} ${r.path}  ${r.roles.join(', ')}`).join('\n'));

// Malformed JSON and other uncaught errors
app.use((err, req, res, next) => {
  if (err.status !== 400) console.error(err);
  res.status(err.status === 400 ? 400 : 500).json({ error: err.status === 400 ? 'Invalid request body.' : 'Server error.' });
});

const PORT = process.env.PORT || 10000;
ensureSchema()
  .then(() => console.log('Database schema ready.'))
  .catch((err) => console.error('Schema setup failed (check DB settings):', err.message))
  .then(() => site.refresh())
  .finally(() => app.listen(PORT, () => console.log(`Server live on port ${PORT}`)));
