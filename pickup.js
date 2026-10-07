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
        pool.query(
          `SELECT o.id, o.reference_code, o.guest_email, o.package_id, p.name AS package_name, o.size, o.status,
                  o.picked_up_at, o.picked_up_by
           FROM orders o JOIN packages p ON p.id = o.package_id
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
<meta name="robots" content="noindex"><meta name="theme-color" content="#0b0a09">
<title>Sizes &amp; pickup | On D' Road</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
:root { --bg: #0b0a09; --surface: #141210; --surface-2: #1b1815; --line: rgba(243, 236, 226, .09); --line-strong: rgba(243, 236, 226, .2); --text: #f3ece2; --muted: #9b9389; --dim: #6c665e; --accent: #ff5b1f; --accent-ink: #120703; --good: #4fc3a1; --warn: #f0b43c; --bad: #ff6a5c; --mono: 'JetBrains Mono', ui-monospace, monospace; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 'Inter', system-ui, -apple-system, sans-serif; -webkit-font-smoothing: antialiased; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.hidden { display: none !important; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.top { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px clamp(16px, 3vw, 32px); background: rgba(11, 10, 9, .8); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 14px; }
.brand b { font-family: 'Anton', Impact, sans-serif; font-weight: 400; font-size: 20px; letter-spacing: .04em; }
.brand b span { color: var(--accent); }
.brand .sub { font-size: 12px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); padding-left: 14px; border-left: 1px solid var(--line-strong); }
.back { font-size: 13px; font-weight: 500; color: var(--muted); text-decoration: none; padding: 8px 12px; border-radius: 8px; white-space: nowrap; }
.back:hover { color: var(--text); background: rgba(243, 236, 226, .05); }
.wrap { max-width: 880px; margin: 0 auto; padding: clamp(24px, 4vw, 48px) clamp(16px, 3vw, 32px) 80px; }
h1 { font-family: 'Anton', Impact, sans-serif; font-weight: 400; font-size: clamp(36px, 6vw, 52px); line-height: .95; text-transform: uppercase; margin: 0; }
h2 { font-family: 'Anton', Impact, sans-serif; font-weight: 400; font-size: 26px; text-transform: uppercase; margin: 0 0 4px; }
h3 { font-size: 16px; font-weight: 700; margin: 0; }
.lead { color: var(--muted); margin: 10px 0 26px; }
.card { background: linear-gradient(180deg, var(--surface-2), var(--surface)); border: 1px solid var(--line); border-radius: 14px; padding: clamp(20px, 3vw, 28px); margin-bottom: 22px; }
.card > p { color: var(--muted); margin: 0; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px 16px; flex-wrap: wrap; }
.head .acts { display: flex; gap: 8px; flex-wrap: wrap; }
small { display: block; color: var(--dim); font-size: 13px; margin-top: 12px; }
input, select { font: 500 15px 'Inter', system-ui, sans-serif; color: var(--text); background: rgba(0, 0, 0, .35); border: 1px solid var(--line-strong); border-radius: 10px; padding: 12px 14px; transition: border-color .15s, box-shadow .15s; }
input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(255, 91, 31, .16); }
input::placeholder { color: var(--dim); }
select { cursor: pointer; }
button { font: 600 14px 'Inter', system-ui, sans-serif; padding: 13px 22px; border-radius: 10px; cursor: pointer; color: var(--accent-ink); background: var(--accent); border: 1px solid var(--accent); }
button.ghost { color: var(--text); background: transparent; border-color: var(--line-strong); }
button.small { padding: 8px 12px; font-size: 13px; }
button:hover { filter: brightness(1.08); }
button:disabled { opacity: .5; cursor: progress; }
.foot { display: flex; align-items: center; gap: 14px; margin-top: 22px; flex-wrap: wrap; }
.msg { font-size: 14px; font-weight: 600; }
.msg.ok { color: var(--good); } .msg.err { color: var(--bad); }

/* Size lock */
.locks { margin-top: 16px; }
label.rule { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; align-items: start; padding: 12px 14px; margin-top: 10px; border: 1px solid var(--line); border-radius: 12px; cursor: pointer; transition: border-color .15s, opacity .15s; }
label.rule:not(.on) { opacity: .62; }
label.rule.on { border-color: var(--line-strong); opacity: 1; }
.rule input { width: 18px; height: 18px; margin: 2px 0 0; padding: 0; accent-color: var(--accent); cursor: pointer; }
.rule input:focus { box-shadow: none; }
.rule b { font-weight: 600; }
.rule span { grid-column: 2; color: var(--muted); font-size: 14px; }

/* Size counts */
.pkg { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--line); }
.pkg .sub { color: var(--dim); font-size: 13px; margin: 2px 0 0; }
.pkg p.none { color: var(--muted); font-size: 14px; margin: 8px 0 0; }
.tbl { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 12px; }
th { text-align: left; font-size: 11px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); padding: 8px 10px 8px 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 10px 10px 10px 0; border-bottom: 1px solid var(--line); vertical-align: middle; }
th.n, td.n { text-align: right; font-variant-numeric: tabular-nums; width: 90px; }
tr.total td { font-weight: 700; border-bottom: 0; border-top: 1px solid var(--line-strong); }
td .hint { display: block; color: var(--dim); font-size: 12px; }
td.warn, td .warn { color: var(--warn); }
.empty { color: var(--dim); font-style: italic; margin: 14px 0 0; }

/* Pickup */
.progress { margin-top: 18px; }
.progress .line { display: flex; align-items: baseline; gap: 10px; color: var(--muted); }
.progress .line b { font-family: 'Anton', Impact, sans-serif; font-weight: 400; font-size: 44px; line-height: 1; color: var(--text); }
.progress .line span b { font: inherit; font-weight: 600; color: var(--text); }
.meter { height: 8px; border-radius: 8px; background: rgba(243, 236, 226, .08); overflow: hidden; margin-top: 10px; }
.meter i { display: block; height: 100%; width: 0; background: var(--good); border-radius: 8px; transition: width .3s; }
.per { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 18px; color: var(--muted); font-size: 13px; }
.per b { color: var(--text); font-weight: 600; }
.tools { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 22px; }
.tools input { flex: 1 1 240px; min-width: 0; }
.tools select { flex: 0 1 auto; }
td.who { overflow-wrap: anywhere; min-width: 180px; }
td .mono { display: block; font-family: var(--mono); font-size: 12px; color: var(--muted); }
td select { padding: 7px 10px; font-size: 14px; border-radius: 8px; }
.pill { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; padding: 3px 8px; border-radius: 999px; white-space: nowrap; }
.pill.ok { color: var(--good); background: rgba(79, 195, 161, .12); }
.pill.no { color: var(--muted); background: rgba(243, 236, 226, .06); }
td.act { text-align: right; white-space: nowrap; }
#list-msg { display: block; min-height: 22px; margin-top: 10px; }
.printed { display: none; }
@media (max-width: 560px) { .brand .sub { display: none; } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
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
  <div class="brand"><b>ON D<span>'</span> ROAD</b><span class="sub">Command Center</span></div>
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
      <input id="q" type="search" placeholder="Search email, reference, package or size" aria-label="Search the pickup list" autocomplete="off">
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
      <table>
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
function renderLock() { lockInputs().forEach(function (i) { i.checked = i.value === data.size_lock; }); markLock(); }
lockInputs().forEach(function (i) { i.addEventListener('change', function () { markLock(); $('lock-msg').textContent = ''; }); });
$('lock-save').addEventListener('click', function () {
  var b = this, pick = lockInputs().filter(function (i) { return i.checked; })[0];
  if (!pick) return say('lock-msg', 'Choose an option.');
  b.disabled = true; $('lock-msg').textContent = '';
  post('/api/admin/size-lock', { size_lock: pick.value }).then(function (x) {
    if (x.ok) data.size_lock = pick.value;
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
    if (!p.sizes.length) {
      wrap.appendChild(el('p', 'No sizes for this package. ' + p.paid + ' paid, ' + p.reserved + ' reserved, ' + p.collected + ' collected.', 'none'));
      box.appendChild(wrap);
      return;
    }
    wrap.appendChild(el('p', 'Sizes offered: ' + p.sizes.join(', '), 'sub'));
    var t = el('table'), tb = el('tbody');
    t.innerHTML = '<thead><tr><th>Size</th><th class="n">Paid</th><th class="n">Reserved</th><th class="n">Collected</th></tr></thead>';
    p.by_size.forEach(function (s) {
      var tr = el('tr'), name = cell(tr, s.size);
      var offered = p.sizes.indexOf(s.size) >= 0;
      if (s.size === 'No size' && !offered) { name.className = 'warn'; name.appendChild(el('span', 'Ask these guests to pick one', 'hint')); }
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

function matches(o, q, f) {
  if (f === 'todo' && o.picked_up_at) return false;
  if (f === 'done' && !o.picked_up_at) return false;
  if (f === 'nosize' && (o.size || !sizesOf(o).length)) return false;
  if (!q) return true;
  return [o.guest_email, o.reference_code, o.package_name, o.size || ''].join(' ').toLowerCase().indexOf(q) >= 0;
}

function renderRows() {
  var q = $('q').value.trim().toLowerCase(), f = $('f').value;
  var list = data.orders.filter(function (o) { return matches(o, q, f); });
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
  var who = cell(tr, o.guest_email, 'who'); who.appendChild(el('span', o.reference_code, 'mono'));
  cell(tr, o.package_name);
  var sz = cell(tr, ''), sizes = sizesOf(o);
  if (sizes.length) {
    // The admin can change a size even when sizes are locked for guests.
    var sel = el('select');
    sel.setAttribute('aria-label', 'Size for ' + o.guest_email);
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
  if (undo && !window.confirm('Mark the package for ' + o.guest_email + ' as not collected?')) return;
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
function downloadCsv(filename, rows) {
  var q = function (v) { return '"' + String(v === null || v === undefined ? '' : v).split('"').join('""') + '"'; };
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.map(function (r) { return r.map(q).join(','); }).join(NL)], { type: 'text/csv' }));
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
// Sorted by package, then email, so it works as a printed list at the pickup table.
$('list-csv').addEventListener('click', function () {
  var list = data.orders.slice().sort(function (a, b) {
    return a.package_name.localeCompare(b.package_name) || a.guest_email.localeCompare(b.guest_email);
  });
  downloadCsv('ondroad-pickup-list.csv', [['reference', 'email', 'package', 'size', 'collected', 'collected_at', 'collected_by']].concat(list.map(function (o) {
    return [o.reference_code, o.guest_email, o.package_name, o.size || '', o.picked_up_at ? 'yes' : 'no', fmt(o.picked_up_at), o.picked_up_by || ''];
  })));
});

load();
</script></body></html>`;
