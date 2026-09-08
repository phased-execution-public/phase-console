#!/usr/bin/env bash
# Pack the tarball and assert its contents — LOCALLY, without touching the
# client build the running console is serving.
#
#   bash .github/scripts/pack-and-assert.sh
#   bash .github/scripts/pack-and-assert.sh --keep        leave the tarball in place; print `tarball: <path>`
#   bash .github/scripts/pack-and-assert.sh --tree DIR    pack another checkout of this repository
#
# `--tree` (and running this file from inside one) works on a materialized tree
# as well as a checkout: nothing here needs a `.git` directory.
#
# The trade that buys: the old `git ls-files` cleanup was self-healing — it took
# ANY untracked `.js` with a `.ts` sibling, including one a crashed run left
# behind. The snapshot treats whatever is already on disk as source, so such a
# straggler is adopted rather than swept. That is the right way round for the
# materialized-tree case (where git answers about the wrong repository, or not at
# all) and worth knowing when a stale `viewer/server/*.js` turns up.
#
# scripts/release.sh packs with this too (`--keep --tree DIR`): the tarball a
# GitHub Release carries is exactly the one these assertions passed.
#
# On a development machine that same `npm pack` REBUILDS `viewer/client/dist`,
# which the live console serves per request — so checking packaging mid-phase
# would swap the client out from under whoever is watching a run. This does the
# two things prepack does that the assertions actually need, with the build left
# alone:
#
#   1. emit the type-stripped `.js` beside each server `.ts` (npm installs land
#      under node_modules, where node refuses to strip types), and
#   2. `npm pack --ignore-scripts`.
#
# Then it asserts, and cleans up after itself — which is the part that is easy
# to get wrong by hand: the emit drops ~86 files, and `viewer/server/
# fallback-sw.js` is real tracked source sitting among them. Only untracked
# `.js` files with a matching `.ts` sibling are removed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --tree)
      [ -n "${2:-}" ] || { echo "pack-and-assert: --tree needs a directory" >&2; exit 2; }
      ROOT="$(cd "$2" && pwd)" || { echo "pack-and-assert: no such directory: $2" >&2; exit 2; }
      shift ;;
    *) echo "pack-and-assert: unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
cd "$ROOT" || exit 2

if [ ! -f viewer/client/dist/index.html ]; then
  echo "pack-and-assert: viewer/client/dist is not built — the tarball assertions read it." >&2
  echo "  Build it once:  npm --prefix viewer run build" >&2
  echo "  (or use \`npm --prefix viewer run verify:dist\`, which builds into a scratch dir.)" >&2
  exit 2
fi

TSC="viewer/node_modules/.bin/tsc"
[ -x "$TSC" ] || { echo "pack-and-assert: no $TSC — run \`npm --prefix viewer ci\` first." >&2; exit 2; }

# Which `.js` files under viewer/server exist BEFORE the emit. Anything the emit
# adds is ours to remove; anything already here is source — `fallback-sw.js` is
# the one that actually is.
#
# This used to ask `git ls-files --error-unmatch`, which only answers inside a
# checkout. Run against a materialized tree — `.free-preview`, an unpacked
# tarball, anything with no `.git` of its own or ignored by the one above it —
# every file read as untracked and the cleanup deleted the source file with the
# emitted ones. A snapshot needs no repository and answers the same question.
pre_emit="$(mktemp)"
find viewer/server -name '*.js' -type f 2>/dev/null | LC_ALL=C sort > "$pre_emit"

emitted=""
cleanup() {
  # Precisely: it was not there before the emit, and it has a .ts sibling.
  while IFS= read -r js; do
    [ -f "${js%.js}.ts" ] || continue
    grep -qxF "$js" "$pre_emit" && continue
    rm -f "$js"
  done < <(find viewer/server -name '*.js' -type f 2>/dev/null)
  rm -f "$pre_emit"
  if [ "$KEEP" -eq 0 ] && [ -n "$emitted" ]; then rm -f "$emitted"; fi
}
trap cleanup EXIT

"$TSC" -p viewer/server/tsconfig.pack.json || { echo "pack-and-assert: the pack tsc failed." >&2; exit 1; }

emitted="$(npm pack --ignore-scripts 2>/dev/null | tail -1)"
[ -n "$emitted" ] && [ -f "$emitted" ] || { echo "pack-and-assert: npm pack produced no tarball." >&2; exit 1; }

bash "$ROOT/.github/scripts/assert-tarball.sh" "$emitted" || exit 1
if [ "$KEEP" -eq 1 ]; then
  printf 'tarball: %s/%s\n' "$ROOT" "$emitted"
fi
exit 0
