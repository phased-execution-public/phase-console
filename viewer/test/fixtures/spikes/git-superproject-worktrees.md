# Probe — the four git behaviours phases 7 and 8 are built on, measured on this machine's git

git: 2.54.0 (Apple Git-157)
date: 2026-09-18
verdict: all-four-usable
cost_usd: 0 (scratch repositories only; no remote was contacted)
settles: `many-plans-one-repo` phase 1 arms G-1…G-4 — isolation (phase 7) and the landing engine (phase 8)

**Why this exists.** Phase 7 gives many plans one repository, and phase 8 lands their branches. Four
questions decide both, and each had a plausible wrong answer that would have been found late: whether two
mirrors of one superproject fight over the submodule, what `merge-tree` actually prints when a landing
conflicts, whether `worktree prune` can eat a live lane, and which porcelain flag means *rejected*.

| arm | question | verdict |
|---|---|---|
| `G-1` | do two linked worktrees of one superproject share a submodule gitdir? | isolated |
| `G-2` | `merge-tree --write-tree -z` exit codes and conflict strings | exits-1-with-types |
| `G-3` | can `prune` or `remove` take a **locked** tree? | lock-holds |
| `G-4` | `push --porcelain --no-follow-tags` output shapes | five-flags |

> Every arm ran with `protocol.file.allow=always` on the `submodule add` only, in throwaway repositories
> under a scratch directory. `G-4` pushed to a **local bare repository** created for the arm; no network
> remote was contacted and nothing was force-pushed.

## G-1 — two mirrors of one superproject do not collide

```
git worktree add <wt1> -b wt1          # ok
ls -A <wt1>/sub                        # 0 entries — an unmounted submodule, as documented
git -C <wt1> submodule update --init   # ok
```

The load-bearing fact is where the submodule's gitdir lands. It is **per worktree**:

| tree | `sub/.git` |
|---|---|
| `wt1` | `gitdir: ../../super/.git/worktrees/wt1/modules/sub` |
| `wt2` | `gitdir: ../../super/.git/worktrees/wt2/modules/sub` |

Distinct. So two mirrors of one superproject each initialise the submodule into their own store, and neither
can move the other's HEAD — which is what makes the run mirror safe to hand to concurrent plans, and what
phase 7's per-repository capacity holder is counting.

`git worktree add` **inside** a submodule of a linked worktree also works (`exit 0`, *"Preparing worktree
(new branch 'subwt')"*), so a lane may take a checkout of a submodule of a mirror. `git -C <wt1>/sub worktree
list` reports the submodule's own store, detached at the pinned commit.

## G-2 — `merge-tree --write-tree -z`

| case | exit | what comes back |
|---|---|---|
| clean merge | **0** | the merged tree oid |
| text conflict | **1** | tree oid, the stage-1/2/3 index entries, then the informational block |
| unrelated histories | **128** | nothing; stderr `fatal: refusing to merge unrelated histories` |
| submodule pointers with no merge base | **1** | tree oid, `160000` stage entries, two conflict records |

A text conflict's payload, NUL rendered as `|`:

```
4844d188…|100644 5626abf0… 1	a.txt|100644 bd44431b… 2	a.txt|100644 db561ffb… 3	a.txt||1|a.txt|Auto-merging|Auto-merging a.txt
|1|a.txt|CONFLICT (contents)|CONFLICT (content): Merge conflict in a.txt
```

The submodule case is the one the plan named, and **its string is not the one the plan guessed.** Phase 8
should match on these, from git 2.54:

```
|1|sub|CONFLICT (submodule may have rewinds)|Failed to merge submodule sub (commits don't follow merge-base)
|1|sub|CONFLICT (contents)|CONFLICT (submodule): Merge conflict in sub
```

There is no `submodule lacks merge base` string. The machine-readable type is `CONFLICT (submodule may have
rewinds)`; the human sentence says *commits don't follow merge-base*; stderr adds
`hint: Recursive merging with submodules currently only supports trivial cases.`

**A trap this arm walked into first, recorded because phase 8's tests will walk into it too:** a submodule
pointer conflict needs **both** sides to move the pointer. If one side still carries the merge base's
commit, git resolves to the other side and exits **0** — no conflict, whatever the two targets' histories
look like. The first two attempts at this arm "passed" for exactly that reason.

## G-3 — a lock holds, against both verbs

| act on a locked tree | exit | message |
|---|---|---|
| `worktree remove` | **128** | `fatal: cannot remove a locked working tree, lock reason: <reason>` · `use 'remove -f -f' to override or unlock first` |
| `worktree remove --force` | **128** | the same — **one `-f` is not enough** |
| `worktree remove --force --force` | **0** | removed |
| `worktree prune -v` with the tree's directory deleted | **0** | prunes only the *unlocked* missing tree; the locked one stays registered |
| `worktree unlock` then `worktree remove` | **0** | removed |

`git worktree list --porcelain` reports the lock and its reason on its own line:

```
worktree <path>
HEAD 6f9a915762d39f7cec3a8cc796b56c1891c7fd8a
branch refs/heads/wt2
locked spike: a live lane
```

So `git worktree lock` is a real guard for a live lane: a sweep that calls `prune`, or `remove --force`, can
**not** take it — only `-f -f` or an explicit unlock can. That is the property phase 7 wanted and it holds.

## G-4 — `push --porcelain --no-follow-tags`

The frozen argv is `push --porcelain --no-follow-tags <remote> <src>:<dst>`. One flag character per ref,
then `Done`:

| case | exit | line |
|---|---|---|
| new branch | 0 | `*	refs/heads/l1:refs/heads/pe/x	[new branch]` |
| already up to date | 0 | `=	refs/heads/l1:refs/heads/pe/x	[up to date]` |
| fast-forward | 0 | ` 	refs/heads/l1:refs/heads/pe/x	0ad0264..b434508` (leading **space**) |
| rejected, non-fast-forward | **1** | `!	refs/heads/r1:refs/heads/pe/x	[rejected] (non-fast-forward)` |
| delete (`:refs/heads/pe/y`) | 0 | `-	:refs/heads/pe/y	[deleted]` |

Two notes for phase 8. The flag is the first **tab-separated field**, and a fast-forward's flag is a *space*,
so a parser must split on tab rather than trim. And a rejection is exit **1** with the porcelain line still
printed on stdout — the hints go to stderr — so `pushRef` can classify from stdout alone and does not need
to read the hint text.

**Not measured, deliberately:** anything forced. `--force`, `--force-with-lease`, `--mirror`, `--delete` and
tag pushes are offences under the never-push allow-list phase 2 pins, so no arm produced their shapes.
