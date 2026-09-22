#!/usr/bin/env bats
# F12 machine-checkable gates (--gate-status) + F9 memory-block generator.
load ../helpers/test_helper

@test "gate-status: a future date gate is blocked (exit 1)" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 2
  [ "$status" -ne 0 ]
  assert_contains "$output" "blocked"
}

@test "gate-status: a past date gate is clear (exit 0)" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 3
  [ "$status" -eq 0 ]
  assert_contains "$output" "clear"
}

@test "gate-status: a phase gate is blocked until that phase is verified" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 4
  [ "$status" -ne 0 ]                     # phase 1 not done yet
  write_handoff gatecheck 1 base complete
  run pg gatecheck --gate-status 4
  [ "$status" -eq 0 ]                     # phase 1 done (no QA gating) -> verified -> clear
  assert_contains "$output" "clear"
}

@test "gate-status: a manual gate needs human confirmation (exit 1)" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 5
  [ "$status" -ne 0 ]
  assert_contains "$output" "manual"
}

@test "gate-status: a phase with no gate-check is clear and not spilled from a neighbour" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 1
  [ "$status" -eq 0 ]
  assert_contains "$output" "clear"
  refute_contains "$output" "2099"        # must NOT pick up phase 2's gate-check
}

@test "gate-status: a phases gate needs every listed phase verified" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 6
  [ "$status" -ne 0 ]
  assert_contains "$output" "blocked"
  write_handoff gatecheck 1 base complete
  run pg gatecheck --gate-status 6
  [ "$status" -ne 0 ]
  assert_contains "$output" "3"
  write_handoff gatecheck 3 past complete
  run pg gatecheck --gate-status 6
  [ "$status" -eq 0 ]
  assert_contains "$output" "clear"
}

@test "gate-status: deadline before the date is clear, after is OVERDUE" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 7
  [ "$status" -eq 0 ]
  assert_contains "$output" "deadline"
  run pg gatecheck --gate-status 8
  [ "$status" -ne 0 ]
  assert_contains "$output" "OVERDUE"
}

@test "gate-status: a cmd gate does not execute unless opted in" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 9
  [ "$status" -ne 0 ]
  assert_contains "$output" "cmd gate not executed"
  PHASE_EXEC_GATES=1 run pg gatecheck --gate-status 9
  [ "$status" -eq 0 ]
  assert_contains "$output" "clear (cmd ok)"
}

@test "gate-status: an unexecuted cmd gate is DISTINGUISHABLE from a human gate" {
  # The split verdict this test exists to prevent: the same gate, on the same
  # plan, in the same second, told the autopilot `clear (cmd ok)` → proceed and
  # the session it boarded `manual:` → stop and fetch a person. SKILL.md routes
  # on the WORD, so the word has to say which of the two facts it means.
  setup_docs gatecheck gatecheck

  run pg gatecheck --gate-status 9          # cmd true, without the opt-in
  [ "$status" -ne 0 ]
  assert_contains "$output" "unevaluated:"
  refute_contains "$output" "manual:"

  run pg gatecheck --gate-status 5          # manual ops sign-off — a real person's gate
  [ "$status" -ne 0 ]
  assert_contains "$output" "manual:"
  refute_contains "$output" "unevaluated:"

  # And the opt-in still collapses the cmd gate to a plain verdict, so the new
  # word only ever appears for the reader that declined to run the command.
  PHASE_EXEC_GATES=1 run pg gatecheck --gate-status 9
  [ "$status" -eq 0 ]
  refute_contains "$output" "unevaluated:"
}

@test "boot-prompt: an unevaluated cmd gate tells the session how to evaluate it" {
  # Reading the verdict is not enough — the prompt used to say "confirm it is
  # clear", and confirming it the same way answers `unevaluated` again forever.
  setup_docs gatecheck gatecheck
  run pg gatecheck --boot-prompt 9
  assert_contains "$output" "unevaluated:"
  assert_contains "$output" "PHASE_EXEC_GATES=1"
  refute_contains "$output" "Do NOT implement past an unapproved human gate"
}

@test "gate-status: a mutating cmd gate is refused even when opted in" {
  setup_docs gatecheck denyplan
  cat > "$DOCS_ROOT/docs/plans/denyplan.md" <<'EOF'
---
slug: denyplan
created: 2026-01-01
status: active
phases: 2
handoffs: docs/handoffs/denyplan/
memory: project_denyplan
---
# deny
## Phase graph
| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | a | — | — | r | x |
| 2 | b | 1 | — | r | x |

### Phase 2 — b *(GATED)*
- **Gate-check:** cmd rm -rf /nowhere
EOF
  PHASE_EXEC_GATES=1 run pg denyplan --gate-status 2
  [ "$status" -ne 0 ]
  assert_contains "$output" "REFUSED"
}

@test "gate-status: a cross-plan gate clears when the other plan's phases are done" {
  setup_docs linear otherplan
  setup_docs gatecheck xp
  cat > "$DOCS_ROOT/docs/plans/xp.md" <<'EOF'
---
slug: xp
created: 2026-01-01
status: active
phases: 1
handoffs: docs/handoffs/xp/
memory: project_xp
---
# xp
## Phase graph
| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | waitother | — | — | r | x |

### Phase 1 — waitother *(GATED)*
- **Gate-check:** plan otherplan:1
EOF
  run pg xp --gate-status 1
  [ "$status" -ne 0 ]
  assert_contains "$output" "blocked"
  write_handoff otherplan 1 alpha complete
  run pg xp --gate-status 1
  [ "$status" -eq 0 ]
  assert_contains "$output" "otherplan"
}

@test "gate-status: an ai gate reports its instructions with kind ai (exit 1)" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 10
  [ "$status" -ne 0 ]
  assert_contains "$output" "ai: verify staging deploy and smoke suite"
}

@test "gate-status: a multi-line prose gate is reported whole, not truncated at six lines" {
  setup_docs gatecheck fulltext
  # strip phase 10's Gate-check so the default (`ai` since 5.0.0) surfaces the prose
  sed -i.bak '/ai verify staging deploy/d' "$DOCS_ROOT/docs/plans/fulltext.md"
  run pg fulltext --gate-status 10
  [ "$status" -ne 0 ]
  [[ "$output" == ai:* ]]
  assert_contains "$output" "seventh condition"
}

@test "lint: the gatecheck fixture (every gate type incl. ai) is clean" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --lint
  [ "$status" -eq 0 ]
}

@test "lint: an unknown Gate-check type is reported by name" {
  setup_docs gatecheck typo
  sed -i.bak 's/manual ops sign-off before launch/manuel ops sign-off/' "$DOCS_ROOT/docs/plans/typo.md"
  run pg typo --lint
  [ "$status" -ne 0 ]
  assert_contains "$output" 'gate-type-unknown — Gate-check type "manuel"'
}

@test "memory-block: emits done / ready / waiting sets in canonical form" {
  setup_docs linear linear
  write_handoff linear 1 alpha complete
  run pg linear --memory-block
  [ "$status" -eq 0 ]
  assert_contains "$output" "done: 1"
  assert_contains "$output" "ready: 2"
  assert_contains "$output" "waiting: 3"
}

@test "memory-block: a diamond after root shows two ready" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  run pg diamond --memory-block
  assert_contains "$output" "ready: 2, 3"
}

# --- delegated human gates (PE_GATE_DELEGATE) --------------------------------
# A `human` gate says a person must decide, and the boot prompt says STOP. An
# operator who wants a plan to run unattended can delegate that verification to
# the session instead — which `gate-status.md`'s own header already names as a
# legitimate approver ("an AI session that verified the conditions"), and which
# this repository's own plans already record (`by: ai-session-delegated`).
# Opt-in, per run, and never the default: the plan author wrote `human`.

@test "boot-prompt: a human gate says STOP by default" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --boot-prompt 5
  assert_contains "$output" "a person must clear this gate"
  assert_contains "$output" "Do NOT implement past an unapproved human gate"
}

@test "boot-prompt: PE_GATE_DELEGATE briefs the session to verify and clear it" {
  setup_docs gatecheck gatecheck
  PE_GATE_DELEGATE=1 run pg gatecheck --boot-prompt 5
  assert_contains "$output" "DELEGATED"
  assert_contains "$output" "ai-session-delegated"
  refute_contains "$output" "Do NOT implement past an unapproved human gate"
}

@test "boot-prompt: a delegated gate still refuses to invent evidence" {
  setup_docs gatecheck gatecheck
  PE_GATE_DELEGATE=1 run pg gatecheck --boot-prompt 5
  # The whole safety of delegation is NOT that the session is trusted to judge —
  # it is that a condition it cannot verify from evidence STOPS it, by name.
  assert_contains "$output" "verify it against evidence you can actually read"
  assert_contains "$output" "Never record an approval you cannot cite evidence for"
  assert_contains "$output" "cannot verify from evidence"
  # And the stop is a declared outcome the supervisor reads, not prose — by key.
  assert_contains "$output" "blocked --needs gates --reason"
}

@test "boot-prompt: delegation does not touch an ai gate's own wording" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --boot-prompt 5
  before="$output"
  PE_GATE_DELEGATE=1 run pg gatecheck --boot-prompt 2
  # phase 2 is a date gate (auto), not human — delegation must not reword it.
  refute_contains "$output" "DELEGATED"
}

# 2026-09-18 (run f0da619a): `git merge-base` is a read — the deny rule matched
# it as `git merge` because the verb had no boundary. The boundary must not
# open `git push;true` either, which a whole gate-check line can carry.
_git_gate_plan() {  # _git_gate_plan <gate-check cmd>
  cat > "$DOCS_ROOT/docs/plans/gitgate.md" <<PLAN
---
slug: gitgate
created: 2026-01-01
status: active
phases: 2
handoffs: docs/handoffs/gitgate/
memory: project_gitgate
---
# gitgate
## Phase graph
| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | a | — | — | r | x |
| 2 | b | 1 | — | r | x |

### Phase 2 — b *(GATED)*
- **Gate-check:** cmd $1
PLAN
}

@test "gate-status: a read-only git gate (merge-base) is evaluated, not refused" {
  setup_docs gatecheck gitgate
  _git_gate_plan 'git merge-base --is-ancestor HEAD HEAD'
  run pg gitgate --gate-status 2
  refute_contains "$output" "REFUSED"
  assert_contains "$output" "cmd gate not executed"
}

@test "gate-status: git push stays refused behind a separator or a global option" {
  setup_docs gatecheck gitgate
  _git_gate_plan 'git push;true'
  PHASE_EXEC_GATES=1 run pg gitgate --gate-status 2
  [ "$status" -ne 0 ]
  assert_contains "$output" "REFUSED"
  _git_gate_plan 'git -C . push origin main'
  PHASE_EXEC_GATES=1 run pg gitgate --gate-status 2
  [ "$status" -ne 0 ]
  assert_contains "$output" "REFUSED"
}

@test "gate-status: a redirect to /dev/null is not a write" {
  setup_docs gatecheck gitgate
  _git_gate_plan 'grep -q x /nonexistent 2>/dev/null'
  run pg gitgate --gate-status 2
  refute_contains "$output" "REFUSED"
}

# ── S8-a — a cross-plan gate read the other plan's DONE set, not its verified one
# `done` and `verified` are two different questions once QA gates, and this gate
# asked the easy one: a phase whose QA verdict is `fail` is `done` on the board
# (its handoff says complete) and is exactly the phase a dependent plan must not
# build on. The engine already knows the difference — `_is_verified` — it simply
# was not asked across the plan boundary.
@test "gate-status: a cross-plan gate stays blocked while the other plan's phase has QA fail (S8-a)" {
  setup_docs linear otherplan
  setup_docs gatecheck xp
  cat > "$DOCS_ROOT/docs/plans/xp.md" <<'EOF'
---
slug: xp
created: 2026-01-01
status: active
phases: 1
handoffs: docs/handoffs/xp/
memory: project_xp
---
# xp
## Phase graph
| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | waitother | — | — | r | x |

### Phase 1 — waitother *(GATED)*
- **Gate-check:** plan otherplan:1
EOF
  write_handoff otherplan 1 alpha complete
  # QA on for otherplan, and phase 1 FAILED it.
  "$SYS_BASH" "$PE_SCRIPTS/qa-mode.sh" otherplan on >/dev/null
  qa_record otherplan 1 fail --report reports/phase-01-qa.md
  run pg xp --gate-status 1
  [ "$status" -ne 0 ]
  assert_contains "$output" "blocked"

  # …and clears the moment the verdict does.
  qa_record otherplan 1 pass --report reports/phase-01-qa-r2.md
  run pg xp --gate-status 1
  [ "$status" -eq 0 ]
  assert_contains "$output" "otherplan"
}

@test "verified: the mode the cross-plan gate reads — done AND QA-passed (S8-a)" {
  setup_docs linear otherplan
  write_handoff otherplan 1 alpha complete
  write_handoff otherplan 2 beta complete
  run pg otherplan --verified
  [ "$status" -eq 0 ]
  assert_contains "$output" "1"
  assert_contains "$output" "2"

  "$SYS_BASH" "$PE_SCRIPTS/qa-mode.sh" otherplan on >/dev/null
  qa_record otherplan 2 fail --report reports/phase-02-qa.md
  run pg otherplan --verified
  [ "$status" -eq 0 ]
  # phase 2 is done and NOT verified: the whole point of the mode.
  refute_contains " $output " " 2 "
}

@test "verified: with QA off, verified is exactly done (S8-a)" {
  setup_docs linear otherplan
  write_handoff otherplan 1 alpha complete
  done_set="$(pg otherplan --memory-block | grep '^done:' | sed 's/^done:[[:space:]]*//')"
  [ "$(pg otherplan --verified)" = "$done_set" ]
}

# ── S8-b — nothing tied "done" to "landed" ───────────────────────────────────
# A settles `keep`, so its work sits on `pe/A` and never reaches the trunk. B's
# `plan A:5` gate clears on A being verified, B forks from the trunk, and B
# builds on a tree that does not contain the thing it gated on. The gate half is
# phase 7's (the `landed`/`pr-merged` kinds and the ledger); the FREE half is
# saying so, because a gate that clears silently is what made this invisible.
@test "gate-status: a cleared cross-plan gate warns when the other plan's branch is not on trunk (S8-b)" {
  setup_docs linear otherplan
  setup_docs gatecheck xp
  cat > "$DOCS_ROOT/docs/plans/xp.md" <<'EOF'
---
slug: xp
created: 2026-01-01
status: active
phases: 1
handoffs: docs/handoffs/xp/
memory: project_xp
---
# xp
## Phase graph
| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | waitother | — | — | r | x |

### Phase 1 — waitother *(GATED)*
- **Gate-check:** plan otherplan:1
EOF
  write_handoff otherplan 1 alpha complete
  # A docs root that is a git repo, with otherplan's run branch unmerged.
  git -C "$DOCS_ROOT" init -q -b main
  git -C "$DOCS_ROOT" config user.email t@t.t; git -C "$DOCS_ROOT" config user.name t
  git -C "$DOCS_ROOT" add -A >/dev/null; git -C "$DOCS_ROOT" commit -qm base
  git -C "$DOCS_ROOT" checkout -q -b pe/otherplan
  echo work > "$DOCS_ROOT/work.txt"; git -C "$DOCS_ROOT" add work.txt; git -C "$DOCS_ROOT" commit -qm work
  git -C "$DOCS_ROOT" checkout -q main

  run pg xp --gate-status 1
  [ "$status" -eq 0 ]
  assert_contains "$output" "clear"
  assert_contains "$output" "advisory"
  assert_contains "$output" "pe/otherplan"
  assert_contains "$output" "main"
}

@test "gate-status: once the branch is on trunk the advisory stops (S8-b)" {
  setup_docs linear otherplan
  setup_docs gatecheck xp
  cat > "$DOCS_ROOT/docs/plans/xp.md" <<'EOF'
---
slug: xp
created: 2026-01-01
status: active
phases: 1
handoffs: docs/handoffs/xp/
memory: project_xp
---
# xp
## Phase graph
| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | waitother | — | — | r | x |

### Phase 1 — waitother *(GATED)*
- **Gate-check:** plan otherplan:1
EOF
  write_handoff otherplan 1 alpha complete
  git -C "$DOCS_ROOT" init -q -b main
  git -C "$DOCS_ROOT" config user.email t@t.t; git -C "$DOCS_ROOT" config user.name t
  git -C "$DOCS_ROOT" add -A >/dev/null; git -C "$DOCS_ROOT" commit -qm base
  git -C "$DOCS_ROOT" branch pe/otherplan     # merged by construction: same commit

  run pg xp --gate-status 1
  [ "$status" -eq 0 ]
  refute_contains "$output" "advisory"
}

@test "gate-status: no branch, no git, no advisory — silence is not a claim (S8-b)" {
  setup_docs linear otherplan
  setup_docs gatecheck xp
  cat > "$DOCS_ROOT/docs/plans/xp.md" <<'EOF'
---
slug: xp
created: 2026-01-01
status: active
phases: 1
handoffs: docs/handoffs/xp/
memory: project_xp
---
# xp
## Phase graph
| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | waitother | — | — | r | x |

### Phase 1 — waitother *(GATED)*
- **Gate-check:** plan otherplan:1
EOF
  write_handoff otherplan 1 alpha complete
  run pg xp --gate-status 1
  [ "$status" -eq 0 ]
  refute_contains "$output" "advisory"
}
