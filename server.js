import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import pkg from 'pg';
import { Resend } from 'resend';

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
app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json({ limit: '10kb' }));

// --- VIP LOGIN ---
app.post('/api/login', rateLimit(10, 15 * 60 * 1000), async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required' });
  try {
    const result = await pool.query('SELECT * FROM guests WHERE LOWER(email) = $1', [email]);
    if (!result.rows.length) {
      return res.status(403).json({ error: 'ACCESS DENIED: Email not found on VIP roster.' });
    }
    const user = result.rows[0];
    res.json({ success: true, user, token: createToken(email) });
  } catch (err) {
    serverError(res, err);
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

// Returns an error object (or null). Never throws.
async function sendInviteEmail(to, from, note, link) {
  const noteHTML = note
    ? `<div style="background-color: #1a0a10; padding: 20px; border-left: 4px solid #f2c879; margin: 25px 0; border-radius: 4px;">
         <p style="color: #c7ad84; font-size: 12px; text-transform: uppercase; margin-top: 0;">Message from ${escapeHtml(from)}:</p>
         <p style="color: #fff4e0; font-style: italic; font-size: 16px; margin-bottom: 0;">"${escapeHtml(note)}"</p>
       </div>`
    : '';
  try {
    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: `[On D' Road] ${from} chose you as one of their invites`,
      html: `
        <div style="background-color: #080307; color: #fff4e0; padding: 40px 20px; font-family: 'Helvetica Neue', sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #3a1a22; border-radius: 12px;">
          <h1 style="color: #f2c879; letter-spacing: 4px; text-align: center;">ON D' ROAD</h1>
          <p style="font-size: 16px; text-align: center;">${escapeHtml(from)} chose you as one of their two invites.</p>
          <p style="font-size: 14px; text-align: center; color: #c7ad84;">This invitation is personal and single-use. Do not forward it.</p>
          ${noteHTML}
          <div style="text-align: center; margin-top: 35px;">
            <a href="${link}" style="display: inline-block; padding: 14px 28px; background: #f2c879; color: #1a0509; text-decoration: none; border-radius: 8px; font-weight: bold; letter-spacing: 1px;">ACCEPT YOUR INVITATION</a>
          </div>
        </div>`
    });
    return error || null;
  } catch (err) {
    return err;
  }
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
      return res.status(403).json({ error: 'Zero authorizations remaining.' });
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
<html>
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>On D' Road | Command Center</title>
<link href="https://fonts.googleapis.com/css2?family=Bowlby+One&family=Outfit:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  :root { --sun:#ffd400; --pink:#ff2e88; --teal:#00b8a9; --orange:#ff6b1a; --ink:#140b2e; --cream:#fff7e6; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Outfit', sans-serif; background: var(--cream); color: var(--ink); padding: 0 0 50px; }
  .top { background: var(--ink); color: var(--sun); padding: 18px 22px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
  .top h1 { font-family: 'Bowlby One', sans-serif; font-size: 24px; margin: 0; letter-spacing: 1px; }
  .top span { color: #fff; font-weight: 700; font-size: 13px; }
  .bunting { height: 30px; background: url('data:image/svg+xml;utf8,<svg width="130" height="30" xmlns="http://www.w3.org/2000/svg"><polygon points="0,0 32,0 16,28" fill="%23ff2e88"/><polygon points="32,0 65,0 48,28" fill="%23ffd400"/><polygon points="65,0 97,0 81,28" fill="%2300b8a9"/><polygon points="97,0 130,0 113,28" fill="%23ff6b1a"/></svg>') repeat-x; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 22px 16px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin-bottom: 22px; }
  .stat { border: 3px solid var(--ink); border-radius: 20px; padding: 16px; box-shadow: 5px 5px 0 var(--ink); animation: pop .5s both; }
  .stat b { font-family: 'Bowlby One', sans-serif; font-size: 38px; display: block; line-height: 1; }
  .stat small { font-weight: 800; letter-spacing: 1px; font-size: 11px; text-transform: uppercase; }
  .stat:nth-child(1) { background: var(--pink); color: #fff; } .stat:nth-child(2) { background: var(--teal); }
  .stat:nth-child(3) { background: var(--sun); } .stat:nth-child(4) { background: var(--orange); }
  .stat:nth-child(5) { background: #fff; } .stat:nth-child(6) { background: #fff; }
  .panel { background: #fff; border: 3px solid var(--ink); border-radius: 22px; padding: 18px; margin-bottom: 22px; box-shadow: 6px 6px 0 var(--pink); }
  .panel h3 { font-family: 'Bowlby One', sans-serif; margin: 0 0 12px; font-size: 16px; text-transform: uppercase; }
  .bars div { display: flex; align-items: center; gap: 10px; margin: 8px 0; font-weight: 800; font-size: 13px; }
  .bars em { display: block; height: 22px; background: var(--teal); border: 2px solid var(--ink); border-radius: 12px; width: 0; transition: width 1s cubic-bezier(.2,.9,.3,1.1); min-width: 4px; }
  .bars span { width: 90px; } .bars i { font-style: normal; }
  .tabs { display: flex; gap: 10px; margin-bottom: 14px; }
  .tab { border: 3px solid var(--ink); background: #fff; border-radius: 999px; padding: 10px 22px; font-weight: 800; cursor: pointer; font-family: 'Outfit', sans-serif; }
  .tab.on { background: var(--ink); color: #fff; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
  input, select { padding: 11px 14px; border: 3px solid var(--ink); border-radius: 14px; font-size: 14px; font-family: 'Outfit', sans-serif; background: var(--cream); min-width: 0; }
  .btn { background: var(--ink); color: #fff; border: 3px solid var(--ink); border-radius: 999px; padding: 9px 16px; font-weight: 800; cursor: pointer; font-family: 'Outfit', sans-serif; font-size: 13px; transition: transform .15s, box-shadow .15s; }
  .btn:hover { transform: translate(-2px,-2px); box-shadow: 3px 3px 0 var(--pink); }
  .btn.alt { background: #fff; color: var(--ink); } .btn.bad { background: #fff; color: #c0153d; border-color: #c0153d; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; padding: 10px; border-bottom: 3px solid var(--ink); }
  td { padding: 10px; border-bottom: 1px solid #eadfc8; vertical-align: middle; } tbody tr { animation: pop .4s both; }
  .pill { border: 2px solid var(--ink); border-radius: 999px; padding: 3px 10px; font-weight: 800; font-size: 11px; display: inline-block; }
  .CONFIRMED, .ACCEPTED { background: #b6f5d4; } .PENDING { background: #ffe07a; } .REVOKED { background: #ffc2c2; }
  #msg { font-weight: 700; word-break: break-all; margin: 6px 0 0; }
  .hidden { display: none; }
  @keyframes pop { from { opacity: 0; transform: translateY(16px) scale(.96); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>
</head>
<body>
<div class="top"><h1>ON D' ROAD · COMMAND CENTER</h1><span id="clock"></span></div>
<div class="bunting"></div>
<div class="wrap">
  <div class="stats" id="stats"></div>

  <div class="panel"><h3>Shirt sizes</h3><div class="bars" id="bars"></div></div>

  <div class="panel">
    <h3>Add people</h3>
    <div class="row">
      <input type="email" id="new-email" placeholder="Add straight to roster..." style="flex:1; min-width:200px;">
      <button class="btn" id="add-btn">Add to roster</button>
    </div>
    <div class="row">
      <input type="email" id="inv-email" placeholder="Create a personal invite link..." style="flex:1; min-width:200px;">
      <button class="btn" id="inv-btn">Create link</button>
    </div>
    <p id="msg"></p>
  </div>

  <div class="tabs"><button class="tab on" id="tab-g">Guests</button><button class="tab" id="tab-i">Invites</button></div>

  <div class="panel" id="guests-panel">
    <div class="row">
      <input id="search" placeholder="Search email..." style="flex:1; min-width:160px;">
      <select id="filter"><option value="">All RSVPs</option><option value="CONFIRMED">Confirmed</option><option value="PENDING">Pending</option></select>
      <button class="btn alt" id="csv-btn">Export CSV</button>
    </div>
    <div class="scroll"><table><thead><tr><th>#</th><th>Email</th><th>RSVP</th><th>Shirt</th><th>Invites left</th><th>Actions</th></tr></thead><tbody id="roster"></tbody></table></div>
  </div>

  <div class="panel hidden" id="invites-panel">
    <div class="scroll"><table><thead><tr><th>Invited</th><th>By</th><th>Status</th><th>Sent</th><th>Action</th></tr></thead><tbody id="invlist"></tbody></table></div>
  </div>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  let guests = [], invites = [];
  async function api(path, body) {
    const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined;
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
    return data;
  }
  function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
  function td(tr, text) { const c = el('td', text); tr.appendChild(c); return c; }
  function pill(text, cls) { return el('span', text, 'pill ' + cls); }
  function btn(label, cls, fn) { const b = el('button', label, 'btn ' + cls); b.addEventListener('click', async () => { try { await fn(); await load(); } catch (e) { alert(e.message); } }); return b; }

  function renderStats() {
    const sum = (f) => guests.filter(f).length;
    const items = [
      ['Guests', guests.length], ['Confirmed', sum((g) => g.rsvp_status === 'CONFIRMED')],
      ['Shirts claimed', sum((g) => g.shirt_size && g.shirt_size !== 'Unassigned')],
      ['Invites pending', invites.filter((i) => i.status === 'PENDING').length],
      ['Invites accepted', invites.filter((i) => i.status === 'ACCEPTED').length],
      ['Invites unused', guests.reduce((a, g) => a + (g.invites_left || 0), 0)]
    ];
    const box = $('stats'); box.replaceChildren();
    items.forEach(([label, n], i) => { const d = el('div', undefined, 'stat'); d.style.animationDelay = (i * 0.07) + 's'; d.appendChild(el('b', n)); d.appendChild(el('small', label)); box.appendChild(d); });
    const sizes = ['S', 'M', 'L', 'XL', 'Unassigned'];
    const counts = sizes.map((z) => guests.filter((g) => (g.shirt_size || 'Unassigned') === z).length);
    const max = Math.max(1, ...counts);
    const bars = $('bars'); bars.replaceChildren();
    sizes.forEach((z, i) => { const row = el('div'); row.appendChild(el('span', z)); const bar = el('em'); row.appendChild(bar); row.appendChild(el('i', counts[i])); bars.appendChild(row); setTimeout(() => { bar.style.width = (counts[i] / max * 70) + '%'; }, 60); });
  }

  function renderGuests() {
    const q = $('search').value.trim().toLowerCase(), f = $('filter').value;
    const tbody = $('roster'); tbody.replaceChildren();
    guests.filter((g) => g.email.toLowerCase().includes(q) && (!f || (g.rsvp_status || 'PENDING') === f)).forEach((g, i) => {
      const tr = el('tr'); tr.style.animationDelay = Math.min(i * 0.03, 0.5) + 's';
      td(tr, i + 1); td(tr, g.email).style.fontWeight = '700';
      td(tr, '').appendChild(pill(g.rsvp_status || 'PENDING', g.rsvp_status || 'PENDING'));
      td(tr, g.shirt_size || 'Unassigned'); td(tr, g.invites_left);
      const act = td(tr, '');
      act.appendChild(btn('Set invites', 'alt', async () => { const v = prompt('Invites for ' + g.email + ' (0-20):', g.invites_left); if (v === null) throw new Error('Cancelled'); await api('/api/admin/set-invites', { email: g.email, count: v }); }));
      act.appendChild(document.createTextNode(' '));
      act.appendChild(btn('Remove', 'bad', async () => { if (!confirm('Remove ' + g.email + ' from the roster?')) throw new Error('Cancelled'); await api('/api/admin/remove-guest', { email: g.email }); }));
      tbody.appendChild(tr);
    });
  }

  function renderInvites() {
    const tbody = $('invlist'); tbody.replaceChildren();
    invites.forEach((v, i) => {
      const tr = el('tr'); tr.style.animationDelay = Math.min(i * 0.03, 0.5) + 's';
      td(tr, v.invitee_email).style.fontWeight = '700'; td(tr, v.inviter_email);
      td(tr, '').appendChild(pill(v.status, v.status));
      td(tr, new Date(v.created_at).toLocaleString());
      const act = td(tr, '');
      if (v.status === 'PENDING') act.appendChild(btn('Revoke', 'bad', async () => { if (!confirm('Revoke this invite?')) throw new Error('Cancelled'); await api('/api/admin/revoke-invite', { id: v.id }); }));
      tbody.appendChild(tr);
    });
  }

  async function load() {
    try { [guests, invites] = await Promise.all([api('/api/admin/guests'), api('/api/admin/invites')]); }
    catch (e) { if (e.message !== 'Cancelled') alert(e.message); return; }
    renderStats(); renderGuests(); renderInvites();
  }

  $('search').addEventListener('input', renderGuests); $('filter').addEventListener('change', renderGuests);
  $('tab-g').addEventListener('click', () => { $('guests-panel').classList.remove('hidden'); $('invites-panel').classList.add('hidden'); $('tab-g').classList.add('on'); $('tab-i').classList.remove('on'); });
  $('tab-i').addEventListener('click', () => { $('invites-panel').classList.remove('hidden'); $('guests-panel').classList.add('hidden'); $('tab-i').classList.add('on'); $('tab-g').classList.remove('on'); });
  $('add-btn').addEventListener('click', async () => {
    const email = $('new-email').value.trim(); if (!email) return;
    try { await api('/api/admin/add-guest', { email }); $('new-email').value = ''; $('msg').textContent = 'Added ' + email; load(); } catch (e) { alert(e.message); }
  });
  $('inv-btn').addEventListener('click', async () => {
    const email = $('inv-email').value.trim(); if (!email) return;
    try { const r = await api('/api/admin/create-invite', { email }); $('msg').textContent = (r.emailed ? 'Emailed. ' : 'Email not sent, share this link yourself: ') + r.link; $('inv-email').value = ''; load(); } catch (e) { alert(e.message); }
  });
  $('csv-btn').addEventListener('click', () => {
    const NL = String.fromCharCode(10), q = (v) => '"' + String(v === null || v === undefined ? '' : v).split('"').join('""') + '"';
    const rows = [['email', 'rsvp', 'shirt', 'invites_left']].concat(guests.map((g) => [g.email, g.rsvp_status, g.shirt_size, g.invites_left]));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([rows.map((r) => r.map(q).join(',')).join(NL)], { type: 'text/csv' }));
    a.download = 'ondroad-guests.csv'; a.click();
  });
  setInterval(() => { $('clock').textContent = new Date().toLocaleString(); }, 1000);
  load();
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
app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
