import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function normalizeForHash(posts) {
  // Hash tylko z pól, które realnie oznaczają “zmianę treści”
  return posts.map(p => ({
    date: p.date || null,
    link: p.link || null,
    body: (p.body || '').trim(),
    image: p.image || ''
  }));
}

function buildTitleFromBody(text) {
  let title = (text || '').trim();
  if (!title) return 'News';

  const stopIndex = title.search(/[.!?]/);
  if (stopIndex !== -1) {
    title = title.slice(0, stopIndex + 1).trim();
  } else {
    const newlineIndex = title.indexOf('\n');
    if (newlineIndex !== -1) title = title.slice(0, newlineIndex).trim();
  }

  const maxTitle = 60;
  if (title.length > maxTitle) title = title.slice(0, maxTitle - 1) + '…';
  return title;
}

async function translateLibre(text, source = 'pl', target = 'en') {
  const endpoints = [
    'https://translate.argosopentech.com/translate',
    'https://trans.zillyhuhn.com/translate',
    'https://translate.terraprint.co/translate'
  ];

  let lastErr = null;

  for (const endpoint of endpoints) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);

    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          q: text,
          source,
          target,
          format: 'text'
        })
      });

      if (!resp.ok) {
        // weź kawałek body do diagnostyki
        const msg = await resp.text().catch(() => '');
        throw new Error(`LibreTranslate mirror HTTP ${resp.status} @ ${endpoint} :: ${msg.slice(0, 200)}`);
      }

      const data = await resp.json();
      const out = (data && data.translatedText) ? String(data.translatedText) : '';

      if (!out.trim()) {
        throw new Error(`Mirror returned empty translation @ ${endpoint}`);
      }

      return out;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(t);
    }
  }

  throw lastErr || new Error('All LibreTranslate mirrors failed');
}


export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const cacheKeyEn = 'facebook_news_en';

  // 1) Weź “źródło prawdy” PL z istniejącego endpointu (on ma własny cache i refresh_hours)
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['host'];
  const plUrl = `${proto}://${host}/api/facebook-news`;

  let plPayload;
  try {
    const plRes = await fetch(plUrl);
    if (!plRes.ok) throw new Error(`PL endpoint HTTP ${plRes.status}`);
    plPayload = await plRes.json();
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Nie udało się pobrać danych PL do tłumaczenia.' }));
    return;
  }

  const plPosts = Array.isArray(plPayload) ? plPayload : (plPayload.posts || []);
  const plHash = sha256(JSON.stringify(normalizeForHash(plPosts)));

  // 2) Pobierz cache EN
  let existingEn = null;
  try {
    const { data, error } = await supabase
      .from('facebook_cache')
      .select('data, cached_at')
      .eq('cache_key', cacheKeyEn)
      .maybeSingle();

    if (!error && data && data.data) existingEn = data.data;
  } catch (_) {
    // jeśli supabase padnie, po prostu nie mamy cache
  }

  // 3) Jeśli hash się nie zmienił – oddaj stare EN bez tłumaczenia
  if (existingEn && existingEn.pl_hash === plHash && Array.isArray(existingEn.posts)) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(existingEn));
    return;
  }

  // 4) Hash inny → tłumaczymy (ale jeśli tłumaczenie się wysypie, zwracamy stare EN)
  try {
    const translatedPosts = [];
    for (const p of plPosts) {
      const bodyPl = (p.body || '').trim();
      if (!bodyPl) continue;

      const bodyEn = await translateLibre(bodyPl, 'pl', 'en');
      const titleEn = buildTitleFromBody(bodyEn);

      translatedPosts.push({
        title: titleEn,
        body: bodyEn,
        date: p.date || null,
        image: p.image || '',
        link: p.link || null
      });
    }

    const enPayload = {
      cached_at: Math.floor(Date.now() / 1000),
      pl_hash: plHash,
      posts: translatedPosts
    };

    // 5) Zapisz cache EN
    await supabase
      .from('facebook_cache')
      .upsert({
        cache_key: cacheKeyEn,
        data: enPayload,
        cached_at: new Date().toISOString()
      });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(enPayload));
  } catch (e) {
    // Fallback: jeśli tłumaczenie nie działa, a mamy poprzednie EN → oddaj je
    if (existingEn && Array.isArray(existingEn.posts)) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(existingEn));
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      cached_at: Math.floor(Date.now() / 1000),
      pl_hash: plHash,
      posts: []
    }));
  }
}
