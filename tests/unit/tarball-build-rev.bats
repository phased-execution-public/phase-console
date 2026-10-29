#!/usr/bin/env bats
# The tarball gates hold the packed client to HEAD (measured-console phase 7,
# the audit's C3; #358's shape: the v7.1.0 Pro Release shipped the 7.0.0
# client, and nothing compared its `.build-rev` with the commit). Each gate is
# copied into a scratch repository, so HEAD is the scratch commit, and run over
# a tarball whose stamp is planted: the stamp line is what is under test, so
# the cases read the gate's verdict on the stamp and ignore its other findings
# about a tarball this small.
load ../helpers/test_helper

setup() {
  R="$BATS_TEST_TMPDIR/r"
  mkdir -p "$R/.github/scripts"
  git -C "$R" init -q -b main
  git -C "$R" config user.email t@t.t; git -C "$R" config user.name t
  cp "$PE_DIR/.github/scripts/assert-tarball.sh" "$R/.github/scripts/"
  git -C "$R" add -A; git -C "$R" commit -qm init
  HEAD_SHA="$(git -C "$R" rev-parse HEAD)"
}

# tarball <out> <stamp> — a package whose client (and, for the Pro shape, whose
# package root) carries <stamp> as its `.build-rev`.
tarball() {
  local w="$BATS_TEST_TMPDIR/w-$RANDOM"
  mkdir -p "$w/package/viewer/client/dist"
  echo "$2" > "$w/package/viewer/client/dist/.build-rev"
  echo "$2" > "$w/package/.build-rev"
  echo '{"name":"x"}' > "$w/package/package.json"
  tar -czf "$1" -C "$w" package
}

@test "assert-tarball: a packed .build-rev that is not HEAD fails, naming both" {
  tarball "$BATS_TEST_TMPDIR/stale.tgz" 0000000000000000000000000000000000000001
  run "$SYS_BASH" "$R/.github/scripts/assert-tarball.sh" "$BATS_TEST_TMPDIR/stale.tgz"
  [ "$status" -ne 0 ]
  assert_contains "$output" "STALE CLIENT in tarball: viewer/client/dist/.build-rev is 0000000000000000000000000000000000000001, not HEAD $HEAD_SHA"
}

@test "assert-tarball: a packed .build-rev that is HEAD raises no stale-client finding" {
  tarball "$BATS_TEST_TMPDIR/fresh.tgz" "$HEAD_SHA"
  run "$SYS_BASH" "$R/.github/scripts/assert-tarball.sh" "$BATS_TEST_TMPDIR/fresh.tgz"
  refute_contains "$output" "STALE CLIENT"
}

@test "assert-tarball: PC_EXPECT_BUILD_REV names HEAD for a pack staged outside any checkout" {
  tarball "$BATS_TEST_TMPDIR/fresh.tgz" "$HEAD_SHA"
  run env PC_EXPECT_BUILD_REV=0000000000000000000000000000000000000002 "$SYS_BASH" "$R/.github/scripts/assert-tarball.sh" "$BATS_TEST_TMPDIR/fresh.tgz"
  assert_contains "$output" "not HEAD 0000000000000000000000000000000000000002"
}

@test "assert-tarball: a missing stamp is stale too" {
  w="$BATS_TEST_TMPDIR/nostamp"; mkdir -p "$w/package"
  echo '{}' > "$w/package/package.json"
  tar -czf "$BATS_TEST_TMPDIR/nostamp.tgz" -C "$w" package
  run "$SYS_BASH" "$R/.github/scripts/assert-tarball.sh" "$BATS_TEST_TMPDIR/nostamp.tgz"
  [ "$status" -ne 0 ]
  assert_contains "$output" "is missing, not HEAD"
}

