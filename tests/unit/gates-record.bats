#!/usr/bin/env bats
# gates.sh's run, driven end to end over a stub stage set (measured-console
# phase 7, the audit's C1, C3 and C9): a dirty tree is refused before stage one,
# a HEAD that moves during the run leaves no record, a green run writes the sha
# and its JSON into the COMMON gitdir, verify-free runs beside the other stages
# and is awaited last, and `--drain` holds the fleet and always lets it go.
#
# The script under test is the real gates.sh, copied into a scratch repository
# with stub stage functions spliced in just before its main body — so the
# preflight, the loop, the record and the drain are the shipped code, and no
# suite runs.
load ../helpers/test_helper

GATES="$PE_SCRIPTS/gates.sh"

setup() {
  command -v node >/dev/null 2>&1 || skip "node is not installed"
  R="$BATS_TEST_TMPDIR/repo"; M="$BATS_TEST_TMPDIR/marks"
  mkdir -p "$R/scripts" "$R/viewer/node_modules" "$M" "$BATS_TEST_TMPDIR/tmp" "$BATS_TEST_TMPDIR/bg"
  git -C "$R" init -q -b main
  git -C "$R" config user.email t@t.t; git -C "$R" config user.name t
  printf 'viewer/node_modules/\n' > "$R/.gitignore"
  cp "$PE_SCRIPTS/gates-marker.sh" "$R/scripts/gates-marker.sh"
  # The stubs: three stages, verify-free among them. Each records that it ran;
  # STUB_FAIL names one to fail, STUB_MOVE one that commits (HEAD moves),
  # STUB_DIRTY one that leaves an untracked file. The build waits (5 s at most)
  # for verify-free to have STARTED: the proof that it runs beside the others.
  # BACKGROUND_STAGES is set here too: the free copy's is empty (its verify-free
  # line sits in a !pro: region), and this file runs in the free tree as well.
  cat > "$BATS_TEST_TMPDIR/stubs.sh" <<STUBS
preflight() { return 0; }
FULL_STAGES="build bash-engine verify-free"
BACKGROUND_STAGES="verify-free"
stub() {
  echo "\$1" >> "$M/ran"
  [ "\${STUB_FAIL:-}" = "\$1" ] && return 1
  [ "\${STUB_MOVE:-}" = "\$1" ] && git -C "$R" commit -q --allow-empty -m moved
  [ "\${STUB_DIRTY:-}" = "\$1" ] && echo x > "$R/stray.txt"
  return 0
}
stage_build() {
  local i=0
  while [ ! -f "$M/vf-started" ] && [ \$i -lt 50 ]; do sleep 0.1; i=\$((i + 1)); done
  [ -f "$M/vf-started" ] && echo build-saw-vf >> "$M/ran"
  stub build
}
stage_bash_engine() { stub bash-engine; }
stage_verify_free() { : > "$M/vf-started"; echo "vf-tmpdir \$TMPDIR" >> "$M/ran"; sleep 1; stub verify-free; }
STUBS
  awk -v stubs="$BATS_TEST_TMPDIR/stubs.sh" '
    /^\(return 0 2>\/dev\/null\) && return 0$/ { while ((getline l < stubs) > 0) print l }
    { print }' "$GATES" > "$R/scripts/gates.sh"
  grep -q 'FULL_STAGES="build bash-engine verify-free"' "$R/scripts/gates.sh"
  git -C "$R" add -A; git -C "$R" commit -qm init
  COMMON="$(cd "$R" && cd "$(git rev-parse --git-common-dir)" && pwd)"
}

gates() { run env TMPDIR="$BATS_TEST_TMPDIR/tmp" GATES_BG_TMP_BASE="$BATS_TEST_TMPDIR/bg" "$SYS_BASH" "$R/scripts/gates.sh" "$@"; }

@test "gates-record: a dirty tree is refused before stage one, naming what is dirty" {
  echo x > "$R/untracked.txt"
  gates
  [ "$status" -eq 2 ]
  assert_contains "$output" "the tree is not clean"
  assert_contains "$output" "untracked.txt"
  [ ! -f "$M/ran" ]
  # --quick verifies no commit, and refuses nothing.
  sed -n '/^QUICK_STAGES=/p' "$R/scripts/gates.sh" | grep -q scrub
}

@test "gates-record: a green run writes the sha and the JSON into the common gitdir" {
  gates
  [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
  head="$(git -C "$R" rev-parse HEAD)"
  [ "$(cat "$COMMON/phase-console-gates-ok")" = "$head" ]
  J="$COMMON/phase-console-gates-ok.json"
  [ -f "$J" ]
  run node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const want = ["head", "head_at_start", "head_now", "stages", "total_s", "started_at", "ended_at",
      "versions", "env_digest", "env_keys", "load", "drained"];
    const missing = want.filter((k) => !(k in j));
    if (missing.length) { console.log("missing " + missing); process.exit(1); }
    if (j.head !== process.argv[2] || j.head_now !== j.head || j.head_at_start !== j.head) { console.log("heads"); process.exit(1); }
    console.log(j.stages.map((s) => s.name + ":" + typeof s.seconds).join(" "));
    console.log("node=" + (j.versions.node ? "yes" : "no") + " drained=" + j.drained + " load=" + (j.load.start && typeof j.load.start.load1));' "$J" "$head"
  [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
  [ "${lines[0]}" = "build:number bash-engine:number verify-free:number" ]
  [ "${lines[1]}" = "node=yes drained=false load=number" ]
  # And the reader the hook and release.sh share accepts it for the full matrix.
  run "$SYS_BASH" -c ". '$PE_SCRIPTS/gates-marker.sh'; gates_marker_check '$R' build bash-engine verify-free"
  [ "$status" -eq 0 ]
}

@test "gates-record: verify-free starts beside the first stage, in a TMPDIR of its own, and is awaited last" {
  gates
  [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
  grep -qx build-saw-vf "$M/ran"
  grep -q "^vf-tmpdir $BATS_TEST_TMPDIR/bg/pcg-verify-free\.......$" "$M/ran"
  # Short (a unix socket under it must fit macOS's 104 bytes) and gone once the run ends.
  vf_tmp="$(sed -n 's/^vf-tmpdir //p' "$M/ran")"
  [ ! -e "$vf_tmp" ]
  grep -q 'GATES_BG_TMP_BASE:-/tmp}/pcg-' "$R/scripts/gates.sh"
  # The report reads in the list's order: verify-free's line comes last.
  stage_lines="$(printf '%s\n' "$output" | grep -E '^(ok|FAIL) ' | awk '{print $2}' | tr '\n' ' ')"
  [ "$stage_lines" = "build bash-engine verify-free " ]
}

@test "gates-record: a red stage stops the run, takes verify-free down with it and leaves no record" {
  STUB_FAIL=build gates
  [ "$status" -eq 1 ]
  [ ! -f "$COMMON/phase-console-gates-ok" ]
  [ ! -f "$COMMON/phase-console-gates-ok.json" ]
  refute_contains "$output" "bash-engine"
}

@test "gates-record: a HEAD that moves during the run leaves no record" {
  record_gates_green "$R"   # a stale record from before: removed at the start
  STUB_MOVE=bash-engine gates
  [ "$status" -eq 0 ]
  assert_contains "$output" "HEAD moved during the run"
  [ ! -f "$COMMON/phase-console-gates-ok" ]
  [ ! -f "$COMMON/phase-console-gates-ok.json" ]
}

@test "gates-record: a tree that turns dirty during the run leaves no record" {
  STUB_DIRTY=bash-engine gates
  [ "$status" -eq 0 ]
  assert_contains "$output" "the tree changed during the run"
  assert_contains "$output" "stray.txt"
  [ ! -f "$COMMON/phase-console-gates-ok" ]
}

# --- the drain ----------------------------------------------------------------
# A stub console CLI: logs its argv, answers the census with LANES live lanes
# (decremented on every read until 0, so a drain settles), and `fleet hold`
# fails when HOLD_FAIL is set.
drain_cli() {
  CLI="$BATS_TEST_TMPDIR/cli"
  echo "${1:-0}" > "$M/lanes"
  cat > "$CLI" <<CLI
#!/bin/bash
echo "\$*" >> "$M/cli"
case "\$*" in
  "fleet hold --by gates") [ -n "\${HOLD_FAIL:-}" ] && { echo "the machine is already held" >&2; exit 1; }; echo held ;;
  "fleet release") echo released ;;
  "fleet instances --json")
    n=\$(cat "$M/lanes"); [ "\${LANES_STUCK:-}" = 1 ] || { [ "\$n" -gt 0 ] && echo \$((n - 1)) > "$M/lanes"; }
    printf '{"rows":[{"id":"a","lanes":{"live":%s,"max":3}},{"id":"b","lanes":{"live":0,"max":3}}]}\n' "\$n" ;;
esac
CLI
  chmod +x "$CLI"
}
drain() { run env GATES_CONSOLE_CLI="$CLI" GATES_DRAIN_POLL_S=1 GATES_DRAIN_CAP_S="${CAP:-30}" TMPDIR="$BATS_TEST_TMPDIR/tmp" "$SYS_BASH" "$R/scripts/gates.sh" --drain "$@"; }

@test "gates-record: --drain holds, waits for the live lanes to settle, runs, releases and records it" {
  drain_cli 2
  drain
  [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
  assert_contains "$output" "gate.drain held by=gates lanes=2 waited=2s capped=false"
  [ "$(head -n 1 "$M/cli")" = "fleet hold --by gates" ]
  [ "$(tail -n 1 "$M/cli")" = "fleet release" ]
  # The hold came before any stage ran.
  [ -f "$M/ran" ]
  run node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log(j.drained, j.drain.capped, j.drain.waited_s, j.drain.lanes_at_start)' "$COMMON/phase-console-gates-ok.json"
  [ "$output" = "true false 2 2" ]
}

@test "gates-record: --drain runs anyway at the cap, and says so" {
  drain_cli 1
  LANES_STUCK=1 CAP=2 drain
  [ "$status" -eq 0 ]
  assert_contains "$output" "capped=true"
  assert_contains "$output" "running anyway"
  [ "$(tail -n 1 "$M/cli")" = "fleet release" ]
}

@test "gates-record: --drain releases the hold when a stage fails" {
  drain_cli 0
  STUB_FAIL=bash-engine drain
  [ "$status" -eq 1 ]
  [ "$(tail -n 1 "$M/cli")" = "fleet release" ]
}

@test "gates-record: --drain releases the hold when the run is killed" {
  drain_cli 0
  # bash-engine sleeps long enough to be killed mid-run.
  sed -i.bak 's/^stage_bash_engine() { stub bash-engine; }$/stage_bash_engine() { sleep 30; }/' "$R/scripts/gates.sh"
  rm -f "$R/scripts/gates.sh.bak"
  git -C "$R" commit -qam slow
  GATES_CONSOLE_CLI="$CLI" GATES_DRAIN_POLL_S=1 TMPDIR="$BATS_TEST_TMPDIR/tmp" "$SYS_BASH" "$R/scripts/gates.sh" --drain > "$M/out" 2>&1 &
  pid=$!
  i=0; while ! grep -q '^ok    build' "$M/out" && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
  kill -TERM "$pid"
  wait "$pid" || true
  [ "$(tail -n 1 "$M/cli")" = "fleet release" ]
}

@test "gates-record: a refused hold is said, and the run goes on undrained" {
  drain_cli 0
  HOLD_FAIL=1 drain
  [ "$status" -eq 0 ]
  assert_contains "$output" "gate.drain refused"
  refute_contains "$(cat "$M/cli")" "fleet release"
}
