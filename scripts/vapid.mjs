// Prints a new VAPID key pair for the admin app's push notifications (adminapp.js). Run it once on your own computer:
//   node scripts/vapid.mjs
// then add the two keys to Render (Environment) as VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, and VAPID_SUBJECT as
// mailto:<ADMIN_EMAIL>. Keep the private key secret. Changing the keys later means every phone has to turn
// notifications on again. Needs nothing installed: it uses Node's own crypto (P-256, as web-push does).
import crypto from 'crypto';

const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();
const b64url = (b) => Buffer.from(b).toString('base64url');
console.log('VAPID_PUBLIC_KEY=' + b64url(ecdh.getPublicKey()));
const priv = ecdh.getPrivateKey(); // 32 bytes, padded in front if it came out shorter
console.log('VAPID_PRIVATE_KEY=' + b64url(Buffer.concat([Buffer.alloc(32 - priv.length), priv])));
console.log('VAPID_SUBJECT=mailto:you@example.com   (use ADMIN_EMAIL)');
