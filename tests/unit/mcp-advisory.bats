#!/usr/bin/env bats
# F15 — a plan naming an MCP server this machine has not registered warns at
# lint time, never gates. Same tier and same reasoning as F14: the autopilot's
# preflight parks such a phase at boarding, so the author should hear it while
# the plan is still open in front of them. Exit codes and the LINT OK line never
# move.
#
# The registry belongs to the console, so bash is TOLD rather than asked:
# PE_MCP_SERVERS carries the configured ids. Unset disables the check outright —
# a bare skill install has no registry to disagree with, and inventing a failure
# there would be a lie.
load ../helpers/test_helper

@test "F15: unset PE_MCP_SERVERS means no console, so no advisory at all" {
  setup_docs mcp mcp
  unset PE_MCP_SERVERS
  run pg mcp --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
  refute_contains "$output" "F15"
}

@test "F15: a server the registry lacks is named, exit stays 0" {
  setup_docs mcp mcp
  export PE_MCP_SERVERS="context7 github"
  run pg mcp --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
  assert_contains "$output" "F15 phase 3"
  assert_contains "$output" "playwright, sentry"
}

@test "F15: a fully registered plan stays silent" {
  setup_docs mcp mcp
  export PE_MCP_SERVERS="context7 github playwright sentry"
  run pg mcp --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" "F15"
}

@test "F15: a comma-separated registry is read the same as a spaced one" {
  setup_docs mcp mcp
  export PE_MCP_SERVERS="context7,github,playwright,sentry"
  run pg mcp --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" "F15"
}

@test "F15: an empty registry is a real answer and does warn" {
  setup_docs mcp mcp
  export PE_MCP_SERVERS=""
  run pg mcp --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "F15 plan"
  assert_contains "$output" "context7"
}

@test "F15: the plan-wide line is reported once, not again on every phase" {
  # Phase 2 names only `context7`, which the plan line already named. Repeating
  # it there would put the same fact on every row of a large plan.
  setup_docs mcp mcp
  export PE_MCP_SERVERS=""
  run pg mcp --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" "F15 phase 2"
}

@test "F15: a done phase is not nagged about history" {
  setup_docs mcp mcp
  export PE_MCP_SERVERS="context7 github"
  write_handoff mcp 3 adds-two complete
  run pg mcp --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" "F15 phase 3"
}

@test "F15: a closed plan is not scanned" {
  setup_docs mcp mcp
  export PE_MCP_SERVERS=""
  pe_close mcp --reason "done with it" >/dev/null 2>&1 || true
  run pg mcp --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" "F15"
}

@test "F15: a plan naming no servers never warns, whatever the registry says" {
  setup_docs linear linear
  export PE_MCP_SERVERS=""
  run pg linear --lint
  [ "$status" -eq 0 ]
  refute_contains "$output" "F15"
}

@test "F15: validate.sh inherits the advisory without failing" {
  setup_docs mcp mcp
  export PE_MCP_SERVERS="context7 github"
  run pe_validate mcp
  [ "$status" -eq 0 ]
  assert_contains "$output" "F15 phase 3"
  assert_contains "$output" "VALIDATE OK"
}

# --- mcp-8: the consequence F15 names must be the one the console will produce.
#
# The policy has three levels — the phase's bullet, the plan's §Session budget
# line, then the RUN's setting — and bash can read only the first two out of the
# plan in front of it. So a console set to `require`, against a plan that says
# nothing, was told "phases will run without them and report it" while what
# would actually happen is every phase parking at boarding.
#
# PE_MCP_POLICY is how the console states its own default, the same "told, not
# asked" arrangement as PE_MCP_SERVERS — and unset means the same thing there
# too: no console, so no claim. `validate.sh` shells the engine by hand.

@test "F15: PE_MCP_POLICY=require makes the consequence the park it will be" {
  setup_docs mcp mcp
  export PE_MCP_SERVERS="context7 github"
  export PE_MCP_POLICY=require
  run pg mcp --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
  assert_contains "$output" "F15 phase 3"
  assert_contains "$output" "park"
  refute_contains "$output" "will run without them and report it"
}

@test "F15: PE_MCP_POLICY=continue keeps the run-without-them wording" {
  setup_docs mcp mcp
  export PE_MCP_SERVERS="context7 github"
  export PE_MCP_POLICY=continue
  run pg mcp --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "F15 phase 3"
  assert_contains "$output" "run without them"
}

@test "F15: unset PE_MCP_POLICY is a third state — the default wording, never require" {
  setup_docs mcp mcp
  export PE_MCP_SERVERS="context7 github"
  unset PE_MCP_POLICY
  run pg mcp --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "F15 phase 3"
  assert_contains "$output" "run without them"
}

@test "F15: garbage in PE_MCP_POLICY is silence, not require" {
  setup_docs mcp mcp
  export PE_MCP_SERVERS="context7 github"
  export PE_MCP_POLICY="REQUIRE-ish nonsense"
  run pg mcp --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "run without them"
}

@test "mcp-8: the PLAN still outranks the console — --mcp-policy reports the plan alone" {
  # `effective_mcp_policy` is deliberately a SEPARATE function from
  # `mcp_policy_for_phase`: --mcp-policy is what the JS parser is held to by
  # engine-parity, and it must keep meaning "what the plan says". Only F15's
  # consequence wording needs the resolved answer.
  # The `mcp` fixture names servers but states no policy anywhere, which is the
  # case that matters: the plan is SILENT, so --mcp-policy must stay silent too
  # even while F15 reports the console's `require` as the consequence.
  setup_docs mcp mcp
  export PE_MCP_SERVERS="context7"
  export PE_MCP_POLICY=require
  run pg mcp --mcp-policy 3
  [ "$status" -eq 0 ]
  refute_contains "$output" "require"

  # …and the very same invocation's lint DOES say park, which is the whole
  # point of the two functions being separate.
  run pg mcp --lint
  assert_contains "$output" "park"
}
