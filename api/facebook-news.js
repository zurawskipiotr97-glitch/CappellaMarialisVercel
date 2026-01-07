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

  const cfg = {};
  for (const row of data || []) {
    cfg[row.key] = row.value;
  }

  // Walidacja minimalna
  for (const k of keys) {
    // deepl_api_key jest opcjonalny (bo endpoint PL może działać bez niego)
    if (k === 'deepl_api_key') continue;
    if (!cfg[k]) {
      throw new Error(`Brak konfiguracji w Supabase (secret_config): ${k}`);
    }
  }

  return cfg;
}

function stablePostsFingerprint(posts) {
  const minimal = (posts || []).map(p => ({
    title: p.title || '',
    body: p.body || '',
    date: p.date || '',
    link: p.link || '',
    image: p.image || ''
  }));
  const json = JSON.stringify(minimal);
  return crypto.createHash('sha256').update(json).digest('hex');
}

async function translateWithDeepL(text, apiKey) {
  if (!text) return '';
  const params = new URLSearchParams();
  params.set('text', text);
  params.set('target_lang', 'EN');

  // DeepL API Free endpoint:
  // https://api-free.deepl.com/v2/translate
  const resp = await fetch('https://api-free.deepl.com/v2/translate', {
    method: 'POST',
    headers: {
      'Authorization': `DeepL-Auth-Key ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  if (!resp.ok) {
    throw new Error(`DeepL HTTP ${resp.status}`);
  }

  const json = await resp.json();
  return json?.translations?.[0]?.text || text;
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
      'page_access_token',
      'deepl_api_key'
    ]);

    const pageId = cfg['facebook_page_id'];
    const limit = Number(cfg['posts_limit'] ?? '3');
    const cacheHrs = Number(cfg['cache_refresh_hours'] ?? '0.25');
    const accessToken = cfg['page_access_token'];

    const nowMs = Date.now();

    // Parametry endpointu:
    // - /api/facebook-news?lang=en -> zwraca EN (z cache, a jeśli PL się zmieniło to aktualizuje EN)
    // - /api/facebook-news?prefetch_en=1 -> przy wywołaniu PL próbuje odświeżyć EN (tylko jeśli zmiana)
    const urlObj = new URL(req.url, 'http://localhost');
    const lang = (urlObj.searchParams.get('lang') || 'pl').toLowerCase();
    const prefetchEn = urlObj.searchParams.get('prefetch_en') === '1';

    const cacheKeyPL = 'facebook_news';
    const cacheKeyEN = 'facebook_news_en';

    async function ensureEnglishCache({ sourceHash, posts }) {
      const deeplKey = cfg['deepl_api_key'];
      if (!deeplKey) {
        throw new Error('Brak deepl_api_key w secret_config.');
      }

      // 1) Sprawdź czy EN cache już jest aktualne
      const { data: enRow, error: enReadErr } = await supabase
        .from('facebook_cache')
        .select('data')
        .eq('cache_key', cacheKeyEN)
        .maybeSingle();

      if (enReadErr) {
        console.error('Supabase EN cache read error:', enReadErr);
      }

      const existingHash = enRow?.data?.source_hash;
      if (existingHash && existingHash === sourceHash) {
        return enRow.data;
      }

      // 2) Tłumaczenie tylko gdy hash się różni
      const translatedPosts = [];
      for (const p of posts || []) {
        const titleEn = await translateWithDeepL(p.title || '', deeplKey);
        const bodyEn = await translateWithDeepL(p.body || '', deeplKey);

        translatedPosts.push({
          ...p,
          title: titleEn,
          body: bodyEn
        });
      }

      const enPayload = {
        cached_at: Math.floor(Date.now() / 1000),
        source_hash: sourceHash,
        posts: translatedPosts
      };

      // 3) Zapis EN cache
      const { error: enWriteErr } = await supabase
        .from('facebook_cache')
        .upsert({
          cache_key: cacheKeyEN,
          data: enPayload,
          cached_at: new Date().toISOString()
        });

      if (enWriteErr) {
        throw new Error(`Supabase EN cache write error: ${enWriteErr.message}`);
      }

      return enPayload;
    }

    // 1. Cache z Supabase (PL)
    let fallbackCache = null;
    if (cacheHrs > 0) {
      const { data: cacheRow, error: cacheError } = await supabase
        .from('facebook_cache')
        .select('data, cached_at')
        .eq('cache_key', cacheKeyPL)
        .maybeSingle();

      if (cacheError) {
        console.error('Błąd odczytu cache z Supabase:', cacheError);
      } else if (cacheRow && cacheRow.data && cacheRow.cached_at) {
        const cachedTime = new Date(cacheRow.cached_at).getTime();
        const diffHours = (nowMs - cachedTime) / 1000 / 3600;

        if (diffHours < cacheHrs) {
          const plPayload = cacheRow.data;

          // Model B: gdy prosisz o EN, nigdy nie generujemy tłumaczeń na tym wywołaniu.
          // Zwracamy tylko to, co jest już w cache EN.
          if (lang === 'en') {
            const { data: enRow } = await supabase
              .from('facebook_cache')
              .select('data')
              .eq('cache_key', cacheKeyEN)
              .maybeSingle();

            if (enRow?.data?.posts) {
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify(enRow.data));
              return;
            }

            // EN nie jest jeszcze przygotowane — trzeba najpierw odświeżyć PL z prefetch_en=1
            res.statusCode = 503;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: 'EN cache nie jest jeszcze przygotowane. Odśwież wersję PL (index.html), aby wygenerować tłumaczenie.' }));
            return;
          }

          // Dla PL zwracamy cache bez zmian.
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(plPayload));
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
    ].join(',');

    const fbUrl = `https://graph.facebook.com/v18.0/${pageId}/posts?fields=${fields}&limit=${limit}&access_token=${accessToken}`;

    let fbJson;
    try {
      const fbRes = await fetch(fbUrl);
      if (!fbRes.ok) {
        const text = await fbRes.text();
        console.error('Facebook API error:', fbRes.status, text);
        throw new Error('Facebook API error');
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

    const sourceHash = stablePostsFingerprint(posts);

    // Model B: tłumaczymy EN tylko wtedy, gdy ZMIENIŁ SIĘ stan postów PL.
    const previousHash = fallbackCache?.source_hash || null;
    const plChanged = !previousHash || previousHash !== sourceHash;


    const payload = {
      cached_at: Math.floor(nowMs / 1000),
      source_hash: sourceHash,
      posts
    };

    // 4. Zapis cache PL
    if (posts.length > 0) {
      const { error: upsertError } = await supabase
        .from('facebook_cache')
        .upsert({
          cache_key: cacheKeyPL,
          data: payload,
          cached_at: new Date().toISOString()
        });

      if (upsertError) {
        console.error('Błąd zapisu cache do Supabase:', upsertError);
      }

      if (lang === 'en') {
        // Model B: nie generujemy tłumaczeń przy wywołaniu EN.
        const { data: enRow } = await supabase
          .from('facebook_cache')
          .select('data')
          .eq('cache_key', cacheKeyEN)
          .maybeSingle();

        if (enRow?.data?.posts) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(enRow.data));
          return;
        }

        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'EN cache nie jest jeszcze przygotowane. Odśwież wersję PL (index.html), aby wygenerować tłumaczenie.' }));
        return;
      }

      if (prefetchEn && plChanged) {
        try {
          await ensureEnglishCache({ sourceHash, posts });
        } catch (e) {
          console.error('Prefetch EN error:', e);
        }
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
      return;
    }

    // Brak nowych postów → stary cache
    if (fallbackCache) {
      if (lang === 'en') {
        const { data: enRow } = await supabase
          .from('facebook_cache')
          .select('data')
          .eq('cache_key', cacheKeyEN)
          .maybeSingle();

        if (enRow?.data?.posts) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(enRow.data));
          return;
        }

        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'EN cache nie jest jeszcze przygotowane. Odśwież wersję PL (index.html), aby wygenerować tłumaczenie.' }));
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(fallbackCache));
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ cached_at: Math.floor(nowMs / 1000), source_hash: stablePostsFingerprint([]), posts: [] }));
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Błąd serwera.' }));
  }
}
