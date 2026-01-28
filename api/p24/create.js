import crypto from 'crypto';
import { getSupabaseAdmin } from '../_lib/supabase.js';
import { readJson } from '../_lib/body.js';
import {
  getP24Config,
  buildAbsoluteUrl,
  p24PostJson,
  p24RegisterSign,
  p24LegacyRegisterSign,
  p24TrnRegister,
} from '../_lib/p24.js';

function uuid() {
  return crypto.randomUUID();
}

function toInt(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function validateAmount(amountGrosze) {
  const n = toInt(amountGrosze);
  if (n == null) return { ok: false, error: 'Brak kwoty' };
  if (n < 100) return { ok: false, error: 'Minimalna kwota to 1,00 PLN' };
  if (n > 20000000) return { ok: false, error: 'Maksymalna kwota jest zbyt duża' };
  return { ok: true, value: n };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const supabase = getSupabaseAdmin();
  const cfg = getP24Config();

  try {
    const body = await readJson(req);
    const amountCheck = validateAmount(body?.amountGrosze);
    if (!amountCheck.ok) {
      res.status(400).json({ error: amountCheck.error });
      return;
    }

    const amount = amountCheck.value; // in grosze
    const currency = 'PLN';
    const email = String(body?.email || '').trim() || null;

    const sessionId = uuid();
    const publicRef = crypto.randomBytes(6).toString('hex').toUpperCase(); // short human ref

    // 1) INSERT initial transaction
    const { error: insErr } = await supabase.from('p24_transactions').insert({
      session_id: sessionId,
      public_ref: publicRef,
      amount_grosze: amount,
      currency,
      email,
      status: 'created',
      meta: body?.meta || null,
      consents: body?.consents || null,
      consents_version: body?.consentsVersion || null,
    });

    if (insErr) throw new Error('DB insert failed: ' + insErr.message);

    const urlReturn = buildAbsoluteUrl(req, cfg.returnPath);
    const urlStatus = buildAbsoluteUrl(req, cfg.statusPath);

    // 2) REGISTER
    let token = null;
    let orderId = null;
    let registerPayload = null;

    if (cfg.mode === 'legacy') {
      // Legacy /trnRegister (no BasicAuth)
      const sign = p24LegacyRegisterSign({
        sessionId,
        merchantId: cfg.merchantId,
        amount,
        currency,
        crc: cfg.crc,
      });

      const form = {
        p24_session_id: sessionId,
        p24_merchant_id: String(cfg.merchantId),
        p24_pos_id: String(cfg.posId),
        p24_amount: String(amount),
        p24_currency: currency,
        p24_description: cfg.description,
        p24_email: email || 'no-reply@cappellamarialis.pl',
        p24_country: 'PL',
        p24_language: 'pl',
        p24_url_return: urlReturn,
        p24_url_status: urlStatus,
        p24_api_version: '3.2',
        p24_sign: sign,
      };

      const reg = await p24TrnRegister({ host: cfg.hostForRedirect, form });
      token = reg.token;
      registerPayload = { request: form, response: reg };
    } else {
      // REST /api/v1/transaction/register (BasicAuth required)
      const sign = p24RegisterSign({
        sessionId,
        merchantId: cfg.merchantId,
        amount,
        currency,
        crc: cfg.crc,
      });

      const registerBody = {
        merchantId: cfg.merchantId,
        posId: cfg.posId,
        sessionId,
        amount,
        currency,
        description: cfg.description,
        email: email,
        country: 'PL',
        language: 'pl',
        urlReturn,
        urlStatus,
        sign,
      };

      const registerUrl = `${cfg.baseUrl}/transaction/register`;
      const registerResp = await p24PostJson({
        url: registerUrl,
        posId: cfg.posId,
        apiKey: cfg.apiKey,
        body: registerBody,
      });

      token = registerResp?.data?.token || registerResp?.token || null;
      orderId = registerResp?.data?.orderId || registerResp?.orderId || null;
      registerPayload = { request: registerBody, response: registerResp };

      if (!token) throw new Error('P24 register: missing token in response');
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
        register_payload: registerPayload,
      })
      .eq('session_id', sessionId);

    if (updErr) throw new Error('DB update failed: ' + updErr.message);

    res.status(200).json({ sessionId, publicRef, redirectUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd serwera', details: String(err?.message || err) });
  }
}
