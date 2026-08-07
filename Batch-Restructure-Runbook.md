# Batch Restructure & Cap Raise (15→20) — Runbook

Started 2026-08-07 (Friday). Target: Monday 2026-08-10 run.

## Rollback point

- **Tag:** `pre-batch-restructure-and-cap-raise-20260807-082239` on commit
  `3545ce8283da420c9c77943fef3aae576aa22b42` (HEAD at session start — the HausOfMode
  baseline-recapture commit). Pushed to `origin`, round-trip-verified: local tag deleted,
  re-fetched fresh via `git fetch --tags --force origin`, resolved back to the same SHA.
- **Config backup:** `backups/config.json.20260807-082229.bak`, diff-confirmed byte-identical
  to the live `config.json` at session start.

### To roll back code/config to session start

```
git fetch origin
git reset --hard pre-batch-restructure-and-cap-raise-20260807-082239   # scout-scripts repo only
cp backups/config.json.20260807-082229.bak config.json                 # if config.json was hand-edited outside git (it isn't normally)
```

Cron jobs are **not** covered by the git tag — they live in OpenClaw's own store. See "Cron
rollback" below once the new jobs exist.

## Baseline state at session start (2026-08-07, before any change)

### Config: 15/15 enabled, batch assignment

| Competitor | Batch | maxRankPages | Last snapshot (date, catalog/ranked) |
|---|---|---|---|
| NouveauRiche | A | default | 2026-07-14, catalog 0 (JSON blocked), ranked 585 |
| ByEmiliaRose | A | default | 2026-08-03, catalog 1366 / ranked 1366 |
| Gartenort | A | default | 2026-08-03, catalog 448 / ranked 447 |
| CristalliSchwiiz | A | 2000 | 2026-08-03, catalog 19687 / ranked 19682 |
| DriftAndTide | A | default | 2026-08-03, catalog 947 / ranked 947 |
| Feanatic | B | default | 2026-08-03, catalog 3310 / ranked 3302 |
| BelroShop | B | default | 2026-08-03, catalog 4504 / ranked 4501 |
| HausOfMode | B | default | 2026-08-07, catalog 13875 / ranked 13871 (fresh clean baseline) |
| Drune | B | default | 2026-07-16, catalog 0 / ranked 448 (Cloudflare-blocked, Tier 3) |
| LozendaFashion | B | default | 2026-08-03, catalog 3058 / ranked 3057 |
| BreuerMode | B | default | 2026-08-03, catalog 2128 / ranked 2128 |
| RisoraShop | B | default | 2026-08-03, catalog 2172 / ranked 2172 |
| RedlichBecker | B | default | 2026-08-03, catalog 1990 / ranked 1990 |
| JesseLondon | B | default | 2026-08-03, catalog 892 / ranked 891 |
| LaLunaMelbourne | B | default | 2026-08-03, catalog 850 / ranked 849 |

`maxCompetitors: 15`, `addCooldownSeconds: 60`, both unchanged at this point.

### Cron jobs (full state, via fresh `openclaw cron get <id>` — not `cron list`)

**Batch A — `34357ef3-6885-4d40-a406-b3b16a46a92e`**
- schedule: `30 10 * * 1` @ Asia/Manila (Mon 10:30)
- command: `node /home/chris/scripts/scout-competitor-tracker/index.js --group A --wait-for-lock 600`
- timeoutSeconds: 7200, noOutputTimeoutSeconds: 1200
- failureAlert: telegram to 199254473 (palantir account)
- last run: 2026-08-03, status `ok`, lastDurationMs 3779796 (~63.0 min) — **pre-dates the
  redirect-port (`6f5d0dc`) and grid-scoping (`4dc5d03`) fixes, both shipped 2026-08-05.
  Not a reliable current-code number** — see Step 1 findings in the session report.

**Batch B — `05acdb9e-dae7-43b6-8fcf-7d0e87e41488`**
- schedule: `0 12 * * 1` @ Asia/Manila (Mon 12:00)
- command: `node /home/chris/scripts/scout-competitor-tracker/index.js --group B --include-ungrouped --wait-for-lock 1800`
- timeoutSeconds: 7200, noOutputTimeoutSeconds: 1200
- failureAlert: telegram to 199254473 (palantir account)
- last run: 2026-08-03, status `ok`, lastDurationMs 3836600 (~63.9 min) — same caveat as
  Batch A: pre-dates both fixes.

### Fleet cron picture (Monday, Asia/Manila) at session start

Storefront-scraping jobs (share the suspected IP-wide Shopify throttle surface):
- **10:00 Palantir `competitor-tracker-weekly`** (`67553e4c-…`) — Belro, HerSelected, DriftAndTide,
  BySeabourne, BarrettBay, Arlento, WiktoriaModa, DomSzyku. Last real duration 2110259ms
  (~35.2 min) → typically finishes ~10:35. **Overlaps Scout's old Batch A start (10:30) and
  shares a target (DriftAndTide) with it.**
- **10:30 Scout Batch A**, **12:00 Scout Batch B** (this session's subject).

All other fleet cron jobs (`conversion-prio-*`, `r2-tracker-*`, `ber-v2-daily-refresh`,
`palantir-shopify-revenue`, `google-ads-*`, `mfeo-ads-token-check`) call Shopify's authenticated
Admin API or Google Ads API against Chris's own stores, not public storefront scraping — a
structurally different rate-limit surface, believed not to share the anonymous-storefront
`local_rate_limited` throttle. Not independently verified script-by-script; flagged as reasoned
inference, not proof. `clivestaples` and `nica` have zero registered cron jobs
(`openclaw cron list --agent <id> --all`) — not a collision risk at all right now.

---

## New structure (applied 2026-08-07)

`maxCompetitors: 20`, `defaultBatch: "D"`. Four batches, all Monday, Asia/Manila:

| Batch | Job ID | Time | Timeout | Competitors |
|---|---|---|---|---|
| A | `34357ef3-6885-4d40-a406-b3b16a46a92e` (edited) | 08:00 | 10800s (3h) | CristalliSchwiiz only |
| B | `95657ebe-99b6-4266-80f2-f94f1ec14c04` (new) | 11:30 | 7200s | ByEmiliaRose, Gartenort, DriftAndTide, NouveauRiche |
| C | `faee47e1-a0fe-4d53-8d0f-57aa27528276` (new) | 13:30 | 7200s | Feanatic, BelroShop, HausOfMode |
| D | `05acdb9e-dae7-43b6-8fcf-7d0e87e41488` (edited, catch-all `--include-ungrouped`) | 15:30 | 7200s | BreuerMode, RisoraShop, RedlichBecker, JesseLondon, LaLunaMelbourne, Drune, LozendaFashion, TessaBayside |

All four verified via a fresh, separately-issued `openclaw cron get <id>` after every edit/create
(never inferred from the edit/create command's own output). Zero cron jobs were deleted — both
pre-existing jobs (`34357ef3`, `05acdb9e`) were repurposed in place, two new jobs created. This is
why advisor checkpoint 2 ("before deleting/replacing an existing cron job") never fired this
session — there was no delete or replace, only edits and additions.

## Rollback commands (post-implementation)

**Config + code (scout-scripts repo):**
```
cd ~/scripts/scout-competitor-tracker
git fetch origin
git reset --hard pre-batch-restructure-and-cap-raise-20260807-082239
```
This reverts `config.json`, `competitors.js`, `SKILL.md` to session-start state — including
`maxCompetitors` back to 15 and `batch` fields back to the old A/B split. It does **not** remove
TessaBayside (added after the tag) — `--disable "TessaBayside"` then `--remove "TessaBayside"`
separately if a full rollback including that add is wanted (its Sheet tab and snapshot would
survive that, per `--remove`'s own guarantee).

**Workspace docs (no remote — local revert only):**
```
cd ~/.openclaw/agents/scout/workspace
git log --oneline -5   # find the commit before this session's AGENTS.md/TOOLS.md edits
git revert <that-session's-commit-sha>   # or git reset --hard <sha-before> if no later commits depend on it
```

**Cron jobs (not covered by git — revert manually):**
```
openclaw cron edit 34357ef3-6885-4d40-a406-b3b16a46a92e --cron "30 10 * * 1" --timeout-seconds 7200 \
  --command "node /home/chris/scripts/scout-competitor-tracker/index.js --group A --wait-for-lock 600" \
  --description "Scout competitor tracker — BATCH A (CristalliSchwiiz, ByEmiliaRose, Gartenort, DriftAndTide, NouveauRiche). Mon 10:30 Manila. Self-delivers this batch's Discord report. \$0 tokens."
openclaw cron edit 05acdb9e-dae7-43b6-8fcf-7d0e87e41488 --cron "0 12 * * 1" --name "scout-competitor-tracker-weekly-batch-b" \
  --command "node /home/chris/scripts/scout-competitor-tracker/index.js --group B --include-ungrouped --wait-for-lock 1800" \
  --description "Scout competitor tracker — BATCH B (HausOfMode, Feanatic, BelroShop, LozendaFashion, RisoraShop, BreuerMode, JenniferJohnCharleston, Drune + any ungrouped). Mon 12:00 Manila, staggered 90m after Batch A. Self-delivers this batch's Discord report. \$0 tokens."
# Then disable the two new jobs rather than delete (safer, reversible):
openclaw cron edit 95657ebe-99b6-4266-80f2-f94f1ec14c04 --disable
openclaw cron edit faee47e1-a0fe-4d53-8d0f-57aa27528276 --disable
```

## What to check after Monday 2026-08-10's real run

For each of the four jobs, a **fresh** `openclaw cron get <id>` (not `cron list` — it doesn't
expose `timeoutSeconds`, and diagnostics need the real per-job detail):

- `lastRunStatus: "ok"` on all four. An `ok` status does **not** mean clean — always read
  `state.lastDiagnostics` too; a run that lost most competitors to 429s/500s still exits `ok`
  (this happened for real on 2026-07-27's Batch A).
- `lastDurationMs` per batch — this is the **first real current-code measurement** at the batch
  level (everything in this session's runtime table was either a single-store measurement
  extrapolated to other stores, or pre-dated the 2026-08-05 redirect-port/grid-scoping fixes).
  Compare against this session's planning figures: A ≈ 65–78 min clean, B ≈ 4–8 min, C ≈ 17–35
  min (upper-bound, HausOfMode-calibrated), D ≈ 9–19 min. A large deviation either way means the
  estimates need revisiting, not that something is broken.
- Per-competitor tier/coverage in the diagnostics summary — specifically whether BelroShop (Batch
  C) and DriftAndTide (Batch B) came back clean or hit 429s, since those are the two stores this
  session reasoned about explicitly for throttle exposure.
- HausOfMode specifically: `gridScoped: true` should persist; this is its first real
  cron-triggered run since the 2026-08-07 manual recapture.
- TessaBayside (Batch D): should show a normal WoW comparison against its 2026-08-07 baseline —
  first batch run it participates in.
- If any batch times out or gets SIGTERM'd: check the `[rate-limit]` console lines in its
  diagnostics per the 2026-07-29 primer entry, and re-derive whether the historical vs.
  current-code timing gap this session flagged was underestimated.
- **Cheap to revise:** if Batch C's margin (the tightest of the four at design time) looks thin
  in the real run, rebalancing one store to Batch D is a one-line `config.json` edit — no cron
  changes needed unless the schedule itself needs to move.
