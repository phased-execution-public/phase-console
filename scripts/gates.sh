#!/usr/bin/env bash
# gates.sh — the release gate, run on this machine. There is no CI: this is
# what "main is always releasable" means now, and the pre-push hook
# (scripts/git-hooks/pre-push) runs it before a push leaves the machine.
#
#   scripts/gates.sh                 the full matrix, in the old ci.yml order
#   scripts/gates.sh --quick         typechecks, lint, format, scrub (under a minute)
#   scripts/gates.sh --list          print the stages this invocation would run
#   scripts/gates.sh --ci            reinstall viewer/node_modules first (npm ci)
#   scripts/gates.sh --build         build viewer/client/dist for real; the default
#                                    is verify:dist (a scratch build), because a
#                                    runtime copy serves client/dist per request
#   scripts/gates.sh --keep-going    run every stage even after one fails
#   scripts/gates.sh --install-hook  point this clone's core.hooksPath at
#                                    scripts/git-hooks, then exit
#   scripts/gates.sh --help          this text
#
# Exit 0 when every stage is green; 1 when a stage failed (named, with the last
# 40 lines of its log); 2 when a precondition is missing — bats-core, node,
# viewer/node_modules, a built client for the packaging stage — or an option is
# unknown. A green FULL run writes the sha it verified into
#   $(git rev-parse --git-path phase-console-gates-ok)
# which the hook and scripts/release.sh --gates-passed accept instead of
# rerunning ten minutes of suites for the same tree.
#
# Target runtime is macOS system bash 3.2, like every script here.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VIEWER="$ROOT/viewer"
# A git hook that runs this inherits git's view of ITS repository (an absolute
# GIT_DIR in a submodule checkout); the suites below run git in temp repos.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX

usage() {
  cat <<'USAGE'
usage: scripts/gates.sh [--quick] [--list] [--ci] [--build] [--keep-going] [--install-hook] [--help]
  (no flag)       the full matrix: bash engine, engine parity, server suite, the three
                  timing-sensitive files with one retry, client suite, both typechecks,
                  lint, format, build gate, scrub, pack + tarball assertions
  --quick         typecheck-server typecheck-client lint-client format-check scrub
  --list          print the stages this invocation would run, one per line
  --ci            run `npm ci` in viewer/ before the suites
  --build         `npm run build` + check:dist instead of verify:dist (touches client/dist)
  --keep-going    do not stop at the first failing stage
  --install-hook  set core.hooksPath=scripts/git-hooks for this clone, then exit
  --help          this text
USAGE
}

QUICK=0; LIST=0; CI=0; BUILD=0; KEEP=0; INSTALL_HOOK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --list) LIST=1 ;;
    --ci) CI=1 ;;
    --build) BUILD=1 ;;
    --keep-going) KEEP=1 ;;
    --install-hook) INSTALL_HOOK=1 ;;
    --help) usage; exit 0 ;;
    *) echo "gates.sh: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

FULL_STAGES="bash-engine npm-ci engine-parity server-suite terminal spawn-protocol runner-parallel client-suite typecheck-server typecheck-client lint-client format-check build scrub pack"
QUICK_STAGES="typecheck-server typecheck-client lint-client format-check scrub"

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
stage_engine_parity()    { (cd "$VIEWER" && node --test test/engine-parity.test.ts); }
stage_server_suite() {
  # Serial on purpose: the suite is documented load-sensitive. The three
  # timing-sensitive files run on their own, below, with one retry each.
  local files=() f
  for f in "$VIEWER"/test/*.test.ts; do
    case "$f" in
      */terminal.test.ts|*/spawn-protocol.test.ts|*/runner-parallel.test.ts) ;;
      *) files+=("test/$(basename "$f")") ;;
    esac
  done
  (cd "$VIEWER" && node --test --test-concurrency=1 "${files[@]}")
}
retry_once() { (cd "$VIEWER" && node --test "$1") || (cd "$VIEWER" && node --test "$1"); }
stage_terminal()         { retry_once test/terminal.test.ts; }
stage_spawn_protocol()   { retry_once test/spawn-protocol.test.ts; }
stage_runner_parallel()  { retry_once test/runner-parallel.test.ts; }
stage_client_suite()     { (cd "$VIEWER" && npm run test:client); }
stage_typecheck_server() { (cd "$VIEWER" && npm run typecheck:server); }
stage_typecheck_client() { (cd "$VIEWER" && npm run typecheck:client); }
stage_lint_client()      { (cd "$VIEWER" && npm run lint:client); }
stage_format_check()     { (cd "$VIEWER" && npm run format:check); }
stage_build() {
  if [ "$BUILD" -eq 1 ]; then
    (cd "$VIEWER" && npm run build && npm run check:dist)
  else
    (cd "$VIEWER" && npm run verify:dist)
  fi
}
stage_scrub()            { (cd "$ROOT" && bash .github/scripts/scrub.sh); }
stage_pack()             { (cd "$ROOT" && bash .github/scripts/pack-and-assert.sh); }

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
  if [ "$QUICK" -eq 0 ] && [ "$BUILD" -eq 0 ] && [ ! -f "$VIEWER/client/dist/index.html" ]; then
    echo "gates.sh: viewer/client/dist is not built and the pack stage reads it — run \`npm --prefix viewer run build\` once, or pass --build" >&2
    return 2
  fi
  return 0
}

# Where a green full run is recorded. Empty outside a git checkout.
marker_path() {
  local p
  p="$(cd "$ROOT" && git rev-parse --git-path phase-console-gates-ok 2>/dev/null)" || return 0
  case "$p" in
    /*) echo "$p" ;;
    *) echo "$ROOT/$p" ;;
  esac
}

run_stage() { # <name>
  local name=$1 fn start rc log
  fn="stage_$(printf '%s' "$name" | tr '-' '_')"
  log="$LOGDIR/$name.log"
  start=$(date +%s)
  if "$fn" > "$log" 2>&1; then
    printf 'ok    %-17s %4ss\n' "$name" "$(( $(date +%s) - start ))"
    return 0
  else
    rc=$?
    printf 'FAIL  %-17s %4ss  exit %s — last 40 lines of %s:\n' "$name" "$(( $(date +%s) - start ))" "$rc" "$log"
    tail -n 40 "$log" | sed 's/^/      /'
    return 1
  fi
}

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
LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/phase-console-gates.XXXXXX")"
MARKER="$(marker_path)"
if [ "$QUICK" -eq 0 ] && [ -n "$MARKER" ]; then rm -f "$MARKER"; fi

planned=0; for s in $PLAN; do planned=$((planned + 1)); done
ran=0; failed=0; started=$(date +%s)
for s in $PLAN; do
  ran=$((ran + 1))
  if ! run_stage "$s"; then
    failed=$((failed + 1))
    [ "$KEEP" -eq 1 ] || break
  fi
done
elapsed=$(( $(date +%s) - started ))

if [ "$failed" -eq 0 ]; then
  echo "gates: ALL GREEN — $ran stages in ${elapsed}s"
  if [ "$QUICK" -eq 0 ] && [ -n "$MARKER" ]; then
    (cd "$ROOT" && git rev-parse HEAD) > "$MARKER"
  fi
  rm -rf "$LOGDIR"
  exit 0
fi
echo "gates: $failed of $ran stages FAILED ($planned planned) in ${elapsed}s — logs in $LOGDIR"
exit 1
