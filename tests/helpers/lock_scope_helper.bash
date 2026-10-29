#!/usr/bin/env bash
# The shared setup of the scope and claim-qualification suites
# (tests/unit/lock-scope.bats, lock-claim.bats, lock-scope-paths.bats), loaded
# after test_helper. lock-scope.bats held it until measured-console phase 7
# split it into files under 400 lines.

setup() {
  # `session=` is written only when an id is known, and this suite may itself run
  # inside a Claude session that exports one — which would silently change what
  # the conflicts scan is keying on. Same block as lock.bats, same reason.
  #
  # `PE_BRANCH` and `PE_WORKTREE` join it for a sharper version of the same
  # reason: this suite may run inside a worktree LANE, whose runner exports
  # both — and `branch=` is ACTED ON, so an inherited one would qualify every
  # lock the suite writes and turn the collision cases green for the wrong
  # reason.
  unset PE_SESSION_ID CLAUDE_CODE_SESSION_ID PE_BRANCH PE_WORKTREE
  # `conflicts` also reads the RUN holds under the state home (control-tower
  # phase 40): this suite reads its own, never the machine's.
  export XDG_STATE_HOME="$BATS_TEST_TMPDIR/xdg-state"
}
