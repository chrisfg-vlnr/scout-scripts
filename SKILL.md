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
node /home/chris/scripts/scout-competitor-tracker/index.js --help                    # usage (added 2026-07-20)
```

**Guards (added 2026-07-20, after overlapping manual runs rate-limit-walled belroshop.com):**

- **Unknown flags hard-fail** with a usage message, exit 1. (Before this, `--help` was silently
  ignored and launched a full 8-competitor scrape.)
- **`.run.lock` concurrency guard** — a second run while one is live refuses with **exit 3**
  and points at the lock file. Stale locks (dead pid) are replaced automatically; only delete
  `.run.lock` by hand if you've confirmed the pid in it is not a tracker run. The lock is a
  single global lock shared by all batches (not per-batch) — this is what makes `--wait-for-lock`
  work uniformly across any number of batches.
- **Manual reruns go through the registered cron job(s)**, not a raw `node index.js`. Rerun only
  the batch that needs it:
  `openclaw cron run 34357ef3-6885-4d40-a406-b3b16a46a92e` (Batch A) /
  `openclaw cron run 95657ebe-99b6-4266-80f2-f94f1ec14c04` (Batch B) /
  `openclaw cron run faee47e1-a0fe-4d53-8d0f-57aa27528276` (Batch C) /
  `openclaw cron run 05acdb9e-dae7-43b6-8fcf-7d0e87e41488` (Batch D).
  Max one manual rerun per day — repeated same-day crawls escalate Cloudflare-style walls.

## Weekly batches (added 2026-07-21, restructured 2026-08-07 for the 15→20 cap raise)

The weekly run is **split into four staggered cron jobs**, not one — at up to 20 competitors
(one of them a 19k-product monster, CristalliSchwiiz) a single sequential run would run several
hours, and bunching all scrape volume into one ~90-minute window is the worst shape for the
documented IP-wide Shopify `local_rate_limited` throttle risk (see primer, 2026-07-29 entries).
Each batch is the same `index.js`/`lib.js`/`.run.lock` machinery, selected by a per-competitor
`"batch"` field in `config.json` via `--group`:

- **Batch A** — job `34357ef3-…`, **Mon 08:00 Manila**, `--group A --wait-for-lock 300`, timeout
  **10800s (3h)**. CristalliSchwiiz **only** — the ~14–19k-product monster (`maxRankPages:2000`,
  historically ~57–78 min alone). Solo by design: even alone it's the single largest batch: giving
  it a 3h ceiling (instead of the other batches' 7200s) keeps it under ~50% of its own timeout
  under a realistic worst-case, which it could not do inside 7200s (see the 2026-08-07 primer
  entry). Scheduled first and early specifically so it finishes (~09:15–09:30 typical) well
  before Palantir's 10:00 storefront scrape starts.
- **Batch B** — job `95657ebe-…`, **Mon 11:30 Manila** (3.5h after A), `--group B
  --wait-for-lock 1800`, timeout 7200s. ByEmiliaRose, Gartenort, DriftAndTide, NouveauRiche.
  Starts a full hour after Palantir's `competitor-tracker-weekly` (Mon 10:00, ~35 min) is
  expected to finish — that job scrapes DriftAndTide too, so this gap is intentional, not
  incidental.
- **Batch C** — job `faee47e1-…`, **Mon 13:30 Manila** (2h after B), `--group C
  --wait-for-lock 1800`, timeout 7200s. Feanatic, BelroShop, HausOfMode. BelroShop is the store
  that got rate-limit-walled on 2026-07-20 and is also scraped by Palantir (as "Belro") at 10:00 —
  this batch's 3.5h clearance from that scrape is deliberate extra margin, not just stagger
  spacing.
- **Batch D** — job `05acdb9e-…`, **Mon 15:30 Manila** (2h after C), `--group D
  --include-ungrouped --wait-for-lock 1800`, timeout 7200s. The **catch-all** batch (any
  enabled competitor with no `batch` runs here) and the destination `competitors.js --add`
  assigns new competitors to (`config.json`'s `defaultBatch: "D"`) — it currently carries the
  most headroom of the four, by design, to absorb the 15→20 cap's 5 new slots without needing
  another restructure. As of 2026-08-07: BreuerMode, RisoraShop, RedlichBecker, JesseLondon,
  LaLunaMelbourne, Drune, LozendaFashion.

Roster drifts as competitors are added/removed/rebalanced; `config.json`'s `batch` field is
always the source of truth — the lists above are a convenience summary, not authoritative.

Design notes:
- **Each batch self-delivers its own Discord report** (header shows "Batch A/B/C/D") — the team
  sees up to four messages Monday, spread from ~08:00 to ~16:00. Simpler than coordinating one
  combined report across four jobs, and the spread-out timing is intentional (throttle recovery
  time between batches), not a bug to compress.
- **`--include-ungrouped`** is now only on Batch D (the catch-all) — any enabled competitor with
  no `batch` (e.g. a hand-edited config) is scraped there, never silently skipped.
  `competitors.js --add` auto-tags new competitors with `config.json`'s `defaultBatch` (currently
  `"D"`), not a hardcoded letter — this is what makes the auto-assignment correct regardless of
  how many batches exist.
- **`--wait-for-lock N`**: if a batch starts while another run holds `.run.lock`, it waits up to N
  seconds (polling) instead of failing — so a slightly-overrunning earlier batch doesn't make the
  next one exit 3. Manual/ad-hoc runs (no flag) still fail fast on a live lock. Because the lock
  is global (see the Guards section above), this works the same regardless of batch count.
- All four jobs are `--no-deliver` (delivery.mode `none`, script-owned) with the same
  `--failure-alert-*` config DMing Chris on Telegram (riding the Palantir account). `$0` model
  tokens.
- **To rebalance batches:** edit the `"batch"` field per competitor in `config.json` (A/B/C/D).
  To add a fifth batch, register another cron job with `--group E` and a later stagger, and
  consider moving `defaultBatch` to it if it becomes the new lowest-committed-time batch.
  **If a future `--add` turns out to be another CristalliSchwiiz-sized store**, move it to its
  own batch (or Batch A) rather than leaving it in the Batch D catch-all — Batch D's headroom
  assumes future adds are modest-sized, not monsters.

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
- **19 columns** (added Price + Currency 2026-07-29, appended at the end — see below). The
  existing-row read range that preserves history across the weekly clear-and-rewrite is **derived
  from the header length** (`SHEET_LAST_COL` in `lib.js`), not a hardcoded literal — this was a
  real bug found and fixed in the same session: a hardcoded range one column narrower than the
  actual schema silently blanks any preserved row's trailing column(s) on the next rewrite.

## Price & Currency (added 2026-07-29)

- **Price** = the first variant's price from the JSON catalog (`p.variants[0].price`), isolated in
  `selectPrice()` in `lib.js` so switching to e.g. min-across-variants later is a one-line change.
  **UNVERIFIED-THIS-SESSION**: this relies on Shopify's documented public `products.json` schema
  (`variants[].price` as a numeric string) — a live confirmation fetch was attempted (one request
  each against gartenort.de and www.driftandtide.com) but both hit `HTTP 429 local_rate_limited`;
  see the Primer's 2026-07-29 Execution Log entry for the full throttle finding.
- **Currency** = a manually-set per-competitor field in `config.json` (`"currency"`, e.g. `"EUR"`).
  Deliberately **not** derived from the domain TLD (unreliable — a `.de` store can price in any
  currency) and **not** converted/normalized — shown as-is. Scaffolded to `null` for all 14
  competitors as of 2026-07-29; ask Chris for the real values before treating the column as
  trustworthy.
- **Tier 2-only competitors (HTML rank scrape, no JSON catalog) get permanently `null` price** —
  not a gap that'll close later. `extractGridHandles()` (container-scoped with a whole-page
  fallback as of 2026-08-05 — see below) is still just an href regex against the best-selling grid
  HTML either way; there is no price anywhere in that code path, and adding one would mean
  theme-dependent HTML price scraping, a materially bigger and more fragile feature, explicitly
  out of scope. (Note: under the *existing*, unmodified `buildSnapshot()` logic, a catalog-blocked
  run is already flagged `partial` regardless of rank-scrape success, so this scenario doesn't
  currently produce per-product Sheet rows at all today — just a marker row. Found via the mock
  harness while verifying this feature, not a new behavior.)
- **query.js** (`--product`, and the top-movers `line()` output) shows price **only** paired with
  its currency (`"19.99 EUR"`) or an explicit `"(currency unknown)"` label — never a bare number
  that could be misread as the wrong currency.
- Discord's weekly report deliberately does **not** show price (message chunking is already tight
  at ~1900 chars) — Sheet and `query.js` only.

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

`--product` and the top-movers output now also show price, always paired with its currency
(`"19.99 EUR"`) or an explicit `"(currency unknown)"` label if the competitor's `currency` isn't
set in `config.json` yet — see "Price & Currency" above.

## Managing competitors (use competitors.js, don't hand-edit config)

```bash
node competitors.js --list
node competitors.js --add "Name" "https://domain.com"       # live tier-detection, then adds (enabled)
node competitors.js --enable  "Name"
node competitors.js --disable "Name"                         # stop scraping; Sheet tab/history kept; frees a cap slot (enabled-only cap, since 2026-07-31)
node competitors.js --remove  "Name"                         # permanently delete the config entry (must already be disabled); Sheet tab/history still kept
```

`--add` runs a **live tier-detection check** (JSON catalog page 1 + HTML best-selling page 1) and
prints the tier — including a clear **BLOCKED (Tier 3)** warning — before adding. On success, it
also captures a full baseline snapshot **and writes it straight to the Sheet tab** (Scout-specific
fix, not in the CFNCS original — see "Sheet sync on add" below), so the tab exists with real data
from the moment the competitor is added rather than waiting for the next weekly run.

### Sheet sync on add (Scout-specific fix — not in the CFNCS original)

`competitors.js --add` used to only save the baseline snapshot to local disk
(`data/<slug>-<date>.json`) — the Google Sheet tab wasn't created/populated until the *next*
successful `index.js` run. Normally invisible, but it produced a real, confusing bug once: a
competitor was added, its baseline saved locally (good data), then the very next `index.js` run
(triggered manually for testing, same day) came back rate-limited/blocked — so the Sheet's
first-ever write for that competitor was *only* the blocked marker, while `query.js` (which reads
local snapshots) kept reporting the good baseline. Scout answered a direct challenge about this
by trusting `query.js`'s local data and asserting the competitor definitely wasn't blocked —
which was wrong for what was actually visible in the Sheet at that moment.

Fixed by moving the Sheet-writing logic (`getSheetsClient`, `writeCompetitorTab`) into `lib.js` so
both `index.js` and `competitors.js` can use it. `--add` now writes the baseline to the Sheet
immediately (non-fatal if it fails — local snapshot is already safely saved either way, and it'll
sync on the next successful weekly run instead).

**Residual limitation, not fixed:** this closes the gap for a *newly-added* competitor. It does
NOT add tracking of "was the most recent attempt blocked" for an *already-established* competitor
on a later run — a blocked run is still never saved locally by design (so it can't clobber good
history), so `query.js`/`competitors.js --list` still can't distinguish "last successful snapshot"
from "the literal most recent attempt" for competitors added before this fix, or on any
subsequent blocked run. `competitors.js --list`'s field is labeled `last successful snapshot:`
(not `last run:`) specifically so it doesn't overclaim what it actually knows. Scout's `AGENTS.md`
has a matching instruction: don't assert a competitor "isn't blocked" from `query.js` alone if
someone pushes back — state what's actually known (the last successful snapshot) rather than
implying it reflects the most recent attempt. Ground truth for "was the most recent run blocked"
is the Sheet's `__blocked__` marker row's `Last Updated` date, if present.

### Abuse guard (Scout-specific — not in the CFNCS original)

Scout is exposed to an external Discord channel, so `--add` is not open-ended the way it is
internally:

- **Hard cap:** `config.json` → `maxCompetitors` (default 20, raised from 15 on 2026-08-07 —
  see the primer entry for the batch-restructure work that had to land first), counting
  **enabled** entries only
  (fixed 2026-07-31 — previously counted all entries including disabled ones, so `--disable`
  never actually freed a slot despite the cap message telling you to disable to make room).
  `--add` refuses once the cap is hit; disable an existing entry first — that alone frees a slot
  now. `--enable` on a disabled entry respects the same cap. `--remove` permanently deletes an
  already-disabled entry's config record (Sheet tab/snapshot history untouched) — a hygiene tool,
  not required to free a slot.
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
`collection`, `enabled`, optional `maxRankPages`, `currency` — manually set, null until filled in,
see "Price & Currency" above). Manage `competitors[]` via `competitors.js` (note: `competitors.js`
doesn't currently prompt for `currency` on `--add` — hand-edit `config.json` for that field).

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

**Before a page ever counts toward Blocked/Partial below (added 2026-07-29):** `politeFetch()` in
`lib.js` now honors a `Retry-After` header (capped at 120s) when a 429's body says
`local_rate_limited` — Shopify's own rate-limit signature — waiting that long before the next
retry instead of the normal short backoff. Ported from Palantir after Scout's own fetches hit
this wall live; deliberately narrower than Palantir's version (which honors Retry-After on any
429/5xx, not just this specific signature) — see the Primer's Execution Log for the exact scoping
and a flagged, unresolved risk: honoring this can add up to ~360s per page in the worst case,
which the Primer entry shows could threaten Batch B's timeout margin if multiple competitors hit
it independently on the same run. If a batch times out or gets SIGTERM'd, check the console for
`[rate-limit]` lines first.

**Also before a page counts toward anything below (added 2026-08-05):** `politeFetch()` now
follows redirects itself, one paced hop at a time (`redirect: 'manual'`, capped at
`MAX_REDIRECT_HOPS = 5`), instead of via `fetch()`'s built-in `redirect: 'follow'` — ported from
Palantir's `81a258b` (2026-07-28). A bare-domain competitor config (no `www` — HausOfMode's is
one) hitting a `canonical_host_redirection` on every paginated request would, under the old
`follow` behavior, resolve invisibly inside a single `fetch()` call, unpaced and unlogged. No-op
for any competitor that never redirects. See the Primer's 2026-08-05 Execution Log.

1. JSON catalog + HTML rank (normal).
2. HTML rank only / catalog only (degraded — logged).
3. **Blocked** (e.g. Cloudflare 403/409/429 on page 1 — no usable data at all): never crashes the
   run. Flagged in both the Discord report and the Sheet (marker row keyed on handle
   `__blocked__`). A blocked week's snapshot is **not saved**, so the next successful week still
   baselines against the last good week.
4. **Partial** (a persistent 429/5xx/network wall hit *past* page 1, after some real data was
   already collected — e.g. Cloudflare bot-mitigation kicking in mid-crawl): distinct from both
   of the above. `scrapeBestsellerRanks()`/`fetchCatalog()` keep whatever they collected instead
   of discarding it, but `buildSnapshot()` marks the whole snapshot `partial: true` (tier string
   gets a `— PARTIAL (incomplete crawl)` suffix) rather than letting a truncated crawl pass as a
   clean, complete week. Handled the same way as a full block for safety: flagged in Discord, a
   `__partial__` marker row in the Sheet (real counts included, e.g. "448 ranked / 0 catalog
   before an early stop"), and the snapshot is **not saved** — a partial catalog would otherwise
   mislabel every not-yet-reached product as "Removed From Store" the next time a run reaches
   further. (Fixed 2026-07-17 — see the Primer's Execution Log. Before this fix, a mid-crawl wall
   was silently indistinguishable from Shopify signaling "no more pages," so a wall-hit crawl was
   reported as a complete, trustworthy week with no error surfaced anywhere.)
5. **Sort-suspect** (added 2026-08-05 — see the Primer's Execution Log): coverage is complete —
   catalog and rank scrape both succeeded — but `buildSnapshot()` believes the recorded rank
   *order* is wrong: it either lost `sort_by` to a redirect (`urlIntegrityFail`, exact) or
   correlates too strongly with a locale-aware alphabetical sort of the same titles
   (`detectAlphabeticalSort()`, checked against the full catalog AND bounded top-30/top-100
   prefixes as of a same-day follow-up fix — ρ≥0.90 or adjacent-pair-match≥0.90 on n≥15 ranked
   products in ANY window — a real bestseller order has no reason to resemble A-Z order).
   **CORRECTED 2026-08-05 (was wrong earlier the same day):** this was NOT a `sort_by` being
   "accepted and silently ignored." The actual root cause on HausOfMode was `extractGridHandles()`
   being an unscoped, page-wide regex that picked up a sitewide Cart Drawer upsell widget's ~50
   product links — present, identically ordered, on every page/sort/collection combination —
   ahead of the real collection grid in the page's byte order. The three-sort-value comparison
   that originally seemed to prove "sort_by ignored" was actually comparing that sort-independent
   widget against itself three times; it never touched the real grid at all, so it couldn't have
   shown anything about sort_by either way. **Fixed 2026-08-05 (later the same day):**
   `extractGridHandles()` now scopes to a known collection-grid container marker first
   (`id="CollectionAjaxContent"` and others), falling back to the old whole-page regex — unchanged
   behavior — when no marker matches or the scoped slice is empty, so an unfamiliar theme can
   never lose data, only lose the (already-broken) contamination. See the Primer's 2026-08-05
   Execution Log (both the correction entry and the grid-scoping-fix entry) for full detail.
   Handled like Partial, not Capped — flagged in Discord and a `__sort_suspect__` Sheet marker,
   snapshot **not saved**, even though it's coverage-complete: a "complete" week with the wrong
   order would silently corrupt week-over-week movers, which is worse than losing a week.

## Error handling

Per-competitor errors are caught and reported as a flagged section; one bad store never aborts the
others. Unrecoverable top-level errors exit non-zero (cron status reflects it).
