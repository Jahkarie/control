import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import pkg from 'pg';
const { Pool } = pkg;

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database Connection (Google Cloud SQL PostgreSQL)
const pool = new Pool({
  host: process.env.DB_HOST, // Google Cloud SQL Public IP
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'postgres',
  port: 20403,
  ssl: { rejectUnauthorized: false }
});

// Auto-initialize tables
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS guests (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(50) DEFAULT 'PENDING',
        shirt_size VARCHAR(20),
        invites_remaining INT DEFAULT 2
      );

      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT
      );
    `);
    console.log('Database tables ready.');
  } catch (err) {
    console.error('Database connection error:', err);
  }
};
initDB();

// Email Transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// --- API ENDPOINTS ---

app.get('/api/guest-status', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  try {
    const result = await pool.query('SELECT * FROM guests WHERE LOWER(email) = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(404).json({ authorized: false, error: 'Not invited' });
    }
    res.json({ authorized: true, guest: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/secure-package', async (req, res) => {
  const { email, shirtSize } = req.body;
  try {
    const result = await pool.query(
      "UPDATE guests SET shirt_size = $1, status = 'APPROVED' WHERE LOWER(email) = $2 RETURNING *",
      [shirtSize, (email || '').toLowerCase().trim()]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Guest not found' });
    }
    res.json({ success: true, guest: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/send-invite', async (req, res) => {
  const { inviterEmail, friendEmail, note } = req.body;
  const cleanInviter = (inviterEmail || '').toLowerCase().trim();
  const cleanFriend = (friendEmail || '').toLowerCase().trim();

  try {
    const inviterRes = await pool.query('SELECT * FROM guests WHERE LOWER(email) = $1', [cleanInviter]);
    const inviter = inviterRes.rows[0];

    if (!inviter || inviter.invites_remaining <= 0) {
      return res.status(400).json({ success: false, error: 'No invite clearance remaining.' });
    }

    // Deduct invite
    await pool.query('UPDATE guests SET invites_remaining = invites_remaining - 1 WHERE id = $1', [inviter.id]);

    // Add friend if not exists
    await pool.query(
      `INSERT INTO guests (email, status, invites_remaining) 
       VALUES ($1, 'PENDING', 2) 
       ON CONFLICT (email) DO NOTHING`,
      [cleanFriend]
    );

    const frontendUrl = process.env.FRONTEND_URL || 'https://your-frontend.onrender.com';
    const inviteUrl = `${frontendUrl}?email=${encodeURIComponent(cleanFriend)}`;

    await transporter.sendMail({
      from: `"CONTROL" <${process.env.EMAIL_USER}>`,
      to: cleanFriend,
      subject: 'CLEARANCE GRANTED: CONTROL ACCESS PASS',
      html: `<p>You have been invited to CONTROL! Access your pass: <a href="${inviteUrl}">${inviteUrl}</a></p>`
    });

    res.json({ success: true, remaining: inviter.invites_remaining - 1 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Error sending invitation.' });
  }
});

// --- ADMIN CONTROL PANEL ---

app.get('/admin', async (req, res) => {
  try {
    const guestsRes = await pool.query('SELECT * FROM guests ORDER BY id ASC');
    const guests = guestsRes.rows;

    const guestRows = guests.map((g, i) => `
      <tr>
        <td style="padding: 12px; border-bottom: 1px solid #222;">#${i + 1}</td>
        <td style="padding: 12px; border-bottom: 1px solid #222; font-weight: bold;">${g.email}</td>
        <td style="padding: 12px; border-bottom: 1px solid #222;">
          <span style="padding: 4px 10px; border-radius: 12px; font-size: 11px; font-weight: 800; ${
            g.status === 'APPROVED' ? 'background: rgba(0,240,255,0.1); color: #00f0ff;' : 'background: rgba(255,255,255,0.1); color: #888;'
          }">
            ${g.status}
          </span>
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #222; color: #00f0ff;">${g.shirt_size || 'Unassigned'}</td>
        <td style="padding: 12px; border-bottom: 1px solid #222; text-align: center;">${g.invites_remaining}</td>
        <td style="padding: 12px; border-bottom: 1px solid #222; text-align: right;">
          <form action="/admin/reset-invites" method="POST" style="display:inline;">
            <input type="hidden" name="email" value="${g.email}" />
            <button type="submit" style="background: #00f0ff; color: #000; border: none; padding: 6px 12px; border-radius: 6px; font-weight: bold; cursor: pointer;">
              Reset Invites (Set to 2)
            </button>
          </form>
        </td>
      </tr>
    `).join('');

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>CONTROL — Admin Command Center</title>
        <style>
          body { font-family: sans-serif; background: #080a0f; color: #fff; padding: 40px; max-width: 1000px; margin: 0 auto; }
          h1 { color: #00f0ff; letter-spacing: 2px; }
          .card { background: #111522; padding: 24px; border-radius: 12px; border: 1px solid rgba(0,240,255,0.2); margin-bottom: 30px; }
          input, button { padding: 10px 14px; border-radius: 6px; border: none; font-size: 14px; }
          input[type="email"] { width: 300px; background: #000; color: #fff; border: 1px solid #333; }
          table { width: 100%; border-collapse: collapse; text-align: left; }
          th { padding: 12px; border-bottom: 2px solid #333; color: #888; font-size: 12px; text-transform: uppercase; }
        </style>
      </head>
      <body>
        <h1>CONTROL COMMAND CENTER</h1>

        <div class="card">
          <h3>Add New Guest</h3>
          <form action="/admin/add-guest" method="POST" style="display: flex; gap: 10px;">
            <input type="email" name="email" placeholder="guest@domain.com" required />
            <button type="submit" style="background: #00f0ff; color: #000; font-weight: bold; cursor: pointer;">Authorize Guest</button>
          </form>
        </div>

        <div class="card">
          <h3>Guest Roster (${guests.length})</h3>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Email</th>
                <th>Status</th>
                <th>Shirt Size</th>
                <th style="text-align: center;">Invites Left</th>
                <th style="text-align: right;">Action</th>
              </tr>
            </thead>
            <tbody>
              ${guestRows.length > 0 ? guestRows : '<tr><td colspan="6" style="padding: 20px; text-align: center; color: #666;">No guests in database.</td></tr>'}
            </tbody>
          </table>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Error loading admin panel.');
  }
});

// Admin Reset Invites Action
app.post('/admin/reset-invites', async (req, res) => {
  const { email } = req.body;
  try {
    await pool.query('UPDATE guests SET invites_remaining = 2 WHERE LOWER(email) = $1', [email.toLowerCase().trim()]);
    res.redirect('/admin');
  } catch (err) {
    res.status(500).send('Database error resetting invites.');
  }
});

// Admin Add Guest Action
app.post('/admin/add-guest', async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  try {
    if (email) {
      await pool.query(
        `INSERT INTO guests (email, status, invites_remaining) 
         VALUES ($1, 'PENDING', 2) 
         ON CONFLICT (email) DO NOTHING`,
        [email]
      );
    }
    res.redirect('/admin');
  } catch (err) {
    res.status(500).send('Database error adding guest.');
  }
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
