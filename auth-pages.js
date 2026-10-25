// auth-pages.js: the admin account pages (auth.js serves them): sign-in (/admin/login, phone-first, also the door
// crew's), first owner (/admin/setup), owner recovery (/admin/recover), joining the team (/admin/join), your account
// (/admin/account) and the team (/admin/team, OWNER). Night Kinetic, admin edition: charcoal with the form on a concrete
// panel, as on the door's sign-in. No user data is put into these strings: the pages ask the API and set text.
import { baseHead, topBar, UI_JS, DIALOG_HTML, MARK } from './admin-ui.js';

// ---------- The sign-in look: a charcoal gate with a concrete panel ----------
const GATE_CSS = `
.gate { min-height: 100vh; min-height: 100svh; display: flex; flex-direction: column; }
.gate main { width: 100%; max-width: 480px; margin: 0 auto; padding: clamp(28px, 6vw, 56px) 16px 40px; flex: 1; }
.gate h1 { font-size: clamp(44px, 13vw, 68px); line-height: .92; margin: 0 0 16px; }
.gate h1 b { font-weight: 900; } .gate h1 i { font-style: normal; font-weight: 200; letter-spacing: .01em; }
.slash { display: block; width: 72px; height: 4px; margin: 0 0 22px; background: linear-gradient(90deg, var(--cyan) 0 30%, var(--accent) 30%); transform: skewX(-24deg); }
.gate p.intro { color: var(--muted); font-size: 16px; line-height: 1.5; margin: 0 0 24px; }
.cp { background: var(--concrete-2); color: var(--ink); padding: 22px clamp(18px, 4vw, 26px) 24px; border-top: 3px solid var(--accent); }
.cp h2 { color: var(--ink); font-size: 17px; }
.cp p { color: var(--ink-2); margin: 0 0 14px; }
.cp label.f { color: var(--ink-2); }
.cp label.f:first-child { margin-top: 0; }
.cp input, .cp select { color: var(--ink); background: #f4f3ef; border-color: rgba(20, 20, 22, .42); }
.cp input::placeholder { color: #6b6a64; }
.cp input:hover { border-color: var(--ink); }
.cp input:focus { border-color: var(--ink); box-shadow: inset 0 0 0 1px var(--ink); }
.cp :focus-visible { outline-color: var(--ink); }
.cp button { width: 100%; margin-top: 22px; }
.cp button.ghost { color: var(--ink); border-color: rgba(20, 20, 22, .42); }
.cp button.ghost:hover { border-color: var(--ink); background: rgba(20, 20, 22, .05); }
.cp button.link { width: auto; margin-top: 12px; color: var(--ink-2); }
.cp a { color: var(--ink); display: inline-flex; align-items: center; min-height: 44px; }
.cp a.btn { color: var(--accent-ink); }
.cp a.btn.ghost { color: var(--ink); }
.cp .msg.err { color: #9b1c12; } .cp .msg.ok { color: #24520a; }
.cp label.chk { color: var(--ink-2); margin-top: 10px; }
.cp .codeinput { font: 700 26px/1 var(--mono); letter-spacing: .3em; text-align: center; padding: 14px 10px; }
.cp .qr { margin: 4px 0 14px; padding: 10px; border: 1px solid rgba(20, 20, 22, .2); }
.cp .qr img { width: 220px; height: 220px; display: block; image-rendering: pixelated; }
.cp .secret { color: var(--ink); font-size: 14px; }
.cp .codes { background: #f4f3ef; border: 1px solid rgba(20, 20, 22, .2); }
.cp .or { display: flex; align-items: center; gap: 12px; margin: 18px 0 0; font: 400 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--ink-2); }
.cp .or::before, .cp .or::after { content: ''; flex: 1; height: 1px; background: rgba(20, 20, 22, .25); }
.cp .or + button { margin-top: 14px; }
.cp ol.steps { margin: 0 0 14px; padding-left: 20px; color: var(--ink-2); }
.cp ol.steps li { margin: 4px 0; }
.foot-links { display: flex; flex-wrap: wrap; gap: 4px 18px; margin-top: 20px; }
.foot-links a { color: var(--muted); font-size: 14px; min-height: 44px; display: inline-flex; align-items: center; }
.sig-data { display: flex; justify-content: space-between; gap: 12px; padding: 18px 16px max(18px, env(safe-area-inset-bottom)); font: 400 11px/1.3 var(--mono); letter-spacing: .1em; color: var(--dim); text-transform: uppercase; max-width: 480px; margin: 0 auto; width: 100%; }
`;
const gateTop = (sub) => `<header class="top"><span class="brand">${MARK}<b>ON D<span>'</span> <i>ROAD</i></b><span class="sub">${sub}</span></span></header>`;
const gateFoot = `<div class="sig-data" aria-hidden="true"><span>[ Admin | 18+ ]</span><span>17°07’N · 61°51’W</span></div>`;

// Shows a new 2FA secret (QR, the key to type in) and asks for a code; then the recovery codes, once.
const ENROLL_JS = `
function enroll(box, p, onCode) {
  box.replaceChildren();
  box.appendChild(el('h2', 'Set up your code app'));
  const ol = el('ol', undefined, 'steps');
  ['Open an authenticator app (Google Authenticator, 1Password, Authy, or your phone’s Passwords app).', 'Scan this code, or type in the key below it.', 'Enter the 6-digit code it shows.'].forEach((t) => ol.appendChild(el('li', t)));
  box.appendChild(ol);
  const q = el('div', undefined, 'qr'); const img = el('img'); img.src = p.qr; img.alt = 'QR code for your authenticator app'; img.width = 220; img.height = 220; q.appendChild(img); box.appendChild(q);
  const k = el('p'); k.appendChild(el('span', 'Key: ')); k.appendChild(el('span', p.secret_text, 'secret')); box.appendChild(k);
  const link = el('a', 'Open in my authenticator app'); link.href = p.otpauth; link.className = 'mono'; box.appendChild(link);
  const f = el('form'); f.noValidate = true;
  const l = el('label', '6-digit code', 'f'); l.htmlFor = 'enroll-code'; f.appendChild(l);
  const i = el('input', undefined, 'codeinput'); i.id = 'enroll-code'; i.inputMode = 'numeric'; i.autocomplete = 'one-time-code'; i.maxLength = 7; i.placeholder = '000000'; f.appendChild(i);
  const b = el('button', 'Turn on 2FA'); b.type = 'submit'; f.appendChild(b);
  const m = el('p', '', 'msg err'); m.setAttribute('role', 'status'); f.appendChild(m);
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); m.textContent = ''; b.disabled = true;
    try { await onCode(i.value.trim()); } catch (er) { m.textContent = er.message; i.select(); } finally { b.disabled = false; }
  });
  box.appendChild(f);
  setTimeout(() => i.focus(), 50);
}
function showCodes(box, codes, next, label) {
  box.replaceChildren();
  box.appendChild(el('h2', 'Save your recovery codes'));
  box.appendChild(el('p', 'Each one works once, instead of a 6-digit code, if you lose your phone. Keep them somewhere safe, like a password manager. They won’t be shown again.'));
  const ul = el('ul', undefined, 'codes'); codes.forEach((c) => ul.appendChild(el('li', c))); box.appendChild(ul);
  const row = el('div', undefined, 'row');
  const cp = el('button', 'Copy'); cp.type = 'button'; cp.className = 'ghost';
  cp.onclick = () => { navigator.clipboard && navigator.clipboard.writeText(codes.join(String.fromCharCode(10))).then(() => { cp.textContent = 'Copied'; }, () => {}); };
  const dl = el('button', 'Download'); dl.type = 'button'; dl.className = 'ghost';
  dl.onclick = () => { const a = el('a'); a.href = URL.createObjectURL(new Blob(["On D' Road admin recovery codes" + String.fromCharCode(10, 10) + codes.join(String.fromCharCode(10)) + String.fromCharCode(10)], { type: 'text/plain' })); a.download = 'odr-admin-recovery-codes.txt'; a.click(); };
  row.appendChild(cp); row.appendChild(dl); box.appendChild(row);
  if (next) {
    const go = el('button', label || "I've saved them"); go.type = 'button'; go.id = 'codes-done';
    go.onclick = () => { location.href = next; }; box.appendChild(go);
  }
}
`;

// ---------- /admin/login ----------
export const LOGIN_PAGE = `${baseHead('Sign in', GATE_CSS)}
<body class="gate">
${gateTop('Admin')}
<main>
  <p class="eb" id="eb">Admin</p>
  <h1><b>Sign</b><br><i>in</i></h1>
  <span class="slash" aria-hidden="true"></span>
  <p class="intro" id="intro">Your email and password, then the 6-digit code from your authenticator app.</p>
  <section class="cp" id="box">
    <form id="f1" novalidate>
      <label class="f" for="email">Email</label>
      <input id="email" type="email" autocomplete="username" inputmode="email" required>
      <label class="f" for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password" required>
      <label class="chk hidden" id="trust-row"><input type="checkbox" id="trusted"> Keep me signed in for 12 hours on this phone</label>
      <button type="submit" id="go1">Continue</button>
      <p class="msg err" id="m1" role="status"></p>
      <div class="hidden" id="pk-row"><p class="or">or</p><button class="ghost" type="button" id="pk">Sign in with a passkey</button></div>
    </form>
    <form id="f2" class="hidden" novalidate>
      <h2>Enter your code</h2>
      <p id="f2-intro">The 6-digit code from your authenticator app.</p>
      <label class="f" for="code" id="code-label">6-digit code</label>
      <input id="code" class="codeinput" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000000">
      <button type="submit" id="go2">Sign in</button>
      <p class="msg err" id="m2" role="status"></p>
      <button class="link" type="button" id="use-rc">Use a recovery code instead</button>
      <div class="hidden" id="pk2-row"><p class="or">or</p><button class="ghost" type="button" id="pk2">Use a passkey</button></div>
    </form>
    <div id="enroll" class="hidden"></div>
  </section>
  <nav class="foot-links"><a href="/admin/recover">Owner locked out?</a><a href="/door" id="door-link">Door scanner</a></nav>
</main>
${gateFoot}
<script>
${UI_JS}
${ENROLL_JS}
const qs = new URLSearchParams(location.search);
let next = qs.get('next') || '';
if (!next && standalone()) next = '/admin/app';
const door = next.indexOf('/door') === 0;
if (door) { $('eb').textContent = 'Door crew'; $('intro').textContent = 'Sign in with your staff account to scan. Do it once with signal before doors open.'; $('door-link').classList.add('hidden'); }
if (standalone() && !door) $('trust-row').classList.remove('hidden');
let ticket = null, rc = false;
const go = (to) => { location.replace(to || next || '/admin'); };
api('/api/admin/auth/state' + (next ? '?next=' + encodeURIComponent(next) : '')).then((s) => {
  if (s.setup_needed) return location.replace('/admin/setup');
  if (s.me) return go(s.me.next);
  if (s.passkeys && passkeysOk()) $('pk-row').classList.remove('hidden');
}).catch(() => {});
$('email').focus();
$('f1').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('m1').textContent = '';
  if (!$('email').value.trim() || !$('password').value) { $('m1').textContent = 'Enter your email and password.'; return; }
  $('go1').disabled = true;
  try {
    const r = await api('/api/admin/auth/login', { email: $('email').value.trim(), password: $('password').value, trusted: $('trusted').checked });
    ticket = r.ticket;
    $('password').value = '';
    if (r.step === 'enroll') {
      $('f1').classList.add('hidden'); const box = $('enroll'); box.classList.remove('hidden');
      $('intro').textContent = 'Your two-step codes were reset. Set them up again to finish signing in.';
      enroll(box, r, async (code) => {
        const d = await api('/api/admin/auth/login/enroll', { ticket, code, next });
        showCodes(box, d.recovery_codes, d.next, 'Continue');
      });
      return;
    }
    $('f1').classList.add('hidden'); $('f2').classList.remove('hidden');
    if (r.passkey && passkeysOk()) $('pk2-row').classList.remove('hidden');
    $('code').focus();
  } catch (er) { $('m1').textContent = er.message; } finally { $('go1').disabled = false; }
});
$('use-rc').addEventListener('click', () => {
  rc = !rc;
  $('code-label').textContent = rc ? 'Recovery code' : '6-digit code';
  $('f2-intro').textContent = rc ? 'One of the recovery codes you saved when you set up 2FA. Each works once.' : 'The 6-digit code from your authenticator app.';
  $('code').className = rc ? '' : 'codeinput'; $('code').inputMode = rc ? 'text' : 'numeric'; $('code').maxLength = rc ? 20 : 7;
  $('code').placeholder = rc ? 'xxxxx-xxxxx' : '000000'; $('code').autocomplete = rc ? 'off' : 'one-time-code';
  $('use-rc').textContent = rc ? 'Use the 6-digit code instead' : 'Use a recovery code instead';
  $('code').value = ''; $('code').focus();
});
$('f2').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('m2').textContent = '';
  if (!$('code').value.trim()) { $('m2').textContent = rc ? 'Enter a recovery code.' : 'Enter the 6-digit code.'; return; }
  $('go2').disabled = true;
  try {
    const r = await api('/api/admin/auth/login/code', { ticket, code: $('code').value.trim(), next, trusted: $('trusted').checked });
    if (r.recovery_left !== null && r.recovery_left !== undefined && r.recovery_left <= 3) {
      try { sessionStorage.setItem('odr_rc_low', String(r.recovery_left)); } catch (er) {}
    }
    go(r.next);
  } catch (er) {
    $('m2').textContent = er.message; $('code').select();
    if (er.data && er.data.restart) { $('f2').classList.add('hidden'); $('f1').classList.remove('hidden'); $('m1').textContent = 'Start again: that took too long.'; $('password').focus(); }
  } finally { if ($('go2')) $('go2').disabled = false; }
});
async function passkey(withTicket) {
  const m = withTicket ? $('m2') : $('m1');
  m.textContent = '';
  try {
    const o = await api('/api/admin/auth/passkey/options', withTicket ? { ticket } : {});
    const response = await passkeyGet(o.options);
    const r = await api('/api/admin/auth/passkey/verify', { id: o.id, response, next, trusted: $('trusted').checked, ticket: withTicket ? ticket : undefined });
    go(r.next);
  } catch (er) { m.textContent = er.name === 'NotAllowedError' ? 'The passkey was cancelled.' : er.message; }
}
$('pk').addEventListener('click', () => passkey(false));
$('pk2').addEventListener('click', () => passkey(true));
</script>
</body></html>`;

// ---------- /admin/setup: the first owner ----------
export const SETUP_PAGE = `${baseHead('First setup', GATE_CSS)}
<body class="gate">
${gateTop('Setup')}
<main>
  <p class="eb">First owner</p>
  <h1><b>Set</b><br><i>up</i></h1>
  <span class="slash" aria-hidden="true"></span>
  <p class="intro" id="intro">No admin accounts yet. Use the admin key (ADMIN_KEY on Render) to create the owner account: yours. You'll set up 2FA before it's done.</p>
  <section class="cp" id="box">
    <form id="f" novalidate>
      <label class="f" for="key">Admin key</label>
      <input id="key" type="password" autocomplete="off" required>
      <label class="f" for="name">Your name</label>
      <input id="name" autocomplete="name" maxlength="60" required>
      <label class="f" for="email">Your email</label>
      <input id="email" type="email" autocomplete="username" inputmode="email" required>
      <label class="f" for="password">Password</label>
      <input id="password" type="password" autocomplete="new-password" minlength="12" required>
      <p class="mono" style="font-size:12px;margin:8px 0 0">At least 12 characters. A passphrase works well.</p>
      <button type="submit" id="go">Next: 2FA</button>
      <p class="msg err" id="m" role="status"></p>
    </form>
  </section>
</main>
${gateFoot}
<script>
${UI_JS}
${ENROLL_JS}
api('/api/admin/auth/state').then((s) => { if (!s.setup_needed) location.replace('/admin/login'); }).catch(() => {});
$('key').focus();
$('f').addEventListener('submit', async (e) => {
  e.preventDefault(); $('m').textContent = '';
  const v = { key: $('key').value, name: $('name').value.trim(), email: $('email').value.trim(), password: $('password').value };
  if (!v.key || !v.name || !v.email || !v.password) { $('m').textContent = 'Fill in every field.'; return; }
  $('go').disabled = true;
  try {
    const p = await api('/api/admin/auth/setup/start', v);
    $('intro').textContent = 'Almost there: 2FA is required for every admin account.';
    enroll($('box'), p, async (code) => {
      const d = await api('/api/admin/auth/setup/finish', { ticket: p.ticket, code });
      $('intro').textContent = "You're the owner. Invite the rest of the team from Team, once you're in.";
      showCodes($('box'), d.recovery_codes, d.next || '/admin', 'Open the Command Center');
    });
  } catch (er) {
    $('m').textContent = er.message;
    if (er.data && er.data.code === 'SETUP_DONE') setTimeout(() => location.replace('/admin/login'), 1500);
  } finally { if ($('go')) $('go').disabled = false; }
});
</script>
</body></html>`;

// ---------- /admin/recover: ADMIN_KEY + the owner's email, then the emailed link ----------
export const RECOVER_PAGE = `${baseHead('Owner recovery', GATE_CSS)}
<body class="gate">
${gateTop('Recovery')}
<main>
  <p class="eb">Owner recovery</p>
  <h1><b>Get</b><br><i>back in</i></h1>
  <span class="slash" aria-hidden="true"></span>
  <p class="intro" id="intro">Lost your password, your phone and your recovery codes? With the admin key (ADMIN_KEY on Render), we email a recovery link to the owner's address.</p>
  <section class="cp" id="box">
    <form id="f" novalidate>
      <label class="f" for="key">Admin key</label>
      <input id="key" type="password" autocomplete="off" required>
      <label class="f" for="email">Owner's email</label>
      <input id="email" type="email" autocomplete="username" inputmode="email" required>
      <button type="submit" id="go">Email me a recovery link</button>
      <p class="msg" id="m" role="status"></p>
    </form>
    <form id="f2" class="hidden" novalidate>
      <h2>Choose a new password</h2>
      <p>This also sets up a new authenticator code, removes your passkeys and signs out every device.</p>
      <label class="f" for="password">New password</label>
      <input id="password" type="password" autocomplete="new-password" minlength="12" required>
      <button type="submit" id="go2">Next: 2FA</button>
      <p class="msg err" id="m2" role="status"></p>
    </form>
  </section>
  <nav class="foot-links"><a href="/admin/login">Back to sign in</a></nav>
</main>
${gateFoot}
<script>
${UI_JS}
${ENROLL_JS}
const token = new URLSearchParams(location.search).get('token');
if (token) { history.replaceState(null, '', '/admin/recover'); $('f').classList.add('hidden'); $('f2').classList.remove('hidden'); $('intro').textContent = 'Set a new password and a new 2FA code for your owner account.'; $('password').focus(); }
else $('key').focus();
$('f').addEventListener('submit', async (e) => {
  e.preventDefault(); const m = $('m'); m.className = 'msg'; m.textContent = '';
  if (!$('key').value || !$('email').value.trim()) { m.className = 'msg err'; m.textContent = 'Enter the key and the email.'; return; }
  $('go').disabled = true;
  try {
    const r = await api('/api/admin/auth/recover/request', { key: $('key').value, email: $('email').value.trim() });
    m.className = 'msg ok'; m.textContent = r.message; $('key').value = '';
  } catch (er) { m.className = 'msg err'; m.textContent = er.message; } finally { if ($('go')) $('go').disabled = false; }
});
$('f2').addEventListener('submit', async (e) => {
  e.preventDefault(); $('m2').textContent = '';
  $('go2').disabled = true;
  try {
    const p = await api('/api/admin/auth/recover/start', { token, password: $('password').value });
    enroll($('box'), p, async (code) => {
      const d = await api('/api/admin/auth/recover/finish', { ticket: p.ticket, code });
      $('intro').textContent = "You're back in. Every other device was signed out.";
      showCodes($('box'), d.recovery_codes, d.next || '/admin', 'Continue');
    });
  } catch (er) { $('m2').textContent = er.message; } finally { if ($('go2')) $('go2').disabled = false; }
});
</script>
</body></html>`;

// ---------- /admin/join: a team invite ----------
export const JOIN_PAGE = `${baseHead('Join the team', GATE_CSS)}
<body class="gate">
${gateTop('Team')}
<main>
  <p class="eb" id="eb">Team invite</p>
  <h1><b>Join</b><br><i>the team</i></h1>
  <span class="slash" aria-hidden="true"></span>
  <p class="intro" id="intro">Checking your invite…</p>
  <section class="cp hidden" id="box">
    <form id="f" novalidate>
      <label class="f" for="email">Email</label>
      <input id="email" type="email" autocomplete="username" readonly>
      <label class="f" for="name">Your name</label>
      <input id="name" autocomplete="name" maxlength="60" required>
      <label class="f" for="password">Password</label>
      <input id="password" type="password" autocomplete="new-password" minlength="12" required>
      <p class="mono" style="font-size:12px;margin:8px 0 0">At least 12 characters. A passphrase works well.</p>
      <button type="submit" id="go">Next: 2FA</button>
      <p class="msg err" id="m" role="status"></p>
    </form>
  </section>
</main>
${gateFoot}
<script>
${UI_JS}
${ENROLL_JS}
const token = new URLSearchParams(location.search).get('token') || '';
api('/api/admin/auth/join/info?token=' + encodeURIComponent(token)).then((i) => {
  $('intro').textContent = "You're invited as " + i.role_name.toLowerCase() + '. Choose a password, then set up 2FA.';
  $('eb').textContent = 'Team invite · ' + i.role_name;
  $('email').value = i.email; $('name').value = i.name || '';
  $('box').classList.remove('hidden'); (i.name ? $('password') : $('name')).focus();
}).catch((er) => { $('intro').textContent = er.message; });
$('f').addEventListener('submit', async (e) => {
  e.preventDefault(); $('m').textContent = ''; $('go').disabled = true;
  try {
    const p = await api('/api/admin/auth/join/start', { token, name: $('name').value.trim(), password: $('password').value });
    enroll($('box'), p, async (code) => {
      const d = await api('/api/admin/auth/join/finish', { ticket: p.ticket, code });
      $('intro').textContent = "You're on the team.";
      showCodes($('box'), d.recovery_codes, d.next || '/admin', 'Continue');
    });
  } catch (er) { $('m').textContent = er.message; } finally { if ($('go')) $('go').disabled = false; }
});
</script>
</body></html>`;

// ---------- /admin/account ----------
const ACCOUNT_CSS = `
.who { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin: 10px 0 0; color: var(--muted); }
.grid2 { display: grid; gap: 0 18px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
#enroll-box { margin-top: 16px; }
#enroll-box.cp { padding: 20px; }
.cp { background: var(--concrete-2); color: var(--ink); border-top: 3px solid var(--accent); }
.cp h2 { color: var(--ink); } .cp p, .cp li { color: var(--ink-2); } .cp label.f { color: var(--ink-2); }
.cp input { color: var(--ink); background: #f4f3ef; border-color: rgba(20, 20, 22, .42); }
.cp button.ghost { color: var(--ink); border-color: rgba(20, 20, 22, .42); }
.cp .msg.err { color: #9b1c12; }
.cp a { color: var(--ink); display: inline-flex; align-items: center; min-height: 44px; }
.cp .qr { margin: 4px 0 14px; padding: 10px; border: 1px solid rgba(20, 20, 22, .2); }
.cp .qr img { width: 200px; height: 200px; display: block; image-rendering: pixelated; }
.cp .codeinput { font: 700 24px/1 var(--mono); letter-spacing: .3em; text-align: center; max-width: 260px; }
.cp .secret { color: var(--ink); font-size: 14px; }
.cp ol.steps { padding-left: 20px; }
.cp form button[type=submit], #codes-done { margin-top: 16px; }
.cur { color: var(--good); font: 700 10.5px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; }
`;
export const ACCOUNT_PAGE = `${baseHead('Your account', ACCOUNT_CSS)}
<body>
${topBar('Account')}
<main class="wrap">
  <h1>Your account</h1>
  <div class="who"><b id="me-name"></b><span id="me-email" class="mono"></span><span id="me-role" class="pill"></span></div>
  <p class="lead">Your password, your two-step codes, your passkeys and where you're signed in.</p>

  <section class="card" id="pw-card">
    <h2>Password</h2>
    <p>Changing it signs out your other devices.</p>
    <form id="pw-form" novalidate>
      <input type="text" autocomplete="username" id="pw-user" class="hidden" aria-hidden="true" tabindex="-1">
      <div class="grid2">
        <div><label class="f" for="pw-cur">Current password</label><input id="pw-cur" type="password" autocomplete="current-password"></div>
        <div><label class="f" for="pw-new">New password</label><input id="pw-new" type="password" autocomplete="new-password" minlength="12"></div>
      </div>
      <div class="row"><button type="submit" id="pw-go">Change password</button></div>
      <p class="msg" id="pw-m" role="status"></p>
    </form>
  </section>

  <section class="card" id="tfa-card">
    <h2>Two-step codes</h2>
    <p id="tfa-state">Loading…</p>
    <div class="row">
      <button class="ghost" type="button" id="tfa-new">Move to a new phone</button>
      <button class="ghost" type="button" id="rc-new">New recovery codes</button>
    </div>
    <div id="enroll-box" class="hidden"></div>
  </section>

  <section class="card" id="pk-card">
    <h2>Passkeys</h2>
    <p id="pk-intro">Sign in with Face ID or a fingerprint instead of a password and code.</p>
    <ul class="list" id="pk-list"></ul>
    <div class="row"><button class="ghost" type="button" id="pk-add">Add a passkey on this device</button></div>
  </section>

  <section class="card" id="sessions">
    <h2>Where you're signed in</h2>
    <p>Signed out after 2 idle hours (12 on a trusted installed app; door accounts 14), and after 7 days at most.</p>
    <ul class="list" id="s-list"></ul>
    <div class="row"><button class="danger" type="button" id="s-all">Log out everywhere</button><a class="btn ghost" href="/admin/app#alerts" id="push-link">Notifications on this phone</a></div>
  </section>
</main>
${DIALOG_HTML}
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>
${UI_JS}
${ENROLL_JS}
let me = null;
async function loadMe() {
  me = await api('/api/admin/auth/me');
  $('me-name').textContent = me.user.name; $('me-email').textContent = me.user.email; $('me-role').textContent = me.user.role_name || me.user.role;
  $('pw-user').value = me.user.email;
  $('tfa-state').textContent = me.totp ? 'On. ' + me.recovery_left + ' of 10 recovery codes left.' + (me.recovery_left <= 3 ? ' Make new ones soon.' : '') : 'Off.';
  if (me.user.role === 'DOOR') $('push-link').classList.add('hidden');
}
async function loadSessions() {
  const d = await api('/api/admin/auth/account/sessions');
  const ul = $('s-list'); ul.replaceChildren();
  d.sessions.forEach((s) => {
    const li = el('li'); const g = el('div', undefined, 'grow');
    const b = el('b', s.device || 'Unknown device'); if (s.current) { b.appendChild(document.createTextNode(' ')); b.appendChild(el('span', 'This device', 'cur')); }
    g.appendChild(b);
    g.appendChild(el('small', 'Signed in ' + when(s.created_at) + ' · last seen ' + when(s.last_seen_at) + (s.ip ? ' · IP ' + String(s.ip).replace('::ffff:', '') : '') + (s.trusted ? ' · trusted app' : '')));
    li.appendChild(g);
    const x = el('button', 'Log out', 'small ghost'); x.type = 'button';
    x.onclick = async () => {
      const v = await ask('Log out ' + (s.current ? 'this device' : (s.device || 'that device')) + '?', s.current ? 'You will need to sign in again here.' : 'It will need to sign in again.', 'Log out', { danger: true });
      if (!v) return;
      try { const r = await api('/api/admin/auth/account/sessions/' + s.id + '/revoke', {}); if (r.current) return location.replace('/admin/login'); toast('Logged out.'); loadSessions(); } catch (er) { toast(er.message, true); }
    };
    li.appendChild(x); ul.appendChild(li);
  });
}
async function loadPasskeys() {
  const d = await api('/api/admin/auth/account/passkeys');
  const ok = d.available && passkeysOk();
  $('pk-add').classList.toggle('hidden', !ok);
  if (!d.available) $('pk-intro').textContent = "Passkeys aren't available on this server.";
  else if (!passkeysOk()) $('pk-intro').textContent = "This browser can't use passkeys. Your password and code still work.";
  const ul = $('pk-list'); ul.replaceChildren();
  if (!d.passkeys.length) ul.appendChild(el('li', 'No passkeys yet.'));
  d.passkeys.forEach((k) => {
    const li = el('li'); const g = el('div', undefined, 'grow');
    g.appendChild(el('b', k.name)); g.appendChild(el('small', 'Added ' + when(k.created_at) + (k.last_used_at ? ' · last used ' + when(k.last_used_at) : ' · not used yet')));
    li.appendChild(g);
    const x = el('button', 'Remove', 'small ghost'); x.type = 'button';
    x.onclick = async () => { const v = await ask('Remove ' + k.name + '?', 'It will no longer sign you in.', 'Remove', { danger: true }); if (!v) return; try { await api('/api/admin/auth/account/passkeys/' + k.id + '/delete', {}); toast('Passkey removed.'); loadPasskeys(); } catch (er) { toast(er.message, true); } };
    li.appendChild(x); ul.appendChild(li);
  });
}
$('pw-form').addEventListener('submit', async (e) => {
  e.preventDefault(); const m = $('pw-m'); m.className = 'msg'; m.textContent = '';
  $('pw-go').disabled = true;
  try {
    const r = await api('/api/admin/auth/account/password', { current: $('pw-cur').value, password: $('pw-new').value });
    m.className = 'msg ok'; m.textContent = 'Password changed.' + (r.other_sessions_ended ? ' ' + r.other_sessions_ended + ' other ' + (r.other_sessions_ended === 1 ? 'device was' : 'devices were') + ' signed out.' : '');
    $('pw-cur').value = ''; $('pw-new').value = ''; loadSessions();
  } catch (er) { m.className = 'msg err'; m.textContent = er.message; } finally { $('pw-go').disabled = false; }
});
$('tfa-new').addEventListener('click', async () => {
  const v = await ask('Move to a new phone?', 'Your old code app stops working once the new one is set up. You get new recovery codes too.', 'Continue', { fields: [{ name: 'current', label: 'Your password', type: 'password', autocomplete: 'current-password' }] });
  if (!v) return;
  try {
    const p = await api('/api/admin/auth/account/2fa/start', { current: v.current });
    const box = $('enroll-box'); box.className = 'cp';
    enroll(box, p, async (code) => {
      const d = await api('/api/admin/auth/account/2fa/finish', { ticket: p.ticket, code });
      showCodes(box, d.recovery_codes, '/admin/account', 'Done');
      loadMe();
    });
  } catch (er) { toast(er.message, true); }
});
$('rc-new').addEventListener('click', async () => {
  const v = await ask('Make new recovery codes?', 'The old ones stop working.', 'Make new codes', { fields: [{ name: 'current', label: 'Your password', type: 'password', autocomplete: 'current-password' }] });
  if (!v) return;
  try {
    const d = await api('/api/admin/auth/account/recovery-codes', { current: v.current });
    const box = $('enroll-box'); box.className = 'cp';
    showCodes(box, d.recovery_codes, '/admin/account', 'Done'); loadMe();
  } catch (er) { toast(er.message, true); }
});
$('pk-add').addEventListener('click', async () => {
  try {
    const o = await api('/api/admin/auth/account/passkeys/options', {});
    const response = await passkeyCreate(o.options);
    await api('/api/admin/auth/account/passkeys/verify', { response });
    toast('Passkey added.'); loadPasskeys();
  } catch (er) { toast(er.name === 'NotAllowedError' ? 'The passkey was cancelled.' : er.message, true); }
});
async function logoutAll() {
  const v = await ask('Log out everywhere?', 'Every device signed in to your account is signed out, this one too. Then change your password if someone else got in.', 'Log out everywhere', { danger: true });
  if (!v) return;
  try { await api('/api/admin/auth/logout-all', {}); location.replace('/admin/login'); } catch (er) { toast(er.message, true); }
}
$('s-all').addEventListener('click', logoutAll);
Promise.all([loadMe(), loadSessions(), loadPasskeys()]).then(() => {
  if (new URLSearchParams(location.search).get('logout-all') === '1') { history.replaceState(null, '', '/admin/account#sessions'); $('sessions').scrollIntoView(); logoutAll(); }
}).catch((er) => toast(er.message, true));
</script>
</body></html>`;

// ---------- /admin/team (OWNER) ----------
const TEAM_CSS = `
.invite { display: grid; gap: 10px; grid-template-columns: minmax(0, 2fr) minmax(0, 1.4fr) minmax(0, 1fr) auto; align-items: end; }
.invite label.f { margin-top: 0; }
@media (max-width: 720px) { .invite { grid-template-columns: 1fr; } }
.people .acts { display: flex; flex-wrap: wrap; gap: 8px; }
.people select { width: auto; min-height: 36px; padding: 6px 36px 6px 10px; font-size: 14px; }
.roles { margin: 0; padding: 0; list-style: none; }
.roles li { padding: 8px 0; border-bottom: 1px solid var(--line); color: var(--muted); }
.roles b { color: var(--text); }
.link-out { margin-top: 12px; padding: 12px; background: var(--well); border: 1px solid var(--line); font: 400 12.5px/1.5 var(--mono); overflow-wrap: anywhere; color: var(--muted); }
`;
export const TEAM_PAGE = `${baseHead('Team', TEAM_CSS)}
<body>
${topBar('Team')}
<main class="wrap">
  <h1>Team</h1>
  <p class="lead">Everyone with an admin login: their role, 2FA and last sign-in. Invite people by email; the link works once, for 48 hours.</p>
  <section class="card">
    <h2>Invite someone</h2>
    <form class="invite" id="inv" novalidate>
      <div><label class="f" for="i-email">Email</label><input id="i-email" type="email" autocomplete="off" required></div>
      <div><label class="f" for="i-name">Name</label><input id="i-name" autocomplete="off" maxlength="60"></div>
      <div><label class="f" for="i-role">Role</label><select id="i-role"><option value="ADMIN">Admin</option><option value="DOOR">Door</option><option value="OWNER">Owner</option></select></div>
      <button type="submit" id="i-go">Send invite</button>
    </form>
    <p class="msg" id="i-m" role="status"></p>
    <div class="link-out hidden" id="i-link"></div>
  </section>
  <section class="card" id="pending-card">
    <h2>Invites waiting</h2>
    <ul class="list" id="pending"></ul>
  </section>
  <section class="card people">
    <h2>People</h2>
    <ul class="list" id="people"></ul>
  </section>
  <section class="card">
    <h2>Roles</h2>
    <ul class="roles">
      <li><b>Owner</b>: everything, including the team, Reset and the site locks.</li>
      <li><b>Admin</b>: everything except the team and Reset (and switching the locks).</li>
      <li><b>Door</b>: only the door scanner and package pickup.</li>
    </ul>
  </section>
</main>
${DIALOG_HTML}
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>
${UI_JS}
const ROLE = { OWNER: 'Owner', ADMIN: 'Admin', DOOR: 'Door' };
async function load() {
  const d = await api('/api/admin/team');
  const pend = $('pending'); pend.replaceChildren();
  $('pending-card').classList.toggle('hidden', !d.invites.length);
  d.invites.forEach((i) => {
    const li = el('li'); const g = el('div', undefined, 'grow');
    g.appendChild(el('b', (i.name ? i.name + ' · ' : '') + i.email));
    g.appendChild(el('small', ROLE[i.role] + ' · sent ' + when(i.created_at) + (i.created_by_name ? ' by ' + i.created_by_name : '') + ' · expires ' + when(i.expires_at)));
    li.appendChild(g);
    const x = el('button', 'Cancel', 'small ghost'); x.type = 'button';
    x.onclick = async () => { const v = await ask('Cancel the invite to ' + i.email + '?', 'The link stops working.', 'Cancel invite', { danger: true }); if (!v) return; try { await api('/api/admin/team/invites/' + i.id + '/revoke', {}); toast('Invite cancelled.'); load(); } catch (er) { toast(er.message, true); } };
    li.appendChild(x); pend.appendChild(li);
  });
  const ul = $('people'); ul.replaceChildren();
  d.users.forEach((u) => {
    const li = el('li'); li.dataset.id = u.id; const g = el('div', undefined, 'grow');
    const b = el('b', u.name + (u.id === d.me ? ' (you)' : '')); g.appendChild(b);
    g.appendChild(el('small', u.email));
    const locked = u.locked_until && new Date(u.locked_until) > new Date();
    g.appendChild(el('small', (u.last_login_at ? 'Last sign-in ' + when(u.last_login_at) : 'Never signed in') + ' · ' + u.sessions + (u.sessions === 1 ? ' session' : ' sessions') + (u.passkeys ? ' · ' + u.passkeys + ' passkey' + (u.passkeys === 1 ? '' : 's') : '')));
    li.appendChild(g);
    const tags = el('div', undefined, 'acts');
    tags.appendChild(el('span', u.active ? 'Active' : 'Off', 'pill ' + (u.active ? 'ok' : '')));
    tags.appendChild(el('span', u.totp_enabled ? '2FA on' : '2FA to set up', 'pill ' + (u.totp_enabled ? 'ok' : 'warn')));
    if (locked) tags.appendChild(el('span', 'Locked until ' + when(u.locked_until), 'pill bad'));
    li.appendChild(tags);
    if (u.id !== d.me) {
      const acts = el('div', undefined, 'acts');
      const sel = el('select'); sel.setAttribute('aria-label', 'Role of ' + u.name);
      ['OWNER', 'ADMIN', 'DOOR'].forEach((r) => { const o = el('option', ROLE[r]); o.value = r; sel.appendChild(o); }); sel.value = u.role;
      sel.onchange = async () => {
        const to = sel.value; sel.value = u.role;
        const v = await ask('Make ' + u.name + ' ' + ROLE[to].toLowerCase() + '?', 'They are signed out and get the new role when they sign in again.', 'Change role');
        if (!v) return;
        try { await api('/api/admin/team/' + u.id, { role: to }); toast(u.name + ' is now ' + ROLE[to].toLowerCase() + '.'); load(); } catch (er) { toast(er.message, true); }
      };
      acts.appendChild(sel);
      const r2 = el('button', 'Reset 2FA', 'small ghost'); r2.type = 'button';
      r2.onclick = async () => { const v = await ask('Reset 2FA for ' + u.name + '?', 'Their code app, recovery codes and passkeys stop working and they are signed out. They set 2FA up again at their next sign-in, with their password.', 'Reset 2FA', { danger: true }); if (!v) return; try { await api('/api/admin/team/' + u.id + '/reset-2fa', {}); toast('2FA reset for ' + u.name + '.'); load(); } catch (er) { toast(er.message, true); } };
      acts.appendChild(r2);
      if (locked) { const ul2 = el('button', 'Unlock', 'small ghost'); ul2.type = 'button'; ul2.onclick = async () => { try { await api('/api/admin/team/' + u.id + '/unlock', {}); toast('Unlocked.'); load(); } catch (er) { toast(er.message, true); } }; acts.appendChild(ul2); }
      const off = el('button', u.active ? 'Switch off' : 'Switch on', 'small ' + (u.active ? 'danger' : 'ghost')); off.type = 'button';
      off.onclick = async () => {
        const v = await ask((u.active ? 'Switch off ' : 'Switch on ') + u.name + '?', u.active ? 'They are signed out everywhere and can’t sign in. Their history stays in the audit log.' : 'They can sign in again with their password and code.', u.active ? 'Switch off' : 'Switch on', { danger: u.active });
        if (!v) return;
        try { await api('/api/admin/team/' + u.id, { active: !u.active }); toast(u.name + (u.active ? ' is switched off.' : ' is switched on.')); load(); } catch (er) { toast(er.message, true); }
      };
      acts.appendChild(off);
      li.appendChild(acts);
    } else {
      const acts = el('div', undefined, 'acts'); acts.appendChild(el('span', ROLE[u.role], 'pill')); const a = el('a', 'Your account', 'btn small ghost'); a.href = '/admin/account'; acts.appendChild(a); li.appendChild(acts);
    }
    ul.appendChild(li);
  });
}
$('inv').addEventListener('submit', async (e) => {
  e.preventDefault(); const m = $('i-m'); m.className = 'msg'; m.textContent = ''; $('i-link').classList.add('hidden');
  if (!$('i-email').value.trim()) { m.className = 'msg err'; m.textContent = 'Enter their email.'; return; }
  $('i-go').disabled = true;
  try {
    const r = await api('/api/admin/team/invite', { email: $('i-email').value.trim(), name: $('i-name').value.trim(), role: $('i-role').value });
    m.className = 'msg ok'; m.textContent = r.emailed ? 'Invite sent. It works for 48 hours.' : "The email didn't send. Copy the link below and send it to them yourself.";
    if (!r.emailed) { $('i-link').textContent = r.link; $('i-link').classList.remove('hidden'); }
    $('i-email').value = ''; $('i-name').value = ''; load();
  } catch (er) { m.className = 'msg err'; m.textContent = er.message; } finally { $('i-go').disabled = false; }
});
load().catch((er) => toast(er.message, true));
</script>
</body></html>`;

// ---------- 403 for a page the role can't open ----------
export function forbiddenPage(admin) {
  const door = admin.role === 'DOOR';
  return `${baseHead('Not for your role', GATE_CSS)}
<body class="gate">
${gateTop(door ? 'Door' : 'Admin')}
<main>
  <p class="eb">${door ? 'Door crew' : 'Admin'}</p>
  <h1><b>Not</b><br><i>for you</i></h1>
  <span class="slash" aria-hidden="true"></span>
  <p class="intro">${door ? 'Door accounts can use the scanner and package pickup.' : 'This page is for the owner. Ask them if you need it.'}</p>
  <section class="cp">
    <a class="btn" href="${door ? '/door' : '/admin'}" style="width:100%">${door ? 'Open the scanner' : 'Back to the Command Center'}</a>
    ${door ? '<a class="btn ghost" href="/admin/pickup" style="width:100%;margin-top:12px">Package pickup</a>' : ''}
  </section>
</main>
${gateFoot}
</body></html>`;
}
