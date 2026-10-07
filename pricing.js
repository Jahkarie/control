// pricing.js: price tiers and promo codes.
// A package can have tiers (Early bird, Standard, Late...). Guests pay the first tier that hasn't ended or sold out;
// when every tier has, the package's sales are closed. A package without tiers costs its own price.
// Promo codes take a percent or an amount off, or make the pass free. Each order stores what it costs (tier, list
// price, discount, amount, code; see /api/orders in server.js), so changing a tier or a code never changes existing
// orders. An order that a code makes free is confirmed straight away (paid_via = 'COMP').
// The package_tiers and promo_codes tables are created by ensureSchema() in server.js.

const HOUR_MS = 60 * 60 * 1000;
const KINDS = ['PERCENT', 'AMOUNT', 'FREE'];

export const cleanCode = (v) => String(v || '').trim().toUpperCase();
export const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,23}$/;

// A whole number from a JSON number or a string of digits, else NaN (same as toInt in server.js).
const toInt = (v) => (typeof v === 'number' || (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) ? Number(v) : NaN);
const blank = (v) => v === null || v === undefined || v === '';
const money = (cents, cur) => (cur || 'XCD') + ' ' + (cents / 100).toFixed(2);

// '2026-10-10T18:00' or a full ISO date -> Date. A date without a time zone is Antigua time (UTC-4 all year).
// Returns null for blank, undefined for anything that isn't a real date.
const WHEN_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?)?(Z|[+-]\d{2}:\d{2})?$/;
function parseWhen(v) {
  if (blank(v)) return null;
  const m = typeof v === 'string' && WHEN_RE.exec(v.trim());
  if (!m) return undefined;
  const [, y, mo, d, h = '00', mi = '00', s = '00', zone = '-04:00'] = m;
  const day = new Date(Date.UTC(+y, +mo - 1, +d)); // catches Feb 30, which Date would roll over to March
  if (+y < 2000 || +y > 2100 || day.getUTCMonth() !== +mo - 1 || +h > 23 || +mi > 59 || +s > 59) return undefined;
  const at = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${zone}`);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

// ---------- Tiers ----------

// Tiers with how many non-cancelled orders each has, for the given package ids. db = pool or a client.
// Returns Map(packageId -> array sorted by sort_order, id) of
//   { id, package_id, name, price_cents, ends_at: Date|null, quantity: number|null, sold: number, sort_order }
export async function loadTiers(db, packageIds) {
  const ids = [...new Set(packageIds.map(Number))].filter(Number.isInteger);
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const r = await db.query(
    `SELECT t.id, t.package_id, t.name, t.price_cents, t.ends_at, t.quantity, t.sort_order,
            (SELECT COUNT(*) FROM orders o WHERE o.tier_id = t.id AND o.status <> 'CANCELLED')::int AS sold
     FROM package_tiers t WHERE t.package_id = ANY($1::int[]) ORDER BY t.package_id, t.sort_order, t.id`, [ids]);
  for (const t of r.rows) out.get(t.package_id).push(t);
  return out;
}

const ended = (t, now) => !blank(t.ends_at) && new Date(t.ends_at) <= now;
const soldOut = (t) => !blank(t.quantity) && (t.sold || 0) >= t.quantity;
const onSale = (t, now) => !ended(t, now) && !soldOut(t);

// Pure. The tier on sale now: the first (in order) that hasn't ended or sold out. null if none.
export function currentTier(tiers, now = new Date()) {
  return (tiers || []).find((t) => onSale(t, now)) || null;
}

// Pure. What a package costs right now.
//   no tiers:            { tier: null, next: null, list_cents: pkg.price_cents, closed: false }
//   tiers, one current:  { tier, next: the next tier after it still on sale (or null), list_cents: tier.price_cents, closed: false }
//   tiers, none current: { tier: null, next: null, list_cents: null, closed: true }
export function priceOf(pkg, tiers, now = new Date()) {
  if (!tiers || !tiers.length) return { tier: null, next: null, list_cents: pkg.price_cents, closed: false };
  const i = tiers.findIndex((t) => onSale(t, now));
  if (i < 0) return { tier: null, next: null, list_cents: null, closed: true };
  const next = tiers.slice(i + 1).find((t) => onSale(t, now)) || null;
  return { tier: tiers[i], next, list_cents: tiers[i].price_cents, closed: false };
}

// Pure. The same tiers, each with state: 'CURRENT' | 'UPCOMING' | 'ENDED' | 'SOLD_OUT' (ENDED wins over SOLD_OUT).
export function withStates(tiers, now = new Date()) {
  const cur = currentTier(tiers, now);
  return (tiers || []).map((t) => ({
    ...t, state: ended(t, now) ? 'ENDED' : soldOut(t) ? 'SOLD_OUT' : t === cur ? 'CURRENT' : 'UPCOMING'
  }));
}

// ---------- Promo codes ----------

// Checks a code for a package. With lock: true it locks the code's row (call it inside a transaction), so two
// guests can't both take its last use. Uses = orders with this code that aren't cancelled, not counting
// excludeOrderId (the guest's own order, when they re-apply a code). Returns { promo } or { error } (guest-facing).
export async function checkPromo(db, code, packageId, { lock = false, excludeOrderId = null } = {}) {
  const c = cleanCode(code);
  if (!CODE_RE.test(c)) return { error: "That code isn't valid." };
  const r = await db.query(
    `SELECT code, kind, value, package_id, max_uses, expires_at, active, note FROM promo_codes WHERE code = $1${lock ? ' FOR UPDATE' : ''}`, [c]);
  const p = r.rows[0];
  if (!p || !p.active) return { error: "That code isn't valid." };
  if (p.expires_at && new Date(p.expires_at) <= new Date()) return { error: 'That code has expired.' };
  if (p.package_id !== null && p.package_id !== Number(packageId)) return { error: "That code doesn't work for this package." };
  const u = await db.query(
    "SELECT COUNT(*)::int AS n FROM orders WHERE promo_code = $1 AND status <> 'CANCELLED' AND ($2::int IS NULL OR id <> $2::int)",
    [c, excludeOrderId]);
  const uses = u.rows[0].n;
  if (p.max_uses !== null && uses >= p.max_uses) return { error: 'That code has been used up.' };
  return { promo: { ...p, uses } };
}

// Pure. Cents off a list price: PERCENT rounds to the cent, AMOUNT is capped at the list price, FREE is all of it.
// Never more than list, never negative.
export function discountFor(promo, listCents) {
  const list = Math.max(0, Math.round(Number(listCents) || 0));
  const value = Number(promo?.value) || 0;
  const off = promo?.kind === 'PERCENT' ? Math.round((list * value) / 100)
    : promo?.kind === 'AMOUNT' ? Math.min(value, list)
    : promo?.kind === 'FREE' ? list : 0;
  return Math.max(0, Math.min(list, off));
}

// Pure. "20% off", "XCD 50.00 off" (in the given currency; no currency gives "50.00 off") or "Free pass".
export function promoLabel(promo, currency) {
  const value = Number(promo?.value) || 0;
  if (promo?.kind === 'PERCENT') return `${value}% off`;
  if (promo?.kind === 'AMOUNT') return `${currency ? currency + ' ' : ''}${(value / 100).toFixed(2)} off`;
  if (promo?.kind === 'FREE') return 'Free pass';
  return '';
}

// ---------- Admin input ----------

// Tier fields from an admin request: all of them (create), or only those sent (partial edit).
// Returns { fields } or { error }. Bad input is refused, never turned into 0.
function tierInput(b, partial) {
  const f = {};
  const has = (k) => !partial || Object.hasOwn(b, k);
  if (has('name')) {
    f.name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!f.name || f.name.length > 40) return { error: 'Give the tier a name of up to 40 characters.' };
  }
  if (has('price_cents')) {
    f.price_cents = toInt(b.price_cents);
    if (!(Number.isInteger(f.price_cents) && f.price_cents >= 0 && f.price_cents <= 10000000)) return { error: 'Enter a valid price.' };
  }
  if (has('ends_at')) {
    f.ends_at = parseWhen(b.ends_at);
    if (f.ends_at === undefined) return { error: 'Enter a valid end date, or leave it blank for none.' };
  }
  if (has('quantity')) {
    f.quantity = blank(b.quantity) ? null : toInt(b.quantity);
    if (f.quantity !== null && !(Number.isInteger(f.quantity) && f.quantity >= 1 && f.quantity <= 100000)) {
      return { error: 'Quantity must be a whole number from 1 to 100,000, or blank for no limit.' };
    }
  }
  return { fields: f };
}

// The promo code fields that can change after it's created; only those sent. Returns { fields } or { error }.
function promoEdits(b) {
  const f = {};
  if (Object.hasOwn(b, 'active')) f.active = !!b.active;
  if (Object.hasOwn(b, 'max_uses')) {
    f.max_uses = blank(b.max_uses) ? null : toInt(b.max_uses);
    if (f.max_uses !== null && !(Number.isInteger(f.max_uses) && f.max_uses >= 1 && f.max_uses <= 100000)) {
      return { error: 'Max uses must be a whole number from 1 to 100,000, or blank for no limit.' };
    }
  }
  if (Object.hasOwn(b, 'expires_at')) {
    f.expires_at = parseWhen(b.expires_at);
    if (f.expires_at === undefined) return { error: 'Enter a valid expiry date, or leave it blank for never.' };
  }
  if (Object.hasOwn(b, 'note')) {
    f.note = blank(b.note) ? '' : typeof b.note === 'string' ? b.note.trim() : null;
    if (f.note === null || f.note.length > 200) return { error: 'Keep the note to 200 characters or fewer.' };
  }
  return { fields: f };
}

// Routes. onComp(order) is called after a code makes an existing reservation free (the order is then PAID);
// order has { guest_email, package_name, reference_code }.
export function registerPricing({ app, pool, requireAuth, requireAdmin, rateLimit, perUser, onComp }) {
  const fail = (res, err) => { console.error(err); res.status(500).json({ error: 'Server error.' }); };
  const invalid = (res, error) => res.status(400).json({ error, code: 'PROMO_INVALID' });

  // ---------- Guest ----------

  // What a code takes off a package at today's price, before reserving.
  app.post('/api/promo/check', requireAuth, rateLimit(30, HOUR_MS, perUser), async (req, res) => {
    const code = cleanCode(req.body?.code);
    const packageId = parseInt(req.body?.package_id, 10);
    if (!code) return invalid(res, 'Enter a code.');
    try {
      const pkg = packageId
        ? await pool.query('SELECT id, price_cents, currency, active FROM packages WHERE id = $1', [packageId]) : { rows: [] };
      const p = pkg.rows[0];
      const price = p && p.active ? priceOf(p, (await loadTiers(pool, [p.id])).get(p.id)) : null;
      if (!price || price.closed) return invalid(res, "That package isn't available.");
      const { promo, error } = await checkPromo(pool, code, p.id);
      if (error) return invalid(res, error);
      const discount = discountFor(promo, price.list_cents);
      res.json({
        valid: true, code: promo.code, label: promoLabel(promo, p.currency), kind: promo.kind,
        list_cents: price.list_cents, discount_cents: discount, amount_cents: price.list_cents - discount,
        currency: p.currency, tier_id: price.tier ? price.tier.id : null
      });
    } catch (err) { fail(res, err); }
  });

  // Adds a code to the guest's unpaid reservation, or takes it off (empty code). The order's list price stays the
  // one it was reserved at. A code that brings it to 0 confirms it as a free pass.
  app.post('/api/orders/promo', requireAuth, rateLimit(10, HOUR_MS, perUser), async (req, res) => {
    const code = cleanCode(req.body?.code);
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      // Locked, so a PayPal checkout (which locks it too) can't start on the old amount meanwhile.
      const r = await client.query(
        `SELECT o.id, o.guest_email, o.reference_code, o.package_id, o.paypal_order_id,
                COALESCE(o.list_cents, p.price_cents) AS list_cents, COALESCE(o.currency, p.currency) AS currency, p.name AS package_name
         FROM orders o JOIN packages p ON p.id = o.package_id
         WHERE o.guest_email = $1 AND o.status = 'RESERVED' ORDER BY o.id DESC LIMIT 1 FOR UPDATE OF o`, [req.userEmail]);
      const o = r.rows[0];
      if (!o) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'You have no unpaid reservation.' });
      }
      // The PayPal order was made for the old amount, so the amount can't change under it.
      if (o.paypal_order_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: "You've already started paying with PayPal, so a code can't be added now. Contact us if you need help." });
      }
      let promo = null;
      if (code) {
        const check = await checkPromo(client, code, o.package_id, { lock: true, excludeOrderId: o.id });
        if (check.error) {
          await client.query('ROLLBACK');
          return invalid(res, check.error);
        }
        promo = check.promo;
      }
      const discount = promo ? discountFor(promo, o.list_cents) : 0;
      const amount = o.list_cents - discount;
      const free = amount === 0;
      await client.query(
        `UPDATE orders SET promo_code = $2, discount_cents = $3, amount_cents = $4
           ${free ? ", status = 'PAID', paid_at = NOW(), paid_via = 'COMP'" : ''}
         WHERE id = $1`, [o.id, promo ? promo.code : null, discount, amount]);
      await client.query('COMMIT');
      res.json({
        success: true, status: free ? 'PAID' : 'RESERVED', amount_cents: amount, discount_cents: discount,
        currency: o.currency, promo_code: promo ? promo.code : null, label: promo ? promoLabel(promo, o.currency) : null
      });
      // After responding, so a slow email never holds up the guest.
      if (free) Promise.resolve().then(() => onComp(o)).catch((err) => console.error('Free pass email error:', err));
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      fail(res, err);
    } finally {
      client?.release();
    }
  });

  // ---------- Admin ----------

  app.get('/api/admin/pricing', requireAdmin, async (req, res) => {
    try {
      const [pk, codes] = await Promise.all([
        pool.query('SELECT id, name, currency, price_cents, active FROM packages ORDER BY sort_order ASC, id ASC'),
        pool.query(
          `SELECT c.code, c.kind, c.value, c.package_id, p.name AS package_name, p.currency, c.max_uses, c.expires_at,
                  c.active, c.note, c.created_at,
                  (SELECT COUNT(*) FROM orders o WHERE o.promo_code = c.code AND o.status <> 'CANCELLED')::int AS uses
           FROM promo_codes c LEFT JOIN packages p ON p.id = c.package_id ORDER BY c.created_at DESC, c.code`)
      ]);
      const tiers = await loadTiers(pool, pk.rows.map((p) => p.id));
      const now = new Date();
      // An amount off on an "any package" code is in each package's own currency. When they all use one, say which.
      const currencies = [...new Set(pk.rows.map((p) => p.currency))];
      const anyCurrency = currencies.length > 1 ? null : currencies[0] || 'XCD';
      res.json({
        packages: pk.rows.map((p) => ({
          ...p,
          tiers: withStates(tiers.get(p.id), now).map((t) => ({
            id: t.id, name: t.name, price_cents: t.price_cents, ends_at: t.ends_at, quantity: t.quantity,
            sold: t.sold, sort_order: t.sort_order, state: t.state
          }))
        })),
        codes: codes.rows.map(({ currency, ...c }) => ({ ...c, label: promoLabel(c, c.package_id ? currency : anyCurrency) }))
      });
    } catch (err) { fail(res, err); }
  });

  // A new tier goes after the package's other tiers.
  app.post('/api/admin/tiers', requireAdmin, async (req, res) => {
    const b = req.body || {};
    const packageId = toInt(b.package_id);
    const { error, fields: f } = tierInput(b, false);
    if (error) return res.status(400).json({ error });
    try {
      const r = await pool.query(
        `INSERT INTO package_tiers (package_id, name, price_cents, ends_at, quantity, sort_order)
         SELECT p.id, $2::text, $3::int, $4::timestamptz, $5::int, (SELECT COALESCE(MAX(t.sort_order), 0) + 1 FROM package_tiers t WHERE t.package_id = p.id)
         FROM packages p WHERE p.id = $1 RETURNING id`,
        [Number.isInteger(packageId) ? packageId : null, f.name, f.price_cents, f.ends_at, f.quantity]);
      if (!r.rowCount) return res.status(400).json({ error: "That package doesn't exist." });
      res.json({ success: true, id: r.rows[0].id });
    } catch (err) { fail(res, err); }
  });

  // Partial edit. ends_at or quantity sent as null or '' clears it.
  app.post('/api/admin/tiers/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { error, fields: f } = tierInput(req.body || {}, true);
    if (error) return res.status(400).json({ error });
    const cols = Object.keys(f); // fixed column names from tierInput, never from the request
    if (!id || !cols.length) return res.status(400).json({ error: 'Nothing to update.' });
    try {
      const r = await pool.query(
        `UPDATE package_tiers SET ${cols.map((c, n) => `${c} = $${n + 1}`).join(', ')} WHERE id = $${cols.length + 1}`,
        [...cols.map((c) => f[c]), id]);
      if (!r.rowCount) return res.status(404).json({ error: "That tier doesn't exist anymore." });
      res.json({ success: true });
    } catch (err) { fail(res, err); }
  });

  // Swaps a tier with the one above or below it, then numbers the package's tiers 1, 2, 3... again.
  app.post('/api/admin/tiers/:id/move', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const dir = req.body?.dir;
    if (!id || !['up', 'down'].includes(dir)) return res.status(400).json({ error: 'Move it up or down.' });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const list = await client.query(
        `SELECT id FROM package_tiers WHERE package_id = (SELECT package_id FROM package_tiers WHERE id = $1)
         ORDER BY sort_order, id FOR UPDATE`, [id]);
      const ids = list.rows.map((t) => t.id);
      const i = ids.indexOf(id);
      const j = dir === 'up' ? i - 1 : i + 1;
      if (i < 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: "That tier doesn't exist anymore." });
      }
      if (j < 0 || j >= ids.length) {
        await client.query('ROLLBACK');
        return res.json({ success: true, moved: false });
      }
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await client.query(
        'UPDATE package_tiers t SET sort_order = x.n FROM unnest($1::int[]) WITH ORDINALITY AS x(id, n) WHERE t.id = x.id', [ids]);
      await client.query('COMMIT');
      res.json({ success: true, moved: true });
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      fail(res, err);
    } finally {
      client?.release();
    }
  });

  // Only a tier no order has ever used can be deleted; the orders keep their tier for the records.
  app.post('/api/admin/tiers/:id/delete', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid tier.' });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      // Lock the package as a reservation does, so no new order can pick this tier while it's deleted.
      const t = await client.query(
        'SELECT p.id FROM package_tiers t JOIN packages p ON p.id = t.package_id WHERE t.id = $1 FOR UPDATE OF p', [id]);
      if (!t.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: "That tier doesn't exist anymore." });
      }
      const used = await client.query('SELECT 1 FROM orders WHERE tier_id = $1 LIMIT 1', [id]);
      if (used.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: "This tier has orders, so it can't be deleted. Set its end date to now to close it." });
      }
      await client.query('DELETE FROM package_tiers WHERE id = $1', [id]);
      await client.query('COMMIT');
      res.json({ success: true });
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      fail(res, err);
    } finally {
      client?.release();
    }
  });

  app.post('/api/admin/promos', requireAdmin, async (req, res) => {
    const b = req.body || {};
    const code = cleanCode(b.code);
    if (!CODE_RE.test(code)) return res.status(400).json({ error: 'A code is 3 to 24 letters, numbers or dashes, starting with a letter or number.' });
    const kind = String(b.kind || '').toUpperCase();
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'Choose what the code gives.' });
    const value = kind === 'FREE' ? 0 : toInt(b.value);
    if (kind === 'PERCENT' && !(Number.isInteger(value) && value >= 1 && value <= 100)) {
      return res.status(400).json({ error: 'Percent off must be a whole number from 1 to 100.' });
    }
    if (kind === 'AMOUNT' && !(Number.isInteger(value) && value >= 1 && value <= 10000000)) {
      return res.status(400).json({ error: 'Enter the amount off.' });
    }
    const packageId = blank(b.package_id) ? null : toInt(b.package_id);
    if (packageId !== null && !(Number.isInteger(packageId) && packageId > 0)) return res.status(400).json({ error: "That package doesn't exist." });
    const { error, fields: f } = promoEdits({ max_uses: b.max_uses, expires_at: b.expires_at, note: b.note });
    if (error) return res.status(400).json({ error });
    try {
      if (packageId !== null && !(await pool.query('SELECT 1 FROM packages WHERE id = $1', [packageId])).rowCount) {
        return res.status(400).json({ error: "That package doesn't exist." });
      }
      const r = await pool.query(
        `INSERT INTO promo_codes (code, kind, value, package_id, max_uses, expires_at, note) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (code) DO NOTHING RETURNING code`, [code, kind, value, packageId, f.max_uses, f.expires_at, f.note]);
      if (!r.rowCount) return res.status(409).json({ error: `${code} already exists. Pick another code.` });
      res.json({ success: true, code });
    } catch (err) { fail(res, err); }
  });

  // Partial edit: active, max_uses, expires_at, note. What a code gives can't change once guests may have it.
  app.post('/api/admin/promos/:code', requireAdmin, async (req, res) => {
    const code = cleanCode(req.params.code);
    const { error, fields: f } = promoEdits(req.body || {});
    if (error) return res.status(400).json({ error });
    const cols = Object.keys(f); // fixed column names from promoEdits, never from the request
    if (!cols.length) return res.status(400).json({ error: 'Nothing to update.' });
    try {
      const r = await pool.query(
        `UPDATE promo_codes SET ${cols.map((c, n) => `${c} = $${n + 1}`).join(', ')} WHERE code = $${cols.length + 1}`,
        [...cols.map((c) => f[c]), code]);
      if (!r.rowCount) return res.status(404).json({ error: "That code doesn't exist anymore." });
      res.json({ success: true });
    } catch (err) { fail(res, err); }
  });

  // Only a code no order has ever used can be deleted, so every order can still say what it took off.
  app.post('/api/admin/promos/:code/delete', requireAdmin, async (req, res) => {
    const code = cleanCode(req.params.code);
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      // A reservation using the code holds this lock until it's saved, so it can't slip in between.
      const c = await client.query('SELECT 1 FROM promo_codes WHERE code = $1 FOR UPDATE', [code]);
      if (!c.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: "That code doesn't exist anymore." });
      }
      const used = await client.query('SELECT 1 FROM orders WHERE promo_code = $1 LIMIT 1', [code]);
      if (used.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: "This code has been used, so it can't be deleted. Turn it off instead." });
      }
      await client.query('DELETE FROM promo_codes WHERE code = $1', [code]);
      await client.query('COMMIT');
      res.json({ success: true });
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      fail(res, err);
    } finally {
      client?.release();
    }
  });

  app.get('/admin/pricing', requireAdmin, (req, res) => res.type('html').send(PAGE));
}

// ---------- "Prices & codes" admin page ----------
// Dates in the forms are datetime-local inputs read and shown as Antigua time; "-04:00" is added when sending.
const PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0b0a09">
<title>Prices &amp; codes | On D' Road</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
:root { --bg: #0b0a09; --surface: #141210; --surface-2: #1b1815; --raise: #221e1a; --line: rgba(243, 236, 226, .09); --line-strong: rgba(243, 236, 226, .2); --text: #f3ece2; --muted: #9b9389; --dim: #6c665e; --accent: #ff5b1f; --accent-ink: #120703; --good: #4fc3a1; --warn: #f0b43c; --bad: #ff6a5c; --mono: 'JetBrains Mono', ui-monospace, monospace; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 'Inter', system-ui, -apple-system, sans-serif; -webkit-font-smoothing: antialiased; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.hidden { display: none !important; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.top { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px clamp(16px, 3vw, 32px); background: rgba(11, 10, 9, .8); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 14px; }
.brand b { font-family: 'Anton', Impact, sans-serif; font-weight: 400; font-size: 20px; letter-spacing: .04em; }
.brand b span { color: var(--accent); }
.brand .sub { font-size: 12px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); padding-left: 14px; border-left: 1px solid var(--line-strong); }
.back { font-size: 13px; font-weight: 500; color: var(--muted); text-decoration: none; padding: 8px 12px; border-radius: 8px; }
.back:hover { color: var(--text); background: rgba(243, 236, 226, .05); }
.wrap { max-width: 980px; margin: 0 auto; padding: clamp(24px, 4vw, 48px) clamp(16px, 3vw, 32px) 80px; }
h1 { font-family: 'Anton', Impact, sans-serif; font-weight: 400; font-size: clamp(36px, 6vw, 52px); line-height: .95; text-transform: uppercase; margin: 0; }
h2 { font-family: 'Anton', Impact, sans-serif; font-weight: 400; font-size: 26px; line-height: 1.1; text-transform: uppercase; margin: 0; }
h3 { font-size: 14px; font-weight: 600; margin: 0 0 12px; }
.lead { color: var(--muted); margin: 10px 0 26px; }
.explain { margin: 0 0 22px; padding: 16px 18px; border-radius: 10px; background: rgba(243, 236, 226, .04); border: 1px solid var(--line); color: var(--muted); font-size: 14px; }
.explain b { display: block; font-size: 11px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--accent); margin-bottom: 6px; }
.card { background: linear-gradient(180deg, var(--surface-2), var(--surface)); border: 1px solid var(--line); border-radius: 14px; padding: clamp(20px, 3vw, 28px); margin-bottom: 22px; scroll-margin-top: 84px; transition: border-color .4s, box-shadow .4s; }
.card.flash { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(255, 91, 31, .16); }
.card > p { color: var(--muted); margin: 6px 0 0; }
.card > p.bad { color: var(--bad); }
.card-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.empty { color: var(--dim); font-style: italic; margin: 0; }
small { display: block; color: var(--dim); font-size: 13px; margin-top: 8px; }
.f label, .lbl { display: block; font-size: 11px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); margin: 0 0 8px; }
input, select { width: 100%; font: 500 14px 'Inter', system-ui, sans-serif; color: var(--text); background: rgba(0, 0, 0, .35); border: 1px solid var(--line-strong); border-radius: 10px; padding: 11px 13px; min-width: 0; transition: border-color .15s, box-shadow .15s; }
select { padding-right: 34px; cursor: pointer; -webkit-appearance: none; appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%); background-position: calc(100% - 17px) 50%, calc(100% - 12px) 50%; background-size: 5px 5px; background-repeat: no-repeat; }
select option { background: var(--surface); color: var(--text); }
input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(255, 91, 31, .16); }
input::placeholder { color: var(--dim); }
#c-code { font-family: var(--mono); text-transform: uppercase; letter-spacing: .04em; }
button { font: 600 14px 'Inter', system-ui, sans-serif; padding: 12px 20px; border-radius: 10px; cursor: pointer; color: var(--accent-ink); background: var(--accent); border: 1px solid var(--accent); white-space: nowrap; }
button:hover { filter: brightness(1.08); }
button:disabled { opacity: .5; cursor: progress; }
button.ghost { color: var(--text); background: transparent; border-color: var(--line-strong); }
button.ghost:hover { border-color: var(--text); filter: none; }
button.danger { color: var(--bad); background: transparent; border-color: rgba(255, 106, 92, .4); }
button.danger:hover { background: rgba(255, 106, 92, .08); filter: none; }
button.danger-solid { background: var(--bad); border-color: var(--bad); color: #1a0402; }
button.small { padding: 7px 11px; font-size: 12px; border-radius: 8px; }
button.icon { min-width: 32px; padding: 7px 8px; }
.toggle { font: 600 12px 'Inter', system-ui, sans-serif; border-radius: 999px; padding: 5px 12px; border: 1px solid var(--line-strong); background: transparent; color: var(--muted); }
.toggle:hover { filter: none; border-color: var(--text); }
.toggle.on { color: var(--good); border-color: rgba(79, 195, 161, .4); background: rgba(79, 195, 161, .08); }
.msg { font-size: 14px; font-weight: 600; }
.msg.ok { color: var(--good); } .msg.err { color: var(--bad); }

.scroll { overflow-x: auto; margin-top: 16px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-size: 11px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); padding: 10px 10px 10px 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 12px 10px 12px 0; border-bottom: 1px solid var(--line); vertical-align: middle; }
tbody tr:last-child td { border-bottom: 0; }
td.strong { font-weight: 600; }
td.code { font-family: var(--mono); font-size: 13px; letter-spacing: .03em; white-space: nowrap; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.actions { text-align: right; white-space: nowrap; padding-right: 0; }
td.actions button + button { margin-left: 6px; }
.subtext { display: block; font-family: 'Inter', system-ui, sans-serif; font-size: 12px; font-weight: 400; letter-spacing: 0; color: var(--muted); margin-top: 3px; white-space: normal; }
.subtext.bad { color: var(--bad); } .subtext.warn { color: var(--warn); }
.pill { display: inline-flex; align-items: center; gap: 7px; padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; white-space: nowrap; border: 1px solid var(--line-strong); color: var(--muted); }
.pill::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pill.good { color: var(--good); border-color: rgba(79, 195, 161, .35); }
.pill.warn { color: var(--warn); border-color: rgba(240, 180, 60, .35); }
.pill.bad { color: var(--bad); border-color: rgba(255, 106, 92, .35); }
.pill.neutral { color: var(--dim); }

.add { margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--line); }
.grid { display: grid; grid-template-columns: 1.4fr 1fr 1.4fr 1fr; gap: 12px; align-items: end; }
.grid .wide { grid-column: span 2; }
.f { min-width: 0; }
.row { display: flex; gap: 8px; }
.row input { flex: 1; }
.foot { display: flex; align-items: center; gap: 14px; margin-top: 16px; flex-wrap: wrap; }

/* Phones: each table row becomes a card. Labels come from data-label. */
@media (max-width: 700px) {
  .grid { grid-template-columns: 1fr 1fr; }
  .grid .wide, .grid .f:first-child { grid-column: 1 / -1; }
  table.cards thead { display: none; }
  table.cards, table.cards tbody, table.cards tr, table.cards td { display: block; width: 100%; }
  table.cards tr { padding: 12px 0; border-bottom: 1px solid var(--line); }
  table.cards tr:last-child { border-bottom: 0; }
  table.cards td { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 12px; border: 0; padding: 4px 0; text-align: right; }
  table.cards td::before { content: attr(data-label); font-size: 11px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); text-align: left; }
  table.cards td[data-label=""]::before { content: none; }
  table.cards td.strong, table.cards td.code { display: block; text-align: left; font-size: 15px; padding-bottom: 6px; }
  table.cards td.actions { justify-content: flex-end; padding-top: 8px; }
  table.cards .subtext { flex-basis: 100%; text-align: right; margin-top: 0; }
  table.cards td.strong .subtext, table.cards td.code .subtext { text-align: left; margin-top: 3px; }
}

dialog { width: min(460px, calc(100vw - 32px)); padding: 0; border: 1px solid var(--line-strong); border-radius: 16px; background: var(--surface-2); color: var(--text); box-shadow: 0 30px 80px -20px rgba(0, 0, 0, .8); }
dialog::backdrop { background: rgba(5, 4, 3, .7); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
dialog form { padding: 24px; }
dialog h3 { margin: 0; font-size: 18px; font-weight: 600; }
dialog p { margin: 8px 0 0; color: var(--muted); font-size: 14px; }
.dlg-fields { display: grid; gap: 14px; margin-top: 18px; }
.dlg-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; }
.toast { position: fixed; left: 50%; bottom: 24px; z-index: 80; transform: translate(-50%, 16px); max-width: calc(100vw - 32px); padding: 12px 16px; border-radius: 10px; background: var(--text); color: var(--bg); font-size: 14px; font-weight: 600; opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s; box-shadow: 0 20px 50px -10px rgba(0, 0, 0, .6); }
.toast.show { opacity: 1; transform: translate(-50%, 0); }
.toast.bad { background: var(--bad); color: #1a0402; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style></head><body>
<header class="top">
  <div class="brand"><b>ON D<span>'</span> ROAD</b><span class="sub">Command Center</span></div>
  <a class="back" href="/admin">&larr; Back to overview</a>
</header>
<main class="wrap">
  <h1>Prices &amp; codes</h1>
  <p class="lead">Prices that change by date or when a tier sells out, and codes that take money off.</p>
  <div class="explain"><b>How price tiers work</b>Guests pay the first tier that hasn't ended or sold out. When the last tier ends or sells out, the package closes; add a last tier with no end date and no limit to keep selling. Unpaid reservations that expire free their spot in that tier. Changing a tier's price doesn't change existing orders.</div>
  <div id="pkgs"><p class="empty">Loading...</p></div>

  <section class="card" id="codes" aria-labelledby="codes-h">
    <h2 id="codes-h">Promo codes</h2>
    <p>Guests enter a code when they reserve, or on their reservation before they pay. A code that brings the price to 0 confirms the order straight away as a free pass.</p>
    <form id="code-form" class="add" novalidate>
      <h3>New code</h3>
      <div class="grid">
        <div class="f wide"><label for="c-code">Code</label>
          <div class="row"><input id="c-code" maxlength="24" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="SAVE20"><button class="ghost" type="button" id="c-random">Random</button></div></div>
        <div class="f"><label for="c-kind">Gives</label>
          <select id="c-kind"><option value="PERCENT">Percent off</option><option value="AMOUNT">Amount off</option><option value="FREE">Free pass</option></select></div>
        <div class="f" id="c-value-f"><label for="c-value" id="c-value-l">Percent off</label>
          <input id="c-value" type="number" min="1" max="100" step="1" inputmode="numeric" placeholder="20"></div>
        <div class="f"><label for="c-pkg">Package</label>
          <select id="c-pkg"><option value="">Any package</option></select></div>
        <div class="f"><label for="c-max">Max uses</label>
          <input id="c-max" type="number" min="1" max="100000" step="1" inputmode="numeric" placeholder="No limit"></div>
        <div class="f wide"><label for="c-exp">Expires (Antigua time)</label>
          <input id="c-exp" type="datetime-local"></div>
        <div class="f wide"><label for="c-note">Note, only you see it</label>
          <input id="c-note" maxlength="200" placeholder="Example: DJ crew"></div>
      </div>
      <small>3 to 24 letters, numbers or dashes; guests can type it in any case. Leave max uses and expiry blank for no limit. A use counts while the order isn't cancelled.</small>
      <div class="foot"><button type="submit" id="c-save">Create code</button><span id="c-msg" class="msg" role="status"></span></div>
    </form>
    <div id="code-list"></div>
  </section>
</main>

<dialog id="dlg" aria-labelledby="dlg-title">
  <form id="dlg-form">
    <h3 id="dlg-title"></h3>
    <p id="dlg-text"></p>
    <div id="dlg-fields" class="dlg-fields"></div>
    <div class="dlg-actions">
      <button class="ghost" type="button" id="dlg-cancel">Cancel</button>
      <button type="submit" id="dlg-ok">Confirm</button>
    </div>
  </form>
</dialog>
<div id="toast" class="toast" role="status" aria-live="polite"></div>

<script>
const $ = (id) => document.getElementById(id);
const AST = 4 * 36e5; // Antigua is UTC-4 all year
const STATES = { CURRENT: ['On sale', 'good'], UPCOMING: ['Upcoming', 'neutral'], ENDED: ['Ended', 'neutral'], SOLD_OUT: ['Sold out', 'warn'] };
let data = { packages: [], codes: [] };
let firstLoad = true;

async function api(path, body) {
  const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined;
  const res = await fetch(path, opts);
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(d.error || ('Request failed (' + res.status + ')')); e.status = res.status; throw e; }
  return d;
}
function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = text; if (cls) e.className = cls; return e; }
function td(tr, label, text, cls) { const c = el('td', text, cls); c.setAttribute('data-label', label); tr.appendChild(c); return c; }
function pill(text, tone) { return el('span', text, 'pill ' + (tone || 'neutral')); }
function money(cents, cur) { return (cur || 'XCD') + ' ' + (Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function when(iso) { return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Antigua' }); }
// datetime-local inputs hold Antigua time.
function toInput(iso) { return iso ? new Date(new Date(iso).getTime() - AST).toISOString().slice(0, 16) : ''; }
function fromInput(v) { return v ? v + '-04:00' : null; }
// "250", "250.5" -> cents; anything else -> NaN.
function toCents(v) { const s = String(v == null ? '' : v).trim(); const n = s ? Number(s) : NaN; return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN; }
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

let toastTimer;
function toast(text, bad) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast' + (bad ? ' bad' : ''); }, 4000);
}

// Styled replacement for confirm()/prompt(). Resolves to the field values, or null if cancelled.
function ask(o) {
  return new Promise((resolve) => {
    const dlg = $('dlg'), form = $('dlg-form'), box = $('dlg-fields');
    $('dlg-title').textContent = o.title;
    $('dlg-text').textContent = o.text || '';
    $('dlg-text').classList.toggle('hidden', !o.text);
    box.replaceChildren();
    box.classList.toggle('hidden', !(o.fields && o.fields.length));
    const inputs = {};
    (o.fields || []).forEach((f, i) => {
      const wrap = el('div', undefined, 'f');
      const label = el('label', f.label);
      const input = el('input');
      input.id = 'dlg-f' + i; label.htmlFor = input.id;
      input.type = f.type || 'text';
      ['step', 'min', 'max', 'maxLength', 'placeholder', 'inputMode'].forEach((k) => { if (f[k] !== undefined) input[k] = f[k]; });
      input.value = f.value === null || f.value === undefined ? '' : f.value;
      wrap.append(label, input);
      if (f.hint) wrap.appendChild(el('small', f.hint));
      box.appendChild(wrap);
      inputs[f.name] = input;
    });
    const ok = $('dlg-ok');
    ok.textContent = o.ok || 'Confirm';
    ok.className = o.danger ? 'danger-solid' : '';
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      form.onsubmit = null; $('dlg-cancel').onclick = null; dlg.onclose = null;
      if (dlg.open) dlg.close();
      resolve(val);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const vals = {};
      Object.keys(inputs).forEach((k) => { vals[k] = inputs[k].value; });
      finish(vals);
    };
    $('dlg-cancel').onclick = () => finish(null);
    dlg.onclose = () => finish(null);
    dlg.showModal();
    const first = box.querySelector('input');
    (first || ok).focus();
  });
}

// Button that runs an action, then reloads the page data. fn returns false when the admin backs out,
// or a message to show.
function actionBtn(label, cls, fn, aria) {
  const b = el('button', label, 'small ' + (cls || ''));
  b.type = 'button';
  if (aria) b.setAttribute('aria-label', aria);
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const result = await fn();
      if (result === false) return;
      await load();
      if (typeof result === 'string') toast(result);
    } catch (e) { toast(e.message, true); }
    finally { b.disabled = false; }
  });
  return b;
}

// ---------- Price tiers ----------
function tierFields(p, t) {
  return [
    { name: 'name', label: 'Name', value: t ? t.name : '', maxLength: 40, placeholder: 'Early bird' },
    { name: 'price', label: 'Price (' + p.currency + ')', type: 'number', step: '0.01', min: 0, value: t ? (t.price_cents / 100).toFixed(2) : '' },
    { name: 'ends', label: 'Ends (Antigua time)', type: 'datetime-local', value: t ? toInput(t.ends_at) : '', hint: 'Blank = no end date.' },
    { name: 'qty', label: 'Quantity at this price', type: 'number', min: 1, step: 1, inputMode: 'numeric', value: t ? t.quantity : '', placeholder: 'No limit' }
  ];
}
// Form values -> request body, or throws with a plain message.
function tierBody(v) {
  const price = toCents(v.price);
  if (!v.name.trim()) throw new Error('Give the tier a name.');
  if (!(price >= 0)) throw new Error('Enter a valid price.');
  return { name: v.name, price_cents: price, ends_at: fromInput(v.ends), quantity: v.qty.trim() };
}

function tierTable(p) {
  const tiers = p.tiers;
  const wrap = el('div', undefined, 'scroll');
  const table = el('table', undefined, 'cards');
  const head = el('thead'), hr = el('tr');
  [['Tier'], ['Price', 'num'], ['Ends'], ['Quantity', 'num'], ['Sold', 'num'], ['State'], ['']].forEach((h) => { const th = el('th', h[0], h[1]); hr.appendChild(th); });
  hr.lastChild.appendChild(el('span', 'Actions', 'sr'));
  head.appendChild(hr); table.appendChild(head);
  const tb = el('tbody');
  tiers.forEach((t, i) => {
    const tr = el('tr');
    td(tr, '', t.name, 'strong');
    td(tr, 'Price', money(t.price_cents, p.currency), 'num');
    td(tr, 'Ends', t.ends_at ? when(t.ends_at) : 'No end date');
    td(tr, 'Quantity', t.quantity === null ? 'No limit' : String(t.quantity), 'num');
    const sold = td(tr, 'Sold', String(t.sold), 'num');
    sold.title = 'Reserved and paid orders at this price';
    if (t.quantity !== null && (t.state === 'CURRENT' || t.state === 'UPCOMING')) sold.appendChild(el('span', Math.max(0, t.quantity - t.sold) + ' left', 'subtext'));
    const st = STATES[t.state] || [t.state, 'neutral'];
    td(tr, 'State', '').appendChild(pill(st[0], st[1]));
    const act = td(tr, '', '', 'actions');
    act.appendChild(actionBtn('Edit', 'ghost', async () => {
      const v = await ask({ title: 'Edit ' + t.name, text: 'Orders already made keep the price they were reserved at.', ok: 'Save tier', fields: tierFields(p, t) });
      if (!v) return false;
      await api('/api/admin/tiers/' + t.id, tierBody(v));
      return 'Tier saved.';
    }, 'Edit ' + t.name));
    const up = actionBtn('↑', 'ghost icon', async () => { await api('/api/admin/tiers/' + t.id + '/move', { dir: 'up' }); }, 'Move ' + t.name + ' up');
    const down = actionBtn('↓', 'ghost icon', async () => { await api('/api/admin/tiers/' + t.id + '/move', { dir: 'down' }); }, 'Move ' + t.name + ' down');
    up.disabled = i === 0; down.disabled = i === tiers.length - 1;
    act.append(up, down);
    act.appendChild(actionBtn('Delete', 'danger', async () => {
      const v = await ask({ title: 'Delete ' + t.name + '?', text: 'Guests will pay the next tier in the list instead.', ok: 'Delete', danger: true });
      if (!v) return false;
      try {
        await api('/api/admin/tiers/' + t.id + '/delete', {});
      } catch (e) {
        if (e.status !== 409) throw e;
        // Tiers with orders stay for the records. Offer to close it instead.
        const end = await ask({ title: "Can't delete " + t.name, text: e.message, ok: 'End it now' });
        if (!end) return false;
        await api('/api/admin/tiers/' + t.id, { ends_at: new Date().toISOString() });
        return t.name + ' has ended.';
      }
      return 'Tier deleted.';
    }, 'Delete ' + t.name));
    tb.appendChild(tr);
  });
  table.appendChild(tb); wrap.appendChild(table);
  return wrap;
}

function field(label, input, cls) {
  const f = el('div', undefined, 'f' + (cls ? ' ' + cls : ''));
  const l = el('label', label); l.htmlFor = input.id;
  f.append(l, input);
  return f;
}
function input(id, type, attrs) {
  const i = el('input'); i.id = id; i.type = type || 'text';
  Object.keys(attrs || {}).forEach((k) => { i[k] = attrs[k]; });
  return i;
}

function addTierForm(p) {
  const form = el('form', undefined, 'add');
  form.noValidate = true;
  const id = 'p' + p.id + '-';
  form.appendChild(el('h3', p.tiers.length ? 'Add a tier' : 'Add the first tier'));
  const name = input(id + 'name', 'text', { maxLength: 40, placeholder: p.tiers.length ? 'Late' : 'Early bird' });
  const price = input(id + 'price', 'number', { step: '0.01', min: 0, placeholder: (p.price_cents / 100).toFixed(2) });
  const ends = input(id + 'ends', 'datetime-local');
  const qty = input(id + 'qty', 'number', { min: 1, step: 1, inputMode: 'numeric', placeholder: 'No limit' });
  const grid = el('div', undefined, 'grid');
  grid.append(field('Name', name), field('Price (' + p.currency + ')', price), field('Ends (Antigua time)', ends), field('Quantity', qty));
  form.appendChild(grid);
  form.appendChild(el('small', p.tiers.length
    ? 'Added last. Leave the end date and quantity blank for no limit.'
    : 'Once a package has tiers, guests pay the tier prices instead of the package price (' + money(p.price_cents, p.currency) + '). Leave the end date and quantity blank for no limit.'));
  const foot = el('div', undefined, 'foot');
  const save = el('button', 'Add tier'); save.type = 'submit';
  foot.appendChild(save); form.appendChild(foot);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      const body = tierBody({ name: name.value, price: price.value, ends: ends.value, qty: qty.value });
      body.package_id = p.id;
      await api('/api/admin/tiers', body);
      await load();
      toast('Tier added.');
    } catch (err) { toast(err.message, true); }
    finally { save.disabled = false; }
  });
  return form;
}

function packageCard(p) {
  const sec = el('section', undefined, 'card');
  sec.id = 'p' + p.id;
  sec.setAttribute('aria-labelledby', sec.id + '-h');
  const head = el('div', undefined, 'card-head');
  const h = el('h2', p.name); h.id = sec.id + '-h';
  head.appendChild(h);
  if (!p.active) head.appendChild(pill('Hidden', 'neutral'));
  sec.appendChild(head);
  const tiers = p.tiers;
  const cur = tiers.find((t) => t.state === 'CURRENT');
  const last = tiers[tiers.length - 1];
  if (!tiers.length) {
    sec.appendChild(el('p', 'No tiers: guests pay the package price, ' + money(p.price_cents, p.currency) + '.'));
  } else if (!cur) {
    sec.appendChild(el('p', "Sales closed: every tier has ended or sold out. Guests can't reserve this package until you add a tier or change one.", 'bad'));
  } else {
    sec.appendChild(el('p', 'Guests pay ' + money(cur.price_cents, p.currency) + ' now (' + cur.name + ').'
      + (last.ends_at || last.quantity !== null ? ' Sales close when ' + last.name + ' ends or sells out.' : '')));
  }
  if (tiers.length) sec.appendChild(tierTable(p));
  sec.appendChild(addTierForm(p));
  return sec;
}

function renderPackages() {
  const box = $('pkgs');
  box.replaceChildren();
  if (!data.packages.length) {
    const c = el('section', undefined, 'card');
    c.appendChild(el('p', 'No packages yet. Create one in the Packages tab of the overview first.', 'empty'));
    box.appendChild(c);
    return;
  }
  data.packages.forEach((p) => box.appendChild(packageCard(p)));
}

// ---------- Promo codes ----------
function pkgById(id) { return data.packages.find((p) => p.id === id) || null; }
// The currency an amount off is in: the chosen package's, or the one every package uses (null when they differ).
function codeCurrency() {
  const p = pkgById(Number($('c-pkg').value));
  if (p) return p.currency;
  const all = Array.from(new Set(data.packages.map((x) => x.currency)));
  return all.length > 1 ? null : all[0] || 'XCD';
}
function syncKind() {
  const kind = $('c-kind').value, v = $('c-value');
  $('c-value-f').classList.toggle('hidden', kind === 'FREE');
  if (kind === 'PERCENT') {
    $('c-value-l').textContent = 'Percent off';
    v.step = '1'; v.max = '100'; v.placeholder = '20'; v.inputMode = 'numeric';
  } else {
    const cur = codeCurrency();
    $('c-value-l').textContent = 'Amount off (' + (cur || "package's currency") + ')';
    v.step = '0.01'; v.removeAttribute('max'); v.placeholder = '50.00'; v.inputMode = 'decimal';
  }
}
$('c-kind').addEventListener('change', syncKind);
$('c-pkg').addEventListener('change', syncKind);

// Fills in a code that's hard to guess, like FREE-7KQ2XD (no 0/O or 1/I/L, so it's easy to read out).
$('c-random').addEventListener('click', () => {
  const ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const kind = $('c-kind').value, n = Number($('c-value').value);
  const prefix = kind === 'FREE' ? 'FREE' : 'SAVE' + (Number.isInteger(n) && n > 0 && n <= 99999 ? n : '');
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  $('c-code').value = prefix + '-' + Array.from(bytes, (b) => ABC[b % ABC.length]).join('');
  $('c-code').focus();
});

$('code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const b = $('c-save'), msg = $('c-msg');
  msg.textContent = ''; msg.className = 'msg';
  const kind = $('c-kind').value;
  const body = {
    code: $('c-code').value.trim().toUpperCase(), kind: kind, package_id: $('c-pkg').value || null,
    max_uses: $('c-max').value.trim(), expires_at: fromInput($('c-exp').value), note: $('c-note').value
  };
  if (kind === 'PERCENT') body.value = $('c-value').value.trim();
  if (kind === 'AMOUNT') {
    body.value = toCents($('c-value').value);
    if (!(body.value > 0)) { msg.textContent = 'Enter the amount off.'; msg.className = 'msg err'; return; }
  }
  b.disabled = true;
  try {
    await api('/api/admin/promos', body);
    ['c-code', 'c-value', 'c-max', 'c-exp', 'c-note'].forEach((id) => { $(id).value = ''; });
    msg.textContent = body.code + ' is ready to share.'; msg.className = 'msg ok';
    await load();
  } catch (err) { msg.textContent = err.message; msg.className = 'msg err'; }
  finally { b.disabled = false; }
});

function renderCodes() {
  // Package choices for a new code (keeps the current choice).
  const sel = $('c-pkg'), was = sel.value;
  sel.replaceChildren(el('option', 'Any package'));
  sel.firstChild.value = '';
  data.packages.forEach((p) => { const o = el('option', p.name + (p.active ? '' : ' (hidden)')); o.value = String(p.id); sel.appendChild(o); });
  sel.value = Array.from(sel.options).some((o) => o.value === was) ? was : '';
  syncKind();

  const box = $('code-list');
  box.replaceChildren();
  if (!data.codes.length) { const p = el('p', 'No codes yet.', 'empty'); p.style.marginTop = '18px'; box.appendChild(p); return; }
  const wrap = el('div', undefined, 'scroll');
  const table = el('table', undefined, 'cards');
  const head = el('thead'), hr = el('tr');
  [['Code'], ['Gives'], ['Package'], ['Used', 'num'], ['Expires'], ['On'], ['']].forEach((h) => { hr.appendChild(el('th', h[0], h[1])); });
  hr.lastChild.appendChild(el('span', 'Actions', 'sr'));
  head.appendChild(hr); table.appendChild(head);
  const tb = el('tbody');
  const now = Date.now();
  data.codes.forEach((c) => {
    const tr = el('tr');
    const code = td(tr, '', c.code, 'code');
    if (c.note) code.appendChild(el('span', c.note, 'subtext'));
    td(tr, 'Gives', c.label);
    td(tr, 'Package', c.package_name || 'Any package');
    const used = td(tr, 'Used', c.uses + (c.max_uses === null ? '' : ' / ' + c.max_uses), 'num');
    if (c.max_uses === null) used.appendChild(el('span', 'No limit', 'subtext'));
    else if (c.uses >= c.max_uses) used.appendChild(el('span', 'Used up', 'subtext warn'));
    const exp = td(tr, 'Expires', c.expires_at ? when(c.expires_at) : 'Never');
    if (c.expires_at && new Date(c.expires_at).getTime() <= now) exp.appendChild(el('span', 'Expired', 'subtext bad'));
    const on = el('button', c.active ? 'On' : 'Off', 'toggle' + (c.active ? ' on' : ''));
    on.type = 'button';
    on.setAttribute('aria-pressed', String(!!c.active));
    on.setAttribute('aria-label', c.code + ' is ' + (c.active ? 'on' : 'off'));
    on.title = c.active ? 'Guests can use this code. Click to turn it off.' : "Guests can't use this code. Click to turn it on.";
    on.addEventListener('click', async () => {
      on.disabled = true;
      try { await api('/api/admin/promos/' + encodeURIComponent(c.code), { active: !c.active }); await load(); toast(c.code + (c.active ? ' is off.' : ' is on.')); }
      catch (e) { toast(e.message, true); } finally { on.disabled = false; }
    });
    td(tr, 'On', '').appendChild(on);
    const act = td(tr, '', '', 'actions');
    act.appendChild(actionBtn('Edit', 'ghost', async () => {
      const v = await ask({ title: 'Edit ' + c.code, text: c.label + ' · ' + (c.package_name || 'Any package') + '. To change what it gives, make a new code.', ok: 'Save code', fields: [
        { name: 'max', label: 'Max uses', type: 'number', min: 1, step: 1, inputMode: 'numeric', value: c.max_uses, placeholder: 'No limit' },
        { name: 'exp', label: 'Expires (Antigua time)', type: 'datetime-local', value: toInput(c.expires_at), hint: 'Blank = never.' },
        { name: 'note', label: 'Note', value: c.note, maxLength: 200 }
      ] });
      if (!v) return false;
      await api('/api/admin/promos/' + encodeURIComponent(c.code), { max_uses: v.max.trim(), expires_at: fromInput(v.exp), note: v.note });
      return 'Code saved.';
    }, 'Edit ' + c.code));
    act.appendChild(actionBtn('Delete', 'danger', async () => {
      const v = await ask({ title: 'Delete ' + c.code + '?', text: 'Guests who have it will be told it isn’t valid.', ok: 'Delete', danger: true });
      if (!v) return false;
      try {
        await api('/api/admin/promos/' + encodeURIComponent(c.code) + '/delete', {});
      } catch (e) {
        if (e.status !== 409 || !c.active) throw e;
        // Used codes stay for the records. Offer to turn it off instead.
        const off = await ask({ title: "Can't delete " + c.code, text: e.message, ok: 'Turn it off' });
        if (!off) return false;
        await api('/api/admin/promos/' + encodeURIComponent(c.code), { active: false });
        return c.code + ' is off.';
      }
      return 'Code deleted.';
    }, 'Delete ' + c.code));
    tb.appendChild(tr);
  });
  table.appendChild(tb); wrap.appendChild(table); box.appendChild(wrap);
}

async function load() {
  data = await api('/api/admin/pricing');
  renderPackages();
  renderCodes();
  // Links like /admin/pricing#p3 (from the Packages tab) land on that package once it's drawn.
  if (firstLoad) {
    firstLoad = false;
    const target = location.hash && document.getElementById(location.hash.slice(1));
    if (target) {
      target.scrollIntoView();
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 1600);
    }
  }
}
load().catch((e) => { $('pkgs').replaceChildren(el('p', 'Could not load prices: ' + e.message, 'empty')); });
</script></body></html>`;
