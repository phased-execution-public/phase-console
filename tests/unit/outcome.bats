#!/usr/bin/env bats
# phase-outcome.sh — the machine-readable session outcome. Born from a live run:
# a phase-8 session that had done real work ended its turn "waiting on the image
# build (34-65 min)" in free prose, the runner read the clean exit as completion,
# found no handoff, and halted the run. The outcome file is the record the
# runner reads instead of guessing; these tests pin the exact JSON (the runner's
# parser and the journal both consume it verbatim).
# (One of five files since measured-console phase 7; the shared setup is tests/helpers/outcome_helper.bash.)
load ../helpers/test_helper
load ../helpers/outcome_helper

@test "outcome: waiting-external writes the exact JSON, atomically" {
  run pe_outcome demo 8 waiting-external --reason "img build" --watch "gh:x#run/1" --until 2026-08-10T21:40:00Z
  [ "$status" -eq 0 ]
  assert_contains "$output" "outcome recorded: demo phase 8 = waiting-external"
  expected='{
  "version": 1,
  "slug": "demo",
  "phase": 8,
  "status": "waiting-external",
  "reason": "img build",
  "resume_after": "2026-08-10T21:40:00Z",
  "watch": ["gh:x#run/1"],
  "written_at": "2026-08-10T21:10:03Z"
}'
  [ "$(cat "$PE_OUTCOME_FILE")" = "$expected" ]
  # tmp+mv: no temp residue beside the target.
  [ -z "$(ls "$BATS_TEST_TMPDIR"/outcome.json.tmp.* 2>/dev/null || true)" ]
}

@test "outcome: complete with no options omits reason/resume_after and keeps an empty watch" {
  run pe_outcome demo 3 complete
  [ "$status" -eq 0 ]
  expected='{
  "version": 1,
  "slug": "demo",
  "phase": 3,
  "status": "complete",
  "watch": [],
  "written_at": "2026-08-10T21:10:03Z"
}'
  [ "$(cat "$PE_OUTCOME_FILE")" = "$expected" ]
}

@test "outcome: --watch is repeatable and ordered" {
  run pe_outcome demo 8 waiting-external --watch a --watch b --watch "c d"
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_OUTCOME_FILE")" '"watch": ["a", "b", "c d"],'
}

@test "outcome: a --watch ref no scheme can poll is warned about at write time, and still recorded (WAI-11)" {
  run pe_outcome demo 8 waiting-external --reason "soak" --watch "gh:acme/app#run/42" \
    --watch "config/fleet-pin.yaml:app-prod" --watch "date:soon" --wait-minutes 30
  [ "$status" -eq 0 ]
  assert_contains "$output" 'warning: --watch "config/fleet-pin.yaml:app-prod" will never be checked: no watch scheme'
  assert_contains "$output" 'warning: --watch "date:soon" will never be checked: not an ISO8601 instant'
  [[ "$output" != *'warning: --watch "gh:acme/app#run/42"'* ]]
  grep -q '"watch": \["gh:acme/app#run/42", "config/fleet-pin.yaml:app-prod", "date:soon"\]' "$PE_OUTCOME_FILE"
}

@test "outcome: a --watch on the declaring phase's OWN lock is refused with the console's sentence, and nothing is written (#42)" {
  run pe_outcome demo 8 blocked --needs lock --reason "lock held by me" --watch "lock:demo/08"
  [ "$status" -eq 2 ]
  assert_contains "$output" "--watch lock:demo/08 refused: a lock: watch is for somebody else's lock"
  assert_contains "$output" "a phase blocked on a person takes no watch at all."
  [ ! -f "$PE_OUTCOME_FILE" ]
  run pe_outcome demo 8 waiting-external --reason "soak" --watch "lock: demo/8 "
  [ "$status" -eq 2 ]
  [ ! -f "$PE_OUTCOME_FILE" ]
}

@test "outcome: a --watch on ANOTHER phase's lock is the lock wait it always was (#42)" {
  run pe_outcome demo 8 blocked --needs lock --reason "lock held by someone/else" --watch "lock:demo/3" --watch "lock:other-plan/8"
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_OUTCOME_FILE")" '"watch": ["lock:demo/3", "lock:other-plan/8"],'
}

@test "outcome: reason newlines and quotes are sanitised for JSON" {
  reason="$(printf 'line one\nline "two"')"
  run pe_outcome demo 8 blocked --needs credential --reason "$reason"
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_OUTCOME_FILE")" '"reason": "line one line \"two\"",'
}

# --needs (zero-touch-console P3, chapter 10 ZTD-3): the decision key a blocked
# or needs-human declaration is missing — required there, refused elsewhere,
# validated against scripts/decisions.env, and carried on the wire as "needs"
# so the runner reads it BEFORE the prose.
@test "outcome: blocked without --needs exits 2 and writes nothing" {
  run pe_outcome demo 8 blocked --reason "the deploy needs the SSH key"
  [ "$status" -eq 2 ]
  assert_contains "$output" "--needs <key> is required on blocked"
  [ ! -f "$PE_OUTCOME_FILE" ]
  run pe_outcome demo 8 needs-human --reason "a person must sign"
  [ "$status" -eq 2 ]
  [ ! -f "$PE_OUTCOME_FILE" ]
}

@test "outcome: --needs credential rides the JSON as needs, with the optional rule and command" {
  run pe_outcome demo 8 blocked --needs credential --reason "no SSH key" --rule 'Bash(ssh *)' --command "ssh deploy@box"
  [ "$status" -eq 0 ]
  expected='{
  "version": 1,
  "slug": "demo",
  "phase": 8,
  "status": "blocked",
  "reason": "no SSH key",
  "needs": "credential",
  "rule": "Bash(ssh *)",
  "command": "ssh deploy@box",
  "watch": [],
  "written_at": "2026-08-10T21:10:03Z"
}'
  [ "$(cat "$PE_OUTCOME_FILE")" = "$expected" ]
}

@test "outcome: --needs takes a decision key or a blocker class; anything else is exit 2" {
  for word in credentials permission.policy gates waits lock permission gate external; do
    run pe_outcome demo 8 blocked --needs "$word" --reason x
    [ "$status" -eq 0 ] || { echo "$word refused: $output"; return 1; }
    grep -q "\"needs\": \"$word\"" "$PE_OUTCOME_FILE"
    rm -f "$PE_OUTCOME_FILE"
  done
  run pe_outcome demo 8 blocked --needs unknown --reason x
  [ "$status" -eq 2 ]
  assert_contains "$output" "unknown --needs word: unknown"
  run pe_outcome demo 8 blocked --needs Credential --reason x
  [ "$status" -eq 2 ]
}

@test "outcome: --needs issues (#349) is a decision key on blocked and needs-human alike, written as its own word" {
  for word in blocked needs-human; do
    run pe_outcome demo 8 "$word" --needs issues --reason "may this run file the bug it found upstream?"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    grep -q '"needs": "issues"' "$PE_OUTCOME_FILE"
    rm -f "$PE_OUTCOME_FILE"
  done
}

@test "outcome: blocked --needs run --run-act writes ONE run request; an unknown act or a stray shape is exit 2" {
  # turn-by-turn phase 6 (#286): an act only the RUN can take is declared as a
  # run request, never as a permission ask nobody can grant.
  run pe_outcome demo 8 blocked --needs run --run-act isolate --reason "relaunch isolated"
  [ "$status" -eq 0 ]
  expected='{
  "version": 1,
  "slug": "demo",
  "phase": 8,
  "status": "blocked",
  "reason": "relaunch isolated",
  "needs": "run",
  "run_act": "isolate",
  "watch": [],
  "written_at": "2026-08-10T21:10:03Z"
}'
  [ "$(cat "$PE_OUTCOME_FILE")" = "$expected" ]
  rm -f "$PE_OUTCOME_FILE"
  # every act of the twin is accepted
  # shellcheck source=/dev/null
  . "$PE_SCRIPTS/turn.env"
  [ "$RUN_ACTS" = "isolate switch-account raise-budget stop hold" ]
  for act in $RUN_ACTS; do
    run pe_outcome demo 8 blocked --needs run --run-act "$act"
    [ "$status" -eq 0 ] || { echo "$act refused: $output"; return 1; }
    grep -q "\"run_act\": \"$act\"" "$PE_OUTCOME_FILE"
    rm -f "$PE_OUTCOME_FILE"
  done
  # an unknown act, a run request with no act, on the wrong status or need, or
  # beside a step, a rule or a command: exit 2, nothing written
  run pe_outcome demo 8 blocked --needs run --run-act relaunch
  [ "$status" -eq 2 ]
  assert_contains "$output" "unknown --run-act: relaunch"
  run pe_outcome demo 8 blocked --needs run
  [ "$status" -eq 2 ]
  assert_contains "$output" "--needs run needs --run-act <act>"
  run pe_outcome demo 8 needs-human --needs run --run-act stop
  [ "$status" -eq 2 ]
  run pe_outcome demo 8 blocked --needs permission --run-act isolate
  [ "$status" -eq 2 ]
  run pe_outcome demo 8 blocked --needs run --run-act isolate --rule 'Bash(x)'
  [ "$status" -eq 2 ]
  run pe_outcome demo 8 complete --run-act hold
  [ "$status" -eq 2 ]
  run pe_outcome demo 8 ruling --what "chose A" --run-act hold
  [ "$status" -eq 2 ]
  [ ! -f "$PE_OUTCOME_FILE" ]
}

@test "outcome: a bare --act still means --step operator-act, never a run request" {
  run pe_outcome demo 8 needs-human --needs human-acts --act --title "Restart the build box" --open-command "ssh box sudo reboot" --proof 'date:2026-08-11T00:00:00Z'
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  grep -q '"kind": "operator-act"' "$PE_OUTCOME_FILE"
  ! grep -q '"run_act"' "$PE_OUTCOME_FILE"
  rm -f "$PE_OUTCOME_FILE"
  run pe_outcome demo 8 blocked --needs run --run-act isolate --act
  [ "$status" -eq 2 ]
  [ ! -f "$PE_OUTCOME_FILE" ]
}

@test "outcome: --needs/--rule/--command are refused on a status that does not ask, and on a ruling" {
  run pe_outcome demo 8 complete --needs gates
  [ "$status" -eq 2 ]
  assert_contains "$output" "only make sense with blocked or needs-human"
  run pe_outcome demo 8 waiting-external --rule "x" --until 2026-08-10T21:40:00Z
  [ "$status" -eq 2 ]
  # A ruling takes a decision KEY (stamped as decisionKey) — never a blocker
  # short form, and never --rule/--command.
  run pe_outcome demo 8 ruling --what "chose A" --needs gates
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_RULINGS_FILE")" '"decisionKey":"gates"'
  run pe_outcome demo 8 ruling --what "chose A" --needs lock
  [ "$status" -eq 2 ]
  assert_contains "$output" "unknown --needs key on a ruling: lock"
  run pe_outcome demo 8 ruling --what "chose A" --rule "Bash(git push:*)"
  [ "$status" -eq 2 ]
  [ ! -f "$PE_OUTCOME_FILE" ]
}

@test "outcome: the --needs vocabulary is the one scripts/decisions.env carries" {
  # shellcheck source=/dev/null
  . "$PE_SCRIPTS/decisions.env"
  # 18 since 5.1.0 — phase 2 added `issues` and this count was the one reader it
  # did not reach (it is not in that phase's §Verification list; it is in this
  # one's). The assertion is a count on purpose: `decisions-model.test.ts` holds
  # bash and JS to the same MEMBERS, and this holds the shell half to the number,
  # so a key added to one language alone fails on both sides.
  [ "$(printf '%s' "$DECISION_KEYS" | wc -w | tr -d ' ')" = "19" ]
  run pe_outcome demo 8 blocked --needs "${DECISION_KEYS##* }" --reason x
  [ "$status" -eq 0 ]
}

# ---- measured-console phase 12 ------------------------------------------------

@test "outcome: --resumed-with prints the answer, declares nothing and exits 0 — whatever the call's other flags (B2)" {
  run pe_outcome demo 8 needs-human --needs credential --step browser-login --title "Sign in" --resumed-with "gh is signed in"
  [ "$status" -eq 0 ]
  assert_contains "$output" "resumed: the person's step for demo phase 8 is done — gh is signed in"
  assert_contains "$output" "nothing was declared"
  [ ! -e "$PE_OUTCOME_FILE" ]
  run pe_outcome demo 8 needs-human --resumed-with
  [ "$status" -eq 2 ]
  [ ! -e "$PE_OUTCOME_FILE" ]
}

@test "outcome: partial warns, naming each scope tree ahead of origin/<branch> with the count; the file is unchanged (#397)" {
  local origin="$BATS_TEST_TMPDIR/origin.git" work="$BATS_TEST_TMPDIR/work-tree"
  git init -q --bare "$origin"
  git init -q -b pe/demo "$work"
  git -C "$work" -c user.name=t -c user.email=t@t commit -q --allow-empty -m base
  git -C "$work" remote add origin "$origin"
  git -C "$work" push -q origin pe/demo
  git -C "$work" -c user.name=t -c user.email=t@t commit -q --allow-empty -m green1
  git -C "$work" -c user.name=t -c user.email=t@t commit -q --allow-empty -m green2
  cd "$work"
  run pe_outcome demo 4 partial --reason context
  [ "$status" -eq 0 ]
  assert_contains "$output" "WARNING: unpushed — . is 2 commit(s) ahead of origin/pe/demo."
  grep -q '"status": "partial"' "$PE_OUTCOME_FILE"
  PHASE_OUTCOME_UNPUSHED=0 run pe_outcome demo 4 partial --reason context
  [[ "$output" != *unpushed* ]]
  run pe_outcome demo 4 complete
  [[ "$output" != *unpushed* ]]
}

@test "outcome: under PE_SDK=1 with nobody at the socket, the file drop is still the door (measured-console phase 20)" {
  # The SDK door's bridge hands the call to the console; a console that is not
  # there (exit 75 from sdk-bridge.mjs) must never cost a declaration.
  PE_SDK=1 PE_SDK_SOCKET="$BATS_TEST_TMPDIR/nobody.sock" run pe_outcome demo 3 complete
  [ "$status" -eq 0 ]
  assert_contains "$output" "outcome recorded: demo phase 3 = complete"
  grep -q '"status": "complete"' "$PE_OUTCOME_FILE"
}
