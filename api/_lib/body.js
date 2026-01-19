// Minimal body parser for Vercel Serverless (Node)

export async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      // Basic safeguard against unexpectedly large bodies
      if (data.length > 1_000_000) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export async function readJson(req) {
  const raw = await readRawBody(req);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function readForm(req) {
  const raw = await readRawBody(req);
  const params = new URLSearchParams(raw || '');
  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

export function getContentType(req) {
  return String(req.headers['content-type'] || '').toLowerCase();
}
