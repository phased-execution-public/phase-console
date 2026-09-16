#!/usr/bin/env bats
# qa-mode.sh — the WRITER behind the two QA switches the engine reads.
#
#   plan-wide  `**QA gate:** on|off`  in §Session budget       — qa_mode()            (qa-mode.bats)
#   per phase  `- **QA:** on|off`     in the ### Phase N block — qa_phase_directive() (qa-per-phase.bats)
#
# Those two suites pin what the engine READS. This one pins that what the script
# WRITES is exactly that shape: every case reads its result back through
# `phase-graph.sh --qa-mode [N]` rather than trusting the bytes, and looks at the
# bytes only where the point is that nothing ELSE moved — a prefix kept, a note
# kept, a neighbour's bullet untouched, a second run byte-identical.
load ../helpers/test_helper

qa_mode_set() { DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" "$SYS_BASH" "$PE_SCRIPTS/qa-mode.sh" "$@"; }
plan()  { echo "$DOCS_ROOT/docs/plans/$1.md"; }
lines() { awk 'END { print NR }' "$1"; }
# The §Session budget body exactly as the engine scopes it (session_budget_block).
budget_lines() {
  awk 'tolower($0) ~ /^##[[:space:]]+session budget/{f=1;next} /^##[[:space:]]/{f=0} f' "$1"
}
# The Nth line after `### Phase <phase> …`, so a test can state "right after the
# heading" as a fact about the file rather than as a grep hit somewhere in it.
after_heading() {  # after_heading <file> <phase> <N>
  awk -v want="$2" -v nth="$3" '
    hit && ++n == nth { print; exit }
    /^###[[:space:]]+[Pp]hase[[:space:]]+[0-9]+/ {
      h=$0; sub(/^###[[:space:]]+[Pp]hase[[:space:]]+/,"",h); sub(/[^0-9].*/,"",h); hit=(h==want)
    }
  ' "$1"
}

# --- plan-wide: the §Session budget line -------------------------------------

@test "plan-wide on: a plan with no §Session budget gains one, and the engine reads it as the plan's word" {
  setup_docs diamond diamond
  run pg diamond --qa-mode; [ "$output" = "off" ]
  run qa_mode_set diamond on
  [ "$status" -eq 0 ]
  # stdout is the engine's own read-back, verbatim: the caller shows the regime
  # the engine will act on, not this script's claim about what it wrote.
  [ "$output" = "$(pg diamond --qa-mode)" ]
  [ "$output" = "on (plan directive: QA gate: on)" ]
  grep -qx '## Session budget' "$(plan diamond)"
  grep -qxF '**QA gate:** on' "$(plan diamond)"
  run pg diamond --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
  run pg diamond --ready
  [ "$output" = "1" ]
}

@test "plan-wide off on a plan with no §Session budget reads back as waived" {
  setup_docs diamond diamond
  run qa_mode_set diamond off
  [ "$status" -eq 0 ]
  [ "$output" = "waived (plan directive: QA gate: off)" ]
  grep -qxF '**QA gate:** off' "$(plan diamond)"
}

@test "a new §Session budget lands after the graph: above ## Phases when there is one, else at the end" {
  # A graph-only plan (diamond with its ## Phases section cut off) — the
  # section closes the file.
  setup_docs diamond diamond
  sed -i.bak '/^## Phases/,$d' "$(plan diamond)"
  qa_mode_set diamond on >/dev/null
  [ "$(tail -n 3 "$(plan diamond)")" = "$(printf '## Session budget\n\n**QA gate:** on')" ]
  # A plan with ## Phases: strip the fixture's own section, then the new one sits
  # just above ## Phases with one blank line each side — never above ## Phase graph.
  setup_docs qa-per-phase blocks
  awk 'tolower($0) ~ /^##[[:space:]]+session budget/{f=1;next} /^##[[:space:]]/{f=0} !f' "$(plan blocks)" \
    > "$(plan blocks).new" && mv "$(plan blocks).new" "$(plan blocks)"
  run pg blocks --qa-mode; [ "$output" = "off" ]
  qa_mode_set blocks on >/dev/null
  at="$(grep -n -x '## Session budget' "$(plan blocks)" | cut -d: -f1)"
  [ "$(sed -n "$((at - 1)),$((at + 4))p" "$(plan blocks)")" = "$(printf '\n## Session budget\n\n**QA gate:** on\n\n## Phases')" ]
  [ "$(grep -n -x '## Phase graph' "$(plan blocks)" | cut -d: -f1)" -lt "$at" ]
  run pg blocks --qa-mode 1; assert_contains "$output" "on (plan directive"
  run pg blocks --lint; [ "$status" -eq 0 ]
}

@test "plan-wide: a plain line's value is replaced in place — same line, no second directive" {
  setup_docs qa-per-phase qa-per-phase
  before="$(lines "$(plan qa-per-phase)")"
  run qa_mode_set qa-per-phase off
  [ "$status" -eq 0 ]
  [ "$output" = "waived (plan directive: QA gate: off)" ]
  [ "$(lines "$(plan qa-per-phase)")" = "$before" ]
  [ "$(grep -c 'QA gate' "$(plan qa-per-phase)")" -eq 1 ]
  grep -qxF '**QA gate:** off' "$(plan qa-per-phase)"
  # The phases' own bullets are not the plan's line: untouched, in both directions.
  run pg qa-per-phase --qa-mode 2; assert_contains "$output" "off (phase directive"
  run pg qa-per-phase --qa-mode 3; assert_contains "$output" "on (phase directive"
  run pg qa-per-phase --qa-mode 1; assert_contains "$output" "waived (plan directive"
  run qa_mode_set qa-per-phase on
  [ "$output" = "on (plan directive: QA gate: on)" ]
  [ "$(grep -c 'QA gate' "$(plan qa-per-phase)")" -eq 1 ]
  run pg qa-per-phase --lint; [ "$status" -eq 0 ]
}

@test "plan-wide: the commerce plan's blockquoted line keeps its '> ' and its neighbours" {
  setup_docs diamond diamond
  cat >> "$(plan diamond)" <<'EOF'

## Session budget

> **Target model:** `claude-opus-5` · **Budget:** ~200K weight/session
> **QA gate:** on
> **Skills (every session):** `tdd`
EOF
  run pg diamond --qa-mode; assert_contains "$output" "on (plan directive"
  run qa_mode_set diamond off
  [ "$status" -eq 0 ]
  assert_contains "$output" "waived (plan directive"
  grep -qxF '> **QA gate:** off' "$(plan diamond)"
  grep -qxF '> **Target model:** `claude-opus-5` · **Budget:** ~200K weight/session' "$(plan diamond)"
  grep -qxF '> **Skills (every session):** `tdd`' "$(plan diamond)"
  [ "$(grep -c 'QA gate' "$(plan diamond)")" -eq 1 ]
}

@test "plan-wide: a '- ' bullet keeps its marker, and prose quoting the bullet is not the bullet" {
  setup_docs unbolded unbolded
  run pg unbolded --qa-mode; assert_contains "$output" "waived"
  run qa_mode_set unbolded on
  [ "$status" -eq 0 ]
  assert_contains "$output" "on (plan directive"
  grep -qxF -- '- **QA gate:** on' "$(plan unbolded)"
  # The fixture's own prose quotes the bullet in backticks, above the section —
  # still there, still saying off.
  grep -qF '`- **QA gate:** off` also carries a BULLET PREFIX here' "$(plan unbolded)"
  [ "$(budget_lines "$(plan unbolded)" | grep -c 'QA gate')" -eq 1 ]
}

@test "plan-wide: a trailing note survives the flip" {
  setup_docs diamond diamond
  printf '\n## Session budget\n\n**QA gate:** off (the suites are the bar here)\n' >> "$(plan diamond)"
  run qa_mode_set diamond on
  [ "$status" -eq 0 ]
  assert_contains "$output" "on (plan directive"
  grep -qxF '**QA gate:** on (the suites are the bar here)' "$(plan diamond)"
}

@test "plan-wide: prose that merely mentions the words is left alone, and the directive goes in first" {
  setup_docs diamond diamond
  printf '\n## Session budget\n\nWe considered whether to turn the QA gate on for this plan.\n**Target model:** opus\n' \
    >> "$(plan diamond)"
  run pg diamond --qa-mode; [ "$output" = "off" ]
  run qa_mode_set diamond off
  [ "$status" -eq 0 ]
  assert_contains "$output" "waived (plan directive"
  [ "$(budget_lines "$(plan diamond)")" = "$(printf '\n**QA gate:** off\nWe considered whether to turn the QA gate on for this plan.\n**Target model:** opus')" ]
}

@test "plan-wide: a heading with nothing blank under it gets the directive on the very next line" {
  setup_docs budgeted budgeted
  run qa_mode_set budgeted on
  [ "$status" -eq 0 ]
  [ "$(budget_lines "$(plan budgeted)")" = "$(printf '**QA gate:** on\n- Target model: Opus 5\n- Per-session weight budget: ~200K\n- Branch: main')" ]
  run pg budgeted --qa-mode; assert_contains "$output" "on (plan directive"
}

@test "plan-wide on over legacy waiver prose wins without deleting the operator's words" {
  setup_docs diamond diamond
  printf '\n## Session budget\n\n**QA gate: WAIVED for ALL phases** (user decision 2026-07-05).\n' >> "$(plan diamond)"
  run pg diamond --qa-mode; assert_contains "$output" "waived"
  run qa_mode_set diamond on
  [ "$status" -eq 0 ]
  assert_contains "$output" "on (plan directive"
  grep -qxF '**QA gate: WAIVED for ALL phases** (user decision 2026-07-05).' "$(plan diamond)"
  grep -qxF '**QA gate:** on' "$(plan diamond)"
}

@test "plan-wide: a second run is byte-identical — the created section and the replaced line alike" {
  setup_docs diamond diamond
  qa_mode_set diamond on >/dev/null
  cp "$(plan diamond)" "$BATS_TEST_TMPDIR/once.md"
  qa_mode_set diamond on >/dev/null
  cmp "$BATS_TEST_TMPDIR/once.md" "$(plan diamond)"
  setup_docs qa-per-phase qa-per-phase
  qa_mode_set qa-per-phase off >/dev/null
  cp "$(plan qa-per-phase)" "$BATS_TEST_TMPDIR/twice.md"
  qa_mode_set qa-per-phase off >/dev/null
  cmp "$BATS_TEST_TMPDIR/twice.md" "$(plan qa-per-phase)"
}

# --- per phase: the ### Phase N bullet ----------------------------------------

@test "--phase N on|off: the bullet lands right after the heading and the engine reads it from the phase" {
  setup_docs qa-per-phase qa-per-phase
  run qa_mode_set qa-per-phase --phase 1 off
  [ "$status" -eq 0 ]
  [ "$output" = "$(pg qa-per-phase --qa-mode 1)" ]
  [ "$output" = "off (phase directive: QA: off)" ]
  [ "$(after_heading "$(plan qa-per-phase)" 1 1)" = "- **QA:** off" ]
  [ "$(after_heading "$(plan qa-per-phase)" 1 2)" = "- **Size:** S" ]
  # Neighbours keep their own words, and the plan keeps its line.
  run pg qa-per-phase --qa-mode 2; assert_contains "$output" "off (phase directive"
  run pg qa-per-phase --qa-mode 3; assert_contains "$output" "on (phase directive"
  run pg qa-per-phase --qa-mode 4; assert_contains "$output" "on (plan directive"
  run pg qa-per-phase --qa-mode;   assert_contains "$output" "on (plan directive"
  run pg qa-per-phase --lint; [ "$status" -eq 0 ]; assert_contains "$output" "LINT OK"
}

@test "--phase N replaces an existing bullet where it stands" {
  setup_docs qa-per-phase qa-per-phase
  before="$(lines "$(plan qa-per-phase)")"
  run qa_mode_set qa-per-phase --phase 2 on
  [ "$status" -eq 0 ]
  [ "$output" = "on (phase directive: QA: on)" ]
  [ "$(lines "$(plan qa-per-phase)")" = "$before" ]
  # The fixture writes the bullet under Size; it stays there rather than moving up.
  [ "$(after_heading "$(plan qa-per-phase)" 2 1)" = "- **Size:** S" ]
  [ "$(after_heading "$(plan qa-per-phase)" 2 2)" = "- **QA:** on" ]
  [ "$(pg qa-per-phase --qa-mode 3)" = "on (phase directive: QA: on)" ]
}

@test "--phase N inherit deletes the bullet, and the phase follows the plan again — both ways" {
  setup_docs qa-per-phase qa-per-phase
  before="$(lines "$(plan qa-per-phase)")"
  run qa_mode_set qa-per-phase --phase 2 inherit
  [ "$status" -eq 0 ]
  [ "$output" = "on (plan directive: QA gate: on)" ]
  [ "$(lines "$(plan qa-per-phase)")" = "$((before - 1))" ]
  run pg qa-per-phase --qa-mode 2; assert_contains "$output" "plan directive"
  run pg qa-per-phase --qa-mode 3; assert_contains "$output" "on (phase directive"
  # It really inherits: flip the plan and phase 2 flips with it; phase 3 does not.
  run qa_mode_set qa-per-phase off
  [ "$status" -eq 0 ]
  run pg qa-per-phase --qa-mode 2; assert_contains "$output" "waived (plan directive"
  run pg qa-per-phase --qa-mode 3; assert_contains "$output" "on (phase directive"
  run pg qa-per-phase --lint; [ "$status" -eq 0 ]
}

@test "--phase takes the handoff filename's padded number" {
  setup_docs qa-per-phase qa-per-phase
  run qa_mode_set qa-per-phase --phase 02 on
  [ "$status" -eq 0 ]
  [ "$(pg qa-per-phase --qa-mode 2)" = "on (phase directive: QA: on)" ]
  [ "$(grep -c '^- \*\*QA:\*\*' "$(plan qa-per-phase)")" -eq 2 ]   # phases 2 and 3: still one bullet each
}

@test "per phase: a line that mentions the words mid-sentence is not the bullet" {
  setup_docs diamond diamond
  cat >> "$(plan diamond)" <<'EOF'

## Phases

### Phase 1 — Root
- **Goal:** decide whether **QA:** on is the right call for phase 2
- **Size:** S
EOF
  run pg diamond --qa-mode 1; [ "$output" = "off" ]
  run qa_mode_set diamond --phase 1 off
  [ "$status" -eq 0 ]
  [ "$output" = "off (phase directive: QA: off)" ]
  grep -qxF -- '- **Goal:** decide whether **QA:** on is the right call for phase 2' "$(plan diamond)"
  [ "$(after_heading "$(plan diamond)" 1 1)" = "- **QA:** off" ]
  # inherit takes only the bullet with it.
  run qa_mode_set diamond --phase 1 inherit
  [ "$status" -eq 0 ]
  [ "$output" = "off" ]
  grep -qxF -- '- **Goal:** decide whether **QA:** on is the right call for phase 2' "$(plan diamond)"
  ! grep -q '^- \*\*QA:\*\*' "$(plan diamond)"
}

@test "per phase: a bullet the engine cannot read (a trailing note) is rewritten into one it can" {
  setup_docs qa-per-phase qa-per-phase
  sed -i.bak 's/^- \*\*QA:\*\* off$/- **QA:** off — docs phase, nothing to review/' "$(plan qa-per-phase)"
  run pg qa-per-phase --qa-mode 2; assert_contains "$output" "plan directive"   # a note makes it silence
  run qa_mode_set qa-per-phase --phase 2 off
  [ "$status" -eq 0 ]
  [ "$output" = "off (phase directive: QA: off)" ]
  [ "$(after_heading "$(plan qa-per-phase)" 2 2)" = "- **QA:** off" ]
}

@test "per phase: a second run is byte-identical — set and inherit alike" {
  setup_docs qa-per-phase qa-per-phase
  qa_mode_set qa-per-phase --phase 1 on >/dev/null
  cp "$(plan qa-per-phase)" "$BATS_TEST_TMPDIR/set.md"
  qa_mode_set qa-per-phase --phase 1 on >/dev/null
  cmp "$BATS_TEST_TMPDIR/set.md" "$(plan qa-per-phase)"
  qa_mode_set qa-per-phase --phase 2 inherit >/dev/null
  cp "$(plan qa-per-phase)" "$BATS_TEST_TMPDIR/inherit.md"
  qa_mode_set qa-per-phase --phase 2 inherit >/dev/null
  cmp "$BATS_TEST_TMPDIR/inherit.md" "$(plan qa-per-phase)"
}

# --- refusals: nothing is written ---------------------------------------------

@test "refuses a phase with no ### Phase N section, and writes nothing" {
  setup_docs qa-per-phase qa-per-phase
  cp "$(plan qa-per-phase)" "$BATS_TEST_TMPDIR/before.md"
  run qa_mode_set qa-per-phase --phase 99 on
  [ "$status" -eq 2 ]
  assert_contains "$output" "Phase 99"
  cmp "$BATS_TEST_TMPDIR/before.md" "$(plan qa-per-phase)"
}

@test "refuses an unknown mode, a missing mode, a bad phase and a bad option" {
  setup_docs qa-per-phase qa-per-phase
  cp "$(plan qa-per-phase)" "$BATS_TEST_TMPDIR/before.md"
  run qa_mode_set qa-per-phase maybe;            [ "$status" -eq 2 ]; assert_contains "$output" "on|off|inherit"
  run qa_mode_set qa-per-phase --phase 2 waived; [ "$status" -eq 2 ]
  run qa_mode_set qa-per-phase;                  [ "$status" -eq 2 ]; assert_contains "$output" "usage"
  run qa_mode_set qa-per-phase --phase x on;     [ "$status" -eq 2 ]
  run qa_mode_set qa-per-phase --bogus on;       [ "$status" -eq 2 ]
  cmp "$BATS_TEST_TMPDIR/before.md" "$(plan qa-per-phase)"
}

@test "refuses inherit without --phase: a plan has nothing to inherit from" {
  setup_docs qa-per-phase qa-per-phase
  cp "$(plan qa-per-phase)" "$BATS_TEST_TMPDIR/before.md"
  run qa_mode_set qa-per-phase inherit
  [ "$status" -eq 2 ]
  assert_contains "$output" "--phase"
  cmp "$BATS_TEST_TMPDIR/before.md" "$(plan qa-per-phase)"
}

@test "refuses a missing plan and creates nothing" {
  setup_docs diamond diamond
  run qa_mode_set nope on
  [ "$status" -eq 2 ]
  assert_contains "$output" "docs/plans/nope.md"
  [ ! -e "$(plan nope)" ]
}
