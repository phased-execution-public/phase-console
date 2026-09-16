#!/usr/bin/env bats
# The wait budget (zero-touch-console phase 5, WAI-1): how long ONE phase may
# stay parked on its declared waits. `**Wait budget:**` in §Session budget is
# the plan's total; a phase's `- **Waits on:** <ref>[, <ref>…] · <max>` names
# what it waits on and overrides that total for itself. `--wait-budget [N]`
# prints minutes<TAB>phase|plan (nothing is silence — the console's default),
# `--waits-on N` the refs one per line. The JS reader (parse/plan.ts) is held
# to both outputs by viewer/test/engine-parity.test.ts.
load ../helpers/test_helper

@test "--wait-budget: the plan line alone, in minutes, decoy prose ignored" {
  setup_docs waits waits
  run pg waits --wait-budget
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf '720\tplan')" ]
}

@test "--wait-budget N: the phase's own max overrides, in every unit, and a max-less bullet inherits" {
  setup_docs waits waits
  run pg waits --wait-budget 1; [ "$output" = "$(printf '720\tplan')" ]
  run pg waits --wait-budget 2; [ "$output" = "$(printf '45\tphase')" ]
  run pg waits --wait-budget 3; [ "$output" = "$(printf '4320\tphase')" ]
  run pg waits --wait-budget 4; [ "$output" = "$(printf '2880\tphase')" ]
  run pg waits --wait-budget 5; [ "$output" = "$(printf '720\tplan')" ]
}

@test "--wait-budget: a plan that says nothing prints nothing, and an unknown phase is refused" {
  setup_docs linear linear
  run pg linear --wait-budget 1
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  run pg linear --wait-budget 99
  [ "$status" -eq 2 ]
}

@test "--waits-on N: backticked spans, else the comma list; nothing for a phase with no bullet" {
  setup_docs waits waits
  run pg waits --waits-on 2; [ "$output" = "gh:acme/app#run/42" ]
  run pg waits --waits-on 3; [ "$output" = "$(printf 'date:2026-09-20T06:00:00Z\ngh:acme/app#pr/7')" ]
  run pg waits --waits-on 4; [ "$output" = "$(printf 'lock:other/2\ndate:2026-09-21T09:00:00Z')" ]
  run pg waits --waits-on 5; [ "$output" = "gh:acme/app#run/43" ]
  run pg waits --waits-on 1
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "--waits-on needs a phase" {
  setup_docs waits waits
  run pg waits --waits-on
  [ "$status" -eq 2 ]
  assert_contains "$output" "--waits-on N"
}
