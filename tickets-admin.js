// tickets-admin.js: the /admin/tickets page ("Tickets & tables") and the printable bar list, as HTML strings
// (tickets.js serves them). Night Kinetic, admin edition, like the other admin pages. The page's script sits inside a
// template literal, so it uses no backslash escapes (String.fromCharCode instead).
import { WM_LITE, WM_INK } from './brand.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ROOT = `:root { --bg: #0a0a0b; --surface: #141416; --surface-2: #1a1a1d; --raise: #232327; --well: #0a0a0b; --line: rgba(236, 235, 230, .1); --line-strong: rgba(236, 235, 230, .24); --text: #ecebe6; --muted: #a6a59f; --dim: #8a8983; --accent: #ff5a1f; --accent-hi: #ff7440; --accent-ink: #141416; --good: #b6ff3b; --warn: #ffc02e; --bad: #ff7a6b; --cyan: #22e1ff; --concrete: #c9c8c3; --concrete-2: #e4e3df; --ink: #141416; --ink-2: #47463f; --display: 'Archivo', 'Helvetica Neue', Arial, sans-serif; --body: 'Archivo', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; --mono: 'Space Mono', ui-monospace, SFMono-Regular, Menlo, monospace; --chev: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none' stroke='%23ecebe6' stroke-width='1.6'%3E%3Cpath d='M1 1.5l5 5 5-5'/%3E%3C/svg%3E"); --xh: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28' fill='none' stroke='%23141416' stroke-opacity='0.55' stroke-width='1'%3E%3Ccircle cx='14' cy='14' r='6.5'/%3E%3Cpath d='M14 0v28M0 14h28'/%3E%3C/svg%3E"); --wm: ${WM_LITE}; --wm-ink: ${WM_INK}; color-scheme: dark; }`;
const BRAND = `<div class="brand"><svg class="mark" viewBox="0 0 30 18" aria-hidden="true" focusable="false"><path fill="#e4e3df" d="M0 6h30v12H0z"/><path fill="#0a0a0b" d="M18.2 0h5.6l-4.6 18h-5.6z"/><path fill="#ff5a1f" d="M19.6 0h2.8l-4.6 18h-2.8z"/></svg><b>ON D<span>'</span> <i>ROAD</i></b><span class="sub">Command Center</span></div>`;
const HEAD = (title) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0a0a0b">
<title>${title} | On D' Road</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">`;

export function ticketsAdminPage({ TICKETS_URL, SITE_URL }) {
  return `${HEAD('Tickets &amp; tables')}
<style>
/* Night Kinetic, admin edition: matte charcoal, one sharp accent (safety orange), hairline rules and square corners.
   Concrete for utility surfaces (dialogs, toasts, the bar list preview). The header band carries the watermark. */
${ROOT}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 var(--body); -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums; }
::selection { background: var(--accent); color: var(--accent-ink); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.hidden { display: none !important; }
a { color: inherit; }
.top { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; gap: 10px 16px; flex-wrap: wrap; min-height: 60px; padding: 10px clamp(16px, 3vw, 32px); background: var(--wm) 0 0 / 260px 150px, rgba(10, 10, 11, .94); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.brand .mark { flex: none; width: 30px; height: 18px; overflow: visible; }
.brand b { font-family: var(--display); font-stretch: 125%; font-weight: 900; font-size: 16px; line-height: 1; letter-spacing: .01em; white-space: nowrap; }
.brand b span { color: var(--accent); }
.brand b i { font-style: normal; font-weight: 200; }
.brand .sub { font-family: var(--mono); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); white-space: nowrap; }
.brand .sub::before { content: '[ '; color: var(--dim); } .brand .sub::after { content: ' ]'; color: var(--dim); }
.top-r { display: flex; gap: 8px; flex-wrap: wrap; }
.back { display: inline-flex; align-items: center; min-height: 38px; padding: 0 14px; font-size: 13px; font-weight: 600; color: var(--text); text-decoration: none; border: 1px solid var(--line-strong); white-space: nowrap; }
.back:hover { border-color: var(--text); background: rgba(236, 235, 230, .05); }
.wrap { max-width: 1180px; margin: 0 auto; padding: clamp(24px, 4vw, 44px) clamp(16px, 3vw, 32px) 80px; }
h1 { font-family: var(--display); font-stretch: 125%; font-weight: 800; font-size: clamp(30px, 5vw, 48px); line-height: .98; letter-spacing: -.01em; text-transform: uppercase; margin: 0; }
h2 { font-family: var(--display); font-stretch: 118%; font-weight: 800; font-size: 19px; line-height: 1.1; letter-spacing: .01em; text-transform: uppercase; margin: 0 0 8px; }
h3 { font-family: var(--display); font-stretch: 112%; font-weight: 800; font-size: 14px; letter-spacing: .04em; text-transform: uppercase; margin: 22px 0 10px; }
.lead { position: relative; color: var(--muted); margin: 14px 0 28px; padding-bottom: 22px; border-bottom: 1px solid var(--line); max-width: 60em; }
.lead::after { content: ''; position: absolute; left: 0; bottom: -1px; width: 56px; height: 2px; background: var(--accent); }
.card { background: var(--surface); border: 1px solid var(--line); padding: clamp(18px, 3vw, 26px); margin-bottom: 22px; min-width: 0; }
.card > p.hint, .hint { color: var(--muted); margin: 0; font-size: 14px; }
.tabs { display: flex; border-bottom: 1px solid var(--line); margin: 0 0 22px; overflow-x: auto; scrollbar-width: none; }
.tab { position: relative; display: inline-flex; align-items: center; min-height: 46px; padding: 0 16px; font: 700 12.5px/1 var(--display); font-stretch: 112%; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); background: transparent; border: 0; cursor: pointer; white-space: nowrap; }
.tab:hover { color: var(--text); }
.tab[aria-selected=true] { color: var(--text); }
.tab[aria-selected=true]::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--accent); }
@media (max-width: 600px) { .tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); } .tab { justify-content: center; background: var(--surface); padding: 0 6px; } .tab[aria-selected=true] { background: var(--raise); } }
label, .lbl { display: block; font-family: var(--mono); font-size: 11px; font-weight: 400; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 0 0 7px; }
input, select, textarea { width: 100%; min-height: 42px; font: 500 14px var(--body); color: var(--text); background: var(--well); border: 1px solid var(--line-strong); border-radius: 0; padding: 9px 12px; min-width: 0; }
input:hover, select:hover, textarea:hover { border-color: rgba(236, 235, 230, .42); }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
select { padding-right: 34px; cursor: pointer; -webkit-appearance: none; appearance: none; background: var(--well) var(--chev) no-repeat right 12px center / 12px 8px; }
select option { background: var(--surface-2); color: var(--text); }
textarea { min-height: 96px; resize: vertical; line-height: 1.5; }
textarea.tall { min-height: 360px; }
input[type=checkbox] { width: 18px; height: 18px; min-height: 0; padding: 0; accent-color: var(--accent); }
input:disabled { opacity: .5; }
::placeholder { color: var(--dim); }
.grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-top: 16px; }
.grid .w2 { grid-column: span 2; } .grid .w4 { grid-column: 1 / -1; }
@media (max-width: 800px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .grid .w2 { grid-column: 1 / -1; } }
.check { display: inline-flex; align-items: center; gap: 10px; font: 500 14px var(--body); letter-spacing: 0; text-transform: none; color: var(--text); cursor: pointer; margin: 0; }
button, .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 42px; font: 700 13px/1 var(--display); font-stretch: 112%; letter-spacing: .05em; text-transform: uppercase; padding: 0 18px; border-radius: 0; cursor: pointer; color: var(--accent-ink); background: var(--accent); border: 1px solid var(--accent); text-decoration: none; white-space: nowrap; }
button:hover, .btn:hover { background: var(--accent-hi); border-color: var(--accent-hi); }
button:disabled { opacity: .5; cursor: progress; }
button.ghost, .btn.ghost { color: var(--text); background: transparent; border-color: var(--line-strong); }
button.ghost:hover, .btn.ghost:hover { border-color: var(--text); background: rgba(236, 235, 230, .05); }
button.danger { background: transparent; color: var(--bad); border-color: rgba(255, 122, 107, .45); }
button.danger:hover { background: rgba(255, 122, 107, .1); border-color: var(--bad); }
button.sm, .btn.sm { min-height: 34px; padding: 0 12px; font-size: 11.5px; }
.foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
.msg { font-size: 14px; font-weight: 600; } .msg.ok { color: var(--good); } .msg.err { color: var(--bad); }
small { display: block; color: var(--dim); font-size: 12.5px; margin-top: 6px; }
code { font: 400 12.5px var(--mono); color: var(--text); background: rgba(236, 235, 230, .07); padding: 1px 6px; overflow-wrap: anywhere; }
.pill { display: inline-flex; align-items: center; gap: 7px; min-height: 22px; padding: 0 8px; font: 700 10.5px/1.3 var(--mono); letter-spacing: .08em; text-transform: uppercase; white-space: nowrap; border: 1px solid var(--line-strong); color: var(--muted); }
.pill::before { content: ''; width: 6px; height: 6px; background: currentColor; }
.pill.good { color: var(--good); border-color: rgba(182, 255, 59, .36); background: rgba(182, 255, 59, .07); }
.pill.warn { color: var(--warn); border-color: rgba(255, 192, 46, .36); background: rgba(255, 192, 46, .07); }
.pill.bad { color: var(--bad); border-color: rgba(255, 122, 107, .42); background: rgba(255, 122, 107, .08); }
.pill.cyan { color: var(--cyan); border-color: rgba(34, 225, 255, .36); }
/* Lock: the two-way switch, as on /admin/site */
.lock-card { border-top: 2px solid var(--line-strong); }
.lock-card.is-locked { border-top-color: var(--accent); } .lock-card.is-open { border-top-color: var(--good); }
.lock-switch { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; width: 100%; max-width: 440px; min-height: 68px; margin-top: 18px; padding: 4px; color: var(--dim); background: var(--well); border: 1px solid var(--line-strong); }
.lock-switch:hover { background: var(--well); border-color: var(--text); }
.ls-opt { display: flex; align-items: center; justify-content: center; gap: 10px; font: 800 19px/1 var(--display); font-stretch: 125%; letter-spacing: .02em; }
.ls-opt::before { content: ''; width: 9px; height: 9px; border: 1.5px solid currentColor; }
.lock-switch[aria-checked=true] .ls-locked { background: var(--accent); color: var(--accent-ink); }
.lock-switch[aria-checked=false] .ls-open { background: var(--good); color: var(--accent-ink); }
.lock-switch[aria-checked=true] .ls-locked::before, .lock-switch[aria-checked=false] .ls-open::before { background: currentColor; }
.lock-state { margin: 14px 0 0; font: 400 13px var(--mono); }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.row input { flex: 1 1 220px; width: auto; }
.urlbox { display: block; padding: 10px 12px; font: 400 12.5px/1.5 var(--mono); word-break: break-all; background: var(--well); border: 1px solid var(--line); }
/* Events list */
.evlist { display: grid; gap: 1px; background: var(--line); border: 1px solid var(--line); margin-top: 16px; }
.ev { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 16px; align-items: center; padding: 14px 16px; background: var(--surface); text-align: left; color: var(--text); border: 0; font: inherit; text-transform: none; letter-spacing: 0; min-height: 0; cursor: pointer; position: relative; }
.ev:hover { background: var(--surface-2); }
.ev[aria-current=true] { background: var(--raise); }
.ev[aria-current=true]::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--accent); }
.ev b { font: 800 16px/1.15 var(--display); font-stretch: 112%; text-transform: uppercase; }
.ev .sub { grid-column: 1; font: 400 12px var(--mono); color: var(--muted); }
.ev .pill { grid-row: 1 / span 2; grid-column: 2; }
/* KPIs */
.kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); margin: 18px 0; }
@media (max-width: 900px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.kpi { background: var(--surface); padding: 16px 16px 14px; min-width: 0; }
.kpi span { display: block; font: 400 10.5px/1.35 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.kpi b { display: block; margin-top: 10px; font: 800 30px/1 var(--display); font-stretch: 125%; overflow-wrap: anywhere; }
.kpi b.money { font: 700 16px/1.3 var(--mono); }
.kpi small { margin-top: 6px; }
/* Tables: blocks on phones, labels from the headers */
.scroll { overflow-x: auto; border: 1px solid var(--line); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font: 400 10.5px var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--dim); padding: 10px 12px; border-bottom: 1px solid var(--line); background: var(--surface); white-space: nowrap; }
td { padding: 11px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; } td.actions { text-align: right; white-space: nowrap; } td.actions button + button { margin-left: 6px; }
td .s { display: block; font-size: 12.5px; color: var(--muted); margin-top: 3px; }
td.mono, .mono { font: 400 12px var(--mono); color: var(--muted); }
.empty-row td { text-align: center; color: var(--muted); padding: 30px 12px; }
tr.detail td { background: var(--well); }
.detail-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
@media (max-width: 900px) { .detail-grid { grid-template-columns: 1fr; } }
.detail-grid ul { margin: 6px 0 0; padding-left: 18px; color: var(--muted); font-size: 13.5px; }
@media (max-width: 700px) {
  table.cards thead { display: none; }
  table.cards, table.cards tbody, table.cards tr, table.cards td { display: block; width: 100%; }
  table.cards tr { padding: 12px 14px; border-bottom: 1px solid var(--line); }
  table.cards td { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; border: 0; padding: 4px 0; text-align: right; }
  table.cards td::before { content: attr(data-label); font: 400 10.5px var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--dim); text-align: left; }
  table.cards td[data-label=""]::before { content: none; }
  table.cards td.actions { justify-content: flex-end; flex-wrap: wrap; gap: 6px; } td.actions button + button { margin-left: 0; }
  table.cards tr.empty-row td { display: block; text-align: center; }
}
.toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 14px 0; }
.toolbar input { flex: 1 1 220px; width: auto; } .toolbar select { width: auto; }
/* Products: one row per product, its tiers under it */
.tiers { margin-top: 8px; display: grid; gap: 4px; }
.tier { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 6px 10px; border: 1px solid var(--line); font-size: 13px; }
.tier b { font-weight: 700; } .tier .mono { white-space: nowrap; }
.tier.now { border-color: rgba(182, 255, 59, .4); }
.tier .sp { flex: 1; }
.slotrow { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.slotrow select { width: auto; }
/* The bar list on screen: a concrete sheet */
.bar-sheet { color: var(--ink); background: var(--xh) no-repeat right 10px top 10px / 18px, var(--wm-ink) 0 0 / 260px 150px, var(--concrete); padding: 20px; margin-top: 14px; --muted: var(--ink-2); --line: rgba(20, 20, 22, .18); }
.bar-sheet table th { background: transparent; color: var(--ink-2); border-bottom-color: rgba(20, 20, 22, .3); }
.bar-sheet td { border-bottom-color: rgba(20, 20, 22, .14); }
.bar-sheet .tot { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; margin-top: 18px; }
@media (max-width: 700px) { .bar-sheet .tot { grid-template-columns: 1fr; } }
.bar-sheet h3 { margin-top: 0; }
.bar-sheet .big { font: 800 22px/1 var(--display); font-stretch: 112%; }
/* Dialog: concrete with registration marks */
dialog { width: min(560px, calc(100vw - 24px)); max-height: calc(100vh - 32px); padding: 0; border: 0; border-radius: 0; color: var(--ink); background: var(--xh) no-repeat 8px 8px / 18px, var(--xh) no-repeat right 8px bottom 8px / 18px, var(--concrete); box-shadow: 0 30px 80px -20px rgba(0, 0, 0, .9);
  --text: var(--ink); --muted: var(--ink-2); --dim: #57564f; --line: rgba(20, 20, 22, .16); --line-strong: rgba(20, 20, 22, .42); --well: #f4f3ef; }
dialog::backdrop { background: rgba(5, 5, 6, .76); }
dialog form { padding: 30px 24px 22px; }
dialog h3 { margin: 0; font: 800 22px/1.05 var(--display); font-stretch: 122%; text-transform: uppercase; }
dialog p { margin: 10px 0 0; color: var(--ink-2); font-size: 14.5px; }
dialog :focus-visible { outline-color: var(--ink); }
dialog input:focus, dialog select:focus, dialog textarea:focus { border-color: var(--ink); box-shadow: inset 0 0 0 1px var(--ink); }
dialog select { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none' stroke='%23141416' stroke-width='1.6'%3E%3Cpath d='M1 1.5l5 5 5-5'/%3E%3C/svg%3E"); }
dialog select option { background: #f4f3ef; color: var(--ink); }
dialog input[type=checkbox] { accent-color: var(--ink); }
dialog button { border-color: var(--ink); } dialog button.ghost { color: var(--ink); border-color: rgba(20, 20, 22, .45); }
dialog button.danger-solid { background: #b3261e; border-color: #b3261e; color: #fff; }
.dlg-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }
.dlg-fields .w2 { grid-column: 1 / -1; }
.dlg-err { margin-top: 12px; color: #a3140c; font-weight: 700; font-size: 14px; }
.dlg-err:empty { display: none; }
.dlg-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; flex-wrap: wrap; }
.toast { position: fixed; left: 50%; bottom: 24px; z-index: 80; transform: translate(-50%, 16px); max-width: calc(100vw - 32px); padding: 13px 18px; border-left: 3px solid var(--accent); background: var(--concrete-2); color: var(--ink); font-weight: 600; opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s; }
.toast.show { opacity: 1; transform: translate(-50%, 0); }
.toast.bad { border-left-color: #b3261e; background: #ffd9d4; color: #3a0d09; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
</style></head><body>
<header class="top">
  ${BRAND}
  <div class="top-r"><a class="back" href="${esc(TICKETS_URL)}" target="_blank" rel="noopener">Ticket site &#8599;</a><a class="back" href="/door" target="_blank" rel="noopener">Door scanner</a><a class="back" href="/admin">&larr; Back to overview</a></div>
</header>
<main class="wrap">
  <h1>Tickets &amp; tables</h1>
  <p class="lead">The public ticket site at ${esc(TICKETS_URL.replace(/^https?:\/\//, ''))}: its own events, entry tickets and VIP tables with bottle service. Buyers don't join the invite roster.</p>

  <div class="tabs" role="tablist" aria-label="Sections">
    <button class="tab" role="tab" id="t-events" aria-selected="true" aria-controls="p-events" type="button">Events</button>
    <button class="tab" role="tab" id="t-menus" aria-selected="false" aria-controls="p-menus" type="button">Bottles &amp; chasers</button>
    <button class="tab" role="tab" id="t-lock" aria-selected="false" aria-controls="p-lock" type="button">Site lock</button>
    <button class="tab" role="tab" id="t-terms" aria-selected="false" aria-controls="p-terms" type="button">Ticket terms</button>
  </div>

  <section id="p-events" role="tabpanel" aria-labelledby="t-events">
    <section class="card">
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">Events</h2><div class="row"><button class="ghost sm" id="run-jobs" type="button">Run checks now</button><button class="sm" id="ev-new" type="button">+ New event</button></div></div>
      <p class="hint">Several can be on sale at once. Only On sale events show on the ticket site; Closed and Past ones stay reachable by their link, with sales closed. Drafts are hidden.</p>
      <div id="evlist" class="evlist"></div>
    </section>
    <div id="ev-detail" class="hidden">
      <section class="card">
        <div class="row" style="justify-content:space-between"><h2 id="d-name" style="margin:0"></h2><div class="row"><a class="btn ghost sm" id="d-open" target="_blank" rel="noopener">Open on the ticket site &#8599;</a><button class="ghost sm" id="d-share" type="button">Copy link</button></div></div>
        <p class="hint" id="d-when"></p>
        <div class="kpis" id="d-kpis"></div>
        <form id="ev-form" class="grid" autocomplete="off">
          <div class="w2"><label for="e-name">Name</label><input id="e-name" maxlength="80" required></div>
          <div><label for="e-slug">Link name</label><input id="e-slug" maxlength="48"><small>tickets.ondroad.xyz/?e=<span id="e-slug-ex"></span></small></div>
          <div><label for="e-status">Status</label><select id="e-status"><option value="DRAFT">Draft (hidden)</option><option value="ON_SALE">On sale</option><option value="CLOSED">Sales closed</option><option value="PAST">Past</option></select></div>
          <div><label for="e-start">Starts (Antigua time)</label><input id="e-start" type="datetime-local"></div>
          <div><label for="e-end">Ends (Antigua time)</label><input id="e-end" type="datetime-local"></div>
          <div><label for="e-sort">Sort order</label><input id="e-sort" type="number" step="1"></div>
          <div><label for="e-showloc">Show the location</label><select id="e-showloc"><option value="AFTER">Only after purchase</option><option value="PUBLIC">Publicly</option></select></div>
          <div class="w2"><label for="e-venue">Venue</label><input id="e-venue" maxlength="120" placeholder="e.g. Pigeon Point"></div>
          <div class="w2"><label for="e-address">Address or directions</label><input id="e-address" maxlength="300"></div>
          <div class="w4"><label for="e-info">About the event (public)</label><textarea id="e-info" maxlength="8000"></textarea></div>
          <div class="w4"><label for="e-buyer">For ticket holders (on the ticket page and in the email, once paid)</label><textarea id="e-buyer" maxlength="8000" placeholder="Parking, what to bring, dress code..."></textarea></div>
          <div class="w4"><label for="e-refund">Refund policy (leave empty to use the ticket terms)</label><textarea id="e-refund" maxlength="4000"></textarea></div>
          <div class="w2"><label for="e-poster">Poster</label><input id="e-poster" maxlength="500" placeholder="https://... or posters/fete.jpg"><small>An https:// image link, or a file in the ticket site's folder (tickets/posters/...). Empty: the site's own art.</small></div>
          <div><label for="e-feekind">Service fee</label><select id="e-feekind"><option value="NONE">None</option><option value="FLAT">Per ticket</option><option value="PERCENT">Percent of the order</option></select></div>
          <div><label for="e-fee">Fee (amount or %)</label><input id="e-fee" type="number" min="0" step="0.01"></div>
          <div class="w4 foot" style="margin-top:4px"><button type="submit">Save event</button><button class="danger sm" id="e-delete" type="button">Delete event</button><span id="e-msg" class="msg" role="status"></span></div>
        </form>
      </section>

      <section class="card">
        <div class="row" style="justify-content:space-between"><h2 style="margin:0">Tickets and tables</h2><div class="row"><button class="sm" id="p-new-ticket" type="button">+ Ticket type</button><button class="sm ghost" id="p-new-table" type="button">+ Table type</button></div></div>
        <p class="hint">Sold = paid, deposit = table held on a deposit, held = a checkout waiting for payment (30 minutes). Left counts all three. Every ticket and table of one event uses one currency.</p>
        <div class="scroll" style="margin-top:14px"><table class="cards"><thead><tr><th>Name</th><th class="num">Price now</th><th class="num">Sold</th><th class="num">Deposit</th><th class="num">Held</th><th class="num">Left</th><th>Visible</th><th></th></tr></thead><tbody id="prodlist"></tbody></table></div>
      </section>

      <section class="card">
        <h2>Orders</h2>
        <div class="toolbar"><input id="o-q" type="search" placeholder="Search name, email or reference" aria-label="Search orders"><select id="o-f" aria-label="Order status"><option value="">All orders</option><option value="PAID">Paid</option><option value="DEPOSIT_PAID">Deposit paid</option><option value="HELD">Checkout waiting</option><option value="CANCELLED">Cancelled</option><option value="REFUNDED">Refunded</option><option value="TRANSFERS">With transfers</option></select><a class="btn ghost sm" id="o-door" href="#">Door list CSV</a></div>
        <div class="scroll"><table class="cards"><thead><tr><th>Order</th><th>Items</th><th class="num">Total</th><th class="num">Paid</th><th>Status</th><th>Placed</th><th></th></tr></thead><tbody id="orderlist"></tbody></table></div>
      </section>

      <section class="card">
        <div class="row" style="justify-content:space-between"><h2 style="margin:0">Bar list</h2><div class="row"><a class="btn sm" id="bar-print" target="_blank" rel="noopener">Print</a><a class="btn ghost sm" id="bar-csv">CSV</a></div></div>
        <p class="hint">Every table that's paid (or held on a deposit), with its bottles and chasers, and the totals to order stock from.</p>
        <div id="bar" class="bar-sheet"></div>
      </section>

      <section class="card">
        <h2>Door log</h2>
        <div class="scroll"><table class="cards"><thead><tr><th>Ticket</th><th>Scan</th><th>Time</th><th>Phone</th><th>Order</th></tr></thead><tbody id="doorlog"></tbody></table></div>
      </section>
    </div>
  </section>

  <section id="p-menus" role="tabpanel" aria-labelledby="t-menus" class="hidden">
    <section class="card">
      <h2>Bottle tiers</h2>
      <p class="hint">A table's slots each have a tier. A bottle at or below the slot's tier is included; a higher one costs that bottle's upgrade price.</p>
      <div class="grid"><div><label for="tl1">Tier 1</label><input id="tl1" maxlength="30"></div><div><label for="tl2">Tier 2</label><input id="tl2" maxlength="30"></div><div><label for="tl3">Tier 3</label><input id="tl3" maxlength="30"></div><div style="align-self:end"><button id="tl-save" type="button" class="ghost">Save names</button></div></div>
    </section>
    <section class="card">
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">Bottles</h2><button class="sm" id="b-new" type="button">+ Bottle</button></div>
      <p class="hint">Upgrade price: charged when it's picked in a slot of a lower tier, in the event's currency.</p>
      <div class="scroll" style="margin-top:14px"><table class="cards"><thead><tr><th>Bottle</th><th>Tier</th><th class="num">Upgrade</th><th>On the menu</th><th class="num">Sort</th><th></th></tr></thead><tbody id="bottlelist"></tbody></table></div>
    </section>
    <section class="card">
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">Chasers</h2><button class="sm" id="g-new" type="button">+ Group</button></div>
      <p class="hint">Each chaser costs its group's points from the table's chaser budget.</p>
      <div id="chaserlist"></div>
    </section>
  </section>

  <section id="p-lock" role="tabpanel" aria-labelledby="t-lock" class="hidden">
    <section class="card lock-card" id="site-lock">
      <h2>Ticket site lock</h2>
      <p class="hint">Its own switch, separate from the invite-only site's. While locked, the ticket site shows only the trailer and nothing can be bought. Tickets already bought keep working: their pages, the live QR and paying a balance.</p>
      <button class="lock-switch" id="l-switch" type="button" role="switch" aria-checked="true" aria-label="Ticket site locked" aria-describedby="l-state" disabled><span class="ls-opt ls-locked">Locked</span><span class="ls-opt ls-open">Open</span></button>
      <p id="l-state" class="lock-state" role="status">Loading&hellip;</p>
      <label for="l-at" style="margin-top:22px">Unlock automatically at</label>
      <div class="row"><input id="l-at" type="datetime-local"><button id="l-set" type="button">Set time</button><button id="l-clear" class="ghost" type="button">Clear</button></div>
      <small id="l-help">Antigua time. The ticket site opens by itself then.</small>
      <div class="lbl" style="margin-top:22px">Preview link</div>
      <code id="l-url" class="urlbox">&hellip;</code>
      <div class="foot"><button id="l-copy" class="ghost" type="button">Copy preview link</button><button id="l-rotate" class="ghost" type="button">Reset preview link</button><span id="l-msg" class="msg" role="status"></span></div>
      <small>Opens the real ticket site while it's locked. It's yours: don't share it. Resetting it makes the old link stop working.</small>
    </section>
  </section>

  <section id="p-terms" role="tabpanel" aria-labelledby="t-terms" class="hidden">
    <section class="card">
      <h2>Ticket terms</h2>
      <p class="hint">Buyers tick "I agree to the terms" at checkout. Start a line with # for a heading and - for a bullet point. An event's own refund policy shows on its page; without one, these terms are linked.</p>
      <p id="tt-state" class="hint" style="margin-top:12px"></p>
      <label for="tt" style="margin-top:16px">Text</label>
      <textarea id="tt" class="tall" maxlength="20000"></textarea>
      <div class="foot"><button id="tt-save" type="button">Save terms</button><button id="tt-reset" class="ghost" type="button">Use the original draft</button><span id="tt-msg" class="msg" role="status"></span></div>
    </section>
  </section>
</main>

<dialog id="dlg" aria-labelledby="dlg-title">
  <form id="dlg-form" method="dialog" novalidate>
    <h3 id="dlg-title"></h3>
    <p id="dlg-text"></p>
    <div id="dlg-fields" class="dlg-fields"></div>
    <p id="dlg-err" class="dlg-err" role="alert"></p>
    <div class="dlg-actions"><button class="ghost" type="button" id="dlg-cancel">Cancel</button><button type="submit" id="dlg-ok">Save</button></div>
  </form>
</dialog>
<div id="toast" class="toast" role="status" aria-live="polite"></div>

<script>
var $ = function (id) { return document.getElementById(id); };
var NL = String.fromCharCode(10);
var TICKETS_URL = ${JSON.stringify(TICKETS_URL).replace(/</g, '\\u003c')};
var events = [], cur = null, detail = null, menus = null, openOrder = null;
function el(tag, text, cls) { var e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = text; if (cls) e.className = cls; return e; }
function api(path, body) {
  return fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)
    .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) { var e = new Error(d.error || 'Something went wrong.'); e.status = r.status; throw e; } return d; }); });
}
var toastTimer;
function toast(t, bad) { var x = $('toast'); x.textContent = t; x.className = 'toast show' + (bad ? ' bad' : ''); clearTimeout(toastTimer); toastTimer = setTimeout(function () { x.className = 'toast'; }, 4000); }
function say(id, t, ok) { $(id).textContent = t; $(id).className = 'msg ' + (ok ? 'ok' : 'err'); }
function money(c, cur) { return (cur === 'USD' ? 'US$' : 'EC$') + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function cents(v) { var n = parseFloat(v); return isNaN(n) ? null : Math.round(n * 100); }
function dollars(c) { return c === null || c === undefined ? '' : (Number(c) / 100).toFixed(2); }
// datetime-local inputs are Antigua time (UTC-4 all year); the server reads a time without a zone as Antigua time.
var AST = 4 * 36e5;
function toInput(iso) { return iso ? new Date(new Date(iso).getTime() - AST).toISOString().slice(0, 16) : ''; }
function when(iso) { return iso ? new Date(iso).toLocaleString('en-US', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Antigua' }) : ''; }
function pill(t, tone) { return el('span', t, 'pill ' + (tone || '')); }
function plural(n, a, b) { return n + ' ' + (n === 1 ? a : b); }
function labelCells(tbody) {
  var heads = Array.prototype.map.call(tbody.closest('table').querySelectorAll('thead th'), function (th) { return th.textContent.trim(); });
  Array.prototype.forEach.call(tbody.rows, function (tr) { Array.prototype.forEach.call(tr.cells, function (c, i) { c.setAttribute('data-label', tr.classList.contains('empty-row') || tr.classList.contains('detail') ? '' : heads[i] || ''); }); });
}
function emptyRow(tbody, cols, text) { var tr = el('tr', undefined, 'empty-row'), td = el('td', text); td.colSpan = cols; tr.appendChild(td); tbody.appendChild(tr); }
function td(tr, text, cls) { var c = el('td', text, cls); tr.appendChild(c); return c; }

// A form in a dialog. fields: [{ name, label, type (text|number|money|textarea|select|checkbox|datetime), value, options, w2, hint }].
// onSubmit(values) returns a promise; a rejection shows its message and keeps the dialog open.
function ask(o) {
  return new Promise(function (resolve) {
    var dlg = $('dlg'), box = $('dlg-fields'), inputs = {};
    $('dlg-title').textContent = o.title;
    $('dlg-text').textContent = o.text || ''; $('dlg-text').classList.toggle('hidden', !o.text);
    $('dlg-err').textContent = '';
    box.replaceChildren(); box.classList.toggle('hidden', !(o.fields && o.fields.length));
    (o.fields || []).forEach(function (f, i) {
      var wrap = el('div'), id = 'f' + i, input;
      if (f.w2 || f.type === 'textarea' || f.type === 'checkbox') wrap.className = 'w2';
      if (f.type === 'checkbox') {
        var l = el('label', undefined, 'check'); input = el('input'); input.type = 'checkbox'; input.checked = !!f.value; input.id = id;
        l.appendChild(input); l.appendChild(el('span', f.label)); wrap.appendChild(l);
      } else {
        var lab = el('label', f.label); lab.htmlFor = id; wrap.appendChild(lab);
        if (f.type === 'select') { input = el('select'); (f.options || []).forEach(function (op) { var x = el('option', op[1]); x.value = op[0]; input.appendChild(x); }); }
        else if (f.type === 'textarea') input = el('textarea');
        else { input = el('input'); input.type = f.type === 'money' || f.type === 'number' ? 'number' : f.type === 'datetime' ? 'datetime-local' : 'text'; if (f.type === 'money') { input.step = '0.01'; input.min = '0'; } if (f.type === 'number') input.step = f.step || '1'; }
        input.id = id;
        input.value = f.value === null || f.value === undefined ? '' : f.value;
        if (f.placeholder) input.placeholder = f.placeholder;
        wrap.appendChild(input);
        if (f.hint) wrap.appendChild(el('small', f.hint));
      }
      if (f.onInput) input.addEventListener('input', function () { f.onInput(inputs); });
      if (f.onInput) input.addEventListener('change', function () { f.onInput(inputs); });
      inputs[f.name] = input; box.appendChild(wrap);
    });
    var ok = $('dlg-ok'); ok.textContent = o.ok || 'Save'; ok.className = o.danger ? 'danger-solid' : '';
    var done = false;
    function finish(v) { if (done) return; done = true; $('dlg-form').onsubmit = null; $('dlg-cancel').onclick = null; dlg.onclose = null; if (dlg.open) dlg.close(); resolve(v); }
    $('dlg-form').onsubmit = function (e) {
      e.preventDefault();
      var vals = {};
      Object.keys(inputs).forEach(function (k) { var i = inputs[k]; vals[k] = i.type === 'checkbox' ? i.checked : i.value; });
      if (!o.onSubmit) return finish(vals);
      ok.disabled = true; $('dlg-err').textContent = '';
      Promise.resolve(o.onSubmit(vals)).then(function (r) { finish(r === undefined ? vals : r); }, function (err) { $('dlg-err').textContent = err.message; }).then(function () { ok.disabled = false; });
    };
    $('dlg-cancel').onclick = function () { finish(null); };
    dlg.onclose = function () { finish(null); };
    if (o.fields) o.fields.forEach(function (f) { if (f.onInput) f.onInput(inputs); });
    dlg.showModal();
    var first = box.querySelector('input:not([type=checkbox]), select, textarea');
    (first || ok).focus();
  });
}
function confirmIt(title, text, okText, danger) { return ask({ title: title, text: text, ok: okText, danger: danger }); }

// ---------- Tabs ----------
var TABS = ['events', 'menus', 'lock', 'terms'];
function showTab(t) {
  TABS.forEach(function (x) { $('t-' + x).setAttribute('aria-selected', x === t ? 'true' : 'false'); $('p-' + x).classList.toggle('hidden', x !== t); });
  if (t === 'menus') loadMenus(); if (t === 'lock') loadLock(); if (t === 'terms') loadTerms();
  history.replaceState(null, '', '#' + t);
}
TABS.forEach(function (x) { $('t-' + x).addEventListener('click', function () { showTab(x); }); });

// ---------- Events ----------
var STATUS = { DRAFT: ['Draft', ''], ON_SALE: ['On sale', 'good'], CLOSED: ['Sales closed', 'warn'], PAST: ['Past', ''] };
function loadEvents(keep) {
  return api('/api/admin/tickets/events').then(function (list) {
    events = list;
    var box = $('evlist'); box.replaceChildren();
    if (!list.length) box.appendChild(el('p', 'No ticket events yet. Make one with New event.', 'hint')).style.padding = '16px';
    list.forEach(function (e) {
      var b = el('button', undefined, 'ev'); b.type = 'button';
      if (cur === e.id) b.setAttribute('aria-current', 'true');
      b.appendChild(el('b', e.name));
      var st = STATUS[e.status] || [e.status, ''];
      b.appendChild(pill(st[0], st[1]));
      var s = e.stats || {};
      b.appendChild(el('span', (e.when || 'No date yet') + ' · ' + plural(s.tickets_sold || 0, 'ticket', 'tickets') + ' sold' + (s.received_cents ? ' · ' + money(s.received_cents, s.currency) + ' in' : ''), 'sub'));
      b.addEventListener('click', function () { openEvent(e.id); });
      box.appendChild(b);
    });
    if (keep && cur) return openEvent(cur, true);
  }).catch(function (e) { toast(e.message, true); });
}
function openEvent(id, quiet) {
  cur = id;
  Array.prototype.forEach.call(document.querySelectorAll('.ev'), function (b, i) { if (events[i]) b.setAttribute('aria-current', events[i].id === id ? 'true' : 'false'); });
  return api('/api/admin/tickets/events/' + id).then(function (d) {
    detail = d;
    $('ev-detail').classList.remove('hidden');
    renderEvent(); renderProducts(); renderOrders(); loadBar(); loadDoorLog();
    if (!quiet) $('ev-detail').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }).catch(function (e) { toast(e.message, true); });
}
function renderEvent() {
  var e = detail.event, s = detail.stats || {};
  $('d-name').textContent = e.name;
  $('d-when').textContent = (e.when || 'No date yet') + (e.venue ? ' · ' + e.venue : '');
  $('d-open').href = e.url;
  $('e-name').value = e.name; $('e-slug').value = e.slug; $('e-slug-ex').textContent = e.slug;
  $('e-status').value = e.status; $('e-start').value = toInput(e.starts_at); $('e-end').value = toInput(e.ends_at); $('e-sort').value = e.sort_order;
  $('e-showloc').value = e.show_location; $('e-venue').value = e.venue; $('e-address').value = e.address; $('e-info').value = e.info; $('e-buyer').value = e.buyer_info;
  $('e-refund').value = e.refund_policy; $('e-poster').value = e.poster; $('e-feekind').value = e.fee_kind;
  $('e-fee').value = e.fee_kind === 'FLAT' ? dollars(e.fee_cents) : e.fee_kind === 'PERCENT' ? e.fee_percent : '';
  $('e-msg').textContent = '';
  var k = $('d-kpis'); k.replaceChildren();
  var cur0 = s.currency || (detail.products[0] && detail.products[0].currency) || 'XCD';
  [['Tickets sold', s.tickets_sold || 0], ['Orders paid', s.orders_paid || 0, (s.orders_deposit || 0) + ' on a deposit'], ['Checkouts waiting', s.orders_held || 0, 'held for 30 minutes'],
    ['Received', money(s.received_cents || 0, cur0), (s.balance_cents ? money(s.balance_cents, cur0) + ' balance to come' : 'no balances due'), true], ['Checked in', s.checked_people || 0, (s.checked_cars || 0) + ' cars']].forEach(function (x) {
    var c = el('div', undefined, 'kpi'); c.appendChild(el('span', x[0])); c.appendChild(el('b', String(x[1]), x[3] ? 'money' : '')); if (x[2]) c.appendChild(el('small', x[2])); k.appendChild(c);
  });
}
$('ev-new').addEventListener('click', function () {
  ask({ title: 'New event', text: 'It starts as a draft, hidden from the ticket site, until you put it on sale.', ok: 'Create', fields: [
    { name: 'name', label: 'Name', w2: true, placeholder: 'e.g. Sunset Boat Ride' }, { name: 'starts_at', label: 'Starts (Antigua time)', type: 'datetime' }, { name: 'ends_at', label: 'Ends (Antigua time)', type: 'datetime' }],
    onSubmit: function (v) { return api('/api/admin/tickets/events', { name: v.name, starts_at: v.starts_at, ends_at: v.ends_at, status: 'DRAFT' }); } })
    .then(function (r) { if (!r) return; toast('Event created.'); cur = r.event.id; loadEvents(true); });
});
$('ev-form').addEventListener('submit', function (ev) {
  ev.preventDefault();
  var kind = $('e-feekind').value, fee = $('e-fee').value;
  var body = { name: $('e-name').value, slug: $('e-slug').value, status: $('e-status').value, starts_at: $('e-start').value, ends_at: $('e-end').value, sort_order: $('e-sort').value || 0,
    show_location: $('e-showloc').value, venue: $('e-venue').value, address: $('e-address').value, info: $('e-info').value, buyer_info: $('e-buyer').value,
    refund_policy: $('e-refund').value, poster: $('e-poster').value, fee_kind: kind, fee_cents: kind === 'FLAT' ? (cents(fee) || 0) : 0, fee_percent: kind === 'PERCENT' ? (parseFloat(fee) || 0) : 0 };
  $('e-msg').textContent = '';
  api('/api/admin/tickets/events/' + cur, body).then(function () { say('e-msg', 'Saved.', true); loadEvents(true); }).catch(function (e) { say('e-msg', e.message); });
});
$('e-delete').addEventListener('click', function () {
  confirmIt('Delete this event?', 'Only an event with no orders can be deleted. Its tickets and tables go too.', 'Delete', true).then(function (y) {
    if (!y) return;
    api('/api/admin/tickets/events/' + cur + '/delete', {}).then(function () { toast('Event deleted.'); cur = null; $('ev-detail').classList.add('hidden'); loadEvents(); }).catch(function (e) { toast(e.message, true); });
  });
});
$('d-share').addEventListener('click', function () { navigator.clipboard.writeText(detail.event.url).then(function () { toast('Link copied.'); }, function () { toast('Copy failed.', true); }); });
$('run-jobs').addEventListener('click', function () {
  api('/api/admin/tickets/run-jobs', {}).then(function (r) { toast('Checked: ' + r.released + ' holds released, ' + r.settled + ' PayPal payments found, ' + r.reminded + ' reminders, ' + r.cancelled + ' late balances cancelled.'); loadEvents(true); }).catch(function (e) { toast(e.message, true); });
});

// ---------- Products ----------
function productFields(p, kind) {
  p = p || {};
  var labels = (detail && detail.tier_labels) || ['Standard', 'Premium', 'Top shelf'];
  var f = [
    { name: 'name', label: 'Name', value: p.name, w2: true, placeholder: kind === 'TABLE' ? 'e.g. Premium cabana' : 'e.g. General admission' },
    { name: 'price', label: 'Price', type: 'money', value: dollars(p.price_cents), hint: 'Used when it has no price tiers.' },
    { name: 'currency', label: 'Currency', type: 'select', value: p.currency || (detail.products[0] && detail.products[0].currency) || 'XCD', options: [['XCD', 'EC$ (XCD)'], ['USD', 'US$ (USD)']] },
    { name: 'capacity', label: kind === 'TABLE' ? 'Tables available' : 'Tickets available', type: 'number', value: p.capacity, placeholder: 'Blank = no limit' },
    { name: 'max', label: 'Max per order', type: 'number', value: p.max_per_order || (kind === 'TABLE' ? 2 : 10) },
    { name: 'includes', label: 'Includes (short line under the name)', value: p.includes, w2: true, placeholder: kind === 'TABLE' ? '' : 'e.g. 1 drink inclusive' },
    { name: 'description', label: 'Description', type: 'textarea', value: p.description },
    { name: 'sales_end', label: 'Sales end (Antigua time, optional)', type: 'datetime', value: toInput(p.sales_end) },
    { name: 'sort', label: 'Sort order', type: 'number', value: p.sort_order || 0 },
    { name: 'active', label: 'Visible on the ticket site', type: 'checkbox', value: p.active !== false }
  ];
  if (kind === 'TABLE') f = f.concat([
    { name: 'tickets', label: 'Entry tickets included', type: 'number', value: p.tickets_included || 5 },
    { name: 'cars', label: 'Car passes included', type: 'number', value: p.car_passes || 0 },
    { name: 'slots', label: 'Bottle slots (tiers, e.g. 2, 2, 1)', value: (p.bottle_slots || [1]).join(', '), w2: true, hint: labels.map(function (l, i) { return (i + 1) + ' = ' + l; }).join(' · ') },
    { name: 'later', label: 'Allow "Decide later" for bottles', type: 'checkbox', value: !!p.slot_later },
    { name: 'points', label: 'Chaser points', type: 'number', step: '0.5', value: p.chaser_points === undefined ? 6 : p.chaser_points },
    { name: 'perks', label: 'Perks (one per line)', type: 'textarea', value: p.perks, placeholder: 'Elevated platform' + NL + 'Assigned waitress' },
    { name: 'dkind', label: 'Deposit', type: 'select', value: p.deposit_kind || 'NONE', options: [['NONE', 'No deposit: full price'], ['PERCENT', 'Percent of the table'], ['AMOUNT', 'Fixed amount']],
      onInput: function (i) { var on = i.dkind.value !== 'NONE'; ['dvalue', 'brule', 'bdays', 'bdate'].forEach(function (k) { i[k].disabled = !on; }); i.bdays.disabled = !on || i.brule.value !== 'DAYS'; i.bdate.disabled = !on || i.brule.value !== 'DATE'; } },
    { name: 'dvalue', label: 'Deposit (% or amount)', type: 'number', step: '0.01', value: p.deposit_kind === 'AMOUNT' ? dollars(p.deposit_value) : p.deposit_value || '' },
    { name: 'brule', label: 'Balance due', type: 'select', value: p.balance_rule || 'DAYS', options: [['DAYS', 'Days after booking'], ['DATE', 'By a date']], onInput: function (i) { i.bdays.disabled = i.dkind.value === 'NONE' || i.brule.value !== 'DAYS'; i.bdate.disabled = i.dkind.value === 'NONE' || i.brule.value !== 'DATE'; } },
    { name: 'bdays', label: 'Days after booking', type: 'number', value: p.balance_days || 7 },
    { name: 'bdate', label: 'Balance due by (Antigua time)', type: 'datetime', value: toInput(p.balance_date), hint: 'Never after the event starts.' }
  ]);
  return f;
}
function productBody(v, kind) {
  var b = { name: v.name, price_cents: cents(v.price) || 0, currency: v.currency, capacity: v.capacity, max_per_order: v.max, includes: v.includes, description: v.description,
    sales_end: v.sales_end, sort_order: v.sort || 0, active: v.active };
  if (kind === 'TABLE') {
    b.tickets_included = v.tickets; b.car_passes = v.cars; b.slot_later = v.later; b.chaser_points = parseFloat(v.points) || 0; b.perks = v.perks;
    b.bottle_slots = String(v.slots || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean).map(Number);
    b.deposit_kind = v.dkind; b.deposit_value = v.dkind === 'AMOUNT' ? (cents(v.dvalue) || 0) : v.dkind === 'PERCENT' ? Math.round(parseFloat(v.dvalue) || 0) : 0;
    b.balance_rule = v.brule; b.balance_days = v.bdays || 7; b.balance_date = v.brule === 'DATE' ? v.bdate : '';
  }
  return b;
}
function newProduct(kind) {
  ask({ title: kind === 'TABLE' ? 'New table type' : 'New ticket type', fields: productFields(null, kind), ok: 'Create',
    onSubmit: function (v) { var b = productBody(v, kind); b.kind = kind; b.event_id = cur; return api('/api/admin/tickets/products', b); } })
    .then(function (r) { if (r) { toast('Created.'); openEvent(cur, true); } });
}
$('p-new-ticket').addEventListener('click', function () { newProduct('TICKET'); });
$('p-new-table').addEventListener('click', function () { newProduct('TABLE'); });
function editProduct(p) {
  ask({ title: 'Edit ' + p.name, fields: productFields(p, p.kind), onSubmit: function (v) { return api('/api/admin/tickets/products/' + p.id, productBody(v, p.kind)); } })
    .then(function (r) { if (r) { toast('Saved.'); openEvent(cur, true); } });
}
function tierDialog(p, t) {
  t = t || {};
  ask({ title: t.id ? 'Edit price' : 'New price for ' + p.name, text: 'Buyers pay the first price that hasn' + String.fromCharCode(39) + 't ended or sold out.', ok: t.id ? 'Save' : 'Add', fields: [
    { name: 'name', label: 'Name', value: t.name, w2: true, placeholder: 'e.g. Early bird' }, { name: 'price', label: 'Price', type: 'money', value: dollars(t.price_cents) },
    { name: 'quantity', label: 'How many at this price', type: 'number', value: t.quantity, placeholder: 'Blank = no limit' },
    { name: 'ends_at', label: 'Ends (Antigua time)', type: 'datetime', value: toInput(t.ends_at) }, { name: 'sort', label: 'Order', type: 'number', value: t.sort_order || 0 }],
    onSubmit: function (v) {
      var b = { name: v.name, price_cents: cents(v.price), quantity: v.quantity, ends_at: v.ends_at, sort_order: v.sort || 0 };
      if (t.id) return api('/api/admin/tickets/tiers/' + t.id, b);
      b.product_id = p.id; return api('/api/admin/tickets/tiers', b);
    } }).then(function (r) { if (r) { toast('Saved.'); openEvent(cur, true); } });
}
function renderProducts() {
  var tbody = $('prodlist'); tbody.replaceChildren();
  var ps = detail.products;
  if (!ps.length) emptyRow(tbody, 8, 'No tickets or tables yet.');
  ps.forEach(function (p) {
    var tr = el('tr'), c = td(tr, '');
    c.appendChild(el('b', p.name));
    var labels = detail.tier_labels;
    var sub = p.kind === 'TABLE' ? 'Table · ' + p.tickets_included + ' tickets · ' + p.bottle_slots.length + ' bottles (' + p.bottle_slots.map(function (t) { return labels[t - 1]; }).join(', ') + ') · ' + p.chaser_points + ' chaser points' + (p.car_passes ? ' · ' + p.car_passes + ' car passes' : '') +
      (p.deposit_kind !== 'NONE' ? ' · deposit ' + (p.deposit_kind === 'PERCENT' ? p.deposit_value + '%' : money(p.deposit_value, p.currency)) + ', balance ' + (p.balance_rule === 'DATE' ? 'by ' + when(p.balance_date) : p.balance_days + ' days after booking') : '')
      : 'Ticket' + (p.includes ? ' · ' + p.includes : '') + ' · up to ' + p.max_per_order + ' per order';
    c.appendChild(el('span', sub, 's'));
    var tiers = el('div', undefined, 'tiers');
    (p.tiers || []).forEach(function (t) {
      var row = el('div', undefined, 'tier' + (p.tier_now === t.name ? ' now' : ''));
      row.appendChild(el('b', t.name)); row.appendChild(el('span', money(t.price_cents, p.currency), 'mono'));
      row.appendChild(el('span', (t.quantity ? t.sold + ' of ' + t.quantity : t.sold + ' sold') + (t.ends_at ? ' · ends ' + when(t.ends_at) : ''), 'mono'));
      row.appendChild(el('span', '', 'sp'));
      var eb = el('button', 'Edit', 'ghost sm'); eb.type = 'button'; eb.addEventListener('click', function () { tierDialog(p, t); }); row.appendChild(eb);
      var db = el('button', 'Remove', 'danger sm'); db.type = 'button'; db.addEventListener('click', function () { confirmIt('Remove ' + t.name + '?', 'Orders made at this price keep it.', 'Remove', true).then(function (y) { if (y) api('/api/admin/tickets/tiers/' + t.id + '/delete', {}).then(function () { openEvent(cur, true); }).catch(function (e) { toast(e.message, true); }); }); });
      row.appendChild(db); tiers.appendChild(row);
    });
    var addT = el('button', '+ Price tier', 'ghost sm'); addT.type = 'button'; addT.style.justifySelf = 'start'; addT.addEventListener('click', function () { tierDialog(p); });
    tiers.appendChild(addT); c.appendChild(tiers);
    var price = td(tr, money(p.price_now, p.currency), 'num'); if (p.tier_now) price.appendChild(el('span', p.tier_now, 's'));
    td(tr, String(p.sold), 'num'); td(tr, String(p.deposit), 'num'); td(tr, String(p.held), 'num');
    var left = td(tr, p.left === null ? 'No limit' : String(p.left), 'num');
    if (p.sold_out) left.appendChild(el('span', 'Sold out', 's')); else if (p.sales_closed) left.appendChild(el('span', 'Sales closed', 's'));
    var vis = td(tr, ''); var tg = el('button', p.active ? 'Visible' : 'Hidden', 'ghost sm'); tg.type = 'button'; tg.setAttribute('aria-pressed', p.active ? 'true' : 'false');
    tg.addEventListener('click', function () { api('/api/admin/tickets/products/' + p.id, { active: !p.active }).then(function () { openEvent(cur, true); }).catch(function (e) { toast(e.message, true); }); });
    vis.appendChild(tg);
    var act = td(tr, '', 'actions');
    var e1 = el('button', 'Edit', 'ghost sm'); e1.type = 'button'; e1.addEventListener('click', function () { editProduct(p); }); act.appendChild(e1);
    if (!p.has_orders) { var d1 = el('button', 'Delete', 'danger sm'); d1.type = 'button'; d1.addEventListener('click', function () { confirmIt('Delete ' + p.name + '?', 'It has no orders, so it can go.', 'Delete', true).then(function (y) { if (y) api('/api/admin/tickets/products/' + p.id + '/delete', {}).then(function () { openEvent(cur, true); }).catch(function (e) { toast(e.message, true); }); }); }); act.appendChild(d1); }
    tbody.appendChild(tr);
  });
  labelCells(tbody);
}

// ---------- Orders ----------
var OSTATUS = { PAID: ['Paid', 'good'], DEPOSIT_PAID: ['Deposit paid', 'warn'], PENDING: ['Checkout', 'cyan'], CANCELLED: ['Cancelled', ''], REFUNDED: ['Refunded', 'bad'] };
function fold(s) { return String(s || '').toLowerCase().normalize('NFD').split('').filter(function (c) { var n = c.charCodeAt(0); return n < 768 || n > 879; }).join(''); }
function itemText(i) { return (i.kind === 'TABLE' ? i.product_name : i.qty + ' × ' + i.product_name) + (i.tier_name ? ' (' + i.tier_name + ')' : ''); }
function renderOrders() {
  var q = fold($('o-q').value.trim()), f = $('o-f').value, tbody = $('orderlist'); tbody.replaceChildren();
  var list = detail.orders.filter(function (o) {
    if (f === 'HELD' ? !o.held : f === 'TRANSFERS' ? !o.tickets.some(function (t) { return t.prev_id; }) : f && o.status !== f) return false;
    if (!f && o.status === 'PENDING' && !o.held) return false;
    if (!q) return true;
    var hay = fold([o.ref, o.buyer_name, o.buyer_email].concat(o.tickets.map(function (t) { return t.ref + ' ' + t.holder_name + ' ' + t.holder_email; })).join(' '));
    return q.split(' ').every(function (w) { return hay.indexOf(w) >= 0; });
  });
  if (!list.length) emptyRow(tbody, 7, detail.orders.length ? 'No orders match.' : 'No orders yet.');
  list.forEach(function (o) {
    var tr = el('tr'), c = td(tr, '');
    c.appendChild(el('b', o.buyer_name)); c.appendChild(el('span', o.buyer_email, 's')); c.appendChild(el('span', o.ref, 's mono'));
    td(tr, o.items.map(itemText).join(', '));
    td(tr, money(o.total_cents, o.currency), 'num');
    var paid = td(tr, money(o.paid_cents, o.currency), 'num');
    if (o.status === 'DEPOSIT_PAID') paid.appendChild(el('span', money(o.total_cents - o.paid_cents, o.currency) + ' due ' + when(o.balance_due_at), 's'));
    var st = td(tr, ''); var s = OSTATUS[o.status] || [o.status, '']; st.appendChild(pill(o.status === 'PENDING' && !o.held ? 'Hold ended' : s[0], s[1]));
    if (o.cancel_reason) st.appendChild(el('span', o.cancel_reason === 'BALANCE_UNPAID' ? 'Balance not paid in time' : o.cancel_reason === 'HOLD_EXPIRED' ? 'Not paid in 30 minutes' : o.cancel_reason, 's'));
    if (o.paypal_status === 'AMOUNT_MISMATCH') st.appendChild(el('span', 'Check this payment in PayPal', 's'));
    td(tr, when(o.created_at), 'mono');
    var act = td(tr, '', 'actions');
    var v = el('button', openOrder === o.id ? 'Hide' : 'Details', 'ghost sm'); v.type = 'button'; v.setAttribute('aria-expanded', openOrder === o.id ? 'true' : 'false');
    v.addEventListener('click', function () { openOrder = openOrder === o.id ? null : o.id; renderOrders(); }); act.appendChild(v);
    if (o.status === 'DEPOSIT_PAID') {
      var mp = el('button', 'Balance paid', 'sm'); mp.type = 'button'; mp.addEventListener('click', function () { markPaid(o); }); act.appendChild(mp);
      var ex = el('button', 'Extend', 'ghost sm'); ex.type = 'button'; ex.addEventListener('click', function () { extend(o); }); act.appendChild(ex);
    }
    if (o.status === 'PAID' || o.status === 'DEPOSIT_PAID') { var rf = el('button', 'Refund', 'danger sm'); rf.type = 'button'; rf.addEventListener('click', function () { refund(o); }); act.appendChild(rf); }
    tbody.appendChild(tr);
    if (openOrder === o.id) tbody.appendChild(orderDetail(o));
  });
  labelCells(tbody);
}
function orderDetail(o) {
  var tr = el('tr', undefined, 'detail'), c = el('td'); c.colSpan = 7; tr.appendChild(c);
  var g = el('div', undefined, 'detail-grid'); c.appendChild(g);
  var a = el('div'); a.appendChild(el('h3', 'Items')); var ul = el('ul');
  o.items.forEach(function (i) {
    var li = el('li', itemText(i) + ': ' + money(i.line_cents, o.currency));
    var sel = i.selections || {};
    (sel.slots || []).forEach(function (s) { li.appendChild(el('div', (s.later ? 'Decide later (' + s.slot_label + ')' : s.name + ' (' + s.tier_label + ')') + (s.charge_cents ? ' +' + money(s.charge_cents, o.currency) : ''))); });
    if (i.kind === 'TABLE') li.appendChild(el('div', (sel.chasers || []).length ? 'Chasers: ' + sel.chasers.map(function (x) { return x.qty + ' × ' + x.name; }).join(', ') + ' (' + sel.points_used + ' of ' + sel.points_budget + ' points)' : 'No chasers'));
    ul.appendChild(li);
  });
  if (o.fee_cents) ul.appendChild(el('li', 'Service fee: ' + money(o.fee_cents, o.currency)));
  a.appendChild(ul); g.appendChild(a);
  var b = el('div'); b.appendChild(el('h3', 'Payments')); var ul2 = el('ul');
  if (!o.payments.length) ul2.appendChild(el('li', 'None yet.'));
  o.payments.forEach(function (p) { ul2.appendChild(el('li', (p.kind === 'DEPOSIT' ? 'Deposit' : p.kind === 'BALANCE' ? 'Balance' : 'In full') + ' · ' + money(p.amount_cents, o.currency) + (p.usd_amount ? ' (US$' + p.usd_amount + ')' : '') + ' · ' + (p.via === 'PAYPAL' ? 'PayPal' : 'by hand' + (p.note ? ': ' + p.note : '') + (p.by_name ? ' · Marked paid by ' + p.by_name : '')) + ' · ' + when(p.created_at) + (p.refunded_at ? ' · refunded' : ''))); });
  b.appendChild(ul2);
  var lnk = el('a', 'Open the buyer' + String.fromCharCode(39) + 's order page'); lnk.href = o.order_url; lnk.target = '_blank'; lnk.rel = 'noopener'; b.appendChild(lnk);
  g.appendChild(b);
  var t = el('div'); t.appendChild(el('h3', 'Tickets and transfers')); var ul3 = el('ul');
  if (!o.tickets.length) ul3.appendChild(el('li', o.status === 'DEPOSIT_PAID' ? 'Issued once the balance is paid.' : 'None.'));
  o.tickets.forEach(function (x) {
    ul3.appendChild(el('li', x.ref + ' · ' + x.label + ' · ' + (x.status === 'TRANSFERRED' ? 'transferred to ' + x.transferred_to_email + ' ' + when(x.transferred_at) : x.status === 'CANCELLED' ? 'cancelled' : x.checked_in_at ? 'in ' + when(x.checked_in_at) : 'valid') + (x.prev_id ? ' · held by ' + x.holder_name + ' (' + x.holder_email + ')' : '')));
  });
  t.appendChild(ul3); g.appendChild(t);
  return tr;
}
function markPaid(o) {
  ask({ title: 'Balance paid by hand?', text: money(o.total_cents - o.paid_cents, o.currency) + ' from ' + o.buyer_name + '. The order is paid in full and the tickets are emailed.', ok: 'Mark paid',
    fields: [{ name: 'note', label: 'Note (how it was paid)', w2: true, placeholder: 'e.g. Cash at HQ' }],
    onSubmit: function (v) { return api('/api/admin/tickets/orders/' + o.id + '/mark-paid', { note: v.note }); } })
    .then(function (r) { if (r) { toast('Paid. Tickets emailed.'); openEvent(cur, true); } });
}
function extend(o) {
  ask({ title: 'New balance deadline', text: 'Antigua time. Before the event starts.', ok: 'Save', fields: [{ name: 'at', label: 'Balance due by', type: 'datetime', value: toInput(o.balance_due_at), w2: true }],
    onSubmit: function (v) { return api('/api/admin/tickets/orders/' + o.id + '/balance-due', { balance_due_at: v.at }); } })
    .then(function (r) { if (r) { toast('Deadline moved.'); openEvent(cur, true); } });
}
function refund(o) {
  var pp = o.payments.filter(function (p) { return p.via === 'PAYPAL' && !p.refunded_at; }), hand = o.payments.filter(function (p) { return p.via === 'MANUAL'; });
  confirmIt('Refund ' + o.ref + '?', 'Refunds ' + (pp.length ? pp.length + ' PayPal ' + (pp.length === 1 ? 'payment' : 'payments') + ' (' + money(pp.reduce(function (a, p) { return a + p.amount_cents; }, 0), o.currency) + ')' : 'nothing through PayPal') +
    (hand.length ? ', and you give back ' + money(hand.reduce(function (a, p) { return a + p.amount_cents; }, 0), o.currency) + ' paid by hand yourself' : '') + '. Its tickets stop working at once. This can' + String.fromCharCode(39) + 't be undone.', 'Refund', true)
    .then(function (y) { if (!y) return; api('/api/admin/tickets/orders/' + o.id + '/refund', {}).then(function () { toast('Refunded. Its tickets no longer work.'); openEvent(cur, true); }).catch(function (e) { toast(e.message, true); }); });
}
$('o-q').addEventListener('input', renderOrders);
$('o-f').addEventListener('change', renderOrders);

// ---------- Bar list and door ----------
function loadBar() {
  $('bar-print').href = '/admin/tickets/events/' + cur + '/bar-list';
  $('bar-csv').href = '/api/admin/tickets/events/' + cur + '/bar-list.csv';
  $('o-door').href = '/api/admin/tickets/events/' + cur + '/door.csv';
  api('/api/admin/tickets/events/' + cur + '/bar-list').then(function (b) {
    var box = $('bar'); box.replaceChildren();
    if (!b.tables.length) { box.appendChild(el('p', 'No tables paid yet.')); return; }
    var t = el('table'), th = el('thead'), hr = el('tr');
    ['Table', 'Order', 'Bottles', 'Chasers'].forEach(function (h) { hr.appendChild(el('th', h)); }); th.appendChild(hr); t.appendChild(th);
    var tb = el('tbody');
    b.tables.forEach(function (x) {
      var tr = el('tr'), c = td(tr, ''); c.appendChild(el('b', x.table)); c.appendChild(el('span', x.status === 'PAID' ? 'Paid' : 'Deposit paid', 's'));
      var c2 = td(tr, ''); c2.appendChild(el('b', x.buyer)); c2.appendChild(el('span', x.ref, 's mono'));
      td(tr, x.slots.map(function (s) { return s.later ? 'Decide later (' + s.slot_label + ')' : s.name + (s.charge_cents ? ' (upgrade)' : ''); }).join(', '));
      td(tr, x.chasers.length ? x.chasers.map(function (c) { return c.qty + ' × ' + c.name; }).join(', ') : 'None');
      tb.appendChild(tr);
    });
    t.appendChild(tb); box.appendChild(t);
    var tot = el('div', undefined, 'tot');
    [['Bottles to order', b.bottle_totals.map(function (x) { return [x.name + (x.later ? '' : ' · ' + x.tier), x.count]; })], ['Chasers to order', b.chaser_totals.map(function (x) { return [x.group + ': ' + x.name, x.count]; })]].forEach(function (s) {
      var d = el('div'); d.appendChild(el('h3', s[0]));
      var tt = el('table'), body = el('tbody');
      if (!s[1].length) { var r0 = el('tr'); td(r0, 'None'); body.appendChild(r0); }
      s[1].forEach(function (r) { var row = el('tr'); td(row, r[0]); td(row, String(r[1]), 'num big'); body.appendChild(row); });
      tt.appendChild(body); d.appendChild(tt); tot.appendChild(d);
    });
    box.appendChild(tot);
  }).catch(function (e) { toast(e.message, true); });
}
var SCANS = { ENTRY: ['Entry', 'good'], MANUAL: ['Let in after ID check', 'warn'], OVERRIDE: ['Override', 'warn'], DUPLICATE: ['Blocked repeat', 'bad'], UNDO: ['Undone', ''] };
function loadDoorLog() {
  api('/api/admin/ticket-checkins?event=' + cur).then(function (rows) {
    var tbody = $('doorlog'); tbody.replaceChildren();
    if (!rows.length) emptyRow(tbody, 5, 'No scans yet. They show up here as staff scan tickets at the door.');
    rows.forEach(function (r) {
      var tr = el('tr'), c = td(tr, ''); c.appendChild(el('b', r.label)); c.appendChild(el('span', r.ref + (r.ticket_kind === 'CAR' ? ' · car pass' : ''), 's mono'));
      var s = SCANS[r.kind] || [r.kind, '']; td(tr, '').appendChild(pill(s[0], s[1]));
      td(tr, when(r.scanned_at), 'mono'); td(tr, r.device || ''); td(tr, r.order_ref, 'mono');
      tbody.appendChild(tr);
    });
    labelCells(tbody);
  }).catch(function () {});
}

// ---------- Menus ----------
function loadMenus() {
  return api('/api/admin/tickets/menus').then(function (m) { menus = m; renderMenus(); }).catch(function (e) { toast(e.message, true); });
}
function tierOptions() { return menus.tier_labels.map(function (l, i) { return [String(i + 1), (i + 1) + ' · ' + l]; }); }
function bottleDialog(b) {
  b = b || {};
  ask({ title: b.id ? 'Edit bottle' : 'New bottle', fields: [{ name: 'name', label: 'Name', value: b.name, w2: true, placeholder: 'e.g. Hennessy VS' }, { name: 'tier', label: 'Tier', type: 'select', value: String(b.tier || 1), options: tierOptions() },
    { name: 'up', label: 'Upgrade price', type: 'money', value: dollars(b.upgrade_cents || 0), hint: 'Charged when picked in a lower-tier slot.' }, { name: 'sort', label: 'Sort order', type: 'number', value: b.sort_order || 0 }, { name: 'active', label: 'On the menu', type: 'checkbox', value: b.active !== false }],
    onSubmit: function (v) { var body = { name: v.name, tier: Number(v.tier), upgrade_cents: cents(v.up) || 0, sort_order: v.sort || 0, active: v.active }; return api('/api/admin/tickets/bottles' + (b.id ? '/' + b.id : ''), body); } })
    .then(function (r) { if (r) { toast('Saved.'); loadMenus(); } });
}
function renderMenus() {
  for (var i = 1; i <= 3; i++) $('tl' + i).value = menus.tier_labels[i - 1];
  var tbody = $('bottlelist'); tbody.replaceChildren();
  if (!menus.bottles.length) emptyRow(tbody, 6, 'No bottles yet.');
  menus.bottles.forEach(function (b) {
    var tr = el('tr'); td(tr, b.name, ''); td(tr, b.tier + ' · ' + menus.tier_labels[b.tier - 1]); td(tr, b.upgrade_cents ? '+' + dollars(b.upgrade_cents) : 'Included only', 'num');
    td(tr, '').appendChild(pill(b.active ? 'On' : 'Off', b.active ? 'good' : '')); td(tr, String(b.sort_order), 'num');
    var a = td(tr, '', 'actions'), e = el('button', 'Edit', 'ghost sm'); e.type = 'button'; e.addEventListener('click', function () { bottleDialog(b); }); a.appendChild(e);
    var d = el('button', 'Delete', 'danger sm'); d.type = 'button'; d.addEventListener('click', function () { confirmIt('Delete ' + b.name + '?', 'Tables already bought keep their bottles. To stop selling it for now, turn it off instead.', 'Delete', true).then(function (y) { if (y) api('/api/admin/tickets/bottles/' + b.id + '/delete', {}).then(loadMenus).catch(function (er) { toast(er.message, true); }); }); });
    a.appendChild(d); tbody.appendChild(tr);
  });
  labelCells(tbody);
  var box = $('chaserlist'); box.replaceChildren();
  if (!menus.chaser_groups.length) box.appendChild(el('p', 'No chaser groups yet. Start with one, like Sodas at 1 point.', 'hint'));
  menus.chaser_groups.forEach(function (g) {
    var wrap = el('div'); wrap.style.marginTop = '18px';
    var head = el('div', undefined, 'row'); head.style.justifyContent = 'space-between';
    var h = el('h3', g.name + ' · ' + g.points + (Number(g.points) === 1 ? ' point' : ' points') + ' each'); h.style.margin = '0'; head.appendChild(h);
    var hb = el('div', undefined, 'row');
    var add = el('button', '+ Chaser', 'sm'); add.type = 'button'; add.addEventListener('click', function () { chaserDialog(g); }); hb.appendChild(add);
    var eg = el('button', 'Edit group', 'ghost sm'); eg.type = 'button'; eg.addEventListener('click', function () { groupDialog(g); }); hb.appendChild(eg);
    head.appendChild(hb); wrap.appendChild(head);
    var list = menus.chasers.filter(function (c) { return c.group_id === g.id; });
    var tw = el('div', undefined, 'scroll'); tw.style.marginTop = '10px';
    var t = el('table', undefined, 'cards'), th = el('thead'), hr = el('tr'); ['Chaser', 'On the menu', 'Sort', ''].forEach(function (x, i) { hr.appendChild(el('th', x, i === 2 ? 'num' : '')); }); th.appendChild(hr); t.appendChild(th);
    var tb = el('tbody');
    if (!list.length) emptyRow(tb, 4, 'No chasers in this group yet.');
    list.forEach(function (c) {
      var tr = el('tr'); td(tr, c.name); td(tr, '').appendChild(pill(c.active ? 'On' : 'Off', c.active ? 'good' : '')); td(tr, String(c.sort_order), 'num');
      var a = td(tr, '', 'actions'), e = el('button', 'Edit', 'ghost sm'); e.type = 'button'; e.addEventListener('click', function () { chaserDialog(g, c); }); a.appendChild(e);
      var d = el('button', 'Delete', 'danger sm'); d.type = 'button'; d.addEventListener('click', function () { api('/api/admin/tickets/chasers/' + c.id + '/delete', {}).then(loadMenus).catch(function (er) { toast(er.message, true); }); }); a.appendChild(d);
      tb.appendChild(tr);
    });
    t.appendChild(tb); tw.appendChild(t); wrap.appendChild(tw); box.appendChild(wrap);
    labelCells(tb);
  });
}
function groupDialog(g) {
  g = g || {};
  ask({ title: g.id ? 'Edit group' : 'New chaser group', fields: [{ name: 'name', label: 'Name', value: g.name, w2: true, placeholder: 'e.g. Juices' }, { name: 'points', label: 'Points per chaser', type: 'number', step: '0.5', value: g.points || 1 }, { name: 'sort', label: 'Sort order', type: 'number', value: g.sort_order || 0 }],
    onSubmit: function (v) { return api('/api/admin/tickets/chaser-groups' + (g.id ? '/' + g.id : ''), { name: v.name, points: parseFloat(v.points), sort_order: v.sort || 0 }); } })
    .then(function (r) { if (r) { toast('Saved.'); loadMenus(); } });
}
function chaserDialog(g, c) {
  c = c || {};
  ask({ title: c.id ? 'Edit chaser' : 'New chaser in ' + g.name, fields: [{ name: 'name', label: 'Name', value: c.name, w2: true, placeholder: 'e.g. Coke' }, { name: 'sort', label: 'Sort order', type: 'number', value: c.sort_order || 0 }, { name: 'active', label: 'On the menu', type: 'checkbox', value: c.active !== false }],
    onSubmit: function (v) { var b = { name: v.name, sort_order: v.sort || 0, active: v.active }; if (!c.id) b.group_id = g.id; return api('/api/admin/tickets/chasers' + (c.id ? '/' + c.id : ''), b); } })
    .then(function (r) { if (r) { toast('Saved.'); loadMenus(); } });
}
$('b-new').addEventListener('click', function () { bottleDialog(); });
$('g-new').addEventListener('click', function () { groupDialog(); });
$('tl-save').addEventListener('click', function () { api('/api/admin/tickets/tier-labels', { labels: [$('tl1').value, $('tl2').value, $('tl3').value] }).then(function () { toast('Tier names saved.'); loadMenus(); }).catch(function (e) { toast(e.message, true); }); });

// ---------- Ticket site lock (as on /admin/site, against /api/admin/tickets-lock) ----------
var lockNow = null;
function antigua(iso) {
  var p = {};
  new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Antigua' }).formatToParts(new Date(iso)).forEach(function (x) { p[x.type] = x.value; });
  return p.weekday + ' ' + p.day + ' ' + p.month + ', ' + p.hour + ':' + p.minute + ' ' + p.dayPeriod;
}
function lockControls(busy) {
  var d = lockNow || {};
  $('l-switch').disabled = busy || !lockNow; $('l-at').disabled = $('l-set').disabled = busy || !d.locked; $('l-clear').disabled = busy || !d.locked || !d.site_unlock_at; $('l-rotate').disabled = busy || !lockNow;
}
function showLock(d) {
  lockNow = d;
  var auto = !d.locked && d.site_lock === 'on' && d.site_unlock_at;
  $('site-lock').className = 'card lock-card ' + (d.locked ? 'is-locked' : 'is-open');
  $('l-switch').setAttribute('aria-checked', d.locked ? 'true' : 'false');
  $('l-state').textContent = d.locked ? (d.site_unlock_at ? 'Locked. Opens on ' + antigua(d.site_unlock_at) + ' (Antigua time).' : 'Locked. It stays locked until you switch it open.')
    : auto ? 'Opened automatically on ' + antigua(d.site_unlock_at) + ' (Antigua time).' : 'Open. Anyone can buy tickets.';
  $('l-at').value = d.locked ? toInput(d.site_unlock_at) : '';
  $('l-help').textContent = d.locked ? 'Antigua time. The ticket site opens by itself then.' : 'The ticket site is open, so there is nothing to schedule. Lock it again to set a time.';
  $('l-url').textContent = d.preview_url;
  lockControls(false);
}
function loadLock() { return api('/api/admin/tickets-lock').then(showLock).catch(function (e) { $('l-state').textContent = 'Could not load the lock: ' + e.message; }); }
function lockSave(body, done) {
  lockControls(true); $('l-msg').textContent = '';
  return api('/api/admin/tickets-lock', body).then(function (d) { showLock(d); say('l-msg', done(d), true); }).catch(function (e) { say('l-msg', e.message); lockControls(false); });
}
$('l-switch').addEventListener('click', function () {
  if (!lockNow) return;
  var open = lockNow.locked;
  confirmIt(open ? 'Open the ticket site?' : 'Lock the ticket site?', open ? 'Everyone can see the events and buy tickets straight away.' : 'Everyone sees only the trailer and nothing can be bought until you open it again. Bought tickets keep working.', open ? 'Open it' : 'Lock it', !open)
    .then(function (y) { if (!y) return $('l-switch').focus(); lockSave({ site_lock: open ? 'off' : 'on' }, function (d) { return d.locked ? 'Locked.' : 'Open.'; }).then(function () { $('l-switch').focus(); }); });
});
$('l-set').addEventListener('click', function () { var v = $('l-at').value; if (!v) return say('l-msg', 'Pick a date and time first.'); lockSave({ site_unlock_at: v }, function (d) { return 'Saved. It opens on ' + antigua(d.site_unlock_at) + '.'; }); });
$('l-clear').addEventListener('click', function () { lockSave({ site_unlock_at: '' }, function () { return 'Cleared.'; }); });
$('l-copy').addEventListener('click', function () { if (lockNow) navigator.clipboard.writeText(lockNow.preview_url).then(function () { say('l-msg', 'Preview link copied.', true); }, function () { say('l-msg', 'Copy failed. Select the link and copy it.'); }); });
$('l-rotate').addEventListener('click', function () {
  confirmIt('Reset the preview link?', 'The link you have now stops working straight away. You get a new one to copy.', 'Reset link', true).then(function (y) {
    if (!y) return;
    api('/api/admin/tickets-lock/preview-reset', {}).then(function (d) { showLock(d); say('l-msg', 'New preview link ready. The old one no longer works.', true); }).catch(function (e) { say('l-msg', e.message); });
  });
});

// ---------- Terms ----------
var defTerms = '';
function loadTerms() {
  return api('/api/admin/tickets/terms').then(function (d) {
    defTerms = d.default_terms; $('tt').value = d.terms;
    $('tt-state').textContent = d.terms_updated_at ? 'Last changed ' + new Date(d.terms_updated_at).toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'America/Antigua' }) + '.' : 'Buyers see the original draft. Read it, change what doesn' + String.fromCharCode(39) + 't match how you run things, and save.';
  }).catch(function (e) { say('tt-msg', e.message); });
}
$('tt-save').addEventListener('click', function () { api('/api/admin/tickets/terms', { terms: $('tt').value }).then(function () { say('tt-msg', 'Saved. Buyers see the new terms now.', true); loadTerms(); }).catch(function (e) { say('tt-msg', e.message); }); });
$('tt-reset').addEventListener('click', function () { confirmIt('Use the original draft?', 'Replaces the text in the box. Nothing changes for buyers until you save.', 'Use it').then(function (y) { if (y) { $('tt').value = defTerms; say('tt-msg', 'Original draft loaded. Save to use it.', true); } }); });

var h = location.hash.slice(1);
loadEvents().then(function () { if (events.length && !cur) openEvent((events.find(function (e) { return e.status === 'ON_SALE'; }) || events[0]).id, true); });
if (TABS.indexOf(h) > 0) showTab(h);
</script></body></html>`;
}

// The printable bar list: black on white for the printer, the concrete look on screen.
export function barListPage({ event, tables, bottle_totals: bottles, chaser_totals: chasers }) {
  const slot = (s) => (s.later ? `Decide later (${esc(s.slot_label)})` : `${esc(s.name)} <span class="t">${esc(s.tier_label || '')}${s.charge_cents ? ' · upgrade' : ''}</span>`);
  return `${HEAD('Bar list')}
<style>
${ROOT}
* { box-sizing: border-box; }
body { margin: 0; background: var(--concrete); color: var(--ink); font: 14px/1.45 var(--body); font-variant-numeric: tabular-nums; }
header { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 14px 24px; background: var(--wm) 0 0 / 260px 150px, var(--bg); color: var(--text); }
header b { font: 900 16px/1 var(--display); font-stretch: 125%; } header b span { color: var(--accent); } header b i { font-style: normal; font-weight: 200; }
header button { min-height: 40px; padding: 0 16px; font: 700 13px/1 var(--display); text-transform: uppercase; letter-spacing: .05em; background: var(--accent); color: var(--ink); border: 0; cursor: pointer; }
main { padding: 24px; max-width: 1000px; margin: 0 auto; }
h1 { font: 800 30px/1 var(--display); font-stretch: 125%; text-transform: uppercase; margin: 0; }
.when { font: 400 12px var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-2); margin: 8px 0 20px; }
h2 { font: 800 15px/1 var(--display); font-stretch: 112%; text-transform: uppercase; letter-spacing: .04em; margin: 26px 0 10px; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font: 400 10.5px var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--ink-2); border-bottom: 2px solid var(--ink); padding: 6px 8px; }
td { border-bottom: 1px solid rgba(20, 20, 22, .2); padding: 8px; vertical-align: top; }
td.n { text-align: right; font: 700 18px var(--mono); width: 80px; }
.t { color: var(--ink-2); font-size: 12px; }
.ref { font: 400 12px var(--mono); color: var(--ink-2); display: block; }
.box { display: inline-block; width: 14px; height: 14px; border: 1.5px solid var(--ink); vertical-align: middle; margin-right: 6px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
@media (max-width: 700px) { .cols { grid-template-columns: 1fr; } main { padding: 16px; } }
@media print { header { display: none; } body { background: #fff; } main { padding: 0; max-width: none; } h2 { break-after: avoid; } tr { break-inside: avoid; } }
</style></head><body>
<header><b>ON D<span>'</span> <i>ROAD</i></b><span style="font:400 11px var(--mono);letter-spacing:.12em;text-transform:uppercase">[ Bar list ]</span><button type="button" onclick="window.print()">Print</button></header>
<main>
  <h1>${esc(event.name)}</h1>
  <p class="when">${esc(event.when)} · ${tables.length} ${tables.length === 1 ? 'table' : 'tables'} · printed ${esc(new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Antigua' }))}</p>
  <div class="cols">
    <section><h2>Bottles to order</h2><table><thead><tr><th>Bottle</th><th>Tier</th><th style="text-align:right">Qty</th></tr></thead><tbody>
      ${bottles.length ? bottles.map((b) => `<tr><td>${esc(b.name)}${b.upgrades ? ` <span class="t">(${b.upgrades} upgraded)</span>` : ''}</td><td>${esc(b.later ? '' : b.tier)}</td><td class="n">${b.count}</td></tr>`).join('') : '<tr><td colspan="3">None yet.</td></tr>'}
    </tbody></table></section>
    <section><h2>Chasers to order</h2><table><thead><tr><th>Chaser</th><th style="text-align:right">Qty</th></tr></thead><tbody>
      ${chasers.length ? chasers.map((c) => `<tr><td>${esc(c.name)} <span class="t">${esc(c.group)}</span></td><td class="n">${c.count}</td></tr>`).join('') : '<tr><td colspan="2">None yet.</td></tr>'}
    </tbody></table></section>
  </div>
  <h2>Tables</h2>
  <table><thead><tr><th>Table</th><th>Buyer</th><th>Bottles</th><th>Chasers</th></tr></thead><tbody>
    ${tables.length ? tables.map((t) => `<tr><td><span class="box"></span><b>${esc(t.table)}</b>${t.status === 'PAID' ? '' : ' <span class="t">deposit paid</span>'}</td><td>${esc(t.buyer)}<span class="ref">${esc(t.ref)}</span></td><td>${t.slots.map(slot).join('<br>')}</td><td>${t.chasers.length ? t.chasers.map((c) => `${c.qty} × ${esc(c.name)}`).join('<br>') : 'None'}</td></tr>`).join('') : '<tr><td colspan="4">No tables paid yet.</td></tr>'}
  </tbody></table>
</main></body></html>`;
}
