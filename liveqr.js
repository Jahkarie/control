// liveqr.js: the live, rotating QR codes on passes (the invite-only site) and tickets (the ticket site).
// Each pass or ticket has a secret: HMAC-SHA256(TOKEN_SECRET, 'qr:' + ref + ':' + version), base64url. version bumps when
// a ticket is re-issued (a transfer gives a new ref and version), so the old secret, link and QR all stop working.
// The guest's page turns the secret into a code that changes every 30 seconds:
//   code = base32(HMAC-SHA256(secret bytes, String(floor(unix seconds / 30))))[0..8]
// and shows the QR "ONDROAD:<ref>:<code>" (passes) or "ONDROAD-T:<ref>:<code>" (tickets). The door accepts the step it is
// in, plus or minus 2 (clock skew), so a screenshot stops working after about 90 seconds. Door phones carry the secrets
// in their saved list (behind DOOR_KEY), so they check codes offline too; the same maths runs in the browser with
// WebCrypto (see BROWSER_CODE, used by the door page).
import crypto from 'crypto';

export const STEP_MS = 30 * 1000;
export const WINDOW = 2;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const qrSecret = (tokenSecret, ref, version = 1) =>
  crypto.createHmac('sha256', tokenSecret).update(`qr:${ref}:${version}`).digest('base64url');

// The first 5 bytes as 8 base32 characters.
function base32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    if (out.length >= 8) break;
  }
  return out.slice(0, 8);
}

export const stepOf = (ms = Date.now()) => Math.floor(ms / STEP_MS);
export const qrCode = (secret, step) =>
  base32(crypto.createHmac('sha256', Buffer.from(secret, 'base64url')).update(String(step)).digest().subarray(0, 5));

// Whether code is right for any step within WINDOW of the given times (the scan time and, for an online scan, now).
export function codeOk(secret, code, ...times) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z2-7]{8}$/.test(c) || !secret) return false;
  const steps = new Set();
  for (const t of times.filter((x) => Number.isFinite(x))) for (let d = -WINDOW; d <= WINDOW; d++) steps.add(stepOf(t) + d);
  let ok = false;
  for (const s of steps) if (crypto.timingSafeEqual(Buffer.from(qrCode(secret, s)), Buffer.from(c))) ok = true;
  return ok;
}

// The same code in a browser (WebCrypto). Pages paste this in; it defines liveCode(secret, step) -> Promise<string>.
// Plain ES5 apart from the promises, no regexes with backslashes (it sits inside template literals on the server).
export const BROWSER_CODE = `
var B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', QR_STEP = 30000, keyCache = {};
function b64urlBytes(s) {
  s = String(s).split('-').join('+').split('_').join('/');
  while (s.length % 4) s += '=';
  var bin = atob(s), out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function liveKey(secret) {
  if (!keyCache[secret]) keyCache[secret] = crypto.subtle.importKey('raw', b64urlBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return keyCache[secret];
}
function liveCode(secret, step) {
  return liveKey(secret).then(function (k) { return crypto.subtle.sign('HMAC', k, new TextEncoder().encode(String(step))); }).then(function (sig) {
    var bytes = new Uint8Array(sig), bits = 0, value = 0, out = '';
    for (var i = 0; i < 5; i++) { value = (value << 8) | bytes[i]; bits += 8; while (bits >= 5) { out += B32.charAt((value >>> (bits - 5)) & 31); bits -= 5; } }
    return out;
  });
}
function liveCheck(secret, code, at) {
  if (!secret || !code || !window.crypto || !crypto.subtle) return Promise.resolve(false);
  var base = Math.floor(at / QR_STEP), tries = [];
  for (var d = -2; d <= 2; d++) tries.push(liveCode(secret, base + d));
  return Promise.all(tries).then(function (list) { return list.indexOf(String(code).toUpperCase()) >= 0; }, function () { return false; });
}
`;
