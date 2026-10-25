// admin-ui.js: the shared look of the admin pages added with admin accounts (sign-in, setup, account, team, audit, the
// app): Night Kinetic, admin edition, with the same tokens as the other admin pages (matte charcoal, safety orange as the
// one accent, hairlines, square corners), plus the small browser helpers those pages share (UI_JS).
// Client code here sits inside template literals: no backticks or backslashes in it (String.fromCharCode instead).
import { WM_LITE } from './brand.js';

export const BASE_CSS = `
:root { --bg: #0a0a0b; --surface: #141416; --surface-2: #1a1a1d; --raise: #232327; --well: #0a0a0b; --line: rgba(236, 235, 230, .1); --line-strong: rgba(236, 235, 230, .24); --text: #ecebe6; --muted: #a6a59f; --dim: #8a8983; --accent: #ff5a1f; --accent-hi: #ff7440; --accent-ink: #141416; --good: #b6ff3b; --warn: #ffc02e; --bad: #ff7a6b; --cyan: #22e1ff; --concrete: #c9c8c3; --concrete-2: #e4e3df; --ink: #141416; --ink-2: #47463f; --display: 'Archivo', 'Helvetica Neue', Arial, sans-serif; --body: 'Archivo', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; --mono: 'Space Mono', ui-monospace, SFMono-Regular, Menlo, monospace; --chev: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none' stroke='%23ecebe6' stroke-width='1.6'%3E%3Cpath d='M1 1.5l5 5 5-5'/%3E%3C/svg%3E"); --wm: ${WM_LITE}; color-scheme: dark; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 var(--body); -webkit-font-smoothing: antialiased; overflow-x: hidden; }
::selection { background: var(--accent); color: var(--accent-ink); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
a { color: var(--text); text-underline-offset: 3px; }
.top { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; gap: 10px 16px; flex-wrap: wrap; min-height: 60px; padding: 10px clamp(16px, 3vw, 32px); padding-top: max(10px, env(safe-area-inset-top)); background: var(--wm) 0 0 / 260px 150px, rgba(10, 10, 11, .92); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; text-decoration: none; color: var(--text); }
.brand .mark { flex: none; width: 30px; height: 18px; overflow: visible; }
.brand b { font-family: var(--display); font-stretch: 125%; font-weight: 900; font-size: 16px; line-height: 1; letter-spacing: .01em; white-space: nowrap; }
.brand b span { color: var(--accent); }
.brand b i { font-style: normal; font-weight: 200; }
.brand .sub { font-family: var(--mono); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); white-space: nowrap; }
.brand .sub::before { content: '[ '; color: var(--dim); }
.brand .sub::after { content: ' ]'; color: var(--dim); }
.top-r { display: flex; gap: 8px; flex-wrap: wrap; }
.back { display: inline-flex; align-items: center; min-height: 44px; padding: 0 14px; font-size: 13px; font-weight: 600; color: var(--text); text-decoration: none; border: 1px solid var(--line-strong); white-space: nowrap; transition: border-color .15s, background .15s; }
.back:hover { border-color: var(--text); background: rgba(236, 235, 230, .05); }
h1 { font-family: var(--display); font-stretch: 125%; font-weight: 800; font-size: clamp(30px, 6vw, 48px); line-height: .98; letter-spacing: -.01em; text-transform: uppercase; margin: 0; overflow-wrap: break-word; }
h2 { font-family: var(--display); font-stretch: 118%; font-weight: 800; font-size: 19px; line-height: 1.1; letter-spacing: .01em; text-transform: uppercase; margin: 0 0 8px; }
h3 { font-family: var(--display); font-stretch: 112%; font-size: 15px; font-weight: 800; letter-spacing: .02em; text-transform: uppercase; margin: 0; }
.lead { position: relative; color: var(--muted); margin: 14px 0 28px; padding-bottom: 22px; border-bottom: 1px solid var(--line); }
.lead::after { content: ''; position: absolute; left: 0; bottom: -1px; width: 56px; height: 2px; background: var(--accent); }
.wrap { max-width: 880px; margin: 0 auto; padding: clamp(24px, 4vw, 48px) clamp(16px, 3vw, 32px) 80px; }
.card { background: var(--surface); border: 1px solid var(--line); padding: clamp(18px, 3vw, 28px); margin-bottom: 22px; }
.card > p { color: var(--muted); margin: 0 0 14px; }
.eb { font: 400 11px/1.2 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--dim); margin: 0 0 10px; }
.eb::before { content: '[ '; } .eb::after { content: ' ]'; }
button, .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; font-family: var(--display); font-weight: 700; font-stretch: 112%; font-size: 13px; line-height: 1; letter-spacing: .05em; text-transform: uppercase; padding: 0 18px; border-radius: 0; cursor: pointer; color: var(--accent-ink); background: var(--accent); border: 1px solid var(--accent); text-decoration: none; transition: background .15s, border-color .15s, color .15s; }
button:hover, .btn:hover { background: var(--accent-hi); border-color: var(--accent-hi); }
button:active, .btn:active { transform: translateY(1px); }
button:disabled { opacity: .5; cursor: progress; transform: none; }
button.ghost, .btn.ghost { color: var(--text); background: transparent; border-color: var(--line-strong); }
button.ghost:hover, .btn.ghost:hover { border-color: var(--text); background: rgba(236, 235, 230, .05); }
button.danger, .btn.danger { color: var(--bad); background: transparent; border-color: rgba(255, 122, 107, .5); }
button.danger:hover { border-color: var(--bad); background: rgba(255, 122, 107, .08); }
button.good { color: var(--ink); background: var(--good); border-color: var(--good); }
button.small, .btn.small { min-height: 36px; padding: 0 12px; font-size: 11.5px; }
button.link { min-height: 44px; padding: 0; background: none; border: 0; color: var(--muted); text-transform: none; letter-spacing: 0; font: 600 14px var(--body); text-decoration: underline; text-underline-offset: 3px; }
button.link:hover { color: var(--text); background: none; }
input, select, textarea { width: 100%; min-height: 44px; font: 500 16px var(--body); color: var(--text); background: var(--well); border: 1px solid var(--line-strong); border-radius: 0; padding: 11px 13px; transition: border-color .15s, box-shadow .15s; }
input:hover, select:hover { border-color: rgba(236, 235, 230, .42); }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
input::placeholder { color: var(--dim); }
select { cursor: pointer; padding-right: 38px; -webkit-appearance: none; appearance: none; background: var(--well) var(--chev) no-repeat right 13px center / 12px 8px; }
select option { background: var(--surface-2); color: var(--text); }
input[type=checkbox] { width: 20px; height: 20px; min-height: 0; padding: 0; accent-color: var(--accent); }
label.f { display: block; font: 400 11.5px/1.2 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 18px 0 8px; }
label.chk { display: flex; align-items: center; gap: 12px; min-height: 44px; color: var(--muted); font-size: 14px; cursor: pointer; }
.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 18px; }
.msg { font-size: 14px; font-weight: 600; min-height: 22px; margin: 12px 0 0; }
.msg.ok { color: var(--good); } .msg.err { color: var(--bad); }
.mono { font-family: var(--mono); }
.pill { display: inline-flex; align-items: center; gap: 7px; min-height: 22px; font-family: var(--mono); font-size: 10.5px; font-weight: 700; letter-spacing: .08em; line-height: 1.3; text-transform: uppercase; padding: 0 8px; white-space: nowrap; border: 1px solid var(--line-strong); color: var(--muted); }
.pill::before { content: ''; flex: none; width: 6px; height: 6px; background: currentColor; }
.pill.ok { color: var(--good); border-color: rgba(182, 255, 59, .36); }
.pill.warn { color: var(--warn); border-color: rgba(255, 192, 46, .4); }
.pill.bad { color: var(--bad); border-color: rgba(255, 122, 107, .45); }
.list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.list > li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 14px 0; border-bottom: 1px solid var(--line); }
.list .grow { flex: 1 1 220px; min-width: 0; }
.list b { display: block; font-weight: 700; overflow-wrap: anywhere; }
.list small { display: block; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.hidden { display: none !important; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.qr { display: inline-block; background: #fff; padding: 12px; line-height: 0; }
.qr svg { width: 200px; height: 200px; display: block; }
.secret { font: 700 15px/1.6 var(--mono); letter-spacing: .08em; overflow-wrap: anywhere; color: var(--text); }
.codes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 18px; margin: 10px 0 0; padding: 14px 16px; background: var(--concrete-2); color: var(--ink); font: 700 15px/1.7 var(--mono); list-style: none; }
.toast { position: fixed; left: 50%; bottom: max(24px, env(safe-area-inset-bottom)); z-index: 80; transform: translate(-50%, 16px); width: max-content; max-width: calc(100vw - 32px); padding: 13px 18px 13px 16px; border-left: 3px solid var(--accent); background: var(--concrete-2); color: var(--ink); font-size: 14px; font-weight: 600; line-height: 1.4; opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s; }
.toast.show { opacity: 1; transform: translate(-50%, 0); }
.toast.bad { border-left-color: #b3261e; background: #ffd9d4; color: #3a0d09; }
dialog { width: min(440px, calc(100vw - 32px)); padding: 26px; border: 0; border-top: 3px solid var(--accent); background: var(--concrete-2); color: var(--ink); }
dialog::backdrop { background: rgba(5, 5, 6, .74); }
dialog h3 { color: var(--ink); margin-bottom: 10px; }
dialog p { color: var(--ink-2); margin: 0 0 6px; }
dialog .row { justify-content: flex-end; }
dialog button.ghost { color: var(--ink); border-color: rgba(20, 20, 22, .4); }
dialog button.ghost:hover { border-color: var(--ink); background: rgba(20, 20, 22, .05); }
dialog button.danger { color: #fff; background: #b3261e; border-color: #b3261e; }
dialog input { color: var(--ink); background: #f4f3ef; border-color: rgba(20, 20, 22, .42); }
dialog label.f { color: var(--ink-2); }
@media (max-width: 560px) { .brand .sub { display: none; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } button:active, .btn:active { transform: none; } }
`;

export const MARK = `<svg class="mark" viewBox="0 0 30 18" aria-hidden="true" focusable="false"><path fill="#e4e3df" d="M0 6h30v12H0z"/><path fill="#0a0a0b" d="M18.2 0h5.6l-4.6 18h-5.6z"/><path fill="#ff5a1f" d="M19.6 0h2.8l-4.6 18h-2.8z"/></svg>`;

// The app's install bits: the manifest, the icons and iOS's home-screen tags. On every admin page, so any of them can be
// installed (the app itself opens on /admin/app).
export const PWA_TAGS = `<link rel="manifest" href="/admin/manifest.webmanifest">
<link rel="icon" type="image/png" sizes="192x192" href="/admin/icons/icon-192.png">
<link rel="apple-touch-icon" href="/admin/icons/apple-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="ODR Admin">
<meta name="apple-mobile-web-app-status-bar-style" content="black">`;

export function baseHead(title, css = '', { viewport = 'width=device-width, initial-scale=1, viewport-fit=cover' } = {}) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="${viewport}">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0a0a0b">
<title>${title} | On D' Road</title>
${PWA_TAGS}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>${BASE_CSS}${css}</style></head>`;
}

export function topBar(sub, right = '<a class="back" href="/admin">&larr; Back to overview</a>') {
  return `<header class="top"><a class="brand" href="/admin">${MARK}<b>ON D<span>'</span> <i>ROAD</i></b><span class="sub">${sub}</span></a><div class="top-r">${right}</div></header>`;
}

// A confirm dialog the pages share: ask(title, text, ok, { danger, fields }) resolves to the field values or null.
export const DIALOG_HTML = `<dialog id="dlg" aria-labelledby="dlg-title"><form id="dlg-form" method="dialog">
<h3 id="dlg-title"></h3><p id="dlg-text"></p><div id="dlg-fields"></div>
<div class="row"><button class="ghost" type="button" id="dlg-cancel">Cancel</button><button type="submit" id="dlg-ok">Confirm</button></div>
</form></dialog>`;

// Browser helpers. api() sends JSON; the session's x-csrf header is added by the script every signed-in admin page gets
// (auth.js), and pages before sign-in don't need it.
export const UI_JS = `
const $ = (id) => document.getElementById(id);
function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = text; if (cls) e.className = cls; return e; }
async function api(path, body, method) {
  const opts = body !== undefined || method ? { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) } : { cache: 'no-store' };
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || ('Request failed (' + res.status + ')')); e.status = res.status; e.data = data; throw e; }
  return data;
}
function when(iso) { return iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Antigua' }) : ''; }
function longWhen(iso) { return iso ? new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Antigua' }) + ' (Antigua time)' : ''; }
let toastTimer;
function toast(text, bad) {
  const t = $('toast'); if (!t) return;
  t.textContent = text; t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast' + (bad ? ' bad' : ''); }, 4200);
}
function ask(title, text, ok, o) {
  o = o || {};
  return new Promise((resolve) => {
    const dlg = $('dlg'); if (!dlg) return resolve(window.confirm(title) ? {} : null);
    $('dlg-title').textContent = title; $('dlg-text').textContent = text || '';
    const box = $('dlg-fields'); box.replaceChildren();
    const inputs = {};
    (o.fields || []).forEach((f) => {
      const l = el('label', f.label, 'f'); l.htmlFor = 'dlg-' + f.name; box.appendChild(l);
      const i = el('input'); i.id = 'dlg-' + f.name; i.type = f.type || 'text'; i.autocomplete = f.autocomplete || 'off'; if (f.inputmode) i.inputMode = f.inputmode; i.required = f.required !== false;
      box.appendChild(i); inputs[f.name] = i;
    });
    const okb = $('dlg-ok'); okb.textContent = ok || 'Confirm'; okb.className = o.danger ? 'danger' : '';
    const done = (v) => { dlg.close(); $('dlg-form').onsubmit = null; $('dlg-cancel').onclick = null; dlg.oncancel = null; resolve(v); };
    $('dlg-form').onsubmit = (e) => { e.preventDefault(); const v = {}; Object.keys(inputs).forEach((k) => { v[k] = inputs[k].value; }); done(v); };
    $('dlg-cancel').onclick = () => done(null);
    dlg.oncancel = (e) => { e.preventDefault(); done(null); };
    dlg.showModal();
    const first = box.querySelector('input'); (first || okb).focus();
  });
}
// WebAuthn (passkeys) in the browser, with no library: base64url to and from ArrayBuffers.
function b64u(buf) { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).split('+').join('-').split('/').join('_').replace(/=+$/, ''); }
function unb64u(s) { s = String(s).split('-').join('+').split('_').join('/'); while (s.length % 4) s += '='; const bin = atob(s); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b.buffer; }
const passkeysOk = () => !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
async function passkeyCreate(o) {
  const pk = Object.assign({}, o, { challenge: unb64u(o.challenge), user: Object.assign({}, o.user, { id: unb64u(o.user.id) }),
    excludeCredentials: (o.excludeCredentials || []).map((c) => Object.assign({}, c, { id: unb64u(c.id) })) });
  const c = await navigator.credentials.create({ publicKey: pk });
  return { id: c.id, rawId: b64u(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {},
    authenticatorAttachment: c.authenticatorAttachment || undefined,
    response: { clientDataJSON: b64u(c.response.clientDataJSON), attestationObject: b64u(c.response.attestationObject),
      transports: c.response.getTransports ? c.response.getTransports() : [] } };
}
async function passkeyGet(o) {
  const pk = Object.assign({}, o, { challenge: unb64u(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => Object.assign({}, c, { id: unb64u(c.id) })) });
  const c = await navigator.credentials.get({ publicKey: pk });
  return { id: c.id, rawId: b64u(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {},
    authenticatorAttachment: c.authenticatorAttachment || undefined,
    response: { clientDataJSON: b64u(c.response.clientDataJSON), authenticatorData: b64u(c.response.authenticatorData), signature: b64u(c.response.signature),
      userHandle: c.response.userHandle ? b64u(c.response.userHandle) : undefined } };
}
const standalone = () => !!((window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone);
`;
