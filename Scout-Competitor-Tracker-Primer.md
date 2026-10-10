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

**2026-07-29 — Live rate-limit probe (2 stores, mid-session for an unrelated price-column build)
reveals a possible IP-wide `local_rate_limited` throttle — read-only, no fix attempted:**
- **Context:** building a Price/Currency column feature (see the next entry below), two narrowly
  scoped live fetches were explicitly authorized to confirm the products.json schema. Both hit the
  same failure signature on two unrelated stores.
- **Requests made** (approximate timestamps — exact per-request times weren't individually logged;
  bounded by a `date` check at 09:06:58 CEST run between the gartenort and driftandtide attempts, and
  session time ~09:19 CEST):
  - `gartenort.de/collections/all/products.json` — **3 requests**, all before ~09:06:58 CEST.
    Attempt 1 → `HTTP 429`, body `local_rate_limited`. Attempt 2 → a **compliance error**: a
    headers-only probe (`curl -D -`) with the body routed to `/dev/null` came back `HTTP 200`, but
    produced no usable schema data since the body was discarded. Attempt 3 (re-authorized, body
    captured this time) → `HTTP 429`, body `local_rate_limited` again.
  - `www.driftandtide.com/collections/all/products.json` — **1 request**, shortly after 09:06:58
    CEST → `HTTP 429`, body `local_rate_limited`. Per instruction, no third store was attempted.
  - **Recorded honestly because it affects how to read this:** of gartenort's 3 requests, only #1 and
    #3 were within the single-request authorization; #2 was a self-inflicted deviation that also
    wasted itself by discarding the body. This inflates gartenort's touch count for the session from
    an intended 1 to 3 — it does not change the interpretation of the 429s, since both used the same
    minimal, correctly-paced single-page request.
- **Timing finding — normal weekly cadence was NOT enough cooldown this time, which is new:**
  gartenort's last successful touch (per local snapshot mtime) was **2026-07-27 09:17:15 CEST** — the
  first 429 today landed **under 48 hours** after that touch. Every prior self-inflicted 429 (BelroShop
  07-20, ByEmiliaRose/CristalliSchwiiz 07-21) involved multiple scrapes of the *same* domain within
  hours. This is the first time a *single* request, on a domain untouched for ~2 days, failed this
  way — consistent with an IP-level throttle (this VPS's outbound address) rather than a per-domain
  cooldown, though that's inferred from 2 data points on 2 domains, not confirmed.
- **Link to prior investigation:** the exact signature — HTTP 429, body `local_rate_limited` — is the
  same one Palantir's 2026-07-28 investigation already documented and built a fix for (see the
  read-only comparison entry immediately below).
- **Status: read-only. No fix attempted, no live retry, flagged for Chris.** Open question: is this
  the same recurring throttle Palantir already characterized, now also visible on Scout's traffic, or
  a separate escalation? Not established — would need either a natural cooldown + re-test, or checking
  whether Palantir's own tracker has hit this on its recent runs.

**2026-07-29 (same session) — Read-only comparison: does Palantir's lib.js handle `local_rate_limited`,
and would Scout's current code survive it on Monday's run? (no edits to either file, no network calls):**
- **Confirmed via direct code read:** Palantir's `politeFetchOnce()` (`~/scripts/competitor-tracker/lib.js`,
  ~lines 94–146) DOES honor `Retry-After` on a 429 whose body contains `local_rate_limited` — parses the
  header, caps it at `MAX_RETRY_AFTER_SECONDS = 120`, and waits that duration before the next retry
  instead of the fixed ~1.5s/attempt escalating backoff. Its comment cites 10+ live probes on
  2026-07-28 confirming a `Retry-After: 60` window genuinely clears once honored.
- **Scout's current `politeFetch()` (lib.js lines 74–104) has none of this** — fixed backoff only
  (`jitter + attempt*1500ms`), no `Retry-After` header read anywhere, no `local_rate_limited` body
  detection. After `maxRetries` (3 → 4 total attempts, well under 20s of total backoff) it gives up
  and returns `{status: null, ...}`.
- **Plain answer: YES, Palantir's version honors Retry-After on `local_rate_limited` (confirmed by
  direct read). NO, Scout's current code does not, and would not recover data from this throttle
  mid-run if it's still active** — it exhausts its short retries in well under 20 seconds, nowhere
  near the ~60s window Palantir observed, and marks the affected competitor(s) Blocked or Partial for
  that week instead. This is safe (no crash, no corrupted baseline — the existing partial/blocked
  design already prevents that) but not functional (no data recovered that week).
- **UNVERIFIED:** whether this specific throttle episode is still active by the next scheduled run
  (Monday 2026-08-03, Batch A 10:30 / Batch B 12:00 Manila) — only 2 data points ~13 minutes apart
  this session, no visibility into duration or decay.
- **Not implemented, not scoped beyond this comparison** — explicitly deferred to a separate
  follow-up session per instruction. Neither file was modified.

**2026-07-29 (same session) — Shipped: Price + Currency columns (Sheet + query.js), and fixed a
real Sheet-erasure bug found while building it:**
- **What shipped:** `Price` (first variant's price, Chris's call — D1) and `Currency` (manually-set
  per-competitor `config.json` field, not derived/converted — D2) appended as the 18th/19th Sheet
  columns. Surfaces: Sheet + `query.js` only, deliberately **not** Discord's weekly report (D3 —
  message chunking is already tight at ~1900 chars). Tier-2-only competitors (Drune, NouveauRiche)
  get permanently `null` price by design (D4 — no HTML price scraping built). Palantir port
  explicitly deferred (D5) — nothing touched in `~/scripts/competitor-tracker/`.
- **Schema verification blocked, documented, proceeded on documented contract:** the authorized
  live schema-check fetch hit the same `local_rate_limited` throttle described in the entry above
  (2 stores, both blocked) — implementation proceeded on Shopify's documented public `products.json`
  contract instead, flagged `UNVERIFIED-THIS-SESSION` in `lib.js`'s `selectPrice()` comment and in
  `SKILL.md`.
- **Currency fetch dropped entirely, not deferred** — re-reading D2 mid-session, currency was
  always a manually-set config value; the live fetch was only ever a convenience. `config.json` now
  has `"currency": null` scaffolded for all 14 competitors, with graceful-null handling everywhere
  it renders (blank Sheet cell; `query.js` prints `"(currency unknown)"` rather than a bare
  number — a price with no currency label could be misread as the wrong currency across a
  `.de`/`.com` mix of stores). Full list of competitors needing a real currency value was handed to
  Chris to fill in by hand.
- **Real bug found and fixed:** `writeCompetitorTab()`'s existing-row read range was a hardcoded
  `'A2:Q'` (17 cols), decoupled from `SHEET_HEADER.length`. Adding 2 columns without fixing this
  would have silently ERASED real Price/Currency values (not just left them blank) for any row not
  touched by the current week's `computeMetrics()` output — e.g. a product removed 2+ weeks ago,
  preserved only via the `padRow()` pass-through path — the moment that row went through one more
  full-tab rewrite. Fixed by deriving the range from `SHEET_NCOL` via a new `colLetter()` helper
  (`SHEET_LAST_COL`), so this class of bug is structurally impossible on the next column addition.
- **Verification (no live runs):** 36 assertions across 6 synthetic fetch-mock scenarios (same
  method as the 2026-07-17 partial/capped work) — multi-/single-variant price selection, Tier-2-only
  synthesized rows, currency flowing from config, blocked/partial marker rows, WoW sign convention +
  sort order unchanged. The regression test that mattered most — a prior-week row with a real price,
  absent from this week's `computeMetrics()` output, must survive a full write cycle — was backed by
  an actual **negative control**: a copy of the fix with only the range line reverted to the old
  `A2:Q` was run against the identical scenario and confirmed the erasure really does fire without
  the fix (a real `24.99 EUR` silently blanked). The first attempt at this test was worthless — the
  mock Sheets client didn't respect the requested range width, so it couldn't have caught the bug
  either way — caught and fixed before trusting the result.
- **Correction to this session's own earlier investigation-phase report:** Drune/NouveauRiche were
  described as getting "permanently blank price" as Tier-2-only stores — still true, but the
  mechanism is stronger than described: under the *current, unmodified* `buildSnapshot()` logic
  (confirmed via direct repro during mock-harness work, not guessed), a catalog-blocked run is
  already flagged `partial` regardless of rank-scrape success, so it was never going to produce
  per-product Sheet rows at all — just a `__partial__` marker, same as any other incomplete week.
  The only local reference for "catalog blocked, ranks fine" was `data/drune-2026-07-16.json`,
  captured *before* the 2026-07-17 fix that introduced the `partial` field — that snapshot predates
  the field, it doesn't contradict this finding.
- **Files changed:** `lib.js` (`selectPrice()`, `fetchCatalog()`, `buildSnapshot()`,
  `computeMetrics()`, `SHEET_HEADER`, `colLetter()`/`SHEET_LAST_COL`, `rowFromMetric()`,
  `writeCompetitorTab()`), `index.js` (marker-row literals only — no Discord report changes),
  `query.js` (`fmtPrice()`, `line()`, `--product` detail view), `config.json` (currency scaffold).
  `~/.openclaw/agents/scout/workspace/AGENTS.md` and `TOOLS.md` updated for the new data surface
  and the one narrow hand-edited `config.json` field. `SKILL.md` updated (new "Price & Currency"
  section, Google Sheet/Config/Ad-hoc-queries sections touched).
- Full diff shown to Chris and approved before any file was written, per this session's working
  agreement for multi-file changes with room for interpretation.

**2026-07-29 (same session, separate commit) — Shipped: Retry-After honoring in politeFetch(),
ported from Palantir with real batch-budget risk flagged, not silently accepted:**
- **What shipped:** `politeFetch()` in `lib.js` now honors a `Retry-After` header (capped at
  `MAX_RETRY_AFTER_SECONDS = 120`) when a 429 response's body contains `local_rate_limited` —
  waits that duration before the next retry instead of the fixed `jitter + attempt*1500ms`
  backoff. Ported after Scout's own schema-check fetches hit this exact wall earlier the same
  session (see the throttle-finding entry above).
- **Deliberately NARROWER than Palantir's actual shipped code, flagged explicitly:** Palantir's
  `politeFetchOnce()` honors Retry-After on **any** 429 or 5xx carrying the header — its
  `isShopifyRateLimit` check only changes the log message, not whether the wait is honored. This
  port only honors it when the response is specifically a 429 whose body contains
  `local_rate_limited`; any other 429, or any 5xx, falls through to the existing backoff
  unchanged. This was Chris's explicit scoping (matches the verify requirements given), not a
  byte-for-byte port — recorded so it isn't "corrected" to match Palantir later without that being
  a conscious decision. Redirect pacing and the consecutive-page-end change from Palantir's same
  2026-07-28 fix set were explicitly NOT ported — separate decision, out of scope here.
- **Verification (no live runs):** 17 assertions via a synthetic fetch-mock harness with
  `setTimeout` intercepted (records the requested wait duration, fires near-instantly) so the
  120s-cap test didn't cost 2 real minutes — 60s Retry-After honored then succeeds; 999s capped to
  exactly 120000ms (999000ms literally never requested); no-header and non-`local_rate_limited`
  429s fall back to normal backoff unchanged (proves the body-gate actually gates, not just header
  presence); 5xx completely unaffected; normal 200-on-first-try untouched; a persistent throttle
  that never clears gives up cleanly (no hang/throw) after exhausting retries.
- **The number that mattered — worst-case runtime, measured not asserted:** worst-case wait for
  ONE page, fully exhausted, with Scout's real `maxRetries: 3` = **360,013ms (~360s / 6 min)**,
  read directly off the harness, not hand-computed. Structurally (confirmed by re-reading
  `scrapeBestsellerRanks()`/`fetchCatalog()`), a wall on any page breaks that whole page-loop
  immediately — never retries page-by-page — so worst case per **competitor** is bounded by at
  most two such exhaustions (catalog fetch + rank scrape), independently.
- **Batch-budget risk (Chris's actual ask) — flagged, not waved away:** applied to measured batch
  margins (Batch A ~1560s margin, Batch B ~1728s margin, from the 2026-07-21 entries above):
  - Realistic case (one honored wait clears each wall, ~120–240s/competitor if independently
    affected): Batch A +1200s (fits, ~360s headroom left); **Batch B +1920s — exceeds its 1728s
    margin by ~192s.**
  - Worst theoretical case (throttle never clears despite 3 honored waits, 720s/competitor):
    both batches blow their budgets outright.
  - Two open unknowns, not resolved: whether a normal 7-day cadence even provokes this throttle
    (today's hits were on domains touched only ~48–52h prior, off the normal rhythm — no evidence
    a full week's gap doesn't clear it entirely), and whether the throttle is per-domain or
    genuinely shared/IP-wide across a whole batch run.
- **Decision: Chris chose to ship as-is and accept the risk** (2026-07-29, after being shown the
  numbers above) — upside of recovering real data judged to outweigh the SIGTERM risk; explicitly
  not resolved by raising a cron timeout or adding a cumulative-wait ceiling this session. **If
  Monday's Batch B (or A) times out or gets SIGTERM'd, check this entry first** — the
  `[rate-limit]` console lines this change adds will show whether Retry-After honoring was the
  cause.
- **Files changed:** `lib.js` only (`politeFetch()`), separate commit from the Price/Currency
  work per Chris's explicit instruction — nothing else touched.

**2026-07-29 (same session, follow-up) — Raised Batch A/B cron timeouts 5400s → 7200s; SUPERSEDES
the "risk accepted" line above — the risk is now mitigated, not just logged:**
- **Change:** `openclaw cron edit` on both jobs, `--timeout-seconds 7200` only. Per-job payload
  field only — `noOutputTimeoutSeconds` (1200 on both) and every other field left untouched.
  Nothing global changed. `openclaw doctor --fix` was explicitly NOT run (it's known to revert
  cron config — a warning about it appears in `openclaw cron --help`'s own footer).
  - Batch A (`34357ef3-…`): `timeoutSeconds` 5400 → **7200**.
  - Batch B (`05acdb9e-…`): `timeoutSeconds` 5400 → **7200**.
- **Verified via a separate, freshly-issued `openclaw cron get` per job** (not the edit command's
  own output) — both confirmed `timeoutSeconds: 7200`, `noOutputTimeoutSeconds: 1200` unchanged,
  `updatedAtMs` timestamps within seconds of the edit. Note: `openclaw cron list`'s table doesn't
  expose `timeoutSeconds` as a column, so `cron get` was the actual persistence check, not `list`.
- **Reasoning (Chris's call):** Batch B's ~1728s margin was already smaller than the ~1920s
  realistic-case Retry-After cost computed in the entry above — genuinely exposed. Batch A's
  remaining ~360s (6 min) headroom was judged too thin for comfort even though its realistic-case
  math looked survivable. Raised both symmetrically so neither needs revisiting Monday.
- **New evidence surfaced while pulling before/after state, directly relevant to the "two open
  unknowns" flagged in the entry above:** `openclaw cron get` on both jobs' `state.lastDiagnostics`
  showed their **actual** 2026-07-27 (last Monday) run results, not just the healthy-runtime
  estimates cited earlier:
  - **Batch A's real 07-27 run:** 4 of 5 competitors came back HTTP 429 or 500 (NouveauRiche
    BLOCKED: catalog 429/html 500; ByEmiliaRose PARTIAL: wall at page 2, catalog 429; CristalliSchwiiz
    BLOCKED: catalog+html both 429; DriftAndTide BLOCKED: catalog+html both 429). Only Gartenort came
    back clean. `lastDurationMs: 378106` (~6.3 min) — fast specifically *because* most competitors
    failed quickly rather than running their normal full crawl.
  - **Batch B's real 07-27 run:** mostly clean — Feanatic, BelroShop, HausOfMode, LozendaFashion,
    JenniferJohnCharleston, BreuerMode all Tier 1+2 with real data; only Drune blocked (HTTP 500/500 —
    its known, pre-existing, non-throttle block). `lastDurationMs: 3804149` (~63.4 min, close to but
    slightly above the previously-cited ~61.2 min figure).
  - **This answers one of the two open unknowns directly: yes, a normal 7-day cadence already
    provoked widespread 429s on Batch A's real last run** — not confirmed as literally carrying the
    `local_rate_limited` body signature (the diagnostics summary only shows HTTP status, not response
    bodies), but the volume (4/5 competitors, mixed 429/500) is consistent with the same class of
    problem investigated earlier this session. The second unknown (per-domain vs. shared/IP-wide)
    remains genuinely open — Batch A's heavy hit vs. Batch B's mostly-clean run 90 minutes later is
    *some* evidence against a simple "IP is globally hot all day" model, but isn't conclusive either
    way with one data point per batch.
  - Not investigated further this session (out of scope for a timeout-raise task) — flagged for
    whoever reviews Monday's actual run, or a future dedicated investigation.
- **Docs check on Chris's question (does `timeoutSeconds` interact with the gateway's
  restart-defer window?):** checked `docs.openclaw.ai/automation/cron-jobs` and
  `docs.openclaw.ai/gateway/restart-recovery` directly (both fetched successfully, real body
  content, not just a title — a passing check per the suggestion rule).
  - **Confirmed, not inferred:** `timeoutSeconds` is documented as a job's own per-run wall-clock
    budget (`automation/cron-jobs`: "Per-run wall-clock budget: `--timeout-seconds` when set...").
    Separately, `gateway/restart-recovery` documents a graceful-restart **drain budget (5 minutes by
    default)** for in-flight work during a requested restart/config-change/upgrade — described as a
    single fixed default, with no text anywhere connecting its duration to any job's `timeoutSeconds`
    value. These read as two structurally independent mechanisms: one bounds how long the job may
    run before the gateway kills it; the other bounds how long the gateway waits before restarting
    itself for unrelated reasons. **No interaction found — matches Chris's own expectation.**
  - **UNVERIFIED, flagged rather than asserted:** the docs describe a 5-minute drain budget, but
    the primer's own 2026-07-21 investigation empirically observed a **~2-minute** defer (re-checking
    every 30s, then a SIGUSR1 restart) specifically for the auth-config-reload-triggered restarts
    that hit Batch A/B that week. The docs don't explicitly state whether that's the same mechanism
    described here (config-reload restarts might be a narrower/faster code path than the general
    "requested restart" this page documents) or a different one. Not resolved this session — the
    core question Chris asked (does raising `timeoutSeconds` change this window) is answered no
    either way, since nothing ties the drain duration to job config in either description.
- **Not touched:** `noOutputTimeoutSeconds`, any global config, `openclaw doctor --fix`.

**2026-07-31 — Fixed: the 15-cap counted disabled entries, so `--disable` never actually freed a
slot (root cause of the 2026-07-29 Michaël/LaLuna/Tessa Discord exchange); added `--remove`:**
- **Symptom (2026-07-29 Discord, see `sessions/6610ed27-….jsonl.reset…`):** at 15/15 configured
  competitors, Michaël asked to add LaLuna and Tessa. Scout correctly reported the cap, then
  disabled `JenniferJohnCharleston` on request to make room — but the next `--add` still refused
  at "15/15". Scout diagnosed live that the cap counts ALL entries (enabled + disabled), so
  disabling one never actually freed anything, and flagged it for Chris since no command
  available to it could resolve it.
- **Root cause, confirmed by reading `competitors.js` before any edit:** `doAdd()`'s guard checked
  `cfg.competitors.length >= maxCompetitors` (all entries) but its own refusal message said
  "Disable one with `--disable`" — advice the code didn't actually honor. There was also no delete
  path at all (`--list`/`--add`/`--enable`/`--disable` only), so a disabled entry was permanent
  dead weight with no way to reclaim it even conceptually.
- **Fix (`competitors.js`):**
  1. Cap now counts **enabled** entries only (`enabledCount()` helper) — matches the actual abuse
     surface (weekly scrape volume, live-fetch cost at `--add` time); a disabled entry costs
     nothing. `--disable` now genuinely frees a slot immediately.
  2. `--enable` on a disabled entry now checks the same cap (previously unchecked — re-enabling
     could have silently pushed the enabled count above `maxCompetitors`). Existing `batch` field
     is untouched by enable/disable either way, so a re-enabled competitor lands back in its
     original weekly batch.
  3. New `--remove "Name"` — permanently deletes the config array entry. Only allowed on an
     already-disabled entry (safety: can't remove something still actively tracked without
     disabling it first). **Confirmed live** (not just by code reading) that this does NOT touch
     the competitor's Sheet tab or local `data/*.json` snapshots — both are looked up by name,
     independent of `config.json`. This is a config-hygiene tool, not required to free a cap slot
     anymore (enabled-only counting already does that).
  4. Cap-exceeded message (`--add`) and the new enable-at-cap message now state the real
     enabled/max counts and the exact working command to free a slot, plus mention `--remove` when
     disabled entries exist to clean up.
  5. `--list` now reports `N/max enabled (+K disabled, total)` instead of a bare total/max ratio.
- **Docs updated to match:** `AGENTS.md` §2 (add/enable/disable/remove procedure, cap behavior,
  explicit note that picking *which* enabled competitor to drop when the cap is hit is Chris's
  call, not Scout's), `SKILL.md` (competitor-management command block + abuse-guard section).
- **Investigated, not fixed — could not reproduce:** the "Exec failed: node
  .../competitors.js" (bare invocation) report mentioned alongside this incident. Read
  `competitors.js`'s `parseArgs`/`main()`: a bare invocation with no flags prints the usage string
  and returns normally — no `process.exit(1)`, no thrown error. **Verified empirically**
  (`node competitors.js`, no args): exit code 0, usage printed, no failure. The July 20
  unknown-flag hard-fail (`console.error` + `process.exit(1)`) exists only in `index.js`'s
  `parseArgs`, never existed in `competitors.js`'s. Also not present anywhere in the ground-truth
  session log for the actual incident (`6610ed27-…`). Left as-is per "fix only what's confirmed
  broken" — flagging here in case it recurs and turns out to be a different, real issue (e.g.
  something in the exec/session layer, not the script itself).
- **Live verification (real state, backed up `config.json` first to `backups/`):**
  `--list` before: 15 total / 14 enabled / 1 disabled (JenniferJohnCharleston). Ran, in order, all
  against live production config: `--add LaLunaMelbourne https://lalunamelbourne.co` → succeeded
  immediately (14 < 15 enabled — the exact operation that was blocked on 2026-07-29, now working),
  Tier 1+2, 852-product baseline, 100% coverage, Sheet tab created and synced at add-time.
  `--add TessaBayside https://tessabayside.com` → correctly refused, new cap message fired
  (15/15 enabled after LaLuna). `--enable JenniferJohnCharleston` → correctly refused by the new
  enable-at-cap guard. `--remove JenniferJohnCharleston` → succeeded (was disabled); confirmed via
  the Sheets API (`spreadsheets.get`) its tab still exists, and confirmed its two local snapshot
  files (`2026-07-21`, `2026-07-27`) are untouched on disk. `--list` after: 15/15 enabled, 0
  disabled, LaLunaMelbourne present, JenniferJohnCharleston absent from config (history intact
  elsewhere).
- **Tessa remains unaddressed — needs a decision, not a fix.** With the bug fixed, the cap is
  now working *correctly*: 15 real slots, all genuinely in use. Adding Tessa requires either
  raising `maxCompetitors` or disabling one of the 15 currently-tracked competitors, and choosing
  which is a call for Chris/the external team, not something to decide unilaterally.
- **Batch B runtime window — estimated, not directly measured** (the orientation's own hard rule
  bars running `node index.js` or a manual `openclaw cron run` outside sanctioned, once-a-day use,
  so the actual batch was not re-triggered just to time it). Batch B's roster changed net: **−**
  JenniferJohnCharleston (removed), **+** JesseLondon and LaLunaMelbourne (both added since the
  last real Batch B run on 07-27; RedlichBecker was already configured for Batch B before 07-27
  and isn't a net change). Real numbers available from this session: JesseLondon's own baseline
  capture (2026-07-29) took **~89s** for 777 products; LaLunaMelbourne's (2026-07-31, this
  session) took **~130s** for 852 products — both measured as `data/<slug>-<date>.json` mtime
  minus `lastAddAtMs` at the start of that add. Against Batch B's last verified full-run duration
  of **3804s (~63.4 min)** on 07-27 (7 stores + Drune blocked), two more similarly-sized stores at
  ~1.5–2 min each is a low-tens-of-seconds-to-a-few-minutes addition — nowhere close to threatening
  the 7200s budget (~57 min of headroom at the 07-27 baseline alone). JenniferJohnCharleston's
  removal further reduces the total by an unmeasured but nonzero amount (it was itself a normal
  Tier 1+2 store in that same run). Net: **no runtime concern expected**, but this is an estimate
  built from real per-store numbers, not a rerun of the actual batch — flag if Monday's real
  `lastDurationMs` (`openclaw cron get 05acdb9e-…`) comes back surprising.
- **LaLunaMelbourne has no `currency` set** (prints "(currency unknown)" in `query.js` price
  output until hand-set in `config.json` — the documented one manual-edit exception, see
  `TOOLS.md`). Pre-existing `--add` behavior, not something this session's fix changed.
- **AGENTS.md §3 and SKILL.md's Batch B roster were also stale independent of this fix** (missing
  RedlichBecker and JesseLondon, both added before this session — 07-20/21 and 07-29 respectively
  — without a matching doc update at the time) — corrected in the same commit as this fix since it
  was directly adjacent (JenniferJohnCharleston's removal made the same lines actively wrong), but
  the RedlichBecker/JesseLondon staleness itself predates this session.
- **Not touched:** the 15-competitor cap value itself (per the orientation: make the cap work
  correctly, not weaken it), the 60s add-cooldown logic (unchanged; not separately exercised this
  session since every `--add` attempt after LaLuna hit the cap check first — cap is checked before
  cooldown in `doAdd()`, so cooldown wasn't actually the thing firing), any OpenClaw-platform
  config (cron/session/timeout — nothing in this fix touches that layer, so no docs check was
  needed or performed).

**2026-08-05 — HausOfMode alphabetical rank data: investigated, root-caused (partially), sort-
integrity guard shipped:**
- **Symptom:** Chris observed in a browser that `hausofmode.de` collection pages with
  `?sort_by=best-selling` (the correct spelling — confirmed `lib.js` has always used it, not the
  invalid `best-sellers`) appeared to redirect to `/collections/all`, and suspected Scout's
  `redirect: 'follow'` was silently chasing a server-side redirect that drops the sort param —
  the same class of gap Palantir closed 2026-07-28 (`redirect: 'manual'` + paced hop loop,
  `81a258b`) but Scout never ported.
- **Offline audit (zero HTTP, read-only) first:** wrote a Spearman-rank-correlation +
  adjacent-pair-match scorer, locale-aware (`Intl.Collator`, TLD-derived locale — a naive ASCII
  sort would misorder German umlauts and produce false signals) comparing each snapshot's
  recorded rank order against an A-Z sort of the same product set. Ran it over all 45 snapshots
  across all 16 competitors ever tracked. Validated the scorer against a synthetic fully-
  alphabetical control built from a real product set (scored a perfect ρ=1.000, correctly
  flagged) before trusting it on real data. **Result: every snapshot of every competitor, through
  2026-08-03, scored near-zero correlation (HausOfMode: ρ≈-0.06, indistinguishable from every
  other clean competitor) — no historical evidence of alphabetical fallback anywhere, ever.**
  This meant the browser-observed problem, if real, had to postdate the 2026-08-03 snapshot (no
  competitor has any snapshot after that date — the next scheduled run hadn't run yet).
- **Live investigation (6-request budget, hausofmode.de only, ≥20s paced, `redirect: 'manual'`
  probe mirroring Scout's exact UA/timeout):**
  1. `GET /collections/all?sort_by=best-selling&page=1` — **200, `Location: null`. No server-side
     redirect at all**, ruling out the suspected mechanism (H0) outright. The returned product
     grid was nonetheless visibly alphabetical-by-handle (`1-stuck-...`, `1-5l-...`,
     `10-wiederverwendbare-...`, `100-baumwolle-...`, `1000-gramm-...`, ascending) after 3 pinned
     items up front.
  2. `GET ...?sort_by=title-ascending&page=1` and `GET ...?page=1` (no sort param at all) both
     returned the **identical first-30 product sequence** as step 1's `best-selling` request.
     Three different sort_by values (including none) → one identical order. The parameter is
     being accepted and silently ignored, not redirected around.
  3. `GET /collections.json?limit=50` — no collection with handle exactly `all` exists (there is
     a German `alle` / "ALLE", handle `alle`, 8529 products, unrelated) — `/collections/all` is
     Shopify's auto-generated virtual collection, not a merchant-created manual one. Rules against
     (though doesn't fully rule out — only 50 of an unknown total collections were checked) the
     "manual collection shadow" explanation being *why*; doesn't change the *what*.
  4. `GET /collections/damenbekleidung?sort_by=best-selling&page=1` (a second, real, named
     collection) — **same leading product sequence as `/collections/all`.** The failure isn't
     specific to the `all` view.
  - **Conclusion: H0 (redirect) and H1 (invalid sort_by spelling) are ruled out by direct
    evidence. sort_by is present in the URL, correctly spelled, and has zero effect on the
    returned order** — consistent with H2/H3 (a theme/collection-query layer that doesn't wire
    the URL param to the actual product order; Shopify docs and community reports confirm this is
    theme-implementation-dependent, not a platform guarantee — see sources below). **Not
    determined:** whether this is a deliberate anti-scraping measure or an unrelated site change
    (new merchandising app, theme swap, admin resort) that happened to land in the same ~2-day
    window; no way to infer merchant intent from the outside. The 30x the browser appeared to
    show was not reproduced at the HTTP layer in 6 requests — most likely a client-side
    (JS/`history.replaceState`) URL change that never reaches a `fetch()`-based scraper, but this
    is inference, not confirmed with a real browser trace this session.
  - Sources checked: shopify.dev `sort_by` filter and `ProductCollectionSortKeys` docs (neither
    documents manual-collection sort_by override behavior one way or the other — labelled
    UNVERIFIED at the platform level), Shopify community threads confirming sort_by-ignored is a
    known real-world theme-level failure mode.
- **Fix shipped (`lib.js`, `index.js`):**
  1. **Ported Palantir's `redirect: 'manual'` + `MAX_REDIRECT_HOPS` (5) paced hop loop**
     (`politeFetchOnce`/`politeFetch` split, same shape/names as `81a258b`), keeping Scout's own
     narrower Retry-After scoping (`local_rate_limited`-only) unchanged. **This did NOT fix or
     catch this incident** (confirmed no redirect occurred) — it closes a separate, real,
     pre-existing gap: HausOfMode's `config.json` entry is a bare domain (no `www`), the same
     shape as Palantir's actual root cause on `driftandtide.com`. Departure from Palantir's exact
     port: also returns `finalUrl`/`hops` (Palantir's doesn't), needed for check (2) below.
  2. **`urlIntegrityFail`** in `scrapeBestsellerRanks()`: hard, exact check — if a redirect hop
     *did* occur and the final URL lost `sort_by`, flag it. Would not have caught this incident
     (no redirect occurred) but is cheap now that the hop loop exists, and covers a future
     redirect-shaped incident on this or another competitor.
  3. **`detectAlphabeticalSort()`** in `buildSnapshot()`: the mechanism-agnostic backstop that
     actually would have caught this — reuses the offline audit's exact method (Spearman ρ +
     adjacent-pair-match, locale-aware, `n≥15` minimum) against the fresh weekly snapshot.
     Suspect if ρ≥0.90 or adjacent-pair-match≥0.90.
  4. New `sortSuspect` flag, sibling to `blocked`/`partial`/`capped`, same idiom. **Behaves like
     `partial`, not `capped`, per Chris's explicit call**: flagged loudly (Sheet marker row,
     Discord one-liner naming the likely cause and telling the human to check the site directly),
     and **not saved as the week's baseline** — even though coverage is complete, because a
     misordered "complete" week is worse than a short one: nothing about a saved snapshot's shape
     would reveal it's wrong. Whole snapshot is discarded on fire (catalog data included), matching
     `partial`'s existing coarseness rather than inventing a new catalog-only-partial state.
- **Verification:** negative control (not just a passing test) — imported the real shipped
  `detectAlphabeticalSort()` and ran it against (a) HausOfMode's real 2026-08-03 snapshot
  (13,873 ranked products) → `suspect: false`, ρ=-0.06 [must-not-fire, passed]; (b) a synthetic
  snapshot built from the same real product set with ranks replaced by pure alphabetical order →
  `suspect: true`, ρ=1.00 [must-fire, passed]; (c) every other competitor's latest real snapshot
  → zero false positives. `data/` confirmed untouched all session (file count unchanged at 45,
  latest mtime still the original 2026-08-03 scrape, `git status` shows only `lib.js`/`index.js`
  modified). Did NOT run `node index.js` or trigger a cron run, per instruction.
- **Rollback point:** tag `pre-sort-integrity-guard-20260805-084921`, pushed and round-trip
  verified via `git fetch --tags`; `config.json` backed up to `backups/config.json.20260805-084934.bak`
  before any edit (config itself was not changed).
- **Not yet done / open:** the *why* behind hausofmode.de's behavior (deliberate vs. incidental)
  is unresolved and likely unresolvable from outside; the full extent of what changed in HausOfMode's
  first-~30-85 grid items across two different collections (identical leading handles, but total
  extracted-handle counts differed 50 vs 85 between sort values — not fully characterized, budget
  exhausted before this could be dug into; `extractGridHandles()`'s page-wide regex doesn't
  distinguish a collection's real grid from other on-page product links, which may be part of the
  85-vs-50 gap); no live confirmation this session that the ported redirect-hop-loop is a true
  no-op on a normal non-redirecting store (budget was hausofmode.de-only) — relying on structural
  equivalence to Palantir's already-live-verified version instead; next Monday's scheduled run
  (on/after 2026-08-10) is the first real-world exercise of this guard — check whether HausOfMode
  fires it again, and whether it's still `sortSuspect` or has reverted.

**2026-08-05 (later same day) — CORRECTION to the entry above: the "silently ignores sort_by"
conclusion was wrong. Root cause was a page-wide extraction regex, not a sort/redirect problem.**

The entry above's central mechanism claim — *"hausofmode.de is silently ignoring the sort_by URL
parameter entirely... no redirect"* — is **wrong**, and is being corrected here rather than
deleted, per Chris's instruction not to erase investigation history. What was actually true and
what wasn't:

- **Still true:** no server-side redirect occurred (confirmed independently again this session,
  see the new entry below). That specific sub-finding stands.
- **Wrong:** the inference that this proves sort_by is "silently ignored." **The three-URL test
  that conclusion rested on (`best-selling` / `title-ascending` / no param, all returning an
  identical leading ~30-handle sequence) could not actually discriminate between the competing
  explanations, and this was missed at the time.** Concretely: `/collections/all` defaulting to
  alphabetical order, `title-ascending` being *explicitly* alphabetical, and "sort_by is silently
  ignored" (falling back to some default that happens to look alphabetical) all predict the exact
  same observable result — an alphabetical-looking leading sequence, unchanged across all three
  requests. Three hypotheses, one shared prediction. Observing that prediction come true proved
  nothing about which hypothesis was correct; the test was worthless by construction, not by
  execution — a good example of the "state what each hypothesis predicts before testing" rule
  this project now follows.
- **What a follow-up investigation later the same day actually found** (full detail in that
  session's entry, immediately below): the leading ~30-85 "handles" in a single-page fetch were
  never the collection grid at all. `extractGridHandles()` is a page-wide `href` regex with no
  container scoping. HausOfMode's theme renders a sitewide **Cart Drawer add-on-product upsell
  widget** earlier in the page's byte order than the actual collection grid section
  (`id="CollectionAjaxContent"`). That widget is present, in the same order, on every page/sort/
  collection combination — which is *why* three different sort_by values produced identical
  output: none of those three requests ever reached the real grid within the extraction's first
  ~30-50 matches. The real grid (items ~51-85 on a page-1 fetch) showed no alphabetical signature
  at all in that session's sampling.
- **Still genuinely unverified, in either session:** whether `sort_by=best-selling` measurably
  reorders the *real* collection grid by actual sales rank. Neither session ran an A/B test of
  different sort_by values isolated to just the scoped grid content — the only sort_by comparison
  ever run was against the (sort-independent) cart-drawer widget, which is exactly the test that's
  now known to be worthless. Labelled UNVERIFIED here rather than asserted either way. This does
  not block today's fix: the grid-scoping fix and the sort-integrity guard both work regardless of
  whether sort_by is genuinely honored, because they detect/prevent contamination of the *recorded
  order*, not the *cause* of any given order.

See the new entry immediately below for the fix that grew out of this correction.

**2026-08-05 (grid-scoping session) — root-caused and fixed the actual mechanism; widened the
sort-integrity guard; corrected the entries above:**
- **Root cause, confirmed:** `extractGridHandles()`'s page-wide, unscoped `href` regex was
  extracting a sitewide Cart Drawer add-on-product widget's ~50 links (present earlier in byte
  order) ahead of the real collection-grid section on hausofmode.de, corrupting the leading ~50
  "ranks" of every crawl since at least 2026-07-20. Confirmed directly: scoping a saved page-1
  fetch to `id="CollectionAjaxContent"` yields exactly 35 products whose first five, in order,
  match what Chris saw in a real browser (Versichertes Paket, Drahtlose 1080P Mini WiFi
  Sicherheitskamera - SecureView, Hilf unserer Natur, Ultraschnelle Externe SSD - SpeedDrive Pro,
  Komfortable Orthopädische Keilabsatz-Espadrilles - Clara).
- **page=2 hard gate (resolved a loose end from the follow-up session):** a page=2 probe run just
  before this session appeared to show page=2 returning content identical to page=1, including the
  real-grid section — which would have meant pagination was broken and the next scheduled run
  would collapse to ~85 products instead of ~13,873. Re-tested this session with a 3-request
  budget (fresh page=1, plain page=2, cache-busted page=2, all ≥20s apart, hausofmode.de only):
  **not reproduced.** Items 0-49 (the cart-drawer widget) are identical between page=1 and page=2,
  as expected for a sitewide, page-independent component. Items 50-84 (the real grid) are
  **completely different** between the two pages — 35 distinct new handles, zero overlap.
  Pagination is fine; the earlier finding was a probe artefact, not a real fault. Full detail in
  this session's report.
- **Fix shipped (`lib.js`):** `extractGridHandles()` now tries a candidate list of known
  collection-grid container markers (`id="CollectionAjaxContent"`, `class="collection-grid__wrapper"`,
  `data-section-type="collection-grid"`) before falling back to the original whole-page regex —
  byte-for-byte the same behavior as before this fix — whenever no marker matches or the scoped
  slice yields zero products, so an unfamiliar theme degrades to today's already-trusted behavior
  rather than to zero data. Returns `{ handles, scoped, marker }`; `scrapeBestsellerRanks()` and
  `buildSnapshot()` log and carry this per-competitor per-run (`gridScoped`/`gridScopeMarker` on
  the snapshot) so a silent fallback can never again hide the way the original bug did. Validated
  live against 4 other roster competitors (Gartenort, RisoraShop, DriftAndTide, CristalliSchwiiz —
  mixed German/non-German, mixed catalog size): zero change in extracted output on any of the 4;
  DriftAndTide's theme has the marker and scoped successfully but happened to have no leading junk
  to remove, so its output was identical either way. Strong evidence (not exhaustive — 10 of 15
  enabled competitors were not live-checked) this incident is isolated to HausOfMode.
- **`detectAlphabeticalSort()` widened** to also score bounded prefixes (top-30, top-100) in
  addition to the existing full-catalog check, strictly additive (fires if ANY window crosses the
  unchanged 0.90 threshold). Mechanism proven sound with a synthetic test (forcing only the real
  top-30 of a real snapshot alphabetical fires via the `top30` window at ρ=1.00, while the
  full-catalog check alone stays clean — exactly the class of smaller-scale, leading-ranks-only
  incident the original whole-catalog-only guard was blind to). **Honest, unretouched finding:**
  neither the real historical HausOfMode snapshot nor a single-page synthetic reconstruction of
  this specific incident crosses the 0.90 threshold at ANY window (best figures seen: top-30
  adjacent-pair-match 0.79 on real historical data, ρ=0.68 on a single-page pre-fix extraction) —
  the widened guard, as specified, would **not** have caught this particular incident's actual
  magnitude either. Per instruction, the threshold was not retuned to force a pass; this is
  reported as-is for Chris to weigh. The guard's real, demonstrated value is as a general backstop
  for a *fully*-alphabetical-leading-ranks incident, not this specific partial-correlation one —
  the grid-scoping fix above is what actually protects against this incident's mechanism.
- **Verification:** re-ran the ground-truth scoped-extraction check against the fixed code path
  (see above); confirmed `data/` untouched (file count, latest mtime, `git status --ignored` all
  unchanged); rollback tag `pre-grid-scoping-fix-20260805-105848` created, pushed, and round-trip
  verified via `git fetch --tags` before any edit; `config.json` re-backed-up (unchanged content).
- **Not done, by explicit instruction:** the HausOfMode baseline decision (every stored snapshot
  since 2026-07-20 has corrupt ranks 1-50; the next run will diff corrected ranks against a
  corrupted baseline) was analyzed and a recommendation given, but NOT implemented — Chris's call.
  Advisor was unavailable both times it was invoked this session (consistent with 5 failed
  attempts across today's earlier sessions) — flagged, not silently skipped. Full detail, including
  per-competitor roster validation numbers and the baseline-impact quantification, in
  `~/Scout_GridScoping_Fix_Report_Aug5.md`.

**2026-08-07 — HausOfMode baseline re-established from corrected extraction (option 1 of the
2026-08-05 report's §7/3c options, authorized by Chris as a one-off exception):**
- **Archived** the 4 contaminated snapshots (`hausofmode-2026-07-20.json`, `07-21`, `07-27`,
  `08-03`) via `mv` to `~/scout-snapshot-archive-precontamination-20260807/` (outside the repo,
  outside `data/`). Verified before/after by reading the actual filesystem, not trusting `mv`'s
  exit code: archive holds 4 files at byte-identical sizes to the pre-move record; `data/` dropped
  from 45 to 41 files with zero `hausofmode-*.json` remaining. Restore command (JSON files only —
  see caveat below): `mv ~/scout-snapshot-archive-precontamination-20260807/hausofmode-*.json
  ~/scripts/scout-competitor-tracker/data/`.
- **Captured** a fresh baseline: `node index.js --only HausOfMode --date 2026-08-07 --no-discord`,
  as the session's one sanctioned exception to the standing "no raw `node index.js`" rule.
  Backgrounded via `nohup`, ~37 minutes, ~452 requests, zero 429s. Result: `catalog 13875 | ranked
  13871 | coverage 100%`, `blocked/partial/capped/sortSuspect` all `false`, `gridScoped: true` via
  `id="CollectionAjaxContent"`.
- **Correction to the 2026-08-05 report's §7/§8:** that report's impact estimate assumed (and
  explicitly flagged as INFERRED/unverified) that the ~50 Cart Drawer handles do NOT independently
  appear in the real collection grid. **This session found the opposite: all 50 do appear in the
  real grid**, at genuinely scattered true ranks (197 through 12180, not clustered) — confirmed by
  sweeping the full new ranked list for all 50 known handles by name. This means the old unscoped
  code never inflated the ranked count: `scrapeBestsellerRanks()`'s `seen`-based dedup meant each
  of the 50 was captured exactly once, at its *artificial* early position (ranks 1-50, from the
  cart-drawer widget sitting earlier in page byte-order) — when the crawl later reached that same
  product's *true* position in the real grid, it was already `seen` and silently skipped. The bug
  was a **relocation** of 50 real products to a fake top-50 block (silently displacing the genuine
  top 50 downward by exactly 50 ranks), not an **addition** of 50 phantom rows on top of the real
  grid. Confirms and quantifies: `rankedCount` before (13873, 2026-08-03) and after (13871,
  2026-08-07) differ by only 2 — exactly the catalog churn over those 4 days
  (`catalogCount` 13877 → 13875) — not by ~50, which is the arithmetic proof the total was never
  inflated. The revised Monday forecast this corrects: the spurious-mover mechanism (now avoided)
  would have been a uniform ~-50 rank shift for the *displaced* real products, not 50 phantom "new"
  rows.
- **Verification (5 independent, converging checks, full detail in the session report):** (1)
  top-5 exact match to Chris's browser ground truth, same order; (2) all 50 known cart-drawer
  handles found ranked at scattered true positions, none in ranks 1-50, none clustered at the tail;
  (3) rank integrity — 1..13871 contiguous, zero gaps, zero duplicate ranks or handles; (4) a
  mid-crawl fallback event (page 398's grid-container marker matched but scoped to empty — logged
  as "differs from page 1's result", the only such line in the run) contributed zero new handles,
  proven by the single log line itself (a second occurrence would have logged if the loop had
  continued past 398 finding anything new — it didn't) and independently by the tail-correspondence
  check below; (5) the new snapshot's last 50 ranks (13822-13871) map to the OLD snapshot's last 50
  ranks (13824-13873) in unbroken 1:1 sequence, offset by exactly the 2-product catalog churn — an
  injected block would show scattered or absent old ranks, and doesn't.
- **`gridScoped: true` caveat, worth knowing for future debugging:** this field is decided from
  *page 1 only* (`scrapeBestsellerRanks()`, lib.js ~380-384) and does not by itself guarantee every
  later page scoped cleanly — a later page's fallback is only visible via the "differs from page
  1's result" log line (lib.js ~385-386), not via any snapshot field. This session's tail-fallback
  event would have been invisible to a `gridScoped`-only check; the 5-way verification above is
  what actually confirmed cleanliness.
- **Sheet tab:** written normally (no `--no-sheet` used) — 14034 total rows, 13875 from this run
  (spot-checked against the local snapshot: exact rank match, e.g. `du-wirst-immer-beschutzt-sein-
  boser-blick-halskette` reads rank 1309 in both), 159 preserved from earlier weeks (handles no
  longer in today's catalog — pre-existing `writeCompetitorTab()` "never delete" behavior, unrelated
  to this session). Every this-run row's Last Week Rank/WoW Change is correctly blank
  (`hasPrior:false`, since no local prior snapshot exists post-archive). **Note for whoever opens
  the Sheet before Monday:** the tab sorts by WoW ascending, so the 159 preserved rows (which still
  carry concrete negative WoW values from 2026-08-03) sort *above* all 13875 of this week's
  blank-WoW rows — stale-looking "movers" at the top of the tab. Pre-existing sort behavior, not
  caused by this session, and does not affect Monday's Discord report (computed fresh from local
  snapshots, which will be clean-vs-clean).
- **Restore-gap caveat:** if anything in a future session needs to undo this, moving the 4 archived
  JSON files back to `data/` restores the *local snapshot history* but does **not** undo the Sheet
  tab write above — `writeCompetitorTab()` already overwrote HausOfMode's live tab. A full restore
  needs both steps; don't assume the `mv` alone is complete.
- **Monday 2026-08-10 (Batch B, 12:00 Manila):** HausOfMode will compare 2026-08-07 vs whatever
  that run captures — a genuine 3-day-old baseline (not the usual weekly cadence), so expect
  smaller WoW movements than a normal week, and expect the multi-week bonus columns (Month Change,
  Streak, Avg Rank 4w, Hot Streak, Consistent Top 10) to be thin for this store for up to
  `weeksToKeep` (4) weeks while clean history rebuilds. This is expected, not a bug.
- Advisor consulted twice this session, both substantive and available: once at the mandated
  archive checkpoint (caught the tail-fallback risk this session's verification plan would
  otherwise have missed, and the save-gate semantics), once to reconcile a self-run count-based
  cross-check whose naive two-branch reading conflicted with the already-gathered overlap evidence
  (correctly resolved in favor of the direct evidence — see above). Full detail:
  `~/Scout_HausOfMode_Recapture_Report_Aug7.md`.

---

**2026-08-21 — Three generic crawl-classification defects fixed (Shopify pagination ceiling, empty-page truncation, password-gated stores):**

**Origin.** The 2026-08-17 read-only diagnosis of two failed Batch D stores
(`~/reports/Scout-BreuerMode-RedlichBecker-Diagnosis-2026-08-17.md`) found that most of what
looked like two store-specific failures was **generic** — defects affecting every store, merely
*exposed* by those two. This session shipped the generic half. The RedlichBecker-specific
follow-up work that report proposed (the ordering-stability capture) was **cancelled**: the
external team dropped the store via Discord before this session ran. The three fixes stand on
their own; RedlichBecker was only the store that surfaced them.

**[1] Shopify's 25,000-product pagination ceiling is a terminal condition, not a block.**
`products.json` refuses `page × limit > 25,000`, answering HTTP 400 with Shopify's own text
(`{"errors":"Page * Limit exceeds the 25000 limit."}`); at `limit=250`, page 100 is the last legal
page. Confirmed live 2026-08-17 (probe P5) and against shopify.dev's documented platform-wide
pagination limit. `fetchCatalog()`'s non-OK catch-all filed it as `blocked`, which forced the
store down the `partial` arm and discarded an otherwise-usable snapshot — the right OUTCOME for
an entirely wrong stated REASON. Generic: **any** store crossing 25,000 products hits it, and
CristalliSchwiiz is at ~20k and growing toward it.

⚠️ **The trap, and why the obvious fix is the dangerous one.** Recognising the 400 makes
`blocked` false. The run then falls through to **`capped`** — which **IS saved**, and whose
Discord line asserts *"the full catalog IS captured."* That statement is false for a catalogue
Shopify truncated, and the saved snapshot becomes a membership list missing an unknown number of
products, mislabeling them "Removed From Store"/"New This Week" from then on — exactly what the
never-save rule exists to prevent (2026-07-17 entry above), and the precise inverse of why
`capped` is savable at all (2026-07-21 entry above: *because* the catalog fetch is complete). **This was demonstrated, not reasoned about:** a
tree carrying only the `fetchCatalog` half of the fix wrote `redlichbecker-2026-08-21.json` to
disk and emitted both "the full catalog IS captured" and "🆕 First snapshot — baseline
established" against the RedlichBecker fixture. So a truncated catalogue gets its **own** state,
`catalogTruncated`, evaluated **before** `capped` in `buildSnapshot()`, never saved, with a
Discord line that presents the catalog count as a **floor** and deliberately shows no coverage
percentage (any coverage figure would use a truncated denominator). Detection matches Shopify's
literal error text and is deliberately narrow — if the wording ever changes, behaviour degrades
to the old blocked→partial→not-saved path, which is safe; a loose match failing the other way is
not.

**[2] One glitched page silently truncated a whole crawl — the highest-value fix of the three.**
`scrapeBestsellerRanks()` broke on the **first** zero-new-handle page, so a single transient
duplicate or glitched page ended an entire crawl and was **indistinguishable in the output from a
real end of catalogue**. Proven false positive: RedlichBecker stopped at ~page 697 on 2026-08-10
while page 960 still served 28 products and linked on to 961 (probe P6). This affected **every
store, every week, invisibly, for as long as the break has existed** — and a truncated week was
reported as clean and complete. Tolerance is now `RANK_EMPTY_PAGE_TOLERANCE` = 3 consecutive
empty pages, and every empty page logs its index and handle count so the next occurrence is
diagnosable rather than inferred. Fixture: a 200-page catalogue with one duplicate page at 50
returned **1,372 ranked before, 5,572 after** — a 75% silent loss, reported both times as a clean
week.

⚠️ **`emptyOrDupPages === 0` in the capped test is load-bearing, not tidying.** The old capped
condition relied on the invariant "`page` can only exceed `cap` via a productive final page,"
which held *only* because an empty page broke immediately with `page` unincremented. Raising the
tolerance destroys that invariant: a store whose genuine catalogue ends within 2 pages of its cap
now increments past the cap while burning its empty-page allowance, and without this term would
be reported `capped` and told to "raise this store's page cap" after having finished **cleanly**.
Verified both directions against a fixture ending one page before its cap (a tree with the guard
removed reports CAPPED; with it, clean).

**[3] Password-gated stores report as CLOSED, a merchant state, not as our failure.** BreuerMode
went behind Shopify's password gate between 08-10 and 08-17: every URL 302s to `/password`,
`products.json` returns a bare 401 with no `WWW-Authenticate` and a 0-byte body, and a plain-curl
UA control behaved identically (probe P3) — the store is closed to **everyone**, not to us. The
existing URL-integrity check already had the redirect in hand and discarded it, so the run
reported `PARTIAL — HTTP 401`, which to the external Discord audience reads as a Scout defect.
The redirect **target** is the discriminator: a WAF or IP block returns a challenge or an error
page, never a 302 to the store's own `/password`. Now surfaced as `closed`, not saved, reported
as competitive news. **The store is deliberately NOT disabled** — a password gate usually means a
rebrand, migration or seasonal close, and tracking should resume by itself if it reopens. Also
fixed the cosmetic mislabel from the same run: the `!ranks.ok` arm hardcoded
`Tier 2-partial (catalog only, no rank)` even when the catalog was 0; there is now a `Tier 0`
arm. No data impact.

**Second save path found and fixed (was not in the diagnosis).** `competitors.js --add` carries
its **own** baseline-persistence gate, and it had already drifted from `index.js`: it checked only
`blocked || partial`, so a newly-added competitor whose baseline came back **sort-suspect was
saved anyway** — contrary to what SKILL.md's own tier list states. Without touching it,
the external team adding a >25k or password-gated store through Discord would have saved a
truncated/empty baseline and been told "baseline established," which is the invariant violation
above walking in through the door nobody was watching. Both call sites now use one shared
`isIncomplete(snapshot)` predicate in `lib.js` (plus `incompleteLabel()` for routing).
**If you add a new incomplete state, add it there, not at a call site.**

**Verification — `test/run-fixtures.sh` (committed).** Offline fixture harness, no network and no
live traffic: `test/mock.mjs` replaces global `fetch` and the throwaway config it generates zeroes
the pacing delays, so the 901-request RedlichBecker fixture runs in seconds. It runs every
classification state against the working tree or any git ref, so before/after can be **shown**:
`./test/run-fixtures.sh pre-generic-crawl-fixes-2026-08-21`. Run against that tag, the
RedlichBecker and BreuerMode fixtures reproduce their **real 2026-08-17 production run lines
byte-for-byte**, which is what makes them credible as stand-ins. Live HTTP requests spent this
session: **zero**.

⚠️ **Fixture trap worth knowing.** The first RedlichBecker fixture used sequential handles
(`rb-rank-0`, `rb-rank-1`, …), which are perfectly alphabetical and therefore tripped the
sort-integrity guard — which blocked the save for a reason the real store does not have, masking
exactly the save behaviour under test. Real RedlichBecker handles carry random bulk-import
suffixes and score no alphabetical correlation. Generate fixture handles with `scramble()`.

**Regression posture for the other stores.** A healthy store's behaviour is unchanged: the
`CleanEnd` fixture reports 100% coverage, unflagged, identically before and after. Cost of the
tolerance is exactly **+2 page fetches per store per run** at a genuine end (measured 12 → 14),
roughly +3–5s per store and well under a minute across the largest batch. No store should newly
flip to `capped` (that is what the `emptyOrDupPages === 0` guard prevents); stores that were
*already* capped are unaffected, and a store that was silently truncating will now legitimately
crawl **further** than before — deeper, more honest coverage, which is the point, but it is also
the one place Monday's runtimes could rise beyond the +2-fetch figure, since nobody knows how
many stores were quietly stopping early.

**Not done, deliberately.** Nothing was ported to Palantir's internal `competitor-tracker`, which
shares this code lineage and therefore has all three defects — that is a separate session. The
analogous single-duplicate-page break inside `fetchCatalog()` (a catalog page that adds no new
handles ends the catalog fetch on the first occurrence) was left alone: same shape as [2], but the
catalog loop has `products.length < 250` as its primary end signal, and it was outside this
session's scope. Batch scheduling, cron timeouts, the roster and the gateway-restart risk were all
untouched.

**Roster note (observed, not acted on).** `config.json` carried uncommitted live edits made by
Scout itself from Discord and they were left exactly as found: **BreuerMode removed** (in addition
to RedlichBecker), and **HarperWears, LeonBoutique and ShopWecro added** — 17 enabled, 0 disabled,
against a cap of 20, with Batch D holding 9. Consequence worth knowing: **no store currently on
the roster exercises the CLOSED path**, since the store that motivated it is gone. The fix is
generic and the next store to close would otherwise have reproduced the same
reads-like-our-bug failure.

---

### 2026-08-25 — the "uniform shift" that wasn't: decliner lists are tied by construction

**What was reported.** After Monday 2026-08-24 (the first run on the five 2026-08-21 crawl commits)
Michael flagged that the biggest-movers-down lists "have weird data, like all the same + amount of
rankings". Scout investigated its own data, correctly found that CristalliSchwiiz showed +138,
HausOfMode +35, BelroShop +30 and LeonBoutique +146, and told the team this was a **store-level
catalog reshuffle** — "not a tracker malfunction, just not a useful signal this week".

**The explanation was wrong.** The ranks were correct and the crawl was healthy. Rank is a
permutation: a product's rank rises by exactly the number of products that overtook it. Declines
are therefore **bounded** (small, for the dense middle of a catalogue) while gains are unbounded,
and every product in the contiguous band that the same *k* risers jumped over falls by the
**identical** *k*. The four numbers Scout reported were each simply that store's **maximum**
decline, and the number of products tied at it was 111 / 144 / 7 / 16 — enough to fill the whole
top-12 list with one value.

**How the wrong story was formed.** `query.js --decliners 20` — Scout's own Q&A path — sliced
`summary.moversDown` with no context and no tie disclosure. Replayed against the stored snapshots
it returns **twenty identical +35s** for HausOfMode. Scout did not misread its data; it read a list
that only ever shows the tied maximum and generalised from it to the whole store.

**Ruled out, with the observation that did it.** The five 2026-08-21 commits were affirmatively
cleared, not merely un-implicated: the same tie-plateau is present in weeks that ran on the *old*
code — Gartenort 08-10→08-17 had **79** products tied at +7, CristalliSchwiiz 08-10→08-17 had
**212** tied at +456. Merchant reshuffle was killed by BelroShop, which showed **0 new, 0 removed,
deltas summing to exactly 0**, and whose +30 product was verified to have been overtaken by exactly
30 real, already-tracked neighbours and 0 in the other direction. A live probe confirmed BelroShop's
grid top-12 is identical to both weeks' snapshots — no junk-at-front displacement, i.e. **not** a
repeat of the Aug 5–7 HausOfMode incident this superficially resembled.

**Data verdict: not poisoned, and deliberately no remediation.** Every store terminated at a genuine
catalog end via the 3-empty-page rule with coverage 100% and no flags, so Monday's snapshots are the
correct baseline for 2026-08-31. This is the **opposite** call from the HausOfMode saga, and the
contrast is the point: there the stored ranks were genuinely wrong and archive-plus-recapture was the
only repair; here archiving good data would have destroyed a clean baseline and manufactured the
false-diff problem. NouveauRiche was the one real poisoning candidate (804→423 ranked, saved clean,
on the historically Cloudflare-blocked store) and was cleared by a live probe: catalog page 2
returned 129 products, so the live catalogue is ~379 — the store genuinely shrank and the 382
removals are real.

**Fixed (2026-08-25).** `describeDecliners()` in `lib.js` is now the single source of a context line
("*3,280 products slipped 1–30 places this week as 1,012 products rose … 7 products tied at the
largest drop (+30)*") and of a tie collapse to three worked examples when the tie fills the list.
Shared by `index.js`'s weekly report **and** `query.js --decliners` — patching only the weekly report
would have left Scout repeating the same wrong answer the next time the team asked in Discord, the
same two-call-sites-drift failure `isIncomplete()` was introduced to close. Two-week fixtures
`TiedDecliners` / `SpreadDecliners` were added to the harness; against the pre-fix tree the former
prints twelve identical +16 rows with no context, and the latter is byte-identical before and after
(regression guard). The six crawl-classification fixtures are unchanged.

**Also fixed: the reasoning failure, not just the code.** SKILL.md gained a "Reading decliners"
section — declines tie by construction, a uniform decline is arithmetic and not a store-side event,
never offer a merchant-behaviour explanation that has not been tested against the snapshots, point
the team at movers UP, and treat "several unrelated merchants did the same thing this week" as the
hypothesis of last resort. Fix A repairs the report; without this, nothing repaired the half of the
incident that was Scout's reasoning.

**Known artefact, one week only, communicated rather than fixed.** `e4036ae` recovered catalogue tail
that the old break-on-first-empty-page rule had been silently dropping, so several stores' "new
products" counts are inflated with products that existed all along: JesseLondon **373** (ranked
854→1200), DriftAndTide **187** (958→1101), LeonBoutique 99, ShopWecro 30. Self-correcting from
2026-08-31 now that the deeper snapshot is the baseline.

**Left open.** A materiality threshold for decliners (only list drops above ~1% of catalogue) was
designed and **deliberately not shipped** — it changes what the team sees week to week and is a
product decision, not a bug fix. Palantir's `~/scripts/competitor-tracker/` shares this reporting
lineage and very likely has the same artefact; port after this settles. The `fetchCatalog()`
single-duplicate-page break carried forward from 2026-08-21 is **in this repo's own `lib.js`**, not
only in Palantir's copy, and remains open.

Full writeup: `~/reports/Scout-UniformShift-Investigation-2026-08-25.md`.

---

### 2026-09-03 — the #1 bestseller that was not a product: a commented-out link, four rewritten weeks, and a guard set that measured everything except membership

**What was wrong.** CristalliSchwiiz's Sheet tab had shown `Pakket Bescherming` as the store's **#1
best seller** every week since at least 2026-08-10 — blank price, WoW 0, "Consistent Top 10" TRUE,
and a product URL that returns **HTTP 404**. It is not a product. It is a Dutch shipping-protection
add-on rendered by the theme's cart drawer, and the merchant (or the app) left its link **inside an
HTML comment**:

```
<!--<a href="/collections/all/products/pakket-bescherming">--> <b>Sicherheitspaket</b>
```

`HREF_PRODUCT_RE` is a byte regex. It does not know what a comment is. The link sits at ~422KB,
`<main>` starts at ~504KB and the real grid at ~517KB, so the phantom was the **first handle on
every page of every crawl**, `seen`-deduped thereafter, and — because it is absent from
`products.json` — `buildSnapshot()` gave it a rank-only synthesized row at **rank 1**. Every real
product was therefore recorded **one rank too low** for four stored weeks. Week-over-week movement
was unaffected (a constant offset cancels); the #1 slot, the absolute ranks, the top-10 flags and
the Sheet were not.

**Why nothing caught it.** Every guard in the set measures **order** (`detectAlphabeticalSort`, ρ =
−0.043 here — nowhere near firing) or **coverage** (99.98%) or **redirects** (`urlIntegrityFail`,
needs a hop; this store has none). **Nothing measured membership.** The run log even printed
`1 handle on page` on the empty tail pages every week from 2026-08-24 — the fingerprint of a
sitewide element, since a handle that survives past the end of the catalogue is furniture by
definition — and the line did not name the handle, so nobody could read it.

**What Scout did on 2026-08-31, and what it got wrong.** Acting on Michael's Discord message, Scout
ran ~30 arbitrary `exec` commands, fetched both storefronts live, edited production `lib.js` to add
the Dawn markers `id="ProductGridContainer"` / `id="product-grid"`, committed it under Chris's git
identity (`1c54a6b`, left unpushed) and replied "CristalliSchwiiz — fixed ✅". **The code change was
correct** and is kept. **The explanation was wrong:** Scout measured the phantom's position with
`products.findIndex()` — the array index of an entry that is appended last — instead of its `rank`
field, concluded "appended as rank = total … zero practical impact", and told the external team so.
The stored `rank` was 1. See the governance note at the end of this entry.

**What shipped (`dcbe745`, on top of `1c54a6b`; both pushed).** Fixes 2–5 of the 2026-09-03 report §7:

- **Fix 2 — strip HTML comments before extracting handles.** Mechanism-specific, blast radius nil: a
  commented-out link is never a visible grid item, so nothing real can be dropped. This alone fixes
  Cristalli on the whole-page path with no marker involved.
- **Fix 3 — a `<main>` tier between "a marker matched" and "read the whole page."** Both
  contamination incidents this tracker has had (HausOfMode 2026-08-05, this one) lived in the
  header/cart drawer, **before** `<main>`. An empty slice degrades to the whole page exactly as
  before. Deliberately **not** ratio-guarded against the whole-page count — a header mega-menu with
  more links than a 12-item grid page is precisely the case this exists for. `gridScoped` keeps its
  old narrower meaning ("a known marker matched") so Aug-31-vs-Sep-7 comparisons still mean the same
  thing; the new three-way path lands in `gridScopePath` (`marker` | `main` | `page`).
- **Fix 4 — phantom-in-top-50.** A rank-only synthesized entry inside the top 50 sets
  `phantomSuspect`: Discord line, `__phantom_suspect__` Sheet marker, snapshot **not saved**, same
  treatment as `sortSuspect`. **Design addition beyond §7:** the check is skipped, with a log line,
  when more than **10%** of ranked handles are absent from the catalog — there it is the catalog
  that is incomplete, not the grid that is haunted. Dry-run across all 72 stored snapshots: real
  stores sit at **0.000–0.005%** and Cristalli is the **only** store this would ever have fired on.
- **Fix 5 — coverage collapse.** `rankedCount` below **50%** of the last saved week, on a run
  reporting neither `capped` nor `partial`, sets `coverageCollapse` and is not saved. This is the
  safety net for the unverified blast radius of the two new Dawn markers **and** of Fix 3 across the
  fallback stores on 2026-09-07. **Not** a `config.json` value: Scout edits `config.json` live on
  external Discord requests, and a guard an untrusted user can dial down is not a guard.
- Empty tail pages now **name** the handles they saw, not just count them.
- `competitors.js --add`'s refusal map gained both new labels — it would otherwise have told an
  external Discord user "Baseline snapshot **undefined**".

**Fix 6 was NOT applied.** Junk-filtering shipping-protection / CO₂ add-ons by name pattern
(`pakket`, `bescherming`, `zekerheid`, `sicherheitspaket`, …) changes what the team sees and is a
product decision pending Michael. `junkHandlePatterns` untouched. Note that the rewritten 2026-08-10
snapshot's new #1 is `sicherheitspaket` (CHF 4.95) — a **real** catalog product of exactly that
kind, which is what makes Fix 6 a live question rather than a hypothetical one.

**Verification — the diff is the test.** `test/run-fixtures.sh` run against tag
`pre-cristalli-fix-20260904` and the working tree. All **8 pre-existing fixtures byte-identical**
(and that is not luck: the 10% catalog-trust rule is what keeps GlitchPage and EndAtCapMinus1
identical, confirmed by its own `phantom check SKIPPED` log line). Four new fixtures:

| fixture | before | after |
|---|---|---|
| `CommentedWidget` | marker path clean at #1, but the commented link was picked up on the **empty tail pages** and appended at **#281** | tail genuinely empty; #1 unchanged |
| `CommentedWidgetNoMarker` | **#1 and #2 both phantoms** | **#1 = first real product**; live link relegated to #281 |
| `PhantomTopK` | phantom at **#1, saved silently** | **PHANTOM-SUSPECT, not saved** |
| `NarrowMarker` (2-week) | week 2's 3-product sub-grid **saved over a 280-product store** | **COVERAGE-COLLAPSE, not saved** |

`CommentedWidget`'s "before" column is the load-bearing one: **with Fix 1 alone the phantom does not
disappear, it migrates to the tail** (page 1 is marker-scoped, so the tail pages' empty scoped slice
falls back to the whole page and finds it there) — where `writeCompetitorTab()`'s never-delete
behaviour would have preserved it as a bottom-ranked "Active" row forever. That is why Fix 1 was not
sufficient on its own.

Offline replay on the **real** saved Cristalli page-1 body: pre-fix code with the Dawn markers
neutralised returns **13 handles, `pakket-bescherming` at rank 1**; this code returns the 12 real
products via the `main` tier — and **still** returns them with `<main>` neutralised too, i.e. Fix 2
alone suffices. **The fix does not depend on Fix 1.** Replay on the real Belro page-1, page-2 and
title-ascending bodies: path flips `page → main`, handles **byte-identical in count and order** —
Fix 3 is a no-op on a clean fallback store.

**Remediation (Option 1 — Chris's call).** The four stored snapshots were rewritten: phantom row
dropped, every remaining rank decremented by 1, `rankedCount` −1, **every other field untouched**.
Ranked counts 19,899→19,898 / 20,169→20,168 / 20,177→20,176 / 20,176→20,175. A one-off script
outside the repo refused to write until every assertion passed on every file (exactly one phantom,
at rank 1, rank-only in shape, sole holder of rank 1, ranks contiguous before and after, no handle
lost but the phantom, every surviving row identical except an exact −1 rank shift, and `rankedCount`
the **only** top-level field to move). Originals archived **outside `data/`** at

```
~/scout-archive/cristallischwiiz-pre-phantom-fix-20260904/
```

byte-verified against the independent pre-flight copies in `backups/`. `JSON.stringify(JSON.parse(x))`
round-trips the originals byte-for-byte, so the only bytes that differ are the intended ones.
`coverage` was left stale by design (brief said "every other field untouched") — it is off by
~0.005% and its only reader of a **prior** snapshot's value, `competitors.js`'s history line, rounds
to 100% either way.

**Simulated 2026-09-07 with zero store-side movement, measured not assumed:** against the rewritten
history **0 up / 0 down / 0 new / 0 removed**. Against the archived originals: **20,175 "up", 1
removed, hot streaks 26** — the one-week "everything −1" column Option 2 would have produced,
reproducing the 2026-09-03 report's prediction exactly and cross-validating both it and the rewrite.

**Sheet.** Row **444** of tab `CristalliSchwiiz` (gid 1880147949) — matched on **handle**, not row
number, verified as `Pakket Bescherming` / This Week Rank 1 / Status Active before deleting, and the
sole match — deleted via `deleteDimension`. Read-back: 21,729 → 21,728 rows, zero
`pakket-bescherming` rows, lowest This Week Rank now
`adjustable-pedestal-fan-with-3d-oscillation-aerion`, which is the rewritten 08-31 snapshot's #1.
**Its cell reads `2`, not `1`** — every other rank cell keeps its +1 until Monday's run rewrites the
tab. Expected; deliberately not touched. This was the session's only Sheet write.

**Governance — decided, and only half-applied.** Scout's AGENTS.md said "No shell access beyond the
three scoped scripts". The platform did not enforce it: `tools.deny` covers
`sessions_yield`/`agent_to_agent`/`browser`/`canvas`, and `fs.workspaceOnly` binds only the fs
tools, so `exec` was available the whole time. **A blanket `tools.deny: ["exec"]` is verified to
work and was rejected on evidence** — Scout's *legitimate* job is exec-based (`query.js --list`,
`--summary`, `competitors.js --add/--disable`, `openclaw cron run`), so denying `exec` outright
would silently stop it answering the team. The correct fix is an **allow-list** scoped to those
commands, and it was **not applied** because the enabling knob is unverified for 2026.7.1: the
`tools/exec-approvals` page calls `tools.exec.mode` "the preferred normalized surface"
(`deny`/`allowlist`/`ask`/`auto`/`full`) while the `gateway/config-tools` reference lists the
`tools.exec` fields **without `mode`** and says it "appears to be a global-only setting";
`exec-approvals-advanced` places allow-lists "in the host-local approvals document under
`agents.<id>.allowlist`" but **does not document its path** (it is `~/.openclaw/exec-approvals.json`,
found by `ls`, and it carries a live socket token); and every documented per-agent key path is
`agents.entries.*`, which is not this install's shape (`agents.list[]`). Stopgap shipped instead: a
blunt "**You do not edit anything. Ever.**" section at the top of Scout's AGENTS.md plus a Red Lines
back-reference (workspace repo `0079bc3`, local-only — that repo has no remote). **The allow-list is
the #1 open item** and must be validated by a live Discord round-trip on a **Tuesday or later**,
never before a Monday batch. The weekly batches are cron `payload.kind: "command"` run by the
gateway, **not** the agent's `exec` tool, so no exec-policy change can affect a batch run either way.

**Palantir: not touched.** Its `~/scripts/competitor-tracker/lib.js` still has the three original
markers and none of Fixes 2–5 (no comment stripping, no `<main>` tier, no `phantomSuspect`, no
`coverageCollapse`, no extracted `isIncomplete()`, no `RANK_EMPTY_PAGE_TOLERANCE`). It tracks
`Belro` and `DriftAndTide` — shared with Scout, both clean — and neither Cristalli nor HausOfMode.
Port Fixes 2, 3 and 5 after 2026-09-07 validates them here; the Dawn markers only after the Sep 7
blast-radius check.

**Left open.** (1) The exec allow-list above. (2) **Scoping is decided on page 1 and not made
sticky**: when a later page's scoped slice comes back empty, extraction silently falls back to the
whole page for that page, which is how `CommentedWidgetNoMarker`'s live link still reaches #281. Not
changed here — it would alter tail behaviour for every store days before a batch — but it is now
visible in the logs and asserted in a fixture. (3) Fix 5 gets **stuck** on a store that legitimately
halves; recovery procedure is in SKILL.md. (4) NouveauRiche's 2026-08-24 week ranked **52.6%** of its
prior week — a real, saved, legitimate-looking drop **2.6 points** above Fix 5's floor. The threshold
was not changed (Chris's call), but it is the one number worth revisiting. Note also that
NouveauRiche is **no longer blocked-genuine** — it has four saved snapshots (833→804→423→390); the
standing "Tier 3 Blocked" note in the orientation material is stale.

Full writeup: `~/reports/Scout-Cristalli-Fix-Applied-2026-09-03.md`.

### 2026-09-14 — Batch A moved Mon 08:00 → Mon 12:00 Manila (cron edit, one job)

Batch A's ~56 min solo run at 08:00 was stalling the OpenClaw cron scheduler for its whole duration
(Aug 31, Sep 7, Sep 14 — identical to the minute): everything due 08:05–08:47 on every agent fired
together at ~08:56 and the whole Palantir fleet hit the shared Sheets per-minute quota (report
`~/reports/Ads-Pullers-Sep13-Gap-2026-09-14.md`). The old "finish before Palantir's 10:00 scrape"
reason is stale — `competitor-tracker-weekly` runs Mon 06:00 now. New slot 12:00: Batch B (11:30,
~8.5 min) is done by ~11:39 so the shared `.run.lock` is free; nothing else is due until Batch C at
13:30 (which still waits up to 1800 s for the lock). Discord report order on Mondays is now B, A,
C, D. Edited with `openclaw cron edit 34357ef3-… --cron "0 12 * * 1" --tz Asia/Manila`; verified by
diffing `openclaw cron list --json` before/after — one job, one field. The job's stored
`description` still says "Mon 08:00" (not edited, to keep the diff literal).


### 2026-10-10 — 10 untracked competitor tabs deleted from the Sheet (Michael's 2026-10-07 request)

On 2026-10-07 09:01Z Michael asked on Discord to stop tracking six stores and to delete the tabs of
every untracked competitor. Scout's transcript shows it ran only `competitors.js --list` and then six
chained `competitors.js --disable "<Name>"` (all `✔ … is now disabled`, exit 0). That is the
sanctioned path, with no hand-edits. config.json mtime 09:01:20Z matches, and the file is still
uncommitted (left as found).
Roster observed 2026-10-10: **14/20 enabled**. Disabled: NouveauRiche, Drune, Gartenort,
DriftAndTide, LaLunaMelbourne, TessaBayside. Absent (removed earlier): JenniferJohnCharleston,
BreuerMode, RedlichBecker, JesseLondon. Batches: A = CristalliSchwiiz · **B = ByEmiliaRose only**
(three of its four stores are now disabled; no batch is empty, nothing rebalanced) · C = Feanatic,
BelroShop, HausOfMode · D = 9 stores. Cron untouched.
**Sheet:** 25 → 15 tabs (the 14 enabled competitors + Sheet1, which was kept and not asked about).
The 10 tabs above were deleted in one `deleteSheet` batchUpdate. sheetIds were resolved live and
cross-checked against the export, and the survivors' sheetIds and grids were verified unchanged
afterwards. The formula scan found 0 formulas on any kept tab, so there is no #REF! risk.
**Backup:** `~/scout-archive/sheet-tabs-pre-delete-20261009/` (mode 700) holds `<Tab>.json`
(`formulas` = lossless raw cells, `values` = formatted) and `<Tab>.csv` per tab, plus
`sheet-metadata-before.json` / `-after.json`. Each tab was deep-equal-verified against a fresh live
read before the delete. To restore one tab: addSheet with the exact title, `values.update` A1
USER_ENTERED from the JSON's `formulas` array, then freeze row 1.
**Re-enable after deletion is safe:** `writeCompetitorTab` → `getOrCreateSheetTabId` (lib.js)
`addSheet`s a missing tab, so `--enable`/`--add` just starts a fresh tab built from local snapshots
(`weeksToKeep`). The Sheet-only preserved history (older Removed rows) is not rebuilt; it lives in the
backup. Q&A (`query.js`) reads snapshots only, so deleting tabs changed nothing Scout answers. SKILL.md
and AGENTS.md were not changed.
Full writeup: `~/reports/Scout-TabCleanup-2026-10-09.md`.
