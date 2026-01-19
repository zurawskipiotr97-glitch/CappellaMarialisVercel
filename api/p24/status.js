import { getSupabaseAdmin } from '../_lib/supabase.js';
import { getContentType, readForm, readJson } from '../_lib/body.js';
import {
  getP24Config,
  p24PostJson,
  p24VerifySign,
} from '../_lib/p24.js';
import { sendThankYouEmail } from '../_lib/email.js';

function toInt(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('Method not allowed');
    return;
  }

  const supabase = getSupabaseAdmin();
  const cfg = getP24Config();

  try {
    const ct = getContentType(req);
    const payload = ct.includes('application/json')
      ? ((await readJson(req)) || {})
      : (await readForm(req));

    // P24 typically sends sessionId and orderId
    const sessionId = payload.sessionId || payload.p24_session_id || payload.p24_sessionid;
    const orderId = payload.orderId || payload.p24_order_id || payload.p24_orderid;

    // Always store event (append-only)
    await supabase.from('p24_events').insert({
      event_type: 'webhook_status',
      session_id: sessionId || null,
      p24_order_id: orderId || null,
      payload_json: payload,
    });

    if (!sessionId) {
      // Return 200 so P24 doesn't hammer you; you still have the event logged.
      res.statusCode = 200;
      res.end('OK');
      return;
    }

    // Load transaction
    const { data: tx, error: txErr } = await supabase
      .from('p24_transactions')
      .select('*')
      .eq('session_id', sessionId)
      .maybeSingle();

    if (txErr) throw new Error('DB read failed: ' + txErr.message);
    if (!tx) {
      res.statusCode = 200;
      res.end('OK');
      return;
    }

    // Idempotency: if already paid, do nothing
    if (tx.status === 'paid') {
      res.statusCode = 200;
      res.end('OK');
      return;
    }

    const amount = toInt(tx.amount_grosze);
    const currency = String(tx.currency || 'PLN');

    // Prefer orderId from payload, fallback to stored
    const orderIdFinal = orderId || tx.p24_order_id;

    if (!orderIdFinal) {
      // Can't verify without orderId; mark as failed only if you want.
      res.statusCode = 200;
      res.end('OK');
      return;
    }

    const sign = p24VerifySign({
      sessionId,
      orderId: Number(orderIdFinal),
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
      orderId: Number(orderIdFinal),
      sign,
    };

    const verifyResp = await p24PostJson({
      url: `${cfg.baseUrl}/transaction/verify`,
      merchantId: cfg.merchantId,
      apiKey: cfg.apiKey,
      body: verifyBody,
    });

    // If verify succeeded (HTTP 200), we treat as paid
    const paidAt = new Date().toISOString();

    // Update paid only if not already paid (idempotent)
    const { data: updatedRows, error: updErr } = await supabase
      .from('p24_transactions')
      .update({
        status: 'paid',
        paid_at: paidAt,
        p24_order_id: orderIdFinal,
        verify_payload: { request: verifyBody, response: verifyResp },
      })
      .eq('session_id', sessionId)
      .neq('status', 'paid')
      .select('session_id, email, amount_grosze, currency, public_ref, p24_order_id, thankyou_email_sent_at');

    if (updErr) throw new Error('DB update failed: ' + updErr.message);

    const updated = updatedRows?.[0] || null;

    // Send email exactly-once
    if (updated && updated.email && !updated.thankyou_email_sent_at) {
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
          .update({ thankyou_email_sent_at: new Date().toISOString(), thankyou_email_error: null })
          .eq('session_id', sessionId)
          .is('thankyou_email_sent_at', null);
      } catch (emailErr) {
        console.error('Email error:', emailErr);
        await supabase
          .from('p24_transactions')
          .update({ thankyou_email_error: String(emailErr?.message || emailErr) })
          .eq('session_id', sessionId);
      }
    }

    // Log verify event
    await supabase.from('p24_events').insert({
      event_type: 'verify',
      session_id: sessionId,
      p24_order_id: orderIdFinal,
      payload_json: { request: verifyBody, response: verifyResp },
    });

    res.statusCode = 200;
    res.end('OK');
  } catch (err) {
    console.error(err);

    // Log error event (best-effort)
    try {
      await supabase.from('p24_events').insert({
        event_type: 'error',
        session_id: null,
        p24_order_id: null,
        payload_json: { message: String(err?.message || err) },
      });
    } catch {}

    // IMPORTANT: return 200 to avoid repeated webhook storms; you still do verify on retries.
    res.statusCode = 200;
    res.end('OK');
  }
}
