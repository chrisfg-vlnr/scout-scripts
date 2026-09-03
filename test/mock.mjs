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

  // ── decliner-presentation fixtures (two-week: WEEK=1 baseline, WEEK=2 movement) ──
  // These exist to test the REPORT, not the crawl, so both weeks crawl identically clean;
  // only the bestseller ORDER differs. Handles go through scramble() for the reason given
  // above: sequential handles are perfectly alphabetical and would trip the sort-integrity
  // guard, blocking the save and masking the behaviour under test.
  //
  // TiedDecliners reproduces 2026-08-24: a block of products overtakes a contiguous band,
  // so that whole band declines by the IDENTICAL amount and fills a top-12 list with one
  // number. SpreadDecliners is the regression guard — ordinary movement, no wide tie, list
  // must render unchanged.
  if (FIX === 'tieddecliners' || FIX === 'spreaddecliners') {
    const N = 60, PFX = FIX === 'tieddecliners' ? 'td' : 'sd';
    const H = Array.from({ length: N }, (_, i) => `${PFX}-${scramble(i)}`);
    const week = process.env.WEEK === '2' ? 2 : 1;
    const ident = Array.from({ length: N }, (_, i) => i);
    let order;
    if (week === 1) order = ident;                       // baseline: rank i+1 for H[i]
    else if (FIX === 'tieddecliners') {
      // 15 products from old ranks 41-55 jump to the front. Old ranks 1-20 all shift
      // +15; old ranks 21-40 all shift +16 (one extra passes them). Two wide ties.
      order = [
        ...Array.from({ length: 15 }, (_, i) => 40 + i),   // -> new ranks 1-15
        ...Array.from({ length: 20 }, (_, i) => i),        // old 1-20  -> new 16-35  (+15)
        55,                                                // old 56    -> new 36
        ...Array.from({ length: 20 }, (_, i) => 20 + i),   // old 21-40 -> new 37-56  (+16)
        56, 57, 58, 59,                                    // unchanged tail
      ];
    } else {
      // One product leaps from last to first; everything else drifts by 1-2 places.
      // Max decline is +2 and only a handful share it, so no collapse must occur.
      order = [59, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 10, 13, 12, 15, 14, 17, 16, 19, 18,
        ...Array.from({ length: 39 }, (_, i) => 20 + i)];
    }
    if (isJson) return mk(200, products(H), JSONH);
    const per = 10;
    const slice = order.slice((page - 1) * per, page * per).map(i => H[i]);
    return mk(200, grid(slice), HTMLH);                  // empty grid past the end -> clean stop
  }

  // ── 2026-09-03 fixtures: commented links, phantoms, and an over-narrow marker ──────────
  // Shaped like a real Shopify theme rather than like the bare `grid()` above: sitewide furniture
  // (cart drawer inside <header>) comes BEFORE <main>, and the collection grid lives inside it.
  // That byte order is the whole mechanism behind both contamination incidents this tracker has
  // had (HausOfMode 2026-08-05, CristalliSchwiiz 2026-09-03), and `grid()` cannot express it.
  //   commented — a link the merchant/app left inside an HTML comment (Fix 2's target)
  //   live      — a real link in the drawer, outside <main> (Fix 3's target; comments can't help)
  //   gridId    — the id on the grid container: a known marker, or one nothing recognises
  //   narrow    — an extra `id="product-grid"` block placed AFTER the real grid but still inside
  //               <main>: a marker that matches in the wrong place and scopes the crawl down to a
  //               handful of products (Fix 5's target)
  //   main      — false renders the same page with no <main> element at all, the theme shape
  //               where the <main> tier cannot help and whole-page extraction is all there is
  const themedPage = ({ commented = null, live = null, gridId = 'CollectionGridUnknown',
                        grid: gridHandles = [], narrow = null, main = true }) => {
    const links = hs => hs.map(h => `<a href="/products/${h}">x</a>`).join('');
    const drawer = `<div class="cart-drawer">`
      + (commented ? `<!--<a href="/collections/all/products/${commented}">--> <b>Sicherheitspaket</b>` : '')
      + (live ? `<a href="/collections/all/products/${live}">Add protection</a>` : '')
      + `</div>`;
    const inner = `<div id="${gridId}">${links(gridHandles)}</div>`
      + (narrow ? `<div id="product-grid">${links(narrow)}</div>` : '');
    return `<html><body><header>${drawer}</header>`
      + (main ? `<main>${inner}</main>` : inner)
      + `<footer></footer></body></html>`;
  };

  // CommentedWidget      marker path, commented phantom in the drawer. The marker sits after the
  //                      phantom in byte order, so page 1 was already clean before 2026-09-03 —
  //                      this is the regression guard that Fixes 2/3 do not disturb the marker
  //                      path. The difference shows up on the TAIL pages, where the grid is empty,
  //                      the scoped slice yields nothing and extraction falls back to the whole
  //                      page: before Fix 2 the commented link was picked up there and appended as
  //                      the last rank; after it, the tail pages are genuinely empty.
  // CommentedWidgetNoMarker  same page with an unrecognised grid id, plus a SECOND phantom that is
  //                      live markup rather than commented out. Before: both lead the ranking.
  //                      After: Fix 2 removes the commented one and Fix 3's <main> slice removes
  //                      the live one from page 1 — neither fix alone does both. The live link
  //                      still lands at the tail (same empty-page fallback as above), which is the
  //                      honest, currently-accepted behaviour and is asserted, not hidden.
  if (FIX === 'commentedwidget' || FIX === 'commentedwidgetnomarker') {
    const NM = FIX === 'commentedwidgetnomarker';
    const H = Array.from({ length: 280 }, (_, i) => `cw-${scramble(i)}`);
    if (isJson) return mk(200, products(H), JSONH);
    return mk(200, themedPage({
      commented: 'cw-commented-phantom',
      live: NM ? 'cw-live-phantom' : null,
      gridId: NM ? 'CollectionGridUnknown' : 'ProductGridContainer',
      grid: H.slice((page - 1) * 28, page * 28),
    }), HTMLH);
  }

  // PhantomTopK  no <main> anywhere and no known marker, so every tier of extractGridHandles()
  //              degrades to the whole page and the live drawer link genuinely reaches rank 1 —
  //              the CristalliSchwiiz shape with nothing left to catch it but Fix 4. The handle is
  //              absent from products.json, exactly like `pakket-bescherming`.
  if (FIX === 'phantomtopk') {
    const H = Array.from({ length: 280 }, (_, i) => `pk-${scramble(i)}`);
    if (isJson) return mk(200, products(H), JSONH);
    return mk(200, themedPage({
      live: 'pk-phantom-widget', main: false,
      grid: H.slice((page - 1) * 28, page * 28),
    }), HTMLH);
  }

  // NarrowMarker  two-week. Week 1 is an ordinary clean crawl of 280 products with no known
  //               marker. Week 2 adds an `id="product-grid"` block of 3 products AFTER the real
  //               grid — a marker matching in the wrong place, which scopes the crawl down to
  //               those 3. Nothing about that run looks broken from the inside: not capped, not
  //               partial, no redirect, and n=3 is below the sort guard's minimum. It is the
  //               shape the 2026-08-31 marker commit could produce on any of the nine fallback
  //               stores nobody has checked, and only the coverage-collapse gate refuses it.
  if (FIX === 'narrowmarker') {
    const H = Array.from({ length: 280 }, (_, i) => `nm-${scramble(i)}`);
    if (isJson) return mk(200, products(H), JSONH);
    return mk(200, themedPage({
      grid: H.slice((page - 1) * 28, page * 28),
      narrow: process.env.WEEK === '2' ? H.slice(0, 3) : null,
    }), HTMLH);
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
