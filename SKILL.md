# SKILL.md — Scout Competitor Scaling Tracker

## What it does

Weekly, zero-AI-token script that tracks competitor Shopify stores' **bestseller rankings** to
spot products that are scaling (rising rank = rising sales velocity). For each competitor it
fetches the **full product catalog in best-selling order**, compares against prior weeks, computes
week-on-week rank change, and writes results to a Google Sheet (one tab per competitor) plus a
Discord report to Scout's dedicated channel.

This is a standalone copy of CFNCS's internal Competitor Scaling Tracker
(`~/scripts/competitor-tracker/`), built for an external team via the **Scout** agent. Same logic,
same fetch tiers, same metrics — fully isolated: own scripts dir, own config, own Sheet, own
Discord bot, own auth key. Nothing shared with CFNCS/MFEO agents except the Google service account
(Sheets/Drive write access only, scoped per-sheet by sharing — not a security boundary).

Competitors are **strictly isolated** — separate snapshot files, separate sheet tabs, separate
report sections. Removed products are kept (marked), never deleted.

## How to run

```bash
node /home/chris/scripts/scout-competitor-tracker/index.js                 # weekly run, all enabled competitors
node /home/chris/scripts/scout-competitor-tracker/index.js --only Feanatic # one competitor
node /home/chris/scripts/scout-competitor-tracker/index.js --date 2026-06-30
node /home/chris/scripts/scout-competitor-tracker/index.js --no-discord --no-sheet   # dry preview
node /home/chris/scripts/scout-competitor-tracker/index.js --max-rank-pages 10       # cap pages (testing)
```

**Cron:** `scout-competitor-tracker-weekly` — Monday 10:30 AM Manila (30 min after CFNCS's own
`competitor-tracker-weekly` — avoids same-minute overlap, not a hard requirement), `--command`
(no model session, $0 tokens). Self-delivers its own Discord report (`--no-deliver` on the cron
job — delivery.mode stays script-owned, mirroring the original's reasoning: cron run status
should reflect the script's real success/failure, not delivery plumbing). On failure, the cron
job's native `--failure-alert-*` config DMs Chris on Telegram (riding the existing Palantir
Telegram account for that one outbound alert — no Telegram credential of Scout's own).

## Data source — IMPORTANT (inherited from Phase 1 findings on the CFNCS tracker)

Shopify's `/collections/<col>/products.json` endpoint **silently ignores `sort_by`** — it returns
the collection's default order, NOT a sales rank. So:

- **Rank comes only from the HTML view:** `GET /collections/<col>?sort_by=best-selling&page=N`,
  paginated, deduped by first appearance → global rank `1..N`. Fetches are sequential, paced 1–2s,
  browser UA.
- **Catalog + metadata** (title, `product_type`, URL, membership for new/removed detection) come
  from `products.json` (reliable, 250/page).
- **Junk filter:** upsell pseudo-products (`shipping-protection`, `*-vip`, `warranty`, etc.) are
  filtered via `config.json` → `junkHandlePatterns`.
- **Coverage check:** `rankedCount / catalogCount` is logged; <60% warns that the theme hides
  products from the HTML view.

## WoW Change sign convention (locked)

```
WoW Change = This Week Rank − Last Week Rank
```
**Negative = moved UP = improving/scaling** (lower rank number is better). Sort ascending → fastest
risers on top.

## Status

| Status | Meaning |
|---|---|
| Active | In both this week's and last week's catalog |
| New This Week | In this week's catalog, not last week's (genuinely new product) |
| Removed From Store | In last week's catalog, gone this week — kept in sheet, never deleted |

First run has no prior snapshot → everything is `Active` baseline, no WoW, no new/removed.

## Multi-week bonus signals (rolling 4-week window)

Month Change (vs oldest snapshot), Streak (consecutive improving weeks), Avg Rank (4w),
Hot Streak (improved 3+ consecutive weeks), Spike (big jump this week, flat before),
Consistent Top 10 (≤10 in every tracked week).

## Google Sheet

- ID `1tdrGptnfwNwrsdZHVt_ASSSvNYgZkPu2dJENS8OTajo` (Scout's dedicated sheet — separate from
  CFNCS's Competitor Scaling Data sheet)
- One tab per competitor (auto-created), named after the competitor's `name`.
- Upsert key: **Product Handle**. Frozen header row. Auto-sorted by WoW Change ascending each run.
- Service account: `/home/chris/scripts/google-service-account.json` (shared with CFNCS — this is
  the one intentionally-shared resource; Sheets access is scoped per-sheet by sharing, not by
  credential, so this does not expose any CFNCS/MFEO data to Scout or vice versa).

## Ad-hoc queries — use query.js, NEVER read raw snapshots

```bash
node query.js --list
node query.js --competitor Feanatic --summary
node query.js --competitor Feanatic --top-movers 20
node query.js --competitor Feanatic --decliners 20
node query.js --competitor Feanatic --hot-streaks
node query.js --competitor Feanatic --consistent-top10
node query.js --competitor Feanatic --new
node query.js --competitor Feanatic --removed
node query.js --competitor Feanatic --product "<handle-or-text>"
```

All computation happens in script-land for ~zero tokens; only a few rows are printed. **Scout must
answer Discord questions about this data via `query.js`, never by reading `data/*.json` snapshots
into model context** — same rule as Palantir's, documented in Scout's `AGENTS.md`.

## Managing competitors (use competitors.js, don't hand-edit config)

```bash
node competitors.js --list
node competitors.js --add "Name" "https://domain.com"       # live tier-detection, then adds (enabled)
node competitors.js --enable  "Name"
node competitors.js --disable "Name"                         # "remove" = disable (tab/history kept)
```

`--add` runs a **live tier-detection check** (JSON catalog page 1 + HTML best-selling page 1) and
prints the tier — including a clear **BLOCKED (Tier 3)** warning — before adding.

### Abuse guard (Scout-specific — not in the CFNCS original)

Scout is exposed to an external Discord channel, so `--add` is not open-ended the way it is
internally:

- **Hard cap:** `config.json` → `maxCompetitors` (default 15). `--add` refuses once the cap is
  hit; disable an existing entry first.
- **Cooldown:** `config.json` → `addCooldownSeconds` (default 60). `--add` refuses if the last
  successful add was more recent than this, tracked via `lastAddAtMs` in `config.json`.

Rationale: `--add` does live HTTP fetches against an arbitrary caller-supplied domain, and a
baseline snapshot can be as expensive as a full weekly run for that one store — an external,
untrusted channel shouldn't be able to trigger unbounded fetches against arbitrary domains from
the VPS. Numbers are conservative defaults, not tuned; adjust in `config.json` if they're wrong
in practice.

## Discord report

One header message (date, competitor count, sheet link), then one message per competitor
(top movers up/down, new/removed counts, multi-week bonus footer). Blocked competitors get a
single flagged line instead. Messages are chunked at ~1900 chars (Discord's hard cap is 2000,
vs. Telegram's ~4096 that the original chunks at 3800) and sent via direct Discord REST API call
(`POST /channels/{id}/messages`) using Scout's own bot token — mirroring the original's
self-delivery pattern (bypasses cron's delivery system so cron run status reflects the script's
real success/failure).

## Config (`config.json`)

`sheetId`, `discordChannelId`, `weeksToKeep` (snapshot retention, default 4), `maxCompetitors`,
`addCooldownSeconds`, `fetch` (delays, timeout, retries, UA, page-safety cap),
`spikeThreshold`/`flatThreshold`, `junkHandlePatterns`, and `competitors[]` (`name`, `baseUrl`,
`collection`, `enabled`, optional `maxRankPages`). Manage `competitors[]` via `competitors.js`.

## Credentials

- `discord-token.json` — Scout's own Discord bot token. **Gitignored.** Never hardcoded in a
  tracked `.js` file (unlike the CFNCS original, which hardcodes its Telegram token directly in
  `index.js` — that token is consequently live in the `palantir-scripts` GitHub repo's history;
  a pre-existing issue on the original, not replicated here).
- `google-service-account.json` — shared with CFNCS (see Google Sheet section above), path
  `/home/chris/scripts/google-service-account.json`, never committed (covered by the parent
  `~/scripts/.gitignore`, though this repo lives outside that tree — see below).

## Repo

This directory is its **own** git repo (`scout-scripts`), separate from CFNCS's `palantir-scripts`
repo that `~/scripts/competitor-tracker/` lives in — matching the pattern already used for
`~/scripts/ransom/` and `~/scripts/nica/` (nested-but-separate repos under `~/scripts/`).

## Snapshots / state

- `data/<slug>-YYYY-MM-DD.json` — full weekly catalog+rank snapshot per competitor.
- Last `weeksToKeep` (4) kept; older auto-pruned each run.
- `data/` is gitignored (runtime data, large, regenerated weekly).

## Fallback tiers

1. JSON catalog + HTML rank (normal).
2. HTML rank only / catalog only (degraded — logged).
3. **Blocked** (e.g. Cloudflare 409): never crashes the run. Flagged in both the Discord report
   and the Sheet (marker row keyed on handle `__blocked__`). A blocked week's snapshot is **not
   saved**, so the next successful week still baselines against the last good week.

## Error handling

Per-competitor errors are caught and reported as a flagged section; one bad store never aborts the
others. Unrecoverable top-level errors exit non-zero (cron status reflects it).
