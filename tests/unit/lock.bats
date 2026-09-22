#!/usr/bin/env bats
# phase-lock.sh — cooperative phase claims with a lease (the concurrency guard).
# Contract: phase-lock.sh <slug> <claim|release|status|list> <N> [--owner X] [--lease SECS]
# Lock files live at docs/handoffs/<slug>/.locks/phase-NN.lock
# RED until scripts/phase-lock.sh exists.
load ../helpers/test_helper

setup() {
  # The `session=` line is written only when an id is known; this suite may
  # itself run inside a Claude session that exports one. `PE_BRANCH` and
  # `PE_WORKTREE` join it because this suite may run inside a worktree LANE,
  # whose runner exports both — and `branch=` is one `conflicts` acts on.
  unset PE_SESSION_ID CLAUDE_CODE_SESSION_ID PE_BRANCH PE_WORKTREE
}

@test "lock: claim creates the lock file under .locks/" {
  setup_docs linear linear
  run pe_lock linear claim 1 --owner sessionA
  [ "$status" -eq 0 ]
  [ -f "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock" ]
}

@test "lock: a second owner is refused and told who holds it" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  run pe_lock linear claim 1 --owner sessionB
  [ "$status" -ne 0 ]
  assert_contains "$output" "sessionA"
}

@test "lock: same owner re-claim is idempotent (exit 0)" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  run pe_lock linear claim 1 --owner sessionA
  [ "$status" -eq 0 ]
}

# The default lease must be longer than a PHASE, because a lapsed lease is
# silently taken over by anyone — that is the cooperative design and it is
# right. It was 30 minutes and a real phase runs 45 minutes to two hours; the
# console's own sessions never noticed, because the runner refreshes on a timer,
# which is exactly why the wrong number survived: it only ever hurt a session
# driven by hand, which has nothing refreshing anything.
@test "lock: the default lease is two hours" {
  setup_docs linear linear
  before="$(date +%s)"
  pe_lock linear claim 1 --owner sessionA
  f="$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
  until_ts="$(sed -n 's/^lease_until=//p' "$f")"
  # A window rather than an equality: the claim reads its own clock, and the
  # test's `date` is a moment earlier. Anything under an hour would mean the
  # default went back to a number shorter than a phase.
  [ "$((until_ts - before))" -ge 7100 ]
  [ "$((until_ts - before))" -le 7300 ]
}

# …and an explicit `--lease` still wins over it, which is what the runner
# passes (RUNNER_LEASE_S = 5400 s — nine 10-minute refresh cadences, so eight
# refresh ticks may be missed before a claim it is actively holding can lapse).
@test "lock: an explicit --lease overrides the default" {
  setup_docs linear linear
  before="$(date +%s)"
  pe_lock linear claim 1 --owner sessionA --lease 5400
  f="$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
  until_ts="$(sed -n 's/^lease_until=//p' "$f")"
  [ "$((until_ts - before))" -ge 5300 ]
  [ "$((until_ts - before))" -le 5500 ]
}

# The autopilot's lease keepalive is exactly a same-owner re-claim on a timer:
# a live 47-minute phase must never lose its lease mid-work. This pins the two
# facts the keepalive stands on: the lease moves forward, and the scope line
# survives.
@test "lock: same-owner re-claim REFRESHES the lease and keeps the scope line" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA --scope "repoA" --lease 60
  f="$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
  first="$(grep '^lease_until=' "$f")"
  run pe_lock linear claim 1 --owner sessionA --scope "repoA" --lease 3600
  [ "$status" -eq 0 ]
  assert_contains "$output" "refreshed"
  second="$(grep '^lease_until=' "$f")"
  [ "$first" != "$second" ]
  # scope_normalize lowercases; the file carries the normalized csv.
  grep -q '^scope=.*repoa' "$f"
}

# `branch=` rides the same keepalive and is worse to lose than `scope=`: an
# un-qualified lock collides with EVERYTHING, so a refresh that dropped it would
# silently retract a worktree lane's carve-out one third of a lease into the run
# — the run keeps working, admission quietly stops. Same defect class as
# engine-4's scope drop, pinned before it can happen again.
@test "lock: same-owner re-claim keeps the branch line, and an explicit one wins" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA --scope "repoA" --branch "pe/lane-1"
  f="$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
  pe_lock linear claim 1 --owner sessionA
  assert_contains "$(cat "$f")" "branch=pe/lane-1"
  pe_lock linear claim 1 --owner sessionA --branch "pe/moved"
  assert_contains "$(cat "$f")" "branch=pe/moved"
  # Unlike the scope, the branch is NOT lowercased or normalised — refs are
  # case-sensitive, and folding one would merge two real branches into one.
  pe_lock linear claim 1 --owner sessionA --branch "PE/Moved"
  assert_contains "$(cat "$f")" "branch=PE/Moved"
}

@test "lock: --branch with no value is a usage error and writes nothing" {
  setup_docs linear linear
  run pe_lock linear claim 1 --owner sessionA --branch
  [ "$status" -ne 0 ]
  [ ! -f "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock" ]
}

@test "lock: a newline in a branch cannot inject lines into the lock file" {
  # The same class as the owner injection above (xcut-7), and worse: an injected
  # line lands in a file read by the rule that DECIDES admission, so a crafted
  # branch could rewrite the scope a second reader sees.
  setup_docs linear linear
  run pe_lock linear claim 1 --owner sessionA --scope "repoA" \
    --branch "$(printf 'pe/a\nscope=all')"
  [ "$status" -eq 0 ]
  f="$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
  [ "$(grep -c '^branch=' "$f")" -eq 1 ]
  [ "$(grep -c '^scope=' "$f")" -eq 1 ]
  assert_contains "$(cat "$f")" "scope=repoa"
}

@test "lock: release frees the lock for another owner" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  pe_lock linear release 1 --owner sessionA
  run pe_lock linear claim 1 --owner sessionB
  [ "$status" -eq 0 ]
}

@test "lock: an expired lease can be taken over" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  expire_lock linear 1
  run pe_lock linear claim 1 --owner sessionB
  [ "$status" -eq 0 ]
  assert_contains "$output" "takeover"
}

@test "lock: status names the current holder" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  run pe_lock linear status 1
  assert_contains "$output" "sessionA"
}

@test "lock: status of an unclaimed phase reports free" {
  setup_docs linear linear
  run pe_lock linear status 1
  [ "$status" -eq 0 ]
  assert_contains "$output" "free"
}

# ---- session= : the presence channel between a lock and the console ----------

@test "lock: --session writes a session= line and status/list print it" {
  setup_docs linear linear
  run pe_lock linear claim 1 --owner sessionA --session s1
  [ "$status" -eq 0 ]
  f="$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
  grep -q '^session=s1$' "$f"
  run pe_lock linear status 1
  assert_contains "$output" "[session: s1]"
  run pe_lock linear list
  assert_contains "$output" "[session: s1]"
}

@test "lock: no session known ⇒ no session= line (older readers see the lock they always saw)" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  f="$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
  ! grep -q '^session=' "$f"
  run pe_lock linear status 1
  refute_contains "$output" "session:"
}

@test "lock: the session defaults to PE_SESSION_ID, then CLAUDE_CODE_SESSION_ID; --session beats both" {
  setup_docs linear linear
  f="$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
  PE_SESSION_ID="env-1" pe_lock linear claim 1 --owner sessionA
  grep -q '^session=env-1$' "$f"
  pe_lock linear release 1 --owner sessionA
  CLAUDE_CODE_SESSION_ID="cc-2" pe_lock linear claim 1 --owner sessionA
  grep -q '^session=cc-2$' "$f"
  pe_lock linear release 1 --owner sessionA
  PE_SESSION_ID="env-1" CLAUDE_CODE_SESSION_ID="cc-2" pe_lock linear claim 1 --owner sessionA
  grep -q '^session=env-1$' "$f"
  pe_lock linear release 1 --owner sessionA
  PE_SESSION_ID="env-1" pe_lock linear claim 1 --owner sessionA --session flag-3
  grep -q '^session=flag-3$' "$f"
  # Only id characters survive — one line in a key=value file.
  pe_lock linear release 1 --owner sessionA
  pe_lock linear claim 1 --owner sessionA --session 'a b=c'
  grep -q '^session=abc$' "$f"
}

@test "lock: a same-owner refresh that names no session KEEPS the session= line (the runner's keepalive must not strip it)" {
  setup_docs linear linear
  f="$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
  pe_lock linear claim 1 --owner sessionA --scope repoA --session s1 --lease 60
  run pe_lock linear claim 1 --owner sessionA --scope repoA --lease 3600
  [ "$status" -eq 0 ]
  assert_contains "$output" "refreshed"
  grep -q '^session=s1$' "$f"
  # A refresh that names a NEW session replaces it.
  pe_lock linear claim 1 --owner sessionA --scope repoA --session s2
  grep -q '^session=s2$' "$f"
  ! grep -q '^session=s1$' "$f"
}

@test "lock: a takeover writes the taker's session, never the previous holder's" {
  setup_docs linear linear
  f="$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
  pe_lock linear claim 1 --owner sessionA --session s1
  expire_lock linear 1
  run pe_lock linear claim 1 --owner sessionB
  [ "$status" -eq 0 ]
  ! grep -q '^session=' "$f"
}

# --- engine-13 / xcut-7: the two fields that were never validated -------------

@test "lock: --lease must be a positive number of seconds" {
  # Under bash 3.2 an unset/non-numeric name inside $(( )) evaluates to 0, so
  # `--lease abc` wrote lease_until == claimed_at — an already-expired lock that
  # the very next claim from any owner takes over, reporting a cheerful
  # "takeover — previous lease had expired".
  setup_docs linear linear
  run pe_lock linear claim 1 --owner sessionA --lease abc
  [ "$status" -eq 2 ]
  assert_contains "$output" "--lease must be a positive number of seconds"
  [ ! -f "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock" ]

  run pe_lock linear claim 1 --owner sessionA --lease 0
  [ "$status" -eq 2 ]
  run pe_lock linear claim 1 --owner sessionA --lease -5
  [ "$status" -eq 2 ]
  run pe_lock linear claim 1 --owner sessionA --lease 60
  [ "$status" -eq 0 ]
}

@test "lock: an owner carrying a newline cannot inject lines into the lock file" {
  # xcut-7. `session` and `scope` were sanitised; `owner` — the field every
  # reader keys on — went straight into `printf 'owner=%s\n'`. bash reads a
  # duplicated key first-wins (grep -m1) and the TS parser read it last-wins, so
  # the two halves of the system named different holders for the same lock.
  setup_docs linear linear
  run pe_lock linear claim 1 --owner "$(printf 'good\nowner=evil')"
  [ "$status" -eq 0 ]
  f="$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
  [ "$(grep -c '^owner=' "$f")" -eq 1 ]
  assert_contains "$(cat "$f")" "owner=goodowner=evil"
}

@test "lock: a zero-padded phase claims the same lock as the plain number" {
  # Handoff files are phase-08-*.md, so `08` is what gets copied into a command.
  setup_docs linear linear
  run pe_lock linear claim 08 --owner sessionA
  [ "$status" -eq 0 ]
  [ -f "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-08.lock" ]
  assert_contains "$(cat "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-08.lock")" "phase=8"
  run pe_lock linear claim 8 --owner sessionB
  [ "$status" -eq 1 ]
}

@test "lock: a claim from inside a submodule lane lands under the HUB's docs, qualified by --here" {
  setup_super_lane "$BATS_TEST_TMPDIR/hub"
  mkdir -p "$HUB/docs/handoffs/demo"
  run env -u DOCS_ROOT bash -c "cd '$LANE' && /bin/bash '$PE_SCRIPTS/phase-lock.sh' demo claim 1 --owner sessionA --here"
  [ "$status" -eq 0 ]
  [ -f "$HUB/docs/handoffs/demo/.locks/phase-01.lock" ]
  grep -q '^branch=pe/demo-p1$' "$HUB/docs/handoffs/demo/.locks/phase-01.lock"
  grep -q '^worktree=' "$HUB/docs/handoffs/demo/.locks/phase-01.lock"
}

# ── LCK-1 — claim is check-then-write, so two claimers both "win" ─────────────
# `[ -f "$lockfile" ]` and the `mv` inside `_write` are two steps with a real
# gap between them (the scope read alone is tens of milliseconds), and nothing
# in between makes the create exclusive. Two sessions boarded within that gap
# were BOTH told "claimed", which is precisely the outcome the whole cooperative
# guard exists to prevent — and the reason a lock must be created with a call
# that fails when the target already exists.
@test "lock: two concurrent claims on one phase — exactly one wins (LCK-1)" {
  setup_docs linear linear
  local i rounds=20 wins=0 total=0 ra rb
  for i in $(seq 1 "$rounds"); do
    rm -f "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
    # No --scope on purpose: reading the plan's Repos cell is what widens the
    # window to something two processes can genuinely land inside.
    # `|| rc=$?` keeps the losing claim's non-zero exit out of `set -e`'s way —
    # bats runs tests with it on, and a bare `cmd; echo $?` kills the subshell
    # before it can report the very exit code under test.
    ( rc=0; "$SYS_BASH" "$PE_SCRIPTS/phase-lock.sh" linear claim 1 --owner raceA >/dev/null 2>&1 || rc=$?
      echo "$rc" > "$BATS_TEST_TMPDIR/rc.A" ) &
    ( rc=0; "$SYS_BASH" "$PE_SCRIPTS/phase-lock.sh" linear claim 1 --owner raceB >/dev/null 2>&1 || rc=$?
      echo "$rc" > "$BATS_TEST_TMPDIR/rc.B" ) &
    wait
    ra="$(cat "$BATS_TEST_TMPDIR/rc.A")"; rb="$(cat "$BATS_TEST_TMPDIR/rc.B")"
    if [ "$ra" = 0 ]; then wins=$((wins + 1)); fi
    if [ "$rb" = 0 ]; then wins=$((wins + 1)); fi
    total=$((total + 1))
    # The loser must be told WHO holds it, not merely refused.
    if [ "$ra" != 0 ] && [ "$rb" != 0 ]; then echo "round $i: nobody claimed" >&2; return 1; fi
  done
  echo "winners=$wins rounds=$total" >&2
  [ "$wins" -eq "$total" ]
}

@test "lock: the loser of a race is told who holds it (LCK-1)" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner raceA
  run pe_lock linear claim 1 --owner raceB
  [ "$status" -eq 1 ]
  assert_contains "$output" "raceA"
}

# A force/takeover/refresh writes with `mv`, which clobbers whatever landed in
# the meantime. Re-reading the owner back off the file is what turns "I wrote
# it" into "I hold it" — the only claim the caller may act on.
@test "lock: a force-claim reports the owner the file actually carries (LCK-1)" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  run pe_lock linear claim 1 --owner sessionB --force
  [ "$status" -eq 0 ]
  grep -q '^owner=sessionB$' "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
}

# ── LCK-5 — release's rmdir races a claim on another phase of the same slug ───
# `release` takes the last lock away and rmdir's `.locks`; a claim on a
# DIFFERENT phase has already mkdir'd it and is about to open its tmp file
# inside. The window is small, which is why this is a regression net rather
# than a reproduction — but a claim must never fail because somebody else
# finished.
@test "lock: a release that sweeps .locks never breaks a concurrent claim (LCK-5)" {
  setup_docs linear linear
  local i rounds=30
  rm -f "$BATS_TEST_TMPDIR/lck5.fail"
  for i in $(seq 1 "$rounds"); do
    pe_lock linear claim 1 --owner sweepA >/dev/null 2>&1
    ( "$SYS_BASH" "$PE_SCRIPTS/phase-lock.sh" linear release 1 --owner sweepA >/dev/null 2>&1 ) &
    ( "$SYS_BASH" "$PE_SCRIPTS/phase-lock.sh" linear claim 2 --owner sweepB >/dev/null 2>&1 \
        || echo "round $i" >> "$BATS_TEST_TMPDIR/lck5.fail" ) &
    wait
    rm -f "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-02.lock"
  done
  [ ! -f "$BATS_TEST_TMPDIR/lck5.fail" ]
}

# ── the `pid=` line ──────────────────────────────────────────────────────────
# A lock records WHO, WHERE and WHICH SESSION. The one thing it could never say
# is whether the process that took it is still alive — which is the fact a
# reader most wants when the owner is the machine default and no session id was
# ever known. Recording it costs one line; acting on it is a later phase's.
@test "lock: a claim records the pid of the process that took it" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  run grep -c '^pid=[0-9][0-9]*$' "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
  [ "$status" -eq 0 ]
  [ "$output" = "1" ]
}

# ---------------------------------------------------------------------------
# The trace carrier (5.1.0): a lock says which drive took it.
# ---------------------------------------------------------------------------

@test "lock: the claim records trace= when the session was spawned inside a span" {
  setup_docs linear linear
  PE_TRACE_ID="0123456789abcdef0123456789abcdef" PE_SPAN_ID="fedcba9876543210" \
    run pe_lock linear claim 1 --owner sessionA
  [ "$status" -eq 0 ]
  grep -q '^trace=0123456789abcdef0123456789abcdef$' "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
  grep -q '^span=fedcba9876543210$' "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
}

@test "lock: with no trace in the environment the file carries no trace= line" {
  setup_docs linear linear
  unset PE_TRACE_ID PE_SPAN_ID
  run pe_lock linear claim 1 --owner sessionA
  [ "$status" -eq 0 ]
  ! grep -q '^trace=' "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
  # And `pid=` must STILL be the last line: it is the one that always prints,
  # which is what keeps the group's exit status from being a failing `[ -n … ]`.
  [ "$(tail -1 "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock" | cut -d= -f1)" = pid ]
}

@test "lock: trace= comes BEFORE pid=, so pid stays the last line" {
  setup_docs linear linear
  PE_TRACE_ID="0123456789abcdef0123456789abcdef" PE_SPAN_ID="fedcba9876543210" \
    run pe_lock linear claim 1 --owner sessionA
  [ "$status" -eq 0 ]
  [ "$(tail -1 "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock" | cut -d= -f1)" = pid ]
}
