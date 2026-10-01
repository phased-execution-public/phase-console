#!/usr/bin/env bats
# validate.sh — the deterministic plan/handoff validator (F1/F2/F3/F10).
# RED until scripts/validate.sh exists. Content assertions guard against the
# "script missing => non-zero => false green" trap.
#
# NOTE: negative fixtures are staged under NEUTRAL slugs (badrow/missingdep/loop)
# so an asserted keyword ("undefined", "cycle") can't accidentally match the slug
# that the tool echoes back in headers/messages.
load ../helpers/test_helper

@test "validate: clean linear plan passes (exit 0)" {
  setup_docs linear linear
  run pe_validate linear
  [ "$status" -eq 0 ]
}

@test "validate: every clean fixture passes" {
  for fx in diamond ranges gated sizes outoforder; do
    setup_docs "$fx" "$fx"
    run pe_validate "$fx"
    [ "$status" -eq 0 ] || { echo "fixture $fx unexpectedly failed validate: $output"; return 1; }
  done
}

@test "validate: malformed Phase cell is rejected and named (F1)" {
  setup_docs bad-malformed-table badrow
  run pe_validate badrow
  [ "$status" -ne 0 ]
  assert_contains "$output" "2a"
}

@test "validate: undefined dependency is rejected and named (F2)" {
  setup_docs bad-undefined-dep missingdep
  run pe_validate missingdep
  [ "$status" -ne 0 ]
  assert_contains "$output" "undefined"
  assert_contains "$output" "9"
}

@test "validate: dependency cycle is detected and named (F3)" {
  setup_docs bad-cycle loop
  run pe_validate loop
  [ "$status" -ne 0 ]
  assert_contains "$output" "cycle"
}

@test "F10: a handoff with NO depends_on line is judged, never a silent death" {
  # Under `set -eo pipefail` the missing line used to fail the grep pipeline
  # and kill the validator mid-loop: exit 1, no ✗, no summary — the silent-red
  # shape this script exists to prevent. Dep-less phase: absent line means [].
  setup_docs scoped scoped
  write_handoff scoped 1 root complete
  printf '\n## Start next phase(s)\nnothing.\n' >> "$DOCS_ROOT/docs/handoffs/scoped/phase-01-root.md"
  run pe_validate scoped
  [ "$status" -eq 0 ]
  assert_contains "$output" "VALIDATE OK"
}

@test "F10: a missing depends_on on a phase WITH deps reports the disagreement out loud" {
  setup_docs scoped scoped
  write_handoff scoped 2 api complete
  printf '\n## Start next phase(s)\nnothing.\n' >> "$DOCS_ROOT/docs/handoffs/scoped/phase-02-api.md"
  run pe_validate scoped
  [ "$status" -eq 1 ]
  assert_contains "$output" "disagrees with plan graph"
  assert_contains "$output" "VALIDATE FAIL"
}

@test "G13: a closed plan's garbage handoff status warns but stays exit 0" {
  setup_docs closed closedp
  write_handoff closedp 1 pasted "complete + write the closeout handoff. Verify every step"
  run pe_validate closedp
  [ "$status" -eq 0 ]
  assert_contains "$output" "VALIDATE SKIPPED"
  assert_contains "$output" "is not one of complete|in-progress|blocked|pending"
}

@test "G13: a closed plan with clean handoffs stays quiet" {
  setup_docs closed closedp
  write_handoff closedp 1 clean complete
  run pe_validate closedp
  [ "$status" -eq 0 ]
  [[ "$output" != *"is not one of"* ]]
}

# --- The four checks that moved to F1 tier in 5.0.0 (zero-touch-console P3) ---
@test "validate: names each of the four promoted checks, and passes a plan carrying a full manifest" {
  setup_docs bad-gated-no-check g1;            run pe_validate g1;  [ "$status" -ne 0 ]; assert_contains "$output" "gate-directive-missing"
  setup_docs bad-gate-type-unknown g2;         run pe_validate g2;  [ "$status" -ne 0 ]; assert_contains "$output" "gate-type-unknown"
  setup_docs bad-empty-verification-open g3;   run pe_validate g3;  [ "$status" -ne 0 ]; assert_contains "$output" "verification-empty-open"
  setup_docs bad-decision-unowned g4;          run pe_validate g4;  [ "$status" -ne 0 ]; assert_contains "$output" "decision-outstanding-unowned"
  setup_docs credentials ok;                   run pe_validate ok;  [ "$status" -eq 0 ]
}

# --------------------------------------------------------------------------
# The forward-notes family: F26 gates, F30 warns (phase 11)
# --------------------------------------------------------------------------

@test "F26: a note addressed to a phase this plan does not have FAILS, and names it" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  cat >> "$DOCS_ROOT/docs/handoffs/diamond/phase-01-root.md" <<'NOTE'

## Notes for later phases

- **Phase 4:** the merge reads both halves.
- **Phase 40:** this one is addressed to nobody.
NOTE
  run pe_validate diamond
  [ "$status" -ne 0 ]
  assert_contains "$output" "note-target-unknown"
  assert_contains "$output" "40"
  assert_contains "$output" "F26"
  # The well-addressed one is not an offence, and `Next`/`All` never are: they
  # are relations, and a relation always has a reader.
  refute_contains "$output" "note for phase 4,"
}

@test "F26: \`Next\` and \`All\` are never note-target-unknown" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  cat >> "$DOCS_ROOT/docs/handoffs/diamond/phase-01-root.md" <<'NOTE'

## Notes for later phases

- **Next:** a dependency edge, not a number.
- **All:** everybody after me.
NOTE
  # The lint arm, not the whole validator: `write_handoff` scaffolds a minimal
  # handoff with no boot section, so `validate.sh` has a second, unrelated
  # reason to fail and "exit 0" would be proving something else.
  run pg diamond --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" "note-target-unknown"
}

@test "F30: a note addressed to a phase that is already DONE warns, and the lint still passes" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  write_handoff diamond 2 left complete
  cat >> "$DOCS_ROOT/docs/handoffs/diamond/phase-01-root.md" <<'NOTE'

## Notes for later phases

- **Phase 2:** phase 2 has already been and gone.
- **Phase 4:** phase 4 has not.
NOTE
  run pg diamond --lint
  # Advisory: the phase exists and the note is well-formed — only its reader
  # is gone. Its own id, because an id that both gates and warns cannot answer
  # "did the lint fail?".
  [ "$status" -eq 0 ]
  assert_contains "$output" "F30"
  assert_contains "$output" "note-target-done"
  assert_contains "$output" "phase 2"
  refute_contains "$output" "note for phase 4 will never"
  assert_contains "$output" "LINT OK"
}

@test "F30: a note DELIVERED before its target finished is not a finding" {
  # The near miss that made F30 grow an advisory per finished phase: phase 7's
  # note to phase 8 became a finding the instant phase 8 closed, having done
  # its whole job. "Already done" has to mean already done WHEN THE NOTE WAS
  # WRITTEN, which the two `completed:` dates answer; a tie reads as delivered,
  # because an advisory must not fire on an ordering it cannot establish.
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  write_handoff diamond 2 left complete
  sed -i.bak 's/^status: complete/status: complete\ncompleted: 2026-09-20/' \
    "$DOCS_ROOT/docs/handoffs/diamond/phase-01-root.md"
  sed -i.bak 's/^status: complete/status: complete\ncompleted: 2026-09-22/' \
    "$DOCS_ROOT/docs/handoffs/diamond/phase-02-left.md"
  cat >> "$DOCS_ROOT/docs/handoffs/diamond/phase-01-root.md" <<'NOTE'

## Notes for later phases

- **Phase 2:** written while phase 2 was still ahead of us.
NOTE
  run pg diamond --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" "note-target-done"
  assert_contains "$output" "LINT OK"
}

@test "F30: a note written AFTER its target finished is still a finding" {
  # The case F30 exists for, and the one the predicate must not lose: a handoff
  # written today leaving a note for a phase that closed last week. Nothing will
  # ever board that phase again, so nobody will ever read it.
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  write_handoff diamond 2 left complete
  sed -i.bak 's/^status: complete/status: complete\ncompleted: 2026-09-25/' \
    "$DOCS_ROOT/docs/handoffs/diamond/phase-01-root.md"
  sed -i.bak 's/^status: complete/status: complete\ncompleted: 2026-09-22/' \
    "$DOCS_ROOT/docs/handoffs/diamond/phase-02-left.md"
  cat >> "$DOCS_ROOT/docs/handoffs/diamond/phase-01-root.md" <<'NOTE'

## Notes for later phases

- **Phase 2:** phase 2 had already been and gone when this was written.
NOTE
  run pg diamond --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "note-target-done"
  assert_contains "$output" "phase 2"
}

# F33 `repos-outside-root` (control-tower phase 82, #94): one Repos cell naming
# a repository outside the docs root used to refuse isolation for every phase
# of the run, silently. The console now refuses that phase alone; the lint
# names the cell at plan time. Advisory — the plan is valid, and the exit code
# never moves.
_outside_plan() {
  local slug="$1" c1="$2" c2="$3" c3="$4"
  scrub_pe_env
  export DOCS_ROOT="$BATS_TEST_TMPDIR/work"
  mkdir -p "$DOCS_ROOT/docs/plans" "$DOCS_ROOT/docs/handoffs/$slug"
  cat > "$DOCS_ROOT/docs/plans/$slug.md" <<PLAN
---
slug: $slug
created: 2026-09-26
status: active
phases: 3
handoffs: docs/handoffs/$slug/
memory: project_$slug
---

# Outside test plan

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Alpha | — | — | $c1 | builds |
| 2 | Beta  | 1 | — | $c2 | builds |
| 3 | Gamma | 2 | — | $c3 | builds |

## Phases

### Phase 1 — Alpha
- **Verification:**
  - \`true\`

### Phase 2 — Beta
- **Verification:**
  - \`true\`

### Phase 3 — Gamma
- **Verification:**
  - \`true\`
PLAN
}

@test "F33: a Repos cell naming a repository outside the root is named, alone, and the lint still passes" {
  _outside_plan outside web api "api, homebrew-tap"
  mkdir -p "$DOCS_ROOT/web" "$DOCS_ROOT/api"
  run pg outside --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "F33 phase 3: repos-outside-root"
  assert_contains "$output" '`homebrew-tap`'
  refute_contains "$output" "F33 phase 1"
  refute_contains "$output" "F33 phase 2"
  refute_contains "$output" '`api`, which'
  assert_contains "$output" "LINT OK"
  # validate.sh delegates to the same lint and never gates on an advisory.
  run pe_validate outside
  [ "$status" -eq 0 ]
}

# F34 `repos-root-token` (control-tower phase 90, #154): a Repos cell naming the
# superproject itself in a phase whose files are all in submodules or under
# docs/ mounts the whole root into an isolated run and waits on any run holding
# the root repository — for nothing. Advisory, judged only from the Files
# bullet, and only in a superproject.
_root_token_plan() {
  local slug="$1"
  scrub_pe_env
  export DOCS_ROOT="$BATS_TEST_TMPDIR/work"
  mkdir -p "$DOCS_ROOT/docs/plans" "$DOCS_ROOT/docs/handoffs/$slug" "$DOCS_ROOT/web" "$DOCS_ROOT/api"
  cat > "$DOCS_ROOT/docs/plans/$slug.md" <<PLAN
---
slug: $slug
created: 2026-09-27
status: active
phases: 4
handoffs: docs/handoffs/$slug/
memory: project_$slug
---

# Root token test plan

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Alpha | — | — | work | builds |
| 2 | Beta  | 1 | — | work, web | builds |
| 3 | Gamma | 2 | — | work, api | builds |
| 4 | Delta | 3 | — | web | builds |

## Phases

### Phase 1 — Alpha
- **Verification:**
  - \`true\`

### Phase 2 — Beta
- **Files to create/modify:**
  - \`web/src/app.ts\`, \`web/README.md\`
  - \`docs/notes.md\` and the \`ensureMirror\` comment
- **Verification:**
  - \`true\`

### Phase 3 — Gamma
- **Files to create/modify:** \`api/server.ts\`, \`scripts/deploy.sh\`
- **Verification:**
  - \`true\`

### Phase 4 — Delta
- **Files to create/modify:** \`web/src/app.ts\`
- **Verification:**
  - \`true\`
PLAN
}

@test "F34: a root token over files that are all in submodules or docs/ is named, and the lint still passes" {
  _root_token_plan roots
  printf '[submodule "web"]\n\tpath = web\n\turl = ../web\n[submodule "api"]\n\tpath = api\n\turl = ../api\n' > "$DOCS_ROOT/.gitmodules"
  run pg roots --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "F34 phase 2: repos-root-token"
  assert_contains "$output" 'names `work`, the superproject itself'
  # Phase 3 writes root code (scripts/deploy.sh); phase 1 lists no files, so
  # there is nothing to judge; phase 4 never names the root.
  refute_contains "$output" "F34 phase 3"
  refute_contains "$output" "F34 phase 1"
  refute_contains "$output" "F34 phase 4"
  assert_contains "$output" "LINT OK"
  run pe_validate roots
  [ "$status" -eq 0 ]
}

@test "F34: silent outside a superproject — a plain repository's root is the only tree there is" {
  _root_token_plan plain
  run pg plain --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" "F34"
}

# F35 `checkout-inert` (control-tower phase 90, #154): the console acts on one
# `Checkout:` meaning — the default branch, board detached at the trunk — and
# carries every other value verbatim, acting on nothing. Advisory.
@test "F35: a Checkout value the console never acts on is named; main, master and default are not" {
  scrub_pe_env
  export DOCS_ROOT="$BATS_TEST_TMPDIR/work"
  mkdir -p "$DOCS_ROOT/docs/plans" "$DOCS_ROOT/docs/handoffs/co"
  cat > "$DOCS_ROOT/docs/plans/co.md" <<'PLAN'
---
slug: co
created: 2026-09-27
status: active
phases: 3
handoffs: docs/handoffs/co/
memory: project_co
---

# Checkout test plan

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Alpha | — | — | app | builds |
| 2 | Beta  | 1 | — | app | builds |
| 3 | Gamma | 2 | — | app | builds |

## Phases

### Phase 1 — Alpha
- **Checkout:** `Default`
- **Verification:**
  - `true`

### Phase 2 — Beta
- **Checkout:** `pe/co-hotfix`
- **Verification:**
  - `true`

### Phase 3 — Gamma
- **Checkout:** main
- **Verification:**
  - `true`
PLAN
  run pg co --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" 'F35 phase 2: checkout-inert — `Checkout: pe/co-hotfix` is acted on by nobody'
  refute_contains "$output" "F35 phase 1"
  refute_contains "$output" "F35 phase 3"
  assert_contains "$output" "LINT OK"
}

@test "F33: a token that is a symlink out of the root is outside, however it is spelled" {
  _outside_plan escape web vendor web
  mkdir -p "$DOCS_ROOT/web" "$BATS_TEST_TMPDIR/elsewhere"
  ln -s "$BATS_TEST_TMPDIR/elsewhere" "$DOCS_ROOT/vendor"
  run pg escape --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "F33 phase 2: repos-outside-root"
  assert_contains "$output" '`vendor`'
}

@test "F33: the hub shape — no cell under the root at all — is not a finding, and neither is all" {
  _outside_plan hubshape homebrew-tap other-repo all
  run pg hubshape --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" "F33"
  # A plan whose cells are all under the root says nothing either.
  _outside_plan inroot web web all
  mkdir -p "$DOCS_ROOT/web"
  run pg inroot --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" "F33"
}

# HF-4 (control-tower phase 85, #115): the `▶ Start next phase(s)` section is a
# hand-off to OTHER sessions, and a handoff it dominates no longer reads as one
# document — tfar phase 32's ran 1,090 of 1,350 lines and buried `## Outstanding`
# at line 1,333. validate.sh names such a handoff; it is a warning, never a
# problem: the exit code is untouched.
#
# oversized_handoff <body-lines> <start-section-lines> — phase 1 of the linear plan.
oversized_handoff() {
  local f="$DOCS_ROOT/docs/handoffs/linear/phase-01-alpha.md" i
  {
    printf -- '---\nplan: docs/plans/linear.md\nphase: 1\ntitle: alpha\nstatus: complete\ndepends_on: []\n---\n\n## What this phase did\n'
    i=0; while [ "$i" -lt "$1" ]; do i=$((i + 1)); echo "shipped $i"; done
    printf '\n## ▶ Start next phase(s) (paste into fresh sessions)\n\n```\n'
    i=0; while [ "$i" -lt "$2" ]; do i=$((i + 1)); echo "prompt $i"; done
    printf '```\n\n## Outstanding / blockers\nnone\n'
  } > "$f"
}

# ET-2 (control-tower phase 90, #123): a person's `!` line that points into a
# console run tree is named — the console prunes that tree on its own schedule.
# A warning, never a problem.
errand_handoff() {
  local f="$DOCS_ROOT/docs/handoffs/linear/phase-01-alpha.md"
  {
    printf -- '---\nplan: docs/plans/linear.md\nphase: 1\ntitle: alpha\nstatus: in-progress\ndepends_on: []\n---\n\n## ⛔ Parked on\n'
    printf '%s\n' "$@"
    printf '\n## ▶ Start next phase(s) (paste into fresh sessions)\n\nnone yet\n'
  } > "$f"
}

@test "ET-2: a ! line into a console run tree is named, and validate still passes" {
  setup_docs linear linear
  errand_handoff '```' \
    '! cd /home/op/.local/state/phase-console/runs/4557c636-hub/obs/worktrees/86103bfe79aa/integration/hetzner && terraform apply plan.tfplan' \
    '```' \
    '- `! cd /home/op/work/hub/.worktrees/runs/obs/86103bfe79aa/integration/aws && terraform plan`'
  run pe_validate linear
  [ "$status" -eq 0 ]
  assert_contains "$output" "phase-01-alpha.md:"
  assert_contains "$output" "points into a console run tree"
  assert_contains "$output" "errand-tree"
  [ "$(printf '%s\n' "$output" | grep -c 'points into a console run tree')" -eq 2 ]
  assert_contains "$output" "VALIDATE OK"
}

@test "ET-2: a ! line into an errand tree, and prose naming a run tree, say nothing" {
  setup_docs linear linear
  errand_handoff '! cd /home/op/work/hub/.worktrees/hand/obs/p27-errand/hetzner && terraform apply plan.tfplan' \
    'The mirror at /home/op/work/hub/.worktrees/runs/obs/86103bfe79aa/integration was pruned.' \
    '!= not a command'
  run pe_validate linear
  [ "$status" -eq 0 ]
  case "$output" in *"points into a console run tree"*) false ;; esac
}

@test "HF-4: a start section over 300 lines is named, and validate still passes" {
  setup_docs linear linear
  oversized_handoff 700 320
  run pe_validate linear
  [ "$status" -eq 0 ]
  assert_contains "$output" "phase-01-alpha.md"
  assert_contains "$output" "section is 325 of"
  assert_contains "$output" "over 300 lines"
  assert_contains "$output" "VALIDATE OK"
}

@test "HF-4: a start section over 40% of its handoff is named, however short" {
  setup_docs linear linear
  oversized_handoff 40 80
  run pe_validate linear
  [ "$status" -eq 0 ]
  assert_contains "$output" "phase-01-alpha.md"
  assert_contains "$output" "over 40% of the handoff"
}

@test "HF-4: a start section under both bounds says nothing" {
  setup_docs linear linear
  oversized_handoff 300 100
  run pe_validate linear
  [ "$status" -eq 0 ]
  refute_contains "$output" "phase-01-alpha.md"
  refute_contains "$output" "section is"
}
