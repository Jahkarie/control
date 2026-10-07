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
import { registerPricing, loadTiers, priceOf, checkPromo, discountFor, withStates, cleanCode } from './pricing.js';
import { registerPickup, getSizeLock, isSizeLocked } from './pickup.js';
import QRCode from 'qrcode';

const { Pool } = pkg;

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
const serverError = (res, err, msg = 'Server error.') => {
  console.error(err);
  res.status(500).json({ error: msg });
};

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
// Accepts either an x-admin-key header or HTTP Basic auth (password = ADMIN_KEY).
const requireAdmin = (req, res, next) => {
  let key = req.get('x-admin-key');
  const basic = /^Basic (.+)$/.exec(req.get('authorization') || '');
  if (!key && basic) {
    const decoded = Buffer.from(basic[1], 'base64').toString();
    key = decoded.slice(decoded.indexOf(':') + 1);
  }
  if (key && safeEqual(key, ADMIN_KEY)) return next();
  res.set('WWW-Authenticate', 'Basic realm="CONTROL Admin"');
  res.status(401).json({ error: 'Unauthorized' });
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

// ---------- App ----------
const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy

// Accept the configured frontend plus the production domain (and any extras, comma-separated).
const ALLOWED_ORIGINS = [FRONTEND_URL, 'https://ondroad.xyz', 'https://www.ondroad.xyz',
  ...(process.env.EXTRA_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean)];
app.use(cors({ origin: ALLOWED_ORIGINS }));
// Door check-in (staff scanner at /door). Registered before the 10kb body limit because
// a phone coming back online can upload a batch of offline check-ins at once.
registerDoor({ app, pool, express, ADMIN_KEY, safeEqual, rateLimit, requireAdmin });
// Contact details and terms (see site.js). Also before the 10kb limit: the terms can be longer than that.
const site = registerSite({ app, pool, express, requireAdmin });
app.use(express.json({ limit: '10kb' }));

// Payment instructions, pay-by deadline, auto-expiry and reminders (see payments.js).
// Registered before the other routes on purpose: it replaces /api/my-order below.
const mail = registerPayments({ app, pool, resend, EMAIL_FROM, FRONTEND_URL, requireAuth, requireAdmin, escapeHtml,
  beforeExpire: (payDays) => paypal.syncDue(payDays) });
// Event details in guests' accounts and email updates to groups of guests (see event.js).
registerEvent({ app, pool, resend, EMAIL_FROM, FRONTEND_URL, requireAuth, requireAdmin, mail });
// Paying online with PayPal (see paypal.js). Off until the PAYPAL_* settings are added.
const paypal = registerPayPal({ app, pool, requireAuth, requireAdmin, rateLimit, perUser,
  onPaid: (o) => sendPaidEmail(o.guest_email, o.package_name, o.reference_code) });
// Price tiers and promo codes (see pricing.js). A code that makes an unpaid reservation free confirms it straight away.
registerPricing({ app, pool, requireAuth, requireAdmin, rateLimit, perUser,
  onComp: (o) => sendPaidEmail(o.guest_email, o.package_name, o.reference_code, { free: true }) });
// Size lock and package pickup tracking (see pickup.js).
registerPickup({ app, pool, requireAdmin });
const ADMIN_EMAIL = normalizeEmail(process.env.ADMIN_EMAIL); // optional: gets a copy of refund requests

// Creates the packages/orders/settings tables and any missing columns on startup,
// so no SQL has to be run by hand in Aiven. Safe to run every boot.
async function ensureSchema() {
  await pool.query(`
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
    CREATE INDEX IF NOT EXISTS orders_tier_idx ON orders (tier_id);
    CREATE INDEX IF NOT EXISTS orders_promo_idx ON orders (promo_code);
  `);
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

// --- FETCH USER DATA ---
app.get('/api/user-status', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM guests WHERE LOWER(email) = $1', [req.userEmail]);
    if (!result.rows.length) return res.status(404).json({ error: 'Guest not found' });
    res.json(result.rows[0]);
  } catch (err) {
    serverError(res, err);
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
app.post('/api/update-rsvp', requireAuth, async (req, res) => {
  const rsvp_status = typeof req.body?.rsvp_status === 'string' ? req.body.rsvp_status.trim() : '';
  if (!['CONFIRMED', 'PENDING'].includes(rsvp_status)) return res.status(400).json({ error: 'Invalid RSVP status.' });
  try {
    await pool.query('UPDATE guests SET rsvp_status = $1 WHERE LOWER(email) = $2', [rsvp_status, req.userEmail]);
    res.json({ success: true, rsvp_status });
  } catch (err) {
    serverError(res, err);
  }
});

// ---------- Personal single-use invite links ----------
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newInviteToken = () => crypto.randomBytes(24).toString('base64url');
const inviteLink = (t) => `${FRONTEND_URL}/?invite=${t}`;

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

// --- SEND A PERSONAL INVITE (uses one of the sender's invites) ---
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

    const dup = await client.query(
      `SELECT 1 FROM guests WHERE LOWER(email) = $1
       UNION SELECT 1 FROM invites WHERE invitee_email = $1 AND status <> 'REVOKED'`, [recipient]);
    if (dup.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'That person has already been invited.' });
    }

    const dec = await client.query(
      'UPDATE guests SET invites_left = invites_left - 1 WHERE LOWER(email) = $1 AND invites_left > 0', [sender]);
    if (!dec.rowCount) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: "You've used all your invites." });
    }

    await client.query(
      'INSERT INTO invites (token_hash, inviter_email, invitee_email, note) VALUES ($1, $2, $3, $4)',
      [hashToken(token), sender, recipient, note]);

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
    const r = await pool.query('SELECT inviter_email, note, status FROM invites WHERE token_hash = $1', [hashToken(req.params.token)]);
    if (!r.rowCount || r.rows[0].status !== 'PENDING') {
      return res.status(404).json({ error: 'This invitation is invalid or has already been used.' });
    }
    res.json({ inviter: r.rows[0].inviter_email, note: r.rows[0].note });
  } catch (err) {
    serverError(res, err);
  }
});

// --- ACCEPT AN INVITE: joins the roster with two invites and logs in ---
app.post('/api/invite/accept', rateLimit(40, 15 * 60 * 1000), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const bad = 'Invitation invalid, already used, or not issued to that email.';
  if (req.body?.adult !== true) return res.status(400).json({ error: "On D' Road is 18+ only. Confirm you're 18 or older to accept." });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const r = await client.query(
      'SELECT id, invitee_email, status FROM invites WHERE token_hash = $1 FOR UPDATE', [hashToken(req.body?.token)]);
    const inv = r.rows[0];
    if (!inv || inv.status !== 'PENDING' || inv.invitee_email !== email) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: bad });
    }
    await client.query(
      `INSERT INTO guests (email, rsvp_status, shirt_size, invites_left)
       SELECT $1::text, 'PENDING', 'Unassigned', 2
       WHERE NOT EXISTS (SELECT 1 FROM guests WHERE LOWER(email) = $1::text)`, [email]);
    await client.query('UPDATE guests SET age_confirmed_at = NOW() WHERE LOWER(email) = $1 AND age_confirmed_at IS NULL', [email]);
    await client.query("UPDATE invites SET status = 'ACCEPTED', accepted_at = NOW() WHERE id = $1", [inv.id]);
    await client.query('COMMIT');
    res.json({ success: true, token: createToken(email), user: { email } });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    serverError(res, err);
  } finally {
    client?.release();
  }
});

// --- ADMIN: create an invite without using anyone's allowance; returns the link ---
app.post('/api/admin/create-invite', requireAdmin, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 300) : '';
  if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
  const token = newInviteToken();
  try {
    const dup = await pool.query(
      `SELECT 1 FROM guests WHERE LOWER(email) = $1
       UNION SELECT 1 FROM invites WHERE invitee_email = $1 AND status <> 'REVOKED'`, [email]);
    if (dup.rowCount) return res.status(400).json({ error: 'That person is already on the roster or invited.' });
    await pool.query(
      "INSERT INTO invites (token_hash, inviter_email, invitee_email, note) VALUES ($1, 'CONTROL', $2, $3)",
      [hashToken(token), email, note]);
    const link = inviteLink(token);
    const emailed = !(await sendInviteEmail(email, "On D' Road", note, link));
    res.json({ success: true, link, emailed });
  } catch (err) {
    serverError(res, err);
  }
});

// ---------- Packages (public read, admin write) ----------
// Each active package with what it costs right now. With price tiers, that's the tier on sale; when every tier
// has ended or sold out, sales_closed is true (price_cents is then the package price, only for display).
app.get('/api/packages', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.id, p.name, p.price_cents, p.currency, p.includes, p.requires_compliance, p.capacity, p.sizes,
              GREATEST(0, COALESCE(p.capacity, 2147483647) - (SELECT COUNT(*) FROM orders o WHERE o.package_id = p.id AND o.status <> 'CANCELLED')) AS spots_left
       FROM packages p WHERE p.active = TRUE ORDER BY p.sort_order ASC, p.id ASC`);
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

app.get('/api/admin/packages', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.*, (SELECT COUNT(*) FROM orders o WHERE o.package_id = p.id AND o.status <> 'CANCELLED') AS claimed,
              (SELECT COALESCE(json_object_agg(s.size, s.n), '{}'::json) FROM
                (SELECT o.size, COUNT(*) AS n FROM orders o
                 WHERE o.package_id = p.id AND o.status <> 'CANCELLED' AND o.size IS NOT NULL GROUP BY o.size) s) AS size_counts
       FROM packages p ORDER BY p.sort_order ASC, p.id ASC`);
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

app.post('/api/admin/packages', requireAdmin, async (req, res) => {
  const { error, fields: f } = packageInput({ ...req.body, price_cents: req.body?.price_cents ?? '' });
  if (error || !f.name) return res.status(400).json({ error: error || 'Give the package a name.' });
  const currency = ['XCD', 'USD'].includes(req.body?.currency) ? req.body.currency : 'XCD';
  try {
    const r = await pool.query(
      `INSERT INTO packages (name, price_cents, currency, includes, requires_compliance, capacity, sort_order, sizes, pay_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [f.name, f.price_cents, currency, f.includes || '', !!f.requires_compliance, f.capacity ?? null, f.sort_order || 0,
        f.sizes || '', f.pay_note || '']);
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) {
    serverError(res, err);
  }
});

app.post('/api/admin/packages/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { error, fields: f } = packageInput(req.body || {});
  if (error) return res.status(400).json({ error });
  const cols = Object.keys(f); // fixed column names from packageInput, never from the request
  if (!id || !cols.length) return res.status(400).json({ error: 'Nothing to update.' });
  try {
    await pool.query(`UPDATE packages SET ${cols.map((c, n) => `${c} = $${n + 1}`).join(', ')} WHERE id = $${cols.length + 1}`,
      [...cols.map((c) => f[c]), id]);
    res.json({ success: true });
  } catch (err) {
    serverError(res, err);
  }
});

app.post('/api/admin/packages/:id/delete', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid package.' });
  try {
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
       WHERE o.guest_email = $1 AND o.status <> 'CANCELLED' ORDER BY o.id DESC LIMIT 1`, [req.userEmail]);
    res.json(r.rows[0] || null);
  } catch (err) {
    serverError(res, err);
  }
});

app.post('/api/orders', requireAuth, rateLimit(10, 60 * 60 * 1000, perUser), rateLimit(300, 60 * 60 * 1000), async (req, res) => {
  const packageId = parseInt(req.body?.package_id, 10);
  if (!packageId) return res.status(400).json({ error: 'Choose a package.' });
  if (req.body?.terms !== true) return res.status(400).json({ error: 'Agree to the terms to reserve a package.', code: 'TERMS_REQUIRED' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Guests who joined before the 18+ check (or were added by the admin) confirm here, once.
    const guest = await client.query('SELECT age_confirmed_at FROM guests WHERE LOWER(email) = $1 FOR UPDATE', [req.userEmail]);
    if (!guest.rowCount) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'That account is no longer on the roster.' });
    }
    if (!guest.rows[0].age_confirmed_at) {
      if (req.body?.adult !== true) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: "Confirm you're 18 or older to reserve a package.", code: 'AGE_REQUIRED' });
      }
      await client.query('UPDATE guests SET age_confirmed_at = NOW() WHERE LOWER(email) = $1', [req.userEmail]);
    }
    const existing = await client.query("SELECT 1 FROM orders WHERE guest_email = $1 AND status <> 'CANCELLED'", [req.userEmail]);
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You already have a package reserved. Cancel it first to choose another.' });
    }
    const pkg = await client.query(
      'SELECT id, name, price_cents, currency, capacity, active, sizes, pay_note FROM packages WHERE id = $1 FOR UPDATE', [packageId]);
    const p = pkg.rows[0];
    if (!p || !p.active) {
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
    // The guest site sends the tier it showed. If the price has moved on since, the guest sees the new one first.
    const tierId = price.tier ? price.tier.id : null;
    if (req.body && Object.hasOwn(req.body, 'tier_id') && (req.body.tier_id == null ? null : toInt(req.body.tier_id)) !== tierId) {
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
    const settings = await mail.getSettings();
    const now = (await client.query('SELECT NOW() AS now')).rows[0].now;
    const payBy = free ? null : mail.deadlineFor(now, settings);
    const ref = newRef();
    await client.query(
      `INSERT INTO orders (guest_email, package_id, reference_code, size, terms_accepted_at, pay_days, pay_by, tier_id, tier_name,
                           list_cents, discount_cents, amount_cents, currency, promo_code, status, paid_at, paid_via)
       VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [req.userEmail, packageId, ref, size, settings.payDays, payBy, tierId, price.tier ? price.tier.name : null,
        list, discount, amount, p.currency, promo ? promo.code : null,
        free ? 'PAID' : 'RESERVED', free ? now : null, free ? 'COMP' : null]);
    await client.query('COMMIT');
    res.json({ success: true, reference_code: ref, status: free ? 'PAID' : 'RESERVED', amount_cents: amount, currency: p.currency });
    // Sent after responding so a slow email never holds up the guest.
    if (free) {
      sendPaidEmail(req.userEmail, p.name, ref, { free: true });
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
// have locked sizes (see pickup.js). The admin can still change it from the Orders tab.
app.post('/api/orders/size', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT o.id, o.status, p.sizes FROM orders o JOIN packages p ON p.id = o.package_id
       WHERE o.guest_email = $1 AND o.status <> 'CANCELLED' ORDER BY o.id DESC LIMIT 1`, [req.userEmail]);
    if (!r.rowCount) return res.status(400).json({ error: 'You have no order to change.' });
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
      `UPDATE orders SET status = 'CANCELLED' WHERE guest_email = $1 AND status = 'RESERVED'
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
       WHERE guest_email = $1 AND status = 'PAID' AND cancel_requested_at IS NULL
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
       WHERE guest_email = $1 AND status = 'PAID' AND cancel_requested_at IS NOT NULL`, [req.userEmail]);
    if (!r.rowCount) return res.status(400).json({ error: 'No open cancellation request.' });
    res.json({ success: true });
  } catch (err) {
    serverError(res, err);
  }
});

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT o.id, o.package_id, o.guest_email, o.status, o.reference_code, o.created_at, o.paid_at,
              o.cancel_requested_at, o.cancel_reason, o.refunded_at, o.checked_in_at, o.checked_in_by, o.size,
              o.paid_via, o.paypal_status, o.paypal_amount, o.paypal_refund_id, o.tier_name, o.promo_code,
              o.discount_cents, o.picked_up_at, o.picked_up_by,
              COALESCE(o.amount_cents, p.price_cents) AS amount_cents, COALESCE(o.list_cents, p.price_cents) AS list_cents,
              COALESCE(o.amount_cents, p.price_cents) AS price_cents, COALESCE(o.currency, p.currency) AS currency,
              NOT EXISTS (SELECT 1 FROM guests g WHERE LOWER(g.email) = LOWER(o.guest_email)) AS removed_guest,
              p.name AS package_name, p.sizes AS package_sizes
       FROM orders o JOIN packages p ON p.id = o.package_id
       ORDER BY (o.status = 'PAID' AND o.cancel_requested_at IS NOT NULL) DESC, o.id DESC`);
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

// ---------- Entry pass QR in email ----------
// Same text as the QR on the guest site, which the door scanner reads.
const passText = (ref, email) => `ONDROAD:${ref}:${String(email).toLowerCase()}`;
const passPng = (ref, email) => QRCode.toBuffer(passText(ref, email), { width: 440, margin: 2, errorCorrectionLevel: 'M' });
// The emailed image URL is signed so pass images can't be fetched by guessing references.
const passSig = (ref) => sign('pass:' + ref).slice(0, 22);
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

// Only paid orders have a pass: after a refund the emailed image stops loading.
app.get('/api/pass/:ref.png', rateLimit(300, 15 * 60 * 1000), async (req, res) => {
  const ref = String(req.params.ref || '').toUpperCase();
  if (!safeEqual(String(req.query.s || ''), passSig(ref))) return res.status(404).end();
  try {
    const r = await pool.query("SELECT guest_email FROM orders WHERE reference_code = $1 AND status = 'PAID'", [ref]);
    if (!r.rowCount) return res.status(404).end();
    res.type('png').set('Cache-Control', 'private, max-age=3600').send(await passPng(ref, r.rows[0].guest_email));
  } catch (err) {
    serverError(res, err);
  }
});

// "You're confirmed" email with the entry pass. free: a free pass (promo code or free package), so nothing was paid.
async function sendPaidEmail(to, packageName, ref, { free } = {}) {
  let attachments;
  try {
    attachments = [{ filename: `ondroad-pass-${ref}.png`, content: await passPng(ref, to) }];
  } catch (err) {
    console.error('Pass QR failed:', ref, err.message); // still send the confirmation without it
  }
  return mail.send(to, "You're confirmed — On D' Road", renderEmail({
    tone: 'good', tag: free ? 'Free pass' : 'Payment confirmed', title: "You're in",
    preheader: free ? 'Your free pass is confirmed. Your entry pass is ready.' : 'Payment received. Your entry pass is ready.',
    lines: [free ? 'Your free pass is confirmed.' : 'Payment received. Your spot is confirmed.',
      'Your entry pass is below and attached to this email. Save it to your phone so you can show it at the entrance even without signal. Final event details, location and package pickup info will follow closer to the date.'],
    image: PUBLIC_URL ? { src: `${PUBLIC_URL}/api/pass/${ref}.png?s=${passSig(ref)}`, alt: `Entry pass ${ref}`, caption: 'Show this at the entrance. One scan, one person.' } : null,
    details: [['Package', packageName], ['Reference', ref, true]],
    cta: { text: 'View my pass', url: FRONTEND_URL }
  }), attachments);
}

app.post('/api/admin/orders/:id/mark-paid', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const r = await pool.query(
      `UPDATE orders SET status = 'PAID', paid_at = NOW(), paid_via = 'MANUAL' WHERE id = $1 AND status = 'RESERVED'
       RETURNING guest_email, reference_code, (SELECT name FROM packages WHERE id = orders.package_id) AS package_name`, [id]);
    if (!r.rowCount) return res.status(400).json({ error: 'Order not found or already resolved.' });
    const { guest_email, reference_code, package_name } = r.rows[0];
    const emailError = await sendPaidEmail(guest_email, package_name, reference_code);
    res.json({ success: true, emailed: !emailError });
  } catch (err) {
    serverError(res, err);
  }
});

// Cancels an unpaid reservation. Paid orders go through approve-refund instead.
app.post('/api/admin/orders/:id/cancel', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const r = await pool.query(
      `UPDATE orders SET status = 'CANCELLED' WHERE id = $1 AND status = 'RESERVED'
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
app.post('/api/admin/orders/:id/approve-refund', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const cur = await pool.query(
      "SELECT reference_code, paid_via, paypal_capture_id, paypal_amount FROM orders WHERE id = $1 AND status = 'PAID'", [id]);
    if (!cur.rowCount) return res.status(400).json({ error: 'Order not found or not paid.' });
    const pp = cur.rows[0].paid_via === 'PAYPAL' && cur.rows[0].paypal_capture_id ? cur.rows[0] : null;
    let refundId = null;
    if (pp) {
      const rf = await paypal.refund(pp);
      if (!rf.ok) return res.status(502).json({ error: `PayPal didn't accept the refund (${rf.error}), so nothing was changed. Try again, or refund it in PayPal and then approve it here.` });
      refundId = rf.id;
    }
    const r = await pool.query(
      `UPDATE orders o SET status = 'CANCELLED', refunded_at = NOW(), paypal_refund_id = COALESCE($2, o.paypal_refund_id) FROM packages p
       WHERE o.id = $1 AND p.id = o.package_id AND o.status = 'PAID'
       RETURNING o.guest_email, o.reference_code, p.name AS package_name,
                 COALESCE(o.amount_cents, p.price_cents) AS amount_cents, COALESCE(o.currency, p.currency) AS currency`, [id, refundId]);
    if (!r.rowCount) return res.status(400).json({ error: 'Order not found or not paid.' });
    const o = r.rows[0];
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
app.get('/api/admin/guests', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM guests ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    serverError(res, err);
  }
});

app.post('/api/admin/reset-invites', requireAdmin, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
  try {
    await pool.query('UPDATE guests SET invites_left = 2 WHERE LOWER(email) = $1', [email]);
    res.json({ success: true });
  } catch (err) {
    serverError(res, err);
  }
});

app.post('/api/admin/add-guest', requireAdmin, async (req, res) => {
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

app.get('/api/admin/invites', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, inviter_email, invitee_email, note, status, created_at, accepted_at FROM invites ORDER BY id DESC');
    res.json(r.rows);
  } catch (err) {
    serverError(res, err);
  }
});

app.post('/api/admin/revoke-invite', requireAdmin, async (req, res) => {
  const id = parseInt(req.body?.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid invite.' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const r = await client.query("UPDATE invites SET status = 'REVOKED' WHERE id = $1 AND status = 'PENDING' RETURNING inviter_email", [id]);
    if (!r.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only pending invites can be revoked.' });
    }
    // Give the inviter their invite back (no-op for admin-created invites)
    await client.query('UPDATE guests SET invites_left = invites_left + 1 WHERE LOWER(email) = $1', [r.rows[0].inviter_email.toLowerCase()]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    serverError(res, err);
  } finally {
    client?.release();
  }
});

app.post('/api/admin/set-invites', requireAdmin, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const count = parseInt(req.body?.count, 10);
  if (!isValidEmail(email) || !(count >= 0 && count <= 20)) return res.status(400).json({ error: 'Invalid email or count (0-20).' });
  try {
    await pool.query('UPDATE guests SET invites_left = $1 WHERE LOWER(email) = $2', [count, email]);
    res.json({ success: true });
  } catch (err) {
    serverError(res, err);
  }
});

app.post('/api/admin/remove-guest', requireAdmin, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
  // A paid guest must be refunded first, or their pass would keep working at the door.
  // Unpaid reservations are cancelled so the spots free up.
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const paid = await client.query(
      "SELECT reference_code FROM orders WHERE LOWER(guest_email) = $1 AND status = 'PAID' LIMIT 1", [email]);
    if (paid.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `${email} has a paid order (${paid.rows[0].reference_code}). Refund it in the Orders tab first, then remove them.` });
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
<meta name="theme-color" content="#0b0a09">
<title>Command Center | On D' Road</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #0b0a09; --surface: #141210; --surface-2: #1b1815; --raise: #221e1a;
  --line: rgba(243, 236, 226, .09); --line-strong: rgba(243, 236, 226, .2);
  --text: #f3ece2; --muted: #9b9389; --dim: #6c665e;
  --accent: #ff5b1f; --accent-ink: #120703;
  --good: #4fc3a1; --warn: #f0b43c; --bad: #ff6a5c;
  --display: 'Anton', Impact, sans-serif; --body: 'Inter', system-ui, -apple-system, sans-serif; --mono: 'JetBrains Mono', ui-monospace, monospace;
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
  position: sticky; top: 0; z-index: 30; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
  padding: 14px clamp(16px, 3vw, 32px); background: rgba(11, 10, 9, .8); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--line);
}
.brand { display: flex; align-items: center; gap: 14px; }
.brand b { font-family: var(--display); font-weight: 400; font-size: 20px; letter-spacing: .04em; }
.brand b span { color: var(--accent); }
.brand .sub { font-size: 12px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); padding-left: 14px; border-left: 1px solid var(--line-strong); }
.top-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.top-link { font-size: 13px; font-weight: 500; color: var(--muted); text-decoration: none; padding: 8px 12px; border-radius: 8px; transition: color .15s, background .15s; }
.top-link:hover { color: var(--text); background: rgba(243, 236, 226, .05); }
.clock { font-family: var(--mono); font-size: 12px; color: var(--dim); padding-left: 10px; }

.wrap { max-width: 1240px; margin: 0 auto; padding: clamp(20px, 3vw, 36px) clamp(16px, 3vw, 32px) 80px; }
.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 22px; }
.page-head h1 { font-family: var(--display); font-weight: 400; font-size: clamp(36px, 5vw, 52px); line-height: .95; text-transform: uppercase; margin: 0; }
.page-head p { margin: 6px 0 0; color: var(--muted); }

/* ---------- Attention banner ---------- */
.alert {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 14px 16px 14px 18px; margin-bottom: 18px; border-radius: 12px;
  background: rgba(240, 180, 60, .08); border: 1px solid rgba(240, 180, 60, .35); color: var(--text); font-weight: 500;
}
.alert .btn { margin-left: auto; }
.alert::before { content: '!'; display: inline-grid; place-items: center; flex: none; width: 22px; height: 22px; border-radius: 50%; background: var(--warn); color: #1a1204; font-weight: 700; font-size: 13px; vertical-align: -5px; }

/* ---------- KPI row ---------- */
.kpis { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; margin-bottom: 18px; }
@media (max-width: 1100px) { .kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 560px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.stat { background: var(--surface); padding: 18px 18px 16px; min-width: 0; }
.stat .label { display: block; font-size: 13px; font-weight: 500; color: var(--muted); }
.stat .value { display: block; font-size: 32px; font-weight: 600; letter-spacing: -.02em; line-height: 1.15; margin-top: 8px; overflow-wrap: anywhere; }
.stat .value.money { font-size: 24px; line-height: 1.35; }
.stat .sub { display: block; font-size: 12px; color: var(--dim); margin-top: 6px; }
@media (max-width: 560px) { .stat .value { font-size: 28px; } .stat .value.money { font-size: 19px; white-space: nowrap; } .stat { padding: 16px 14px 14px; } }

/* ---------- Cards ---------- */
.split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; margin-bottom: 28px; }
@media (max-width: 900px) { .split { grid-template-columns: 1fr; } }
.card { background: linear-gradient(180deg, var(--surface-2), var(--surface)); border: 1px solid var(--line); border-radius: 14px; padding: 22px; min-width: 0; }
.card h2 { font-size: 16px; font-weight: 600; margin: 0; }
.card .hint { font-size: 13px; color: var(--muted); margin: 4px 0 0; }
.form-block { margin-top: 18px; }
.form-block > span { display: block; font-size: 11px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; }
.field-row { display: flex; gap: 8px; }
.field-row input { flex: 1; min-width: 0; }

input, select, textarea {
  font: 500 14px var(--body); color: var(--text); background: rgba(0, 0, 0, .35);
  border: 1px solid var(--line-strong); border-radius: 9px; padding: 11px 13px; min-width: 0;
  transition: border-color .15s, box-shadow .15s;
}
select { padding-right: 34px; -webkit-appearance: none; appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%); background-position: calc(100% - 17px) 50%, calc(100% - 12px) 50%; background-size: 5px 5px; background-repeat: no-repeat; }
select option { background: var(--surface); color: var(--text); }
input::placeholder, textarea::placeholder { color: var(--dim); }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(255, 91, 31, .16); }
textarea { resize: vertical; min-height: 84px; width: 100%; }
input[type=checkbox] { width: 18px; height: 18px; padding: 0; accent-color: var(--accent); }

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px; white-space: nowrap;
  font: 600 13px var(--body); padding: 11px 16px; border-radius: 9px; cursor: pointer;
  color: var(--accent-ink); background: var(--accent); border: 1px solid var(--accent); transition: filter .15s, background .15s, border-color .15s, color .15s;
  text-decoration: none;
}
.btn:hover { filter: brightness(1.08); }
.btn:disabled { opacity: .5; cursor: progress; }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--line-strong); }
.btn.ghost:hover { border-color: var(--text); filter: none; }
.btn.danger { background: transparent; color: var(--bad); border-color: rgba(255, 106, 92, .4); }
.btn.danger:hover { background: rgba(255, 106, 92, .08); filter: none; }
.btn.good { background: var(--good); border-color: var(--good); color: #04140e; }
.btn.danger-solid { background: var(--bad); border-color: var(--bad); color: #1a0402; }
.btn.small { padding: 7px 11px; font-size: 12px; border-radius: 8px; }

.result { margin-top: 16px; padding: 14px; border-radius: 10px; background: rgba(243, 236, 226, .04); border: 1px solid var(--line); font-size: 13px; }
.result .link-row { display: flex; gap: 8px; margin-top: 10px; }
.result code { flex: 1; min-width: 0; font-family: var(--mono); font-size: 12px; color: var(--text); background: rgba(0, 0, 0, .35); border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- Package sales (meters) ---------- */
.sales { margin-top: 18px; display: grid; gap: 18px; }
.meter-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.meter-name { font-weight: 600; }
.meter-val { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.bar { display: flex; gap: 2px; height: 10px; margin-top: 10px; }
.seg { height: 100%; min-width: 3px; border-radius: 0; transition: filter .15s; }
.seg.end { border-radius: 0 4px 4px 0; }
.seg.paid { background: var(--good); }
.seg.reserved { background: var(--warn); }
.seg.left { background: rgba(243, 236, 226, .08); flex: 1; }
.seg.paid:hover, .seg.reserved:hover { filter: brightness(1.18); }
.legend { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 8px; font-size: 12px; color: var(--muted); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.legend i.paid { background: var(--good); } .legend i.reserved { background: var(--warn); }
.tip { position: fixed; z-index: 60; pointer-events: none; background: var(--raise); border: 1px solid var(--line-strong); border-radius: 8px; padding: 8px 10px; font-size: 12px; color: var(--muted); box-shadow: 0 12px 30px -10px rgba(0, 0, 0, .7); transform: translate(-50%, calc(-100% - 10px)); }
.tip b { display: block; color: var(--text); font-size: 15px; font-weight: 600; }
.empty { color: var(--muted); font-size: 14px; margin: 0; }

/* ---------- Tabs ---------- */
.tabs { display: flex; gap: 4px; padding: 4px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); width: max-content; max-width: 100%; overflow-x: auto; margin-bottom: 14px; }
.tab { position: relative; display: inline-flex; align-items: center; gap: 8px; font: 600 13px var(--body); color: var(--muted); background: transparent; border: 0; border-radius: 9px; padding: 9px 14px; cursor: pointer; white-space: nowrap; transition: color .15s, background .15s; }
.tab:hover { color: var(--text); }
.tab.on { color: var(--text); background: var(--raise); box-shadow: inset 0 0 0 1px var(--line-strong); }
.count { font-family: var(--mono); font-size: 11px; color: var(--dim); }
.tab.on .count { color: var(--muted); }
@media (max-width: 600px) {
  .tabs { width: 100%; }
  .tab { flex: 1 0 auto; justify-content: center; padding: 9px 10px; }
  .tab .count { display: none; }
}
.ping { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); box-shadow: 0 0 0 3px rgba(240, 180, 60, .18); }

/* ---------- Panels & tables ---------- */
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
.toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; padding: 14px; border-bottom: 1px solid var(--line); }
.toolbar .grow { flex: 1; min-width: 180px; }
.toolbar .spacer { flex: 1; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { position: sticky; top: 0; text-align: left; font-size: 11px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); padding: 12px 14px; background: var(--surface); border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 13px 14px; border-bottom: 1px solid var(--line); vertical-align: middle; }
tbody tr { transition: background .12s; }
tbody tr:hover { background: rgba(243, 236, 226, .025); }
tbody tr:last-child td { border-bottom: 0; }
td.strong { font-weight: 600; }
td.mono, .mono { font-family: var(--mono); font-size: 12px; color: var(--muted); white-space: nowrap; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.actions { text-align: right; white-space: nowrap; }
td.actions .btn + .btn { margin-left: 6px; }
.subtext { display: block; font-size: 12px; color: var(--muted); margin-top: 4px; max-width: 280px; white-space: normal; }
.subtext.bad { color: var(--bad); }
td.num .subtext { margin-left: auto; }
.empty-row td { text-align: center; color: var(--muted); padding: 40px 14px; }

.pill { display: inline-flex; align-items: center; gap: 7px; padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; white-space: nowrap; border: 1px solid var(--line-strong); color: var(--muted); }
.pill::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pill.good { color: var(--good); border-color: rgba(79, 195, 161, .35); }
.pill.warn { color: var(--warn); border-color: rgba(240, 180, 60, .35); }
.pill.bad { color: var(--bad); border-color: rgba(255, 106, 92, .35); }
.pill.neutral { color: var(--dim); }

.toggle { font: 600 12px var(--body); border-radius: 999px; padding: 5px 12px; cursor: pointer; border: 1px solid var(--line-strong); background: transparent; color: var(--muted); }
.toggle.on { color: var(--good); border-color: rgba(79, 195, 161, .4); background: rgba(79, 195, 161, .08); }

/* Phones: each table row becomes a card. Labels come from the column headers. */
@media (max-width: 700px) {
  table.cards thead { display: none; }
  table.cards, table.cards tbody, table.cards tr, table.cards td { display: block; width: 100%; }
  table.cards tr { padding: 14px 16px; border-bottom: 1px solid var(--line); }
  table.cards tr:last-child { border-bottom: 0; }
  table.cards td { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 12px; border: 0; padding: 5px 0; text-align: right; }
  table.cards td::before { content: attr(data-label); font-size: 11px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); text-align: left; }
  table.cards td[data-label=""]::before { content: none; }
  table.cards td.strong { display: block; text-align: left; font-size: 15px; padding: 0 0 6px; }
  table.cards td.strong::before { content: none; }
  table.cards td.idx { display: none; }
  table.cards td.actions { justify-content: flex-end; padding-top: 10px; }
  table.cards td.actions .btn { flex: 1; max-width: 220px; padding: 10px 12px; font-size: 13px; }
  table.cards .subtext { flex-basis: 100%; max-width: none; text-align: right; margin-top: 0; }
  table.cards td.strong .subtext { text-align: left; margin-top: 4px; }
  table.cards tr.empty-row td { display: block; text-align: center; }
  table.cards tr.empty-row td::before { content: none; }
  tbody tr:hover { background: transparent; }
}

/* Create-package form */
.create { padding: 18px; border-bottom: 1px solid var(--line); background: rgba(243, 236, 226, .015); }
.create h3 { margin: 0 0 14px; font-size: 14px; font-weight: 600; }
.create-grid { display: grid; grid-template-columns: 2fr 1fr 110px 1fr; gap: 10px; }
.create-grid textarea, .create-grid #p-sizes { grid-column: 1 / -1; }
.create .hint { font-size: 13px; color: var(--muted); margin: 10px 0 0; }
.create .hint a { color: var(--text); }
.create-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
.check { display: inline-flex; align-items: center; gap: 10px; font-size: 14px; color: var(--text); cursor: pointer; }
@media (max-width: 700px) { .create-grid { grid-template-columns: 1fr 1fr; } .create-grid input:first-child { grid-column: 1 / -1; } }

/* ---------- Dialog ---------- */
dialog { width: min(460px, calc(100vw - 32px)); padding: 0; border: 1px solid var(--line-strong); border-radius: 16px; background: var(--surface-2); color: var(--text); box-shadow: 0 30px 80px -20px rgba(0, 0, 0, .8); }
dialog::backdrop { background: rgba(5, 4, 3, .7); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
dialog form { padding: 24px; }
dialog h3 { margin: 0; font-size: 18px; font-weight: 600; }
dialog p { margin: 8px 0 0; color: var(--muted); font-size: 14px; }
.dlg-fields { display: grid; gap: 14px; margin-top: 18px; }
.dlg-fields .field span { display: block; font-size: 11px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); margin-bottom: 7px; }
.dlg-fields .field input, .dlg-fields .field textarea { width: 100%; }
.dlg-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; }

/* ---------- Toast ---------- */
.toast { position: fixed; left: 50%; bottom: 24px; z-index: 80; transform: translate(-50%, 16px); max-width: calc(100vw - 32px); padding: 12px 16px; border-radius: 10px; background: var(--text); color: var(--bg); font-size: 14px; font-weight: 600; opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s; box-shadow: 0 20px 50px -10px rgba(0, 0, 0, .6); }
.toast.show { opacity: 1; transform: translate(-50%, 0); }
.toast.bad { background: var(--bad); color: #1a0402; }

@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
</style>
</head>
<body>
<header class="top">
  <div class="brand"><b>ON D<span>'</span> ROAD</b><span class="sub">Command Center</span></div>
  <nav class="top-right">
    <a class="top-link" href="/door" target="_blank" rel="noopener">Door scanner</a>
    <a class="top-link" href="/admin/payments">Payment settings</a>
    <a class="top-link" href="/admin/pricing">Prices &amp; codes</a>
    <a class="top-link" href="/admin/pickup">Sizes &amp; pickup</a>
    <a class="top-link" href="/admin/event">Event &amp; messages</a>
    <a class="top-link" href="/admin/site">Contact, terms &amp; FAQ</a>
    <a class="top-link" href="${FRONTEND_URL}" target="_blank" rel="noopener">View site &#8599;</a>
    <span id="clock" class="clock"></span>
  </nav>
</header>

<main class="wrap">
  <div class="page-head">
    <div>
      <h1>Overview</h1>
      <p id="updated">Loading&hellip;</p>
    </div>
    <button class="btn ghost" id="refresh-btn" type="button">Refresh</button>
  </div>

  <div id="alert" class="alert hidden"><span id="alert-text"></span><button class="btn small" id="alert-go" type="button">Review</button></div>

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
    <button class="tab" id="tab-i" role="tab" aria-selected="false" type="button">Invites <span class="count" id="c-i"></span></button>
    <button class="tab" id="tab-p" role="tab" aria-selected="false" type="button">Packages <span class="count" id="c-p"></span></button>
    <button class="tab" id="tab-o" role="tab" aria-selected="false" type="button">Orders <span class="count" id="c-o"></span><span class="ping hidden" id="o-ping"></span></button>
    <button class="tab" id="tab-d" role="tab" aria-selected="false" type="button">Door <span class="count" id="c-d"></span></button>
  </div>

  <section class="panel" id="guests-panel" role="tabpanel">
    <div class="toolbar">
      <input id="search" class="grow" placeholder="Search by email" type="search">
      <select id="filter" aria-label="Attendance filter"><option value="">All attendance</option><option value="CONFIRMED">Confirmed</option><option value="PENDING">Pending</option></select>
      <button class="btn ghost" id="csv-btn" type="button">Export CSV</button>
    </div>
    <div class="scroll"><table class="cards"><thead><tr><th class="num">#</th><th>Email</th><th>Attendance</th><th>Package</th><th class="num">Invites left</th><th></th></tr></thead><tbody id="roster"></tbody></table></div>
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
      <p class="hint">Want early bird pricing or promo codes? Create the package, then set them up in <a href="/admin/pricing">Prices &amp; codes</a>.</p>
      <div class="create-foot">
        <label class="check"><input type="checkbox" id="p-compliance" checked> Requires costume compliance</label>
        <button class="btn" type="submit">Create package</button>
      </div>
    </form>
    <div class="scroll"><table class="cards"><thead><tr><th>Package</th><th class="num">Price</th><th class="num">Claimed</th><th>Visibility</th><th></th></tr></thead><tbody id="productlist"></tbody></table></div>
  </section>

  <section class="panel hidden" id="orders-panel" role="tabpanel">
    <div class="toolbar">
      <input id="order-search" class="grow" placeholder="Search email or reference" type="search">
      <select id="order-filter" aria-label="Order status filter"><option value="">All orders</option><option value="REFUND">Refund requests</option><option value="RESERVED">Awaiting payment</option><option value="PAID">Paid</option><option value="COMP">Free passes</option><option value="COLLECTED">Package collected</option><option value="UNCOLLECTED">Paid, not collected</option><option value="CHECKED">Checked in</option><option value="CANCELLED">Cancelled</option></select>
      <button class="btn ghost" id="orders-csv-btn" type="button">Export orders CSV</button>
    </div>
    <div class="scroll"><table class="cards"><thead><tr><th>Guest</th><th>Package</th><th class="num">Amount</th><th>Status</th><th>Reference</th><th>Reserved</th><th></th></tr></thead><tbody id="orderlist"></tbody></table></div>
  </section>
  <section class="panel hidden" id="door-panel" role="tabpanel">
    <div class="toolbar">
      <input id="door-search" class="grow" placeholder="Search email or reference" type="search">
      <select id="door-filter" aria-label="Door event filter"><option value="">All door activity</option><option value="ENTRY">Entries</option><option value="OVERRIDE">Overrides</option><option value="DUPLICATE">Blocked repeat scans</option><option value="UNDO">Undone</option><option value="PICKUP">Packages collected</option><option value="PICKUP_DUP">Blocked repeat pickups</option><option value="PICKUP_UNDO">Pickups undone</option></select>
      <a class="btn ghost" href="/door" target="_blank" rel="noopener">Open scanner</a>
    </div>
    <div class="scroll"><table class="cards"><thead><tr><th>Guest</th><th>Event</th><th>Package</th><th>Time</th><th>Phone</th><th>Reference</th></tr></thead><tbody id="doorlist"></tbody></table></div>
  </section>
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
  const q = $('search').value.trim().toLowerCase(), f = $('filter').value;
  const tbody = $('roster'); tbody.replaceChildren();
  const list = guests.filter((g) => g.email.toLowerCase().includes(q) && (!f || (g.rsvp_status || 'PENDING') === f));
  if (!list.length) return emptyRow(tbody, 6, guests.length ? 'No guests match.' : 'No guests yet. Add someone above.');
  list.forEach((g, i) => {
    const tr = el('tr');
    td(tr, i + 1, 'num mono idx');
    td(tr, g.email, 'strong');
    td(tr, '').appendChild(g.rsvp_status === 'CONFIRMED' ? pill('Confirmed', 'good') : pill('Pending', 'neutral'));
    td(tr, '').appendChild(orderPill(latestOrderFor(g.email)));
    td(tr, g.invites_left, 'num');
    const act = td(tr, '', 'actions');
    act.appendChild(actionBtn('Set invites', 'ghost', async () => {
      const v = await ask({ title: 'Set invites', text: 'How many invites ' + g.email + ' can still send.', ok: 'Save', fields: [{ name: 'count', label: 'Invites (0 to 20)', type: 'number', min: 0, max: 20, value: g.invites_left, required: true }] });
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

function renderInvites() {
  const q = $('inv-search').value.trim().toLowerCase(), f = $('inv-filter').value;
  const tbody = $('invlist'); tbody.replaceChildren();
  const list = invites.filter((v) => (!f || v.status === f) && (String(v.invitee_email).toLowerCase().includes(q) || String(v.inviter_email).toLowerCase().includes(q)));
  if (!list.length) return emptyRow(tbody, 5, invites.length ? 'No invites match.' : 'No invites sent yet.');
  list.forEach((v) => {
    const tr = el('tr');
    td(tr, v.invitee_email, 'strong');
    td(tr, v.inviter_email === 'CONTROL' ? "On D' Road" : v.inviter_email);
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
function renderOrders() {
  const f = $('order-filter').value, q = $('order-search').value.trim().toLowerCase();
  const tbody = $('orderlist'); tbody.replaceChildren();
  const list = orders.filter((o) => (!f || (ORDER_FILTERS[f] ? ORDER_FILTERS[f](o) : o.status === f)) &&
    (String(o.guest_email).toLowerCase().includes(q) || String(o.reference_code).toLowerCase().includes(q)));
  if (!list.length) return emptyRow(tbody, 7, orders.length ? 'No orders match.' : 'No orders yet.');
  list.forEach((o) => {
    const tr = el('tr');
    td(tr, o.guest_email, 'strong');
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
    if (o.picked_up_at) st.appendChild(el('span', 'Package collected ' + timeOf(o.picked_up_at) + (o.picked_up_by ? ' · ' + o.picked_up_by : ''), 'subtext'));
    if (o.checked_in_at) st.appendChild(el('span', 'Checked in ' + timeOf(o.checked_in_at) + (o.checked_in_by ? ' · ' + o.checked_in_by : ''), 'subtext'));
    td(tr, o.reference_code, 'mono');
    const when = td(tr, shortDate(o.created_at), 'mono'); when.title = longDate(o.created_at);
    const act = td(tr, '', 'actions');
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

const DOOR_EVENTS = { ENTRY: ['Entry', 'good'], OVERRIDE: ['Override', 'warn'], DUPLICATE: ['Blocked repeat', 'bad'], UNDO: ['Undone', 'neutral'],
  PICKUP: ['Package collected', 'good'], PICKUP_DUP: ['Blocked repeat pickup', 'bad'], PICKUP_UNDO: ['Pickup undone', 'neutral'] };
function renderDoor() {
  const q = $('door-search').value.trim().toLowerCase(), f = $('door-filter').value;
  const tbody = $('doorlist'); tbody.replaceChildren();
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
function renderAll() { renderStats(); renderSales(); renderGuests(); renderInvites(); renderProducts(); renderOrders(); renderDoor(); renderCounts(); }

async function refresh() {
  try {
    const r = await Promise.all([api('/api/admin/guests'), api('/api/admin/invites'), api('/api/admin/packages'), api('/api/admin/orders'), api('/api/admin/checkins')]);
    guests = r[0]; invites = r[1]; products = r[2]; orders = r[3]; checkins = Array.isArray(r[4]) ? r[4] : [];
  } catch (e) { toast(e.message, true); return; }
  renderAll();
  $('updated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Antigua' }) + ' Antigua time';
}

// ---------- Tabs ----------
const panels = ['guests-panel', 'invites-panel', 'products-panel', 'orders-panel', 'door-panel'];
const tabs = ['tab-g', 'tab-i', 'tab-p', 'tab-o', 'tab-d'];
function showTab(which) {
  panels.forEach((p, i) => $(p).classList.toggle('hidden', tabs[i] !== which));
  tabs.forEach((t) => { $(t).classList.toggle('on', t === which); $(t).setAttribute('aria-selected', t === which ? 'true' : 'false'); });
}
tabs.forEach((t) => $(t).addEventListener('click', () => showTab(t)));
$('alert-go').addEventListener('click', () => { $('order-filter').value = 'REFUND'; renderOrders(); showTab('tab-o'); $('orders-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); });

// ---------- Filters ----------
$('search').addEventListener('input', renderGuests);
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

function downloadCsv(filename, rows) {
  const q = (v) => '"' + String(v === null || v === undefined ? '' : v).split('"').join('""') + '"';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.map((r) => r.map(q).join(',')).join(NL)], { type: 'text/csv' }));
  a.download = filename; a.click();
}
$('csv-btn').addEventListener('click', () => {
  downloadCsv('ondroad-guests.csv', [['email', 'attendance', 'invites_left', 'package', 'size', 'order_status', 'reference', 'checked_in_at']].concat(guests.map((g) => {
    const o = latestOrderFor(g.email);
    return [g.email, g.rsvp_status || 'PENDING', g.invites_left, o ? o.package_name : '', o && o.size ? o.size : '', o ? (isRefundRequest(o) ? 'REFUND_REQUESTED' : o.status) : '', o ? o.reference_code : '', o && o.checked_in_at ? o.checked_in_at : ''];
  })));
});
// Every order, newest first. Amounts are in the order's currency, e.g. 250.00.
$('orders-csv-btn').addEventListener('click', () => {
  const amount = (c) => (c === null || c === undefined ? '' : (Number(c) / 100).toFixed(2));
  downloadCsv('ondroad-orders.csv', [['reference', 'email', 'package', 'tier', 'size', 'list', 'discount', 'code', 'amount', 'currency', 'status', 'paid_via', 'reserved_at', 'paid_at', 'picked_up_at', 'checked_in_at']].concat(
    orders.slice().sort((a, b) => b.id - a.id).map((o) => [o.reference_code, o.guest_email, o.package_name, o.tier_name, o.size, amount(o.list_cents ?? o.price_cents),
      amount(o.discount_cents || 0), o.promo_code, amount(amountOf(o)), o.currency, isRefundRequest(o) ? 'REFUND_REQUESTED' : o.status, o.paid_via,
      o.created_at, o.paid_at, o.picked_up_at, o.checked_in_at])));
});

const tick = () => { $('clock').textContent = new Date().toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Antigua' }); };
tick(); setInterval(tick, 15000);
refresh();
</script>
</body>
</html>`;

app.get('/admin', requireAdmin, (req, res) => res.send(ADMIN_PAGE));

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
