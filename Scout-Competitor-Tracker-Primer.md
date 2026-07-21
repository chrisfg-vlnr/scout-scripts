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
