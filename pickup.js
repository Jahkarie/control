// pickup.js: size lock and package pickup.
// Once the costume order goes in, the organizers lock sizes so guests can't change theirs from their account
// (for everyone, or only once a guest has paid). The admin can still change any guest's size.
// Packages are handed out with the door scanner's Pickup mode (door.js) or marked collected on the
// "Sizes & pickup" page, which also has the size counts to order stock from.

export const SIZE_LOCKS = ['open', 'paid', 'all'];

// 'open' (guests can change their size), 'paid' (locked once the order is paid) or 'all' (locked for everyone).
// Anything else counts as 'open'. db = pool or a client.
export async function getSizeLock(db) {
  const r = await db.query("SELECT value FROM settings WHERE key = 'size_lock'");
  const v = r.rows[0]?.value;
  return SIZE_LOCKS.includes(v) ? v : 'open';
}

export const isSizeLocked = (lock, status) => lock === 'all' || (lock === 'paid' && status === 'PAID');

// A package's sizes, read the same way as in server.js: "S, m , M, L" -> ['S', 'm', 'L'].
const sizeList = (v) => {
  const out = [];
  for (const part of String(v || '').split(',')) {
    const size = part.trim().slice(0, 15);
    if (size && out.length < 15 && !out.some((x) => x.toLowerCase() === size.toLowerCase())) out.push(size);
  }
  return out;
};
const NO_SIZE = 'No size';
const fmt = (d) => new Date(d).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Antigua' });

export function registerPickup({ app, pool, requireAdmin }) {
  const fail = (res, err) => { console.error('Pickup error:', err); res.status(500).json({ error: 'Server error.' }); };
  const orderId = (v) => (/^\d{1,9}$/.test(String(v)) ? Number(v) : null);

  // Size counts per package (what to order) and the pickup list (paid orders, newest first).
  app.get('/api/admin/pickup', requireAdmin, async (req, res) => {
    try {
      const [lock, pkgs, counts, orders] = await Promise.all([
        getSizeLock(pool),
        // Hidden packages only show while they still have orders.
        pool.query(
          `SELECT p.id, p.name, p.sizes FROM packages p
           WHERE p.active = TRUE OR EXISTS (SELECT 1 FROM orders o WHERE o.package_id = p.id AND o.status <> 'CANCELLED')
           ORDER BY p.sort_order ASC, p.id ASC`),
        pool.query(
          `SELECT package_id, NULLIF(TRIM(size), '') AS size,
                  COUNT(*) FILTER (WHERE status = 'PAID')::int AS paid,
                  COUNT(*) FILTER (WHERE status = 'RESERVED')::int AS reserved,
                  COUNT(*) FILTER (WHERE status = 'PAID' AND picked_up_at IS NOT NULL)::int AS collected
           FROM orders WHERE status IN ('PAID', 'RESERVED') GROUP BY 1, 2`),
        // full_name: the guest's name as on their ID (null when they haven't given it), joined on a lowercased
        // email with one row per email, so an order is never listed twice.
        pool.query(
          `SELECT o.id, o.reference_code, o.guest_email, o.package_id, p.name AS package_name, o.size, o.status,
                  o.picked_up_at, o.picked_up_by, NULLIF(TRIM(g.full_name), '') AS full_name
           FROM orders o JOIN packages p ON p.id = o.package_id
           LEFT JOIN (SELECT DISTINCT ON (LOWER(email)) LOWER(email) AS email, full_name FROM guests ORDER BY LOWER(email), id) g
             ON g.email = LOWER(o.guest_email)
           WHERE o.status = 'PAID' ORDER BY o.id DESC`)
      ]);

      const packages = pkgs.rows.map((p) => {
        const sizes = sizeList(p.sizes);
        // The package's sizes in its own order (even at 0), then sizes it no longer offers, then orders with none.
        const rows = sizes.map((size) => ({ size, paid: 0, reserved: 0, collected: 0 }));
        const extra = [];
        let none = null;
        for (const c of counts.rows) {
          if (c.package_id !== p.id) continue;
          const same = (r) => r.size.toLowerCase() === String(c.size).toLowerCase();
          let row = c.size === null ? none : rows.find(same) || extra.find(same);
          if (!row) {
            row = { size: c.size === null ? NO_SIZE : c.size, paid: 0, reserved: 0, collected: 0 };
            if (c.size === null) none = row; else extra.push(row);
          }
          row.paid += c.paid; row.reserved += c.reserved; row.collected += c.collected;
        }
        const by_size = [...rows, ...extra, ...(none ? [none] : [])];
        const sum = (k) => by_size.reduce((n, r) => n + r[k], 0);
        return { id: p.id, name: p.name, sizes, paid: sum('paid'), reserved: sum('reserved'), collected: sum('collected'), by_size };
      });
      res.json({ size_lock: lock, packages, orders: orders.rows });
    } catch (err) { fail(res, err); }
  });

  app.post('/api/admin/size-lock', requireAdmin, async (req, res) => {
    const lock = req.body?.size_lock;
    if (!SIZE_LOCKS.includes(lock)) return res.status(400).json({ error: 'Choose how sizes are locked.' });
    try {
      await pool.query(
        "INSERT INTO settings (key, value) VALUES ('size_lock', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [lock]);
      res.json({ success: true, size_lock: lock });
    } catch (err) { fail(res, err); }
  });

  // The admin can change a size even when sizes are locked for guests.
  app.post('/api/admin/orders/:id/size', requireAdmin, async (req, res) => {
    const id = orderId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Order not found.' });
    try {
      const r = await pool.query(
        'SELECT o.status, p.sizes FROM orders o JOIN packages p ON p.id = o.package_id WHERE o.id = $1', [id]);
      if (!r.rowCount) return res.status(404).json({ error: 'Order not found.' });
      if (r.rows[0].status === 'CANCELLED') return res.status(400).json({ error: 'This order is cancelled.' });
      const sizes = sizeList(r.rows[0].sizes);
      if (!sizes.length) return res.status(400).json({ error: "This package doesn't have sizes." });
      const want = String(req.body?.size || '').trim().toLowerCase();
      const size = sizes.find((s) => s.toLowerCase() === want);
      if (!size) return res.status(400).json({ error: `Choose one of this package's sizes: ${sizes.join(', ')}.` });
      const u = await pool.query("UPDATE orders SET size = $1 WHERE id = $2 AND status <> 'CANCELLED'", [size, id]);
      if (!u.rowCount) return res.status(400).json({ error: 'This order is cancelled.' });
      res.json({ success: true, size });
    } catch (err) { fail(res, err); }
  });

  // Marks a paid order's package collected from admin, or undoes it. Logged in the door log like a scan.
  app.post('/api/admin/orders/:id/pickup', requireAdmin, async (req, res) => {
    const id = orderId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Order not found.' });
    const undo = req.body?.undo === true;
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      // Locked so a door phone handing out the same package at this moment waits for us.
      const r = await client.query('SELECT status, picked_up_at, picked_up_by FROM orders WHERE id = $1 FOR UPDATE', [id]);
      const o = r.rows[0];
      let error = null;
      if (!o) error = [404, { error: 'Order not found.' }];
      else if (undo && !o.picked_up_at) error = [409, { error: "This package isn't marked as collected." }];
      else if (!undo && o.status !== 'PAID') error = [400, { error: 'Only paid orders can collect a package.' }];
      else if (!undo && o.picked_up_at) {
        error = [409, { error: `Already collected ${fmt(o.picked_up_at)}${o.picked_up_by ? ' by ' + o.picked_up_by : ''}.`,
          picked_up_at: o.picked_up_at, picked_up_by: o.picked_up_by }];
      }
      if (error) {
        await client.query('ROLLBACK');
        return res.status(error[0]).json(error[1]);
      }
      const u = await client.query(
        `UPDATE orders SET picked_up_at = ${undo ? 'NULL' : 'NOW()'}, picked_up_by = ${undo ? 'NULL' : "'Admin'"}
         WHERE id = $1 RETURNING picked_up_at, picked_up_by`, [id]);
      await client.query(
        "INSERT INTO checkins (order_id, kind, device) VALUES ($1, $2, 'Admin')", [id, undo ? 'PICKUP_UNDO' : 'PICKUP']);
      await client.query('COMMIT');
      res.json({ success: true, ...u.rows[0] });
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      fail(res, err);
    } finally {
      client?.release();
    }
  });

  app.get('/admin/pickup', requireAdmin, (req, res) => res.type('html').send(PAGE));
}

// ---------- Sizes & pickup page ----------
const PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#09080b">
<title>Sizes &amp; pickup | On D' Road</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
/* Paint & Powder, admin edition: the guest site's black canvas and neon paint, kept calm for daily work. */
:root { --bg: #09080b; --surface: #131117; --surface-2: #18151d; --raise: #201c26; --well: #0c0b0f; --line: rgba(246, 241, 232, .09); --line-strong: rgba(246, 241, 232, .2); --text: #f6f1e8; --muted: #b4adbb; --dim: #8f8898; --accent: #ff2e93; --accent-ink: #0b0a0d; --good: #a3ff2b; --warn: #ffe500; --bad: #ff4d4d; --cyan: #1ee3ff; --display: 'Archivo', 'Arial Narrow', 'Roboto Condensed', Impact, sans-serif; --body: 'Archivo', system-ui, -apple-system, sans-serif; --mono: 'Space Mono', ui-monospace, monospace; --torn: polygon(0 14%, 3% 0, 22% 7%, 46% 0, 71% 6%, 93% 0, 100% 9%, 97% 34%, 100% 58%, 97% 82%, 100% 100%, 78% 93%, 53% 100%, 28% 94%, 6% 100%, 0 88%, 3% 63%, 0 38%); --drip: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 24' preserveAspectRatio='none'%3E%3Cpath d='M0 1.5C20 .5 40 2.5 60 1.2S100 .4 120 1.6V6.4C110 7.2 100 5.8 90 6.6S70 7.4 60 6.2 40 5.6 30 6.8 10 7.2 0 6.2ZM11.5 5.4Q10.3 6 10.3 8V11a1.3 1.3 0 0 1 -2.6 0V8Q7.7 6 6.5 5.4ZM29.9 5.4Q28.7 6 28.7 8V18a1.7 1.7 0 0 1 -3.4 0V8Q25.3 6 24.1 5.4ZM52.4 5.4Q51.2 6 51.2 8V9a1.2 1.2 0 0 1 -2.4 0V8Q48.8 6 47.6 5.4ZM73.7 5.4Q72.5 6 72.5 8V15a1.5 1.5 0 0 1 -3 0V8Q69.5 6 68.3 5.4ZM98.5 5.4Q97.3 6 97.3 8V11.5a1.3 1.3 0 0 1 -2.6 0V8Q94.7 6 93.5 5.4ZM113.3 5.4Q112.1 6 112.1 8V9a1.1 1.1 0 0 1 -2.2 0V8Q109.9 6 108.7 5.4ZM25.7 22.2a1.3 1.3 0 1 1 2.6 0a1.3 1.3 0 1 1 -2.6 0ZM69.9 19.4a1.1 1.1 0 1 1 2.2 0a1.1 1.1 0 1 1 -2.2 0Z'/%3E%3C/svg%3E"); color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 var(--body); -webkit-font-smoothing: antialiased; }
::selection { background: var(--warn); color: var(--accent-ink); }
:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }
.top { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px clamp(16px, 3vw, 32px); background: rgba(9, 8, 11, .88); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.brand .mark { flex: none; width: 28px; height: 28px; overflow: visible; color: var(--accent); transform: rotate(-14deg); }
.brand b { font-family: var(--display); font-weight: 900; font-stretch: 62%; font-size: 25px; line-height: 1; letter-spacing: .01em; white-space: nowrap; }
.brand b span { color: var(--warn); }
.brand .sub { font-family: var(--mono); font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); padding-left: 12px; border-left: 1px solid var(--line-strong); white-space: nowrap; }
.back { font-size: 13px; font-weight: 600; color: var(--muted); text-decoration: none; padding: 7px 13px; border: 1px solid var(--line); border-radius: 999px; white-space: nowrap; transition: color .15s, border-color .15s, background .15s; }
.back:hover { color: var(--text); border-color: var(--line-strong); background: rgba(246, 241, 232, .05); }
h1 { font-family: var(--display); font-weight: 900; font-stretch: 62%; font-size: clamp(46px, 7vw, 64px); line-height: .88; letter-spacing: .005em; text-transform: uppercase; margin: 0; }
/* A short neon drip under the page title */
h1::after { content: ''; display: block; width: 132px; height: 26px; margin-top: 8px; background: var(--accent); -webkit-mask: var(--drip) left top / 100% 100% no-repeat; mask: var(--drip) left top / 100% 100% no-repeat; }
h2 { font-family: var(--display); font-weight: 900; font-stretch: 62%; font-size: 30px; line-height: 1; letter-spacing: .01em; text-transform: uppercase; margin: 0 0 6px; }
.lead { color: var(--muted); margin: 6px 0 26px; max-width: 620px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: clamp(20px, 3vw, 28px); }
/* Buttons: paint stickers. Pink with ink text and a small misprinted yellow shadow. */
button { font-family: var(--display); font-weight: 800; font-stretch: 78%; font-size: 14.5px; line-height: 1; letter-spacing: .045em; text-transform: uppercase; padding: 13px 21px 12px; border-radius: 999px; cursor: pointer; color: var(--accent-ink); background: var(--accent); border: 1px solid var(--accent); box-shadow: 3px 3px 0 var(--warn); transition: transform .12s, box-shadow .12s, background .15s, border-color .15s, color .15s; }
button:hover { transform: translate(-1px, -1px); box-shadow: 4px 4px 0 var(--warn); }
button:active { transform: translate(2px, 2px); box-shadow: 1px 1px 0 var(--warn); }
button:disabled { opacity: .5; cursor: progress; transform: none; }
button.ghost { color: var(--text); background: transparent; border-color: var(--line-strong); box-shadow: none; }
button.ghost:hover { color: var(--cyan); border-color: var(--cyan); background: rgba(30, 227, 255, .06); transform: none; }
button.ghost:active { transform: translateY(1px); }
.msg { font-size: 14px; font-weight: 700; }
.msg.ok { color: var(--good); } .msg.err { color: var(--bad); }
@media (max-width: 560px) { .brand .sub { display: none; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } button:hover, button:active { transform: none; } }
.hidden { display: none !important; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.wrap { max-width: 880px; margin: 0 auto; padding: clamp(24px, 4vw, 48px) clamp(16px, 3vw, 32px) 80px; }
h2 { margin: 0 0 4px; }
h3 { font-size: 17px; font-weight: 800; margin: 0; }
.card { margin-bottom: 22px; }
.card > p { color: var(--muted); margin: 0; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px 16px; flex-wrap: wrap; }
.head .acts { display: flex; gap: 8px; flex-wrap: wrap; }
small { display: block; color: var(--dim); font-size: 13px; margin-top: 12px; }
input, select { font: 500 15px var(--body); color: var(--text); background: var(--well); border: 1px solid var(--line-strong); border-radius: 8px; padding: 12px 14px; transition: border-color .15s, box-shadow .15s; }
input:hover, select:hover { border-color: rgba(246, 241, 232, .32); }
input:focus, select:focus { outline: none; border-color: var(--cyan); box-shadow: 0 0 0 3px rgba(30, 227, 255, .16); }
input::placeholder { color: var(--dim); }
select { cursor: pointer; padding-right: 36px; -webkit-appearance: none; appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--warn) 50%), linear-gradient(135deg, var(--warn) 50%, transparent 50%); background-position: calc(100% - 18px) 50%, calc(100% - 13px) 50%; background-size: 5px 5px; background-repeat: no-repeat; }
select option { background: var(--surface-2); color: var(--text); }
button.small { padding: 8px 13px 7px; font-size: 13px; box-shadow: 2px 2px 0 var(--warn); }
button.small.ghost { box-shadow: none; }
button.small:active { box-shadow: 1px 1px 0 var(--warn); }
.foot { display: flex; align-items: center; gap: 14px; margin-top: 22px; flex-wrap: wrap; }

/* Size lock */
.locks { margin-top: 16px; }
label.rule { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; align-items: start; padding: 12px 14px; margin-top: 10px; border: 1px solid var(--line); border-radius: 10px; cursor: pointer; transition: border-color .15s, opacity .15s, background .15s; }
label.rule:not(.on) { opacity: .62; }
label.rule.on { border-color: rgba(255, 46, 147, .55); background: rgba(255, 46, 147, .05); opacity: 1; }
.rule input { width: 18px; height: 18px; margin: 2px 0 0; padding: 0; accent-color: var(--accent); cursor: pointer; }
.rule input:focus { box-shadow: none; }
.rule input:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }
.rule b { font-weight: 700; }
.rule span { grid-column: 2; color: var(--muted); font-size: 14px; }

/* Size counts */
.pkg { margin-top: 22px; padding-top: 18px; border-top: 1px dashed var(--line-strong); }
.pkg .sub { color: var(--dim); font-size: 13px; margin: 2px 0 0; }
.pkg p.none { color: var(--muted); font-size: 14px; margin: 8px 0 0; }
.tbl { position: relative; overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 12px; }
th { text-align: left; font-family: var(--mono); font-size: 10.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); padding: 8px 10px 8px 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 10px 10px 10px 0; border-bottom: 1px solid var(--line); vertical-align: middle; }
th.n, td.n { text-align: right; font-variant-numeric: tabular-nums; width: 90px; }
tr.total td { font-weight: 800; border-bottom: 0; border-top: 1px solid var(--line-strong); }
td .hint { display: block; color: var(--dim); font-size: 12px; }
td.warn, td .warn { color: var(--warn); }
.empty { color: var(--dim); font-style: italic; margin: 14px 0 0; }

/* Pickup */
.progress { margin-top: 18px; }
.progress .line { display: flex; align-items: baseline; gap: 10px; color: var(--muted); }
.progress .line b { font-family: var(--display); font-weight: 900; font-stretch: 62%; font-size: 56px; line-height: .9; color: var(--good); }
.progress .line span b { font: inherit; font-weight: 700; color: var(--text); }
.meter { height: 10px; border-radius: 10px; background: rgba(246, 241, 232, .08); overflow: hidden; margin-top: 12px; }
.meter i { display: block; height: 100%; width: 0; background: var(--good); border-radius: 10px; transition: width .3s; }
.per { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 18px; color: var(--muted); font-size: 13px; }
.per b { color: var(--text); font-weight: 700; }
.tools { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 22px; }
.tools input { flex: 1 1 240px; min-width: 0; }
.tools select { flex: 0 1 auto; }
td.who { overflow-wrap: anywhere; min-width: 180px; }
td.who .name { display: block; font-size: 15.5px; font-weight: 800; line-height: 1.3; }
td.who .email { display: block; }
td.who .name + .email { color: var(--muted); font-size: 14px; }
td .mono { display: block; font-family: var(--mono); font-size: 12px; color: var(--muted); }
td select { padding: 7px 30px 7px 10px; font-size: 14px; border-radius: 8px; background-position: calc(100% - 15px) 50%, calc(100% - 10px) 50%; }
.pill { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 10.5px; font-weight: 700; letter-spacing: .06em; line-height: 1.3; text-transform: uppercase; padding: 4px 10px 3px; border-radius: 999px; white-space: nowrap; border: 1px solid var(--line-strong); }
.pill::before { content: ''; flex: none; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pill.ok { color: var(--good); background: rgba(163, 255, 43, .08); border-color: rgba(163, 255, 43, .38); }
.pill.no { color: var(--muted); background: rgba(246, 241, 232, .04); }
td.act { text-align: right; white-space: nowrap; }
#list-msg { display: block; min-height: 22px; margin-top: 10px; }
.printed { display: none; }
@media (max-width: 560px) {
  /* Phones: one block per guest in the pickup list, so the pickup status and button stay on screen. */
  table.list, table.list tbody { display: block; }
  table.list thead { display: none; }
  table.list tr { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 14px 0; border-bottom: 1px solid var(--line); }
  table.list td { padding: 0; border: 0; }
  table.list td.who { flex: 0 0 100%; min-width: 0; }
  table.list td.act { margin-left: auto; }
}
@media print {
  :root { --text: #000; --muted: #333; --dim: #555; --line: #bbb; --line-strong: #000; }
  body { background: #fff; color: #000; font-size: 12px; }
  .top, .card:not(#sizes-card), .lead, h1, .head .acts, #sizes-card > p.intro { display: none !important; }
  .wrap { padding: 0; max-width: none; }
  .card { background: none; border: 0; padding: 0; }
  .pkg { break-inside: avoid; }
  .printed { display: block; color: #555; margin-top: 18px; font-size: 11px; }
}
</style></head><body>
<header class="top">
  <div class="brand"><svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path fill="currentColor" d="M29.1 16.4C28.6 17 25.8 17.4 24.9 17.9C24 18.3 24 18.6 23.9 19.1C23.7 19.5 23.6 19.9 23.7 20.5C23.7 21.1 24.2 22 24.2 22.6C24.2 23.3 24.2 24.2 23.8 24.6C23.3 24.9 22.3 24.7 21.6 24.6C20.9 24.6 20.1 24.2 19.5 24.1C18.9 24 18.5 23.7 18.1 24.2C17.7 24.6 17.7 25.9 17.2 26.7C16.8 27.5 16.1 29.2 15.6 28.9C15.1 28.6 14.7 25.8 14.2 25C13.8 24.1 13.6 24.1 13.1 24C12.7 23.8 12.3 23.9 11.7 24C11.2 24.1 10.5 24.3 9.7 24.5C8.9 24.7 7.5 25.4 6.8 25.2C6 25.1 5.4 24.5 5.4 23.8C5.4 23.1 6.4 21.7 6.7 21C7 20.2 7.6 19.6 7.2 19.1C6.7 18.7 4.6 18.7 4 18.2C3.4 17.8 3 16.9 3.6 16.4C4.2 15.9 6.6 15.5 7.4 15.1C8.1 14.7 8 14.4 8 13.9C8.1 13.5 8 13 7.9 12.5C7.7 11.9 7.4 11.1 7.3 10.4C7.3 9.7 7.2 8.7 7.5 8.3C7.9 7.9 8.7 7.8 9.4 7.8C10 7.8 10.9 8.3 11.4 8.2C12 8.1 12.2 8 12.6 7.1C12.9 6.2 13 3.5 13.5 3C14 2.5 15 3.2 15.6 3.9C16.2 4.6 16.6 6.5 17 7.3C17.5 8 17.8 8 18.2 8.3C18.6 8.7 18.9 9 19.3 9.2C19.7 9.4 19.9 9.6 20.6 9.5C21.3 9.5 22.6 8.7 23.2 8.8C23.9 8.8 24.5 9.3 24.6 9.9C24.6 10.5 23.7 11.7 23.5 12.4C23.4 13 23.1 13.4 23.9 13.7C24.7 14 27.4 13.9 28.2 14.4C29.1 14.8 29.7 15.8 29.1 16.4ZM12.7 3.8a1.5 1.5 0 1 1 3.1 0a1.5 1.5 0 1 1 -3.1 0ZM23 9a1.4 1.4 0 1 1 2.9 0a1.4 1.4 0 1 1 -2.9 0ZM27.1 15.5a1.6 1.6 0 1 1 3.1 0a1.6 1.6 0 1 1 -3.1 0ZM14.5 28.9a1.5 1.5 0 1 1 3 0a1.5 1.5 0 1 1 -3 0ZM5.5 23.7a1.4 1.4 0 1 1 2.8 0a1.4 1.4 0 1 1 -2.8 0ZM1.4 17.3a1.5 1.5 0 1 1 3.1 0a1.5 1.5 0 1 1 -3.1 0ZM27.4 5.4a1.2 1.2 0 1 1 2.4 0a1.2 1.2 0 1 1 -2.4 0ZM2.6 27a1 1 0 1 1 2 0a1 1 0 1 1 -2 0ZM26.6 28.2a0.8 0.8 0 1 1 1.6 0a0.8 0.8 0 1 1 -1.6 0Z"/></svg><b>ON D<span>'</span> ROAD</b><span class="sub">Command Center</span></div>
  <a class="back" href="/admin">&larr; Back to overview</a>
</header>
<main class="wrap">
  <h1>Sizes &amp; pickup</h1>
  <p class="lead">Lock sizes before you order costumes, see how many of each size to order, and track who has collected their package.</p>

  <section class="card" aria-labelledby="lock-h">
    <h2 id="lock-h">Size lock</h2>
    <p>Whether guests can still change their size from their account.</p>
    <div class="locks" role="radiogroup" aria-labelledby="lock-h">
      <label class="rule"><input type="radio" name="lock" value="open"><b>Open</b><span>Guests can change their size any time.</span></label>
      <label class="rule"><input type="radio" name="lock" value="paid"><b>Locked once paid</b><span>Guests can change their size until they pay. Use this if you order stock as payments come in.</span></label>
      <label class="rule"><input type="radio" name="lock" value="all"><b>Locked for everyone</b><span>Nobody can change their size. Use this once the costume order has gone in.</span></label>
    </div>
    <small>Guests whose size is locked are told to contact you. You can still change anyone's size in the pickup list below or in the Orders tab.</small>
    <div class="foot"><button id="lock-save" type="button">Save size lock</button><span id="lock-msg" class="msg" role="status"></span></div>
  </section>

  <section class="card" id="sizes-card" aria-labelledby="sz-h">
    <div class="head">
      <h2 id="sz-h">Size counts</h2>
      <div class="acts"><button class="ghost small" id="print-btn" type="button">Print</button><button class="ghost small" id="sizes-csv" type="button">Download (CSV)</button></div>
    </div>
    <p class="intro">How many of each size to order, per package. Paid orders are confirmed; reserved ones can still expire or be cancelled.</p>
    <div id="sizes"><p class="empty">Loading...</p></div>
    <p class="printed" id="printed"></p>
  </section>

  <section class="card" aria-labelledby="pu-h">
    <div class="head">
      <h2 id="pu-h">Pickup</h2>
      <div class="acts"><button class="ghost small" id="refresh-btn" type="button">Refresh</button></div>
    </div>
    <p>Hand packages out with the door scanner in Pickup mode, or mark them here. Packages only go to the guest themselves, with photo ID.</p>
    <div class="progress">
      <div class="line"><b id="pu-n">0</b><span>of <b id="pu-m">0</b> paid packages collected</span></div>
      <div class="meter" id="pu-meter" role="progressbar" aria-label="Packages collected" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"><i id="pu-bar"></i></div>
      <ul class="per" id="pu-per"></ul>
    </div>
    <div class="tools">
      <input id="q" type="search" placeholder="Search name, email, package or size" aria-label="Search the pickup list" autocomplete="off">
      <select id="f" aria-label="Show">
        <option value="">All paid orders</option>
        <option value="todo">Not collected yet</option>
        <option value="done">Collected</option>
        <option value="nosize">No size picked</option>
      </select>
      <button class="ghost" id="list-csv" type="button">Download pickup list (CSV)</button>
    </div>
    <span id="list-msg" class="msg" role="status"></span>
    <div class="tbl">
      <table class="list">
        <thead><tr><th>Guest</th><th>Package</th><th>Size</th><th>Pickup</th><th><span class="sr">Action</span></th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <p class="empty hidden" id="rows-empty"></p>
  </section>
</main>
<script>
var $ = function (id) { return document.getElementById(id); };
var NL = String.fromCharCode(10);
var data = { size_lock: 'open', packages: [], orders: [] };
var MAX_ROWS = 400;

function el(tag, text, cls) { var e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = text; if (cls) e.className = cls; return e; }
// Search fold, the same as the door scanner's: lowercase, no accents, ' . , dropped and - read as a space.
// Built with String.fromCharCode because this page sits inside a template literal (no backslash escapes).
var MARKS = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');
var FOLD_DROP = "'.," + String.fromCharCode(0x2019, 0x2018, 0x2bc, 0xb4, 0x60);
var FOLD_SPACE = '-' + String.fromCharCode(0x2010, 0x2011, 0x2013, 0x2014, 0x2212, 0xa0, 9, 10, 13);
function fold(s) {
  s = String(s || '').toLowerCase();
  if (s.normalize) s = s.normalize('NFD');
  s = s.replace(MARKS, '');
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (FOLD_DROP.indexOf(c) >= 0) continue;
    out += FOLD_SPACE.indexOf(c) >= 0 ? ' ' : c;
  }
  return out;
}
function nameOf(o) { return String(o.full_name || '').trim(); }
function say(id, text, ok) { $(id).textContent = text; $(id).className = 'msg ' + (ok ? 'ok' : 'err'); }
function fmt(iso) { return iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Antigua' }) : ''; }
function post(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); });
}
function pkgOf(o) { for (var i = 0; i < data.packages.length; i++) if (data.packages[i].id === o.package_id) return data.packages[i]; return null; }
function sizesOf(o) { var p = pkgOf(o); return p ? p.sizes : []; }

function load() {
  return fetch('/api/admin/pickup', { cache: 'no-store' }).then(function (r) {
    if (!r.ok) throw new Error();
    return r.json();
  }).then(function (d) {
    data = d;
    renderLock(); renderSizes(); renderPickup();
  }).catch(function () {
    say('list-msg', 'Could not load the list. Check your connection and tap Refresh.');
    if (!data.packages.length) $('sizes').replaceChildren(el('p', 'Could not load the size counts.', 'empty'));
  });
}

// ---------- Size lock ----------
function lockInputs() { return Array.prototype.slice.call(document.querySelectorAll('input[name=lock]')); }
function markLock() { lockInputs().forEach(function (i) { i.closest('.rule').classList.toggle('on', i.checked); }); }
// A choice not saved yet stays picked when the page reloads its data (Refresh, coming back to the tab, a pickup).
var lockDirty = false;
function renderLock() { if (lockDirty) return; lockInputs().forEach(function (i) { i.checked = i.value === data.size_lock; }); markLock(); }
lockInputs().forEach(function (i) { i.addEventListener('change', function () { lockDirty = true; markLock(); $('lock-msg').textContent = ''; }); });
$('lock-save').addEventListener('click', function () {
  var b = this, pick = lockInputs().filter(function (i) { return i.checked; })[0];
  if (!pick) return say('lock-msg', 'Choose an option.');
  b.disabled = true; $('lock-msg').textContent = '';
  post('/api/admin/size-lock', { size_lock: pick.value }).then(function (x) {
    if (x.ok) { data.size_lock = pick.value; lockDirty = false; }
    say('lock-msg', x.ok ? 'Saved. Guests see it now.' : (x.d.error || 'Could not save.'), x.ok);
  }).catch(function () { say('lock-msg', 'Could not save.'); }).then(function () { b.disabled = false; });
});

// ---------- Size counts ----------
function cell(tr, text, cls) { var td = el('td', text, cls); tr.appendChild(td); return td; }
function renderSizes() {
  var box = $('sizes'); box.replaceChildren();
  if (!data.packages.length) { box.appendChild(el('p', 'No packages yet.', 'empty')); return; }
  data.packages.forEach(function (p) {
    var wrap = el('div', undefined, 'pkg');
    wrap.appendChild(el('h3', p.name));
    // A package that stopped offering sizes still shows the sizes its orders have.
    var picked = p.by_size.some(function (s) { return s.size !== 'No size'; });
    if (!p.sizes.length && !picked) {
      wrap.appendChild(el('p', 'No sizes for this package. ' + p.paid + ' paid, ' + p.reserved + ' reserved, ' + p.collected + ' collected.', 'none'));
      box.appendChild(wrap);
      return;
    }
    wrap.appendChild(el('p', p.sizes.length ? 'Sizes offered: ' + p.sizes.join(', ') : 'No sizes offered now. Orders still have these:', 'sub'));
    var t = el('table'), tb = el('tbody');
    t.innerHTML = '<thead><tr><th>Size</th><th class="n">Paid</th><th class="n">Reserved</th><th class="n">Collected</th></tr></thead>';
    p.by_size.forEach(function (s) {
      var tr = el('tr'), name = cell(tr, s.size);
      var offered = p.sizes.indexOf(s.size) >= 0;
      if (s.size === 'No size' && !offered) { if (p.sizes.length) { name.className = 'warn'; name.appendChild(el('span', 'Ask these guests to pick one', 'hint')); } }
      else if (!offered) name.appendChild(el('span', 'No longer offered', 'hint'));
      cell(tr, s.paid, 'n'); cell(tr, s.reserved, 'n'); cell(tr, s.collected, 'n');
      tb.appendChild(tr);
    });
    var tot = el('tr', undefined, 'total');
    cell(tot, 'Total'); cell(tot, p.paid, 'n'); cell(tot, p.reserved, 'n'); cell(tot, p.collected, 'n');
    tb.appendChild(tot);
    t.appendChild(tb);
    var scroll = el('div', undefined, 'tbl'); scroll.appendChild(t);
    wrap.appendChild(scroll);
    box.appendChild(wrap);
  });
}
$('print-btn').addEventListener('click', function () {
  $('printed').textContent = "On D' Road size counts, " + new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Antigua' }) + ' Antigua time.';
  window.print();
});

// ---------- Pickup ----------
function renderPickup() {
  var paid = data.orders.length, done = data.orders.filter(function (o) { return o.picked_up_at; }).length;
  $('pu-n').textContent = done; $('pu-m').textContent = paid;
  $('pu-bar').style.width = (paid ? Math.round(done / paid * 100) : 0) + '%';
  $('pu-meter').setAttribute('aria-valuemax', paid); $('pu-meter').setAttribute('aria-valuenow', done);
  var per = $('pu-per'); per.replaceChildren();
  var withPaid = data.packages.filter(function (p) { return p.paid; });
  if (withPaid.length > 1) withPaid.forEach(function (p) {
    var li = el('li', p.name + ': '); li.appendChild(el('b', p.collected + ' of ' + p.paid)); per.appendChild(li);
  });
  renderRows();
}

// words: the folded search words. Each must be in the guest's name, email, reference, package or size, in any order.
function matches(o, words, f) {
  if (f === 'todo' && o.picked_up_at) return false;
  if (f === 'done' && !o.picked_up_at) return false;
  if (f === 'nosize' && (o.size || !sizesOf(o).length)) return false;
  if (!words.length) return true;
  var hay = fold([nameOf(o), o.guest_email, o.reference_code, o.package_name, o.size || ''].join(' '));
  return words.every(function (w) { return hay.indexOf(w) >= 0; });
}

function renderRows() {
  var words = fold($('q').value).split(' ').filter(Boolean), f = $('f').value;
  var list = data.orders.filter(function (o) { return matches(o, words, f); });
  var tb = $('rows'); tb.replaceChildren();
  var empty = $('rows-empty');
  empty.classList.toggle('hidden', list.length > 0);
  empty.textContent = data.orders.length ? 'No paid orders match.' : 'No paid orders yet.';
  list.slice(0, MAX_ROWS).forEach(function (o) { tb.appendChild(row(o)); });
  if (list.length > MAX_ROWS) {
    var tr = el('tr'), td = cell(tr, 'Showing ' + MAX_ROWS + ' of ' + list.length + '. Search to narrow it down.', 'hint');
    td.colSpan = 5; tb.appendChild(tr);
  }
}

function row(o) {
  var tr = el('tr');
  // The name as on their ID above the email, when the guest has given it.
  var who = cell(tr, '', 'who'), name = nameOf(o);
  if (name) who.appendChild(el('span', name, 'name'));
  who.appendChild(el('span', o.guest_email, 'email'));
  who.appendChild(el('span', o.reference_code, 'mono'));
  cell(tr, o.package_name);
  var sz = cell(tr, ''), sizes = sizesOf(o);
  if (sizes.length) {
    // The admin can change a size even when sizes are locked for guests.
    var sel = el('select');
    sel.setAttribute('aria-label', 'Size for ' + (name || o.guest_email));
    if (!o.size || sizes.indexOf(o.size) < 0) { var cur = el('option', o.size || 'Pick a size'); cur.value = ''; cur.disabled = true; sel.appendChild(cur); }
    sizes.forEach(function (s) { var opt = el('option', s); opt.value = s; sel.appendChild(opt); });
    sel.value = o.size && sizes.indexOf(o.size) >= 0 ? o.size : '';
    sel.addEventListener('change', function () { setSize(o, sel); });
    sz.appendChild(sel);
    if (!o.size) sz.appendChild(el('span', 'No size picked', 'hint warn'));
  } else {
    sz.textContent = o.size || '-';
  }
  var st = cell(tr, '');
  if (o.picked_up_at) {
    st.appendChild(el('span', 'Collected', 'pill ok'));
    st.appendChild(el('span', fmt(o.picked_up_at) + (o.picked_up_by ? ' · ' + o.picked_up_by : ''), 'hint'));
  } else {
    st.appendChild(el('span', 'Not yet', 'pill no'));
  }
  var act = cell(tr, '', 'act');
  var b = el('button', o.picked_up_at ? 'Undo' : 'Mark collected', o.picked_up_at ? 'ghost small' : 'small');
  b.type = 'button';
  b.addEventListener('click', function () { setPickup(o, b); });
  act.appendChild(b);
  return tr;
}

function setSize(o, sel) {
  var size = sel.value;
  sel.disabled = true;
  post('/api/admin/orders/' + o.id + '/size', { size: size }).then(function (x) {
    if (!x.ok) throw new Error(x.d.error || 'Could not change the size.');
    say('list-msg', 'Size for ' + o.guest_email + ' set to ' + x.d.size + '.', true);
    return load();
  }).catch(function (err) {
    say('list-msg', err.message || 'Could not change the size.');
    sel.value = o.size || '';
    sel.disabled = false;
  });
}

function setPickup(o, b) {
  var undo = !!o.picked_up_at;
  // Undo takes a second tap, so a slip of the finger doesn't un-collect a package.
  if (undo && !b.getAttribute('data-sure')) {
    b.setAttribute('data-sure', '1');
    b.textContent = 'Tap again to undo';
    setTimeout(function () { b.removeAttribute('data-sure'); b.textContent = 'Undo'; }, 4000);
    return;
  }
  b.disabled = true;
  post('/api/admin/orders/' + o.id + '/pickup', undo ? { undo: true } : {}).then(function (x) {
    say('list-msg', x.ok ? (undo ? 'Pickup undone for ' : 'Package collected: ') + o.guest_email + '.' : (x.d.error || 'Could not save.'), x.ok);
    // Someone at the door may have just handed it out: reload either way.
    return load();
  }).catch(function () { say('list-msg', 'Could not save. Check your connection.'); b.disabled = false; });
}

$('q').addEventListener('input', renderRows);
$('f').addEventListener('change', renderRows);
$('refresh-btn').addEventListener('click', function () { $('list-msg').textContent = ''; load(); });
document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') load(); });

// ---------- CSV ----------
// A cell starting with = + - @ (or a tab or return) would run as a formula in Excel or Sheets, and some come from
// outside (a door phone's name, guests' emails), so those get a leading ' and stay plain text.
var FORMULA_START = '=+-@' + String.fromCharCode(9, 13);
function downloadCsv(filename, rows) {
  var q = function (v) {
    var s = String(v === null || v === undefined ? '' : v);
    if (s && FORMULA_START.indexOf(s.charAt(0)) >= 0) s = "'" + s;
    return '"' + s.split('"').join('""') + '"';
  };
  var a = document.createElement('a');
  // The byte-order mark makes Excel read the file as UTF-8, so accented names come out right.
  a.href = URL.createObjectURL(new Blob([String.fromCharCode(0xFEFF) + rows.map(function (r) { return r.map(q).join(','); }).join(NL)], { type: 'text/csv;charset=utf-8' }));
  a.download = filename; a.click();
}
$('sizes-csv').addEventListener('click', function () {
  var rows = [['package', 'size', 'paid', 'reserved', 'collected']];
  data.packages.forEach(function (p) {
    p.by_size.forEach(function (s) { rows.push([p.name, s.size, s.paid, s.reserved, s.collected]); });
    rows.push([p.name, 'Total', p.paid, p.reserved, p.collected]);
  });
  downloadCsv('ondroad-size-counts.csv', rows);
});
// Sorted by package, then name (email for guests without one), so it works as a printed list at the pickup table.
$('list-csv').addEventListener('click', function () {
  var key = function (o) { return nameOf(o) || o.guest_email; };
  var list = data.orders.slice().sort(function (a, b) {
    return a.package_name.localeCompare(b.package_name) || key(a).localeCompare(key(b), 'en', { sensitivity: 'base' }) || a.guest_email.localeCompare(b.guest_email);
  });
  downloadCsv('ondroad-pickup-list.csv', [['reference', 'name', 'email', 'package', 'size', 'collected', 'collected_at', 'collected_by']].concat(list.map(function (o) {
    return [o.reference_code, nameOf(o), o.guest_email, o.package_name, o.size || '', o.picked_up_at ? 'yes' : 'no', fmt(o.picked_up_at), o.picked_up_by || ''];
  })));
});

load();
</script></body></html>`;
