#!/usr/bin/env bats
# phase-outcome.sh — the console asked at the door (a ref that already landed,
# a refusal, the guard), the watch refs it reads, and `handled`.
# (One of five files since measured-console phase 7; the shared setup is tests/helpers/outcome_helper.bash.)
load ../helpers/test_helper
load ../helpers/outcome_helper

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

@test "outcome: a cmd: ref on gh api names an endpoint, not a path, and is accepted" {
  run pe_outcome demo 5 waiting-external --wait-minutes 5 --watch 'cmd:"gh api repos/o/r/releases/latest"'
  [ "$status" -eq 0 ]
  [[ "$output" != *"relative path"* ]]
  run pe_outcome demo 5 waiting-external --wait-minutes 5 \
    --watch "cmd:\"gh api -H 'Accept: application/vnd.github+json' marketplace_listing/plans/x --jq .name\""
  [ "$status" -eq 0 ]
  [[ "$output" != *"relative path"* ]]
  # A path elsewhere in the same command is still refused.
  run pe_outcome demo 5 waiting-external --wait-minutes 5 --watch 'cmd:"gh api meta/o/c --input out/body.json"'
  [ "$status" -eq 2 ]
  assert_contains "$output" 'relative path'
}

@test "outcome: the console's refused answer at declaration exits 2 with its reason, and nothing is written (WF-3, #125)" {
  fake_console 200 '{"status":200,"verdict":"refused","ref":"cmd:\"npm ci\"","detail":"npm ci writes node_modules","sentence":"refused — cmd:npm ci: npm ci writes node_modules. The console would never run it, so nothing would ever resume this phase: fix the ref and declare again.","refs":[]}'
  run pe_outcome demo 5 waiting-external --wait-minutes 30 --watch 'cmd:"npm ci"'
  [ "$status" -eq 2 ]
  assert_contains "$output" "npm ci writes node_modules"
  [ ! -f "$PE_OUTCOME_FILE" ]
  [ -z "$(ls "$BATS_TEST_TMPDIR" | grep '\.tmp\.' || true)" ]
}

@test "outcome: the guard at the door — a step is judged with no ref to probe, and G4's refusal exits 4 with nothing written (control-tower phase 130)" {
  fake_console 200 '{"status":200,"verdict":"guard","rule":"G4","exit":4,"sentence":"the AI can do this itself: this run'"'"'s own policy allows every command the guide asks for (`npm test`) — run them, then carry on.","commands":["npm test"],"refs":[]}'
  run pe_outcome demo 5 needs-human --needs human-acts --act --title "Run the tests" --why reserved --proof-type attest
  [ "$status" -eq 4 ]
  assert_contains "$output" "refused (G4): the AI can do this itself"
  assert_contains "$output" "exit 4"
  [ ! -f "$PE_OUTCOME_FILE" ]
  [ -z "$(ls "$BATS_TEST_TMPDIR" | grep '\.tmp\.' || true)" ]
  grep -q '"file":"[^"]*/outcome\.json\.tmp\.[0-9][0-9]*"' "$FAKE_CURL_LOG"
  # A G1 refusal from the console carries its own exit, 2.
  fake_console 200 '{"status":200,"verdict":"guard","rule":"G1","exit":2,"sentence":"a decision step is not asked for because of identity","refs":[]}'
  run pe_outcome demo 5 needs-human --needs human-acts --step decision --title "Pick"
  [ "$status" -eq 2 ]
  assert_contains "$output" "refused (G1)"
  # A pass is pending: the step is written as before.
  fake_console 200 '{"status":200,"verdict":"pending","refs":[]}'
  run pe_outcome demo 5 needs-human --needs human-acts --step decision --title "Pick"
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_OUTCOME_FILE")" '"kind": "decision"'
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

# ---- a job on another machine, and a date that only bounds a live ref (control-tower phase 121, #181)

@test "outcome: a unit:<host>/<unit> ref is a watch scheme — recorded with no warning" {
  run pe_outcome demo 8 waiting-external --reason "the nightly build runs on the box" \
    --watch "unit:build-box/nightly-build.service" --wait-minutes 30
  [ "$status" -eq 0 ]
  [[ "$output" != *'will never be checked'* ]]
  grep -q '"watch": \["unit:build-box/nightly-build.service"\]' "$PE_OUTCOME_FILE"
}

@test "outcome: a unit: ref the console could not run safely is refused, nothing written" {
  for bad in 'unit:-oProxyCommand=sh/x.service' 'unit:build-box/x;reboot' 'unit:build-box/' 'unit:/x.service' 'unit:build box/x' 'unit:build-box/$(id)'; do
    rm -f "$PE_OUTCOME_FILE"
    run pe_outcome demo 8 waiting-external --reason "box" --watch "$bad"
    [ "$status" -eq 2 ] || { echo "accepted $bad: $output"; return 1; }
    assert_contains "$output" 'unit:<host>/<unit>'
    [ ! -f "$PE_OUTCOME_FILE" ]
  done
}

@test "outcome: a date: beside a live ref is named as the BACKSTOP — the ref wakes it, the date only bounds it" {
  run pe_outcome demo 8 waiting-external --reason "the box job" \
    --watch "unit:build-box/nightly-build.service" --watch "date:2026-10-06T09:00:00Z"
  [ "$status" -eq 0 ]
  assert_contains "$output" 'date:2026-10-06T09:00:00Z is the backstop'
  assert_contains "$output" 'unit:build-box/nightly-build.service wakes the phase the moment it lands'
  grep -q '"watch": \["unit:build-box/nightly-build.service", "date:2026-10-06T09:00:00Z"\]' "$PE_OUTCOME_FILE"
  # --until is the same backstop, spelled as a clock.
  rm -f "$PE_OUTCOME_FILE"
  run pe_outcome demo 8 waiting-external --reason "ci" --watch "gh:acme/app#run/42" --until "2026-10-06T09:00:00Z"
  [ "$status" -eq 0 ]
  assert_contains "$output" '--until 2026-10-06T09:00:00Z is the backstop'
  # A date alone is a clock, not a backstop: nothing to say.
  rm -f "$PE_OUTCOME_FILE"
  run pe_outcome demo 8 waiting-external --reason "soak" --watch "date:2026-10-06T09:00:00Z"
  [ "$status" -eq 0 ]
  [[ "$output" != *'backstop'* ]]
}

# ---- handled (control-tower phase 136, #213): what a session did instead of asking ----

@test "outcome: handled appends ONE row to the sessions' handled file — never an outcome, links held to their kinds" {
  export PE_HANDLED_FILE="$BATS_TEST_TMPDIR/handled-sessions.ndjson"
  run pe_outcome demo 3 handled --what "Ran the migration myself" --note "the policy allows it" \
    --link commit:abc1234 --link '#12' --link https://github.com/o/r/pull/5 --link journal:demo/r1#40
  [ "$status" -eq 0 ]
  [[ "$output" == *"handled recorded: demo phase 3"* ]]
  [ ! -e "$PE_OUTCOME_FILE" ]
  [ "$(wc -l < "$PE_HANDLED_FILE" | tr -d ' ')" = 1 ]
  line="$(cat "$PE_HANDLED_FILE")"
  [[ "$line" == *'"source":"session","slug":"demo","phase":3'* ]]
  [[ "$line" == *'"what":"Ran the migration myself","note":"the policy allows it","count":1'* ]]
  [[ "$line" == *'"links":["commit:abc1234","#12","https://github.com/o/r/pull/5","journal:demo/r1#40"]'* ]]
  [[ "$line" == *'"at":"2026-08-10T21:10:03Z"'* ]]
  [ "$(stat -f '%Lp' "$PE_HANDLED_FILE" 2>/dev/null || stat -c '%a' "$PE_HANDLED_FILE")" = 600 ]
}

@test "outcome: handled refuses a link of another shape, a secret in any field, and another shape's flags — nothing written" {
  export PE_HANDLED_FILE="$BATS_TEST_TMPDIR/handled-sessions.ndjson"
  run pe_outcome demo 3 handled --what "x" --link https://evil.example/a
  [ "$status" -eq 2 ]; [[ "$output" == *"not a commit, a pull request, an issue or a journal line"* ]]
  run pe_outcome demo 3 handled --what "used ghp_abcdefghijklmnopqrstuvwxyz0123456789"
  [ "$status" -eq 2 ]; [[ "$output" != *"ghp_"* ]]
  run pe_outcome demo 3 handled --what "x" --note "password=hunter2hunter2"
  [ "$status" -eq 2 ]
  run pe_outcome demo 3 handled --what "x" --reason "y"
  [ "$status" -eq 2 ]; [[ "$output" == *"handled takes --what, --note and --link only"* ]]
  run pe_outcome demo 3 handled --note "no what"
  [ "$status" -eq 2 ]; [[ "$output" == *"--what is required for handled"* ]]
  run pe_outcome demo 3 ruling --what "x" --link '#3'
  [ "$status" -eq 2 ]; [[ "$output" == *"only make sense with handled"* ]]
  [ ! -e "$PE_HANDLED_FILE" ]
}

@test "outcome: handled with no runner writes the sessions' handled file under the instance state — never the console's own log" {
  run pe_outcome demo 3 handled --what "Rebased the branch"
  [ "$status" -eq 0 ]
  [[ "$output" == *"PE_HANDLED_FILE is not set"* ]]
  found="$(find "$XDG_STATE_HOME" -name handled-sessions.ndjson | head -1)"
  [ -n "$found" ]
  grep -q '"what":"Rebased the branch"' "$found"
  [ -z "$(find "$XDG_STATE_HOME" -name handled.ndjson | head -1)" ]
}
