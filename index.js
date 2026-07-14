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
import { google } from 'googleapis';
import {
  loadConfig, slug, buildSnapshot, saveSnapshot, loadSnapshots, pruneSnapshots,
  computeMetrics, ROOT,
} from './lib.js';

const GOOGLE_SA_PATH = '/home/chris/scripts/google-service-account.json';

const HEADER = [
  'Product Name', 'Product Handle', 'Product URL', 'Product Type',
  'Last Week Rank', 'This Week Rank', 'WoW Change', 'Status', 'Last Updated',
  'Wk -3 Rank', 'Wk -2 Rank', 'Month Change', 'Streak', 'Avg Rank (4w)',
  'Hot Streak', 'Spike', 'Consistent Top 10',
];
const NCOL = HEADER.length;

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

// ─── Google Sheets ───────────────────────────────────────────────────────────

async function getSheetsClient() {
  const sa = JSON.parse(await fs.readFile(GOOGLE_SA_PATH, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: sa,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function getOrCreateSheetId(sheets, sheetId, tabName) {
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

const rankCell  = v => (typeof v === 'number' && Number.isFinite(v)) ? v : '';
const boolCell  = v => (v === null || v === undefined ? '' : (v ? 'TRUE' : 'FALSE'));

function rowFromMetric(r, today) {
  return [
    r.title, r.handle, r.url, r.productType,
    rankCell(r.lastRank), rankCell(r.thisRank), rankCell(r.wow), r.status, today,
    rankCell(r.wk3Rank), rankCell(r.wk2Rank), rankCell(r.monthChange), rankCell(r.streak),
    rankCell(r.avgRank), boolCell(r.hotStreak), boolCell(r.spike), boolCell(r.consistentTop10),
  ];
}

function pad(row, n) {
  const out = row.slice(0, n);
  while (out.length < n) out.push('');
  return out;
}

function wowSortKey(cellVal) {
  const n = Number(String(cellVal ?? '').replace(/[^\d.\-]/g, ''));
  return (String(cellVal ?? '').trim() === '' || Number.isNaN(n)) ? Infinity : n;
}

// Upsert by Product Handle, preserve historical rows (incl. older Removed), sort by WoW asc, frozen header.
async function writeCompetitorTab(sheets, sheetId, tabName, rows, today) {
  const tabSheetId = await getOrCreateSheetId(sheets, sheetId, tabName);

  // existing rows (preserve history — never delete)
  let existing = [];
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `'${tabName}'!A2:Q` });
    existing = res.data.values ?? [];
  } catch { existing = []; }

  const byHandle = new Map();
  for (const raw of existing) {
    const h = (raw[1] ?? '').toString().trim();
    if (h) byHandle.set(h, pad(raw, NCOL));
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
    requestBody: { values: [HEADER, ...finalRows] },
  });
  console.log(`  Sheet "${tabName}": ${finalRows.length} rows written (${rows.length} from this run, ${finalRows.length - rows.length} preserved).`);
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

      // Never persist a blocked snapshot — an empty catalog would mislabel the whole
      // catalog as "New This Week" the week the store recovers. Comparison should always
      // baseline against the last SUCCESSFUL week.
      if (!args.noSave && !snapshot.blocked) { await saveSnapshot(snapshot, comp); }
      if (!args.noSave && !args.noPrune) {
        const pruned = await pruneSnapshots(comp.name, cfg.weeksToKeep);
        if (pruned.length) console.log(`  Pruned ${pruned.length} old snapshot(s).`);
      }

      // Use the freshly-built snapshot as "this week" + prior weeks from disk (dedup same date).
      // Robust whether or not we saved, and avoids a disk round-trip.
      const prior = (await loadSnapshots(comp.name)).filter(s => s.date !== snapshot.date);
      const snaps = [snapshot, ...prior].slice(0, cfg.weeksToKeep);
      const { rows, summary: sm } = computeMetrics(snaps, cfg);
      summary = sm;
      summary.blocked = snapshot.blocked;
      summary.tier = snapshot.tier;

      if (snapshot.blocked) {
        // Mark the block visibly in the Sheet too.
        // Preserves any existing product rows from prior good weeks; upserts one marker row
        // keyed on the stable handle "__blocked__".
        console.log(`  BLOCKED — flagged in report${sheets ? ' + Sheet marker' : ''} (snapshot not saved).`);
        if (sheets) {
          const marker = {
            handle: '__blocked__',
            title: '⚠️ BLOCKED — no data this week (manual check recommended)',
            url: comp.baseUrl, productType: '',
            lastRank: null, thisRank: null, wow: null,
            status: 'Blocked',
            wk2Rank: null, wk3Rank: null, monthChange: null, streak: null, avgRank: null,
            hotStreak: null, spike: null, consistentTop10: null,
          };
          await writeCompetitorTab(sheets, cfg.sheetId, comp.name, [marker], date);
        }
      } else if (sheets) {
        await writeCompetitorTab(sheets, cfg.sheetId, comp.name, rows, date);
      }
      if (!snapshot.blocked) {
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
