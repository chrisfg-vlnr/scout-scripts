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

for f in "RedlichBecker redlichbecker" "BreuerMode breuermode" "GlitchPage glitchpage" \
         "EndAtCapMinus1 endatcapminus1" "CleanEnd cleanend" "EmptyGrid emptygrid"; do
  run $f
done
for f in "TiedDecliners tieddecliners" "SpreadDecliners spreaddecliners"; do
  run2week $f
done
