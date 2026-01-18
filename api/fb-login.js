import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

async function loadConfig(keys) {
  const { data, error } = await supabase
    .from('secret_config')
    .select('key, value')
    .in('key', keys);

  if (error) {
    throw new Error('Błąd czytania konfiguracji z Supabase: ' + error.message);
  }

  const map = {};
  for (const row of data || []) {
    map[row.key] = row.value;
  }
  return map;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end('Method not allowed');
    return;
  }

  try {
    const cfg = await loadConfig(['facebook_app_id', 'admin_secret']);

    const appId = cfg['facebook_app_id'];
    const adminSecret = cfg['admin_secret'];

    if (!appId || !adminSecret) {
      res.statusCode = 500;
      res.end('Brak facebook_app_id lub admin_secret w konfiguracji.');
      return;
    }

    const currentUrl = new URL(req.url, 'http://localhost');
    const provided = currentUrl.searchParams.get('s');

    if (!provided || provided !== adminSecret) {
      res.statusCode = 403;
      res.end('Brak dostępu (zły sekret administratora).');
      return;
    }

    const proto = (req.headers['x-forwarded-proto'] || 'https');
    const host = req.headers['host'];
    const redirectUri = `${proto}://${host}/api/fb-callback`;

    const state = crypto.randomBytes(16).toString('hex');

    // zapisujemy state w ciasteczku, żeby sprawdzić w callbacku
    res.setHeader(
      'Set-Cookie',
      `fb_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
    );

    const scope = [
      'public_profile',
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_metadata',
      'pages_read_user_content'
    ];

    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      state,
      scope: scope.join(',')
    });

    const url = 'https://www.facebook.com/v24.0/dialog/oauth?' + params.toString();

    res.statusCode = 302;
    res.setHeader('Location', url);
    res.end();
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.end('Błąd serwera.');
  }
}
