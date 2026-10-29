#!/usr/bin/env bats
# gates.sh — the release gate, on this machine. `--list` is the contract the
# hook and the release script build on: every stage once, the one client build
# first, verify-free last (measured-console phase 7, the audit's C1); --quick is
# the cheap subset, --ci adds the reinstall. Nothing here runs a suite: these
# cases pin the plan, not the hours. The record a green run leaves, the dirty
# refusal and the drain are tests/unit/gates-record.bats.
load ../helpers/test_helper

GATES="$PE_SCRIPTS/gates.sh"

@test "gates: --list prints the full matrix, each stage once, the build first" {
  expected="build
quarantine
bash-engine
engine-parity
server-suite
terminal
spawn-protocol
runner-parallel
client-suite
typecheck-server
typecheck-client
lint-client
lint-test
typecheck-test
format-check
e2e
scrub
pack"
  run "$SYS_BASH" "$GATES" --list
  [ "$status" -eq 0 ]
  [ "$output" = "$expected" ]
  # Every stage once (the audit's C1): no suite runs twice in a full run.
  [ -z "$(printf '%s\n' "$output" | sort | uniq -d)" ]
}

@test "gates: the server suite runs neither engine-parity nor dist-dir — each is its own stage's" {
  sed -n '/^stage_server_suite() {/,/^}/p' "$GATES" > "$BATS_TEST_TMPDIR/fn.sh"
  run grep -c -e '\*/engine-parity.test.ts|\*/dist-dir.test.ts) ;;' "$BATS_TEST_TMPDIR/fn.sh"
  [ "$output" = "1" ]
  # …and they are run: engine-parity by its stage, dist-dir by e2e's.
  run grep -c 'test/engine-parity.test.ts' "$GATES"
  [ "$output" -ge 1 ]
  sed -n '/^stage_e2e() {/,/^}/p' "$GATES" > "$BATS_TEST_TMPDIR/e2e.sh"
  run grep -c 'test/dist-dir.test.ts' "$BATS_TEST_TMPDIR/e2e.sh"
  [ "$output" = "1" ]
}



# The e2e stage drives a real Chromium, and the revision the pinned Playwright
# drives is a download nobody wants to discover forty minutes into a full run.
# Driven over a scratch tree holding exactly what the preflight reads, so the
# machine's own browser cache never answers for the test.
e2e_tree() {
  T="$BATS_TEST_TMPDIR/tree"
  mkdir -p "$T/scripts" "$T/viewer/node_modules/playwright-core" "$T/viewer/client/dist" "$BATS_TEST_TMPDIR/browsers"
  cp "$GATES" "$T/scripts/gates.sh"
  cp "$PE_SCRIPTS/gates-marker.sh" "$T/scripts/gates-marker.sh"
  echo '<!doctype html>' > "$T/viewer/client/dist/index.html"
  printf '{"browsers":[{"name":"chromium","revision":"999998"},{"name":"chromium-headless-shell","revision":"999999"}]}\n' \
    > "$T/viewer/node_modules/playwright-core/browsers.json"
}


@test "gates: the build is the first stage, e2e runs before scrub and pack" {
  run "$SYS_BASH" "$GATES" --list
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "build" ]
  assert_contains "$output" "e2e
scrub
pack"
}

@test "gates: the e2e stage tours the run's one build in dist mode, never Vite" {
  # control-tower phase 31: the console serves the build under its real CSP.
  sed -n '/^stage_e2e() {/,/^}/p' "$GATES" > "$BATS_TEST_TMPDIR/e2e.sh"
  run grep -c 'PHASE_CONSOLE_DIST_DIR="$dist" npm run test:e2e' "$BATS_TEST_TMPDIR/e2e.sh"
  [ "$output" = "1" ]
  assert_contains "$(cat "$BATS_TEST_TMPDIR/e2e.sh")" 'local dist="$CLIENT_BUILD"'
  # The default builds client/.dist-<sha> once; --build writes client/dist.
  sed -n '/^stage_build() {/,/^}/p' "$GATES" > "$BATS_TEST_TMPDIR/build.sh"
  run grep -c 'npm run verify:dist -- --keep --dir "$name"' "$BATS_TEST_TMPDIR/build.sh"
  [ "$output" = "1" ]
  run "$SYS_BASH" -c ". '$GATES'; ROOT='$PE_DIR'; VIEWER='$PE_DIR/viewer'; BUILD=0; client_build_dir; BUILD=1; client_build_dir"
  [ "${lines[0]}" = "$PE_DIR/viewer/client/.dist-$(git -C "$PE_DIR" rev-parse HEAD | cut -c1-12)" ]
  [ "${lines[1]}" = "$PE_DIR/viewer/client/dist" ]
}

@test "gates: every stage that reads a client build reads the run's one build" {
  sed -n '/^stage_server_suite() {/,/^}/p' "$GATES" > "$BATS_TEST_TMPDIR/fn.sh"
  assert_contains "$(cat "$BATS_TEST_TMPDIR/fn.sh")" 'PC_CLIENT_BUILD="$CLIENT_BUILD"'
  run grep -c '^stage_pack() .*pack-and-assert.sh --dist "$CLIENT_BUILD"' "$GATES"
  [ "$output" = "1" ]
}

@test "gates: a per-commit build is pruned when another commit's is made, and nothing else is" {
  V="$BATS_TEST_TMPDIR/viewer"
  mkdir -p "$V/client/.dist-aaaaaaaaaaaa" "$V/client/.dist-bbbbbbbbbbbb" "$V/client/.dist-verify" "$V/client/.dist-previous" "$V/client/dist"
  run "$SYS_BASH" -c ". '$GATES'; VIEWER='$V'; prune_client_builds .dist-bbbbbbbbbbbb"
  [ "$status" -eq 0 ]
  [ ! -d "$V/client/.dist-aaaaaaaaaaaa" ]
  [ -d "$V/client/.dist-bbbbbbbbbbbb" ]
  [ -d "$V/client/.dist-verify" ] && [ -d "$V/client/.dist-previous" ] && [ -d "$V/client/dist" ]
}

@test "gates: the e2e stage refuses to tour when there is no production build" {
  # Run the stage function alone over a scratch viewer with no build in it.
  run "$SYS_BASH" -c "
    VIEWER='$BATS_TEST_TMPDIR/viewer'; CLIENT_BUILD='$BATS_TEST_TMPDIR/viewer/client/.dist-x'
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
  assert_contains "$output" "FAIL  build"
}

@test "gates: --quick never asks for the browser" {
  e2e_tree
  run env PLAYWRIGHT_BROWSERS_PATH="$BATS_TEST_TMPDIR/browsers" "$SYS_BASH" "$T/scripts/gates.sh" --quick
  [ "$status" -ne 2 ]
  refute_contains "$output" "playwright install"
}

@test "gates: --list --quick is the eight cheap stages" {
  run "$SYS_BASH" "$GATES" --list --quick
  [ "$status" -eq 0 ]
  [ "$output" = "quarantine
typecheck-server
typecheck-client
lint-client
lint-test
typecheck-test
format-check
scrub" ]
}

@test "gates: --ci puts npm-ci first — before the build reads node_modules — and only then" {
  run "$SYS_BASH" "$GATES" --list --ci
  [ "${lines[0]}" = "npm-ci" ]
  [ "${lines[1]}" = "build" ]
  run "$SYS_BASH" "$GATES" --list
  [ "${lines[0]}" = "build" ]
  refute_contains "$output" "npm-ci"
}

@test "gates: an unknown option exits 2 and names it" {
  run "$SYS_BASH" "$GATES" --nope
  [ "$status" -eq 2 ]
  assert_contains "$output" "unknown option: --nope"
}

@test "gates: --help exits 0 and names every flag" {
  run "$SYS_BASH" "$GATES" --help
  [ "$status" -eq 0 ]
  for f in --quick --list --ci --build --drain --keep-going --verbose --install-hook; do assert_contains "$output" "$f"; done
}

# --- the terse output (measured-console phase 6, the audit's A4) ------------
# A session pays for every line it reads, so a stage prints at most three:
# green is one, red adds its failing ids and its log's path. Driven over the
# scratch tree with a stub npm whose stages are loud, so the rule is held
# against output that would have filled the screen.
terse_tree() {
  e2e_tree
  B="$BATS_TEST_TMPDIR/bin"; mkdir -p "$B"
  cat > "$B/npm" <<'STUB'
#!/bin/bash
i=0; while [ $i -lt 120 ]; do echo "noise line $i of $2"; i=$((i + 1)); done
case "$2" in
  typecheck:client)
    echo "not ok 7 - the broken one"
    echo "not ok 8 - the other one # TODO not a failure"
    echo "trailing noise after the failure"
    exit 1 ;;
esac
exit 0
STUB
  chmod +x "$B/npm"
  mkdir -p "$BATS_TEST_TMPDIR/tmp"
}

@test "gates: a green stage is one line, a red one three — its ids and its log, never the log itself" {
  terse_tree
  run env PATH="$B:$PATH" TMPDIR="$BATS_TEST_TMPDIR/tmp" "$SYS_BASH" "$T/scripts/gates.sh" --quick
  [ "$status" -eq 1 ]
  # quarantine and typecheck-server green, typecheck-client red, then the run's one summary.
  [ "${#lines[@]}" -eq 6 ] || { echo "$output" >&2; return 1; }
  [[ "${lines[0]}" =~ ^ok\ +quarantine\ +[0-9]+s$ ]]
  [[ "${lines[1]}" =~ ^ok\ +typecheck-server\ +[0-9]+s$ ]]
  [[ "${lines[2]}" =~ ^FAIL\ +typecheck-client\ +[0-9]+s\ +exit\ 1$ ]]
  [ "${lines[3]}" = "      failing (1): the broken one" ]
  [[ "${lines[4]}" =~ ^\ +log:\ (.+/typecheck-client\.log)$ ]]
  log="${BASH_REMATCH[1]}"
  [ -f "$log" ]
  assert_contains "$(cat "$log")" "noise line 119 of typecheck:client"
  assert_contains "${lines[5]}" "gates: 1 of 3 stages FAILED"
  refute_contains "$output" "noise line"
  refute_contains "$output" "last 40 lines"
}

@test "gates: --verbose restores the red stage's tail" {
  terse_tree
  run env PATH="$B:$PATH" TMPDIR="$BATS_TEST_TMPDIR/tmp" "$SYS_BASH" "$T/scripts/gates.sh" --quick --verbose
  [ "$status" -eq 1 ]
  assert_contains "$output" "failing (1): the broken one"
  assert_contains "$output" "last 40 lines (--verbose)"
  assert_contains "$output" "trailing noise after the failure"
  # The tail is the red stage's, never the green one's.
  refute_contains "$output" "of typecheck:server"
}

@test "gates: the failing-id line is capped, and a log that names no test gives its last line" {
  L="$BATS_TEST_TMPDIR/ids.log"
  { for i in 1 2 3 4 5 6 7 8; do echo "not ok $i case $i"; done
    echo "✖ a spec failure (12.5ms)"
    echo "✖ failing tests:"
    echo "✖ a spec failure (12.5ms)"
    echo "suite gap: test/x.test.ts stopped part way — 1 of 2 tests reported"
  } > "$L"
  run "$SYS_BASH" -c ". '$GATES'; failing_ids '$L'"
  [ "$status" -eq 0 ]
  [ "$output" = "failing (10): case 1 · case 2 · case 3 · case 4 · case 5 · +5 more" ]

  printf 'one\n\n  gates.sh: the last word  \n\n' > "$L"
  run "$SYS_BASH" -c ". '$GATES'; failing_ids '$L'"
  [ "$output" = "last line: gates.sh: the last word" ]

  printf 'server/x.ts(3,4): error TS2322: no\n[warn] client/a.tsx\n[warn] Code style issues found. Run Prettier with --write to fix.\n' > "$L"
  run "$SYS_BASH" -c ". '$GATES'; failing_ids '$L'"
  [ "$output" = "failing (2): server/x.ts · client/a.tsx" ]
}

# tests/run-tests.sh prints a summary and keeps the TAP in a log under TMPDIR.
# Driven over a scratch tree of three tiny suites, so nothing real runs.
run_tests_tree() {
  RT="$BATS_TEST_TMPDIR/rt"
  mkdir -p "$RT/tests/unit" "$RT/tests/integration" "$RT/scripts" "$BATS_TEST_TMPDIR/rtmp"
  cp "$PE_DIR/tests/run-tests.sh" "$RT/tests/run-tests.sh"
  printf '#!/bin/bash\necho hi\n' > "$RT/scripts/a.sh"
  printf '@test "i" { true; }\n' > "$RT/tests/integration/y.bats"
}

@test "run-tests: a red run prints counts and the failing names, with the log that holds the TAP" {
  run_tests_tree
  printf '@test "a" { true; }\n@test "b" { skip "later"; }\n@test "c breaks" { false; }\n' > "$RT/tests/unit/x.bats"
  run env TMPDIR="$BATS_TEST_TMPDIR/rtmp" "$SYS_BASH" "$RT/tests/run-tests.sh"
  [ "$status" -eq 1 ]
  assert_contains "$output" "== unit: 1 ok, 1 not ok, 1 skipped =="
  assert_contains "$output" "not ok 3 c breaks"
  assert_contains "$output" "== integration: 1 ok, 0 not ok, 0 skipped =="
  # The TAP's diagnostics are the log's, not the screen's.
  refute_contains "$output" "# (in test file"
  log="$(printf '%s\n' "$output" | sed -n 's/^FAILURES ABOVE — the whole output: //p')"
  [ -f "$log" ]
  case "$log" in "$BATS_TEST_TMPDIR/rtmp/"*) ;; *) echo "log outside TMPDIR: $log" >&2; return 1 ;; esac
  assert_contains "$(cat "$log")" "# (in test file"
  assert_contains "$(cat "$log")" "ok 1 a"
}

@test "run-tests: a green run says ALL GREEN, exits 0 and leaves no log" {
  run_tests_tree
  printf '@test "a" { true; }\n' > "$RT/tests/unit/x.bats"
  run env TMPDIR="$BATS_TEST_TMPDIR/rtmp" "$SYS_BASH" "$RT/tests/run-tests.sh"
  [ "$status" -eq 0 ]
  [ "${lines[${#lines[@]}-1]}" = "ALL GREEN" ]
  [ -z "$(ls "$BATS_TEST_TMPDIR/rtmp")" ]
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

# A scratch repository holding the hook, the record's reader and a stub gates.sh
# whose `--list` is a two-stage matrix; any other call records its argv.
hook_repo() {
  setup_hook
  R="$BATS_TEST_TMPDIR/r"; mkdir -p "$R/scripts/git-hooks"
  git -C "$R" init -q -b main
  git -C "$R" config user.email t@t.t; git -C "$R" config user.name t
  cp "$H/git-hooks/pre-push" "$R/scripts/git-hooks/pre-push"
  cp "$PE_SCRIPTS/gates-marker.sh" "$R/scripts/gates-marker.sh"
  printf '#!/bin/bash\n[ "$1" = --list ] && { printf "build\\nbash-engine\\n"; exit 0; }\nprintf "%%s\\n" "$*" > "%s/gates.log"\nexit 0\n' "$H" > "$R/scripts/gates.sh"
  git -C "$R" add -A; git -C "$R" commit -qm init
  push_refs "refs/heads/main 1111 refs/heads/main 2222"
}
hook_push() { run "$SYS_BASH" -c "cd '$1' && '$SYS_BASH' scripts/git-hooks/pre-push origin url < '$H/refs'"; }

@test "hook: a recorded green run of the full matrix for HEAD on a clean tree stands in for the full gates" {
  hook_repo
  record_gates_green "$R"
  hook_push "$R"
  [ "$status" -eq 0 ]
  [ ! -f "$H/gates.log" ]
  assert_contains "$output" "recorded green run of the full matrix"
  # A dirty tree forfeits the record.
  echo dirty > "$R/f"
  hook_push "$R"
  [ "$(cat "$H/gates.log")" = "" ]
  assert_contains "$output" "the tree is not clean"
}

@test "hook: a record whose JSON lacks a stage of the full matrix is not a green gate" {
  hook_repo
  record_gates_green "$R" build
  hook_push "$R"
  [ "$(cat "$H/gates.log")" = "" ]
  assert_contains "$output" "lacks bash-engine"
  # Nor is a bare sha with no JSON — the record before 9.0.
  rm -f "$(cd "$R" && cd "$(git rev-parse --git-common-dir)" && pwd)/phase-console-gates-ok.json"
  rm -f "$H/gates.log"
  hook_push "$R"
  [ "$(cat "$H/gates.log")" = "" ]
}

@test "hook: a run recorded in a linked worktree counts for the checkout it shares a repository with" {
  # The record lives in the COMMON gitdir: a console run's mirror is a linked
  # worktree, and its green run must count in the dev checkout (one-pool phase 34
  # copied the sha by hand).
  hook_repo
  W="$BATS_TEST_TMPDIR/w"
  git -C "$R" worktree add -q --detach "$W" HEAD
  record_gates_green "$W"
  hook_push "$R"
  [ "$status" -eq 0 ]
  [ ! -f "$H/gates.log" ]
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
