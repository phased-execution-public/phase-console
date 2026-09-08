#!/usr/bin/env bats
# phase-outcome.sh — the machine-readable session outcome. Born from a live run:
# a phase-8 session that had done real work ended its turn "waiting on the image
# build (34-65 min)" in free prose, the runner read the clean exit as completion,
# found no handoff, and halted the run. The outcome file is the record the
# runner reads instead of guessing; these tests pin the exact JSON (the runner's
# parser and the journal both consume it verbatim).
load ../helpers/test_helper

setup() {
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

@test "outcome: reason newlines and quotes are sanitised for JSON" {
  reason="$(printf 'line one\nline "two"')"
  run pe_outcome demo 8 blocked --reason "$reason"
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_OUTCOME_FILE")" '"reason": "line one line \"two\"",'
}

@test "outcome: without PE_OUTCOME_FILE the JSON goes to the console's inbox for this root AND to stdout, exit stays 0" {
  unset PE_OUTCOME_FILE
  run pe_outcome demo 8 waiting-external --until 2026-08-10T21:40:00Z
  [ "$status" -eq 0 ]
  assert_contains "$output" '"status": "waiting-external",'
  assert_contains "$output" 'PE_OUTCOME_FILE is not set'
  # runs/<sha256(root)[:8]-basename>/<slug>/outcomes/phase-NN.json — what the
  # convergence loop watches for a session nobody supervises.
  f="$(inbox_dir demo)/phase-08.json"
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
  [ -f "$XDG_STATE_HOME/phase-console/runs/$id/demo/outcomes/phase-02.json" ]
}

@test "outcome: an unwritable state home still prints the JSON and exits 0" {
  unset PE_OUTCOME_FILE
  export XDG_STATE_HOME="/dev/null/nowhere"
  run pe_outcome demo 8 blocked --reason "x"
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
  run pe_outcome demo 8 needs-human --reason "a person must sign the release" --until 2026-09-01T09:00:00Z
  [ "$status" -eq 0 ]
  grep -q '"resume_after": "2026-09-01T09:00:00Z"' "$PE_OUTCOME_FILE"
  grep -q '"status": "needs-human"' "$PE_OUTCOME_FILE"

  run pe_outcome demo 8 blocked --reason "waiting on the lock" --wait-minutes 90
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
  expected='{"version":1,"type":"ruling","slug":"demo","phase":5,"kind":"deviation","what":"kept the old field","why":"a reader predating it still exists","cost_if_wrong":"one dead branch","at":"2026-08-10T21:10:03Z"}'
  [ "$(cat "$PE_RULINGS_FILE")" = "$expected" ]

  PE_NOW="2026-08-10T22:00:00Z" run pe_outcome demo 6 ruling --what "left the sub-case to phase 9"
  [ "$status" -eq 0 ]
  # Appended, not replaced: two lines, the first untouched.
  [ "$(wc -l < "$PE_RULINGS_FILE" | tr -d ' ')" = "2" ]
  [ "$(head -1 "$PE_RULINGS_FILE")" = "$expected" ]
  second='{"version":1,"type":"ruling","slug":"demo","phase":6,"kind":"ambiguity","what":"left the sub-case to phase 9","at":"2026-08-10T22:00:00Z"}'
  [ "$(tail -1 "$PE_RULINGS_FILE")" = "$second" ]
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
    "$SYS_BASH" "$PE_SCRIPTS/phase-outcome.sh" myslug 3 blocked --reason "lock held"
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
