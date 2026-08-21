// competitor-tracker/lib.js
// Shared brain: polite fetching, full-catalog HTML rank scrape, JSON catalog fetch,
// snapshot IO, and week-over-week / multi-week metric computation.
// Imported by both index.js (weekly run) and query.js (ad-hoc, zero-token lookups).
//
// DATA SOURCE NOTE (verified Phase 1, 2026-06-30): Shopify's products.json IGNORES
// sort_by, so it CANNOT provide bestseller rank. Rank comes only from the HTML
// best-selling view; JSON is used for the full catalog + product metadata + product_type.
// See PHASE1-FINDINGS.md.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT     = __dirname;
export const DATA_DIR = path.join(ROOT, 'data');
export const GOOGLE_SA_PATH = '/home/chris/scripts/google-service-account.json';

// ─── config ─────────────────────────────────────────────────────────────────

export async function loadConfig() {
  const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
  cfg.fetch ??= {};
  cfg.fetch.minDelayMs    ??= 1000;
  cfg.fetch.maxDelayMs    ??= 2000;
  cfg.fetch.timeoutMs     ??= 25000;
  cfg.fetch.maxRetries    ??= 3;
  cfg.fetch.maxPagesSafety??= 800;
  cfg.fetch.userAgent     ??= 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  cfg.weeksToKeep   ??= 4;
  cfg.spikeThreshold??= 50;
  cfg.flatThreshold ??= 10;
  cfg.junkHandlePatterns ??= [];
  return cfg;
}

export function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Safe config write — proper JSON serialization (never string-edit). Keeps each competitor on
// one line for readable diffs; everything else is standard 2-space JSON.
export async function saveConfig(cfg) {
  const compact = cfg.competitors.map(c => '    ' + JSON.stringify(c));
  const clone = { ...cfg, competitors: '__COMPETITORS__' };
  let s = JSON.stringify(clone, null, 2).replace('"__COMPETITORS__"', `[\n${compact.join(',\n')}\n  ]`);
  await fs.writeFile(path.join(ROOT, 'config.json'), s + '\n');
}

export function findCompetitor(cfg, nameOrSlug) {
  const s = slug(nameOrSlug);
  return cfg.competitors.find(c => slug(c.name) === s || c.name.toLowerCase() === String(nameOrSlug).toLowerCase());
}

export function normalizeBaseUrl(url) {
  let u = String(url).trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '');
}

// ─── polite fetch ─────────────────────────────────────────────────────────────

export const sleep = ms => new Promise(r => setTimeout(r, ms));

function jitter(cfg) {
  const { minDelayMs, maxDelayMs } = cfg.fetch;
  return Math.floor(minDelayMs + Math.random() * Math.max(0, maxDelayMs - minDelayMs));
}

// Cap on how long a single Retry-After-honoring wait is allowed to be — an untrusted external
// header should never be honored unbounded. Value ported from Palantir's 2026-07-28 fix (chosen
// there from 10+ live probes observing Shopify consistently send `Retry-After: 60` on
// `local_rate_limited`; this cap gives 2x headroom above that observed value).
const MAX_RETRY_AFTER_SECONDS = 120;

// Ported 2026-08-05 from Palantir's MAX_REDIRECT_HOPS (2026-07-28 fix, commit 81a258b) — see
// the redirect-pacing note on politeFetch() below for why.
const MAX_REDIRECT_HOPS = 5;

// One HTTP attempt sequence against a single URL: paced retries on transient errors
// (429/5xx/network), 3xx responses returned as-is (never retried — a redirect is deterministic,
// retrying it can't change it). `redirect: 'manual'` so the caller sees and paces every hop
// itself, rather than fetch() silently chasing a redirect inside one call — ported 2026-08-05
// from Palantir's politeFetchOnce()/politeFetch() split (2026-07-28 fix, commit 81a258b),
// prompted by the 2026-08-05 HausOfMode sort-integrity investigation (see primer). That
// investigation's live evidence turned out NOT to be a redirect (hausofmode.de returned 200
// with `sort_by` silently ignored, not a 3xx) — so this port did not fix that specific incident.
// It closes a real, separate, pre-existing gap Scout has been carrying since Palantir's original
// fix: a bare-domain competitor config (HausOfMode's `baseUrl` IS bare, no `www` — see config.json)
// hitting a canonical_host_redirection on every paginated request would, under the old
// `redirect: 'follow'`, resolve invisibly to fetch()'s own second HTTP request per hop — unpaced,
// unlogged, and silently doubling effective request volume against that store's rate-limit bucket,
// exactly Palantir's root-caused driftandtide.com incident. Verified against Palantir's own
// characterization: this is a no-op whenever no 3xx is encountered (every competitor that doesn't
// redirect), so it does not change per-page request volume for the common case — confirm this
// holds before a full batch run if a future incident suggests otherwise.
//
// Retry-After handling ported 2026-07-29 from Palantir's politeFetchOnce() (2026-07-28 fix),
// after Scout's own schema-check fetches hit this exact wall this session (see primer's
// 2026-07-29 Execution Log). SCOPE NOTE — this is deliberately NARROWER than what Palantir's
// code actually does: Palantir honors Retry-After on ANY 429 or 5xx that carries the header;
// `isShopifyRateLimit` there only changes the log message, not whether the wait is honored. This
// port only honors Retry-After when the response is specifically a 429 whose body contains
// `local_rate_limited` (Shopify's own rate-limit signature) — a 429 without that body, or any
// 5xx, falls through to the existing fixed backoff unchanged. Deliberate, per explicit scoping
// for this port, not an oversight — flagged so this doesn't get "fixed" to match Palantir later
// without that being a conscious choice. Still true after the 2026-08-05 redirect-pacing port
// below: only the redirect handling was brought in line with Palantir, not this scoping.
async function politeFetchOnce(url, cfg, { accept = 'text/html' } = {}) {
  const { timeoutMs, maxRetries, userAgent } = cfg.fetch;
  let lastErr = null;
  let nextWaitMs = null; // set by a local_rate_limited 429's Retry-After; overrides the default backoff once
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const baseWait = jitter(cfg) + (attempt > 0 ? attempt * 1500 : 0); // base pacing + backoff on retry
    await sleep(nextWaitMs != null ? Math.max(baseWait, nextWaitMs) : baseWait);
    nextWaitMs = null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          'User-Agent': userAgent,
          'Accept': accept,
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      clearTimeout(t);
      if (res.status >= 300 && res.status < 400) {
        // Node's native fetch under redirect:'manual' returns the redirect transparently
        // (status/location readable) rather than the browser's opaque 'opaqueredirect' —
        // verified live by Palantir 2026-07-28, applies equally here (same runtime). Return
        // immediately; the outer politeFetch hop loop paces the follow.
        return { status: res.status, ok: false, ctype: res.headers.get('content-type') || '', text: '', location: res.headers.get('location') };
      }
      if (res.status === 429 || res.status >= 500) {
        // Body read (needed to detect local_rate_limited) only on 429 — a 5xx can never match,
        // so skip the extra await there. Palantir's version reads the body unconditionally; this
        // is a minor, behavior-equivalent tightening, not a functional difference.
        let bodySnippet = '';
        if (res.status === 429) {
          try { bodySnippet = (await res.text()).slice(0, 60); } catch { /* body already consumed/unreadable — cosmetic only */ }
        }
        const isShopifyRateLimit = res.status === 429 && bodySnippet.includes('local_rate_limited');
        if (isShopifyRateLimit) {
          const retryAfterHeader = res.headers.get('retry-after');
          const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null;
          lastErr = `Shopify local_rate_limited (Retry-After ${retryAfterSec ?? 'n/a'}s)`;
          if (retryAfterSec && retryAfterSec > 0 && attempt < maxRetries) {
            nextWaitMs = Math.min(retryAfterSec, MAX_RETRY_AFTER_SECONDS) * 1000;
            console.error(`    [rate-limit] ${lastErr} — waiting ${Math.round(nextWaitMs / 1000)}s before retry ${attempt + 2}/${maxRetries + 1}...`);
          }
        } else {
          lastErr = `HTTP ${res.status}`;
        }
        continue; // retry
      }
      const text = await res.text();
      return { status: res.status, ok: res.ok, ctype: res.headers.get('content-type') || '', text };
    } catch (e) {
      clearTimeout(t);
      lastErr = e.name === 'AbortError' ? 'timeout' : e.message;
    }
  }
  if (lastErr && lastErr.startsWith('Shopify local_rate_limited')) {
    console.error(`    [rate-limit] retries exhausted after honoring Retry-After — giving up on this page.`);
  }
  return { status: null, ok: false, ctype: '', text: '', error: lastErr };
}

// Sequential, paced fetch. Sleeps a randomized 1–2s BEFORE every request so callers looping
// over pages stay polite automatically. Retries transient errors (429/5xx/network). Follows
// redirects itself, one paced hop at a time (bounded by MAX_REDIRECT_HOPS), instead of via
// fetch()'s built-in redirect:'follow'. Ported 2026-08-05 from Palantir's politeFetch()
// (2026-07-28 fix, commit 81a258b) — see politeFetchOnce() above for why.
//
// DEPARTURE from Palantir's shape: also returns `finalUrl` and `hops`, which Palantir's version
// doesn't surface. Added for the sort-integrity guard below (scrapeBestsellerRanks needs to know
// whether a hop silently changed the URL it asked for, in particular dropping `sort_by`) — not
// needed by Palantir today, so not backported there.
export async function politeFetch(url, cfg, { accept = 'text/html' } = {}) {
  let currentUrl = url;
  let lastResult = null;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    lastResult = await politeFetchOnce(currentUrl, cfg, { accept });
    if (lastResult.status >= 300 && lastResult.status < 400 && lastResult.location) {
      currentUrl = new URL(lastResult.location, currentUrl).toString();
      continue;
    }
    return { ...lastResult, finalUrl: currentUrl, hops: hop };
  }
  return { ...lastResult, finalUrl: currentUrl, hops: MAX_REDIRECT_HOPS, error: (lastResult.error ? lastResult.error + ' | ' : '') + `redirect hop limit (${MAX_REDIRECT_HOPS}) exceeded` };
}

// ─── JSON catalog (full product list + metadata; NOT a sales rank) ─────────────

// Price selection strategy: first variant's price (Chris's call, 2026-07-29 — chosen for
// simplicity over min-across-variants, knowing it can be arbitrary if variant order isn't
// meaningful). Isolated here so switching strategies later (e.g. Math.min across
// product.variants) is a one-line change at this function, not a re-plumb through
// fetchCatalog/buildSnapshot/computeMetrics. UNVERIFIED-THIS-SESSION: the assumption that
// variants[0].price is a numeric string comes from Shopify's documented public products.json
// contract, not a live-confirmed payload — the 2026-07-29 schema-check fetch was blocked
// (local_rate_limited) on both attempted stores; see the primer's Execution Log.
function selectPrice(product) {
  const v = Array.isArray(product.variants) ? product.variants[0] : null;
  if (!v || v.price == null) return null;
  const n = Number(v.price);
  return Number.isFinite(n) ? n : null;
}

// Shopify refuses to paginate `products.json` past page x limit = 25,000 objects, answering
// HTTP 400 with its own error text (confirmed live 2026-08-17 on RedlichBecker at page 101 of
// limit=250, and documented at shopify.dev/docs/api/usage/limits as a platform-wide pagination
// ceiling). This is a NORMAL TERMINAL CONDITION — the end of what the endpoint will serve — not
// a block, not a rate limit, not a WAF, and not merchant-specific. Before 2026-08-21 the
// catch-all below filed it as `blocked`; see buildSnapshot() for why that mattered so much.
// Matching on Shopify's literal text is deliberately narrow: if the wording ever changes we
// fall back to the old blocked -> partial -> not-saved path, which is safe. The failure mode of
// a loose match — mistaking a real 400 for a ceiling — is the unsafe direction, so we don't.
const CATALOG_PAGE_CEILING_RE = /Page \s*\*\s*Limit exceeds the (\d+) limit/i;

// Returns { ok, blocked, truncated, truncatedAt, products:[{handle,title,productType,id,url,price}], error }
export async function fetchCatalog(competitor, cfg) {
  const base = competitor.baseUrl.replace(/\/+$/, '');
  const col  = competitor.collection || 'all';
  const byHandle = new Map();
  let page = 1, blocked = false, error = null;
  let truncated = false, truncatedAt = null;

  while (page <= cfg.fetch.maxPagesSafety) {
    const url = `${base}/collections/${col}/products.json?limit=250&page=${page}`;
    const r = await politeFetch(url, cfg, { accept: 'application/json' });
    // Checked BEFORE the blocked catch-all below, which would otherwise swallow this 400.
    const ceiling = r.status === 400 ? CATALOG_PAGE_CEILING_RE.exec(r.text || '') : null;
    if (ceiling) {
      truncated = true;
      truncatedAt = Number(ceiling[1]) || null;
      error = `catalog truncated at ${byHandle.size} products by Shopify's ${truncatedAt ?? '25000'}-product pagination ceiling — this store has MORE than that and the rest cannot be enumerated through this endpoint`;
      console.error(`    [${competitor.name}] catalog page ${page}: Shopify's ${truncatedAt ?? '25000'}-product pagination ceiling reached — catalogue is TRUNCATED at ${byHandle.size} products, not complete.`);
      break;
    }
    if (r.status === 403 || r.status === 409 || r.status === 401 || r.status === 430 || (!r.ok && r.status !== 404)) {
      blocked = true; error = r.error || `HTTP ${r.status}`; break;
    }
    if (r.status === 404) { error = 'collection 404'; break; }
    let data;
    try { data = JSON.parse(r.text); }
    catch { blocked = true; error = 'catalog non-JSON (blocked?)'; break; }
    const products = Array.isArray(data.products) ? data.products : [];
    if (products.length === 0) break;
    const sizeBefore = byHandle.size;
    for (const p of products) {
      if (!p.handle) continue;
      byHandle.set(p.handle, {
        handle: p.handle,
        title: p.title || p.handle,
        productType: p.product_type || '',
        id: p.id ?? null,
        url: `${base}/products/${p.handle}`,
        price: selectPrice(p),
      });
    }
    // A page that adds no NEW handles means the server is repeating itself (some hosts
    // ignore the `page` param when erroring or serving cached content). Without this
    // break the loop would grind through all maxPagesSafety (800) identical pages —
    // ~half an hour of wasted, impolite requests per competitor. Mirrors the
    // added===0 end-of-catalog break in scrapeBestsellerRanks().
    if (byHandle.size === sizeBefore) {
      console.error(`    [${competitor.name}] catalog page ${page} returned no new products — treating as end of catalog.`);
      break;
    }
    if (products.length < 250) break;
    page++;
    if (page % 5 === 0) console.error(`    [${competitor.name}] catalog page ${page}, ${byHandle.size} products so far...`);
  }
  return { ok: byHandle.size > 0 && !blocked, blocked, truncated, truncatedAt, products: [...byHandle.values()], error };
}

// ─── HTML best-selling rank scrape (the ONLY real rank source) ─────────────────

// Consecutive zero-new-handle pages required before the rank crawl calls it the end of the
// catalogue. 3, not 1: one glitched or duplicate page must not be able to truncate a crawl
// (see the break site below for the RedlichBecker evidence), while 3 in a row is not a
// plausible transient. Costs 2 extra page fetches per store per run at a genuine end — a
// concrete non-ok status (e.g. 404) past page 1 still breaks immediately and is unaffected.
const RANK_EMPTY_PAGE_TOLERANCE = 3;

// Shopify's storefront password gate always lands on the store's own /password path.
// Path-exact on purpose: a product legitimately handled `…/products/password-reset` must not
// trip this, and neither must a query string that merely mentions the word.
function isPasswordGateUrl(u) {
  try { return /^\/password\/?$/.test(new URL(u).pathname); } catch { return false; }
}

const HREF_PRODUCT_RE = /href="[^"]*?\/products\/([a-z0-9][a-z0-9\-_%]*)(?:[?#][^"]*)?"/gi;

// Candidate container markers for the real collection-grid section, tried in order. Themes vary
// — this is a list to try, not a single hardcoded shape. Confirmed present in HausOfMode's markup
// (2026-08-05 investigation, see primer's Execution Log): the OLD whole-page regex below was
// picking up ~50 product links from a sitewide Cart Drawer add-on-product upsell widget that sits
// earlier in the page's byte order than the actual collection grid, corrupting the leading ~50
// "ranks" on that store (real grid content only starts at `id="CollectionAjaxContent"`).
const GRID_CONTAINER_MARKERS = [
  /id="CollectionAjaxContent"/i,
  /class="collection-grid__wrapper"/i,
  /data-section-type="collection-grid"/i,
];

function extractHandlesFromSlice(html) {
  const seen = new Set();
  const ordered = [];
  let m;
  HREF_PRODUCT_RE.lastIndex = 0;
  while ((m = HREF_PRODUCT_RE.exec(html)) !== null) {
    const h = decodeURIComponent(m[1]).toLowerCase();
    if (!seen.has(h)) { seen.add(h); ordered.push(h); }
  }
  return ordered;
}

// Scopes extraction to the real collection-grid container when the theme exposes one of the
// known markers, so a sitewide widget earlier in the page (cart drawer, upsell, recommendations)
// can't contaminate the leading "ranks" the way it did on HausOfMode. Falls back to the original
// whole-page regex — byte-for-byte the same behavior as before this fix — whenever no marker
// matches, OR the scoped slice yields zero products, so a theme with unfamiliar markup degrades
// to today's (already-shipped, already-trusted) behavior rather than to zero data. This fallback
// is the load-bearing safety property here: going from "wrong order" to "no data" would be worse
// than the bug being fixed. Returns { handles, scoped, marker } — callers log/report which path
// was taken per competitor, since a silent fallback is exactly how the original bug went
// unnoticed for weeks.
export function extractGridHandles(html) {
  for (const marker of GRID_CONTAINER_MARKERS) {
    const m = marker.exec(html);
    if (!m) continue;
    const startIdx = m.index;
    const endMatch = /<\/main/i.exec(html.slice(startIdx));
    const endIdx = endMatch ? startIdx + endMatch.index : html.length;
    const scopedHandles = extractHandlesFromSlice(html.slice(startIdx, endIdx));
    if (scopedHandles.length > 0) {
      return { handles: scopedHandles, scoped: true, marker: marker.source };
    }
  }
  return { handles: extractHandlesFromSlice(html), scoped: false, marker: null };
}

function makeJunkMatcher(patterns) {
  const res = patterns.map(p => { try { return new RegExp(p, 'i'); } catch { return null; } }).filter(Boolean);
  return h => res.some(re => re.test(h));
}

// Returns { ok, blocked, partial, capped, cap, handles:[...rank order], pages, error }
//
// `blocked` = no usable data at all (page 1 itself failed, or an explicit 403/409/401/430).
// `partial` = real data was collected, but a page past page 1 hit a persistent 429/5xx/network
// wall (politeFetch exhausted all retries — its `status: null` sentinel) rather than Shopify
// signaling a clean end of pagination (a concrete status like 404, or a 200 with an empty grid).
// Conflating these two was the original bug: a mid-crawl wall silently looked identical to
// "reached the last page," so a blocked/partial crawl was reported as a complete one.
// `capped` = the crawl ran out of its page budget (`page > cap`) while the last page was STILL
// yielding new products — i.e. the store genuinely has more ranked products than `cap` pages can
// reach. Deterministic (unlike `partial`), and the catalog fetch is independent/complete, so it's
// distinct from both: real, stable top-N rank data, just not full coverage. Fix per-store by
// setting `maxRankPages` high enough; the flag exists so an oversized store is reported honestly
// ("capped at page N") instead of silently passing as a complete week or blamed on the store.
export async function scrapeBestsellerRanks(competitor, cfg) {
  const base = competitor.baseUrl.replace(/\/+$/, '');
  const col  = competitor.collection || 'all';
  const isJunk = makeJunkMatcher(cfg.junkHandlePatterns);
  const cap = competitor.maxRankPages || cfg.fetch.maxPagesSafety;

  const seen = new Set();
  const ranked = [];
  let page = 1, blocked = false, partial = false, capped = false, error = null, emptyOrDupPages = 0;
  // urlIntegrityFail: a redirect hop (see politeFetch's MAX_REDIRECT_HOPS loop) landed us on a
  // URL that dropped the `sort_by` we asked for — a hard, exact signal that whatever HTML we
  // parsed did not come from the bestseller-sorted view we requested. Cheap and unambiguous
  // where it applies; added 2026-08-05 per the sort-integrity investigation (see primer). Does
  // NOT cover a 200-with-sort_by-silently-ignored response (no redirect at all) — that's what
  // detectAlphabeticalSort() in buildSnapshot() is for.
  let urlIntegrityFail = false, urlIntegrityDetail = null;
  // passwordGated: the storefront is behind Shopify's password gate — every request is
  // redirected to /password. A MERCHANT STATE (store closed to visitors: rebrand, seasonal
  // close, migration), not a block on us and not a scrape failure. Distinguished from a real
  // block by the redirect target: a WAF or IP block returns a challenge or an error page, not
  // a 302 to the store's own /password. Confirmed 2026-08-17 on BreuerMode, including a
  // plain-curl-UA control that behaved identically — i.e. the store is closed to EVERYONE.
  let passwordGated = false;
  // Grid-scoping visibility (2026-08-05 fix): decided from page 1 and logged once per
  // competitor per run, rather than per page, since 300+ pages would otherwise flood the log —
  // silent fallback is exactly how the original cart-drawer-contamination bug went unnoticed.
  let gridScopeChecked = false, gridScopeOk = false, gridScopeMarker = null;

  while (page <= cap) {
    const url = `${base}/collections/${col}?sort_by=best-selling&page=${page}`;
    const r = await politeFetch(url, cfg, { accept: 'text/html' });
    if (r.hops > 0 && r.finalUrl && isPasswordGateUrl(r.finalUrl)) {
      passwordGated = true;
      error = `store is password-protected (closed to visitors) — ${url} redirected to ${r.finalUrl}`;
      console.error(`    [${competitor.name}] password gate: ${error}`);
      break;
    }
    if (!urlIntegrityFail && r.hops > 0 && r.finalUrl && !/[?&]sort_by=/.test(r.finalUrl)) {
      urlIntegrityFail = true;
      urlIntegrityDetail = `redirected away from the requested sort (${r.hops} hop(s)): ${url} -> ${r.finalUrl}`;
      console.error(`    [${competitor.name}] URL-integrity: ${urlIntegrityDetail}`);
    }
    if (r.status === 403 || r.status === 409 || r.status === 401 || r.status === 430) {
      blocked = true; error = `HTTP ${r.status}`; break;
    }
    if (!r.ok || !r.text) {
      if (page === 1) {
        // First page failed outright — no usable data at all.
        blocked = true; error = r.error || `HTTP ${r.status}`;
      } else if (r.status === null) {
        // politeFetch exhausted every retry on a persistent 429/5xx/network failure — a real
        // wall, not Shopify saying "no more pages." Keep whatever we collected before it.
        partial = true; error = `wall hit at page ${page} (${r.error || 'retries exhausted'})`;
      }
      // else: a concrete non-ok status past page 1 (e.g. 404) — treat as the natural end of
      // pagination, same as an empty grid below.
      break;
    }
    const { handles: pageHandles, scoped, marker } = extractGridHandles(r.text);
    if (!gridScopeChecked) {
      gridScopeChecked = true;
      gridScopeOk = scoped;
      gridScopeMarker = marker;
      console.error(`    [${competitor.name}] grid extraction: ${scoped ? `scoped via marker ${marker}` : 'FALLBACK — no known container marker matched; using whole-page extraction (same behavior as before this fix)'}`);
    } else if (scoped !== gridScopeOk) {
      console.error(`    [${competitor.name}] grid extraction: page ${page} scoping ${scoped ? 'succeeded' : 'failed'} — differs from page 1's result`);
    }
    let added = 0;
    for (const h of pageHandles) {
      if (seen.has(h) || isJunk(h)) continue;
      seen.add(h); ranked.push(h); added++;
    }
    // End-of-catalog detection: a page with no NEW grid products (Shopify repeats last page
    // or serves an empty grid past the end). Tolerance raised from 1 to
    // RANK_EMPTY_PAGE_TOLERANCE consecutive such pages on 2026-08-21: breaking on the FIRST
    // one silently truncated whole crawls, and did so invisibly. Proven false positive —
    // RedlichBecker stopped at ~page 697 on 2026-08-10, yet page 960 still served 28 products
    // and linked on to 961 (probe P6, 2026-08-17 diagnosis). A single transient duplicate or
    // glitched page was indistinguishable from a real end of catalogue, and nothing in the run
    // output revealed which had happened. The page index and handle counts are now logged on
    // every empty page precisely so the next occurrence is diagnosable rather than inferred.
    if (added === 0) {
      emptyOrDupPages++;
      console.error(`    [${competitor.name}] rank scrape page ${page}: 0 new handles (${pageHandles.length} on page, ${ranked.length} ranked so far) — empty/duplicate page ${emptyOrDupPages}/${RANK_EMPTY_PAGE_TOLERANCE}.`);
      if (emptyOrDupPages >= RANK_EMPTY_PAGE_TOLERANCE) {
        console.error(`    [${competitor.name}] rank scrape: ${RANK_EMPTY_PAGE_TOLERANCE} consecutive empty/duplicate pages ending at page ${page} — treating as end of catalog at ${ranked.length} ranked.`);
        break;
      }
    } else {
      emptyOrDupPages = 0;
    }
    page++;
    if (page % 25 === 0) console.error(`    [${competitor.name}] rank scrape page ${page}, ${ranked.length} ranked so far...`);
  }
  // Exited via the `while (page <= cap)` condition rather than any break above.
  // `emptyOrDupPages === 0` is LOAD-BEARING as of 2026-08-21. It used to be implied: with a
  // tolerance of 1, an empty page always broke immediately with `page` unincremented, so
  // `page > cap` could only mean a productive final page. Raising the tolerance destroys that
  // invariant — a store whose genuine catalogue ends within RANK_EMPTY_PAGE_TOLERANCE-1 pages
  // of its cap now increments past the cap while burning its empty-page allowance, and would
  // be reported as `capped` ("raise this store's page cap") when it had in fact finished
  // cleanly. Requiring the last page to have been productive restores the original meaning.
  if (!blocked && !partial && page > cap && emptyOrDupPages === 0) {
    capped = true;
    error = `rank scrape hit the ${cap}-page cap while still finding new products — coverage incomplete (raise this store's maxRankPages)`;
  }
  return { ok: ranked.length > 0 && !blocked, blocked, partial, capped, cap, passwordGated, handles: ranked, pages: page - 1, error, urlIntegrityFail, urlIntegrityDetail, gridScoped: gridScopeOk, gridScopeMarker };
}

// ─── sort-integrity check (alphabetical-fallback detector) ────────────────────
// Mechanism-agnostic backstop for the 2026-08-05 HausOfMode incident: whatever the cause turns
// out to be on any given store — a redirect that drops sort_by (see urlIntegrityFail above), a
// theme that doesn't wire sort_by up to the collection query at all, a manual collection's own
// admin-set order — a fallback-to-default listing will closely match a locale-aware A-Z sort of
// the same product set, and a genuine bestseller ordering has no reason to correlate with
// alphabetical order at all. Method and thresholds validated 2026-08-05 against every snapshot
// in this tracker's history (every real competitor scored near-zero correlation, i.e. this does
// NOT fire on legitimately-ranked data) and a synthetic fully-alphabetical control built from a
// real product set (scored a perfect 1.000) — see the primer's Execution Log for both.
const SORT_SUSPECT_MIN_N = 15; // below this, chance alone can make a small real bestseller list look alphabetical — too few points to trust a correlation
const SORT_SUSPECT_RHO = 0.90;
const SORT_SUSPECT_ADJ = 0.90;
// Bounded prefix windows, checked IN ADDITION to the full-catalog check below — added
// 2026-08-05 after the HausOfMode cart-drawer incident showed the original whole-catalog-only
// guard is mathematically blind to a contamination confined to the leading ranks: ~50 junk
// entries diluted to invisibility across a ~13,873-product full-catalog correlation (that
// incident's actual full-catalog ρ was -0.061 — nowhere near 0.90). Strictly additive: firing on
// ANY window (full, top-30, or top-100) is sufficient to flag sortSuspect, so this can only make
// the guard fire MORE often than before, never less. Threshold left at the existing 0.90 for all
// windows, unchanged — see the primer's 2026-08-05 Execution Log for why it was NOT retuned even
// though a single-page (N=85) extraction scores below threshold (ρ=0.679): that's a real,
// reported number, not something to silently tune away.
const SORT_SUSPECT_WINDOWS = [30, 100];

// Locale heuristic from the store's own TLD — Shopify's "Alphabetically" sort and a plain
// codepoint sort disagree on stores with accented titles (German umlauts, etc: naive ASCII
// sort puts "Ä" after "Z"), so this must be locale-aware, not a byte sort. TLD is a proxy, not
// a store's confirmed storefront language — reasonable across this roster's current mix of
// .de/.com/.co domains (checked 2026-08-05), but a store with a mismatched TLD/language could
// weaken the signal. Extend with more TLDs (or a per-competitor config override) if this roster
// grows a real .nl/.fr competitor and starts producing borderline scores.
function localeForDomain(domain) {
  const d = String(domain || '').toLowerCase();
  if (d.includes('.de')) return 'de';
  if (d.includes('.nl')) return 'nl';
  if (d.includes('.fr')) return 'fr';
  return 'en';
}

// Spearman rank correlation between two same-length permutations of 1..n.
function spearman(aRanks, bRanks) {
  const n = aRanks.length;
  if (n < 2) return null;
  let sumD2 = 0;
  for (let i = 0; i < n; i++) { const d = aRanks[i] - bRanks[i]; sumD2 += d * d; }
  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

// Scores one ordered list (full catalog or a bounded prefix) against a locale-aware alphabetical
// sort of the same set. Shared by every window detectAlphabeticalSort() checks below.
function scoreOrder(ranked, collator) {
  const n = ranked.length;
  if (n < SORT_SUSPECT_MIN_N) return { suspect: false, n, rho: null, adjPairFrac: null };
  const alphaOrder = ranked.slice().sort((a, b) => collator.compare(a.title, b.title));
  const alphaRankByHandle = new Map(alphaOrder.map((p, i) => [p.handle, i + 1]));
  const alphaRanks = ranked.map(p => alphaRankByHandle.get(p.handle));
  const recordedRanks = ranked.map((_, i) => i + 1);
  const rho = spearman(recordedRanks, alphaRanks);

  let adjOk = 0;
  for (let i = 0; i < n - 1; i++) if (collator.compare(ranked[i].title, ranked[i + 1].title) <= 0) adjOk++;
  const adjPairFrac = adjOk / (n - 1);

  return { suspect: rho >= SORT_SUSPECT_RHO || adjPairFrac >= SORT_SUSPECT_ADJ, n, rho, adjPairFrac };
}

// products: buildSnapshot()'s merged catalog+rank list ({handle, title, rank, ...}).
// Returns { suspect, n, rho, adjPairFrac, firedWindow, windows } — the top-level n/rho/adjPairFrac
// always describe the FULL-catalog window (unchanged shape from before 2026-08-05's widening),
// so existing callers (index.js's Discord one-liner, sortSuspectStats) keep working unmodified;
// `windows` carries the full detail (including which bounded prefix fired, if any) for anyone
// who wants it.
export function detectAlphabeticalSort(products, domain) {
  const ranked = products.filter(p => typeof p.rank === 'number' && p.title).sort((a, b) => a.rank - b.rank);
  const collator = new Intl.Collator(localeForDomain(domain), { sensitivity: 'base', numeric: true });

  const full = scoreOrder(ranked, collator);
  const windows = { full: { window: ranked.length, ...full } };
  for (const w of SORT_SUSPECT_WINDOWS) {
    if (ranked.length <= w) continue; // window not smaller than the full catalog — would just duplicate `full`
    windows[`top${w}`] = { window: w, ...scoreOrder(ranked.slice(0, w), collator) };
  }

  const firing = Object.entries(windows).find(([, r]) => r.suspect);
  return {
    suspect: !!firing,
    n: full.n, rho: full.rho, adjPairFrac: full.adjPairFrac,
    firedWindow: firing ? firing[0] : null,
    windows,
  };
}

// ─── fast tier detection (page-1 only) — for add-time checks ───────────────────

// Same endpoints/logic as the weekly run, but only page 1 of each, so it's quick (~seconds).
// Returns { tier, blocked, jsonOk, jsonCount, jsonErr, htmlOk, htmlCount, htmlErr }.
export async function detectTier(competitor, cfg) {
  const base = normalizeBaseUrl(competitor.baseUrl);
  const col  = competitor.collection || 'all';

  const jr = await politeFetch(`${base}/collections/${col}/products.json?limit=250&page=1`, cfg, { accept: 'application/json' });
  let jsonOk = false, jsonCount = null, jsonErr = null;
  if (jr.ok) {
    try { const d = JSON.parse(jr.text); const p = Array.isArray(d.products) ? d.products : []; jsonCount = p.length; jsonOk = p.length > 0; }
    catch { jsonErr = 'non-JSON (blocked?)'; }
  } else jsonErr = jr.error || `HTTP ${jr.status}`;

  const hr = await politeFetch(`${base}/collections/${col}?sort_by=best-selling&page=1`, cfg, { accept: 'text/html' });
  let htmlOk = false, htmlCount = 0, htmlErr = null;
  if (hr.ok && hr.text) { const { handles: h } = extractGridHandles(hr.text); htmlCount = h.length; htmlOk = h.length > 0; }
  else htmlErr = hr.error || `HTTP ${hr.status}`;

  let tier, blocked = false;
  if (!jsonOk && !htmlOk)      { tier = 'Tier 3 (Blocked)'; blocked = true; }
  else if (htmlOk && jsonOk)   { tier = 'Tier 1+2 (JSON catalog + HTML rank)'; }
  else if (htmlOk)             { tier = 'Tier 2 (HTML rank only)'; }
  else                         { tier = 'Tier 2-partial (catalog only, no rank)'; }
  return { tier, blocked, jsonOk, jsonCount, jsonErr, htmlOk, htmlCount, htmlErr };
}

// ─── build a weekly snapshot for one competitor ────────────────────────────────

// Snapshot shape:
// { competitor, domain, date, tier, blocked, error, catalogCount, rankedCount, coverage,
//   products: [ { handle, title, productType, url, rank, price } ] }
//   // rank: 1..N or null (unranked); price: first-variant number or null (rank-only/Tier-2
//   // synthesized entries, and any entry Shopify didn't send a parseable price for)
export async function buildSnapshot(competitor, cfg, date) {
  const out = {
    competitor: competitor.name,
    domain: competitor.baseUrl,
    date,
    tier: null,
    blocked: false,
    partial: false,
    capped: false,
    cappedAt: null,
    // Shopify's products.json pagination ceiling cut the catalogue off (see fetchCatalog).
    // The membership list is incomplete BY CONSTRUCTION and can never be completed through
    // this endpoint, so catalogCount is a FLOOR, not the store's size, and `coverage` is
    // computed against a truncated denominator. Gated out of baseline persistence by
    // isIncomplete() — see the comment there for why this is not `capped`.
    catalogTruncated: false,
    catalogTruncatedAt: null,
    // The merchant has the storefront behind Shopify's password gate: every request is
    // redirected to /password. A merchant state, not a scrape failure and not a block on us.
    closed: false,
    sortSuspect: false,
    sortSuspectStats: null,
    error: null,
    catalogCount: 0,
    rankedCount: 0,
    coverage: 0,
    // Grid-scoping visibility (2026-08-05 fix): true when extractGridHandles() found a known
    // collection-grid container marker for this store's theme and scoped to it; false when it
    // fell back to the original whole-page regex (identical to pre-fix behavior). Not currently
    // surfaced in Discord/Sheet output (that's report-structure territory, out of scope for this
    // session — see primer) but logged per-run via console.error and saved here so it's visible
    // in the snapshot JSON, not just in logs.
    gridScoped: false,
    gridScopeMarker: null,
    products: [],
  };

  const catalog = await fetchCatalog(competitor, cfg);
  const ranks   = await scrapeBestsellerRanks(competitor, cfg);
  out.gridScoped = ranks.gridScoped;
  out.gridScopeMarker = ranks.gridScopeMarker;

  // Checked before the blocked case: a password-gated store produces block-SHAPED symptoms
  // (products.json 401, no rank data) but is not a block on us at all, and reporting it as one
  // reads to the external team as a Scout defect rather than as news about a competitor.
  if (ranks.passwordGated) {
    out.tier = 'Tier 3 (Closed — password-protected)';
    out.closed = true;
    out.error = ranks.error || 'store is password-protected (closed to visitors)';
    // Report whatever the catalog fetch managed before the gate was seen. Normally 0 (a closed
    // store 401s products.json too), but a merchant who flips the gate on mid-run leaves a real
    // catalog behind, and logging `catalog 0` for it would be a second wrong statement on top of
    // the one this branch exists to fix. Not saved either way — see isIncomplete().
    out.catalogCount = catalog.products.length;
    return out;
  }

  if (catalog.blocked && ranks.blocked) {
    out.tier = 'Tier 3 (Blocked)';
    out.blocked = true;
    out.error = `catalog: ${catalog.error || 'blocked'} | html: ${ranks.error || 'blocked'}`;
    return out;
  }

  // rank map: handle → rank (1-based) from HTML order
  const rankMap = new Map();
  ranks.handles.forEach((h, i) => { if (!rankMap.has(h)) rankMap.set(h, i + 1); });

  // Merge: catalog products are the membership authority; HTML supplies rank.
  const metaByHandle = new Map(catalog.products.map(p => [p.handle, p]));

  // Any handle that is ranked in HTML but missing from JSON catalog still gets a row
  // (real product the .json view filtered out), with a prettified fallback title.
  for (const h of rankMap.keys()) {
    if (!metaByHandle.has(h)) {
      metaByHandle.set(h, {
        handle: h,
        title: h.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        productType: '',
        id: null,
        url: `${competitor.baseUrl.replace(/\/+$/, '')}/products/${h}`,
        // Rank-only synthesized entry — HTML grid scraping has no price data at all
        // (extractGridHandles() is a bare href regex), so this is permanently null for
        // Tier-2-only competitors, not just missing-for-now.
        price: null,
      });
    }
  }

  out.products = [...metaByHandle.values()].map(p => ({
    handle: p.handle,
    title: p.title,
    productType: p.productType,
    url: p.url,
    rank: rankMap.has(p.handle) ? rankMap.get(p.handle) : null,
    price: p.price ?? null,
  }));

  out.catalogCount = catalog.products.length;
  out.rankedCount  = rankMap.size;
  out.coverage     = out.catalogCount > 0 ? out.rankedCount / out.catalogCount : (out.rankedCount > 0 ? 1 : 0);
  // The `!ranks.ok` arm used to hardcode 'Tier 2-partial (catalog only, no rank)' even when
  // there was no catalog either — BreuerMode's 2026-08-17 run reported exactly that alongside
  // `catalog 0`, a self-contradicting label. Cosmetic only (no data impact), fixed 2026-08-21.
  out.tier = ranks.ok ? (catalog.ok ? 'Tier 1+2 (JSON catalog + HTML rank)' : 'Tier 2 (HTML rank only)')
                      : (catalog.ok ? 'Tier 2-partial (catalog only, no rank)' : 'Tier 0 (no catalog, no rank)');

  // A mid-crawl wall on the rank scrape, and/or a blocked catalog fetch, both mean this
  // snapshot is real but INCOMPLETE — distinct from the "no usable data at all" Tier 3 case
  // above (which already returned). Flag it visibly rather than let it pass as a clean,
  // complete week — the same silent-truncation failure mode this fix addresses, one level up.
  const partialNotes = [];
  if (ranks.partial) partialNotes.push(`rank scrape: ${ranks.error} — ${ranks.handles.length} ranked before stopping`);
  if (catalog.blocked) partialNotes.push(`catalog fetch: ${catalog.error || 'blocked'}`);
  if (catalog.truncated) {
    // CHECKED FIRST, AND DELIBERATELY SO. Before 2026-08-21 the ceiling 400 was filed as
    // `blocked` by fetchCatalog, which forced this store down the `partial` arm and discarded
    // the snapshot — the right OUTCOME for the wrong stated REASON. Now that `blocked` is
    // correctly false, the naive consequence would be to fall through to `capped` below, whose
    // Discord line asserts "the full catalog IS captured" (index.js). That statement is FALSE
    // for a catalogue Shopify truncated, and the saved snapshot would become a membership list
    // missing an unknown number of products — which mislabels them as "Removed From Store" /
    // "New This Week" forever after. That is exactly what the never-save rule exists to prevent
    // (primer Execution Log, 2026-07-17), and it is precisely why `capped` IS savable: the
    // 2026-07-21 entry is explicit that capped is safe to save BECAUSE the catalog fetch is
    // complete — the one precondition a truncated catalogue can never meet. Here it is not, and never
    // can be. So: own state, never saved, and it says so in words.
    out.catalogTruncated = true;
    out.catalogTruncatedAt = catalog.truncatedAt;
    out.tier += ` — CATALOG TRUNCATED (Shopify's ${catalog.truncatedAt ?? 25000}-product pagination ceiling)`;
    out.error = [catalog.error, ...partialNotes].filter(Boolean).join(' | ');
  } else if (partialNotes.length) {
    out.partial = true;
    out.tier += ' — PARTIAL (incomplete crawl)';
    out.error = partialNotes.join(' | ');
  } else if (ranks.capped) {
    // Ran the full page budget and the last page was still productive — real, stable top-N rank
    // data, but not full coverage. Unlike `partial`, the catalog fetch here is complete and the
    // cut-off is deterministic, so this IS saved as the baseline (see index.js) — just flagged so
    // the report says "capped at page N", never mislabeled as a clean week or blamed on the store.
    out.capped = true;
    out.cappedAt = ranks.cap;
    out.tier += ` — CAPPED (rank scrape stopped at the ${ranks.cap}-page cap)`;
    out.error = ranks.error;
  } else if (!ranks.ok && catalog.ok) {
    out.error = `rank scrape failed: ${ranks.error || 'no ranks'}`;
  }

  // Sort-integrity check — runs whenever we have real ranked data (independent of `capped`;
  // even a capped top-N can be misordered). NOT run over `partial`/`blocked` snapshots — too
  // little data to trust a correlation, and those already don't get saved for other reasons.
  // Deliberately behaves like `partial`, not `capped`, when it fires: flags loudly and — via
  // the `incomplete` gate in index.js — is NOT saved as this week's baseline. Chris's explicit
  // call 2026-08-05: silently overwriting a known-good baseline with alphabetical noise is the
  // worst outcome available, worse than losing a week's rank-mover data, which capped's
  // save-anyway behavior is fine with because capped data is genuinely still rank-ordered, just
  // truncated. Two independent triggers, OR'd together (either alone is sufficient):
  //   (i)  urlIntegrityFail — a redirect hop dropped `sort_by` (exact, no heuristics)
  //   (ii) detectAlphabeticalSort — the recorded order itself correlates with alphabetical
  //        (mechanism-agnostic backstop; this is the one that actually caught HausOfMode, since
  //        that incident turned out to be a silently-ignored sort_by, not a redirect)
  if (!out.blocked && !out.partial && !out.catalogTruncated) {
    const sortCheck = detectAlphabeticalSort(out.products, competitor.baseUrl);
    const reasons = [];
    if (ranks.urlIntegrityFail) reasons.push(ranks.urlIntegrityDetail);
    if (sortCheck.suspect) {
      const fw = sortCheck.windows[sortCheck.firedWindow];
      const rhoStr = fw.rho == null ? 'n/a' : fw.rho.toFixed(2);
      const adjStr = fw.adjPairFrac == null ? 'n/a' : `${(fw.adjPairFrac * 100).toFixed(0)}%`;
      const windowLabel = sortCheck.firedWindow === 'full' ? `full catalog (n=${fw.n})` : `top ${fw.window} (n=${fw.n})`;
      reasons.push(`recorded order correlates with alphabetical in the ${windowLabel} (Spearman ρ=${rhoStr}, adjacent-pair-match=${adjStr}) — looks like a sort fallback, not a real bestseller order`);
    }
    if (reasons.length) {
      out.sortSuspect = true;
      out.sortSuspectStats = { n: sortCheck.n, rho: sortCheck.rho, adjPairFrac: sortCheck.adjPairFrac, urlIntegrityFail: !!ranks.urlIntegrityFail, firedWindow: sortCheck.firedWindow, windows: sortCheck.windows };
      out.tier += ' — SORT-SUSPECT (recorded order looks alphabetical, not ranked)';
      out.error = reasons.join(' | ');
    }
  }

  return out;
}

// ─── baseline-persistence gate (SINGLE SOURCE OF TRUTH) ───────────────────────
// Never persist an incomplete snapshot as this week's trusted baseline. Comparison must always
// baseline against the last COMPLETE, TRUSTED week, because every one of these states would
// corrupt next week's diff in a way nothing about a saved snapshot's shape would reveal:
//   blocked         — empty catalog; next week's whole catalog reads "New This Week".
//   partial         — a mid-crawl wall; every not-yet-reached product reads "Removed From
//                     Store" the moment a future run reaches further.
//   catalogTruncated— Shopify's pagination ceiling cut the membership list off at 25,000 (see
//                     buildSnapshot). Same mislabeling as `partial`, permanently, and it is
//                     specifically NOT `capped`: capped is savable only because a capped run's
//                     CATALOG is complete and only its RANK depth is cut (primer, 2026-07-21).
//   closed          — merchant has the storefront password-gated; there is nothing to save.
//   sortSuspect     — coverage-complete but believed MISORDERED (alphabetical, not sales-
//                     ranked); saving it replaces a known-good rank baseline with noise that
//                     looks exactly like real data. Chris's explicit call 2026-08-05.
// Extracted to lib.js 2026-08-21: index.js and competitors.js --add each carried their OWN copy
// of this expression and they had already drifted — competitors.js checked only
// `blocked || partial`, so a --add whose baseline came back sort-suspect saved it anyway. One
// predicate, both call sites, no drift.
export function isIncomplete(snapshot) {
  return !!(snapshot.blocked || snapshot.partial || snapshot.catalogTruncated
            || snapshot.closed || snapshot.sortSuspect);
}

// Short label for the incomplete state, for logs / Sheet markers / report routing.
export function incompleteLabel(snapshot) {
  if (snapshot.blocked) return 'BLOCKED';
  if (snapshot.closed) return 'CLOSED';
  if (snapshot.catalogTruncated) return 'CATALOG-TRUNCATED';
  if (snapshot.sortSuspect) return 'SORT-SUSPECT';
  if (snapshot.partial) return 'PARTIAL';
  return null;
}

// ─── snapshot persistence ──────────────────────────────────────────────────────

export function snapshotPath(competitor, date) {
  return path.join(DATA_DIR, `${slug(competitor.name)}-${date}.json`);
}

export async function saveSnapshot(snapshot, competitor) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(snapshotPath(competitor, snapshot.date), JSON.stringify(snapshot));
}

// Loads all snapshots for a competitor, most-recent-first.
export async function loadSnapshots(competitorName) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const pre = slug(competitorName) + '-';
  const files = (await fs.readdir(DATA_DIR))
    .filter(f => f.startsWith(pre) && f.endsWith('.json'))
    .sort()
    .reverse();
  const snaps = [];
  for (const f of files) {
    try { snaps.push(JSON.parse(await fs.readFile(path.join(DATA_DIR, f), 'utf8'))); }
    catch { /* skip corrupt */ }
  }
  return snaps;
}

// Keep the newest `weeksToKeep` snapshots for a competitor; delete older.
export async function pruneSnapshots(competitorName, weeksToKeep) {
  const pre = slug(competitorName) + '-';
  const files = (await fs.readdir(DATA_DIR))
    .filter(f => f.startsWith(pre) && f.endsWith('.json'))
    .sort()
    .reverse();
  const stale = files.slice(weeksToKeep);
  for (const f of stale) { try { await fs.unlink(path.join(DATA_DIR, f)); } catch {} }
  return stale;
}

// ─── metric computation (the shared WoW + multi-week brain) ────────────────────

// snaps: most-recent-first array of snapshots for ONE competitor (use up to 4).
// Returns { rows:[...], summary:{...} }. Pure function — no IO.
export function computeMetrics(snaps, cfg = {}) {
  const spikeTh = cfg.spikeThreshold ?? 50;
  const flatTh  = cfg.flatThreshold ?? 10;

  const win = snaps.slice(0, cfg.weeksToKeep ?? 4); // [s0=this, s1=last, s2, s3]
  const s0 = win[0];
  const hasPrior = win.length > 1;

  // Currency is a manually-set per-competitor config value (config.json), not derived from any
  // fetch — look it up once here by the snapshot's competitor name. null until Chris fills it in
  // (see config.json's `currency` field); every row below carries the same value.
  const currency = (cfg.competitors && s0) ? (findCompetitor(cfg, s0.competitor)?.currency ?? null) : null;

  // rank lookups per snapshot
  const rankMaps = win.map(s => {
    const m = new Map();
    for (const p of s.products) m.set(p.handle, p.rank);
    return m;
  });
  const catalogSets = win.map(s => new Set(s.products.map(p => p.handle)));
  const metaByHandle = new Map();
  // newest metadata wins
  for (let i = win.length - 1; i >= 0; i--) {
    for (const p of win[i].products) metaByHandle.set(p.handle, p);
  }

  const r0 = rankMaps[0];
  const r1 = hasPrior ? rankMaps[1] : new Map();
  const r2 = win[2] ? rankMaps[2] : new Map();
  const r3 = win[3] ? rankMaps[3] : new Map();
  const cat0 = catalogSets[0];
  const cat1 = hasPrior ? catalogSets[1] : new Set();

  // handles to emit: this-week catalog ∪ just-removed (in last week, not this week)
  const handles = new Set(cat0);
  if (hasPrior) for (const h of cat1) if (!cat0.has(h)) handles.add(h);

  const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;

  const rows = [];
  for (const h of handles) {
    const meta = metaByHandle.get(h) || { handle: h, title: h, productType: '', url: '' };
    const thisRank = num(r0.get(h));
    const lastRank = hasPrior ? num(r1.get(h)) : null;
    const wk2 = num(r2.get(h));
    const wk3 = num(r3.get(h));

    const removed = hasPrior && cat1.has(h) && !cat0.has(h);
    let status;
    if (removed) status = 'Removed From Store';
    else if (hasPrior && !cat1.has(h)) status = 'New This Week';
    else status = 'Active';

    const wow = (thisRank != null && lastRank != null) ? thisRank - lastRank : null;

    // sequence of ranks newest→oldest for streak/avg/oldest
    const seq = [thisRank, lastRank, wk2, wk3].filter((_, i) => i < win.length);

    // Month Change: vs oldest available snapshot that has this handle ranked
    let oldestRank = null;
    for (let i = win.length - 1; i >= 1; i--) {
      const rv = num(rankMaps[i].get(h));
      if (rv != null) { oldestRank = rv; break; }
    }
    const monthChange = (thisRank != null && oldestRank != null && win.length > 1) ? thisRank - oldestRank : null;

    // Streak: consecutive weeks (newest→older) of improvement (rank decreased).
    let streak = 0;
    for (let i = 1; i < seq.length; i++) {
      const cur = seq[i - 1], prev = seq[i];
      if (cur != null && prev != null && cur < prev) streak++;
      else break;
    }

    // Avg rank over available ranked weeks
    const ranked = seq.filter(v => v != null);
    const avgRank = ranked.length ? (ranked.reduce((a, b) => a + b, 0) / ranked.length) : null;

    const hotStreak = streak >= 3;

    // Spike: big jump this week (wow <= -spikeTh) but prior weeks were flat.
    let spike = false;
    if (wow != null && wow <= -spikeTh && wk2 != null && lastRank != null) {
      const priorMove = Math.abs(lastRank - wk2);
      spike = priorMove <= flatTh;
    }

    // Consistent Top 10: ranked ≤10 in every available snapshot the product appears in
    // (must appear & be top10 in all windows we have).
    let consistentTop10 = thisRank != null && thisRank <= 10;
    if (consistentTop10) {
      for (let i = 1; i < win.length; i++) {
        const rv = num(rankMaps[i].get(h));
        if (rv == null || rv > 10) { consistentTop10 = false; break; }
      }
    }

    rows.push({
      handle: h,
      title: meta.title,
      url: meta.url,
      productType: meta.productType,
      lastRank, thisRank, wow,
      status,
      wk2Rank: wk2, wk3Rank: wk3,
      monthChange, streak,
      avgRank: avgRank != null ? Math.round(avgRank * 10) / 10 : null,
      hotStreak, spike, consistentTop10,
      price: num(meta.price),
      currency,
    });
  }

  // Primary sort: WoW ascending (fastest risers first); nulls (new/removed/unranked) to bottom,
  // there ordered by thisRank asc then lastRank asc.
  rows.sort((a, b) => {
    const aw = a.wow, bw = b.wow;
    if (aw != null && bw != null) return aw - bw;
    if (aw != null) return -1;
    if (bw != null) return 1;
    const at = a.thisRank ?? Infinity, bt = b.thisRank ?? Infinity;
    if (at !== bt) return at - bt;
    return (a.lastRank ?? Infinity) - (b.lastRank ?? Infinity);
  });

  const active = rows.filter(r => r.status !== 'Removed From Store');
  const summary = {
    competitor: s0?.competitor ?? null,
    date: s0?.date ?? null,
    hasPrior,
    catalogCount: s0?.catalogCount ?? 0,
    rankedCount: s0?.rankedCount ?? 0,
    coverage: s0?.coverage ?? 0,
    tier: s0?.tier ?? null,
    blocked: !!s0?.blocked,
    newCount: rows.filter(r => r.status === 'New This Week').length,
    removedCount: rows.filter(r => r.status === 'Removed From Store').length,
    hotStreakCount: rows.filter(r => r.hotStreak).length,
    consistentTop10Count: rows.filter(r => r.consistentTop10).length,
    spikeCount: rows.filter(r => r.spike).length,
    moversUp: active.filter(r => r.wow != null && r.wow < 0),                       // already asc
    moversDown: active.filter(r => r.wow != null && r.wow > 0).sort((a, b) => b.wow - a.wow),
  };
  return { rows, summary };
}

// ─── Google Sheets writer ───────────────────────────────────────────────────
// Shared by index.js (weekly run) and competitors.js (--add baseline), so a
// newly-added competitor's Sheet tab is written at add-time, not left to lag
// until the next successful weekly run — see PHASE1-FINDINGS equivalent note
// in SKILL.md ("Sheet sync on add").

export const SHEET_HEADER = [
  'Product Name', 'Product Handle', 'Product URL', 'Product Type',
  'Last Week Rank', 'This Week Rank', 'WoW Change', 'Status', 'Last Updated',
  'Wk -3 Rank', 'Wk -2 Rank', 'Month Change', 'Streak', 'Avg Rank (4w)',
  'Hot Streak', 'Spike', 'Consistent Top 10',
  // Appended 2026-07-29, deliberately at the END, not inserted mid-row: wowSortKey() and
  // writeCompetitorTab()'s sort index into row arrays by hardcoded position (a[6], a[5]) —
  // appending leaves every existing index untouched. Currency is a manually-set config value
  // (config.json), not derived/converted — shown as-is, blank until Chris fills it in.
  'Price', 'Currency',
];
const SHEET_NCOL = SHEET_HEADER.length;

// 1-based column index -> A1 letter(s) (1->A, 26->Z, 27->AA, ...).
function colLetter(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
// Last column letter of the current schema, DERIVED from SHEET_NCOL — see writeCompetitorTab()
// for why this must never be a hardcoded literal again.
const SHEET_LAST_COL = colLetter(SHEET_NCOL);

export async function getSheetsClient() {
  const sa = JSON.parse(await fs.readFile(GOOGLE_SA_PATH, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: sa,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function getOrCreateSheetTabId(sheets, sheetId, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const existing = meta.data.sheets.find(s => s.properties.title === tabName);
  if (existing) return existing.properties.sheetId;
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName, gridProperties: { frozenRowCount: 1 } } } }] },
  });
  const created = res.data.replies[0].addSheet.properties;
  console.log(`  Created tab "${tabName}" (sheetId ${created.sheetId})`);
  return created.sheetId;
}

const rankCell = v => (typeof v === 'number' && Number.isFinite(v)) ? v : '';
const boolCell = v => (v === null || v === undefined ? '' : (v ? 'TRUE' : 'FALSE'));

function rowFromMetric(r, today) {
  return [
    r.title, r.handle, r.url, r.productType,
    rankCell(r.lastRank), rankCell(r.thisRank), rankCell(r.wow), r.status, today,
    rankCell(r.wk3Rank), rankCell(r.wk2Rank), rankCell(r.monthChange), rankCell(r.streak),
    rankCell(r.avgRank), boolCell(r.hotStreak), boolCell(r.spike), boolCell(r.consistentTop10),
    rankCell(r.price), r.currency || '',
  ];
}

function padRow(row, n) {
  const out = row.slice(0, n);
  while (out.length < n) out.push('');
  return out;
}

function wowSortKey(cellVal) {
  const n = Number(String(cellVal ?? '').replace(/[^\d.\-]/g, ''));
  return (String(cellVal ?? '').trim() === '' || Number.isNaN(n)) ? Infinity : n;
}

// Upsert by Product Handle, preserve historical rows (incl. older Removed), sort by WoW asc, frozen header.
export async function writeCompetitorTab(sheets, sheetId, tabName, rows, today) {
  const tabSheetId = await getOrCreateSheetTabId(sheets, sheetId, tabName);

  // existing rows (preserve history — never delete)
  //
  // Read range's end column is DERIVED from SHEET_NCOL (via SHEET_LAST_COL), not a hardcoded
  // literal. Found 2026-07-29 while adding the Price/Currency columns: this used to be a bare
  // 'A2:Q' (17 cols), decoupled from SHEET_HEADER.length. Any row NOT touched by the current
  // week's computeMetrics() output (e.g. a product removed 2+ weeks ago, preserved only via the
  // padRow() path below) would be read back one-or-more columns short the moment SHEET_HEADER
  // grew past column Q; padRow() would pad the missing trailing cell(s) with '', and the next
  // full-tab clear-and-rewrite would write that blank over whatever real value the sheet already
  // had — silently ERASING it, not just leaving it blank for a row that never had it. Deriving
  // the range from SHEET_NCOL makes this class of bug structurally impossible on the next column
  // addition, instead of relying on remembering to bump a literal every time.
  let existing = [];
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `'${tabName}'!A2:${SHEET_LAST_COL}` });
    existing = res.data.values ?? [];
  } catch { existing = []; }

  const byHandle = new Map();
  for (const raw of existing) {
    const h = (raw[1] ?? '').toString().trim();
    if (h) byHandle.set(h, padRow(raw, SHEET_NCOL));
  }
  // current computation overrides
  for (const r of rows) byHandle.set(r.handle, rowFromMetric(r, today));

  const finalRows = [...byHandle.values()].sort((a, b) => {
    const aw = wowSortKey(a[6]), bw = wowSortKey(b[6]);
    if (aw !== bw) return aw - bw;
    const at = wowSortKey(a[5]), bt = wowSortKey(b[5]); // This Week Rank
    return at - bt;
  });

  // clear then write (deterministic full rewrite incl. preserved history)
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [
      { updateCells: { range: { sheetId: tabSheetId }, fields: 'userEnteredValue' } },
      { updateSheetProperties: { properties: { sheetId: tabSheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      { repeatCell: { range: { sheetId: tabSheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
    ] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `'${tabName}'!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [SHEET_HEADER, ...finalRows] },
  });
  console.log(`  Sheet "${tabName}": ${finalRows.length} rows written (${rows.length} from this run, ${finalRows.length - rows.length} preserved).`);
}
