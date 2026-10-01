#!/usr/bin/env bats
#
# A fan-out handoff writes the boot boilerplate ONCE (control-tower phase 85, #115).
#
# A handoff that unblocks eight phases used to carry eight whole boot prompts —
# the skills line, the Setup preamble, the wait procedure, the bootstrap list, the
# DAG warning, the decisions, the lock steps, the task list and the handoff duty,
# eight times over — 1,350 lines of which ~1,100 were copies of each other
# (hub, tfar phase 32), and every session told to read that handoff read all of
# them. Two consecutive prompts differed in ~21 lines.
#
# So a fan-out handoff now writes the shared boot once, as a template (`<N>` is
# the phase's number, each `⟨slot⟩` line is filled from the phase's own block),
# and under `### Phase N — <title>` only what is that phase's: its size, model
# and scope, and the parts of the prompt that differ — always its reading list,
# its notes and its gate, and anything else that is not the same for every
# sibling. The full prompt is composed AT LAUNCH (`next-phase-prompt.sh …
# --phase N`, Phase Console) from the plan, exactly as `--boot-prompt` has always
# built it. The proof that nothing was lost or invented is composition: the
# shared boot plus a phase's block, put together by awk below, must be
# byte-identical to `--boot-prompt N`.

load ../helpers/test_helper

setup() {
  setup_docs fanout fanout
  # Phase 5 stands apart and is done: it leaves one note for phase 2 alone and
  # one for every later phase, so the siblings' notes differ.
  write_handoff fanout 5 aside complete
  cat >> "$DOCS_ROOT/docs/handoffs/fanout/phase-05-aside.md" <<'EOF'

## Notes for later phases
- **Phase 2:** the stack's cache must be warm before the suite runs.
- **All:** the root's API is frozen; read it, never widen it.
EOF
}

handoff() { cat "$DOCS_ROOT/docs/handoffs/fanout/$1"; }

# compose <phase> <text> — the shared boot with `<NN>`/`<N>` read as the phase and
# each ⟨slot⟩ line replaced by the phase's own part of the same name (nothing,
# when the phase's block has none). The composition a person does by eye.
compose() {
  printf '%s\n' "$2" | awk -v want="$1" '
    shared && /^```$/        { shared = 0; next }
    shared                   { line[++n] = $0; next }
    delta && /^```$/         { delta = 0; next }
    delta && /^⟨[a-z-]+⟩$/   { slot = $0; next }
    delta                    { part[slot] = part[slot] $0 "\n"; next }
    /^```text boot-shared$/  { shared = 1; next }
    /^### Phase [0-9]+/      { cur = $3 + 0; next }
    /^```text boot-delta$/   { if (cur == want) delta = 1; else skip = 1; next }
    END {
      pad = sprintf("%02d", want)
      for (i = 1; i <= n; i++) {
        l = line[i]
        if (l ~ /^⟨[a-z-]+⟩$/) { printf "%s", part[l]; continue }
        gsub(/<NN>/, pad, l); gsub(/<N>/, want, l)
        print l
      }
    }'
}

# The START COPY block of next-phase-prompt.sh's output, frame lines dropped.
copied() { printf '%s\n' "$1" | awk '/^── START COPY/ { on = 1; next } /^── END COPY/ { on = 0 } on'; }

same_or_diff() {  # same_or_diff <want> <got>
  [ "$1" = "$2" ] && return 0
  diff <(printf '%s\n' "$1") <(printf '%s\n' "$2") >&2 || true
  return 1
}

@test "HF-1: a fan-out handoff writes the shared boot once and each phase only its own delta" {
  pe_newho fanout 1 root complete >/dev/null
  local body; body="$(handoff phase-01-root.md)"
  # The boilerplate, once — not once per unblocked phase.
  [ "$(printf '%s\n' "$body" | grep -c '^/phased-execution$')" -eq 1 ]
  [ "$(printf '%s\n' "$body" | grep -c '^Waiting without polling')" -eq 1 ]
  [ "$(printf '%s\n' "$body" | grep -c 'start Phase <N> in this fresh session')" -eq 1 ]
  [ "$(printf '%s\n' "$body" | grep -c 'Then publish this phase')" -eq 1 ]
  # Each phase: number and title, size, model and scope …
  assert_contains "$body" "### Phase 2 — Stack"
  assert_contains "$body" "### Phase 3 — Gate — 🔒 GATED·ai"
  assert_contains "$body" "### Phase 4 — Model"
  assert_contains "$body" '- **Size:** L · **Model:** `claude-opus-5-5[1m]` · **Scope:** `core`'
  assert_contains "$body" '- **Size:** M · **Model:** `claude-opus-5-5[1m]` · **Scope:** `core`'
  assert_contains "$body" '- **Size:** S · **Model:** `claude-sonnet-5` · **Scope:** `site`'
  # … its reading list — the handoff being written is the first thing each
  # unblocked phase reads, so it is named although the file lands last …
  [ "$(printf '%s\n' "$body" | grep -c '^- docs/handoffs/fanout/phase-01-root.md$')" -eq 3 ]
  # … and its notes: phase 2's own note reaches phase 2's block alone.
  [ "$(printf '%s\n' "$body" | grep -c "the stack's cache must be warm")" -eq 1 ]
  [ "$(printf '%s\n' "$body" | grep -c "the root's API is frozen")" -eq 3 ]
  # Where the siblings differ, the shared boot names the slot instead.
  assert_contains "$body" "⟨setup⟩"
  assert_contains "$body" "⟨gate⟩"
  assert_contains "$body" "⟨scope⟩"
}

@test "HF-2: the shared boot plus a phase's own block composes to exactly its --boot-prompt" {
  write_handoff fanout 1 root complete
  run pg fanout --boot-fanout "2 3 4"
  [ "$status" -eq 0 ] || false
  local fan="$output" p
  for p in 2 3 4; do
    same_or_diff "$(pg fanout --boot-prompt "$p")" "$(compose "$p" "$fan")" || { echo "phase $p" >&2; false; }
  done
}

@test "HF-2: the handoff new-handoff.sh writes composes to each unblocked phase's --boot-prompt" {
  pe_newho fanout 1 root complete >/dev/null
  local body p; body="$(handoff phase-01-root.md)"
  for p in 2 3 4; do
    same_or_diff "$(pg fanout --boot-prompt "$p")" "$(compose "$p" "$body")" || { echo "phase $p" >&2; false; }
  done
}

@test "HF-2: siblings that agree share everything but their own reading list, notes and gate" {
  # Phases 2 and 3 of the diamond differ in nothing but their number.
  setup_docs diamond demo
  write_handoff demo 1 root complete
  run pg demo --boot-fanout "2 3"
  [ "$status" -eq 0 ] || false
  local fan="$output" p
  refute_contains "$fan" "⟨setup⟩"
  refute_contains "$fan" "⟨scope⟩"
  refute_contains "$fan" "⟨decisions⟩"
  assert_contains "$fan" "⟨reading⟩"
  for p in 2 3; do
    same_or_diff "$(pg demo --boot-prompt "$p")" "$(compose "$p" "$fan")" || { echo "phase $p" >&2; false; }
  done
}

@test "HF-2: the section markers never reach a plain --boot-prompt" {
  write_handoff fanout 1 root complete
  run pg fanout --boot-prompt 3
  [ "$status" -eq 0 ] || false
  refute_contains "$output" "$(printf '\036')"
  refute_contains "$output" "<N>"
  refute_contains "$output" "⟨"
}

@test "HF-3: next-phase-prompt composes one phase's full prompt at launch — equal to --boot-prompt" {
  write_handoff fanout 1 root complete
  local p
  for p in 2 3 4; do
    run pe_nextp fanout 1 --phase "$p"
    [ "$status" -eq 0 ] || false
    assert_contains "$output" "START COPY — Phase $p"
    same_or_diff "$(pg fanout --boot-prompt "$p")" "$(copied "$output")" || { echo "phase $p" >&2; false; }
  done
}

@test "HF-3: next-phase-prompt's fan-out banner carries the shared boot once, and says how to compose" {
  write_handoff fanout 1 root complete
  run pe_nextp fanout 1
  [ "$status" -eq 0 ] || false
  [ "$(printf '%s\n' "$output" | grep -c '^Waiting without polling')" -eq 1 ]
  assert_contains "$output" "### Phase 2 — Stack"
  assert_contains "$output" "### Phase 4 — Model"
  assert_contains "$output" "next-phase-prompt.sh fanout 1 --phase <N>"
  refute_contains "$output" "START COPY"
  # And what it prints composes, like the handoff's copy.
  same_or_diff "$(pg fanout --boot-prompt 2)" "$(compose 2 "$output")"
}

@test "a single unblocked phase is not a fan-out: its handoff and its banner keep the whole prompt" {
  setup_docs linear linear
  pe_newho linear 1 first complete >/dev/null
  local body; body="$(cat "$DOCS_ROOT/docs/handoffs/linear/phase-01-first.md")"
  assert_contains "$body" "start Phase 2 in this fresh session"
  refute_contains "$body" "boot-shared"
  run pe_nextp linear 1
  [ "$status" -eq 0 ] || false
  assert_contains "$output" "START COPY — Phase 2"
}

@test "--phase names a phase the plan does not have: refused, nothing composed" {
  write_handoff fanout 1 root complete
  run pe_nextp fanout 1 --phase 99
  [ "$status" -ne 0 ]
  refute_contains "$output" "START COPY"
}

@test "--boot-fanout refuses a phase the plan does not have, and an empty list" {
  run pg fanout --boot-fanout "2 99"
  [ "$status" -eq 2 ]
  assert_contains "$output" "99"
  run pg fanout --boot-fanout ""
  [ "$status" -eq 2 ]
}
