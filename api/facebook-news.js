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

  for (const k of keys) {
    if (k === 'deepl_api_key') continue;
    if (!cfg[k]) {
      throw new Error(`Brak konfiguracji w Supabase (secret_config): ${k}`);
    }
  }

  return cfg;
}

function normalizeText(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function postContentHash(p) {
  const payload = {
    title: normalizeText(p?.title),
    body: normalizeText(p?.body)
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function stablePostsFingerprint(posts) {
  const hashes = (posts || []).map(postContentHash);
  return crypto.createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
}

async function translateManyWithDeepL(texts, apiKey) {
  const clean = (texts || []).map(t => String(t ?? ''));
  if (!clean.length) return [];

  if (clean.every(t => !t)) return clean.map(() => '');

  const params = new URLSearchParams();
  for (const t of clean) {
    params.append('text', t);
  }
  params.set('target_lang', 'EN');

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
  const out = (json?.translations || []).map(x => x?.text || '');
  while (out.length < clean.length) out.push('');
  return out.slice(0, clean.length);
}

// FUNKCJA: Wyciąga obrazek z posta (w tym z udostępnień) 
async function extractImageFromPost(item, accessToken = null) {
  // Jeśli jest full_picture, użyj tego
  if (item.full_picture) {
    return item.full_picture;
  }
  
  // Jeśli post ma object_id, to jest to ID zdjęcia - możemy pobrać jego URL
  if (item.object_id && accessToken) {
    try {
      const photoUrl = `https://graph.facebook.com/v18.0/${item.object_id}?fields=images&access_token=${accessToken}`;
      const photoRes = await fetch(photoUrl);
      
      if (photoRes.ok) {
        const photoData = await photoRes.json();
        if (photoData.images && photoData.images.length > 0) {
          return photoData.images[0].source;
        }
      }
    } catch (e) {
      console.error('Błąd pobierania obrazka z object_id:', e);
    }
  }
  
  // Ostatnia szansa - spróbuj oEmbed API
  if (item.permalink_url && accessToken) {
    try {
      const embedUrl = `https://graph.facebook.com/v18.0/oembed_post?url=${encodeURIComponent(item.permalink_url)}&access_token=${accessToken}`;
      const embedRes = await fetch(embedUrl);
      
      if (embedRes.ok) {
        const embedData = await embedRes.json();
        if (embedData.thumbnail_url) {
          return embedData.thumbnail_url;
        }
      }
    } catch (e) {
      console.error('Błąd pobierania z oEmbed:', e);
    }
  }
  
  return '';
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

      const localSourceHash = stablePostsFingerprint(posts || []);

      const { data: enRow, error: enReadErr } = await supabase
        .from('facebook_cache')
        .select('data')
        .eq('cache_key', cacheKeyEN)
        .maybeSingle();

      if (enReadErr) {
        console.error('Supabase EN cache read error:', enReadErr);
      }

      const existingHash = enRow?.data?.source_hash;
      if (existingHash && existingHash === localSourceHash) {
        return enRow.data;
      }

      const existingPosts = Array.isArray(enRow?.data?.posts) ? enRow.data.posts : [];

      const enByContentHash = new Map();
      for (const p of existingPosts) {
        if (p && p.content_hash) {
          enByContentHash.set(p.content_hash, p);
        }
      }

      const nextEnPosts = [];
      const toTranslate = [];

      for (const p of posts || []) {
        const contentHash = postContentHash(p);
        const existing = enByContentHash.get(contentHash);

        if (existing && (existing.title != null || existing.body != null)) {
          nextEnPosts.push({
            ...existing,
            date: p.date || null,
            link: p.link || null,
            image: p.image || '',
            content_hash: contentHash
          });
          continue;
        }

        const idx = nextEnPosts.push({
          ...p,
          content_hash: contentHash,
          title: null,
          body: null
        }) - 1;

        toTranslate.push({ idx, field: 'title', text: p.title || '' });
        toTranslate.push({ idx, field: 'body', text: p.body || '' });
      }

      const texts = [];
      const slots = [];
      for (let i = 0; i < toTranslate.length; i++) {
        const t = toTranslate[i];
        if (!t.text) {
          nextEnPosts[t.idx][t.field] = '';
          continue;
        }
        slots.push(i);
        texts.push(t.text);
      }

      if (texts.length) {
        const translated = await translateManyWithDeepL(texts, deeplKey);
        for (let j = 0; j < translated.length; j++) {
          const originalIndex = slots[j];
          const t = toTranslate[originalIndex];
          nextEnPosts[t.idx][t.field] = translated[j] || '';
        }
      }

      const enPayload = {
        cached_at: Math.floor(Date.now() / 1000),
        source_hash: localSourceHash,
        posts: nextEnPosts
      };

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
            res.end(JSON.stringify({ error: 'EN cache nie jest jeszcze przygotowane.' }));
            return;
          }

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(plPayload));
          return;
        } else {
          fallbackCache = cacheRow.data;
        }
      }
    }

    // WAŻNE: Proste pola bez zagnieżdżonych attachments
    const fields = [
      'message',
      'story',
      'created_time',
      'permalink_url',
      'full_picture',
      'object_id'
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

    const posts = [];
    for (const item of fbJson.data) {
      const message = item.message || item.story || '';
      if (!message) continue;

      let titleRaw = message || item.story || '';
      let title = titleRaw.trim();

      const stopIndex = title.search(/[.!?]/);
      if (stopIndex !== -1) {
        title = title.slice(0, stopIndex + 1).trim();
      } else {
        const newlineIndex = title.indexOf('\n');
        if (newlineIndex !== -1) {
          title = title.slice(0, newlineIndex).trim();
        }
      }

      const maxTitle = 60;
      if (title.length > maxTitle) {
        title = title.slice(0, maxTitle - 1) + '…';
      }

      const imageUrl = await extractImageFromPost(item, accessToken);
      
      // DEBUG
      console.log('=== POST ===');
      console.log('ID:', item.id);
      console.log('Title:', title.substring(0, 50));
      console.log('Full picture:', item.full_picture || 'BRAK');
      console.log('Object ID:', item.object_id || 'BRAK');
      console.log('Final image URL:', imageUrl || 'BRAK');
      console.log('============');

      posts.push({
        title,
        body: message,
        date: item.created_time || null,
        image: imageUrl,
        link: item.permalink_url || null
      });
    }

    for (const p of posts) {
      p.content_hash = postContentHash(p);
    }

    const sourceHash = stablePostsFingerprint(posts);

    const previousHash = fallbackCache?.source_hash || null;
    const plChanged = !previousHash || previousHash !== sourceHash;

    const payload = {
      cached_at: Math.floor(nowMs / 1000),
      source_hash: sourceHash,
      posts
    };

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
        res.end(JSON.stringify({ error: 'EN cache nie jest jeszcze przygotowane.' }));
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
        res.end(JSON.stringify({ error: 'EN cache nie jest jeszcze przygotowane.' }));
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