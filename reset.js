// reset.js: wipes data so the event can start over (for example after testing). Two scopes:
// - 'guests': guests, invites, login links, orders (with their check-ins and pickups) and the group email log.
//   Keeps the setup: packages, price tiers, promo codes and every setting.
// - 'everything': all of that plus packages, price tiers, promo codes and every setting (payments, event, contact,
//   terms, FAQ, sponsors, size lock), so the site is back to its built-in defaults.
// The page asks the server for a one-time 6-digit number for a scope, and the reset only runs when that number is
// typed back for the same scope within 10 minutes. One try per number, so a stray click or a forged request can't
// wipe anything. Rows are DELETEd (not TRUNCATE ... CASCADE), so a table we don't know about can never go with them.
import crypto from 'crypto';

const TTL_MS = 10 * 60 * 1000;
const GUEST_TABLES = ['checkins', 'orders', 'login_links', 'invites', 'guests', 'broadcasts'];
const SETUP_TABLES = ['package_tiers', 'promo_codes', 'packages', 'settings'];
const SCOPES = ['guests', 'everything'];

// afterReset() runs after an 'everything' reset (server.js passes site.refresh, which clears the email footer's
// cached contact details).
export function registerReset({ app, pool, requireAdmin, rateLimit, afterReset }) {
  let pending = null; // { code, scope, expires }
  const fail = (res, err) => { console.error('Reset error:', err); res.status(500).json({ error: 'Server error. Nothing was deleted.' }); };

  // What a reset would delete, plus the money received from paid orders (per currency) as a warning.
  async function counts(db) {
    const r = await db.query(`SELECT
        (SELECT COUNT(*) FROM guests)::int AS guests,
        (SELECT COUNT(*) FROM invites)::int AS invites,
        (SELECT COUNT(*) FROM orders)::int AS orders,
        (SELECT COUNT(*) FROM orders WHERE status = 'PAID')::int AS paid,
        (SELECT COUNT(*) FROM checkins)::int AS checkins,
        (SELECT COUNT(*) FROM broadcasts)::int AS broadcasts,
        (SELECT COUNT(*) FROM packages)::int AS packages,
        (SELECT COUNT(*) FROM package_tiers)::int AS tiers,
        (SELECT COUNT(*) FROM promo_codes)::int AS codes,
        (SELECT COUNT(*) FROM settings)::int AS settings`);
    const money = await db.query(
      `SELECT COALESCE(o.currency, p.currency) AS currency, SUM(COALESCE(o.amount_cents, p.price_cents))::bigint AS cents
       FROM orders o JOIN packages p ON p.id = o.package_id WHERE o.status = 'PAID'
       GROUP BY 1 HAVING SUM(COALESCE(o.amount_cents, p.price_cents)) > 0 ORDER BY 1`);
    return { ...r.rows[0], received: money.rows.map((m) => ({ currency: m.currency, cents: Number(m.cents) })) };
  }

  app.get('/api/admin/reset', requireAdmin, async (req, res) => {
    try { res.json(await counts(pool)); } catch (err) { fail(res, err); }
  });

  // Step 1: a fresh confirmation number for a scope (replaces any earlier one).
  app.post('/api/admin/reset/start', requireAdmin, rateLimit(20, 15 * 60 * 1000), async (req, res) => {
    const scope = req.body?.scope;
    if (!SCOPES.includes(scope)) return res.status(400).json({ error: 'Choose what to reset.' });
    try {
      pending = { code: String(crypto.randomInt(100000, 1000000)), scope, expires: Date.now() + TTL_MS };
      res.json({ code: pending.code, scope, expires_at: new Date(pending.expires).toISOString(), ...(await counts(pool)) });
    } catch (err) { fail(res, err); }
  });

  // Step 2: the number typed back, for the same scope. Deletes in one transaction, so it's all or nothing.
  app.post('/api/admin/reset', requireAdmin, rateLimit(20, 15 * 60 * 1000), async (req, res) => {
    const typed = String(req.body?.code ?? '').replace(/\s/g, '');
    const scope = req.body?.scope;
    const ok = pending && Date.now() < pending.expires && scope === pending.scope &&
      typed.length === pending.code.length && crypto.timingSafeEqual(Buffer.from(typed), Buffer.from(pending.code));
    pending = null;
    if (!ok) return res.status(400).json({ error: "That number didn't match (or it expired), so nothing was deleted. Get a new number and try again." });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const before = await counts(client);
      // Check-ins and pickups go with their orders (checkins.order_id cascades), but delete them explicitly anyway.
      // Setup tables come after orders, which point at packages and tiers.
      for (const table of scope === 'everything' ? [...GUEST_TABLES, ...SETUP_TABLES] : GUEST_TABLES) {
        await client.query(`DELETE FROM ${table}`);
      }
      await client.query('COMMIT');
      console.log(`Reset (${scope}): deleted ${before.guests} guests, ${before.invites} invites, ${before.orders} orders (${before.paid} paid), ${before.checkins} door scans, ${before.broadcasts} group emails` +
        (scope === 'everything' ? `, ${before.packages} packages, ${before.tiers} tiers, ${before.codes} codes and ${before.settings} settings.` : '.'));
      if (scope === 'everything' && afterReset) await Promise.resolve(afterReset()).catch((err) => console.error('After reset:', err.message));
      res.json({ success: true, scope, deleted: before });
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      fail(res, err);
    } finally {
      client?.release();
    }
  });

  app.get('/admin/reset', requireAdmin, (req, res) => res.type('html').send(PAGE));
}

const PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0b0a09">
<title>Reset | On D' Road</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
:root { --bg: #0b0a09; --surface: #141210; --surface-2: #1b1815; --line: rgba(243, 236, 226, .09); --line-strong: rgba(243, 236, 226, .2); --text: #f3ece2; --muted: #9b9389; --dim: #6c665e; --accent: #ff5b1f; --accent-ink: #120703; --good: #4fc3a1; --warn: #f0b43c; --bad: #ff6a5c; --mono: 'JetBrains Mono', ui-monospace, monospace; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 'Inter', system-ui, -apple-system, sans-serif; -webkit-font-smoothing: antialiased; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.hidden { display: none !important; }
.top { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px clamp(16px, 3vw, 32px); background: rgba(11, 10, 9, .8); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 14px; }
.brand b { font-family: 'Anton', Impact, sans-serif; font-weight: 400; font-size: 20px; letter-spacing: .04em; }
.brand b span { color: var(--accent); }
.brand .sub { font-size: 12px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); padding-left: 14px; border-left: 1px solid var(--line-strong); }
.back { font-size: 13px; font-weight: 500; color: var(--muted); text-decoration: none; padding: 8px 12px; border-radius: 8px; white-space: nowrap; }
.back:hover { color: var(--text); background: rgba(243, 236, 226, .05); }
.wrap { max-width: 720px; margin: 0 auto; padding: clamp(24px, 4vw, 48px) clamp(16px, 3vw, 32px) 80px; }
h1 { font-family: 'Anton', Impact, sans-serif; font-weight: 400; font-size: clamp(36px, 6vw, 52px); line-height: .95; text-transform: uppercase; margin: 0; }
h2 { font-family: 'Anton', Impact, sans-serif; font-weight: 400; font-size: 26px; text-transform: uppercase; margin: 0 0 4px; }
.lead { color: var(--muted); margin: 10px 0 26px; }
.card { background: linear-gradient(180deg, var(--surface-2), var(--surface)); border: 1px solid var(--line); border-radius: 14px; padding: clamp(20px, 3vw, 28px); margin-bottom: 22px; }
.card > p { color: var(--muted); margin: 0; }
.card.danger { border-color: rgba(255, 106, 92, .35); }
ul.counts { list-style: none; margin: 16px 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
ul.counts li { background: var(--surface); padding: 14px 16px; }
ul.counts b { display: block; font-size: 26px; font-weight: 600; letter-spacing: -.02em; }
ul.counts span { color: var(--muted); font-size: 13px; }
.keep { margin: 14px 0 0; color: var(--muted); font-size: 14px; }
.keep b { color: var(--text); font-weight: 600; }
.scopes { margin-top: 14px; display: grid; gap: 10px; }
label.scope { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; align-items: start; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; cursor: pointer; opacity: .62; transition: border-color .15s, opacity .15s; margin: 0; font-size: 15px; letter-spacing: 0; text-transform: none; color: var(--text); }
label.scope.on { opacity: 1; border-color: var(--line-strong); }
label.scope input { width: 18px; height: 18px; margin: 2px 0 0; padding: 0; accent-color: var(--bad); cursor: pointer; }
label.scope b { font-weight: 600; }
label.scope span { grid-column: 2; color: var(--muted); font-size: 14px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
.warn { margin-top: 16px; padding: 12px 14px; border-radius: 10px; font-size: 14px; font-weight: 600; background: rgba(240, 180, 60, .07); border: 1px solid rgba(240, 180, 60, .3); color: var(--warn); }
.code { margin: 18px 0 0; padding: 18px; border-radius: 12px; text-align: center; background: rgba(255, 106, 92, .07); border: 1px solid rgba(255, 106, 92, .35); }
.code span { display: block; color: var(--muted); font-size: 13px; }
.code b { display: block; font-family: var(--mono); font-size: clamp(34px, 9vw, 46px); letter-spacing: .18em; color: var(--text); margin-top: 6px; }
label { display: block; font-size: 11px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); margin: 18px 0 8px; }
#typed { width: 100%; max-width: 260px; font: 500 22px var(--mono); letter-spacing: .14em; color: var(--text); background: rgba(0, 0, 0, .35); border: 1px solid var(--line-strong); border-radius: 10px; padding: 12px 14px; }
#typed:focus { outline: none; border-color: var(--bad); box-shadow: 0 0 0 3px rgba(255, 106, 92, .18); }
button { font: 600 14px 'Inter', system-ui, sans-serif; padding: 13px 22px; border-radius: 10px; cursor: pointer; color: var(--accent-ink); background: var(--accent); border: 1px solid var(--accent); }
button.ghost { color: var(--text); background: transparent; border-color: var(--line-strong); }
button.bad { color: #1a0402; background: var(--bad); border-color: var(--bad); }
button:hover { filter: brightness(1.08); }
button:disabled { opacity: .5; cursor: not-allowed; filter: none; }
.foot { display: flex; align-items: center; gap: 12px; margin-top: 20px; flex-wrap: wrap; }
.msg { font-size: 14px; font-weight: 600; }
.msg.ok { color: var(--good); } .msg.err { color: var(--bad); }
</style></head><body>
<header class="top">
  <div class="brand"><b>ON D<span>'</span> ROAD</b><span class="sub">Command Center</span></div>
  <a class="back" href="/admin">&larr; Back to overview</a>
</header>
<main class="wrap">
  <h1>Reset</h1>
  <p class="lead">Start over, for example after testing. This can't be undone.</p>

  <section class="card" aria-labelledby="w-h">
    <h2 id="w-h">What to reset</h2>
    <div class="scopes" role="radiogroup" aria-label="What to reset">
      <label class="scope on"><input type="radio" name="scope" value="guests" checked><b>Guest data only</b>
        <span>Deletes every guest and everything they did. Keeps your setup: packages, prices and tiers, promo codes, and every setting (payments, event details, contact, terms, FAQ, sponsors, size lock).</span></label>
      <label class="scope"><input type="radio" name="scope" value="everything"><b>Everything</b>
        <span>Also deletes your setup, so the site goes back to a blank start with the original terms and FAQ drafts. You'd set up packages, prices and settings again.</span></label>
    </div>
    <ul class="counts" id="counts" aria-live="polite"><li><b>&hellip;</b><span>Loading</span></li></ul>
    <div id="money" class="warn hidden" role="status"></div>
    <p class="keep">Guests who are logged in are logged out. Door phones drop the old list at their next sync.</p>
    <p class="keep"><b>This includes your own guest account.</b> Login links only go to people on the list, so afterwards add yourself back with Add to roster in the Command Center (or send yourself an invite) before you log in to the guest site.</p>
    <div class="foot"><button class="ghost" id="backup" type="button">Download a copy first</button><span id="b-msg" class="msg" role="status"></span></div>
  </section>

  <section class="card danger" aria-labelledby="r-h">
    <h2 id="r-h">Confirm</h2>
    <p>Get a confirmation number, then type it in to delete what's listed above.</p>
    <div class="foot"><button class="ghost" id="start" type="button">Get confirmation number</button></div>
    <div id="step2" class="hidden">
      <div class="code"><span>Type this number to confirm</span><b id="code"></b><span id="expires"></span></div>
      <label for="typed">Confirmation number</label>
      <input id="typed" inputmode="numeric" autocomplete="off" maxlength="7" placeholder="000000">
      <div class="foot"><button class="bad" id="go" type="button" disabled>Delete all guest data</button></div>
    </div>
    <p id="msg" class="msg" role="status" style="margin-top:14px"></p>
  </section>
</main>
<script>
var $ = function (id) { return document.getElementById(id); };
var code = '', last = null;
function el(tag, text) { var e = document.createElement(tag); if (text !== undefined) e.textContent = text; return e; }
function say(id, text, ok) { $(id).textContent = text; $(id).className = 'msg ' + (ok ? 'ok' : 'err'); }
function call(path, body) {
  return fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)
    .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'Request failed.'); return d; }); });
}
function scope() { return document.querySelector('input[name=scope]:checked').value; }
function money(c) { return c.currency + ' ' + (c.cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function plural(n, one, many) { return n === 1 ? one : many; }
function show(d) {
  last = d;
  var all = scope() === 'everything';
  var rows = [[d.guests, 'guest', 'guests'], [d.invites, 'invite', 'invites'], [d.orders, 'order', 'orders'], [d.paid, 'paid order', 'paid orders'], [d.checkins, 'door scan', 'door scans'], [d.broadcasts, 'group email', 'group emails']];
  if (all) rows = rows.concat([[d.packages, 'package', 'packages'], [d.tiers, 'price tier', 'price tiers'], [d.codes, 'promo code', 'promo codes'], [d.settings, 'saved setting', 'saved settings']]);
  var ul = $('counts'); ul.replaceChildren();
  rows.forEach(function (x) { var li = el('li'); li.appendChild(el('b', String(x[0]))); li.appendChild(el('span', plural(x[0], x[1], x[2]))); ul.appendChild(li); });
  var m = $('money');
  m.classList.toggle('hidden', !d.paid);
  m.textContent = d.paid ? d.paid + ' ' + plural(d.paid, 'order is', 'orders are') + ' paid' + (d.received.length ? ' (' + d.received.map(money).join(' + ') + ' received)' : '') +
    '. Their records go too, including what you need for refunds. Download a copy first.' : '';
  $('go').textContent = all ? 'Delete everything' : 'Delete all guest data';
}
function load() { return call('/api/admin/reset').then(show).catch(function (e) { say('msg', e.message); }); }
function forgetNumber() { code = ''; $('typed').value = ''; $('go').disabled = true; $('step2').classList.add('hidden'); $('start').textContent = 'Get confirmation number'; }

Array.prototype.forEach.call(document.querySelectorAll('input[name=scope]'), function (r) {
  r.addEventListener('change', function () {
    Array.prototype.forEach.call(document.querySelectorAll('label.scope'), function (l) { l.classList.toggle('on', l.querySelector('input').checked); });
    if (code) { forgetNumber(); say('msg', 'You changed what to reset, so get a new number.'); }
    if (last) show(last);
  });
});

// One JSON file with everything the chosen reset deletes, from the admin lists the other pages already use.
$('backup').addEventListener('click', function () {
  var b = this; b.disabled = true; $('b-msg').textContent = '';
  var parts = [['guests', '/api/admin/guests'], ['invites', '/api/admin/invites'], ['orders', '/api/admin/orders'], ['checkins', '/api/admin/checkins'], ['broadcasts', '/api/admin/broadcasts']];
  if (scope() === 'everything') parts = parts.concat([['packages', '/api/admin/packages'], ['pricing', '/api/admin/pricing'], ['payment_settings', '/api/admin/payment-settings'],
    ['event', '/api/admin/event'], ['site', '/api/admin/site'], ['pickup', '/api/admin/pickup']]);
  Promise.all(parts.map(function (x) { return call(x[1]); }))
    .then(function (r) {
      var data = { exported_at: new Date().toISOString() };
      parts.forEach(function (x, i) { data[x[0]] = r[i]; });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      a.download = 'ondroad-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      say('b-msg', 'Copy downloaded.', true);
    })
    .catch(function (e) { say('b-msg', 'Could not download: ' + e.message); })
    .then(function () { b.disabled = false; });
});

$('start').addEventListener('click', function () {
  var b = this; b.disabled = true; $('msg').textContent = '';
  call('/api/admin/reset/start', { scope: scope() }).then(function (d) {
    code = d.code; show(d);
    $('code').textContent = d.code;
    $('expires').textContent = 'Works once, until ' + new Date(d.expires_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Antigua' }) + ' Antigua time.';
    $('typed').value = ''; $('go').disabled = true;
    $('step2').classList.remove('hidden');
    $('start').textContent = 'Get a new number';
    $('typed').focus();
  }).catch(function (e) { say('msg', e.message); }).then(function () { b.disabled = false; });
});

$('typed').addEventListener('input', function () { $('go').disabled = !code || this.value.replace(/\\s/g, '') !== code; });
$('typed').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !$('go').disabled) $('go').click(); });

$('go').addEventListener('click', function () {
  var b = this; b.disabled = true;
  call('/api/admin/reset', { scope: scope(), code: $('typed').value }).then(function (d) {
    var x = d.deleted;
    say('msg', 'Done. Deleted ' + x.guests + ' ' + plural(x.guests, 'guest', 'guests') + ', ' + x.invites + ' ' + plural(x.invites, 'invite', 'invites') + ' and ' + x.orders + ' ' + plural(x.orders, 'order', 'orders') +
      (d.scope === 'everything' ? ', plus ' + x.packages + ' ' + plural(x.packages, 'package', 'packages') + ' and all settings.' : '.') +
      ' Add yourself back with Add to roster before you log in.', true);
  }).catch(function (e) { say('msg', e.message); }).then(function () { forgetNumber(); load(); });
});
load();
</script></body></html>`;
