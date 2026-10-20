// events.js: events, one current at a time. The roster (guests, approvals, profiles) is shared by every event; what
// guests buy and do belongs to one: packages (and their tiers), orders (and their check-ins and pickups), promo codes,
// invites and group emails each carry an event_id. Everything guests see is the current event's. Starting a new event
// turns the current one into a past one (its paid passes stay as history) and opens a fresh one, in one transaction.
// The events table and the event_id columns are created by ensureSchema() in server.js; migrateEvents() below fills them.
//
// Invites: a guest's allowance for the current event is events.invites_per_guest plus their guest_event.invite_bonus,
// less the invites they sent for this event that aren't revoked (see INVITES_LEFT_SQL). guests.invites_left is the
// legacy counter: the migration turned it into each guest's bonus, and nothing reads or writes it any more.
// Attendance (guests.rsvp_status) is the current event's: starting a new event sets everyone back to PENDING and keeps
// how many had confirmed on the old event (events.rsvp_confirmed).

// The current event's id, as SQL. A fixed fragment (no input in it), so queries stay parameterized.
export const CUR = `(SELECT id FROM events WHERE status = 'current')`;
export const DEFAULT_EVENT_NAME = "On D' Road";

// Invites a guest can still send for the current event. Use with "FROM guests g" (any alias g with an email column).
// Admin ('CONTROL') and promoter ('PROMOTER') invites have no @ in inviter_email, so they never count against a guest.
export const INVITES_LEFT_SQL = `GREATEST(0,
    (SELECT e.invites_per_guest FROM events e WHERE e.status = 'current')
    + COALESCE((SELECT ge.invite_bonus FROM guest_event ge WHERE ge.email = LOWER(g.email) AND ge.event_id = ${CUR}), 0)
    - (SELECT COUNT(*) FROM invites i WHERE LOWER(i.inviter_email) = LOWER(g.email) AND i.event_id = ${CUR} AND i.status <> 'REVOKED'))::int`;

export async function currentEvent(db) {
  const r = await db.query("SELECT * FROM events WHERE status = 'current'");
  if (!r.rowCount) throw new Error('No current event.');
  return r.rows[0];
}

// A fresh current event with the built-in defaults (a first boot, or after "Reset everything"). db must be a client in
// a transaction where no event is current.
export async function createDefaultEvent(db) {
  return (await db.query(
    `INSERT INTO events (name, status, invites_per_guest, started_at) VALUES ($1, 'current', 2, NOW()) RETURNING *`, [DEFAULT_EVENT_NAME])).rows[0];
}

const ID_TABLES = ['packages', 'promo_codes', 'broadcasts', 'invites'];

// Safe to run on every boot. The first time (no events yet) it creates the event that was running all along, named
// "On D' Road", with the event details that were in settings and 2 invites per guest, and turns each guest's legacy
// invites_left into a bonus so their allowance stays what it was. Then rows without an event_id get the current one.
export async function migrateEvents(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Two boots at once (a deploy overlap) wait for each other here.
    await client.query('LOCK TABLE events IN SHARE ROW EXCLUSIVE MODE');
    let cur = (await client.query("SELECT id FROM events WHERE status = 'current'")).rows[0];
    if (!cur) {
      const newest = (await client.query('SELECT id FROM events ORDER BY id DESC LIMIT 1')).rows[0];
      if (newest) {
        // Events, but none current (only possible by hand): the newest is the current one.
        cur = (await client.query("UPDATE events SET status = 'current', ended_at = NULL WHERE id = $1 RETURNING id", [newest.id])).rows[0];
        console.log(`Events: no current event, so event ${cur.id} is current again.`);
      } else {
        const keys = ['event_when', 'event_info', 'event_paid_info', 'event_location', 'event_poster'];
        const s = Object.fromEntries((await client.query('SELECT key, value FROM settings WHERE key = ANY($1)', [keys])).rows.map((x) => [x.key, x.value]));
        cur = (await client.query(
          `INSERT INTO events (name, status, invites_per_guest, event_when, event_info, event_paid_info, event_location, event_poster, started_at)
           VALUES ($1, 'current', 2, $2, $3, $4, $5, $6, NOW()) RETURNING id`,
          [DEFAULT_EVENT_NAME, s.event_when || '', s.event_info || '', s.event_paid_info || '', s.event_location || '', s.event_poster || ''])).rows[0];
        // invites_left counted down as invites went out and back up on a revoke, and the admin could set it. So what a
        // guest could send in all = invites_left + their invites that aren't revoked; the bonus is that less the 2.
        const b = await client.query(
          `INSERT INTO guest_event (email, event_id, invite_bonus)
           SELECT DISTINCT ON (LOWER(g.email)) LOWER(g.email), $1::int,
                  g.invites_left + (SELECT COUNT(*) FROM invites i WHERE LOWER(i.inviter_email) = LOWER(g.email) AND i.status <> 'REVOKED')::int - 2
           FROM guests g
           WHERE g.invites_left + (SELECT COUNT(*) FROM invites i WHERE LOWER(i.inviter_email) = LOWER(g.email) AND i.status <> 'REVOKED')::int <> 2
           ORDER BY LOWER(g.email), g.id
           ON CONFLICT DO NOTHING`, [cur.id]);
        console.log(`Events: created "${DEFAULT_EVENT_NAME}" as the current event (${b.rowCount} invite bonuses carried over).`);
      }
    }
    for (const t of ID_TABLES) await client.query(`UPDATE ${t} SET event_id = $1 WHERE event_id IS NULL`, [cur.id]);
    // An order belongs to its package's event.
    await client.query('UPDATE orders o SET event_id = COALESCE(p.event_id, $1) FROM packages p WHERE p.id = o.package_id AND o.event_id IS NULL', [cur.id]);
    await client.query('UPDATE orders SET event_id = $1 WHERE event_id IS NULL', [cur.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const cleanName = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
// The typed confirmation matches the name, ignoring case and extra spaces.
const sameName = (a, b) => cleanName(a).toLowerCase() === cleanName(b).toLowerCase();
const toInt = (v) => (typeof v === 'number' || (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) ? Number(v) : NaN);
const idOf = (v) => { const n = toInt(v); return n > 0 && n <= 2147483647 ? n : 0; };
function eventInput(b, partial) {
  const f = {};
  if (!partial || b.name !== undefined) {
    f.name = cleanName(b.name);
    if (!f.name || f.name.length > 80) return { error: 'Give the event a name of up to 80 characters.' };
  }
  if (!partial || b.invites_per_guest !== undefined) {
    f.invites_per_guest = toInt(b.invites_per_guest);
    if (!(Number.isInteger(f.invites_per_guest) && f.invites_per_guest >= 0 && f.invites_per_guest <= 20)) return { error: 'Invites per guest is a whole number from 0 to 20.' };
  }
  return { fields: f };
}

// A CSV cell: quoted, and a leading = + - @ (or tab or return) gets a ' so Excel and Sheets keep it as text.
const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (s && '=+-@\t\r'.includes(s[0])) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
};

// Orders that hold a PayPal payment in flight (a checkout from the last 30 minutes, or one PayPal is still holding): the
// same rule the payments job uses before it cancels anything.
const PAYPAL_BUSY = `o.paypal_order_id IS NOT NULL AND (o.paypal_status = 'PENDING' OR o.paypal_started_at > NOW() - INTERVAL '30 minutes')`;

export function registerEvents({ app, pool, requireAdmin }) {
  const fail = (res, err) => { console.error('Events error:', err); res.status(500).json({ error: 'Server error.' }); };

  // Each event with its totals: reserved, paid, cancelled, checked in, the money received per currency and packages.
  async function withTotals(db, events) {
    if (!events.length) return [];
    const ids = events.map((e) => e.id);
    const [t, m] = await Promise.all([
      db.query(
        `SELECT e.id,
                (SELECT COUNT(*) FROM orders o WHERE o.event_id = e.id AND o.status = 'RESERVED')::int AS reserved,
                (SELECT COUNT(*) FROM orders o WHERE o.event_id = e.id AND o.status = 'PAID')::int AS paid,
                (SELECT COUNT(*) FROM orders o WHERE o.event_id = e.id AND o.status = 'PAID' AND o.paid_via = 'COMP')::int AS free_passes,
                (SELECT COUNT(*) FROM orders o WHERE o.event_id = e.id AND o.status = 'CANCELLED')::int AS cancelled,
                (SELECT COUNT(*) FROM orders o WHERE o.event_id = e.id AND o.checked_in_at IS NOT NULL)::int AS checked_in,
                (SELECT COUNT(*) FROM orders o WHERE o.event_id = e.id AND o.picked_up_at IS NOT NULL)::int AS picked_up,
                (SELECT COUNT(*) FROM packages p WHERE p.event_id = e.id)::int AS packages,
                (SELECT COUNT(*) FROM invites i WHERE i.event_id = e.id AND i.status <> 'REVOKED')::int AS invites
         FROM events e WHERE e.id = ANY($1::int[])`, [ids]),
      db.query(
        `SELECT o.event_id, COALESCE(o.currency, p.currency) AS currency, SUM(COALESCE(o.amount_cents, p.price_cents))::bigint AS cents
         FROM orders o JOIN packages p ON p.id = o.package_id
         WHERE o.event_id = ANY($1::int[]) AND o.status = 'PAID' GROUP BY 1, 2 HAVING SUM(COALESCE(o.amount_cents, p.price_cents)) > 0 ORDER BY 2`, [ids])
    ]);
    const byId = new Map(t.rows.map((x) => [x.id, x]));
    return events.map((e) => {
      const { id, ...totals } = byId.get(e.id) || {};
      return { id: e.id, name: e.name, status: e.status, invites_per_guest: e.invites_per_guest, created_at: e.created_at,
        started_at: e.started_at, ended_at: e.ended_at, rsvp_confirmed: e.rsvp_confirmed,
        ...totals, received: m.rows.filter((x) => x.event_id === e.id).map((x) => ({ currency: x.currency, cents: Number(x.cents) })) };
    });
  }

  // What starting a new event would do to the current one.
  async function switchCounts(db) {
    const r = await db.query(
      `SELECT (SELECT COUNT(*) FROM orders o WHERE o.event_id = ${CUR} AND o.status = 'RESERVED')::int AS unpaid,
              (SELECT COUNT(*) FROM orders o WHERE o.event_id = ${CUR} AND o.status = 'RESERVED' AND ${PAYPAL_BUSY})::int AS paypal_busy,
              (SELECT COUNT(*) FROM orders o WHERE o.event_id = ${CUR} AND o.status = 'PAID' AND o.cancel_requested_at IS NOT NULL)::int AS refund_requests,
              (SELECT COUNT(DISTINCT LOWER(o.guest_email)) FROM orders o WHERE o.event_id = ${CUR} AND o.status = 'PAID')::int AS paid_guests,
              (SELECT COUNT(*) FROM invites i WHERE i.status = 'PENDING')::int AS pending_invites,
              (SELECT COUNT(*) FROM packages p WHERE p.event_id = ${CUR})::int AS packages,
              (SELECT COUNT(*) FROM guests WHERE rsvp_status = 'CONFIRMED')::int AS attendance_confirmed`);
    return r.rows[0];
  }

  app.get('/api/admin/events', requireAdmin, async (req, res) => {
    try {
      const all = (await pool.query("SELECT * FROM events ORDER BY (status = 'current') DESC, started_at DESC NULLS LAST, id DESC")).rows;
      const list = await withTotals(pool, all);
      res.json({ current: list.find((e) => e.status === 'current') || null, past: list.filter((e) => e.status !== 'current'), switch: await switchCounts(pool) });
    } catch (err) { fail(res, err); }
  });

  // Renames the current event, or changes how many invites each guest gets for it (their bonuses stay).
  app.post('/api/admin/events/current', requireAdmin, async (req, res) => {
    const { error, fields: f } = eventInput(req.body || {}, true);
    if (error) return res.status(400).json({ error });
    const cols = Object.keys(f); // fixed names from eventInput, never from the request
    if (!cols.length) return res.status(400).json({ error: 'Nothing to change.' });
    try {
      const r = await pool.query(
        `UPDATE events SET ${cols.map((c, n) => `${c} = $${n + 1}`).join(', ')} WHERE status = 'current' RETURNING id, name, invites_per_guest`,
        cols.map((c) => f[c]));
      res.json({ success: true, event: r.rows[0] });
    } catch (err) { fail(res, err); }
  });

  // Starts a new event: { name, invites_per_guest, copy_packages, confirm } (confirm = the new name, typed again).
  // In one transaction: unpaid reservations of the current event are cancelled (no email), attendance goes back to
  // PENDING, the current event becomes past and the new one current. Copied packages start hidden, with their tiers
  // (end dates only when still to come), sizes and pay notes; codes stay with the old event. Refused while a refund
  // request is open or a PayPal payment is in flight.
  app.post('/api/admin/events/start', requireAdmin, async (req, res) => {
    const b = req.body || {};
    const { error, fields: f } = eventInput(b, false);
    if (error) return res.status(400).json({ error });
    if (!sameName(b.confirm, f.name)) return res.status(400).json({ error: "Type the new event's name to confirm.", code: 'CONFIRM_MISMATCH' });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      // Reservations, invites and codes take this row FOR SHARE, so none of them lands in the old event halfway.
      const old = (await client.query("SELECT * FROM events WHERE status = 'current' FOR UPDATE")).rows[0];
      const c = await switchCounts(client);
      if (c.refund_requests) {
        await client.query('ROLLBACK');
        return res.status(409).json({ code: 'REFUNDS_PENDING', counts: c,
          error: `${c.refund_requests} refund ${c.refund_requests === 1 ? 'request is' : 'requests are'} still open. Approve or settle ${c.refund_requests === 1 ? 'it' : 'them'} in the Orders tab first.` });
      }
      if (c.paypal_busy) {
        await client.query('ROLLBACK');
        return res.status(409).json({ code: 'PAYPAL_BUSY', counts: c,
          error: `${c.paypal_busy} ${c.paypal_busy === 1 ? 'guest is' : 'guests are'} paying with PayPal right now. Try again in half an hour.` });
      }
      const cancelled = await client.query(`UPDATE orders SET status = 'CANCELLED' WHERE event_id = $1 AND status = 'RESERVED'`, [old.id]);
      await client.query(`UPDATE events SET status = 'past', ended_at = NOW(), rsvp_confirmed = $2 WHERE id = $1`, [old.id, c.attendance_confirmed]);
      await client.query(`UPDATE guests SET rsvp_status = 'PENDING' WHERE rsvp_status = 'CONFIRMED'`);
      const ev = (await client.query(
        `INSERT INTO events (name, status, invites_per_guest, started_at) VALUES ($1, 'current', $2, NOW()) RETURNING *`,
        [f.name, f.invites_per_guest])).rows[0];
      let copied = 0;
      if (b.copy_packages === true) {
        const pk = await client.query('SELECT id FROM packages WHERE event_id = $1 ORDER BY sort_order, id', [old.id]);
        for (const p of pk.rows) {
          const n = (await client.query(
            `INSERT INTO packages (name, price_cents, currency, includes, requires_compliance, capacity, active, sort_order, sizes, pay_note, event_id)
             SELECT name, price_cents, currency, includes, requires_compliance, capacity, FALSE, sort_order, sizes, pay_note, $2
             FROM packages WHERE id = $1 RETURNING id`, [p.id, ev.id])).rows[0];
          await client.query(
            `INSERT INTO package_tiers (package_id, name, price_cents, ends_at, quantity, sort_order)
             SELECT $2, name, price_cents, CASE WHEN ends_at > NOW() THEN ends_at END, quantity, sort_order
             FROM package_tiers WHERE package_id = $1 ORDER BY sort_order, id`, [p.id, n.id]);
          copied++;
        }
      }
      await client.query('COMMIT');
      console.log(`Events: "${old.name}" ended, "${ev.name}" started (${cancelled.rowCount} unpaid reservations cancelled, ${copied} packages copied).`);
      res.json({ success: true, event: { id: ev.id, name: ev.name, invites_per_guest: ev.invites_per_guest }, ended: { id: old.id, name: old.name },
        cancelled: cancelled.rowCount, copied });
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      console.error('Events error:', err);
      res.status(500).json({ error: 'Server error. Nothing was changed.' });
    } finally {
      client?.release();
    }
  });

  // Every order of one event (past or current), as a CSV that opens in Excel with accented names intact.
  app.get('/api/admin/events/:id/orders.csv', requireAdmin, async (req, res) => {
    const id = idOf(req.params.id);
    if (!id) return res.status(404).json({ error: 'Event not found.' });
    try {
      const ev = (await pool.query('SELECT id, name FROM events WHERE id = $1', [id])).rows[0];
      if (!ev) return res.status(404).json({ error: 'Event not found.' });
      const r = await pool.query(
        `SELECT o.reference_code, o.guest_email, g.full_name, p.name AS package_name, o.tier_name, o.size,
                COALESCE(o.list_cents, p.price_cents) AS list_cents, COALESCE(o.discount_cents, 0) AS discount_cents, o.promo_code,
                COALESCE(o.amount_cents, p.price_cents) AS amount_cents, COALESCE(o.currency, p.currency) AS currency,
                CASE WHEN o.status = 'PAID' AND o.cancel_requested_at IS NOT NULL THEN 'REFUND_REQUESTED' ELSE o.status END AS status,
                o.paid_via, o.created_at, o.paid_at, o.refunded_at, o.picked_up_at, o.checked_in_at
         FROM orders o JOIN packages p ON p.id = o.package_id
         LEFT JOIN (SELECT DISTINCT ON (LOWER(email)) LOWER(email) AS email, full_name FROM guests ORDER BY LOWER(email), id) g ON g.email = LOWER(o.guest_email)
         WHERE o.event_id = $1 ORDER BY o.id DESC`, [id]);
      const amount = (c) => (c === null || c === undefined ? '' : (Number(c) / 100).toFixed(2));
      const rows = [['reference', 'email', 'name', 'package', 'tier', 'size', 'list', 'discount', 'code', 'amount', 'currency', 'status', 'paid_via',
        'reserved_at', 'paid_at', 'refunded_at', 'picked_up_at', 'checked_in_at']]
        .concat(r.rows.map((o) => [o.reference_code, o.guest_email, o.full_name, o.package_name, o.tier_name, o.size, amount(o.list_cents),
          amount(o.discount_cents), o.promo_code, amount(o.amount_cents), o.currency, o.status, o.paid_via, o.created_at, o.paid_at, o.refunded_at,
          o.picked_up_at, o.checked_in_at]));
      const slug = ev.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'event';
      res.set('Content-Type', 'text/csv; charset=utf-8')
        .set('Content-Disposition', `attachment; filename="ondroad-${slug}-orders.csv"`)
        .set('Cache-Control', 'no-store')
        // The byte-order mark makes Excel read the file as UTF-8.
        .send('﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\n'));
    } catch (err) { fail(res, err); }
  });

  app.get('/admin/events', requireAdmin, (req, res) => res.type('html').send(PAGE));
}

// ---------- "Events" admin page ----------
const PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0a0a0b">
<title>Events | On D' Road</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
/* Night Kinetic, admin edition: matte charcoal, one sharp accent (safety orange), hairline rules and square corners.
   Concrete is kept for utility surfaces (previews, dialogs, toasts). Calm and dense for daily work. */
:root { --bg: #0a0a0b; --surface: #141416; --surface-2: #1a1a1d; --raise: #232327; --well: #0a0a0b; --line: rgba(236, 235, 230, .1); --line-strong: rgba(236, 235, 230, .24); --text: #ecebe6; --muted: #a6a59f; --dim: #8a8983; --accent: #ff5a1f; --accent-hi: #ff7440; --accent-ink: #141416; --good: #b6ff3b; --warn: #ffc02e; --bad: #ff7a6b; --cyan: #22e1ff; --concrete: #c9c8c3; --concrete-2: #e4e3df; --ink: #141416; --ink-2: #47463f; --display: 'Archivo', 'Helvetica Neue', Arial, sans-serif; --body: 'Archivo', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; --mono: 'Space Mono', ui-monospace, SFMono-Regular, Menlo, monospace; --xh: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28' fill='none' stroke='%23141416' stroke-opacity='0.55' stroke-width='1'%3E%3Ccircle cx='14' cy='14' r='6.5'/%3E%3Cpath d='M14 0v28M0 14h28'/%3E%3C/svg%3E"); color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 var(--body); -webkit-font-smoothing: antialiased; }
::selection { background: var(--accent); color: var(--accent-ink); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.hidden { display: none !important; }
.top { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; gap: 10px 16px; flex-wrap: wrap; min-height: 60px; padding: 10px clamp(16px, 3vw, 32px); background: rgba(10, 10, 11, .9); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.brand .mark { flex: none; width: 30px; height: 18px; overflow: visible; }
.brand b { font-family: var(--display); font-stretch: 125%; font-weight: 900; font-size: 16px; line-height: 1; letter-spacing: .01em; white-space: nowrap; }
.brand b span { color: var(--accent); }
.brand b i { font-style: normal; font-weight: 200; }
.brand .sub { font-family: var(--mono); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); white-space: nowrap; }
.brand .sub::before { content: '[ '; color: var(--dim); }
.brand .sub::after { content: ' ]'; color: var(--dim); }
.back { display: inline-flex; align-items: center; min-height: 38px; padding: 0 14px; font-size: 13px; font-weight: 600; color: var(--text); text-decoration: none; border: 1px solid var(--line-strong); white-space: nowrap; transition: border-color .15s, background .15s; }
.back:hover { border-color: var(--text); background: rgba(236, 235, 230, .05); }
h1 { font-family: var(--display); font-stretch: 125%; font-weight: 800; font-size: clamp(30px, 5vw, 48px); line-height: .98; letter-spacing: -.01em; text-transform: uppercase; margin: 0; overflow-wrap: break-word; }
h2 { font-family: var(--display); font-stretch: 118%; font-weight: 800; font-size: 19px; line-height: 1.1; letter-spacing: .01em; text-transform: uppercase; margin: 0 0 8px; overflow-wrap: anywhere; }
.lead { position: relative; color: var(--muted); margin: 14px 0 28px; padding-bottom: 22px; border-bottom: 1px solid var(--line); }
.lead::after { content: ''; position: absolute; left: 0; bottom: -1px; width: 56px; height: 2px; background: var(--accent); }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 0; padding: clamp(20px, 3vw, 28px); margin-bottom: 22px; min-width: 0; }
.card > p { color: var(--muted); margin: 0; }
button, .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 42px; font-family: var(--display); font-weight: 700; font-stretch: 112%; font-size: 13px; line-height: 1; letter-spacing: .05em; text-transform: uppercase; padding: 0 18px; border-radius: 0; cursor: pointer; color: var(--accent-ink); background: var(--accent); border: 1px solid var(--accent); transition: background .15s, border-color .15s, color .15s; text-decoration: none; white-space: nowrap; }
button:hover, .btn:hover { background: var(--accent-hi); border-color: var(--accent-hi); }
button:active, .btn:active { transform: translateY(1px); }
button:disabled { opacity: .5; cursor: not-allowed; transform: none; }
button.ghost, .btn.ghost { color: var(--text); background: transparent; border-color: var(--line-strong); }
button.ghost:hover, .btn.ghost:hover { border-color: var(--text); background: rgba(236, 235, 230, .05); }
button.small, .btn.small { min-height: 34px; padding: 0 12px; font-size: 11.5px; }
.msg { font-size: 14px; font-weight: 600; }
.msg.ok { color: var(--good); } .msg.err { color: var(--bad); }
@media (max-width: 560px) { .brand .sub { display: none; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } button:active, .btn:active { transform: none; } }
.wrap { max-width: 880px; margin: 0 auto; padding: clamp(24px, 4vw, 48px) clamp(16px, 3vw, 32px) 80px; }
.tag { display: inline-block; font-family: var(--mono); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin-bottom: 10px; }
.tag::before { content: '[ '; color: var(--dim); } .tag::after { content: ' ]'; color: var(--dim); }
.tag.on { color: var(--good); }
.card > .evname { color: var(--text); }
.evname { font-family: var(--display); font-stretch: 125%; font-weight: 900; font-size: clamp(26px, 6vw, 38px); line-height: 1; letter-spacing: -.01em; text-transform: uppercase; margin: 0; overflow-wrap: anywhere; }
.since { margin: 8px 0 0; font-family: var(--mono); font-size: 12px; color: var(--muted); }
/* Totals: hairline cells with registration ticks, like the overview's KPIs */
.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); margin-top: 20px; }
@media (max-width: 640px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.stat { position: relative; background: var(--surface); padding: 18px 16px 14px; min-width: 0; }
.stat::before { content: ''; position: absolute; top: 7px; left: 7px; width: 7px; height: 7px; border-top: 1px solid var(--line-strong); border-left: 1px solid var(--line-strong); }
.stat .label { display: block; font-family: var(--mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.stat .value { display: block; font-family: var(--display); font-stretch: 125%; font-weight: 800; font-size: 34px; line-height: 1; margin-top: 10px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.stat .value.money { font-family: var(--mono); font-stretch: 100%; font-weight: 700; font-size: 15px; line-height: 1.35; margin-top: 12px; }
.stat .sub { display: block; font-size: 12px; color: var(--dim); margin-top: 6px; }
label { display: block; font-family: var(--mono); font-size: 11px; font-weight: 400; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 22px 0 8px; }
input { width: 100%; min-height: 44px; font: 500 15px var(--body); color: var(--text); background: var(--well); border: 1px solid var(--line-strong); border-radius: 0; padding: 11px 13px; transition: border-color .15s, box-shadow .15s; min-width: 0; }
input:hover { border-color: rgba(236, 235, 230, .42); }
input:focus { outline: none; border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
input::placeholder { color: var(--dim); }
.row2 { display: grid; grid-template-columns: minmax(0, 1fr) 160px; gap: 0 14px; }
@media (max-width: 560px) { .row2 { grid-template-columns: 1fr; } }
small { display: block; color: var(--dim); font-size: 13px; margin-top: 8px; }
.check { display: flex; align-items: flex-start; gap: 12px; margin-top: 20px; font-family: var(--body); font-size: 15px; letter-spacing: 0; text-transform: none; color: var(--text); cursor: pointer; }
.check input { flex: none; width: 18px; height: 18px; min-height: 0; margin: 2px 0 0; padding: 0; accent-color: var(--accent); }
.check input:focus { box-shadow: none; }
.check input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.check span { color: var(--muted); font-size: 14px; display: block; }
.check b { display: block; font-weight: 600; color: var(--text); }
.foot { display: flex; align-items: center; gap: 12px; margin-top: 22px; flex-wrap: wrap; }
/* Past events: hairline-split rows */
.past { list-style: none; margin: 16px 0 0; padding: 0; border-top: 1px solid var(--line); }
.past li { padding: 18px 0; border-bottom: 1px solid var(--line); }
.past .ph { display: flex; align-items: baseline; justify-content: space-between; gap: 6px 16px; flex-wrap: wrap; }
.past h3 { margin: 0; font-family: var(--display); font-stretch: 118%; font-weight: 800; font-size: 17px; text-transform: uppercase; letter-spacing: .01em; overflow-wrap: anywhere; }
.past .dates { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.past .facts { margin: 8px 0 0; color: var(--muted); font-size: 14px; }
.past .facts b { color: var(--text); font-weight: 700; font-variant-numeric: tabular-nums; }
.past .acts { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.empty { color: var(--dim); font-style: italic; margin: 14px 0 0; }
/* Dialog: a concrete utility panel with registration marks */
dialog { --text: var(--ink); --muted: var(--ink-2); --dim: #57564f; --line: rgba(20, 20, 22, .16); --line-strong: rgba(20, 20, 22, .42); --well: #f4f3ef; width: min(520px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; padding: 0; border: 0; border-radius: 0; color: var(--ink); background: var(--xh) no-repeat 8px 8px / 18px, var(--xh) no-repeat right 8px bottom 8px / 18px, var(--concrete); box-shadow: 0 30px 80px -20px rgba(0, 0, 0, .9); }
dialog::backdrop { background: rgba(5, 5, 6, .76); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
dialog :focus-visible { outline-color: var(--ink); }
dialog form { padding: 34px 26px 24px; }
dialog h3 { margin: 0; font-family: var(--display); font-size: 24px; font-weight: 800; font-stretch: 122%; line-height: 1.05; text-transform: uppercase; color: var(--ink); overflow-wrap: anywhere; }
dialog p { margin: 10px 0 0; color: var(--ink-2); font-size: 14.5px; }
dialog ul.will { list-style: none; margin: 16px 0 0; padding: 0; border-top: 1px solid var(--line); }
dialog ul.will li { display: grid; grid-template-columns: 54px 1fr; gap: 12px; align-items: baseline; padding: 10px 0; border-bottom: 1px solid var(--line); font-size: 14px; color: var(--ink-2); }
dialog ul.will li b { font-family: var(--display); font-stretch: 125%; font-weight: 800; font-size: 24px; line-height: 1; color: var(--ink); text-align: right; font-variant-numeric: tabular-nums; }
dialog ul.will li.block { color: #7a1610; } dialog ul.will li.block b { color: #b3261e; }
dialog ul.will li strong { color: var(--ink); }
dialog .blocked { margin-top: 14px; padding: 10px 12px; border-left: 3px solid #b3261e; background: rgba(179, 38, 30, .09); color: #5c100b; font-size: 14px; font-weight: 600; }
dialog label { color: var(--ink-2); }
dialog input { color: var(--ink); }
dialog input:hover { border-color: var(--ink); }
dialog input:focus { border-color: var(--ink); box-shadow: inset 0 0 0 1px var(--ink); }
dialog button { border-color: var(--ink); }
dialog button.ghost { color: var(--ink); border-color: rgba(20, 20, 22, .45); }
dialog button.ghost:hover { border-color: var(--ink); background: rgba(20, 20, 22, .06); }
dialog button.go { background: #b3261e; border-color: #b3261e; color: #fff; }
dialog button.go:hover { background: #941c15; border-color: #941c15; }
dialog a { color: var(--ink); font-weight: 700; }
.dlg-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; flex-wrap: wrap; }
.toast { position: fixed; left: 50%; bottom: 24px; z-index: 80; transform: translate(-50%, 16px); width: max-content; max-width: calc(100vw - 32px); padding: 13px 18px 13px 16px; border-left: 3px solid var(--accent); background: var(--concrete-2); color: var(--ink); font-size: 14px; font-weight: 600; line-height: 1.4; opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s; box-shadow: 0 20px 50px -10px rgba(0, 0, 0, .8); }
.toast.show { opacity: 1; transform: translate(-50%, 0); }
.toast.bad { border-left-color: #b3261e; background: #ffd9d4; color: #3a0d09; }
</style></head><body>
<header class="top">
  <div class="brand"><svg class="mark" viewBox="0 0 30 18" aria-hidden="true" focusable="false"><path fill="#e4e3df" d="M0 6h30v12H0z"/><path fill="#0a0a0b" d="M18.2 0h5.6l-4.6 18h-5.6z"/><path fill="#ff5a1f" d="M19.6 0h2.8l-4.6 18h-2.8z"/></svg><b>ON D<span>'</span> <i>ROAD</i></b><span class="sub">Command Center</span></div>
  <a class="back" href="/admin">&larr; Back to overview</a>
</header>
<main class="wrap">
  <h1>Events</h1>
  <p class="lead">One event is on at a time. Guests, approvals and profiles carry over from one event to the next; packages, orders, codes and invites belong to each event.</p>

  <section class="card" id="cur" aria-labelledby="cur-name">
    <span class="tag on">Current event</span>
    <p class="evname" id="cur-name">&hellip;</p>
    <p class="since" id="cur-since"></p>
    <div class="kpis" id="cur-kpis" aria-label="Current event totals"></div>
    <form id="cur-form" novalidate>
      <div class="row2">
        <div><label for="cur-in-name">Name</label><input id="cur-in-name" maxlength="80" autocomplete="off"></div>
        <div><label for="cur-in-inv">Invites per guest</label><input id="cur-in-inv" type="number" min="0" max="20" step="1" inputmode="numeric"></div>
      </div>
      <small>Guests see the name as the title of their event page. Invites per guest apply to everyone for this event; extra invites you give someone in the Guests tab come on top.</small>
      <div class="foot"><button type="submit" id="cur-save">Save</button><span id="cur-msg" class="msg" role="status"></span></div>
    </form>
  </section>

  <section class="card" aria-labelledby="new-h">
    <h2 id="new-h">Start a new event</h2>
    <p>The current event ends and becomes a past event. Its paid passes stay as history; they don't open the door at the new one.</p>
    <form id="new-form" novalidate>
      <div class="row2">
        <div><label for="new-name">Name of the new event</label><input id="new-name" maxlength="80" autocomplete="off" placeholder="Example: On D' Road Carnival"></div>
        <div><label for="new-inv">Invites per guest</label><input id="new-inv" type="number" min="0" max="20" step="1" inputmode="numeric" value="2"></div>
      </div>
      <label class="check"><input type="checkbox" id="new-copy" checked><span><b>Copy packages from the current event</b>With their price tiers, sizes and cash payment details. Copies start hidden so you can set prices first. Promo codes aren't copied.</span></label>
      <small>The new event starts with empty event details (fill them in on Event &amp; messages). Payment settings, terms, FAQ, contact details and the size lock stay as they are.</small>
      <div class="foot"><button type="submit" id="new-go">Start new event&hellip;</button><span id="new-msg" class="msg" role="status"></span></div>
    </form>
  </section>

  <section class="card" aria-labelledby="past-h">
    <h2 id="past-h">Past events</h2>
    <p>Read-only. Download each event's orders, or open them in the overview.</p>
    <div id="past"></div>
  </section>
</main>

<dialog id="sw" aria-labelledby="sw-title">
  <form id="sw-form" method="dialog" novalidate>
    <h3 id="sw-title"></h3>
    <p id="sw-text"></p>
    <ul class="will" id="sw-list"></ul>
    <div id="sw-blocked" class="blocked hidden" role="alert"></div>
    <div id="sw-confirm">
      <label for="sw-typed" id="sw-typed-l"></label>
      <input id="sw-typed" autocomplete="off" spellcheck="false">
    </div>
    <p id="sw-err" class="msg err" role="status"></p>
    <div class="dlg-actions">
      <button class="ghost" type="button" id="sw-cancel">Cancel</button>
      <button class="go" type="submit" id="sw-ok" disabled>Start event</button>
    </div>
  </form>
</dialog>
<div id="toast" class="toast" role="status" aria-live="polite"></div>

<script>
var $ = function (id) { return document.getElementById(id); };
var data = null;
function el(tag, text, cls) { var e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = text; if (cls) e.className = cls; return e; }
function money(c) { return c.currency + ' ' + (c.cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function received(list) { return list && list.length ? list.map(money).join(' + ') : 'XCD 0.00'; }
function day(iso) { return iso ? new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'America/Antigua' }) : ''; }
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
function say(id, text, ok) { $(id).textContent = text; $(id).className = 'msg ' + (ok ? 'ok' : 'err'); }
var toastTimer;
function toast(text, bad) { var t = $('toast'); t.textContent = text; t.className = 'toast show' + (bad ? ' bad' : ''); clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = 'toast'; }, 4000); }
function call(path, body) {
  return fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' })
    .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) { var e = new Error(d.error || 'Request failed.'); e.data = d; throw e; } return d; }); });
}
// The typed confirmation, compared like the server does: case and extra spaces don't matter.
function norm(v) { return String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase(); }

function stat(box, label, value, sub, isMoney) {
  var d = el('div', undefined, 'stat');
  d.appendChild(el('span', label, 'label'));
  d.appendChild(el('span', value, 'value' + (isMoney ? ' money' : '')));
  if (sub) d.appendChild(el('span', sub, 'sub'));
  box.appendChild(d);
}

function render() {
  var c = data.current;
  $('cur-name').textContent = c.name;
  $('cur-since').textContent = (c.started_at ? 'Since ' + day(c.started_at) + ' · ' : '') + plural(c.invites_per_guest, 'invite', 'invites') + ' per guest · ' + plural(c.packages, 'package', 'packages');
  var k = $('cur-kpis'); k.replaceChildren();
  stat(k, 'Reserved', String(c.reserved), 'Not paid yet');
  stat(k, 'Paid', String(c.paid), c.free_passes ? plural(c.free_passes, 'free pass', 'free passes') : 'Passes');
  stat(k, 'Received', received(c.received), 'From paid orders', true);
  stat(k, 'Checked in', String(c.checked_in), 'At the door');
  if (document.activeElement !== $('cur-in-name')) $('cur-in-name').value = c.name;
  if (document.activeElement !== $('cur-in-inv')) $('cur-in-inv').value = c.invites_per_guest;
  if (!$('new-inv').dataset.touched) $('new-inv').value = c.invites_per_guest;

  var box = $('past'); box.replaceChildren();
  if (!data.past.length) { box.appendChild(el('p', 'No past events yet.', 'empty')); return; }
  var ul = el('ul', undefined, 'past');
  data.past.forEach(function (e) {
    var li = el('li');
    var head = el('div', undefined, 'ph');
    head.appendChild(el('h3', e.name));
    head.appendChild(el('span', [day(e.started_at), day(e.ended_at)].filter(Boolean).join(' – '), 'dates'));
    li.appendChild(head);
    var f = el('p', undefined, 'facts');
    [[e.paid, 'paid', 'paid'], [e.checked_in, 'checked in', 'checked in'], [e.cancelled, 'cancelled', 'cancelled']].forEach(function (x, i) {
      if (i) f.appendChild(document.createTextNode(' · '));
      f.appendChild(el('b', String(x[0]))); f.appendChild(document.createTextNode(' ' + x[1]));
    });
    f.appendChild(document.createTextNode(' · Received '));
    f.appendChild(el('b', received(e.received)));
    if (e.rsvp_confirmed !== null && e.rsvp_confirmed !== undefined) { f.appendChild(document.createTextNode(' · ')); f.appendChild(el('b', String(e.rsvp_confirmed))); f.appendChild(document.createTextNode(' confirmed attendance')); }
    li.appendChild(f);
    var acts = el('div', undefined, 'acts');
    var csv = el('a', 'Orders CSV', 'btn small ghost'); csv.href = '/api/admin/events/' + e.id + '/orders.csv'; csv.setAttribute('download', '');
    var view = el('a', 'View orders', 'btn small ghost'); view.href = '/admin?event=' + e.id + '#orders';
    acts.appendChild(csv); acts.appendChild(view);
    li.appendChild(acts);
    ul.appendChild(li);
  });
  box.appendChild(ul);
}

function load() { return call('/api/admin/events').then(function (d) { data = d; render(); }).catch(function (e) { toast(e.message, true); }); }

$('new-inv').addEventListener('input', function () { this.dataset.touched = '1'; });
$('cur-form').addEventListener('submit', function (e) {
  e.preventDefault();
  var b = $('cur-save'); b.disabled = true; $('cur-msg').textContent = '';
  call('/api/admin/events/current', { name: $('cur-in-name').value, invites_per_guest: $('cur-in-inv').value })
    .then(function () { say('cur-msg', 'Saved.', true); return load(); })
    .catch(function (err) { say('cur-msg', err.message); })
    .then(function () { b.disabled = false; });
});

// ---------- Start a new event: the warning, then the typed name ----------
var pending = null, opener = null;
function openSwitch(body) {
  pending = body;
  var c = data.switch, cur = data.current;
  $('sw-title').textContent = 'Start ' + body.name + '?';
  $('sw-text').textContent = cur.name + ' ends now and becomes a past event. This can\\'t be undone.';
  var ul = $('sw-list'); ul.replaceChildren();
  function row(n, html, block) { var li = el('li', undefined, block ? 'block' : ''); li.appendChild(el('b', String(n))); var s = el('span'); s.innerHTML = html; li.appendChild(s); ul.appendChild(li); }
  row(c.unpaid, '<strong>' + (c.unpaid === 1 ? 'unpaid reservation is' : 'unpaid reservations are') + ' cancelled.</strong> Nobody is emailed.');
  row(c.refund_requests, '<strong>' + (c.refund_requests === 1 ? 'refund request' : 'refund requests') + '</strong> waiting. ' + (c.refund_requests ? 'Handle them first.' : 'Nothing to handle.'), c.refund_requests > 0);
  if (c.paypal_busy) row(c.paypal_busy, '<strong>PayPal ' + (c.paypal_busy === 1 ? 'payment is' : 'payments are') + ' in progress.</strong> Wait for them to finish.', true);
  row(c.paid_guests, '<strong>' + (c.paid_guests === 1 ? 'paid guest keeps their pass' : 'paid guests keep their passes') + '</strong> as history. They don\\'t open the door at the new event.');
  row(c.attendance_confirmed, (c.attendance_confirmed === 1 ? 'confirmed attendance goes' : 'confirmed attendances go') + ' back to pending, for the new event.');
  row(c.pending_invites, (c.pending_invites === 1 ? 'pending invite stays' : 'pending invites stay') + ' open. Everyone gets ' + plural(body.invites_per_guest, 'invite', 'invites') + ' for the new event.');
  row(body.copy_packages ? c.packages : 0, body.copy_packages ? (c.packages === 1 ? 'package is' : 'packages are') + ' copied, hidden until you show them.' : 'packages copied. You\\'ll create new ones.');
  var blocked = c.refund_requests > 0 || c.paypal_busy > 0;
  $('sw-blocked').classList.toggle('hidden', !blocked);
  $('sw-blocked').innerHTML = c.refund_requests ? 'Approve or settle the open refund requests in the <a href="/admin">Orders tab</a> first.' : blocked ? 'Wait until the PayPal payments have finished, then try again.' : '';
  $('sw-confirm').classList.toggle('hidden', blocked);
  $('sw-typed-l').textContent = 'Type "' + body.name + '" to confirm';
  $('sw-typed').value = '';
  $('sw-err').textContent = '';
  $('sw-ok').textContent = 'Start ' + body.name;
  $('sw-ok').disabled = true;
  $('sw-ok').classList.toggle('hidden', blocked);
  opener = document.activeElement;
  $('sw').showModal();
  (blocked ? $('sw-cancel') : $('sw-typed')).focus();
}
function closeSwitch() { if ($('sw').open) $('sw').close(); }
$('sw').addEventListener('close', function () { pending = null; if (opener && opener.focus) opener.focus(); });
$('sw-cancel').addEventListener('click', closeSwitch);
$('sw-typed').addEventListener('input', function () { $('sw-ok').disabled = !pending || norm(this.value) !== norm(pending.name); });
$('sw-form').addEventListener('submit', function (e) {
  e.preventDefault();
  if (!pending || $('sw-ok').disabled) return;
  var body = Object.assign({}, pending, { confirm: $('sw-typed').value });
  $('sw-ok').disabled = true; $('sw-err').textContent = '';
  call('/api/admin/events/start', body).then(function (d) {
    closeSwitch();
    $('new-name').value = ''; delete $('new-inv').dataset.touched;
    say('new-msg', d.event.name + ' is on.' + (d.cancelled ? ' ' + plural(d.cancelled, 'unpaid reservation', 'unpaid reservations') + ' cancelled.' : '') + (d.copied ? ' ' + plural(d.copied, 'package', 'packages') + ' copied, hidden for now.' : ''), true);
    return load();
  }).catch(function (err) {
    $('sw-err').textContent = err.message;
    $('sw-ok').disabled = false;
    if (err.data && err.data.counts) { data.switch = err.data.counts; var p = pending; closeSwitch(); openSwitch(p); $('sw-err').textContent = err.message; }
  });
});
$('new-form').addEventListener('submit', function (e) {
  e.preventDefault();
  $('new-msg').textContent = '';
  var name = $('new-name').value.replace(/\\s+/g, ' ').trim(), inv = $('new-inv').value.trim();
  if (!name) { say('new-msg', 'Give the new event a name.'); $('new-name').focus(); return; }
  if (!/^\\d+$/.test(inv) || Number(inv) > 20) { say('new-msg', 'Invites per guest is a whole number from 0 to 20.'); $('new-inv').focus(); return; }
  var b = $('new-go'); b.disabled = true;
  // Fresh counts, so the warning is up to date.
  load().then(function () { if (data) openSwitch({ name: name, invites_per_guest: Number(inv), copy_packages: $('new-copy').checked }); })
    .then(function () { b.disabled = false; });
});
load();
</script></body></html>`;
