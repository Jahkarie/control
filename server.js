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
    const inviteLink = `${process.env.FRONTEND_URL || 'https://your-frontend.onrender.com'}?email=${encodeURIComponent(friendEmail)}`;
    
    await resend.emails.send({
      from: "J'Ouvertween <onboarding@resend.dev>",
      to: [friendEmail],
      subject: "You have been invited to J'Ouvertween by Chattabox",
      html: `
        <div style="background-color: #2b501e; color: #ffffff; padding: 30px; font-family: sans-serif; text-align: center;">
          <h2 style="text-transform: uppercase;">YOU'VE BEEN INVITED TO J'OUVERTWEEN</h2>
          <p><strong>${inviterEmail}</strong> chose you as one of their two J'Ouvertween invites.</p>
          <p>Your personal invitation gives you access to register for J'Ouvertween by Chattabox.</p>
          <p>Once you accept your invitation, you'll receive <strong>two invitations of your own</strong> to extend to the people you want beside you.</p>
          ${note ? `<p style="font-style: italic; margin: 20px 0;">"${note}"</p>` : ''}
          <div style="margin: 30px 0;">
            <a href="${inviteLink}" style="background-color: #000000; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 25px; font-weight: bold; display: inline-block;">
              ME A COME!
            </a>
            <br>
            <small style="display: block; margin-top: 8px;">(Accept your invitation)</small>
          </div>
          <p style="font-size: 11px; opacity: 0.8; margin-top: 40px;">
            INVITES ARE NOT TRANSFERRABLE & ARE SINGLE USE.<br>
            REGISTRATION WILL ONLY BE APPROVED FOR THE PERSON INVITED.
          </p>
        </div>
      `
    });

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
