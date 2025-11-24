// api/debug-config.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

export default async function handler(req, res) {
  try {
    const { data, error } = await supabase
      .from('secret_config')
      .select('key, value');

    if (error) {
      res.statusCode = 500;
      res.json({ error: 'Błąd czytania z Supabase', details: error.message });
      return;
    }

    res.statusCode = 200;
    res.json({
      env: {
        SUPABASE_URL: !!process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY
      },
      secret_config: data
    });
  } catch (e) {
    res.statusCode = 500;
    res.json({ error: 'Wyjątek w handlerze', details: String(e) });
  }
}
