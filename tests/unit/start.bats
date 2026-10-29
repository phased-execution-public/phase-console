#!/usr/bin/env bats
# `./start` (measured-console phase 13, #385's residual) — the bats half of the
# last test in `viewer/test/cli-dispatch.test.ts`. A bare first argument that is
# not a directory is refused with the verbs named, and never reaches
# `viewer/run`; a directory, a switch or nothing still does. The script runs from
# a sandbox whose `viewer/run` is a stub, so a regression prints a line instead
# of booting a console.

load ../helpers/test_helper

setup() {
  scrub_pe_env
  # A sandboxed state root, as every suite that names the console's start does
  # (state-isolation.test.ts) — the stub never boots one, but a regression would.
  export HOME="$BATS_TEST_TMPDIR/home"
  export XDG_STATE_HOME="$BATS_TEST_TMPDIR/state"
  export XDG_CONFIG_HOME="$BATS_TEST_TMPDIR/config"
  mkdir -p "$HOME" "$XDG_STATE_HOME" "$XDG_CONFIG_HOME"
  BOX="$BATS_TEST_TMPDIR/box"
  mkdir -p "$BOX/viewer" "$BOX/a-repo"
  cp "$PE_DIR/start" "$BOX/start"
  printf '#!/bin/bash\necho RUN "$@"\n' > "$BOX/viewer/run"
  chmod +x "$BOX/start" "$BOX/viewer/run"
  cd "$BOX"
}

@test "start: a bare word that is no directory is refused, naming the verbs, and boots nothing" {
  run bash "$BOX/start" run clear-streak demo
  [ "$status" -eq 2 ]
  [[ "$output" == *"'run' is not a directory"* ]]
  [[ "$output" == *"doctor"* ]]
  [[ "$output" == *"sessions"* ]]
  [[ "$output" != *"RUN "* ]]
}

@test "start: a directory, a switch and nothing still start the console" {
  run bash "$BOX/start" a-repo --no-open
  [ "$status" -eq 0 ]
  [ "$output" = "RUN --root a-repo --no-open" ]
  run bash "$BOX/start" --allow-writes
  [ "$output" = "RUN --allow-writes" ]
  run bash "$BOX/start"
  [ "$output" = "RUN" ]
}
