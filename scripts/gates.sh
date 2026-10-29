#!/usr/bin/env bash
# gates.sh — the release gate, run on this machine. There is no CI: this is
# what "main is always releasable" means now, and the pre-push hook
# (scripts/git-hooks/pre-push) runs it before a push leaves the machine.
#
#   scripts/gates.sh                 the full matrix, every suite once
#   scripts/gates.sh --quick         typechecks, lint, format, scrub (under a minute)
#   scripts/gates.sh --list          print the stages this invocation would run
#   scripts/gates.sh --ci            reinstall viewer/node_modules first (npm ci)
#   scripts/gates.sh --build         build viewer/client/dist for real; the default
#                                    is ONE scratch build per commit,
#                                    client/.dist-<sha>, because a runtime copy
#                                    serves client/dist per request
#   scripts/gates.sh --drain         hold every console's automatic starts and wait
#                                    (at most 60 minutes) for live lanes to settle
#                                    before stage one; released on every exit
#   scripts/gates.sh --keep-going    run every stage even after one fails
#   scripts/gates.sh --verbose       a red stage also prints the last 40 lines of
#                                    its log
#   scripts/gates.sh --install-hook  point this clone's core.hooksPath at
#                                    scripts/git-hooks, then exit
#   scripts/gates.sh --help          this text
#
# Each stage prints at most three lines (measured-console phase 6, the audit's
# A4 — a session pays for every line it reads): green is one line, the stage
# and its seconds; red adds the failing ids its log names (TAP `not ok`, node's
# `✖`, vitest's `FAIL`, a suite gap, a tsc/eslint/prettier file — capped) and
# the log's path. Never the log itself unless --verbose asks.
#
# Exit 0 when every stage is green; 1 when a stage failed (named, with its
# failing ids and its log's path); 2 when a precondition is missing — bats-core, node,
# viewer/node_modules, a built client for the packaging stage — or an option is
# unknown — or, for the full matrix, when the tree is not clean: it verifies a
# commit, and a dirty tree is not one. A green FULL run on a HEAD that did not
# move and a tree that stayed clean records the sha it verified, and a JSON of
# what it ran, in the COMMON gitdir (scripts/gates-marker.sh says where and
# what), which the hook and scripts/release.sh --gates-passed accept instead of
# rerunning the matrix for the same commit.
#
# The order (measured-console phase 7, the audit's C1): every suite runs ONCE —
# engine-parity and dist-dir are their own stages, never the server suite's
# too; the client is built once per commit and every stage that reads a build
# reads that one; a stage named in BACKGROUND_STAGES starts beside the others
# the moment the run starts, in a TMPDIR of its own with its own log, and is
# awaited where the list names it — last, so it stays the last word.
#
# Target runtime is macOS system bash 3.2, like every script here.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VIEWER="$ROOT/viewer"
# Every `node --test` below: no test may run for more than ten minutes, and a
# file exits once its tests are done. `node --test` has no timeout of its own —
# one stranded await hung the whole suite silently for 88 minutes — and a timeout
# alone fails the test but leaves a file with a live handle running for ever.
# The same two flags as `npm test` (viewer/package.json); test/suite-timeout.test.ts
# holds them together.
NODE_TEST_BOUND=(--test-timeout=600000 --test-force-exit)
# A git hook that runs this inherits git's view of ITS repository (an absolute
# GIT_DIR in a submodule checkout); the suites below run git in temp repos.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX
# And a gate launched from a console's phase session inherits what that console
# exports to its sessions: the account's config dir (whose plugins the tour's
# Skills page then lists), the plugin seed and the telemetry receiver. The
# verdict is HEAD's, never its launcher's (measured-console phase 35, run 3).
unset CLAUDE_CONFIG_DIR CLAUDE_CODE_PLUGIN_SEED_DIR PE_OTEL_ENDPOINT PE_OTEL_TOKEN

usage() {
  cat <<'USAGE'
usage: scripts/gates.sh [--quick] [--list] [--ci] [--build] [--drain] [--keep-going] [--verbose] [--install-hook] [--help]
  (no flag)       the full matrix, each suite once: the client build, bash engine,
                  engine parity, server suite, the three timing-sensitive files with
                  one retry, client suite, both typechecks, lint, format, the
                  real-browser tour, scrub, pack + tarball assertions; refuses a
                  dirty tree, and a green run records HEAD in the common gitdir
  --quick         quarantine typecheck-server typecheck-client lint-client lint-test typecheck-test format-check scrub
  --list          print the stages this invocation would run, one per line
  --ci            run `npm ci` in viewer/ before the suites
  --build         `npm run build` + check:dist into client/dist, instead of the one
                  scratch build per commit (client/.dist-<sha>)
  --drain         `phase-console fleet hold --by gates`, wait up to 60 minutes for
                  every live lane on the machine to settle, run, release on exit
  --keep-going    do not stop at the first failing stage
  --verbose       a red stage also prints the last 40 lines of its log (the default
                  is at most three lines a stage: its name and seconds, the failing
                  ids, the log's path)
  --install-hook  set core.hooksPath=scripts/git-hooks for this clone, then exit
  --help          this text
USAGE
}

QUICK=0; LIST=0; CI=0; BUILD=0; KEEP=0; INSTALL_HOOK=0; VERBOSE=0; DRAIN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --list) LIST=1 ;;
    --ci) CI=1 ;;
    --build) BUILD=1 ;;
    --drain) DRAIN=1 ;;
    --keep-going) KEEP=1 ;;
    --verbose) VERBOSE=1 ;;
    --install-hook) INSTALL_HOOK=1 ;;
    --help) usage; exit 0 ;;
    *) echo "gates.sh: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# Set by the run before stage one (the commit it verifies, the client build every
# stage reads); empty for a stage sourced on its own (tests/unit/gates-suite.bats).
HEAD_AT_START=""; CLIENT_BUILD=""

# npm-ci first (only with --ci), then the build every later stage reads.
FULL_STAGES="npm-ci build quarantine bash-engine engine-parity server-suite terminal spawn-protocol runner-parallel client-suite typecheck-server typecheck-client lint-client lint-test typecheck-test format-check e2e scrub pack"
# The stages that run beside the others rather than in turn (none in the free copy).
BACKGROUND_STAGES=""
QUICK_STAGES="quarantine typecheck-server typecheck-client lint-client lint-test typecheck-test format-check scrub"

# The stages this invocation runs, in order, one per word.
stages() {
  local s out=""
  if [ "$QUICK" -eq 1 ]; then
    out="$QUICK_STAGES"
  else
    for s in $FULL_STAGES; do
      if [ "$s" = npm-ci ] && [ "$CI" -eq 0 ]; then continue; fi
      out="$out $s"
    done
  fi
  echo "$out"
}

# --- the stages, one function each; the name is the stage with - as _ -------
stage_bash_engine()      { (cd "$ROOT" && bash tests/run-tests.sh); }
stage_npm_ci()           { (cd "$VIEWER" && npm ci); }
stage_engine_parity()    { (cd "$VIEWER" && node --test "${NODE_TEST_BOUND[@]}" test/engine-parity.test.ts); }
stage_server_suite() {
  # Serial on purpose: the suite is documented load-sensitive. The three
  # timing-sensitive files run on their own, below, with one retry each;
  # engine-parity is its own stage and dist-dir runs in e2e's, on the pictures
  # the tour has just left — each file runs once in a full run (the audit's C1).
  local files=() f
  for f in "$VIEWER"/test/*.test.ts; do
    case "$f" in
      */terminal.test.ts|*/spawn-protocol.test.ts|*/runner-parallel.test.ts) ;;
      */engine-parity.test.ts|*/dist-dir.test.ts) ;;
      *) files+=("test/$(basename "$f")") ;;
    esac
  done
  # The ledger (#339): `node --test` reads a file that stopped part way as
  # green, so a reporter beside the spec one writes what each file enqueued and
  # finished (`viewer/test/suite-ledger.mjs`), and the stage fails on a gap
  # between the files planned and the files that reported in full.
  local ledger rc=0
  ledger="$(mktemp "${TMPDIR:-/tmp}/phase-console-suite-ledger.XXXXXX")"
  # PHASE_CONSOLE_GATE_STAGE: a file that reads the tour's pictures may skip,
  # naming why, while the suite runs before the e2e stage re-shoots them (#353).
  # PC_CLIENT_BUILD: a test that packs a package packs the run's one client
  # build rather than building its own.
  (cd "$VIEWER" && PHASE_CONSOLE_GATE_STAGE=server-suite PC_CLIENT_BUILD="$CLIENT_BUILD" \
    node --test "${NODE_TEST_BOUND[@]}" --test-concurrency=1 \
    --test-reporter=spec --test-reporter-destination=stdout \
    --test-reporter=./test/suite-ledger.mjs --test-reporter-destination="$ledger" \
    "${files[@]}") || rc=$?
  suite_gaps "$ledger" "${files[@]}" || { [ "$rc" -ne 0 ] || rc=1; }
  rm -f "$ledger"
  return "$rc"
}
# suite_gaps <ledger> <file>… — every planned file must have reported, every
# test it enqueued must have finished, and it must have reported a test of its
# own. Prints one line per gap; exit 1 on any.
suite_gaps() {
  local ledger=$1; shift
  printf '%s\n' "$@" | awk -F '\t' -v ledger="$ledger" '
    BEGIN { while ((getline line < ledger) > 0) { split(line, f, "\t"); enq[f[1]] = f[2]; fin[f[1]] = f[3]; seen[f[1]] = 1 } }
    {
      if (!($0 in seen)) { print "suite gap: " $0 " never reported"; gaps++; next }
      if (enq[$0] == 0) { print "suite gap: " $0 " reported none of its own tests — it stopped before it began"; gaps++; next }
      if (fin[$0] < enq[$0]) { print "suite gap: " $0 " stopped part way — " fin[$0] " of " enq[$0] " tests reported"; gaps++ }
    }
    END { if (gaps) { print gaps " file(s) did not report in full: the suite is NOT green"; exit 1 } }'
}
retry_once() {
  (cd "$VIEWER" && node --test "${NODE_TEST_BOUND[@]}" "$1") \
    || (cd "$VIEWER" && node --test "${NODE_TEST_BOUND[@]}" "$1")
}
stage_terminal()         { retry_once test/terminal.test.ts; }
stage_spawn_protocol()   { retry_once test/spawn-protocol.test.ts; }
stage_runner_parallel()  { retry_once test/runner-parallel.test.ts; }
stage_client_suite()     { (cd "$VIEWER" && npm run test:client); }
stage_typecheck_server() { (cd "$VIEWER" && npm run typecheck:server); }
stage_typecheck_client() { (cd "$VIEWER" && npm run typecheck:client); }
stage_lint_client()      { (cd "$VIEWER" && npm run lint:client); }
# viewer/test, linted and typechecked (measured-console phase 15): the lint is
# green outright; the types are held to test/typecheck-ratchet.json.
stage_lint_test()        { (cd "$VIEWER" && npm run lint:test); }
stage_typecheck_test()   { (cd "$VIEWER" && npm run typecheck:test); }

# The quarantine (scripts/quarantine.env, measured-console phase 15): every row
# names a suite, an owner, a day and a reason, and none is past its day — a
# quarantine is a loan. Read here in bash, so the quick matrix needs no node.
stage_quarantine() {
  local QUARANTINE_ROWS="" today id owner expires why bad=0 n=0
  # shellcheck source=quarantine.env
  . "$ROOT/scripts/quarantine.env"
  today="$(date -u +%Y-%m-%d)"
  while IFS="$(printf '\t')" read -r id owner expires why; do
    [ -n "$id$owner$expires$why" ] || continue
    n=$((n + 1))
    case "$id" in node:?*|bats:?*|vitest:?*|playwright:?*) ;; *) echo "quarantine: $id — the id names no suite (node bats vitest playwright)"; bad=1; continue ;; esac
    if [ -z "$owner" ] || [ -z "$why" ]; then echo "quarantine: $id — every row names an owner and a reason"; bad=1; continue; fi
    case "$expires" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) echo "quarantine: $id — the expiry '$expires' is not a YYYY-MM-DD day"; bad=1; continue ;; esac
    if [[ "$today" > "$expires" ]]; then
      echo "quarantine: $id EXPIRED on $expires (owner $owner) — fix it, or renew the row with a reason"
      bad=1
    fi
  done <<ROWS
$QUARANTINE_ROWS
ROWS
  [ "$bad" -eq 0 ] && echo "quarantine: $n row(s), none expired"
  return "$bad"
}
stage_format_check()     { (cd "$VIEWER" && npm run format:check); }
# The run's ONE client build (the audit's C1): `client/.dist-<sha>`, addressed
# by the commit it is built from — a clean tree at a commit IS that commit's
# content, and the stamp (`.build-rev`) names the commit, so a build is reused
# only for the commit it says it is. e2e tours it, the server suite's package
# test copies it, pack packs it. A second run on the same
# commit reuses it after the build gate has read it again; a build of another
# commit is pruned. `--build` writes client/dist instead, as it always did.
client_build_dir() {
  if [ "$BUILD" -eq 1 ]; then echo "$VIEWER/client/dist"; return; fi
  local head
  head="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" || head=""
  if [ -n "$head" ]; then echo "$VIEWER/client/.dist-${head:0:12}"; else echo "$VIEWER/client/.dist-verify"; fi
}
# prune_client_builds <keep> — every other per-commit build under client/.
prune_client_builds() {
  local d base re='^\.dist-[0-9a-f]{12}$'
  for d in "$VIEWER"/client/.dist-*; do
    [ -d "$d" ] || continue
    base="$(basename "$d")"
    [ "$base" = "$1" ] && continue
    if [[ $base =~ $re ]]; then rm -rf "$d"; fi
  done
}
stage_build() {
  local name rev
  if [ "$BUILD" -eq 1 ]; then
    (cd "$VIEWER" && npm run build && npm run check:dist)
    return
  fi
  name="$(basename "$CLIENT_BUILD")"
  rev="$(tr -d '[:space:]' < "$CLIENT_BUILD/.build-rev" 2>/dev/null)"
  if [ -f "$CLIENT_BUILD/index.html" ] && [ -n "$HEAD_AT_START" ] && [ "$rev" = "$HEAD_AT_START" ]; then
    echo "gates.sh: the client built for ${rev:0:12} is already here — the build gate reads it again"
    (cd "$VIEWER" && PC_DIST_DIR="$name" node scripts/check-dist.mjs) || return 1
  else
    rm -rf "$CLIENT_BUILD"
    (cd "$VIEWER" && npm run verify:dist -- --keep --dir "$name") || return 1
  fi
  prune_client_builds "$name"
}
# The real-browser harness (viewer/e2e): a sandboxed console, toured in
# Chromium over four viewports and held to e2e/baseline.json — which is empty
# since 6.0, so any finding fails. After `build`, and ON that build: dist mode
# (`PHASE_CONSOLE_DIST_DIR`) has the console serve the production client under
# its real CSP, with no Vite in front, because that is the client a person
# meets (control-tower phase 31). `--build` tours client/dist; the default
# tours the run's one build, which stays for the packing stages.
stage_e2e() {
  local dist="$CLIENT_BUILD"
  if [ ! -f "$dist/index.html" ]; then
    echo "gates.sh: the e2e stage tours a production build and $dist holds none — the build stage runs first" >&2
    return 1
  fi
  # Then the tour's own promise, on the pictures it has just left (#353).
  (cd "$VIEWER" && npm run typecheck:e2e && PHASE_CONSOLE_DIST_DIR="$dist" npm run test:e2e \
    && node --test "${NODE_TEST_BOUND[@]}" test/dist-dir.test.ts)
}
stage_scrub()            { (cd "$ROOT" && bash .github/scripts/scrub.sh); }
# The source tarball, carrying the run's one build — whose `.build-rev` must be
# HEAD, which assert-tarball.sh now checks (the audit's C3, #358's shape).
stage_pack()             { (cd "$ROOT" && bash .github/scripts/pack-and-assert.sh --dist "$CLIENT_BUILD"); }

preflight() {
  command -v node >/dev/null 2>&1 || { echo "gates.sh: node is not on PATH" >&2; return 2; }
  if [ "$QUICK" -eq 0 ] && ! command -v bats >/dev/null 2>&1; then
    echo "gates.sh: bats-core is not installed (brew install bats-core) — the bash-engine stage needs it" >&2
    return 2
  fi
  if [ "$CI" -eq 0 ] && [ ! -d "$VIEWER/node_modules" ]; then
    echo "gates.sh: viewer/node_modules is missing — run \`npm --prefix viewer ci\` once, or pass --ci" >&2
    return 2
  fi
  local missing
  if [ "$QUICK" -eq 0 ] && missing="$(e2e_browser_missing)"; then
    echo "gates.sh: the e2e stage needs Playwright's $missing, which is not installed — run \`npm --prefix viewer exec -- playwright install chromium\` once" >&2
    return 2
  fi
  return 0
}

# Prints the browser the pinned Playwright drives headless (name-revision) and
# succeeds when it is NOT installed where Playwright looks: PLAYWRIGHT_BROWSERS_PATH
# ("0" meaning inside node_modules), else the per-user cache. Silent failure when it
# is there — or when Playwright itself is not installed yet (--ci installs it, and
# the stage then says what is missing in Playwright's own words).
e2e_browser_missing() {
  local json="$VIEWER/node_modules/playwright-core/browsers.json"
  [ -f "$json" ] || return 1
  PC_JSON="$json" PC_CORE="$VIEWER/node_modules/playwright-core" node -e '
    const { existsSync, readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const os = require("node:os");
    const b = JSON.parse(readFileSync(process.env.PC_JSON, "utf8")).browsers
      .find((x) => x.name === "chromium-headless-shell");
    if (!b) process.exit(1);
    const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const cache = env === "0" ? join(process.env.PC_CORE, ".local-browsers")
      : env ? env
      : process.platform === "darwin" ? join(os.homedir(), "Library", "Caches", "ms-playwright")
      : join(process.env.XDG_CACHE_HOME || join(os.homedir(), ".cache"), "ms-playwright");
    const dir = join(cache, "chromium_headless_shell-" + b.revision);
    if (existsSync(join(dir, "INSTALLATION_COMPLETE"))) process.exit(1);
    process.stdout.write("chromium-headless-shell-" + b.revision + " (" + dir + ")");
  '
}

# Where a green full run is recorded, and the reader the hook and release.sh
# share: the common gitdir (scripts/gates-marker.sh).
# shellcheck source=gates-marker.sh
. "$HERE/gates-marker.sh"

# How many failing ids a red stage names on its one line, and how much of each.
FAIL_ID_CAP=5
FAIL_ID_CHARS=80

# failing_ids <log> — ONE line naming what a red stage's log says failed:
# `failing (N): a · b · … · +K more`, or, when it names no test or file,
# `last line: <the log's last non-blank line>`. The shapes are the ones the
# stages print: TAP `not ok N [-] name` (bats, tests/run-tests.sh's summary,
# node's tap reporter; a TODO/SKIP is not a failure), node's spec reporter
# `✖ name (1.2ms)`, vitest `FAIL  file > name`, the server suite's own
# `suite gap: <file>`, and the file a tsc error, an eslint report or a
# prettier warning names. Each id once, in order, the repository's prefix cut.
failing_ids() {
  awk -v root="$ROOT/" -v cap="$FAIL_ID_CAP" -v width="$FAIL_ID_CHARS" '
    function add(id) {
      gsub(/^[ \t]+|[ \t]+$/, "", id)
      if (index(id, root) == 1) id = substr(id, length(root) + 1)
      if (id == "" || (id in seen)) return
      seen[id] = 1; n++
      if (length(id) > width) id = substr(id, 1, width - 1) "…"
      if (n <= cap) ids[n] = id
    }
    { line = $0; sub(/\r$/, "", line) }
    line ~ /^[ \t]*not ok [0-9]+/ {
      s = line; sub(/^[ \t]*not ok [0-9]+( -)?[ \t]*/, "", s)
      if (s ~ /#[ \t]*(TODO|SKIP)/) next
      sub(/[ \t]+#[ \t].*$/, "", s); add(s); next
    }
    line ~ /^[ \t]*✖ .* \([0-9.]+m?s\)[ \t]*$/ {
      s = line; sub(/^[ \t]*✖ /, "", s); sub(/ \([0-9.]+m?s\)[ \t]*$/, "", s); add(s); next
    }
    line ~ /^[ \t]*FAIL[ \t]+[^ \t]/ { s = line; sub(/^[ \t]*FAIL[ \t]+/, "", s); add(s); next }
    line ~ /^suite gap: [^ ]+/ { s = line; sub(/^suite gap: /, "", s); sub(/ .*$/, "", s); add(s); next }
    line ~ /error TS[0-9]+:/ { s = line; sub(/[(:][0-9]+[,:][0-9]+\)?:?( -)? *error TS.*$/, "", s); add(s); next }
    line ~ /^\[warn\] / && line !~ /Code style issues|Run Prettier/ { s = line; sub(/^\[warn\] /, "", s); add(s); next }
    line ~ /^\/[^ \t]+\.(ts|tsx|js|jsx|mjs|cjs)$/ { add(line); next }
    line ~ /[^ \t]/ { last = line }
    END {
      if (n > 0) {
        out = "failing (" n "): "
        for (i = 1; i <= n && i <= cap; i++) out = out (i > 1 ? " · " : "") ids[i]
        if (n > cap) out = out " · +" (n - cap) " more"
        print out
      } else if (last != "") {
        gsub(/^[ \t]+|[ \t]+$/, "", last)
        if (length(last) > 160) last = substr(last, 1, 159) "…"
        print "last line: " last
      } else print "the log is empty"
    }' "$1"
}

# report_stage <name> <seconds> <rc> <log> — the stage's lines (one green,
# three red: never the log itself, the audit's A4) and its row in the run's
# record, which the marker's JSON is written from.
# known_reds_cover <stage> <log> — exit 0 (and the words) when the stage's log
# names at least one failing test and every one is in viewer/known-reds.json.
known_reds_cover() {
  [ -f "$VIEWER/known-reds.json" ] && command -v node >/dev/null 2>&1 || return 1
  node "$VIEWER/scripts/reds-ratchet.mjs" gate "$1" "$2" 2>/dev/null
}

report_stage() {
  local name=$1 secs=$2 rc=$3 log=$4
  printf '%s\t%s\t%s\n' "$name" "$secs" "$rc" >> "$LOGDIR/stages.tsv"
  if [ "$rc" -eq 0 ]; then
    printf 'ok    %-17s %4ss\n' "$name" "$secs"
    return 0
  fi
  # The reds a release carries are a ratchet (viewer/known-reds.json,
  # measured-console phase 15): a stage whose every red is a known one, filed
  # and owned, passes and says so; one new red fails it, naming it.
  local carried
  if carried="$(known_reds_cover "$name" "$log")"; then
    printf 'ok    %-17s %4ss  %s\n' "$name" "$secs" "$carried"
    return 0
  fi
  printf 'FAIL  %-17s %4ss  exit %s\n' "$name" "$secs" "$rc"
  printf '      %s\n' "$(failing_ids "$log")"
  printf '      log: %s\n' "$log"
  if [ "$VERBOSE" -eq 1 ]; then
    echo "      --- last 40 lines (--verbose) ---"
    tail -n 40 "$log" | sed 's/^/      /'
  fi
  return 1
}

# A stage runs as a child the script WAITS on, rather than in the foreground:
# bash runs a trap only between foreground commands, so a kill would otherwise
# wait out an hour-long stage before the drain's hold was released.
CUR_PID=""
run_stage() { # <name>
  local name=$1 fn start rc=0 log
  fn="stage_$(printf '%s' "$name" | tr '-' '_')"
  log="$LOGDIR/$name.log"
  start=$(date +%s)
  "$fn" > "$log" 2>&1 &
  CUR_PID=$!
  wait "$CUR_PID" || rc=$?
  CUR_PID=""
  report_stage "$name" "$(( $(date +%s) - start ))" "$rc" "$log"
}

# A stage that runs beside the others (BACKGROUND_STAGES): started with stage one in a
# short TMPDIR of its own, its log apart, and awaited where the list names it — last.
# It writes its exit code and seconds to files, so the wait reads a fact rather
# than a `wait` status a trap may have taken.
# The TMPDIR is SHORT, made under /tmp (GATES_BG_TMP_BASE), never under $LOGDIR:
# a unix socket path holds 104 bytes on macOS, and macOS's own TMPDIR plus the
# log directory left a test's `pc-pty-<hex>.sock` at 116 (measured-console
# phase 8). It is removed in the exit trap.
BG_NAME=""; BG_PID=""; BG_TMP=""
start_background() { # <name>
  local name=$1 fn
  fn="stage_$(printf '%s' "$name" | tr '-' '_')"
  BG_TMP="$(mktemp -d "${GATES_BG_TMP_BASE:-/tmp}/pcg-$name.XXXXXX")" || BG_TMP="$LOGDIR/$name.tmp"
  mkdir -p "$BG_TMP"
  (
    start=$(date +%s); rc=0
    TMPDIR="$BG_TMP" "$fn" > "$LOGDIR/$name.log" 2>&1 || rc=$?
    echo "$(( $(date +%s) - start ))" > "$LOGDIR/$name.secs"
    echo "$rc" > "$LOGDIR/$name.rc"
  ) &
  BG_NAME=$name; BG_PID=$!
}
await_background() { # <name>
  local name=$1 rc
  wait "$BG_PID" 2>/dev/null
  BG_PID=""
  rc="$(cat "$LOGDIR/$name.rc" 2>/dev/null)"
  [ -n "$rc" ] || rc=1
  report_stage "$name" "$(cat "$LOGDIR/$name.secs" 2>/dev/null || echo 0)" "$rc" "$LOGDIR/$name.log"
}
# kill_tree <pid> — the process and everything it started, children first.
kill_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done
  kill -TERM "$1" 2>/dev/null
}

# --- the drain (the audit's C9) -----------------------------------------------
# `--drain` asks the fleet supervisor to hold every console's automatic starts
# (`phase-console fleet hold --by gates`), waits for every live lane on the
# machine to settle — at most DRAIN_CAP_S, then it runs anyway and says so — and
# releases the hold in the EXIT trap, so a red run, a ^C or a kill all let the
# fleet go. One `gate.drain` line says what it found; the marker's JSON keeps it.
DRAIN_CAP_S="${GATES_DRAIN_CAP_S:-3600}"
DRAIN_POLL_S="${GATES_DRAIN_POLL_S:-30}"
HELD=0; DRAINED=false; DRAIN_JSON=null
console_cli() {
  if [ -n "${GATES_CONSOLE_CLI:-}" ]; then "$GATES_CONSOLE_CLI" "$@"
  else node "$ROOT/bin/phase-console.mjs" "$@"; fi
}
# live_lanes — the machine's live lanes, summed over the census; empty when the
# census cannot be read.
live_lanes() {
  console_cli fleet instances --json 2>/dev/null | node -e '
    let raw = ""; process.stdin.on("data", (c) => { raw += c; }).on("end", () => {
      try {
        const rows = JSON.parse(raw).rows || [];
        process.stdout.write(String(rows.reduce((n, r) => n + (Number(r && r.lanes && r.lanes.live) || 0), 0)));
      } catch { /* unreadable: say nothing */ }
    });' 2>/dev/null
}
drain_hold() {
  local lanes first waited=0 capped=false
  if ! console_cli fleet hold --by gates > "$LOGDIR/drain.log" 2>&1; then
    echo "gate.drain refused — $(tail -n 1 "$LOGDIR/drain.log") — the run goes on undrained"
    DRAIN_JSON="{\"held\":false,\"reason\":\"hold refused\"}"
    return 0
  fi
  HELD=1; DRAINED=true
  lanes="$(live_lanes)"; first="${lanes:-unknown}"
  while [ "${lanes:-1}" != 0 ]; do
    if [ "$waited" -ge "$DRAIN_CAP_S" ]; then capped=true; break; fi
    sleep "$DRAIN_POLL_S"; waited=$((waited + DRAIN_POLL_S))
    lanes="$(live_lanes)"
  done
  if [ "$capped" = true ]; then
    echo "gate.drain held by=gates lanes=$first waited=${waited}s capped=true — ${lanes:-unknown} lane(s) still live after the cap; running anyway"
  else
    echo "gate.drain held by=gates lanes=$first waited=${waited}s capped=false"
  fi
  DRAIN_JSON="{\"held\":true,\"lanes_at_start\":\"$first\",\"lanes_at_run\":\"${lanes:-unknown}\",\"waited_s\":$waited,\"capped\":$capped,\"cap_s\":$DRAIN_CAP_S}"
}
drain_release() {
  [ "$HELD" -eq 1 ] || return 0
  HELD=0
  console_cli fleet release > /dev/null 2>&1 || echo "gate.drain: the release failed — run: phase-console fleet release" >&2
}
on_exit() {
  [ -z "$CUR_PID" ] || kill_tree "$CUR_PID"
  [ -z "$BG_PID" ] || kill_tree "$BG_PID"
  [ -z "$BG_TMP" ] || rm -rf "$BG_TMP"
  drain_release
}

# --- the record of a green full run (the audit's C3) --------------------------
# load_reading — the machine's load as the console's load guard reads it: the
# 1/5/15-minute averages and the CPUs they are read against.
load_reading() {
  node -e 'const os = require("os"); const [a, b, c] = os.loadavg();
    process.stdout.write(JSON.stringify({ load1: +a.toFixed(2), load5: +b.toFixed(2), load15: +c.toFixed(2), cpus: os.cpus().length }));' 2>/dev/null \
    || printf 'null'
}
# write_marker <dir> — the JSON of what this run ran, then the sha. The sha last:
# a reader that finds it finds the JSON beside it.
write_marker() {
  local dir=$1 claude_v bats_v
  claude_v="$(claude --version 2>/dev/null | head -n 1)" || claude_v=""
  bats_v="$(bats --version 2>/dev/null | awk '{print $2}')" || bats_v=""
  GM_STAGES="$LOGDIR/stages.tsv" GM_HEAD="$HEAD_AT_START" GM_HEAD_NOW="$HEAD_NOW" \
  GM_STARTED="$STARTED_AT" GM_ENDED="$(date -u +%Y-%m-%dT%H:%M:%SZ)" GM_TOTAL="$elapsed" \
  GM_LOAD_START="$LOAD_START" GM_LOAD_END="$(load_reading)" GM_DRAINED="$DRAINED" GM_DRAIN="$DRAIN_JSON" \
  GM_NPM="$(npm --version 2>/dev/null)" GM_BATS="$bats_v" GM_CLAUDE="$claude_v" GM_BASH="$BASH_VERSION" \
  GM_CI="$CI" GM_BUILD="$BUILD" GM_OUT="$dir/$GATES_MARKER_NAME.json" node -e '
    const fs = require("fs"); const { createHash } = require("crypto"); const e = process.env;
    const stages = fs.readFileSync(e.GM_STAGES, "utf8").split("\n").filter(Boolean)
      .map((l) => { const [name, seconds] = l.split("\t"); return { name, seconds: Number(seconds) }; });
    const ENV_KEYS = ["PATH", "NODE_OPTIONS", "NODE_ENV", "LANG", "LC_ALL", "TZ", "CI", "SHELL", "HOME", "PLAYWRIGHT_BROWSERS_PATH"];
    const env = Object.fromEntries(ENV_KEYS.map((k) => [k, e[k] ?? null]));
    const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
    const record = {
      version: 1, full: true, head: e.GM_HEAD, head_at_start: e.GM_HEAD, head_now: e.GM_HEAD_NOW, clean: true,
      stages, total_s: Number(e.GM_TOTAL), started_at: e.GM_STARTED, ended_at: e.GM_ENDED,
      options: { ci: e.GM_CI === "1", build: e.GM_BUILD === "1" },
      versions: { node: process.version, npm: e.GM_NPM || null, bats: e.GM_BATS || null, claude: e.GM_CLAUDE || null, bash: e.GM_BASH || null },
      env_keys: ENV_KEYS, env_digest: createHash("sha256").update(JSON.stringify(env)).digest("hex").slice(0, 16),
      load: { start: parse(e.GM_LOAD_START), end: parse(e.GM_LOAD_END) },
      drained: e.GM_DRAINED === "true", drain: parse(e.GM_DRAIN),
    };
    fs.writeFileSync(e.GM_OUT, JSON.stringify(record, null, 2) + "\n");' || return 1
  printf '%s\n' "$HEAD_AT_START" > "$dir/$GATES_MARKER_NAME"
}

# Sourced (a test of one stage, `tests/unit/gates-suite.bats`): the stages are
# defined, and nothing runs.
(return 0 2>/dev/null) && return 0

if [ "$INSTALL_HOOK" -eq 1 ]; then
  chmod +x "$HERE/git-hooks/pre-push"
  git -C "$ROOT" config core.hooksPath scripts/git-hooks || exit 1
  echo "gates.sh: core.hooksPath = scripts/git-hooks for $(git -C "$ROOT" rev-parse --show-toplevel)"
  echo "  a push to main or a tag runs the full gates (or accepts a recorded green run for the same sha);"
  echo "  any other ref runs --quick; PHASE_CONSOLE_SKIP_GATES=1 git push … skips them, and says so."
  exit 0
fi

PLAN="$(stages)"
if [ "$LIST" -eq 1 ]; then
  for s in $PLAN; do echo "$s"; done
  exit 0
fi

preflight || exit 2

# The full matrix verifies a COMMIT: HEAD is read now, and a tree that is not
# clean is refused before stage one, naming what makes it dirty. Outside a git
# checkout there is no commit to record, and nothing is refused or recorded.
MARKER_DIR=""
# The marker is the RELEASE's (measured-console phase 15): a run under the
# phase tier — a phase's selected form, PE_VERIFY_TIER=phase — verifies what
# its phase changed, never the commit, and records nothing.
if [ "${PE_VERIFY_TIER:-}" = phase ]; then
  echo "gates.sh: the phase tier (PE_VERIFY_TIER=phase) — this run verifies what a phase changed; no record will be written"
elif [ "$QUICK" -eq 0 ] && HEAD_AT_START="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"; then
  dirty="$(git -C "$ROOT" status --porcelain 2>/dev/null)"
  if [ -n "$dirty" ]; then
    echo "gates.sh: the tree is not clean, and the full matrix verifies a commit — commit or remove these first:" >&2
    printf '%s\n' "$dirty" | head -n 10 | sed 's/^/  /' >&2
    exit 2
  fi
  MARKER_DIR="$(gates_marker_dir "$ROOT")"
  [ -z "$MARKER_DIR" ] || rm -f "$MARKER_DIR/$GATES_MARKER_NAME" "$MARKER_DIR/$GATES_MARKER_NAME.json"
fi

TMP_BASE="${TMPDIR:-/tmp}"
LOGDIR="$(mktemp -d "${TMP_BASE%/}/phase-console-gates.XXXXXX")"
: > "$LOGDIR/stages.tsv"
CLIENT_BUILD="$(client_build_dir)"
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
started=$(date +%s)
[ "$DRAIN" -eq 0 ] || [ "$QUICK" -eq 1 ] || drain_hold
LOAD_START="$(load_reading)"

planned=0; for s in $PLAN; do planned=$((planned + 1)); done
ran=0; failed=0
for s in $PLAN; do
  # A background stage starts with the first stage after the reinstall, and is
  # awaited where the list names it.
  if [ -z "$BG_NAME" ] && [ "$s" != npm-ci ]; then
    for b in $BACKGROUND_STAGES; do
      case " $PLAN " in *" $b "*) [ "$s" = "$b" ] || { start_background "$b"; break; } ;; esac
    done
  fi
  ran=$((ran + 1))
  if [ -n "$BG_NAME" ] && [ "$s" = "$BG_NAME" ]; then
    await_background "$s" || failed=$((failed + 1))
  elif ! run_stage "$s"; then
    failed=$((failed + 1))
  fi
  if [ "$failed" -gt 0 ] && [ "$KEEP" -eq 0 ]; then break; fi
done
elapsed=$(( $(date +%s) - started ))

if [ "$failed" -eq 0 ]; then
  echo "gates: ALL GREEN — $ran stages in ${elapsed}s"
  if [ -n "$MARKER_DIR" ]; then
    HEAD_NOW="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"
    if [ "$HEAD_NOW" != "$HEAD_AT_START" ]; then
      echo "gates: no record written — HEAD moved during the run (${HEAD_AT_START:0:12} → ${HEAD_NOW:0:12}), so no one commit was verified"
    elif [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
      echo "gates: no record written — the tree changed during the run:"
      git -C "$ROOT" status --porcelain 2>/dev/null | head -n 10 | sed 's/^/  /'
    elif write_marker "$MARKER_DIR"; then
      echo "gates: recorded ${HEAD_AT_START:0:12} in $MARKER_DIR/$GATES_MARKER_NAME (+ .json)"
    else
      echo "gates: the record could not be written in $MARKER_DIR"
    fi
  fi
  rm -rf "$LOGDIR"
  exit 0
fi
echo "gates: $failed of $ran stages FAILED ($planned planned) in ${elapsed}s — logs in $LOGDIR"
exit 1
