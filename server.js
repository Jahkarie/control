import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import pkg from 'pg';
import { Resend } from 'resend';
import { registerPayments } from './payments.js';
import { renderEmail } from './emails.js';
import { registerDoor } from './door.js';
import { registerEvent } from './event.js';

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

// Simple in-memory fixed-window rate limiter, per IP.
const rateLimit = (max, windowMs) => {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const n = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, n);
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
app.use(express.json({ limit: '10kb' }));

// Payment instructions, pay-by deadline, auto-expiry and reminders (see payments.js).
// Registered before the other routes on purpose: it replaces /api/my-order below.
const mail = registerPayments({ app, pool, resend, EMAIL_FROM, FRONTEND_URL, requireAuth, requireAdmin, escapeHtml });
// Event details in guests' accounts and email updates to groups of guests (see event.js).
registerEvent({ app, pool, resend, EMAIL_FROM, FRONTEND_URL, requireAuth, requireAdmin, mail });
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
  `);
}

// --- VIP LOGIN: step 1, request a one-time link ---
// Always returns the same generic response whether or not the email is on the roster,
// so this endpoint can't be used to check who is or isn't invited.
app.post('/api/login', rateLimit(6, 15 * 60 * 1000), async (req, res) => {
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
app.post('/api/login/verify', rateLimit(15, 15 * 60 * 1000), async (req, res) => {
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
  if (!rsvp_status || rsvp_status.length > 20) return res.status(400).json({ error: 'Invalid RSVP status.' });
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
app.post('/api/send-invite', requireAuth, rateLimit(20, 60 * 60 * 1000), async (req, res) => {
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
app.get('/api/invite/:token', rateLimit(30, 15 * 60 * 1000), async (req, res) => {
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
app.post('/api/invite/accept', rateLimit(10, 15 * 60 * 1000), async (req, res) => {
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
app.get('/api/packages', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.id, p.name, p.price_cents, p.currency, p.includes, p.requires_compliance, p.capacity,
              GREATEST(0, COALESCE(p.capacity, 2147483647) - (SELECT COUNT(*) FROM orders o WHERE o.package_id = p.id AND o.status <> 'CANCELLED')) AS spots_left
       FROM packages p WHERE p.active = TRUE ORDER BY p.sort_order ASC, p.id ASC`);
    res.json(r.rows);
  } catch (err) {
    serverError(res, err);
  }
});

app.get('/api/admin/packages', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.*, (SELECT COUNT(*) FROM orders o WHERE o.package_id = p.id AND o.status <> 'CANCELLED') AS claimed
       FROM packages p ORDER BY p.sort_order ASC, p.id ASC`);
    res.json(r.rows);
  } catch (err) {
    serverError(res, err);
  }
});

app.post('/api/admin/packages', requireAdmin, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : '';
  const price = parseInt(req.body?.price_cents, 10);
  const includes = typeof req.body?.includes === 'string' ? req.body.includes.slice(0, 1000) : '';
  const requiresCompliance = !!req.body?.requires_compliance;
  const capacity = req.body?.capacity === '' || req.body?.capacity == null ? null : parseInt(req.body.capacity, 10);
  const sortOrder = parseInt(req.body?.sort_order, 10) || 0;
  const currency = ['XCD', 'USD'].includes(req.body?.currency) ? req.body.currency : 'XCD';
  if (!name || !Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'A name and a valid price (in cents) are required.' });
  try {
    const r = await pool.query(
      `INSERT INTO packages (name, price_cents, currency, includes, requires_compliance, capacity, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [name, price, currency, includes, requiresCompliance, capacity, sortOrder]);
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) {
    serverError(res, err);
  }
});

app.post('/api/admin/packages/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fields = []; const values = []; let i = 1;
  const push = (col, val) => { fields.push(`${col} = $${i++}`); values.push(val); };
  if (typeof req.body?.name === 'string') push('name', req.body.name.trim().slice(0, 80));
  if (req.body?.price_cents !== undefined) push('price_cents', parseInt(req.body.price_cents, 10) || 0);
  if (typeof req.body?.includes === 'string') push('includes', req.body.includes.slice(0, 1000));
  if (req.body?.requires_compliance !== undefined) push('requires_compliance', !!req.body.requires_compliance);
  if (req.body?.capacity !== undefined) push('capacity', req.body.capacity === '' || req.body.capacity == null ? null : parseInt(req.body.capacity, 10));
  if (req.body?.active !== undefined) push('active', !!req.body.active);
  if (req.body?.sort_order !== undefined) push('sort_order', parseInt(req.body.sort_order, 10) || 0);
  if (!id || !fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  try {
    await pool.query(`UPDATE packages SET ${fields.join(', ')} WHERE id = $${i}`, [...values, id]);
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
      `SELECT o.id, o.status, o.reference_code, o.created_at, p.name AS package_name, p.price_cents, p.currency, p.includes
       FROM orders o JOIN packages p ON p.id = o.package_id
       WHERE o.guest_email = $1 AND o.status <> 'CANCELLED' ORDER BY o.id DESC LIMIT 1`, [req.userEmail]);
    res.json(r.rows[0] || null);
  } catch (err) {
    serverError(res, err);
  }
});

app.post('/api/orders', requireAuth, rateLimit(10, 60 * 60 * 1000), async (req, res) => {
  const packageId = parseInt(req.body?.package_id, 10);
  if (!packageId) return res.status(400).json({ error: 'Choose a package.' });
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
    const pkg = await client.query('SELECT name, price_cents, currency, capacity, active FROM packages WHERE id = $1 FOR UPDATE', [packageId]);
    if (!pkg.rowCount || !pkg.rows[0].active) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'That package is no longer available.' });
    }
    if (pkg.rows[0].capacity !== null) {
      const claimed = await client.query("SELECT COUNT(*) FROM orders WHERE package_id = $1 AND status <> 'CANCELLED'", [packageId]);
      if (parseInt(claimed.rows[0].count, 10) >= pkg.rows[0].capacity) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'That package just sold out.' });
      }
    }
    const ref = newRef();
    const created = await client.query(
      'INSERT INTO orders (guest_email, package_id, reference_code) VALUES ($1, $2, $3) RETURNING created_at',
      [req.userEmail, packageId, ref]);
    await client.query('COMMIT');
    res.json({ success: true, reference_code: ref });
    // Sent after responding so a slow email never holds up the guest.
    const p = pkg.rows[0];
    sendOrderReceivedEmail(req.userEmail, p.name, money(p.price_cents, p.currency), ref, created.rows[0].created_at)
      .catch((e) => console.error('Order-received email error:', e));
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    serverError(res, err);
  } finally {
    client?.release();
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
app.post('/api/orders/request-refund', requireAuth, rateLimit(5, 60 * 60 * 1000), async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
  try {
    const r = await pool.query(
      `UPDATE orders SET cancel_requested_at = NOW(), cancel_reason = $2
       WHERE guest_email = $1 AND status = 'PAID' AND cancel_requested_at IS NULL
       RETURNING reference_code, (SELECT name FROM packages WHERE id = orders.package_id) AS package_name`, [req.userEmail, reason]);
    if (!r.rowCount) return res.status(400).json({ error: 'No paid order to cancel, or a request is already open.' });
    res.json({ success: true });
    const o = r.rows[0];
    mail.send(req.userEmail, "Refund request received — On D' Road", renderEmail({
      tone: 'warn', tag: 'Request received', title: 'We got your request',
      lines: [`You asked to cancel ${o.package_name} and get your money back.`,
        "We'll email you when your refund is approved, with how to collect it. Your pass keeps working until then."],
      details: [['Package', o.package_name], ['Reference', o.reference_code, true]],
      cta: { text: 'Open my account', url: FRONTEND_URL },
      fine: 'Changed your mind? You can withdraw the request from your account.'
    }));
    if (ADMIN_EMAIL) {
      mail.send(ADMIN_EMAIL, `Refund requested: ${o.reference_code}`, renderEmail({
        tone: 'warn', tag: 'Refund request', title: 'Action needed',
        lines: [`${req.userEmail} wants to cancel ${o.package_name} and get a refund.`,
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
              o.cancel_requested_at, o.cancel_reason, o.refunded_at, o.checked_in_at, o.checked_in_by,
              p.name AS package_name, p.price_cents, p.currency
       FROM orders o JOIN packages p ON p.id = o.package_id
       ORDER BY (o.status = 'PAID' AND o.cancel_requested_at IS NOT NULL) DESC, o.id DESC`);
    res.json(r.rows);
  } catch (err) {
    serverError(res, err);
  }
});

const money = (cents, cur) => (cur || 'XCD') + ' ' + (cents / 100).toFixed(2);

async function sendOrderReceivedEmail(to, packageName, price, ref, createdAt) {
  const { instructions, payDays } = await mail.getSettings();
  const due = payDays > 0 ? mail.fmt(mail.payBy(createdAt, payDays)) : null;
  return mail.send(to, "Order received — On D' Road", renderEmail({
    tone: 'warn', tag: 'Order received', title: 'Your spot is held',
    preheader: due ? `Pay by ${due} to confirm your spot.` : 'Your spot is held until you pay.',
    lines: [`You reserved ${packageName}. Your spot is confirmed once you pay.`,
      'Your entry pass shows up in your account as soon as your payment is received.'],
    details: [['Package', packageName], ['Amount', price], ['Reference', ref, true], ['Pay by', due]],
    callout: instructions ? { label: 'How to pay', text: instructions } : null,
    cta: { text: 'View my order', url: FRONTEND_URL },
    fine: due
      ? 'Bring your reference code when you pay. Unpaid reservations are cancelled automatically after the deadline.'
      : 'Bring your reference code when you pay.'
  }));
}

async function sendPaidEmail(to, packageName, ref) {
  return mail.send(to, "You're confirmed — On D' Road", renderEmail({
    tone: 'good', tag: 'Payment confirmed', title: "You're in",
    preheader: 'Payment received. Your entry pass is ready.',
    lines: ['Payment received. Your spot is confirmed.',
      'Your entry pass is in your account. Final event details, location and package pickup info will follow closer to the date.'],
    details: [['Package', packageName], ['Reference', ref, true]],
    cta: { text: 'View my pass', url: FRONTEND_URL }
  }));
}

app.post('/api/admin/orders/:id/mark-paid', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const r = await pool.query(
      `UPDATE orders SET status = 'PAID', paid_at = NOW() WHERE id = $1 AND status = 'RESERVED'
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
app.post('/api/admin/orders/:id/approve-refund', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const r = await pool.query(
      `UPDATE orders o SET status = 'CANCELLED', refunded_at = NOW() FROM packages p
       WHERE o.id = $1 AND p.id = o.package_id AND o.status = 'PAID'
       RETURNING o.guest_email, o.reference_code, p.name AS package_name, p.price_cents, p.currency`, [id]);
    if (!r.rowCount) return res.status(400).json({ error: 'Order not found or not paid.' });
    const o = r.rows[0];
    const emailError = await mail.send(o.guest_email, "Refund approved — On D' Road", renderEmail({
      tone: 'good', tag: 'Refund approved', title: 'Refund approved',
      lines: [`Your order for ${o.package_name} is cancelled and your refund is approved.`,
        'Refunds are paid in cash where you paid. Bring your reference code. Your entry pass no longer works.'],
      details: [['Package', o.package_name], ['Refund', money(o.price_cents, o.currency)], ['Reference', o.reference_code, true]]
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
  try {
    await pool.query('DELETE FROM guests WHERE LOWER(email) = $1', [email]);
    res.json({ success: true });
  } catch (err) {
    serverError(res, err);
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
.create-grid textarea { grid-column: 1 / -1; }
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
    <a class="top-link" href="/admin/event">Event &amp; messages</a>
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
      </div>
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
      <select id="order-filter" aria-label="Order status filter"><option value="">All orders</option><option value="REFUND">Refund requests</option><option value="RESERVED">Awaiting payment</option><option value="PAID">Paid</option><option value="CHECKED">Checked in</option><option value="CANCELLED">Cancelled</option></select>
    </div>
    <div class="scroll"><table class="cards"><thead><tr><th>Guest</th><th>Package</th><th class="num">Amount</th><th>Status</th><th>Reference</th><th>Reserved</th><th></th></tr></thead><tbody id="orderlist"></tbody></table></div>
  </section>
  <section class="panel hidden" id="door-panel" role="tabpanel">
    <div class="toolbar">
      <input id="door-search" class="grow" placeholder="Search email or reference" type="search">
      <select id="door-filter" aria-label="Door event filter"><option value="">All door activity</option><option value="ENTRY">Entries</option><option value="OVERRIDE">Overrides</option><option value="DUPLICATE">Blocked repeat scans</option><option value="UNDO">Undone</option></select>
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
function latestOrderFor(email) {
  const e = String(email).toLowerCase();
  return orders.find((o) => String(o.guest_email).toLowerCase() === e && o.status !== 'CANCELLED') || null;
}
function totals(list) {
  const t = {};
  list.forEach((o) => { const c = o.currency || 'XCD'; t[c] = (t[c] || 0) + Number(o.price_cents); });
  const keys = Object.keys(t);
  return keys.length ? keys.map((c) => money(t[c], c)).join(' + ') : money(0, 'XCD');
}
function orderPill(o) {
  if (!o) return pill('None', 'neutral');
  if (isRefundRequest(o)) return pill('Refund requested', 'warn');
  if (o.status === 'PAID') return pill('Paid', 'good');
  if (o.status === 'RESERVED') return pill('Awaiting payment', 'warn');
  if (o.status === 'CANCELLED' && o.refunded_at) return pill('Refunded', 'bad');
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
    { label: 'Collected', value: totals(paid), sub: 'From paid orders', money: true },
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
      const v = await ask({ title: 'Remove guest?', text: g.email + ' will be taken off the roster and can no longer log in.', ok: 'Remove', danger: true });
      if (!v) return false;
      await api('/api/admin/remove-guest', { email: g.email });
      return 'Guest removed.';
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
    if (meta.length) name.appendChild(el('span', meta.join(' · '), 'subtext'));
    td(tr, money(p.price_cents, p.currency), 'num');
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
    act.appendChild(actionBtn('Edit', 'ghost', async () => {
      const v = await ask({ title: 'Edit package', ok: 'Save changes', fields: [
        { name: 'name', label: 'Name', value: p.name, required: true },
        { name: 'price', label: 'Price (' + (p.currency || 'XCD') + ')', type: 'number', step: '0.01', min: 0, value: (p.price_cents / 100).toFixed(2), required: true },
        { name: 'capacity', label: 'Capacity (blank = no limit)', type: 'number', min: 1, value: p.capacity },
        { name: 'includes', label: "What's included (one per line)", type: 'textarea', value: p.includes },
        { name: 'requires_compliance', label: 'Requires costume compliance', type: 'checkbox', value: p.requires_compliance }
      ] });
      if (!v) return false;
      const price = parseFloat(v.price);
      if (!v.name.trim() || !(price >= 0)) throw new Error('Name and a valid price are required.');
      await api('/api/admin/packages/' + p.id, { name: v.name, price_cents: Math.round(price * 100), capacity: v.capacity, includes: v.includes, requires_compliance: v.requires_compliance });
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

function renderOrders() {
  const f = $('order-filter').value, q = $('order-search').value.trim().toLowerCase();
  const tbody = $('orderlist'); tbody.replaceChildren();
  const list = orders.filter((o) => (!f || (f === 'REFUND' ? isRefundRequest(o) : f === 'CHECKED' ? !!o.checked_in_at : o.status === f)) &&
    (String(o.guest_email).toLowerCase().includes(q) || String(o.reference_code).toLowerCase().includes(q)));
  if (!list.length) return emptyRow(tbody, 7, orders.length ? 'No orders match.' : 'No orders yet.');
  list.forEach((o) => {
    const tr = el('tr');
    td(tr, o.guest_email, 'strong');
    td(tr, o.package_name);
    td(tr, money(o.price_cents, o.currency), 'num');
    const st = td(tr, '');
    st.appendChild(orderPill(o));
    if (isRefundRequest(o)) {
      st.appendChild(el('span', 'Requested ' + shortDate(o.cancel_requested_at) + (o.cancel_reason ? ': ' + o.cancel_reason : ''), 'subtext'));
    } else if (o.status === 'PAID' && o.paid_at && !o.checked_in_at) {
      st.appendChild(el('span', 'Paid ' + shortDate(o.paid_at), 'subtext'));
    }
    if (o.checked_in_at) st.appendChild(el('span', 'Checked in ' + timeOf(o.checked_in_at) + (o.checked_in_by ? ' · ' + o.checked_in_by : ''), 'subtext'));
    td(tr, o.reference_code, 'mono');
    const when = td(tr, shortDate(o.created_at), 'mono'); when.title = longDate(o.created_at);
    const act = td(tr, '', 'actions');
    if (o.status === 'RESERVED') {
      act.appendChild(actionBtn('Mark paid', 'good', async () => {
        const v = await ask({ title: 'Mark as paid?', text: money(o.price_cents, o.currency) + ' from ' + o.guest_email + ' (' + o.reference_code + '). They get a confirmation email and their entry pass.', ok: 'Mark paid' });
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
      const req = isRefundRequest(o);
      act.appendChild(actionBtn(req ? 'Approve refund' : 'Cancel + refund', req ? '' : 'danger', async () => {
        const inAlready = o.checked_in_at ? 'Heads up: they already checked in at the door (' + timeOf(o.checked_in_at) + '). ' : '';
        const v = await ask({ title: req ? 'Approve this refund?' : 'Cancel and refund?', text: inAlready + 'Cancels the order and records a refund of ' + money(o.price_cents, o.currency) + ' to ' + o.guest_email + '. Their entry pass stops working right away.', ok: req ? 'Approve refund' : 'Cancel and refund', danger: true });
        if (!v) return false;
        await api('/api/admin/orders/' + o.id + '/approve-refund', {});
        return 'Refund recorded. The guest has been emailed.';
      }));
    }
    tbody.appendChild(tr);
  });
  labelCells(tbody);
}

const DOOR_EVENTS = { ENTRY: ['Entry', 'good'], OVERRIDE: ['Override', 'warn'], DUPLICATE: ['Blocked repeat', 'bad'], UNDO: ['Undone', 'neutral'] };
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
      requires_compliance: $('p-compliance').checked, capacity: $('p-capacity').value || null
    });
    ['p-name', 'p-price', 'p-includes', 'p-capacity'].forEach((id) => { $(id).value = ''; });
    toast('Package created.');
    await refresh();
  } catch (err) { toast(err.message, true); }
});

$('csv-btn').addEventListener('click', () => {
  const q = (v) => '"' + String(v === null || v === undefined ? '' : v).split('"').join('""') + '"';
  const rows = [['email', 'attendance', 'invites_left', 'package', 'order_status', 'reference', 'checked_in_at']].concat(guests.map((g) => {
    const o = latestOrderFor(g.email);
    return [g.email, g.rsvp_status || 'PENDING', g.invites_left, o ? o.package_name : '', o ? (isRefundRequest(o) ? 'REFUND_REQUESTED' : o.status) : '', o ? o.reference_code : '', o && o.checked_in_at ? o.checked_in_at : ''];
  }));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.map((r) => r.map(q).join(',')).join(NL)], { type: 'text/csv' }));
  a.download = 'ondroad-guests.csv'; a.click();
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
  .finally(() => app.listen(PORT, () => console.log(`Server live on port ${PORT}`)));
