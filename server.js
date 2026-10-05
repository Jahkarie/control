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
      subject: `[CONTROL] ${from} chose you as one of their invites`,
      html: `
        <div style="background-color: #080307; color: #fff4e0; padding: 40px 20px; font-family: 'Helvetica Neue', sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #3a1a22; border-radius: 12px;">
          <h1 style="color: #f2c879; letter-spacing: 4px; text-align: center;">CONTROL</h1>
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
    const emailed = !(await sendInviteEmail(email, 'CONTROL', note, link));
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

app.get('/admin', requireAdmin, (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>CONTROL COMMAND CENTER</title>
  <style>
    body { background: #080b10; color: #e2e8f0; font-family: monospace; padding: 20px; }
    h1 { color: #00f0ff; text-align: center; }
    .metrics { display: flex; gap: 15px; margin-bottom: 25px; }
    .card { background: #0f172a; border: 1px solid #1e293b; padding: 15px; flex: 1; border-radius: 8px; text-align: center; }
    .card h2 { margin: 0; color: #00f0ff; font-size: 28px; }
    table { width: 100%; border-collapse: collapse; background: #0f172a; border-radius: 8px; overflow: hidden; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #1e293b; }
    th { background: #1e293b; color: #94a3b8; }
    .btn { background: #00f0ff; color: #000; font-weight: bold; border: none; padding: 6px 12px; cursor: pointer; border-radius: 4px; }
    .btn:hover { background: #00c8ff; }
    input { background: #020617; border: 1px solid #334155; color: #fff; padding: 8px; border-radius: 4px; }
    .badge-confirmed { color: #00ff88; font-weight: bold; }
    .badge-pending { color: #ffaa00; }
  </style>
</head>
<body>
  <h1>CONTROL COMMAND CENTER</h1>
  <div class="metrics">
    <div class="card"><p>Total Guests</p><h2 id="total-guests">0</h2></div>
    <div class="card"><p>Confirmed RSVPs</p><h2 id="confirmed-rsvp">0</h2></div>
    <div class="card"><p>Shirts Claimed</p><h2 id="shirts-claimed">0</h2></div>
  </div>
  <div style="background: #0f172a; padding: 15px; border-radius: 8px; margin-bottom: 25px;">
    <h3>Authorize New Guest</h3>
    <input type="email" id="new-email" placeholder="guest@domain.com" style="width: 300px;">
    <button class="btn" id="add-btn">Authorize Guest</button>
  </div>
  <div style="background: #0f172a; padding: 15px; border-radius: 8px; margin-bottom: 25px;">
    <h3>Create Personal Invite Link</h3>
    <input type="email" id="inv-email" placeholder="guest@domain.com" style="width: 300px;">
    <button class="btn" id="inv-btn">Create Link</button>
    <p id="inv-out" style="word-break: break-all;"></p>
  </div>
  <h3>Guest Roster</h3>
  <table>
    <thead><tr><th>#</th><th>Email</th><th>RSVP Status</th><th>Shirt Size</th><th>Invites Remaining</th><th>Action</th></tr></thead>
    <tbody id="roster"></tbody>
  </table>
  <script>
    const $ = (id) => document.getElementById(id);
    async function api(path, body) {
      const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined;
      const res = await fetch(path, opts);
      if (!res.ok) throw new Error('Request failed (' + res.status + ')');
      return res.json();
    }
    function cell(tr, text, cls) {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      tr.appendChild(td);
      return td;
    }
    async function loadData() {
      try {
        const data = await api('/api/admin/guests');
        $('total-guests').textContent = data.length;
        $('confirmed-rsvp').textContent = data.filter((g) => g.rsvp_status === 'CONFIRMED').length;
        $('shirts-claimed').textContent = data.filter((g) => g.shirt_size && g.shirt_size !== 'Unassigned').length;
        const tbody = $('roster');
        tbody.replaceChildren();
        data.forEach((g, i) => {
          const tr = document.createElement('tr');
          cell(tr, '#' + (i + 1));
          cell(tr, g.email).style.fontWeight = 'bold';
          cell(tr, g.rsvp_status || 'PENDING', g.rsvp_status === 'CONFIRMED' ? 'badge-confirmed' : 'badge-pending');
          cell(tr, g.shirt_size || 'Unassigned');
          cell(tr, g.invites_left);
          const td = document.createElement('td');
          const btn = document.createElement('button');
          btn.className = 'btn';
          btn.textContent = 'Reset Invites (Set to 2)';
          btn.addEventListener('click', async () => {
            try { await api('/api/admin/reset-invites', { email: g.email }); loadData(); } catch (e) { alert(e.message); }
          });
          td.appendChild(btn);
          tr.appendChild(td);
          tbody.appendChild(tr);
        });
      } catch (e) { alert(e.message); }
    }
    $('add-btn').addEventListener('click', async () => {
      const email = $('new-email').value.trim();
      if (!email) return;
      try { await api('/api/admin/add-guest', { email }); $('new-email').value = ''; loadData(); } catch (e) { alert(e.message); }
    });
    $('inv-btn').addEventListener('click', async () => {
      const email = $('inv-email').value.trim();
      if (!email) return;
      try {
        const r = await api('/api/admin/create-invite', { email });
        $('inv-out').textContent = (r.emailed ? 'Emailed. ' : 'Email not sent, share this link yourself: ') + r.link;
        $('inv-email').value = '';
      } catch (e) { alert(e.message); }
    });
    loadData();
  </script>
</body>
</html>`);
});

// Malformed JSON and other uncaught errors
app.use((err, req, res, next) => {
  if (err.status !== 400) console.error(err);
  res.status(err.status === 400 ? 400 : 500).json({ error: err.status === 400 ? 'Invalid request body.' : 'Server error.' });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
