#!/usr/bin/env bats
# phase-outcome.sh — where a declaration goes with no runner, how its file is named,
# the usage it refuses, the resume clocks, and the trace it carries.
# (One of five files since measured-console phase 7; the shared setup is tests/helpers/outcome_helper.bash.)
load ../helpers/test_helper
load ../helpers/outcome_helper

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
