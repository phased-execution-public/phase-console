#!/usr/bin/env bats
# The two tiers of gates.sh (measured-console phase 15), driven over a stub
# stage set the way gates-record.bats drives it: the real gates.sh, copied into
# a scratch repository with stub stage functions spliced in before its main
# body. The quarantine stage stays REAL — it reads the scratch quarantine.env.
#   - the release alone writes the marker: a run under the phase tier
#     (PE_VERIFY_TIER=phase) records nothing, green or not;
#   - an expired quarantine row fails `--quick`; a standing one does not.
load ../helpers/test_helper

GATES="$PE_SCRIPTS/gates.sh"

setup() {
  R="$BATS_TEST_TMPDIR/repo"; M="$BATS_TEST_TMPDIR/marks"
  mkdir -p "$R/scripts" "$R/viewer/node_modules" "$M" "$BATS_TEST_TMPDIR/tmp"
  git -C "$R" init -q -b main
  git -C "$R" config user.email t@t.t; git -C "$R" config user.name t
  printf 'viewer/node_modules/\n' > "$R/.gitignore"
  cp "$PE_SCRIPTS/gates-marker.sh" "$R/scripts/gates-marker.sh"
  cp "$PE_SCRIPTS/quarantine.env" "$R/scripts/quarantine.env"
  cat > "$BATS_TEST_TMPDIR/stubs.sh" <<STUBS
preflight() { return 0; }
FULL_STAGES="quarantine build bash-engine"
BACKGROUND_STAGES=""
QUICK_STAGES="quarantine typecheck-server"
stage_build() { echo build >> "$M/ran"; }
stage_bash_engine() { echo bash-engine >> "$M/ran"; }
stage_typecheck_server() { echo typecheck-server >> "$M/ran"; }
STUBS
  awk -v stubs="$BATS_TEST_TMPDIR/stubs.sh" '
    /^\(return 0 2>\/dev\/null\) && return 0$/ { while ((getline l < stubs) > 0) print l }
    { print }' "$GATES" > "$R/scripts/gates.sh"
  grep -q 'QUICK_STAGES="quarantine typecheck-server"' "$R/scripts/gates.sh"
  git -C "$R" add -A; git -C "$R" commit -qm init
  COMMON="$(cd "$R" && cd "$(git rev-parse --git-common-dir)" && pwd)"
}

gates() { run env -u PE_VERIFY_TIER TMPDIR="$BATS_TEST_TMPDIR/tmp" "$SYS_BASH" "$R/scripts/gates.sh" "$@"; }

rows() {  # rows <TSV row>… — the scratch quarantine, committed so the full matrix sees a clean tree
  { printf "QUARANTINE_ROWS='"; printf '%s\n' "$@" | sed '$ s/$//'; printf "'\n"; } > "$R/scripts/quarantine.env"
  git -C "$R" commit -qam rows
}

@test "gates-tier: the release writes the marker; the phase tier never does" {
  gates
  [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
  [ "$(cat "$COMMON/phase-console-gates-ok")" = "$(git -C "$R" rev-parse HEAD)" ]
  rm -f "$COMMON/phase-console-gates-ok" "$COMMON/phase-console-gates-ok.json"
  run env PE_VERIFY_TIER=phase TMPDIR="$BATS_TEST_TMPDIR/tmp" "$SYS_BASH" "$R/scripts/gates.sh"
  [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
  assert_contains "$output" "no record will be written"
  [ ! -f "$COMMON/phase-console-gates-ok" ]
  [ ! -f "$COMMON/phase-console-gates-ok.json" ]
}

@test "gates-tier: an expired quarantine row fails --quick, naming it; a standing one passes" {
  rows "$(printf 'node:viewer/test/x.test.ts\tmeasured-console/26\t2026-01-01\tsegfaults under load')"
  gates --quick
  [ "$status" -ne 0 ]
  assert_contains "$output" "quarantine"
  run cat "$BATS_TEST_TMPDIR"/tmp/phase-console-gates.*/quarantine.log
  assert_contains "$output" "node:viewer/test/x.test.ts EXPIRED on 2026-01-01"
  rows "$(printf 'node:viewer/test/x.test.ts\tmeasured-console/26\t2999-12-31\tsegfaults under load')"
  gates --quick
  [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
  [ "$(cat "$M/ran")" = "typecheck-server" ]
}

@test "gates-tier: a row without an owner, a reason or a day fails the quarantine stage" {
  rows "$(printf 'node:viewer/test/x.test.ts\t\t2999-12-31\tno owner')"
  gates --quick
  [ "$status" -ne 0 ]
  rows "$(printf 'viewer/test/x.test.ts\tme\t2999-12-31\tno suite')"
  gates --quick
  [ "$status" -ne 0 ]
  rows "$(printf 'node:viewer/test/x.test.ts\tme\tsoon\tno day')"
  gates --quick
  [ "$status" -ne 0 ]
}
