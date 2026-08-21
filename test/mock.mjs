// Fetch mock for the Scout tracker fixtures. NO NETWORK: every request is served from
// generated fixture data. Installed via `node --import ./mock.mjs index.js ...`.
// politeFetchOnce() uses only res.status / res.ok / res.headers.get() / res.text().
const FIX = process.env.FIXTURE;
const mk = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: n => headers[n.toLowerCase()] ?? null },
  text: async () => body,
});
const JSONH = { 'content-type': 'application/json' };
const HTMLH = { 'content-type': 'text/html' };

// A collection-grid page carrying `n` product links, scoped in a known container marker.
const grid = (handles) =>
  `<html><body><div id="CollectionAjaxContent">` +
  handles.map(h => `<a href="/products/${h}">x</a>`).join('') +
  `</div></body></html>`;

const products = (handles) => JSON.stringify({
  products: handles.map((h, i) => ({
    handle: h, title: 'P ' + h, product_type: 'Dress', id: 1000 + i,
    variants: [{ price: '49.90' }],
  })),
});

// Real RedlichBecker handles carry random suffixes (…-ruschendetails-r-b-glei6fgqdq-q4c5g4),
// the signature of a bulk import, and scored no alphabetical correlation. A naively sequential
// fixture handle (`rb-rank-0`, `rb-rank-1`, …) is PERFECTLY alphabetical, which trips the
// sort-integrity guard and would block the save for a reason the real store does not have —
// masking exactly the behaviour under test. Scramble deterministically so lexicographic order
// is uncorrelated with rank order, as it is in production.
const scramble = i => ((i * 2654435761) % 99999989).toString(36).padStart(6, '0');

const CEILING_400 = '{"errors":"Page * Limit exceeds the 25000 limit."}';

function route(urlStr) {
  const u = new URL(urlStr);
  const page = Number(u.searchParams.get('page') || '1');
  const isJson = u.pathname.endsWith('/products.json');

  if (FIX === 'redlichbecker') {
    // 2026-08-17 shape (OBSERVED: catalog 25000, catalog fetch HTTP 400, rank crawl capped).
    if (isJson) {
      if (page <= 100) return mk(200, products(Array.from({length:250}, (_,i)=>`rb-${scramble((page-1)*250+i)}`)), JSONH);
      return mk(400, CEILING_400, JSONH);           // Shopify's page x limit ceiling
    }
    // Every rank page stays productive, so the crawl runs the full 800-page budget -> capped.
    return mk(200, grid(Array.from({length:28}, (_,i)=>`rb-${scramble((page-1)*28+i)}`)), HTMLH);
  }

  if (FIX === 'breuermode') {
    // 2026-08-17 shape (OBSERVED: / -> 302 /password, products.json -> bare 401).
    if (isJson) return mk(401, '', HTMLH);
    if (u.pathname === '/password') return mk(200, '<html><body>Opening soon</body></html>', HTMLH);
    return mk(302, '', { location: 'https://breuermode.de/password' });
  }

  if (FIX === 'glitchpage') {
    // One duplicate page mid-crawl (page 50 repeats page 49), real catalogue ends after 200.
    if (isJson) return mk(200, products(Array.from({length:40}, (_,i)=>`gp-${scramble(i)}`)), JSONH);
    if (page > 200) return mk(200, grid([]), HTMLH);
    const src = page === 50 ? 49 : page;            // page 50 serves page 49 again -> 0 new
    return mk(200, grid(Array.from({length:28}, (_,i)=>`gp-${scramble((src-1)*28+i)}`)), HTMLH);
  }

  if (FIX === 'endatcapminus1') {
    // Genuine end of catalogue one page before the store's cap (maxRankPages 20).
    if (isJson) return mk(200, products(Array.from({length:40}, (_,i)=>`ec-${scramble(i)}`)), JSONH);
    if (page > 19) return mk(200, grid([]), HTMLH);
    return mk(200, grid(Array.from({length:28}, (_,i)=>`ec-${scramble((page-1)*28+i)}`)), HTMLH);
  }

  if (FIX === 'cleanend') {
    // Ordinary healthy store: catalogue ends naturally well inside the cap.
    if (isJson) return mk(200, products(Array.from({length:40}, (_,i)=>`ce-${scramble(i)}`)), JSONH);
    if (page > 10) return mk(200, grid([]), HTMLH);
    return mk(200, grid(Array.from({length:4}, (_,i)=>`ce-${scramble((page-1)*4+i)}`)), HTMLH);
  }

  if (FIX === 'emptygrid') {
    // Catalog 401 (no redirect anywhere), rank pages 200-but-empty. The shape that produced
    // the self-contradicting 'Tier 2-partial (catalog only, no rank) | catalog 0' label.
    if (isJson) return mk(401, '', HTMLH);
    return mk(200, grid([]), HTMLH);
  }

  throw new Error('no fixture: ' + FIX);
}

let calls = 0;
globalThis.fetch = async (url) => { calls++; return route(String(url)); };
process.on('exit', () => console.log(`[mock] fetches served: ${calls}`));
