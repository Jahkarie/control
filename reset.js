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
<meta name="robots" content="noindex"><meta name="theme-color" content="#09080b">
<title>Reset | On D' Road</title>
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
.wrap { max-width: 720px; margin: 0 auto; padding: clamp(24px, 4vw, 48px) clamp(16px, 3vw, 32px) 80px; }
.card { margin-bottom: 22px; }
.card > p { color: var(--muted); margin: 0; }
.card.danger { border-color: rgba(255, 77, 77, .45); background: linear-gradient(180deg, rgba(255, 77, 77, .05), transparent 140px), var(--surface); }
ul.counts { list-style: none; margin: 16px 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
ul.counts li { background: var(--surface); padding: 14px 16px; }
ul.counts b { display: block; font-family: var(--display); font-size: 36px; font-weight: 900; font-stretch: 62%; line-height: 1.05; letter-spacing: .005em; font-variant-numeric: tabular-nums; }
ul.counts span { color: var(--muted); font-size: 13px; }
.card > p.keep { margin: 14px 0 0; color: var(--muted); font-size: 14px; }
.card > p.keep + p.keep { margin-top: 8px; }
.keep b { color: var(--text); font-weight: 700; }
.scopes { margin-top: 14px; display: grid; gap: 10px; }
label.scope { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; align-items: start; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; cursor: pointer; opacity: .62; transition: border-color .15s, opacity .15s, background .15s; margin: 0; font-family: var(--body); font-size: 15px; font-weight: 400; letter-spacing: 0; text-transform: none; color: var(--text); }
label.scope.on { opacity: 1; border-color: rgba(255, 77, 77, .55); background: rgba(255, 77, 77, .05); }
label.scope input { width: 18px; height: 18px; margin: 2px 0 0; padding: 0; accent-color: var(--bad); cursor: pointer; }
label.scope b { font-weight: 700; }
label.scope span { grid-column: 2; color: var(--muted); font-size: 14px; }
.warn { margin-top: 16px; padding: 12px 14px; border-radius: 8px; font-size: 14px; font-weight: 700; background: rgba(255, 229, 0, .06); border: 1px solid rgba(255, 229, 0, .35); border-left: 4px solid var(--warn); color: var(--warn); }
/* The confirmation number, on a yellow and ink hazard strip */
.code { margin: 18px 0 0; padding: 22px 18px 18px; border-radius: 10px; text-align: center; background: repeating-linear-gradient(-45deg, var(--warn) 0 9px, var(--accent-ink) 9px 18px) top / 100% 6px no-repeat, rgba(255, 77, 77, .07); border: 1px solid rgba(255, 77, 77, .45); }
.code span { display: block; color: var(--muted); font-size: 13px; }
.code b { display: block; font-family: var(--mono); font-weight: 700; font-size: clamp(34px, 9vw, 46px); letter-spacing: .18em; color: var(--text); margin-top: 6px; }
label { display: block; font-family: var(--mono); font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 18px 0 8px; }
#typed { width: 100%; max-width: 260px; font: 700 22px var(--mono); letter-spacing: .14em; color: var(--text); background: var(--well); border: 1px solid var(--line-strong); border-radius: 8px; padding: 12px 14px; }
#typed:focus { outline: none; border-color: var(--bad); box-shadow: 0 0 0 3px rgba(255, 77, 77, .2); }
#typed::placeholder { color: var(--dim); }
button.bad { color: var(--accent-ink); background: var(--bad); border-color: var(--bad); }
button:disabled { opacity: .5; cursor: not-allowed; box-shadow: none; transform: none; }
.foot { display: flex; align-items: center; gap: 12px; margin-top: 20px; flex-wrap: wrap; }
</style></head><body>
<header class="top">
  <div class="brand"><svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path fill="currentColor" d="M29.1 16.4C28.6 17 25.8 17.4 24.9 17.9C24 18.3 24 18.6 23.9 19.1C23.7 19.5 23.6 19.9 23.7 20.5C23.7 21.1 24.2 22 24.2 22.6C24.2 23.3 24.2 24.2 23.8 24.6C23.3 24.9 22.3 24.7 21.6 24.6C20.9 24.6 20.1 24.2 19.5 24.1C18.9 24 18.5 23.7 18.1 24.2C17.7 24.6 17.7 25.9 17.2 26.7C16.8 27.5 16.1 29.2 15.6 28.9C15.1 28.6 14.7 25.8 14.2 25C13.8 24.1 13.6 24.1 13.1 24C12.7 23.8 12.3 23.9 11.7 24C11.2 24.1 10.5 24.3 9.7 24.5C8.9 24.7 7.5 25.4 6.8 25.2C6 25.1 5.4 24.5 5.4 23.8C5.4 23.1 6.4 21.7 6.7 21C7 20.2 7.6 19.6 7.2 19.1C6.7 18.7 4.6 18.7 4 18.2C3.4 17.8 3 16.9 3.6 16.4C4.2 15.9 6.6 15.5 7.4 15.1C8.1 14.7 8 14.4 8 13.9C8.1 13.5 8 13 7.9 12.5C7.7 11.9 7.4 11.1 7.3 10.4C7.3 9.7 7.2 8.7 7.5 8.3C7.9 7.9 8.7 7.8 9.4 7.8C10 7.8 10.9 8.3 11.4 8.2C12 8.1 12.2 8 12.6 7.1C12.9 6.2 13 3.5 13.5 3C14 2.5 15 3.2 15.6 3.9C16.2 4.6 16.6 6.5 17 7.3C17.5 8 17.8 8 18.2 8.3C18.6 8.7 18.9 9 19.3 9.2C19.7 9.4 19.9 9.6 20.6 9.5C21.3 9.5 22.6 8.7 23.2 8.8C23.9 8.8 24.5 9.3 24.6 9.9C24.6 10.5 23.7 11.7 23.5 12.4C23.4 13 23.1 13.4 23.9 13.7C24.7 14 27.4 13.9 28.2 14.4C29.1 14.8 29.7 15.8 29.1 16.4ZM12.7 3.8a1.5 1.5 0 1 1 3.1 0a1.5 1.5 0 1 1 -3.1 0ZM23 9a1.4 1.4 0 1 1 2.9 0a1.4 1.4 0 1 1 -2.9 0ZM27.1 15.5a1.6 1.6 0 1 1 3.1 0a1.6 1.6 0 1 1 -3.1 0ZM14.5 28.9a1.5 1.5 0 1 1 3 0a1.5 1.5 0 1 1 -3 0ZM5.5 23.7a1.4 1.4 0 1 1 2.8 0a1.4 1.4 0 1 1 -2.8 0ZM1.4 17.3a1.5 1.5 0 1 1 3.1 0a1.5 1.5 0 1 1 -3.1 0ZM27.4 5.4a1.2 1.2 0 1 1 2.4 0a1.2 1.2 0 1 1 -2.4 0ZM2.6 27a1 1 0 1 1 2 0a1 1 0 1 1 -2 0ZM26.6 28.2a0.8 0.8 0 1 1 1.6 0a0.8 0.8 0 1 1 -1.6 0Z"/></svg><b>ON D<span>'</span> ROAD</b><span class="sub">Command Center</span></div>
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
