# Conventions

Contents: Slug · Task list · Commits · Branches · Memory · Status source of truth ·
Phase dependencies (the DAG) · Session sizing & hygiene · Helper scripts · Locking ·
Scoped concurrency · QA gating (opt-in) · Gates (human vs ai) · Rulings · A person's turn · Issues ·
Docs layout & repo split · Multi-repo commit atomicity

## Slug
- kebab-case, derived from the work: `crm-import-contacts`, `submission-approval-fix`.
- The **same slug** names the plan (`docs/plans/<slug>.md`), the handoff folder
  (`docs/handoffs/<slug>/`), and the memory entry (`project_<slug>`) — so one grep finds all three.
- **Memory-key override:** when this work extends an existing tracked project, the plan's `memory:`
  frontmatter may point to a pre-existing `project_<other>` key. Document the deviation inline (e.g. a
  `# reuses project_sa_crm_app_gaps` comment). The slug still names the plan and handoff folder.

## Task list — `scripts/phase-tasks.sh`, and ids `pN.taskM`
At `phase-start`, **reset** the list (which drops the previous phase's) and create this phase's tasks
with subjects prefixed `pN.taskM`:

```bash
bash <skill-root>/scripts/phase-tasks.sh <slug> 1 reset
bash <skill-root>/scripts/phase-tasks.sh <slug> 1 create --subject "p1.task1 — add migration file"
bash <skill-root>/scripts/phase-tasks.sh <slug> 1 create --subject "p1.task2 — mirror canonical SQL"
bash <skill-root>/scripts/phase-tasks.sh <slug> 1 update --id p1.task1 --status in_progress
bash <skill-root>/scripts/phase-tasks.sh <slug> 1 update --id p1.task1 --status completed
```

- Use the script whether or not the harness offers `TodoWrite` / `TaskCreate` / `TaskUpdate` (unattended
  `claude -p` sessions get none). If it does, use them as well — they feed the same list.
- An unnamed `create` is numbered `pN.task1`, `pN.task2` … in creation order since the last `reset`, so
  an `update` names a task without reading anything back; `--id` overrides. Statuses: `pending` ·
  `in_progress` · `completed`, plus `deleted` on an update, which removes the row.
- It writes to `$PE_TASKS_FILE` under the autopilot, else to the console's inbox for this repository.
  It always exits 0.
- Keep the broad roadmap in the plan; the task list holds this phase's tasks alone.

## Commits (per phase)
- Stage **explicit feature paths**, never `git add -A` — submodules carry unrelated uncommitted work.
- Commit **inside** the relevant submodule(s); a superproject tracks only submodule pointers, so a
  phase touching two submodules makes one commit in each, then (if desired) a pointer-bump in the superproject.
- End the message with the repo's `Co-Authored-By:` trailer.
- Commit after each coherent, green step; a phase is a short series of commits per repo, each one whose
  checks you ran. On a SHARED run branch, work whose checks you have not run stays uncommitted when you
  wrap up (the console's wrap-up notice says which branch you are on); on a lane's own branch commit what
  is done. Rewriting pushed history (squash, `git reset`) is a person's call, never a session's.
- **Verify the sha:** run `git log -1` after committing — never carry a sha from memory into the next
  handoff without checking. The environment may auto-commit (hooks); confirm the actual sha/message.

## Branches
- **Default: commit to the branch already checked out.** Create a branch only when the user
  **explicitly asks**.
- **When the user asks for a branch, use exactly ONE branch per repo for the whole plan** and commit
  **every** phase to it — including independent phases in separate sessions, sequential or concurrent on
  disjoint scopes. No branch per phase or per session.
- **Record the branch in the plan** (the `## Session budget` note's `Branch:` line). Create it **once**
  (at plan time); later sessions `git checkout <branch>`, **never** `git checkout -b`.
- **Worktree lanes are the console's exception, not yours.** With `- **Worktrees:** on` on a new-branch
  run, each concurrent lane gets its own checkout on **`pe/<slug>-p<N>`** — a *sibling* of the run branch
  `pe/<slug>` (`pe/<slug>/p4` is impossible while `pe/<slug>` exists). The console merges each lane back
  into `pe/<slug>` when its phase settles; a conflict aborts the merge and halts with every commit still
  on the lane branch. A session in a lane commits to the branch it finds checked out.
- **Leave `$DOCS_ROOT` as the console set it.** Skill scripts resolve the docs root as `$DOCS_ROOT` first,
  then a cwd-upward git walk — which inside a linked worktree answers the worktree, so overriding it puts
  the handoff, `.locks/` and QA row where the board never looks. Set it only when you mean a different
  repo (`DOCS_ROOT=<hub-root> bash <skill-root>/scripts/…` from inside a submodule).

## Memory (the `remember` replacement)
At each phase boundary, update the durable memory:
- `project_<slug>.md` in `~/.claude/projects/<proj>/memory/` — frontmatter (`name`, `description`,
  `metadata.type: project`) + body: phase status, commits/shas, deploy/commit gates, gotchas.
- Add/refresh the one-line pointer in `MEMORY.md`: `- [Title](project_<slug>.md) — hook; [[links]]`.
- Cross-link related memories with `[[name]]`.
- Memory = durable facts that must outlive the docs. Handoff = operational next-session state. Plan =
  roadmap. Don't duplicate across them.

## Status source of truth
Status is **computed, not a stored cursor.** `scripts/phase-graph.sh <slug>` reads each handoff's
`status:` frontmatter + the plan's Phase-graph table and puts every phase in one of five buckets:
`done | in-progress | stuck | ready | waiting`. **`stuck` is a handoff that says `blocked`**; the buckets
and the four writable handoff statuses are different vocabularies (owners: `shared/status-vocab.js`
`BOARD_BUCKETS` and `shared/plan-vocab.js` `HANDOFF_STATUSES`). Keep INDEX.md and each handoff's
`status:` accurate — they are the inputs; the plan's "Exit criteria" column defines done but is
secondary. Never hand-maintain a "current phase". **A plan is finished only when the board shows EVERY
phase `done`**, never when the highest-numbered phase is reached.

**Closure is stored, because it is an operator decision.** "Is every phase done?" is computed. "Does
anyone still care?" is the plan's own `status:`. A terminal status (`complete`, `abandoned`,
`superseded`) means **closed**: no stuck-handoff, QA, drift, ready, boot-prompt, batching or
notification reports, while the board still renders in full and structural damage is still noted. Set
it with `scripts/close-plan.sh` (`--reopen` reverses it); ask with `phase-graph.sh <slug> --closed`. A
closed plan can have unfinished phases; an open plan with every phase done stays open until someone
closes it.

**`close-plan.sh <slug> --status complete` refuses** — exit 1, one line per item — while any repository
of the docs root carries `pe/<slug>` that its origin trunk does not hold (an ancestor, or a squash whose
content is there; read as last fetched, so fetch first), while `landing.md` has a row in `conflict` or
`failed`, or while an issue labelled `plan:<slug>` is open on one of those repositories (a repository
`gh` cannot read is an item too):

```
refusing to close <slug> complete — <n> item(s) of its work are not done:
  unlanded: pe/<slug> in <repo> is not on origin/main (as this clone last fetched it)
  landing: phase <N> in <repo> is conflict (docs/handoffs/<slug>/landing.md)
  open: <owner>/<name> #<n> <title>
land the branches and close or move the issues first; --force closes it complete anyway and records the exception
```

`--force` closes it `complete` regardless, prints `--force: closed complete over what is still open:`
with the same items, and appends `closed complete with <n> item(s) open (--force)` to `closed_reason`.
`abandoned` and `superseded` are never held to the landing.

What closure quiets, and what it does not:

- **Search still finds a closed plan** (with a `closed` badge); every attention surface drops it.
- **A closed plan stops announcing progress, not processes.** No notification for a phase landing,
  work becoming ready, a plan finishing or files changing; `approval`, `needs-you`, `halted`, `parked`,
  `session` and `health` still fire. Its stuck phases and stale locks go quiet; its halted run does not.
- **⚠️ A closed plan still reports its own `ready` phases — only the AGGREGATES are gated.**
  `--memory-block` prints every state (plus a `closed:` line) and `planStats()` passes `board.ready`
  through; `portfolio()`'s `totals.ready`, `remainingWeight`, `remainingSessions`, `readyQueue` and
  `stalled` count only open plans. **Anything that turns `ready` into a call to action gates closure
  itself.** The predicate has exactly three implementations — `plan_is_closed()` in bash,
  `isClosedStatus()` on the server, `client/src/lib/closure.ts` in the client — and never a fourth.

## Phase dependencies (the DAG)
- The plan is a dependency graph. A phase's `Depends on` lists **every** phase that must finish first;
  `scripts/phase-graph.sh` parses that column (numbers, comma lists, ranges like `1–7`, `—` for none).
- **ready = not started AND every dependency `done`**, computed from the done-*set*, so it holds for
  out-of-order execution too (finishing 1→4→5 before 2,3 leaves 2,3 not-done, and the plan unfinished).
- Two phases are **parallel-safe** only if neither depends on the other **and** their **scopes are
  disjoint** (§Scoped concurrency). Independent `ready` phases run in *separate* fresh sessions,
  simultaneously when their scopes allow; `next-phase-prompt.sh` lists a boot prompt for each and says
  which pairs may run together.
- `new-handoff.sh` auto-fills each handoff's `depends_on` + `blocks` from the graph. Don't hand-edit those
  to disagree with the plan table.

## Session sizing & hygiene
- **Right-size; don't reflexively split.** One coherent chunk per session, sized to the running model's
  budget (~0.2 × window in phase weight; `references/sizing.md`). **The console runs one phase per
  session; batch only by hand.** Driving by hand, any **ready** phase that fits the **remaining budget**
  may be **batched** into the same session. Open a fresh session (`/clear`) when the budget is spent, at
  a GATED phase, to switch model, or — with QA on — when the next phase depends on an unrecorded verdict.
- **Session budget is computed, not stored**: from the plan's `## Session budget` note +
  `references/sizing.md` + your model. `scripts/phase-graph.sh <slug> --session-plan <model>` proposes
  the grouping; you confirm it.
- **Keep the cache warm.** Don't switch model/effort or run `/compact` mid-phase; start a fresh session
  instead.
- The plan-creating session also runs Phase 1 (no `/clear` between plan and phase 1), and may batch on
  under the same rule.
- **Bootstrap via INDEX, not folder mtime.** At Mode 2 start, run `scripts/handoff-status.sh <slug>` or
  read `docs/handoffs/<slug>/INDEX.md`; early phases may live in a legacy flat file the INDEX references.
- If a handoff can't bootstrap a cold session, fix the handoff.

## Helper scripts
`scripts/` resolve their own location and the docs root: `git rev-parse --show-superproject-working-tree`
first, then `--show-toplevel` / `pwd`; with no `docs/` under the resolved root they exit with an error.
Run them from the repo root, or set `DOCS_ROOT=/path/to/repo` from inside a submodule.

`scripts/instance.sh` (bash half of `shared/instances.mjs`: a console's state directory) and
`scripts/scope.sh` (bash half of `shared/scope.js`: reading a Repos column) are **sourced, never
executed**. Data files: `scripts/sizing.env` + `scripts/models.env` (budgets, model vocabulary),
`scripts/gates.env` (gate vocabulary), `scripts/mcp.env` (per-server surcharge), `scripts/verify.env`
(the verification-command vocabulary of F16/F17/F18 and the stall detector). Change a value in the env
file, never in a consumer.

What runs a phase when nobody is watching — the convergence loop, the Stop hook, permission profiles, run
settings, the remediation ladder, freeze/thaw, ask/steer and the `?include=` projections — is
`references/console-surface.md`.

## Locking (concurrency guard)
Verbs: `phase-lock.sh <slug> <claim|release|status|list|conflicts|mirror> [N] [opts]`.
- **Claim the phase you start**: `scripts/phase-lock.sh <slug> claim <N> --owner "<account>/<session>"
  --scope "<csv>" --git` writes `docs/handoffs/<slug>/.locks/phase-NN.lock` (owner + lease + scope) and,
  with `--git`, commits and pushes it (a raced commit or push is retried with pull --rebase, up to 3×).
- **`git pull`, then ask two questions before you build.** *Is the phase taken?* — `claim` refuses a
  live holder. *Does anything live share my working tree?* — `phase-lock.sh <slug> conflicts <N> --scope
  "<csv>"`, across **every plan** (exit 0 clear / 1 conflicts / 2 usage). On either refusal **stop and
  ask the user**: wait, stop the other session, `--force` take over, or start a ready phase with a
  disjoint scope. Never build a phase two sessions hold at once.
- `claim` enforces only the *same-phase* rule, never scope; scope policy belongs to `conflicts`, the
  console's scheduler, or a session that can ask a human.
- `scope=` is optional. **Absent means UNKNOWN, and unknown collides with everything.**
- `session=` (`--session <id>`, else `$PE_SESSION_ID`, else `$CLAUDE_CODE_SESSION_ID`; a same-owner
  refresh naming none keeps the line) keys the console's session registry (fed by
  `scripts/session-hook.sh`): a lock whose session is **ended** is debris at once, one whose session is
  **live** is a queue to wait in (`foreign-live`), one nobody reports keeps lease rules. Only the lock's
  own `session=` may mean debris; a `<user>@<host>`-and-time match is display only.
- `worktree=` (`--worktree <path>`, else `$PE_WORKTREE`) and `branch=` (`--branch <name>`, else
  `$PE_BRANCH`; a same-owner refresh naming none keeps the line) are the **pair** that changes a
  `conflicts` answer (§Scoped concurrency). **Absent in EITHER dimension means UNQUALIFIED, which
  collides with everything.** A tree alone carves nothing. `status` and `list` print both.
- **Leases expire after 2 h** (`lease=7200`); refresh by re-claiming; the console keepalives its own
  lanes every lease/3. Release at phase-finish (`phase-lock.sh <slug> release <N> --owner … --git`).
  The lock is cooperative: an operator (the Locks view) or the convergence loop (for a provably dead
  session) can release it.
- **Under an autopilot (`PE_LOCK_MIRROR=console`) the console mirrors the lock in git, not you.** Run
  the boot prompt's `conflicts` and `claim` lines without `--git`; `phase-lock.sh` skips a `--git`
  passed anyway (one stderr line, never a refusal). The console runs `phase-lock.sh <slug> mirror <N>`
  itself: one commit of the lock path alone, no pull, no push; a mirror that cannot land says
  `UNMIRRORED` and leaves the lock on disk. **A person driving by hand keeps `--git`.**
- **The docs root is declared scope, never admitted on.** Every phase writes under
  `docs/handoffs/<slug>/`, so the boot prompt names that **per-slug token** beside the scope
  (`scope_root_token` / `rootScopeToken`; `all` already covers it). Writes there are ordered by the
  docs root's **critical section**, a directory `<git-dir>/pe-root-section` taken with `mkdir` around
  every commit and rebase `phase-lock.sh` makes and released before any push (`PE_ROOT_SECTION_WAIT`,
  default 30 s; a section whose writer's pid is gone, or older than `PE_ROOT_SECTION_STALE`, default
  900 s, is broken; a writer removes only its own). Every lock commit names its own path
  (`git commit --only -- <path>`); commit your own handoff the same way, by path.
- **A scope-drift line means the phase itself left its scope.** The console compares each repository
  outside the scope before and after the phase and credits a new commit to it only when it is on the
  lane's branch or the lane's session printed it (`[branch sha] subject`) — never a `phase-lock:`
  commit, another plan's (`docs/handoffs/<other>/`, `docs/plans/<other>.md`), or a write inside the
  declared scope (the Repos tokens, the per-slug token, `docs/plans/<slug>.md` and its `<slug>-…`
  companions). Detection, not containment.
- **The console's provisional claim carries the PAIR only** (the tree as `--worktree`, the run branch
  `pe/<slug>` as `--branch`) until the session re-claims.
- **A terminal session holds what it TOUCHED, never where it was opened.** A hand session with no
  `PE_SCOPE` is read from its transcript: paths its Edit/Write/MultiEdit/NotebookEdit calls named,
  repositories it changed (`git -C <dir> …`), plans its `phase-lock.sh` / `phase-graph.sh` calls named
  (another docs root's `DOCS_ROOT=` means elsewhere; a lock call's `--scope` is its own word). It holds
  what it touched for `PEER_CLAIM_WINDOW_MS` (10 min) after its LAST touch; a session that touched only
  elsewhere holds nothing; one that touched nothing holds its cwd's reach for 10 min from its newest
  start. A person can **Release** it (`POST /api/sessions/<id>/release {hours?}`, `--allow-run`).
  Claim a lock when you work a phase: a lock is the one statement nothing has to infer.

## Scoped concurrency (working-tree safety)
- **The invariant: never two live sessions whose scopes intersect. Same repo ⇒ serialized; `all` ⇒
  exclusive against every unqualified claim; disjoint ⇒ parallel.** The hazard is a shared *working
  tree*, not the number of sessions.
- **`all` is carved like any other scope once both claims are qualified.** Two claims that each declare
  a branch AND a working tree, and differ in both, may run together even when one says `all`. A claim
  unqualified in *either* dimension collides with everything (`claimsDisjoint` in `shared/scope.js`,
  `claim_disjoint` in `scripts/scope.sh`).
- **A lock with no `scope=` line reads as `all`** in both languages. Never infer a lock's scope from its
  plan.
- **Scope = the plan's Repos column**, normalised by `shared/scope.js` and `scripts/scope.sh`;
  `phase-graph.sh <slug> --repos <N>` prints it. `all` and an *undeclared* cell touch everything. A path
  token nests segment-wise: `packages` ∩ `packages/cart-api` collide, `api` and `api-gateway` do not.
  Ambiguity resolves toward colliding. **The superproject's own name is not a free token**: it mounts the
  whole root into an isolated run and holds the phase against any run with the root repository on its
  branch. A phase that writes only in submodules lists the submodules and leaves the root out
  (`references/plan-format.md` §Phase graph; lint **F34**).
- **A phase scoped `all` serialises the entire docs root while it holds its lock** — every other plan's
  phases queue behind it until it releases or the lease expires (under the autopilot they queue, capped
  at two hours). Name real repositories; keep `all` for phases that genuinely touch everything.
- **Overlapping on one repo needs separate checkouts and branches** — never one shared directory.
  - Under a console **lane worktree** or **mirror**, your cwd IS the checkout; never `git worktree add`.
  - When you need a branch somebody else holds, work only in scoped files in the checkout you have, or
    declare `blocked --needs lock --watch lock:<holder-slug>/<holder-phase>` and stop. **A watch is for
    somebody ELSE's lock**: a watch on your own phase's lock is refused (exit 2). A block on a person
    (`--needs ambiguity`) takes no watch and no wait clock.
  - **A hand session that needs a second checkout** (e.g. a read-only QA round beside a build) takes one
    through `scripts/phase-lane.sh` (run it bare for usage): `create` puts it under
    `<root>/.worktrees/hand/<slug>/p<N>[-qa<r>]` on `pe/<slug>-p<N>[-qa<r>]` (or detached), locked;
    `merge` folds it back; `remove` takes the tree, the merged branch and the lock away (superprojects
    included). Never a sibling folder of the project, never a worktree of the superproject itself. On a
    plan with `- **Worktrees:** on` the script refuses a build lane and offers `--detach` or `--qa`.
  - **Under a console run** a spawned session takes at most a review tree (`--detach`) or a QA round's
    (`--qa`) — never a build lane, a `merge`, a `pe/<slug>` checkout or `git switch -c`; the console owns
    the run's trees and branches. A hand tree standing on the run branch blocks the run's own checkout
    (`branch-in-use`); the console detaches it at the run's next boundary
    (`run.isolation-reclaimed {detached: true}`).
- **Never clone, and never `git submodule update --init`, inside a run's checkout.** A repository your
  scope does not name is an EMPTY directory in the run's mirror; read it at the shared root, read-only
  (the boot prompt names that path). The console denies `git clone` / `gh repo clone` into a run tree
  (`run-tree-clone`), asks before `git submodule` inside one (allowed at the run root), and moves foreign
  content at a mount to `<run>/stale-mounts/<ts>/<mount>` (itself when clean and pushed, after a person's
  **Repair checkout** otherwise; never deleted).
  - A person's commands for a parked phase belong in an **errand tree** —
    `POST /api/run/<slug>/errand-tree {phase}` makes `<root>/.worktrees/hand/<slug>/p<N>-errand`,
    detached at the PUSHED run branch in every mounted repository, locked, never pruned — not in the
    run's mirror. `validate.sh` warns on a handoff `!` line that points into a run tree.
  - Never DETACH your run's own checkout (`git switch --detach`, `git checkout <commit>` — denied as
    `run-tree-detach`). After a squash-merge, once the trunk holds every change of the branch (a
    `git merge-tree` proof) the console re-seats `pe/<slug>` on `origin/<trunk>` itself. A run finishes
    only when every repository's run branch is on `origin/<trunk>` by that proof; otherwise it parks
    `unlanded` and its card opens a merge errand tree.
- **A scoped run (`onlyPhases`, "Run only this") finishes when its phases do** —
  `run.finished {onlyPhases}`, a `finishedReason` naming the scope — opens no pull request, and is never
  the plan's final run. To move one stuck phase use `resume-phase` (Retry) on the unscoped run, or
  `isolate-phase` for a phase held behind another run's branch; never scope a run for it.
- **Run isolation is a RUN setting, not a plan line.** It gives a work-branch run its own checkout so
  two intersecting runs can be admitted together. Inside one: your **cwd is a linked worktree**;
  `$DOCS_ROOT` is the docs root, always; `$PE_BRANCH` is the branch to commit on — or
  `detached@<sha12>` when the checkout is detached at the trunk (the commit it stands at, not a branch);
  `$PE_WORKTREE` is the tree to record on the lock. A refused isolation (`scope-unmapped`, a full disk,
  the worktree cap) degrades to the shared checkout with queue semantics; the procedure is unchanged.
  Two hand-driven sessions in one repo still need two checkouts and two branches.
- **Worktree lanes (`- **Worktrees:** on`) change nothing about scope.** Each lane runs in a `git
  worktree` of the run branch, merged back when it settles; lanes still share the object database, refs
  and the branch they commit to. Record where you work with `phase-lock.sh --worktree <path>` (or
  `$PE_WORKTREE`); `scope=` stays the REPO. Per-lane worktrees refuse on a superproject; the RUN takes a
  MIRROR instead — one linked worktree per scoped sub-repository, the superproject's ROOT first when the
  scope means it — and those phases share the mirror, serialized per scope. The refusals by name are
  `scope-unmapped` and `has-submodules`. See `references/plan-format.md` §Session budget.
- **Branch AND tree qualification carves two sessions out of one repo; both are lock FIELDS, never scope
  tokens.** **Two claims whose scopes intersect are nevertheless disjoint iff BOTH declare a branch AND a
  working tree and both differ; anything else collides.** So `phase-lock.sh conflicts <N> --scope "<csv>"
  --branch pe/a --worktree /w/a` is clear against a live lock with `branch=pe/b` in `/w/b`, and refuses
  one with `branch=pe/a`, one in the same tree or a tree nested in it (segment-wise), and one unqualified
  in either dimension. A branch alone does not carve. The scope stays the repo and both questions must
  pass. Branches do not nest (`main` and `pe/main` are two branches) and are case-sensitive.
- **The console applies the same rule.** The scheduler's `conflictsFor` narrows its grants, the locks on
  disk and aged reservations by `claimsDisjoint`, so two isolated runs on one repository are admitted
  together. An admission's branch is `RunnerBase.branchFor` — in practice the run branch `pe/<slug>` or
  nothing, so two lanes of one run are not carved apart and still need disjoint scopes. **The same
  slug+phase never carves** (`sameUnitOfWork`), whatever the branches or the repository guard.
- **The lock is per PHASE; the branch is per RUN.** A new-branch run in the SHARED checkout HOLDS each
  repository it left on `pe/<slug>` until the run settles (a record under `<state>/trees/`). `conflicts`
  reads those holds: a repository of your scope standing on another open run's branch is a
  `CONFLICT … run <id> — holds <repo> on <branch>` line. Against a hold the branch the tree already
  stands on is no collision and a different branch always is (`claimsDisjoint` with `hold: true`,
  `claim_disjoint_hold`). Your own checkout (`phase-lane.sh`, a mirror, an isolated run) is never held.
  The hold ends when the holder's run settles or the tree leaves its branch.
- **Handoff, INDEX and lock commits in the docs repo are NOT part of a phase's scope.** On a raced commit
  or push, rebase and retry (≤3).
- **Never `git stash` to hand work to another session** — a stash is invisible to other trees and
  clones. **Commit** instead (a WIP commit is fine).
- **Commit before you switch, pull before you start.** End a session with everything you verified
  committed (unverified work on a shared branch is the one thing left in the tree, and the handoff names
  it); the next session `git pull`s and runs `conflicts` / `claim` before touching anything. Git is the
  channel, not a closed session's filesystem.

## QA gating (opt-in — verify before dependents start)
- **QA is opt-in, off by default.** It is on with a `**QA gate:** on` line in §Session budget,
  `new-handoff.sh --qa` at a finish, or a plan that already has `test-status.md`. A recorded **waiver**
  (`**QA gate:** off`, or legacy "QA gate: WAIVED…" prose) records rows as `waived` and never dispatches
  a subagent — the session's own §Verification is the bar. `phase-graph.sh <slug> --qa-mode` reports the
  regime (`off` · `on <reason>` · `waived <reason>`).
- **When QA is on:** at each phase-finish dispatch a **fresh-context QA subagent** (brief:
  `phase-graph.sh --qa-prompt N`). It reviews the real diff per `references/qa-method.md`, runs/extends
  tests, writes the report file **the brief names** (round 1 `reports/phase-NN-qa.md`, later
  `reports/phase-NN-qa-roundR.md`), and records via `scripts/qa-record.sh` into
  `docs/handoffs/<slug>/test-status.md`: `## QA status` (ONE row per phase, the gating verdict, with a
  `Round` column), `## QA rounds` (append-only, `--qa-history`) and `## QA waivers` (each `--reason`).
  The closeout dispatches a `qa-full` subagent for the whole plan.
- **Under QA `on`, a dependent is `ready` only when every dependency is `done` and QA `pass`/`waived`.**
  A `fail` holds all dependents until a re-QA passes. Commit + push the report and `test-status.md`.
- **A `pending` row holds dependents as hard as a `fail`.** Finishing a phase under QA means
  *dispatching the verdict*, not just writing the handoff.
- **Per phase: `- **QA:** on|off` in the phase's §Phase section.** The phase's word wins, silence
  inherits the plan. An exempt phase is never asked for a verdict and a verdict recorded against it holds
  nothing. `--qa-mode <N>` reports the resolved regime and its level.
- **`**QA gate:** off` releases the gate for the whole plan**: recorded verdicts stay and are reported,
  they stop holding dependents. Re-QA is the per-phase release.
- **Both switches have one writer: `scripts/qa-mode.sh <slug> [--phase N] on|off|inherit`** (`inherit`
  removes the phase bullet); it prints `--qa-mode`'s read-back. Editing the plan by hand is also valid.
- **Closing the plan retires a `fail` without a re-QA** (the row stays; reopening restores the gate).
  Re-QA clears a failure; closure stops caring about one. Never close a live plan to hide a failure.
- **Whatever creates `test-status.md` mid-plan** (`new-handoff.sh` or `qa-record.sh`) backfills
  already-complete phases as `waived`. Use `waived` otherwise only for a genuinely non-applicable check or
  a recorded plan-level waiver.

## Gates (human vs ai — one approval door)

A gate blocks a phase on something outside the plan's dependency graph. Its `Gate-check` directive
categorizes it (`scripts/phase-graph.sh <slug> --gate-kind N`: `human` · `ai` · `auto` · `none`;
vocabulary in `scripts/gates.env`):

- **ai** (`Gate-check: ai <check>`) — an AI session may clear it, as its FIRST task: verify each
  condition in the Gates bullet for real, make failing ones true, record the clearance, then implement.
  **Bias gates here.**
- **human** (`Gate-check: manual <who/what>`; a `*(GATED)*` heading with no directive reads as **ai**,
  `scripts/gates.env` `GATE_DEFAULT`, and fails `validate.sh`, F24) — a person does the Gates bullet's
  steps, then approves through the phase page's **Gate card** or `scripts/gate-approve.sh <slug> <N>
  --by "<who>" --note "<what was done>"` in their own terminal. **A gate the plan marks `manual` is a
  person's whatever the `gates` decision says** — "all permissions" never delegates it, and a session
  never records its own approval. On one, STOP and declare `phase-outcome.sh … needs-human --needs gates`.
  - the runner never boards a session on a `human` gate (`--gate-kind` answers `human` for `manual` and
    for an unknown type);
  - `gate-approve.sh` names its DOOR from its environment, never from `--by`: `session`
    (`PE_OWNER=autopilot/*|console/*`, `PE_OUTCOME_FILE`, `PE_SESSION_KIND`, `CLAUDECODE=1`), `console`
    (a person's press through the console), `terminal` (stdin is a tty, no session marker) or `script`.
    A manual gate is approved only through `console` or `terminal`, never by an `ai-*`, `autopilot*` or
    `console/*` approver; a revoke is taken from any door;
  - the door is recorded in `gate-status.md`'s `Door` column, and `--gate-status` honours a manual row
    only when a person's door wrote it.
  The `gates` decision answers the rest of the human family — an overdue `deadline`/`by` gate
  (`OVERDUE`): the plan's `## Decisions` row, then the console's `policy.gates` (on by default), then
  `delegated`. A delegated gate still needs evidence you can cite for each condition; STOP the moment one
  cannot be verified (`phase-outcome.sh … blocked --needs gates --reason`). A delegated gate whose verdict
  states no condition a session could evidence stays `gated` for a person.
- **auto** (`date` / `deadline` / `by` / `phase` / `phases` / `plan` / `cmd`) — the engine evaluates it.
  `cmd` executes only under `PHASE_EXEC_GATES=1`; page views and boot prompts report **`unevaluated:`**
  instead, which means **nobody is needed** — a session may evaluate it by running the printed command
  with the flag.

**The approval record** is `docs/handoffs/<slug>/gate-status.md` (`## Gate approvals`), written only by
`gate-approve.sh` (an idempotent upsert). An approved row clears `--gate-status` for EVERY kind;
`--revoke` restores the gate. It is not `test-status.md`, whose existence switches QA on. Commit + push
it. The `*(GATED)*` marker stays until the plan's author removes it: an approval opens the door once; batching still seals around it, and the boot prompt notes
the approval and proceeds.

The autopilot boots a session on an unclear **ai** gate (clearing it is the session's job) and holds an
unclear **human/auto** gate as `gated` until approved. Never batch past a gate of any kind.

## Rulings — the decisions the plan did not make for you

Record every judgement call the plan could not make — two readings, a departure, a sub-case left for
later — as it happens:

```bash
bash scripts/phase-outcome.sh <slug> <N> ruling --kind ambiguity|deviation|deferral   --what "<what you decided>" --why "<why>" [--cost-if-wrong "<what it costs if this was wrong>"]   [--for <M|next|all>] [--needs <decision key>] [--remember plan|global] [--by WHO]
```

It appends one NDJSON line to `$PE_RULINGS_FILE` (runner-injected) or, unsupervised, to
`runs/<instance>/<slug>/rulings.ndjson`, stamped with its id; the console journals it as `phase.ruling`
and shows it as an `fyi` row. **Name the decision key it answers** (`--needs <key>`, a manifest key —
never a blocker short form) whenever there is one. The three kinds:

- **`ambiguity`** (the default) — the plan admitted two readings and you picked one.
- **`deviation`** — the plan said one thing and you did another, with a reason.
- **`deferral`** — something in scope was deliberately left. `--for <M|next|all>` (default `next`)
  addresses it, which puts it in `phase-graph.sh <slug> --notes M` and M's boot prompt. `--for` is
  refused on the other two kinds.

Write the ruling when you make the call and the handoff's `- **Phase M:** …` bullet at phase-finish:
both reach M's boot prompt; the ledger is what the console reads, the handoff what a person reads
(`references/handoff-format.md` §7 has the bullet grammar). Put the same decisions in the handoff's
**Key decisions / gotchas**.

**A ruling is not an outcome.** Nothing acts on it — it parks nothing, climbs no ladder, changes nothing
that runs next, and does not end your turn. Declare the outcome as well. The ledger is per PLAN and
append-only; an ack is a further line.

**Remembering.** `--remember plan` writes it as a `## Decisions` row of the plan's twin at once
(`decisions.sh promote`: value `--what`, source `ruling`) and acks it with `--by` (default
`$PE_OWNER`, else user@host). `--remember global` asks the owning console to hold `--what` as its
`policy.<key>` answer (`POST /api/run/<slug>/rulings/<id>/remember`), so `--what` must be an answer word
for the key; with no console answering the script exits 1 naming Settings ▸ Automation ▸ Policy
answers. The ruling itself is recorded first either way.

**A question the console's relay answered is a ruling too** (`references/console-surface.md`
§Questions): kind `ambiguity`, `decisionKey: ambiguity`, `by` `relay` or the person, and a `relay`
object `{tool, key, answer, answeredBy, ruleId?}` (`answeredBy`: `human`, `rule`, `recommended` or
`first-option`). Its extra action, **Remember as a relay rule**, makes a relay rule, never a
`## Decisions` row.

**The decisions the plan DID make live in its `## Decisions` manifest** (`references/plan-format.md`
§Decisions): one row per key of `scripts/decisions.env` (`credentials`, `accounts`, `gates`, `waits`,
`human-acts`, `ambiguity`, …). Every ruling, errand and `needs-human` reason names its row as its
**`decisionKey`**. Promote a ruling to a standing answer with `scripts/decisions.sh <slug> promote
--from-ruling <id> [--key <key>]` (no `--key` needed when the ruling carries one). Declare a block **by
key** — `phase-outcome.sh <slug> <N> blocked|needs-human --needs <key>`, required (exit 2 without),
where `<key>` is a decision key or a blocker short form (`credential`, `permission`, `gate`, `external`,
`lock`, and `run` with `--run-act <act>` for an act only the run can take — §A person's turn). A key
the manifest lacks is a defect report. Never ask in prose: prose reaches nobody.

## A person's turn — human steps

An act only a person can do — a browser sign-in, a device code, a token to paste, a password at the
machine, an approval on somebody else's dashboard — is a **human step**, not a failure or a free-text
errand. The console raises ONE item on **Your turn** (`#/turn`) and ONE `needs-you` push whose buttons
follow the kind, parks the phase on a PERSON (wait kind `person`, situation
`blocked-declared:human-acts`, no ladder rung spent), checks it when the person presses *I've done this —
check* (`passed`, `rejected` with what to redo, `needs-info`), and resumes the same session with what
was proven or answered. The full reference — reasons, guide grammar, a template per kind, proof types,
the guard, the permission block, the doors — is `references/turn.md`.

Declare one with `phase-outcome.sh <slug> <N> needs-human --needs <key> --step <kind> --title "<what>"
…`, hand off `in-progress`, and stop; `phase-outcome.sh --help` lists every flag. The kinds are
`scripts/human-steps.env`'s; `--act` is `--step operator-act` (a command or click path), and
`--due-when <ref>` keeps a step `upcoming` until the ref lands. Say **why only a person fits it**
(`--why <reason>`, `scripts/turn.env`'s `WHY_PERSON`, held to the kind's `KIND_REASONS`; absent, the
kind's default is recorded as inferred), give **a full guide** (`--guide <file>`, `shared/guide-grammar.js`:
a why paragraph, `## Steps` with numbered steps — each with an optional command, `Expect:`, `Warning:`
and `Link:` — and `## If it goes wrong`; at most 20 steps and 24 KB, `--lang` its language), and **a
proof a person can read** (`--proof` ref, `--proof-words`, or `--proof-type attest`). Four rules:

- **Never hand a person what you can do yourself.** The guard (G1–G7) runs at declaration and at ingest.
  For a `permission`, `reserved` or `reach` reason: a guide whose every command your run's policy would
  allow is refused with **exit 4** — run them; a command a rule stops makes it a `permission` item; a
  `reach` with no `--tried` is refused — try it, then re-declare with `--tried`. A sign-in (`identity`)
  is always the person's. Another lane declaring the same item joins it as a waiter.
- **Never run the sign-in yourself** — in a `-p` session it hangs on a browser or prompt nobody sees.
- **Never put a secret in a flag.** A token-, password-, one-time-code- or URL-query-secret-shaped value
  is refused (exit 2, nothing written, never echoed). The console never takes a secret either: a
  `secret-entry` step names only the registry id, and the item tells the person where the value goes —
  the keychain item `phase-console-<id>` on macOS, a 0600 file elsewhere, or the item's `credential:`
  place — where the check finds it by name.
- **A session's step never opens by itself.** Only a plan's bullet may carry `auto-open: host`.

Three more habits:
- **A wall is a permission block, not a step**: `phase-outcome.sh <slug> <N> blocked --needs permission
  --rule "<rule>" --command "<command>"` raises ONE `permission` item when it cites a wall the console
  recorded for your lane (else exit 4, G5: nothing refused this — run it). A person answers with a grant
  (`call`, `phase`, `plan`, `repository`, `always`), *Deny* or *I'll do it myself*; the never list has no
  grant.
- **A run-level act is a run request, never a permission**: relaunch isolated, switch account, raise the
  budget, stop or hold is `phase-outcome.sh <slug> <N> blocked --needs run --run-act <act>`; the
  supervisor (Pro) or ONE approval per run and act (Free) answers it. A `permission` declaration naming
  no rule or command on a shared checkout whose lane is not on `pe/<slug>` is read as `--run-act
  isolate`.
- **What you handled is recorded**: `phase-outcome.sh <slug> <N> handled --what "<what>" [--note …]
  [--link …]` puts one row under *Handled by the AI*; it is never an outcome.

The answer returns as the console's sentence, once per waiting session ("The operator answered
`<option>`: <note>", "The operator declined: <reason>. Do not ask again; …", a grant's "run it again");
a decision declared with `--decision-key <key>` has its answer written to the plan's `## Decisions`
first.

The console's ledger is `<instance state>/human-steps.ndjson` — append-only, last state wins, rotated
past 4 MB — in eleven states: `upcoming` → `declared` → `notified` → `opened` → `checking` → `proven`, a
check's `returned` (redo it), or the settles `declined`, `expired`, `cannot`, `dismissed`. No code, token,
password or URL query secret reaches it, a journal line, a push payload, the log or a transcript.

Run `gh auth login` (or any `SIGN_IN_SHAPES` member) anyway and the hook refuses it with the declaration
to make instead; declare it and stop. A plan's `- **Human step:**` bullets are asked for at the launch
door, proofs first, so a step already true never reaches the phase.

**Plan-time proof advisories**, read as the check reads them (`scripts/cmd-ref.sh`, twin of
`shared/proof-words.js`): **F45** `proof-unparsable` — a `cmd:` ref with a shell variable, a
substitution, an unclosed quote or a cwd-relative path, or a proof with no watch scheme; **F46**
`proof-script-run-branch-only` — a `cmd:` proof whose script is not on its repository's trunk. At check
time a missing script reads `unrunnable` (**Cannot run**, exit 127 named), never *Redo*. *Send my
decision* sends the answer and then runs its proof; an item whose proof reads a gate's row closes when
that gate opens (`references/turn.md`).

## Issues — the label lifecycle

An issue a plan owns moves through three states:

1. **`awaiting-plan`** — filed, and no plan owns it yet.
2. **`plan:<slug>`** — an amendment planned it: the relabel, plus one comment naming the fixing phase.
   A deferral relabels it `plan:<slug>-deferred`.
3. **Closed** — by the fixing phase at its finish, or by the plan's landing phase.

The fixing phase commits with **`Refs #N`**, never a closing keyword (a keyword closes the issue when the
run branch merges). Whether a phase may close its issue **before the fix is on `main`** is the plan's
decision, in its `permission.destructive` and `issues` rows. Where it may, the close comment says
"fixed on `<branch>`, not yet live" with the sha and the test that proves it. Where it may not, the
landing phase closes it once the fix is on `main`.

## Docs layout & repo split
- **Work-state lives in the project repo** under `docs/`:
  `plans/<slug>.md` and `handoffs/<slug>/{INDEX.md, phase-NN-*.md, reports/phase-NN-qa.md, test-status.md,
  .locks/phase-NN.lock}`. Commit + push so any account/machine can pull and continue.
- **The skill lives in its own install** — a plugin, or a clone under `~/.claude*/skills/`. With several
  clones, edit one and **commit → push → pull** in the others. Never put work-state in the skill folder,
  or skill code in the project repo.

## Multi-repo commit atomicity
- A phase touching several repos makes one commit per repo — there's no cross-repo transaction. Guard
  against half-committed phases: do the commits **last** (after the work is verified), in a fixed repo
  order; if one fails, fix it and commit that repo again — the commits already made stay, and the handoff
  names the repo still owed — and write the handoff only once `git log -1` in each repo confirms the
  expected sha.
