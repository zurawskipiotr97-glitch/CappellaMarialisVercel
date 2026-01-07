// This endpoint serves a 200 OK HTML response with OG tags for Meta crawlers.
// It avoids Vercel static 206 Partial Content responses caused by Range requests.
//
// Usage (handled via vercel.json rewrite): /api/_meta?p=<path>
const OG_IMAGE = "https://www.cappellamarialis.pl/images/og-cover-1200x630.jpg";
const FB_APP_ID = "1519385729118488";

const PAGES = {
  "/": {
    "lang": "pl",
    "title": "Cappella Marialis",
    "desc": "Zesp\u00f3\u0142 wokalny bazyliki Mariackiej w Krakowie. Koncerty, nagrania i aktualno\u015bci.",
    "url": "https://www.cappellamarialis.pl/"
  },
  "/en.html": {
    "lang": "en",
    "title": "Cappella Marialis",
    "desc": "Cappella Marialis is a vocal ensemble of St. Mary's Basilica in Krak\u00f3w. Concerts, recordings and news.",
    "url": "https://www.cappellamarialis.pl/en.html"
  },
  "/privacy.html": {
    "lang": "pl",
    "title": "Polityka prywatno\u015bci \u2013 Cappella Marialis",
    "desc": "Polityka prywatno\u015bci strony internetowej Cappella Marialis.",
    "url": "https://www.cappellamarialis.pl/privacy.html"
  },
  "/regulamin.html": {
    "lang": "pl",
    "title": "Regulamin darowizn \u2013 Cappella Marialis",
    "desc": "Regulamin dokonywania darowizn za po\u015brednictwem strony internetowej Fundacji Cappella Marialis.",
    "url": "https://www.cappellamarialis.pl/regulamin.html"
  },
  "/rodo.html": {
    "lang": "pl",
    "title": "Klauzula informacyjna RODO \u2013 Cappella Marialis",
    "desc": "Klauzula informacyjna RODO dla u\u017cytkownik\u00f3w strony Cappella Marialis.",
    "url": "https://www.cappellamarialis.pl/rodo.html"
  },
  "/dostepnosc.html": {
    "lang": "pl",
    "title": "Deklaracja dost\u0119pno\u015bci \u2013 Cappella Marialis",
    "desc": "Deklaracja dost\u0119pno\u015bci strony internetowej Cappella Marialis (WCAG 2.1 AA).",
    "url": "https://www.cappellamarialis.pl/dostepnosc.html"
  },
  "/accessibility.html": {
    "lang": "en",
    "title": "Cappella Marialis \u2013 Accessibility statement",
    "desc": "Accessibility statement for the Cappella Marialis website, prepared in accordance with WCAG 2.1 AA.",
    "url": "https://www.cappellamarialis.pl/accessibility.html"
  }
};

function normalizePath(p) {
  if (!p) return "/";
  // p comes from query; it may be like "privacy.html" or "/privacy.html" or "privacy"
  let x = String(p).split("?")[0].split("#")[0].trim();
  if (x === "") return "/";
  if (!x.startsWith("/")) x = "/" + x;
  if (x === "//") x = "/";
  // strip any accidental double slashes
  x = x.replace(/\/+/g, "/");
  return x;
}

function resolvePage(pathname) {
  const p = pathname;

  // direct match
  if (PAGES[p]) return { key: p, ...PAGES[p] };

  // if it's missing .html, try adding it (e.g., /privacy -> /privacy.html)
  if (!p.endsWith(".html")) {
    const html = p === "/" ? "/" : (p + ".html");
    if (PAGES[html]) return { key: html, ...PAGES[html] };
  }

  // fallback to home
  return { key: "/", ...PAGES["/"] };
}

export default function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(405).send("Method not allowed");
    return;
  }

  const pathname = normalizePath(req.query?.p);
  const page = resolvePage(pathname);

  // Always 200 for Meta bots
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Let CDN cache a little; Meta re-scrapes via debugger when needed
  res.setHeader("Cache-Control", "public, s-maxage=600, max-age=0");

  const url = page.url; // canonical/og:url
  const title = page.title;
  const desc = page.desc;
  const lang = page.lang || "pl";

  const html = `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />

  <title>${title}</title>
  <meta name="description" content="${desc}" />
  <link rel="canonical" href="${url}" />

  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Cappella Marialis" />
  <meta property="fb:app_id" content="${FB_APP_ID}" />
  <meta property="og:url" content="${url}" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${desc}" />
  <meta property="og:image" content="${OG_IMAGE}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${desc}" />
  <meta name="twitter:image" content="${OG_IMAGE}" />

  <!-- Redirect humans to the real page immediately -->
  <meta http-equiv="refresh" content="0;url=${url}" />
</head>
<body>
  <p>Redirecting… <a href="${url}">${url}</a></p>
</body>
</html>`;

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  res.end(html);
}
