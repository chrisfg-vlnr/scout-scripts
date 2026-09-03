// scout-competitor-tracker/index.js
// Weekly --command cron job (zero AI token cost). For each enabled competitor:
//   fetch full catalog (JSON) + full-catalog bestseller rank (HTML) → snapshot →
//   compare vs prior weeks → write per-competitor Google Sheet tab → Discord report.
// Competitors are STRICTLY isolated: separate snapshot files, separate tabs, separate
// report sections. Removed products are kept (marked), never deleted.
//
// Flags (testing): --only <Name>  --date YYYY-MM-DD  --max-rank-pages N
//                  --no-sheet  --no-discord  --no-save  --no-prune

import fs from 'node:fs/promises';
import {
  loadConfig, slug, buildSnapshot, saveSnapshot, loadSnapshots, pruneSnapshots,
  computeMetrics, ROOT, getSheetsClient, writeCompetitorTab, isIncomplete, incompleteLabel,
  describeDecliners,
} from './lib.js';

// ─── args ──────────────────────────────────────────────────────────────────────

const USAGE = `Usage: node index.js [flags]
  --only <Name>         run a single competitor (exact name or slug)
  --group <A|B|...>     run only competitors whose config "batch" matches (staggered weekly batches)
  --include-ungrouped   with --group: also run enabled competitors that have no batch assigned
                        (the catch-all batch uses this so a new competitor is never silently skipped)
  --wait-for-lock N     if another run holds the lock, wait up to N seconds for it before giving up
                        (staggered batches use this so a slightly-overrunning batch doesn't fail the next)
  --date YYYY-MM-DD     override the run date
  --max-rank-pages N    cap HTML rank pages per competitor (testing)
  --no-sheet            skip Google Sheet writes
  --no-discord          print report preview instead of posting to Discord
  --no-save             do not persist snapshots
  --no-prune            do not prune old snapshots
  --help                show this help and exit`;

function parseArgs(argv) {
  const a = { noSheet: false, noDiscord: false, noSave: false, noPrune: false, only: null, group: null, includeUngrouped: false, waitForLock: 0, date: null, maxRankPages: null };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--no-sheet') a.noSheet = true;
    else if (v === '--no-discord') a.noDiscord = true;
    else if (v === '--no-save') a.noSave = true;
    else if (v === '--no-prune') a.noPrune = true;
    else if (v === '--only') a.only = argv[++i];
    else if (v === '--group') a.group = argv[++i];
    else if (v === '--include-ungrouped') a.includeUngrouped = true;
    else if (v === '--wait-for-lock') a.waitForLock = parseInt(argv[++i], 10) || 0;
    else if (v === '--date') a.date = argv[++i];
    else if (v === '--max-rank-pages') a.maxRankPages = parseInt(argv[++i], 10);
    else if (v === '--help' || v === '-h') { console.log(USAGE); process.exit(0); }
    else {
      // Unknown flags are a hard error. Before this guard, "node index.js --help" silently
      // launched a FULL 8-competitor scrape (unknown flags were ignored) — that exact accident
      // spawned an orphaned duplicate run on 2026-07-20 that rate-limit-walled belroshop.com.
      console.error(`Unknown flag: ${v}\n\n${USAGE}`);
      process.exit(1);
    }
  }
  return a;
}

// ─── run lock ──────────────────────────────────────────────────────────────────
// Refuse to run two scrapes at once. On 2026-07-20 two overlapping full runs hit
// belroshop.com concurrently from this VPS and tripped its 429 rate-limit wall — the
// same crawl had always passed clean as a single weekly run. The lock holds
// {pid, startedAt}; a lock whose pid is no longer alive is stale and gets replaced.

const LOCK_PATH = `${ROOT}/.run.lock`;

// Read the current lock holder if one is alive; returns {pid, startedAt} or null (no lock, or a
// stale lock whose pid is dead — either way the caller may take it).
async function liveLockHolder() {
  try {
    const raw = JSON.parse(await fs.readFile(LOCK_PATH, 'utf8'));
    try { process.kill(raw.pid, 0); return raw; }
    catch (e) { return e.code === 'EPERM' ? raw : null; }
  } catch { return null; }
}

// `waitForLockSeconds` = 0 → fail fast (exit 3) if a run is already live — the right default for a
// manual/ad-hoc run. Staggered batch crons pass a positive value so a slightly-overrunning earlier
// batch makes the next one wait rather than fail (this closes the "a legitimate rerun had no safe
// path" gap from the 2026-07-20 incident).
async function acquireRunLock({ waitForLockSeconds = 0 } = {}) {
  const deadline = Date.now() + waitForLockSeconds * 1000;
  for (;;) {
    const holder = await liveLockHolder();
    if (!holder) break; // free or stale — take it
    if (Date.now() >= deadline) {
      console.error(`Another tracker run is already in progress (pid ${holder.pid}, started ${holder.startedAt}).`);
      if (waitForLockSeconds > 0) console.error(`Waited ${waitForLockSeconds}s for it to finish; giving up.`);
      console.error(`Refusing to start a second one — overlapping scrapes trip rate-limit walls.`);
      console.error(`If pid ${holder.pid} is not actually a tracker run, delete ${LOCK_PATH} and retry.`);
      process.exit(3);
    }
    const remainMs = deadline - Date.now();
    console.error(`Another run holds the lock (pid ${holder.pid}); waiting up to ${Math.ceil(remainMs / 1000)}s more...`);
    await new Promise(r => setTimeout(r, Math.min(15000, remainMs)));
  }
  await fs.writeFile(LOCK_PATH, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
}

async function releaseRunLock() { try { await fs.unlink(LOCK_PATH); } catch {} }

// Best-effort release on SIGINT/SIGTERM (SIGKILL leaves a stale lock; the pid-alive
// check above handles that on the next start).
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { releaseRunLock().finally(() => process.exit(1)); });
}

function localDate(tz) {
  return new Intl.DateTimeFormat('sv', { timeZone: tz }).format(new Date());
}

// ─── Discord ───────────────────────────────────────────────────────────────────
// Self-delivers directly via the Discord REST API (mirrors the original CFNCS tracker's
// self-delivery pattern) rather than relying on cron's own delivery system, so cron run
// status always reflects the script's real success/failure, not delivery plumbing.

let discordTokenCache = null;
async function getDiscordToken() {
  if (discordTokenCache) return discordTokenCache;
  const raw = JSON.parse(await fs.readFile(`${ROOT}/discord-token.json`, 'utf8'));
  discordTokenCache = raw.botToken;
  return discordTokenCache;
}

// Escape Discord markdown special chars in untrusted scraped text so a product title
// can't break message formatting (equivalent role to the original's HTML esc()).
const mdEscape = s => String(s ?? '').replace(/([*_~`|\\])/g, '\\$1');

async function sendDiscord(channelId, text) {
  const token = await getDiscordToken();
  // split into <=1900-char chunks on newlines (Discord's hard cap is 2000)
  const chunks = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > 1900) { chunks.push(buf); buf = ''; }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf) chunks.push(buf);
  for (const chunk of chunks) {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bot ${token}` },
      body: JSON.stringify({ content: chunk }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Discord error: ${JSON.stringify(body)}`);
    await new Promise(r => setTimeout(r, 400));
  }
}

const fmtRank = v => (typeof v === 'number' ? `#${v}` : '—');
const sgn = v => (v > 0 ? `+${v}` : `${v}`);

function buildCompetitorReport(summary, prettyDate) {
  const name = mdEscape(summary.competitor).toUpperCase();
  if (summary.blocked) {
    return `⚠️ **${name}** — BLOCKED this week (${summary.tier}). No data. Manual check recommended.`;
  }
  if (summary.closed) {
    return `🔒 **${name}** — STORE CLOSED this week (${summary.tier}). The store is behind Shopify's `
      + `password page: every visitor is redirected to /password, so there is no public catalog to read. `
      + `This is a change at the store, not a problem with the tracker — it usually means a rebrand, a `
      + `migration or a seasonal close, and it is often temporary. Nothing was saved for this week and the `
      + `store's history is untouched; tracking resumes automatically if it reopens.`;
  }
  if (summary.catalogTruncated) {
    const ceiling = summary.catalogTruncatedAt ?? 25000;
    return `⚠️ **${name}** — CATALOG TOO LARGE TO ENUMERATE this week (${summary.tier}). This store now has `
      + `**more than ${ceiling.toLocaleString('en-US')} products** — Shopify refuses to paginate its product list past `
      + `${ceiling.toLocaleString('en-US')}, so we can see ${(summary.catalogCount ?? 0).toLocaleString('en-US')} of them and there is no way to `
      + `retrieve the rest. Coverage figures would be measured against that truncated list, so none are shown. `
      + `Not saved as this week's baseline — an incomplete product list would wrongly report the products we cannot `
      + `see as "Removed From Store" next week. This is a limit of Shopify's public catalog, not a fault at the store `
      + `or in the tracker. Rank tracking for this store needs a different approach — flag it to Chris.`;
  }
  if (summary.sortSuspect) {
    const st = summary.sortSuspectStats;
    const stStr = st ? ` (ρ=${st.rho == null ? 'n/a' : st.rho.toFixed(2)}, n=${st.n}${st.urlIntegrityFail ? ', redirect dropped sort_by' : ''})` : '';
    return `⚠️ **${name}** — SORT-SUSPECT this week (${summary.tier}). Full coverage (${summary.rankedCount ?? 0} ranked / `
      + `${summary.catalogCount ?? 0} catalog) but the recorded order looks alphabetical, not sales-ranked${stStr}. `
      + `Not saved as this week's baseline. Store likely changed its default collection sort or its theme doesn't honor `
      + `sort_by — check the site directly before trusting next week's movers. Manual check recommended.`;
  }
  if (summary.coverageCollapse) {
    return `⚠️ **${name}** — COVERAGE COLLAPSE this week (${summary.tier}). We ranked only `
      + `**${(summary.rankedCount ?? 0).toLocaleString('en-US')} products** against `
      + `**${(summary.priorRankedCount ?? 0).toLocaleString('en-US')}** in the last good week `
      + `(${summary.priorSnapshotDate ?? 'n/a'}) — less than half — and the crawl did not report `
      + `hitting a page cap or a wall, so it believes it finished normally. A drop that size on a `
      + `clean-looking run is far more likely to be something changing in how we read the page than `
      + `the store deleting most of its catalog. Not saved as this week's baseline, so last week's `
      + `numbers stand and nothing is reported as "Removed From Store". Needs a manual look before `
      + `this store's ranks are trusted again — flag it to Chris.`;
  }
  if (summary.phantomSuspect) {
    return `⚠️ **${name}** — PHANTOM IN THE TOP RANKS this week (${summary.tier}). Full coverage `
      + `(${(summary.rankedCount ?? 0).toLocaleString('en-US')} ranked / ${(summary.catalogCount ?? 0).toLocaleString('en-US')} catalog), but one or more of `
      + `the leading ranks is held by something the store's own product list does not contain — `
      + `almost always a cart/upsell/app widget link picked up from the page furniture rather than `
      + `from the bestseller grid, which pushes every real product down a place. `
      + `${summary.phantomSuspectDetail ? `Detail: ${summary.phantomSuspectDetail}. ` : ''}`
      + `Not saved as this week's baseline. Manual check recommended.`;
  }
  if (summary.partial) {
    return `⚠️ **${name}** — PARTIAL this week (${summary.tier}). ${summary.rankedCount ?? 0} ranked / `
      + `${summary.catalogCount ?? 0} catalog before an early stop${summary.error ? ` — ${summary.error}` : ''}. `
      + `Not saved as this week's baseline. Manual check recommended.`;
  }
  const L = [];
  L.push(`📊 **${name} — WEEKLY RANK CHANGES**`);
  L.push(`Week of ${prettyDate} | ${summary.rankedCount} ranked / ${summary.catalogCount} catalog`);
  if (summary.capped) {
    L.push(`⚠️ Rank coverage ${(summary.coverage * 100).toFixed(0)}% — the rank scrape hit the ${summary.cappedAt}-page cap, so only the top ${summary.rankedCount} best-sellers are ranked this week (the full catalog IS captured). Movers below that cutoff aren't tracked; raise this store's page cap to cover more.`);
  } else if (summary.coverage > 0 && summary.coverage < 0.6) {
    L.push(`⚠️ Rank coverage ${(summary.coverage * 100).toFixed(0)}% — store may hide products from HTML.`);
  }
  if (!summary.hasPrior) {
    L.push('');
    L.push('🆕 First snapshot — baseline established. Week-on-week changes start next run.');
    return L.join('\n');
  }
  L.push('');
  L.push('🚀 **Biggest movers UP:**');
  const up = summary.moversUp.slice(0, 18);
  if (up.length === 0) L.push('  (none)');
  for (const r of up) L.push(`  ${mdEscape(r.title).slice(0, 48)}  ${fmtRank(r.lastRank)} → ${fmtRank(r.thisRank)}  (${sgn(r.wow)})`);
  L.push('');
  L.push('📉 **Biggest movers down:**');
  // The context line and any tie collapse come from describeDecliners() so this report
  // and query.js's --decliners cannot drift — see the helper's note in lib.js for why a
  // bare top-12 slice reads as broken data on a tied week (2026-08-24).
  const decl = describeDecliners(summary, 12);
  if (decl.context) L.push(`  _${decl.context}_`);
  if (decl.list.length === 0) L.push('  (none)');
  for (const r of decl.list) L.push(`  ${mdEscape(r.title).slice(0, 48)}  ${fmtRank(r.lastRank)} → ${fmtRank(r.thisRank)}  (${sgn(r.wow)})`);
  if (decl.note) L.push(`  _${decl.note}_`);
  L.push('');
  L.push(`🆕 New products this week: ${summary.newCount}`);
  L.push(`❌ Removed from store: ${summary.removedCount}`);
  L.push('');
  L.push('— Bonus: multi-week signals —');
  L.push(`🔥 Hot streaks (rising 3+ weeks): ${summary.hotStreakCount}`);
  L.push(`🎯 Consistent top 10: ${summary.consistentTop10Count}`);
  L.push(`⚡ Spikes this week: ${summary.spikeCount}`);
  L.push('[Full detail in the Scout Competitor Scaling Data sheet]');
  return L.join('\n');
}

// ─── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  await acquireRunLock({ waitForLockSeconds: args.waitForLock });
  try {
    await run(args);
  } finally {
    await releaseRunLock();
  }
}

async function run(args) {
  const cfg = await loadConfig();
  const reportTz = cfg.reportTz || 'Asia/Manila';
  const date = args.date || localDate(reportTz);
  const prettyDate = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  console.log(`Scout Competitor Tracker${args.group ? ` — Batch ${args.group}` : ''} — run date ${date} (${reportTz})`);

  let competitors = cfg.competitors.filter(c => c.enabled);
  if (args.only) {
    competitors = cfg.competitors.filter(c => slug(c.name) === slug(args.only) || c.name.toLowerCase() === args.only.toLowerCase());
  } else if (args.group) {
    // Staggered weekly batches: run only this batch's competitors. `--include-ungrouped` (the
    // catch-all batch) also picks up any enabled competitor with no `batch` assigned, so a newly
    // added store is never silently missed by every batch.
    competitors = competitors.filter(c => c.batch === args.group || (args.includeUngrouped && !c.batch));
    const orphaned = cfg.competitors.filter(c => c.enabled && !c.batch);
    if (orphaned.length && !args.includeUngrouped) {
      console.error(`  ⚠️ ${orphaned.length} enabled competitor(s) have NO batch and are not in group ${args.group}: ${orphaned.map(c => c.name).join(', ')}. They only run in the catch-all (--include-ungrouped) batch — assign them a batch or check that batch's cron.`);
    }
  }
  if (args.maxRankPages != null) competitors = competitors.map(c => ({ ...c, maxRankPages: args.maxRankPages }));
  console.log(`Competitors: ${competitors.map(c => c.name).join(', ') || '(none)'}`);

  const sheets = args.noSheet ? null : await getSheetsClient();
  const reports = [];

  for (const comp of competitors) {
    console.log(`\n=== ${comp.name} (${comp.baseUrl}) ===`);
    let summary;
    try {
      const snapshot = await buildSnapshot(comp, cfg, date);
      console.log(`  ${snapshot.tier} | catalog ${snapshot.catalogCount} | ranked ${snapshot.rankedCount} | coverage ${(snapshot.coverage * 100).toFixed(0)}%${snapshot.error ? ' | ' + snapshot.error : ''}`);

      // Baseline-persistence gate. The full rationale for every state it covers, and why this
      // is one shared predicate rather than a copy here, lives at isIncomplete() in lib.js.
      const incomplete = isIncomplete(snapshot);
      if (!args.noSave && !incomplete) { await saveSnapshot(snapshot, comp); }
      if (!args.noSave && !args.noPrune) {
        const pruned = await pruneSnapshots(comp.name, cfg.weeksToKeep);
        if (pruned.length) console.log(`  Pruned ${pruned.length} old snapshot(s).`);
      }

      if (incomplete) {
        summary = {
          competitor: comp.name, blocked: snapshot.blocked, partial: snapshot.partial,
          catalogTruncated: snapshot.catalogTruncated, catalogTruncatedAt: snapshot.catalogTruncatedAt,
          closed: snapshot.closed,
          sortSuspect: snapshot.sortSuspect, sortSuspectStats: snapshot.sortSuspectStats,
          phantomSuspect: snapshot.phantomSuspect, phantomSuspectDetail: snapshot.phantomSuspectDetail,
          coverageCollapse: snapshot.coverageCollapse, coverageCollapseDetail: snapshot.coverageCollapseDetail,
          priorRankedCount: snapshot.priorRankedCount, priorSnapshotDate: snapshot.priorSnapshotDate,
          tier: snapshot.tier, error: snapshot.error,
          catalogCount: snapshot.catalogCount, rankedCount: snapshot.rankedCount,
        };
        // Mark it visibly in the Sheet too. Preserves any existing product rows from prior
        // good weeks; upserts one marker row keyed on a stable handle.
        const label = incompleteLabel(snapshot);
        console.log(`  ${label} — flagged in report${sheets ? ' + Sheet marker' : ''} (snapshot not saved).`);
        if (sheets) {
          // price: always null — a marker row has no product data, real or otherwise.
          // currency: a config value, not fetch-dependent, so it's populated here whenever
          // it's known regardless of the failed run (see D2 in the 2026-07-29 primer entry).
          const marker = snapshot.blocked ? {
            handle: '__blocked__',
            title: '⚠️ BLOCKED — no data this week (manual check recommended)',
            url: comp.baseUrl, productType: '',
            lastRank: null, thisRank: null, wow: null,
            status: 'Blocked',
            wk2Rank: null, wk3Rank: null, monthChange: null, streak: null, avgRank: null,
            hotStreak: null, spike: null, consistentTop10: null,
            price: null, currency: comp.currency ?? null,
          } : snapshot.closed ? {
            handle: '__closed__',
            title: `🔒 CLOSED — the store is behind Shopify's password page this week (no public catalog to read); a change at the store, not a tracker fault. History untouched; tracking resumes if it reopens.`,
            url: comp.baseUrl, productType: '',
            lastRank: null, thisRank: null, wow: null,
            status: 'Closed',
            wk2Rank: null, wk3Rank: null, monthChange: null, streak: null, avgRank: null,
            hotStreak: null, spike: null, consistentTop10: null,
            price: null, currency: comp.currency ?? null,
          } : snapshot.catalogTruncated ? {
            handle: '__catalog_truncated__',
            title: `⚠️ CATALOG TOO LARGE — this store has more than ${(snapshot.catalogTruncatedAt ?? 25000).toLocaleString('en-US')} products and Shopify will not paginate past that, so only ${snapshot.catalogCount.toLocaleString('en-US')} could be listed and the rest cannot be retrieved; not saved as this week's baseline. Not a fault at the store or in the tracker.`,
            url: comp.baseUrl, productType: '',
            lastRank: null, thisRank: null, wow: null,
            status: 'CatalogTruncated',
            wk2Rank: null, wk3Rank: null, monthChange: null, streak: null, avgRank: null,
            hotStreak: null, spike: null, consistentTop10: null,
            price: null, currency: comp.currency ?? null,
          } : snapshot.sortSuspect ? {
            handle: '__sort_suspect__',
            title: `⚠️ SORT-SUSPECT — full coverage (${snapshot.rankedCount} ranked / ${snapshot.catalogCount} catalog) but the recorded order looks alphabetical, not sales-ranked (${snapshot.error}); not saved as this week's baseline. Manual check recommended.`,
            url: comp.baseUrl, productType: '',
            lastRank: null, thisRank: null, wow: null,
            status: 'SortSuspect',
            wk2Rank: null, wk3Rank: null, monthChange: null, streak: null, avgRank: null,
            hotStreak: null, spike: null, consistentTop10: null,
            price: null, currency: comp.currency ?? null,
          } : snapshot.coverageCollapse ? {
            handle: '__coverage_collapse__',
            title: `⚠️ COVERAGE COLLAPSE — only ${snapshot.rankedCount.toLocaleString('en-US')} products ranked this week against ${(snapshot.priorRankedCount ?? 0).toLocaleString('en-US')} in the last good week (${snapshot.priorSnapshotDate ?? 'n/a'}), on a crawl that reported no cap and no wall; more likely a change in how we read the page than the store; not saved as this week's baseline, so the rows below are last week's. Manual check needed.`,
            url: comp.baseUrl, productType: '',
            lastRank: null, thisRank: null, wow: null,
            status: 'CoverageCollapse',
            wk2Rank: null, wk3Rank: null, monthChange: null, streak: null, avgRank: null,
            hotStreak: null, spike: null, consistentTop10: null,
            price: null, currency: comp.currency ?? null,
          } : snapshot.phantomSuspect ? {
            handle: '__phantom_suspect__',
            title: `⚠️ PHANTOM IN THE TOP RANKS — ${snapshot.phantomSuspectDetail ?? 'a leading rank is held by a handle absent from the store product list'}; that is page furniture (cart/upsell widget), not a best seller, and it pushes every real product down a place; not saved as this week's baseline. Manual check recommended.`,
            url: comp.baseUrl, productType: '',
            lastRank: null, thisRank: null, wow: null,
            status: 'PhantomSuspect',
            wk2Rank: null, wk3Rank: null, monthChange: null, streak: null, avgRank: null,
            hotStreak: null, spike: null, consistentTop10: null,
            price: null, currency: comp.currency ?? null,
          } : {
            handle: '__partial__',
            title: `⚠️ PARTIAL — incomplete crawl this week (${snapshot.rankedCount} ranked / ${snapshot.catalogCount} catalog before an early stop; manual check recommended)`,
            url: comp.baseUrl, productType: '',
            lastRank: null, thisRank: null, wow: null,
            status: 'Partial',
            wk2Rank: null, wk3Rank: null, monthChange: null, streak: null, avgRank: null,
            hotStreak: null, spike: null, consistentTop10: null,
            price: null, currency: comp.currency ?? null,
          };
          await writeCompetitorTab(sheets, cfg.sheetId, comp.name, [marker], date);
        }
      } else {
        // Use the freshly-built snapshot as "this week" + prior weeks from disk (dedup same
        // date). Robust whether or not we saved, and avoids a disk round-trip.
        const prior = (await loadSnapshots(comp.name)).filter(s => s.date !== snapshot.date);
        const snaps = [snapshot, ...prior].slice(0, cfg.weeksToKeep);
        const { rows, summary: sm } = computeMetrics(snaps, cfg);
        summary = sm;
        summary.blocked = false;
        summary.partial = false;
        summary.catalogTruncated = false;
        summary.closed = false;
        // `capped` (rank scrape hit the page budget while still productive) is real, complete-
        // catalog data — saved as baseline like a normal week, but surfaced so the report says
        // "capped at page N" rather than passing as full coverage.
        summary.capped = snapshot.capped;
        summary.cappedAt = snapshot.cappedAt;
        summary.tier = snapshot.tier;
        if (sheets) await writeCompetitorTab(sheets, cfg.sheetId, comp.name, rows, date);
        console.log(`  new ${summary.newCount} | removed ${summary.removedCount} | hotStreak ${summary.hotStreakCount} | top10 ${summary.consistentTop10Count} | up ${summary.moversUp.length} | down ${summary.moversDown.length}${summary.capped ? ` | CAPPED at page ${summary.cappedAt}` : ''}`);
      }
    } catch (e) {
      console.error(`  ERROR ${comp.name}: ${e.message}`);
      summary = { competitor: comp.name, blocked: true, tier: `error: ${e.message}` };
    }
    reports.push(buildCompetitorReport(summary, prettyDate));
  }

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${cfg.sheetId}/edit`;
  const batchLabel = args.group ? ` — Batch ${args.group}` : '';
  const header = `🗓️ **Scout Competitor Scaling Tracker${batchLabel}** — ${prettyDate}\n`
    + `${competitors.length} competitor(s)${args.group ? ' in this batch' : ' tracked'}\n`
    + `📋 <${sheetUrl}>`;
  if (!args.noDiscord && reports.length) {
    await sendDiscord(cfg.discordChannelId, header);
    for (const rep of reports) await sendDiscord(cfg.discordChannelId, rep);
    console.log('\nDiscord report sent.');
  } else if (args.noDiscord) {
    console.log('\n[--no-discord] Report preview:\n' + header + '\n\n' + reports.join('\n\n'));
  }

  console.log('\nDone.');
}

main().catch(e => { console.error(e?.stack || String(e)); process.exit(1); });
