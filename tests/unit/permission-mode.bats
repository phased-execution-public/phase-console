#!/usr/bin/env bats
# `**Permission mode:**` — which `--permission-mode` a phase's session is
# started in (control-tower phase 11, #34). Two shapes: a plan-wide line in
# §Session budget and a per-phase `- **Permission mode:**` bullet, answered by
# `--permission-mode [N]` as `mode<TAB>phase|plan`.
#
# Four properties, each load-bearing somewhere:
#
#  - the PHASE outranks the plan — a permission mode is one answer, so the more
#    specific statement wins (overrides, never unions, as `MCP policy:` does);
#  - silence prints NOTHING: "the plan never said" must not read like "the plan
#    chose acceptEdits", or the run's own default could never answer;
#  - the word is matched case-insensitively and printed the way the CLI spells
#    it, because the console hands it to `claude --permission-mode` verbatim;
#  - a word that is not a mode falls through to the next level for the READER
#    and fails the LINT by name (F31 `permission-mode-unknown`).
load ../helpers/test_helper

@test "--permission-mode: with no phase, the plan-wide line alone" {
  setup_docs permission-mode permission-mode
  run pg permission-mode --permission-mode
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'plan\tplan')" ]
}

@test "--permission-mode N: a phase with no bullet inherits the plan's line" {
  setup_docs permission-mode permission-mode
  run pg permission-mode --permission-mode 1
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'plan\tplan')" ]
}

@test "--permission-mode N: the phase's bullet overrides the plan's line" {
  setup_docs permission-mode permission-mode
  run pg permission-mode --permission-mode 2
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'acceptEdits\tphase')" ]
}

@test "--permission-mode N: a phase restating the plan's word is still the phase's answer" {
  setup_docs permission-mode permission-mode
  run pg permission-mode --permission-mode 3
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'plan\tphase')" ]
}

@test "--permission-mode N: a word that is not a mode falls through to the plan" {
  # The reader never invents a mode and never drops to the default silently —
  # the lint below is what names the typo.
  setup_docs permission-mode permission-mode
  run pg permission-mode --permission-mode 4
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'plan\tplan')" ]
}

@test "--permission-mode N: backticks and case do not change the answer — the CLI's spelling comes out" {
  setup_docs permission-mode permission-mode
  run pg permission-mode --permission-mode 5
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'dontAsk\tphase')" ]
}

@test "--permission-mode: a plan that says nothing prints nothing, not 'acceptEdits'" {
  setup_docs mcp-policy mcp-policy
  run pg mcp-policy --permission-mode
  [ "$status" -eq 0 ]
  [ "$output" = "" ]
  run pg mcp-policy --permission-mode 1
  [ "$status" -eq 0 ]
  [ "$output" = "" ]
}

@test "--permission-mode: a plan with no §Session budget at all is not an error" {
  setup_docs linear linear
  run pg linear --permission-mode 1
  [ "$status" -eq 0 ]
  [ "$output" = "" ]
}

@test "--permission-mode N: a phase the plan does not have is refused" {
  setup_docs permission-mode permission-mode
  run pg permission-mode --permission-mode 9
  [ "$status" -eq 2 ]
  [[ "$output" == *"phase 9 is not in this plan"* ]]
}

@test "--permission-mode N: a padded phase number is the phase" {
  setup_docs permission-mode permission-mode
  run pg permission-mode --permission-mode 02
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf 'acceptEdits\tphase')" ]
}

@test "F31: a bullet whose word is not a mode fails the lint, by name" {
  setup_docs permission-mode permission-mode
  run pg permission-mode --lint
  [ "$status" -eq 1 ]
  [[ "$output" == *'phase 4: permission-mode-unknown — "- **Permission mode:** whenever"'*'(F31)'* ]]
  # The phases that DO name a mode — any case, backticked or not — are clean.
  [[ "$output" != *"phase 5:"* ]]
  [[ "$output" != *"phase 2:"* ]]
}

@test "F31: a plan-wide line whose word is not a mode fails the lint too" {
  setup_docs permission-mode permission-mode
  sed -i.bak 's/^\*\*Permission mode:\*\* plan$/**Permission mode:** planned/' "$DOCS_ROOT/docs/plans/permission-mode.md"
  run pg permission-mode --lint
  [ "$status" -eq 1 ]
  [[ "$output" == *'permission-mode-unknown — **Permission mode:** "planned"'*'(F31)'* ]]
}

@test "F31: a plan whose every word is a mode lints clean" {
  setup_docs permission-mode permission-mode
  sed -i.bak 's/^- \*\*Permission mode:\*\* whenever$/- **Permission mode:** manual/' "$DOCS_ROOT/docs/plans/permission-mode.md"
  run pg permission-mode --lint
  [ "$status" -eq 0 ]
  run pg permission-mode --permission-mode 4
  [ "$output" = "$(printf 'manual\tphase')" ]
}

@test "permission.env: the words the reader accepts are the file's words" {
  # The drift test proper (JS owner ↔ this file) is permission-modes.test.ts;
  # this is the bash half — the script really reads the file it ships beside.
  . "$PE_SCRIPTS/permission.env"
  [ "$PERMISSION_MODES" = "acceptEdits auto dontAsk plan manual" ]
  [ "$DEFAULT_PERMISSION_MODE" = "acceptEdits" ]
}
