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
scrub
pack"
  run "$SYS_BASH" "$GATES" --list
  [ "$status" -eq 0 ]
  [ "$output" = "$expected" ]
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
