#!/usr/bin/env bats
# F32 `verification-fleet-wide` — a §Verification line whose exit code reads
# FLEET-WIDE state warns at lint time, never gates (control-tower phase 62, #47).
#
# The measured case: a ship phase verified with `task hygiene -- --offline`. In
# a shared checkout that line can never exit 0 while the run is live — the
# console's own minted `pe/<slug>` branches (one pinned by the run's worktree)
# and three other live plans' trees made 31 of its 33 findings — so the phase
# finished its whole ship, declared `blocked`, and waited for a person to rule
# the line deferred. The line judges the whole fleet; the phase's exit
# criterion is only what THIS plan introduced. The lint names the line and
# says what to write instead while the plan is still open.
#
# Phase 89 (HY-1, HY-2) corrected what it says. The "scoped forms" phase 62
# recommended were forms the fleet's tasks do not accept: `task hygiene` hands
# its arguments to fleet-hygiene.sh, which refuses `--plan` and `--repos` with
# exit 2, and `task drift` reads no arguments at all, so `-- --root …` was
# dropped and the whole fleet judged anyway. A fleet-wide PROCESS read is the
# same class (#71's PEH-3): `ps … | grep phase-console` matched every console
# on the machine and reported another one's heap flag as this one's.
load ../helpers/test_helper

# A six-phase plan, written here rather than added to tests/fixtures/plans/:
# every file there joins engine-parity's corpus, which forks the engine once
# per phase per flag on every gate run.
fleet_plan() {
  scrub_pe_env
  export DOCS_ROOT="$BATS_TEST_TMPDIR/work"
  mkdir -p "$DOCS_ROOT/docs/plans" "$DOCS_ROOT/docs/handoffs/fleet"
  cat > "$DOCS_ROOT/docs/plans/fleet.md" <<'EOF'
---
slug: fleet
created: 2026-09-25
status: active
phases: 6
handoffs: docs/handoffs/fleet/
memory: project_fleet
---

# Fleet-wide verification test plan

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Build  | — | — | repoA | unit green |
| 2 | Tidy   | 1 | — | repoA | hygiene |
| 3 | Drift  | 2 | — | repoA | no drift |
| 4 | Ship   | 3 | — | repoA | shipped |
| 5 | Heap   | 4 | — | repoA | heap flag |
| 6 | Heaped | 5 | — | repoA | heap flag, one console |

### Phase 1 — Build

- **Verification:**
  - `npm test`
  - `task drift -- --root .worktrees/staging`

### Phase 2 — Tidy

- **Verification:**
  - `task hygiene -- --offline`

### Phase 3 — Drift

- **Verification:**
  ```
  task drift
  ```

### Phase 4 — Ship

- **Verification:**
  - `task hygiene -- --plan fleet`
  - `task test`

### Phase 5 — Heap

- **Verification:**
  - `ps -axo pid,command | grep -E 'phase-console|viewer/server' | grep -o 'max-old-space-size=[0-9]*' | sort | uniq -c`

### Phase 6 — Heaped

- **Verification:**
  - `ps -o command= -p "$(lsof -tiTCP:4130 -sTCP:LISTEN)" | grep -c max-old-space`
  - `task drift:pins`
  - `task hygiene -- --check-tag phased-execution v1.0.1`
EOF
}

# The one F32 line the lint wrote for phase <n>.
f32_line() { printf '%s\n' "$output" | grep "^F32 phase $1:" || true; }

@test "F32: an unscoped 'task hygiene' and a root-less 'task drift' are named, and the lint still passes" {
  fleet_plan
  run pg fleet --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
  assert_contains "$output" "F32 phase 2: verification-fleet-wide"
  assert_contains "$output" "task hygiene -- --offline"
  assert_contains "$output" "F32 phase 3: verification-fleet-wide"
  assert_contains "$output" "task drift"
}

@test "HY-1: the warning recommends only forms the fleet's tasks accept — never --plan, --repos or --root" {
  fleet_plan
  run pg fleet --lint
  local hygiene drift
  hygiene="$(f32_line 2)"
  drift="$(f32_line 3)"
  [ -n "$hygiene" ] && [ -n "$drift" ]
  # fleet-hygiene.sh refuses `--plan` and `--repos` (exit 2), and the drift task
  # reads no arguments: none of the three may be offered as a remedy again —
  # they may only be named as what does NOT work.
  refute_contains "$output" "task hygiene -- --plan fleet\` (or"
  refute_contains "$output" "--repos <list>"
  refute_contains "$output" "-- --root <main-tip checkout>"
  # What is said instead: hygiene has no scoped form, so check the plan's own
  # footprint and leave the audit to a person; drift has a gate per box.
  assert_contains "$hygiene" "has no scoped form"
  assert_contains "$hygiene" "exits 2 on anything else (\`--plan\`, \`--repos\`)"
  assert_contains "$hygiene" 'status --porcelain'
  assert_contains "$hygiene" "Gate-check: manual"
  assert_contains "$drift" "takes no arguments (\`-- --root …\` is dropped)"
  assert_contains "$drift" "task drift:<gate>"
  assert_contains "$drift" "task -d <main-tip checkout> drift"
}

@test "HY-1: every form the warning recommends passes its own reader" {
  # shellcheck source=/dev/null
  . "$PE_SCRIPTS/verify.env"
  # A remedy the lint would flag again is not a remedy.
  [ -z "$(printf '%s' 'task drift:pins' | fleet_wide_hit)" ]
  [ -z "$(printf '%s' 'task drift:backend' | fleet_wide_hit)" ]
  [ -z "$(printf '%s' 'task -d .worktrees/staging drift' | fleet_wide_hit)" ]
  [ -z "$(printf '%s' 'test -z "$(git -C web status --porcelain)"' | fleet_wide_hit)" ]
  [ -z "$(printf '%s' '! git -C web show-ref --verify --quiet refs/heads/pe/fleet' | fleet_wide_hit)" ]
  [ -z "$(printf '%s' 'ps -o command= -p "$(lsof -tiTCP:4130 -sTCP:LISTEN)" | grep -c max-old-space' | fleet_wide_hit)" ]
}

@test "HY-1: --plan, --repos and --root no longer silence the warning" {
  fleet_plan
  run pg fleet --lint
  [ "$status" -eq 0 ]
  assert_contains "$(f32_line 1)" "task drift -- --root .worktrees/staging"
  assert_contains "$(f32_line 4)" "task hygiene -- --plan fleet"
}

@test "HY-1: the forms that genuinely scope stay silent" {
  fleet_plan
  run pg fleet --lint
  # Phase 6: a pid-addressed ps read, one drift gate, and a hygiene question
  # answered from its own allowlist — none of them reads the fleet.
  [ -z "$(f32_line 6)" ]
}

@test "F32: a done phase is not judged about history" {
  fleet_plan
  write_handoff fleet 1 build complete
  write_handoff fleet 2 tidy complete
  run pg fleet --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" "F32 phase 2"
  assert_contains "$output" "F32 phase 3"
}

@test "F32: validate.sh carries the advisory and does not fail on it" {
  fleet_plan
  run pe_validate fleet
  assert_contains "$output" "F32 phase 2: verification-fleet-wide"
  assert_contains "$output" "VALIDATE OK"
}

@test "HY-1: the one bash reader answers the shapes the lint is built on" {
  # shellcheck source=/dev/null
  . "$PE_SCRIPTS/verify.env"
  # The whole command, so the warning names the line an author has to change.
  [ "$(printf '%s' 'task hygiene -- --offline' | fleet_wide_hit)" = "task hygiene -- --offline" ]
  [ "$(printf '%s' 'task drift' | fleet_wide_hit)" = "task drift" ]
  # What phase 62 counted as scoped reads the whole fleet all the same.
  [ "$(printf '%s' 'task drift -- --root .worktrees/staging' | fleet_wide_hit)" = "task drift -- --root .worktrees/staging" ]
  [ "$(printf '%s' 'ROOT=.worktrees/staging task drift' | fleet_wide_hit)" = "ROOT=.worktrees/staging task drift" ]
  [ "$(printf '%s' 'task hygiene -- --plan fleet' | fleet_wide_hit)" = "task hygiene -- --plan fleet" ]
  [ "$(printf '%s' 'task hygiene -- --repos phased-execution' | fleet_wide_hit)" = "task hygiene -- --repos phased-execution" ]
  [ "$(printf '%s' 'task hygiene -- --remote-only --json' | fleet_wide_hit)" = "task hygiene -- --remote-only --json" ]
  # The two hygiene questions answered from a constant read no repository.
  [ -z "$(printf '%s' 'task hygiene -- --check-tag phased-execution v1.0.1' | fleet_wide_hit)" ]
  [ -z "$(printf '%s' 'task hygiene -- --list-tag-allowlist' | fleet_wide_hit)" ]
  # One command of a chain is judged alone: a scoped neighbour excuses nothing.
  [ "$(printf '%s' 'task drift:pins && task hygiene' | fleet_wide_hit)" = "task hygiene" ]
  [ "$(printf '%s' 'task hygiene -- --check-tag a b && task hygiene -- --offline' | fleet_wide_hit)" = "task hygiene -- --offline" ]
  [ -z "$(printf '%s' 'task test' | fleet_wide_hit)" ]
  [ -z "$(printf '%s' 'npm run hygiene' | fleet_wide_hit)" ]
}

@test "HY-2: a fleet-wide 'ps … | grep' is named, with the pid-addressed form beside it" {
  fleet_plan
  run pg fleet --lint
  [ "$status" -eq 0 ]
  local heap
  heap="$(f32_line 5)"
  assert_contains "$heap" "F32 phase 5: verification-fleet-wide"
  assert_contains "$heap" "ps -axo pid,command | grep -E 'phase-console|viewer/server'"
  assert_contains "$heap" "every process on the machine"
  assert_contains "$heap" 'ps -o command= -p "$(lsof -tiTCP:<port> -sTCP:LISTEN)"'
  refute_contains "$heap" "task hygiene has no scoped form"
}

@test "HY-2: the reader tells a fleet-wide process read from a scoped one" {
  # shellcheck source=/dev/null
  . "$PE_SCRIPTS/verify.env"
  # #71's PEH-3, verbatim: every console on the machine, one answer.
  local peh3
  peh3="ps -axo pid,command | grep -E 'phase-console|viewer/server' | grep -o 'max-old-space-size=[0-9]*' | sort | uniq -c"
  [ "$(printf '%s' "$peh3" | fleet_wide_hit)" = "$peh3" ]
  [ "$(printf '%s' 'ps aux|grep phase-console' | fleet_wide_hit)" = "ps aux|grep phase-console" ]
  [ "$(printf '%s' 'ps -ef | sort | grep node' | fleet_wide_hit)" = "ps -ef | sort | grep node" ]
  [ "$(printf '%s' 'test "$(ps -axo command | grep -c phase-console)" -eq 1' | fleet_wide_hit)" = 'test "$(ps -axo command | grep -c phase-console)" -eq 1' ]
  [ "$(printf '%s' 'npm test && ps -A | egrep viewer' | fleet_wide_hit)" = "ps -A | egrep viewer" ]
  # Scoped: ONE process, named by its pid.
  [ -z "$(printf '%s' 'ps -o command= -p 45397 | grep -c max-old-space' | fleet_wide_hit)" ]
  [ -z "$(printf '%s' 'ps -p "$PID" -o command= | grep max-old-space' | fleet_wide_hit)" ]
  [ -z "$(printf '%s' 'ps -fp 1602 | grep node' | fleet_wide_hit)" ]
  # Not a process read at all: a compose project's services, and pgrep, whose
  # pattern IS its scope.
  [ -z "$(printf '%s' 'docker compose ps | grep healthy' | fleet_wide_hit)" ]
  [ -z "$(printf '%s' 'pgrep -f /work/pe-hub/console/viewer/server' | fleet_wide_hit)" ]
  [ -z "$(printf '%s' 'grep -c ps notes.txt' | fleet_wide_hit)" ]
}
