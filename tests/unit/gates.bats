#!/usr/bin/env bats
# gates.sh — the release gate, on this machine. `--list` is the contract the
# hook and the release script build on: the stage order IS ci.yml's old order,
# --quick is the cheap subset, --ci adds the reinstall. Nothing here runs a
# suite: these cases pin the plan, not the ten minutes.
load ../helpers/test_helper

GATES="$PE_SCRIPTS/gates.sh"

@test "gates: --list prints the full matrix in ci.yml's old order" {
  expected="bash-engine
engine-parity
server-suite
terminal
spawn-protocol
runner-parallel
client-suite
typecheck-server
typecheck-client
lint-client
format-check
build
e2e
scrub
pack"
  run "$SYS_BASH" "$GATES" --list
  [ "$status" -eq 0 ]
  [ "$output" = "$expected" ]
}



# The e2e stage drives a real Chromium, and the revision the pinned Playwright
# drives is a download nobody wants to discover forty minutes into a full run.
# Driven over a scratch tree holding exactly what the preflight reads, so the
# machine's own browser cache never answers for the test.
e2e_tree() {
  T="$BATS_TEST_TMPDIR/tree"
  mkdir -p "$T/scripts" "$T/viewer/node_modules/playwright-core" "$T/viewer/client/dist" "$BATS_TEST_TMPDIR/browsers"
  cp "$GATES" "$T/scripts/gates.sh"
  echo '<!doctype html>' > "$T/viewer/client/dist/index.html"
  printf '{"browsers":[{"name":"chromium","revision":"999998"},{"name":"chromium-headless-shell","revision":"999999"}]}\n' \
    > "$T/viewer/node_modules/playwright-core/browsers.json"
}


@test "gates: the e2e stage runs after build, before scrub" {
  run "$SYS_BASH" "$GATES" --list
  [ "$status" -eq 0 ]
  assert_contains "$output" "build
e2e
scrub"
}

@test "gates: the e2e stage tours the production build in dist mode, never Vite" {
  # control-tower phase 31: the console serves the build under its real CSP.
  sed -n '/^stage_e2e() {/,/^}/p' "$GATES" > "$BATS_TEST_TMPDIR/e2e.sh"
  run grep -c 'PHASE_CONSOLE_DIST_DIR="$dist" npm run test:e2e' "$BATS_TEST_TMPDIR/e2e.sh"
  [ "$output" = "1" ]
  # The default tours the scratch build verify:dist KEPT; --build tours client/dist.
  sed -n '/^stage_build() {/,/^}/p' "$GATES" > "$BATS_TEST_TMPDIR/build.sh"
  run grep -c 'npm run verify:dist -- --keep' "$BATS_TEST_TMPDIR/build.sh"
  [ "$output" = "1" ]
  sed -n '/^e2e_dist_dir() {/,/^}/p' "$GATES" > "$BATS_TEST_TMPDIR/dir.sh"
  run grep -c -e 'client/dist' -e 'client/.dist-verify' "$BATS_TEST_TMPDIR/dir.sh"
  [ "$output" = "1" ]
  assert_contains "$(cat "$BATS_TEST_TMPDIR/dir.sh")" 'client/.dist-verify'
}

@test "gates: the e2e stage refuses to tour when there is no production build" {
  # Run the stage function alone over a scratch viewer with no build in it.
  VIEWER="$BATS_TEST_TMPDIR/viewer" BUILD=0 run "$SYS_BASH" -c "
    VIEWER='$BATS_TEST_TMPDIR/viewer'; BUILD=0
    $(sed -n '/^e2e_dist_dir() {/,/^}/p' "$GATES")
    $(sed -n '/^stage_e2e() {/,/^}/p' "$GATES")
    stage_e2e"
  [ "$status" -eq 1 ]
  assert_contains "$output" "tours a production build"
}

@test "gates: a missing Playwright browser exits 2 before any stage, naming the line that installs it" {
  e2e_tree
  run env PLAYWRIGHT_BROWSERS_PATH="$BATS_TEST_TMPDIR/browsers" "$SYS_BASH" "$T/scripts/gates.sh"
  [ "$status" -eq 2 ]
  assert_contains "$output" "npm --prefix viewer exec -- playwright install chromium"
  assert_contains "$output" "999999"
  # The preflight refuses the RUN, not a stage: nothing ran.
  refute_contains "$output" "bash-engine"
}

@test "gates: with the browser revision installed the preflight lets the run start" {
  e2e_tree
  mkdir -p "$BATS_TEST_TMPDIR/browsers/chromium_headless_shell-999999"
  : > "$BATS_TEST_TMPDIR/browsers/chromium_headless_shell-999999/INSTALLATION_COMPLETE"
  run env PLAYWRIGHT_BROWSERS_PATH="$BATS_TEST_TMPDIR/browsers" "$SYS_BASH" "$T/scripts/gates.sh"
  # The scratch tree has no suites, so the first stage fails — with 1, a stage's
  # failure, never the preflight's 2.
  [ "$status" -eq 1 ]
  assert_contains "$output" "bash-engine"
}

@test "gates: --quick never asks for the browser" {
  e2e_tree
  run env PLAYWRIGHT_BROWSERS_PATH="$BATS_TEST_TMPDIR/browsers" "$SYS_BASH" "$T/scripts/gates.sh" --quick
  [ "$status" -ne 2 ]
  refute_contains "$output" "playwright install"
}

@test "gates: --list --quick is the five cheap stages" {
  run "$SYS_BASH" "$GATES" --list --quick
  [ "$status" -eq 0 ]
  [ "$output" = "typecheck-server
typecheck-client
lint-client
format-check
scrub" ]
}

@test "gates: --ci puts npm-ci second, and only then" {
  run "$SYS_BASH" "$GATES" --list --ci
  [ "${lines[0]}" = "bash-engine" ]
  [ "${lines[1]}" = "npm-ci" ]
  run "$SYS_BASH" "$GATES" --list
  [ "${lines[1]}" = "engine-parity" ]
}

@test "gates: an unknown option exits 2 and names it" {
  run "$SYS_BASH" "$GATES" --nope
  [ "$status" -eq 2 ]
  assert_contains "$output" "unknown option: --nope"
}

@test "gates: --help exits 0 and names every flag" {
  run "$SYS_BASH" "$GATES" --help
  [ "$status" -eq 0 ]
  for f in --quick --list --ci --build --keep-going --install-hook; do assert_contains "$output" "$f"; done
}


# --- the hook -------------------------------------------------------------
# Driven with a stub gates.sh beside a COPY of the hook, so nothing runs a
# suite and the decision is the only thing under test.
HOOK="$PE_SCRIPTS/git-hooks/pre-push"

setup_hook() {
  H="$BATS_TEST_TMPDIR/h"
  mkdir -p "$H/git-hooks"
  cp "$HOOK" "$H/git-hooks/pre-push"; chmod +x "$H/git-hooks/pre-push"
  # The stub records its argv (one line, possibly empty) and succeeds.
  printf '#!/bin/bash\nprintf "%%s\\n" "$*" > "%s/gates.log"\nexit 0\n' "$H" > "$H/gates.sh"
  chmod +x "$H/gates.sh"
  unset PHASE_CONSOLE_SKIP_GATES
}
push_refs() { printf '%s\n' "$@" > "$H/refs"; }
# The marker file, absolute: `git rev-parse --git-path` answers relative to the
# repository it runs in, which is not the directory a bats test stands in.
marker_of() { local p; p="$(cd "$1" && git rev-parse --git-path phase-console-gates-ok)"; case "$p" in /*) echo "$p" ;; *) echo "$1/$p" ;; esac; }

@test "hook: a push to main runs the full gates" {
  setup_hook
  push_refs "refs/heads/main 1111 refs/heads/main 2222"
  run "$SYS_BASH" "$H/git-hooks/pre-push" origin git@example.invalid:x.git < "$H/refs"
  [ "$status" -eq 0 ]
  [ "$(cat "$H/gates.log")" = "" ]
}

@test "hook: a tag runs the full gates" {
  setup_hook
  push_refs "refs/tags/v9.9.9 1111 refs/tags/v9.9.9 0000000000000000000000000000000000000000"
  run "$SYS_BASH" "$H/git-hooks/pre-push" origin url < "$H/refs"
  [ "$status" -eq 0 ]
  [ "$(cat "$H/gates.log")" = "" ]
}

@test "hook: any other branch runs --quick" {
  setup_hook
  push_refs "refs/heads/pe/x 1111 refs/heads/pe/x 2222"
  run "$SYS_BASH" "$H/git-hooks/pre-push" origin url < "$H/refs"
  [ "$status" -eq 0 ]
  [ "$(cat "$H/gates.log")" = "--quick" ]
}

@test "hook: main among other refs still means full" {
  setup_hook
  push_refs "refs/heads/pe/x 1111 refs/heads/pe/x 2222" "refs/heads/main 3333 refs/heads/main 4444"
  run "$SYS_BASH" "$H/git-hooks/pre-push" origin url < "$H/refs"
  [ "$(cat "$H/gates.log")" = "" ]
}

@test "hook: a delete is not a push of main" {
  setup_hook
  push_refs "(delete) 0000000000000000000000000000000000000000 refs/heads/main 2222"
  run "$SYS_BASH" "$H/git-hooks/pre-push" origin url < "$H/refs"
  [ "$status" -eq 0 ]
  [ "$(cat "$H/gates.log")" = "--quick" ]
}

@test "hook: PHASE_CONSOLE_SKIP_GATES=1 skips, and says so" {
  setup_hook
  push_refs "refs/heads/main 1111 refs/heads/main 2222"
  run env PHASE_CONSOLE_SKIP_GATES=1 "$SYS_BASH" "$H/git-hooks/pre-push" origin url < "$H/refs"
  [ "$status" -eq 0 ]
  [ ! -f "$H/gates.log" ]
  assert_contains "$output" "PHASE_CONSOLE_SKIP_GATES"
}

@test "hook: a recorded green run for HEAD on a clean tree stands in for the full gates" {
  setup_hook
  R="$BATS_TEST_TMPDIR/r"; mkdir -p "$R/scripts/git-hooks"
  git -C "$R" init -q -b main
  git -C "$R" config user.email t@t.t; git -C "$R" config user.name t
  cp "$H/git-hooks/pre-push" "$R/scripts/git-hooks/pre-push"; cp "$H/gates.sh" "$R/scripts/gates.sh"
  git -C "$R" add -A; git -C "$R" commit -qm init
  git -C "$R" rev-parse HEAD > "$(marker_of "$R")"
  push_refs "refs/heads/main 1111 refs/heads/main 2222"
  run "$SYS_BASH" -c "cd '$R' && '$SYS_BASH' scripts/git-hooks/pre-push origin url < '$H/refs'"
  [ "$status" -eq 0 ]
  [ ! -f "$H/gates.log" ]
  assert_contains "$output" "recorded green run"
  # A dirty tree forfeits the record.
  echo dirty > "$R/f"
  run "$SYS_BASH" -c "cd '$R' && '$SYS_BASH' scripts/git-hooks/pre-push origin url < '$H/refs'"
  [ "$(cat "$H/gates.log")" = "" ]
}

@test "hook: git's own GIT_DIR does not reach the gates" {
  setup_hook
  # The stub reports what it inherited; git exports an absolute GIT_DIR to a
  # hook in a submodule checkout, and a gate that runs git elsewhere must not see it.
  printf '#!/bin/bash\nprintf "%%s\\n" "${GIT_DIR:-unset}" > "%s/gates.log"\nexit 0\n' "$H" > "$H/gates.sh"
  push_refs "refs/heads/pe/x 1111 refs/heads/pe/x 2222"
  run env GIT_DIR=/nonexistent/.git GIT_WORK_TREE=/nonexistent "$SYS_BASH" "$H/git-hooks/pre-push" origin url < "$H/refs"
  [ "$status" -eq 0 ]
  [ "$(cat "$H/gates.log")" = "unset" ]
}

@test "gates: --install-hook sets core.hooksPath for the clone it runs in" {
  R="$BATS_TEST_TMPDIR/ih"; mkdir -p "$R/scripts/git-hooks"
  git -C "$R" init -q -b main
  cp "$GATES" "$R/scripts/gates.sh"; cp "$HOOK" "$R/scripts/git-hooks/pre-push"
  run "$SYS_BASH" "$R/scripts/gates.sh" --install-hook
  [ "$status" -eq 0 ]
  [ "$(git -C "$R" config core.hooksPath)" = "scripts/git-hooks" ]
  [ -x "$R/scripts/git-hooks/pre-push" ]
}
