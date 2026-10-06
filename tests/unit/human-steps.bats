#!/usr/bin/env bats
# A person's turn (control-tower phase 41) — the human-step LANGUAGE in bash:
# the `- **Human step:**` plan bullet read by `phase-graph.sh --human-steps [N]`
# and held by lints F37 (gating) and F38 (advisory), and the `--step` fields of
# a `phase-outcome.sh … needs-human` declaration, with its secret refusal.
#
# The properties, each load-bearing somewhere:
#
#  - the reader prints ONE line per well-formed step, eight tab-separated
#    fields, and nothing for a bullet the lint refuses — so a typo is never a
#    step the launch door asks for;
#  - the 5.1.0 `<who, what, proof ref>` spelling fails the lint with a sentence
#    naming the grammar that replaced it;
#  - a step with no proof is advised about (F38), never refused;
#  - `--step` rides `needs-human` alone, and a value shaped like a secret is
#    refused with nothing written and the value never echoed.
load ../helpers/test_helper

tab() { printf '\t'; }

# ---- the plan bullet --------------------------------------------------------

@test "--human-steps N: a phase with no bullet prints nothing" {
  setup_docs human-steps human-steps
  run pg human-steps --human-steps 1
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "--human-steps N: every field, in order, auto-open included" {
  setup_docs human-steps human-steps
  run pg human-steps --human-steps 2
  [ "$status" -eq 0 ]
  expected="browser-login$(tab)sign the gh CLI in to the org$(tab)gh auth login --web$(tab)cmd:\"gh auth status\"$(tab)host$(tab)2880$(tab)host$(tab)"
  [ "$output" = "$expected" ]
}

@test "--human-steps N: two steps, each where from its kind when the bullet is silent" {
  setup_docs human-steps human-steps
  run pg human-steps --human-steps 3
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 2 ]
  [ "${lines[0]}" = "device-code$(tab)enter the code the CLI prints$(tab)https://github.com/login/device$(tab)cmd:\"gh auth status\"$(tab)any$(tab)$(tab)$(tab)" ]
  [ "${lines[1]}" = "third-party-approval$(tab)the org owner approves the app$(tab)$(tab)gh:acme/app#pr/7$(tab)any$(tab)4320$(tab)$(tab)" ]
}

@test "--human-steps N: a secret-entry step carries its credential id; a step with no proof is still a step" {
  setup_docs human-steps human-steps
  run pg human-steps --human-steps 4
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 2 ]
  case "${lines[0]}" in *"$(tab)any$(tab)$(tab)$(tab)npm-token") : ;; *) echo "${lines[0]}"; return 1 ;; esac
  [ "${lines[1]}" = "physical$(tab)plug the signing key in$(tab)$(tab)$(tab)host$(tab)$(tab)$(tab)" ]
}

@test "--human-steps N: kind and where in any case, the colon outside the bold, a * bullet" {
  setup_docs human-steps human-steps
  run pg human-steps --human-steps 5
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "os-permission$(tab)grant screen recording to the terminal$(tab)https://support.example.com/screen?tab=privacy$(tab)$(tab)host$(tab)90$(tab)$(tab)" ]
  [ "${lines[1]}" = "person-check$(tab)look at the rendered page on a phone$(tab)$(tab)$(tab)any$(tab)$(tab)host$(tab)" ]
}

@test "--human-steps: with no phase, every step led by its phase number" {
  setup_docs human-steps human-steps
  run pg human-steps --human-steps
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 7 ]
  [ "$(printf '%s\n' "${lines[@]}" | cut -f1 | tr '\n' ' ')" = "2 3 3 4 4 5 5 " ]
}

@test "--human-steps N: a phase the plan does not have is exit 2" {
  setup_docs human-steps human-steps
  run pg human-steps --human-steps 9
  [ "$status" -eq 2 ]
}

@test "lint: well-formed steps pass; a step with no proof is advised about (F38), never refused" {
  setup_docs human-steps human-steps
  run pg human-steps --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK: human-steps"
  assert_contains "$output" "F38 phase 4: human-step-no-proof — the physical step"
  assert_contains "$output" "F38 phase 5: human-step-no-proof — the person-check step"
}

@test "lint: the superseded 5.1.0 spelling fails, naming the grammar that replaced it (F37)" {
  setup_docs bad-human-steps bad-human-steps
  run pg bad-human-steps --lint
  [ "$status" -eq 1 ]
  assert_contains "$output" 'phase 1: human-step-superseded — "- **Human step:** the owner signs the release'
  assert_contains "$output" 'is the 5.1.0 <who, what, proof ref> spelling, which nothing reads; write it as "- **Human step:** <kind> · <what> · open: <url or command> · proof: <ref> · where: host|any · window: <duration> [· auto-open: host] [· due: <ref>]" (F37)'
}

@test "lint: an unknown kind fails by name (F37)" {
  setup_docs bad-human-steps bad-human-steps
  run pg bad-human-steps --lint
  [ "$status" -eq 1 ]
  assert_contains "$output" 'phase 2: human-step-kind-unknown — "credential" is not one of: browser-login'
}

@test "lint: a field the grammar does not have fails by name (F37)" {
  setup_docs bad-human-steps bad-human-steps
  run pg bad-human-steps --lint
  [ "$status" -eq 1 ]
  assert_contains "$output" 'phase 3: human-step-field-invalid — where: "phone" is not one of: host any (F37)'
  assert_contains "$output" 'phase 3: human-step-field-invalid — open: "javascript:alert(1)" is a link that is not http or https (F37)'
  assert_contains "$output" 'phase 3: human-step-field-invalid — credential: belongs to a secret-entry step, not mcp-login (F37)'
  assert_contains "$output" 'phase 3: human-step-field-invalid — "colour: blue" is not a field'
  assert_contains "$output" "LINT FAIL: bad-human-steps (6 issue[s])"
}

@test "--human-steps: a bullet the lint refuses is not a step; the good one beside it is" {
  setup_docs bad-human-steps bad-human-steps
  run pg bad-human-steps --human-steps
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 1 ]
  case "${lines[0]}" in "4$(tab)os-prompt$(tab)unlock the keychain$(tab)"*) : ;; *) echo "$output"; return 1 ;; esac
}

# ---- the declaration ---------------------------------------------------------

outcome_env() {
  scrub_pe_env
  export PE_NOW="2026-09-30T10:00:00Z"
  export PE_OUTCOME_FILE="$BATS_TEST_TMPDIR/outcome.json"
  export PHASE_OUTCOME_PROBE=0
  unset PE_SESSION_ID CLAUDE_CODE_SESSION_ID
  export XDG_STATE_HOME="$BATS_TEST_TMPDIR/state"
  export DOCS_ROOT="$BATS_TEST_TMPDIR/work"
  mkdir -p "$DOCS_ROOT"
}

@test "outcome: needs-human --step writes the step as structured JSON" {
  outcome_env
  run pe_outcome demo 8 needs-human --needs credential --reason "gh is signed out" \
    --step browser-login --title "Sign the gh CLI in" --open-command "gh auth login --web" \
    --proof 'cmd:"gh auth status"' --step-line "Run the command" --step-line "Approve it in the browser"
  [ "$status" -eq 0 ]
  expected='{
  "version": 1,
  "slug": "demo",
  "phase": 8,
  "status": "needs-human",
  "reason": "gh is signed out",
  "needs": "credential",
  "step": {"kind": "browser-login", "title": "Sign the gh CLI in", "open_command": "gh auth login --web", "where": "host", "proof": "cmd:\"gh auth status\"", "lines": ["Run the command","Approve it in the browser"]},
  "watch": [],
  "written_at": "2026-09-30T10:00:00Z"
}'
  [ "$(cat "$PE_OUTCOME_FILE")" = "$expected" ]
}

@test "outcome: a device-code step carries its code; where defaults to the kind's" {
  outcome_env
  run pe_outcome demo 8 needs-human --needs credential --step device-code --title "Enter the code" \
    --open-url https://github.com/login/device --code ABCD-1234
  [ "$status" -eq 0 ]
  grep -q '"step": {"kind": "device-code", "title": "Enter the code", "open_url": "https://github.com/login/device", "where": "any", "code": "ABCD-1234"},' "$PE_OUTCOME_FILE"
}

@test "outcome: --step is refused off needs-human, and its fields are refused without it" {
  outcome_env
  run pe_outcome demo 8 blocked --needs credential --step browser-login --title x
  [ "$status" -eq 2 ]
  assert_contains "$output" "--step is valid only with needs-human"
  run pe_outcome demo 8 needs-human --needs credential --title x
  [ "$status" -eq 2 ]
  run pe_outcome demo 8 ruling --what x --step browser-login
  [ "$status" -eq 2 ]
  [ ! -f "$PE_OUTCOME_FILE" ]
}

@test "outcome: an unknown kind, a missing title, a non-http link, a code or credential on the wrong kind — exit 2" {
  outcome_env
  run pe_outcome demo 8 needs-human --needs credential --step typo --title x
  [ "$status" -eq 2 ]
  assert_contains "$output" "unknown --step kind: typo"
  run pe_outcome demo 8 needs-human --needs credential --step browser-login
  [ "$status" -eq 2 ]
  run pe_outcome demo 8 needs-human --needs credential --step browser-login --title x --open-url 'file:///etc/hosts'
  [ "$status" -eq 2 ]
  run pe_outcome demo 8 needs-human --needs credential --step browser-login --title x --open-url 'javascript:alert(1)'
  [ "$status" -eq 2 ]
  run pe_outcome demo 8 needs-human --needs credential --step browser-login --title x --code ABCD-1234
  [ "$status" -eq 2 ]
  run pe_outcome demo 8 needs-human --needs credential --step secret-entry --title "paste the token"
  [ "$status" -eq 2 ]
  assert_contains "$output" "--credential <id> is required with --step secret-entry"
  run pe_outcome demo 8 needs-human --needs credential --step browser-login --title x --where phone
  [ "$status" -eq 2 ]
  [ ! -f "$PE_OUTCOME_FILE" ]
}

@test "outcome: a session step can never ask to open by itself — there is no --auto-open" {
  outcome_env
  run pe_outcome demo 8 needs-human --needs credential --step browser-login --title x --auto-open host
  [ "$status" -eq 2 ]
  assert_contains "$output" "unknown option: --auto-open"
  [ ! -f "$PE_OUTCOME_FILE" ]
}

@test "outcome: a value shaped like a token, a password, a code or a URL query secret is refused, and never echoed" {
  outcome_env
  # Assembled at run time, so no secret-shaped literal sits in the tree.
  token="gh""p_$(printf 'q%.0s' $(seq 1 36))"
  for args in \
      "--title|use $token to sign in" \
      "--open-url|https://example.com/callback?access_token=Zq81xk2mP0" \
      "--open-url|https://example.com/cb#code=Zq81xk2mP0" \
      "--title|type 493817 at the prompt" \
      "--open-command|security unlock-keychain --password Zq81xk2mP0" \
      "--step-line|password: Zq81xk2mP0" \
      "--proof|cmd:\"curl -H Authorization:Bearer Zq81xk2mP0Zq81xk2mP0Zq81\""; do
    flag="${args%%|*}"; value="${args#*|}"
    if [ "$flag" = --title ]; then
      run pe_outcome demo 8 needs-human --needs credential --step browser-login --title "$value"
    else
      run pe_outcome demo 8 needs-human --needs credential --step browser-login --title "sign in" "$flag" "$value"
    fi
    [ "$status" -eq 2 ] || { echo "$flag $value was accepted"; return 1; }
    assert_contains "$output" "$flag refused: its value is shaped like a secret"
    case "$output" in *Zq81xk2mP0*|*493817*|*"$token"*) echo "the value was echoed: $output"; return 1 ;; esac
    [ ! -f "$PE_OUTCOME_FILE" ]
  done
}

@test "outcome: ordinary words, links and refs pass the secret screen" {
  outcome_env
  run pe_outcome demo 8 needs-human --needs credential --step third-party-approval \
    --title "The org owner approves PR #123456 on acme/app" --open-url "https://github.com/acme/app/pull/123456?tab=files" \
    --proof 'gh:acme/app#pr/123456' --step-line "Open the pull request" --step-line "Press Approve in the review panel"
  [ "$status" -eq 0 ]
  grep -q '"kind": "third-party-approval"' "$PE_OUTCOME_FILE"
}

@test "outcome: the --step vocabulary is the one scripts/human-steps.env carries" {
  outcome_env
  # shellcheck source=/dev/null
  . "$PE_DIR/scripts/human-steps.env"
  set -- $HUMAN_STEP_KINDS
  [ "$#" -eq 17 ]
  for kind in $HUMAN_STEP_KINDS; do
    extra=""
    [ "$kind" = secret-entry ] && extra="--credential some-id"
    # shellcheck disable=SC2086
    run pe_outcome demo 8 needs-human --needs credential --step "$kind" --title "do the thing" $extra
    [ "$status" -eq 0 ] || { echo "$kind refused: $output"; return 1; }
    rm -f "$PE_OUTCOME_FILE"
  done
}

# ---- the operator act (control-tower phase 121, #182) --------------------------

@test "--human-steps 0: the plan's own act under ## Operator errands, with its due ref as a ninth field" {
  setup_docs operator-acts operator-acts
  run pg operator-acts --human-steps 0
  [ "$status" -eq 0 ]
  expected="operator-act$(tab)restart the hub console on the new build$(tab)phase-console update hub --when-idle$(tab)cmd:\"curl -sf http://127.0.0.1:4123/api/state\"$(tab)host$(tab)$(tab)$(tab)$(tab)phase:operator-acts/2"
  [ "$output" = "$expected" ]
}

@test "--human-steps N: an act's due: ref is the ninth field; a step without one keeps its eight" {
  setup_docs operator-acts operator-acts
  run pg operator-acts --human-steps 2
  [ "$status" -eq 0 ]
  [ "$output" = "operator-act$(tab)push the release tag$(tab)git push origin v1.0.0$(tab)gh:acme/app#run/42$(tab)any$(tab)$(tab)$(tab)$(tab)date:2026-10-06T09:00:00Z" ]
  run pg operator-acts --human-steps 3
  [ "$status" -eq 0 ]
  [ "$output" = "browser-login$(tab)sign the gh CLI in$(tab)gh auth login --web$(tab)cmd:\"gh auth status\"$(tab)host$(tab)$(tab)$(tab)" ]
}

@test "--human-steps: the bare listing leads with the plan's own acts, as phase 0" {
  setup_docs operator-acts operator-acts
  run pg operator-acts --human-steps
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 3 ]
  case "${lines[0]}" in "0$(tab)operator-act$(tab)restart the hub"*) : ;; *) echo "$output"; return 1 ;; esac
  case "${lines[1]}" in "2$(tab)operator-act$(tab)push the release tag"*) : ;; *) echo "$output"; return 1 ;; esac
}

@test "lint: an operator act lints clean; a due: that names no watch scheme fails by name (F37)" {
  setup_docs operator-acts operator-acts
  run pg operator-acts --lint
  [ "$status" -eq 0 ]
  printf '%s\n' '- **Human step:** operator-act · rotate the key · due: next tuesday' >> "$DOCS_ROOT/docs/plans/operator-acts.md"
  run pg operator-acts --lint
  [ "$status" -ne 0 ]
  assert_contains "$output" 'human-step-field-invalid — due: "next tuesday" is not a watch ref'
}

@test "lint: a due: in a scheme's name but not its shape fails too — a date with no time, a phase with no number" {
  for bad in 'date:2026-10-06' 'phase:operator-acts' 'unit:-oProxyCommand=x/y' 'gh:acme/app' 'cmd:""'; do
    setup_docs operator-acts operator-acts
    printf '%s\n' "- **Human step:** operator-act · rotate the key · due: \`$bad\`" >> "$DOCS_ROOT/docs/plans/operator-acts.md"
    run pg operator-acts --lint
    [ "$status" -ne 0 ] || { echo "accepted: $bad"; false; }
    assert_contains "$output" "due: \"$bad\" is not a watch ref the console can poll"
  done
}

@test "outcome: --act is --step operator-act, and --due-when rides it as the step's due_when" {
  outcome_env
  run pe_outcome demo 8 needs-human --needs external --act --title "Push the release tag" \
    --open-command "git push origin v1.0.0" --due-when "gh:acme/app#run/42" --proof "gh:acme/app#pr/7"
  [ "$status" -eq 0 ]
  grep -q '"step": {"kind": "operator-act", "title": "Push the release tag", "open_command": "git push origin v1.0.0", "where": "host", "proof": "gh:acme/app#pr/7", "due_when": "gh:acme/app#run/42"},' "$PE_OUTCOME_FILE"
}

@test "outcome: --due-when works with any --step; --act with another --step, or a due-when alone, is exit 2" {
  outcome_env
  run pe_outcome demo 8 needs-human --needs credential --step browser-login --title "Sign in" --due-when "date:2026-10-06T09:00:00Z"
  [ "$status" -eq 0 ]
  grep -q '"due_when": "date:2026-10-06T09:00:00Z"' "$PE_OUTCOME_FILE"
  rm -f "$PE_OUTCOME_FILE"
  run pe_outcome demo 8 needs-human --needs external --act --step decision --title "x"
  [ "$status" -eq 2 ]
  assert_contains "$output" '--act is --step operator-act'
  run pe_outcome demo 8 needs-human --needs external --due-when "phase:demo/7"
  [ "$status" -eq 2 ]
  [ ! -f "$PE_OUTCOME_FILE" ]
}

@test "outcome: a due-when nothing could ever probe is refused — no scheme, a cmd: with a variable, our own lock" {
  outcome_env
  run pe_outcome demo 8 needs-human --needs external --act --title "x" --due-when "next tuesday"
  [ "$status" -eq 2 ]
  assert_contains "$output" '--due-when refused'
  run pe_outcome demo 8 needs-human --needs external --act --title "x" --due-when 'cmd:"test -f $HOME/done"'
  [ "$status" -eq 2 ]
  run pe_outcome demo 8 needs-human --needs external --act --title "x" --due-when "lock:demo/8"
  [ "$status" -eq 2 ]
  [ ! -f "$PE_OUTCOME_FILE" ]
}
