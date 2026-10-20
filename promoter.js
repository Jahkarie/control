// promoter.js: promoters. Each one gets codes (any kind, TRACK included: full price, it only records who brought the
// guest), invites for the current event (promoter_event.invites) and a private page at /promoter/<token> with their
// numbers. The page is phone-first and shows counts only: no guest names, emails or Instagram handles, except the
// emails of their own pending invites, which they typed and may revoke.
// The token is "<id>.<sig>", sig = HMAC(TOKEN_SECRET, 'promoter:' + id + ':' + token_version), compared in constant time.
// The page sends it back as an x-promoter-token header to /api/promoter/*. Reset link bumps token_version, so the old
// link stops working; so does turning the promoter off (their codes stop applying too, see checkPromo in pricing.js).
// /promoter/* and /api/promoter/* work while the site is locked (lock.js), but sending an invite then is refused,
// since nobody could accept it yet.
// Tables (created by ensureSchema() in server.js): promoters, promoter_event; promo_codes.promoter_id and
// invites.promoter_id (invites from a promoter have inviter_email 'PROMOTER').
import crypto from 'crypto';
import { CUR } from './events.js';
import { promoLabel } from './pricing.js';

const TOKEN_RE = /^(\d{1,9})\.([A-Za-z0-9_-]{43})$/;
const HOUR_MS = 60 * 60 * 1000;
const toInt = (v) => (typeof v === 'number' || (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) ? Number(v) : NaN);
const idOf = (v) => { const n = toInt(v); return n > 0 && n <= 2147483647 ? n : 0; };

// What a code does, as the promoter and the owner read it.
export const codeLabel = (c, currency) => (c.kind === 'TRACK' ? 'Tracking only (full price)' : promoLabel(c, currency));

export function registerPromoters({ app, pool, TOKEN_SECRET, safeEqual, requireAdmin, rateLimit, lock, mail, renderEmail,
  normalizeEmail, isValidEmail, hashToken, newInviteToken, inviteLink, inviteBlocked, SITE_URL, PUBLIC_URL }) {
  const fail = (res, err) => { console.error('Promoter error:', err); res.status(500).json({ error: 'Server error.' }); };
  const sig = (id, version) => crypto.createHmac('sha256', TOKEN_SECRET).update(`promoter:${id}:${version}`).digest('base64url');
  const tokenOf = (p) => `${p.id}.${sig(p.id, p.token_version)}`;
  const base = (req) => PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const linkOf = (req, p) => `${base(req)}/promoter/${tokenOf(p)}`;

  // The promoter a token belongs to, if it's valid and they're active. null otherwise.
  async function promoterFor(token) {
    const m = TOKEN_RE.exec(String(token || ''));
    if (!m) return null;
    const r = await pool.query('SELECT id, name, active, token_version FROM promoters WHERE id = $1', [Number(m[1])]);
    const p = r.rows[0];
    // Compared even when there's no such promoter, so a wrong id takes as long as a wrong signature.
    const ok = safeEqual(m[2], sig(m[1], p ? p.token_version : 'none'));
    return p && ok && p.active ? p : null;
  }
  const requirePromoter = async (req, res, next) => {
    try {
      const p = await promoterFor(req.get('x-promoter-token'));
      if (!p) return res.status(401).json({ error: "This link doesn't work any more. Ask the organizers for a new one.", code: 'LINK_INVALID' });
      req.promoter = p;
      next();
    } catch (err) { fail(res, err); }
  };

  // One promoter's numbers for one event. withPeople adds who (names and emails) for the owner's view.
  async function stats(db, promoterId, eventId, withPeople) {
    const [codes, orders, money, inv, allow, pending] = await Promise.all([
      db.query(
        `SELECT c.code, c.kind, c.value, c.max_uses, c.expires_at, c.active, c.package_id, p.name AS package_name, p.currency,
                (SELECT COUNT(*) FROM orders o WHERE o.promo_code = c.code AND o.status <> 'CANCELLED')::int AS uses
         FROM promo_codes c LEFT JOIN packages p ON p.id = c.package_id
         WHERE c.promoter_id = $1 AND c.event_id = $2 ORDER BY c.created_at, c.code`, [promoterId, eventId]),
      db.query(
        `SELECT COUNT(*) FILTER (WHERE o.status = 'RESERVED')::int AS reserved, COUNT(*) FILTER (WHERE o.status = 'PAID')::int AS paid,
                COUNT(*) FILTER (WHERE o.status = 'CANCELLED')::int AS cancelled
         FROM orders o JOIN promo_codes c ON c.code = o.promo_code WHERE c.promoter_id = $1 AND o.event_id = $2`, [promoterId, eventId]),
      db.query(
        `SELECT COALESCE(o.currency, p.currency) AS currency, SUM(COALESCE(o.amount_cents, p.price_cents))::bigint AS cents
         FROM orders o JOIN packages p ON p.id = o.package_id JOIN promo_codes c ON c.code = o.promo_code
         WHERE c.promoter_id = $1 AND o.event_id = $2 AND o.status = 'PAID'
         GROUP BY 1 HAVING SUM(COALESCE(o.amount_cents, p.price_cents)) > 0 ORDER BY 1`, [promoterId, eventId]),
      db.query(
        `SELECT COUNT(*) FILTER (WHERE i.status <> 'REVOKED')::int AS sent,
                COUNT(*) FILTER (WHERE i.status = 'PENDING')::int AS pending,
                COUNT(*) FILTER (WHERE i.status = 'ACCEPTED')::int AS accepted,
                COUNT(*) FILTER (WHERE i.status = 'ACCEPTED' AND EXISTS (SELECT 1 FROM guests g WHERE LOWER(g.email) = i.invitee_email AND g.approval = 'APPROVED'))::int AS approved,
                COUNT(*) FILTER (WHERE i.status = 'ACCEPTED' AND EXISTS (SELECT 1 FROM orders o WHERE LOWER(o.guest_email) = i.invitee_email AND o.status = 'PAID' AND o.event_id = $2))::int AS paid
         FROM invites i WHERE i.promoter_id = $1 AND i.event_id = $2`, [promoterId, eventId]),
      db.query('SELECT invites FROM promoter_event WHERE promoter_id = $1 AND event_id = $2', [promoterId, eventId]),
      db.query(`SELECT id, invitee_email AS email, created_at FROM invites WHERE promoter_id = $1 AND event_id = $2 AND status = 'PENDING' ORDER BY id DESC`,
        [promoterId, eventId])
    ]);
    const allowance = allow.rows[0]?.invites || 0;
    const out = {
      codes: codes.rows.map((c) => ({ code: c.code, kind: c.kind, label: codeLabel(c, c.package_id ? c.currency : null), uses: c.uses, max_uses: c.max_uses,
        expires_at: c.expires_at, active: c.active, package: c.package_name || null })),
      orders: orders.rows[0],
      received: money.rows.map((m) => ({ currency: m.currency, cents: Number(m.cents) })),
      invites: { ...inv.rows[0], allowance, left: Math.max(0, allowance - inv.rows[0].sent) },
      pending: pending.rows
    };
    if (withPeople) {
      const [invited, buyers] = await Promise.all([
        db.query(
          `SELECT i.invitee_email AS email, i.status, g.full_name, g.approval,
                  EXISTS (SELECT 1 FROM orders o WHERE LOWER(o.guest_email) = i.invitee_email AND o.status = 'PAID' AND o.event_id = $2) AS paid
           FROM invites i LEFT JOIN guests g ON LOWER(g.email) = i.invitee_email
           WHERE i.promoter_id = $1 AND i.event_id = $2 AND i.status = 'ACCEPTED' ORDER BY i.accepted_at DESC NULLS LAST, i.id DESC`, [promoterId, eventId]),
        db.query(
          `SELECT o.guest_email AS email, g.full_name, o.promo_code AS code, o.status, o.reference_code,
                  COALESCE(o.amount_cents, p.price_cents) AS amount_cents, COALESCE(o.currency, p.currency) AS currency
           FROM orders o JOIN packages p ON p.id = o.package_id JOIN promo_codes c ON c.code = o.promo_code
           LEFT JOIN (SELECT DISTINCT ON (LOWER(email)) LOWER(email) AS email, full_name FROM guests ORDER BY LOWER(email), id) g ON g.email = LOWER(o.guest_email)
           WHERE c.promoter_id = $1 AND o.event_id = $2 ORDER BY o.id DESC`, [promoterId, eventId])
      ]);
      out.people = { invited: invited.rows, orders: buyers.rows };
    }
    return out;
  }

  // Past events where the promoter had codes or invites: how they did there.
  async function pastSummary(db, promoterId) {
    const r = await db.query(
      `SELECT e.id, e.name, e.started_at, e.ended_at,
              (SELECT COUNT(*) FROM orders o JOIN promo_codes c ON c.code = o.promo_code WHERE c.promoter_id = $1 AND o.event_id = e.id AND o.status = 'PAID')::int AS paid,
              (SELECT COUNT(*) FROM invites i WHERE i.promoter_id = $1 AND i.event_id = e.id AND i.status <> 'REVOKED')::int AS invites_sent,
              (SELECT COUNT(*) FROM invites i WHERE i.promoter_id = $1 AND i.event_id = e.id AND i.status = 'ACCEPTED')::int AS invites_accepted
       FROM events e WHERE e.status = 'past'
         AND (EXISTS (SELECT 1 FROM promo_codes c WHERE c.promoter_id = $1 AND c.event_id = e.id) OR EXISTS (SELECT 1 FROM invites i WHERE i.promoter_id = $1 AND i.event_id = e.id))
       ORDER BY e.ended_at DESC NULLS LAST, e.id DESC LIMIT 10`, [promoterId]);
    if (!r.rowCount) return [];
    const m = await db.query(
      `SELECT o.event_id, COALESCE(o.currency, p.currency) AS currency, SUM(COALESCE(o.amount_cents, p.price_cents))::bigint AS cents
       FROM orders o JOIN packages p ON p.id = o.package_id JOIN promo_codes c ON c.code = o.promo_code
       WHERE c.promoter_id = $1 AND o.status = 'PAID' AND o.event_id = ANY($2::int[])
       GROUP BY 1, 2 HAVING SUM(COALESCE(o.amount_cents, p.price_cents)) > 0 ORDER BY 2`, [promoterId, r.rows.map((e) => e.id)]);
    return r.rows.map(({ id, ...e }) => ({ ...e, received: m.rows.filter((x) => x.event_id === id).map((x) => ({ currency: x.currency, cents: Number(x.cents) })) }));
  }

  const currentEvent = async (db) => (await db.query("SELECT id, name FROM events WHERE status = 'current'")).rows[0];

  // ---------- The promoter's own page and API ----------
  const PAGE_HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' };
  app.get('/promoter/:token', rateLimit(120, 15 * 60 * 1000), async (req, res) => {
    try {
      const p = await promoterFor(req.params.token);
      res.status(p ? 200 : 404).set(PAGE_HEADERS).type('html').send(p ? PAGE : GONE);
    } catch (err) {
      console.error('Promoter page error:', err);
      res.status(500).set(PAGE_HEADERS).type('html').send(GONE);
    }
  });

  const apiLimit = rateLimit(300, 15 * 60 * 1000);
  app.get('/api/promoter/me', apiLimit, requirePromoter, async (req, res) => {
    try {
      const ev = await currentEvent(pool);
      const [s, past] = await Promise.all([stats(pool, req.promoter.id, ev.id, false), pastSummary(pool, req.promoter.id)]);
      res.set('Cache-Control', 'no-store').json({ promoter: { name: req.promoter.name }, event: { name: ev.name }, site_url: SITE_URL, ...s, past });
    } catch (err) { fail(res, err); }
  });

  // Sends an invite for the current event, from the promoter's allowance there. The same rules as a guest's invite:
  // single-use, tied to the email, only the hash kept, and nobody on the roster or already invited.
  app.post('/api/promoter/invites', apiLimit, requirePromoter, rateLimit(20, HOUR_MS, (req) => 'p:' + req.promoter.id), rateLimit(60, HOUR_MS),
    async (req, res) => {
      const recipient = normalizeEmail(req.body?.email);
      const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 300) : '';
      if (!isValidEmail(recipient)) return res.status(400).json({ error: 'Enter a valid email.' });
      let client;
      try {
        // While the site is locked nobody can open an invite link, so it would only go to waste.
        if (await lock.lockedNow()) {
          return res.status(423).json({ error: "The site is locked, so nobody could accept an invite yet. Send it once the site is open.", code: 'SITE_LOCKED' });
        }
        const token = newInviteToken();
        client = await pool.connect();
        await client.query('BEGIN');
        const ev = (await client.query("SELECT id, name FROM events WHERE status = 'current' FOR SHARE")).rows[0];
        // Locked until the invite is saved, so two quick sends can't both take the last invite.
        const me = (await client.query('SELECT id, name, active FROM promoters WHERE id = $1 FOR UPDATE', [req.promoter.id])).rows[0];
        if (!me || !me.active) {
          await client.query('ROLLBACK');
          return res.status(401).json({ error: "This link doesn't work any more. Ask the organizers for a new one.", code: 'LINK_INVALID' });
        }
        if (await inviteBlocked(client, recipient)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'That person has already been invited.' });
        }
        const allow = (await client.query('SELECT invites FROM promoter_event WHERE promoter_id = $1 AND event_id = $2', [me.id, ev.id])).rows[0]?.invites || 0;
        const sent = (await client.query(
          "SELECT COUNT(*)::int AS n FROM invites WHERE promoter_id = $1 AND event_id = $2 AND status <> 'REVOKED'", [me.id, ev.id])).rows[0].n;
        if (sent >= allow) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: allow ? "You've used all your invites for this event." : 'You have no invites for this event yet.', code: 'NO_INVITES' });
        }
        await client.query(
          "INSERT INTO invites (token_hash, inviter_email, invitee_email, note, event_id, promoter_id) VALUES ($1, 'PROMOTER', $2, $3, $4, $5)",
          [hashToken(token), recipient, note, ev.id, me.id]);
        const emailError = await mail.send(recipient, `${me.name} invited you — On D' Road`, renderEmail({
          tone: 'accent', tag: "You're invited", title: "You're on the list",
          lines: [`${me.name} invited you to On D' Road.`,
            "This invitation is personal and single-use. It only works with this email address, so don't forward it or post it."],
          quote: note ? { from: me.name, text: note } : null,
          cta: { text: 'Accept invitation', url: inviteLink(token), fallback: true },
          fine: 'Accepting sends your request to the organizers. We email you once you are approved.'
        }));
        if (emailError) throw Object.assign(new Error(emailError.message || 'email failed'), { publicMessage: 'The email could not be delivered. Nothing was used.' });
        await client.query('COMMIT');
        res.json({ success: true, left: Math.max(0, allow - sent - 1) });
      } catch (err) {
        await client?.query('ROLLBACK').catch(() => {});
        if (err.code === '23505') return res.status(400).json({ error: 'That person has already been invited.' });
        console.error('Promoter invite error:', err);
        res.status(500).json({ error: err.publicMessage || 'Server error.' });
      } finally {
        client?.release();
      }
    });

  // Revokes one of their own pending invites; the link stops working and the invite comes back to them.
  app.post('/api/promoter/invites/:id/revoke', apiLimit, requirePromoter, async (req, res) => {
    const id = idOf(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid invite.' });
    try {
      const r = await pool.query("UPDATE invites SET status = 'REVOKED' WHERE id = $1 AND promoter_id = $2 AND status = 'PENDING'", [id, req.promoter.id]);
      if (!r.rowCount) return res.status(400).json({ error: 'Only pending invites can be revoked.' });
      res.json({ success: true });
    } catch (err) { fail(res, err); }
  });

  // ---------- Admin ----------
  function promoterInput(b, partial) {
    const f = {};
    if (!partial || b.name !== undefined) {
      f.name = typeof b.name === 'string' ? b.name.replace(/\s+/g, ' ').trim() : '';
      if (!f.name || f.name.length > 60) return { error: 'Give the promoter a name of up to 60 characters.' };
    }
    if (b.note !== undefined) {
      f.note = b.note === null ? '' : typeof b.note === 'string' ? b.note.trim() : null;
      if (f.note === null || f.note.length > 300) return { error: 'Keep the note to 300 characters or fewer.' };
    }
    if (b.active !== undefined) f.active = !!b.active;
    let invites;
    if (b.invites !== undefined && b.invites !== '') {
      invites = toInt(b.invites);
      if (!(Number.isInteger(invites) && invites >= 0 && invites <= 500)) return { error: 'Invites is a whole number from 0 to 500.' };
    }
    return { fields: f, invites };
  }
  const setInvites = (db, id, eventId, n) => db.query(
    `INSERT INTO promoter_event (promoter_id, event_id, invites) VALUES ($1, $2, $3)
     ON CONFLICT (promoter_id, event_id) DO UPDATE SET invites = EXCLUDED.invites`, [id, eventId, n]);

  app.get('/api/admin/promoters', requireAdmin, async (req, res) => {
    try {
      const ev = await currentEvent(pool);
      const list = (await pool.query('SELECT * FROM promoters ORDER BY active DESC, LOWER(name), id')).rows;
      const out = [];
      for (const p of list) {
        out.push({ id: p.id, name: p.name, note: p.note, active: p.active, created_at: p.created_at, link: linkOf(req, p),
          ...(await stats(pool, p.id, ev.id, true)), past: await pastSummary(pool, p.id) });
      }
      res.set('Cache-Control', 'no-store').json({ event: ev, promoters: out });
    } catch (err) { fail(res, err); }
  });

  app.post('/api/admin/promoters', requireAdmin, async (req, res) => {
    const { error, fields: f, invites } = promoterInput(req.body || {}, false);
    if (error) return res.status(400).json({ error });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const p = (await client.query('INSERT INTO promoters (name, note) VALUES ($1, $2) RETURNING *', [f.name, f.note || ''])).rows[0];
      if (invites !== undefined) await setInvites(client, p.id, (await currentEvent(client)).id, invites);
      await client.query('COMMIT');
      res.json({ success: true, id: p.id, link: linkOf(req, p) });
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      fail(res, err);
    } finally {
      client?.release();
    }
  });

  // Partial edit: name, note, active, and invites (their allowance for the current event).
  app.post('/api/admin/promoters/:id', requireAdmin, async (req, res) => {
    const id = idOf(req.params.id);
    const { error, fields: f, invites } = promoterInput(req.body || {}, true);
    if (error) return res.status(400).json({ error });
    const cols = Object.keys(f); // fixed names from promoterInput, never from the request
    if (!id || (!cols.length && invites === undefined)) return res.status(400).json({ error: 'Nothing to update.' });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const r = cols.length
        ? await client.query(`UPDATE promoters SET ${cols.map((c, n) => `${c} = $${n + 2}`).join(', ')} WHERE id = $1`, [id, ...cols.map((c) => f[c])])
        : await client.query('SELECT 1 FROM promoters WHERE id = $1 FOR UPDATE', [id]);
      if (!r.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: "That promoter doesn't exist." });
      }
      if (invites !== undefined) await setInvites(client, id, (await currentEvent(client)).id, invites);
      await client.query('COMMIT');
      res.json({ success: true });
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      fail(res, err);
    } finally {
      client?.release();
    }
  });

  // A new link: the old one stops working at once.
  app.post('/api/admin/promoters/:id/reset-link', requireAdmin, async (req, res) => {
    const id = idOf(req.params.id);
    try {
      const r = await pool.query('UPDATE promoters SET token_version = token_version + 1 WHERE id = $1 RETURNING *', [id]);
      if (!r.rowCount) return res.status(404).json({ error: "That promoter doesn't exist." });
      res.json({ success: true, link: linkOf(req, r.rows[0]) });
    } catch (err) { fail(res, err); }
  });

  return { promoterFor };
}

// ---------- The promoter's page ----------
const HEAD = `<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0a0a0b">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">`;
const BASE_CSS = `:root { --bg: #0a0a0b; --surface: #141416; --surface-2: #1a1a1d; --raise: #232327; --well: #0a0a0b; --line: rgba(236, 235, 230, .1); --line-strong: rgba(236, 235, 230, .24); --text: #ecebe6; --muted: #a6a59f; --dim: #8a8983; --accent: #ff5a1f; --accent-hi: #ff7440; --accent-ink: #141416; --good: #b6ff3b; --warn: #ffc02e; --bad: #ff7a6b; --cyan: #22e1ff; --concrete: #c9c8c3; --concrete-2: #e4e3df; --ink: #141416; --ink-2: #47463f; --display: 'Archivo', 'Helvetica Neue', Arial, sans-serif; --body: 'Archivo', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; --mono: 'Space Mono', ui-monospace, SFMono-Regular, Menlo, monospace; --xh: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28' fill='none' stroke='%23141416' stroke-opacity='0.55' stroke-width='1'%3E%3Ccircle cx='14' cy='14' r='6.5'/%3E%3Cpath d='M14 0v28M0 14h28'/%3E%3C/svg%3E"); color-scheme: dark; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 var(--body); -webkit-font-smoothing: antialiased; }
::selection { background: var(--accent); color: var(--accent-ink); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.hidden { display: none !important; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 56px; padding: 10px 16px; border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.brand .mark { flex: none; width: 30px; height: 18px; overflow: visible; }
.brand b { font-family: var(--display); font-stretch: 125%; font-weight: 900; font-size: 16px; line-height: 1; white-space: nowrap; }
.brand b span { color: var(--accent); }
.brand b i { font-style: normal; font-weight: 200; }
.top .tag { font-family: var(--mono); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); white-space: nowrap; }
.top .tag::before { content: '[ '; color: var(--dim); } .top .tag::after { content: ' ]'; color: var(--dim); }
.wrap { max-width: 640px; margin: 0 auto; padding: 24px 16px 64px; }`;
const MARK = `<svg class="mark" viewBox="0 0 30 18" aria-hidden="true" focusable="false"><path fill="#e4e3df" d="M0 6h30v12H0z"/><path fill="#0a0a0b" d="M18.2 0h5.6l-4.6 18h-5.6z"/><path fill="#ff5a1f" d="M19.6 0h2.8l-4.6 18h-2.8z"/></svg><b>ON D<span>'</span> <i>ROAD</i></b>`;

const GONE = `<!DOCTYPE html><html lang="en"><head>${HEAD}<title>Link not working | On D' Road</title>
<style>${BASE_CSS}
h1 { font-family: var(--display); font-stretch: 125%; font-weight: 900; font-size: 34px; line-height: 1; text-transform: uppercase; margin: 24px 0 12px; }
p { color: var(--muted); margin: 0; }</style></head><body>
<header class="top"><div class="brand">${MARK}</div><span class="tag">Promoter</span></header>
<main class="wrap"><h1>Link not working</h1><p>This promoter link doesn't work any more. Ask the organizers for a new one.</p></main></body></html>`;

const PAGE = `<!DOCTYPE html>
<html lang="en"><head>${HEAD}
<title>Promoter | On D' Road</title>
<style>${BASE_CSS}
.hello { margin: 0; font-family: var(--mono); font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
h1 { position: relative; font-family: var(--display); font-stretch: 125%; font-weight: 900; font-size: clamp(30px, 9vw, 44px); line-height: .95; letter-spacing: -.01em; text-transform: uppercase; margin: 8px 0 0; padding-bottom: 18px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
h1::after { content: ''; position: absolute; left: 0; bottom: -1px; width: 56px; height: 2px; background: var(--accent); }
h2 { font-family: var(--display); font-stretch: 118%; font-weight: 800; font-size: 17px; line-height: 1.1; letter-spacing: .01em; text-transform: uppercase; margin: 32px 0 12px; }
.lead { color: var(--muted); margin: 14px 0 0; font-size: 14px; }
.kpis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); }
.stat { position: relative; background: var(--surface); padding: 16px 14px 13px; min-width: 0; }
.stat::before { content: ''; position: absolute; top: 7px; left: 7px; width: 7px; height: 7px; border-top: 1px solid var(--line-strong); border-left: 1px solid var(--line-strong); }
.stat .label { display: block; font-family: var(--mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.stat .value { display: block; font-family: var(--display); font-stretch: 125%; font-weight: 800; font-size: 34px; line-height: 1; margin-top: 10px; font-variant-numeric: tabular-nums; }
.stat .value.money { font-family: var(--mono); font-stretch: 100%; font-weight: 700; font-size: 15px; line-height: 1.35; overflow-wrap: anywhere; }
.stat .sub { display: block; font-size: 12px; color: var(--dim); margin-top: 6px; }
.stat.wide { grid-column: 1 / -1; }
ul.list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
ul.list li { display: flex; align-items: center; justify-content: space-between; gap: 6px 14px; flex-wrap: wrap; padding: 13px 0; border-bottom: 1px solid var(--line); min-width: 0; }
.code { font-family: var(--mono); font-weight: 700; font-size: 15px; letter-spacing: .06em; overflow-wrap: anywhere; }
.what { display: block; color: var(--muted); font-size: 13px; margin-top: 2px; }
.uses { font-family: var(--mono); font-size: 13px; color: var(--text); white-space: nowrap; font-variant-numeric: tabular-nums; }
.uses.off { color: var(--dim); }
.email { min-width: 0; overflow-wrap: anywhere; font-size: 14.5px; }
.when { display: block; color: var(--dim); font-family: var(--mono); font-size: 11.5px; margin-top: 2px; }
.empty { color: var(--dim); font-style: italic; margin: 0; padding: 14px 0; border-top: 1px solid var(--line); }
button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; font-family: var(--display); font-weight: 700; font-stretch: 112%; font-size: 13px; line-height: 1; letter-spacing: .05em; text-transform: uppercase; padding: 0 18px; border-radius: 0; cursor: pointer; color: var(--accent-ink); background: var(--accent); border: 1px solid var(--accent); transition: background .15s, border-color .15s; white-space: nowrap; }
button:hover { background: var(--accent-hi); border-color: var(--accent-hi); }
button:active { transform: translateY(1px); }
button:disabled { opacity: .5; cursor: progress; transform: none; }
button.ghost { color: var(--text); background: transparent; border-color: var(--line-strong); }
button.ghost:hover { border-color: var(--text); background: rgba(236, 235, 230, .05); }
button.small { min-height: 44px; padding: 0 14px; font-size: 11.5px; }
form { margin-top: 4px; }
label { display: block; font-family: var(--mono); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 16px 0 8px; }
input, textarea { width: 100%; min-height: 48px; font: 500 16px var(--body); color: var(--text); background: var(--well); border: 1px solid var(--line-strong); border-radius: 0; padding: 12px 13px; min-width: 0; }
textarea { min-height: 84px; resize: vertical; line-height: 1.45; }
input:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
input::placeholder, textarea::placeholder { color: var(--dim); }
form button[type=submit] { width: 100%; margin-top: 16px; min-height: 50px; }
.left { margin: 0 0 4px; font-size: 14px; color: var(--muted); }
.left b { color: var(--text); font-family: var(--mono); }
.msg { min-height: 22px; margin: 10px 0 0; font-size: 14px; font-weight: 600; }
.msg.ok { color: var(--good); } .msg.err { color: var(--bad); }
.note { margin: 12px 0 0; color: var(--dim); font-size: 13px; }
.past li { display: block; }
.past b { font-weight: 700; }
.past .facts { display: block; color: var(--muted); font-size: 13.5px; margin-top: 3px; }
.foot { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--dim); font-family: var(--mono); font-size: 11.5px; letter-spacing: .04em; }
.loading { color: var(--muted); }
.toast { position: fixed; left: 50%; bottom: 20px; z-index: 80; transform: translate(-50%, 16px); width: max-content; max-width: calc(100vw - 32px); padding: 13px 18px 13px 16px; border-left: 3px solid var(--accent); background: var(--concrete-2); color: var(--ink); font-size: 14px; font-weight: 600; line-height: 1.4; opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s; }
.toast.show { opacity: 1; transform: translate(-50%, 0); }
.toast.bad { border-left-color: #b3261e; background: #ffd9d4; color: #3a0d09; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } button:active { transform: none; } }
</style></head><body>
<header class="top"><div class="brand">${MARK}</div><span class="tag">Promoter</span></header>
<main class="wrap" id="main">
  <p class="hello" id="hello">Loading&hellip;</p>
  <h1 id="ev">&nbsp;</h1>
  <p class="lead">Your numbers for this event. Counts only: guests' names and details stay with the organizers.</p>

  <h2>Orders through your codes</h2>
  <div class="kpis" id="kpis" aria-live="polite"></div>

  <h2>Your codes</h2>
  <div id="codes"><p class="loading">Loading&hellip;</p></div>

  <h2>Invites</h2>
  <div class="kpis" id="ikpis"></div>
  <form id="inv" novalidate>
    <label for="inv-email">Their email</label>
    <input id="inv-email" type="email" inputmode="email" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="name@example.com" maxlength="254">
    <label for="inv-note">Personal note (optional)</label>
    <textarea id="inv-note" maxlength="300" placeholder="Shown in the invite email"></textarea>
    <button type="submit" id="inv-go">Send invite</button>
    <p id="inv-msg" class="msg" role="status"></p>
  </form>
  <p class="note">An invite is single-use and only works with that email. Whoever accepts waits for the organizers to approve them.</p>

  <h2>Waiting to be accepted</h2>
  <div id="pending"></div>

  <div id="past-wrap" class="hidden">
    <h2>Past events</h2>
    <ul class="list past" id="past"></ul>
  </div>
  <p class="foot">This page is private to you. Keep the link to yourself.</p>
</main>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>
var $ = function (id) { return document.getElementById(id); };
// The token is the last part of this page's address. It goes to the API in a header, never in a URL.
var TOKEN = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
var data = null;
function el(tag, text, cls) { var e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = text; if (cls) e.className = cls; return e; }
function money(c) { return c.currency + ' ' + (c.cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function received(list) { return list && list.length ? list.map(money).join(' + ') : 'XCD 0.00'; }
function day(iso) { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Antigua' }); }
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
var toastTimer;
function toast(text, bad) { var t = $('toast'); t.textContent = text; t.className = 'toast show' + (bad ? ' bad' : ''); clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = 'toast'; }, 4000); }
function call(path, body) {
  return fetch(path, { method: body ? 'POST' : 'GET', cache: 'no-store', headers: Object.assign({ 'x-promoter-token': TOKEN }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined })
    .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) { var e = new Error(d.error || 'Something went wrong.'); e.status = r.status; e.code = d.code; throw e; } return d; }); });
}
function gone() {
  $('main').replaceChildren(el('h1', 'Link not working'), el('p', "This promoter link doesn't work any more. Ask the organizers for a new one.", 'lead'));
}
function stat(box, label, value, sub, cls) {
  var d = el('div', undefined, 'stat' + (cls ? ' ' + cls : ''));
  d.appendChild(el('span', label, 'label'));
  d.appendChild(el('span', value, 'value' + (cls === 'wide money' ? ' money' : '')));
  if (sub) d.appendChild(el('span', sub, 'sub'));
  box.appendChild(d);
}
function render() {
  var d = data;
  $('hello').textContent = 'Hi ' + d.promoter.name;
  $('ev').textContent = d.event.name;
  document.title = d.event.name + ' | Promoter';
  var k = $('kpis'); k.replaceChildren();
  stat(k, 'Paid', String(d.orders.paid), 'Passes confirmed');
  stat(k, 'Reserved', String(d.orders.reserved), 'Not paid yet');
  stat(k, 'Cancelled', String(d.orders.cancelled), 'Expired or refunded');
  var uses = d.codes.reduce(function (n, c) { return n + c.uses; }, 0);
  stat(k, 'Code uses', String(uses), plural(d.codes.length, 'code', 'codes'));
  var m = el('div', undefined, 'stat wide');
  m.appendChild(el('span', 'Money received', 'label'));
  m.appendChild(el('span', received(d.received), 'value money'));
  m.appendChild(el('span', 'From paid orders through your codes', 'sub'));
  k.appendChild(m);

  var cb = $('codes'); cb.replaceChildren();
  if (!d.codes.length) cb.appendChild(el('p', 'No codes for this event yet. The organizers set them up.', 'empty'));
  else {
    var ul = el('ul', undefined, 'list');
    d.codes.forEach(function (c) {
      var li = el('li');
      var left = el('div');
      left.appendChild(el('span', c.code, 'code'));
      var expired = c.expires_at && new Date(c.expires_at).getTime() <= Date.now();
      var used = c.max_uses !== null && c.uses >= c.max_uses;
      left.appendChild(el('span', c.label + (c.package ? ' · ' + c.package : '') + (!c.active ? ' · Off' : expired ? ' · Expired' : used ? ' · Used up' : ''), 'what'));
      li.appendChild(left);
      var right = el('div');
      right.style.display = 'flex'; right.style.alignItems = 'center'; right.style.gap = '12px';
      right.appendChild(el('span', c.uses + (c.max_uses === null ? '' : ' / ' + c.max_uses) + ' used', 'uses' + (c.active ? '' : ' off')));
      var share = el('button', 'Copy link', 'ghost small'); share.type = 'button';
      share.setAttribute('aria-label', 'Copy the sign-in link with code ' + c.code);
      share.addEventListener('click', function () {
        var url = d.site_url + '/?code=' + encodeURIComponent(c.code);
        (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function () { toast('Link with ' + c.code + ' copied.'); }, function () { toast(url); });
      });
      right.appendChild(share);
      li.appendChild(right);
      ul.appendChild(li);
    });
    cb.appendChild(ul);
  }

  var i = d.invites, ik = $('ikpis'); ik.replaceChildren();
  stat(ik, 'Left', String(i.left), 'of ' + i.allowance + ' for this event');
  stat(ik, 'Sent', String(i.sent), i.pending + ' waiting');
  stat(ik, 'Joined', String(i.accepted), i.approved + ' approved');
  stat(ik, 'Paid', String(i.paid), 'Invited guests who paid');
  $('inv-go').disabled = i.left <= 0;
  $('inv-go').textContent = i.left > 0 ? 'Send invite' : i.allowance ? 'No invites left' : 'No invites yet';

  var pb = $('pending'); pb.replaceChildren();
  if (!d.pending.length) pb.appendChild(el('p', 'Nobody waiting.', 'empty'));
  else {
    var pl = el('ul', undefined, 'list');
    d.pending.forEach(function (p) {
      var li = el('li');
      var who = el('div');
      who.appendChild(el('span', p.email, 'email'));
      who.appendChild(el('span', 'Sent ' + day(p.created_at), 'when'));
      li.appendChild(who);
      var b = el('button', 'Revoke', 'ghost small'); b.type = 'button';
      b.setAttribute('aria-label', 'Revoke the invite to ' + p.email);
      b.addEventListener('click', function () {
        if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Tap to revoke'; setTimeout(function () { b.dataset.sure = ''; b.textContent = 'Revoke'; }, 4000); return; }
        b.disabled = true;
        call('/api/promoter/invites/' + p.id + '/revoke', {}).then(function () { toast('Invite revoked. You have it back.'); return load(); })
          .catch(function (e) { if (e.status === 401) return gone(); toast(e.message, true); b.disabled = false; });
      });
      li.appendChild(b);
      pl.appendChild(li);
    });
    pb.appendChild(pl);
  }

  $('past-wrap').classList.toggle('hidden', !d.past.length);
  var ps = $('past'); ps.replaceChildren();
  d.past.forEach(function (e) {
    var li = el('li');
    li.appendChild(el('b', e.name));
    li.appendChild(el('span', plural(e.paid, 'paid order', 'paid orders') + ' · ' + received(e.received) + ' · ' + plural(e.invites_sent, 'invite', 'invites') + ' sent, ' + e.invites_accepted + ' joined', 'facts'));
    ps.appendChild(li);
  });
}
function load() {
  return call('/api/promoter/me').then(function (d) { data = d; render(); })
    .catch(function (e) { if (e.status === 401) gone(); else $('hello').textContent = 'Could not load. Pull to refresh.'; });
}
$('inv').addEventListener('submit', function (e) {
  e.preventDefault();
  var email = $('inv-email').value.trim(), msg = $('inv-msg');
  msg.textContent = ''; msg.className = 'msg';
  if (!email) { msg.textContent = 'Enter their email first.'; msg.className = 'msg err'; $('inv-email').focus(); return; }
  var b = $('inv-go'); b.disabled = true;
  call('/api/promoter/invites', { email: email, note: $('inv-note').value }).then(function () {
    msg.textContent = 'Invite sent to ' + email + '.'; msg.className = 'msg ok';
    $('inv-email').value = ''; $('inv-note').value = '';
    return load();
  }).catch(function (err) {
    if (err.status === 401) return gone();
    msg.textContent = err.message; msg.className = 'msg err';
    b.disabled = false;
  });
});
load();
</script></body></html>`;
