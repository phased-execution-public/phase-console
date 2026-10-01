#!/usr/bin/env bats
# Every command a generated prompt prints must name the docs root it was read
# from.
#
# The skill scripts resolve their docs root from the RUNNING session's cwd
# (`pe_docs_root`: $DOCS_ROOT → the outermost superproject of the cwd → … →
# pwd). A generated line without `DOCS_ROOT=` therefore records its approval,
# outcome, task or lock wherever the reader's session happens to sit — not in
# the repository whose plan the line was generated from. Measured live on
# 2026-09-17 (autopilot-token-drain phase 8): a `gate-approve.sh` line pasted
# from a pe-hub plan into a session sitting in hub would have written
# `gate-status.md` into HUB; the operator noticed and hand-wrapped the command
# with an exported DOCS_ROOT. This file is the guard for that whole class.
#
# NOTE ON THE HARNESS: `tests/helpers/test_helper.bash` exports DOCS_ROOT for
# every runner, which is exactly why this defect was invisible to the suite for
# its whole life — the callee always found the right root in the environment.
# These tests read the generated TEXT, they never run it, so the ambient
# DOCS_ROOT cannot mask a missing prefix.
load ../helpers/test_helper

# How a boot prompt names this copy's scripts since control-tower phase 98
# (#151): through the session's `$PE_SCRIPTS`, falling back to this copy.
SREF="\"\${PE_SCRIPTS:-$PE_SCRIPTS}\""

# Lines in `text` that invoke a skill script but do not name a docs root —
# by this copy's path, or through the boot prompt's indirection.
# bash 3.2: no `mapfile`, no `${var^^}`.
missing_docs_root() {
  printf '%s\n' "$1" | grep -F -e "$PE_SCRIPTS/" -e "$SREF/" | grep -v 'DOCS_ROOT=' || true
}

@test "boot-prompt: every generated skill-script command carries its DOCS_ROOT (ai gate)" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --boot-prompt 10
  [ "$status" -eq 0 ] || false
  assert_contains "$output" "gate-approve.sh gatecheck 10"
  bad="$(missing_docs_root "$output")"
  [ -z "$bad" ] || { echo "generated without DOCS_ROOT:" >&2; echo "$bad" >&2; false; }
}

@test "boot-prompt: every generated skill-script command carries its DOCS_ROOT (human gate)" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --boot-prompt 5
  [ "$status" -eq 0 ] || false
  assert_contains "$output" "Gate card"
  bad="$(missing_docs_root "$output")"
  [ -z "$bad" ] || { echo "generated without DOCS_ROOT:" >&2; echo "$bad" >&2; false; }
}

@test "boot-prompt: every generated skill-script command carries its DOCS_ROOT (delegated gate)" {
  setup_docs gatecheck gatecheck
  PE_GATE_DELEGATE=1 run pg gatecheck --boot-prompt 5
  [ "$status" -eq 0 ] || false
  assert_contains "$output" "DELEGATED"
  bad="$(missing_docs_root "$output")"
  [ -z "$bad" ] || { echo "generated without DOCS_ROOT:" >&2; echo "$bad" >&2; false; }
}

@test "boot-prompt: every generated skill-script command carries its DOCS_ROOT (auto gate)" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --boot-prompt 2
  [ "$status" -eq 0 ] || false
  assert_contains "$output" "GATED phase (auto-checked)"
  bad="$(missing_docs_root "$output")"
  [ -z "$bad" ] || { echo "generated without DOCS_ROOT:" >&2; echo "$bad" >&2; false; }
}

@test "boot-prompt: an ungated phase's lock, task and outcome lines carry it too" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --boot-prompt 1
  [ "$status" -eq 0 ] || false
  # the three that a session is told to run for itself
  assert_contains "$output" "phase-lock.sh"
  assert_contains "$output" "phase-tasks.sh"
  assert_contains "$output" "phase-outcome.sh"
  bad="$(missing_docs_root "$output")"
  [ -z "$bad" ] || { echo "generated without DOCS_ROOT:" >&2; echo "$bad" >&2; false; }
}

@test "the gate line names the plan's OWN root, not the cwd the generator ran in" {
  setup_docs gatecheck gatecheck
  # Generate from a cwd whose git root is NOT the docs root — the live shape of
  # the defect: a session working in another repository asks for the prompt.
  elsewhere="$BATS_TEST_TMPDIR/elsewhere"
  mkdir -p "$elsewhere"
  run env -u PE_SCOPE sh -c "cd '$elsewhere' && DOCS_ROOT='$DOCS_ROOT' '$SYS_BASH' '$PE_SCRIPTS/phase-graph.sh' gatecheck --boot-prompt 10"
  [ "$status" -eq 0 ] || false
  assert_contains "$output" "DOCS_ROOT=$DOCS_ROOT"
  bad="$(missing_docs_root "$output")"
  [ -z "$bad" ] || { echo "generated without DOCS_ROOT:" >&2; echo "$bad" >&2; false; }
}

@test "next-phase-prompt: its printed commands are absolute and carry DOCS_ROOT" {
  setup_docs gatecheck gatecheck
  run pe_nextp gatecheck none
  [ "$status" -eq 0 ] || false
  # a bare `scripts/…` resolves against the READER's cwd, which is never
  # guaranteed to be the skill root
  bare="$(printf '%s\n' "$output" | grep -E '(^|[^/A-Za-z._-])scripts/[a-z-]+\.sh' || true)"
  [ -z "$bare" ] || { echo "relative skill-script paths printed:" >&2; echo "$bare" >&2; false; }
  bad="$(missing_docs_root "$output")"
  [ -z "$bad" ] || { echo "generated without DOCS_ROOT:" >&2; echo "$bad" >&2; false; }
}

# ---------------------------------------------------------------------------
# control-tower phase 63 (#85): under an autopilot the console mirrors the lock
# to git outside the turn, so the prompt's lock lines are FILE-ONLY; a person
# driving by hand keeps `--git`.
# ---------------------------------------------------------------------------

@test "boot-prompt: under an autopilot the claim and conflicts lines are file-only and say who mirrors" {
  setup_docs gatecheck gatecheck
  PE_LOCK_MIRROR=console run pg gatecheck --boot-prompt 1
  [ "$status" -eq 0 ] || false
  lock_lines="$(printf '%s\n' "$output" | grep -F "$SREF/phase-lock.sh")"
  assert_contains "$lock_lines" "conflicts 1"
  assert_contains "$lock_lines" "claim 1"
  if printf '%s\n' "$lock_lines" | grep -q -- '--git'; then
    echo "an autopilot prompt still passes --git:" >&2; echo "$lock_lines" >&2; false
  fi
  assert_contains "$output" "FILE-ONLY under this autopilot"
  assert_contains "$output" "mirrors the lock to git outside your turn"
}

@test "boot-prompt: a hand-driven prompt keeps --git on both lock lines" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --boot-prompt 1
  [ "$status" -eq 0 ] || false
  [ "$(printf '%s\n' "$output" | grep -F "$SREF/phase-lock.sh" | grep -c -- '--git')" -eq 2 ]
  ! printf '%s\n' "$output" | grep -q "FILE-ONLY under this autopilot"
}

@test "boot-prompt: the docs root is declared scope — the plan's per-slug token is named (#88)" {
  setup_docs scoped scoped
  run pg scoped --boot-prompt 1
  [ "$status" -eq 0 ] || false
  assert_contains "$output" '`docs/handoffs/scoped` — your handoff and lock writes'
  assert_contains "$output" "docs repo ARE your scope"
  ! printf '%s\n' "$output" | grep -q "are NOT"
  # Declared, never claimed: the claim line carries the Repos cell alone.
  printf '%s\n' "$output" | grep -F "$SREF/phase-lock.sh scoped claim 1" | grep -q -- '--scope "api-server"'
  ! printf '%s\n' "$output" | grep -F "$SREF/phase-lock.sh" | grep -q "docs/handoffs"
}

@test "boot-prompt: a phase scoped \`all\` already covers the docs root, so no token is named beside it" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --boot-prompt 1
  [ "$status" -eq 0 ] || false
  assert_contains "$output" "from the plan's Repos column): all"
  ! printf '%s\n' "$output" | grep -q "plus, in the docs root"
}

# HF-5 (control-tower phase 85, #115): a booting session is handed its full prompt;
# in a dependency handoff's start section it reads the shared boot and its OWN
# phase's block — a sibling's block is somebody else's prompt.
@test "HF-5: the skill tells a booting session to read only its own block of a fan-out handoff" {
  grep -q "never a sibling's" "$PE_DIR/SKILL.md"
  grep -q "never a sibling's" "$PE_DIR/references/handoff-format.md"
}

@test "HF-5: the fan-out section says it too, and every command it prints carries DOCS_ROOT" {
  setup_docs diamond demo
  write_handoff demo 1 root complete
  run pg demo --boot-fanout "2 3"
  [ "$status" -eq 0 ] || false
  assert_contains "$output" "never a sibling's"
  assert_contains "$output" "--boot-prompt <N>"
  bad="$(missing_docs_root "$output")"
  [ -z "$bad" ] || { echo "generated without DOCS_ROOT:" >&2; echo "$bad" >&2; false; }
}

# control-tower phase 98 (#151): a boot prompt names the skill's scripts
# through `$PE_SCRIPTS`, which every session a console starts carries, and
# falls back to this copy's own directory — so the line runs by hand, and a
# handoff that embeds it never pins a later session to one clone's scripts.
@test "boot-prompt: skill scripts are named through \$PE_SCRIPTS with this copy as the fallback, and resolve either way (#151)" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --boot-prompt 1
  [ "$status" -eq 0 ] || false
  assert_contains "$output" "DOCS_ROOT=$DOCS_ROOT bash $SREF/phase-lock.sh gatecheck claim 1"
  assert_contains "$output" "bash $SREF/phase-outcome.sh gatecheck 1 waiting-external"
  if printf '%s\n' "$output" | grep -qF "bash $PE_SCRIPTS/"; then
    echo "a line still names this copy's scripts directly:" >&2
    printf '%s\n' "$output" | grep -F "bash $PE_SCRIPTS/" >&2; false
  fi
  # Read the way a shell reads it: by hand, this copy's script; under a console, the console's.
  ref="$(printf '%s\n' "$output" | grep -m1 -o '"${PE_SCRIPTS:-[^}]*}"/phase-lock.sh')"
  [ "$(env -u PE_SCRIPTS "$SYS_BASH" -c "printf '%s' $ref")" = "$PE_SCRIPTS/phase-lock.sh" ]
  [ "$(PE_SCRIPTS=/the/console/scripts "$SYS_BASH" -c "printf '%s' $ref")" = "/the/console/scripts/phase-lock.sh" ]
  # A fan-out's shared boot, which a handoff embeds, says it the same way.
  setup_docs diamond demo
  write_handoff demo 1 root complete
  run pg demo --boot-fanout "2 3"
  [ "$status" -eq 0 ] || false
  assert_contains "$output" "bash $SREF/phase-graph.sh demo --boot-prompt <N>"
}

@test "boot-prompt: a sibling wait is phase:<slug>/<phase>, never a cmd: grep over its handoff; verify: names the phase (PW-4, #129)" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --boot-prompt 1
  [ "$status" -eq 0 ] || false
  # `<phase>`, not `<N>`: `<N>` is the fan-out marker HF-2 keeps out of a plain prompt (phase 89).
  assert_contains "$output" "--watch phase:gatecheck/<phase>"
  assert_contains "$output" "never a"
  assert_contains "$output" "cmd: grep over its handoff"
  assert_contains "$output" "--watch verify:gatecheck/1"
  assert_contains "$output" "absolute"
}
