#!/usr/bin/env bats
# gates.sh's server-suite stage reads the suite's ledger (#339): `node --test`
# reports a file whose process stops part way as green, so the stage compares
# the files it planned with the files that reported in full and fails on a gap.
# Each case plants a throwaway viewer with its own test files and runs ONE
# stage of the sourced script under the 3.2 system bash.
load ../helpers/test_helper

setup() {
  command -v node >/dev/null 2>&1 || skip "node is not installed"
  VIEWER_DIR="$BATS_TEST_TMPDIR/viewer"
  mkdir -p "$VIEWER_DIR/test"
  cp "$PE_DIR/viewer/test/suite-ledger.mjs" "$VIEWER_DIR/test/"
  cat > "$VIEWER_DIR/test/whole.test.ts" <<'TS'
import test from 'node:test';
test('one', () => {});
test('two', () => {});
test.skip('three, skipped', () => {});
TS
}

server_suite() {
  # The arguments are cleared before the source: gates.sh reads its own options.
  run "$SYS_BASH" -c 'g=$1 v=$2; set --; source "$g" && VIEWER="$v" && stage_server_suite' _ \
    "$PE_SCRIPTS/gates.sh" "$VIEWER_DIR"
}

@test "gates-suite: a suite whose every file reports in full is green" {
  server_suite
  [ "$status" -eq 0 ]
  [[ "$output" != *"suite gap"* ]]
}

@test "gates-suite: a planted mid-run stop reads red, naming the file and the count" {
  cat > "$VIEWER_DIR/test/stops.test.ts" <<'TS'
import test from 'node:test';
test('first', () => {});
test('second stops the process', async () => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  process.exit(0);
});
test('third, never reported', () => {});
TS
  server_suite
  [ "$status" -ne 0 ]
  [[ "$output" == *"suite gap: test/stops.test.ts stopped part way — 1 of 3 tests reported"* ]]
  [[ "$output" == *"NOT green"* ]]
  [[ "$output" != *"whole.test.ts"*"gap"* ]]
}

@test "gates-suite: a file that stops before it reports anything reads red too" {
  cat > "$VIEWER_DIR/test/silent.test.ts" <<'TS'
import test from 'node:test';
test('stops at once', () => { process.exit(0); });
test('never reported', () => {});
TS
  server_suite
  [ "$status" -ne 0 ]
  [[ "$output" == *"suite gap: test/silent.test.ts"* ]]
}

@test "gates-suite: a planned file the ledger never names is a gap" {
  printf 'test/whole.test.ts\t3\t3\n' > "$BATS_TEST_TMPDIR/ledger"
  run "$SYS_BASH" -c 'g=$1 l=$2; set --; source "$g" && suite_gaps "$l" test/whole.test.ts test/missing.test.ts' _ \
    "$PE_SCRIPTS/gates.sh" "$BATS_TEST_TMPDIR/ledger"
  [ "$status" -eq 1 ]
  [[ "$output" == *"suite gap: test/missing.test.ts never reported"* ]]
}
