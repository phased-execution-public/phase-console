#!/usr/bin/env bats
# phase-outcome.sh verified — what a session's OWN §Verification proved, keyed by
# the working tree it ran against.
# (One of five files since measured-console phase 7; the shared setup is tests/helpers/outcome_helper.bash.)
load ../helpers/test_helper
load ../helpers/outcome_helper

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

@test "verified: a cd <sub> && … line into ANOTHER repository keys the proof by that repository's tree too (#301)" {
  proof_repo
  export PE_PROOFS_FILE="$BATS_TEST_TMPDIR/proofs.ndjson"
  # The hub shape: a superproject mounting the line's repository.
  hubdir="$BATS_TEST_TMPDIR/hub"
  mkdir -p "$hubdir"
  git -C "$hubdir" init -q
  git -C "$hubdir" config user.email t@t
  git -C "$hubdir" config user.name t
  printf '# hub\n' > "$hubdir/README.md"
  git -C "$hubdir" add -A && git -C "$hubdir" commit -qm init
  git -C "$hubdir" -c protocol.file.allow=always submodule add -q "$REPO" sub
  git -C "$hubdir" commit -qm mount
  printf 'wip\n' > "$hubdir/sub/src/a.ts"
  run pe_outcome demo 5 verified --command "cd sub && npm test" --exit 0 --in "$hubdir"
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_PROOFS_FILE")" "\"tree\":\"$(working_tree "$hubdir")\",\"repo\":\"sub\",\"repo_tree\":\"$(working_tree "$hubdir/sub")\","
  # A cd that stays inside the judged repository, or that the shell must expand, is no key.
  run pe_outcome demo 5 verified --command "cd src && npm test" --exit 0 --in "$REPO"
  [ "$status" -eq 0 ]
  refute_contains "$(tail -1 "$PE_PROOFS_FILE")" '"repo":'
  run pe_outcome demo 5 verified --command 'cd $SUB && npm test' --exit 0 --in "$hubdir"
  [ "$status" -eq 0 ]
  refute_contains "$(tail -1 "$PE_PROOFS_FILE")" '"repo":'
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

# ── verified --in: the run root, never $PWD (control-tower phase 106, #196) ──
# ai-builder-v7 P14 recorded `--in .` from a shell standing INSIDE its
# app-frontend submodule, so its five proofs were keyed by the submodule's
# tree; the console judges those lines (`cd app/app-frontend && …`) at the
# plan root, against the SUPERPROJECT's tree, and refused all five at the verdict.
# A relative --in is now resolved against the run root, the default is where the
# console judges the phase ($PE_VERIFY_DIR), and a tree the judging repository
# does not hold is refused at RECORD time, naming both trees.

proof_superproject() {
  local origin="$BATS_TEST_TMPDIR/origin"
  SUPER="$BATS_TEST_TMPDIR/super"
  mkdir -p "$origin" "$SUPER"
  git -C "$origin" init -q -b main
  printf 'app\n' > "$origin/app.txt"
  git -C "$origin" add -A && git -C "$origin" -c user.email=t@example.invalid -c user.name=t commit -qm init
  git -C "$SUPER" init -q -b main
  printf '# root\n' > "$SUPER/README.md"
  git -C "$SUPER" add -A && git -C "$SUPER" -c user.email=t@example.invalid -c user.name=t commit -qm init
  git -C "$SUPER" -c protocol.file.allow=always submodule add -q "$origin" sub
  git -C "$SUPER" -c user.email=t@example.invalid -c user.name=t commit -qm mount
}

@test "verified --in: '.' from inside a submodule means the RUN ROOT — the tree the console judges" {
  proof_superproject
  export PE_PROOFS_FILE="$BATS_TEST_TMPDIR/proofs.ndjson" PE_RUN_ROOT="$SUPER" PE_VERIFY_DIR="$SUPER"
  run bash -c "cd '$SUPER/sub' && '$SYS_BASH' '$PE_SCRIPTS/phase-outcome.sh' demo 5 verified --command 'cd sub && npm test' --exit 0 --in ."
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_PROOFS_FILE")" "\"tree\":\"$(working_tree "$SUPER")\""
}

@test "verified: with no --in the proof is keyed where the console judges the phase (\$PE_VERIFY_DIR), whatever the cwd" {
  proof_superproject
  export PE_PROOFS_FILE="$BATS_TEST_TMPDIR/proofs.ndjson" PE_RUN_ROOT="$SUPER" PE_VERIFY_DIR="$SUPER/sub"
  run bash -c "cd '$SUPER' && '$SYS_BASH' '$PE_SCRIPTS/phase-outcome.sh' demo 5 verified --command 'npm test' --exit 0"
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_PROOFS_FILE")" "\"tree\":\"$(working_tree "$SUPER/sub")\""
}

@test "verified: a tree the judging repository does not hold is refused at RECORD time, naming both trees" {
  proof_superproject
  export PE_PROOFS_FILE="$BATS_TEST_TMPDIR/proofs.ndjson" PE_RUN_ROOT="$SUPER" PE_VERIFY_DIR="$SUPER"
  sub_tree="$(working_tree "$SUPER/sub")"
  root_tree="$(working_tree "$SUPER")"
  run pe_outcome demo 5 verified --command 'cd sub && npm test' --exit 0 --in sub
  [ "$status" -eq 2 ]
  assert_contains "$output" "not recorded"
  assert_contains "$output" "${sub_tree:0:12}"
  assert_contains "$output" "${root_tree:0:12}"
  [ ! -f "$PE_PROOFS_FILE" ]
}

# ── the ref is checked where it is declared (control-tower phase 88) ─────────
# #125: a 200-character cut silently split a two-check `cmd:` ref mid-word, the
# console refused what was left three seconds later, and the errand went on
# saying it was being watched. #152: a ref carrying the SESSION's shell variable
# (`'$L'`) or a path relative to the session's cwd can never land in the
# console, which runs it from its own root. A ref is now refused while the
# session can still fix it — never cut, never silently kept.
