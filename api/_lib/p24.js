import crypto from 'crypto';

export function getP24Config() {
  const merchantIdRaw = String(process.env.P24_MERCHANT_ID || '').trim();
  const posIdRaw = String(process.env.P24_POS_ID || merchantIdRaw).trim();
  const apiKey = String(process.env.P24_API_KEY || '').trim();
  const crc = String(process.env.P24_CRC || '').trim();

  const sandboxFlag = String(process.env.P24_SANDBOX || '').toLowerCase();
  const isSandbox = sandboxFlag === '1' || sandboxFlag === 'true' || sandboxFlag === 'yes';

  const baseUrl = isSandbox
    ? 'https://sandbox.przelewy24.pl/api/v1'
    : 'https://secure.przelewy24.pl/api/v1';

  const hostForRedirect = isSandbox
    ? 'https://sandbox.przelewy24.pl'
    : 'https://secure.przelewy24.pl';

  const description = process.env.P24_DESCRIPTION || 'Darowizna na cele statutowe';
  const returnPath = process.env.P24_RETURN_PATH || '/pl/dziekujemy';
  const statusPath = process.env.P24_STATUS_PATH || '/api/p24/status';

  if (!merchantIdRaw || !posIdRaw || !apiKey || !crc) {
    throw new Error('Missing P24 env vars');
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

export function p24RegisterSign({ sessionId, merchantId, amount, currency, crc }) {
  return sha384Hex(JSON.stringify({ sessionId, merchantId, amount, currency, crc }));
}

export function p24VerifySign({ sessionId, orderId, amount, currency, crc }) {
  return sha384Hex(JSON.stringify({ sessionId, orderId, amount, currency, crc }));
}

export function basicAuthHeader(login, password) {
  return 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
}

export async function p24PostJson({ url, posId, apiKey, body }) {
  if (!url.includes('/api/v1/')) throw new Error('Bad P24 URL');

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(posId, apiKey),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'cappellamarialis-vercel/1.0',
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!resp.ok) {
    const err = new Error(`P24 HTTP ${resp.status}`);
    err.p24_response = data;
    throw err;
  }

  return data;
}
