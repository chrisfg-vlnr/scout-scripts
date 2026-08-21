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
for f in "RedlichBecker redlichbecker" "BreuerMode breuermode" "GlitchPage glitchpage" \
         "EndAtCapMinus1 endatcapminus1" "CleanEnd cleanend" "EmptyGrid emptygrid"; do
  run $f
done
