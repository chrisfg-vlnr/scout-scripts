# Scout Competitor Tracker Primer

*How the Scout agent and its Competitor Scaling Tracker work, for Chris's own reference and for
any future session. Scout is a fully isolated sibling agent to Palantir/Nica/CliveStaples/Ransom,
built for an external team, on Discord instead of Telegram. Built: 2026-07-14.*

---

## 1. Why Scout exists

The external team needed their own competitor bestseller-rank tracker. Sharing Palantir's would
have exposed CFNCS/MFEO internal data paths and credentials to outside users. Scout is a from-
scratch copy of the same proven logic (`~/scripts/competitor-tracker/`, run internally by
Palantir) — same fetch tiers, same metrics, same WoW-change convention — wired to its own
Discord bot, own Sheet, own Anthropic key, own scripts repo. **Zero overlap** with the internal
fleet except the Google service account (Sheets/Drive write access, scoped per-sheet by sharing
— not a credential boundary, so this doesn't expose anything).

## 2. The pattern: a full copy, not a shared codebase

Unlike MFEO (which parameterized CFNCS's existing scripts with a `--store` flag), Scout is a
**separate copy** of the tracker logic at `~/scripts/scout-competitor-tracker/` — deliberate,
because MFEO is Chris's own second store sharing the same trust boundary as CFNCS, while Scout
serves an external team that must never see CFNCS/MFEO's paths, credentials, or data. The two
codebases will drift over time; that's expected, not a bug to fix by re-merging them.

| File | Role |
|---|---|
| `index.js` | Weekly orchestrator (cron-only), self-delivers to Discord |
| `query.js` | Zero-token ad-hoc query layer — Scout's only way to answer Discord questions about data |
| `competitors.js` | Add/enable/disable competitors — Scout's only way to change what's tracked |
| `lib.js` | Shared fetch/scrape/metrics brain, byte-identical logic to the CFNCS original |

## 3. What changed from the CFNCS original (and why)

| CFNCS original | Scout | Why |
|---|---|---|
| Telegram self-delivery, hardcoded bot token in `index.js` | Discord self-delivery, token from gitignored `discord-token.json` | Discord instead of Telegram; also **fixes a pre-existing issue** — the CFNCS original's Telegram token is committed in plaintext in `palantir-scripts`' git history (commit `3ff5512`, still live on GitHub). Not replicated. |
| Chunked at 3800 chars | Chunked at ~1900 chars | Discord's hard message cap is 2000 vs. Telegram's ~4096 |
| HTML `<b>` tags, `esc()` | Markdown `**bold**`, `mdEscape()` | Discord uses markdown, not HTML `parse_mode` |
| No cap on `--add` | Hard cap (15) + 60s cooldown, enforced in `competitors.js` | Scout is exposed to an external, untrusted Discord channel; `--add` does live fetches against an arbitrary caller-supplied domain from the VPS. Not present in the internal version because Palantir's Telegram group is trusted CFNCS staff only. |
| N/A | Full `AGENTS.md` prompt-injection-defense section | Same reason — untrusted external channel |

Nothing else changed. `lib.js` (the actual fetch/scrape/WoW-metrics logic) and `query.js` are
byte-for-byte copies — same Tier 1/2/3 fallback behavior, same junk-handle filtering, same
multi-week signal computation, same locked WoW sign convention
(`WoW = This Week Rank − Last Week Rank`, negative = scaling up).

## 4. Credentials & resources

| Thing | Value |
|---|---|
| Discord bot | Application `1526526478072811540`, scoped to guild `748794747749007421`, channel `1526532157802025030` only. `dmPolicy: disabled`, `groupPolicy: allowlist` (not `open` — see §6). |
| Discord token | `~/scripts/scout-competitor-tracker/discord-token.json` (gitignored) + `channels.discord.accounts.scout.token` in `openclaw.json` (plaintext, matching every other agent's Telegram token convention there — that file isn't git-tracked) |
| Anthropic key | Auth profile `scout`, agent-scoped SQLite store `~/.openclaw/agents/scout/agent/openclaw-agent.sqlite`. Verified live via `openclaw models status --probe --agent scout`. Confirmed invisible to clivestaples/palantir/nica/ransom and vice versa. |
| Model | `anthropic/claude-sonnet-4-6` (same as the rest of the fleet — "Sonnet 5" doesn't exist in this gateway's model catalog as of 2026.6.9, even unfiltered; revisit if the anthropic-provider plugin's catalog is ever refreshed) |
| Google Sheet | `1tdrGptnfwNwrsdZHVt_ASSSvNYgZkPu2dJENS8OTajo` ("Scout Competitor Scaling Data") — separate sheet from CFNCS's `1e6KWv1xE93tCYKRR4lqCLwtKlKmEYKG418NhOJFW2rw` |
| Google service account | `palantir-bot@agents-489207.iam.gserviceaccount.com`, creds `/home/chris/scripts/google-service-account.json` — **the one intentionally shared resource** |
| Scripts repo | `~/scripts/scout-competitor-tracker/` — own git repo `scout-scripts`, nested under `~/scripts/` but separate from the `palantir-scripts` repo that lives there, same pattern as `~/scripts/ransom/` and `~/scripts/nica/`. **Remote not yet created** — `gh` isn't installed on this box; needs Chris to create `chrisfg-vlnr/scout-scripts` (empty repo) before the first push. |
| Workspace | `~/.openclaw/agents/scout/workspace/` — own repo, auto-created by `openclaw agents add` |

## 5. Cron

`scout-competitor-tracker-weekly` — Monday 10:30 AM Manila (30 min after CFNCS's own
`competitor-tracker-weekly`, avoiding same-minute overlap — not a hard requirement), `--command`,
zero model tokens. `--no-deliver` — the script self-delivers to Discord directly via the REST API
(mirrors the CFNCS original's reasoning: cron run status should reflect the script's real
success/failure, not delivery plumbing, working around a documented platform quirk where
announce-delivery status doesn't always reflect real script outcome). On failure, the cron job's
native `--failure-alert-*` config DMs Chris on Telegram — riding the **existing Palantir Telegram
account** for that one outbound alert (verified: it's the account that successfully reaches
Chris's DM, confirmed via `palantir-new-month-prep`'s config). This is a one-way outbound
notification only, not a credential share — Scout never gains any Telegram credential of its own.

## 6. Discord config — corrections found during build (worth knowing if this ever needs debugging)

The Discord plugin (`@openclaw/discord@2026.6.9`, installed fresh for this build — wasn't bundled
before) wasn't fully documented accurately on `docs.openclaw.ai` as of this build. Two things
were verified against the plugin's actual compiled source instead of trusting docs:

1. **`groupPolicy: "allowlist"` scoped to one guild + one channel means every message from
   anyone in that channel is processed — no separate user-level allowlist required.** The
   plugin's `isDiscordGroupAllowedByPolicy()` gate only checks guild/channel scoping; a "no user
   allowlist" warning exists in the plugin's own security-audit code but only fires for Discord
   *slash commands* (which Scout doesn't use), not regular messages.
2. **The per-channel schema key is `enabled`, not `allowed`** — the docs (and a first attempt at
   this config) got this wrong; `openclaw config validate` caught it immediately.

Config lives in `openclaw.json` → `channels.discord.accounts.scout` (per-account `guilds`/
`groupPolicy`/`dmPolicy`, not top-level — Scout is a named, non-default account, and this plugin
resolves `guilds` from `accounts.<id>.guilds` for any non-default account).

## 7. Seed competitors (2026-07-14)

Added via `competitors.js --add`, live tier-detection run against each:

| Name | Domain | Result |
|---|---|---|
| NouveauRiche | nouveauriche-official.com | ⛔ Tier 3 (Blocked) at add-time (JSON HTTP 500, HTML HTTP 429). Kept enabled as a standing blocked check per the tracker's normal fallback behavior. On the first real weekly run it actually returned data (Tier 2, 585 ranked) — this site is simply flaky/inconsistent, not permanently dead; expect it to bounce between working and blocked. |
| ByEmiliaRose | byemiliarose.com | ✅ Tier 1+2 at add-time — full catalog (1366 products) + rank, 100% coverage |
| Feanatic | feanatic.com | ✅ Tier 1+2 at add-time — full catalog (3208 products) + rank, 100% coverage |

**Note on the first real weekly run (2026-07-14):** ByEmiliaRose and Feanatic both came back
BLOCKED (HTTP 429) on that run, despite working fine at add-time. This was self-inflicted by
testing, not a real fault: both sites got scraped in full three times within about an hour
(baseline capture at add-time, a manual `--no-discord` verification run, then the cron test
itself) — a much tighter cadence than the intended weekly one, and plausibly enough to trip a
legitimate rate limiter. The code handled it exactly as designed either way: no crash, no
snapshot overwrite, existing product rows preserved in the Sheet, a single blocked-marker row
added, clearly flagged in Discord. If this shows up again on an actual Monday run (a full week
apart, not back-to-back testing), it's worth a real look — but the first occurrence has an
obvious, benign explanation.

## 8. Isolation — what was actually verified, not just designed

- `openclaw models auth list --agent <id>` run against all 5 agents (clivestaples, palantir,
  nica, ransom, scout) — `scout` profile appears only in Scout's own store, no cross-visibility
  either direction.
- No `agentRuntime` override anywhere in Scout's config (the exact pattern that caused the
  June 30 CliveStaples 18-hour outage documented in `CLAUDE_CODE_ORIENTATION_BLOCKS`) — model is
  a plain string, same as every other agent.
- `tools.deny: [sessions_yield, agent_to_agent, browser, canvas]` and `tools.fs.workspaceOnly:
  true` on Scout's `agents.list` entry — can't spawn/hand off to other agents, can't browse the
  filesystem outside its own workspace via file tools.
- `heartbeat.every: "0m"` explicitly set — without this, Scout would have silently inherited the
  fleet default (2h heartbeat targeting CFNCS's internal Telegram group).

## 9. Discord channel permission — found and fixed during build

The bot was correctly invited to the "607 Media" guild (confirmed via the Discord API), but
posting to `#competitor-tracker` initially failed with `403 Missing Access`. Root cause: that
channel's permission overwrites deny `@everyone` by default and had no role-based allow entry
covering Scout's bot — being in the guild isn't the same as having access to every channel in it.
Confirmed via `GET /guilds/<id>/channels` (the channel's `permission_overwrites` showed a deny on
the `@everyone` role, id == guild id, with no allow for any role the bot holds). This needed a
Discord-side fix (granting the bot View Channel + Send Messages on that specific channel) — not
something fixable from the OpenClaw config side. Fixed same day; full send + read access confirmed
working after.

**If Scout ever goes silent in Discord again, check this first** — `openclaw channels status
--probe` will show the account as "connected"/"works" even when a specific channel is denying
access, since that's a per-channel Discord permission, not a gateway/plugin connectivity issue.
The gateway-level check won't catch it; a real send attempt (or `openclaw message send`) will.

## 10. End-to-end test results (2026-07-14)

- **Weekly cron run (real, via `openclaw cron run <id> --wait`):** exit 0, completed in ~4.3 min,
  Sheet tabs created/updated correctly for all 3 competitors, Discord report delivered — 5 clean
  messages (header + 3 competitor reports), correct markdown formatting, correct BLOCKED flagging
  for the two rate-limited sites (see §7 note above).
- **Sheets path (isolated verification via `--no-discord`):** confirmed independently before the
  full cron test — created the ByEmiliaRose tab, wrote 1366 rows correctly, right "first snapshot"
  messaging.
- **Auth isolation:** cross-checked `openclaw models auth list --agent <id>` against all 5 agents
  — zero cross-visibility either direction. Diffed `openclaw.json` before/after the `scout` key
  registration: `agents.defaults.models` unchanged (`{}`, no leak like the Ransom incident);
  `auth.order.anthropic` gained `"scout"` at the front (matches the already-documented,
  accepted, name-only accumulation pattern — no secrets in that list); all 4 other agents'
  `agents.list` entries byte-identical, unchanged.
- **Discord conversational Q&A path:** ✅ exercised for real, same day. Chris asked "What's the
  latest on ByEmiliaRose?" and "How many products is Feanatic tracking right now?" — Scout
  correctly called `query.js --summary` for each and relayed the real numbers (1366/1366 for
  ByEmiliaRose; 3202/3208 for Feanatic), confirmed against the session JSONL
  (`~/.openclaw/agents/scout/sessions/a9d3d8c1-...jsonl`) — the tool calls were exactly
  `query.js`, not a raw snapshot read. See §12 below for a real bug this same conversation
  surfaced and how it was fixed.

## 11. A real bug found via the Discord test, and the fix (2026-07-14)

Chris followed up: *"wait feanatic is blocked tho. what 3,202 are you talking about."* — because
the Sheet's Feanatic tab showed only a `⚠️ BLOCKED` marker row, while Scout had just reported
3,202 ranked products. Scout's reply asserted Feanatic's "last run... came back as Tier 1+2 — not
blocked," which was wrong: the most recent `index.js` run (the manual cron test) genuinely had
been blocked (HTTP 429, from repeated testing against the same site in under an hour — see §7).

**Root cause:** `competitors.js --add` only ever saved its baseline snapshot to local disk, never
to the Sheet. The Sheet tab for a freshly-added competitor doesn't get created until the *next*
successful `index.js` run. Here that next run was blocked, so the Sheet's first-ever write for
Feanatic was *only* the blocked marker — while `query.js` (reading the good local baseline from
add-time) kept reporting real data. Both answers were individually accurate; they were reading two
data surfaces that had diverged, and Scout's phrasing papered over that instead of surfacing it.

**Fixed same day:**
1. Moved the Sheet-writing logic (`getSheetsClient`, `writeCompetitorTab`) from `index.js` into
   `lib.js` so both scripts share it — no duplicated code.
2. `competitors.js --add` now writes its baseline straight to the Sheet on success (non-fatal if
   it fails; local snapshot is already saved regardless, and it'll sync on the next weekly run).
3. Fixed the actual bad Sheet state this had caused: reran the write path directly against
   Feanatic's already-saved local snapshot — Sheet now shows the real 3,208 rows, with the
   original blocked-marker row correctly preserved as history (upsert-by-handle keeps it, doesn't
   erase it — it's genuine history: one attempt on that date was blocked).
4. `competitors.js --list`'s misleading `last run:` label renamed to `last successful snapshot:`,
   with a code comment explaining exactly what it does and doesn't tell you.
5. Added an explicit instruction to Scout's `AGENTS.md`: if someone pushes back that the data
   looks wrong, don't assert a competitor "isn't blocked" from `query.js` alone — state what's
   actually known (the last successful snapshot) rather than implying it reflects the most recent
   attempt.

**Residual limitation, not fixed (documented, not built out further):** this closes the gap for a
*newly-added* competitor. For an *already-established* competitor, a blocked run still isn't
recorded anywhere Scout's tools can see (still never saved locally, by design, so it can't clobber
good history) — so the same kind of confusion could still happen on a later run, just not from
this exact cause anymore. A full fix would mean `index.js` writing a separate `lastAttempt`
status to `config.json` on every run, blocked or not — judged not worth the added complexity
right now; the Sheet's `__blocked__` marker row's `Last Updated` date is the ground truth if this
ever needs checking by hand.

Full detail, including the exact code diff reasoning: `SKILL.md` → "Sheet sync on add" section.

## 12. What's NOT done yet

- **Git remote for `scout-scripts`** — deferred by Chris's explicit choice (not a hard blocker):
  `gh` isn't installed on this box, and rather than install it or have Chris create the repo
  mid-session, the decision was to hold off. Local commits are done and safe either way; create
  `chrisfg-vlnr/scout-scripts` (empty repo) and push whenever it's actually wanted.

## 13. Execution Log
*(Claude Code appends a dated entry here after each session on this project — status/results
only, never credential values. Append, don't rewrite.)*

**2026-07-17 — Drune 448-product ceiling: investigated, root-caused, fixed:**
- **Symptom:** Drune (`drune.de`) tracked at only 448 ranked products while PPSpy showed
  Shopify's `25001` pagination-cap sentinel (real catalog >25,000, exact size unknown). The
  Jul 16 snapshot showed `blocked: false, error: null, tier: "Tier 2 (HTML rank only)"` — looked
  like a clean, complete run.
- **Investigation session (read-only, live curl tests from this VPS, no code changes):**
  confirmed `/collections/all/products.json` (the endpoint `fetchCatalog()` actually calls, not
  the top-level `/products.json`) returns 500/429; `/sitemap.xml` serves a Cloudflare JS
  managed-challenge page, not real XML; and within ~10 test requests over ~2 minutes, Cloudflare
  escalated to a blanket `cf-mitigated: challenge` across every endpoint on this domain,
  including one that started out clean. The `server-timing` header exposed our own ASN
  (`asn;desc="141995"`, Contabo) — consistent with Cloudflare bot-mitigation scoring this VPS's
  traffic on datacenter/ASN reputation, not just request rate.
- **Root cause confirmed in code:** `scrapeBestsellerRanks()` in `lib.js` only treated HTTP
  403/409/401/430 as `blocked`. It never checked 429, 5xx, or `politeFetch()`'s
  retries-exhausted sentinel (`status: null`). Past page 1, any such failure fell into the
  `!r.ok || !r.text` branch, which just did `break` with no error and no blocked flag — making a
  mid-crawl Cloudflare wall silently indistinguishable from Shopify signaling "no more pages."
  `fetchCatalog()` (the JSON-catalog function) already handled this correctly, which is exactly
  why `catalogCount: 0` was honestly reported while the rank scrape's 448 was not.
- **Fix (this session, no live drune.de calls — verified via a synthetic fetch-mock harness,
  6/6 scenarios passing):**
  1. `scrapeBestsellerRanks()` now returns a new `partial` field: `true` when a page past page 1
     hits `status: null` (persistent 429/5xx/network, retries exhausted) — distinct from
     `blocked` (page 1 fails outright, or an explicit 403/409/401/430). Partial data collected
     before the wall is kept, not discarded.
  2. `buildSnapshot()` surfaces `out.partial`, appends `— PARTIAL (incomplete crawl)` to the
     tier string, and records which side(s) hit a wall — without discarding real rows collected
     (Drune-shaped case: catalog blocked + ranks partial → still real product rows, not the
     "no data at all" Tier 3 state).
  3. `index.js` and `competitors.js --add` both now treat `partial` the same as `blocked` for
     baseline-persistence safety (never saved as the trusted baseline — a partial catalog would
     mislabel every not-yet-reached product as "Removed From Store"/"New This Week" the next
     time a run reaches further), but surface a distinct, more informative `__partial__` Sheet
     marker and Discord line (real counts included) rather than the generic BLOCKED marker.
  4. `SKILL.md`'s "Fallback tiers" section updated with a new tier 4 (Partial) entry.
- **Verification method:** synthetic `fetch` mock (no network calls) exercising normal-complete-
  crawl, mid-crawl-wall, page-1-block, and explicit-403 scenarios, plus a Drune-shaped
  `buildSnapshot()` case — all passed. Explicitly did NOT run against the live (still
  rate-limited) `drune.de` this session, per instruction.
- **Not yet done:** real-world confirmation on the next scheduled Monday cron run (or whenever
  Chris manually triggers one after enough cooldown) — Chris's call on timing, not this session's.
  Drune's *true* catalog size is still unknown either way; this fix only stops the tracker from
  silently mis-reporting a wall-hit as a complete week — it doesn't get past Cloudflare's
  mitigation itself.

**2026-07-20 — Monday cron SIGTERM'd + 3 domains failing: investigated, root-caused, fixed:**
- **Symptom:** The 10:30 AM Manila weekly cron was killed by SIGTERM ~15.6 min in (3/8
  competitors done). Two manual Discord-triggered reruns recovered HausOfMode, LozendaFashion,
  Gartenort, but NouveauRiche, BelroShop, and Drune kept failing all day.
- **Root cause 1 — the cron kill was NOT a timeout:** the run died at 937.9s, matching neither
  `timeoutSeconds` (2400) nor `noOutputTimeoutSeconds` (1200). The gateway itself was restarted
  at 04:45:37 CEST (config change + systemd restart; a second restart at 08:48 CEST was the
  2026.7.1 upgrade). systemd `KillMode=control-group` kills every child in the cgroup, including
  a mid-flight tracker run. Environmental — a gateway restart during a run will always kill it.
- **Root cause 2 (latent) — 2400s was too small anyway:** 8 competitors (BelroShop alone is
  ~4,500 products / ~200 requests) now need ~35–50 min. The job would have started dying at the
  40-min cap within weeks regardless. Fixed: per-job `timeoutSeconds` raised to **5400** via
  `openclaw cron edit` (job-scoped only, nothing global).
- **Root cause 3 — manual reruns used a different, fragile path (H2 confirmed):** Scout ran raw
  background execs of `index.js` instead of the registered job. One rerun (started 06:26 UTC)
  was killed invisibly by the upgrade restart's cgroup kill; its exec session vanished
  ("No session found"). Worse, a probe of `node index.js --help` silently launched a FULL
  8-competitor run (unknown flags were ignored by the arg parser) whose `sh` wrapper was killed
  at its 10s exec timeout while the node grandchild survived as an orphan — file mtimes show it
  re-scraping ByEmiliaRose (07:36:43 UTC) and Feanatic (07:43:00 UTC) invisibly, overlapping the
  second manual rerun.
- **Root cause 4 — BelroShop's failure was self-inflicted (H3 confirmed):** it completed cleanly
  on 2026-07-16 (4,506/4,509 ranked). On 2026-07-20 it was crawled or part-crawled ~5×, twice
  CONCURRENTLY (the orphaned accidental run + the sequential `--only` rerun, ~07:40–08:00 UTC)
  → persistent 429 wall → every attempt failed. Expected to recover on the normal weekly cadence.
- **NouveauRiche = genuinely blocked (new since 2026-07-16):** live polite test this session:
  `products.json` → HTTP 500 (instant, empty body), best-selling HTML → HTTP 429 with
  `cf-mitigated: challenge` (Cloudflare, same ASN-reputation pattern as Drune). Predates today's
  retries — not self-inflicted, not fixable script-side. Tier 3 flow reports it correctly
  (Sheet `__blocked__` marker written ✓). Last good snapshot 2026-07-14.
- **Drune = genuinely blocked (known since 2026-07-17):** unchanged; today's repeat attempts
  only fed its escalation. Last good (partial-quality) snapshot 2026-07-16.
- **Fixes shipped this session (all Scout-scoped):**
  1. Cron job payload `timeoutSeconds` 2400 → 5400 (per-job edit; `noOutputTimeoutSeconds` 1200
     unchanged).
  2. `index.js`: unknown flags now hard-fail with a usage message (exit 1); `--help`/`-h` prints
     usage and exits — a bare typo can never again launch a full scrape.
  3. `index.js`: `.run.lock` concurrency guard (pid + start time; stale-pid detection; released
     on exit/SIGINT/SIGTERM; exit code 3 when a run is already live) — overlapping scrapes can
     no longer double-hammer a domain from this VPS.
  4. `lib.js` `fetchCatalog()`: a page returning no NEW handles now ends the crawl (mirrors the
     rank scraper's dup-page break) — closes an unbounded-loop hazard (up to 800 identical
     pages) on servers that ignore the `page` param. NOTE: Scout's lib.js is no longer
     byte-identical to the CFNCS original (which still has this latent hazard — flagged to
     Chris, not touched per isolation).
  5. `AGENTS.md` §3b + `TOOLS.md`: manual reruns now have exactly one sanctioned path
     (`openclaw cron run 34357ef3-6885-4d40-a406-b3b16a46a92e`), max one per day; never raw
     `node index.js`; never unverified flags; exit 3 = wait, don't delete the lock; blocked
     domains are findings to report, not bugs to retry.
- **Also observed:** the job's Telegram failure alert did not fire for the cron kill — the
  gateway process that would deliver it was itself the thing shutting down. Alert path left
  untouched by design (rides Palantir's account, one-way).
- **Verification (same session, 2026-07-20 ~20:26–21:17 Manila):** full end-to-end run through
  the registered cron job (`openclaw cron run … --wait`) → **status `ok`, exit 0, 51.2 min**
  (would have been killed at the old 40-min cap — the timeout raise was load-bearing, not just
  headroom). All 8 attempted; Discord report posted; `.run.lock` engaged and released cleanly.
  Results: ByEmiliaRose 1366 ✓, Feanatic 3263 ✓, **BelroShop 4504 ✓ (recovered after ~4.5 h
  cooldown — confirms self-inflicted)**, HausOfMode 13,931 ✓ (the giant — ~20 min alone),
  LozendaFashion 3020 ✓, Gartenort 445 ✓; NouveauRiche BLOCKED (500/429) and Drune BLOCKED
  (500/500), both reported via the Tier 3 marker flow as designed. Capacity note: at 8
  competitors a clean run is ~51 min; if the team grows toward the 15 cap (or adds another
  HausOfMode-sized store), the 5400s budget will need revisiting.

**2026-07-21 — 5 new baselines captured (4 team-added domains + CristalliSchwiiz), repo/primer housekeeping, 3 investigations (report-only):**
- **Baselines confirmed via query.js + direct Sheet API check (not just local file existence):**
  JenniferJohnCharleston (1,214 catalog, added + baseline by Scout live in Discord, sequential,
  generous timeout — followed the just-added AGENTS.md guidance correctly), BreuerMode (2,134,
  same), RisoraShop (2,174 — added by Scout but its Discord completion message was never sent,
  see Investigation C below), DriftAndTide (970 — its queued add silently never fired until
  Michel asked for confirmation 6.5h later, see Investigation C), and CristalliSchwiiz (19,183
  catalog / 9,596 ranked, captured this session in the background per the ≥1800s-timeout lesson
  from its earlier interrupted attempt — see finding below). All 5 Sheet tabs verified to exist
  with real, non-trivial row counts via a direct Sheets API read, not assumed from local files.
- **New finding — CristalliSchwiiz hit the global 800-page rank-scrape safety cap
  (`config.json` → `fetch.maxPagesSafety`) while still actively finding new products (page 800
  added 299 more ranked products in that single page-block, no slowdown).** Result: 9,596 ranked
  / 19,183 catalog = 50% coverage — flagged by the *existing* <60%-coverage warning in the
  Discord report/Sheet, but that warning's wording ("store may hide products from HTML") is
  misleading here; the real cause is the page cap, not the store. `competitor.maxRankPages` is
  already a supported per-competitor override field in `lib.js` (used by `--max-rank-pages`),
  just not set for CristalliSchwiiz. This is the first competitor to ever hit the cap — its
  best-selling grid is roughly 3× sparser than HausOfMode's (~12 net-new ranked/page vs. ~35).
  **Not fixed this session** (needs a real decision: raise the global cap, set a per-competitor
  override, or add a distinct "capped" flag mirroring the existing blocked/partial distinction) —
  reported to Chris for a call, per the same report-don't-silently-fix pattern as the two
  investigations below.
- **Repo/primer housekeeping:** `chrisfg-vlnr/scout-scripts` remote does not exist yet on GitHub
  (SSH auth confirmed working — same key as `palantir-scripts` — but the repo itself was never
  created) — still pending Chris; nothing pushed. This primer file itself moved from `~/scripts/`
  (untracked, sitting inside the unrelated `palantir-scripts` repo by accident since build time)
  into `~/scripts/scout-competitor-tracker/` and is now version-controlled in `scout-scripts`;
  `AGENTS.md`/`TOOLS.md` path references updated to match.
- **Investigation A (report-only, zero edits to Palantir's files):** none of today's 5 Scout
  fixes are currently live hazards for Palantir's internal tracker (last 2 runs: 25.7 min and
  27.7 min, both clean, well under its own 2400s timeout) — but the unknown-flag hard-fail and
  `fetchCatalog()` dup-page-break hazards are confirmed present in Palantir's code identically to
  Scout's pre-fix state, recommended as cheap zero-risk ports regardless of urgency. The timeout
  headroom fix is a ticking clock — Palantir is already at Scout's pre-incident competitor count
  (8). The `.run.lock` guard and rerun-policy doc matter less for Palantir since its real-world
  usage (trusted internal Telegram staff, `cron run --wait` already the established manual-rerun
  convention per its own AGENTS.md) is inherently safer than Scout's external-Discord exposure.
  Also flagged: Palantir's config has `driftandtide.com` as `enabled: true` (not disabled, correcting
  the task's premise) — same domain (minus `www.`) just added to Scout, worth Chris confirming
  it's an intentional overlap with the team, not a mix-up. Not implemented — Chris's call.
- **Investigation B (report-only, options not weighed against each other):** at 13 competitors
  (≥51,500 combined catalog vs. today's 8-competitor 26,544), a naive extrapolation of today's
  51.2-min run lands close to or past the current 5400s budget — and CristalliSchwiiz's own
  ~29-min capture (19,183 catalog, sparse grid) is a live data point supporting that. Laid out 3
  real options: keep raising the single job's timeout (simplest, no scaling fix), split into
  staggered cron jobs (bounded per-job runtime, needs real code changes — per-batch lock paths,
  a group selector, a "batch N of M" report header), or restructure for concurrency across
  different domains (only option that shrinks total time, biggest code change, but a materially
  different — and safe — kind of concurrency than what caused today's incident, since it's
  across different domains rather than repeat hits on the same one). Not implemented.
- **Investigation C (report-only, prompted mid-session by Chris's build-partner in the other
  Claude chat):** confirmed via full-text session review that (1) Scout never sent a Discord
  completion message for RisoraShop or DriftAndTide — the channel saw "adding it now" then
  silence for 6.5 hours, indistinguishable from failure — while JenniferJohnCharleston and
  BreuerMode both got correct done-confirmations, so this is inconsistency (dropped only when a
  new request interrupted the poll loop before the done step), not a missing capability; and (2)
  Scout explicitly stated a commitment it had no mechanism to keep — *"I'll do risora →
  driftandtide in order"* — while having no heartbeat (`every: "0m"`) and no persistent task
  queue across idle gaps. DriftAndTide only got added because Michel happened to ask for
  confirmation later; if he hadn't, it simply would never have been added despite Scout's stated
  plan. Proposed AGENTS.md language drafted (a new "never imply follow-through you can't
  guarantee" section) but **not applied** — for Chris and the build-partner to review/edit first.

**2026-07-21 (later) — Implemented four decided fixes: capped coverage, follow-through rules, Palantir port, staggered batches:**
- **CristalliSchwiiz page-cap coverage (P1):** its 2026-07-21 baseline had come back 50% (9,596/19,183
  ranked) because the rank scrape silently hit the global 800-page `maxPagesSafety` cap while still
  finding products. Fix: `lib.js scrapeBestsellerRanks()` now returns a distinct `capped` flag (loop
  exhausted its page budget with the last page still productive — separate from `blocked`, `partial`,
  and a clean natural end); `buildSnapshot()` adds a `— CAPPED (…)` tier suffix; the Discord/Sheet
  report now says "hit the N-page cap … raise this store's page cap" instead of the misleading "store
  may hide products from HTML." A capped snapshot **is** saved as baseline (unlike partial — the
  catalog fetch is complete, so no removed/new mislabeling risk; the data is real, deterministic
  top-N). Set `CristalliSchwiiz.maxRankPages = 2000` (sized from real density ~12 ranked/page →
  ~1,599 pages for full coverage + ~25% margin). **Recaptured & verified: 19,179/19,183 = 99.98%,
  natural-end at ~1,600 pages, `capped:false`, Sheet 19,185 rows.** Capped-vs-natural-end logic also
  unit-tested with a fetch mock.
- **Investigation C follow-through rules (P2):** `AGENTS.md` §2b (two literal, non-judgment rules):
  (a) exactly one completion-or-failure message per add/baseline started — no exceptions; (b) never
  imply follow-through beyond the current turn (no heartbeat, no persistent queue). Both trace to the
  2026-07-20/21 add incidents (RisoraShop/DriftAndTide finished silently; "I'll do risora →
  driftandtide in order" left driftandtide unadded 6.5 h).
- **Palantir port (P3, read+backup+diff-verify, committed in palantir-scripts):** ported the four
  zero-behavior-change guards to `~/scripts/competitor-tracker/` — unknown-flag hard-fail + `--help`,
  `.run.lock` concurrency guard, `fetchCatalog()` dup-page break; cron `timeoutSeconds` 2400→3600
  (sized to Palantir's real ~26–28 min runs, NOT copied from Scout — Palantir has no 14k–19k monster
  stores). Verified on one small competitor with no production side effects (no Telegram/Sheet post).
  Telegram token left untouched (known pre-existing issue, out of scope). `driftandtide.com` noted in
  both trackers' docs as an intentional Palantir/Scout overlap (Chris-confirmed), not a mix-up.
- **Staggered weekly batches (P4):** at 13 competitors a single run is ~2 h (CristalliSchwiiz alone is
  ~60 min at 2,000 pages). Split into two cron jobs by a per-competitor `batch` field via `--group`:
  **Batch A** (job `34357ef3-…`, Mon 10:30 Manila, 5400s) = CristalliSchwiiz, ByEmiliaRose, Gartenort,
  DriftAndTide, NouveauRiche; **Batch B** (job `05acdb9e-…`, Mon 12:00 Manila, 5400s) = HausOfMode,
  Feanatic, BelroShop, LozendaFashion, RisoraShop, BreuerMode, JenniferJohnCharleston, Drune. New
  flags: `--group`, `--include-ungrouped` (Batch B catch-all so a new competitor is never silently
  skipped; `competitors.js --add` also auto-tags `batch:"B"`), `--wait-for-lock N` (a slightly-
  overrunning batch waits rather than exit-3; manual runs still fail fast — tested both ways against
  a live lock). Each batch self-delivers its own "Batch A/B" Discord report (delivery `none`, matching
  failure-alerts). BelroShop is in Batch B (12:00), clear of Palantir's Belro scrape at 10:00.
  **Verified Batch B end-to-end through the real registered cron job: status ok, 61.2 min, all 8
  attempted (7 clean + Drune blocked-genuine), Discord report delivered.**
- **Runtime note / open watch-item:** Batch B's real measured runtime was **~61 min** (higher than the
  ~48 min estimate — mid-size stores at 1–2 s/page add up). Its timeout was bumped 4200→**5400s** to
  match Batch A after this measurement (~29 min margin). If Batch B's list grows, rebalance a store to
  Batch A or add a Batch C rather than just raising the timeout again.
- **Minor pre-existing data-quality note (not fixed, out of scope):** CristalliSchwiiz's #1/#2
  "best-sellers" are protection/insurance upsells ("Pakket Bescherming", "Sicherheitspaket") that
  slip past `junkHandlePatterns` because those patterns are English-only and this store uses
  Dutch/German handles. Affects any non-English store's top ranks cosmetically — worth a follow-up if
  Chris wants localized junk patterns.

**2026-07-21 (later still) — Batch A end-to-end verification + a BIGGER root-cause finding (auth-reload restarts):**
- **Batch A completed OK through the real cron job:** status `ok`, 36.5 min, all 5 attempted, "Discord
  report sent". (The `openclaw cron run --wait` CLI returned exit 1 with a GatewayTransportError, but
  that was the CLI's polling socket dropping when the gateway restarted **1 second after** the job
  finished — not a job failure. Always confirm via `cron runs --id` diagnostics, not the --wait exit.)
- **BUT the run was polluted by self-inflicted 429 rate-limiting** from repeated same-night scraping
  (verification hit these domains 3–4× in a few hours): NouveauRiche PARTIAL (429 wall p3),
  **ByEmiliaRose BLOCKED (429 — was clean the day before)**, Gartenort clean, **CristalliSchwiiz
  PARTIAL (429 wall at page 817, 51%)** vs. the clean 99.98% recapture an hour earlier, DriftAndTide
  clean. Lesson reaffirmed (same as 07-20 BelroShop): back-to-back same-day scrapes escalate 429
  walls. This is a testing artifact, NOT a Monday-schedule problem (weekly cadence won't do this).
- **The capped-vs-partial distinction worked correctly under fire:** CristalliSchwiiz's 429 wall at
  page 817 was flagged **PARTIAL** (a real rate-limit wall — `status:null` retries-exhausted), NOT
  `capped` (which is only a clean 200 at the page-budget ceiling), and was **not** saved as baseline —
  so the good 99.98% recapture snapshot was preserved intact (verified: `partial:false capped:false`
  on disk). Exactly the designed behavior.
- **Runtime caveat:** the 36.5-min figure is an UNDER-estimate because CristalliSchwiiz was cut short
  at page 817 by the 429 instead of running its full ~1,600 pages. A HEALTHY Batch A ≈ ~64 min
  (recapture's clean ~57-min CristalliSchwiiz + ~5 min for the small stores), comfortably inside the
  5400s (90-min) budget (~26 min margin). A clean full-runtime measurement should come from Monday's
  real run or a re-run after the domains cool off — not from more same-night scraping.
- **⭐ ROOT CAUSE FINDING (the real recurring one, bigger than batching/timeout/lock):** the gateway
  restart that grazed this run — AND the original 07-20 incident — is triggered by **Anthropic
  auth-config reloads** (`auth.order.anthropic` / `auth.profiles.default` / `models.providers.anthropic`
  — consistent with periodic OAuth token refreshes rewriting the config). OpenClaw's reload logic DOES
  try to protect an in-flight run — it detected the batch-A cron task and **deferred** the restart,
  re-checking every 30s — **but caps the defer at ~2 min**, then restarts anyway (SIGUSR1 → full
  process restart → cgroup SIGTERM kills the child scrape). Observed reloads: 07-20 07:48 CEST
  (13:48 Manila), 07-21 09:00 CEST (15:00 Manila) — both ~daily and both AFTER the 10:30–13:00 Manila
  batch window (mildly reassuring, but only 2 data points). **This is NOT fixable in Scout's scripts** —
  it's OpenClaw platform behavior. A real fix is Chris's call: e.g. pin/settle Anthropic auth so it
  doesn't rewrite config mid-day, raise the reload defer window past a batch's runtime, run batches
  when reloads are unlikely, or make `--command` cron jobs survive a gateway restart. Scout's SIGTERM
  handler now at least releases `.run.lock` cleanly on the kill (no orphan — an improvement over 07-20),
  and `partial`/blocked handling means a killed run never corrupts a baseline.

**2026-07-21 (final) — Auth-reload restart root cause: investigated deeply, claude-CLI theory DISPROVED for this box (CORRECTS the entry above):**
- The entry above speculated the gateway restarts were "consistent with periodic OAuth token
  refreshes." A focused investigation this session **disproved that for this VPS** — do not chase the
  OAuth/claude-CLI theory here. Evidence:
  - **No Anthropic oauth / claude-CLI-reuse profile exists on this box.** `openclaw.json`
    `auth.profiles.default` is `{provider: anthropic, mode: api_key}` (static). `auth.order.anthropic`
    = `[default, anthropic:default, scout, anthropic:nica]` — all `api_key`. `openclaw.json` has zero
    references to `claude-cli` / `claudeAiOauth` / `~/.claude/.credentials.json`.
  - **Timestamps do NOT line up** (the decisive test). Restarts were 07-20 05:48 UTC and 07-21 07:00
    UTC. The 4 fleet agents' `auth-profiles.json` (static keys) are all mtime **2026-06-24** (a month
    old). This Claude Code session's own OAuth store (`~/.claude/.credentials.json`, an ~8 h-rotating
    "Claude Pro" login) mtime was **01:29 UTC** — 5.5 h off the 07:00 restart, unrelated to either.
    Every file written *around* the 07:00 restart (agent sqlites, device-auth, openclaw.json) was
    stamped 07:00–07:05, i.e. **after** the 07:00:08 trigger — startup re-init, not the cause.
  - The general GitHub pattern (Claude-CLI-reuse token rotation → "auth config changed" restart) is
    real, but **this box is already on the static-API-key setup those issues recommend as the fix** —
    which is exactly why there's nothing to rotate and the timing doesn't match.
- **What the evidence points to instead:** the restart is tripped by an `openclaw.json` config-save
  that re-serializes the auth block. Right before the 07:00 event the log shows a `models.authStatus`
  check → "Updated config … Auth profile: default (anthropic/api_key)". So the likely trigger is
  **OpenClaw's own periodic auth-status re-validation re-writing the config**, which the reload
  detector flags as `auth.profiles.default` / `auth.order.anthropic` "changed" — independent of any
  token. (A stale `.bak` diff reinforced this: a routine write there changed only an unrelated field,
  `nica-p2test tools.profile`, yet still re-serialized the whole auth block.)
- **Not fully pinned** (only 2 data points; exact internal trigger needs OpenClaw docs/source — not
  guessed from source per the suggestion rule). Deliberately did NOT run `openclaw models status
  --probe` to confirm live, because a `models.authStatus`/probe is plausibly the very thing that
  re-saves config and triggers a restart. **No fix applied** (timestamps disprove the theory; the
  default profile is already static — nothing to convert).
- **Applies fleet-wide, NOT just Scout:** any long-running `--command` cron is exposed, including
  Palantir's competitor-tracker (see its SKILL.md). The real levers are platform-side (extend
  OpenClaw's ~2-min restart-defer to actually wait for an active cron task, or make `--command` jobs
  survive a gateway restart) — Chris's call at the OpenClaw level.
