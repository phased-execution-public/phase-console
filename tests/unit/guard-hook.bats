#!/usr/bin/env bats
# guard-hook.sh — a run's local PreToolUse layer (measured-console phase 6, C4).
# It answers the console's deterministic denies — a protected file written, a
# test deleted, a gate forged — with no console running, asking the console's
# own classifier through node; anything else is `{}`, no decision. It must exit
# 0 with JSON whenever it decided: any other exit is a hook failure, which the
# run's `onFailure: "block"` turns into a blocked call.
load ../helpers/test_helper

setup() {
  unset PE_MAY_DELETE_TESTS
  export PE_NODE
  PE_NODE=$(command -v node)
}

guard() { printf '%s' "$1" | "$SYS_BASH" "$PE_SCRIPTS/guard-hook.sh"; }

@test "a call that names nothing protected is answered {} without node" {
  PE_NODE=/nonexistent/node PATH=/usr/bin:/bin run guard '{"tool_name":"Bash","tool_input":{"command":"git status"}}'
  [ "$status" -eq 0 ]
  [ "$output" = "{}" ]
}

@test "deleting a test file is denied, by rm and by git rm inside bash -c" {
  run guard '{"tool_name":"Bash","tool_input":{"command":"rm viewer/test/foo.test.ts"}}'
  [ "$status" -eq 0 ]
  [[ "$output" == *'"permissionDecision":"deny"'* ]]
  [[ "$output" == *'rule: protected-file'* ]]
  run guard '{"tool_name":"Bash","tool_input":{"command":"bash -c '\''git rm -q src/foo.spec.js'\''"}}'
  [ "$status" -eq 0 ]
  [[ "$output" == *'"permissionDecision":"deny"'* ]]
}

@test "May delete tests: yes lifts the test half and only that half" {
  PE_MAY_DELETE_TESTS=yes run guard '{"tool_name":"Bash","tool_input":{"command":"rm viewer/test/foo.test.ts"}}'
  [ "$status" -eq 0 ]
  [ "$output" = "{}" ]
  PE_MAY_DELETE_TESTS=yes run guard '{"tool_name":"Write","tool_input":{"file_path":"viewer/e2e/baseline.json","content":"[]"}}'
  [ "$status" -eq 0 ]
  [[ "$output" == *'"permissionDecision":"deny"'* ]]
}

@test "the baselines, ratchets and snapshots are never writable" {
  for path in viewer/e2e/baseline.json status-ratchet.json known-reds.json scripts/quarantine.env client/__snapshots__/a.snap; do
    run guard "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$path\"}}"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"permissionDecision":"deny"'* ]] || { echo "not denied: $path"; return 1; }
  done
}

@test "a read of a protected file is not denied" {
  run guard '{"tool_name":"Bash","tool_input":{"command":"cat viewer/e2e/baseline.json"}}'
  [ "$status" -eq 0 ]
  [ "$output" = "{}" ]
}

@test "no node to ask is a failure, never a silent allow" {
  PE_NODE=/nonexistent/node PATH=/usr/bin:/bin run guard '{"tool_name":"Bash","tool_input":{"command":"rm a.test.ts"}}'
  [ "$status" -ne 0 ]
  [[ "$output" == *'no node'* ]]
}
