#!/usr/bin/env bash
# gates-marker.sh — where a green FULL run of scripts/gates.sh is recorded, and
# the one reader of that record. Sourced, never executed: by gates.sh (which
# writes it), by scripts/git-hooks/pre-push and by scripts/release.sh
# --gates-passed (which accept it instead of rerunning the matrix).
#
# The record is two files in the repository's COMMON gitdir
# (`git rev-parse --git-common-dir`), so a run in any linked worktree — a
# console run's mirror — counts for the checkout it shares a repository with
# (measured-console phase 7, the audit's C3; one-pool phase 34 copied it by
# hand):
#
#   phase-console-gates-ok        the sha the run verified, one line
#   phase-console-gates-ok.json   what it ran: every stage and its seconds, the
#                                 heads at start and end, the tool versions, the
#                                 environment digest, the load, the drain
#
# gates.sh writes them only when every stage is green, HEAD did not move during
# the run and the tree was clean at both ends. A reader accepts them only for
# HEAD, on a clean tree, and only when the JSON names every stage of the full
# matrix — a record of a partial run is not a green gate.
#
# Target runtime is macOS system bash 3.2, like every script here.

GATES_MARKER_NAME=phase-console-gates-ok

# gates_marker_dir <root> — the common gitdir of <root>'s repository, absolute;
# nothing outside a git checkout.
gates_marker_dir() {
  local d
  d="$(git -C "$1" rev-parse --git-common-dir 2>/dev/null)" || return 0
  [ -n "$d" ] || return 0
  case "$d" in
    /*) ;;
    *) d="$(cd "$1" && cd "$d" && pwd)" || return 0 ;;
  esac
  printf '%s\n' "$d"
}

# gates_marker_check <root> <stage>… — exit 0 when the record covers <root>'s
# HEAD on a clean tree and its JSON names every <stage>; otherwise exit 1 with
# one line on stdout saying which of those does not hold.
gates_marker_check() {
  local root=$1 dir sha head
  shift
  dir="$(gates_marker_dir "$root")"
  [ -n "$dir" ] || { echo "not a git checkout"; return 1; }
  [ -f "$dir/$GATES_MARKER_NAME" ] || { echo "no green full run is recorded"; return 1; }
  sha="$(tr -d '[:space:]' < "$dir/$GATES_MARKER_NAME")"
  head="$(git -C "$root" rev-parse HEAD 2>/dev/null)"
  if [ -z "$head" ] || [ "$sha" != "$head" ]; then
    echo "the recorded green run is for ${sha:0:7}, not HEAD ${head:0:7}"
    return 1
  fi
  [ -z "$(git -C "$root" status --porcelain 2>/dev/null)" ] || { echo "the tree is not clean"; return 1; }
  [ -f "$dir/$GATES_MARKER_NAME.json" ] \
    || { echo "the recorded run has no $GATES_MARKER_NAME.json beside it — it predates the full record"; return 1; }
  command -v node >/dev/null 2>&1 || { echo "node is not on PATH, so the recorded run cannot be read"; return 1; }
  node -e '
    const [file, head, ...wanted] = process.argv.slice(1);
    let j;
    try { j = JSON.parse(require("fs").readFileSync(file, "utf8")); }
    catch (e) { console.log(`the recorded run is unreadable: ${e.message}`); process.exit(1); }
    if (j.head !== head || j.head_at_start !== head || j.head_now !== head) {
      console.log("the recorded run does not name HEAD at its start and its end"); process.exit(1);
    }
    const ran = new Set((Array.isArray(j.stages) ? j.stages : []).map((s) => s && s.name));
    const missing = wanted.filter((s) => !ran.has(s));
    if (missing.length) { console.log(`the recorded run is not the full matrix — it lacks ${missing.join(", ")}`); process.exit(1); }
  ' "$dir/$GATES_MARKER_NAME.json" "$head" "$@"
}
