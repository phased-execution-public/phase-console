#!/usr/bin/env bash
# phase-lane.sh — a hand session's own checkout, made where the console keeps
# its own, and cleaned up by the same hand.
#
# A session that needs a second working tree beside a live one — a QA round
# beside a build, a review that must not stand in the builder's tree — used to
# `git worktree add ../pe-p14` a sibling of the project on a branch of its own
# naming. Nothing swept it, nothing found it, and the skill scripts run from
# inside it named the lane itself as their docs root. This script is the
# sanctioned shape of that need:
#
#   <root>/.worktrees/hand/<slug>/p<N>[-qa<round>]          the lane
#   <root>/.worktrees/hand/<slug>/p<N>[-qa<round>]/<rel>    …its checkout of a
#                                                           scoped sub-repository
#   pe/<slug>-p<N>[-qa<round>]                              its branch — a SIBLING of
#                                                           the run branch pe/<slug>
#
# — the same `.worktrees/` folder the console's own lanes live in (`runs/`)
# and the staging tree (`staging/`), excluded from the root's `git status`
# through `.git/info/exclude`, locked while it lives (`git worktree lock`),
# folded back with fast-forward-then-`--no-ff`, and removed with `git worktree
# remove` (which refuses a dirty tree) and `git branch -d` (which refuses an
# unmerged one). Nothing here pushes, and nothing here ever deletes work.
#
# Usage:
#   phase-lane.sh <slug> create <N> [--qa <round>] [--detach] [--repo <token>] [--owner <id>]
#   phase-lane.sh <slug> merge  <N> [--qa <round>] [--repo <token>]
#   phase-lane.sh <slug> remove <N> [--qa <round>] [--repo <token>] [--force]
#   phase-lane.sh list [<slug>]
#
# Which repository: under a superproject (a root with `.gitmodules`) the lane
# is a worktree of the sub-repository the phase's scope names — `--repo <token>`
# or, absent, the plan's Repos cell for that phase (`phase-graph.sh --repos`).
# A token meaning the root itself (`all`, the root's name, a plain directory)
# is refused: a linked worktree of a superproject has EMPTY submodule
# directories. A plain repository (no `.gitmodules`) lanes the root itself.
#
# The branch NAME is shared with the console on purpose: `pe/<slug>-p<N>` is
# the ONE lane branch phase N has (`viewer/server/runner/worktree.ts`
# `laneNames`), whoever makes its tree — so a hand lane for a phase the console
# would lane itself (a plan with `- **Worktrees:** on`) is refused, since two
# trees cannot hold one branch and the console's `acquireLane` would fall back
# to the shared root; take `--detach` or `--qa` beside the console's lane
# instead. When the branch already exists (a console lane landed and pruned,
# or an earlier hand lane removed with `--force`) `create` ADOPTS it and says
# how far it stands from the run branch. The console's own sweeps report a
# hand lane once as `run.worktrees-unmanaged` and never touch it; its
# merged-branch delete (`-d`, never `-D`) may take the branch once it has
# landed on the run branch — which is what `remove` does anyway.
# Exit 0 done · 1 refused by the tree's state (dirty, unmerged, conflict,
# missing branch) · 2 usage or an unresolvable scope. bash 3.2.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/scope.sh"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/instance.sh"

usage() {
  cat >&2 <<'USAGE'
usage: phase-lane.sh <slug> create <N> [--qa <round>] [--detach] [--repo <token>] [--owner <id>]
       phase-lane.sh <slug> merge  <N> [--qa <round>] [--repo <token>]
       phase-lane.sh <slug> remove <N> [--qa <round>] [--repo <token>] [--force]
       phase-lane.sh list [<slug>]
USAGE
  exit 2
}

[ $# -ge 1 ] || usage
if [ "$1" = "list" ]; then
  verb="list"; slug="${2:-}"; phase=""
  [ $# -le 2 ] || usage
else
  [ $# -ge 3 ] || usage
  slug="$1"; verb="$2"; phase="$3"; shift 3
  case "$verb" in create|merge|remove) : ;; *) usage ;; esac
  case "$phase" in ''|*[!0-9]*) echo "phase must be a number, got: $phase" >&2; exit 2 ;; esac
  phase=$((10#$phase))
fi
case "$slug" in *[!A-Za-z0-9._-]*) echo "slug may contain only letters, digits, . _ -: $slug" >&2; exit 2 ;; esac

qa=""; detach=0; repo_token=""; force=0
owner="${PE_OWNER:-$(id -un 2>/dev/null || echo user)@$(hostname -s 2>/dev/null || echo host)}"
if [ "$verb" != "list" ]; then
  while [ $# -gt 0 ]; do
    case "$1" in
      --qa)     qa="${2:?--qa needs a round number}"; shift 2
                case "$qa" in ''|*[!0-9]*) echo "--qa needs a round number, got: $qa" >&2; exit 2 ;; esac ;;
      --detach) detach=1; shift ;;
      --repo)   repo_token="${2:?--repo needs a scope token}"; shift 2 ;;
      --owner)  owner="${2:?--owner needs an id}"; shift 2 ;;
      --force)  force=1; shift ;;
      *) echo "unknown option: $1" >&2; usage ;;
    esac
  done
fi
if [ "$verb" = "merge" ] && [ "$detach" = 1 ]; then
  echo "merge takes no --detach: a detached lane holds no branch to merge — cherry-pick its commits by sha" >&2
  exit 2
fi

root="$(pe_docs_root)"
root_p="$(cd "$root" 2>/dev/null && pwd -P)" || { echo "not a directory: $root" >&2; exit 2; }
# The PHYSICAL root from here on: `git -C "$repo" worktree add "$dir"` resolves a
# relative path against the sub-repository, so a relative `DOCS_ROOT` once put
# a lane INSIDE the builder's checkout.
root="$root_p"
hand="$root/.worktrees/hand"

# submodule_paths → every INITIALISED submodule under the root, nested ones
# included, one root-relative path per line (spaces and all).
submodule_paths() {
  [ -f "$root/.gitmodules" ] || return 0
  git -C "$root" submodule --quiet foreach --recursive 'printf "%s\n" "$displaypath"' 2>/dev/null || true
}

# plan_repos → the phase's Repos cell, asked of the engine ONCE.
plan_repos() {
  if [ -z "${_plan_repos_asked:-}" ]; then
    _plan_repos="$(DOCS_ROOT="$root" "$SCRIPT_DIR/phase-graph.sh" "$slug" --repos "$phase" 2>/dev/null || true)"
    _plan_repos_asked=1
  fi
  printf '%s' "${_plan_repos:-}"
}

# plan_lanes_itself → does this plan ask the console for per-phase lanes?
plan_lanes_itself() {
  /usr/bin/grep -qiE '^[[:space:]]*(-[[:space:]]*)?\*\*Worktrees:\*\*[[:space:]]*on([[:space:]]|$)' "$root/docs/plans/$slug.md" 2>/dev/null
}

# resolve_repo → sets `repo` (the repository the lane is a worktree of) and `rel`
# (its path under the root, empty for the root itself), or exits 2 naming why.
resolve_repo() {
  repo=""; rel=""
  if [ ! -f "$root/.gitmodules" ]; then
    [ -z "$repo_token" ] || { echo "--repo names a sub-repository, and $root has no submodules" >&2; exit 2; }
    [ -e "$root/.git" ] || { echo "not a git repository: $root" >&2; exit 2; }
    repo="$root"; return 0
  fi
  local token="$repo_token" probe
  [ -n "$token" ] || token="$(plan_repos)"
  token="$(scope_normalize "$token")"
  case "$token" in
    ''|all|"$(basename "$root")"|*,*)
      echo "scope '${token:-?}' means the root itself or several repositories — a lane is ONE sub-repository; say which with --repo <token>" >&2
      echo "(a linked worktree of a superproject has EMPTY submodule directories, so the root is never laned)" >&2
      exit 2 ;;
  esac
  probe="$root/$token"
  [ -d "$probe" ] || { echo "scope-unmapped: '$token' is not a directory under $root — say which repository with --repo <token>" >&2; exit 2; }
  probe="$(cd "$probe" && pwd -P)"
  while [ "$probe" != "$root_p" ] && [ "$probe" != "/" ]; do
    if [ -e "$probe/.git" ]; then repo="$probe"; break; fi
    probe="$(dirname "$probe")"
  done
  [ -n "$repo" ] || { echo "scope-unmapped: '$token' lies in no repository below $root (the root itself is never laned) — say which with --repo <token>" >&2; exit 2; }
  rel="${repo#"$root_p"/}"
}

# ensure_excluded → `/.worktrees/` in the root repository's .git/info/exclude, once.
ensure_excluded() {
  local file
  file="$(git -C "$root" rev-parse --git-path info/exclude 2>/dev/null || true)"
  [ -n "$file" ] || return 0
  case "$file" in /*) : ;; *) file="$root/$file" ;; esac
  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] && /usr/bin/grep -qx '/.worktrees/' "$file" && return 0
  printf '/.worktrees/\n' >> "$file"
}

lane_names() {
  suffix=""
  [ -z "$qa" ] || suffix="-qa$qa"
  lane="$hand/$slug/p$phase$suffix"
  branch="pe/$slug-p$phase$suffix"
  run_branch="pe/$slug"
  dir="$lane"
  [ -z "$rel" ] || dir="$lane/$rel"
  return 0
}

# ---- list ---------------------------------------------------------------
if [ "$verb" = "list" ]; then
  base="$root_p/.worktrees/hand"
  [ -n "$slug" ] && base="$base/$slug"
  repos="$root"
  while IFS= read -r sp || [ -n "$sp" ]; do
    [ -n "$sp" ] && [ -e "$root/$sp/.git" ] && repos="$repos
$root/$sp"
  done <<REPOS
$(submodule_paths)
REPOS
  printf '%s\n' "$repos" | while IFS= read -r r; do
    [ -n "$r" ] || continue
    label="${r#"$root"}"; label="${label#/}"; [ -n "$label" ] || label="root"
    git -C "$r" worktree list --porcelain 2>/dev/null | {
      wt=""; br=""; det=""; lk="no"
      emit() {
        case "$wt" in "$base"/*|"$base") : ;; *) return 0 ;; esac
        local head dirty shown
        head="$(git -C "$wt" rev-parse --short=12 HEAD 2>/dev/null || echo '?')"
        if [ -n "$(git -C "$wt" status --porcelain --ignore-submodules=all 2>/dev/null)" ]; then dirty=yes; else dirty=no; fi
        shown="$br"; [ -n "$det" ] && shown="detached@$head"
        printf '%s  repo=%s  branch=%s  head=%s  locked=%s  dirty=%s\n' "${wt#"$root_p"/}" "$label" "$shown" "$head" "$lk" "$dirty"
      }
      while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
          "worktree "*) wt="${line#worktree }" ;;
          "branch refs/heads/"*) br="${line#branch refs/heads/}" ;;
          detached) det=1 ;;
          locked*) lk="yes" ;;
          "") [ -n "$wt" ] && emit; wt=""; br=""; det=""; lk="no" ;;
        esac
      done
      [ -n "$wt" ] && emit
      true
    }
  done
  exit 0
fi

resolve_repo
lane_names
scope_csv="$repo_token"
[ -n "$scope_csv" ] || scope_csv="$(plan_repos)"
[ -n "$scope_csv" ] || scope_csv="${rel:-all}"

# ---- create -------------------------------------------------------------
if [ "$verb" = "create" ]; then
  [ ! -e "$dir" ] || { echo "lane already exists: $dir" >&2; exit 1; }
  if [ "$detach" = 0 ] && [ -z "$qa" ] && plan_lanes_itself; then
    echo "$slug lanes its phases itself (\`- **Worktrees:** on\` in the plan): the console makes $branch for phase $phase, and two trees cannot hold one branch — take a review lane (--detach) or a QA lane (--qa <round>) beside it" >&2
    exit 1
  fi
  git -C "$repo" rev-parse --verify --quiet "refs/heads/$run_branch^{commit}" >/dev/null 2>&1 \
    || { echo "no run branch $run_branch in $repo — the plan's branch must exist there first (git -C $repo checkout -b $run_branch, or fetch it)" >&2; exit 1; }
  if [ "$detach" = 0 ] && git -C "$repo" worktree list --porcelain 2>/dev/null | /usr/bin/grep -qx "branch refs/heads/$branch"; then
    echo "$branch is already checked out in another working tree (git -C $repo worktree list) — remove that lane first" >&2
    exit 1
  fi
  ensure_excluded
  mkdir -p "$(dirname "$dir")"
  if [ "$detach" = 1 ]; then
    git -C "$repo" worktree add --detach "$dir" "$run_branch" >/dev/null 2>&1 \
      || { echo "git worktree add failed for $dir" >&2; exit 1; }
  elif git -C "$repo" rev-parse --verify --quiet "refs/heads/$branch^{commit}" >/dev/null 2>&1; then
    git -C "$repo" worktree add "$dir" "$branch" >/dev/null 2>&1 \
      || { echo "git worktree add failed for $dir on the existing $branch" >&2; exit 1; }
    printf 'adopted the existing %s: %s commit(s) ahead of and %s behind %s — merge %s into it first if you want its latest\n' \
      "$branch" "$(git -C "$repo" rev-list --count "$run_branch..$branch")" "$(git -C "$repo" rev-list --count "$branch..$run_branch")" "$run_branch" "$run_branch"
  else
    git -C "$repo" worktree add -b "$branch" "$dir" "$run_branch" >/dev/null 2>&1 \
      || { echo "git worktree add failed for $dir" >&2; exit 1; }
  fi
  git -C "$repo" worktree lock --reason "phase-lane $slug p$phase$suffix $owner $(date +%F)" "$dir" >/dev/null 2>&1 || true
  if [ "$detach" = 1 ]; then shown="detached at $run_branch"; else shown="$branch"; fi
  printf 'lane ready: %s (%s, locked)\n  cd "%s"\n' "$dir" "$shown" "$dir"
  # 🔴 A QA lane claims NOTHING (S7-2). `phase-lock.sh claim` refuses a second
  # claim on the same slug+phase however it is qualified — the scheduler's
  # `sameUnitOfWork` rule, which bash learned in phase 3 — so the `claim … --here`
  # line printed here could only ever fail beside the build lane it was made to
  # sit next to, and the reviewer who ran it read the refusal as "somebody else
  # is building here". A round is recorded, not claimed; that is the instruction
  # it actually needs.
  if [ -n "$qa" ]; then
    printf '  # a QA round claims no lock — the build lane holds this phase. Record the verdict:\n'
    printf '  bash %s/qa-record.sh %s %s pass|fail|waived --round %s --report docs/handoffs/%s/reports/phase-%02d-qa%s.md\n' \
      "$SCRIPT_DIR" "$slug" "$phase" "$qa" "$slug" "$phase" "$qa"
  else
    printf '  bash %s/phase-lock.sh %s claim %s --scope "%s" --here\n' "$SCRIPT_DIR" "$slug" "$phase" "$scope_csv"
  fi
  printf 'when done:\n'
  if [ "$detach" = 0 ]; then
    printf '  bash %s/phase-lane.sh %s merge %s%s%s    # folds %s onto %s: fast-forward, else a merge commit\n' \
      "$SCRIPT_DIR" "$slug" "$phase" "${qa:+ --qa $qa}" "${repo_token:+ --repo $repo_token}" "$branch" "$run_branch"
  fi
  printf '  bash %s/phase-lane.sh %s remove %s%s%s   # the tree, %s and the lock go\n' \
    "$SCRIPT_DIR" "$slug" "$phase" "${qa:+ --qa $qa}" "${repo_token:+ --repo $repo_token}" \
    "$([ "$detach" = 1 ] && echo 'the registration' || echo 'the merged branch')"
  exit 0
fi

[ -d "$dir" ] || { echo "no such lane: $dir" >&2; exit 1; }
lane_head_ref="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"

# ---- merge --------------------------------------------------------------
if [ "$verb" = "merge" ]; then
  if [ "$lane_head_ref" = "HEAD" ] || [ "$lane_head_ref" != "$branch" ]; then
    echo "the lane at $dir is detached (or not on $branch) — nothing to merge; cherry-pick its commits by sha" >&2
    exit 2
  fi
  # 🔴 ASK GIT which tree holds the run branch (S7-4). Requiring `$repo` itself
  # to stand on `pe/<slug>` was wrong in both directions: under isolation the
  # console holds the branch in its own mirror, so the merge was IMPOSSIBLE; and
  # under a shared run the main checkout is exactly where a live session is
  # working, so the merge would have swapped files under it. git allows a branch
  # one working tree, so there is always at most one right answer and it is
  # cheap to ask for.
  target=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "worktree "*) _wt="${line#worktree }" ;;
      "branch refs/heads/$run_branch") target="$_wt" ;;
    esac
  done <<EOF
$(git -C "$repo" worktree list --porcelain 2>/dev/null || true)
EOF
  [ -n "$target" ] || { echo "$run_branch is checked out in no working tree of $repo — check it out somewhere (it is where the merge lands)" >&2; exit 1; }
  # …and NEVER a tree the console is driving a run in. `<root>/.worktrees/runs/`
  # is the console's own runs home (`worktree.ts` §The layout): a merge there
  # moves files under a session mid-phase, and the console would then land the
  # lane's commits a second time when the run settles.
  case "$target" in
    "$root_p/.worktrees/runs/"*)
      echo "$run_branch is held by a console run's tree ($target) — a merge there would move files under a live session." >&2
      echo "  Let the run settle (or stop it), then merge; or take the commits by sha." >&2
      exit 1 ;;
  esac
  [ -z "$(git -C "$target" status --porcelain --ignore-submodules=all)" ] || { echo "the checkout holding $run_branch ($target) has uncommitted changes — commit them before merging into it" >&2; exit 1; }
  ahead="$(git -C "$repo" rev-list --count "$run_branch..$branch")"
  if [ "$ahead" = 0 ]; then echo "nothing to merge: $branch holds no commit $run_branch lacks"; exit 0; fi
  if git -C "$target" merge --ff-only "$branch" >/dev/null 2>&1; then
    echo "fast-forwarded $run_branch to $branch ($ahead commit(s)) in $target"
    exit 0
  fi
  if git -C "$target" merge --no-ff --no-edit -m "Merge $branch into $run_branch" "$branch" >/dev/null 2>&1; then
    echo "merge commit: $branch ($ahead commit(s)) folded into $run_branch in $target — $(git -C "$target" rev-parse --short=12 HEAD)"
    exit 0
  fi
  echo "merge conflict — aborted, nothing changed. Conflicting files:" >&2
  git -C "$target" diff --name-only --diff-filter=U >&2 || true
  git -C "$target" merge --abort >/dev/null 2>&1 || true
  echo "resolve by merging $run_branch INTO the lane ($dir) and merging again" >&2
  exit 1
fi

# ---- remove -------------------------------------------------------------
if [ -n "$(git -C "$dir" status --porcelain --ignore-submodules=all 2>/dev/null)" ] && [ "$force" = 0 ]; then
  echo "the lane $dir has uncommitted changes — commit them, or remove --force to discard them" >&2
  exit 1
fi
has_branch=0
git -C "$repo" rev-parse --verify --quiet "refs/heads/$branch^{commit}" >/dev/null 2>&1 && has_branch=1
if [ "$has_branch" = 1 ] && [ "$lane_head_ref" = "$branch" ] && [ "$force" = 0 ]; then
  ahead="$(git -C "$repo" rev-list --count "$run_branch..$branch")"
  [ "$ahead" = 0 ] || { echo "$branch holds $ahead unmerged commit(s) — merge first (phase-lane.sh $slug merge $phase${qa:+ --qa $qa}), or remove --force to keep the branch and drop the tree" >&2; exit 1; }
fi
git -C "$repo" worktree unlock "$dir" >/dev/null 2>&1 || true
if [ "$force" = 1 ]; then
  git -C "$repo" worktree remove --force "$dir" >/dev/null 2>&1 || { echo "git worktree remove --force failed for $dir" >&2; exit 1; }
else
  git -C "$repo" worktree remove "$dir" >/dev/null 2>&1 || { echo "git worktree remove refused $dir — it is not clean, or not a registered worktree" >&2; exit 1; }
fi
echo "removed $dir"
if [ "$has_branch" = 1 ]; then
  # 🔴 `--force` KEEPS the branch (G-LANE). The refusal above says so in as many
  # words — "remove --force to keep the branch and drop the tree" — and then this
  # deleted it anyway whenever `branch -d` judged it merged, which `-d` judges
  # against the CURRENT checkout's HEAD rather than against the run branch. The
  # one place this script's promise and its act disagreed; the line is printed
  # now, for a person who has read the ahead count and decided.
  if [ "$force" = 1 ]; then
    echo "kept $branch — --force keeps the branch. Delete it yourself when you are done with it:"
    echo "  git -C $repo branch -d $branch    # refuses while it holds commits $run_branch lacks"
  elif git -C "$repo" branch -d "$branch" >/dev/null 2>&1; then
    echo "deleted $branch (merged)"
  else
    echo "kept $branch — it holds commits $run_branch lacks; merge them or delete it yourself (never -D here)"
  fi
fi
git -C "$repo" worktree prune >/dev/null 2>&1 || true
# Every directory the lane path added between the tree and the lane — a nested
# sub-repository's parents — then the lane, the plan and `hand/` when empty.
d="$(dirname "$dir")"
while [ "$d" != "$lane" ] && [ "${d#"$lane"/}" != "$d" ]; do
  rmdir "$d" 2>/dev/null || break
  d="$(dirname "$d")"
done
rmdir "$lane" 2>/dev/null || true
rmdir "$hand/$slug" 2>/dev/null || true
rmdir "$hand" 2>/dev/null || true
echo "  bash $SCRIPT_DIR/phase-lock.sh $slug release $phase"
exit 0
