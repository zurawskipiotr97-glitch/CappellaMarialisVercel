import querystring from 'node:querystring';

import { getSupabaseAdmin } from '../_lib/supabase.js';
import { getP24Config, p24PostJson, p24VerifySign } from '../_lib/p24.js';
import { sendThankYouEmail } from '../_lib/email.js';

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function parseBody(raw, contentType) {
  const ct = String(contentType || '').toLowerCase();

  // Prefer urlencoded if header says so OR raw looks like key=value&...
  if (ct.includes('application/x-www-form-urlencoded') || raw.includes('=')) {
    return querystring.parse(raw);
  }

  // JSON fallback
  try {
    return JSON.parse(raw);
  } catch {
    // last resort: try urlencoded anyway
    return querystring.parse(raw);
  }
}

function toInt(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const supabase = getSupabaseAdmin();
  const cfg = getP24Config();

  try {
    const raw = await readRawBody(req);
    const payload = parseBody(raw, req.headers['content-type']);

    // P24 fields (urlencoded => strings)
    const sessionId =
      payload.sessionId ||
      payload.p24_session_id ||
      payload.p24_sessionid ||
      null;

    const orderId =
      payload.orderId ||
      payload.p24_order_id ||
      payload.p24_orderid ||
      null;

    // Zapisz event zawsze (append-only), nawet jeśli brak sessionId
    await supabase.from('p24_events').insert({
      event_type: 'webhook_status',
      session_id: sessionId,
      p24_order_id: orderId ? String(orderId) : null,
      payload_json: payload,
    });

    // Brak identyfikatorów = nie zwracaj błędu, żeby P24 nie spamował
    if (!sessionId) {
      res.status(200).send('OK');
      return;
    }

    // Pobierz transakcję
    const { data: tx, error: txErr } = await supabase
      .from('p24_transactions')
      .select('*')
      .eq('session_id', sessionId)
      .maybeSingle();

    if (txErr) throw new Error('DB read failed: ' + txErr.message);
    if (!tx) {
      res.status(200).send('OK');
      return;
    }

    // Idempotencja
    if (tx.status === 'paid') {
      res.status(200).send('OK');
      return;
    }

    const amount = toInt(tx.amount_grosze);
    const currency = String(tx.currency || 'PLN');

    // orderId preferuj z webhooka, fallback z DB
    const orderIdFinal = orderId || tx.p24_order_id;
    if (!orderIdFinal) {
      // nie da się zrobić verify bez orderId
      res.status(200).send('OK');
      return;
    }

    // SIGN do verify (na bazie Twoich danych + CRC)
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
      posId: cfg.posId,
      apiKey: cfg.apiKey,
      body: verifyBody,
    });

    const paidAt = new Date().toISOString();

    // Update transakcji (idempotentnie)
    const { data: updatedRows, error: updErr } = await supabase
      .from('p24_transactions')
      .update({
        status: 'paid',
        paid_at: paidAt,
        p24_order_id: String(orderIdFinal),
        verify_payload: { request: verifyBody, response: verifyResp },
      })
      .eq('session_id', sessionId)
      .neq('status', 'paid')
      .select('session_id, email, amount_grosze, currency, public_ref, p24_order_id, thankyou_email_sent_at');

    if (updErr) throw new Error('DB update failed: ' + updErr.message);

    const updated = updatedRows?.[0] || null;

    // Event verify
    await supabase.from('p24_events').insert({
      event_type: 'verify',
      session_id: sessionId,
      p24_order_id: String(orderIdFinal),
      payload_json: { request: verifyBody, response: verifyResp },
    });

    // Email exactly-once
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
          .update({
            thankyou_email_sent_at: new Date().toISOString(),
            thankyou_email_error: null,
          })
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

    res.status(200).send('OK');
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

    // 200 żeby P24 nie robił stormu; i tak będzie retry + możesz “dopchnąć” checkiem
    res.status(200).send('OK');
  }
}
