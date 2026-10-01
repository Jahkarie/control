import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Nodemailer Transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Database placeholder
let guests = [
  { email: 'test@example.com', status: 'PENDING', shirt_size: null, invites_remaining: 2 }
];

// CASHCXDE x CONTROL Email Design Template
const generateInviteEmail = (inviteUrl, note = '') => {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>CONTROL Access Granted</title>
    </head>
    <body style="margin: 0; padding: 0; background-color: #030407; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #ffffff;">
      <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #030407; padding: 40px 10px;">
        <tr>
          <td align="center">
            <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 500px; background-color: #0b0e17; border: 1px solid rgba(0, 240, 255, 0.2); border-radius: 20px; overflow: hidden; box-shadow: 0 20px 50px rgba(0,0,0,0.8);">
              <tr>
                <td style="height: 4px; background: linear-gradient(90deg, #00f0ff 0%, #7000ff 100%);"></td>
              </tr>
              <tr>
                <td style="padding: 40px 30px 20px 30px; text-align: center;">
                  <p style="margin: 0 0 8px 0; font-size: 11px; font-weight: 800; letter-spacing: 3px; color: #838a9e; text-transform: uppercase;">
                    PRESENTED BY <span style="color: #00f0ff;">CASHCXDE</span>
                  </p>
                  <h1 style="margin: 0; font-size: 42px; font-weight: 900; letter-spacing: 8px; color: #ffffff; text-transform: uppercase; line-height: 1;">
                    CONTROL
                  </h1>
                </td>
              </tr>
              <tr>
                <td style="padding: 0 30px 30px 30px; text-align: center;">
                  <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.6; color: #a1a8bd;">
                    You have been issued clearance for <strong style="color: #ffffff;">CONTROL</strong>. Confirm your access pass and secure your package below.
                  </p>
                  ${note ? `
                  <div style="background-color: rgba(255, 255, 255, 0.04); border-left: 3px solid #00f0ff; border-radius: 8px; padding: 16px; margin-bottom: 28px; text-align: left;">
                    <p style="margin: 0 0 4px 0; font-size: 10px; font-weight: 700; color: #00f0ff; letter-spacing: 1.5px; text-transform: uppercase;">Message attached:</p>
                    <p style="margin: 0; font-size: 14px; color: #ffffff; font-style: italic;">"${note}"</p>
                  </div>
                  ` : ''}
                  <table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                    <tr>
                      <td align="center" style="border-radius: 12px; background: #00f0ff;">
                        <a href="${inviteUrl}" target="_blank" style="display: inline-block; padding: 18px 36px; font-size: 14px; font-weight: 800; color: #000000; text-decoration: none; letter-spacing: 2px; text-transform: uppercase; border-radius: 12px;">
                          ME A COME!
                        </a>
                      </td>
                    </tr>
                  </table>
                  <p style="margin: 28px 0 0 0; font-size: 12px; color: #5a6072;">
                    If the button doesn't work, copy and paste this link:<br>
                    <a href="${inviteUrl}" style="color: #00f0ff; text-decoration: underline; word-break: break-all;">${inviteUrl}</a>
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding: 20px; background-color: #06080f; text-align: center; border-top: 1px solid rgba(255, 255, 255, 0.05);">
                  <p style="margin: 0; font-size: 11px; color: #434857; letter-spacing: 1px; text-transform: uppercase;">
                    CONTROL &bull; POWERED BY CASHCXDE
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
};

// 1. Check guest authorization status
app.get('/api/guest-status', (req, res) => {
  const email = req.query.email ? req.query.email.toLowerCase() : '';
  const guest = guests.find(g => g.email.toLowerCase() === email);

  if (!guest) {
    return res.status(404).json({ authorized: false, error: 'Not invited' });
  }

  res.json({ authorized: true, guest });
});

// 2. Lock package / shirt size
app.post('/api/secure-package', (req, res) => {
  const { email, shirtSize } = req.body;
  const guest = guests.find(g => g.email.toLowerCase() === (email || '').toLowerCase());

  if (!guest) {
    return res.status(404).json({ success: false, error: 'Guest not found' });
  }

  guest.shirt_size = shirtSize;
  guest.status = 'APPROVED';

  res.json({ success: true, guest });
});

// 3. Dispatch invitation email
app.post('/api/send-invite', async (req, res) => {
  const { inviterEmail, friendEmail, note } = req.body;
  const inviter = guests.find(g => g.email.toLowerCase() === (inviterEmail || '').toLowerCase());

  if (!inviter || inviter.invites_remaining <= 0) {
    return res.status(400).json({ success: false, error: 'No invite clearance remaining.' });
  }

  const cleanFriendEmail = friendEmail.toLowerCase();
  
  let friendGuest = guests.find(g => g.email.toLowerCase() === cleanFriendEmail);
  if (!friendGuest) {
    friendGuest = { email: cleanFriendEmail, status: 'PENDING', shirt_size: null, invites_remaining: 2 };
    guests.push(friendGuest);
  }

  inviter.invites_remaining -= 1;

  const frontendUrl = process.env.FRONTEND_URL || 'https://your-frontend.onrender.com';
  const inviteUrl = `${frontendUrl}?email=${encodeURIComponent(cleanFriendEmail)}`;

  try {
    await transporter.sendMail({
      from: `"CONTROL" <${process.env.EMAIL_USER}>`,
      to: cleanFriendEmail,
      subject: 'CLEARANCE GRANTED: CONTROL ACCESS PASS',
      html: generateInviteEmail(inviteUrl, note)
    });

    res.json({ success: true, remaining: inviter.invites_remaining });
  } catch (error) {
    console.error('Email error:', error);
    res.status(500).json({ success: false, error: 'Failed to send invite email.' });
  }
});

// 4. Admin Command Center
app.get('/admin', (req, res) => {
  const guestRows = guests.map((g, index) => `
    <tr>
      <td style="padding: 14px; border-bottom: 1px solid rgba(255,255,255,0.08); font-size: 13px; color: #838a9e;">#${index + 1}</td>
      <td style="padding: 14px; border-bottom: 1px solid rgba(255,255,255,0.08); font-weight: 600; color: #ffffff;">${g.email}</td>
      <td style="padding: 14px; border-bottom: 1px solid rgba(255,255,255,0.08);">
        <span style="display: inline-block; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 800; letter-spacing: 1px; ${
          g.status === 'APPROVED' 
            ? 'background: rgba(0, 240, 255, 0.1); color: #00f0ff; border: 1px solid rgba(0, 240, 255, 0.3);' 
            : 'background: rgba(255, 255, 255, 0.05); color: #838a9e; border: 1px solid rgba(255, 255, 255, 0.1);'
        }">
          ${g.status}
        </span>
      </td>
      <td style="padding: 14px; border-bottom: 1px solid rgba(255,255,255,0.08); font-weight: 700; color: #00f0ff;">
        ${g.shirt_size ? g.shirt_size : '<span style="color:#5a6072;">Unassigned</span>'}
      </td>
      <td style="padding: 14px; border-bottom: 1px solid rgba(255,255,255,0.08); text-align: center; font-weight: 600; color: #ffffff;">
        ${g.invites_remaining}
      </td>
    </tr>
  `).join('');

  const totalGuests = guests.length;
  const totalApproved = guests.filter(g => g.status === 'APPROVED').length;
  const totalPending = guests.filter(g => g.status === 'PENDING').length;

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>CONTROL — Admin Command Center</title>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=Syne:wght@700;800&display=swap" rel="stylesheet">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: 'Plus Jakarta Sans', sans-serif;
          background-color: #030407;
          color: #f3f4f8;
          min-height: 100vh;
          padding: 30px 20px;
        }
        .container { max-width: 1000px; margin: 0 auto; }
        .header {
          display: flex; justify-content: space-between; align-items: center;
          margin-bottom: 30px; padding-bottom: 20px;
          border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .brand-title {
          font-family: 'Syne', sans-serif; font-size: 28px; font-weight: 800;
          letter-spacing: 4px; color: #ffffff; text-transform: uppercase;
        }
        .sponsor-tag { font-size: 11px; font-weight: 800; letter-spacing: 2px; color: #838a9e; }
        .sponsor-tag span { color: #00f0ff; }
        
        .stats-grid {
          display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 16px; margin-bottom: 30px;
        }
        .stat-card {
          background: rgba(13, 16, 27, 0.75); border: 1px solid rgba(255,255,255,0.08);
          border-radius: 16px; padding: 20px;
        }
        .stat-label { font-size: 11px; font-weight: 700; letter-spacing: 1.5px; color: #838a9e; text-transform: uppercase; }
        .stat-value { font-family: 'Syne', sans-serif; font-size: 32px; font-weight: 800; color: #ffffff; margin-top: 6px; }

        .add-guest-box {
          background: rgba(13, 16, 27, 0.75); border: 1px solid rgba(0, 240, 255, 0.2);
          border-radius: 16px; padding: 24px; margin-bottom: 30px; display: flex; gap: 12px; align-items: center;
        }
        .admin-input {
          flex: 1; background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.1);
          border-radius: 10px; padding: 14px 16px; font-size: 14px; color: #fff; outline: none;
        }
        .admin-input:focus { border-color: #00f0ff; }
        .btn-add {
          background: #00f0ff; color: #000; font-family: 'Syne', sans-serif;
          font-weight: 800; border: none; border-radius: 10px; padding: 14px 24px;
          cursor: pointer; text-transform: uppercase; letter-spacing: 1px; transition: all 0.2s;
        }
        .btn-add:hover { background: #ffffff; transform: translateY(-2px); }

        .table-card {
          background: rgba(13, 16, 27, 0.75); border: 1px solid rgba(255,255,255,0.08);
          border-radius: 16px; overflow: hidden;
        }
        table { width: 100%; border-collapse: collapse; text-align: left; }
        th {
          background: rgba(0,0,0,0.4); padding: 16px; font-size: 11px;
          font-weight: 700; letter-spacing: 1.5px; color: #838a9e; text-transform: uppercase;
          border-bottom: 1px solid rgba(255,255,255,0.08);
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div>
            <div class="sponsor-tag">POWERED BY <span>CASHCXDE</span></div>
            <div class="brand-title">CONTROL COMMAND</div>
          </div>
        </div>

        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">Total Guests</div>
            <div class="stat-value">${totalGuests}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Confirmed / Approved</div>
            <div class="stat-value" style="color: #00f0ff;">${totalApproved}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Pending Access</div>
            <div class="stat-value" style="color: #ffaa00;">${totalPending}</div>
          </div>
        </div>

        <form class="add-guest-box" action="/admin/add-guest" method="POST">
          <input type="email" name="email" class="admin-input" placeholder="Add guest email address..." required />
          <button type="submit" class="btn-add">Authorize Guest</button>
        </form>

        <div class="table-card">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Guest Email</th>
                <th>Status</th>
                <th>Locked Size</th>
                <th style="text-align: center;">Invites Left</th>
              </tr>
            </thead>
            <tbody>
              ${guestRows.length > 0 ? guestRows : `<tr><td colspan="5" style="padding: 20px; text-align: center; color: #838a9e;">No guests in database.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </body>
    </html>
  `);
});

// 5. Admin Add Guest
app.post('/admin/add-guest', (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  if (email && !guests.some(g => g.email.toLowerCase() === email)) {
    guests.push({ email, status: 'PENDING', shirt_size: null, invites_remaining: 2 });
  }
  res.redirect('/admin');
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
