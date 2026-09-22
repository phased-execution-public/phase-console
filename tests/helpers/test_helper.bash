#!/usr/bin/env bash
# Common helpers for phased-execution bats tests.
#
# IMPORTANT: scripts under test are ALWAYS invoked under /bin/bash (macOS system
# bash 3.2) — the real target runtime — not the (possibly newer) bash that runs
# bats. This is what actually catches 3.2-specific regressions.

# Skill root, resolved from this helper's location: tests/helpers/ -> skill root.
PE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PE_SCRIPTS="$PE_DIR/scripts"
SYS_BASH="/bin/bash"

# --- runners (each forces the 3.2 system bash) --------------------------------
pg()          { DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" "$SYS_BASH" "$PE_SCRIPTS/phase-graph.sh"      "$@"; }
pe_validate() { DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" "$SYS_BASH" "$PE_SCRIPTS/validate.sh"          "$@"; }
pe_lock()     { DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" "$SYS_BASH" "$PE_SCRIPTS/phase-lock.sh"        "$@"; }
pe_newplan()  {                                                "$SYS_BASH" "$PE_SCRIPTS/new-plan.sh"          "$@"; }
pe_newho()    {                                                "$SYS_BASH" "$PE_SCRIPTS/new-handoff.sh"       "$@"; }
pe_nextp()    { DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" "$SYS_BASH" "$PE_SCRIPTS/next-phase-prompt.sh"  "$@"; }
pe_hostatus() { DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" "$SYS_BASH" "$PE_SCRIPTS/handoff-status.sh"     "$@"; }
qa_record()   { DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" "$SYS_BASH" "$PE_SCRIPTS/qa-record.sh"          "$@"; }
gate_approve(){ DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" "$SYS_BASH" "$PE_SCRIPTS/gate-approve.sh"       "$@"; }
# phase-outcome.sh needs no DOCS_ROOT — it writes $PE_OUTCOME_FILE, or (unsupervised)
# the console's inbox for the root it derives the way phase-lock.sh does.
pe_outcome()  {                                                "$SYS_BASH" "$PE_SCRIPTS/phase-outcome.sh"     "$@"; }
# phase-tasks.sh is phase-outcome.sh's twin and needs no DOCS_ROOT for the same
# reason: it writes $PE_TASKS_FILE, or (unsupervised) the console's own inbox.
pe_tasks()    {                                                "$SYS_BASH" "$PE_SCRIPTS/phase-tasks.sh"       "$@"; }
# phase-msg.sh is their third sibling and needs no DOCS_ROOT either: it writes
# $PE_MESSAGES_FILE, or (unsupervised) the console's own inbox for the root it
# derives the way phase-lock.sh does.
pe_msg()      {                                                "$SYS_BASH" "$PE_SCRIPTS/phase-msg.sh"         "$@"; }
# phase-issue.sh is the fourth: it writes $PE_ISSUES_FILE, or (unsupervised) the
# console's own inbox — but it READS the plan's `**Issues:**` word through
# phase-graph.sh first, so it does take DOCS_ROOT.
pe_issue()    { DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" "$SYS_BASH" "$PE_SCRIPTS/phase-issue.sh"       "$@"; }
# session-hook.sh reads the hook payload on stdin; it needs no DOCS_ROOT either.
pe_hook()     {                                                "$SYS_BASH" "$PE_SCRIPTS/session-hook.sh"      "$@"; }
# PE_TODAY keeps closure dates off the wall clock so assertions stay stable.
pe_close()    { DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" PE_TODAY="${PE_TODAY:-2026-01-02}" \
                "$SYS_BASH" "$PE_SCRIPTS/close-plan.sh" "$@"; }

# --- the ambient session, scrubbed -------------------------------------------
# The scripts under test read PE_* from the environment BY DESIGN: a supervised
# session has PE_SCOPE/PE_OWNER/PE_SESSION_ID exported into it so phase-lock.sh
# records them without being told. That is also how this suite gets three false
# failures the moment it is run from inside such a session — a lock claimed with
# no --scope picks up the ambient one, and `lock-scope.bats` asserts a lock
# written WITHOUT a scope. The suite must describe the scripts, not the shell it
# happens to run in, so the ambient values are dropped here; a test that wants
# one sets it itself.
scrub_pe_env() {
  unset PE_SCOPE PE_OWNER PE_SESSION_ID PE_OUTCOME_FILE PE_RULINGS_FILE PE_TASKS_FILE PE_MCP_SERVERS \
    PE_MESSAGES_FILE PE_MSG_TOKEN PE_ISSUES_FILE PE_ISSUES_MODE PE_TRACE_ID
}

# --- fixtures / scaffolding ---------------------------------------------------
# Create an isolated DOCS_ROOT in the bats temp dir and install a fixture plan.
# usage: setup_docs <fixture-name> <slug>
setup_docs() {
  local fixture="$1" slug="$2"
  scrub_pe_env
  export DOCS_ROOT="$BATS_TEST_TMPDIR/work"
  mkdir -p "$DOCS_ROOT/docs/plans" "$DOCS_ROOT/docs/handoffs/$slug"
  cp "$PE_DIR/tests/fixtures/plans/$fixture.md" "$DOCS_ROOT/docs/plans/$slug.md"
}

# Write a minimal handoff with a given status for state tests.
# usage: write_handoff <slug> <N> <title> <status>   (status: complete|in-progress|blocked|pending)
write_handoff() {
  local slug="$1" n="$2" title="$3" status="$4" pad f
  pad="$(printf '%02d' "$n")"
  f="$DOCS_ROOT/docs/handoffs/$slug/phase-$pad-$title.md"
  mkdir -p "$(dirname "$f")"
  cat > "$f" <<EOF
---
plan: docs/plans/$slug.md
phase: $n
title: $title
status: $status
---
# Phase $n — $title
EOF
}

# Back-date a lock's lease so it reads as expired, without waiting and without
# claiming a zero lease (which phase-lock.sh rightly refuses: `--lease abc`
# evaluated to 0 under bash 3.2 and wrote an instantly-takeable lock, so 0 is now
# an error). The precondition under test is "the lease has passed", and this
# states it directly instead of going through the claim path to produce it.
# usage: expire_lock <slug> <N>
expire_lock() {
  local slug="$1" pad f
  pad="$(printf '%02d' "$2")"
  f="$DOCS_ROOT/docs/handoffs/$slug/.locks/phase-$pad.lock"
  [ -f "$f" ] || { echo "expire_lock: no lock at $f" >&2; return 1; }
  sed "s/^lease_until=.*/lease_until=1/" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
}

# Hand-write a lock in the pre-scope format — no `scope=` line at all. `claim`
# now fills the scope from the plan's Repos cell when it is told none, so this is
# the only way left to produce the shape an older copy of the script wrote, and
# every reader still has to treat it as "unknown scope" (which collides with
# everything). usage: write_legacy_lock <slug> <N> <owner> [lease-seconds]
write_legacy_lock() {
  local slug="$1" n="$2" owner="$3" lease="${4:-1800}" pad f now
  pad="$(printf '%02d' "$n")"
  f="$DOCS_ROOT/docs/handoffs/$slug/.locks/phase-$pad.lock"
  now="$(date +%s)"
  mkdir -p "$(dirname "$f")"
  cat > "$f" <<EOF
slug=$slug
phase=$n
owner=$owner
host=testhost
claimed_at=$now
lease_until=$((now + lease))
EOF
}

# Initialise a throwaway git repo as a DOCS_ROOT (for git-root / path tests).
# usage: setup_git_docs <fixture-name> <slug>   (leaves DOCS_ROOT UNSET on purpose)
setup_git_docs() {
  local fixture="$1" slug="$2" root="$BATS_TEST_TMPDIR/gitwork"
  mkdir -p "$root/docs/plans" "$root/docs/handoffs/$slug"
  cp "$PE_DIR/tests/fixtures/plans/$fixture.md" "$root/docs/plans/$slug.md"
  git -C "$root" init -q
  git -C "$root" config user.email t@t.t
  git -C "$root" config user.name t
  echo "$root"
}

# How many rows a phase has in test-status.md's GATING table — the `## QA status`
# section alone. A plain `grep -c '^| N |'` over the whole file stopped answering
# this the day rounds landed: `## QA rounds` holds one row per (phase, round) and
# its rows begin with the same phase number, so a healthy two-round phase counted
# as three duplicates. The invariant these tests exist to hold is unchanged — ONE
# row per phase in the table that gates — so the count has to name that table.
qa_status_rows() {  # qa_status_rows <file> <phase> -> count on stdout
  awk -F'|' -v want="$2" '
    function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); gsub(/[*`]/,"",s); sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
    BEGIN{ n=0 }
    tolower($0) ~ /^##[[:space:]]+qa[[:space:]]+status/ { inq=1; seen=0; next }
    /^[[:space:]]*#/ { inq=0; seen=0; next }
    inq && seen && $0 !~ /^[[:space:]]*\|/ { inq=0; seen=0 }
    inq && /^[[:space:]]*\|/ { seen=1; if (trim($2) == want) n++ }
    END{ print n }
  ' "$1"
}

# assert helpers
assert_contains() { case "$1" in *"$2"*) : ;; *) echo "expected to contain: $2" >&2; echo "actual: $1" >&2; return 1 ;; esac; }
refute_contains() { case "$1" in *"$2"*) echo "expected NOT to contain: $2" >&2; echo "actual: $1" >&2; return 1 ;; *) : ;; esac; }

# setup_super_lane <hubdir> — a superproject at <hubdir> holding docs/plans/demo.md
# (the linear fixture) and one submodule `sub` (its own repository at
# <hubdir>-subsrc), plus a LINKED WORKTREE of that submodule at <hubdir>-lane on
# branch `pe/demo-p1` — the shape of a console lane or a hand lane. Sets HUB,
# SUB_SRC and LANE. The lane holds no docs/ at all, so a script that answers
# the plan from inside it has found the hub, not itself.
setup_super_lane() {
  local hub="$1"
  HUB="$hub"; SUB_SRC="$hub-subsrc"; LANE="$hub-lane"
  mkdir -p "$SUB_SRC"
  git -C "$SUB_SRC" init -q
  git -C "$SUB_SRC" config user.email t@t.t; git -C "$SUB_SRC" config user.name t
  echo x > "$SUB_SRC/f"; git -C "$SUB_SRC" add f; git -C "$SUB_SRC" commit -qm init
  mkdir -p "$hub/docs/plans"
  cp "$PE_DIR/tests/fixtures/plans/linear.md" "$hub/docs/plans/demo.md"
  git -C "$hub" init -q
  git -C "$hub" config user.email t@t.t; git -C "$hub" config user.name t
  git -C "$hub" -c protocol.file.allow=always submodule add -q "$SUB_SRC" sub >/dev/null 2>&1
  git -C "$hub" add -A; git -C "$hub" commit -qm hub
  git -C "$hub/sub" worktree add -q "$LANE" -b pe/demo-p1 >/dev/null 2>&1
}
pe_lane()     { DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" "$SYS_BASH" "$PE_SCRIPTS/phase-lane.sh"        "$@"; }
pe_decisions() { DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" PE_TODAY="${PE_TODAY:-2026-09-14}" \
                "$SYS_BASH" "$PE_SCRIPTS/decisions.sh" "$@"; }
