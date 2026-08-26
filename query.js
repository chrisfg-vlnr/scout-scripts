// competitor-tracker/query.js
// Zero-token ad-hoc query tool for Palantir's Telegram answers. ALL filtering/sorting/
// computation happens here in script-land; only a small pre-computed result is printed for
// the model to relay. Palantir must NEVER read raw data/*.json snapshots into its context —
// it calls this script instead. (See AGENTS.md.)
//
// Usage:
//   node query.js --list
//   node query.js --competitor Belro --summary
//   node query.js --competitor Belro --top-movers 20
//   node query.js --competitor Belro --decliners 20
//   node query.js --competitor Belro --hot-streaks
//   node query.js --competitor Belro --consistent-top10
//   node query.js --competitor Belro --new
//   node query.js --competitor Belro --removed
//   node query.js --competitor Belro --product <handle-or-text>

import fs from 'node:fs/promises';
import { loadConfig, slug, loadSnapshots, computeMetrics, describeDecliners, DATA_DIR } from './lib.js';

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--competitor') a.competitor = argv[++i];
    else if (v === '--top-movers') a.topMovers = parseInt(argv[++i], 10) || 20;
    else if (v === '--decliners') a.decliners = parseInt(argv[++i], 10) || 20;
    else if (v === '--hot-streaks') a.hotStreaks = true;
    else if (v === '--consistent-top10') a.consistentTop10 = true;
    else if (v === '--new') a.newOnly = true;
    else if (v === '--removed') a.removedOnly = true;
    else if (v === '--product') a.product = argv[++i];
    else if (v === '--summary') a.summary = true;
    else if (v === '--list') a.list = true;
  }
  return a;
}

const rk = v => (typeof v === 'number' ? `#${v}` : '—');
const sg = v => (typeof v === 'number' ? (v > 0 ? `+${v}` : `${v}`) : '—');

// Never render a bare price number — a figure with no currency beside it could be misread as
// the wrong currency across stores. currency is a manually-set config value (config.json);
// until Chris fills it in, say so explicitly rather than showing a naked figure.
const fmtPrice = (price, currency) =>
  price == null ? '—' : `${price.toFixed(2)} ${currency || '(currency unknown)'}`;

function line(r) {
  return `${rk(r.thisRank).padStart(5)}  (${sg(r.wow).padStart(5)})  ${r.title.slice(0, 50)}  [${r.handle}]  ${fmtPrice(r.price, r.currency)}`;
}

async function listCompetitors() {
  const cfg = await loadConfig();
  try { await fs.access(DATA_DIR); } catch { console.log('No data directory yet — run index.js first.'); return; }
  const files = (await fs.readdir(DATA_DIR)).filter(f => f.endsWith('.json'));
  const bySlug = new Map();
  for (const f of files) {
    const m = f.match(/^(.*)-(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;
    if (!bySlug.has(m[1])) bySlug.set(m[1], []);
    bySlug.get(m[1]).push(m[2]);
  }
  console.log('Competitors with snapshots:');
  for (const c of cfg.competitors) {
    const dates = (bySlug.get(slug(c.name)) || []).sort();
    console.log(`  ${c.name}${c.enabled ? '' : ' (disabled)'} — ${dates.length} week(s): ${dates.join(', ') || 'none'}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.list || !args.competitor) {
    if (!args.competitor && !args.list) console.log('Specify --competitor <name>, or --list. See header for usage.\n');
    return listCompetitors();
  }

  const cfg = await loadConfig();
  const comp = cfg.competitors.find(c => slug(c.name) === slug(args.competitor) || c.name.toLowerCase() === args.competitor.toLowerCase());
  const name = comp ? comp.name : args.competitor;

  const snaps = await loadSnapshots(name);
  if (snaps.length === 0) { console.log(`No snapshots for "${name}". Run index.js or check the name (try --list).`); return; }

  const { rows, summary } = computeMetrics(snaps, cfg);
  const header = `${name} — week of ${summary.date} | ${summary.rankedCount} ranked / ${summary.catalogCount} catalog | ${snaps.length} week(s) of history`;

  if (args.product) {
    const q = args.product.toLowerCase();
    const matches = rows.filter(r => r.handle.toLowerCase().includes(q) || r.title.toLowerCase().includes(q));
    if (matches.length === 0) { console.log(`${header}\nNo product matching "${args.product}".`); return; }
    console.log(header);
    for (const r of matches.slice(0, 8)) {
      console.log(`\n${r.title}  [${r.handle}]  — ${r.status}`);
      console.log(`  Price ${fmtPrice(r.price, r.currency)}`);
      console.log(`  This week ${rk(r.thisRank)} | last week ${rk(r.lastRank)} | WoW ${sg(r.wow)}`);
      console.log(`  Wk-2 ${rk(r.wk2Rank)} | Wk-3 ${rk(r.wk3Rank)} | Month change ${sg(r.monthChange)} | Avg(4w) ${r.avgRank ?? '—'}`);
      console.log(`  Streak ${r.streak} | HotStreak ${r.hotStreak} | Spike ${r.spike} | ConsistentTop10 ${r.consistentTop10}`);
      console.log(`  ${r.url}`);
    }
    return;
  }

  let title, list;
  // Decliner context/tie-collapse lines, populated only on the --decliners path.
  let declContext = null, declNote = null, declTotal = null;
  if (args.hotStreaks)          { title = 'Hot streaks (rising 3+ consecutive weeks)'; list = rows.filter(r => r.hotStreak); }
  else if (args.consistentTop10){ title = 'Consistent top 10 (all tracked weeks)';     list = rows.filter(r => r.consistentTop10); }
  else if (args.newOnly)        { title = 'New this week';                              list = rows.filter(r => r.status === 'New This Week'); }
  else if (args.removedOnly)    { title = 'Removed from store';                         list = rows.filter(r => r.status === 'Removed From Store'); }
  else if (args.decliners)      {
    // Same helper as the weekly Discord report. Without it this path answers a
    // Discord question with N identical rows and invites exactly the store-wide
    // "uniform shift" misreading that happened on 2026-08-24 — see lib.js.
    const decl = describeDecliners(summary, args.decliners);
    title = `Top ${args.decliners} decliners (falling fastest)`;
    list = decl.list; declContext = decl.context; declNote = decl.note;
    declTotal = summary.moversDown.length;
  }
  else if (args.summary)        { title = null; list = null; }
  else                          { const n = args.topMovers || 20; title = `Top ${n} movers up (fastest risers)`; list = summary.moversUp.slice(0, n); }

  console.log(header);
  if (args.summary || (title === null && list === null)) {
    console.log(`Tier: ${summary.tier}${summary.blocked ? ' (BLOCKED)' : ''}`);
    console.log(`Movers up: ${summary.moversUp.length} | down: ${summary.moversDown.length}`);
    console.log(`New: ${summary.newCount} | Removed: ${summary.removedCount}`);
    console.log(`Hot streaks: ${summary.hotStreakCount} | Consistent top 10: ${summary.consistentTop10Count} | Spikes: ${summary.spikeCount}`);
    if (!summary.hasPrior) console.log('(First snapshot — WoW comparisons start next week.)');
    return;
  }

  // On a collapsed decliner list, report the true decliner count rather than the
  // number of rows printed, so "3" can never be read as "only 3 products fell".
  console.log(`\n${title}: ${declTotal ?? list.length}`);
  if (declContext) console.log(declContext);
  for (const r of list.slice(0, Math.max(args.topMovers || 0, args.decliners || 0, 50))) console.log(line(r));
  if (declNote) console.log(declNote);
}

main().catch(e => { console.error(e?.stack || String(e)); process.exit(1); });
