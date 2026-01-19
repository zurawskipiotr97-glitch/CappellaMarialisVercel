import crypto from 'crypto';
import { getSupabaseAdmin } from '../_lib/supabase.js';
import { getContentType, readJson } from '../_lib/body.js';
import {
  getP24Config,
  buildAbsoluteUrl,
  p24PostJson,
  p24RegisterSign,
} from '../_lib/p24.js';

function uuid() {
  // Node 18 has crypto.randomUUID
  return crypto.randomUUID();
}

function toInt(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function validateAmount(amountGrosze) {
  const n = toInt(amountGrosze);
  if (n === null) return { ok: false, error: 'Nieprawidłowa kwota' };
  // MVP defaults: min 1 PLN, max 10 000 PLN; adjust via env if needed
  const min = toInt(process.env.DONATION_MIN_GROSZE || 100);
  const max = toInt(process.env.DONATION_MAX_GROSZE || 1_000_000);
  if (n < min) return { ok: false, error: `Minimalna kwota to ${(min/100).toFixed(2)} PLN` };
  if (n > max) return { ok: false, error: `Maksymalna kwota to ${(max/100).toFixed(2)} PLN` };
  return { ok: true, value: n };
}

function mustBeTrue(v) {
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
}

function makePublicRef(sessionId) {
  // Human-friendly reference derived from UUID (no PII)
  return 'DON-' + sessionId.replace(/-/g, '').slice(0, 12).toUpperCase();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    const ct = getContentType(req);
    if (!ct.includes('application/json')) {
      res.statusCode = 415;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Content-Type must be application/json' }));
      return;
    }

    const body = (await readJson(req)) || {};

    const amountCheck = validateAmount(body.amountGrosze);
    if (!amountCheck.ok) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: amountCheck.error }));
      return;
    }

    const consents = body.consents || {};
    if (!mustBeTrue(consents.privacy) || !mustBeTrue(consents.terms)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Wymagane zgody: prywatność i regulamin.' }));
      return;
    }

    const email = (body.email || '').trim();
    const requireEmail = String(process.env.REQUIRE_DONOR_EMAIL || 'true').toLowerCase() !== 'false';
    if (requireEmail && !email) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Podaj e-mail (wyślemy potwierdzenie i podziękowanie).' }));
      return;
    }

    const currency = String(body.currency || 'PLN');
    const amountGrosze = amountCheck.value;

    const sessionId = uuid();
    const publicRef = makePublicRef(sessionId);

    const supabase = getSupabaseAdmin();
    const cfg = getP24Config();

    // === language + returnUrl based on frontend page ===
    const metaPage = String(body?.meta?.page || '');
    const isEn = metaPage.startsWith('en/');

    const returnPath = isEn
      ? '/en/thank-you'
      : (cfg.returnPath || '/pl/dziekujemy');

    const urlReturn = buildAbsoluteUrl(
      req,
      `${returnPath}?sessionId=${encodeURIComponent(sessionId)}`
    );

    // (opcjonalnie) defensywnie, żeby nie wywalić się gdy cfg.statusPath puste
    const urlStatus = buildAbsoluteUrl(req, cfg.statusPath || '/api/p24/status');

    // 1) INSERT initiated
    const { error: insErr } = await supabase
      .from('p24_transactions')
      .insert({
        session_id: sessionId,
        public_ref: publicRef,
        amount_grosze: amountGrosze,
        currency,
        status: 'initiated',
        email: email || null,
        consents_json: {
          privacy: mustBeTrue(consents.privacy),
          terms: mustBeTrue(consents.terms),
        },
        consents_version: String(body.consentsVersion || process.env.CONSENTS_VERSION || '1'),
        meta_json: body.meta || null,
      });

    if (insErr) {
      throw new Error('DB insert failed: ' + insErr.message);
    }

    // 2) Register transaction in P24
    const sign = p24RegisterSign({
      sessionId,
      merchantId: cfg.merchantId,
      amount: amountGrosze,
      currency,
      crc: cfg.crc,
    });

    const registerBody = {
      merchantId: cfg.merchantId,
      posId: cfg.posId,
      sessionId,
      amount: amountGrosze,
      currency,
      description: cfg.description,
      email: email || 'donor@example.com',
      country: 'PL',
      language: metaPage.startsWith('en/') ? 'en' : 'pl',
      urlReturn,
      urlStatus,
      sign,
    };

    const registerResp = await p24PostJson({
      url: `${cfg.baseUrl}/transaction/register`,
      merchantId: cfg.merchantId,
      posId: cfg.posId, 
      apiKey: cfg.apiKey,
      body: registerBody,
    });

    const token = registerResp?.data?.token || registerResp?.token;
    const orderId = registerResp?.data?.orderId || registerResp?.orderId || null;

    if (!token) {
      throw new Error('P24 register: missing token in response');
    }

    const redirectUrl = `${cfg.hostForRedirect}/trnRequest/${encodeURIComponent(token)}`;

    // 3) UPDATE to registered
    const { error: updErr } = await supabase
      .from('p24_transactions')
      .update({
        status: 'registered',
        p24_order_id: orderId,
        p24_token: token,
        redirect_url: redirectUrl,
        register_payload: { request: registerBody, response: registerResp },
      })
      .eq('session_id', sessionId);

    if (updErr) {
      throw new Error('DB update failed: ' + updErr.message);
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ sessionId, publicRef, redirectUrl }));
  } catch (err) {
    console.error(err);

    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Błąd serwera', details: String(err?.message || err) }));
  }
}
