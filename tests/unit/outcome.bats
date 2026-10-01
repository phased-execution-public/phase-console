#!/usr/bin/env bats
# phase-outcome.sh — the machine-readable session outcome. Born from a live run:
# a phase-8 session that had done real work ended its turn "waiting on the image
# build (34-65 min)" in free prose, the runner read the clean exit as completion,
# found no handoff, and halted the run. The outcome file is the record the
# runner reads instead of guessing; these tests pin the exact JSON (the runner's
# parser and the journal both consume it verbatim).
load ../helpers/test_helper

setup() {
  # FIRST, and before the exports below: five cases here compare the file
  # against an exact JSON literal, and a supervised session exports PE_TRACE_ID
  # and PE_SPAN_ID, which phase-outcome.sh correctly folds in as `trace`/`span`
  # (cases 41-43 assert exactly that). Without this the suite is green from a
  # terminal and red from inside a run — the one place it is most likely to be
  # run. `setup_docs` scrubs for the suites that use it; this one builds its own
  # environment, so it asks for itself.
  scrub_pe_env
  export PE_NOW="2026-08-10T21:10:03Z"
  export PE_OUTCOME_FILE="$BATS_TEST_TMPDIR/outcome.json"
  # The ruling ledger the runner would inject. Append-only, unlike the outcome
  # file, which is written whole and consumed.
  export PE_RULINGS_FILE="$BATS_TEST_TMPDIR/rulings.ndjson"
  # The session line is written only when a session id is known; this suite
  # may itself run inside a Claude session that exports one.
  unset PE_SESSION_ID CLAUDE_CODE_SESSION_ID
  # The unsupervised fallback writes into the console's state home for the
  # repository root — both pointed at the test's own directories.
  export XDG_STATE_HOME="$BATS_TEST_TMPDIR/state"
  export DOCS_ROOT="$BATS_TEST_TMPDIR/work"
  mkdir -p "$DOCS_ROOT"
}

# The identity rule of viewer/shared/instances.mjs, in bash: sha256(root)[:8]-basename.
inbox_dir() { # <slug>
  local id
  id="$(printf '%s' "$DOCS_ROOT" | shasum -a 256 | cut -c1-8)-$(basename "$DOCS_ROOT")"
  printf '%s/phase-console/runs/%s/%s/outcomes' "$XDG_STATE_HOME" "$id" "$1"
}

# The rulings ledger sits beside outcomes/: it is per PLAN, not per phase and
# not per run. Built from the id rather than from `inbox_dir`/.. — `..` only
# resolves through a directory that exists, and outcomes/ need not.
ledger_file() { # <slug>
  local id
  id="$(printf '%s' "$DOCS_ROOT" | shasum -a 256 | cut -c1-8)-$(basename "$DOCS_ROOT")"
  printf '%s/phase-console/runs/%s/%s/rulings.ndjson' "$XDG_STATE_HOME" "$id" "$1"
}

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

@test "outcome: without PE_OUTCOME_FILE the JSON goes to the console's inbox for this root AND to stdout, exit stays 0" {
  unset PE_OUTCOME_FILE
  run pe_outcome demo 8 waiting-external --until 2026-08-10T21:40:00Z
  [ "$status" -eq 0 ]
  assert_contains "$output" '"status": "waiting-external",'
  assert_contains "$output" 'PE_OUTCOME_FILE is not set'
  # runs/<sha256(root)[:8]-basename>/<slug>/outcomes/phase-NN-<written_at>.json —
  # what the convergence loop watches for a session nobody supervises. The
  # stamp is what keeps a second declaration from destroying an unread first
  # (S9-a); the basic ISO form, so the name sorts oldest-first as a string and
  # is legal on every filesystem.
  f="$(inbox_dir demo)/phase-08-20260810T211003Z.json"
  assert_contains "$output" "$f"
  [ -f "$f" ]
  expected='{
  "version": 1,
  "slug": "demo",
  "phase": 8,
  "status": "waiting-external",
  "resume_after": "2026-08-10T21:40:00Z",
  "watch": [],
  "written_at": "2026-08-10T21:10:03Z"
}'
  [ "$(cat "$f")" = "$expected" ]
  [ -z "$(ls "$(inbox_dir demo)"/*.tmp.* 2>/dev/null || true)" ]
}

@test "outcome: the unsupervised path derives the root the way phase-lock.sh does (git toplevel when DOCS_ROOT is unset)" {
  unset PE_OUTCOME_FILE
  unset DOCS_ROOT
  repo="$BATS_TEST_TMPDIR/repo"; mkdir -p "$repo/sub"
  git -C "$repo" init -q
  id="$(printf '%s' "$(cd "$repo" && pwd -P)" | shasum -a 256 | cut -c1-8)-repo"
  run bash -c "cd '$repo/sub' && '$SYS_BASH' '$PE_SCRIPTS/phase-outcome.sh' demo 2 partial --reason context"
  [ "$status" -eq 0 ]
  [ -f "$XDG_STATE_HOME/phase-console/runs/$id/demo/outcomes/phase-02-20260810T211003Z.json" ]
}

@test "outcome: an unwritable state home still prints the JSON and exits 0" {
  unset PE_OUTCOME_FILE
  export XDG_STATE_HOME="/dev/null/nowhere"
  run pe_outcome demo 8 blocked --needs credential --reason "x"
  [ "$status" -eq 0 ]
  assert_contains "$output" '"status": "blocked",'
  assert_contains "$output" 'could not be'
}

@test "outcome: the session id rides along as session_id — PE_SESSION_ID first, else CLAUDE_CODE_SESSION_ID, sanitised" {
  PE_SESSION_ID="sess-1" run pe_outcome demo 8 complete
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_OUTCOME_FILE")" '"session_id": "sess-1",'
  CLAUDE_CODE_SESSION_ID="abc-2" run pe_outcome demo 8 complete
  assert_contains "$(cat "$PE_OUTCOME_FILE")" '"session_id": "abc-2",'
  PE_SESSION_ID="one" CLAUDE_CODE_SESSION_ID="two" run pe_outcome demo 8 complete
  assert_contains "$(cat "$PE_OUTCOME_FILE")" '"session_id": "one",'
  # Only id characters survive, so the line can never break the JSON.
  PE_SESSION_ID='we"ird id' run pe_outcome demo 8 complete
  assert_contains "$(cat "$PE_OUTCOME_FILE")" '"session_id": "weirdid",'
  # The exact-JSON pins above hold because no id was known there.
  run pe_outcome demo 8 complete
  refute_contains "$(cat "$PE_OUTCOME_FILE")" 'session_id'
}

@test "outcome: usage errors exit 2 (bad status, wait flags on a status that cannot park, both wait flags)" {
  run pe_outcome demo 8 finished
  [ "$status" -eq 2 ]
  # `complete` has nothing to resume and `partial` is resumed at once, so a
  # clock on either describes a wait the session is not taking.
  run pe_outcome demo 8 complete --wait-minutes 30
  [ "$status" -eq 2 ]
  run pe_outcome demo 8 waiting-external --wait-minutes 30 --until 2026-08-10T21:40:00Z
  [ "$status" -eq 2 ]
  run pe_outcome demo eight complete
  [ "$status" -eq 2 ]
  [ ! -f "$PE_OUTCOME_FILE" ]
}

@test "outcome: blocked and needs-human may carry a resume clock too" {
  # Refused until 2026-08-30, and the refusal cost more than it saved: a session
  # can know both that a person must look AND that there is no point looking
  # before the release lands. Forced to choose it chose the question, and the
  # clock — the one fact that could have moved the phase without anybody — was
  # discarded at the parser. The ask still stands; the clock only decides when
  # the console next brings the phase up.
  run pe_outcome demo 8 needs-human --needs human-acts --reason "a person must sign the release" --until 2026-09-01T09:00:00Z
  [ "$status" -eq 0 ]
  grep -q '"resume_after": "2026-09-01T09:00:00Z"' "$PE_OUTCOME_FILE"
  grep -q '"status": "needs-human"' "$PE_OUTCOME_FILE"

  run pe_outcome demo 8 blocked --needs lock --reason "waiting on the lock" --wait-minutes 90
  [ "$status" -eq 0 ]
  grep -q '"resume_after": "20[0-9][0-9]-' "$PE_OUTCOME_FILE"
}

@test "outcome: --until accepts a space separator and normalises it to T" {
  # A `date:` ref is written by hand as often as by --wait-minutes, and
  # "2026-09-01 09:00" is what a person types. It is accepted at the door and
  # normalised on the way out: one wire format, two spellings at the keyboard.
  run pe_outcome demo 8 waiting-external --until "2026-09-01 09:00:00"
  [ "$status" -eq 0 ]
  grep -q '"resume_after": "2026-09-01T09:00:00"' "$PE_OUTCOME_FILE"
}

@test "outcome: --until refuses a shape that is not an instant, and a shape that is not a MOMENT" {
  run pe_outcome demo 8 waiting-external --until tomorrow
  [ "$status" -eq 2 ]
  assert_contains "$output" "must be ISO8601"
  run pe_outcome demo 8 waiting-external --until 2026-09-01
  [ "$status" -eq 2 ]
  # Shape is not sense. Each of these matches the glob and is not a moment; a
  # park armed from one resumes instantly or never, and both read as a console
  # bug rather than a typo three files away.
  run pe_outcome demo 8 waiting-external --until 2026-13-01T09:00:00Z
  [ "$status" -eq 2 ]
  assert_contains "$output" "not a real instant"
  run pe_outcome demo 8 waiting-external --until 2026-09-45T09:00:00Z
  [ "$status" -eq 2 ]
  run pe_outcome demo 8 waiting-external --until 2026-09-01T99:00:00Z
  [ "$status" -eq 2 ]
  run pe_outcome demo 8 waiting-external --until 2026-09-01T09:99:00Z
  [ "$status" -eq 2 ]
  # DAYS IN THIS MONTH, not a flat 31. A flat bound let `2026-09-31` through, and
  # every consumer of `resume_after` uses a bare `Date.parse`, which rolls it
  # over to October 1st — so the phase parked a day later than the session asked
  # with nothing anywhere saying why, which is verbatim the defect this check
  # exists to prevent.
  run pe_outcome demo 8 waiting-external --until 2026-09-31T09:00:00Z
  [ "$status" -eq 2 ]
  assert_contains "$output" "not a real instant"
  run pe_outcome demo 8 waiting-external --until 2026-02-30T09:00:00Z
  [ "$status" -eq 2 ]
  # …and the calendar, not a table: 2026 is not a leap year and 2028 is.
  run pe_outcome demo 8 waiting-external --until 2026-02-29T09:00:00Z
  [ "$status" -eq 2 ]
  run pe_outcome demo 8 waiting-external --until 2028-02-29T09:00:00Z
  [ "$status" -eq 0 ]
  # The month ends that ARE real must all still pass.
  for d in 2026-01-31 2026-04-30 2026-06-30 2026-08-31 2026-09-30 2026-11-30 2026-12-31; do
    run pe_outcome demo 8 waiting-external --until "${d}T09:00:00Z"
    [ "$status" -eq 0 ] || { echo "refused a real day: $d"; return 1; }
  done
  # A leading zero is a decimal month, not an octal one — `08` and `09` are
  # where a naive `$((...))` breaks, and both are real months.
  run pe_outcome demo 8 waiting-external --until 2026-08-09T08:09:00Z
  [ "$status" -eq 0 ]
  run pe_outcome demo 8 waiting-external --until 2026-09-08T09:08:00Z
  [ "$status" -eq 0 ]
  [ ! -f "$PE_OUTCOME_FILE" ] || grep -q '"resume_after": "2026-09-08T09:08:00Z"' "$PE_OUTCOME_FILE"
}

@test "outcome: every documented watch scheme survives the round trip verbatim" {
  # The console parses these (viewer/server/watch-refs.ts); this script must not
  # normalise, quote or reorder them on the way through. A ref the scheduler
  # cannot parse is a wait nobody is watching.
  run pe_outcome demo 8 waiting-external \
    --watch "gh:acme/app#run/33123610977" \
    --watch "gh:acme/app#pr/77" \
    --watch "date:2026-09-01T09:00:00Z" \
    --watch "lock:other-plan/3" \
    --watch 'cmd:"npm test"'
  [ "$status" -eq 0 ]
  expected='"watch": ["gh:acme/app#run/33123610977", "gh:acme/app#pr/77", "date:2026-09-01T09:00:00Z", "lock:other-plan/3", "cmd:\"npm test\""],'
  grep -qF "$expected" "$PE_OUTCOME_FILE"
}

@test "outcome: --wait-minutes computes a resume_after timestamp" {
  run pe_outcome demo 8 waiting-external --wait-minutes 45
  [ "$status" -eq 0 ]
  grep -q '"resume_after": "20[0-9][0-9]-' "$PE_OUTCOME_FILE"
}

@test "outcome: partial writes the exact JSON — work remains, resume me" {
  run pe_outcome demo 5 partial --reason budget
  [ "$status" -eq 0 ]
  assert_contains "$output" "outcome recorded: demo phase 5 = partial"
  expected='{
  "version": 1,
  "slug": "demo",
  "phase": 5,
  "status": "partial",
  "reason": "budget",
  "watch": [],
  "written_at": "2026-08-10T21:10:03Z"
}'
  [ "$(cat "$PE_OUTCOME_FILE")" = "$expected" ]
  # `partial` means "resume me now", so a clock on it is a contradiction.
  run pe_outcome demo 5 partial --wait-minutes 10
  [ "$status" -eq 2 ]
}

# ---- rulings: what a session DECIDED, not how it ended ---------------------

@test "ruling: writes ONE exact NDJSON line, and the next one appends" {
  run pe_outcome demo 5 ruling --kind deviation --what "kept the old field" \
    --why "a reader predating it still exists" --cost-if-wrong "one dead branch"
  [ "$status" -eq 0 ]
  assert_contains "$output" "ruling recorded: demo phase 5 (deviation)"
  # The id is sha256("<slug> <phase> <at> <what>") cut to 12 — the digest
  # viewer/server/runner/rulings.ts derives, stamped so acks and promote name it.
  expected='{"version":1,"type":"ruling","id":"87b9eff77673","slug":"demo","phase":5,"kind":"deviation","what":"kept the old field","why":"a reader predating it still exists","cost_if_wrong":"one dead branch","at":"2026-08-10T21:10:03Z"}'
  [ "$(cat "$PE_RULINGS_FILE")" = "$expected" ]

  PE_NOW="2026-08-10T22:00:00Z" run pe_outcome demo 6 ruling --what "left the sub-case to phase 9"
  [ "$status" -eq 0 ]
  # Appended, not replaced: two lines, the first untouched.
  [ "$(wc -l < "$PE_RULINGS_FILE" | tr -d ' ')" = "2" ]
  [ "$(head -1 "$PE_RULINGS_FILE")" = "$expected" ]
  second='{"version":1,"type":"ruling","id":"7edead64f86b","slug":"demo","phase":6,"kind":"ambiguity","what":"left the sub-case to phase 9","at":"2026-08-10T22:00:00Z"}'
  [ "$(tail -1 "$PE_RULINGS_FILE")" = "$second" ]
}

@test "ruling --for: a deferral carries its addressee, and defaults to \`next\`" {
  run pe_outcome demo 5 ruling --kind deferral --what "left the second decoder" --for 9
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_RULINGS_FILE")" '"for":"9"'

  rm -f "$PE_RULINGS_FILE"
  # A deferral with no addressee is for whoever comes next — which is what a
  # session means when it says "left for later" and does not say for whom. The
  # field is written either way, so a reader never has to know the default.
  run pe_outcome demo 5 ruling --kind deferral --what "left the second decoder"
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_RULINGS_FILE")" '"for":"next"'

  rm -f "$PE_RULINGS_FILE"
  run pe_outcome demo 5 ruling --kind deferral --what "a fact for everyone" --for all
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_RULINGS_FILE")" '"for":"all"'
}

@test "ruling --for: refused on the other two kinds, and on an unreadable addressee" {
  # An ambiguity and a deviation are a session explaining ITSELF; only a
  # deferral is addressed to somebody, so `--for` on the other two is a note
  # nothing would ever deliver.
  run pe_outcome demo 5 ruling --kind ambiguity --what x --for 9
  [ "$status" -eq 2 ]
  assert_contains "$output" "--for belongs to --kind deferral"
  [ ! -f "$PE_RULINGS_FILE" ]

  run pe_outcome demo 5 ruling --kind deviation --what x --for next
  [ "$status" -eq 2 ]

  run pe_outcome demo 5 ruling --kind deferral --what x --for "the next person"
  [ "$status" -eq 2 ]
  assert_contains "$output" "invalid --for"
  [ ! -f "$PE_RULINGS_FILE" ]

  run pe_outcome demo 5 ruling --kind deferral --what x --for 0
  [ "$status" -eq 2 ]
}

@test "ruling: --kind defaults to ambiguity and an unknown kind exits 2 without writing" {
  run pe_outcome demo 5 ruling --what "a choice"
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_RULINGS_FILE")" '"kind":"ambiguity"'

  rm -f "$PE_RULINGS_FILE"
  run pe_outcome demo 5 ruling --kind opinion --what "a choice"
  [ "$status" -eq 2 ]
  assert_contains "$output" "invalid --kind: opinion"
  [ ! -f "$PE_RULINGS_FILE" ]
}

@test "ruling: newlines, quotes and backslashes are sanitised into ONE json line" {
  what="$(printf 'chose "A"\nover B\\C')"
  run pe_outcome demo 5 ruling --what "$what"
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$PE_RULINGS_FILE" | tr -d ' ')" = "1" ]
  assert_contains "$(cat "$PE_RULINGS_FILE")" '"what":"chose \"A\" over B\\C"'
}

@test "ruling: --what is required, and the outcome flags are refused rather than ignored" {
  run pe_outcome demo 5 ruling
  [ "$status" -eq 2 ]
  assert_contains "$output" "--what is required"

  run pe_outcome demo 5 ruling --what x --watch "gh:a#run/1"
  [ "$status" -eq 2 ]
  assert_contains "$output" "belong to an outcome status"

  run pe_outcome demo 5 ruling --what x --wait-minutes 30
  [ "$status" -eq 2 ]
  assert_contains "$output" "belong to an outcome status"

  # ...and the other way round: a ruling flag on a real status is an error too.
  run pe_outcome demo 5 complete --what x
  [ "$status" -eq 2 ]
  assert_contains "$output" "only make sense with ruling"
  [ ! -f "$PE_RULINGS_FILE" ]
}

@test "ruling: the session id rides along, sanitised, and is omitted when unknown" {
  PE_SESSION_ID='we"ird id' run pe_outcome demo 5 ruling --what x
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_RULINGS_FILE")" '"session_id":"weirdid"'
  rm -f "$PE_RULINGS_FILE"
  run pe_outcome demo 5 ruling --what x
  refute_contains "$(cat "$PE_RULINGS_FILE")" 'session_id'
}

@test "ruling: without PE_RULINGS_FILE the line goes to this root's ledger AND to stdout, exit stays 0" {
  unset PE_RULINGS_FILE
  run pe_outcome demo 5 ruling --what "a choice"
  [ "$status" -eq 0 ]
  assert_contains "$output" '"type":"ruling"'
  assert_contains "$output" 'PE_RULINGS_FILE is not set'
  f="$(ledger_file demo)"
  [ -f "$f" ]
  assert_contains "$(cat "$f")" '"what":"a choice"'
}

@test "ruling: an unwritable state home still prints the line and exits 0" {
  unset PE_RULINGS_FILE
  export XDG_STATE_HOME="/dev/null/nowhere"
  run pe_outcome demo 5 ruling --what "a choice"
  [ "$status" -eq 0 ]
  assert_contains "$output" '"what":"a choice"'
  assert_contains "$output" 'could not be written'
}

# ---- rulings: --remember, the feedback loop (chapter 10 ZTD-7) ---------------

@test "ruling --remember plan: writes the ## Decisions row (source ruling) and acks the ruling with --by" {
  setup_docs decisions decisions
  # setup_docs scrubs the PE_* environment, the ledger path included.
  export PE_RULINGS_FILE="$BATS_TEST_TMPDIR/rulings.ndjson" PE_NOW="2026-08-10T21:10:03Z" PE_TODAY=2026-09-14
  run pe_outcome decisions 2 ruling --what "the window is the cap" --why "the plan says so" \
    --needs waits --remember plan --by op
  [ "$status" -eq 0 ]
  assert_contains "$output" "remembered for plan decisions: waits"
  id="$(sed -n 's/.*"id":"\([0-9a-f]*\)".*/\1/p' "$PE_RULINGS_FILE" | head -1)"
  [ "${#id}" -eq 12 ]
  # The twin row: value = --what, source ruling, evidence the id, plan-wide.
  grep -q "| \`waits\` | the window is the cap | op | answered | yes | ruling | ruling $id | — |" \
    "$DOCS_ROOT/docs/handoffs/decisions/decisions.md"
  # The ledger: the ruling line, then ONE ack naming it and its author.
  [ "$(wc -l < "$PE_RULINGS_FILE" | tr -d ' ')" = "2" ]
  [ "$(tail -1 "$PE_RULINGS_FILE")" = "{\"version\":1,\"type\":\"ack\",\"id\":\"$id\",\"at\":\"2026-08-10T21:10:03Z\",\"by\":\"op\"}" ]
  # And the engine reads the promoted row back.
  run pg decisions --decisions
  assert_contains "$output" "$(printf 'waits\tanswered\top\tyes\truling\tthe window is the cap')"
}

@test "ruling --remember: needs a key, plan|global only, refused on an outcome status" {
  run pe_outcome demo 5 ruling --what x --remember plan
  [ "$status" -eq 2 ]
  assert_contains "$output" "--remember plan needs --needs <key>"
  run pe_outcome demo 5 ruling --what x --needs gates --remember always
  [ "$status" -eq 2 ]
  assert_contains "$output" "invalid --remember: always"
  run pe_outcome demo 5 complete --remember plan
  [ "$status" -eq 2 ]
  assert_contains "$output" "only make sense with ruling"
  [ ! -f "$PE_RULINGS_FILE" ]
}

@test "ruling --remember global: with no console answering, the ruling is still recorded and the exit names the fallback" {
  PHASE_CONSOLE_URL="http://127.0.0.1:1" run pe_outcome demo 5 ruling --what waive --needs qa.exhausted --remember global
  [ "$status" -eq 1 ]
  assert_contains "$output" "no console answers at http://127.0.0.1:1"
  assert_contains "$output" "Settings"
  # Recorded first — the request failing is not the ruling failing.
  assert_contains "$(cat "$PE_RULINGS_FILE")" '"decisionKey":"qa.exhausted"'
  [ "$(wc -l < "$PE_RULINGS_FILE" | tr -d ' ')" = "1" ]
}

# --- engine-3 / engine-16: the two ways a declaration used to disappear -------

@test "outcome: a zero-padded phase writes a phase the runner can parse" {
  # engine-3. `08` passed the all-digits check and went unquoted into the JSON
  # number position, where it is not a legal JSON number: readOutcome threw,
  # caught, and returned null — which it documents as "the session declared
  # nothing". A session that correctly parked itself, using the number it read
  # off its own handoff filename, had the park dropped and the run halted.
  out="$BATS_TEST_TMPDIR/outcome.json"
  run env PE_OUTCOME_FILE="$out" "$SYS_BASH" "$PE_SCRIPTS/phase-outcome.sh" myslug 08 complete --reason r
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$out")" '"phase": 8'
  refute_contains "$(cat "$out")" '"phase": 08'
  if command -v node >/dev/null 2>&1; then
    run node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$out"
    [ "$status" -eq 0 ]
  fi
}

@test "outcome: a PE_OUTCOME_FILE whose directory is missing is created, not fatal" {
  out="$BATS_TEST_TMPDIR/nested/deeper/outcome.json"
  run env PE_OUTCOME_FILE="$out" "$SYS_BASH" "$PE_SCRIPTS/phase-outcome.sh" myslug 3 partial --reason budget
  [ "$status" -eq 0 ]
  [ -f "$out" ]
  assert_contains "$(cat "$out")" '"status": "partial"'
}

@test "outcome: an unwritable PE_OUTCOME_FILE degrades to stdout and exit 0" {
  # engine-16. The unsupervised branch has always degraded honestly; the
  # supervised one had no guard, so the redirect failed, set -e fired, and the
  # session died with exit 1 and nothing on either stream — the one failure mode
  # a channel built to replace prose must not have.
  run env PE_OUTCOME_FILE="/proc/nonexistent-root/x/outcome.json" \
    "$SYS_BASH" "$PE_SCRIPTS/phase-outcome.sh" myslug 3 blocked --needs lock --reason "lock held"
  [ "$status" -eq 0 ]
  assert_contains "$output" '"status": "blocked"'
  assert_contains "$output" "could not be written"
}

@test "outcome: the usage line names exactly the statuses shared/run-lifecycle.js declares" {
  # The script's usage line IS the vocabulary as a session reads it, and it is
  # the one copy that cannot import the owner. A word added to OUTCOME_STATUSES
  # and not to the usage line is a status the console accepts and never tells
  # anybody about; a word dropped from the array and left in the line is worse.
  declared="$(node --input-type=module -e "
    import { OUTCOME_STATUSES } from '$PE_DIR/viewer/shared/run-lifecycle.js';
    process.stdout.write(OUTCOME_STATUSES.join('|'));
  ")"
  [ -n "$declared" ]
  run bash "$PE_SCRIPTS/phase-outcome.sh"
  [ "$status" -eq 2 ]
  assert_contains "$output" "<$declared>"
}

# ── S9-a — the unsupervised inbox destroyed an unread declaration ────────────
# The name was `phase-NN.json`, one per phase, written with `mv`. A session that
# declared `partial` and then — resumed, or never read — declared `blocked`
# silently destroyed the first, and a console that had been away long enough to
# need both got exactly one. The inbox is the ONLY channel a session nobody
# supervises has into the autopilot; a channel that overwrites its own backlog
# is prose with extra steps.
@test "outcome: two unsupervised declarations both survive — neither mv's over the other (S9-a)" {
  unset PE_OUTCOME_FILE
  export PE_NOW="2026-08-10T21:10:03Z"
  run pe_outcome demo 8 partial --reason context
  [ "$status" -eq 0 ]
  export PE_NOW="2026-08-10T21:44:09Z"
  run pe_outcome demo 8 blocked --needs lock --reason "held by someone"
  [ "$status" -eq 0 ]

  [ -f "$(inbox_dir demo)/phase-08-20260810T211003Z.json" ]
  [ -f "$(inbox_dir demo)/phase-08-20260810T214409Z.json" ]
  grep -q '"status": "partial"'  "$(inbox_dir demo)/phase-08-20260810T211003Z.json"
  grep -q '"status": "blocked"'  "$(inbox_dir demo)/phase-08-20260810T214409Z.json"
}

@test "outcome: the same declaration twice in one second is one file, not two (S9-a)" {
  # Idempotence at the same instant: the stamp is the key, so a re-run with the
  # same clock replaces rather than accumulating. The thing being prevented is
  # losing a DIFFERENT message, never writing the same one twice.
  unset PE_OUTCOME_FILE
  run pe_outcome demo 8 partial --reason context
  run pe_outcome demo 8 partial --reason context
  [ "$(ls "$(inbox_dir demo)" | wc -l | tr -d " ")" = "1" ]
}

@test "outcome: the stamped name still addresses its phase, and sorts oldest-first (S9-a)" {
  unset PE_OUTCOME_FILE
  export PE_NOW="2026-08-10T21:44:09Z"; run pe_outcome demo 8 partial --reason context
  export PE_NOW="2026-08-10T21:10:03Z"; run pe_outcome demo 8 partial --reason budget
  # Lexicographic order over a fixed-width basic-ISO stamp IS chronological
  # order, which is what lets the console ingest oldest-first by sorting names.
  [ "$(ls "$(inbox_dir demo)" | head -1)" = "phase-08-20260810T211003Z.json" ]
}

# ---------------------------------------------------------------------------
# The trace carrier (5.1.0)
#
# A declaration is the one thing the runner ACTS on, so "which drive was this
# the outcome of" is exactly the question worth answering from the file alone
# — and after a console restart the file is often all that is left.
# ---------------------------------------------------------------------------

@test "outcome: the declaration carries trace and span when the session has them" {
  export PE_TRACE_ID="0123456789abcdef0123456789abcdef"
  export PE_SPAN_ID="fedcba9876543210"
  run pe_outcome demo 5 partial --reason budget
  [ "$status" -eq 0 ]
  grep -q '"trace": "0123456789abcdef0123456789abcdef"' "$PE_OUTCOME_FILE"
  grep -q '"span": "fedcba9876543210"' "$PE_OUTCOME_FILE"
}

@test "outcome: with no trace the file carries neither key" {
  unset PE_TRACE_ID PE_SPAN_ID
  run pe_outcome demo 5 partial --reason budget
  [ "$status" -eq 0 ]
  ! grep -q '"trace"' "$PE_OUTCOME_FILE"
  ! grep -q '"span"' "$PE_OUTCOME_FILE"
}

@test "outcome: a span with no trace carries neither — half a join is not a join" {
  unset PE_TRACE_ID
  export PE_SPAN_ID="fedcba9876543210"
  run pe_outcome demo 5 partial --reason budget
  [ "$status" -eq 0 ]
  ! grep -q '"span"' "$PE_OUTCOME_FILE"
}

# ---- the ingest probe (control-tower phase 50, #86) --------------------------
# A declaration that parks and names refs is STAGED, and the console asked
# whether one has already landed. `curl` is a fake here: it records what it was
# asked, whether the staged file existed while it was asked, and answers what
# the test says. The real door is `declare-already-landed.test.ts`.
fake_console() { # <http code> <body>
  local bin="$BATS_TEST_TMPDIR/fakebin"
  mkdir -p "$bin"
  cat > "$bin/curl" <<'CURL'
#!/bin/bash
out=""; data=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --data) data="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s\n' "$data" >> "$FAKE_CURL_LOG"
file="$(printf '%s' "$data" | sed -n 's/.*"file":"\([^"]*\)".*/\1/p')"
[ -f "$file" ] && echo "staged-present" >> "$FAKE_CURL_LOG"
printf '%s' "$FAKE_CURL_BODY" > "$out"
printf '%s' "$FAKE_CURL_CODE"
CURL
  chmod +x "$bin/curl"
  export PATH="$bin:$PATH" FAKE_CURL_LOG="$BATS_TEST_TMPDIR/curl.log" FAKE_CURL_CODE="$1" FAKE_CURL_BODY="$2"
  export PHASE_OUTCOME_PROBE=1 PHASE_CONSOLE_URL="http://127.0.0.1:1"
  : > "$FAKE_CURL_LOG"
}
LANDED='{"status":200,"verdict":"landed","ref":"gh:acme/app#run/1","detail":"completed: success","sentence":"already landed — continue: gh:acme/app#run/1 (completed: success). Nothing was parked; carry on with the phase from what landed.","refs":[]}'

@test "outcome: a watched ref that has ALREADY landed parks nothing — exit 3, the console's sentence, no file" {
  fake_console 200 "$LANDED"
  run pe_outcome demo 5 waiting-external --wait-minutes 30 --watch "gh:acme/app#run/1"
  [ "$status" -eq 3 ]
  assert_contains "$output" "already landed — continue: gh:acme/app#run/1 (completed: success)"
  [ ! -f "$PE_OUTCOME_FILE" ]
  [ -z "$(ls "$BATS_TEST_TMPDIR" | grep '\.tmp\.' || true)" ]
  grep -q '"file":"[^"]*/outcome\.json\.tmp\.[0-9][0-9]*"' "$FAKE_CURL_LOG"
  grep -qx 'staged-present' "$FAKE_CURL_LOG"
}

@test "outcome: pending, a refusal or no console writes the declaration as before, exit 0" {
  fake_console 200 '{"status":200,"verdict":"pending","refs":[]}'
  run pe_outcome demo 5 waiting-external --wait-minutes 30 --watch "gh:acme/app#run/1"
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_OUTCOME_FILE")" '"status": "waiting-external"'
  rm -f "$PE_OUTCOME_FILE"
  # A refusal is never a landing, whatever its body says.
  fake_console 404 "$LANDED"
  run pe_outcome demo 5 blocked --needs lock --reason "held" --watch "lock:other/2"
  [ "$status" -eq 0 ]
  [ -f "$PE_OUTCOME_FILE" ]
  rm -f "$PE_OUTCOME_FILE"
  fake_console 000 ''
  run pe_outcome demo 5 needs-human --needs credential --reason "sign in" --watch 'cmd:"true"'
  [ "$status" -eq 0 ]
  [ -f "$PE_OUTCOME_FILE" ]
  [ -z "$(ls "$BATS_TEST_TMPDIR" | grep '\.tmp\.' || true)" ]
}

@test "outcome: only a parking declaration with refs asks — and PHASE_OUTCOME_PROBE=0 asks nothing" {
  fake_console 200 "$LANDED"
  run pe_outcome demo 5 partial --reason context
  [ "$status" -eq 0 ]
  run pe_outcome demo 5 waiting-external --wait-minutes 30
  [ "$status" -eq 0 ]
  PHASE_OUTCOME_PROBE=0 run pe_outcome demo 5 waiting-external --wait-minutes 30 --watch "gh:acme/app#run/1"
  [ "$status" -eq 0 ]
  [ ! -s "$FAKE_CURL_LOG" ]
}

@test "outcome: the unsupervised inbox asks too — landed leaves no inbox file behind" {
  unset PE_OUTCOME_FILE
  fake_console 200 "$LANDED"
  run pe_outcome demo 5 waiting-external --wait-minutes 30 --watch "gh:acme/app#run/1"
  [ "$status" -eq 3 ]
  [ -z "$(ls "$(inbox_dir demo)" 2>/dev/null || true)" ]
  grep -q '"file":"[^"]*/outcomes/phase-05-[0-9TZ]*\.json\.tmp\.[0-9][0-9]*"' "$FAKE_CURL_LOG"
}

# ── verified: the session's own proof (control-tower phase 62, #68) ──────────
# The console used to re-run a phase's whole §Verification after the session
# exited, with no record of what the session had just proved at which tree: in
# 21 phases of one week it re-ran a suite (398 min) after 640 min of in-turn
# suite waiting. A session now records each command it ran — the command, its
# exit status and the TREE it ran against — and the console re-runs only what
# was not proven at an equivalent tree. The tree is the WORKING tree's content,
# committed or not: a session tests, then commits, and a proof pinned to HEAD
# would be stale the moment the commit it proved landed.

proof_repo() {
  REPO="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$REPO/src"
  git -C "$REPO" init -q -b main
  git -C "$REPO" config user.email t@example.invalid
  git -C "$REPO" config user.name t
  printf 'a\n' > "$REPO/src/a.ts"
  git -C "$REPO" add -A && git -C "$REPO" commit -qm init
}

# What the script must name: the working tree's content as a tree object. Built
# here from an EMPTY index — every file hashed, no stat data trusted — so it is
# the ground truth the script's faster index-copy route has to agree with.
working_tree() { # <repo>
  local idx
  idx="$(mktemp)"
  rm -f "$idx"
  GIT_INDEX_FILE="$idx" git -C "$1" add -A
  GIT_INDEX_FILE="$idx" git -C "$1" write-tree
  rm -f "$idx"
}

proofs_file() { # <slug>
  local id
  id="$(printf '%s' "$DOCS_ROOT" | shasum -a 256 | cut -c1-8)-$(basename "$DOCS_ROOT")"
  printf '%s/phase-console/runs/%s/%s/proofs.ndjson' "$XDG_STATE_HOME" "$id" "$1"
}

@test "verified: ONE proof line — the command folded, its exit, and the working tree it ran against" {
  proof_repo
  export PE_PROOFS_FILE="$BATS_TEST_TMPDIR/proofs.ndjson"
  # Uncommitted on purpose: the proof is about what RAN.
  printf 'b\n' > "$REPO/src/a.ts"
  tree="$(working_tree "$REPO")"
  head="$(git -C "$REPO" rev-parse HEAD)"
  run pe_outcome demo 5 verified --command "npm   test" --exit 0 --in "$REPO"
  [ "$status" -eq 0 ]
  assert_contains "$output" "proof recorded: demo phase 5"
  expected="{\"version\":1,\"type\":\"proof\",\"slug\":\"demo\",\"phase\":5,\"command\":\"npm test\",\"code\":0,\"tree\":\"$tree\",\"head\":\"$head\",\"at\":\"2026-08-10T21:10:03Z\"}"
  [ "$(cat "$PE_PROOFS_FILE")" = "$expected" ]
  # The session's own index is untouched — nothing staged behind its back.
  [ -z "$(git -C "$REPO" diff --cached --name-only)" ]
  # …and a second proof appends.
  run pe_outcome demo 5 verified --command "bash tests/run-tests.sh" --exit 1 --in "$REPO/src"
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$PE_PROOFS_FILE" | tr -d ' ')" = "2" ]
  assert_contains "$(tail -1 "$PE_PROOFS_FILE")" '"command":"bash tests/run-tests.sh","code":1,'
}

@test "verified: a file rewritten at the same size in the second it was checked out is named as it RAN" {
  proof_repo
  export PE_PROOFS_FILE="$BATS_TEST_TMPDIR/proofs.ndjson"
  # A fresh checkout's index trusts its entries' stat data; a same-size rewrite
  # in the same second matches it on every field git reads. Git re-reads such an
  # entry only while it is not older than the INDEX FILE — so the private copy
  # must keep the index file's mtime, or a second later the tree names the
  # checkout rather than what ran (a copy without it named the stale tree here).
  lane="$BATS_TEST_TMPDIR/lane"
  git -C "$REPO" worktree add -q -b lane "$lane"
  printf 'z\n' > "$lane/src/a.ts"
  sleep 1.1
  run pe_outcome demo 5 verified --command "npm test" --exit 0 --in "$lane"
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_PROOFS_FILE")" "\"tree\":\"$(working_tree "$lane")\""
}

@test "verified: --command and a numeric --exit are required; the other shapes' flags are refused" {
  proof_repo
  export PE_PROOFS_FILE="$BATS_TEST_TMPDIR/proofs.ndjson"
  run pe_outcome demo 5 verified --exit 0 --in "$REPO"
  [ "$status" -eq 2 ]
  run pe_outcome demo 5 verified --command "npm test" --in "$REPO"
  [ "$status" -eq 2 ]
  run pe_outcome demo 5 verified --command "npm test" --exit green --in "$REPO"
  [ "$status" -eq 2 ]
  run pe_outcome demo 5 verified --command "npm test" --exit 0 --reason "x" --in "$REPO"
  [ "$status" -eq 2 ]
  run pe_outcome demo 5 verified --command "npm test" --exit 0 --what "x" --in "$REPO"
  [ "$status" -eq 2 ]
  # --exit and --in belong to a proof alone.
  run pe_outcome demo 5 complete --exit 0
  [ "$status" -eq 2 ]
  [ ! -f "$PE_PROOFS_FILE" ]
}

@test "verified: outside a git working tree it exits 2 and writes nothing — there is no tree to prove against" {
  export PE_PROOFS_FILE="$BATS_TEST_TMPDIR/proofs.ndjson"
  mkdir -p "$BATS_TEST_TMPDIR/plain"
  run pe_outcome demo 5 verified --command "npm test" --exit 0 --in "$BATS_TEST_TMPDIR/plain"
  [ "$status" -eq 2 ]
  assert_contains "$output" "not inside a git working tree"
  [ ! -f "$PE_PROOFS_FILE" ]
}

@test "verified: without PE_PROOFS_FILE the line goes to this root's proofs ledger AND stdout; the session id rides along" {
  proof_repo
  unset PE_PROOFS_FILE
  export PE_SESSION_ID="sess-42"
  run pe_outcome demo 5 verified --command "npm test" --exit 0 --in "$REPO"
  [ "$status" -eq 0 ]
  assert_contains "$output" '"type":"proof"'
  assert_contains "$output" 'PE_PROOFS_FILE is not set'
  f="$(proofs_file demo)"
  [ -f "$f" ]
  assert_contains "$(cat "$f")" '"command":"npm test","code":0,'
  assert_contains "$(cat "$f")" '"session_id":"sess-42"'
}

# ── the ref is checked where it is declared (control-tower phase 88) ─────────
# #125: a 200-character cut silently split a two-check `cmd:` ref mid-word, the
# console refused what was left three seconds later, and the errand went on
# saying it was being watched. #152: a ref carrying the SESSION's shell variable
# (`'$L'`) or a path relative to the session's cwd can never land in the
# console, which runs it from its own root. A ref is now refused while the
# session can still fix it — never cut, never silently kept.

@test "outcome: a --watch ref is never cut — 999 characters are kept verbatim, over 1,000 exits 2 naming the limit (WF-1, #125)" {
  long="cmd:\"test -f /tmp/p88/$(printf 'a%.0s' $(seq 1 960))\""
  [ "${#long}" -lt 1000 ]
  run pe_outcome demo 8 waiting-external --wait-minutes 30 --watch "$long"
  [ "$status" -eq 0 ]
  grep -qF "$(printf '%s' "$long" | sed 's/"/\\"/g')" "$PE_OUTCOME_FILE"
  rm -f "$PE_OUTCOME_FILE"
  over="cmd:\"test -f /tmp/p88/$(printf 'b%.0s' $(seq 1 1000))\""
  run pe_outcome demo 8 waiting-external --wait-minutes 30 --watch "$over"
  [ "$status" -eq 2 ]
  assert_contains "$output" "1000 characters"
  [ ! -f "$PE_OUTCOME_FILE" ]
}

@test "outcome: a cmd: ref the console could not read — unbalanced quoting, a substitution — exits 2 at declaration (WF-2, #125)" {
  # The #125 ref as the old cut left it: its opening quote never closes.
  run pe_outcome demo 27 needs-human --needs permission --reason "applies" \
    --watch 'cmd:"AWS_PROFILE=production aws iam get-user --user-nam'
  [ "$status" -eq 2 ]
  assert_contains "$output" "quot"
  [ ! -f "$PE_OUTCOME_FILE" ]
  run pe_outcome demo 27 waiting-external --wait-minutes 30 --watch "cmd:\"grep -q 'done /tmp/p27/log\""
  [ "$status" -eq 2 ]
  run pe_outcome demo 27 waiting-external --wait-minutes 30 --watch 'cmd:"test -f `cat /tmp/p27/name`"'
  [ "$status" -eq 2 ]
  [ ! -f "$PE_OUTCOME_FILE" ]
}

@test "outcome: a cmd: ref with a shell variable or a relative path exits 2 — the console runs it from its own root (SK-4, #152)" {
  run pe_outcome demo 10 waiting-external --wait-minutes 30 --watch "cmd:\"grep -q 'ios done' '\$L' 2>/dev/null\""
  [ "$status" -eq 2 ]
  assert_contains "$output" 'shell variable'
  run pe_outcome demo 10 waiting-external --wait-minutes 30 --watch 'cmd:"test -f ./out/sweep.rc"'
  [ "$status" -eq 2 ]
  assert_contains "$output" 'relative path'
  run pe_outcome demo 10 waiting-external --wait-minutes 30 --watch "cmd:\"grep -q '^status: complete' docs/handoffs/demo/phase-43-perf.md\""
  [ "$status" -eq 2 ]
  assert_contains "$output" 'relative path'
  [ ! -f "$PE_OUTCOME_FILE" ]
  # Self-contained refs pass untouched: absolute paths, a repo slug, a URL.
  run pe_outcome demo 10 waiting-external --wait-minutes 30 \
    --watch 'cmd:"test -f /tmp/p27/het-verify.rc && test -f /tmp/p27/aws-verify.rc"' \
    --watch "cmd:\"gh pr view 12 -R acme/app --json state -q .state | grep -qx MERGED\"" \
    --watch 'cmd:"curl -sf https://phase-console-site.vercel.app/api/health/license"'
  [ "$status" -eq 0 ]
  [[ "$output" != *warning* ]]
}

@test "outcome: the console's refused answer at declaration exits 2 with its reason, and nothing is written (WF-3, #125)" {
  fake_console 200 '{"status":200,"verdict":"refused","ref":"cmd:\"npm ci\"","detail":"npm ci writes node_modules","sentence":"refused — cmd:npm ci: npm ci writes node_modules. The console would never run it, so nothing would ever resume this phase: fix the ref and declare again.","refs":[]}'
  run pe_outcome demo 5 waiting-external --wait-minutes 30 --watch 'cmd:"npm ci"'
  [ "$status" -eq 2 ]
  assert_contains "$output" "npm ci writes node_modules"
  [ ! -f "$PE_OUTCOME_FILE" ]
  [ -z "$(ls "$BATS_TEST_TMPDIR" | grep '\.tmp\.' || true)" ]
}

@test "outcome: a cmd: ref wrapping gh run list … --commit is offered a gh: ref in its place (WF-4, #87)" {
  run pe_outcome demo 14 waiting-external --wait-minutes 60 \
    --watch "cmd:\"gh run list -R acme/app --workflow deploy.yml --commit cb590f0e --json status -q '.[0].status' | grep -qx completed\""
  [ "$status" -eq 0 ]
  assert_contains "$output" 'gh:acme/app#run/<id>'
  assert_contains "$output" 'gh run list -R acme/app --workflow deploy.yml --commit cb590f0e --json databaseId'
}

@test "outcome: a cmd:grep over a handoff is warned about and offered phase: — and phase:/verify: are schemes (PW-4, #129)" {
  run pe_outcome demo 50 blocked --needs external --reason "waits on 43" \
    --watch "cmd:\"grep -q '^status: complete' $DOCS_ROOT/docs/handoffs/demo/phase-43-perf-ii.md\""
  [ "$status" -eq 0 ]
  assert_contains "$output" 'phase:demo/43'
  rm -f "$PE_OUTCOME_FILE"
  run pe_outcome demo 50 blocked --needs external --reason "waits on 43" --watch "phase:demo/43" --watch "verify:demo/50"
  [ "$status" -eq 0 ]
  [[ "$output" != *warning* ]]
  assert_contains "$(cat "$PE_OUTCOME_FILE")" '"watch": ["phase:demo/43", "verify:demo/50"],'
  rm -f "$PE_OUTCOME_FILE"
  # A phase cannot wait for its own completion; verify: names the declaring phase.
  run pe_outcome demo 50 blocked --needs external --reason "x" --watch "phase:demo/50"
  [ "$status" -eq 2 ]
  run pe_outcome demo 50 blocked --needs external --reason "x" --watch "verify:demo/43"
  [ "$status" -eq 2 ]
  [ ! -f "$PE_OUTCOME_FILE" ]
}
