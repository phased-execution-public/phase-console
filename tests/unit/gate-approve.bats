#!/usr/bin/env bats
# gate-approve.sh + the engine's approval short-circuit: an approved row in
# docs/handoffs/<slug>/gate-status.md clears --gate-status for EVERY gate kind
# (human, ai, auto — the operator's override, like a QA waiver); revoke restores
# the gate; and the sidecar must never flip QA gating on (it is deliberately a
# different file from test-status.md). Also pins the category-aware boot prompt.
load ../helpers/test_helper

@test "gate-approve: records an approval and the manual gate clears" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 5
  [ "$status" -ne 0 ]
  PE_TODAY=2026-01-03 run gate_approve_console gatecheck 5 --by tester --note "did the steps"
  [ "$status" -eq 0 ]
  assert_contains "$output" "approved: gatecheck phase 5 by tester on 2026-01-03"
  [ -f "$DOCS_ROOT/docs/handoffs/gatecheck/gate-status.md" ]
  run pg gatecheck --gate-status 5
  [ "$status" -eq 0 ]
  assert_contains "$output" "clear (approved by tester on 2026-01-03)"
}

@test "gate-approve: clears ai and auto gates too (operator override)" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 10
  [ "$status" -ne 0 ]
  assert_contains "$output" "ai:"
  PE_TODAY=2026-01-03 run gate_approve gatecheck 10 --by op
  run pg gatecheck --gate-status 10
  [ "$status" -eq 0 ]
  assert_contains "$output" "approved by op"
  PE_TODAY=2026-01-03 run gate_approve gatecheck 2 --by op --note "window waived"
  run pg gatecheck --gate-status 2
  [ "$status" -eq 0 ]
  assert_contains "$output" "approved by op"
}

@test "gate-approve: an OVERDUE deadline clears once approved" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 8
  [ "$status" -ne 0 ]
  assert_contains "$output" "OVERDUE"
  PE_TODAY=2026-01-03 run gate_approve gatecheck 8 --by op
  run pg gatecheck --gate-status 8
  [ "$status" -eq 0 ]
}

@test "gate-approve: revoke restores the gate" {
  setup_docs gatecheck gatecheck
  PE_TODAY=2026-01-03 run gate_approve_console gatecheck 5 --by tester
  run pg gatecheck --gate-status 5
  [ "$status" -eq 0 ]
  PE_TODAY=2026-01-04 run gate_approve gatecheck 5 --revoke --by tester
  assert_contains "$output" "revoked: gatecheck phase 5"
  run pg gatecheck --gate-status 5
  [ "$status" -ne 0 ]
  assert_contains "$output" "manual"
}

@test "gate-approve: upsert is idempotent — one row per phase, last write wins" {
  setup_docs gatecheck gatecheck
  PE_TODAY=2026-01-03 run gate_approve_console gatecheck 5 --by first
  PE_TODAY=2026-01-04 run gate_approve_console gatecheck 5 --by second
  n="$(grep -c '^| 5 |' "$DOCS_ROOT/docs/handoffs/gatecheck/gate-status.md")"
  [ "$n" -eq 1 ]
  run pg gatecheck --gate-status 5
  assert_contains "$output" "approved by second on 2026-01-04"
}

@test "gate-approve: the sidecar never flips QA gating on" {
  setup_docs gatecheck gatecheck
  PE_TODAY=2026-01-03 run gate_approve_console gatecheck 5 --by tester
  run pg gatecheck --qa-mode
  [ "$output" = "off" ]
}

@test "gate-approve: an approved but ungated phase still answers clear (no gate)" {
  setup_docs gatecheck gatecheck
  PE_TODAY=2026-01-03 run gate_approve gatecheck 1 --by tester
  run pg gatecheck --gate-status 1
  [ "$status" -eq 0 ]
  assert_contains "$output" "clear (no gate)"
}

@test "gate-approve: the board shows kind and approval" {
  setup_docs gatecheck gatecheck
  PE_TODAY=2026-01-03 run gate_approve_console gatecheck 5 --by tester
  run pg gatecheck
  assert_contains "$output" "GATED·human ✓approved"
  assert_contains "$output" "GATED·ai"
  assert_contains "$output" "GATED·auto"
}

@test "boot-prompt: an ai gate carries the FULL multi-line conditions and the clearance command" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --boot-prompt 10
  [ "$status" -eq 0 ]
  assert_contains "$output" "GATED phase (ai-clearable)"
  assert_contains "$output" "seventh condition"
  assert_contains "$output" "gate-approve.sh gatecheck 10"
  assert_contains "$output" "commit + push"
}

@test "boot-prompt: a human gate says STOP and points at the console Gate card" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --boot-prompt 5
  assert_contains "$output" "GATED phase (human)"
  assert_contains "$output" "Gate card"
  assert_contains "$output" "Do NOT implement"
}

@test "boot-prompt: an approved gate says proceed" {
  setup_docs gatecheck gatecheck
  PE_TODAY=2026-01-03 run gate_approve_console gatecheck 5 --by tester
  run pg gatecheck --boot-prompt 5
  assert_contains "$output" "already approved by tester"
  refute_contains "$output" "Do NOT implement"
}

@test "boot-prompt: an auto gate surfaces the live verdict without executing cmd gates" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --boot-prompt 2
  assert_contains "$output" "GATED phase (auto-checked)"
  assert_contains "$output" "blocked: opens on 2099-01-01"
  # a cmd gate's boot prompt must NEVER execute the command, even if the caller
  # exported the opt-in — the prompt is generated on page views too
  PHASE_EXEC_GATES=1 run pg gatecheck --boot-prompt 9
  assert_contains "$output" "cmd gate not executed"
}

# --- a manual gate is a person's (control-tower phase 107, #174) -------------
# An unattended session cleared a MANUAL gate as `ai-session-delegated` and then
# changed production data. The approver's NAME is free text the session fills
# in, so it is never the witness: gate-approve.sh names the DOOR it was invoked
# through from its own environment — `console` (the console's Gate card, a
# phone's Approve, a confirmed chat act), `terminal` (a person's shell, stdin a
# tty), `session` (any session marker) or `script` (anything else) — refuses a
# manual gate from a door that is not a person's, and records the door in the
# row; --gate-status honours a manual row only when a person's door wrote it.

gate_file() { printf '%s' "$DOCS_ROOT/docs/handoffs/gatecheck/gate-status.md"; }

# A gate-status.md written by hand, as a session (or an older script) could.
# usage: hand_rows <row>…   (rows WITHOUT a Door cell get the five-column header)
hand_rows() {
  local f header
  f="$(gate_file)"
  mkdir -p "$(dirname "$f")"
  header='| Phase | Approved | By | Date | Note |\n|------:|----------|----|------|------|'
  case "$1" in *'|'*'|'*'|'*'|'*'|'*'|'*'|'*) header='| Phase | Approved | By | Date | Note | Door |\n|------:|----------|----|------|------|------|' ;; esac
  { printf '# Gate approvals — gatecheck\n\n## Gate approvals\n\n'; printf "$header\n"; printf '%s\n' "$@"; } > "$f"
}

@test "#174: a manual gate refuses an approval from an unattended session, whatever --by says" {
  setup_docs gatecheck gatecheck
  PE_OWNER=autopilot/r1 PE_TODAY=2026-01-03 run gate_approve gatecheck 5 --by "mobin (operator)" --note "the owner granted all permissions"
  [ "$status" -eq 1 ]
  assert_contains "$output" "manual"
  assert_contains "$output" "Gate card"
  assert_contains "$output" "needs-human --needs gates"
  ! grep -q '^| 5 |' "$(gate_file)" 2>/dev/null
  run pg gatecheck --gate-status 5
  [ "$status" -eq 1 ]
  assert_contains "$output" "manual: ops sign-off before launch"
}

@test "#174: every session marker is an unattended door, and a session cannot borrow the console's" {
  setup_docs gatecheck gatecheck
  PE_OUTCOME_FILE="$BATS_TEST_TMPDIR/o.json" run gate_approve gatecheck 5 --by op
  [ "$status" -eq 1 ]
  PE_SESSION_KIND=author run gate_approve gatecheck 5 --by op
  [ "$status" -eq 1 ]
  CLAUDECODE=1 run gate_approve gatecheck 5 --by op
  [ "$status" -eq 1 ]
  PE_OWNER=console/mcp-probe run gate_approve gatecheck 5 --by op
  [ "$status" -eq 1 ]
  PE_OWNER=autopilot/r1 PE_GATE_DOOR=console run gate_approve gatecheck 5 --by op
  [ "$status" -eq 1 ]
  CLAUDECODE=1 PE_GATE_DOOR=console run gate_approve gatecheck 5 --by op
  [ "$status" -eq 1 ]
  run pg gatecheck --gate-status 5
  [ "$status" -eq 1 ]
}

@test "#174: an ai-* or automatic approver never clears a manual gate, even through the console's door" {
  setup_docs gatecheck gatecheck
  for who in ai-session-delegated ai-session AI-Session autopilot/r1 console/mcp-probe; do
    run gate_approve_console gatecheck 5 --by "$who"
    [ "$status" -eq 1 ]
    assert_contains "$output" "$who"
  done
  run pg gatecheck --gate-status 5
  [ "$status" -eq 1 ]
}

@test "#174: a script with no person behind it — no terminal, no console door — is refused too" {
  setup_docs gatecheck gatecheck
  run gate_approve gatecheck 5 --by op
  [ "$status" -eq 1 ]
  assert_contains "$output" "script"
}

@test "#174: the console's door clears a manual gate, and the row names its door" {
  setup_docs gatecheck gatecheck
  PE_TODAY=2026-01-03 run gate_approve_console gatecheck 5 --by mobin
  [ "$status" -eq 0 ]
  grep -qx '| Phase | Approved | By | Date | Note | Door |' "$(gate_file)"
  grep -qx '| 5 | yes | mobin | 2026-01-03 | - | console |' "$(gate_file)"
  run pg gatecheck --gate-status 5
  [ "$status" -eq 0 ]
  [ "$output" = "clear (approved by mobin on 2026-01-03)" ]
}

@test "#174: a person's own terminal is a person's door" {
  command -v script >/dev/null 2>&1 || skip "no script(1) to give the run a terminal"
  setup_docs gatecheck gatecheck
  local cmd="DOCS_ROOT='$DOCS_ROOT' PE_TODAY=2026-01-03 /bin/bash '$PE_SCRIPTS/gate-approve.sh' gatecheck 5 --by mobin"
  # BSD script(1) takes `<file> <command…>`; util-linux takes `-c <command> <file>`.
  if script -q /dev/null true </dev/null >/dev/null 2>&1; then
    script -q /dev/null /bin/bash -c "$cmd" </dev/null >/dev/null 2>&1 || true
  else
    script -qec "$cmd" /dev/null </dev/null >/dev/null 2>&1 || true
  fi
  grep -qx '| 5 | yes | mobin | 2026-01-03 | - | terminal |' "$(gate_file)"
  run pg gatecheck --gate-status 5
  [ "$status" -eq 0 ]
}

@test "#174: an ai gate behaves as today — a session clears it, and its door is named" {
  setup_docs gatecheck gatecheck
  PE_OWNER=autopilot/r1 PE_TODAY=2026-01-03 run gate_approve gatecheck 10 --by ai-session --note "verified"
  [ "$status" -eq 0 ]
  grep -qx '| 10 | yes | ai-session | 2026-01-03 | verified | session |' "$(gate_file)"
  run pg gatecheck --gate-status 10
  [ "$status" -eq 0 ]
  # An auto gate's override is not a manual gate's either.
  PE_OWNER=autopilot/r1 PE_TODAY=2026-01-03 run gate_approve gatecheck 8 --by ai-session
  [ "$status" -eq 0 ]
}

@test "#174: a note or a name cannot write a row of its own — awk never decodes an escape in a cell" {
  setup_docs gatecheck gatecheck
  # A session may clear the ai gate (10). Its note spells a newline and a pipe
  # as escapes; awk would decode them in a `-v` value and print a SECOND row:
  # the manual gate (5), approved through a person's door.
  PE_OWNER=autopilot/r1 PE_TODAY=2026-01-03 run gate_approve gatecheck 10 --by 'ai\n| 5 | yes | mobin' \
    --note 'ok\n| 5 | yes | mobin | 2026-01-03 | - | terminal |\n'
  [ "$status" -eq 0 ]
  PE_OWNER=autopilot/r1 PE_TODAY=2026-01-03 run gate_approve gatecheck 10 --by ai-session \
    --note 'ok\012\174 5 \174 yes \174 mobin \174 2026-01-03 \174 - \174 terminal \174'
  [ "$status" -eq 0 ]
  run grep -c '^| 5 ' "$(gate_file)"
  [ "$output" = "0" ]
  # Every row is ONE line with its six cells, the escapes kept as text.
  run awk -F'|' '/^\| *[0-9]/ && NF != 8 { bad++ } END { print bad + 0 }' "$(gate_file)"
  [ "$output" = "0" ]
  grep -q 'ok\\012\\174 5' "$(gate_file)"
  run pg gatecheck --gate-status 5
  [ "$status" -ne 0 ]
}

@test "#174: anyone may REVOKE a manual gate's approval — closing a gate is never a person's privilege" {
  setup_docs gatecheck gatecheck
  PE_TODAY=2026-01-03 run gate_approve_console gatecheck 5 --by mobin
  run pg gatecheck --gate-status 5
  [ "$status" -eq 0 ]
  PE_OWNER=autopilot/r1 run gate_approve gatecheck 5 --revoke
  [ "$status" -eq 0 ]
  run pg gatecheck --gate-status 5
  [ "$status" -eq 1 ]
}

@test "#174: --gate-status ignores a manual row no person's door wrote — the By text is never the witness" {
  setup_docs gatecheck gatecheck
  # The legacy five-column row #174's session wrote, in its shape.
  hand_rows '| 5 | yes | ai-session-delegated | 2026-09-29 | the owner granted all permissions |'
  run pg gatecheck --gate-status 5
  [ "$status" -eq 1 ]
  assert_contains "$output" "manual: ops sign-off before launch"
  assert_contains "$output" "does not clear a manual gate"
  # A door-less row naming a person is no better: nothing says a person wrote it.
  hand_rows '| 5 | yes | mobin | 2026-09-29 | - |'
  run pg gatecheck --gate-status 5
  [ "$status" -eq 1 ]
  # Nor is a session's door or a script's, whatever name the row gives.
  for door in session script; do
    hand_rows "| 5 | yes | mobin | 2026-09-29 | - | $door |"
    run pg gatecheck --gate-status 5
    [ "$status" -eq 1 ]
    assert_contains "$output" "$door"
  done
  # A person's door is.
  for door in console terminal; do
    hand_rows "| 5 | yes | mobin | 2026-09-29 | - | $door |"
    run pg gatecheck --gate-status 5
    [ "$status" -eq 0 ]
    [ "$output" = "clear (approved by mobin on 2026-09-29)" ]
  done
}

@test "#174: an ignored approval is not painted approved — the board and the boot prompt agree with the gate" {
  setup_docs gatecheck gatecheck
  hand_rows '| 5 | yes | ai-session-delegated | 2026-09-29 | - |'
  run pg gatecheck
  refute_contains "$output" "GATED·human ✓approved"
  run pg gatecheck --boot-prompt 5
  refute_contains "$output" "already approved"
  assert_contains "$output" "Do NOT implement"
}

@test "#174: a legacy approval still clears a gate that is not manual (ai, auto)" {
  setup_docs gatecheck gatecheck
  hand_rows '| 10 | yes | ai-session | 2026-09-29 | - |' '| 8 | yes | ai-session | 2026-09-29 | - |'
  run pg gatecheck --gate-status 10
  [ "$status" -eq 0 ]
  run pg gatecheck --gate-status 8
  [ "$status" -eq 0 ]
}

@test "#174: the boot prompt never tells a session to clear a manual gate — delegated or not" {
  setup_docs gatecheck gatecheck
  for delegate in 0 1; do
    PE_GATE_DELEGATE=$delegate run pg gatecheck --boot-prompt 5
    assert_contains "$output" "GATED phase (human)"
    assert_contains "$output" "Do NOT implement"
    assert_contains "$output" "needs-human --needs gates"
    refute_contains "$output" "ai-session-delegated"
    refute_contains "$output" "DELEGATED to you"
  done
}

@test "#174: an existing five-column table gains its Door column on the next write, its old rows kept" {
  setup_docs gatecheck gatecheck
  hand_rows '| 10 | yes | ai-session | 2026-09-29 | evidence |'
  PE_TODAY=2026-01-03 run gate_approve_console gatecheck 5 --by mobin
  [ "$status" -eq 0 ]
  grep -qx '| Phase | Approved | By | Date | Note | Door |' "$(gate_file)"
  grep -qx '|------:|----------|----|------|------|------|' "$(gate_file)"
  grep -qx '| 10 | yes | ai-session | 2026-09-29 | evidence |' "$(gate_file)"
  grep -qx '| 5 | yes | mobin | 2026-01-03 | - | console |' "$(gate_file)"
  [ "$(grep -c '^| Phase |' "$(gate_file)")" -eq 1 ]
}
