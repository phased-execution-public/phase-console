#!/usr/bin/env bats
# A cross-plan `plan <slug>:<phases>` gate clears the moment the other plan's
# phases are VERIFIED (control-tower phase 107, #167).
#
# `_gate_plan` read the other plan's set with `tr -d ' '`, written when the set
# came from `--memory-block`'s CSV (`1, 2, 3`). It has come from `--verified`
# since S8-a, which prints the set SPACE-separated (`1 2 3`), so deleting the
# spaces fused it into one number: `1 2 … 22` read as `,12345678910…22,`, and
# neither `,10,` nor `,11,` matched. Every multi-phase dependency was dead;
# only a one-phase set could clear a gate. The separators are normalised now,
# never deleted — on both sides, the set and the gate's own list.
load ../helpers/test_helper

# A plan of <n> independent phases, its handoffs written `complete` for the
# phases named after it. usage: other_plan <slug> <n> [done…]
other_plan() {
  local slug="$1" n="$2" i
  shift 2
  mkdir -p "$DOCS_ROOT/docs/plans" "$DOCS_ROOT/docs/handoffs/$slug"
  {
    printf -- '---\nslug: %s\ncreated: 2026-01-01\nstatus: active\nphases: %s\n' "$slug" "$n"
    printf -- 'handoffs: docs/handoffs/%s/\nmemory: project_%s\n---\n# %s\n## Phase graph\n' "$slug" "$slug" "$slug"
    printf '| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |\n'
    printf '|------:|-------|-----------|--------------------|-------|---------------|\n'
    i=1
    while [ "$i" -le "$n" ]; do
      printf '| %s | p%s | — | — | r | x |\n' "$i" "$i"
      i=$((i + 1))
    done
  } > "$DOCS_ROOT/docs/plans/$slug.md"
  for i in "$@"; do write_handoff "$slug" "$i" "p$i" complete; done
}

# The dependent plan: one gated phase per gate value given, in order.
# usage: dep_plan <slug> <gate-value>…
dep_plan() {
  local slug="$1" i=1 g
  shift
  mkdir -p "$DOCS_ROOT/docs/plans" "$DOCS_ROOT/docs/handoffs/$slug"
  {
    printf -- '---\nslug: %s\ncreated: 2026-01-01\nstatus: active\nphases: %s\n' "$slug" "$#"
    printf -- 'handoffs: docs/handoffs/%s/\nmemory: project_%s\n---\n# %s\n## Phase graph\n' "$slug" "$slug" "$slug"
    printf '| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |\n'
    printf '|------:|-------|-----------|--------------------|-------|---------------|\n'
    for g in "$@"; do printf '| %s | g%s | — | — | r | x |\n' "$i" "$i"; i=$((i + 1)); done
    i=1
    for g in "$@"; do
      printf '\n### Phase %s — g%s *(GATED)*\n- **Gate-check:** plan %s\n' "$i" "$i" "$g"
      i=$((i + 1))
    done
  } > "$DOCS_ROOT/docs/plans/$slug.md"
}

setup() {
  scrub_pe_env
  export DOCS_ROOT="$BATS_TEST_TMPDIR/work"
}

@test "the other plan's verified set is SPACE-separated — the shape the gate must read" {
  other_plan vca 22 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22
  run pg vca --verified
  [ "$status" -eq 0 ]
  [ "$output" = "1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22" ]
}

@test "#167: a 22-phase verified set clears a 'plan <slug>:10,11' gate (the tamagui-upgrade P4 shape)" {
  other_plan vca 22 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22
  dep_plan tam "vca:10,11"
  run pg tam --gate-status 1
  [ "$status" -eq 0 ]
  [ "$output" = "clear (vca phases 10,11 verified)" ]
}

@test "#167: any two-or-more verified set clears — the gate is not about the set's size" {
  other_plan two 3 2 3
  dep_plan dep "two:2,3" "two:3"
  run pg dep --gate-status 1
  [ "$status" -eq 0 ]
  run pg dep --gate-status 2
  [ "$status" -eq 0 ]
}

@test "a one-phase verified set still clears a one-phase gate, and blocks a wider one naming what is missing" {
  other_plan solo 11 1
  dep_plan dep "solo:1" "solo:10,11"
  run pg dep --gate-status 1
  [ "$status" -eq 0 ]
  run pg dep --gate-status 2
  [ "$status" -eq 1 ]
  [ "$output" = "blocked: solo phase(s) 10 11 not verified" ]
}

@test "the 1-vs-11 trap: '1' never matches inside '11', nor '11' inside '1 2 … 22' less phase 11" {
  other_plan trap 12 11
  dep_plan dep "trap:1" "trap:11"
  run pg dep --gate-status 1
  [ "$status" -eq 1 ]
  [ "$output" = "blocked: trap phase(s) 1 not verified" ]
  run pg dep --gate-status 2
  [ "$status" -eq 0 ]

  other_plan most 12 1 2 3 4 5 6 7 8 9 10 12
  dep_plan dep2 "most:11" "most:1,12"
  run pg dep2 --gate-status 1
  [ "$status" -eq 1 ]
  [ "$output" = "blocked: most phase(s) 11 not verified" ]
  run pg dep2 --gate-status 2
  [ "$status" -eq 0 ]
}

@test "the gate's own list reads in every shape a person writes: '10,11', '10, 11' and '10 11'" {
  other_plan vca 22 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22
  dep_plan dep "vca:10,11" "vca:10, 11" "vca:10 11"
  for p in 1 2 3; do
    run pg dep --gate-status "$p"
    [ "$status" -eq 0 ]
  done
  # …and a missing phase is still named, whatever the separator.
  other_plan half 22 1 2 3 4 5 6 7 8 9 10
  dep_plan dep3 "half:10, 11" "half:10 11"
  run pg dep3 --gate-status 1
  [ "$output" = "blocked: half phase(s) 11 not verified" ]
  run pg dep3 --gate-status 2
  [ "$output" = "blocked: half phase(s) 11 not verified" ]
}
