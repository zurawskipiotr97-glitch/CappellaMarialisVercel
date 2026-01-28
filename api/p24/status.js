import { getSupabaseAdmin } from '../_lib/supabase.js';
import { readJson, readForm, getContentType } from '../_lib/body.js';
import { getP24Config, p24VerifySign, p24PostJson, p24LegacyVerifySign } from '../_lib/p24.js';

/**
 * urlStatus handler:
 * - In LEGACY mode: validate MD5 p24_sign and mark transaction as paid.
 * - In REST mode: you can still do server-to-server verify (may require whitelisted IP / proxy).
 */
export default async function handler(req, res) {
  const cfg = getP24Config();
  const supabase = getSupabaseAdmin();

  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  try {
    const ct = getContentType(req);
    const payload = ct.includes('application/json') ? (await readJson(req)) : (await readForm(req));

    // Normalize fields (legacy uses p24_* names)
    const sessionId = String(payload?.sessionId || payload?.p24_session_id || '').trim();
    const orderIdRaw = payload?.orderId ?? payload?.p24_order_id ?? payload?.p24_orderid;
    const amountRaw = payload?.amount ?? payload?.p24_amount;
    const currency = String(payload?.currency || payload?.p24_currency || 'PLN').trim();
    const sign = String(payload?.sign || payload?.p24_sign || '').trim();

    const orderId = orderIdRaw != null ? Number(orderIdRaw) : null;
    const amount = amountRaw != null ? Number(amountRaw) : null;

    if (!sessionId || !orderId || !amount) {
      res.status(400).send('Bad request');
      return;
    }

    // Load tx
    const { data: tx, error: selErr } = await supabase
      .from('p24_transactions')
      .select('*')
      .eq('session_id', sessionId)
      .maybeSingle();

    if (selErr) throw new Error('DB select failed: ' + selErr.message);
    if (!tx) {
      // Still respond OK to avoid retries; you can inspect logs
      res.status(200).send('OK');
      return;
    }

    // Basic amount/currency match
    if (Number(tx.amount_grosze) !== amount || String(tx.currency) !== currency) {
      res.status(400).send('Mismatch');
      return;
    }

    if (cfg.mode === 'legacy') {
      // Validate legacy sign if present
      if (sign) {
        const expected = p24LegacyVerifySign({
          sessionId,
          orderId,
          amount,
          currency,
          crc: cfg.crc,
        });

        if (expected !== sign) {
          res.status(400).send('Invalid sign');
          return;
        }
      }

      const { error: updErr } = await supabase
        .from('p24_transactions')
        .update({
          status: 'paid',
          p24_order_id: orderId,
          status_payload: payload,
          paid_at: new Date().toISOString(),
        })
        .eq('session_id', sessionId);

      if (updErr) throw new Error('DB update failed: ' + updErr.message);

      // P24 expects plain OK
      res.status(200).send('OK');
      return;
    }

    // REST mode: optional verify (may require proxy)
    const verifySign = p24VerifySign({
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
      sign: verifySign,
    };

    const verifyUrl = `${cfg.baseUrl}/transaction/verify`;
    await p24PostJson({
      url: verifyUrl,
      posId: cfg.posId,
      apiKey: cfg.apiKey,
      body: verifyBody,
    });

    const { error: updErr } = await supabase
      .from('p24_transactions')
      .update({
        status: 'paid',
        p24_order_id: orderId,
        status_payload: payload,
        verify_payload: verifyBody,
        paid_at: new Date().toISOString(),
      })
      .eq('session_id', sessionId);

    if (updErr) throw new Error('DB update failed: ' + updErr.message);

    res.status(200).send('OK');
  } catch (err) {
    console.error(err);
    // P24 will retry on non-200; but if we are failing due to our code, better return 200 after logging?
    res.status(500).send('ERR');
  }
}
