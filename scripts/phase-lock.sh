#!/usr/bin/env bash
# Cooperative phase locking for phased-execution — the concurrency guard.
#
# A lock is a small file at docs/handoffs/<slug>/.locks/phase-NN.lock recording
# WHO is working a phase and a LEASE (expiry time). It lets a second session
# detect that another session already holds a phase and decide what to do, rather
# than two sessions silently building the same phase on top of each other.
#
# Cross-account / cross-machine: locks live in the project repo (work/docs), so
# pass --git to `git pull` before checking and commit+push the lock after
# claiming; other clones see it on their next pull. This is COOPERATIVE (relies on
# pull-before-claim), not a hard distributed mutex — on a real conflict it asks a
# human to decide.
#
# A lock also records the SCOPE of the phase — the repos it touches, from the
# plan's Repos column. Sessions on disjoint scopes cannot collide, so they may
# run at the same time; `conflicts` is the read-only question "would my scope hit
# any live lock, in ANY plan?". Claiming deliberately does NOT enforce scope: it
# still refuses only the same phase of the same plan, so an old console and an
# old script keep working. The policy lives where the answer can be acted on.
#
# A lock may also name the Claude SESSION that holds it (`session=`): the id the
# session-presence hook reports to Phase Console, which lets the console tell a
# lock whose session has ENDED (debris, released at once) from one whose session
# is live (queue behind it) — instead of waiting out the lease either way.
#
# A lock may also name the BRANCH the session's work rides (`branch=`). Unlike
# `worktree=`, this one is acted on: two claims whose scopes intersect are
# nevertheless disjoint when BOTH name a branch and the branches differ, because
# their commits cannot land on top of each other. An unqualified claim collides
# with everything, exactly like an unstated scope. See `claim_disjoint`.
#
# Usage:
#   phase-lock.sh <slug> claim   <N> [--owner ID] [--lease SECS] [--scope CSV] [--session ID] [--branch NAME] [--worktree DIR] [--here] [--git] [--force]
#   phase-lock.sh <slug> release <N> [--owner ID] [--git] [--force]
#   phase-lock.sh <slug> status  <N>
#   phase-lock.sh <slug> list
#   phase-lock.sh <slug> conflicts [N] [--scope CSV] [--branch NAME] [--worktree DIR] [--here] [--owner ID] [--git]
#
# Owner defaults to "$PE_OWNER" or "<user>@<host>". Pass a per-SESSION --owner
# (e.g. "account/conversation-id") so two sessions on the same host are distinct.
# Scope defaults to "$PE_SCOPE", else the plan's Repos cell for the phase.
# Session defaults to "$PE_SESSION_ID" (runner-injected), else
# "$CLAUDE_CODE_SESSION_ID" (Claude Code exports it to its own subprocesses);
# a same-owner refresh that states none keeps the line the lock already has.
# Branch defaults to "$PE_BRANCH" and is kept by a refresh the same way.
#
# Exit: 0 = ok / claimed / refreshed / taken-over / free / released / no conflict;
#       1 = held by another live session, or scope conflicts;  2 = usage error.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/scope.sh"

slug="${1:?usage: phase-lock.sh <slug> <claim|release|status|list|conflicts> [N] [opts]}"
action="${2:?usage: phase-lock.sh <slug> <claim|release|status|list|conflicts> [N] [opts]}"
shift 2

phase=""
case "$action" in
  claim|release|status)
    phase="${1:?usage: phase-lock.sh <slug> $action <N> ...}"; shift
    case "$phase" in ''|*[!0-9]*) echo "phase must be a number, got: $phase" >&2; exit 2 ;; esac
    ;;
  conflicts)
    # The phase is optional here: asking "does this scope collide with anything
    # live?" is a fair question before you know which phase you will take.
    if [ $# -gt 0 ]; then
      case "$1" in [0-9]*) phase="$1"; shift ;; esac
    fi
    ;;
  list) : ;;
  *) echo "unknown action: $action (want claim|release|status|list|conflicts)" >&2; exit 2 ;;
esac
# Handoff files are `phase-08-*.md`, so `08` is what gets copied into a command —
# and to bash it is an invalid octal literal, not the number eight. Normalise
# once, at the door, so the lock path and every arithmetic below agree.
case "$phase" in ''|*[!0-9]*) ;; *) phase=$((10#$phase)) ;; esac

owner="${PE_OWNER:-$(id -un)@$(hostname -s 2>/dev/null || hostname)}"
# The default lease: 2 hours.
#
# 🔴 Raised from 30 minutes, because 30 was shorter than a phase. A lapsed
# lease is silently taken over by anyone — that is the cooperative design and it
# is right — so the number has to be longer than the work it protects, and a
# real phase of a real plan runs for 45 minutes to two hours. The console's own
# sessions never depended on it (the runner refreshes on a timer), which is
# exactly why the wrong number survived: it only ever hurt a session driven by
# hand, which has nothing refreshing anything.
#
# The runner still passes `--lease 5400` explicitly — `RUNNER_LEASE_S`, a
# literal in seconds (90 min: nine times its 10-minute refresh cadence), so
# eight refreshes may be missed before a claim it is actively holding can
# lapse.
lease=7200
scope="${PE_SCOPE:-}"
session="${PE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}"
# The working tree this session's work rides — `--worktree` / `$PE_WORKTREE`,
# or derived from the cwd by `--here`. ACTED ON since the tree dimension
# joined the carve rule: two claims whose scopes intersect are disjoint only
# when BOTH the branches and the trees differ (`claim_disjoint`), because a
# branch alone says nothing about two sessions editing one shared checkout.
worktree="${PE_WORKTREE:-}"
# The branch this session's work rides — `--branch` / `$PE_BRANCH`.
#
# Acted on TOGETHER with `worktree=`: `conflicts` treats two claims whose
# scopes intersect as disjoint only when both name a branch AND a tree and
# both differ. See `claim_disjoint` in scope.sh for the rule and why it is safe.
branch="${PE_BRANCH:-}"
use_git=0
here=0
force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --owner)   owner="${2:?--owner needs a value}"; shift 2 ;;
    --lease)   lease="${2:?--lease needs seconds}"; shift 2 ;;
    --scope)   scope="${2:?--scope needs a csv}"; shift 2 ;;
    --session) session="${2:?--session needs an id}"; shift 2 ;;
    --worktree) worktree="${2:?--worktree needs a path}"; shift 2 ;;
    --branch)  branch="${2:?--branch needs a branch name}"; shift 2 ;;
    --here)    here=1; shift ;;
    --git)     use_git=1; shift ;;
    --force)   force=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
# `--here`: both qualification dimensions read off the cwd in one flag — the
# branch this checkout stands on and the PHYSICAL path of its toplevel
# (`pwd -P`, so a symlinked spelling cannot fake a tree difference). A detached
# HEAD derives no branch, and neither value overrides one given explicitly.
if [ "$here" = 1 ]; then
  _top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$_top" ]; then
    [ -n "$worktree" ] || worktree="$(cd "$_top" 2>/dev/null && pwd -P || printf '%s' "$_top")"
    if [ -z "$branch" ]; then
      _b="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
      if [ -n "$_b" ] && [ "$_b" != "HEAD" ]; then branch="$_b"; fi
    fi
  fi
fi
case "$lease" in
  ''|*[!0-9]*|0) echo "--lease must be a positive number of seconds, got: $lease" >&2; exit 2 ;;
esac
scope="$(scope_normalize "$scope")"
# One line in a key=value file: the id is kept to the characters an id has.
session="$(printf '%s' "$session" | tr -cd 'A-Za-z0-9._-' | cut -c1-128)"
# The same reasoning for the owner, which is the field every reader keys on. It
# was the one value written raw, so a newline in it injected whole lines into the
# middle of the lock — and the two readers resolve duplicate keys in OPPOSITE
# directions (bash `grep -m1` takes the first, the TS parser took the last), so
# the halves of the system disagreed about who held the lock.
owner="$(printf '%s' "$owner" | tr -d '\n\r' | cut -c1-128)"
# Same treatment for the worktree path: one line in a key=value file, and a
# newline in it would inject whole lines the two readers resolve differently.
# Trimmed like the branch, because the tree joined the comparison the carve is
# decided on — a leading space must not read as a different place.
worktree="$(printf '%s' "$worktree" | tr -d '\n\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | cut -c1-256)"
# And for the branch, plus a trim: the TS reader calls `.trim()` on every value,
# so a leading space here would make the two halves compare different strings —
# and this is the one field a comparison DECIDES something on.
branch="$(printf '%s' "$branch" | tr -d '\n\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | cut -c1-256)"
[ -n "$owner" ] || { echo "--owner must not be empty" >&2; exit 2; }

# shellcheck source=/dev/null
. "$SCRIPT_DIR/instance.sh"
DOCS_ROOT="$(pe_docs_root)"
lockdir="$DOCS_ROOT/docs/handoffs/$slug/.locks"
pad=""; [ -n "$phase" ] && pad="$(printf '%02d' "$phase")"
lockfile="$lockdir/phase-$pad.lock"
now="$(date +%s)"

_field()  { grep -m1 "^$1=" "$lockfile" 2>/dev/null | sed "s/^$1=//" || true; }
_fmt()    { [ -z "${1:-}" ] && { printf '?'; return; }; date -r "$1" '+%Y-%m-%d %H:%M' 2>/dev/null || printf '%s' "$1"; }
_write()  {
  # Last resort before the file is written: `conflicts` has always read the
  # plan's Repos cell when told no --scope; `claim` refused to, so a hand claim
  # (and EVERY console-issued claim — writes.ts passes no --scope at all) wrote
  # `unstated`, which every reader treats as colliding with everything. Asking
  # the same question of the same source makes the pair mean something.
  #
  # LAST, deliberately: an explicit --scope wins, and so does the scope already
  # on a lock this same owner is refreshing. What the holder stated about its own
  # session outranks what the plan states about the phase.
  if [ -z "$scope" ] && [ -n "$phase" ]; then
    scope="$(scope_normalize "$("$SCRIPT_DIR/phase-graph.sh" "$slug" --repos "$phase" 2>/dev/null || true)")"
  fi
  mkdir -p "$lockdir"
  local tmp="$lockfile.tmp.$$"
  {
    printf 'slug=%s\n'        "$slug"
    printf 'phase=%s\n'       "$phase"
    printf 'owner=%s\n'       "$owner"
    printf 'host=%s\n'        "$(hostname -s 2>/dev/null || hostname)"
    printf 'claimed_at=%s\n'  "$now"
    printf 'lease_until=%s\n' "$((now + lease))"
    # Only when stated. An absent scope reads as "unknown" — which every reader
    # treats as colliding — and that is the right meaning for a lock written by
    # an older copy of this script.
    [ -n "$scope" ] && printf 'scope=%s\n' "$scope"
    # Only when known. Absent means the console falls back to lease rules.
    [ -n "$session" ] && printf 'session=%s\n' "$session"
    # The session's own linked worktree, when it has one.
    #
    # 🔴 It does NOT narrow the claim, and reading it as though it did is the
    # mistake this comment exists to prevent. A worktree lane holds a second
    # checkout of the SAME repository: the object database, the refs and the
    # branch are shared, so two lanes in two worktrees still contend for the
    # branch they both commit to, and `git worktree add` on a repo somebody
    # else is mid-`rebase` in is still a bad afternoon. The scope stays the
    # REPO, exactly as it would without a worktree, and every reader
    # (`conflicts`, the console's scheduler) goes on serialising on it.
    #
    # What the line is for is the OUTSIDE observer: `phase-lock.sh list` and
    # the console's Pulse can say where a session is actually working, so
    # somebody looking at a busy repo with a clean `git status` knows to look
    # in the linked worktree rather than concluding the lock is stale.
    [ -n "$worktree" ] && printf 'worktree=%s\n' "$worktree"
    # The branch this session's work rides — and, unlike the line above, one
    # that CHANGES an answer: `conflicts` reads it and lets two claims on one
    # repo through when both name a branch and the two differ. Only when
    # stated, and for the usual reason: a lock written by an older copy of this
    # script, or by a session that never said, must go on colliding with
    # everything rather than silently qualifying as disjoint.
    [ -n "$branch" ] && printf 'branch=%s\n' "$branch"
  } > "$tmp"
  mv "$tmp" "$lockfile"
}
# Refresh the docs clone, and REPORT. Two things used to be wrong with the
# one-liner this replaces: it swallowed git's exit code (`|| true`), so
# `_git_sync`'s retry loop pulled between attempts without ever learning that
# the pull itself had failed and kept retrying a push that could not land; and a
# `pull --rebase` that stops on a conflict leaves the repo MID-REBASE — detached
# HEAD, a half-applied lock commit, `git status` full of conflict markers — for
# whatever session next touches the docs repo, which in this system is every
# session on the machine. A conflicted rebase is not a transient failure and
# must not be left in place: abort it (best effort) so the tree is exactly as it
# was, and hand the real code back to the caller.
_git_pull() {
  [ "$use_git" = 1 ] || return 0
  local code gitdir was_rebasing=0
  # Was a rebase ALREADY in progress before we touched anything? This is a docs
  # repo every session on the machine shares, and a pull that fails because
  # somebody else holds `index.lock` while they are mid-rebase must not abort
  # THEIR rebase. Only a rebase this call started is this call's to clean up.
  gitdir="$(git -C "$DOCS_ROOT" rev-parse --git-dir 2>/dev/null || true)"
  case "$gitdir" in /*) ;; ?*) gitdir="$DOCS_ROOT/$gitdir" ;; esac
  if [ -n "$gitdir" ] && { [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ]; }; then
    was_rebasing=1
  fi
  git -C "$DOCS_ROOT" pull --rebase --autostash >/dev/null 2>&1
  code=$?
  [ "$code" -eq 0 ] && return 0
  [ "$was_rebasing" = 0 ] && git -C "$DOCS_ROOT" rebase --abort >/dev/null 2>&1
  return "$code"
}
# Two sessions finishing phases at the same moment write the same handoff folder
# from different clones, and git says so: a held index.lock, or a push rejected
# because the other one landed first. Both clear by themselves — so rebase onto
# what landed and try again rather than losing the lock commit. Never fatal: a
# lock that failed to publish is a cooperative miss, not a reason to abort the
# claim the caller already has on disk.
_git_retries="${PE_GIT_RETRIES:-3}"
_git_retry_delay="${PE_GIT_RETRY_DELAY:-2}"
# The read-side refresh. Never fatal — a clone that could not be refreshed is a
# stale read, not a reason to refuse a claim the caller has every right to make,
# and `set -e` is on so a bare `_git_pull` would now abort the script. Never
# SILENT either, which is the only thing `|| true` ever bought: a session that
# claims off a stale view is exactly the session that needs to know it did.
_git_refresh() {
  _git_pull && return 0
  printf 'phase-lock: could not refresh %s (%s) — reading the local copy\n' "$DOCS_ROOT" "$action" >&2
  return 0
}
_git_sync() {  # _git_sync <verb>
  [ "$use_git" = 1 ] || return 0
  local attempt=1
  while :; do
    # Commit only when something is staged: after a rejected push the commit is
    # already made, and re-running it would fail with "nothing to commit" and
    # break the chain before the retry ever reached the push — which is the
    # whole point of retrying.
    if ( cd "$DOCS_ROOT" \
           && git add "docs/handoffs/$slug/.locks" >/dev/null 2>&1 \
           && { git diff --cached --quiet -- "docs/handoffs/$slug/.locks" \
                || git commit -m "phase-lock: $1 phase $phase ($slug) by $owner" >/dev/null 2>&1; } \
           && git push >/dev/null 2>&1 ); then
      return 0
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -gt "$_git_retries" ]; then
      # Out of retries. The claim IS on disk and the caller keeps it — that half
      # of the contract does not change — but it is local-only, and this used to
      # `return 0` in complete silence. A lock nobody else can see is exactly the
      # lock the cooperative guard cannot do its job with: the next clone pulls,
      # sees nothing, claims the same phase, and two sessions build one unit of
      # work. Say so, in a word a caller can grep for, on stdout (where the verb
      # already reports) AND on stderr (where a supervisor looks).
      printf 'UNPUBLISHED: phase %s lock is on disk but its commit could not be pushed after %s attempts — other clones will not see it until docs/handoffs/%s/.locks is pushed\n' \
        "$phase" "$_git_retries" "$slug"
      printf 'phase-lock: UNPUBLISHED — %s phase %s (%s): the lock is local-only after %s attempts\n' \
        "$1" "$phase" "$slug" "$_git_retries" >&2
      return 0
    fi
    printf 'phase-lock: git sync retry %s/%s (%s)\n' "$attempt" "$_git_retries" "$1" >&2
    # A pull that itself failed is worth naming: it is the usual reason the next
    # push fails too, and `_git_pull` has already aborted any rebase it left.
    _git_refresh
    [ "$_git_retry_delay" = 0 ] || sleep "$_git_retry_delay"
  done
}

case "$action" in
  claim)
    _git_refresh
    if [ -f "$lockfile" ]; then
      cur_owner="$(_field owner)"; cur_lease="$(_field lease_until)"
      if [ "$cur_owner" = "$owner" ]; then
        # A refresh that names no session keeps the one the lock carries — the
        # runner's keepalive and a hand re-claim must not strip the line the
        # session's own claim wrote. The SAME is true of the scope, and it was
        # missing: _write only emits `scope=` when it has one, so a plain
        # re-claim rewrote the file without it and the lock started colliding
        # with every scope in every plan. The console's own Claim-lock action
        # passes no --scope at all, so this was its every write; the runner
        # carried a workaround (always pass --scope) whose comment said the fix
        # belonged here.
        [ -n "$session" ] || session="$(_field session)"
        [ -n "$scope" ]   || scope="$(_field scope)"
        [ -n "$worktree" ] || worktree="$(_field worktree)"
        # The keepalive MUST preserve this one. A refresh that dropped `branch=`
        # would silently re-qualify a lane's lock as unqualified — and an
        # unqualified lock collides with everything, so the carve-out this field
        # exists for would evaporate one third of a lease into the run.
        [ -n "$branch" ] || branch="$(_field branch)"
        _write; _git_sync refresh
        printf 'phase %s: lock refreshed for %s (lease %ss)\n' "$phase" "$owner" "$lease"; exit 0
      fi
      if [ -n "$cur_lease" ] && [ "$now" -ge "$cur_lease" ]; then
        _write; _git_sync takeover
        printf 'phase %s: takeover — previous lease (held by %s) had expired\n' "$phase" "$cur_owner"; exit 0
      fi
      if [ "$force" = 1 ]; then
        _write; _git_sync force
        printf 'phase %s: force-claimed from %s\n' "$phase" "$cur_owner"; exit 0
      fi
      printf 'phase %s is being worked by %s (lease until %s).\n' "$phase" "$cur_owner" "$(_fmt "$cur_lease")" >&2
      printf '  → stop that session, re-run with --force to take over, or start another ready phase.\n' >&2
      exit 1
    fi
    _write; _git_sync claim
    printf 'phase %s: claimed by %s (lease %ss)\n' "$phase" "$owner" "$lease"; exit 0
    ;;
  release)
    _git_refresh
    if [ ! -f "$lockfile" ]; then printf 'phase %s: already free\n' "$phase"; exit 0; fi
    cur_owner="$(_field owner)"
    if [ "$cur_owner" = "$owner" ] || [ "$force" = 1 ]; then
      rm -f "$lockfile"
      # Releasing the LAST lock of a slug that has no handoffs must not leave
      # an empty husk under docs/handoffs/ — a folder with no files and an
      # empty .locks/ reads as an orphan that exists for no reason (the
      # viewer's store test rightly objects; one such husk was found live).
      # Best-effort only: rmdir refuses non-empty directories, which is
      # exactly the guard wanted here.
      rmdir "$lockdir" 2>/dev/null || true
      rmdir "$DOCS_ROOT/docs/handoffs/$slug" 2>/dev/null || true
      _git_sync release
      printf 'phase %s: released\n' "$phase"; exit 0
    fi
    printf 'phase %s: held by %s, not %s — use --force to override\n' "$phase" "$cur_owner" "$owner" >&2
    exit 1
    ;;
  status)
    if [ ! -f "$lockfile" ]; then printf 'phase %s: free\n' "$phase"; exit 0; fi
    cur_owner="$(_field owner)"; cur_lease="$(_field lease_until)"; cur_at="$(_field claimed_at)"
    cur_scope="$(_field scope)"; cur_session="$(_field session)"; cur_wt="$(_field worktree)"
    cur_branch="$(_field branch)"
    exp=""; [ -n "$cur_lease" ] && [ "$now" -ge "$cur_lease" ] && exp=" (EXPIRED — free to take over)"
    sc=""; [ -n "$cur_scope" ] && sc=" [scope: $cur_scope]"
    se=""; [ -n "$cur_session" ] && se=" [session: $cur_session]"
    # Where the work is actually happening. The scope above is still the repo —
    # a linked worktree shares its refs, so it narrows nothing.
    wt=""; [ -n "$cur_wt" ] && wt=" [worktree: $cur_wt]"
    # The branch, on the other hand, DOES narrow: a reader deciding whether to
    # wait needs to see whether this claim is qualified at all.
    br=""; [ -n "$cur_branch" ] && br=" [branch: $cur_branch]"
    printf 'phase %s: held by %s since %s, lease until %s%s%s%s%s%s\n' \
      "$phase" "$cur_owner" "$(_fmt "$cur_at")" "$(_fmt "$cur_lease")" "$exp" "$sc" "$se" "$wt" "$br"
    exit 0
    ;;
  list)
    if [ ! -d "$lockdir" ]; then printf 'no active locks for %s\n' "$slug"; exit 0; fi
    found=0
    for f in "$lockdir"/phase-*.lock; do
      [ -e "$f" ] || continue
      found=1
      o="$(grep -m1 '^owner=' "$f" | sed 's/^owner=//')"
      l="$(grep -m1 '^lease_until=' "$f" | sed 's/^lease_until=//')"
      p="$(grep -m1 '^phase=' "$f" | sed 's/^phase=//')"
      s="$(grep -m1 '^scope=' "$f" | sed 's/^scope=//' || true)"
      se="$(grep -m1 '^session=' "$f" | sed 's/^session=//' || true)"
      wt="$(grep -m1 '^worktree=' "$f" | sed 's/^worktree=//' || true)"
      br="$(grep -m1 '^branch=' "$f" | sed 's/^branch=//' || true)"
      wt="$(grep -m1 '^worktree=' "$f" | sed 's/^worktree=//' || true)"
      exp=""; [ -n "$l" ] && [ "$now" -ge "$l" ] && exp=" (expired)"
      sc=""; [ -n "$s" ] && sc=" [scope: $s]"
      [ -n "$se" ] && sc="$sc [session: $se]"
      [ -n "$wt" ] && sc="$sc [worktree: $wt]"
      [ -n "$br" ] && sc="$sc [branch: $br]"
      printf 'phase %s: %s until %s%s%s\n' "$p" "$o" "$(_fmt "$l")" "$exp" "$sc"
    done
    [ "$found" = 0 ] && printf 'no active locks for %s\n' "$slug"
    exit 0
    ;;
  conflicts)
    # Read-only, and deliberately across ALL plans: the thing that makes two
    # sessions unsafe is a shared working tree, and working trees do not know
    # which plan asked for them.
    _git_refresh
    if [ -z "$scope" ] && [ -n "$phase" ]; then
      scope="$("$SCRIPT_DIR/phase-graph.sh" "$slug" --repos "$phase" 2>/dev/null || true)"
      scope="$(scope_normalize "$scope")"
    fi
    if [ -z "$scope" ]; then
      printf 'usage: phase-lock.sh %s conflicts [N] --scope "<csv>"\n' "$slug" >&2
      printf '  (no --scope, no $PE_SCOPE, and no phase to read the plan Repos cell from)\n' >&2
      exit 2
    fi
    hits=0
    for f in "$DOCS_ROOT"/docs/handoffs/*/.locks/phase-*.lock; do
      [ -e "$f" ] || continue
      o="$(grep -m1 '^owner=' "$f" | sed 's/^owner=//' || true)"
      l="$(grep -m1 '^lease_until=' "$f" | sed 's/^lease_until=//' || true)"
      p="$(grep -m1 '^phase=' "$f" | sed 's/^phase=//' || true)"
      s="$(grep -m1 '^slug=' "$f" | sed 's/^slug=//' || true)"
      sc="$(grep -m1 '^scope=' "$f" | sed 's/^scope=//' || true)"
      se="$(grep -m1 '^session=' "$f" | sed 's/^session=//' || true)"
      br="$(grep -m1 '^branch=' "$f" | sed 's/^branch=//' || true)"
      wt="$(grep -m1 '^worktree=' "$f" | sed 's/^worktree=//' || true)"
      [ -n "$l" ] && [ "$now" -ge "$l" ] && continue      # expired: free to take
      # Ours only when we can PROVE it, which owner alone cannot do. `owner`
      # defaults to `<user>@<host>` — the SAME string for every hand-driven
      # session on one machine — so skipping on owner equality made this scan
      # blind to every other local session. It really happened: a live lock on
      # `scope=phased-execution` held by another session was reported as "no
      # scope conflicts — safe to start", and a shared working tree is the one
      # thing this command exists to refuse.
      #
      # `session=` is the identity, so it decides whenever the LOCK carries one.
      # A lock naming a session that is not ours is not ours, whatever the owner
      # says — and with no session id of our own we cannot claim it either. Only
      # a lock with NO session recorded falls back to owner, which is then all
      # there is to go on, and which keeps one session's OTHER phases (a batch)
      # from crying wolf against themselves.
      mine=0
      if [ -n "$se" ]; then
        [ -n "$session" ] && [ "$se" = "$session" ] && mine=1
      elif [ "$o" = "$owner" ]; then
        mine=1
      fi
      [ "$mine" = 1 ] && continue
      # A closed plan has no live sessions by definition, so a lock it left behind is
      # debris — and because this scan crosses every plan, that debris would otherwise
      # block work on unrelated plans until its lease happened to lapse.
      [ -n "$s" ] && bash "$SCRIPT_DIR/phase-graph.sh" "$s" --closed >/dev/null 2>&1 && continue
      scope_intersects "$scope" "$sc" || continue
      # Branch+tree qualification, applied AFTER the scope test and only ever
      # as a narrowing of it: two claims on one repository are nevertheless
      # disjoint when BOTH name a branch AND a working tree and both differ
      # (`claim_disjoint`). Either side unqualified in either dimension ⇒ the
      # collision stands — which keeps every lock written before these fields
      # existed exactly as safe as it was, and retires the false carve a
      # branch alone bought two sessions sharing one checkout.
      if claim_disjoint "$branch" "$worktree" "$br" "$wt"; then continue; fi
      hits=$((hits + 1))
      overlap="$(scope_overlap "$scope" "$sc")"
      [ -n "$sc" ] || sc="unstated"
      [ -n "$overlap" ] || overlap="unstated"
      # `status` and `list` already render the session, and this is the one output
      # a person reads while deciding whether to stop. Since a conflict can now
      # be against our own OWNER, the id is what says which window to look at.
      _se=""; [ -n "$se" ] && _se=" [session: $se]"
      # And the branch, because "why is this a conflict when we are on different
      # branches" is the first question a qualified caller asks: an unqualified
      # holder shows `branch: unstated`, which is the answer.
      _br=" [branch: ${br:-unstated}] [worktree: ${wt:-unstated}]"
      printf 'CONFLICT %s phase %s — held by %s%s until %s [scope: %s]%s overlaps: %s\n' \
        "${s:-?}" "${p:-?}" "${o:-?}" "$_se" "$(_fmt "$l")" "$sc" "$_br" "$overlap"
    done
    if [ "$hits" = 0 ]; then
      _on=""; [ -n "$branch" ] && _on=" on branch $branch"
      printf 'no scope conflicts for [%s]%s — safe to start\n' "$scope" "$_on"
      exit 0
    fi
    printf '  → %s live session(s) share a working tree with [%s].\n' "$hits" "$scope" >&2
    printf '    Stop and ask: wait for them, take a phase with a disjoint scope, or (if you know\n' >&2
    printf '    that session is dead) --force the claim.\n' >&2
    exit 1
    ;;
esac
