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

# Rule 7 (control-tower phase 45, #59) read end to end: the engine's own two
# answers for a phase are what the runner judges a declared wait against, so
# this feeds them — verbatim — to the one expression (`evaluateWait`). The
# mql P19 arithmetic: a 45 m `Waits on:` budget, 30 m already parked, and a
# 90 m ask. A ref the clock can poll is granted what is left and its landing
# ends the wait; a window nothing can end sooner is refused, as before, and
# the runner answers that refusal with a park on the refs, never a failure.
rule7() {
  node --input-type=module -e "
    const { evaluateWait, waitBudgetFrom } = await import(process.argv[1]);
    const budget = waitBudgetFrom(process.argv[2], process.argv[3], () => null);
    const now = Date.parse('2026-09-21T09:00:00Z');
    const verdict = evaluateWait({
      now, requestedUntil: now + 90 * 60000, parkedMs: Number(process.argv[4]) * 60000, waits: 1,
      budget, ledger: 'session', pollable: process.argv[5] === 'pollable',
    });
    console.log([verdict.verdict, verdict.verdict === 'park' ? verdict.granted / 60000 : verdict.ledger,
      verdict.budgetMs / 60000, budget.source].join(' '));
  " "$PE_DIR/viewer/server/runner/wait-budget.ts" "$1" "$2" "$3" "$4"
}

@test "rule 7: a declared window past the budget that names a pollable ref is granted min(asked, remaining)" {
  command -v node >/dev/null || skip "node is not installed"
  setup_docs waits waits
  budget="$(pg waits --wait-budget 2)"
  refs="$(pg waits --waits-on 2)"
  [ "$refs" = "gh:acme/app#run/42" ]
  run rule7 "$budget" "$refs" 30 pollable
  [ "$status" -eq 0 ]
  [ "$output" = "park 15 45 phase" ]
}

# The fifth amendment's window rules (control-tower phase 87, #126), read from
# the engine's own answer: a declared window ends where the budget
# `--wait-budget` names does, and a park on console state (`phase:`, `verify:`,
# phase 88's schemes) spends none of it, so nothing clamps it. P41 asked twelve
# hours against eight, and its `cmd:` cadence was a sixth of the twelve.
window_end() {
  node --input-type=module -e "
    const { waitBudgetFrom, spendsWaitBudget } = await import(process.argv[1]);
    const { declaredWindowOf } = await import(process.argv[2]);
    const budget = waitBudgetFrom(process.argv[3], '', () => null);
    const at = Date.parse('2026-09-25T09:28:13Z');
    const watch = process.argv[4].split(',').filter(Boolean);
    const record = {
      status: 'waiting', parkedUntil: new Date(at + 90 * 60000).toISOString(),
      declared: { status: 'blocked', at: new Date(at).toISOString(), watch, budget: { ms: budget.budgetMs, source: budget.source } },
    };
    const window = declaredWindowOf(record);
    console.log([(window.until - at) / 60000, spendsWaitBudget(watch)].join(' '));
  " "$PE_DIR/viewer/server/runner/wait-budget.ts" "$PE_DIR/viewer/server/watch-refs.ts" "$1" "$2"
}

@test "BW-4: a declared window past the engine's budget ends where the budget does" {
  command -v node >/dev/null || skip "node is not installed"
  setup_docs waits waits
  budget="$(pg waits --wait-budget 2)"
  [ "$budget" = "$(printf '45\tphase')" ]
  run window_end "$budget" 'cmd:"grep -q complete docs/handoffs/waits/phase-01.md"'
  [ "$status" -eq 0 ]
  [ "$output" = "45 true" ]
}

@test "BW-5: a park on console state spends no budget and keeps the window it asked; the engine's own refs keep theirs" {
  command -v node >/dev/null || skip "node is not installed"
  setup_docs waits waits
  budget="$(pg waits --wait-budget 2)"
  run window_end "$budget" "phase:waits/1,verify:waits/1"
  [ "$status" -eq 0 ]
  [ "$output" = "90 false" ]
  refs="$(pg waits --waits-on 4 | paste -s -d, -)"
  [ "$refs" = "lock:other/2,date:2026-09-21T09:00:00Z" ]
  run window_end "$budget" "$refs"
  [ "$status" -eq 0 ]
  [ "$output" = "45 true" ]
}

@test "rule 7: with nothing pollable, or nothing left, a declared window is refused on the budget ledger" {
  command -v node >/dev/null || skip "node is not installed"
  setup_docs waits waits
  budget="$(pg waits --wait-budget 2)"
  run rule7 "$budget" "" 30 none
  [ "$status" -eq 0 ]
  [ "$output" = "timeout budget 45 phase" ]
  run rule7 "$budget" "gh:acme/app#run/42" 45 pollable
  [ "$status" -eq 0 ]
  [ "$output" = "timeout budget 45 phase" ]
}

# --- wait-budget.sh: the WRITER behind `--wait-budget` (control-tower phase 14, #40) ---
#
# A spent wait budget used to be raised by hand-editing the plan: the halt text
# named the bullet and a person opened a text editor. The console's raise verb
# writes the SAME two directives the reader above has always read, and every
# case below proves the write by the engine's own read-back — stdout IS
# `phase-graph.sh --wait-budget [N]` — looking at the bytes only where the point
# is that nothing else moved (the refs, a note, the decoy, a second run).

wb_set() { DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" "$SYS_BASH" "$PE_SCRIPTS/wait-budget.sh" "$@"; }
plan_of() { echo "$DOCS_ROOT/docs/plans/$1.md"; }
bullet_of() {  # bullet_of <slug> <phase> — the phase's `Waits on:` line, verbatim
  awk -v want="$2" '
    /^###[[:space:]]+[Pp]hase[[:space:]]+[0-9]+/ {
      h=$0; sub(/^###[[:space:]]+[Pp]hase[[:space:]]+/,"",h); sub(/[^0-9].*/,"",h); cur=(h==want)
    }
    cur && tolower($0) ~ /^[[:space:]]*[-*][[:space:]]*\*{0,2}waits[[:space:]]+on/ { print; exit }
  ' "$(plan_of "$1")"
}

@test "wait-budget.sh --phase: the max after the refs is replaced, the refs are kept, the engine reads it back" {
  setup_docs waits waits
  run wb_set waits --phase 2 90m
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf '90\tphase')" ]
  [ "$output" = "$(pg waits --wait-budget 2)" ]
  [ "$(bullet_of waits 2)" = '- **Waits on:** `gh:acme/app#run/42` · 90m' ]
  [ "$(pg waits --waits-on 2)" = "gh:acme/app#run/42" ]
  # Its neighbours did not move.
  [ "$(pg waits --wait-budget 3)" = "$(printf '4320\tphase')" ]
  [ "$(pg waits --wait-budget)" = "$(printf '720\tplan')" ]
}

@test "wait-budget.sh is idempotent: a second run is byte-identical and does not even rewrite the file" {
  setup_docs waits waits
  wb_set waits --phase 2 2h >/dev/null
  cp "$(plan_of waits)" "$BATS_TEST_TMPDIR/once.md"
  ino_before="$(ls -i "$(plan_of waits)" | awk '{print $1}')"
  run wb_set waits --phase 2 2h
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf '120\tphase')" ]
  cmp -s "$(plan_of waits)" "$BATS_TEST_TMPDIR/once.md"
  [ "$(ls -i "$(plan_of waits)" | awk '{print $1}')" = "$ino_before" ]
}

@test "wait-budget.sh --phase: a bullet with no max gains one; bare refs and a day unit are kept as written" {
  setup_docs waits waits
  run wb_set waits --phase 5 2h
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf '120\tphase')" ]
  [ "$(bullet_of waits 5)" = '- **Waits on:** `gh:acme/app#run/43` · 2h' ]
  run wb_set waits --phase 4 3d
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf '4320\tphase')" ]
  [ "$(bullet_of waits 4)" = '- **Waits on:** lock:other/2, date:2026-09-21T09:00:00Z · 3d' ]
  [ "$(pg waits --waits-on 4 | paste -s -d, -)" = "lock:other/2,date:2026-09-21T09:00:00Z" ]
}

@test "wait-budget.sh --phase: a note after the max stays, and the written unit is the plainest one" {
  setup_docs waits waits
  f="$(plan_of waits)"
  sed 's/· ~45m$/· ~45m (measured on the hosted runner)/' "$f" > "$f.new" && mv "$f.new" "$f"
  run wb_set waits --phase 2 150
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf '150\tphase')" ]
  [ "$(bullet_of waits 2)" = '- **Waits on:** `gh:acme/app#run/42` · 150m (measured on the hosted runner)' ]
}

@test "wait-budget.sh --phase with no bullet: --ref writes one after the heading; with no ref it is refused" {
  setup_docs waits waits
  cp "$(plan_of waits)" "$BATS_TEST_TMPDIR/before.md"
  run wb_set waits --phase 1 30m
  [ "$status" -eq 2 ]
  assert_contains "$output" "Wait budget"
  cmp -s "$(plan_of waits)" "$BATS_TEST_TMPDIR/before.md"
  run wb_set waits --phase 1 30m --ref 'gh:acme/app#run/9' --ref 'gh:acme/app#pr/3'
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf '30\tphase')" ]
  [ "$(bullet_of waits 1)" = '- **Waits on:** `gh:acme/app#run/9`, `gh:acme/app#pr/3` · 30m' ]
  [ "$(pg waits --waits-on 1 | paste -s -d, -)" = "gh:acme/app#run/9,gh:acme/app#pr/3" ]
  [ "$(awk '/^### Phase 1/{getline; print; exit}' "$(plan_of waits)")" = '- **Waits on:** `gh:acme/app#run/9`, `gh:acme/app#pr/3` · 30m' ]
  run pg waits --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
}

@test "wait-budget.sh plan-wide: the §Session budget line is rewritten in place; the decoy prose is not" {
  setup_docs waits waits
  run wb_set waits 3h
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf '180\tplan')" ]
  grep -qxF '> **Wait budget:** 3h' "$(plan_of waits)"
  grep -qF 'wait budget of 99h that must NOT be read' "$(plan_of waits)"
  [ "$(pg waits --wait-budget 1)" = "$(printf '180\tplan')" ]
  [ "$(pg waits --wait-budget 2)" = "$(printf '45\tphase')" ]
}

@test "wait-budget.sh plan-wide: a plan with no line gains one inside §Session budget, or a section when it has none" {
  setup_docs linear linear
  run wb_set linear 90m
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf '90\tplan')" ]
  grep -qx '## Session budget' "$(plan_of linear)"
  grep -qxF '**Wait budget:** 90m' "$(plan_of linear)"
  [ "$(pg linear --wait-budget 3)" = "$(printf '90\tplan')" ]
  run pg linear --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
}

@test "wait-budget.sh refuses what it cannot write: an unknown phase, a bad duration, a stray word" {
  setup_docs waits waits
  cp "$(plan_of waits)" "$BATS_TEST_TMPDIR/before.md"
  run wb_set waits --phase 99 30m;      [ "$status" -eq 2 ]
  run wb_set waits --phase 2 soon;      [ "$status" -eq 2 ]
  run wb_set waits --phase 2 0m;        [ "$status" -eq 2 ]
  run wb_set waits --phase 2;           [ "$status" -eq 2 ]
  run wb_set waits --phase 2 30m 40m;   [ "$status" -eq 2 ]
  run wb_set waits --phase 2 30m --ref 'a`b'; [ "$status" -eq 2 ]
  run wb_set waits --bogus 30m;         [ "$status" -eq 2 ]
  run wb_set nope 30m;                  [ "$status" -eq 2 ]
  cmp -s "$(plan_of waits)" "$BATS_TEST_TMPDIR/before.md"
}

# ---- the declared-wait COUNT (control-tower phase 121, #40) -------------------

@test "--wait-count: the plan's line, a phase's own bullet over it, and silence printing nothing" {
  setup_docs operator-acts operator-acts
  run pg operator-acts --wait-count
  [ "$status" -eq 0 ]; [ "$output" = "$(printf '6\tplan')" ]
  run pg operator-acts --wait-count 1
  [ "$status" -eq 0 ]; [ "$output" = "$(printf '8\tphase')" ]
  run pg operator-acts --wait-count 2
  [ "$status" -eq 0 ]; [ "$output" = "$(printf '6\tplan')" ]
  setup_docs linear linear
  run pg linear --wait-count 1
  [ "$status" -eq 0 ]; [ -z "$output" ]
  run pg linear --wait-count 99
  [ "$status" -eq 2 ]
}

@test "wait-budget.sh --count: a phase gains its own bullet, the plan's line is rewritten, the engine reads both back" {
  setup_docs operator-acts operator-acts
  run wb_set operator-acts --phase 3 --count 5
  [ "$status" -eq 0 ]; [ "$output" = "$(printf '5\tphase')" ]
  grep -q '^- \*\*Wait count:\*\* 5$' "$DOCS_ROOT/docs/plans/operator-acts.md"
  run wb_set operator-acts --phase 1 --count 12
  [ "$status" -eq 0 ]; [ "$output" = "$(printf '12\tphase')" ]
  [ "$(grep -c 'Wait count:' "$DOCS_ROOT/docs/plans/operator-acts.md")" -eq 3 ]
  run wb_set operator-acts --count 9
  [ "$status" -eq 0 ]; [ "$output" = "$(printf '9\tplan')" ]
  grep -q '^> \*\*Wait count:\*\* 9$' "$DOCS_ROOT/docs/plans/operator-acts.md"
  before="$(cat "$DOCS_ROOT/docs/plans/operator-acts.md")"
  run wb_set operator-acts --count 9
  [ "$status" -eq 0 ]
  [ "$(cat "$DOCS_ROOT/docs/plans/operator-acts.md")" = "$before" ]
}

@test "wait-budget.sh --count refuses what is not a count, and a count with a budget beside it" {
  setup_docs operator-acts operator-acts
  for bad in 0 -3 x 2h 100; do
    run wb_set operator-acts --phase 1 --count "$bad"
    [ "$status" -eq 2 ] || { echo "accepted --count $bad"; return 1; }
  done
  run wb_set operator-acts --phase 1 --count 5 90m
  [ "$status" -eq 2 ]
}
