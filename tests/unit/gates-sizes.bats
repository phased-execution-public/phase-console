#!/usr/bin/env bats
# Gate detection + size resolution. Locks in correct CURRENT behavior.
load ../helpers/test_helper

@test "gated: phase 2 is gated, phase 1 is not" {
  setup_docs gated gated
  run pg gated --gated 2; [ "$output" = "yes" ]
  run pg gated --gated 1; [ "$output" = "no" ]
}

@test "gated: board marks the gated phase" {
  setup_docs gated gated
  run pg gated
  assert_contains "$output" "GATED"
}

@test "gate-kind: manual is human, ai is ai, machine types are auto, ungated is none" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-kind 5;  [ "$output" = "human" ]
  run pg gatecheck --gate-kind 10; [ "$output" = "ai" ]
  run pg gatecheck --gate-kind 2;  [ "$output" = "auto" ]
  run pg gatecheck --gate-kind 4;  [ "$output" = "auto" ]
  run pg gatecheck --gate-kind 9;  [ "$output" = "auto" ]
  run pg gatecheck --gate-kind 1;  [ "$output" = "none" ]
}

@test "gate-kind: a GATED heading with no Gate-check reads as ai (GATE_DEFAULT) — and the lint names it" {
  setup_docs gated gated
  sed -i.bak '/Gate-check/d' "$DOCS_ROOT/docs/plans/gated.md"
  run pg gated --gate-kind 2
  [ "$output" = "ai" ]
  run pg gated --gate-status 2
  [ "$status" -eq 1 ]
  [[ "$output" == ai:* ]]
  run pg gated --lint
  [ "$status" -ne 0 ]
  assert_contains "$output" "phase 2: gate-directive-missing"
}

@test "size: explicit S/M/L tags are read" {
  setup_docs gated gated
  run pg gated --size 1; [ "$output" = "S" ]
  run pg gated --size 2; [ "$output" = "M" ]
  run pg gated --size 3; [ "$output" = "L" ]
}

@test "size: missing tag defaults to M" {
  setup_docs sizes sizes
  run pg sizes --size 3
  [ "$output" = "M" ]
}

# --- engine-5: Size is read from the phase's OWN block ------------------------

@test "size: a phase with no Size bullet does not inherit its neighbour's" {
  # phase_size was the last directive still on a fixed `grep -A8` window rather
  # than phase_block — neither scoped nor long enough. A short phase inherited a
  # heavy neighbour's L and was weighted 90K instead of 40K, so compute_groups
  # refused to batch it and every batching surface proposed the wrong sessions.
  setup_docs linear neighbour
  cat >> "$DOCS_ROOT/docs/plans/neighbour.md" <<'PLAN'

## Phases

### Phase 1 — Alpha
- **Goal:** something short with no Size tag
- **Verification:** `true`

### Phase 2 — Beta
- **Size:** L
- **Goal:** the heavy one
- **Verification:** `true`
PLAN
  run pg neighbour --size 1; [ "$output" = "M" ]
  run pg neighbour --size 2; [ "$output" = "L" ]
}

@test "size: a Size bullet more than eight lines into the block is still found" {
  setup_docs linear faraway
  cat >> "$DOCS_ROOT/docs/plans/faraway.md" <<'PLAN'

## Phases

### Phase 1 — Alpha
- **Goal:** a long goal paragraph that pushes the Size bullet down the block,
  which is an entirely ordinary thing for a real plan to do — several lines of
  context about why the phase exists, what it is replacing, and which decisions
  it is deliberately not making, before the machine-read directives start.
- **Read first:** this plan §Phase 1
- **Files to create/modify:** several
- **Steps:** several
- **Size:** S
- **Verification:** `true`
PLAN
  run pg faraway --size 1
  [ "$output" = "S" ]
}

@test "size: prose containing the word 'sizes' is not a Size tag" {
  # The loose `.*[Ss]ize` match also fired on prose, which turned HAVE_SIZES on —
  # and with it the whole SUGGESTED BATCHES banner — for plans that tagged nothing.
  setup_docs linear prose
  cat >> "$DOCS_ROOT/docs/plans/prose.md" <<'PLAN'

## Phases

### Phase 1 — Alpha
- **Goal:** resize the thumbnails and normalise their sizes
- **Verification:** `true`
PLAN
  run pg prose --size 1
  [ "$output" = "M" ]
  run pg prose
  refute_contains "$output" "SUGGESTED BATCHES"
}
