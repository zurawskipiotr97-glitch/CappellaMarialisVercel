import crypto from 'crypto';

export function getP24Config() {
  const merchantIdRaw = String(process.env.P24_MERCHANT_ID || '').trim();
  const posIdRaw = String(process.env.P24_POS_ID || merchantIdRaw).trim();
  const apiKey = String(process.env.P24_API_KEY || '').trim();
  const crc = String(process.env.P24_CRC || '').trim();

  const sandboxFlag = String(process.env.P24_SANDBOX || '').toLowerCase();
  const isSandbox = sandboxFlag === '1' || sandboxFlag === 'true' || sandboxFlag === 'yes';

  // REST API base
  const baseUrl = isSandbox
    ? 'https://sandbox.przelewy24.pl/api/v1'
    : 'https://secure.przelewy24.pl/api/v1';

  // Redirect host (payment page)
  const hostForRedirect = isSandbox
    ? 'https://sandbox.przelewy24.pl'
    : 'https://secure.przelewy24.pl';

  const description = process.env.P24_DESCRIPTION || 'Darowizna na cele statutowe';
  const returnPath = process.env.P24_RETURN_PATH || '/pl/dziekujemy';
  const statusPath = process.env.P24_STATUS_PATH || '/api/p24/status';

  if (!merchantIdRaw || !posIdRaw || !apiKey || !crc) {
    throw new Error('Missing P24 env vars: P24_MERCHANT_ID/P24_POS_ID/P24_API_KEY/P24_CRC');
  }

  // Guard: common misconfig
  if (apiKey.length < 16) {
    throw new Error(
      `P24_API_KEY looks too short (len=${apiKey.length}). Use "Klucz API" from P24 panel.`
    );
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

function normalizeMethod(method) {
  const m = String(method || 'POST').toUpperCase().trim();
  if (!['POST', 'PUT', 'GET', 'DELETE', 'PATCH'].includes(m)) return 'POST';
  return m;
}

/**
 * Calls P24 REST API, optionally via proxy.
 * - If proxy is used: we DO NOT add Authorization here (proxy should add it).
 * - If direct: we add BasicAuth.
 */
export async function p24PostJson({ url, posId, apiKey, body, method = 'POST' }) {
  const m = normalizeMethod(method);

  const proxyBase = String(process.env.P24_PROXY_BASE || '').trim().replace(/\/$/, '');

  // Backward-compat (older envs). Prefer P24_PROXY_BASE.
  const legacyVerifyProxy = String(process.env.P24_VERIFY_PROXY_URL || '').trim();
  const legacyRegisterProxy = String(process.env.P24_REGISTER_PROXY_URL || '').trim();

  // Decide action name from URL (register / verify / etc.)
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  const action = parts[parts.length - 1];
  if (!action) throw new Error(`Cannot derive P24 action from url: ${url}`);

  const proxyUrl =
    proxyBase ? `${proxyBase}/p24/${action}` :
    (action === 'verify' && legacyVerifyProxy) ? legacyVerifyProxy :
    (action === 'register' && legacyRegisterProxy) ? legacyRegisterProxy :
    '';

  const headersBase = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  // Proxy route
  if (proxyUrl) {
    const resp = await fetch(proxyUrl, {
      method: m,
      redirect: 'manual',
      headers: headersBase,
      body: body == null ? undefined : JSON.stringify(body),
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

  // Direct route (requires whitelisted IP etc.)
  const resp = await fetch(url, {
    method: m,
    redirect: 'manual',
    headers: {
      ...headersBase,
      Authorization: basicAuthHeader(posId, apiKey),
    },
    body: body == null ? undefined : JSON.stringify(body),
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
