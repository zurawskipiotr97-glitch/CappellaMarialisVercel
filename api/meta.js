// Vercel Serverless Function: Meta (Facebook/Messenger/WhatsApp) share helper.
// This endpoint always returns 200 OK (no Range/206) and includes OG/Twitter tags.
// It is invoked transparently for Meta bots via vercel.json rewrite.
//
// /api/meta?p=<path>
const OG_IMAGE = "https://www.cappellamarialis.pl/images/og-cover-1200x630.jpg";
const FB_APP_ID = "1519385729118488";

const PAGES = {
  "/": {
    lang: "pl",
    title: "Cappella Marialis",
    desc: "Zespół wokalny bazyliki Mariackiej w Krakowie. Koncerty, nagrania i aktualności.",
    url: "https://www.cappellamarialis.pl/"
  },
  "/en.html": {
    lang: "en",
    title: "Cappella Marialis",
    desc: "Cappella Marialis is a vocal ensemble of St. Mary's Basilica in Kraków. Concerts, recordings and news.",
    url: "https://www.cappellamarialis.pl/en.html"
  },
  "/privacy.html": {
    lang: "pl",
    title: "Polityka prywatności – Cappella Marialis",
    desc: "Polityka prywatności strony internetowej Cappella Marialis.",
    url: "https://www.cappellamarialis.pl/privacy.html"
  },
  "/regulamin.html": {
    lang: "pl",
    title: "Regulamin darowizn – Cappella Marialis",
    desc: "Regulamin dokonywania darowizn za pośrednictwem strony internetowej Fundacji Cappella Marialis.",
    url: "https://www.cappellamarialis.pl/regulamin.html"
  },
  "/rodo.html": {
    lang: "pl",
    title: "Klauzula informacyjna RODO – Cappella Marialis",
    desc: "Klauzula informacyjna RODO dla użytkowników strony Cappella Marialis.",
    url: "https://www.cappellamarialis.pl/rodo.html"
  },
  "/dostepnosc.html": {
    lang: "pl",
    title: "Deklaracja dostępności – Cappella Marialis",
    desc: "Deklaracja dostępności strony internetowej Cappella Marialis (WCAG 2.1 AA).",
    url: "https://www.cappellamarialis.pl/dostepnosc.html"
  },
  "/accessibility.html": {
    lang: "en",
    title: "Cappella Marialis – Accessibility statement",
    desc: "Accessibility statement for the Cappella Marialis website, prepared in accordance with WCAG 2.1 AA.",
    url: "https://www.cappellamarialis.pl/accessibility.html"
  }
};

function normalizePath(p) {
  if (!p) return "/";
  let x = String(p).split("?")[0].split("#")[0].trim();
  if (!x) return "/";
  if (!x.startsWith("/")) x = "/" + x;
  x = x.replace(/\/+/, "/");
  return x;
}

function resolvePage(pathname) {
  if (PAGES[pathname]) return PAGES[pathname];
  if (!pathname.endsWith(".html") && PAGES[pathname + ".html"]) return PAGES[pathname + ".html"];
  return PAGES["/"];
}

export default function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method not allowed");
    return;
  }

  const pathname = normalizePath(req.query?.p);
  const page = resolvePage(pathname);

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=600, max-age=0");

  const url = page.url;
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
