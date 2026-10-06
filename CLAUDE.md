# On D' Road: backend (`control`)

On D' Road is an invite-only, 18+ Antigua Carnival band. Guests join through an invite chain, reserve a package, pay, and get a QR entry pass. This repo is the API, the admin pages and the door scanner. The guest site is a separate repo, `controlfrontend` (a single `index.html`).

## Stack

- Node (ES modules) + Express 4, Postgres on Aiven (`pg`), email via Resend.
- Hosted on Render at `https://control-1-0baa.onrender.com`.
- No build step, no tests. Run with `npm start`.

## Files

- `server.js`: config, auth, schema setup, guest/invite/package/order routes, admin API, and the Command Center admin page at `/admin` (HTML inlined as `ADMIN_PAGE`).
- `payments.js`: payment settings (`payment_instructions`, `pay_days`), the pay-by deadline, a job every 10 minutes that expires unpaid orders and sends one reminder, `/api/my-order`, and the `/admin/payments` page. It is registered before the routes in `server.js`, so its `/api/my-order` wins and the one in `server.js` is an unused fallback.
- `event.js`: event details guests see in their account (`/api/event`), emails to groups of guests through Resend's batch API, and the `/admin/event` page ("Event & messages").
- `site.js`: contact details and terms (`/api/site`, public), the `/admin/site` page ("Contact & terms"), and `DEFAULT_TERMS`, the draft guests see until the organizers save their own.
- `door.js`: staff scanner at `/door` (works offline through a service worker), `/api/door/list|checkin|sync`, and the door log at `/api/admin/checkins`.
- `emails.js`: `renderEmail()` builds every email (HTML + plain text). Its footer lists the contact details set through `setContact()` (called by `site.js` on boot and after each save).

## How it works

- **Invites:** each guest gets 2 (`guests.invites_left`). Sending one creates a single-use link (`?invite=<token>`) tied to the recipient's email; only the token's hash is stored. Admin invites (`inviter_email = 'CONTROL'`) don't use anyone's allowance. Revoking a pending invite gives it back.
- **Login:** passwordless. `/api/login` emails a one-time link (`?login=<code>`, 15 minutes). `/api/login/verify` exchanges it for an HMAC-signed token valid for 7 days. The frontend sends `Authorization: Bearer <token>`.
- **Admin auth:** `ADMIN_KEY` via the `x-admin-key` header or HTTP Basic (password = key). Door staff use `DOOR_KEY` (the admin key also works) via `x-door-key`.
- **Orders:** one active order per guest. `RESERVED` → `PAID` (admin marks paid; payment is manual/cash) or `CANCELLED` (guest cancels, admin cancels, deadline expires, or a refund is approved). Paid guests can request a refund and withdraw the request; the pass keeps working until the admin approves. References look like `ODR-1A2B3C4D`.
- **Packages:** price in cents, currency `XCD` or `USD`, optional capacity. `active = false` hides a package ("Visible/Hidden" in admin). `requires_compliance` means the costume rules apply.
- **18+:** accepting an invite requires `adult: true` (a checkbox on the guest site). Guests who joined before that, or were added by the admin, confirm once when they reserve: `/api/orders` answers `400` with `code: 'AGE_REQUIRED'` until they send `adult: true`. Stored in `guests.age_confirmed_at`. Guests who already had an order before this check were never asked.
- **Event details:** stored in `settings` as `event_when`, `event_info` (every logged-in guest) and `event_paid_info` (only returned once the guest's order is `PAID`).
- **Group emails:** to paid guests, reserved-but-unpaid guests, or everyone on the roster, sent in batches of 100 with a short pause between batches. Each send is logged in `broadcasts`. Test sends aren't logged.
- **Contact details:** `settings` keys `contact_whatsapp` (digits with country code; Antigua numbers can be typed without it), `contact_instagram` (username) and `contact_email`. Shown in the guest site's footer and at the bottom of every email.
- **Terms:** `settings.terms` (falls back to `DEFAULT_TERMS`) and `terms_updated_at`. In the text, `# ` starts a heading and `- ` a bullet point. `/api/orders` requires `terms: true` (`code: 'TERMS_REQUIRED'`) and stores `orders.terms_accepted_at`.
- **Sizes:** `packages.sizes` is a comma-separated list; empty means no size is needed. When it's set, `/api/orders` requires one of them (`code: 'SIZE_REQUIRED'`) and stores it in `orders.size`. Guests change it with `/api/orders/size`. The admin packages list shows how many active orders picked each size. (`guests.shirt_size` and `/api/update-shirt` are old and unused.)
- **Door:** the guest's QR code encodes `ONDROAD:<reference>:<email>`. Only one phone can record the first entry; repeat scans are logged as `DUPLICATE`.
- Times shown to guests use the `America/Antigua` time zone.

## Database

`ensureSchema()` in `server.js` creates and migrates `packages`, `orders`, `settings`, `checkins` and `broadcasts` on every boot, and adds `guests.age_confirmed_at`, `packages.sizes`, `orders.size` and `orders.terms_accepted_at`. Add new columns there with `ADD COLUMN IF NOT EXISTS`. `guests`, `invites` and `login_links` are **not** created by code; they already exist in Aiven.

## Environment variables

- Required: `TOKEN_SECRET`, `ADMIN_KEY`.
- Database: `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_PORT`, `DB_CA` (optional; enables full TLS verification).
- Email: `RESEND_API_KEY` (or `EMAIL_PASS`), `EMAIL_FROM`.
- Optional: `FRONTEND_URL`, `EXTRA_ORIGINS` (comma-separated), `ADMIN_EMAIL` (gets refund requests), `DOOR_KEY`, `PORT`.

## Conventions

- All SQL is parameterized. Multi-step writes use `pool.connect()` + `BEGIN`/`COMMIT`/`ROLLBACK`.
- Email helpers return an error or `null` and never throw. Guest emails are often sent after the response.
- Rate limiting is in memory, per IP: `rateLimit(max, windowMs)`.
- `express.json({ limit: '10kb' })` applies to every route registered after it. Routes that need bigger bodies (door sync, terms) are registered before it with their own parser.
- Errors are `{ error: '<short plain message>' }`. Guest-facing text is plain, friendly and short.
- Admin and door pages are HTML strings inside the JS files, with no framework.
- CORS allows `FRONTEND_URL`, `https://ondroad.xyz`, `https://www.ondroad.xyz` and `EXTRA_ORIGINS`.
- The frontend and backend deploy separately. When a backend change needs a frontend change, deploy the frontend first.

## Known issues (review of 2026-10-06)

1. Removing a guest leaves their orders active, so a paid pass still scans at the door. (A removed guest can no longer reserve, and the guest site logs them out.)
2. The expiry job uses the *current* `pay_days` for every order, so shortening it cancels older reservations right away.
3. `/api/update-rsvp` accepts any string up to 20 characters.
4. Package edits: a bad price silently becomes 0; a bad capacity causes a 500.
5. No README, `.env.example` or tests.
6. Reservations are limited to 10 per hour per IP address. Guests on shared mobile-data IPs could hit that when sales open.

One active order per guest is enforced by locking the guest's row in `/api/orders`, so two quick reservations can't both go through.

## Not built yet

- Package/costume pickup tracking (sizes are collected per order; only entry is tracked).
- An FAQ section.
- The QR pass in the "You're confirmed" email (today it's only in the guest's account).
- CSV export of orders (the Command Center's guest export includes each guest's latest package and size).
- A record of which admin marked an order paid (everyone shares one admin key).
- Waitlist for sold-out packages; transferring a pass.
