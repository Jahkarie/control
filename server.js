import express from 'express';
import cors from 'cors';
import pkg from 'pg';
const { Pool } = pkg;
import { Resend } from 'resend';

const app = express();
app.use(cors());
app.use(express.json());

const resend = new Resend(process.env.EMAIL_PASS);

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER || 'avnadmin',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'defaultdb',
  port: parseInt(process.env.DB_PORT || '25432', 10),
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 5000
});

// --- VIP LOGIN CHECK ---
app.post('/api/login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const cleanEmail = email.trim().toLowerCase();
    const result = await pool.query('SELECT * FROM guests WHERE LOWER(email) = $1', [cleanEmail]);

    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'ACCESS DENIED: Email not found on VIP roster.' });
    }
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- FETCH USER DATA ---
app.get('/api/user-status', async (req, res) => {
  const { email } = req.query;
  try {
    const result = await pool.query('SELECT * FROM guests WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Guest not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- UPDATE SHIRT SIZE ---
app.post('/api/update-shirt', async (req, res) => {
  const { email, shirt_size } = req.body;
  try {
    await pool.query('UPDATE guests SET shirt_size = $1 WHERE email = $2', [shirt_size, email]);
    res.json({ success: true, shirt_size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- UPDATE RSVP ---
app.post('/api/update-rsvp', async (req, res) => {
  const { email, rsvp_status } = req.body;
  try {
    await pool.query('UPDATE guests SET rsvp_status = $1 WHERE email = $2', [rsvp_status, email]);
    res.json({ success: true, rsvp_status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- DISPATCH COSMIC EMAIL INVITE ---
app.post('/api/send-invite', async (req, res) => {
  const { sender_email, recipient_email, custom_note } = req.body;

  try {
    const senderRes = await pool.query('SELECT invites_left FROM guests WHERE email = $1', [sender_email]);
    if (senderRes.rows.length === 0 || senderRes.rows[0].invites_left <= 0) {
      return res.status(403).json({ error: 'Zero authorizations remaining.' });
    }

    const checkRes = await pool.query('SELECT * FROM guests WHERE email = $1', [recipient_email]);
    if (checkRes.rows.length > 0) {
      return res.status(400).json({ error: 'User is already in the system.' });
    }

    // Add guest and deduct invite
    await pool.query('INSERT INTO guests (email) VALUES ($1)', [recipient_email]);
    await pool.query('UPDATE guests SET invites_left = invites_left - 1 WHERE email = $1', [sender_email]);

    // Format custom note if provided
    const noteHTML = custom_note 
      ? `<div style="background-color: #1a1a2e; padding: 20px; border-left: 4px solid #b026ff; margin: 25px 0; border-radius: 4px;">
           <p style="color: #94a3b8; font-size: 12px; text-transform: uppercase; margin-top: 0;">Message from ${sender_email}:</p>
           <p style="color: #ffffff; font-style: italic; font-size: 16px; margin-bottom: 0;">"${custom_note}"</p>
         </div>`
      : '';

    // Send via Resend
    await resend.emails.send({
      from: process.env.EMAIL_USER || 'onboarding@resend.dev',
      to: recipient_email,
      subject: `[CONTROL] Priority Authorization from ${sender_email}`,
      html: `
        <div style="background-color: #020108; color: #ffffff; padding: 40px 20px; font-family: 'Helvetica Neue', sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #1e293b; border-radius: 12px;">
          <h1 style="color: #00f0ff; letter-spacing: 4px; text-align: center;">CONTROL PORTAL</h1>
          <p style="font-size: 16px; text-align: center; color: #e2e8f0;">You have been authorized for priority access.</p>
          
          ${noteHTML}

          <div style="text-align: center; margin-top: 35px;">
            <a href="${process.env.FRONTEND_URL || 'https://controlfrontend.onrender.com'}" style="display: inline-block; padding: 14px 28px; background: linear-gradient(90deg, #00f0ff, #b026ff); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: bold; letter-spacing: 1px;">INITIATE SECURE LINK</a>
          </div>
          
          <p style="font-size: 11px; color: #64748b; text-align: center; margin-top: 40px; text-transform: uppercase;">Secure transmission from CONTROL server.</p>
        </div>
      `
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during dispatch.' });
  }
});

// --- ADMIN ENDPOINTS ---
app.get('/api/admin/guests', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM guests ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reset-invites', async (req, res) => {
  const { email } = req.body;
  try {
    await pool.query('UPDATE guests SET invites_left = 2 WHERE email = $1', [email]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/add-guest', async (req, res) => {
  const { email } = req.body;
  try {
    await pool.query(
      'INSERT INTO guests (email, rsvp_status, shirt_size, invites_left) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING',
      [email, 'PENDING', 'Unassigned', 2]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin', (req, res) => {
  res.send(`
  <!DOCTYPE html>
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
      <button class="btn" onclick="addGuest()">Authorize Guest</button>
    </div>

    <h3>Guest Roster</h3>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Email</th>
          <th>RSVP Status</th>
          <th>Shirt Size</th>
          <th>Invites Remaining</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody id="roster"></tbody>
    </table>

    <script>
      async function loadData() {
        const res = await fetch('/api/admin/guests');
        const data = await res.json();
        
        document.getElementById('total-guests').innerText = data.length;
        document.getElementById('confirmed-rsvp').innerText = data.filter(g => g.rsvp_status === 'CONFIRMED').length;
        document.getElementById('shirts-claimed').innerText = data.filter(g => g.shirt_size && g.shirt_size !== 'Unassigned').length;

        const tbody = document.getElementById('roster');
        tbody.innerHTML = '';
        data.forEach((g, idx) => {
          tbody.innerHTML += \`
            <tr>
              <td>#\${idx + 1}</td>
              <td><b>\${g.email}</b></td>
              <td class="\${g.rsvp_status === 'CONFIRMED' ? 'badge-confirmed' : 'badge-pending'}">\${g.rsvp_status || 'PENDING'}</td>
              <td>\${g.shirt_size || 'Unassigned'}</td>
              <td>\${g.invites_left}</td>
              <td><button class="btn" onclick="resetInvites('\${g.email}')">Reset Invites (Set to 2)</button></td>
            </tr>
          \`;
        });
      }

      async function addGuest() {
        const email = document.getElementById('new-email').value;
        if (!email) return;
        await fetch('/api/admin/add-guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
        document.getElementById('new-email').value = '';
        loadData();
      }

      async function resetInvites(email) {
        await fetch('/api/admin/reset-invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
        loadData();
      }

      loadData();
    </script>
  </body>
  </html>
  `);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
