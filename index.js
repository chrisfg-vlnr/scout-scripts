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
  computeMetrics, ROOT, getSheetsClient, writeCompetitorTab,
} from './lib.js';

// ─── args ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { noSheet: false, noDiscord: false, noSave: false, noPrune: false, only: null, date: null, maxRankPages: null };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--no-sheet') a.noSheet = true;
    else if (v === '--no-discord') a.noDiscord = true;
    else if (v === '--no-save') a.noSave = true;
    else if (v === '--no-prune') a.noPrune = true;
    else if (v === '--only') a.only = argv[++i];
    else if (v === '--date') a.date = argv[++i];
    else if (v === '--max-rank-pages') a.maxRankPages = parseInt(argv[++i], 10);
  }
  return a;
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
  if (summary.partial) {
    return `⚠️ **${name}** — PARTIAL this week (${summary.tier}). ${summary.rankedCount ?? 0} ranked / `
      + `${summary.catalogCount ?? 0} catalog before an early stop${summary.error ? ` — ${summary.error}` : ''}. `
      + `Not saved as this week's baseline. Manual check recommended.`;
  }
  const L = [];
  L.push(`📊 **${name} — WEEKLY RANK CHANGES**`);
  L.push(`Week of ${prettyDate} | ${summary.rankedCount} ranked / ${summary.catalogCount} catalog`);
  if (summary.coverage > 0 && summary.coverage < 0.6) {
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
  const down = summary.moversDown.slice(0, 12);
  if (down.length === 0) L.push('  (none)');
  for (const r of down) L.push(`  ${mdEscape(r.title).slice(0, 48)}  ${fmtRank(r.lastRank)} → ${fmtRank(r.thisRank)}  (${sgn(r.wow)})`);
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
  const cfg = await loadConfig();
  const reportTz = cfg.reportTz || 'Asia/Manila';
  const date = args.date || localDate(reportTz);
  const prettyDate = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  console.log(`Scout Competitor Tracker — run date ${date} (${reportTz})`);

  let competitors = cfg.competitors.filter(c => c.enabled);
  if (args.only) competitors = cfg.competitors.filter(c => slug(c.name) === slug(args.only) || c.name.toLowerCase() === args.only.toLowerCase());
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

      // Never persist a blocked OR partial snapshot as this week's baseline. A blocked (empty)
      // catalog would mislabel next week's whole catalog as "New This Week"; a partial one (a
      // mid-crawl wall stopped the rank scrape or catalog fetch early) would just as wrongly
      // mislabel every not-yet-reached product as "Removed From Store" the moment a future run
      // reaches further. Comparison should always baseline against the last COMPLETE week.
      const incomplete = snapshot.blocked || snapshot.partial;
      if (!args.noSave && !incomplete) { await saveSnapshot(snapshot, comp); }
      if (!args.noSave && !args.noPrune) {
        const pruned = await pruneSnapshots(comp.name, cfg.weeksToKeep);
        if (pruned.length) console.log(`  Pruned ${pruned.length} old snapshot(s).`);
      }

      if (incomplete) {
        summary = {
          competitor: comp.name, blocked: snapshot.blocked, partial: snapshot.partial,
          tier: snapshot.tier, error: snapshot.error,
          catalogCount: snapshot.catalogCount, rankedCount: snapshot.rankedCount,
        };
        // Mark it visibly in the Sheet too. Preserves any existing product rows from prior
        // good weeks; upserts one marker row keyed on a stable handle.
        const label = snapshot.blocked ? 'BLOCKED' : 'PARTIAL';
        console.log(`  ${label} — flagged in report${sheets ? ' + Sheet marker' : ''} (snapshot not saved).`);
        if (sheets) {
          const marker = snapshot.blocked ? {
            handle: '__blocked__',
            title: '⚠️ BLOCKED — no data this week (manual check recommended)',
            url: comp.baseUrl, productType: '',
            lastRank: null, thisRank: null, wow: null,
            status: 'Blocked',
            wk2Rank: null, wk3Rank: null, monthChange: null, streak: null, avgRank: null,
            hotStreak: null, spike: null, consistentTop10: null,
          } : {
            handle: '__partial__',
            title: `⚠️ PARTIAL — incomplete crawl this week (${snapshot.rankedCount} ranked / ${snapshot.catalogCount} catalog before an early stop; manual check recommended)`,
            url: comp.baseUrl, productType: '',
            lastRank: null, thisRank: null, wow: null,
            status: 'Partial',
            wk2Rank: null, wk3Rank: null, monthChange: null, streak: null, avgRank: null,
            hotStreak: null, spike: null, consistentTop10: null,
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
        summary.tier = snapshot.tier;
        if (sheets) await writeCompetitorTab(sheets, cfg.sheetId, comp.name, rows, date);
        console.log(`  new ${summary.newCount} | removed ${summary.removedCount} | hotStreak ${summary.hotStreakCount} | top10 ${summary.consistentTop10Count} | up ${summary.moversUp.length} | down ${summary.moversDown.length}`);
      }
    } catch (e) {
      console.error(`  ERROR ${comp.name}: ${e.message}`);
      summary = { competitor: comp.name, blocked: true, tier: `error: ${e.message}` };
    }
    reports.push(buildCompetitorReport(summary, prettyDate));
  }

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${cfg.sheetId}/edit`;
  const header = `🗓️ **Scout Competitor Scaling Tracker** — ${prettyDate}\n`
    + `${competitors.length} competitor(s) tracked\n`
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
