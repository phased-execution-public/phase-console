#!/usr/bin/env bats
# Your turn (control-tower phase 130, #207) — the language in bash: a reason
# only a person fits (`--why`, the plan bullet's `why:`), a full guide
# (`--guide`), a proof a person can read, and the guard's door-side rules in
# `phase-outcome.sh`: G1 a reason the kind allows (exit 2 by name; none named
# is the kind's default, marked inferred), G2 a proof unless the answer is the
# result (attest only by name), G4 a `reach` with no `--tried` (exit 4), G6
# the secret screen on every line of a guide. The console's half of G4 — a
# guide whose every command the run's policy allows — is turn-guard.test.ts.
load ../helpers/test_helper

tab() { printf '\t'; }

outcome_env() {
  scrub_pe_env
  export PE_NOW="2026-10-06T10:00:00Z"
  export PE_OUTCOME_FILE="$BATS_TEST_TMPDIR/outcome.json"
  export PHASE_OUTCOME_PROBE=0
  unset PE_SESSION_ID CLAUDE_CODE_SESSION_ID
  export XDG_STATE_HOME="$BATS_TEST_TMPDIR/state"
  export DOCS_ROOT="$BATS_TEST_TMPDIR/work"
  mkdir -p "$DOCS_ROOT"
}

guide_file() {
  cat > "$BATS_TEST_TMPDIR/guide.md" <<'GUIDE'
Signing in lets the run push its branch.

## Steps
1. Run the sign-in.
   ```sh
   gh auth login
   ```
   Expect: a browser opens.
   Link: [GitHub](https://github.com/login)

## If it goes wrong
- The browser never opens — open the link yourself.
GUIDE
  printf '%s' "$BATS_TEST_TMPDIR/guide.md"
}

signin() { pe_outcome demo 8 needs-human --needs credential --step browser-login --title "Sign gh in" "$@"; }

# ---- G1 — a reason --------------------------------------------------------

@test "turn: no --why — the kind's default is written, marked inferred" {
  outcome_env
  run signin --proof 'cmd:"gh auth status"'
  [ "$status" -eq 0 ]
  grep -q '"why": "identity", "why_source": "inferred"' "$PE_OUTCOME_FILE"
}

@test "turn: --why the kind allows is written as declared; --act keeps working without one" {
  outcome_env
  run signin --why secret --proof 'cmd:"gh auth status"'
  [ "$status" -eq 0 ]
  grep -q '"why": "secret", "why_source": "declared"' "$PE_OUTCOME_FILE"
  run pe_outcome demo 8 needs-human --needs human-acts --act --title "Restart the box" --open-command "launchctl kickstart x" --proof 'cmd:"true"'
  [ "$status" -eq 0 ]
  grep -q '"kind": "operator-act"' "$PE_OUTCOME_FILE"
  grep -q '"why": "reserved", "why_source": "inferred"' "$PE_OUTCOME_FILE"
}

@test "turn: a reason the kind does not allow is refused by name, exit 2, nothing written" {
  outcome_env
  run signin --why money --proof 'cmd:"gh auth status"'
  [ "$status" -eq 2 ]
  [[ "$output" == *"--why money refused: a browser-login step is not asked for because of money — its reasons are: identity secret"* ]]
  [ ! -e "$PE_OUTCOME_FILE" ]
  run signin --why vibes --proof 'cmd:"gh auth status"'
  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown --why vibes"* ]]
}

@test "turn: --why stays a ruling's reasoning when no step is declared" {
  outcome_env
  export PE_RULINGS_FILE="$BATS_TEST_TMPDIR/rulings.ndjson"
  run pe_outcome demo 8 ruling --what "kept the old name" --why "the plan never renamed it"
  [ "$status" -eq 0 ]
  grep -q 'the plan never renamed it' "$PE_RULINGS_FILE"
}

# ---- G2 — a proof ---------------------------------------------------------

@test "turn: a step with no proof is refused (G2); attest only by name; a decision is answered" {
  outcome_env
  run signin
  [ "$status" -eq 2 ]
  [[ "$output" == *"needs a proof"*"--proof-type attest"* ]]
  [ ! -e "$PE_OUTCOME_FILE" ]
  run signin --proof-type attest
  [ "$status" -eq 0 ]
  grep -q '"proof_type": "attest"' "$PE_OUTCOME_FILE"
  run pe_outcome demo 8 needs-human --needs human-acts --step decision --title "Pick one" \
    --option eu=Europe::data\ stays\ in\ the\ EU --option us=US --recommended eu --allow-decline
  [ "$status" -eq 0 ]
  grep -q '"options": \[{"id": "eu", "label": "Europe", "consequence": "data stays in the EU"}, {"id": "us", "label": "US"}\], "recommended": "eu", "allow_decline": true' "$PE_OUTCOME_FILE"
  run signin --proof-words "gh auth status names the org"
  [ "$status" -eq 0 ]
  grep -q '"proof_words": "gh auth status names the org"' "$PE_OUTCOME_FILE"
  run signin --proof-type probe
  [ "$status" -eq 2 ]
  run pe_outcome demo 8 needs-human --needs human-acts --step decision --title "x" --option a=A --recommended b
  [ "$status" -eq 2 ]
  [[ "$output" == *"--recommended b names no --option"* ]]
}

# ---- a decision's key (control-tower phase 140, phase 133's deferral) -------

@test "turn: --decision-key names the ## Decisions row a decision's answer is written to" {
  outcome_env
  run pe_outcome demo 8 needs-human --needs ambiguity --step decision --title "Which region?" \
    --option eu=Europe --option us=US --decision-key ambiguity
  [ "$status" -eq 0 ]
  grep -q '"decision_key": "ambiguity"' "$PE_OUTCOME_FILE"
  rm -f "$PE_OUTCOME_FILE"
  run pe_outcome demo 8 needs-human --needs ambiguity --step decision --title "x" --option a=A --decision-key vibes
  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown --decision-key vibes"* ]]
  [ ! -e "$PE_OUTCOME_FILE" ]
  run signin --proof 'cmd:"gh auth status"' --decision-key ambiguity
  [ "$status" -eq 2 ]
  [[ "$output" == *"--decision-key belongs to a decision"* ]]
  [ ! -e "$PE_OUTCOME_FILE" ]
}

# ---- the guide --------------------------------------------------------------

@test "turn: --guide is carried whole, with its language, effort, unblocks, window and due" {
  outcome_env
  g="$(guide_file)"
  run signin --proof 'cmd:"gh auth status"' --guide "$g" --lang fa --effort 1h --unblocks 9,other/4 --window 2d --due 2026-10-07T09:00
  [ "$status" -eq 0 ]
  grep -q '"guide": {"text": "Signing in lets the run push its branch.\\n\\n## Steps\\n1. Run the sign-in.' "$PE_OUTCOME_FILE"
  grep -q '"lang": "fa"}' "$PE_OUTCOME_FILE"
  grep -q '"effort": 60' "$PE_OUTCOME_FILE"
  grep -q '"window_minutes": 2880' "$PE_OUTCOME_FILE"
  grep -q '"unblocks": \["9", "other/4"\]' "$PE_OUTCOME_FILE"
  grep -q '"due_when": "date:2026-10-07T09:00"' "$PE_OUTCOME_FILE"
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$PE_OUTCOME_FILE"
}

@test "turn: a guide line shaped like a secret is refused by its number, never echoed (G6)" {
  outcome_env
  printf 'Why.\n\n## Steps\n1. Paste ghp_abcdefghijklmnopqrstuvwxyz0123456789AB here\n' > "$BATS_TEST_TMPDIR/bad.md"
  run signin --proof-type attest --guide "$BATS_TEST_TMPDIR/bad.md"
  [ "$status" -eq 2 ]
  [[ "$output" == *"line 4 carries a secret-shaped value"* ]]
  [[ "$output" != *"ghp_abcdefghij"* ]]
  [ ! -e "$PE_OUTCOME_FILE" ]
}

@test "turn: a guide links http and https only, holds 20 steps and 24 KB at most" {
  outcome_env
  printf 'Why.\n\n## Steps\n1. Open it\n   Link: [x](file:///etc/hosts)\n' > "$BATS_TEST_TMPDIR/link.md"
  run signin --proof-type attest --guide "$BATS_TEST_TMPDIR/link.md"
  [ "$status" -eq 2 ]
  [[ "$output" == *"http and https only"* ]]
  { printf 'Why.\n\n## Steps\n'; for i in $(seq 1 21); do printf '%s. Step %s\n' "$i" "$i"; done; } > "$BATS_TEST_TMPDIR/many.md"
  run signin --proof-type attest --guide "$BATS_TEST_TMPDIR/many.md"
  [ "$status" -eq 2 ]
  [[ "$output" == *"20 steps at most"* ]]
  head -c 25000 /dev/zero | tr '\0' 'a' > "$BATS_TEST_TMPDIR/big.md"
  run signin --proof-type attest --guide "$BATS_TEST_TMPDIR/big.md"
  [ "$status" -eq 2 ]
  [[ "$output" == *"24576 bytes at most"* ]]
  run signin --proof-type attest --lang fa
  [ "$status" -eq 2 ]
  [[ "$output" == *"--lang is the language of --guide"* ]]
}

# ---- G4 — reach, at the door ------------------------------------------------

@test "turn: reach with no --tried is refused, exit 4 — try it, then say what happened" {
  outcome_env
  run pe_outcome demo 8 needs-human --needs external --act --title "Open the VPN" --why reach --proof-type attest
  [ "$status" -eq 4 ]
  [[ "$output" == *"try it, then say what happened"* ]]
  [ ! -e "$PE_OUTCOME_FILE" ]
  run pe_outcome demo 8 needs-human --needs external --act --title "Open the VPN" --why reach --proof-type attest \
    --tried "curl https://intra.example timed out after 30 s"
  [ "$status" -eq 0 ]
  grep -q '"tried": "curl https://intra.example timed out after 30 s"' "$PE_OUTCOME_FILE"
}

@test "turn: a sign-in is the person's — a declared identity reason is never judged by G4" {
  outcome_env
  run signin --why identity --open-command "gh auth login" --proof 'cmd:"gh auth status"'
  [ "$status" -eq 0 ]
}

# ---- the plan bullet ----------------------------------------------------------

@test "turn: --human-steps prints why, effort, unblocks and guide after the due field" {
  setup_docs turn turn
  run pg turn --human-steps 1
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "browser-login$(tab)sign the gh CLI in$(tab)gh auth login$(tab)cmd:\"gh auth status\"$(tab)host$(tab)$(tab)$(tab)$(tab)$(tab)identity$(tab)5$(tab)2,3$(tab)guides/gh-sign-in.md" ]
  [ "${lines[1]}" = "decision$(tab)pick the region$(tab)$(tab)$(tab)any$(tab)$(tab)$(tab)$(tab)$(tab)money$(tab)60$(tab)$(tab)" ]
}

@test "turn: a bullet with no why: is an advisory (F40), never a gate" {
  setup_docs turn turn
  run pg turn --lint
  [ "$status" -eq 0 ]
  [[ "$output" == *"F40 phase 2: human-step-no-why — the operator-act step \"restart the box\" names no why:"*"(reserved)"* ]]
  run pg turn --human-steps 2
  [ "$output" = "operator-act$(tab)restart the box$(tab)sudo systemctl restart app$(tab)cmd:\"true\"$(tab)host$(tab)$(tab)$(tab)" ]
}

@test "turn: a why: the kind does not allow, or a guide: outside the docs root, fails F37" {
  setup_docs turn turn
  sed -i.bak 's/why: Money · effort: 1h/why: physical · effort: 1h/' "$DOCS_ROOT/docs/plans/turn.md"
  printf -- '- **Human step:** operator-act · flip it · proof: `cmd:"true"` · why: reserved · guide: /etc/passwd\n' >> "$DOCS_ROOT/docs/plans/turn.md"
  run pg turn --lint
  [ "$status" -ne 0 ]
  [[ "$output" == *"human-step-field-invalid — why: \"physical\" is not a reason a decision step is asked for"* ]]
  [[ "$output" == *"human-step-field-invalid — guide: \"/etc/passwd\" is not a path under the docs root"* ]]
}
