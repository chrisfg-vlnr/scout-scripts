#!/bin/bash
# Fixture harness for the crawl-classification states. NO NETWORK, NO LIVE TRAFFIC:
# test/mock.mjs replaces global fetch and serves generated pages, and the throwaway config
# it writes sets minDelayMs/maxDelayMs to 0, so a 900-page fixture runs in seconds.
#
#   ./test/run-fixtures.sh                  # run every fixture against the working tree
#   ./test/run-fixtures.sh <git-ref>        # run every fixture against an older revision
#
# Comparing a ref against the working tree is the point: a change to any of these states
# should show a DIFFERENT result before and after, or it isn't tested.
#
#   ./test/run-fixtures.sh pre-generic-crawl-fixes-2026-08-21   # state before 2026-08-21
#
# Fixtures (name -> what it reproduces):
#   RedlichBecker  redlichbecker   >25,000 products: products.json 400s at page 101 with
#                                  Shopify's ceiling error, rank crawl runs the full budget.
#                                  MUST report CATALOG TRUNCATED and MUST NOT save.
#   BreuerMode     breuermode      password-gated: / 302s to /password, products.json 401s.
#                                  MUST report CLOSED, not PARTIAL/BLOCKED.
#   GlitchPage     glitchpage      one duplicate page at 50 of a real 200-page catalogue.
#                                  MUST crawl past it (1,372 ranked before the fix, 5,572 after).
#   EndAtCapMinus1 endatcapminus1  genuine end one page before the store's cap. MUST NOT be
#                                  reported as capped (regression guard for the tolerance).
#   CleanEnd       cleanend        ordinary healthy store. MUST stay 100% coverage, unflagged.
#   EmptyGrid      emptygrid       no catalog and no ranks, no redirect. Tier 0 label.
#
# Two-week fixtures (report presentation, not crawl classification). Both weeks crawl
# identically clean; only the bestseller ORDER changes, so any difference is the report:
#   TiedDecliners   tieddecliners   a block of products overtakes a contiguous band, so that
#                                   band declines by ONE identical amount. Before the fix the
#                                   top-12 list is twelve identical rows with no context — the
#                                   2026-08-24 defect. After: context line + collapsed tie.
#   SpreadDecliners spreaddecliners ordinary movement, max decline shared by only a few.
#                                   REGRESSION GUARD: the list must still render in full.
#
# Extraction/guard fixtures added 2026-09-03 (report §7 Fixes 2-5). These print more than the
# Tier line — the extraction path taken, the guard lines fired, and rank 1 / the last rank of any
# saved snapshot — because for these the CLASSIFICATION is not the artefact under test, the
# recorded ORDER is:
#   CommentedWidget         commentedwidget          known marker + a commented-out drawer link.
#                                                    Page 1 clean on both trees (regression guard
#                                                    for the marker path); before Fix 2 the tail
#                                                    pages pick the commented link up as the last
#                                                    rank, after it they are genuinely empty.
#   CommentedWidgetNoMarker commentedwidgetnomarker  unknown grid id, one commented AND one live
#                                                    phantom in the drawer. Before: ranks 1-2 are
#                                                    both phantoms. After: rank 1 is the first real
#                                                    product — Fix 2 removes the commented one,
#                                                    Fix 3's <main> slice the live one; neither
#                                                    alone does both. The live link still lands at
#                                                    the TAIL via the empty-page whole-page
#                                                    fallback: asserted, not hidden (open item).
#   PhantomTopK             phantomtopk              no <main>, no marker, live drawer link absent
#                                                    from products.json reaches rank 1. Before:
#                                                    saved, silently. After: PHANTOM-SUSPECT, not
#                                                    saved.
#   NarrowMarker            narrowmarker             TWO-WEEK. Week 2 grows an id="product-grid"
#                                                    block of 3 products after the real 280-product
#                                                    grid. Before: 3 ranked, SAVED — a whole store
#                                                    replaced by a fragment. After: COVERAGE-
#                                                    COLLAPSE, not saved.
set -u
REF="${1:-}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
if [ -n "$REF" ]; then
  git -C "$SRC" archive "$REF" lib.js index.js competitors.js | tar -x -C "$T" || exit 1
  echo "### tree: $REF"
else
  cp "$SRC"/lib.js "$SRC"/index.js "$SRC"/competitors.js "$T"/
  echo "### tree: working tree"
fi
cp "$SRC"/test/mock.mjs "$T"/
[ -f "$SRC/package.json" ] && cp "$SRC/package.json" "$T"/
ln -s "$SRC/node_modules" "$T/node_modules"
python3 - "$SRC" "$T" <<'PY'
import json, sys
c = json.load(open(sys.argv[1] + "/config.json"))
c["fetch"].update(minDelayMs=0, maxDelayMs=0, maxRetries=0)
c["sheetId"] = ""
c["competitors"] = [
  {"name":"RedlichBecker","baseUrl":"https://redlich-becker.de","collection":"all","enabled":True,"batch":"D","currency":None},
  {"name":"BreuerMode","baseUrl":"https://breuermode.de","collection":"all","enabled":True,"batch":"D","currency":None},
  {"name":"GlitchPage","baseUrl":"https://glitch.example","collection":"all","enabled":True,"batch":"D","currency":None},
  {"name":"EndAtCapMinus1","baseUrl":"https://endcap.example","collection":"all","enabled":True,"maxRankPages":20,"batch":"D","currency":None},
  {"name":"CleanEnd","baseUrl":"https://clean.example","collection":"all","enabled":True,"batch":"D","currency":None},
  {"name":"EmptyGrid","baseUrl":"https://empty.example","collection":"all","enabled":True,"batch":"D","currency":None},
  {"name":"TiedDecliners","baseUrl":"https://tied.example","collection":"all","enabled":True,"batch":"D","currency":None},
  {"name":"SpreadDecliners","baseUrl":"https://spread.example","collection":"all","enabled":True,"batch":"D","currency":None},
  {"name":"CommentedWidget","baseUrl":"https://cw.example","collection":"all","enabled":True,"batch":"D","currency":None},
  {"name":"CommentedWidgetNoMarker","baseUrl":"https://cwnm.example","collection":"all","enabled":True,"batch":"D","currency":None},
  {"name":"PhantomTopK","baseUrl":"https://ptk.example","collection":"all","enabled":True,"batch":"D","currency":None},
  {"name":"NarrowMarker","baseUrl":"https://nm.example","collection":"all","enabled":True,"batch":"D","currency":None},
]
json.dump(c, open(sys.argv[2] + "/config.json", "w"), indent=2)
PY
run() {
  rm -rf "$T/data"
  ( cd "$T" && FIXTURE="$2" node --import ./mock.mjs index.js --only "$1" \
      --no-sheet --no-discord --no-prune 2>&1 ) > "$T/out.txt"
  echo "--- $1"
  grep -E "^  Tier" "$T/out.txt" | sed 's/^/    /'
  local saved; saved="$(ls "$T/data" 2>/dev/null | tr '\n' ' ')"
  echo "    saved: ${saved:-<nothing>}"
}
# Two-week runner: week 1 establishes the baseline snapshot through the REAL buildSnapshot/
# saveSnapshot path (no hand-written snapshot JSON to drift from the real format), week 2
# supplies the movement and prints the report. --no-discord makes index.js print the report
# preview, which is the artefact under test.
run2week() {
  rm -rf "$T/data"
  ( cd "$T" && FIXTURE="$2" WEEK=1 node --import ./mock.mjs index.js --only "$1" \
      --no-sheet --no-discord --no-prune --date 2026-08-17 ) > "$T/w1.txt" 2>&1
  ( cd "$T" && FIXTURE="$2" WEEK=2 node --import ./mock.mjs index.js --only "$1" \
      --no-sheet --no-discord --no-prune --date 2026-08-24 ) > "$T/w2.txt" 2>&1
  echo "--- $1"
  if ! grep -q "Biggest movers down" "$T/w2.txt"; then
    echo "    !! no report produced — week 1 baseline likely did not save"
    grep -E "^  Tier|error" "$T/w1.txt" | sed 's/^/    w1: /'
    return
  fi
  # Everything from the movers-down heading to the next blank-prefixed section.
  sed -n '/Biggest movers down/,/New products this week/p' "$T/w2.txt" \
    | grep -v "New products this week" | sed 's/^/    /'
  echo "    distinct WoW values shown: $(sed -n '/Biggest movers down/,/New products this week/p' "$T/w2.txt" \
    | grep -oE '\(\+[0-9]+\)' | sort -u | tr '\n' ' ')"
}

# Extraction runner: same single-week run as run(), but reports the artefacts that matter for an
# ORDER bug rather than a classification bug — which extraction tier page 1 took, which guards
# fired, and (when a snapshot was saved) the first and last ranks actually recorded.
runrank() {
  rm -rf "$T/data"
  ( cd "$T" && FIXTURE="$2" node --import ./mock.mjs index.js --only "$1" \
      --no-sheet --no-discord --no-prune 2>&1 ) > "$T/out.txt"
  echo "--- $1"
  grep -E "^  Tier" "$T/out.txt" | sed 's/^/    /'
  grep -m1 "grid extraction:" "$T/out.txt" | sed 's/^ *\[[^]]*\] /    /'
  local mism; mism="$(grep -c "differs from page 1" "$T/out.txt")" || true
  [ "${mism:-0}" != "0" ] && echo "    page-path mismatch lines: $mism"
  grep -E "PHANTOM-SUSPECT:|COVERAGE-COLLAPSE:|phantom check SKIPPED:" "$T/out.txt" \
    | sed 's/^ *\[[^]]*\] /    /'
  local saved; saved="$(ls "$T/data" 2>/dev/null | tr '\n' ' ')"
  echo "    saved: ${saved:-<nothing>}"
  if [ -n "$saved" ]; then
    node -e '
      const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const r = s.products.filter(p => p.rank != null).sort((a, b) => a.rank - b.rank);
      console.log(`    ranked ${s.rankedCount} | path ${s.gridScopePath} | #1 ${r[0].handle}`
        + ` | #2 ${r[1] ? r[1].handle : "-"} | last #${r[r.length-1].rank} ${r[r.length-1].handle}`);
    ' "$T/data/$(ls "$T/data" | head -1)"
  fi
  return 0
}

# Two-week extraction runner. Week 1 establishes a real baseline through the production
# buildSnapshot/saveSnapshot path; week 2 is the run under test. Unlike run2week() this does NOT
# grep for a movers list — the point of week 2 here is that it produces an INCOMPLETE report and
# saves nothing, so there is no movers list to find.
runnarrow() {
  rm -rf "$T/data"
  local w d
  for w in 1 2; do
    if [ "$w" = "1" ]; then d=2026-08-17; else d=2026-08-24; fi
    ( cd "$T" && FIXTURE="$2" WEEK=$w node --import ./mock.mjs index.js --only "$1" \
        --no-sheet --no-discord --no-prune --date $d ) > "$T/w$w.txt" 2>&1
    echo "--- $1 week $w ($d)"
    grep -E "^  Tier" "$T/w$w.txt" | sed 's/^/    /'
    grep -m1 "grid extraction:" "$T/w$w.txt" | sed 's/^ *\[[^]]*\] /    /'
    grep -E "PHANTOM-SUSPECT:|COVERAGE-COLLAPSE:" "$T/w$w.txt" | sed 's/^ *\[[^]]*\] /    /'
    echo "    saved: $(ls "$T/data" 2>/dev/null | tr '\n' ' ')"
  done
  return 0
}

for f in "RedlichBecker redlichbecker" "BreuerMode breuermode" "GlitchPage glitchpage" \
         "EndAtCapMinus1 endatcapminus1" "CleanEnd cleanend" "EmptyGrid emptygrid"; do
  run $f
done
for f in "TiedDecliners tieddecliners" "SpreadDecliners spreaddecliners"; do
  run2week $f
done
for f in "CommentedWidget commentedwidget" "CommentedWidgetNoMarker commentedwidgetnomarker" \
         "PhantomTopK phantomtopk"; do
  runrank $f
done
runnarrow NarrowMarker narrowmarker
