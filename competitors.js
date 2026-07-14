// scout-competitor-tracker/competitors.js
// Manage tracked competitors WITHOUT hand-editing config.json.
// Scout runs this (it must NOT edit config.json directly) and relays the result.
//
// Usage:
//   node competitors.js --list
//   node competitors.js --add "Name" "https://domain.com"   # live tier-detection, then add
//   node competitors.js --enable  "Name"
//   node competitors.js --disable "Name"
//
// On --add the script runs a live tier-detection check (same endpoints as the weekly run:
// JSON catalog + HTML best-selling rank) and reports the tier — including clearly if BLOCKED.
//
// Abuse guard (Scout is exposed to an external Discord channel, unlike the internal
// CFNCS tracker): a hard cap on total tracked competitors, plus a short cooldown between
// adds, since --add fetches live pages against an arbitrary caller-supplied domain and a
// full baseline snapshot can be as expensive as a full weekly run for that one store.

import {
  loadConfig, saveConfig, slug, findCompetitor, normalizeBaseUrl,
  detectTier, loadSnapshots, buildSnapshot, saveSnapshot,
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
    else if (v === '--list')    a.list = true;
    else if (v === '--collection') a.collection = argv[++i];
  }
  return a;
}

function tierLabel(d) {
  if (d.blocked) return `⛔ ${d.tier}  (JSON: ${d.jsonErr || 'fail'} | HTML: ${d.htmlErr || 'fail'})`;
  const bits = [];
  bits.push(`JSON catalog ${d.jsonOk ? `OK (${d.jsonCount}+ products p1)` : `NO (${d.jsonErr})`}`);
  bits.push(`HTML rank ${d.htmlOk ? `OK (${d.htmlCount} on p1)` : `NO (${d.htmlErr})`}`);
  return `✅ ${d.tier}  — ${bits.join(' | ')}`;
}

async function lastKnown(name) {
  const snaps = await loadSnapshots(name);
  if (snaps.length === 0) return '(no snapshot yet)';
  const s = snaps[0];
  return `${s.date}: ${s.tier}${s.coverage != null ? `, coverage ${Math.round(s.coverage * 100)}%` : ''}${s.blocked ? ' (BLOCKED)' : ''}`;
}

async function doList() {
  const cfg = await loadConfig();
  console.log(`Configured competitors (${cfg.competitors.length}/${cfg.maxCompetitors ?? 15}):\n`);
  for (const c of cfg.competitors) {
    const status = c.enabled ? 'ENABLED ' : 'disabled';
    console.log(`  [${status}] ${c.name}  ${c.baseUrl}`);
    console.log(`            last run: ${await lastKnown(c.name)}`);
  }
}

async function doAdd(name, url, collection) {
  if (!name || !url) { console.error('Usage: --add "Name" "https://domain.com"'); process.exit(1); }
  const cfg = await loadConfig();

  // ─── abuse guard ──────────────────────────────────────────────────────────
  const maxCompetitors = cfg.maxCompetitors ?? 15;
  if (cfg.competitors.length >= maxCompetitors) {
    console.error(`At the tracked-competitor limit (${maxCompetitors}). Disable one with --disable before adding another.`);
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

  const entry = { name, baseUrl, collection: col, enabled: true };
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
  if (snapshot.blocked) {
    console.log(`⚠️  Baseline snapshot failed (${snapshot.error || 'blocked'}) — no baseline saved. It'll get its first snapshot on the next weekly run instead.`);
    return;
  }
  await saveSnapshot(snapshot, entry);
  console.log(`✔ Baseline snapshot saved (${date}): ${snapshot.tier}, catalog ${snapshot.catalogCount}, ranked ${snapshot.rankedCount}, coverage ${Math.round(snapshot.coverage * 100)}%. WoW change will be available on the next weekly run.`);
}

async function setEnabled(name, enabled) {
  const cfg = await loadConfig();
  const c = findCompetitor(cfg, name);
  if (!c) { console.error(`No competitor named "${name}". Run --list to see configured competitors.`); process.exit(1); }
  if (c.enabled === enabled) { console.log(`"${c.name}" is already ${enabled ? 'enabled' : 'disabled'}. No change.`); return; }
  c.enabled = enabled;
  await saveConfig(cfg);
  console.log(`✔ "${c.name}" is now ${enabled ? 'ENABLED' : 'disabled'}.`);
}

async function main() {
  const a = parseArgs(process.argv);
  if (a.add)          return doAdd(a.name, a.url, a.collection);
  if (a.enable)       return setEnabled(a.enable, true);
  if (a.disable)      return setEnabled(a.disable, false);
  if (a.list)         return doList();
  console.log('Usage:\n  node competitors.js --list\n  node competitors.js --add "Name" "https://domain.com"\n  node competitors.js --enable "Name"\n  node competitors.js --disable "Name"');
}

main().catch(e => { console.error(e?.stack || String(e)); process.exit(1); });
