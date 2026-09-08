#!/usr/bin/env bats
# repair-artefacts.sh — the FREE first rung of `plan-broken`.
#
# Everything the paid plan-repair agent used to be reached for and did not
# need judgement to fix: an INDEX status cell that disagrees with the handoff
# it points at, a handoff's `depends_on` that disagrees with the plan graph, a
# lock whose lease has passed, and a `blocked` marker left by an attempt that
# never started. Four mechanical repairs, each of which has exactly one right
# answer, none of which needs a session.
#
# The two properties that make it safe to run unattended, and what this file
# pins: it NEVER edits a plan table or a handoff body (the two artefacts whose
# repair is a judgement), and running it twice changes nothing the second time.
load ../helpers/test_helper

repair() { DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" /bin/bash "$PE_SCRIPTS/repair-artefacts.sh" "$@"; }

# A linear plan (1→2→3→4→5) with two handoffs and a hand-written INDEX whose
# status cell for phase 2 lies.
setup_drift() {
  setup_docs linear drift
  write_handoff drift 1 one complete
  write_handoff drift 2 two complete
  cat > "$DOCS_ROOT/docs/handoffs/drift/INDEX.md" <<'EOF'
# Handoffs — drift

| Phase | Title | Status | Handoff |
|------:|-------|--------|---------|
| 01 | one | complete | [phase-01-one.md](phase-01-one.md) |
| 02 | two | in-progress | [phase-02-two.md](phase-02-two.md) |
EOF
}

@test "repair-artefacts: exists, is executable, and refuses without a slug" {
  [ -x "$PE_SCRIPTS/repair-artefacts.sh" ]
  run /bin/bash "$PE_SCRIPTS/repair-artefacts.sh"
  [ "$status" -eq 2 ]
}

@test "repair-artefacts: reports INDEX drift but changes nothing without --apply" {
  setup_drift
  run repair drift
  [ "$status" -eq 0 ]
  assert_contains "$output" '"kind":"index-drift"'
  assert_contains "$output" '"applied":false'
  # The file is untouched: the lie is still there.
  assert_contains "$(cat "$DOCS_ROOT/docs/handoffs/drift/INDEX.md")" "| 02 | two | in-progress |"
}

@test "repair-artefacts: --apply fixes the INDEX status cell from the frontmatter" {
  setup_drift
  run repair drift --apply
  [ "$status" -eq 0 ]
  assert_contains "$output" '"kind":"index-drift"'
  assert_contains "$(cat "$DOCS_ROOT/docs/handoffs/drift/INDEX.md")" "| 02 | two | complete |"
  # …and the row's link and title are untouched.
  assert_contains "$(cat "$DOCS_ROOT/docs/handoffs/drift/INDEX.md")" "[phase-02-two.md](phase-02-two.md)"
}

@test "repair-artefacts: is idempotent — a second --apply changes nothing" {
  setup_drift
  repair drift --apply >/dev/null
  run repair drift --apply
  [ "$status" -eq 0 ]
  assert_contains "$output" '"changed":0'
  refute_contains "$output" '"kind":"index-drift"'
}

@test "repair-artefacts: fixes depends_on drift from the plan graph" {
  setup_docs linear deps
  write_handoff deps 3 three complete
  # linear.md: phase 3 depends on 2. Write a handoff that disagrees.
  f="$DOCS_ROOT/docs/handoffs/deps/phase-03-three.md"
  sed 's/^status: complete/status: complete\ndepends_on: [1]/' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  run repair deps --apply
  [ "$status" -eq 0 ]
  assert_contains "$output" '"kind":"depends-drift"'
  assert_contains "$(cat "$f")" "depends_on: [2]"
}

@test "repair-artefacts: releases an EXPIRED lock and leaves a live one alone" {
  setup_docs linear locks
  pe_lock locks claim 1 --owner ghost --scope repo >/dev/null
  pe_lock locks claim 2 --owner alive --scope repo >/dev/null
  expire_lock locks 1
  run repair locks --apply
  [ "$status" -eq 0 ]
  assert_contains "$output" '"kind":"expired-lock"'
  [ ! -f "$DOCS_ROOT/docs/handoffs/locks/.locks/phase-01.lock" ]
  [ -f "$DOCS_ROOT/docs/handoffs/locks/.locks/phase-02.lock" ]
}

@test "repair-artefacts: resets a did-not-start blocked marker only when told to" {
  setup_docs linear reset
  write_handoff reset 4 four blocked
  f="$DOCS_ROOT/docs/handoffs/reset/phase-04-four.md"
  # Not named: the blocked marker stands. A blocked handoff is testimony until
  # the RUN says the attempt never happened.
  run repair reset --apply
  [ "$status" -eq 0 ]
  refute_contains "$output" '"kind":"not-started"'
  assert_contains "$(cat "$f")" "status: blocked"
  # Named: the run has told us record.attempts === 0, so nothing wrote it.
  run repair reset --apply --reset-not-started 4
  [ "$status" -eq 0 ]
  assert_contains "$output" '"kind":"not-started"'
  assert_contains "$(cat "$f")" "status: pending"
}

@test "repair-artefacts: never touches a COMPLETE handoff named by --reset-not-started" {
  setup_docs linear safe
  write_handoff safe 4 four complete
  run repair safe --apply --reset-not-started 4
  [ "$status" -eq 0 ]
  refute_contains "$output" '"kind":"not-started"'
  assert_contains "$(cat "$DOCS_ROOT/docs/handoffs/safe/phase-04-four.md")" "status: complete"
}

# Everything after the frontmatter's closing `---`. Frontmatter itself is fair
# game (status and depends_on ARE the repairs); the body is a session's words
# and is not this script's to rewrite.
body_hash() { awk 'seen >= 2 { print } /^---$/ { seen++ }' "$1" | shasum | cut -d' ' -f1; }

@test "repair-artefacts: never edits the plan file or a handoff BODY" {
  setup_drift
  before_plan="$(shasum "$DOCS_ROOT/docs/plans/drift.md" | cut -d' ' -f1)"
  before_body="$(body_hash "$DOCS_ROOT/docs/handoffs/drift/phase-02-two.md")"
  repair drift --apply >/dev/null
  [ "$before_plan" = "$(shasum "$DOCS_ROOT/docs/plans/drift.md" | cut -d' ' -f1)" ]
  [ "$before_body" = "$(body_hash "$DOCS_ROOT/docs/handoffs/drift/phase-02-two.md")" ]
}

@test "repair-artefacts: a clean plan reports zero and exits 0" {
  setup_docs linear clean
  write_handoff clean 1 one complete
  pe_newho clean 1 one complete >/dev/null 2>&1 || true
  run repair clean --apply
  [ "$status" -eq 0 ]
  assert_contains "$output" '"changed":0'
}

@test "repair-artefacts: --reset-not-started takes a CSV and repeats" {
  setup_docs linear multi
  write_handoff multi 3 three blocked
  write_handoff multi 4 four blocked
  run repair multi --apply --reset-not-started 3,4
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$DOCS_ROOT/docs/handoffs/multi/phase-03-three.md")" "status: pending"
  assert_contains "$(cat "$DOCS_ROOT/docs/handoffs/multi/phase-04-four.md")" "status: pending"
}

# ------------------------------------------------------------------ #
# QA round 1 — the four ways this script could be confidently wrong
# ------------------------------------------------------------------ #

@test "repair-artefacts: REFUSES to empty a stated depends_on (an unknown phase answers the same as 'no deps')" {
  # `phase-graph.sh --deps 99` prints nothing and exits 0 — exactly what it
  # prints for a phase that genuinely has no dependencies. A handoff whose
  # `phase:` is wrong would therefore have its real list wiped, and validate.sh
  # would then agree with the damage.
  setup_docs linear unknown
  write_handoff unknown 3 three complete
  f="$DOCS_ROOT/docs/handoffs/unknown/phase-03-three.md"
  # A phase number the 5-phase fixture does not have, plus a real dependency.
  sed -e 's/^phase: 3$/phase: 007/' -e 's/^status: complete/status: complete\ndepends_on: [1]/' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  run repair unknown --apply
  [ "$status" -eq 0 ]
  assert_contains "$output" '"kind":"depends-declined"'
  refute_contains "$output" '"kind":"depends-drift"'
  assert_contains "$(cat "$f")" "depends_on: [1]"
}

@test "repair-artefacts: still FILLS and NARROWS a depends_on — only emptying is refused" {
  setup_docs linear narrow
  write_handoff narrow 3 three complete
  f="$DOCS_ROOT/docs/handoffs/narrow/phase-03-three.md"
  sed 's/^status: complete/status: complete\ndepends_on: [1, 2]/' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  run repair narrow --apply
  [ "$status" -eq 0 ]
  assert_contains "$output" '"kind":"depends-drift"'
  assert_contains "$(cat "$f")" "depends_on: [2]"
}

@test "repair-artefacts: a zero-padded phase still yields VALID JSON" {
  # `"phase":007` is not JSON. The caller parses this summary to decide whether
  # anything changed, and a throw there reads as "nothing to fix" — a verdict
  # with no way to know whether it is true.
  setup_docs linear padded
  write_handoff padded 2 two complete
  f="$DOCS_ROOT/docs/handoffs/padded/phase-02-two.md"
  sed 's/^phase: 2$/phase: 002/' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  cat > "$DOCS_ROOT/docs/handoffs/padded/INDEX.md" <<'EOF'
| Phase | Title | Status | Handoff |
|------:|-------|--------|---------|
| 02 | two | in-progress | [phase-02-two.md](phase-02-two.md) |
EOF
  run repair padded --apply
  [ "$status" -eq 0 ]
  echo "$output" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["changed"])' >/dev/null
  assert_contains "$output" '"phase":2'
  refute_contains "$output" '"phase":002'
}

@test "repair-artefacts: a CRLF handoff is read, not silently skipped" {
  setup_docs linear crlf
  write_handoff crlf 2 two complete
  f="$DOCS_ROOT/docs/handoffs/crlf/phase-02-two.md"
  perl -pe 's/\n/\r\n/' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  cat > "$DOCS_ROOT/docs/handoffs/crlf/INDEX.md" <<'EOF'
| Phase | Title | Status | Handoff |
|------:|-------|--------|---------|
| 02 | two | in-progress | [phase-02-two.md](phase-02-two.md) |
EOF
  run repair crlf --apply
  [ "$status" -eq 0 ]
  assert_contains "$output" '"kind":"index-drift"'
  assert_contains "$(cat "$DOCS_ROOT/docs/handoffs/crlf/INDEX.md")" "| 02 | two | complete |"
}

@test "repair-artefacts: prose naming a handoff does not hide the drift below it" {
  setup_docs linear prose
  write_handoff prose 2 two complete
  cat > "$DOCS_ROOT/docs/handoffs/prose/INDEX.md" <<'EOF'
# Handoffs — prose

Start with [phase-02-two.md](phase-02-two.md) — it explains the rest.

| Phase | Title | Status | Handoff |
|------:|-------|--------|---------|
| 02 | two | in-progress | [phase-02-two.md](phase-02-two.md) |
EOF
  run repair prose --apply
  [ "$status" -eq 0 ]
  assert_contains "$output" '"kind":"index-drift"'
  assert_contains "$(cat "$DOCS_ROOT/docs/handoffs/prose/INDEX.md")" "| 02 | two | complete |"
  # …and the prose line is left exactly as it was.
  assert_contains "$(cat "$DOCS_ROOT/docs/handoffs/prose/INDEX.md")" "Start with [phase-02-two.md](phase-02-two.md) — it explains the rest."
}

@test "repair-artefacts: an expired lock's row says the removal is LOCAL" {
  setup_docs linear localrel
  pe_lock localrel claim 1 --owner ghost --scope repo >/dev/null
  expire_lock localrel 1
  run repair localrel --apply
  [ "$status" -eq 0 ]
  assert_contains "$output" "the removal is LOCAL"
}

# ------------------------------------------------------------------ #
# QA round 2 — a refusal is evidence, not work
# ------------------------------------------------------------------ #

@test "repair-artefacts: a DECLINED row counts as declined, never as changed" {
  # The driver settles the rung `fixed` when `changed > 0` and validate.sh
  # passes. Counting a refusal into `changed` therefore made the ladder record
  # a repair that had not happened, stamp slot.fixed, and delete the errand a
  # person needed — round 1's M-1 coupling, in the harmful direction.
  setup_docs linear declined
  write_handoff declined 3 three complete
  f="$DOCS_ROOT/docs/handoffs/declined/phase-03-three.md"
  sed -e 's/^phase: 3$/phase: 007/' -e 's/^status: complete/status: complete\ndepends_on: [1]/' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  run repair declined --apply
  [ "$status" -eq 0 ]
  assert_contains "$output" '"changed":0'
  assert_contains "$output" '"declined":1'
  assert_contains "$output" '"kind":"depends-declined"'
  # …and a row nothing acted on is never `applied`, whatever --apply says.
  refute_contains "$output" '"kind":"depends-declined","phase":7,"from":"[1]","to":"[]","applied":true'
}

@test "repair-artefacts: an unreadable INDEX mention is declined, not counted" {
  setup_docs linear unreadable
  write_handoff unreadable 2 two complete
  cat > "$DOCS_ROOT/docs/handoffs/unreadable/INDEX.md" <<'EOF'
# Handoffs — unreadable

Start with [phase-02-two.md](phase-02-two.md) — there is no table in this file.
EOF
  run repair unreadable --apply
  [ "$status" -eq 0 ]
  assert_contains "$output" '"kind":"index-unreadable"'
  assert_contains "$output" '"changed":0'
  assert_contains "$output" '"declined":1'
}

@test "repair-artefacts: a real repair still counts as CHANGED, with declines beside it" {
  setup_docs linear both
  write_handoff both 2 two complete
  write_handoff both 3 three complete
  g="$DOCS_ROOT/docs/handoffs/both/phase-03-three.md"
  sed -e 's/^phase: 3$/phase: 099/' -e 's/^status: complete/status: complete\ndepends_on: [1]/' "$g" > "$g.tmp" && mv "$g.tmp" "$g"
  cat > "$DOCS_ROOT/docs/handoffs/both/INDEX.md" <<'EOF'
| Phase | Title | Status | Handoff |
|------:|-------|--------|---------|
| 02 | two | in-progress | [phase-02-two.md](phase-02-two.md) |
EOF
  run repair both --apply
  [ "$status" -eq 0 ]
  assert_contains "$output" '"changed":1'
  assert_contains "$output" '"declined":1'
  assert_contains "$(cat "$DOCS_ROOT/docs/handoffs/both/INDEX.md")" "| 02 | two | complete |"
  assert_contains "$(cat "$g")" "depends_on: [1]"
}

@test "repair-artefacts: a non-numeric phase is REPORTED, not silently skipped" {
  setup_docs linear nonnum
  write_handoff nonnum 2 two complete
  f="$DOCS_ROOT/docs/handoffs/nonnum/phase-02-two.md"
  sed 's/^phase: 2$/phase: two/' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  run repair nonnum --apply
  [ "$status" -eq 0 ]
  assert_contains "$output" '"kind":"phase-unreadable"'
  assert_contains "$output" '"changed":0'
}

# ------------------------------------------------------------------ #
# QA round 3 — the counter split is DECLARED, and no handoff is silent
# ------------------------------------------------------------------ #

@test "repair-artefacts: a handoff with NO phase: line at all is reported" {
  # A frontmatter with no `phase:` read as an empty string and was skipped in
  # silence — `changed: 0`, "nothing to fix", about a file that could not be
  # repaired at all. The same silence class L-1 and L-2 were taught to break.
  setup_docs linear nophase
  write_handoff nophase 2 two complete
  f="$DOCS_ROOT/docs/handoffs/nophase/phase-02-two.md"
  grep -v '^phase: ' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  run repair nophase --apply
  [ "$status" -eq 0 ]
  assert_contains "$output" '"kind":"phase-unreadable"'
  assert_contains "$output" 'missing'
  assert_contains "$output" '"declined":1'
}

@test "repair-artefacts: every emitted kind is DECLARED in one of the two lists" {
  # The counter a kind feeds decides whether the ladder records a repair as
  # `fixed`. A kind that picked its counter from how somebody happened to name
  # it is a silent way to get that wrong, so the lists are spelled out — and
  # this test is what keeps them in step with the `emit` calls.
  declared="$(sed -n 's/^REPAIRED_KINDS=.\(.*\).$/\1/p;s/^DECLINED_KINDS=.\(.*\).$/\1/p' "$PE_SCRIPTS/repair-artefacts.sh" | tr -s ' ')"
  for kind in $(grep -oE '^ *(\[ .* \] && )?emit [a-z-]+' "$PE_SCRIPTS/repair-artefacts.sh" | awk '{print $NF}' | sort -u); do
    case " $declared " in
      *" $kind "*) : ;;
      *) echo "emit kind '$kind' is in neither REPAIRED_KINDS nor DECLINED_KINDS" >&2; return 1 ;;
    esac
  done
}
