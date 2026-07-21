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

// Sequential, paced fetch. Sleeps a randomized 1–2s BEFORE every request so callers
// looping over pages stay polite automatically. Retries transient errors (429/5xx/network).
export async function politeFetch(url, cfg, { accept = 'text/html' } = {}) {
  const { timeoutMs, maxRetries, userAgent } = cfg.fetch;
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await sleep(jitter(cfg) + (attempt > 0 ? attempt * 1500 : 0)); // base pacing + backoff on retry
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: ctrl.signal,
        headers: {
          'User-Agent': userAgent,
          'Accept': accept,
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      clearTimeout(t);
      if (res.status === 429 || res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        continue; // retry
      }
      const text = await res.text();
      return { status: res.status, ok: res.ok, ctype: res.headers.get('content-type') || '', text };
    } catch (e) {
      clearTimeout(t);
      lastErr = e.name === 'AbortError' ? 'timeout' : e.message;
    }
  }
  return { status: null, ok: false, ctype: '', text: '', error: lastErr };
}

// ─── JSON catalog (full product list + metadata; NOT a sales rank) ─────────────

// Returns { ok, blocked, products:[{handle,title,productType,id,url}], error }
export async function fetchCatalog(competitor, cfg) {
  const base = competitor.baseUrl.replace(/\/+$/, '');
  const col  = competitor.collection || 'all';
  const byHandle = new Map();
  let page = 1, blocked = false, error = null;

  while (page <= cfg.fetch.maxPagesSafety) {
    const url = `${base}/collections/${col}/products.json?limit=250&page=${page}`;
    const r = await politeFetch(url, cfg, { accept: 'application/json' });
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
  return { ok: byHandle.size > 0 && !blocked, blocked, products: [...byHandle.values()], error };
}

// ─── HTML best-selling rank scrape (the ONLY real rank source) ─────────────────

const HREF_PRODUCT_RE = /href="[^"]*?\/products\/([a-z0-9][a-z0-9\-_%]*)(?:[?#][^"]*)?"/gi;

export function extractGridHandles(html) {
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

  while (page <= cap) {
    const url = `${base}/collections/${col}?sort_by=best-selling&page=${page}`;
    const r = await politeFetch(url, cfg, { accept: 'text/html' });
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
    const pageHandles = extractGridHandles(r.text);
    let added = 0;
    for (const h of pageHandles) {
      if (seen.has(h) || isJunk(h)) continue;
      seen.add(h); ranked.push(h); added++;
    }
    // End-of-catalog detection: a page with no NEW grid products (Shopify repeats last page
    // or serves an empty grid past the end).
    if (added === 0) {
      emptyOrDupPages++;
      if (emptyOrDupPages >= 1) break;
    } else {
      emptyOrDupPages = 0;
    }
    page++;
    if (page % 25 === 0) console.error(`    [${competitor.name}] rank scrape page ${page}, ${ranked.length} ranked so far...`);
  }
  // Exited via the `while (page <= cap)` condition rather than any break above — the only way
  // `page` exceeds `cap` is a productive final page (an empty/duplicate page breaks first, with
  // `page` unincremented). So this is unambiguously "cut off by the page budget while still
  // finding products," not a clean end.
  if (!blocked && !partial && page > cap) {
    capped = true;
    error = `rank scrape hit the ${cap}-page cap while still finding new products — coverage incomplete (raise this store's maxRankPages)`;
  }
  return { ok: ranked.length > 0 && !blocked, blocked, partial, capped, cap, handles: ranked, pages: page - 1, error };
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
  if (hr.ok && hr.text) { const h = extractGridHandles(hr.text); htmlCount = h.length; htmlOk = h.length > 0; }
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
//   products: [ { handle, title, productType, url, rank } ] }   // rank: 1..N or null (unranked)
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
    error: null,
    catalogCount: 0,
    rankedCount: 0,
    coverage: 0,
    products: [],
  };

  const catalog = await fetchCatalog(competitor, cfg);
  const ranks   = await scrapeBestsellerRanks(competitor, cfg);

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
      });
    }
  }

  out.products = [...metaByHandle.values()].map(p => ({
    handle: p.handle,
    title: p.title,
    productType: p.productType,
    url: p.url,
    rank: rankMap.has(p.handle) ? rankMap.get(p.handle) : null,
  }));

  out.catalogCount = catalog.products.length;
  out.rankedCount  = rankMap.size;
  out.coverage     = out.catalogCount > 0 ? out.rankedCount / out.catalogCount : (out.rankedCount > 0 ? 1 : 0);
  out.tier = ranks.ok ? (catalog.ok ? 'Tier 1+2 (JSON catalog + HTML rank)' : 'Tier 2 (HTML rank only)')
                      : 'Tier 2-partial (catalog only, no rank)';

  // A mid-crawl wall on the rank scrape, and/or a blocked catalog fetch, both mean this
  // snapshot is real but INCOMPLETE — distinct from the "no usable data at all" Tier 3 case
  // above (which already returned). Flag it visibly rather than let it pass as a clean,
  // complete week — the same silent-truncation failure mode this fix addresses, one level up.
  const partialNotes = [];
  if (ranks.partial) partialNotes.push(`rank scrape: ${ranks.error} — ${ranks.handles.length} ranked before stopping`);
  if (catalog.blocked) partialNotes.push(`catalog fetch: ${catalog.error || 'blocked'}`);
  if (partialNotes.length) {
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

  return out;
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
];
const SHEET_NCOL = SHEET_HEADER.length;

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
  let existing = [];
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `'${tabName}'!A2:Q` });
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
