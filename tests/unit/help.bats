#!/usr/bin/env bats
# `--help` and `--explain` (measured-console phase 2): the engine's own
# catalogue, where a session used to read 70 KB of skill for it.
#
# The modes' list is ONE table in the script (`_modes_table`); these tests hold
# it to the dispatch's own arms in both directions, so a mode added without a
# line — or a line left for a mode that went — fails here. A lint's paragraph
# is `scripts/lints.env`; every code the lint prints must have one.
load ../helpers/test_helper

# Every `--flag)` / `--a|--b)` case arm in the script — the reader
# viewer/test/script-flags.ts uses, in grep.
_dispatch_flags() {
  grep -oE '^[[:space:]]*(--[a-z][a-z0-9-]*\|)*--[a-z][a-z0-9-]*\)' "$PE_SCRIPTS/phase-graph.sh" \
    | tr -d ' \t)' | tr '|' '\n' | sort -u
}

@test "--help: answers with no plan, in the slug's place or after one" {
  scrub_pe_env
  export DOCS_ROOT="$BATS_TEST_TMPDIR/empty"; mkdir -p "$DOCS_ROOT"
  run pg --help
  [ "$status" -eq 0 ]
  assert_contains "$output" "every mode, one line each"
  run pg no-such-plan --help
  [ "$status" -eq 0 ]
  assert_contains "$output" "--section"
}

@test "--help: one line per mode, and every mode the dispatch answers has its line" {
  scrub_pe_env
  export DOCS_ROOT="$BATS_TEST_TMPDIR/empty"; mkdir -p "$DOCS_ROOT"
  run pg --help
  listed="$(printf '%s\n' "$output" | awk 'NR > 1 { print $1 }' | grep '^--' | sort)"
  # one line per mode: no mode is listed twice
  [ -z "$(printf '%s\n' "$listed" | uniq -d)" ]
  missing=""
  for f in $(_dispatch_flags); do
    printf '%s\n' "$listed" | grep -qx -- "$f" || missing="$missing $f"
  done
  [ -z "$missing" ] || { echo "modes with no --help line:$missing" >&2; false; }
  stale=""
  for f in $listed; do
    _dispatch_flags | grep -qx -- "$f" || stale="$stale $f"
  done
  [ -z "$stale" ] || { echo "--help lines for modes the dispatch does not answer:$stale" >&2; false; }
}

@test "--help: every line is one line — a mode, its argument, what it answers" {
  scrub_pe_env
  export DOCS_ROOT="$BATS_TEST_TMPDIR/empty"; mkdir -p "$DOCS_ROOT"
  run pg --help
  n="$(printf '%s\n' "$output" | grep -c '^  ')"
  [ "$n" -ge 55 ]
  while IFS= read -r line; do
    [ "$(printf '%s' "$line" | awk '{ print NF }')" -ge 3 ] || { echo "a bare line: $line" >&2; false; }
  done <<EOF
$(printf '%s\n' "$output" | grep '^  ')
EOF
}

@test "--explain: a lint's name, tier and paragraph, under any spelling of its code" {
  scrub_pe_env
  export DOCS_ROOT="$BATS_TEST_TMPDIR/empty"; mkdir -p "$DOCS_ROOT"
  run pg --explain F14
  [ "$status" -eq 0 ]
  assert_contains "${lines[0]}" "F14 verification-empty-open (gate)"
  [ "${#lines[@]}" -ge 2 ]
  for spelling in f14 14; do
    run pg --explain "$spelling"
    assert_contains "${lines[0]}" "F14 verification-empty-open (gate)"
  done
  run pg --explain F51
  assert_contains "${lines[0]}" "F51 path-no-dir (advisory)"
}

@test "--explain: an unknown code is refused, naming the codes there are" {
  scrub_pe_env
  export DOCS_ROOT="$BATS_TEST_TMPDIR/empty"; mkdir -p "$DOCS_ROOT"
  run pg --explain F99
  [ "$status" -eq 2 ]
  assert_contains "$output" "no lint F99"
  assert_contains "$output" "F14"
  run pg --explain
  [ "$status" -eq 2 ]
}

@test "lints.env: every code the engine prints has a paragraph, and the catalogue holds no duplicate" {
  codes="$(grep -oE "(_advise |'|\")F[0-9]+[ :]" "$PE_SCRIPTS/phase-graph.sh" | grep -oE 'F[0-9]+' | sort -u)"
  [ -n "$codes" ]
  missing=""
  for c in $codes; do
    grep -qE "^$c " "$PE_SCRIPTS/lints.env" || missing="$missing $c"
  done
  [ -z "$missing" ] || { echo "codes the engine prints with no lints.env entry:$missing" >&2; false; }
  [ -z "$(awk '/^F[0-9]+ / { print $1 }' "$PE_SCRIPTS/lints.env" | sort | uniq -d)" ]
  # every record says gate or advisory
  [ -z "$(awk '/^F[0-9]+ / && $3 != "gate" && $3 != "advisory"' "$PE_SCRIPTS/lints.env")" ]
}
