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

  // P24 webhook is often x-www-form-urlencoded
  if (ct.includes('application/x-www-form-urlencoded') || raw.includes('=')) {
    return querystring.parse(raw);
  }

  // fallback JSON
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

    // P24 field names
    const sessionId = String(
      payload.p24_session_id || payload.sessionId || ''
    ).trim();

    const orderIdRaw = payload.p24_order_id || payload.orderId || null;
    const orderId = orderIdRaw != null ? Number(orderIdRaw) : null;

    // Always log event (audyt)
    await supabase.from('p24_events').insert({
      event_type: 'webhook_status',
      session_id: sessionId || null,
      p24_order_id: orderId ? String(orderId) : null,
      payload_json: payload,
    });

    // If webhook without ids => ACK to avoid storm
    if (!sessionId || !orderId) return res.status(200).send('OK');

    // Load transaction by sessionId
    const { data: tx, error: txErr } = await supabase
      .from('p24_transactions')
      .select('*')
      .eq('session_id', sessionId)
      .maybeSingle();

    if (txErr) throw new Error(`DB read failed: ${txErr.message}`);
    if (!tx) return res.status(200).send('OK');

    // Idempotent
    if (tx.status === 'paid') return res.status(200).send('OK');

    const amount = toInt(tx.amount_grosze);
    const currency = String(tx.currency || 'PLN');

    if (!amount) throw new Error(`Invalid amount_grosze in DB: ${tx.amount_grosze}`);

    const sign = p24VerifySign({
      sessionId,
      orderId,
      amount,
      currency,
      crc: cfg.crc,
    });

    const verifyBody = {
      merchantId: cfg.merchantId,
      posId: cfg.posId,
      sessionId,
      amount,
      currency,
      orderId,
      sign,
    };

    // Log where we call (helps if any misconfig)
    console.log('[P24 verify] url=', `${cfg.baseUrl}/transaction/verify`);

    const verifyResp = await p24PostJson({
      url: `${cfg.baseUrl}/transaction/verify`,
      posId: cfg.posId,
      apiKey: cfg.apiKey,
      body: verifyBody,
    });

    const paidAt = new Date().toISOString();

    // Update tx to paid (idempotent)
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
      .select('session_id, email, amount_grosze, currency, public_ref, p24_order_id, thankyou_email_sent_at');

    if (updErr) throw new Error(`DB update failed: ${updErr.message}`);

    const updated = updatedRows?.[0] || null;

    // Verify event
    await supabase.from('p24_events').insert({
      event_type: 'verify',
      session_id: sessionId,
      p24_order_id: String(orderId),
      payload_json: { request: verifyBody, response: verifyResp },
    });

    // Send thank-you email once
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

    // best-effort error event
    try {
      await supabase.from('p24_events').insert({
        event_type: 'error',
        session_id: null,
        p24_order_id: null,
        payload_json: { message: String(err?.message || err) },
      });
    } catch {}

    // ACK 200 so P24 doesn't hammer you; you can retry via next webhook
    return res.status(200).send('OK');
  }
}
