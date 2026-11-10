// PayPal Checkout (Orders v2 API). Turned on by setting PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.
// PAYPAL_ENV=sandbox uses PayPal's test site (fake money); leave it out or set "live" for real payments.
const { fail } = require('./util');

function config() {
  const clientId = process.env.PAYPAL_CLIENT_ID || '', secret = process.env.PAYPAL_CLIENT_SECRET || '';
  if (!clientId || !secret) return null;
  const sandbox = String(process.env.PAYPAL_ENV || 'live').toLowerCase() === 'sandbox';
  return {
    clientId, secret, sandbox,
    base: process.env.PAYPAL_API_BASE || (sandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com'),
  };
}

let token = null; // { value, until, key }

async function accessToken(c) {
  const key = c.base + c.clientId;
  if (token && token.key === key && token.until > Date.now() + 60000) return token.value;
  const r = await fetch(c.base + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(c.clientId + ':' + c.secret).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw fail(502, 'PAYPAL_ERROR', 'PayPal could not be reached (sign-in failed). Check the PayPal keys on the server.');
  token = { value: j.access_token, until: Date.now() + (Number(j.expires_in) || 300) * 1000, key };
  return token.value;
}

async function call(method, path, body, extraHeaders) {
  const c = config();
  if (!c) throw fail(400, 'PAYPAL_OFF', 'PayPal checkout is not set up on this site.');
  const r = await fetch(c.base + path, {
    method,
    headers: Object.assign({ Authorization: 'Bearer ' + (await accessToken(c)), 'Content-Type': 'application/json' }, extraHeaders || {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, body: j };
}

/** Creates an order for `credits` at `price` (a number) in `currency`. Returns the PayPal order id. */
async function createOrder({ teacherId, credits, price, currency, siteName }) {
  const r = await call('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: 'credits',
      custom_id: teacherId + ':' + credits,
      description: credits + ' ' + (siteName || 'Exam Wizard') + ' credit' + (credits === 1 ? '' : 's'),
      amount: { currency_code: currency, value: price.toFixed(2) },
    }],
    application_context: { brand_name: String(siteName || 'Exam Wizard').slice(0, 120), shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' },
  });
  if (!r.ok || !r.body.id) throw fail(502, 'PAYPAL_ERROR', 'PayPal did not accept the order' + (r.body.message ? ': ' + r.body.message : '.'));
  return r.body.id;
}

/** Captures an approved order (safe to call twice). Returns { status, captureId, amount, currency, customId }. */
async function captureOrder(orderId) {
  let r = await call('POST', '/v2/checkout/orders/' + encodeURIComponent(orderId) + '/capture', {}, { 'PayPal-Request-Id': 'capture-' + orderId });
  if (!r.ok) {
    const issue = r.body && r.body.details && r.body.details[0] && r.body.details[0].issue;
    if (issue !== 'ORDER_ALREADY_CAPTURED') throw fail(402, 'PAYMENT_FAILED', 'PayPal did not complete the payment' + (issue ? ' (' + issue + ')' : '') + '. No money was taken.');
    r = await call('GET', '/v2/checkout/orders/' + encodeURIComponent(orderId));
    if (!r.ok) throw fail(502, 'PAYPAL_ERROR', 'Could not check the payment with PayPal. Try again in a minute.');
  }
  const unit = (r.body.purchase_units || [])[0] || {};
  const cap = ((unit.payments || {}).captures || [])[0] || {};
  return {
    status: cap.status || r.body.status,
    captureId: cap.id || '',
    amount: Number((cap.amount || unit.amount || {}).value),
    currency: (cap.amount || unit.amount || {}).currency_code,
    customId: cap.custom_id || unit.custom_id || '',
  };
}

module.exports = { config, createOrder, captureOrder };
