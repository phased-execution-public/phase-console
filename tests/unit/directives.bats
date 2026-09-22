#!/usr/bin/env bats
# The nine plan directives 5.1.0 adds, read by the engine.
#
# One property runs through all of them and is the reason they share a suite:
# every arm answers `value<TAB>source`, where source is `phase`, `plan` or
# `default`. The source token is not decoration. These words have engine-owned
# defaults — a plan that says nothing about landing lands nothing — so a bare
# `hold` would be two different facts wearing one spelling: "this plan chose
# hold" and "this plan has never considered landing". The console asks the
# first to report it and the second to put it in the wizard, so the engine has
# to tell them apart.
#
# `--isolation` is the one arm with no default at all: a phase that says
# nothing inherits the RUN, which is not in the plan, so its third state is
# silence. Pinned below, because "answers nothing" is exactly the behaviour a
# well-meaning later edit turns into `shared\tdefault`.
load ../helpers/test_helper

# --------------------------------------------------------------------------
# --land: the four shapes
# --------------------------------------------------------------------------

@test "--land: a phase with no bullet takes the plan's word, tagged plan" {
  setup_docs landing landing
  run pg landing --land 1
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'pr\tplan')" ]
}

@test "--land: a phase's own bullet wins, tagged phase" {
  setup_docs landing landing
  run pg landing --land 2
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'integrate\tphase')" ]
}

@test "--land: a bullet that AGREES with the plan still reads as the phase's" {
  setup_docs landing landing
  # Phase 3 says `hold` where the plan says `pr`. The word differs, but the
  # point is the source: a phase that states its policy has stated it, whether
  # or not it happens to match.
  run pg landing --land 3
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'hold\tphase')" ]
}

@test "--land: a plan that says nothing gets the engine's default, tagged default" {
  setup_docs checkout checkout
  run pg checkout --land 1
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'hold\tdefault')" ]
}

@test "--land with no phase reads the plan line alone" {
  setup_docs landing landing
  run pg landing --land
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'pr\tplan')" ]
}

@test "--land: an unknown phase is a usage error, not an answer" {
  setup_docs landing landing
  run pg landing --land 99
  [ "$status" -eq 2 ]
  assert_contains "$output" "not in this plan"
}

# --------------------------------------------------------------------------
# The rest of the per-phase family
# --------------------------------------------------------------------------

@test "--gitlink: plan line, phase override, engine default" {
  setup_docs landing landing
  run pg landing --gitlink 1
  [ "$output" = "$(printf 'leave\tplan')" ]
  run pg landing --gitlink 2
  [ "$output" = "$(printf 'bump\tphase')" ]
  setup_docs checkout checkout
  run pg checkout --gitlink 1
  [ "$output" = "$(printf 'bump\tdefault')" ]
}

@test "--issues: a phase narrows the plan's word, and silence takes it" {
  setup_docs issues issues
  run pg issues --issues 1
  [ "$output" = "$(printf 'file\tplan')" ]
  run pg issues --issues 2
  [ "$output" = "$(printf 'draft\tphase')" ]
  run pg issues --issues 3
  [ "$output" = "$(printf 'off\tphase')" ]
  run pg issues --issues 4
  [ "$output" = "$(printf 'file\tplan')" ]
}

@test "--issues: off is the default, because an outward write is never one" {
  setup_docs checkout checkout
  run pg checkout --issues
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'off\tdefault')" ]
}

@test "--isolation: silence is the third state — the run decides, and the run is not here" {
  setup_docs landing landing
  run pg landing --isolation 2
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'worktree\tphase')" ]
  # Phase 3 declares nothing and the plan declares nothing. The engine must not
  # invent `shared`: that would be the engine answering a question the run owns.
  run pg landing --isolation 3
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

# --------------------------------------------------------------------------
# The plan-wide family — and the refusal that keeps it plan-wide
# --------------------------------------------------------------------------

@test "--base-branch: the plan's ref verbatim, else origin/HEAD" {
  setup_docs landing landing
  run pg landing --base-branch
  [ "$status" -eq 0 ]
  # A ref, not a word: the slash must survive, and so must the dot.
  [ "$output" = "$(printf 'release/5.1\tplan')" ]
  setup_docs checkout checkout
  run pg checkout --base-branch
  [ "$output" = "$(printf 'origin/HEAD\tdefault')" ]
}

@test "--conflict-policy: the plan's word, else halt" {
  setup_docs landing landing
  run pg landing --conflict-policy
  [ "$output" = "$(printf 'park\tplan')" ]
  setup_docs checkout checkout
  run pg checkout --conflict-policy
  [ "$output" = "$(printf 'halt\tdefault')" ]
}

@test "--messaging: read unbolded too, and on by default" {
  setup_docs messaging messaging
  run pg messaging --messaging
  [ "$status" -eq 0 ]
  # The fixture writes `messaging: off` with no bold at all.
  [ "$output" = "$(printf 'off\tplan')" ]
  setup_docs checkout checkout
  run pg checkout --messaging
  [ "$output" = "$(printf 'on\tdefault')" ]
}

@test "a plan-wide arm REFUSES a phase argument rather than ignoring it" {
  setup_docs messaging messaging
  # Phase 3's bullet says `on` against a plan that says `off`. Accepting the
  # argument and answering `on` would let one phase turn off a run-wide
  # transport its siblings are relying on — so the arm refuses the question.
  run pg messaging --messaging 3
  [ "$status" -eq 2 ]
  assert_contains "$output" "plan-wide"
  setup_docs landing landing
  run pg landing --base-branch 1
  [ "$status" -eq 2 ]
  assert_contains "$output" "plan-wide"
  run pg landing --conflict-policy 1
  [ "$status" -eq 2 ]
}

@test "--clash-zones: the backticked paths, as a csv" {
  setup_docs landing landing
  run pg landing --clash-zones
  [ "$status" -eq 0 ]
  [ "$output" = "viewer/shared/, scripts/phase-graph.sh" ]
  setup_docs checkout checkout
  run pg checkout --clash-zones
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

# --------------------------------------------------------------------------
# The lints
# --------------------------------------------------------------------------

@test "F27 land-word-unknown: both levels are named, and the lint FAILS" {
  setup_docs bad-land-word bad-land-word
  run pe_validate bad-land-word
  [ "$status" -ne 0 ]
  assert_contains "$output" "land-word-unknown"
  assert_contains "$output" "sometimes"
  assert_contains "$output" "yes"
  assert_contains "$output" "maybe"
}

@test "F27: the readers fall THROUGH an unknown word rather than adopting it" {
  setup_docs bad-land-word bad-land-word
  # Phase 2 says `yes`, which is not a policy. The plan says `sometimes`, which
  # is not one either. So the answer is the engine's default — and crucially it
  # is tagged `default`, not `phase`, so nothing downstream believes the plan
  # made a choice it did not make.
  run pg bad-land-word --land 2
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'hold\tdefault')" ]
}

@test "F29 landed-gate-unknown-phase: a gate on a phase that does not exist FAILS the lint" {
  setup_docs bad-landed-gate bad-landed-gate
  run pe_validate bad-landed-gate
  [ "$status" -ne 0 ]
  assert_contains "$output" "landed-gate-unknown-phase"
  assert_contains "$output" "99"
}

@test "F26 note-target-unknown: a handoff note for a phase that does not exist FAILS the lint" {
  setup_docs landing landing
  write_handoff landing 1 x complete
  cat >> "$DOCS_ROOT/docs/handoffs/landing/phase-01-x.md" <<'NOTE'

## Notes for later phases

- **Phase 4:** the base-branch words live in `landing-model.js`; do not re-spell them.
- **Phase 40:** this one is addressed to nobody.
NOTE
  run pe_validate landing
  [ "$status" -ne 0 ]
  assert_contains "$output" "note-target-unknown"
  assert_contains "$output" "40"
  # The note for a phase that DOES exist is not an offence.
  refute_contains "$output" "note for phase 4,"
}

@test "F28 land-needs-lane is ADVISORY — stderr, and the lint still passes" {
  setup_docs landing landing
  run pg landing --lint
  # Phase 1 lands with `pr` from a checkout it shares. That is a hazard, not an
  # error: a plan whose phases are serial is fine, and that plan exists.
  [ "$status" -eq 0 ]
  assert_contains "$output" "F28"
  assert_contains "$output" "land-needs-lane"
  assert_contains "$output" "LINT OK"
  # Phase 2, 4 and 5 each have a lane of their own, so none of them is named.
  refute_contains "$output" "F28 phase 2"
  refute_contains "$output" "F28 phase 4"
}

# --------------------------------------------------------------------------
# --notes (source 1 of 3; phase 11 adds the other two)
# --------------------------------------------------------------------------

@test "--notes: a phase is handed the bullets addressed to it, and nobody else's" {
  setup_docs landing landing
  write_handoff landing 1 x complete
  cat >> "$DOCS_ROOT/docs/handoffs/landing/phase-01-x.md" <<'NOTE'

## Notes for later phases

- **Phase 4:** the ledger's column order is fixed; read it by header name.
- **For phase 5:** the gate reads the ledger, never `gh`.
NOTE
  run pg landing --notes 4
  [ "$status" -eq 0 ]
  assert_contains "$output" "ledger's column order"
  refute_contains "$output" "never \`gh\`"
  assert_contains "$output" "phase-01-x"
  # The label is bold and the colon sits INSIDE the emphasis, so stripping to
  # the first colon leaves the closing `**` at the head of the note unless
  # something drops it. It reads as a broken bullet everywhere it is shown.
  refute_contains "$output" "	**"

  run pg landing --notes 5
  assert_contains "$output" "never \`gh\`"

  # A phase nobody wrote to is handed nothing — not an error, not a blank line.
  run pg landing --notes 2
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
