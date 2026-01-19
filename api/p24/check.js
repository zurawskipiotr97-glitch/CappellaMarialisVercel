import { getSupabaseAdmin } from '../_lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    const u = new URL(req.url, 'http://localhost');
    const sessionId = u.searchParams.get('sessionId');

    if (!sessionId) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Missing sessionId' }));
      return;
    }

    const supabase = getSupabaseAdmin();

    const { data: tx, error } = await supabase
      .from('p24_transactions')
      .select('session_id, public_ref, status, amount_grosze, currency, paid_at, created_at')
      .eq('session_id', sessionId)
      .maybeSingle();

    if (error) throw new Error(error.message);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ transaction: tx || null }));
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Błąd serwera' }));
  }
}
