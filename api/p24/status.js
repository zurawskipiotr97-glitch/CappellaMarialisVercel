import querystring from 'node:querystring';
import { getSupabaseAdmin } from '../_lib/supabase.js';
import { getP24Config, p24PostJson, p24VerifySign } from '../_lib/p24.js';

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function parseBody(raw) {
  return raw.includes('=') ? querystring.parse(raw) : JSON.parse(raw);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const supabase = getSupabaseAdmin();
  const cfg = getP24Config();

  const raw = await readRawBody(req);
  const payload = parseBody(raw);

  const sessionId = payload.p24_session_id;
  const orderId = Number(payload.p24_order_id);

  if (!sessionId || !orderId) return res.status(200).end();

  const { data: tx } = await supabase
    .from('p24_transactions')
    .select('*')
    .eq('session_id', sessionId)
    .maybeSingle();

  if (!tx || tx.status === 'paid') return res.status(200).end();

  const amount = tx.amount_grosze;
  const currency = tx.currency;

  const sign = p24VerifySign({ sessionId, orderId, amount, currency, crc: cfg.crc });

  const bodyA = { sessionId, orderId, amount, currency, sign };
  const bodyB = { merchantId: cfg.merchantId, posId: cfg.posId, ...bodyA };

  let verifyResp;
  try {
    verifyResp = await p24PostJson({ url: `${cfg.baseUrl}/transaction/verify`, posId: cfg.posId, apiKey: cfg.apiKey, body: bodyA });
  } catch {
    verifyResp = await p24PostJson({ url: `${cfg.baseUrl}/transaction/verify`, posId: cfg.posId, apiKey: cfg.apiKey, body: bodyB });
  }

  await supabase.from('p24_transactions').update({
    status: 'paid',
    paid_at: new Date().toISOString(),
    p24_order_id: String(orderId),
    verify_payload: verifyResp,
  }).eq('session_id', sessionId);

  res.status(200).end();
}
