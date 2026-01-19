import crypto from 'crypto';

export function getP24Config() {
  const merchantIdRaw = String(process.env.P24_MERCHANT_ID || '').trim();
  const posIdRaw = String(process.env.P24_POS_ID || merchantIdRaw).trim();
  const apiKey = String(process.env.P24_API_KEY || '').trim();
  const crc = String(process.env.P24_CRC || '').trim();

  const sandboxFlag = String(process.env.P24_SANDBOX || '').toLowerCase();
  const isSandbox = sandboxFlag === '1' || sandboxFlag === 'true' || sandboxFlag === 'yes';

  // PROPER REST API base URLs
  const baseUrl = isSandbox
    ? 'https://sandbox.przelewy24.pl/api/v1'
    : 'https://secure.przelewy24.pl/api/v1';

  // Redirect host (P24 payment page)
  const hostForRedirect = isSandbox
    ? 'https://sandbox.przelewy24.pl'
    : 'https://secure.przelewy24.pl';

  const description = process.env.P24_DESCRIPTION || 'Darowizna na cele statutowe';
  const returnPath = process.env.P24_RETURN_PATH || '/pl/dziekujemy';
  const statusPath = process.env.P24_STATUS_PATH || '/api/p24/status';

  if (!merchantIdRaw || !posIdRaw || !apiKey || !crc) {
    throw new Error('Missing P24 env vars: P24_MERCHANT_ID/P24_POS_ID/P24_API_KEY/P24_CRC');
  }

  // Guard: avoid accidental short key (common misconfig)
  if (apiKey.length < 16) {
    throw new Error(`P24_API_KEY looks too short (len=${apiKey.length}). Use "Klucz API" from P24 panel (not "klucz do zamówień").`);
  }

  return {
    isSandbox,
    merchantId: Number(merchantIdRaw),
    posId: Number(posIdRaw),
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

/**
 * Sign for transaction/register: sha384(JSON({sessionId, merchantId, amount, currency, crc}))
 */
export function p24RegisterSign({ sessionId, merchantId, amount, currency, crc }) {
  const payload = { sessionId, merchantId, amount, currency, crc };
  return sha384Hex(JSON.stringify(payload));
}

/**
 * Sign for transaction/verify: sha384(JSON({sessionId, orderId, amount, currency, crc}))
 */
// IMPORTANT: Per P24 docs the verify sign MUST be computed only from:
// { sessionId, orderId, amount, currency, crc }
// (i.e. without merchantId/posId). If you include extra fields, P24 will reject
// verification and transactions may stay in "registered" forever.
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

export async function p24PostJson({ url, posId, apiKey, body }) {
  // hard guard: must hit REST api path
  if (!String(url).includes('/api/v1/')) {
    throw new Error(`P24 URL misconfigured (missing /api/v1): ${url}`);
  }

  const login = String(posId || '').trim();
  if (!login) throw new Error('P24 config error: posId missing');

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(login, apiKey),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'cappellamarialis-vercel/1.0',
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();

  // Try JSON; if not JSON, preserve raw (helps debug HTML 400)
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!resp.ok) {
    const message = data?.error || data?.message || `HTTP ${resp.status}`;
    const err = new Error(`P24 HTTP ${resp.status}: ${message}`);
    err.p24_code = data?.code || resp.status;
    err.p24_response = data;
    throw err;
  }

  return data;
}
