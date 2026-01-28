import crypto from 'crypto';
import querystring from 'node:querystring';

function md5Hex(input) {
  return crypto.createHash('md5').update(input).digest('hex');
}

export function getP24Config() {
  const merchantIdRaw = String(process.env.P24_MERCHANT_ID || '').trim();
  const posIdRaw = String(process.env.P24_POS_ID || merchantIdRaw).trim();
  const apiKey = String(process.env.P24_API_KEY || '').trim(); // optional in legacy mode
  const crc = String(process.env.P24_CRC || '').trim();

  const sandboxFlag = String(process.env.P24_SANDBOX || '').toLowerCase();
  const isSandbox = sandboxFlag === '1' || sandboxFlag === 'true' || sandboxFlag === 'yes';

  // Mode:
  // - "legacy" = /trnRegister + /trnRequest redirect, checksum MD5, no BasicAuth
  // - "rest"   = /api/v1/transaction/register + /verify, checksum SHA384(JSON), BasicAuth posId:apiKey
  const modeRaw = String(process.env.P24_MODE || '').trim().toLowerCase();
  const mode = (modeRaw === 'legacy' || modeRaw === 'trn') ? 'legacy' : 'rest';

  // REST API base URL
  const baseUrl = isSandbox
    ? 'https://sandbox.przelewy24.pl/api/v1'
    : 'https://secure.przelewy24.pl/api/v1';

  // Redirect host (P24 payment page) + legacy endpoints live here
  const hostForRedirect = isSandbox
    ? 'https://sandbox.przelewy24.pl'
    : 'https://secure.przelewy24.pl';

  const description = process.env.P24_DESCRIPTION || 'Darowizna na cele statutowe';
  const returnPath = process.env.P24_RETURN_PATH || '/pl/dziekujemy';
  const statusPath = process.env.P24_STATUS_PATH || '/api/p24/status';

  if (!merchantIdRaw || !posIdRaw || !crc) {
    throw new Error('Missing P24 env vars: P24_MERCHANT_ID/P24_POS_ID/P24_CRC');
  }

  if (mode === 'rest') {
    if (!apiKey) {
      throw new Error('Missing P24_API_KEY (required in P24_MODE=rest)');
    }
    // Guard: avoid accidental short key (common misconfig)
    if (apiKey.length < 16) {
      throw new Error(
        `P24_API_KEY looks too short (len=${apiKey.length}). Use "Klucz API" from P24 panel (not "klucz do zamówień").`
      );
    }
  }

  return {
    mode,
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
 * REST: sign for transaction/register: sha384(JSON({sessionId, merchantId, amount, currency, crc}))
 */
export function p24RegisterSign({ sessionId, merchantId, amount, currency, crc }) {
  const payload = { sessionId, merchantId, amount, currency, crc };
  return sha384Hex(JSON.stringify(payload));
}

/**
 * REST: sign for transaction/verify: sha384(JSON({sessionId, orderId, amount, currency, crc}))
 */
export function p24VerifySign({ sessionId, orderId, amount, currency, crc }) {
  const payload = { sessionId, orderId, amount, currency, crc };
  return sha384Hex(JSON.stringify(payload));
}

/**
 * LEGACY: p24_sign (register) = md5("sessionId|merchantId|amount|currency|crc")
 * Based on older P24 integration docs and common implementations.
 */
export function p24LegacyRegisterSign({ sessionId, merchantId, amount, currency, crc }) {
  return md5Hex([sessionId, merchantId, amount, currency, crc].join('|'));
}

/**
 * LEGACY: p24_sign (verify/status) = md5("sessionId|orderId|amount|currency|crc")
 */
export function p24LegacyVerifySign({ sessionId, orderId, amount, currency, crc }) {
  return md5Hex([sessionId, orderId, amount, currency, crc].join('|'));
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

/**
 * LEGACY: call /trnRegister with application/x-www-form-urlencoded and get token.
 * Response is typically a urlencoded string like: "error=0&token=XXXX"
 */
export async function p24TrnRegister({ host, form }) {
  const resp = await fetch(`${host}/trnRegister`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      'Accept': 'text/plain,application/x-www-form-urlencoded,application/json,*/*',
    },
    body: new URLSearchParams(form).toString(),
  });

  const text = await resp.text();
  // P24 legacy returns 200 even for errors, with "error=1&errorMessage=..."
  const data = querystring.parse(text);

  if (String(data.error || '') !== '0' || !data.token) {
    const msg = data.errorMessage || data.errormessage || data.message || `Legacy register failed (HTTP ${resp.status})`;
    const err = new Error(String(msg));
    err.p24_code = data.error || resp.status;
    err.p24_response = { raw: text, parsed: data };
    err.p24_raw_start = text?.slice?.(0, 1200) || String(text);
    throw err;
  }

  return { token: String(data.token), raw: text, parsed: data };
}

export async function p24PostJson({ url, posId, apiKey, body }) {
  const proxyBase = String(process.env.P24_PROXY_BASE || '').trim().replace(/\/$/, '');

  // Backward-compat (older envs). Prefer P24_PROXY_BASE.
  const legacyVerifyProxy = String(process.env.P24_VERIFY_PROXY_URL || '').trim();
  const legacyRegisterProxy = String(process.env.P24_REGISTER_PROXY_URL || '').trim();

  // Decide whether to route via proxy
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  const action = parts[parts.length - 1]; // e.g. register / verify
  if (!action) throw new Error(`Cannot derive P24 action from url: ${url}`);

  const proxyUrl =
    proxyBase ? `${proxyBase}/p24/${action}` :
    (action === 'verify' && legacyVerifyProxy) ? legacyVerifyProxy :
    (action === 'register' && legacyRegisterProxy) ? legacyRegisterProxy :
    '';

  // If proxyUrl is set, call proxy without Basic Auth here (proxy adds auth).
  if (proxyUrl) {
    const resp = await fetch(proxyUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    const text = await resp.text();

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
      err.p24_raw_start = text?.slice?.(0, 1200) || String(text);
      throw err;
    }

    return data;
  }

  // Direct call to P24 (requires IP not restricted OR running from whitelisted IP)
  const resp = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Authorization: basicAuthHeader(posId, apiKey),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();

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
    err.p24_raw_start = text?.slice?.(0, 1200) || String(text);
    throw err;
  }

  return data;
}
