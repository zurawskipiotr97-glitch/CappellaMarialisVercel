import { createClient } from '@supabase/supabase-js';

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

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const [name, ...rest] = part.trim().split('=');
    out[name] = decodeURIComponent(rest.join('=') || '');
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end('Method not allowed');
    return;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  try {
    const cfg = await loadConfig(['facebook_app_id', 'facebook_app_secret', 'facebook_page_id']);

    const appId = cfg['facebook_app_id'];
    const appSecret = cfg['facebook_app_secret'];
    const pageId = cfg['facebook_page_id'];

    if (!appId || !appSecret || !pageId) {
      res.statusCode = 500;
      res.end('<h1>Błąd konfiguracji</h1><p>Brak app_id, app_secret albo page_id.</p>');
      return;
    }

    const currentUrl = new URL(req.url, 'http://localhost');
    const code = currentUrl.searchParams.get('code');
    const state = currentUrl.searchParams.get('state');

    if (!code) {
      res.statusCode = 400;
      res.end("<h1>Błąd</h1><p>Brak parametru <code>code</code> w adresie.</p>");
      return;
    }

    const cookies = parseCookies(req.headers.cookie || '');
    if (!state || !cookies.fb_oauth_state || state !== cookies.fb_oauth_state) {
      res.statusCode = 400;
      res.end("<h1>Błąd</h1><p>Nieprawidłowy parametr <code>state</code>. Spróbuj jeszcze raz.</p>");
      return;
    }

    const proto = (req.headers['x-forwarded-proto'] || 'https');
    const host = req.headers['host'];
    const redirectUri = `${proto}://${host}/api/fb-callback`;

    // 4. Krótkotrwały USER access token
    const tokenParams = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code: String(code)
    });

    const tokenUrl = 'https://graph.facebook.com/v24.0/oauth/access_token?' + tokenParams.toString();

    let tokenJson;
    try {
      const tokenRes = await fetch(tokenUrl);
      if (!tokenRes.ok) throw new Error('HTTP ' + tokenRes.status);
      tokenJson = await tokenRes.json();
    } catch (err) {
      console.error('Błąd pobierania access_token:', err);
      res.statusCode = 500;
      res.end('<h1>Błąd</h1><p>Nie udało się pobrać access token z Facebooka.</p>');
      return;
    }

    let userAccessToken = tokenJson.access_token;
    if (!userAccessToken) {
      res.statusCode = 500;
      res.end('<h1>Błąd</h1><p>Brak <code>access_token</code> w odpowiedzi Facebooka.</p>');
      return;
    }

    // 5. Wymiana na long-lived token
    const longParams = new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: userAccessToken
    });

    const longUrl = 'https://graph.facebook.com/v24.0/oauth/access_token?' + longParams.toString();
    try {
      const longRes = await fetch(longUrl);
      if (longRes.ok) {
        const longJson = await longRes.json();
        if (longJson.access_token) {
          userAccessToken = longJson.access_token;
        }
      }
    } catch (err) {
      console.error('Błąd wymiany na long-lived token:', err);
    }

    // 6. Page access token dla strony
    const pageParams = new URLSearchParams({
      fields: 'access_token',
      access_token: userAccessToken
    });
    const pageUrl = `https://graph.facebook.com/v24.0/${encodeURIComponent(pageId)}?` + pageParams.toString();

    let pageJson;
    try {
      const pageRes = await fetch(pageUrl);
      if (!pageRes.ok) throw new Error('HTTP ' + pageRes.status);
      pageJson = await pageRes.json();
    } catch (err) {
      console.error('Błąd pobierania Page Access Token:', err);
      res.statusCode = 500;
      res.end('<h1>Błąd</h1><p>Nie udało się pobrać Page Access Token.</p>');
      return;
    }

    const pageAccessToken = pageJson.access_token;
    if (!pageAccessToken) {
      res.statusCode = 500;
      res.end('<h1>Błąd</h1><p>Odpowiedź Facebooka nie zawiera <code>access_token</code> strony.</p>');
      return;
    }

    // 7. Zapis tokena do Supabase
    const { error: saveError } = await supabase
      .from('secret_config')
      .upsert({ key: 'page_access_token', value: pageAccessToken });

    if (saveError) {
      console.error('Nie udało się zapisać tokena do Supabase:', saveError);
      res.statusCode = 500;
      res.end('<h1>Błąd</h1><p>Token pobrano, ale nie udało się go zapisać w bazie.</p>');
      return;
    }

    res.statusCode = 200;
    res.end(`
      <h1>Token zapisany 🎉</h1>
      <p>Nowy Page Access Token został zapisany w Supabase (tabela <code>secret_config</code>, klucz <code>page_access_token</code>).</p>
      <p>Teraz endpoint <code>/api/facebook-news</code> będzie go używać automatycznie.</p>
      <p>Możesz zamknąć tę stronę.</p>
    `);
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.end('<h1>Błąd serwera</h1><p>Coś poszło nie tak.</p>');
  }
}
