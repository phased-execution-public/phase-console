#!/usr/bin/env bats
# F14 — a phase without a runnable §Verification FAILS the lint (a gate since
# 5.0.0, `verification-empty-open`; it warned before). The autopilot parks such
# a phase at boarding ("nothing would prove the work") hours after plan time,
# and the sep-review audit (ZTD-6) found a prose-only verification card asking a
# person for twelve hours after the phase was paid for — so the author hears it
# as a red exit while the plan is still in front of them. Done phases and closed
# plans keep their history unjudged.
load ../helpers/test_helper

@test "F14: an open phase with no Verification bullet is named, and the lint FAILS" {
  setup_docs nested-verification nestedv
  run pg nestedv --lint
  [ "$status" -ne 0 ]
  assert_contains "$output" "LINT FAIL"
  assert_contains "$output" "phase 3: verification-empty-open"
}

@test "F14: nested sub-bullet verification counts as runnable" {
  setup_docs nested-verification nestedv
  run pg nestedv --lint
  [[ "$output" != *"phase 1: verification-empty-open"* ]]
  [[ "$output" != *"phase 2: verification-empty-open"* ]]
}

@test "F14: a done phase is not judged about history — the same plan lints OK" {
  setup_docs nested-verification nestedv
  write_handoff nestedv 3 bare complete
  run pg nestedv --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
  [[ "$output" != *"verification-empty-open"* ]]
}

@test "F14: a plan whose every phase verifies stays silent" {
  setup_docs scoped scoped
  run pg scoped --lint
  [ "$status" -eq 0 ]
  [[ "$output" != *"verification-empty-open"* ]]
}

@test "F14: validate.sh fails on it, naming the check" {
  setup_docs nested-verification nestedv
  run pe_validate nestedv
  [ "$status" -ne 0 ]
  assert_contains "$output" "phase 3: verification-empty-open"
  [[ "$output" != *"VALIDATE OK"* ]]
}

@test "F14: a closed plan is noted, not gated" {
  setup_docs closed closedp
  run pg closedp --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK (closed)"
}

@test "F14: every shape of an empty §Verification is named — numbers only, no bullet, prose only" {
  setup_docs bad-empty-verification-open bev
  run pg bev --lint
  [ "$status" -ne 0 ]
  assert_contains "$output" "phase 1: verification-empty-open"
  assert_contains "$output" "phase 2: verification-empty-open"
  assert_contains "$output" "phase 3: verification-empty-open"
  [[ "$output" != *"phase 4: verification-empty-open"* ]]
  assert_contains "$output" "LINT FAIL: bev (3 issue[s])"
}

# F16 — a §Verification that waits on an external clock warns at lint time,
# never gates. F14 asks "is anything runnable?"; F16 asks "does what runs ever
# finish on its own?". The live incident: a phase whose verification WAS the
# deploy of a CI-built image (34-65 min build) passed F14, boarded, and the
# session died holding the wait.

@test "F16: a fenced 'gh run watch' and a bulleted 'task deploy' are named, exit stays 0" {
  setup_docs unbounded-verification unb
  run pg unb --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
  assert_contains "$output" "F16 phase 2"
  assert_contains "$output" "gh run watch"
  assert_contains "$output" "F16 phase 3"
  assert_contains "$output" "task deploy"
}

@test "F16: a bounded verification stays silent" {
  setup_docs unbounded-verification unb
  run pg unb --lint
  [[ "$output" != *"F16 phase 1"* ]]
}

@test "F16: runnable-but-unbounded does not trip F14" {
  setup_docs unbounded-verification unb
  run pg unb --lint
  [[ "$output" != *"verification-empty-open"* ]]
}

@test "F16: a done phase is not nagged about history" {
  setup_docs unbounded-verification unb
  write_handoff unb 2 watch complete
  write_handoff unb 3 deploy complete
  run pg unb --lint
  [ "$status" -eq 0 ]
  [[ "$output" != *"F16"* ]]
}

# F16's vocabulary is not its own. It is EXTERNAL_WAIT in scripts/verify.env,
# shared with the console's runtime detector (viewer/server/runner/liveness.ts)
# so that what the lint warns about at plan time is what gets parked at run
# time. These two pin the seam from the bash side; the JS side is pinned by
# viewer/test/verify-env.test.ts, which runs BOTH engines over the same inputs.

@test "F16: the vocabulary is EXTERNAL_WAIT from scripts/verify.env, not a local copy" {
  run "$SYS_BASH" -c '. "$1/verify.env"; printf "%s" "$EXTERNAL_WAIT"' _ "$PE_SCRIPTS"
  [ "$status" -eq 0 ]
  assert_contains "$output" "gh run watch"
  assert_contains "$output" "task deploy"
  # The dialect-neutrality contract: one string drives a POSIX ERE here and a
  # JS RegExp in the runner, so a POSIX character class would break the half
  # that cannot be seen from bash.
  [[ "$output" != *"[:"* ]]
}

@test "F16: a tab-indented external wait is still caught (whitespace is normalised)" {
  # The shared vocabulary spells the space before `--watch` literally, because
  # JS has no `[[:space:]]`. That is only equivalent if the bash side
  # normalises tabs first — which is exactly the sort of claim that rots.
  setup_docs unbounded-verification unb
  # Phase 1 is the fixture's BOUNDED phase (test 8 pins that it stays silent),
  # so a hit here can only have come from the tab.
  # `task ci<TAB>--watch` is reachable ONLY through the ` --watch` alternative:
  # it is not `task deploy`, and it carries no `gh pr checks` prefix whose own
  # `[^\`]*` span would swallow the tab and pass for the wrong reason.
  local plan="$DOCS_ROOT/docs/plans/unb.md"
  "$SYS_BASH" -c 'printf "%s\n" "$(sed "s|^  - .npm test.$|  - \`task ci\t--watch\`|" "$1")" > "$1"' _ "$plan"
  grep -q "$(printf 'task ci\t--watch')" "$plan" || fail "the fixture edit did not land a tab"
  run pg unb --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "F16 phase 1"
}

# The narrowed loop arms (control-tower phase 47, #52). A `while [ … ]` or
# `until …` loop used to be a wait by shape alone, so a counter that waits on
# nothing — twenty `printf`s in a throwaway container — was refused in a
# session and would be warned about here. A loop is a wait only when it holds
# a clock (a sleep, a timed read, a `wait`, a network verb), and it cannot
# borrow one from a statement after its own `done`: both readers split there.
@test "F16: a counter loop with no clock stays silent; the same loop with a sleep is named" {
  setup_docs bounded-loops bl
  run pg bl --lint
  [ "$status" -eq 0 ]
  [[ "$output" != *"F16 phase 1"* ]]
  assert_contains "$output" "F16 phase 2"
}

@test "F16: a loop does not borrow a sleep from after its own done" {
  setup_docs bounded-loops bl
  run pg bl --lint
  [[ "$output" != *"F16 phase 3"* ]]
}

@test "F16: a loop whose clock is a remote verb is a wait with no sleep in it" {
  setup_docs bounded-loops bl
  run pg bl --lint
  assert_contains "$output" "F16 phase 4"
}

@test "F16: the reader is external_wait_hit from scripts/verify.env, the one JS mirrors" {
  run "$SYS_BASH" -c '. "$1/verify.env"; printf "%s" "until curl -sf localhost:1; do sleep 2; done; echo ok" | external_wait_hit' _ "$PE_SCRIPTS"
  [ "$status" -eq 0 ]
  assert_contains "$output" "until"
  run "$SYS_BASH" -c '. "$1/verify.env"; printf "%s" "while [ \$i -lt 3 ]; do i=\$((i+1)); done; sleep 3" | external_wait_hit' _ "$PE_SCRIPTS"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

# F45 `proof-unparsable` and F46 `proof-script-run-branch-only` (one-pool phase
# 13, #345 #374) — both ADVISORY. F45: a Human step's proof the console's check
# reader would refuse every time. F46: a cmd: proof whose script is not on its
# repository's trunk, so the console's checkout exits 127 on it.

proof_docs() {
  setup_docs guided guided
  mkdir -p "$DOCS_ROOT/docs/guides"
  printf 'Why it matters.\n\n## Steps\n1. Rotate it.\n' > "$DOCS_ROOT/docs/guides/rotate-key.md"
}

@test "F45: an unclosed quote, a shell variable, a relative path and an unknown scheme are named; the lint stays OK" {
  proof_docs
  {
    printf -- '- **Human step:** browser-login · sign one in · proof: `cmd:"grep -q x '"'"'/a/b"` · why: identity\n'
    printf -- '- **Human step:** browser-login · sign two in · proof: `cmd:"test -f $HOME/x"` · why: identity\n'
    printf -- '- **Human step:** browser-login · sign three in · proof: `cmd:"bash scripts/vpn/status.sh --assert ok"` · why: identity\n'
    printf -- '- **Human step:** browser-login · sign four in · proof: `whenever it is done` · why: identity\n'
  } >> "$DOCS_ROOT/docs/plans/guided.md"
  run pg guided --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK: guided"
  assert_contains "$output" 'F45 phase 0: proof-unparsable — the browser-login step "sign one in" has a proof the console cannot read as written: its quoting does not balance'
  assert_contains "$output" 'F45 phase 0: proof-unparsable — the browser-login step "sign two in" has a proof the console cannot read as written: it carries a shell variable'
  assert_contains "$output" 'F45 phase 0: proof-unparsable — the browser-login step "sign three in" has a proof the console cannot read as written: it names a relative path (scripts/vpn/status.sh)'
  assert_contains "$output" 'F45 phase 0: proof-unparsable — the browser-login step "sign four in" has a proof the console cannot read as written: it names no watch scheme'
}

@test "F45: an escaped inner quote and a git ref read clean (#345, #350)" {
  proof_docs
  {
    printf -- '%s\n' '- **Human step:** operator-act · resolve the host (E-4) · proof: `cmd:"python3 -c \"import socket;socket.gethostbyname('"'"'mt.example.com'"'"')\""` · why: reach'
    printf -- '%s\n' '- **Human step:** operator-act · delete the branch (E-7) · proof: `cmd:"git -C /tmp show-ref --verify --quiet refs/heads/pe/x && exit 1 || exit 0"` · why: reach'
  } >> "$DOCS_ROOT/docs/plans/guided.md"
  run pg guided --lint
  [ "$status" -eq 0 ]
  [[ "$output" != *"F45"* ]]
}

@test "F46: a proof script that exists only on a run branch is named with its trunk; one on main is quiet" {
  proof_docs
  local repo="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$repo/scripts/vpn"
  git -C "$repo" init -q -b main
  git -C "$repo" config user.email t@example.com && git -C "$repo" config user.name t
  printf '#!/bin/sh\nexit 0\n' > "$repo/scripts/landed.sh"
  git -C "$repo" add scripts/landed.sh && git -C "$repo" commit -qm landed
  git -C "$repo" checkout -qb pe/run
  printf '#!/bin/sh\nexit 0\n' > "$repo/scripts/vpn/status.sh"
  git -C "$repo" add scripts/vpn/status.sh && git -C "$repo" commit -qm run-only
  {
    printf -- '- **Human step:** operator-act · approve the exit node (E-3) · proof: `cmd:"bash %s/scripts/vpn/status.sh --assert ok"` · why: reach\n' "$repo"
    printf -- '- **Human step:** operator-act · approve the landed one (E-6) · proof: `cmd:"bash %s/scripts/landed.sh"` · why: reach\n' "$repo"
    printf -- '- **Human step:** operator-act · approve the missing one (E-8) · proof: `cmd:"%s/scripts/nowhere.sh"` · why: reach\n' "$repo"
  } >> "$DOCS_ROOT/docs/plans/guided.md"
  run pg guided --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "F46 phase 0: proof-script-run-branch-only — the operator-act step \"approve the exit node (E-3)\" proves itself with $repo/scripts/vpn/status.sh, which is not on main (it exists only on another branch)"
  assert_contains "$output" "F46 phase 0: proof-script-run-branch-only — the operator-act step \"approve the missing one (E-8)\" proves itself with $repo/scripts/nowhere.sh, which is on neither this checkout nor main"
  [[ "$output" != *'F46 phase 0: proof-script-run-branch-only — the operator-act step "approve the landed one'* ]]
}
