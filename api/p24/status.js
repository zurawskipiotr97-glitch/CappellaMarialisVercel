import querystring from 'node:querystring';

import { getSupabaseAdmin } from '../_lib/supabase.js';
import { getP24Config, p24PostJson, p24VerifySign } from '../_lib/p24.js';
import { sendThankYouEmail } from '../_lib/email.js';

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function parseP24Body(raw, contentType) {
  const ct = String(contentType || '').toLowerCase();

  if (ct.includes('application/x-www-form-urlencoded') || raw.includes('=')) {
    return querystring.parse(raw);
  }

  try {
    return JSON.parse(raw);
  } catch {
    return querystring.parse(raw);
  }
}

function toInt(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const supabase = getSupabaseAdmin();
  const cfg = getP24Config();

  try {
    const raw = await readRawBody(req);
    const payload = parseP24Body(raw, req.headers['content-type']);

    const sessionId = String(payload.p24_session_id || payload.sessionId || '').trim();
    const orderIdRaw = payload.p24_order_id || payload.orderId || null;
    const orderId = orderIdRaw != null ? Number(orderIdRaw) : null;

    // log webhook
    await supabase.from('p24_events').insert({
      event_type: 'webhook_status',
      session_id: sessionId || null,
      p24_order_id: orderId ? String(orderId) : null,
      payload_json: payload,
    });

    // If webhook is incomplete / not paid — acknowledge to P24 anyway
    if (!sessionId || !orderId) return res.status(200).send('OK');

    const { data: tx, error: txErr } = await supabase
      .from('p24_transactions')
      .select('*')
      .eq('session_id', sessionId)
      .maybeSingle();

    if (txErr) throw new Error(`DB read failed: ${txErr.message}`);
    if (!tx) return res.status(200).send('OK');
    if (tx.status === 'paid') return res.status(200).send('OK');

    const amount = toInt(tx.amount_grosze);
    const currency = String(tx.currency || 'PLN').toUpperCase();
    if (!amount) throw new Error(`Invalid amount_grosze in DB: ${tx.amount_grosze}`);

    // SIGN uses CRC but CRC is NOT sent in request body
    const signPayload = {
      sessionId,
      orderId,
      amount,
      currency,
      crc: cfg.crc,
    };
    const sign = p24VerifySign(signPayload);

    console.log('[P24 verify sign payload]', signPayload);
    console.log('[P24 verify sign]', sign);

    // ✅ VERIFY body MUST include merchantId
    const verifyBody = {
      merchantId: cfg.merchantId,
      posId: cfg.posId,
      sessionId,
      amount,
      currency,
      orderId,
      sign,
    };

    const verifyUrl = `${cfg.baseUrl}/transaction/verify`;
    console.log('[P24 verify] url=', verifyUrl, 'proxyBase=', process.env.P24_PROXY_BASE || '');

    // ✅ REST API: verify is PUT
    const verifyResp = await p24PostJson({
      url: verifyUrl,
      posId: cfg.posId,
      apiKey: cfg.apiKey,
      body: verifyBody,
      method: 'PUT',
    });

    const paidAt = new Date().toISOString();

    const { data: updatedRows, error: updErr } = await supabase
      .from('p24_transactions')
      .update({
        status: 'paid',
        paid_at: paidAt,
        p24_order_id: String(orderId),
        verify_payload: { request: verifyBody, response: verifyResp },
      })
      .eq('session_id', sessionId)
      .neq('status', 'paid')
      .select('*');

    if (updErr) throw new Error(`DB update failed: ${updErr.message}`);

    const updated = updatedRows?.[0] || null;

    await supabase.from('p24_events').insert({
      event_type: 'verify',
      session_id: sessionId,
      p24_order_id: String(orderId),
      payload_json: { request: verifyBody, response: verifyResp },
    });

    if (updated?.email && !updated.thankyou_email_sent_at) {
      try {
        await sendThankYouEmail({
          to: updated.email,
          amountGrosze: updated.amount_grosze,
          currency: updated.currency,
          publicRef: updated.public_ref,
          p24OrderId: updated.p24_order_id,
          paidAtIso: paidAt,
        });

        await supabase
          .from('p24_transactions')
          .update({
            thankyou_email_sent_at: new Date().toISOString(),
            thankyou_email_error: null,
          })
          .eq('session_id', sessionId)
          .is('thankyou_email_sent_at', null);
      } catch (e) {
        console.error('Email error:', e);
        await supabase
          .from('p24_transactions')
          .update({ thankyou_email_error: String(e?.message || e) })
          .eq('session_id', sessionId);
      }
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error(err);

    if (err?.p24_raw_start) {
      console.error('P24 raw start:', err.p24_raw_start);
    }

    try {
      await supabase.from('p24_events').insert({
        event_type: 'error',
        payload_json: {
          message: String(err?.message || err),
          p24_code: err?.p24_code || null,
          p24_raw_start: err?.p24_raw_start || null,
        },
      });
    } catch {}

    // Always 200 to stop repeated webhook retries while you debug
    return res.status(200).send('OK');
  }
}
