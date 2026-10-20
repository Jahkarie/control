// tickets.js: the public ticket site (tickets.ondroad.xyz, the controlfrontend repo's tickets/ folder). No invites, no
// roster: anyone 18+ buys entry tickets or VIP tables (bottle service) for the ticket events, separate from the
// invite-only On D' Road events (events.js). Several ticket events can be on sale at once.
//
// What's here:
// - the schema (ensureTicketSchema(), run by server.js's ensureSchema()): ticket_events, ticket_products, ticket_tiers,
//   the global menus (bottles, chaser_groups, chasers), ticket_orders, ticket_order_items, ticket_payments, tickets and
//   ticket_checkins;
// - its own site lock (lock.js's createLock() with the tickets_* settings), covering /api/tickets/* only;
// - the guest API under /api/tickets/: site info, events, checkout (validated and priced here, never from the client;
//   capacity held for 30 minutes while PayPal is pending), PayPal create/capture (in full, or a table's deposit and later
//   its balance), the signed order and ticket pages, transfers and "find my tickets";
// - the emails, the job (holds, PayPal recovery, balance reminders and deadlines), the admin API and /admin/tickets
//   (the page itself is tickets-admin.js), the bar list and door list;
// - createTicketDoor(): the ticket side of the door scanner (door.js), the door list and check-ins of a ticket event.
// Every ticket has a live QR (liveqr.js): "ONDROAD-T:<ref>:<code>", the code changing every 30 seconds. Emails carry no
// QR, only a button to the live ticket page.
import crypto from 'crypto';
import { createLock } from './lock.js';
import { usdCents, usd, paypalEnabledFor, PAYPAL_CLIENT_ID, paypalApi, paypalIssue, captureOf, orderPath, refundCapture } from './paypal.js';
import { qrSecret, codeOk } from './liveqr.js';
import { parseWhen } from './pricing.js';
import { ticketsAdminPage, barListPage } from './tickets-admin.js';

export const TICKETS_URL = (process.env.TICKETS_URL || 'https://tickets.ondroad.xyz').replace(/\/$/, '');
export const DEFAULT_TIER_LABELS = ['Standard', 'Premium', 'Top shelf'];
const HOLD_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PERSON_STATUSES = ['PAID', 'DEPOSIT_PAID'];
const EVENT_STATUSES = ['DRAFT', 'ON_SALE', 'CLOSED', 'PAST'];

// Used until the organizers save their own ticket terms (settings.tickets_terms). "# " starts a heading, "- " a bullet.
export const DEFAULT_TICKET_TERMS = `# The short version
Tickets are for adults 18 and over. Bring photo ID. One ticket lets one person in, once. Look after your ticket like cash.

# 1. Age and ID
- Every event on this site is 18+. The date of birth you give when you buy must be your own.
- Bring photo ID. You can be asked for it at the entrance, and at the bar.
- No ID, or under 18: no entry and no refund.

# 2. Your tickets
- Each ticket lets one person in, once. The first scan at the entrance is the one that counts.
- Show the live ticket on your phone at the door. Screenshots and printouts stop working after about a minute.
- A forwarded ticket is the holder's responsibility. If someone else uses it first, it's gone. To give a ticket to a friend, use Transfer on your ticket page: they get their own ticket and the old one stops working.
- Car passes let one car in. They don't let a person in, and entry tickets don't let a car in.
- Tickets can't be resold for more than you paid.

# 3. Paying
- You pay online by card or PayPal, charged in US dollars. Prices in EC$ are converted at 2.70 to the dollar.
- Your spot is held for 30 minutes while you pay. After that it goes back on sale.

# 4. Table deposits
- Some tables can be booked with a deposit. The rest (the balance) is due by the date shown on your order.
- Pay the balance online from your order page. Your tickets are issued once the table is paid in full.
- If the balance isn't paid by the deadline, the booking is cancelled and the table goes back on sale.
- Deposits are non-refundable.

# 5. Refunds
- There are no refunds, except when the organizers decide to give one, or if the event is cancelled.
- If the event is cancelled, you get your money back for the tickets you paid for.
- No refunds for no-shows, lost tickets, or if you're refused entry or removed for breaking these terms.

# 6. Bottle service
- Table bottles are served by our staff, to the table's guests only, and only to guests 18 and over.
- Bottles can't be taken away, swapped for cash or moved to another table.
- Chasers are limited to your table's chaser allowance. Extra drinks are paid at the bar.
- Bottles marked "decide later" are chosen with your server on the night, from what's in stock at the same tier.
- We can stop serving anyone who is drunk, under age or putting others at risk.

# 7. Safety
- Follow the instructions of the organizers, security and police.
- We can refuse entry or remove anyone who is violent, threatening or putting people at risk, with no refund.
- You take part at your own risk, as far as the law allows, and you're responsible for your belongings.

# 8. Photos and video
- Events may be photographed and filmed. By attending, you agree that you may appear in photos and videos we use to promote our events.

# 9. Your information
- We keep your name, email, date of birth and orders to run the event and check tickets. We don't sell your information.`;

// ---------- Schema ----------
export async function ensureTicketSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_events (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      venue TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      show_location TEXT NOT NULL DEFAULT 'AFTER' CHECK (show_location IN ('PUBLIC', 'AFTER')),
      info TEXT NOT NULL DEFAULT '',
      buyer_info TEXT NOT NULL DEFAULT '',
      poster TEXT NOT NULL DEFAULT '',
      refund_policy TEXT NOT NULL DEFAULT '',
      fee_kind TEXT NOT NULL DEFAULT 'NONE' CHECK (fee_kind IN ('NONE', 'FLAT', 'PERCENT')),
      fee_cents INTEGER NOT NULL DEFAULT 0,
      fee_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ON_SALE', 'CLOSED', 'PAST')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ticket_products (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES ticket_events(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('TICKET', 'TABLE')),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      includes TEXT NOT NULL DEFAULT '',
      perks TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'XCD' CHECK (currency IN ('XCD', 'USD')),
      capacity INTEGER,
      max_per_order INTEGER NOT NULL DEFAULT 10,
      tickets_included INTEGER NOT NULL DEFAULT 1,
      car_passes INTEGER NOT NULL DEFAULT 0,
      bottle_slots JSONB NOT NULL DEFAULT '[]',
      slot_later BOOLEAN NOT NULL DEFAULT FALSE,
      chaser_points NUMERIC(8,2) NOT NULL DEFAULT 0,
      deposit_kind TEXT NOT NULL DEFAULT 'NONE' CHECK (deposit_kind IN ('NONE', 'PERCENT', 'AMOUNT')),
      deposit_value INTEGER NOT NULL DEFAULT 0,
      balance_rule TEXT NOT NULL DEFAULT 'DAYS' CHECK (balance_rule IN ('DAYS', 'DATE')),
      balance_days INTEGER NOT NULL DEFAULT 7,
      balance_date TIMESTAMPTZ,
      sales_end TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ticket_tiers (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES ticket_products(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      ends_at TIMESTAMPTZ,
      quantity INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bottles (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      tier INTEGER NOT NULL DEFAULT 1 CHECK (tier BETWEEN 1 AND 3),
      upgrade_cents INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS chaser_groups (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      points NUMERIC(6,2) NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS chasers (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES chaser_groups(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS ticket_orders (
      id SERIAL PRIMARY KEY,
      ref TEXT NOT NULL UNIQUE,
      event_id INTEGER NOT NULL REFERENCES ticket_events(id),
      buyer_name TEXT NOT NULL,
      buyer_email TEXT NOT NULL,
      buyer_birth_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DEPOSIT_PAID', 'PAID', 'CANCELLED', 'REFUNDED')),
      subtotal_cents INTEGER NOT NULL DEFAULT 0,
      fee_cents INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL DEFAULT 0,
      deposit_cents INTEGER NOT NULL DEFAULT 0,
      paid_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'XCD',
      balance_due_at TIMESTAMPTZ,
      balance_reminder_at TIMESTAMPTZ,
      terms_accepted_at TIMESTAMPTZ,
      hold_until TIMESTAMPTZ,
      paypal_order_id TEXT,
      paypal_amount TEXT,
      paypal_status TEXT,
      paypal_purpose TEXT,
      paypal_due_cents INTEGER,
      paypal_started_at TIMESTAMPTZ,
      paid_via TEXT,
      deposit_paid_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      cancel_reason TEXT,
      refunded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ticket_order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES ticket_orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES ticket_products(id),
      product_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      qty INTEGER NOT NULL,
      unit_cents INTEGER NOT NULL,
      tier_id INTEGER REFERENCES ticket_tiers(id) ON DELETE SET NULL,
      tier_name TEXT,
      upgrades_cents INTEGER NOT NULL DEFAULT 0,
      line_cents INTEGER NOT NULL DEFAULT 0,
      deposit_cents INTEGER NOT NULL DEFAULT 0,
      tickets_included INTEGER NOT NULL DEFAULT 1,
      car_passes INTEGER NOT NULL DEFAULT 0,
      selections JSONB NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS ticket_payments (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES ticket_orders(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('DEPOSIT', 'FULL', 'BALANCE')),
      via TEXT NOT NULL CHECK (via IN ('PAYPAL', 'MANUAL')),
      amount_cents INTEGER NOT NULL,
      usd_amount TEXT,
      paypal_order_id TEXT,
      capture_id TEXT UNIQUE,
      refund_id TEXT,
      refunded_at TIMESTAMPTZ,
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES ticket_orders(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES ticket_order_items(id) ON DELETE CASCADE,
      ref TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'PERSON' CHECK (kind IN ('PERSON', 'CAR')),
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'VALID' CHECK (status IN ('VALID', 'TRANSFERRED', 'CANCELLED')),
      version INTEGER NOT NULL DEFAULT 1,
      holder_name TEXT NOT NULL DEFAULT '',
      holder_email TEXT NOT NULL DEFAULT '',
      prev_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
      transferred_to_email TEXT,
      transferred_at TIMESTAMPTZ,
      checked_in_at TIMESTAMPTZ,
      checked_in_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ticket_checkins (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      device TEXT,
      client_id TEXT UNIQUE,
      scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ticket_products_event_idx ON ticket_products (event_id);
    CREATE INDEX IF NOT EXISTS ticket_orders_event_idx ON ticket_orders (event_id, status);
    CREATE INDEX IF NOT EXISTS ticket_orders_email_idx ON ticket_orders (LOWER(buyer_email));
    CREATE INDEX IF NOT EXISTS ticket_items_order_idx ON ticket_order_items (order_id);
    CREATE INDEX IF NOT EXISTS ticket_items_product_idx ON ticket_order_items (product_id);
    CREATE INDEX IF NOT EXISTS tickets_order_idx ON tickets (order_id);
    CREATE INDEX IF NOT EXISTS tickets_holder_idx ON tickets (LOWER(holder_email));
    CREATE INDEX IF NOT EXISTS ticket_checkins_ticket_idx ON ticket_checkins (ticket_id);
  `);
}

// ---------- Small helpers ----------
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford's base32: no I, L, O or U, so a ref read aloud is unambiguous
const randomB32 = (n) => Array.from(crypto.randomBytes(n), (b) => B32[b & 31]).join('');
const newOrderRef = () => 'TKT-' + crypto.randomBytes(4).toString('hex').toUpperCase();
export const newTicketRef = () => randomB32(12); // 60 random bits
const int = (v) => (typeof v === 'number' || (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) ? Number(v) : NaN);
const idOf = (v) => { const n = parseInt(v, 10); return n > 0 && n <= 2147483647 ? n : 0; };
const text = (v, max) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');
const blank = (v) => v === undefined || v === null || (typeof v === 'string' && !v.trim());
const pts = (v) => Math.round(Number(v || 0) * 100); // chaser points in hundredths, so 1.5 + 1.5 is exactly 3
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';
export const maskEmail = (e) => { const [u, d] = String(e || '').split('@'); return u && d ? `${u[0]}***@${d}` : ''; };
const POSTER_PATH = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.(png|jpe?g|svg|webp|gif)$/;
const isHttpsUrl = (v) => {
  if (v.length > 500 || !/^https:\/\/[^\s"'<>\\]+$/.test(v)) return false;
  try { return new URL(v).protocol === 'https:'; } catch { return false; }
};
const posterOk = (v) => !v || isHttpsUrl(v) || POSTER_PATH.test(v);
export const slugify = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

// "EC$100.00" / "US$37.04"; with both: "EC$100.00 · US$37.04" (the US$ is what the card is charged).
export const money = (cents, cur) => `${cur === 'USD' ? 'US$' : 'EC$'}${(Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const moneyBoth = (cents, cur) => (cur === 'USD' ? money(cents, 'USD') : `${money(cents, 'XCD')} · ${money(usdCents(cents, cur), 'USD')}`);

const AT = 'America/Antigua';
const partsOf = (d, o) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: AT, ...o }).formatToParts(d).map((x) => [x.type, x.value]));
// "Sun 26 Jul · 2:00 PM – 10:00 PM" (an end on another day gets its date too).
export function whenRange(starts, ends) {
  if (!starts) return '';
  const s = new Date(starts);
  const p = partsOf(s, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  let out = `${p.weekday} ${p.day} ${p.month} · ${p.hour}:${p.minute} ${p.dayPeriod}`;
  if (ends) {
    const e = new Date(ends), q = partsOf(e, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const sameDay = q.day === p.day && q.month === p.month || (e - s < 18 * 3600 * 1000);
    out += ` – ${sameDay ? '' : `${q.weekday} ${q.day} ${q.month}, `}${q.hour}:${q.minute} ${q.dayPeriod}`;
  }
  return out;
}
export const longDate = (d) => (d ? new Date(d).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: AT }) : '');

// The current tier: the first (by sort order) that hasn't ended or sold out. sold counts held and paid ones.
function tierState(tiers, now = Date.now()) {
  const open = tiers.filter((t) => (!t.ends_at || new Date(t.ends_at).getTime() > now) && (t.quantity == null || t.sold < t.quantity));
  const cur = open[0] || null, next = open[1] || null;
  return { cur, next, allSold: tiers.length > 0 && !open.length && tiers.every((t) => t.quantity != null && t.sold >= t.quantity) };
}

// The order statuses that hold capacity: paid, deposit paid, and a checkout whose hold is still running (or whose
// payment PayPal is still holding, however long that takes).
// A payment PayPal took but for the wrong amount (AMOUNT_MISMATCH) holds too, until the organizers sort it out.
const HOLDS = `(o.status IN ('PAID', 'DEPOSIT_PAID') OR (o.status = 'PENDING' AND (o.hold_until > NOW() OR o.paypal_status IN ('PENDING', 'AMOUNT_MISMATCH'))))`;

// Everything needed to sell one event's products: products (with tiers and what's held) and the menus.
// lock: lock the product rows (checkout), so two buyers can't both take the last tickets. exclude: an order whose own
// items don't count (re-checking an expired hold).
async function loadCatalog(db, eventId, { lock = false, exclude = 0 } = {}) {
  const products = (await db.query(
    `SELECT * FROM ticket_products WHERE event_id = $1 ORDER BY sort_order, id ${lock ? 'FOR UPDATE' : ''}`, [eventId])).rows;
  const ids = products.map((p) => p.id);
  const [tiers, held, bottles, groups, chasers, labels] = await Promise.all([
    db.query('SELECT * FROM ticket_tiers WHERE product_id = ANY($1::int[]) ORDER BY sort_order, id', [ids]),
    db.query(`SELECT i.product_id, i.tier_id, SUM(i.qty)::int AS n,
                     SUM(CASE WHEN o.status = 'PENDING' THEN i.qty ELSE 0 END)::int AS pending
              FROM ticket_order_items i JOIN ticket_orders o ON o.id = i.order_id
              WHERE i.product_id = ANY($1::int[]) AND ${HOLDS} AND o.id <> $2 GROUP BY 1, 2`, [ids, exclude]),
    db.query('SELECT id, name, tier, upgrade_cents, active, sort_order FROM bottles ORDER BY tier, sort_order, id'),
    db.query('SELECT id, name, points, sort_order FROM chaser_groups ORDER BY sort_order, id'),
    db.query('SELECT id, group_id, name, active, sort_order FROM chasers ORDER BY sort_order, id'),
    tierLabels(db)
  ]);
  const byProduct = new Map(products.map((p) => [p.id, { sold: 0, pending: 0 }]));
  const byTier = new Map();
  for (const h of held.rows) {
    const x = byProduct.get(h.product_id); x.sold += h.n; x.pending += h.pending;
    if (h.tier_id) byTier.set(h.tier_id, (byTier.get(h.tier_id) || 0) + h.n);
  }
  for (const p of products) {
    p.tiers = tiers.rows.filter((t) => t.product_id === p.id).map((t) => ({ ...t, sold: byTier.get(t.id) || 0 }));
    p.held = byProduct.get(p.id).sold; // paid + deposit + held checkouts
    p.pending = byProduct.get(p.id).pending;
    p.slots = Array.isArray(p.bottle_slots) ? p.bottle_slots.map(Number) : [];
  }
  return {
    products, labels,
    bottles: bottles.rows, groups: groups.rows.map((g) => ({ ...g, points: Number(g.points) })), chasers: chasers.rows
  };
}

export async function tierLabels(db) {
  const r = await db.query("SELECT value FROM settings WHERE key = 'bottle_tier_labels'");
  try {
    const v = JSON.parse(r.rows[0]?.value || 'null');
    if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'string' && x.trim())) return v.map((x) => x.trim());
  } catch { /* the defaults */ }
  return DEFAULT_TIER_LABELS;
}

// A product's sale state right now: the price, tier, how many are left (null = no limit) and why it can't be bought.
function saleState(p, ev, now = Date.now()) {
  const { cur, next, allSold } = tierState(p.tiers, now);
  const capLeft = p.capacity == null ? null : Math.max(0, p.capacity - p.held);
  const tierLeft = cur && cur.quantity != null ? Math.max(0, cur.quantity - cur.sold) : null;
  const left = capLeft == null ? tierLeft : tierLeft == null ? capLeft : Math.min(capLeft, tierLeft);
  const ended = p.sales_end && new Date(p.sales_end).getTime() <= now;
  const soldOut = capLeft === 0 || allSold;
  const closed = !soldOut && (ended || (p.tiers.length && !cur) || ev.status !== 'ON_SALE');
  const price = cur ? cur.price_cents : p.price_cents;
  const maxNow = Math.max(0, Math.min(p.max_per_order, left == null ? Infinity : left));
  return { cur, next, capLeft, tierLeft, left, soldOut, closed, price, maxNow, available: p.active && !soldOut && !closed && maxNow > 0 };
}

// The deposit due now for one table (unit price plus upgrades), or the full amount when it has no deposit.
function depositFor(p, lineCents) {
  if (p.kind !== 'TABLE' || p.deposit_kind === 'NONE') return lineCents;
  const d = p.deposit_kind === 'PERCENT' ? Math.ceil((lineCents * p.deposit_value) / 100) : Math.min(p.deposit_value, lineCents);
  return d > 0 && d < lineCents ? d : lineCents;
}
// When a table's balance is due if booked now: N days after booking or a fixed date, never after the event starts.
function balanceDueFor(p, ev, now = Date.now()) {
  let due = p.balance_rule === 'DATE' && p.balance_date ? new Date(p.balance_date).getTime() : now + (p.balance_days || 7) * DAY_MS;
  if (ev.starts_at) due = Math.min(due, new Date(ev.starts_at).getTime());
  return due;
}

const fail = (code, error, extra = {}) => ({ code, error, ...extra });

// Prices and checks an order from what the buyer picked. Returns { lines, subtotal, fee, total, dueNow, currency,
// balanceDueAt, persons } or { error: { code, error, ... } }. Never trusts a price from the client.
function priceOrder(cat, ev, rawItems, now = Date.now()) {
  if (!Array.isArray(rawItems) || !rawItems.length) return { error: fail('ITEMS_REQUIRED', 'Pick at least one ticket or table.') };
  if (rawItems.length > 40) return { error: fail('ITEMS_REQUIRED', 'That order is too big. Split it in two.') };
  const products = new Map(cat.products.map((p) => [p.id, p]));
  const bottles = new Map(cat.bottles.filter((b) => b.active).map((b) => [b.id, b]));
  const groups = new Map(cat.groups.map((g) => [g.id, g]));
  const chasers = new Map(cat.chasers.filter((c) => c.active && groups.has(c.group_id)).map((c) => [c.id, c]));
  const wanted = new Map(); // product id -> how many (tickets) or tables
  const lines = [];
  let currency = null;
  for (const [i, it] of rawItems.entries()) {
    const p = products.get(idOf(it?.product_id));
    if (!p || !p.active) return { error: fail('PRODUCT_UNAVAILABLE', "One of those isn't on sale any more.", { item: i }) };
    const st = saleState(p, ev, now);
    if (st.soldOut) return { error: fail('SOLD_OUT', `${p.name} is sold out.`, { item: i, product_id: p.id }) };
    if (st.closed) return { error: fail('SALES_CLOSED', `Sales for ${p.name} are closed.`, { item: i, product_id: p.id }) };
    if (currency && currency !== p.currency) return { error: fail('CURRENCY_MIX', 'Buy those separately: they are priced in different currencies.') };
    currency = p.currency;
    const qty = p.kind === 'TABLE' ? 1 : int(it.qty);
    if (p.kind === 'TABLE' && it.qty !== undefined && int(it.qty) !== 1) return { error: fail('BAD_QTY', 'Build each table on its own.', { item: i }) };
    if (!(qty >= 1 && qty <= 100)) return { error: fail('BAD_QTY', 'Pick how many.', { item: i }) };
    wanted.set(p.id, (wanted.get(p.id) || 0) + qty);
    const n = wanted.get(p.id);
    if (n > p.max_per_order) return { error: fail('MAX_PER_ORDER', `You can buy up to ${p.max_per_order} ${p.kind === 'TABLE' ? (p.max_per_order === 1 ? 'table' : 'tables') : (p.max_per_order === 1 ? 'ticket' : 'tickets')} of ${p.name} per order.`, { item: i, product_id: p.id, max: p.max_per_order }) };
    if (st.left != null && n > st.left) {
      const tierShort = st.tierLeft != null && n > st.tierLeft && (st.capLeft == null || st.tierLeft < st.capLeft);
      return { error: fail('SOLD_OUT', st.left === 0 ? `${p.name} is sold out.` : tierShort ? `Only ${st.left} left at this price for ${p.name}.` : `Only ${st.left} left for ${p.name}.`, { item: i, product_id: p.id, left: st.left }) };
    }
    let upgrades = 0, selections = {};
    if (p.kind === 'TABLE') {
      // One bottle per slot: a bottle at or below the slot's tier is included, a higher one costs its upgrade price.
      const picks = Array.isArray(it.bottles) ? it.bottles : [];
      if (picks.length !== p.slots.length) return { error: fail('BOTTLE_REQUIRED', `Pick a bottle for every slot of ${p.name}.`, { item: i }) };
      const slots = [];
      for (const [s, raw] of picks.entries()) {
        const slotTier = p.slots[s];
        if (raw === null || raw === 'later') {
          if (!p.slot_later) return { error: fail('BOTTLE_REQUIRED', `Pick a bottle for every slot of ${p.name}.`, { item: i, slot: s }) };
          slots.push({ slot_tier: slotTier, slot_label: cat.labels[slotTier - 1], later: true, bottle_id: null, name: 'Decide later', tier: slotTier, charge_cents: 0 });
          continue;
        }
        const b = bottles.get(idOf(raw));
        if (!b) return { error: fail('BOTTLE_INVALID', "That bottle isn't on the menu any more. Pick another.", { item: i, slot: s }) };
        const charge = b.tier > slotTier ? b.upgrade_cents : 0;
        upgrades += charge;
        slots.push({ slot_tier: slotTier, slot_label: cat.labels[slotTier - 1], later: false, bottle_id: b.id, name: b.name, tier: b.tier, tier_label: cat.labels[b.tier - 1], charge_cents: charge });
      }
      // Chasers: points per item come from its group; the table's budget can't be exceeded (a remainder is fine).
      const budget = pts(p.chaser_points);
      const merged = new Map();
      for (const c of Array.isArray(it.chasers) ? it.chasers : []) {
        const id = idOf(c?.id), q = int(c?.qty);
        if (!chasers.has(id)) return { error: fail('CHASER_INVALID', "One of those chasers isn't on the menu any more.", { item: i }) };
        if (!(q >= 0 && q <= 99)) return { error: fail('CHASER_INVALID', 'Check the number of chasers.', { item: i }) };
        if (q) merged.set(id, (merged.get(id) || 0) + q);
      }
      let used = 0;
      const list = [];
      for (const [id, q] of merged) {
        const c = chasers.get(id), g = groups.get(c.group_id);
        used += pts(g.points) * q;
        list.push({ id, name: c.name, group: g.name, qty: q, points: Number(g.points) });
      }
      if (used > budget) return { error: fail('CHASERS_OVER', `Those chasers come to ${used / 100} points; ${p.name} includes ${budget / 100}.`, { item: i, used: used / 100, budget: budget / 100 }) };
      selections = { slots, chasers: list, points_used: used / 100, points_budget: budget / 100 };
    }
    const lineCents = (st.price + upgrades) * qty;
    lines.push({
      product: p, qty, unit: st.price, tier: st.cur, upgrades, lineCents, selections,
      deposit: p.kind === 'TABLE' ? depositFor(p, lineCents) : lineCents,
      persons: p.tickets_included * qty, cars: p.kind === 'TABLE' ? p.car_passes * qty : 0
    });
  }
  const subtotal = lines.reduce((a, l) => a + l.lineCents, 0);
  const persons = lines.reduce((a, l) => a + l.persons, 0);
  const fee = ev.fee_kind === 'FLAT' ? ev.fee_cents * persons : ev.fee_kind === 'PERCENT' ? Math.round((subtotal * Number(ev.fee_percent)) / 100) : 0;
  // Deposits only while the balance would be due at least a day from now; otherwise tables are paid in full.
  let balanceDueAt = null;
  for (const l of lines) {
    if (l.deposit >= l.lineCents) continue;
    const due = balanceDueFor(l.product, ev, now);
    if (due < now + DAY_MS) l.deposit = l.lineCents;
    else balanceDueAt = balanceDueAt == null ? due : Math.min(balanceDueAt, due);
  }
  const dueNow = lines.reduce((a, l) => a + l.deposit, 0) + fee;
  const total = subtotal + fee;
  return { lines, subtotal, fee, total, dueNow, currency, persons, balanceDueAt: dueNow < total ? new Date(balanceDueAt) : null };
}

// ---------- What guests see ----------
const showLocation = (ev, bought) => ev.show_location === 'PUBLIC' || bought;
function eventOut(ev, { bought = false, paid = false } = {}) {
  const loc = showLocation(ev, bought);
  return {
    slug: ev.slug, name: ev.name, starts_at: ev.starts_at, ends_at: ev.ends_at, when: whenRange(ev.starts_at, ev.ends_at),
    venue: loc ? ev.venue : '', address: loc ? ev.address : '',
    location_after_purchase: !loc && !!(ev.venue || ev.address), info: ev.info, poster: posterOk(ev.poster) ? ev.poster : '',
    refund_policy: ev.refund_policy || '', status: ev.status,
    fee: { kind: ev.fee_kind, cents: ev.fee_cents, percent: Number(ev.fee_percent) },
    ...(paid ? { buyer_info: ev.buyer_info } : {})
  };
}
function productOut(p, ev, labels) {
  const st = saleState(p, ev);
  const out = {
    id: p.id, kind: p.kind, name: p.name, description: p.description, includes: p.includes,
    perks: p.perks.split('\n').map((x) => x.trim()).filter(Boolean),
    currency: p.currency, price_cents: st.price, usd_cents: usdCents(st.price, p.currency),
    tier: st.cur ? { id: st.cur.id, name: st.cur.name, ends_at: st.cur.ends_at, left: st.tierLeft } : null,
    next_tier: st.next ? { name: st.next.name, price_cents: st.next.price_cents } : null,
    left: st.left, max_per_order: p.max_per_order, max_now: st.maxNow,
    sold_out: st.soldOut, sales_closed: st.closed, sales_end: p.sales_end
  };
  if (p.kind === 'TABLE') {
    Object.assign(out, {
      tickets_included: p.tickets_included, car_passes: p.car_passes,
      bottle_slots: p.slots.map((t) => ({ tier: t, label: labels[t - 1] })), slot_later: p.slot_later,
      chaser_points: Number(p.chaser_points),
      deposit: p.deposit_kind === 'NONE' ? null : {
        kind: p.deposit_kind, value: p.deposit_value, cents: depositFor(p, st.price),
        balance_rule: p.balance_rule, balance_days: p.balance_days, balance_date: p.balance_date,
        // The deadline for a table booked now, or null when it's too close and tables are paid in full.
        due_at: (() => { const d = balanceDueFor(p, ev); return d >= Date.now() + DAY_MS ? new Date(d).toISOString() : null; })()
      }
    });
  }
  return out;
}
function menusOut(cat) {
  return {
    tier_labels: cat.labels,
    bottles: cat.bottles.filter((b) => b.active).map((b) => ({ id: b.id, name: b.name, tier: b.tier, upgrade_cents: b.upgrade_cents })),
    chaser_groups: cat.groups.map((g) => ({ id: g.id, name: g.name, points: g.points,
      chasers: cat.chasers.filter((c) => c.active && c.group_id === g.id).map((c) => ({ id: c.id, name: c.name })) })).filter((g) => g.chasers.length)
  };
}
async function eventPayload(db, ev) {
  const cat = await loadCatalog(db, ev.id);
  const products = cat.products.filter((p) => p.active).map((p) => productOut(p, ev, cat.labels));
  // "From EC$95 – EC$140": the ticket prices (the tables' when there are no tickets).
  const priced = products.some((p) => p.kind === 'TICKET') ? products.filter((p) => p.kind === 'TICKET') : products;
  const prices = priced.map((p) => p.price_cents);
  const currency = products[0]?.currency || 'XCD';
  return { ...eventOut(ev), currency, price_from: prices.length ? Math.min(...prices) : null, price_to: prices.length ? Math.max(...prices) : null,
    products, menus: products.some((p) => p.kind === 'TABLE') ? menusOut(cat) : null };
}

const ORDER_ITEMS_SQL = `SELECT id, product_id, product_name, kind, qty, unit_cents, tier_name, upgrades_cents, line_cents, deposit_cents,
  tickets_included, car_passes, selections FROM ticket_order_items WHERE order_id = $1 ORDER BY id`;

// Issues the QR tickets of a fully paid order (inside the caller's transaction): one per person, and one per car pass.
async function issueTickets(db, orderId, holderName, holderEmail) {
  const have = await db.query('SELECT 1 FROM tickets WHERE order_id = $1 LIMIT 1', [orderId]);
  if (have.rowCount) return;
  const items = (await db.query(ORDER_ITEMS_SQL, [orderId])).rows;
  const tables = new Map(); // tables of the same product count "1 of 5" within each table
  for (const it of items) {
    const rows = [];
    if (it.kind === 'TICKET') {
      for (let i = 0; i < it.qty; i++) rows.push(['PERSON', it.product_name]);
    } else {
      const n = (tables.get(it.product_id) || 0) + 1;
      tables.set(it.product_id, n);
      const name = items.filter((x) => x.product_id === it.product_id).length > 1 ? `${it.product_name} ${n}` : it.product_name;
      for (let i = 1; i <= it.tickets_included * it.qty; i++) rows.push(['PERSON', `${name} · ${i} of ${it.tickets_included * it.qty}`]);
      for (let i = 1; i <= it.car_passes * it.qty; i++) rows.push(['CAR', `Car pass · ${name}${it.car_passes * it.qty > 1 ? ` · ${i} of ${it.car_passes * it.qty}` : ''}`]);
    }
    for (const [kind, label] of rows) {
      await db.query(
        `INSERT INTO tickets (order_id, item_id, ref, kind, label, holder_name, holder_email) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [orderId, it.id, newTicketRef(), kind, label, holderName, holderEmail]);
    }
  }
}

export function registerTickets({ app, pool, express, TOKEN_SECRET, safeEqual, requireAdmin, rateLimit, mail, renderEmail,
  normalizeEmail, isValidEmail, cleanName, cleanBirthDate, SITE_URL, PUBLIC_URL }) {
  const json = express.json({ limit: '16kb' });
  const adminJson = express.json({ limit: '100kb' }); // ticket terms and event texts can be long
  const sign = (data) => crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest('base64url').slice(0, 22);
  const orderSig = (ref) => sign('tkt-order:' + ref);
  const ticketSig = (ref) => sign('tkt-ticket:' + ref);
  const orderUrl = (ref) => `${TICKETS_URL}/?order=${encodeURIComponent(ref)}&s=${orderSig(ref)}`;
  const ticketUrl = (ref) => `${TICKETS_URL}/?ticket=${encodeURIComponent(ref)}&s=${ticketSig(ref)}`;
  const secretOf = (t) => qrSecret(TOKEN_SECRET, t.ref, t.version);
  const serverError = (res, err) => { console.error('Tickets error:', err); res.status(500).json({ error: 'Server error.' }); };
  const bad = (res, e, status = 400) => res.status(status).json(e);

  // ---------- The ticket site's lock ----------
  // Open while locked: the site status itself, bought orders and tickets (their pages, paying a balance, transfers)
  // and the retired QR images. Everything else under /api/tickets/ (unknown paths too) answers 423.
  const OPEN = /^\/api\/tickets\/(site|order|ticket|qr)(\/|$)/;
  const lock = createLock({ pool, TOKEN_SECRET, safeEqual, SITE_URL: TICKETS_URL,
    keys: { lock: 'tickets_lock', at: 'tickets_unlock_at', version: 'tickets_preview_version' }, tokenPrefix: 'tickets-preview:',
    applies: (path) => (path === '/api/tickets' || path.startsWith('/api/tickets/')) && !OPEN.test(path),
    adminPath: '/api/admin/tickets-lock', what: 'Ticket site' });
  app.use(lock.guard);
  lock.register({ app, requireAdmin, json: adminJson });

  const settingsOf = async (db, keys) => Object.fromEntries((await db.query('SELECT key, value FROM settings WHERE key = ANY($1)', [keys])).rows.map((r) => [r.key, r.value]));
  async function siteInfo(db) {
    const s = await settingsOf(db, ['contact_whatsapp', 'contact_instagram', 'contact_email', 'tickets_terms', 'tickets_terms_updated_at']);
    return {
      contact: { whatsapp: s.contact_whatsapp || '', instagram: s.contact_instagram || '', email: s.contact_email || '' },
      terms: s.tickets_terms || DEFAULT_TICKET_TERMS, terms_updated_at: s.tickets_terms_updated_at || null,
      main_site: SITE_URL
    };
  }

  // ---------- Orders: what the order page shows ----------
  const eventById = async (db, id) => (await db.query('SELECT * FROM ticket_events WHERE id = $1', [id])).rows[0];
  const eventOver = (ev) => ev.status === 'PAST' || (new Date(ev.ends_at || (ev.starts_at ? new Date(ev.starts_at).getTime() + 12 * 3600 * 1000 : Date.now() + DAY_MS)).getTime() < Date.now());
  const ticketOut = (t, o, { secret }) => ({
    ref: t.ref, kind: t.kind, label: t.label, status: o.status === 'PAID' ? t.status : 'CANCELLED',
    checked_in: !!t.checked_in_at, holder: firstName(t.holder_name),
    transferred_to: t.status === 'TRANSFERRED' ? maskEmail(t.transferred_to_email) : null, transferred_at: t.transferred_at,
    ...(secret && t.status === 'VALID' && o.status === 'PAID' ? { secret: secretOf(t), version: t.version, link: ticketUrl(t.ref), s: ticketSig(t.ref) } : {})
  });
  function payState(o) {
    const enabled = paypalEnabledFor(o.buyer_email);
    if (o.status === 'PENDING') return { purpose: o.deposit_cents < o.total_cents ? 'DEPOSIT' : 'FULL', cents: o.deposit_cents, enabled };
    if (o.status === 'DEPOSIT_PAID') return { purpose: 'BALANCE', cents: o.total_cents - o.paid_cents, enabled };
    return null;
  }
  async function orderPage(db, o) {
    const ev = await eventById(db, o.event_id);
    const bought = PERSON_STATUSES.includes(o.status);
    const [items, tks, pays] = await Promise.all([
      db.query(ORDER_ITEMS_SQL, [o.id]),
      // The buyer's own tickets: the ones first issued to them (a transferred one shows who it went to).
      db.query('SELECT * FROM tickets WHERE order_id = $1 AND prev_id IS NULL ORDER BY id', [o.id]),
      db.query('SELECT kind, via, amount_cents, created_at, refunded_at FROM ticket_payments WHERE order_id = $1 ORDER BY id', [o.id])
    ]);
    const pay = payState(o);
    return {
      ref: o.ref, status: o.status, created_at: o.created_at, buyer_first_name: firstName(o.buyer_name), buyer_name: o.buyer_name,
      event: eventOut(ev, { bought, paid: o.status === 'PAID' }), event_over: eventOver(ev),
      currency: o.currency, subtotal_cents: o.subtotal_cents, fee_cents: o.fee_cents, total_cents: o.total_cents,
      deposit_cents: o.deposit_cents, paid_cents: o.paid_cents, balance_cents: Math.max(0, o.total_cents - o.paid_cents),
      balance_due_at: o.balance_due_at, hold_until: o.status === 'PENDING' ? o.hold_until : null,
      items: items.rows.map((i) => ({ kind: i.kind, name: i.product_name, qty: i.qty, unit_cents: i.unit_cents, tier_name: i.tier_name,
        upgrades_cents: i.upgrades_cents, line_cents: i.line_cents, tickets_included: i.tickets_included, car_passes: i.car_passes, selections: i.selections })),
      payments: pays.rows.map((p) => ({ kind: p.kind, via: p.via, amount_cents: p.amount_cents, at: p.created_at, refunded: !!p.refunded_at })),
      tickets: o.status === 'PAID' || o.status === 'REFUNDED' ? tks.rows.map((t) => ticketOut(t, o, { secret: true })) : [],
      pay: pay ? { ...pay, usd: usd(usdCents(pay.cents, o.currency)), client_id: pay.enabled ? PAYPAL_CLIENT_ID : null,
        pending: o.paypal_status === 'PENDING' && o.paypal_purpose === (pay.purpose === 'BALANCE' ? 'BALANCE' : o.paypal_purpose) } : null
    };
  }
  const orderByRef = async (db, ref, lockRow = false) =>
    (await db.query(`SELECT * FROM ticket_orders WHERE ref = $1 ${lockRow ? 'FOR UPDATE' : ''}`, [String(ref || '').toUpperCase().slice(0, 20)])).rows[0];
  const sigOk = (sig, want) => typeof sig === 'string' && sig.length > 0 && safeEqual(sig, want);

  // ---------- Recording money ----------
  // Re-checks an expired hold (inside the caller's transaction, the order row locked): its items must still fit.
  async function holdStillFits(db, o) {
    const ev = await eventById(db, o.event_id);
    const cat = await loadCatalog(db, o.event_id, { lock: true, exclude: o.id });
    const items = (await db.query(ORDER_ITEMS_SQL, [o.id])).rows;
    const want = new Map();
    for (const it of items) want.set(it.product_id, (want.get(it.product_id) || 0) + it.qty);
    for (const [pid, n] of want) {
      const p = cat.products.find((x) => x.id === pid);
      if (!p || !p.active) return false;
      const st = saleState(p, { ...ev, status: ev.status === 'PAST' ? 'PAST' : 'ON_SALE' });
      if (st.capLeft != null && n > st.capLeft) return false;
    }
    return true;
  }

  // Records a payment on a locked order. Returns 'PAID' (in full: tickets issued), 'DEPOSIT' (deposit paid, balance due)
  // or 'STALE' (the order wasn't in the state the payment was for; nothing recorded).
  async function recordPayment(db, o, { kind, via, cents, usdAmount = null, ppOrderId = null, captureId = null, note = '' }) {
    const wanted = kind === 'BALANCE' ? 'DEPOSIT_PAID' : 'PENDING';
    if (o.status !== wanted) return 'STALE';
    if (captureId && (await db.query('SELECT 1 FROM ticket_payments WHERE capture_id = $1', [captureId])).rowCount) return 'STALE';
    await db.query(`INSERT INTO ticket_payments (order_id, kind, via, amount_cents, usd_amount, paypal_order_id, capture_id, note)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [o.id, kind, via, cents, usdAmount, ppOrderId, captureId, note]);
    const paid = o.paid_cents + cents;
    const vias = (await db.query('SELECT DISTINCT via FROM ticket_payments WHERE order_id = $1', [o.id])).rows.map((r) => r.via);
    const paidVia = vias.length > 1 ? 'MIXED' : vias[0];
    if (paid >= o.total_cents) {
      await db.query(`UPDATE ticket_orders SET status = 'PAID', paid_cents = $2, paid_at = NOW(), paid_via = $3, hold_until = NULL
        WHERE id = $1`, [o.id, paid, paidVia]);
      await issueTickets(db, o.id, o.buyer_name, o.buyer_email);
      return 'PAID';
    }
    await db.query(`UPDATE ticket_orders SET status = 'DEPOSIT_PAID', paid_cents = $2, paid_via = $3, deposit_paid_at = NOW(), hold_until = NULL
      WHERE id = $1`, [o.id, paid, paidVia]);
    return 'DEPOSIT';
  }

  // What PayPal says about the payment started on a locked order. Returns 'PAID', 'DEPOSIT', 'PENDING', 'MISMATCH',
  // 'STALE' or PayPal's own status.
  async function recordCapture(db, o, ppOrder) {
    const cap = captureOf(ppOrder);
    if (!cap) return ppOrder?.status || 'NONE';
    if (cap.status === 'PENDING') {
      await db.query("UPDATE ticket_orders SET paypal_status = 'PENDING' WHERE id = $1", [o.id]);
      return 'PENDING';
    }
    if (cap.status !== 'COMPLETED') return cap.status;
    if (cap.amount?.currency_code !== 'USD' || cap.amount?.value !== o.paypal_amount) {
      console.error(`PayPal amount mismatch on ${o.ref}: got ${cap.amount?.currency_code} ${cap.amount?.value}, expected USD ${o.paypal_amount}`);
      await db.query("UPDATE ticket_orders SET paypal_status = 'AMOUNT_MISMATCH' WHERE id = $1", [o.id]);
      return 'MISMATCH';
    }
    const state = await recordPayment(db, o, { kind: o.paypal_purpose, via: 'PAYPAL', cents: o.paypal_due_cents,
      usdAmount: o.paypal_amount, ppOrderId: o.paypal_order_id, captureId: cap.id });
    await db.query("UPDATE ticket_orders SET paypal_status = 'COMPLETED' WHERE id = $1", [o.id]);
    if (state === 'STALE') console.error(`PayPal payment ${cap.id} on ${o.ref} arrived for an order in state ${o.status}. Check it in PayPal.`);
    return state;
  }

  // Brings the PayPal payment started on a locked order up to date: captures it if the buyer approved it but the capture
  // never happened (page closed), then records the result. canCapture false: only record what's already captured.
  async function settle(db, o, { canCapture = true } = {}) {
    let r = await paypalApi('GET', orderPath(o.paypal_order_id));
    if (!r.ok) return 'UNKNOWN';
    if (r.data.status === 'APPROVED') {
      if (!canCapture) return 'APPROVED';
      r = await paypalApi('POST', `${orderPath(o.paypal_order_id)}/capture`, {});
      if (!r.ok) return 'APPROVED';
    }
    return recordCapture(db, o, r.data);
  }

  // After a payment is recorded (outside the transaction): the emails.
  async function afterPaid(state, ref) {
    if (state !== 'PAID' && state !== 'DEPOSIT') return;
    const o = (await pool.query('SELECT * FROM ticket_orders WHERE ref = $1', [ref])).rows[0];
    if (!o) return;
    if (state === 'PAID') await sendTicketsEmail(o).catch((e) => console.error('Tickets email:', e.message));
    else await sendDepositEmail(o).catch((e) => console.error('Deposit email:', e.message));
  }

  // ---------- Guest API ----------
  // The ticket site asks this first: { locked: true } while locked (nothing else), else the site's details.
  app.get('/api/tickets/site', async (req, res) => {
    try {
      const gate = await lock.check(req);
      res.set('Cache-Control', 'no-store');
      if (gate.locked) return res.json({ locked: true });
      res.json({ ...(await siteInfo(pool)), locked: false, ...(gate.preview ? { preview: true } : {}) });
    } catch (err) { serverError(res, err); }
  });

  // Events on sale, each with its products, what's left and the menus its tables need.
  app.get('/api/tickets/events', rateLimit(300, 15 * 60 * 1000), async (req, res) => {
    try {
      const evs = (await pool.query("SELECT * FROM ticket_events WHERE status = 'ON_SALE' ORDER BY sort_order, starts_at NULLS LAST, id")).rows;
      res.set('Cache-Control', 'no-store');
      res.json({ events: await Promise.all(evs.map((ev) => eventPayload(pool, ev))) });
    } catch (err) { serverError(res, err); }
  });
  // One event by its slug: on sale, or closed / past (shown with sales closed). Drafts don't exist for guests.
  app.get('/api/tickets/events/:slug', rateLimit(300, 15 * 60 * 1000), async (req, res) => {
    try {
      const ev = (await pool.query("SELECT * FROM ticket_events WHERE slug = $1 AND status <> 'DRAFT'", [String(req.params.slug).toLowerCase().slice(0, 60)])).rows[0];
      res.set('Cache-Control', 'no-store');
      if (!ev) return res.status(404).json({ error: "We couldn't find that event.", code: 'NOT_FOUND' });
      res.json(await eventPayload(pool, ev));
    } catch (err) { serverError(res, err); }
  });

  // Checks the buyer's details. Returns { name, email, birth } or an error with code and field.
  function buyerInput(b) {
    const name = cleanName(b?.name);
    if (!name) return { error: fail('NAME_INVALID', blank(b?.name) ? 'Enter your full name as it shows on your ID.' : 'Enter your full name as it shows on your ID, in letters.', { field: 'name' }) };
    const email = normalizeEmail(b?.email);
    if (!isValidEmail(email)) return { error: fail('EMAIL_INVALID', 'Enter a valid email address. Your tickets go there.', { field: 'email' }) };
    const d = cleanBirthDate(b?.birth_date);
    if (d.error === 'UNDER_18') return { error: fail('UNDER_18', 'Tickets are 18+ only.', { field: 'birth_date' }) };
    if (d.error) return { error: fail('BIRTH_DATE_INVALID', 'Check your date of birth.', { field: 'birth_date' }) };
    return { name, email, birth: d.value };
  }

  // Validates and prices the order here (the client's prices are never used), holds the capacity for 30 minutes and
  // creates a PENDING order. The client sends the total it showed: a different one gets 409 PRICE_CHANGED with the
  // event as it is now. An order with nothing to pay is confirmed straight away.
  app.post('/api/tickets/checkout', json, rateLimit(40, 60 * 60 * 1000), rateLimit(12, 60 * 60 * 1000, (req) => 'e:' + normalizeEmail(req.body?.buyer?.email)), async (req, res) => {
    const b = req.body || {};
    if (b.terms !== true) return bad(res, fail('TERMS_REQUIRED', 'Tick the box to agree to the terms.', { field: 'terms' }));
    const buyer = buyerInput(b.buyer);
    if (buyer.error) return bad(res, buyer.error);
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const ev = (await client.query('SELECT * FROM ticket_events WHERE slug = $1 FOR SHARE', [String(b.event || '').toLowerCase().slice(0, 60)])).rows[0];
      if (!ev || ev.status !== 'ON_SALE') { await client.query('ROLLBACK'); return bad(res, fail('EVENT_CLOSED', "Sales for this event are closed.")); }
      // The product rows stay locked until the order is saved, so parallel checkouts for the last tickets queue up.
      const cat = await loadCatalog(client, ev.id, { lock: true });
      const q = priceOrder(cat, ev, b.items);
      if (q.error) {
        await client.query('ROLLBACK');
        const status = ['SOLD_OUT', 'SALES_CLOSED', 'PRODUCT_UNAVAILABLE'].includes(q.error.code) ? 409 : 400;
        return bad(res, status === 409 ? { ...q.error, event: await eventPayload(pool, ev) } : q.error, status);
      }
      if (int(b.total_cents) !== q.total) {
        await client.query('ROLLBACK');
        return bad(res, fail('PRICE_CHANGED', `The price changed while you were choosing. The total is now ${money(q.total, q.currency)}.`, { total_cents: q.total, event: await eventPayload(pool, ev) }), 409);
      }
      // Card payments: in sandbox mode only testers can pay, and nobody can while PayPal isn't set up.
      if (q.dueNow > 0 && !paypalEnabledFor(buyer.email)) {
        await client.query('ROLLBACK');
        return bad(res, fail('PAYPAL_CLOSED', "Online payment isn't open yet. Check back soon."), 403);
      }
      let ref, o;
      for (let i = 0; i < 5 && !o; i++) {
        ref = newOrderRef();
        o = (await client.query(
          `INSERT INTO ticket_orders (ref, event_id, buyer_name, buyer_email, buyer_birth_date, subtotal_cents, fee_cents, total_cents,
             deposit_cents, currency, balance_due_at, terms_accepted_at, hold_until)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW() + make_interval(secs => $12))
           ON CONFLICT (ref) DO NOTHING RETURNING *`,
          [ref, ev.id, buyer.name, buyer.email, buyer.birth, q.subtotal, q.fee, q.total, q.dueNow, q.currency, q.balanceDueAt, HOLD_MS / 1000])).rows[0];
      }
      for (const l of q.lines) {
        await client.query(
          `INSERT INTO ticket_order_items (order_id, product_id, product_name, kind, qty, unit_cents, tier_id, tier_name, upgrades_cents, line_cents,
             deposit_cents, tickets_included, car_passes, selections) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [o.id, l.product.id, l.product.name, l.product.kind, l.qty, l.unit, l.tier?.id || null, l.tier?.name || null, l.upgrades, l.lineCents,
            l.deposit, l.product.tickets_included, l.product.kind === 'TABLE' ? l.product.car_passes : 0, JSON.stringify(l.selections)]);
      }
      let state = null;
      if (q.total === 0) state = await recordPayment(client, o, { kind: 'FULL', via: 'MANUAL', cents: 0, note: 'Free' });
      await client.query('COMMIT');
      if (state) await afterPaid(state, ref);
      const fresh = await orderByRef(pool, ref);
      res.json({ ref, s: orderSig(ref), order_url: orderUrl(ref), status: fresh.status, total_cents: q.total, due_now_cents: q.dueNow,
        currency: q.currency, usd_due: usd(usdCents(q.dueNow, q.currency)), hold_until: fresh.hold_until, balance_due_at: q.balanceDueAt,
        paypal: q.dueNow > 0 ? { client_id: PAYPAL_CLIENT_ID, currency: 'USD' } : null });
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      serverError(res, err);
    } finally { client?.release(); }
  });

  // PayPal, step 1: create the PayPal order for what's due now: the full price or a table's deposit (a PENDING order),
  // or the balance (a DEPOSIT_PAID order). Authorized by the order's signature. Also at /api/tickets/order/:ref/paypal/...,
  // which stay open while the ticket site is locked (paying a balance on an order already made).
  async function createOrder(req, res) {
    const ref = req.params.ref || req.body?.ref;
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const o = await orderByRef(client, ref, true);
      if (!o || !sigOk(req.body?.s, orderSig(o.ref))) { await client.query('ROLLBACK'); return bad(res, fail('NOT_FOUND', "That order link isn't right."), 404); }
      if (!paypalEnabledFor(o.buyer_email)) { await client.query('ROLLBACK'); return bad(res, fail('PAYPAL_CLOSED', "Online payment isn't open yet. Check back soon."), 403); }
      if (o.status === 'PAID') { await client.query('ROLLBACK'); return bad(res, fail('ALREADY_PAID', 'This order is already paid.'), 409); }
      if (!['PENDING', 'DEPOSIT_PAID'].includes(o.status)) { await client.query('ROLLBACK'); return bad(res, fail('CANCELLED', 'This order was cancelled, so there is nothing to pay.'), 410); }
      const purpose = o.status === 'DEPOSIT_PAID' ? 'BALANCE' : o.deposit_cents < o.total_cents ? 'DEPOSIT' : 'FULL';
      // An earlier PayPal payment for this step: finish it first, so nobody pays twice.
      if (o.paypal_order_id && o.paypal_status !== 'COMPLETED' && o.paypal_purpose === purpose) {
        const state = await settle(client, o);
        const stop = {
          PAID: fail('ALREADY_PAID', 'Your payment already went through.'), DEPOSIT: fail('ALREADY_PAID', 'Your deposit already went through.'),
          PENDING: fail('PENDING', "PayPal is still processing your earlier payment. We'll email you when it's confirmed."),
          MISMATCH: fail('CHECK', 'There is a problem with your earlier PayPal payment. Please contact us before paying again.')
        }[state];
        if (stop) { await client.query('COMMIT'); await afterPaid(state, o.ref); return bad(res, stop, 409); }
      }
      if (purpose === 'BALANCE' && o.balance_due_at && new Date(o.balance_due_at) < new Date()) {
        await client.query('ROLLBACK'); return bad(res, fail('BALANCE_LATE', 'The balance deadline has passed. Contact us.'), 410);
      }
      // A hold that ran out: only if the tickets are still free, and then it runs for another 30 minutes.
      if (o.status === 'PENDING' && new Date(o.hold_until) <= new Date() && o.paypal_status !== 'PENDING') {
        if (!(await holdStillFits(client, o))) {
          await client.query("UPDATE ticket_orders SET status = 'CANCELLED', cancelled_at = NOW(), cancel_reason = 'HOLD_EXPIRED' WHERE id = $1", [o.id]);
          await client.query('COMMIT');
          return bad(res, fail('HOLD_EXPIRED', 'Your 30 minutes ran out and those tickets have gone. Start again.'), 410);
        }
      }
      const due = purpose === 'BALANCE' ? o.total_cents - o.paid_cents : o.deposit_cents;
      const amount = usd(usdCents(due, o.currency));
      const ev = await eventById(client, o.event_id);
      const created = await paypalApi('POST', '/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: o.ref,
          invoice_id: purpose === 'BALANCE' ? `${o.ref}-BAL` : o.ref, // PayPal refuses a second completed payment with the same invoice id
          custom_id: 'T' + o.id,
          description: `${ev.name}: ${purpose === 'DEPOSIT' ? 'deposit' : purpose === 'BALANCE' ? 'balance' : 'tickets'}`.slice(0, 127),
          amount: { currency_code: 'USD', value: amount }
        }],
        application_context: { brand_name: "On D' Road Tickets", shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' }
      });
      if (!created.ok || !created.data.id) {
        await client.query('ROLLBACK');
        console.error('PayPal create order failed:', o.ref, created.status, JSON.stringify(created.data));
        return bad(res, fail('PAYPAL_DOWN', "PayPal isn't available right now. Try again in a minute."), 502);
      }
      await client.query(
        `UPDATE ticket_orders SET paypal_order_id = $2, paypal_amount = $3, paypal_status = 'CREATED', paypal_purpose = $4, paypal_due_cents = $5,
           paypal_started_at = NOW(), hold_until = CASE WHEN status = 'PENDING' THEN GREATEST(hold_until, NOW() + make_interval(secs => $6)) ELSE hold_until END
         WHERE id = $1`, [o.id, created.data.id, amount, purpose, due, HOLD_MS / 1000]);
      await client.query('COMMIT');
      res.json({ id: created.data.id, purpose, usd: amount });
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      serverError(res, err);
    } finally { client?.release(); }
  }

  // PayPal, step 2, once the buyer approves: capture, check PayPal took exactly what we asked, and record it. In full
  // (or the balance): PAID, the tickets are issued and emailed. A deposit: DEPOSIT_PAID and the balance email.
  async function capture(req, res) {
    const ref = req.params.ref || req.body?.ref;
    const ppId = String(req.body?.paypal_order_id || '').slice(0, 64);
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const o = await orderByRef(client, ref, true);
      if (!o || !sigOk(req.body?.s, orderSig(o.ref))) { await client.query('ROLLBACK'); return bad(res, fail('NOT_FOUND', "That order link isn't right."), 404); }
      if (o.paypal_order_id !== ppId || !ppId) {
        await client.query('ROLLBACK');
        if (o.status === 'PAID') return res.json({ success: true, status: o.status });
        return bad(res, fail('MISMATCH', "That payment doesn't match your order. Refresh the page and try again."));
      }
      if (o.paypal_status === 'COMPLETED') { await client.query('ROLLBACK'); return res.json({ success: true, status: o.status }); }
      const wanted = o.paypal_purpose === 'BALANCE' ? 'DEPOSIT_PAID' : 'PENDING';
      if (o.status !== wanted) {
        await client.query('ROLLBACK');
        return bad(res, fail('CANCELLED', 'This order was cancelled, so PayPal did not take the payment.'), 410);
      }
      if (o.status === 'PENDING' && new Date(o.hold_until) <= new Date() && !(await holdStillFits(client, o))) {
        await client.query("UPDATE ticket_orders SET status = 'CANCELLED', cancelled_at = NOW(), cancel_reason = 'HOLD_EXPIRED' WHERE id = $1", [o.id]);
        await client.query('COMMIT');
        return bad(res, fail('HOLD_EXPIRED', "Your 30 minutes ran out and those tickets have gone, so PayPal didn't take the payment. Start again."), 410);
      }
      let cap = await paypalApi('POST', `${orderPath(ppId)}/capture`, {});
      if (!cap.ok && paypalIssue(cap) === 'ORDER_ALREADY_CAPTURED') cap = await paypalApi('GET', orderPath(ppId));
      if (!cap.ok) {
        await client.query('ROLLBACK');
        console.error('PayPal capture failed:', o.ref, cap.status, JSON.stringify(cap.data));
        if (paypalIssue(cap) === 'INSTRUMENT_DECLINED') return bad(res, fail('DECLINED', 'PayPal declined that payment method. Try another one.'), 402);
        if (paypalIssue(cap) === 'DUPLICATE_INVOICE_ID') return bad(res, fail('CHECK', "PayPal says this was already paid, so it didn't charge you again. Contact us so we can confirm it."), 409);
        return bad(res, fail('FAILED', "The payment didn't go through, and you haven't been charged. Try again."), 502);
      }
      const state = await recordCapture(client, o, cap.data);
      await client.query('COMMIT');
      await afterPaid(state, o.ref);
      if (state === 'PAID' || state === 'DEPOSIT') return res.json({ success: true, status: state === 'PAID' ? 'PAID' : 'DEPOSIT_PAID' });
      if (state === 'PENDING') return res.json({ success: false, pending: true, message: "PayPal is still processing your payment. We'll email you as soon as it's confirmed." });
      if (state === 'MISMATCH') return bad(res, fail('CHECK', "Something didn't match on that payment, so your order isn't confirmed yet. Please contact us."), 502);
      bad(res, fail('FAILED', "The payment didn't go through. Try again."), 502);
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      console.error('PayPal capture error:', err);
      res.status(500).json({ error: "We couldn't confirm your payment yet. Refresh the page in a minute before trying again." });
    } finally { client?.release(); }
  }
  const payLimit = rateLimit(40, 60 * 60 * 1000);
  app.post('/api/tickets/paypal/create-order', json, payLimit, createOrder);
  app.post('/api/tickets/paypal/capture', json, payLimit, capture);
  app.post('/api/tickets/order/:ref/paypal/create-order', json, payLimit, createOrder);
  app.post('/api/tickets/order/:ref/paypal/capture', json, payLimit, capture);

  // The order page (?order=<ref>&s=<sig>): works while the ticket site is locked.
  app.get('/api/tickets/order/:ref', rateLimit(300, 15 * 60 * 1000), async (req, res) => {
    try {
      const o = await orderByRef(pool, req.params.ref);
      res.set('Cache-Control', 'no-store');
      if (!o || !sigOk(String(req.query.s || ''), orderSig(o.ref))) return bad(res, fail('NOT_FOUND', "That order link isn't right."), 404);
      res.json(await orderPage(pool, o));
    } catch (err) { serverError(res, err); }
  });

  // A single ticket's page (?ticket=<ref>&s=<sig>): what a friend gets after a transfer, and each ticket's own link.
  async function ticketPage(db, t) {
    const o = (await db.query('SELECT * FROM ticket_orders WHERE id = $1', [t.order_id])).rows[0];
    const ev = await eventById(db, o.event_id);
    return { ticket: ticketOut(t, o, { secret: true }), holder_name: t.holder_name, from_first_name: t.prev_id ? '' : firstName(o.buyer_name),
      event: eventOut(ev, { bought: true, paid: o.status === 'PAID' }), event_over: eventOver(ev), order_status: o.status };
  }
  app.get('/api/tickets/ticket/:ref', rateLimit(300, 15 * 60 * 1000), async (req, res) => {
    try {
      const t = (await pool.query('SELECT * FROM tickets WHERE ref = $1', [String(req.params.ref || '').toUpperCase().slice(0, 20)])).rows[0];
      res.set('Cache-Control', 'no-store');
      if (!t || !sigOk(String(req.query.s || ''), ticketSig(t.ref))) return bad(res, fail('NOT_FOUND', "That ticket link isn't right."), 404);
      res.json(await ticketPage(pool, t));
    } catch (err) { serverError(res, err); }
  });

  // Transfer: re-issues the ticket to a friend with a new ref and version, so the old link, secret and QR all stop
  // working. Not for a ticket that's been used, cancelled, or for an event that's over. One transfer per ticket a
  // minute (a ticket can't move again in its first minute), and per IP limits.
  app.post('/api/tickets/ticket/:ref/transfer', json, rateLimit(20, 60 * 60 * 1000), async (req, res) => {
    const b = req.body || {};
    const name = cleanName(b.name), email = normalizeEmail(b.email);
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const t = (await client.query('SELECT * FROM tickets WHERE ref = $1 FOR UPDATE', [String(req.params.ref || '').toUpperCase().slice(0, 20)])).rows[0];
      if (!t || !sigOk(b.s, ticketSig(t.ref))) { await client.query('ROLLBACK'); return bad(res, fail('NOT_FOUND', "That ticket link isn't right."), 404); }
      const o = (await client.query('SELECT * FROM ticket_orders WHERE id = $1', [t.order_id])).rows[0];
      const ev = await eventById(client, o.event_id);
      const no = (code, error, status = 409) => client.query('ROLLBACK').then(() => bad(res, fail(code, error), status));
      if (t.status === 'TRANSFERRED') return no('TRANSFERRED', 'This ticket was already transferred.');
      if (t.status !== 'VALID' || o.status !== 'PAID') return no('CANCELLED', "This ticket was cancelled, so it can't be transferred.");
      if (t.checked_in_at) return no('USED', "This ticket has been scanned at the door, so it can't be transferred.");
      if (eventOver(ev)) return no('EVENT_OVER', "This event is over, so tickets can't be transferred.");
      if (Date.now() - new Date(t.created_at).getTime() < 60 * 1000) return no('TOO_SOON', 'This ticket just moved. Wait a minute before transferring it again.', 429);
      if (!name) return no('NAME_INVALID', "Enter your friend's full name as it shows on their ID.", 400);
      if (!isValidEmail(email)) return no('EMAIL_INVALID', "Enter your friend's email address.", 400);
      if (email === String(t.holder_email).toLowerCase()) return no('SAME_EMAIL', "That's the email this ticket is already for.", 400);
      const fresh = (await client.query(
        `INSERT INTO tickets (order_id, item_id, ref, kind, label, version, holder_name, holder_email, prev_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [t.order_id, t.item_id, newTicketRef(), t.kind, t.label, t.version + 1, name, email, t.id])).rows[0];
      await client.query("UPDATE tickets SET status = 'TRANSFERRED', transferred_to_email = $2, transferred_at = NOW() WHERE id = $1", [t.id, email]);
      await client.query('COMMIT');
      const from = firstName(t.holder_name) || 'A friend';
      const err = await mail.send(email, `${from} sent you a ticket — ${ev.name}`, renderEmail({
        tone: 'good', tag: 'Ticket transferred to you', title: 'You have a ticket',
        brandTag: 'Tickets | 18+', site: 'tickets',
        lines: [`${from} sent you a ticket for ${ev.name}.`, "It's yours now, in your name. Open it on your phone at the door: the code on it changes every 30 seconds."],
        details: [['Event', ev.name], ['When', whenRange(ev.starts_at, ev.ends_at)], ['Ticket', fresh.label], ['Name', name]],
        cta: { text: 'Open your ticket', url: ticketUrl(fresh.ref), fallback: true },
        fine: "Screenshots won't work at the door; open your ticket on your phone. Bring photo ID that says " + name + '.'
      }));
      if (err) console.error('Transfer email failed:', fresh.ref);
      res.json({ success: true, transferred_to: maskEmail(email), emailed: !err });
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      serverError(res, err);
    } finally { client?.release(); }
  });

  // "Find my tickets": emails the links to every order bought with this email and every ticket transferred to it.
  // Always the same answer, so it can't be used to learn who bought tickets.
  app.post('/api/tickets/resend', json, rateLimit(10, 15 * 60 * 1000), rateLimit(3, 60 * 60 * 1000, (req) => 'e:' + normalizeEmail(req.body?.email)), async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) return bad(res, fail('EMAIL_INVALID', 'Enter the email you bought with.', { field: 'email' }));
    const generic = { success: true, message: "If that email has tickets, we've sent the links. Check your inbox in a minute." };
    try {
      const [orders, gifts] = await Promise.all([
        pool.query(`SELECT o.ref, o.status, e.name, e.starts_at FROM ticket_orders o JOIN ticket_events e ON e.id = o.event_id
          WHERE LOWER(o.buyer_email) = $1 AND o.status IN ('PAID', 'DEPOSIT_PAID') ORDER BY o.id DESC LIMIT 20`, [email]),
        pool.query(`SELECT t.ref, t.label, e.name FROM tickets t JOIN ticket_orders o ON o.id = t.order_id JOIN ticket_events e ON e.id = o.event_id
          WHERE LOWER(t.holder_email) = $1 AND t.prev_id IS NOT NULL AND t.status = 'VALID' AND o.status = 'PAID' ORDER BY t.id DESC LIMIT 20`, [email])
      ]);
      const links = [
        ...orders.rows.map((o) => [`${o.name} · order ${o.ref}${o.status === 'DEPOSIT_PAID' ? ' (balance due)' : ''}`, orderUrl(o.ref)]),
        ...gifts.rows.map((t) => [`${t.name} · ${t.label}`, ticketUrl(t.ref)])
      ];
      res.json(generic);
      if (!links.length) return;
      await mail.send(email, "Your tickets — On D' Road", renderEmail({
        tone: 'accent', tag: 'Find my tickets', title: 'Your tickets', brandTag: 'Tickets | 18+', site: 'tickets',
        lines: ['Here are the links to your tickets. Open them on your phone at the door.'],
        links,
        fine: "Screenshots won't work at the door; open your ticket on your phone. Didn't ask for this? You can ignore it."
      }));
    } catch (err) {
      console.error('Resend error:', err);
      if (!res.headersSent) res.json(generic);
    }
  });

  // Retired: tickets have no still QR image any more (the QR is live on the ticket page).
  app.get('/api/tickets/qr/:ref.png', (req, res) => res.status(410).type('text/plain').send('Open your live ticket on your phone.'));

  // ---------- Emails (no QR in any of them: the ticket page has the live one) ----------
  const SCREENSHOTS = "Screenshots won't work at the door; open your ticket on your phone.";
  const whereOf = (ev) => [ev.venue, ev.address].filter(Boolean).join(', ');
  function tableNotes(items, currency) {
    return items.filter((i) => i.kind === 'TABLE').map((i, n, all) => {
      const sel = i.selections || {};
      const rows = (sel.slots || []).map((s) => `- ${s.later ? `Decide later (${s.slot_label})` : `${s.name} (${s.tier_label || ''})`}${s.charge_cents ? ` · upgrade +${money(s.charge_cents, currency)}` : ''}`);
      const ch = (sel.chasers || []).map((c) => `- ${c.qty} × ${c.name}`);
      return { label: `${i.product_name}${all.length > 1 ? ' ' + (n + 1) : ''}`, text: [...(rows.length ? ['Bottles', ...rows] : []), ...(ch.length ? ['Chasers', ...ch] : ['Chasers: none'])].join('\n') };
    });
  }
  async function sendTicketsEmail(o) {
    const ev = await eventById(pool, o.event_id);
    const [items, tks] = await Promise.all([pool.query(ORDER_ITEMS_SQL, [o.id]), pool.query("SELECT * FROM tickets WHERE order_id = $1 AND prev_id IS NULL AND status = 'VALID' ORDER BY id", [o.id])]);
    const persons = tks.rows.filter((t) => t.kind === 'PERSON'), cars = tks.rows.filter((t) => t.kind === 'CAR');
    return mail.send(o.buyer_email, `Your tickets — ${ev.name}`, renderEmail({
      tone: 'good', tag: 'Tickets confirmed', title: "You're in. Here are your tickets.", brandTag: 'Tickets | 18+', site: 'tickets',
      preheader: `${persons.length} ${persons.length === 1 ? 'ticket' : 'tickets'} for ${ev.name}. Open them on your phone at the door.`,
      lines: [`${firstName(o.buyer_name)}, you're going to ${ev.name}.`,
        `You have ${persons.length} ${persons.length === 1 ? 'ticket' : 'tickets'}${cars.length ? ` and ${cars.length} car ${cars.length === 1 ? 'pass' : 'passes'}` : ''}. Open them on your phone at the door: the QR on each one changes every 30 seconds.`],
      details: [['Event', ev.name], ['When', whenRange(ev.starts_at, ev.ends_at)], ['Where', whereOf(ev)], ['Order', o.ref, true],
        ['Total', moneyBoth(o.total_cents, o.currency)]],
      ticketList: [{ label: 'Entry tickets', rows: persons.map((t) => t.label) }, { label: 'Car passes', rows: cars.map((t) => t.label) }].filter((g) => g.rows.length),
      callouts: [...tableNotes(items.rows, o.currency), ...(ev.buyer_info ? [{ label: 'Good to know', text: ev.buyer_info }] : [])],
      cta: { text: 'Open your tickets', url: orderUrl(o.ref), fallback: true },
      fine: `${SCREENSHOTS} Forward a ticket to a friend: each QR lets one person in. Use Transfer on your ticket page and they get their own ticket, in their name. Bring photo ID.`
    }));
  }
  async function sendDepositEmail(o) {
    const ev = await eventById(pool, o.event_id);
    const due = longDate(o.balance_due_at);
    return mail.send(o.buyer_email, `Deposit received — ${ev.name}`, renderEmail({
      tone: 'warn', tag: 'Deposit received', title: 'Your table is held', brandTag: 'Tickets | 18+', site: 'tickets',
      preheader: `Pay the balance by ${due} to keep your table.`,
      lines: [`${firstName(o.buyer_name)}, your deposit for ${ev.name} is in. Your table is held.`,
        'Pay the balance from your order page. Your tickets arrive as soon as the table is paid in full.'],
      details: [['Event', ev.name], ['Order', o.ref, true], ['Total', moneyBoth(o.total_cents, o.currency)], ['Deposit paid', moneyBoth(o.paid_cents, o.currency)],
        ['Balance', moneyBoth(o.total_cents - o.paid_cents, o.currency)], ['Pay by', due]],
      cta: { text: 'Pay your balance', url: orderUrl(o.ref), fallback: true },
      fine: `Deposits are non-refundable. If the balance isn't paid by ${due}, the booking is cancelled and the table goes back on sale.`
    }));
  }

  // ---------- The job: run by the payments job (payments.js) every 10 minutes, and by "Run checks now" ----------
  async function sweep() {
    const out = { settled: 0, released: 0, reminded: 0, cancelled: 0 };
    // 1. PayPal payments that went through without reaching us (page closed, lost answer), and ones PayPal is still
    //    holding, before anything is released.
    const due = await pool.query(
      `SELECT id FROM ticket_orders WHERE paypal_order_id IS NOT NULL AND paypal_status IN ('CREATED', 'PENDING')
         AND ((status = 'PENDING' AND paypal_purpose <> 'BALANCE' AND (hold_until < NOW() OR paypal_status = 'PENDING'))
           OR (status = 'DEPOSIT_PAID' AND paypal_purpose = 'BALANCE' AND (paypal_status = 'PENDING' OR balance_due_at < NOW() OR paypal_started_at < NOW() - INTERVAL '30 minutes')))
       ORDER BY id LIMIT 50`);
    for (const row of due.rows) {
      const client = await pool.connect();
      let state = null, ref = null;
      try {
        await client.query('BEGIN');
        const o = (await client.query('SELECT * FROM ticket_orders WHERE id = $1 FOR UPDATE', [row.id])).rows[0];
        ref = o.ref;
        // A hold that ran out is only captured now if the tickets are still free; money PayPal already took is recorded.
        const fits = o.status !== 'PENDING' || new Date(o.hold_until) > new Date() || await holdStillFits(client, o);
        state = await settle(client, o, { canCapture: fits });
        await client.query('COMMIT');
        if (state === 'PAID' || state === 'DEPOSIT') out.settled++;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Ticket PayPal check failed:', row.id, err.message);
      } finally { client.release(); }
      await afterPaid(state, ref);
    }
    // 2. Holds that ran out go back on sale (not while PayPal holds a payment, or took one for the wrong amount).
    const released = await pool.query(
      `UPDATE ticket_orders SET status = 'CANCELLED', cancelled_at = NOW(), cancel_reason = 'HOLD_EXPIRED'
       WHERE status = 'PENDING' AND hold_until < NOW() AND paypal_status IS DISTINCT FROM 'PENDING' AND paypal_status IS DISTINCT FROM 'AMOUNT_MISMATCH'
       RETURNING id`);
    out.released = released.rowCount;
    // 3. One reminder 48 hours before a balance is due (when the buyer had more than that).
    const remind = await pool.query(
      `UPDATE ticket_orders SET balance_reminder_at = NOW()
       WHERE status = 'DEPOSIT_PAID' AND balance_reminder_at IS NULL AND balance_due_at > NOW() AND balance_due_at - INTERVAL '48 hours' < NOW()
         AND balance_due_at - deposit_paid_at > INTERVAL '48 hours' RETURNING *`);
    for (const o of remind.rows) {
      const ev = await eventById(pool, o.event_id), when = longDate(o.balance_due_at);
      await mail.send(o.buyer_email, `Balance due soon — ${ev.name}`, renderEmail({
        tone: 'warn', tag: 'Balance reminder', title: 'Your balance is due', brandTag: 'Tickets | 18+', site: 'tickets',
        preheader: `Pay ${money(o.total_cents - o.paid_cents, o.currency)} by ${when} to keep your table.`,
        lines: [`The balance for your table at ${ev.name} is due on ${when}.`, "If it isn't paid by then, the booking is cancelled and the table goes back on sale."],
        details: [['Order', o.ref, true], ['Balance', moneyBoth(o.total_cents - o.paid_cents, o.currency)], ['Pay by', when]],
        cta: { text: 'Pay your balance', url: orderUrl(o.ref), fallback: true },
        fine: 'Deposits are non-refundable.'
      }));
      out.reminded++;
    }
    // 4. Balances not paid by the deadline: the booking is cancelled and the table released. The deposit is kept.
    const late = await pool.query(
      `UPDATE ticket_orders SET status = 'CANCELLED', cancelled_at = NOW(), cancel_reason = 'BALANCE_UNPAID'
       WHERE status = 'DEPOSIT_PAID' AND balance_due_at < NOW()
         AND NOT (paypal_purpose = 'BALANCE' AND paypal_status IN ('PENDING', 'AMOUNT_MISMATCH'))
         AND NOT (paypal_purpose = 'BALANCE' AND paypal_status = 'CREATED' AND paypal_started_at > NOW() - INTERVAL '30 minutes')
       RETURNING *`);
    for (const o of late.rows) {
      const ev = await eventById(pool, o.event_id);
      await mail.send(o.buyer_email, `Table released — ${ev.name}`, renderEmail({
        tone: 'bad', tag: 'Booking cancelled', title: 'Your table was released', brandTag: 'Tickets | 18+', site: 'tickets',
        lines: [`The balance for your table at ${ev.name} wasn't paid by the deadline, so the booking is cancelled and the table is back on sale.`,
          'Deposits are non-refundable. Think this is a mistake? Contact us.'],
        details: [['Order', o.ref, true], ['Deposit paid', moneyBoth(o.paid_cents, o.currency)]]
      }));
      out.cancelled++;
    }
    return out;
  }

  // ---------- Admin ----------
  const adminFail = (res, error, status = 400) => res.status(status).json({ error });
  const whenIn = (v) => { const w = parseWhen(v); return w === undefined ? undefined : w; }; // Date, null (blank) or undefined (bad)

  // Checks an event from the admin page. Only the fields sent change; returns { fields } or { error }.
  function eventInput(b, cur = {}) {
    const f = {};
    if (b.name !== undefined || !cur.id) {
      f.name = text(b.name, 80);
      if (!f.name) return { error: 'Give the event a name.' };
    }
    if (b.slug !== undefined || !cur.id) {
      f.slug = slugify(b.slug || f.name || cur.name);
      if (f.slug.length < 2) return { error: 'The link name needs at least 2 letters or numbers.' };
    }
    for (const k of ['starts_at', 'ends_at']) if (b[k] !== undefined) {
      const w = whenIn(b[k]);
      if (w === undefined) return { error: `${k === 'starts_at' ? 'The start' : 'The end'} isn't a real date and time.` };
      f[k] = w;
    }
    const starts = f.starts_at !== undefined ? f.starts_at : cur.starts_at, ends = f.ends_at !== undefined ? f.ends_at : cur.ends_at;
    if (starts && ends && new Date(ends) <= new Date(starts)) return { error: 'The end must be after the start.' };
    for (const [k, max] of [['venue', 120], ['address', 300], ['info', 8000], ['buyer_info', 8000], ['refund_policy', 4000]]) if (b[k] !== undefined) f[k] = text(b[k], max);
    if (b.poster !== undefined) {
      f.poster = text(b.poster, 500);
      if (!posterOk(f.poster)) return { error: 'The poster needs to be an https:// link, or a file in the ticket site like posters/fete.jpg.' };
    }
    if (b.show_location !== undefined) {
      if (!['PUBLIC', 'AFTER'].includes(b.show_location)) return { error: 'Choose when the location shows.' };
      f.show_location = b.show_location;
    }
    if (b.status !== undefined) {
      if (!EVENT_STATUSES.includes(b.status)) return { error: 'Choose a status.' };
      f.status = b.status;
    }
    if (b.sort_order !== undefined) { f.sort_order = int(b.sort_order); if (!Number.isInteger(f.sort_order) || Math.abs(f.sort_order) > 9999) return { error: 'Sort order is a whole number.' }; }
    if (b.fee_kind !== undefined) { if (!['NONE', 'FLAT', 'PERCENT'].includes(b.fee_kind)) return { error: 'Choose a service fee type.' }; f.fee_kind = b.fee_kind; }
    if (b.fee_cents !== undefined) { f.fee_cents = int(b.fee_cents); if (!(f.fee_cents >= 0 && f.fee_cents <= 100000)) return { error: 'The fee per ticket must be between 0 and 1,000.' }; }
    if (b.fee_percent !== undefined) { f.fee_percent = Number(b.fee_percent); if (!(f.fee_percent >= 0 && f.fee_percent <= 30)) return { error: 'The fee percent must be between 0 and 30.' }; }
    if ((f.status || cur.status) === 'ON_SALE' && !starts) return { error: 'Set the start date and time before putting the event on sale.' };
    return { fields: f };
  }

  // Checks a product. kind and event come from the existing row when editing.
  function productInput(b, cur, ev, labelsLen = 3) {
    const f = {}, kind = cur?.kind || b.kind;
    if (!['TICKET', 'TABLE'].includes(kind)) return { error: 'Choose a ticket or a table.' };
    if (!cur) f.kind = kind;
    const n = (k, min, max, msg) => { if (b[k] === undefined) return null; const v = int(b[k]); if (!(v >= min && v <= max)) return msg; f[k] = v; return null; };
    if (b.name !== undefined || !cur) { f.name = text(b.name, 80); if (!f.name) return { error: 'Give it a name.' }; }
    for (const [k, max] of [['description', 1000], ['includes', 140], ['perks', 1500]]) if (b[k] !== undefined) f[k] = text(b[k], max);
    let e = n('price_cents', 0, 10000000, 'Enter a price of 0 or more.') || n('max_per_order', 1, kind === 'TABLE' ? 10 : 50, `Max per order is 1 to ${kind === 'TABLE' ? 10 : 50}.`)
      || n('sort_order', -9999, 9999, 'Sort order is a whole number.');
    if (e) return { error: e };
    if (b.currency !== undefined) { if (!['XCD', 'USD'].includes(b.currency)) return { error: 'Choose XCD or USD.' }; f.currency = b.currency; }
    if (b.capacity !== undefined) {
      if (blank(b.capacity)) f.capacity = null;
      else { f.capacity = int(b.capacity); if (!(f.capacity >= 1 && f.capacity <= 100000)) return { error: 'Capacity is a whole number of 1 or more (or blank for no limit).' }; }
    }
    if (b.active !== undefined) f.active = !!b.active;
    if (b.sales_end !== undefined) { const w = whenIn(b.sales_end); if (w === undefined) return { error: "The sales end isn't a real date and time." }; f.sales_end = w; }
    if (kind === 'TICKET') {
      f.tickets_included = 1;
      if (!cur) Object.assign(f, { car_passes: 0, bottle_slots: '[]', chaser_points: 0, deposit_kind: 'NONE' });
      return { fields: f };
    }
    e = n('tickets_included', 1, 50, 'A table includes 1 to 50 tickets.') || n('car_passes', 0, 20, 'Car passes: 0 to 20.')
      || n('deposit_value', 0, 10000000, 'Enter the deposit as a number.') || n('balance_days', 1, 365, 'The balance is due 1 to 365 days after booking.');
    if (e) return { error: e };
    if (b.bottle_slots !== undefined) {
      const slots = Array.isArray(b.bottle_slots) ? b.bottle_slots.map(int) : null;
      if (!slots || slots.length > 10 || slots.some((t) => !(t >= 1 && t <= labelsLen))) return { error: 'Each bottle slot needs a tier (up to 10 slots).' };
      f.bottle_slots = JSON.stringify(slots);
    }
    if (b.slot_later !== undefined) f.slot_later = !!b.slot_later;
    if (b.chaser_points !== undefined) { f.chaser_points = Number(b.chaser_points); if (!(f.chaser_points >= 0 && f.chaser_points <= 1000) || pts(f.chaser_points) !== f.chaser_points * 100) return { error: 'Chaser points: 0 to 1000 (up to 2 decimals).' }; }
    if (b.deposit_kind !== undefined) { if (!['NONE', 'PERCENT', 'AMOUNT'].includes(b.deposit_kind)) return { error: 'Choose how the deposit works.' }; f.deposit_kind = b.deposit_kind; }
    const dk = f.deposit_kind || cur?.deposit_kind || 'NONE', dv = f.deposit_value ?? cur?.deposit_value ?? 0;
    if (dk === 'PERCENT' && !(dv >= 1 && dv <= 99)) return { error: 'A deposit percent is 1 to 99.' };
    if (dk === 'AMOUNT' && !(dv >= 1)) return { error: 'Enter the deposit amount.' };
    if (b.balance_rule !== undefined) { if (!['DAYS', 'DATE'].includes(b.balance_rule)) return { error: 'Choose when the balance is due.' }; f.balance_rule = b.balance_rule; }
    if (b.balance_date !== undefined) { const w = whenIn(b.balance_date); if (w === undefined) return { error: "The balance date isn't a real date and time." }; f.balance_date = w; }
    const rule = f.balance_rule || cur?.balance_rule || 'DAYS', date = f.balance_date !== undefined ? f.balance_date : cur?.balance_date;
    if (dk !== 'NONE' && rule === 'DATE') {
      if (!date) return { error: 'Pick the date the balance is due.' };
      if (ev.starts_at && new Date(date) > new Date(ev.starts_at)) return { error: 'The balance must be due before the event starts.' };
    }
    return { fields: f };
  }

  const setClause = (fields, start = 2) => Object.keys(fields).map((k, i) => `${k} = $${i + start}`).join(', ');
  const eventRow = (id) => pool.query('SELECT * FROM ticket_events WHERE id = $1', [id]).then((r) => r.rows[0]);

  // Per event: tickets sold (paid), on deposit, held (checkouts still running) and money received, per currency.
  async function eventStats(ids) {
    const r = await pool.query(
      `SELECT o.event_id,
         COALESCE(SUM(CASE WHEN o.status = 'PAID' THEN (SELECT COALESCE(SUM(i.qty * i.tickets_included), 0) FROM ticket_order_items i WHERE i.order_id = o.id) END), 0)::int AS tickets_sold,
         COUNT(*) FILTER (WHERE o.status = 'PAID')::int AS orders_paid,
         COUNT(*) FILTER (WHERE o.status = 'DEPOSIT_PAID')::int AS orders_deposit,
         COUNT(*) FILTER (WHERE o.status = 'PENDING' AND (o.hold_until > NOW() OR o.paypal_status IN ('PENDING', 'AMOUNT_MISMATCH')))::int AS orders_held,
         COALESCE(SUM(o.paid_cents) FILTER (WHERE o.status IN ('PAID', 'DEPOSIT_PAID', 'CANCELLED')), 0)::bigint AS received_cents,
         COALESCE(SUM(o.total_cents - o.paid_cents) FILTER (WHERE o.status = 'DEPOSIT_PAID'), 0)::bigint AS balance_cents,
         MAX(o.currency) AS currency
       FROM ticket_orders o WHERE o.event_id = ANY($1::int[]) GROUP BY o.event_id`, [ids]);
    const checked = await pool.query(
      `SELECT o.event_id, COUNT(*) FILTER (WHERE t.kind = 'PERSON')::int AS people, COUNT(*) FILTER (WHERE t.kind = 'CAR')::int AS cars
       FROM tickets t JOIN ticket_orders o ON o.id = t.order_id WHERE o.event_id = ANY($1::int[]) AND t.checked_in_at IS NOT NULL GROUP BY 1`, [ids]);
    const m = new Map(r.rows.map((x) => [x.event_id, { ...x, received_cents: Number(x.received_cents), balance_cents: Number(x.balance_cents) }]));
    for (const c of checked.rows) Object.assign(m.get(c.event_id) || {}, { checked_people: c.people, checked_cars: c.cars });
    return m;
  }

  app.get('/admin/tickets', requireAdmin, (req, res) => res.type('html').send(ticketsAdminPage({ TICKETS_URL, SITE_URL })));

  app.get('/api/admin/tickets/events', requireAdmin, async (req, res) => {
    try {
      const evs = (await pool.query('SELECT * FROM ticket_events ORDER BY sort_order, starts_at NULLS LAST, id')).rows;
      const st = await eventStats(evs.map((e) => e.id));
      res.json(evs.map((e) => ({ ...e, fee_percent: Number(e.fee_percent), when: whenRange(e.starts_at, e.ends_at), url: `${TICKETS_URL}/?e=${e.slug}`,
        stats: st.get(e.id) || { tickets_sold: 0, orders_paid: 0, orders_deposit: 0, orders_held: 0, received_cents: 0, balance_cents: 0, currency: null } })));
    } catch (err) { serverError(res, err); }
  });
  app.post('/api/admin/tickets/events', requireAdmin, adminJson, async (req, res) => {
    const v = eventInput(req.body || {});
    if (v.error) return adminFail(res, v.error);
    try {
      const keys = Object.keys(v.fields);
      const r = await pool.query(`INSERT INTO ticket_events (${keys.join(', ')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(', ')})
        ON CONFLICT (slug) DO NOTHING RETURNING *`, keys.map((k) => v.fields[k]));
      if (!r.rowCount) return adminFail(res, 'Another event already uses that link name. Pick another.', 409);
      res.json({ success: true, event: r.rows[0] });
    } catch (err) { serverError(res, err); }
  });
  app.post('/api/admin/tickets/events/:id', requireAdmin, adminJson, async (req, res) => {
    try {
      const cur = await eventRow(idOf(req.params.id));
      if (!cur) return adminFail(res, 'Event not found.', 404);
      const v = eventInput(req.body || {}, cur);
      if (v.error) return adminFail(res, v.error);
      if (!Object.keys(v.fields).length) return adminFail(res, 'Nothing to change.');
      const r = await pool.query(`UPDATE ticket_events SET ${setClause(v.fields)} WHERE id = $1 AND NOT EXISTS
        (SELECT 1 FROM ticket_events x WHERE x.slug = $${Object.keys(v.fields).length + 2} AND x.id <> $1) RETURNING *`,
        [cur.id, ...Object.values(v.fields), v.fields.slug || cur.slug]);
      if (!r.rowCount) return adminFail(res, 'Another event already uses that link name. Pick another.', 409);
      res.json({ success: true, event: r.rows[0] });
    } catch (err) { serverError(res, err); }
  });
  app.post('/api/admin/tickets/events/:id/delete', requireAdmin, adminJson, async (req, res) => {
    try {
      const id = idOf(req.params.id);
      if ((await pool.query('SELECT 1 FROM ticket_orders WHERE event_id = $1 LIMIT 1', [id])).rowCount) return adminFail(res, 'This event has orders, so it stays. Set it to Past instead.', 409);
      const r = await pool.query('DELETE FROM ticket_events WHERE id = $1', [id]);
      if (!r.rowCount) return adminFail(res, 'Event not found.', 404);
      res.json({ success: true });
    } catch (err) { serverError(res, err); }
  });

  // One event in full: products (with tiers and live numbers), money, and every order.
  app.get('/api/admin/tickets/events/:id', requireAdmin, async (req, res) => {
    try {
      const ev = await eventRow(idOf(req.params.id));
      if (!ev) return adminFail(res, 'Event not found.', 404);
      const cat = await loadCatalog(pool, ev.id);
      const counts = await pool.query(
        `SELECT i.product_id, COALESCE(SUM(i.qty) FILTER (WHERE o.status = 'PAID'), 0)::int AS sold,
           COALESCE(SUM(i.qty) FILTER (WHERE o.status = 'DEPOSIT_PAID'), 0)::int AS deposit,
           COALESCE(SUM(i.qty) FILTER (WHERE o.status = 'PENDING' AND (o.hold_until > NOW() OR o.paypal_status IN ('PENDING', 'AMOUNT_MISMATCH'))), 0)::int AS held,
           COUNT(*)::int AS items
         FROM ticket_order_items i JOIN ticket_orders o ON o.id = i.order_id WHERE o.event_id = $1 GROUP BY 1`, [ev.id]);
      const c = new Map(counts.rows.map((x) => [x.product_id, x]));
      const products = cat.products.map((p) => {
        const st = saleState(p, ev), n = c.get(p.id) || { sold: 0, deposit: 0, held: 0, items: 0 };
        return { ...p, chaser_points: Number(p.chaser_points), bottle_slots: p.slots, tiers: p.tiers, sold: n.sold, deposit: n.deposit, held: n.held,
          left: st.capLeft, price_now: st.price, tier_now: st.cur?.name || null, sold_out: st.soldOut, sales_closed: st.closed, has_orders: n.items > 0 };
      });
      const orders = (await pool.query('SELECT * FROM ticket_orders WHERE event_id = $1 ORDER BY id DESC', [ev.id])).rows;
      const ids = orders.map((o) => o.id);
      const [items, tks, pays] = await Promise.all([
        pool.query('SELECT * FROM ticket_order_items WHERE order_id = ANY($1::int[]) ORDER BY id', [ids]),
        pool.query('SELECT id, order_id, ref, kind, label, status, holder_name, holder_email, prev_id, transferred_to_email, transferred_at, checked_in_at, checked_in_by, created_at FROM tickets WHERE order_id = ANY($1::int[]) ORDER BY id', [ids]),
        pool.query('SELECT * FROM ticket_payments WHERE order_id = ANY($1::int[]) ORDER BY id', [ids])
      ]);
      const by = (rows, k) => rows.reduce((m, r) => m.set(r[k], [...(m.get(r[k]) || []), r]), new Map());
      const bi = by(items.rows, 'order_id'), bt = by(tks.rows, 'order_id'), bp = by(pays.rows, 'order_id');
      const st = (await eventStats([ev.id])).get(ev.id) || {};
      res.json({
        event: { ...ev, fee_percent: Number(ev.fee_percent), when: whenRange(ev.starts_at, ev.ends_at), url: `${TICKETS_URL}/?e=${ev.slug}` }, stats: st, products,
        orders: orders.map((o) => ({ ...o, held: o.status === 'PENDING' && (new Date(o.hold_until) > new Date() || ['PENDING', 'AMOUNT_MISMATCH'].includes(o.paypal_status)),
          items: bi.get(o.id) || [], tickets: bt.get(o.id) || [], payments: bp.get(o.id) || [], order_url: orderUrl(o.ref) })),
        tier_labels: cat.labels
      });
    } catch (err) { serverError(res, err); }
  });

  // Products, and their price tiers.
  async function eventOfProduct(pid) { return (await pool.query('SELECT e.* FROM ticket_events e JOIN ticket_products p ON p.event_id = e.id WHERE p.id = $1', [pid])).rows[0]; }
  async function currencyClash(eventId, currency, exceptId = 0) {
    return (await pool.query('SELECT 1 FROM ticket_products WHERE event_id = $1 AND currency <> $2 AND id <> $3 LIMIT 1', [eventId, currency, exceptId])).rowCount > 0;
  }
  app.post('/api/admin/tickets/products', requireAdmin, adminJson, async (req, res) => {
    try {
      const ev = await eventRow(idOf(req.body?.event_id));
      if (!ev) return adminFail(res, 'Event not found.', 404);
      const v = productInput(req.body || {}, null, ev);
      if (v.error) return adminFail(res, v.error);
      v.fields.event_id = ev.id;
      if (await currencyClash(ev.id, v.fields.currency || 'XCD')) return adminFail(res, "Every ticket and table of one event uses the same currency, so one order has one total.");
      const keys = Object.keys(v.fields);
      const r = await pool.query(`INSERT INTO ticket_products (${keys.join(', ')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING *`, keys.map((k) => v.fields[k]));
      res.json({ success: true, product: r.rows[0] });
    } catch (err) { serverError(res, err); }
  });
  app.post('/api/admin/tickets/products/:id', requireAdmin, adminJson, async (req, res) => {
    try {
      const cur = (await pool.query('SELECT * FROM ticket_products WHERE id = $1', [idOf(req.params.id)])).rows[0];
      if (!cur) return adminFail(res, 'Not found.', 404);
      const ev = await eventRow(cur.event_id);
      const v = productInput(req.body || {}, cur, ev);
      if (v.error) return adminFail(res, v.error);
      if (!Object.keys(v.fields).length) return adminFail(res, 'Nothing to change.');
      if (v.fields.currency && await currencyClash(ev.id, v.fields.currency, cur.id)) return adminFail(res, "Every ticket and table of one event uses the same currency, so one order has one total.");
      const r = await pool.query(`UPDATE ticket_products SET ${setClause(v.fields)} WHERE id = $1 RETURNING *`, [cur.id, ...Object.values(v.fields)]);
      res.json({ success: true, product: r.rows[0] });
    } catch (err) { serverError(res, err); }
  });
  app.post('/api/admin/tickets/products/:id/delete', requireAdmin, adminJson, async (req, res) => {
    try {
      const id = idOf(req.params.id);
      if ((await pool.query('SELECT 1 FROM ticket_order_items WHERE product_id = $1 LIMIT 1', [id])).rowCount) return adminFail(res, 'This has orders, so it stays. Hide it instead.', 409);
      const r = await pool.query('DELETE FROM ticket_products WHERE id = $1', [id]);
      if (!r.rowCount) return adminFail(res, 'Not found.', 404);
      res.json({ success: true });
    } catch (err) { serverError(res, err); }
  });
  function tierInput(b, isNew) {
    const f = {};
    if (b.name !== undefined || isNew) { f.name = text(b.name, 60); if (!f.name) return { error: 'Give the price a name, like Early bird.' }; }
    if (b.price_cents !== undefined || isNew) { f.price_cents = int(b.price_cents); if (!(f.price_cents >= 0 && f.price_cents <= 10000000)) return { error: 'Enter a price of 0 or more.' }; }
    if (b.ends_at !== undefined) { const w = whenIn(b.ends_at); if (w === undefined) return { error: "That end isn't a real date and time." }; f.ends_at = w; }
    if (b.quantity !== undefined) { f.quantity = blank(b.quantity) ? null : int(b.quantity); if (f.quantity !== null && !(f.quantity >= 1 && f.quantity <= 100000)) return { error: 'Quantity is a whole number (or blank for no limit).' }; }
    if (b.sort_order !== undefined) { f.sort_order = int(b.sort_order); if (!Number.isInteger(f.sort_order)) return { error: 'Sort order is a whole number.' }; }
    return { fields: f };
  }
  app.post('/api/admin/tickets/tiers', requireAdmin, adminJson, async (req, res) => {
    try {
      const pid = idOf(req.body?.product_id);
      if (!(await pool.query('SELECT 1 FROM ticket_products WHERE id = $1', [pid])).rowCount) return adminFail(res, 'Not found.', 404);
      const v = tierInput(req.body || {}, true);
      if (v.error) return adminFail(res, v.error);
      v.fields.product_id = pid;
      const keys = Object.keys(v.fields);
      const r = await pool.query(`INSERT INTO ticket_tiers (${keys.join(', ')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING *`, keys.map((k) => v.fields[k]));
      res.json({ success: true, tier: r.rows[0] });
    } catch (err) { serverError(res, err); }
  });
  app.post('/api/admin/tickets/tiers/:id', requireAdmin, adminJson, async (req, res) => {
    try {
      const v = tierInput(req.body || {}, false);
      if (v.error) return adminFail(res, v.error);
      if (!Object.keys(v.fields).length) return adminFail(res, 'Nothing to change.');
      const r = await pool.query(`UPDATE ticket_tiers SET ${setClause(v.fields)} WHERE id = $1 RETURNING *`, [idOf(req.params.id), ...Object.values(v.fields)]);
      if (!r.rowCount) return adminFail(res, 'Not found.', 404);
      res.json({ success: true, tier: r.rows[0] });
    } catch (err) { serverError(res, err); }
  });
  app.post('/api/admin/tickets/tiers/:id/delete', requireAdmin, adminJson, async (req, res) => {
    try {
      const r = await pool.query('DELETE FROM ticket_tiers WHERE id = $1', [idOf(req.params.id)]);
      if (!r.rowCount) return adminFail(res, 'Not found.', 404);
      res.json({ success: true });
    } catch (err) { serverError(res, err); }
  });

  // The menus: bottles, chaser groups and chasers, shared by every event, and the three bottle tier names.
  app.get('/api/admin/tickets/menus', requireAdmin, async (req, res) => {
    try {
      const [b, g, c, labels] = await Promise.all([pool.query('SELECT * FROM bottles ORDER BY tier, sort_order, id'), pool.query('SELECT * FROM chaser_groups ORDER BY sort_order, id'),
        pool.query('SELECT * FROM chasers ORDER BY sort_order, id'), tierLabels(pool)]);
      res.json({ bottles: b.rows, chaser_groups: g.rows.map((x) => ({ ...x, points: Number(x.points) })), chasers: c.rows, tier_labels: labels });
    } catch (err) { serverError(res, err); }
  });
  const MENU = {
    bottles: { table: 'bottles', check(b, isNew) {
      const f = {};
      if (b.name !== undefined || isNew) { f.name = text(b.name, 80); if (!f.name) return { error: 'Give the bottle a name.' }; }
      if (b.tier !== undefined || isNew) { f.tier = int(b.tier); if (!(f.tier >= 1 && f.tier <= 3)) return { error: 'Pick the tier.' }; }
      if (b.upgrade_cents !== undefined) { f.upgrade_cents = int(b.upgrade_cents); if (!(f.upgrade_cents >= 0 && f.upgrade_cents <= 10000000)) return { error: 'Enter the upgrade price (0 or more).' }; }
      if (b.active !== undefined) f.active = !!b.active;
      if (b.sort_order !== undefined) { f.sort_order = int(b.sort_order); if (!Number.isInteger(f.sort_order)) return { error: 'Sort order is a whole number.' }; }
      return { fields: f };
    } },
    'chaser-groups': { table: 'chaser_groups', check(b, isNew) {
      const f = {};
      if (b.name !== undefined || isNew) { f.name = text(b.name, 60); if (!f.name) return { error: 'Give the group a name, like Sodas.' }; }
      if (b.points !== undefined || isNew) { f.points = Number(b.points); if (!(f.points > 0 && f.points <= 100) || pts(f.points) !== f.points * 100) return { error: 'Points per chaser: more than 0, up to 100 (up to 2 decimals).' }; }
      if (b.sort_order !== undefined) { f.sort_order = int(b.sort_order); if (!Number.isInteger(f.sort_order)) return { error: 'Sort order is a whole number.' }; }
      return { fields: f };
    } },
    chasers: { table: 'chasers', check(b, isNew) {
      const f = {};
      if (isNew) { f.group_id = idOf(b.group_id); if (!f.group_id) return { error: 'Pick the group.' }; }
      if (b.name !== undefined || isNew) { f.name = text(b.name, 60); if (!f.name) return { error: 'Give the chaser a name.' }; }
      if (b.active !== undefined) f.active = !!b.active;
      if (b.sort_order !== undefined) { f.sort_order = int(b.sort_order); if (!Number.isInteger(f.sort_order)) return { error: 'Sort order is a whole number.' }; }
      return { fields: f };
    } }
  };
  for (const [path, m] of Object.entries(MENU)) {
    app.post(`/api/admin/tickets/${path}`, requireAdmin, adminJson, async (req, res) => {
      const v = m.check(req.body || {}, true);
      if (v.error) return adminFail(res, v.error);
      try {
        const keys = Object.keys(v.fields);
        const r = await pool.query(`INSERT INTO ${m.table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING *`, keys.map((k) => v.fields[k]));
        res.json({ success: true, item: r.rows[0] });
      } catch (err) {
        if (err.code === '23503') return adminFail(res, 'That group is gone. Reload the page.');
        serverError(res, err);
      }
    });
    app.post(`/api/admin/tickets/${path}/:id`, requireAdmin, adminJson, async (req, res) => {
      const v = m.check(req.body || {}, false);
      if (v.error) return adminFail(res, v.error);
      if (!Object.keys(v.fields).length) return adminFail(res, 'Nothing to change.');
      try {
        const r = await pool.query(`UPDATE ${m.table} SET ${setClause(v.fields)} WHERE id = $1 RETURNING *`, [idOf(req.params.id), ...Object.values(v.fields)]);
        if (!r.rowCount) return adminFail(res, 'Not found.', 404);
        res.json({ success: true, item: r.rows[0] });
      } catch (err) { serverError(res, err); }
    });
    // Orders keep a copy of what was picked (names and prices), so deleting a menu item never changes an order.
    app.post(`/api/admin/tickets/${path}/:id/delete`, requireAdmin, adminJson, async (req, res) => {
      try {
        const r = await pool.query(`DELETE FROM ${m.table} WHERE id = $1`, [idOf(req.params.id)]);
        if (!r.rowCount) return adminFail(res, 'Not found.', 404);
        res.json({ success: true });
      } catch (err) { serverError(res, err); }
    });
  }
  app.post('/api/admin/tickets/tier-labels', requireAdmin, adminJson, async (req, res) => {
    const l = Array.isArray(req.body?.labels) ? req.body.labels.map((x) => text(x, 30)) : [];
    if (l.length !== 3 || l.some((x) => !x)) return adminFail(res, 'Name all three tiers.');
    try {
      await pool.query("INSERT INTO settings (key, value) VALUES ('bottle_tier_labels', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(l)]);
      res.json({ success: true, tier_labels: l });
    } catch (err) { serverError(res, err); }
  });

  // Ticket terms.
  app.get('/api/admin/tickets/terms', requireAdmin, async (req, res) => {
    try { const s = await siteInfo(pool); res.json({ terms: s.terms, terms_updated_at: s.terms_updated_at, default_terms: DEFAULT_TICKET_TERMS }); } catch (err) { serverError(res, err); }
  });
  app.post('/api/admin/tickets/terms', requireAdmin, adminJson, async (req, res) => {
    const t = text(req.body?.terms, 20000);
    if (!t) return adminFail(res, "The terms can't be empty. Use the original draft to start again.");
    try {
      if (t === DEFAULT_TICKET_TERMS) await pool.query("DELETE FROM settings WHERE key IN ('tickets_terms', 'tickets_terms_updated_at')");
      else {
        await pool.query("INSERT INTO settings (key, value) VALUES ('tickets_terms', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [t]);
        await pool.query("INSERT INTO settings (key, value) VALUES ('tickets_terms_updated_at', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [new Date().toISOString()]);
      }
      const s = await siteInfo(pool);
      res.json({ success: true, terms: s.terms, terms_updated_at: s.terms_updated_at });
    } catch (err) { serverError(res, err); }
  });

  // Refund: every PayPal capture on the order is refunded through PayPal, one by one (so a part-paid table gets its
  // deposit back too). If PayPal refuses one, the order stays as it is and the captures already refunded are recorded,
  // so trying again carries on. Money paid by hand is listed for the organizers to give back themselves. Then the
  // order is REFUNDED and its tickets stop working.
  app.post('/api/admin/tickets/orders/:id/refund', requireAdmin, adminJson, async (req, res) => {
    try {
      const o = (await pool.query('SELECT * FROM ticket_orders WHERE id = $1', [idOf(req.params.id)])).rows[0];
      if (!o || !['PAID', 'DEPOSIT_PAID'].includes(o.status)) return adminFail(res, 'Only a paid order (or a paid deposit) can be refunded.');
      const pays = (await pool.query("SELECT * FROM ticket_payments WHERE order_id = $1 AND via = 'PAYPAL' AND refunded_at IS NULL ORDER BY id", [o.id])).rows;
      for (const p of pays) {
        const rf = await refundCapture(p.capture_id, o.ref);
        if (!rf.ok) return adminFail(res, `PayPal didn't accept the refund (${rf.error}), so the order wasn't changed${pays.indexOf(p) ? ' (the payments before it were refunded)' : ''}. Try again, or refund it in PayPal and then here.`, 502);
        await pool.query('UPDATE ticket_payments SET refund_id = $2, refunded_at = NOW() WHERE id = $1', [p.id, rf.id]);
      }
      const manual = (await pool.query("SELECT COALESCE(SUM(amount_cents), 0)::int AS c FROM ticket_payments WHERE order_id = $1 AND via = 'MANUAL'", [o.id])).rows[0].c;
      const r = await pool.query(`UPDATE ticket_orders SET status = 'REFUNDED', refunded_at = NOW() WHERE id = $1 AND status IN ('PAID', 'DEPOSIT_PAID') RETURNING *`, [o.id]);
      if (!r.rowCount) return adminFail(res, 'This order changed meanwhile. Reload the page.', 409);
      await pool.query("UPDATE tickets SET status = 'CANCELLED' WHERE order_id = $1 AND status = 'VALID'", [o.id]);
      const ev = await eventById(pool, o.event_id);
      const paypalCents = pays.reduce((a, p) => a + p.amount_cents, 0);
      const err = await mail.send(o.buyer_email, `Refund — ${ev.name}`, renderEmail({
        tone: 'good', tag: 'Refund', title: 'Your order is refunded', brandTag: 'Tickets | 18+', site: 'tickets',
        lines: [`Your order ${o.ref} for ${ev.name} is cancelled and refunded.`,
          paypalCents ? 'The money is going back to the card or PayPal account you paid with. It can take a few days to show.' : 'The organizers will contact you about the refund.',
          'Your tickets no longer work.'],
        details: [['Order', o.ref, true], ['Refund', moneyBoth(o.paid_cents, o.currency)]]
      }));
      res.json({ success: true, refunded_paypal_cents: paypalCents, manual_cents: manual, emailed: !err });
    } catch (err) { serverError(res, err); }
  });
  // The balance paid by hand (cash, bank transfer): the order is PAID and its tickets are issued and emailed.
  app.post('/api/admin/tickets/orders/:id/mark-paid', requireAdmin, adminJson, async (req, res) => {
    let client, state;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const o = (await client.query('SELECT * FROM ticket_orders WHERE id = $1 FOR UPDATE', [idOf(req.params.id)])).rows[0];
      if (!o || o.status !== 'DEPOSIT_PAID') { await client.query('ROLLBACK'); return adminFail(res, 'Only an order with its deposit paid has a balance to mark paid.'); }
      state = await recordPayment(client, o, { kind: 'BALANCE', via: 'MANUAL', cents: o.total_cents - o.paid_cents, note: text(req.body?.note, 200) });
      await client.query('COMMIT');
      await afterPaid(state, o.ref);
      res.json({ success: true, status: 'PAID' });
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      serverError(res, err);
    } finally { client?.release(); }
  });
  // A new balance deadline (in the future, and not after the event starts).
  app.post('/api/admin/tickets/orders/:id/balance-due', requireAdmin, adminJson, async (req, res) => {
    try {
      const o = (await pool.query('SELECT * FROM ticket_orders WHERE id = $1', [idOf(req.params.id)])).rows[0];
      if (!o || o.status !== 'DEPOSIT_PAID') return adminFail(res, 'Only an order with a balance to pay has a deadline.');
      const w = whenIn(req.body?.balance_due_at);
      if (!w) return adminFail(res, "That isn't a real date and time.");
      if (w <= new Date()) return adminFail(res, 'Pick a time in the future.');
      const ev = await eventById(pool, o.event_id);
      if (ev.starts_at && w > new Date(ev.starts_at)) return adminFail(res, 'The balance must be due before the event starts.');
      // A new deadline more than 48 hours away gets its own reminder.
      const r = await pool.query(`UPDATE ticket_orders SET balance_due_at = $2, balance_reminder_at = CASE WHEN $2::timestamptz - NOW() > INTERVAL '48 hours' THEN NULL ELSE balance_reminder_at END
        WHERE id = $1 RETURNING balance_due_at`, [o.id, w]);
      res.json({ success: true, balance_due_at: r.rows[0].balance_due_at });
    } catch (err) { serverError(res, err); }
  });
  app.post('/api/admin/tickets/run-jobs', requireAdmin, adminJson, async (req, res) => {
    try { res.json({ success: true, ...(await sweep()) }); } catch (err) { serverError(res, err); }
  });

  // The bar list: each paid (or deposit-paid) table with its bottles and chasers, and totals per bottle and chaser.
  async function barList(eventId) {
    const rows = (await pool.query(
      `SELECT o.ref, o.buyer_name, o.status, i.product_name, i.selections, i.id FROM ticket_order_items i JOIN ticket_orders o ON o.id = i.order_id
       WHERE o.event_id = $1 AND i.kind = 'TABLE' AND o.status IN ('PAID', 'DEPOSIT_PAID') ORDER BY i.product_name, o.id, i.id`, [eventId])).rows;
    const bottles = new Map(), chasers = new Map();
    const tables = rows.map((r) => {
      const sel = r.selections || {};
      for (const s of sel.slots || []) {
        const k = s.later ? `Decide later (${s.slot_label})` : s.name;
        const x = bottles.get(k) || { name: k, tier: s.later ? s.slot_label : s.tier_label, later: !!s.later, count: 0, upgrades: 0 };
        x.count++; if (s.charge_cents) x.upgrades++; bottles.set(k, x);
      }
      for (const c of sel.chasers || []) {
        const k = `${c.group}: ${c.name}`;
        const x = chasers.get(k) || { name: c.name, group: c.group, count: 0 };
        x.count += c.qty; chasers.set(k, x);
      }
      return { ref: r.ref, buyer: r.buyer_name, status: r.status, table: r.product_name, slots: sel.slots || [], chasers: sel.chasers || [] };
    });
    return { tables, bottle_totals: [...bottles.values()].sort((a, b) => a.later - b.later || b.count - a.count), chaser_totals: [...chasers.values()].sort((a, b) => a.group.localeCompare(b.group) || b.count - a.count) };
  }
  // A cell starting with = + - @ (or a tab or return) would run as a formula in Excel or Sheets, so it gets a leading '.
  const csv = (rows) => '﻿' + rows.map((r) => r.map((v) => {
    let s = String(v ?? '');
    if (s && '=+-@\t\r'.includes(s[0])) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }).join(',')).join('\n');
  const sendCsv = (res, name, rows) => res.type('text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${name}"`).send(csv(rows));
  app.get('/api/admin/tickets/events/:id/bar-list', requireAdmin, async (req, res) => {
    try { const ev = await eventRow(idOf(req.params.id)); if (!ev) return adminFail(res, 'Event not found.', 404); res.json({ event: { id: ev.id, name: ev.name, when: whenRange(ev.starts_at, ev.ends_at) }, ...(await barList(ev.id)) }); } catch (err) { serverError(res, err); }
  });
  app.get('/api/admin/tickets/events/:id/bar-list.csv', requireAdmin, async (req, res) => {
    try {
      const ev = await eventRow(idOf(req.params.id)); if (!ev) return adminFail(res, 'Event not found.', 404);
      const b = await barList(ev.id);
      const rows = [['section', 'reference', 'buyer', 'table', 'status', 'item', 'tier', 'quantity', 'upgrade']];
      for (const t of b.tables) {
        for (const s of t.slots) rows.push(['table', t.ref, t.buyer, t.table, t.status === 'PAID' ? 'paid' : 'deposit paid', s.later ? 'Decide later' : s.name, s.later ? s.slot_label : s.tier_label, 1, s.charge_cents ? (s.charge_cents / 100).toFixed(2) : '']);
        for (const c of t.chasers) rows.push(['table', t.ref, t.buyer, t.table, t.status === 'PAID' ? 'paid' : 'deposit paid', `${c.group}: ${c.name}`, '', c.qty, '']);
      }
      for (const x of b.bottle_totals) rows.push(['bottle total', '', '', '', '', x.name, x.tier, x.count, x.upgrades ? `${x.upgrades} upgraded` : '']);
      for (const x of b.chaser_totals) rows.push(['chaser total', '', '', '', '', `${x.group}: ${x.name}`, '', x.count, '']);
      sendCsv(res, `bar-list-${ev.slug}.csv`, rows);
    } catch (err) { serverError(res, err); }
  });
  app.get('/admin/tickets/events/:id/bar-list', requireAdmin, async (req, res) => {
    try {
      const ev = await eventRow(idOf(req.params.id)); if (!ev) return res.status(404).send('Event not found.');
      res.type('html').send(barListPage({ event: { name: ev.name, when: whenRange(ev.starts_at, ev.ends_at), id: ev.id }, ...(await barList(ev.id)) }));
    } catch (err) { serverError(res, err); }
  });
  // The door list: every ticket of the event, for a backup list on paper.
  app.get('/api/admin/tickets/events/:id/door.csv', requireAdmin, async (req, res) => {
    try {
      const ev = await eventRow(idOf(req.params.id)); if (!ev) return adminFail(res, 'Event not found.', 404);
      const r = await pool.query(
        `SELECT t.ref, t.kind, t.label, t.status, t.holder_name, t.holder_email, t.checked_in_at, t.checked_in_by, o.ref AS order_ref, o.buyer_name, o.status AS order_status
         FROM tickets t JOIN ticket_orders o ON o.id = t.order_id WHERE o.event_id = $1 ORDER BY t.kind DESC, t.label, t.id`, [ev.id]);
      sendCsv(res, `door-list-${ev.slug}.csv`, [['ticket', 'kind', 'label', 'status', 'name', 'email', 'order', 'buyer', 'checked_in_at', 'checked_in_by'],
        ...r.rows.map((t) => [t.ref, t.kind === 'CAR' ? 'car pass' : 'person', t.label, t.order_status === 'PAID' ? t.status : 'CANCELLED', t.holder_name, t.holder_email, t.order_ref, t.buyer_name, t.checked_in_at ? new Date(t.checked_in_at).toISOString() : '', t.checked_in_by || ''])]);
    } catch (err) { serverError(res, err); }
  });
  // The door log of one ticket event (the Command Center's Door tab and /admin/tickets).
  app.get('/api/admin/ticket-checkins', requireAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT c.id, c.kind, c.device, c.scanned_at, c.synced_at, t.ref, t.kind AS ticket_kind, t.label, o.ref AS order_ref, o.event_id
         FROM ticket_checkins c JOIN tickets t ON t.id = c.ticket_id JOIN ticket_orders o ON o.id = t.order_id
         WHERE o.event_id = $1 ORDER BY c.scanned_at DESC, c.id DESC LIMIT 1000`, [idOf(req.query.event)]);
      res.json(r.rows);
    } catch (err) { serverError(res, err); }
  });
  // Everything of the ticket site, for the Reset page's "Download a copy first".
  app.get('/api/admin/tickets/export', requireAdmin, async (req, res) => {
    try {
      const q = (t) => pool.query(`SELECT * FROM ${t} ORDER BY id`).then((r) => r.rows);
      const [events, products, tiers, orders, items, payments, tks, checkins, bottles, groups, chasers] = await Promise.all(
        ['ticket_events', 'ticket_products', 'ticket_tiers', 'ticket_orders', 'ticket_order_items', 'ticket_payments', 'tickets', 'ticket_checkins', 'bottles', 'chaser_groups', 'chasers'].map(q));
      res.json({ events, products, tiers, orders, items, payments, tickets: tks, checkins, menus: { bottles, chaser_groups: groups, chasers }, tier_labels: await tierLabels(pool) });
    } catch (err) { serverError(res, err); }
  });
  // For the Command Center: the ticket site's lock and the tickets paid for today (Antigua's day).
  app.get('/api/admin/tickets/summary', requireAdmin, async (req, res) => {
    try {
      const [locked, r] = await Promise.all([lock.lockedNow(), pool.query(
        `SELECT COALESCE(SUM(i.qty * i.tickets_included), 0)::int AS sold FROM ticket_order_items i JOIN ticket_orders o ON o.id = i.order_id
         WHERE o.status = 'PAID' AND (o.paid_at AT TIME ZONE 'America/Antigua')::date = (NOW() AT TIME ZONE 'America/Antigua')::date`)]);
      const on = await pool.query("SELECT COUNT(*)::int AS n FROM ticket_events WHERE status = 'ON_SALE'");
      res.json({ locked, sold_today: r.rows[0].sold, on_sale: on.rows[0].n });
    } catch (err) { serverError(res, err); }
  });

  return { lock, sweep };
}

// ---------- The door (door.js uses this for ticket events) ----------
// A ticket event at the door: on sale or closed, starting within the next 2 days or ended within the last 2.
// The door list carries each valid ticket's live-QR secret (behind DOOR_KEY), so phones check codes offline. Names
// (the holder's, and the buyer's) are only for the scanner's "Look up" fallback, never shown on a normal scan.
export function createTicketDoor({ pool, TOKEN_SECRET }) {
  const secretOf = (t) => qrSecret(TOKEN_SECRET, t.ref, t.version);
  const TICKET_SQL = `SELECT t.id, t.ref, t.kind, t.label, t.version, t.status AS tstatus, t.checked_in_at, t.checked_in_by, t.holder_name,
      o.buyer_name, o.status AS ostatus, o.event_id
    FROM tickets t JOIN ticket_orders o ON o.id = t.order_id`;
  const passOf = (r) => {
    const status = r.tstatus === 'TRANSFERRED' ? 'TRANSFERRED' : r.tstatus === 'VALID' && r.ostatus === 'PAID' ? 'VALID' : 'CANCELLED';
    return { ref: r.ref, kind: r.kind, label: r.label, status, checked_in_at: r.checked_in_at, checked_in_by: r.checked_in_by, event_id: r.event_id,
      ...(status === 'VALID' ? { secret: secretOf(r), name: r.holder_name || r.buyer_name, buyer: r.buyer_name } : {}) };
  };
  async function events() {
    return (await pool.query(
      `SELECT id, name, starts_at, ends_at, status FROM ticket_events WHERE status IN ('ON_SALE', 'CLOSED') AND starts_at IS NOT NULL
         AND starts_at < NOW() + INTERVAL '2 days' AND COALESCE(ends_at, starts_at) > NOW() - INTERVAL '2 days' ORDER BY starts_at, id`)).rows
      .map((e) => ({ ...e, when: whenRange(e.starts_at, e.ends_at) }));
  }
  async function list(eventId) {
    const ev = (await pool.query('SELECT id, name, starts_at, ends_at FROM ticket_events WHERE id = $1', [eventId])).rows[0];
    if (!ev) return null;
    const r = await pool.query(`${TICKET_SQL} WHERE o.event_id = $1 AND o.status IN ('PAID', 'REFUNDED', 'CANCELLED') ORDER BY t.id`, [eventId]);
    return { generated_at: new Date().toISOString(), event: { ...ev, when: whenRange(ev.starts_at, ev.ends_at) }, tickets: r.rows.map(passOf) };
  }
  const record = (ticketId, kind, clientId, device, at) => pool.query(
    'INSERT INTO ticket_checkins (ticket_id, kind, client_id, device, scanned_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (client_id) DO NOTHING',
    [ticketId, kind, clientId, device, at]);
  const REPLAY = { ENTRY: 'ADMIT', MANUAL: 'ADMIT', OVERRIDE: 'ADMIT', UNDO: 'UNDONE', DUPLICATE: 'ALREADY' };
  // One ticket scan: { ref, code, kind: ENTRY | MANUAL | UNDO | OVERRIDE, event_id, client_id, device }, at = the scan
  // time (already checked by door.js). ENTRY needs the live code (this step, plus or minus 2, at the scan time or now);
  // MANUAL is staff letting someone in after checking their photo ID (Look up). Safe to repeat (client_id).
  async function applyScan(ev, at) {
    const kind = ['ENTRY', 'MANUAL', 'UNDO', 'OVERRIDE'].includes(ev?.kind) ? ev.kind : 'ENTRY';
    const ref = String(ev?.ref || '').trim().toUpperCase().slice(0, 20);
    const clientId = ev?.client_id ? String(ev.client_id).slice(0, 64) : null;
    const device = String(ev?.device || '').trim().slice(0, 40) || 'Door';
    if (!ref) return { result: 'NOT_FOUND' };
    const r = (await pool.query(`${TICKET_SQL} WHERE t.ref = $1`, [ref])).rows[0];
    if (!r) return { result: 'NOT_FOUND' };
    if (Number(ev.event_id) !== r.event_id) {
      const theirs = (await pool.query('SELECT name FROM ticket_events WHERE id = $1', [r.event_id])).rows[0];
      return { result: 'OTHER_EVENT', event_name: theirs ? theirs.name : null };
    }
    const pass = passOf(r);
    if (clientId) {
      const seen = await pool.query('SELECT kind FROM ticket_checkins WHERE client_id = $1', [clientId]);
      if (seen.rowCount) return { result: REPLAY[seen.rows[0].kind] || 'ADMIT', override: seen.rows[0].kind === 'OVERRIDE', manual: seen.rows[0].kind === 'MANUAL', pass, replay: true };
    }
    if (kind === 'UNDO') {
      await pool.query('UPDATE tickets SET checked_in_at = NULL, checked_in_by = NULL WHERE id = $1', [r.id]);
      await record(r.id, 'UNDO', clientId, device, at);
      return { result: 'UNDONE', pass: { ...pass, checked_in_at: null, checked_in_by: null } };
    }
    if (pass.status === 'TRANSFERRED') return { result: 'TRANSFERRED', pass };
    if (pass.status !== 'VALID') return { result: 'CANCELLED', pass };
    if (kind === 'ENTRY' && !codeOk(pass.secret, ev.code, at.getTime(), Date.now())) return { result: 'STALE', pass: { ref: pass.ref, kind: pass.kind, label: pass.label } };
    if (kind === 'OVERRIDE') {
      await record(r.id, 'OVERRIDE', clientId, device, at);
      return { result: 'ADMIT', override: true, pass };
    }
    const won = await pool.query(
      `UPDATE tickets SET checked_in_at = $2, checked_in_by = $3 WHERE id = $1 AND checked_in_at IS NULL AND status = 'VALID'
         AND (SELECT status FROM ticket_orders WHERE id = tickets.order_id) = 'PAID' RETURNING checked_in_at, checked_in_by`, [r.id, at, device]);
    if (won.rowCount) {
      await record(r.id, kind, clientId, device, at);
      return { result: 'ADMIT', manual: kind === 'MANUAL', pass: { ...pass, ...won.rows[0] } };
    }
    const now = (await pool.query(`${TICKET_SQL} WHERE t.id = $1`, [r.id])).rows[0];
    const p2 = passOf(now);
    if (p2.status === 'TRANSFERRED') return { result: 'TRANSFERRED', pass: p2 };
    if (p2.status !== 'VALID') return { result: 'CANCELLED', pass: p2 };
    await record(r.id, 'DUPLICATE', clientId, device, at);
    return { result: 'ALREADY', pass: p2 };
  }
  return { events, list, applyScan };
}
