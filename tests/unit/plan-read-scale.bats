#!/usr/bin/env bats
# The plan read scales (control-tower phase 55, #58 #44).
#
# One `--memory-block` read of a 72-phase plan used to re-scan the whole plan
# once per DEPENDENCY EDGE: `missing_deps` → `_is_verified` → `qa_gates_phase`
# → `qa_mode_for_phase` forked an `awk` over the phase's block and another over
# §Session budget for every edge it checked, and `phase_size` forked one over
# the whole plan for every phase at load. On the 72-phase, 232 KB plan in #58
# that was 24,716 traced commands and 16.4 s — past the console's 45 s ceiling
# at the first sign of load, which is when its board went empty.
#
# The engine now memoises the plan-wide QA mode and reads every per-phase
# directive from ONE pre-parsed pass (bash 3.2 indexed arrays keyed by phase
# number). These tests count the `awk` processes a read starts, through a PATH
# shim, and hold the count to the PHASE count and to independence from the
# edge count — then check the board those forks were saved from is unchanged.
load ../helpers/test_helper

# A PATH shim that counts every `awk` the engine starts, then runs the real one.
shim_awk() {
  AWK_SHIM="$BATS_TEST_TMPDIR/shim"
  AWK_COUNT="$BATS_TEST_TMPDIR/awk.count"
  mkdir -p "$AWK_SHIM"
  : > "$AWK_COUNT"
  local real
  real="$(command -v awk)"
  printf '#!/bin/sh\nprintf x >> "%s"\nexec "%s" "$@"\n' "$AWK_COUNT" "$real" > "$AWK_SHIM/awk"
  chmod +x "$AWK_SHIM/awk"
}
awk_forks() { wc -c < "$AWK_COUNT" | tr -d ' '; }
pg_counted() { : > "$AWK_COUNT"; PATH="$AWK_SHIM:$PATH" pg "$@"; }

# Phases 1–21 and 40 are done and every one has a verdict. 20 is a `- **QA:** off`
# phase whose verdict is `fail` — it must NOT hold 22. 40 says `- **QA:** on`
# and failed — it must hold 41–43.
scale_setup() {
  # The fixture lives in tests/fixtures/scale/, outside the plans corpus that
  # engine-parity.test.ts forks the engine over once per phase per flag — so it
  # is set up over a small fixture and then put in place.
  setup_docs linear scale-72
  cp "$PE_DIR/tests/fixtures/scale/scale-72.md" "$DOCS_ROOT/docs/plans/scale-72.md"
  local i v f
  for i in $(seq 1 21) 40; do write_handoff scale-72 "$i" "step-$i" complete; done
  f="$DOCS_ROOT/docs/handoffs/scale-72/test-status.md"
  printf '# QA status — scale-72\n\n## QA status\n\n| Phase | Result | Report |\n|--:|--|--|\n' > "$f"
  for i in $(seq 1 21) 40; do
    case "$i" in 20|40) v=fail ;; *) v=pass ;; esac
    printf '| %s | %s | - |\n' "$i" "$v" >> "$f"
  done
  shim_awk
}

# The same plan with one edge per phase instead of three.
as_chain() {
  local plan="$DOCS_ROOT/docs/plans/scale-72.md"
  awk -F'|' 'BEGIN { OFS = "|" }
    /^\| [0-9]+ \| Step / { n = $2 + 0; $4 = (n > 1) ? " " (n - 1) " " : " — " }
    { print }' "$plan" > "$plan.chain" && mv "$plan.chain" "$plan"
}

@test "--memory-block on 72 phases forks awk a number of times bounded by the phase count" {
  scale_setup
  pg_counted scale-72 --memory-block > /dev/null
  forks="$(awk_forks)"
  echo "awk forks: $forks"
  [ "$forks" -gt 0 ]      # the shim is on the PATH, or this proves nothing
  [ "$forks" -le 72 ]
}

@test "the fork count does not grow with the edges: three edges per phase cost what one does" {
  scale_setup
  pg_counted scale-72 --memory-block > /dev/null
  dense="$(awk_forks)"
  as_chain
  run pg scale-72 --deps 30
  [ "$output" = "29" ]    # the rewrite took
  pg_counted scale-72 --memory-block > /dev/null
  chain="$(awk_forks)"
  echo "dense=$dense chain=$chain"
  [ "$dense" -eq "$chain" ]
}

@test "the board the forks were saved from is unchanged: a QA-off failure holds nothing, a QA-on one holds its dependents" {
  scale_setup
  run pg scale-72 --memory-block
  [ "$status" -eq 0 ]
  echo "$output"
  [ "$(printf '%s\n' "$output" | grep '^done:')" = "done: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 40" ]
  [ "$(printf '%s\n' "$output" | grep '^ready:')" = "ready: 22" ]
  blocked="$(printf '%s\n' "$output" | grep '^blocked:')"
  assert_contains "$blocked" " 23<-22(not-done) "
  assert_contains "$blocked" " 41<-38(not-done),39(not-done),40(qa:fail) "
  refute_contains "$blocked" "20(qa:"
}

@test "per-phase directives read from the pre-parsed pass agree with the plan, phase by phase" {
  scale_setup
  for p in 1 2 3 20 40 50 72; do
    run pg scale-72 --size "$p"
    case $((p % 3)) in 0) want=S ;; 1) want=M ;; *) want=L ;; esac
    [ "$output" = "$want" ] || { echo "phase $p: size $output, want $want"; return 1; }
  done
  run pg scale-72 --qa-mode 20
  assert_contains "$output" "off"
  run pg scale-72 --qa-mode 40
  assert_contains "$output" "on"
  run pg scale-72 --qa-mode 41
  assert_contains "$output" "on"
  run pg scale-72 --qa-result 40
  [ "$output" = "fail" ]
  run pg scale-72 --qa-result 22
  [ "$output" = "none" ]
}

@test "a verdict row keyed '07' answers as qa_result always did: it is not phase 7's" {
  # `qa_result` compares the phase cell as a STRING (macOS awk: `ph != want`
  # on a string and a strnum), so `| 07 |` never answered phase 7. The
  # memoised table must not start to — keyed by number it did.
  scale_setup
  f="$DOCS_ROOT/docs/handoffs/scale-72/test-status.md"
  sed 's/^| 7 | pass | - |$/| 07 | pass | - |/' "$f" > "$f.new" && mv "$f.new" "$f"
  grep -q '^| 07 | pass' "$f"
  run pg scale-72 --qa-result 7
  [ "$output" = "none" ]
}
