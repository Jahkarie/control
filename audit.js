// audit.js: who did what in the admin. Every admin write (every POST behind requireRole, in every module) is logged
// by one hook in auth.js's requireRole, so nothing slips through: the action comes from ACTIONS below (a route with no
// entry is logged as 'admin.write' with its path), the target from the route's id, and for money and status changes the
// row as it was before and after (LOADERS). Logins, lockouts, sessions, the team and 2FA changes are logged by auth.js
// itself. details never hold passwords, codes, secrets or tokens (clean() drops them by name, whatever the route sends).
// The /admin/audit page (OWNER and ADMIN) filters by person, action, date and target and exports a CSV with the BOM.
import { baseHead, topBar, UI_JS } from './admin-ui.js';

export async function ensureAuditSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_id INTEGER,
      user_email TEXT,
      user_name TEXT,
      role TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      ip TEXT,
      details JSONB NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS audit_at_idx ON audit_log (at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS audit_user_idx ON audit_log (user_id, at DESC);
    CREATE INDEX IF NOT EXISTS audit_action_idx ON audit_log (action, at DESC);
    CREATE INDEX IF NOT EXISTS audit_target_idx ON audit_log (target_type, target_id);
  `);
}

// Keys never written to details, at any depth: passwords, one-time codes, secrets, tokens, keys, card data.
const SECRET = /pass(word)?|secret|token|totp|otp|recovery|csrf|signature|^key$|^keys$|apikey|api_key|private|credential|^code$|^codes$|^current$|^ticket$|card|cvv|cvc|^pan$|^s$|^response$|^challenge$|p256dh|^auth$|endpoint/i;
export function clean(v, keep = [], depth = 0) {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + '…' : v;
  if (typeof v !== 'object') return v;
  if (v instanceof Date) return v.toISOString();
  if (depth > 4) return '…';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clean(x, keep, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (SECRET.test(k) && !keep.includes(k)) continue;
    out[k] = clean(x, keep, depth + 1);
  }
  return out;
}

// What a route's write is called, its target and how to read the target before and after.
// id(req, body): the target id (body = the JSON the route answered with, for creates).
const P = (k = 'id') => (req) => req.params[k];
const B = (k) => (req) => req.body?.[k];
const R = (k = 'id') => (req, body) => req.params.id || body?.[k];
const ITEM = (req, body) => req.params.id || body?.item?.id;
const lower = (f) => (req, body) => { const v = f(req, body); return typeof v === 'string' ? v.trim().toLowerCase() : v; };
export const ACTIONS = {
  // Command Center (server.js)
  'POST /api/admin/create-invite': { action: 'invite.create', type: 'invite', id: lower(B('email')) },
  'POST /api/admin/packages': { action: 'package.create', type: 'package', id: R(), load: 'package' },
  'POST /api/admin/packages/:id': { action: 'package.update', type: 'package', id: P(), load: 'package' },
  'POST /api/admin/packages/:id/delete': { action: 'package.delete', type: 'package', id: P(), load: 'package' },
  'POST /api/admin/orders/:id/mark-paid': { action: 'order.mark_paid', type: 'order', id: P(), load: 'order' },
  'POST /api/admin/orders/:id/cancel': { action: 'order.cancel', type: 'order', id: P(), load: 'order' },
  'POST /api/admin/orders/:id/approve-refund': { action: 'order.refund', type: 'order', id: P(), load: 'order' },
  'POST /api/admin/guests/approve': { action: 'guest.approve', type: 'guest', id: lower(B('email')), load: 'guest' },
  'POST /api/admin/guests/decline': { action: 'guest.decline', type: 'guest', id: lower(B('email')), load: 'guest' },
  'POST /api/admin/guests/profile': { action: 'guest.profile', type: 'guest', id: lower(B('email')), load: 'guest' },
  'POST /api/admin/reset-invites': { action: 'guest.reset_invites', type: 'guest', id: lower(B('email')) },
  'POST /api/admin/add-guest': { action: 'guest.add', type: 'guest', id: lower(B('email')), load: 'guest' },
  'POST /api/admin/revoke-invite': { action: 'invite.revoke', type: 'invite', id: B('id') },
  'POST /api/admin/set-invites': { action: 'guest.set_invites', type: 'guest', id: lower(B('email')) },
  'POST /api/admin/remove-guest': { action: 'guest.remove', type: 'guest', id: lower(B('email')), load: 'guest' },
  // Locks (lock.js, both sites)
  'POST /api/admin/site-lock': { action: 'lock.set', type: 'setting', id: () => 'site_lock', load: 'site_lock' },
  'POST /api/admin/site-lock/preview-reset': { action: 'lock.preview_reset', type: 'setting', id: () => 'preview_version' },
  'POST /api/admin/tickets-lock': { action: 'tickets_lock.set', type: 'setting', id: () => 'tickets_lock', load: 'tickets_lock' },
  'POST /api/admin/tickets-lock/preview-reset': { action: 'tickets_lock.preview_reset', type: 'setting', id: () => 'tickets_preview_version' },
  // Pages
  'POST /api/admin/site': { action: 'site.update', type: 'setting', id: () => 'site' },
  'POST /api/admin/payment-settings': { action: 'payments.settings', type: 'setting', id: () => 'payments', load: 'pay_settings' },
  'POST /api/admin/event': { action: 'event.details', type: 'event', id: () => 'current', load: 'event' },
  'POST /api/admin/broadcast': { action: 'broadcast.send', type: 'broadcast', id: B('audience') },
  'POST /api/admin/events/current': { action: 'event.update', type: 'event', id: () => 'current', load: 'event' },
  'POST /api/admin/events/start': { action: 'event.start', type: 'event', id: (req, b) => b?.event?.id, load: 'event' },
  'POST /api/admin/size-lock': { action: 'size_lock.set', type: 'setting', id: () => 'size_lock', load: 'size_lock' },
  'POST /api/admin/orders/:id/size': { action: 'order.size', type: 'order', id: P(), load: 'order' },
  'POST /api/admin/orders/:id/pickup': { action: 'order.pickup', type: 'order', id: P(), load: 'order' },
  'POST /api/admin/tiers': { action: 'tier.create', type: 'tier', id: R(), load: 'tier' },
  'POST /api/admin/tiers/:id': { action: 'tier.update', type: 'tier', id: P(), load: 'tier' },
  'POST /api/admin/tiers/:id/move': { action: 'tier.move', type: 'tier', id: P() },
  'POST /api/admin/tiers/:id/delete': { action: 'tier.delete', type: 'tier', id: P(), load: 'tier' },
  'POST /api/admin/promos': { action: 'code.create', type: 'code', id: (req) => String(req.body?.code || '').trim().toUpperCase(), load: 'code', keep: ['code'] },
  'POST /api/admin/promos/:code': { action: 'code.update', type: 'code', id: (req) => String(req.params.code).toUpperCase(), load: 'code' },
  'POST /api/admin/promos/:code/delete': { action: 'code.delete', type: 'code', id: (req) => String(req.params.code).toUpperCase(), load: 'code' },
  'POST /api/admin/promoters': { action: 'promoter.create', type: 'promoter', id: (req, b) => b?.promoter?.id ?? b?.id, load: 'promoter' },
  'POST /api/admin/promoters/:id': { action: 'promoter.update', type: 'promoter', id: P(), load: 'promoter' },
  'POST /api/admin/promoters/:id/reset-link': { action: 'promoter.reset_link', type: 'promoter', id: P() },
  'POST /api/admin/reset/start': { action: 'reset.start', type: 'reset', id: B('scope') },
  'POST /api/admin/reset': { action: 'reset.run', type: 'reset', id: B('scope') },
  // Ticket site (tickets.js)
  'POST /api/admin/tickets/events': { action: 'ticket_event.create', type: 'ticket_event', id: (req, b) => b?.event?.id ?? b?.id, load: 'ticket_event' },
  'POST /api/admin/tickets/events/:id': { action: 'ticket_event.update', type: 'ticket_event', id: P(), load: 'ticket_event' },
  'POST /api/admin/tickets/events/:id/delete': { action: 'ticket_event.delete', type: 'ticket_event', id: P(), load: 'ticket_event' },
  'POST /api/admin/tickets/products': { action: 'ticket_product.create', type: 'ticket_product', id: (req, b) => b?.product?.id ?? b?.id, load: 'ticket_product' },
  'POST /api/admin/tickets/products/:id': { action: 'ticket_product.update', type: 'ticket_product', id: P(), load: 'ticket_product' },
  'POST /api/admin/tickets/products/:id/delete': { action: 'ticket_product.delete', type: 'ticket_product', id: P(), load: 'ticket_product' },
  'POST /api/admin/tickets/tiers': { action: 'ticket_tier.create', type: 'ticket_tier', id: (req, b) => b?.tier?.id ?? b?.id, load: 'ticket_tier' },
  'POST /api/admin/tickets/tiers/:id': { action: 'ticket_tier.update', type: 'ticket_tier', id: P(), load: 'ticket_tier' },
  'POST /api/admin/tickets/tiers/:id/delete': { action: 'ticket_tier.delete', type: 'ticket_tier', id: P(), load: 'ticket_tier' },
  'POST /api/admin/tickets/bottles': { action: 'menu.bottle_create', type: 'bottle', id: ITEM },
  'POST /api/admin/tickets/bottles/:id': { action: 'menu.bottle_update', type: 'bottle', id: P() },
  'POST /api/admin/tickets/bottles/:id/delete': { action: 'menu.bottle_delete', type: 'bottle', id: P() },
  'POST /api/admin/tickets/chaser-groups': { action: 'menu.chaser_group_create', type: 'chaser_group', id: ITEM },
  'POST /api/admin/tickets/chaser-groups/:id': { action: 'menu.chaser_group_update', type: 'chaser_group', id: P() },
  'POST /api/admin/tickets/chaser-groups/:id/delete': { action: 'menu.chaser_group_delete', type: 'chaser_group', id: P() },
  'POST /api/admin/tickets/chasers': { action: 'menu.chaser_create', type: 'chaser', id: ITEM },
  'POST /api/admin/tickets/chasers/:id': { action: 'menu.chaser_update', type: 'chaser', id: P() },
  'POST /api/admin/tickets/chasers/:id/delete': { action: 'menu.chaser_delete', type: 'chaser', id: P() },
  'POST /api/admin/tickets/tier-labels': { action: 'menu.tier_labels', type: 'setting', id: () => 'bottle_tier_labels' },
  'POST /api/admin/tickets/terms': { action: 'ticket_terms.update', type: 'setting', id: () => 'tickets_terms' },
  'POST /api/admin/tickets/orders/:id/refund': { action: 'ticket.refund', type: 'ticket_order', id: P(), load: 'ticket_order' },
  'POST /api/admin/tickets/orders/:id/mark-paid': { action: 'ticket.mark_paid', type: 'ticket_order', id: P(), load: 'ticket_order' },
  'POST /api/admin/tickets/orders/:id/balance-due': { action: 'ticket.balance_due', type: 'ticket_order', id: P(), load: 'ticket_order' },
  'POST /api/admin/tickets/run-jobs': { action: 'tickets.run_checks', type: 'job', id: () => 'sweep' },
  // Admin accounts (auth.js): your own account, and the team (OWNER)
  'POST /api/admin/auth/logout': { action: 'logout', type: 'admin_user', id: (req) => req.admin?.id },
  'POST /api/admin/auth/logout-all': { action: 'session.revoke_all', type: 'admin_user', id: (req) => req.admin?.id },
  'POST /api/admin/auth/account/password': { action: 'password.change', type: 'admin_user', id: (req) => req.admin?.id },
  'POST /api/admin/auth/account/2fa/start': { action: '2fa.reset_start', type: 'admin_user', id: (req) => req.admin?.id },
  'POST /api/admin/auth/account/2fa/finish': { action: '2fa.reset_self', type: 'admin_user', id: (req) => req.admin?.id },
  'POST /api/admin/auth/account/recovery-codes': { action: 'recovery.regenerate', type: 'admin_user', id: (req) => req.admin?.id },
  'POST /api/admin/auth/account/sessions/:id/revoke': { action: 'session.revoke', type: 'admin_session', id: P() },
  'POST /api/admin/auth/account/passkeys/options': { skip: true },
  'POST /api/admin/auth/account/passkeys/verify': { action: 'passkey.add', type: 'passkey', id: R() },
  'POST /api/admin/auth/account/passkeys/:id/delete': { action: 'passkey.remove', type: 'passkey', id: P() },
  'POST /api/admin/team/invite': { action: 'team.invite', type: 'admin_invite', id: R() },
  'POST /api/admin/team/invites/:id/revoke': { action: 'team.invite_revoke', type: 'admin_invite', id: P() },
  'POST /api/admin/team/:id': { action: 'team.update', type: 'admin_user', id: P() },
  'POST /api/admin/team/:id/reset-2fa': { action: 'team.reset_2fa', type: 'admin_user', id: P() },
  'POST /api/admin/team/:id/unlock': { action: 'team.unlock', type: 'admin_user', id: P() },
  // The admin app's notifications (adminapp.js)
  'POST /api/admin/push/subscribe': { action: 'push.subscribe', type: 'push_subscription', id: R() },
  'POST /api/admin/push/prefs': { action: 'push.prefs', type: 'push_subscription', id: R() },
  'POST /api/admin/push/unsubscribe': { action: 'push.unsubscribe', type: 'push_subscription', id: R() },
  'POST /api/admin/push/test': { action: 'push.test', type: 'push_subscription', id: R() }
};

// The target's row before and after (money and status). Each returns a plain object or null.
const one = async (q) => (await q).rows[0] || null;
const settingsRow = (db, keys) => db.query('SELECT key, value FROM settings WHERE key = ANY($1)', [keys])
  .then((r) => Object.fromEntries(keys.map((k) => [k, r.rows.find((x) => x.key === k)?.value ?? null])));
const intId = (v) => { const n = parseInt(v, 10); return n > 0 && n <= 2147483647 ? n : 0; };
const LOADERS = {
  order: (db, id) => intId(id) && one(db.query(`SELECT o.reference_code, o.status, o.amount_cents, o.currency, o.paid_via, o.size, o.marked_paid_by,
      o.picked_up_at IS NOT NULL AS picked_up, o.cancel_requested_at IS NOT NULL AS refund_requested FROM orders o WHERE o.id = $1`, [intId(id)])),
  guest: (db, email) => email && one(db.query('SELECT approval, full_name, birth_date, instagram FROM guests WHERE LOWER(email) = $1 ORDER BY id LIMIT 1', [email])),
  package: (db, id) => intId(id) && one(db.query('SELECT name, price_cents, currency, capacity, active FROM packages WHERE id = $1', [intId(id)])),
  tier: (db, id) => intId(id) && one(db.query('SELECT package_id, name, price_cents, ends_at, quantity FROM package_tiers WHERE id = $1', [intId(id)])),
  code: (db, code) => code && one(db.query('SELECT kind, value, active, max_uses, expires_at, package_id, promoter_id FROM promo_codes WHERE code = $1', [code])),
  promoter: (db, id) => intId(id) && one(db.query('SELECT name, active, note FROM promoters WHERE id = $1', [intId(id)])),
  event: (db) => one(db.query("SELECT id, name, invites_per_guest, status FROM events WHERE status = 'current'")),
  ticket_order: (db, id) => intId(id) && one(db.query('SELECT ref, status, total_cents, paid_cents, currency, balance_due_at FROM ticket_orders WHERE id = $1', [intId(id)])),
  ticket_event: (db, id) => intId(id) && one(db.query('SELECT name, status, starts_at FROM ticket_events WHERE id = $1', [intId(id)])),
  ticket_product: (db, id) => intId(id) && one(db.query('SELECT name, kind, price_cents, currency, capacity, active FROM ticket_products WHERE id = $1', [intId(id)])),
  ticket_tier: (db, id) => intId(id) && one(db.query('SELECT product_id, name, price_cents, ends_at, quantity FROM ticket_tiers WHERE id = $1', [intId(id)])),
  site_lock: (db) => settingsRow(db, ['site_lock', 'site_unlock_at']),
  tickets_lock: (db) => settingsRow(db, ['tickets_lock', 'tickets_unlock_at']),
  size_lock: (db) => settingsRow(db, ['size_lock']),
  pay_settings: (db) => settingsRow(db, ['pay_rule', 'pay_days', 'pay_weekday', 'pay_time'])
};

export function createAudit({ pool }) {
  // One row. actor: { id, email, name, role } (req.admin), or null for the system. Never throws: an audit failure is
  // reported in the log, and the admin's action stands.
  async function log(actor, action, { target_type = null, target_id = null, ip = null, details = {}, keep = [] } = {}) {
    try {
      await pool.query(
        `INSERT INTO audit_log (user_id, user_email, user_name, role, action, target_type, target_id, ip, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [actor?.id ?? null, actor?.email ?? null, actor?.name ?? null, actor?.role ?? null, String(action).slice(0, 80),
          target_type, target_id === null || target_id === undefined || target_id === '' ? null : String(target_id).slice(0, 200),
          ip ? String(ip).slice(0, 64) : null, JSON.stringify(clean(details || {}, keep))]);
    } catch (err) {
      console.error('Audit log error:', err.message);
    }
  }
  const fromReq = (req, action, o = {}) => log(req.admin || null, action, { ip: req.ip, ...o });

  // The hook requireRole runs for every admin write: reads the target before the route runs, and writes the audit row
  // (with the target after) just before the answer goes out, so the row is there by the time the admin sees the result.
  // Only writes that succeeded (status < 400) are logged.
  async function hook(req, res) {
    const key = `${req.method} ${req.route?.path || req.path}`;
    const spec = ACTIONS[key] || { action: 'admin.write', type: null, id: () => null };
    if (spec.skip) return;
    const loader = spec.load && LOADERS[spec.load];
    const idNow = () => { try { return spec.id ? spec.id(req, null) : null; } catch { return null; } };
    let before = null;
    if (loader) { try { before = await loader(pool, idNow()) || null; } catch { before = null; } }
    const send = res.send;
    let done = false;
    res.send = function (body) {
      if (done || res.statusCode >= 400) return send.call(this, body);
      done = true;
      let answer = null;
      try { answer = typeof body === 'string' ? JSON.parse(body) : Buffer.isBuffer(body) ? null : body; } catch { answer = null; }
      let id = null;
      try { id = spec.id ? spec.id(req, answer) : null; } catch { id = null; }
      const after = loader ? Promise.resolve(loader(pool, id)).catch(() => null) : Promise.resolve(undefined);
      after.then((a) => fromReq(req, req.auditAction || spec.action, {
        target_type: spec.type, target_id: id, keep: spec.keep || [],
        details: { ...(ACTIONS[key] ? {} : { path: req.originalUrl.split('?')[0] }), request: req.body && typeof req.body === 'object' ? req.body : {},
          ...(loader ? { before, after: a || null } : {}), ...(req.auditExtra || {}) }
      })).finally(() => send.call(res, body));
      return res;
    };
  }

  // ---------- The page and its API ----------
  // Filters: user (id, or 'system' for jobs), action (a prefix like 'order.' or a full name), from / to ('YYYY-MM-DD',
  // Antigua days), target_type, target_id, before (an id, for the next page).
  function filters(q) {
    const where = [], args = [];
    const add = (sql, v) => { args.push(v); where.push(sql.replace('?', '$' + args.length)); };
    if (q.user === 'system') where.push('user_id IS NULL');
    else if (/^\d{1,9}$/.test(String(q.user || ''))) add('user_id = ?', Number(q.user));
    if (q.action) {
      const a = String(q.action).trim().slice(0, 80);
      if (a.endsWith('.')) add('action LIKE ?', a.replace(/[%_]/g, '') + '%'); else add('action = ?', a);
    }
    const day = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
    if (day(q.from)) add("(at AT TIME ZONE 'America/Antigua')::date >= ?::date", day(q.from));
    if (day(q.to)) add("(at AT TIME ZONE 'America/Antigua')::date <= ?::date", day(q.to));
    if (q.target_type) add('target_type = ?', String(q.target_type).slice(0, 40));
    if (q.target_id) add('target_id = ?', String(q.target_id).trim().slice(0, 200));
    if (/^\d{1,18}$/.test(String(q.before || ''))) add('id < ?', String(q.before));
    return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
  }

  function register({ app, requireRole }) {
    const ADMINS = requireRole('OWNER', 'ADMIN');
    app.get('/admin/audit', ADMINS, (req, res) => res.type('html').send(PAGE));
    app.get('/api/admin/audit', ADMINS, async (req, res) => {
      try {
        const f = filters(req.query);
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
        const [rows, people, actions] = await Promise.all([
          pool.query(`SELECT * FROM audit_log ${f.sql} ORDER BY id DESC LIMIT ${limit + 1}`, f.args),
          pool.query('SELECT id, name, email, role FROM admin_users ORDER BY name, id'),
          pool.query('SELECT DISTINCT action FROM audit_log ORDER BY action')
        ]);
        res.set('Cache-Control', 'no-store').json({ rows: rows.rows.slice(0, limit), more: rows.rows.length > limit,
          people: people.rows, actions: actions.rows.map((r) => r.action) });
      } catch (err) { console.error(err); res.status(500).json({ error: 'Server error.' }); }
    });
    app.get('/api/admin/audit.csv', ADMINS, async (req, res) => {
      try {
        const f = filters({ ...req.query, before: '' });
        const r = await pool.query(`SELECT * FROM audit_log ${f.sql} ORDER BY id DESC LIMIT 50000`, f.args);
        const cell = (v) => {
          let s = String(v ?? '');
          if (s && '=+-@\t\r'.includes(s[0])) s = "'" + s;
          return '"' + s.replace(/"/g, '""') + '"';
        };
        const rows = [['id', 'at', 'at_antigua', 'person', 'email', 'role', 'action', 'target_type', 'target_id', 'ip', 'details'],
          ...r.rows.map((x) => [x.id, new Date(x.at).toISOString(),
            new Date(x.at).toLocaleString('en-US', { timeZone: 'America/Antigua', dateStyle: 'medium', timeStyle: 'medium' }),
            x.user_name || (x.user_id ? '' : 'System'), x.user_email || '', x.role || '', x.action, x.target_type || '', x.target_id || '', x.ip || '', JSON.stringify(x.details)])];
        res.type('text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="audit-log.csv"')
          .send('﻿' + rows.map((row) => row.map(cell).join(',')).join('\n'));
      } catch (err) { console.error(err); res.status(500).json({ error: 'Server error.' }); }
    });
  }

  return { log, fromReq, hook, register };
}

// ---------- /admin/audit ----------
const PAGE = `${baseHead('Audit log', `
.filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin: 0 0 18px; }
.filters label { display: grid; gap: 6px; font: 400 11px/1.2 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--dim); }
.filters .acts { display: flex; gap: 8px; align-items: end; flex-wrap: wrap; }
.log { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.log li { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 4px 16px; padding: 12px 0; border-bottom: 1px solid var(--line); }
.log time { font: 400 12px/1.4 var(--mono); color: var(--muted); }
.log .what { min-width: 0; }
.log .act { font: 700 12.5px/1.4 var(--mono); letter-spacing: .02em; color: var(--text); }
.log .who { color: var(--muted); font-size: 13.5px; }
.log .tgt { font: 400 12px/1.4 var(--mono); color: var(--dim); overflow-wrap: anywhere; }
.log details { grid-column: 2; }
.log summary { cursor: pointer; color: var(--dim); font-size: 12.5px; min-height: 28px; display: inline-flex; align-items: center; }
.log pre { margin: 6px 0 0; padding: 10px 12px; background: var(--well); border: 1px solid var(--line); font: 400 12px/1.5 var(--mono); color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; }
.log .fail .act { color: var(--bad); }
.log .ok .act::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 8px; background: var(--accent); vertical-align: 2px; }
.more { margin-top: 18px; }
@media (max-width: 640px) { .log li { grid-template-columns: 1fr; } .log details { grid-column: 1; } }
`)}
<body>
${topBar('Audit log')}
<main class="wrap">
  <h1>Audit log</h1>
  <p class="lead">Every change made in the admin, by whom and when, plus sign-ins and lockouts. Money and status changes show the before and after.</p>
  <form class="filters" id="f">
    <label>Person<select id="f-user"><option value="">Everyone</option><option value="system">System (jobs)</option></select></label>
    <label>Action<select id="f-action"><option value="">All actions</option></select></label>
    <label>From<input type="date" id="f-from"></label>
    <label>To<input type="date" id="f-to"></label>
    <label>Target<input id="f-target" placeholder="e.g. 12, ODR-…, jane@x.com" autocomplete="off"></label>
    <div class="acts"><button type="submit">Filter</button><button class="ghost" type="button" id="f-csv">Export CSV</button></div>
  </form>
  <p id="count" class="msg" role="status"></p>
  <ul class="log" id="log"></ul>
  <button class="ghost more hidden" id="more" type="button">Load more</button>
</main>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>
${UI_JS}
let last = null;
const FAIL = /fail|locked|denied/;
function q(extra) {
  const p = new URLSearchParams();
  const v = { user: $('f-user').value, action: $('f-action').value, from: $('f-from').value, to: $('f-to').value, target_id: $('f-target').value.trim() };
  Object.keys(v).forEach((k) => { if (v[k]) p.set(k, v[k]); });
  Object.keys(extra || {}).forEach((k) => p.set(k, extra[k]));
  return p.toString();
}
function row(x) {
  const li = el('li', undefined, FAIL.test(x.action) ? 'fail' : 'ok');
  const t = el('time', when(x.at)); t.dateTime = x.at; li.appendChild(t);
  const w = el('div', undefined, 'what');
  w.appendChild(el('div', x.action, 'act'));
  w.appendChild(el('div', (x.user_name || (x.user_id ? x.user_email : x.user_email ? x.user_email : 'System')) + (x.role ? ' · ' + x.role.toLowerCase() : '') + (x.ip ? ' · ' + x.ip : ''), 'who'));
  if (x.target_type) w.appendChild(el('div', x.target_type + (x.target_id ? ' ' + x.target_id : ''), 'tgt'));
  li.appendChild(w);
  const keys = Object.keys(x.details || {});
  if (keys.length) {
    const d = el('details'); d.appendChild(el('summary', 'Details'));
    d.appendChild(el('pre', JSON.stringify(x.details, null, 2))); li.appendChild(d);
  }
  return li;
}
async function load(more) {
  const d = await api('/api/admin/audit?' + q(more && last ? { before: last } : {}));
  if (!more) {
    $('log').replaceChildren();
    const us = $('f-user'), keepU = us.value; [...us.querySelectorAll('option[data-p]')].forEach((o) => o.remove());
    d.people.forEach((p) => { const o = el('option', p.name + ' (' + p.role.toLowerCase() + ')'); o.value = p.id; o.dataset.p = 1; us.appendChild(o); });
    us.value = keepU;
    const as = $('f-action'), keepA = as.value; [...as.querySelectorAll('option[data-a]')].forEach((o) => o.remove());
    const groups = [...new Set(d.actions.map((a) => a.split('.')[0] + '.'))];
    groups.forEach((g) => { const o = el('option', g + '*'); o.value = g; o.dataset.a = 1; as.appendChild(o); });
    d.actions.forEach((a) => { const o = el('option', a); o.value = a; o.dataset.a = 1; as.appendChild(o); });
    as.value = keepA;
  }
  d.rows.forEach((x) => $('log').appendChild(row(x)));
  last = d.rows.length ? d.rows[d.rows.length - 1].id : last;
  $('more').classList.toggle('hidden', !d.more);
  const n = $('log').children.length;
  $('count').textContent = n ? n + (d.more ? '+' : '') + ' entries' : 'Nothing logged for these filters.';
}
$('f').addEventListener('submit', (e) => { e.preventDefault(); load(false).catch((er) => toast(er.message, true)); });
$('more').addEventListener('click', () => load(true).catch((er) => toast(er.message, true)));
$('f-csv').addEventListener('click', () => { location.href = '/api/admin/audit.csv?' + q(); });
// ?action=, ?user=, ?from=, ?to=, ?target= preset the filters (the selects once their options have loaded).
const qs = new URLSearchParams(location.search);
['from', 'to'].forEach((k) => { if (qs.get(k)) $('f-' + k).value = qs.get(k); });
if (qs.get('target')) $('f-target').value = qs.get('target');
const preset = (id, v) => { if (!v) return; const s = $(id); if (![...s.options].some((o) => o.value === v)) { const o = el('option', v); o.value = v; o.dataset[id === 'f-user' ? 'p' : 'a'] = 1; s.appendChild(o); } s.value = v; };
preset('f-action', qs.get('action')); preset('f-user', qs.get('user'));
load(false).catch((er) => toast(er.message, true));
</script>
</body></html>`;
