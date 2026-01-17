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

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  try {
    const cfg = await loadConfig([
      'facebook_page_id',
      'posts_limit',
      'cache_refresh_hours',
      'page_access_token'
    ]);

    const pageId = cfg['facebook_page_id'];
    const limit = Number(cfg['posts_limit'] ?? '3');
    const cacheHrs = Number(cfg['cache_refresh_hours'] ?? '0.25');
    const accessToken = cfg['page_access_token'];

    if (!pageId || !accessToken) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        error: 'Brak page_id lub page_access_token. Najpierw uruchom logowanie administratora.'
      }));
      return;
    }

    const nowMs = Date.now();
    const cacheKey = 'facebook_news';

    // 1. Cache z Supabase
    let fallbackCache = null;
    if (cacheHrs > 0) {
      const { data: cacheRow, error: cacheError } = await supabase
        .from('facebook_cache')
        .select('data, cached_at')
        .eq('cache_key', cacheKey)
        .maybeSingle();

      if (cacheError) {
        console.error('Błąd odczytu cache z Supabase:', cacheError);
      } else if (cacheRow && cacheRow.data && cacheRow.cached_at) {
        const cachedTime = new Date(cacheRow.cached_at).getTime();
        const diffHours = (nowMs - cachedTime) / 1000 / 3600;
        if (diffHours < cacheHrs) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(cacheRow.data));
          return;
        } else {
          fallbackCache = cacheRow.data;
        }
      }
    }

    // 2. Zapytanie do Graph API
    const fields = [
      'message',
      'story',
      'created_time',
      'permalink_url',
      'full_picture'
    ];

    const params = new URLSearchParams({
      fields: fields.join(','),
      limit: String(limit),
      access_token: accessToken
    });

    const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(pageId)}/posts?` + params.toString();

    let fbJson;
    try {
      const fbRes = await fetch(url);
      if (!fbRes.ok) {
        throw new Error(`Facebook HTTP ${fbRes.status}`);
      }
      fbJson = await fbRes.json();
    } catch (err) {
      console.error('Błąd pobierania z Facebooka:', err);
      if (fallbackCache) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(fallbackCache));
        return;
      }
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Błąd pobierania danych z Facebooka.' }));
      return;
    }

    if (!fbJson || !Array.isArray(fbJson.data) || fbJson.data.length === 0) {
      if (fallbackCache) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(fallbackCache));
        return;
      }
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Nieprawidłowa odpowiedź z Facebooka.', raw: fbJson }));
      return;
    }

    // 3. Zbudowanie tablicy postów (prawie jak w PHP)
    const posts = [];
    for (const item of fbJson.data) {
      const message = item.message || item.story || '';
      if (!message) continue;

      let titleRaw = message || item.story || '';
      let title = titleRaw.trim();

      // 1. Tytuł do pierwszego znaku kończącego zdanie (. ! ?)
      const stopIndex = title.search(/[.!?]/);
      if (stopIndex !== -1) {
        title = title.slice(0, stopIndex + 1).trim();
      } else {
        // 2. Jeśli nie ma kropki/!/?, bierzemy pierwszą linię
        const newlineIndex = title.indexOf('\n');
        if (newlineIndex !== -1) {
          title = title.slice(0, newlineIndex).trim();
        }
      }

      // 3. Ostateczne skrócenie, jeśli bardzo długie (np. > 60 znaków)
      const maxTitle = 60;
      if (title.length > maxTitle) {
        title = title.slice(0, maxTitle - 1) + '…';
      }


      posts.push({
        title,
        body: message,
        date: item.created_time || null,
        image: item.full_picture || '',
        link: item.permalink_url || null
      });
    }

    const payload = {
      cached_at: Math.floor(nowMs / 1000),
      posts
    };

    // 4. Zapis cache
    if (posts.length > 0) {
      const { error: upsertError } = await supabase
        .from('facebook_cache')
        .upsert({
          cache_key: cacheKey,
          data: payload,
          cached_at: new Date().toISOString()
        });

      if (upsertError) {
        console.error('Błąd zapisu cache do Supabase:', upsertError);
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
      return;
    }

    // Brak nowych postów → stary cache
    if (fallbackCache) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(fallbackCache));
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ cached_at: Math.floor(nowMs / 1000), posts: [] }));
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Błąd serwera.' }));
  }
}
