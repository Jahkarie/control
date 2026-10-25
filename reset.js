// reset.js: wipes data so the event can start over (for example after testing). Two scopes:
// - 'guests': guests (with their per-event invite bonuses), invites, login links, orders (with their check-ins and
//   pickups) and the group email log, for every event, plus the ticket site's orders, their items, payments, tickets
//   and door scans. Keeps the setup: events (past ones stay, with nothing in them), packages, price tiers, promo codes,
//   promoters, the ticket events, their tickets and tables, the bottle and chaser menus, and every setting.
// - 'everything': all of that plus every event, package, price tier, promo code, promoter, ticket event (with its
//   products and price tiers), menu and setting (payments, contact, terms, FAQ, sponsors, size lock, both site locks),
//   so both sites are back to their built-in defaults with one fresh current event, "On D' Road": that includes locked,
//   since a missing site_lock / tickets_lock means locked (see lock.js). Only preview_version and
//   tickets_preview_version stay, so a preview link that was reset before never works again.
// The page asks the server for a one-time 6-digit number for a scope, and the reset only runs when that number is
// typed back for the same scope within 10 minutes. One try per number, so a stray click or a forged request can't
// wipe anything. Rows are DELETEd (not TRUNCATE ... CASCADE), so a table we don't know about can never go with them.
import { WM_LITE } from './brand.js';
import crypto from 'crypto';
import { createDefaultEvent } from './events.js';

const TTL_MS = 10 * 60 * 1000;
// The admin app's alerts and the door's refused scans (adminapp.js) go with the guest data. Admin accounts, their
// sessions and passkeys, push subscriptions and the audit log are never reset: the reset itself is in the audit log.
const GUEST_TABLES = ['admin_alerts', 'door_refusals', 'ticket_checkins', 'tickets', 'ticket_payments', 'ticket_order_items', 'ticket_orders',
  'checkins', 'orders', 'login_links', 'invites', 'guest_event', 'guests', 'broadcasts'];
// In this order: each table only points at tables after it.
const SETUP_TABLES = ['ticket_tiers', 'ticket_products', 'ticket_events', 'chasers', 'chaser_groups', 'bottles',
  'package_tiers', 'promo_codes', 'packages', 'promoter_event', 'promoters', 'events', 'settings'];
const KEEP_SETTINGS = ['preview_version', 'tickets_preview_version'];
const SCOPES = ['guests', 'everything'];

// afterReset() runs after an 'everything' reset (server.js clears the site lock's cache and calls site.refresh, which
// clears the email footer's cached contact details).
export function registerReset({ app, pool, requireRole, rateLimit, afterReset }) {
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
        (SELECT COUNT(*) FROM events)::int AS events,
        (SELECT COUNT(*) FROM promoters)::int AS promoters,
        (SELECT COUNT(*) FROM settings)::int AS settings,
        (SELECT COUNT(*) FROM ticket_orders)::int AS ticket_orders,
        (SELECT COUNT(*) FROM ticket_orders WHERE status IN ('PAID', 'DEPOSIT_PAID'))::int AS ticket_paid,
        (SELECT COUNT(*) FROM tickets)::int AS tickets,
        (SELECT COUNT(*) FROM ticket_checkins)::int AS ticket_checkins,
        (SELECT COUNT(*) FROM ticket_events)::int AS ticket_events,
        (SELECT COUNT(*) FROM ticket_products)::int AS ticket_products,
        ((SELECT COUNT(*) FROM bottles) + (SELECT COUNT(*) FROM chasers))::int AS menu_items`);
    // Money received: paid invite-only orders, and the ticket site's paid orders and paid deposits.
    const money = await db.query(
      `SELECT currency, SUM(cents)::bigint AS cents FROM (
         SELECT COALESCE(o.currency, p.currency) AS currency, COALESCE(o.amount_cents, p.price_cents) AS cents
         FROM orders o JOIN packages p ON p.id = o.package_id WHERE o.status = 'PAID'
         UNION ALL SELECT currency, paid_cents FROM ticket_orders WHERE status IN ('PAID', 'DEPOSIT_PAID')) x
       GROUP BY 1 HAVING SUM(cents) > 0 ORDER BY 1`);
    return { ...r.rows[0], received: money.rows.map((m) => ({ currency: m.currency, cents: Number(m.cents) })) };
  }

  app.get('/api/admin/reset', requireRole('OWNER'), async (req, res) => {
    try { res.json(await counts(pool)); } catch (err) { fail(res, err); }
  });

  // Step 1: a fresh confirmation number for a scope (replaces any earlier one).
  app.post('/api/admin/reset/start', requireRole('OWNER'), rateLimit(20, 15 * 60 * 1000), async (req, res) => {
    const scope = req.body?.scope;
    if (!SCOPES.includes(scope)) return res.status(400).json({ error: 'Choose what to reset.' });
    try {
      pending = { code: String(crypto.randomInt(100000, 1000000)), scope, expires: Date.now() + TTL_MS };
      res.json({ code: pending.code, scope, expires_at: new Date(pending.expires).toISOString(), ...(await counts(pool)) });
    } catch (err) { fail(res, err); }
  });

  // Step 2: the number typed back, for the same scope. Deletes in one transaction, so it's all or nothing.
  app.post('/api/admin/reset', requireRole('OWNER'), rateLimit(20, 15 * 60 * 1000), async (req, res) => {
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
        await client.query(table === 'settings' ? 'DELETE FROM settings WHERE NOT (key = ANY($1))' : `DELETE FROM ${table}`, table === 'settings' ? [KEEP_SETTINGS] : []);
      }
      // Past events keep their names and dates, but the attendance count was about guests who are gone now.
      if (scope === 'guests') await client.query('UPDATE events SET rsvp_confirmed = NULL');
      // Everything: one fresh current event, with the built-in defaults.
      if (scope === 'everything') await createDefaultEvent(client);
      await client.query('COMMIT');
      console.log(`Reset (${scope}): deleted ${before.guests} guests, ${before.invites} invites, ${before.orders} orders (${before.paid} paid), ${before.checkins} door scans, ${before.broadcasts} group emails, ${before.ticket_orders} ticket orders (${before.tickets} tickets)` +
        (scope === 'everything' ? `, ${before.events} events, ${before.packages} packages, ${before.tiers} tiers, ${before.codes} codes, ${before.promoters} promoters, ${before.ticket_events} ticket events, ${before.ticket_products} ticket products, ${before.menu_items} menu items and ${before.settings} settings.` : '.'));
      if (scope === 'everything' && afterReset) await Promise.resolve(afterReset()).catch((err) => console.error('After reset:', err.message));
      res.json({ success: true, scope, deleted: before });
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      fail(res, err);
    } finally {
      client?.release();
    }
  });

  app.get('/admin/reset', requireRole('OWNER'), (req, res) => res.type('html').send(PAGE));
}

const PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0a0a0b">
<title>Reset | On D' Road</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
/* Night Kinetic, admin edition: matte charcoal, one sharp accent (safety orange), hairline rules and square corners.
   Concrete is kept for utility surfaces (previews, dialogs, toasts). Calm and dense for daily work. */
:root { --bg: #0a0a0b; --surface: #141416; --surface-2: #1a1a1d; --raise: #232327; --well: #0a0a0b; --line: rgba(236, 235, 230, .1); --line-strong: rgba(236, 235, 230, .24); --text: #ecebe6; --muted: #a6a59f; --dim: #8a8983; --accent: #ff5a1f; --accent-hi: #ff7440; --accent-ink: #141416; --good: #b6ff3b; --warn: #ffc02e; --bad: #ff7a6b; --cyan: #22e1ff; --concrete: #c9c8c3; --concrete-2: #e4e3df; --ink: #141416; --ink-2: #47463f; --display: 'Archivo', 'Helvetica Neue', Arial, sans-serif; --body: 'Archivo', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; --mono: 'Space Mono', ui-monospace, SFMono-Regular, Menlo, monospace; --chev: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none' stroke='%23ecebe6' stroke-width='1.6'%3E%3Cpath d='M1 1.5l5 5 5-5'/%3E%3C/svg%3E"); --xh: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28' fill='none' stroke='%23141416' stroke-opacity='0.55' stroke-width='1'%3E%3Ccircle cx='14' cy='14' r='6.5'/%3E%3Cpath d='M14 0v28M0 14h28'/%3E%3C/svg%3E"); --wm: ${WM_LITE}; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 var(--body); -webkit-font-smoothing: antialiased; }
::selection { background: var(--accent); color: var(--accent-ink); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.top { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; gap: 10px 16px; flex-wrap: wrap; min-height: 60px; padding: 10px clamp(16px, 3vw, 32px); background: var(--wm) 0 0 / 260px 150px, rgba(10, 10, 11, .9); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-bottom: 1px solid var(--line); }
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
h2 { font-family: var(--display); font-stretch: 118%; font-weight: 800; font-size: 19px; line-height: 1.1; letter-spacing: .01em; text-transform: uppercase; margin: 0 0 8px; }
/* The title block closes with a hairline and a short orange tab on it */
.lead { position: relative; color: var(--muted); margin: 14px 0 28px; padding-bottom: 22px; border-bottom: 1px solid var(--line); }
.lead::after { content: ''; position: absolute; left: 0; bottom: -1px; width: 56px; height: 2px; background: var(--accent); }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 0; padding: clamp(20px, 3vw, 28px); }
/* Buttons: square blocks. Safety orange with ink text for the main action; outlines for the rest. */
button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 42px; font-family: var(--display); font-weight: 700; font-stretch: 112%; font-size: 13px; line-height: 1; letter-spacing: .05em; text-transform: uppercase; padding: 0 18px; border-radius: 0; cursor: pointer; color: var(--accent-ink); background: var(--accent); border: 1px solid var(--accent); transition: background .15s, border-color .15s, color .15s; }
button:hover { background: var(--accent-hi); border-color: var(--accent-hi); }
button:active { transform: translateY(1px); }
button:disabled { opacity: .5; cursor: progress; transform: none; }
button.ghost { color: var(--text); background: transparent; border-color: var(--line-strong); }
button.ghost:hover { border-color: var(--text); background: rgba(236, 235, 230, .05); }
.msg { font-size: 14px; font-weight: 600; }
.msg.ok { color: var(--good); } .msg.err { color: var(--bad); }
@media (max-width: 560px) { .brand .sub { display: none; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } button:active { transform: none; } }
.hidden { display: none !important; }
.wrap { max-width: 720px; margin: 0 auto; padding: clamp(24px, 4vw, 48px) clamp(16px, 3vw, 32px) 80px; }
.card { margin-bottom: 22px; }
.card > p { color: var(--muted); margin: 0; }
.card.danger { border-color: rgba(255, 122, 107, .42); border-top: 2px solid var(--bad); }
ul.counts { list-style: none; margin: 16px 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); overflow: hidden; }
ul.counts li { background: var(--surface); padding: 14px 16px; }
ul.counts b { display: block; font-family: var(--display); font-size: 32px; font-weight: 800; font-stretch: 125%; line-height: 1.05; letter-spacing: -.01em; font-variant-numeric: tabular-nums; }
ul.counts span { color: var(--muted); font-size: 13px; }
.card > p.keep { margin: 14px 0 0; color: var(--muted); font-size: 14px; }
.card > p.keep + p.keep { margin-top: 8px; }
.keep b { color: var(--text); font-weight: 700; }
.scopes { margin-top: 14px; display: grid; gap: 8px; }
label.scope { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; align-items: start; padding: 12px 14px; border: 1px solid var(--line); border-left: 2px solid var(--line); cursor: pointer; opacity: .62; transition: border-color .15s, opacity .15s, background .15s; margin: 0; font-family: var(--body); font-size: 15px; font-weight: 400; letter-spacing: 0; text-transform: none; color: var(--text); }
label.scope.on { opacity: 1; border-color: rgba(255, 122, 107, .42); border-left-color: var(--bad); background: rgba(255, 122, 107, .05); }
label.scope input { width: 18px; height: 18px; margin: 2px 0 0; padding: 0; accent-color: var(--bad); cursor: pointer; }
label.scope b { font-weight: 700; }
label.scope span { grid-column: 2; color: var(--muted); font-size: 14px; }
.warn { margin-top: 16px; padding: 11px 14px; font-size: 14px; font-weight: 600; background: rgba(255, 192, 46, .06); border: 1px solid rgba(255, 192, 46, .32); border-left: 3px solid var(--warn); color: var(--warn); }
/* The confirmation number: a concrete label under an orange and ink hazard strip */
.code { margin: 18px 0 0; padding: 24px 18px 18px; text-align: center; color: var(--ink); background: repeating-linear-gradient(-45deg, var(--accent) 0 9px, var(--ink) 9px 18px) top / 100% 6px no-repeat, var(--xh) no-repeat right 8px bottom 8px / 18px, var(--concrete); }
.code span { display: block; color: var(--ink-2); font-size: 13px; }
.code b { display: block; font-family: var(--mono); font-weight: 700; font-size: clamp(34px, 9vw, 46px); letter-spacing: .18em; color: var(--ink); margin-top: 6px; }
label { display: block; font-family: var(--mono); font-size: 11px; font-weight: 400; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 18px 0 8px; }
#typed { width: 100%; max-width: 260px; font: 700 22px var(--mono); letter-spacing: .14em; color: var(--text); background: var(--well); border: 1px solid var(--line-strong); border-radius: 0; padding: 11px 14px; }
#typed:focus { outline: none; border-color: var(--bad); box-shadow: inset 0 0 0 1px var(--bad); }
#typed::placeholder { color: var(--dim); }
button.bad { color: var(--accent-ink); background: var(--bad); border-color: var(--bad); }
button.bad:hover { background: #ff9286; border-color: #ff9286; }
button:disabled { opacity: .5; cursor: not-allowed; transform: none; }
.foot { display: flex; align-items: center; gap: 12px; margin-top: 20px; flex-wrap: wrap; }
</style></head><body>
<header class="top">
  <div class="brand"><svg class="mark" viewBox="0 0 30 18" aria-hidden="true" focusable="false"><path fill="#e4e3df" d="M0 6h30v12H0z"/><path fill="#0a0a0b" d="M18.2 0h5.6l-4.6 18h-5.6z"/><path fill="#ff5a1f" d="M19.6 0h2.8l-4.6 18h-2.8z"/></svg><b>ON D<span>'</span> <i>ROAD</i></b><span class="sub">Command Center</span></div>
  <a class="back" href="/admin">&larr; Back to overview</a>
</header>
<main class="wrap">
  <h1>Reset</h1>
  <p class="lead">Start over, for example after testing. This can't be undone.</p>

  <section class="card" aria-labelledby="w-h">
    <h2 id="w-h">What to reset</h2>
    <div class="scopes" role="radiogroup" aria-label="What to reset">
      <label class="scope on"><input type="radio" name="scope" value="guests" checked><b>Guest data only</b>
        <span>Deletes every guest and everything they did, in every event: orders, invites, door scans and group emails. Also every ticket site order, with its tickets, payments and door scans. Keeps your setup: events (past ones stay, empty), packages, prices and tiers, promo codes, promoters, ticket events with their tickets and tables, the bottle and chaser menus, and every setting (payments, event details, contact, terms, FAQ, sponsors, size lock, both site locks).</span></label>
      <label class="scope"><input type="radio" name="scope" value="everything"><b>Everything</b>
        <span>Also deletes your setup: every event (current and past), package, code and promoter, every ticket event with its tickets and tables, and the bottle and chaser menus, so both sites go back to a blank start with one new event, "On D' Road", the original terms and FAQ drafts, and locked again: only the trailer shows, on the main site and the ticket site. Your preview links stay the same. You'd set up packages, prices and settings again.</span></label>
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
  var rows = [[d.guests, 'guest', 'guests'], [d.invites, 'invite', 'invites'], [d.orders, 'order', 'orders'], [d.paid, 'paid order', 'paid orders'], [d.checkins, 'door scan', 'door scans'], [d.broadcasts, 'group email', 'group emails'],
    [d.ticket_orders, 'ticket order', 'ticket orders'], [d.ticket_paid, 'paid ticket order', 'paid ticket orders'], [d.tickets, 'ticket', 'tickets'], [d.ticket_checkins, 'ticket scan', 'ticket scans']];
  if (all) rows = rows.concat([[d.events, 'event', 'events'], [d.packages, 'package', 'packages'], [d.tiers, 'price tier', 'price tiers'], [d.codes, 'promo code', 'promo codes'], [d.promoters, 'promoter', 'promoters'],
    [d.ticket_events, 'ticket event', 'ticket events'], [d.ticket_products, 'ticket or table type', 'ticket and table types'], [d.menu_items, 'menu item', 'menu items'], [d.settings, 'saved setting', 'saved settings']]);
  var ul = $('counts'); ul.replaceChildren();
  rows.forEach(function (x) { var li = el('li'); li.appendChild(el('b', String(x[0]))); li.appendChild(el('span', plural(x[0], x[1], x[2]))); ul.appendChild(li); });
  var m = $('money');
  var paidAll = d.paid + (d.ticket_paid || 0);
  m.classList.toggle('hidden', !paidAll);
  m.textContent = paidAll ? paidAll + ' ' + plural(paidAll, 'order is', 'orders are') + ' paid' + (d.ticket_paid ? ' (' + d.ticket_paid + ' on the ticket site)' : '') + (d.received.length ? ' (' + d.received.map(money).join(' + ') + ' received)' : '') +
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
  // Every event's orders, invites, door scans and group emails, not only the current event's.
  var parts = [['guests', '/api/admin/guests'], ['invites', '/api/admin/invites?event=all'], ['orders', '/api/admin/orders?event=all'], ['checkins', '/api/admin/checkins?event=all'], ['broadcasts', '/api/admin/broadcasts?event=all'], ['events', '/api/admin/events'],
    ['ticket_site', '/api/admin/tickets/export']];
  if (scope() === 'everything') parts = parts.concat([['packages', '/api/admin/packages?event=all'], ['pricing', '/api/admin/pricing'], ['promoters', '/api/admin/promoters'], ['payment_settings', '/api/admin/payment-settings'],
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
    say('msg', 'Done. Deleted ' + x.guests + ' ' + plural(x.guests, 'guest', 'guests') + ', ' + x.invites + ' ' + plural(x.invites, 'invite', 'invites') + ', ' + x.orders + ' ' + plural(x.orders, 'order', 'orders') + ' and ' + x.ticket_orders + ' ' + plural(x.ticket_orders, 'ticket order', 'ticket orders') +
      (d.scope === 'everything' ? ', plus ' + x.events + ' ' + plural(x.events, 'event', 'events') + ', ' + x.packages + ' ' + plural(x.packages, 'package', 'packages') + ' and all settings.' : '.') +
      ' Add yourself back with Add to roster before you log in.', true);
  }).catch(function (e) { say('msg', e.message); }).then(function () { forgetNumber(); load(); });
});
load();
</script></body></html>`;
