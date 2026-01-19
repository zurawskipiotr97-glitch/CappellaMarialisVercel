import crypto from 'crypto';

export function getP24Config() {
  const merchantId = process.env.P24_MERCHANT_ID;
  const posId = process.env.P24_POS_ID || merchantId;
  const apiKey = process.env.P24_API_KEY;
  const crc = process.env.P24_CRC;

  const sandboxFlag = String(process.env.P24_SANDBOX || '').toLowerCase();
  const isSandbox = sandboxFlag === '1' || sandboxFlag === 'true' || sandboxFlag === 'yes';

  const baseUrl = process.env.P24_BASE_URL || (isSandbox
    ? 'https://sandbox.przelewy24.pl/api/v1'
    : 'https://secure.przelewy24.pl/api/v1');

  const hostForRedirect = isSandbox ? 'https://sandbox.przelewy24.pl' : 'https://secure.przelewy24.pl';

  const description = process.env.P24_DESCRIPTION || 'Darowizna';
  const returnPath = process.env.P24_RETURN_PATH || '/pl/dziekujemy';
  const statusPath = process.env.P24_STATUS_PATH || '/api/p24/status';

  if (!merchantId || !apiKey || !crc) {
    throw new Error('Missing P24_MERCHANT_ID, P24_API_KEY or P24_CRC env vars');
  }

  return {
    merchantId: Number(merchantId),
    posId: Number(posId),
    apiKey,
    crc,
    baseUrl,
    hostForRedirect,
    description,
    returnPath,
    statusPath,
  };
}

export function sha384Hex(input) {
  return crypto.createHash('sha384').update(input).digest('hex');
}

export function p24RegisterSign({ sessionId, merchantId, amount, currency, crc }) {
  // P24 expects sha384 over JSON with specific fields. JS preserves insertion order.
  const payload = { sessionId, merchantId, amount, currency, crc };
  return sha384Hex(JSON.stringify(payload));
}

export function p24VerifySign({ sessionId, orderId, amount, currency, crc }) {
  const payload = { sessionId, orderId, amount, currency, crc };
  return sha384Hex(JSON.stringify(payload));
}

export function basicAuthHeader(login, password) {
  const token = Buffer.from(`${login}:${password}`).toString('base64');
  return `Basic ${token}`;
}

export function buildAbsoluteUrl(req, path) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https');
  const host = String(req.headers['host'] || '');
  return `${proto}://${host}${path.startsWith('/') ? path : '/' + path}`;
}

// api/_lib/p24.js

export async function p24PostJson({ url, merchantId, posId, apiKey, body }) {
  // P24 REST auth: login = posId, password = apiKey
  // fallback: if posId not provided, use merchantId (legacy)
  const login = String(posId || '').trim();
if (!login) throw new Error('P24 config error: posId missing');


  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': basicAuthHeader(String(login), apiKey),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

  if (!resp.ok) {
    const code = json?.code || resp.status;
    const message = json?.error || json?.message || text || 'P24 error';
    const err = new Error(`P24 HTTP ${resp.status}: ${message}`);
    err.p24_code = code;
    err.p24_response = json;
    throw err;
  }

  return json;
}
