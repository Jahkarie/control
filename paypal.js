// paypal.js: paying online with PayPal. The guest site shows PayPal's buttons on a reserved order. This server
// creates the PayPal order for the right amount, captures it once the guest approves, checks what PayPal took, and
// marks the order paid. Approving a refund on a PayPal order sends the money back through PayPal (see refund()).
//
// Env: PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (from developer.paypal.com), PAYPAL_ENV ('live' or 'sandbox';
// sandbox unless set to live). In sandbox mode only the emails in PAYPAL_TESTERS (comma-separated) see PayPal,
// so the live site can be tested without guests seeing it. PAYPAL_API_URL replaces PayPal's address (for tests).
//
// PayPal doesn't take XCD, so XCD prices are charged in USD at the fixed rate of 2.70 XCD to 1 USD.

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const LIVE = process.env.PAYPAL_ENV === 'live';
const API = (process.env.PAYPAL_API_URL || (LIVE ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com')).replace(/\/$/, '');
const TESTERS = (process.env.PAYPAL_TESTERS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const CONFIGURED = !!(CLIENT_ID && SECRET);
const TIMEOUT_MS = 20 * 1000; // a stuck PayPal call mustn't hold the order (and a database connection) for long

// What PayPal charges, in USD cents: USD prices as they are, XCD at 2.70 to the dollar, rounded up to the cent.
export const usdCents = (cents, currency) => (currency === 'USD' ? cents : Math.ceil((cents * 10) / 27));
const usd = (cents) => (cents / 100).toFixed(2);

export function registerPayPal({ app, pool, requireAuth, requireAdmin, rateLimit, onPaid }) {
  const enabledFor = (email) => CONFIGURED && (LIVE || TESTERS.includes(email));
  const fail = (res, err) => { console.error('PayPal error:', err); res.status(500).json({ error: 'Server error.' }); };

  let token = null, tokenExpires = 0;
  async function accessToken() {
    if (token && Date.now() < tokenExpires) return token;
    const res = await fetch(`${API}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new Error(`PayPal login failed (${res.status} ${data.error || ''}). Check PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_ENV.`);
    token = data.access_token;
    tokenExpires = Date.now() + (Number(data.expires_in) || 300) * 1000 - 60 * 1000;
    return token;
  }

  // Calls PayPal's REST API. PayPal errors come back as { ok: false, ... }; only network failures throw.
  // No PayPal-Request-Id: PayPal would answer a retry (say, after a declined card) with the first, failed result.
  // Paying or refunding twice is prevented by PayPal itself (already captured / already refunded).
  async function api(method, path, body) {
    const headers = { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' };
    const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }
  const issue = (r) => r.data?.details?.[0]?.issue || r.data?.name || `HTTP ${r.status}`;
  const captureOf = (ppOrder) => ppOrder?.purchase_units?.[0]?.payments?.captures?.[0] || null;
  const orderPath = (id) => `/v2/checkout/orders/${encodeURIComponent(id)}`;

  const ORDER_SQL = `SELECT o.id, o.guest_email, o.status, o.reference_code, o.paypal_order_id, o.paypal_status, o.paypal_amount,
      p.name AS package_name, p.price_cents, p.currency
    FROM orders o JOIN packages p ON p.id = o.package_id`;

  // Records what PayPal says about a payment on our (locked) order: paid if PayPal has exactly the amount we asked
  // for. Returns 'PAID', 'PENDING', 'MISMATCH', 'NOT_RESERVED' or PayPal's capture status.
  async function recordCapture(client, o, ppOrder) {
    const cap = captureOf(ppOrder);
    if (!cap) return ppOrder?.status || 'NONE';
    if (cap.status === 'PENDING') {
      // PayPal is holding the money (for example, under review). It's confirmed when it completes.
      await client.query("UPDATE orders SET paypal_status = 'PENDING', paypal_capture_id = $2 WHERE id = $1", [o.id, cap.id]);
      return 'PENDING';
    }
    if (cap.status !== 'COMPLETED') return cap.status;
    if (cap.amount?.currency_code !== 'USD' || cap.amount?.value !== o.paypal_amount) {
      console.error(`PayPal amount mismatch on ${o.reference_code}: got ${cap.amount?.currency_code} ${cap.amount?.value}, expected USD ${o.paypal_amount}`);
      await client.query("UPDATE orders SET paypal_status = 'AMOUNT_MISMATCH', paypal_capture_id = $2 WHERE id = $1", [o.id, cap.id]);
      return 'MISMATCH';
    }
    const r = await client.query(
      `UPDATE orders SET status = 'PAID', paid_at = NOW(), paid_via = 'PAYPAL', paypal_status = 'COMPLETED', paypal_capture_id = $2
       WHERE id = $1 AND status = 'RESERVED'`, [o.id, cap.id]);
    return r.rowCount ? 'PAID' : 'NOT_RESERVED';
  }

  // Brings a PayPal payment we started up to date: captures it if the guest approved it but the capture never
  // happened (for example, they closed the page right after paying), then records the result.
  async function settle(client, o) {
    let r = await api('GET', orderPath(o.paypal_order_id));
    if (!r.ok) return 'UNKNOWN';
    if (r.data.status === 'APPROVED') {
      r = await api('POST', `${orderPath(o.paypal_order_id)}/capture`, {});
      if (!r.ok) return 'APPROVED';
    }
    return recordCapture(client, o, r.data);
  }

  // What the guest site needs to show PayPal on the guest's reserved order.
  app.get('/api/paypal/checkout', requireAuth, async (req, res) => {
    try {
      if (!enabledFor(req.userEmail)) return res.json({ enabled: false });
      const r = await pool.query(`${ORDER_SQL} WHERE o.guest_email = $1 AND o.status = 'RESERVED' ORDER BY o.id DESC LIMIT 1`, [req.userEmail]);
      if (!r.rowCount) return res.json({ enabled: false });
      const o = r.rows[0];
      res.json({ enabled: true, client_id: CLIENT_ID, currency: 'USD', amount: usd(usdCents(o.price_cents, o.currency)), pending: o.paypal_status === 'PENDING' });
    } catch (err) { fail(res, err); }
  });

  // Step 1, when the guest taps a PayPal button: create the PayPal order for their reservation.
  app.post('/api/paypal/create-order', requireAuth, rateLimit(30, 60 * 60 * 1000), async (req, res) => {
    if (!enabledFor(req.userEmail)) return res.status(400).json({ error: "PayPal isn't available." });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const r = await client.query(
        `${ORDER_SQL} WHERE o.guest_email = $1 AND o.status = 'RESERVED' ORDER BY o.id DESC LIMIT 1 FOR UPDATE OF o`, [req.userEmail]);
      if (!r.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'You have no reservation to pay for.' });
      }
      const o = r.rows[0];
      // Finish an earlier PayPal payment for this order before starting another, so nobody pays twice.
      if (o.paypal_order_id) {
        const state = await settle(client, o);
        const stop = {
          PAID: { error: 'Your payment already went through.', code: 'ALREADY_PAID' },
          PENDING: { error: "PayPal is still processing your earlier payment. We'll email you when it's confirmed.", code: 'PENDING' },
          MISMATCH: { error: 'There is a problem with your earlier PayPal payment. Please contact us before paying again.', code: 'CHECK' }
        }[state];
        if (stop) {
          await client.query('COMMIT');
          if (state === 'PAID') onPaid(o);
          return res.status(409).json(stop);
        }
      }
      const amount = usd(usdCents(o.price_cents, o.currency));
      const created = await api('POST', '/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: o.reference_code,
          invoice_id: o.reference_code, // PayPal refuses a second completed payment with the same invoice id
          custom_id: String(o.id),
          description: `On D' Road: ${o.package_name}`.slice(0, 127),
          amount: { currency_code: 'USD', value: amount }
        }],
        application_context: { brand_name: "On D' Road", shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' }
      });
      if (!created.ok || !created.data.id) {
        await client.query('ROLLBACK');
        console.error('PayPal create order failed:', o.reference_code, created.status, JSON.stringify(created.data));
        return res.status(502).json({ error: "PayPal isn't available right now. Try again, or use another way to pay." });
      }
      await client.query(
        `UPDATE orders SET paypal_order_id = $2, paypal_amount = $3, paypal_status = 'CREATED', paypal_started_at = NOW(), paypal_capture_id = NULL
         WHERE id = $1`, [o.id, created.data.id, amount]);
      await client.query('COMMIT');
      res.json({ id: created.data.id });
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      fail(res, err);
    } finally {
      client?.release();
    }
  });

  // Step 2, after the guest approves in PayPal: take the payment and mark the order paid.
  // The order stays locked meanwhile, so it can't be cancelled or expire halfway through.
  app.post('/api/paypal/capture', requireAuth, async (req, res) => {
    const ppId = String(req.body?.paypal_order_id || '').slice(0, 64);
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const r = await client.query(`${ORDER_SQL} WHERE o.guest_email = $1 AND o.paypal_order_id = $2 FOR UPDATE OF o`, [req.userEmail, ppId]);
      const o = r.rows[0];
      if (!o || o.status !== 'RESERVED') {
        await client.query('ROLLBACK');
        if (o?.status === 'PAID') return res.json({ success: true });
        return res.status(400).json({ error: o
          ? 'This reservation was cancelled, so PayPal did not take the payment.'
          : "That payment doesn't match your reservation. Refresh the page and try again." });
      }
      let cap = await api('POST', `${orderPath(ppId)}/capture`, {});
      if (!cap.ok && issue(cap) === 'ORDER_ALREADY_CAPTURED') cap = await api('GET', orderPath(ppId));
      if (!cap.ok) {
        await client.query('ROLLBACK');
        console.error('PayPal capture failed:', o.reference_code, cap.status, JSON.stringify(cap.data));
        if (issue(cap) === 'INSTRUMENT_DECLINED') return res.status(402).json({ error: 'PayPal declined that payment method. Try another one.', code: 'DECLINED' });
        if (issue(cap) === 'DUPLICATE_INVOICE_ID') return res.status(409).json({ error: "PayPal says this reservation was already paid, so it didn't charge you again. Please contact us so we can confirm it." });
        return res.status(502).json({ error: "The payment didn't go through, and you haven't been charged. Try again, or use another way to pay." });
      }
      const state = await recordCapture(client, o, cap.data);
      await client.query('COMMIT');
      if (state === 'PAID') {
        onPaid(o);
        return res.json({ success: true });
      }
      if (state === 'PENDING') return res.json({ success: false, pending: true, message: "PayPal is still processing your payment. We'll email you as soon as it's confirmed." });
      if (state === 'MISMATCH') return res.status(502).json({ error: "Something didn't match on that payment, so your order isn't confirmed yet. Please contact us." });
      res.status(502).json({ error: "The payment didn't go through. Try again, or use another way to pay." });
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      console.error('PayPal capture error:', err);
      // The capture may have reached PayPal. The next attempt (or the payments job) checks with PayPal first.
      res.status(500).json({ error: "We couldn't confirm your payment yet. Refresh the page in a minute before trying again." });
    } finally {
      client?.release();
    }
  });

  // For the Payment settings page.
  app.get('/api/admin/paypal', requireAdmin, (req, res) => {
    res.json({ configured: CONFIGURED, live: LIVE, testers: LIVE ? [] : TESTERS });
  });

  // Refunds a PayPal payment in full. Returns { ok: true, id } or { ok: false, error }.
  async function refund(o) {
    if (!CONFIGURED) return { ok: false, error: 'PayPal keys are missing' };
    let r;
    try {
      r = await api('POST', `/v2/payments/captures/${encodeURIComponent(o.paypal_capture_id)}/refund`, {});
    } catch (err) {
      console.error('PayPal refund error:', o.reference_code, err.message);
      return { ok: false, error: "couldn't reach PayPal" };
    }
    if (r.ok && ['COMPLETED', 'PENDING'].includes(r.data.status)) return { ok: true, id: r.data.id };
    if (issue(r) === 'CAPTURE_FULLY_REFUNDED') return { ok: true, id: null }; // already refunded in PayPal itself
    console.error('PayPal refund failed:', o.reference_code, r.status, JSON.stringify(r.data));
    return { ok: false, error: issue(r) };
  }

  // Run by the payments job before it cancels unpaid orders. Confirms PayPal payments that went through without
  // reaching us, and keeps checking ones PayPal is still holding.
  async function syncDue(payDays) {
    if (!CONFIGURED) return;
    const due = await pool.query(
      `${ORDER_SQL} WHERE o.status = 'RESERVED' AND o.paypal_order_id IS NOT NULL
         AND (o.paypal_status = 'PENDING' OR ($1::int > 0 AND o.created_at + make_interval(days => $1::int) < NOW()))
       ORDER BY o.id LIMIT 50`, [payDays]);
    for (const row of due.rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await client.query(`${ORDER_SQL} WHERE o.id = $1 AND o.status = 'RESERVED' FOR UPDATE OF o`, [row.id]);
        const state = r.rowCount ? await settle(client, r.rows[0]) : null;
        await client.query('COMMIT');
        if (state === 'PAID') onPaid(r.rows[0]);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('PayPal check failed:', row.reference_code, err.message);
      } finally {
        client.release();
      }
    }
  }

  return { refund, syncDue };
}
