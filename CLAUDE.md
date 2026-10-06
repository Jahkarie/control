# On D' Road: backend (`control`)

On D' Road is an invite-only, 18+ Antigua Carnival band. Guests join through an invite chain, reserve a package, pay, and get a QR entry pass. This repo is the API, the admin pages and the door scanner. The guest site is a separate repo, `controlfrontend` (a single `index.html`).

## Stack

- Node (ES modules) + Express 4, Postgres on Aiven (`pg`), email via Resend.
- Hosted on Render at `https://control-1-0baa.onrender.com`.
- No build step, no tests. Run with `npm start`.

## Files

- `server.js`: config, auth, schema setup, guest/invite/package/order routes, admin API, and the Command Center admin page at `/admin` (HTML inlined as `ADMIN_PAGE`).
- `payments.js`: payment settings (`payment_instructions`, `pay_days`), the pay-by deadline, a job every 10 minutes that expires unpaid orders and sends one reminder, `/api/my-order`, and the `/admin/payments` page. It is registered before the routes in `server.js`, so its `/api/my-order` wins and the one in `server.js` is an unused fallback.
- `door.js`: staff scanner at `/door` (works offline through a service worker), `/api/door/list|checkin|sync`, and the door log at `/api/admin/checkins`.
- `emails.js`: `renderEmail()` builds every email (HTML + plain text).

## How it works

- **Invites:** each guest gets 2 (`guests.invites_left`). Sending one creates a single-use link (`?invite=<token>`) tied to the recipient's email; only the token's hash is stored. Admin invites (`inviter_email = 'CONTROL'`) don't use anyone's allowance. Revoking a pending invite gives it back.
- **Login:** passwordless. `/api/login` emails a one-time link (`?login=<code>`, 15 minutes). `/api/login/verify` exchanges it for an HMAC-signed token valid for 7 days. The frontend sends `Authorization: Bearer <token>`.
- **Admin auth:** `ADMIN_KEY` via the `x-admin-key` header or HTTP Basic (password = key). Door staff use `DOOR_KEY` (the admin key also works) via `x-door-key`.
- **Orders:** one active order per guest. `RESERVED` → `PAID` (admin marks paid; payment is manual/cash) or `CANCELLED` (guest cancels, admin cancels, deadline expires, or a refund is approved). Paid guests can request a refund and withdraw the request; the pass keeps working until the admin approves. References look like `ODR-1A2B3C4D`.
- **Packages:** price in cents, currency `XCD` or `USD`, optional capacity. `active = false` hides a package ("Visible/Hidden" in admin). `requires_compliance` means the costume rules apply.
- **Door:** the guest's QR code encodes `ONDROAD:<reference>:<email>`. Only one phone can record the first entry; repeat scans are logged as `DUPLICATE`.
- Times shown to guests use the `America/Antigua` time zone.

## Database

`ensureSchema()` in `server.js` creates and migrates `packages`, `orders`, `settings` and `checkins` on every boot. Add new columns there with `ADD COLUMN IF NOT EXISTS`. `guests`, `invites` and `login_links` are **not** created by code; they already exist in Aiven.

## Environment variables

- Required: `TOKEN_SECRET`, `ADMIN_KEY`.
- Database: `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_PORT`, `DB_CA` (optional; enables full TLS verification).
- Email: `RESEND_API_KEY` (or `EMAIL_PASS`), `EMAIL_FROM`.
- Optional: `FRONTEND_URL`, `EXTRA_ORIGINS` (comma-separated), `ADMIN_EMAIL` (gets refund requests), `DOOR_KEY`, `PORT`.

## Conventions

- All SQL is parameterized. Multi-step writes use `pool.connect()` + `BEGIN`/`COMMIT`/`ROLLBACK`.
- Email helpers return an error or `null` and never throw. Guest emails are often sent after the response.
- Rate limiting is in memory, per IP: `rateLimit(max, windowMs)`.
- Errors are `{ error: '<short plain message>' }`. Guest-facing text is plain, friendly and short.
- Admin and door pages are HTML strings inside the JS files, with no framework.
- CORS allows `FRONTEND_URL`, `https://ondroad.xyz`, `https://www.ondroad.xyz` and `EXTRA_ORIGINS`.

## Known issues (review of 2026-10-06)

1. Removing a guest doesn't end their session (tokens last 7 days) and leaves their orders active. `/api/orders` doesn't check the guest still exists.
2. The expiry job uses the *current* `pay_days` for every order, so shortening it cancels older reservations right away.
3. Nothing in the database enforces one active order per guest; two quick requests for different packages can both succeed.
4. `/api/update-rsvp` accepts any string up to 20 characters.
5. Package edits: a bad price silently becomes 0; a bad capacity causes a 500.
6. No README, `.env.example` or tests.

## Not built yet

- Event info (date, meetup spot, schedule) and a way to email all paid guests. The "you're confirmed" email promises details later.
- An 18+ confirmation when accepting an invite (the site says 18+ but never asks).
- Package/shirt pickup tracking (shirt sizes are collected, only entry is tracked).
- CSV export of guests and orders.
- A record of which admin marked an order paid (everyone shares one admin key).
- Waitlist for sold-out packages; transferring a pass.
- Terms, refund policy and privacy pages.
