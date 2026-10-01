import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import { Resend } from 'resend';

const { Pool } = pkg;
const app = express();

app.use(cors());
app.use(express.json());

// Connect to Render PostgreSQL Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

const resend = new Resend(process.env.RESEND_API_KEY);

// Automatically initialize database table
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guests (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      status VARCHAR(50) DEFAULT 'INVITED',
      shirt_size VARCHAR(20),
      invites_remaining INT DEFAULT 2,
      invited_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
initDB().catch(console.error);

// Endpoint 1: Verify Guest Email Status
app.get('/api/guest-status', async (req, res) => {
  const { email } = req.query;
  try {
    const result = await pool.query('SELECT * FROM guests WHERE LOWER(email) = LOWER($1)', [email]);
    if (result.rows.length === 0) {
      return res.status(404).json({ authorized: false });
    }
    return res.json({ authorized: true, guest: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Database query failed' });
  }
});

// Endpoint 2: Lock Package & Size
app.post('/api/secure-package', async (req, res) => {
  const { email, shirtSize } = req.body;
  try {
    const updated = await pool.query(
      `UPDATE guests 
       SET status = 'APPROVED', shirt_size = $1 
       WHERE LOWER(email) = LOWER($2) 
       RETURNING *`,
      [shirtSize, email]
    );
    res.json({ success: true, guest: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to lock package' });
  }
});

// Endpoint 3: Send Friend Invite via Resend
app.post('/api/send-invite', async (req, res) => {
  const { inviterEmail, friendEmail, note } = req.body;
  try {
    // Check inviter balance
    const inviterRes = await pool.query('SELECT * FROM guests WHERE LOWER(email) = LOWER($1)', [inviterEmail]);
    const inviter = inviterRes.rows[0];

    if (!inviter || inviter.invites_remaining <= 0) {
      return res.status(400).json({ error: 'No invites remaining' });
    }

    // Deduct invite from inviter
    await pool.query('UPDATE guests SET invites_remaining = invites_remaining - 1 WHERE LOWER(email) = LOWER($1)', [inviterEmail]);

    // Insert new friend record into Database
    await pool.query(
      `INSERT INTO guests (email, status, invites_remaining, invited_by) 
       VALUES (LOWER($1), 'INVITED', 2, LOWER($2)) 
       ON CONFLICT (email) DO NOTHING`,
      [friendEmail, inviterEmail]
    );

    // Trigger Email via Resend
const generateInviteEmail = (guestEmail, inviteUrl, note = '') => {
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
            
            <!-- MAIN CARD CONTAINER -->
            <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 500px; background-color: #0b0e17; border: 1px solid rgba(0, 240, 255, 0.2); border-radius: 20px; overflow: hidden; box-shadow: 0 20px 50px rgba(0,0,0,0.8);">
              
              <!-- TOP GLOW BAR -->
              <tr>
                <td style="height: 4px; background: linear-gradient(90deg, #00f0ff 0%, #7000ff 100%);"></td>
              </tr>

              <!-- HEADER -->
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

              <!-- BODY CONTENT -->
              <tr>
                <td style="padding: 0 30px 30px 30px; text-align: center;">
                  <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.6; color: #a1a8bd;">
                    You have been issued clearance for <strong style="color: #ffffff;">CONTROL</strong>. Secure your package tier and confirm your access pass below.
                  </p>

                  ${note ? `
                  <!-- PERSONAL NOTE BOX -->
                  <div style="background-color: rgba(255, 255, 255, 0.04); border-left: 3px solid #00f0ff; border-radius: 8px; padding: 16px; margin-bottom: 28px; text-align: left;">
                    <p style="margin: 0 0 4px 0; font-size: 10px; font-weight: 700; color: #00f0ff; letter-spacing: 1.5px; text-transform: uppercase;">Message attached:</p>
                    <p style="margin: 0; font-size: 14px; color: #ffffff; font-style: italic;">"${note}"</p>
                  </div>
                  ` : ''}

                  <!-- ACTION BUTTON -->
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
                    If the button above doesn't work, copy and paste this link in your browser:<br>
                    <a href="${inviteUrl}" style="color: #00f0ff; text-decoration: underline; word-break: break-all;">${inviteUrl}</a>
                  </p>
                </td>
              </tr>

              <!-- FOOTER -->
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

    res.json({ success: true, remaining: inviter.invites_remaining - 1 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process invitation' });
  }
});
// Endpoint 4: Easy Browser Seed (Add initial guest without SQL)
app.get('/api/seed', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).send('Please provide an email. Example: /api/seed?email=yourname@gmail.com');
  
  try {
    await pool.query(
      `INSERT INTO guests (email, status, invites_remaining) 
       VALUES (LOWER($1), 'INVITED', 2) 
       ON CONFLICT (email) DO NOTHING`,
      [email]
    );
    res.send(`Success! ${email} has been added as an invited guest.`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Database error.');
  }
});
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
