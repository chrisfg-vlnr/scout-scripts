// scout-competitor-tracker/competitors.js
// Manage tracked competitors WITHOUT hand-editing config.json.
// Scout runs this (it must NOT edit config.json directly) and relays the result.
//
// Usage:
//   node competitors.js --list
//   node competitors.js --add "Name" "https://domain.com"   # live tier-detection, then add
//   node competitors.js --enable  "Name"
//   node competitors.js --disable "Name"
//   node competitors.js --remove  "Name"   # permanently delete the config entry (must already be disabled)
//
// On --add the script runs a live tier-detection check (same endpoints as the weekly run:
// JSON catalog + HTML best-selling rank) and reports the tier — including clearly if BLOCKED.
//
// Abuse guard (Scout is exposed to an external Discord channel, unlike the internal
// CFNCS tracker): a hard cap on ENABLED tracked competitors (fixed 2026-07-31 — was
// previously counting ALL entries including disabled ones, which meant --disable never
// actually freed a slot, contradicting the cap-exceeded message's own advice), plus a short
// cooldown between adds, since --add fetches live pages against an arbitrary caller-supplied
// domain and a full baseline snapshot can be as expensive as a full weekly run for that one
// store. The enabled-only cap keeps the real abuse surface (weekly scrape volume, live-fetch
// cost at --add time) unchanged — a disabled entry costs nothing. The one tradeoff: total
// config entries can now grow across disable→add cycles since disabling no longer requires
// eventually removing. --remove exists as the hygiene tool for that — deleting a config entry
// never touches its Sheet tab or local snapshot history, both of which are keyed independently
// of config.json (by competitor name), so removed-then-re-added history isn't lost either.

import {
  loadConfig, saveConfig, slug, findCompetitor, normalizeBaseUrl,
  detectTier, loadSnapshots, buildSnapshot, saveSnapshot, computeMetrics,
  getSheetsClient, writeCompetitorTab,
} from './lib.js';

function localDate(tz) {
  return new Intl.DateTimeFormat('sv', { timeZone: tz }).format(new Date());
}

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--add')      { a.add = true; a.name = argv[++i]; a.url = argv[++i]; }
    else if (v === '--enable')  a.enable = argv[++i];
    else if (v === '--disable') a.disable = argv[++i];
    else if (v === '--remove')  a.remove = argv[++i];
    else if (v === '--list')    a.list = true;
    else if (v === '--collection') a.collection = argv[++i];
  }
  return a;
}

// The cap counts ENABLED entries only — a disabled entry costs nothing (no weekly scrape, no
// live fetch), so it shouldn't consume a slot. See the file-header note (2026-07-31 fix).
function enabledCount(cfg) {
  return cfg.competitors.filter(c => c.enabled).length;
}

function tierLabel(d) {
  if (d.blocked) return `⛔ ${d.tier}  (JSON: ${d.jsonErr || 'fail'} | HTML: ${d.htmlErr || 'fail'})`;
  const bits = [];
  bits.push(`JSON catalog ${d.jsonOk ? `OK (${d.jsonCount}+ products p1)` : `NO (${d.jsonErr})`}`);
  bits.push(`HTML rank ${d.htmlOk ? `OK (${d.htmlCount} on p1)` : `NO (${d.htmlErr})`}`);
  return `✅ ${d.tier}  — ${bits.join(' | ')}`;
}

async function lastKnownSnapshot(name) {
  // NOTE: this is the last snapshot that was successfully SAVED, not necessarily the
  // outcome of the most recent run attempt — a blocked run is deliberately never saved
  // (so it can't clobber good history), so it won't show up here at all. If the most
  // recent weekly run came back blocked, this will still show the last good week before
  // that, with no indication a more recent attempt failed. Don't answer "was the last
  // run blocked?" from this field alone — check the Sheet tab's __blocked__ marker row
  // (Last Updated column) for the true most-recent-attempt status.
  const snaps = await loadSnapshots(name);
  if (snaps.length === 0) return '(no snapshot yet)';
  const s = snaps[0];
  return `${s.date}: ${s.tier}${s.coverage != null ? `, coverage ${Math.round(s.coverage * 100)}%` : ''}${s.blocked ? ' (BLOCKED)' : ''}`;
}

async function doList() {
  const cfg = await loadConfig();
  const maxCompetitors = cfg.maxCompetitors ?? 20;
  const nEnabled = enabledCount(cfg);
  const nDisabled = cfg.competitors.length - nEnabled;
  console.log(`Configured competitors: ${nEnabled}/${maxCompetitors} enabled`
    + (nDisabled ? ` (+${nDisabled} disabled, ${cfg.competitors.length} total)` : '') + '\n');
  for (const c of cfg.competitors) {
    const status = c.enabled ? 'ENABLED ' : 'disabled';
    console.log(`  [${status}] ${c.name}  ${c.baseUrl}`);
    console.log(`            last successful snapshot: ${await lastKnownSnapshot(c.name)}`);
  }
}

async function doAdd(name, url, collection) {
  if (!name || !url) { console.error('Usage: --add "Name" "https://domain.com"'); process.exit(1); }
  const cfg = await loadConfig();

  // ─── abuse guard ──────────────────────────────────────────────────────────
  const maxCompetitors = cfg.maxCompetitors ?? 20;
  const nEnabled = enabledCount(cfg);
  if (nEnabled >= maxCompetitors) {
    const nDisabled = cfg.competitors.length - nEnabled;
    console.error(`At the tracked-competitor limit (${nEnabled}/${maxCompetitors} enabled). 0 slots free.\n`
      + `Free one by disabling an existing competitor — node competitors.js --disable "Name" (see --list for names) — this immediately frees a slot for a new add.`
      + (nDisabled > 0
        ? `\nYou also have ${nDisabled} already-disabled entr${nDisabled === 1 ? 'y' : 'ies'} you could permanently delete instead: node competitors.js --remove "Name" (doesn't touch its Sheet tab or snapshot history).`
        : ''));
    process.exit(1);
  }
  const cooldownSeconds = cfg.addCooldownSeconds ?? 60;
  if (cfg.lastAddAtMs) {
    const elapsedSeconds = (Date.now() - cfg.lastAddAtMs) / 1000;
    if (elapsedSeconds < cooldownSeconds) {
      const wait = Math.ceil(cooldownSeconds - elapsedSeconds);
      console.error(`Please wait ${wait}s before adding another competitor (cooldown: ${cooldownSeconds}s between adds).`);
      process.exit(1);
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  if (findCompetitor(cfg, name)) { console.error(`A competitor named "${name}" already exists. Use --enable/--disable, or pick a different name.`); process.exit(1); }
  const baseUrl = normalizeBaseUrl(url);
  if (cfg.competitors.some(c => normalizeBaseUrl(c.baseUrl) === baseUrl)) {
    console.error(`That domain (${baseUrl}) is already tracked under another name.`); process.exit(1);
  }
  const col = collection || 'all';

  console.log(`Running live tier detection for "${name}" (${baseUrl}, collection "${col}")...`);
  const d = await detectTier({ name, baseUrl, collection: col }, cfg);
  console.log(`Result: ${tierLabel(d)}`);

  // Assign new competitors to the config-declared catch-all weekly batch (cfg.defaultBatch) so
  // they're picked up by a staggered batch cron from the very next run. (The catch-all batch's
  // cron also runs --include-ungrouped as a backstop, so even an untagged competitor is never
  // silently skipped — but tagging it here keeps config/--list explicit.) The fallback here
  // ('D') exists only for a config.json missing the field entirely; since this session sets
  // defaultBatch explicitly, that branch is currently unreachable but is kept pointed at the
  // real catch-all rather than a stale letter. See SKILL.md → "Weekly batches".
  const entry = { name, baseUrl, collection: col, enabled: true, batch: cfg.defaultBatch || 'D' };
  cfg.competitors.push(entry);
  cfg.lastAddAtMs = Date.now();
  await saveConfig(cfg);

  console.log(`\n✔ Added "${name}" (enabled). It will be included in the next weekly run and in --list.`);
  if (d.blocked) {
    console.log(`⚠️  HEADS UP: ${name} came back BLOCKED (Tier 3). It will be flagged in the Sheet + Discord each week, not scraped. If you don't want a standing blocked check for it, run:  node competitors.js --disable "${name}"`);
    return;
  }
  if (!d.htmlOk) {
    console.log(`⚠️  Note: HTML best-selling rank did not return products on page 1 — rank tracking may be unavailable for this store. Catalog/new-removed still works.`);
  }

  // Baseline snapshot now (not just tier-detection) so the next weekly run has something
  // to diff against and produces a real WoW change on its first pass, instead of the new
  // competitor sitting with zero history until the run after next.
  console.log(`\nCapturing baseline snapshot for "${name}"...`);
  const date = localDate(cfg.reportTz || 'Asia/Manila');
  const snapshot = await buildSnapshot(entry, cfg, date);
  if (snapshot.blocked || snapshot.partial) {
    const label = snapshot.blocked ? 'blocked' : 'partial (a mid-crawl wall stopped it early)';
    console.log(`⚠️  Baseline snapshot ${label} (${snapshot.error || label}) — no baseline saved. It'll get its first snapshot on the next weekly run instead.`);
    return;
  }
  await saveSnapshot(snapshot, entry);
  console.log(`✔ Baseline snapshot saved (${date}): ${snapshot.tier}, catalog ${snapshot.catalogCount}, ranked ${snapshot.rankedCount}, coverage ${Math.round(snapshot.coverage * 100)}%. WoW change will be available on the next weekly run.`);

  // Write the baseline straight to the Sheet too — not just local disk. Without this, the
  // Sheet tab doesn't exist until the next successful weekly index.js run, which can make
  // Scout's own query.js answers (reads local snapshots) look inconsistent with what's
  // actually visible in the Sheet if that next run happens to come back blocked before this
  // baseline ever synced. Non-fatal: local baseline is already safely saved above regardless.
  try {
    const sheets = await getSheetsClient();
    const { rows } = computeMetrics([snapshot], cfg);
    await writeCompetitorTab(sheets, cfg.sheetId, entry.name, rows, date);
    console.log(`✔ Baseline written to Sheet tab "${entry.name}" (${rows.length} rows) — in sync from the moment it's added.`);
  } catch (e) {
    console.log(`⚠️  Baseline captured locally but Sheet write failed (${e.message}). It'll sync on the next successful weekly run instead.`);
  }
}

async function setEnabled(name, enabled) {
  const cfg = await loadConfig();
  const c = findCompetitor(cfg, name);
  if (!c) { console.error(`No competitor named "${name}". Run --list to see configured competitors.`); process.exit(1); }
  if (c.enabled === enabled) { console.log(`"${c.name}" is already ${enabled ? 'enabled' : 'disabled'}. No change.`); return; }
  if (enabled) {
    // Re-enabling must respect the same cap --add does — otherwise disable/enable cycling
    // could push the scraped-weekly count above maxCompetitors. (Its existing `batch` field,
    // if any, is untouched by disable/enable, so it lands back in the right weekly batch.)
    const maxCompetitors = cfg.maxCompetitors ?? 20;
    const nEnabled = enabledCount(cfg);
    if (nEnabled >= maxCompetitors) {
      console.error(`Can't enable "${c.name}" — already at the tracked-competitor limit (${nEnabled}/${maxCompetitors} enabled). Disable another competitor first.`);
      process.exit(1);
    }
  }
  c.enabled = enabled;
  await saveConfig(cfg);
  console.log(`✔ "${c.name}" is now ${enabled ? 'ENABLED' : 'disabled'}.`);
}

async function doRemove(name) {
  const cfg = await loadConfig();
  const c = findCompetitor(cfg, name);
  if (!c) { console.error(`No competitor named "${name}". Run --list to see configured competitors.`); process.exit(1); }
  if (c.enabled) {
    console.error(`"${c.name}" is still enabled. Disable it first, then remove it:\n`
      + `  node competitors.js --disable "${c.name}"\n  node competitors.js --remove "${c.name}"`);
    process.exit(1);
  }
  cfg.competitors = cfg.competitors.filter(x => x !== c);
  await saveConfig(cfg);
  console.log(`✔ "${c.name}" removed from tracked competitors (config entry deleted).\n`
    + `Its Sheet tab and local snapshot history are untouched — only the config entry is gone. `
    + `Re-adding it later (node competitors.js --add "${c.name}" "${c.baseUrl}") starts a fresh baseline and keeps writing to the same Sheet tab.`);
}

async function main() {
  const a = parseArgs(process.argv);
  if (a.add)          return doAdd(a.name, a.url, a.collection);
  if (a.enable)       return setEnabled(a.enable, true);
  if (a.disable)      return setEnabled(a.disable, false);
  if (a.remove)       return doRemove(a.remove);
  if (a.list)         return doList();
  console.log('Usage:\n  node competitors.js --list\n  node competitors.js --add "Name" "https://domain.com"\n  node competitors.js --enable "Name"\n  node competitors.js --disable "Name"\n  node competitors.js --remove "Name"   (must already be disabled)');
}

main().catch(e => { console.error(e?.stack || String(e)); process.exit(1); });
