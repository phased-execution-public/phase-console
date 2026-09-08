# Conventions

Contents: Slug · Task list · Commits · Branches · Memory · Status source of truth ·
Phase dependencies (the DAG) · Session sizing & hygiene · Helper scripts · Locking ·
Scoped concurrency · QA gating (opt-in) · Gates (human vs ai) · Rulings ·
Docs layout & repo split · Multi-repo commit atomicity

## Slug
- kebab-case, derived from the work: `crm-import-contacts`, `submission-approval-fix`.
- The **same slug** names the plan (`docs/plans/<slug>.md`), the handoff folder
  (`docs/handoffs/<slug>/`), and the memory entry (`project_<slug>`) — so one grep finds all three.
- **Memory-key override:** if this work extends an existing tracked project, the plan's `memory:`
  frontmatter may point to a pre-existing `project_<other>` key rather than `project_<slug>`. Document
  the deviation inline (e.g. a `# reuses project_sa_crm_app_gaps` comment). The slug still names the
  plan + handoff folder; only the memory key differs.

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

**Why a script and not a task tool.** The console has always rendered this list as *"What it is doing"*,
folded out of the CLI's own `TodoWrite` / `TaskCreate` / `TaskUpdate` calls. Around **2026-08-14 the CLI
stopped provisioning those tools to `claude -p` sessions** — measured across 946 machine transcripts:
not one call since. The pipeline was never broken, it was starved, and every unattended run after that
showed an empty panel for hours while sessions burned passes searching for a tool that was not there.
A channel a session can be deprived of is not a channel; this one is a file on disk. If your harness
does still provide the tools, use them as well — they feed the same list, through the same fold.

**The ids are yours.** An unnamed `create` is numbered `pN.task1`, `pN.task2` … in order of creation
since the last `reset`, so an `update` names a task without anything being read back. `--id` overrides.
Statuses are `pending` · `in_progress` · `completed`, plus `deleted` on an update, which removes the row.

**Where it goes.** `$PE_TASKS_FILE` when the autopilot is supervising (it injects the path, deletes it
before every spawn and tails it into `PhaseRecord.tasks`); otherwise the console's own inbox for this
repository, so a hand-driven session's list shows up beside a lane's. Either way the exit is 0 — a
session following this discipline never dies here.

Keep the broad roadmap in the plan, never in the task list. (Memory: `feedback_phase_task_list_reset`.)

## Commits (per phase)
- Stage **explicit feature paths**, never `git add -A` — submodules carry unrelated uncommitted work.
- Commit **inside** the relevant submodule(s); the parent `hub` repo only tracks submodule pointers, so a
  phase touching two submodules makes one commit in each, then (if desired) a pointer-bump in the superproject.
- End the message with the repo's `Co-Authored-By:` trailer.
- One phase = one logical commit per repo (squash WIP before finishing).
- **Verify the sha:** run `git log -1` after committing — never carry a sha from memory into the next
  handoff without checking. The environment may auto-commit (hooks); confirm the actual sha/message.

## Branches
- **Default: do NOT create a branch — commit to the branch already checked out.** Creating a branch is the
  user's call; only create one when the user **explicitly asks**. This keeps a plan from scattering work
  across branches the user never wanted.
- **When the user does ask for a branch, use exactly ONE branch for the whole plan** and commit **every**
  phase to it — including independent phases that run in **separate sessions**, whether those sessions run
  one after another or at the same time on disjoint scopes. They touch disjoint files, so sharing one
  branch is safe; do **not** open a branch per phase or per session — that over-branching is exactly what
  to avoid. One feature branch per repo (submodule) for the entire plan.
- **Record the branch in the plan** (the `## Session budget` note's `Branch:` line) so every fresh session —
  sequential or independent — checks out the SAME branch. Create the branch **once** (at plan time, if the
  user asked); later sessions `git checkout <branch>`, **never** `git checkout -b`.
- **Worktree lanes are the one exception, and the console makes it, not you.** When a plan sets
  `- **Worktrees:** on` and the console runs its phases on a new-branch run, each concurrent lane gets its
  own checkout on its own branch, **`pe/<slug>-p<N>`** — a *sibling* of the run branch `pe/<slug>`, never a
  child. The hyphen is load-bearing: git refs are files in a directory tree, so `pe/<slug>/p4` is
  impossible while `pe/<slug>` exists. Each lane branch is merged back into `pe/<slug>` when its phase
  settles; a conflict aborts the merge and halts, losing nothing — every commit is still on the lane
  branch. A session in a lane commits to the branch it finds checked out, exactly as any other session
  does, so nothing in this section changes for the phase that is running.
- **`$DOCS_ROOT` says where work-state goes, and a session must not override it.** Every spawned session
  gets it, lane or not. Skill scripts resolve their docs root as `$DOCS_ROOT` first and a cwd-upward git
  walk second — and inside a linked worktree that walk answers the *worktree*, not the run's root, so a
  lane session that ignored it would write its handoff, its `.locks/` and its QA row where the board never
  looks: the phase lands cleanly and still reads `no-handoff`. Set it explicitly only when you mean a
  different repo (`DOCS_ROOT=<hub-root> bash <skill-root>/scripts/…` from inside a submodule).

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
`status:` frontmatter + the plan's Phase-graph table and classifies every phase into one of five buckets:
`done | in-progress | stuck | ready | waiting`. **`stuck` is a handoff that says `blocked`** — the engine
folds the word, so it never reaches the board as itself; the bucket list and the four writable handoff
statuses are deliberately different vocabularies (owner: `viewer/shared/status-vocab.js`
`BOARD_BUCKETS` and `viewer/shared/plan-vocab.js` `HANDOFF_STATUSES`).
INDEX.md + per-handoff `status:` are the inputs it aggregates —
keep them accurate; the plan's "Exit criteria" column is the *definition* of done but secondary. Don't
hand-maintain a "current phase". **A plan is finished only when the board shows EVERY phase `done`**, never
when the highest-numbered phase is reached.

**Closure is the one exception, and it is a different question.** "Is every phase done?" is computed and
never stored. "Does anyone still care?" cannot be computed at all — it is an operator decision, so it
*is* stored, in the plan's own `status:`. A terminal status (`complete`, `abandoned`, `superseded`)
means the plan is **closed**: it stops reporting stuck handoffs, QA failures, drift warnings, ready
phases, boot prompts, batching and notifications, while still rendering its board in full and still
reporting genuine structural damage as a note. Set it with `scripts/close-plan.sh` (`--reopen`
reverses it); ask for it with `phase-graph.sh <slug> --closed`. The two ideas must not blur: a closed
plan can have unfinished phases, and an open plan with every phase done is still open until someone
says otherwise.

Three boundaries the console draws around that, all deliberate:

- **Search still finds a closed plan.** Closing quiets a plan; it never hides one. Every attention
  surface — health issues, the ready queue, remaining work, the stalled list — drops it, and search
  keeps it (with a `closed` badge), because "I know we tried this once" is exactly the question a
  closed plan answers.
- **A closed plan stops announcing its progress, not its processes.** No notification for a phase
  landing, work becoming ready, a plan finishing, or files changing. But `approval`, `needs-you`,
  `halted`, `parked`, `session` and `health` still fire: those mean a live session has stopped and
  cannot continue without a person, and a stale `status:` line must never be able to strand a
  running agent in silence. The console's own surfaces draw the same line: a plan's *stuck phases*
  and *stale locks* go quiet, its *halted autopilot run* does not.
- **⚠️ A closed plan still reports its own `ready` phases — only the AGGREGATES are gated.**
  `--memory-block` prints every state for a closed plan (adding only a `closed:` line, which is what
  keeps engine-parity working) and `planStats()` passes `board.ready` through verbatim, because the
  plan's own board must still be able to say what never got done. `portfolio()` is where the gate
  is: `totals.ready`, `remainingWeight`, `remainingSessions`, `readyQueue` and `stalled` count only
  the open plans. **So anything that turns `ready` into a call to action must gate it itself** — the
  departures board, the nav badge, the dashboard's recommendation and tiles, the plan header's ready
  chips, the list's ready chips and count, and the boot-prompt cards all do. The client reads
  closure in exactly one place, `viewer/client/src/lib/closure.ts`; that is the third and last
  implementation of the predicate (`plan_is_closed()` in bash, `isClosedStatus()` on the server) and
  there must never be a fourth.

## Phase dependencies (the DAG)
- The plan is a dependency graph. A phase's `Depends on` lists **every** phase that must finish first;
  `scripts/phase-graph.sh` parses that column (numbers, comma lists, ranges like `1–7`, `—` for none).
- **ready = not started AND every dependency `done`.** Readiness is computed from the done-*set*, so it is
  correct however the phases are run — one completion unblocking several, sessions running side by side, or
  **out-of-order** execution (finishing a deep chain like 1→4→5 before siblings 2,3 — the board still shows
  2,3 as not-done, and the project isn't finished until they are).
- Two phases are **parallel-safe** only if neither depends on the other **and** their **scopes are
  disjoint** (§Scoped concurrency — the Repos column is the machine-readable form of "disjoint files").
  Independent `ready` phases run in *separate* fresh sessions, simultaneously when their scopes allow it
  and one at a time when they don't; `next-phase-prompt.sh` lists a boot prompt for each and says which
  pairs are which.
- `new-handoff.sh` auto-fills each handoff's `depends_on` (prerequisites) + `blocks` (dependents) from the
  graph, so every handoff is self-describing. Don't hand-edit those to disagree with the plan table.

## Session sizing & hygiene
- **Right-size; don't reflexively split.** Aim for one coherent chunk of work per session, sized to the
  running model's budget (~0.2 × window in phase weight; `references/sizing.md`). Several phases usually
  share a session: any **ready** phase — sequential on the one just finished *or* an independent sibling —
  that fits the **remaining budget** should be **batched** into the same session; it saves a full
  bootstrap + closeout and keeps the prefix cache warm. Open a fresh session (`/clear`) when the budget is
  spent, at a GATED phase, to switch model, or — with QA on — when the next phase depends on a
  still-unrecorded verdict.
- **Session budget is computed, not stored.** Like status, it's derived from the plan's `## Session budget`
  note + `references/sizing.md` + the model you're running — never a per-handoff field. `scripts/phase-graph.sh
  <slug> --session-plan <model>` proposes the grouping; you confirm it.
- **Keep the cache warm.** Don't switch model/effort level or run `/compact` mid-phase — each busts the
  prefix cache (a full-price re-read); start a fresh session instead.
- The plan-creating session also runs Phase 1 (no `/clear` between plan and phase 1), and may batch on into
  Phase 2+ under the same rule.
- **Bootstrap via INDEX, not folder mtime.** At Mode 2 start, run `scripts/handoff-status.sh <slug>` or
  read `docs/handoffs/<slug>/INDEX.md` to find the correct handoff for this phase. Early phases may live in
  a legacy flat file the INDEX references — don't rely on picking the newest file in the folder.
- If a handoff can't bootstrap a cold session, it's the bug — fix the handoff, not the next session.

## Helper scripts
`scripts/` resolve their own location and the docs root. **Root resolution is superproject-aware:** scripts
try `git rev-parse --show-superproject-working-tree` first (avoids resolving to a submodule root when cwd
is inside a submodule), then fall back to `--show-toplevel` / `pwd`. If `docs/` is not found under the
resolved root, scripts exit with a clear error message (and note when you're not inside a git repo). Always
run scripts from the repo root or set `DOCS_ROOT=/path/to/repo` explicitly when inside a submodule directory.

Two of them are **sourced, never executed**, and exist so the same fact is not computed twice:
`scripts/instance.sh` is the bash half of `viewer/shared/instances.mjs` (where a console's state directory
is, so `scripts/phase-outcome.sh` and `scripts/session-hook.sh` can find it with no console up and no node
on PATH), and `scripts/scope.sh` is the bash half of `viewer/shared/scope.js` (how a plan's Repos column is
read). Five more files are data, not code: `scripts/sizing.env` + `scripts/models.env` (budgets, model
vocabulary), `scripts/gates.env` (gate vocabulary), `scripts/mcp.env` (the per-server surcharge) and
`scripts/verify.env` (the verification-command vocabulary the F16/F17/F18 lints and the console's stall
detector both read). Change a value in the env file, never in a consumer.

What runs a phase when nobody is watching — the convergence loop, the Stop hook, permission profiles, run
settings, the remediation ladder, freeze/thaw, ask/steer and the `?include=` projections — is
`references/console-surface.md`.

## Locking (concurrency guard)
- A phase started in a session is **claimed**: `scripts/phase-lock.sh <slug> claim <N> --owner
  "<account>/<session>" --scope "<csv>" --git` writes `docs/handoffs/<slug>/.locks/phase-NN.lock`
  (owner + lease + scope) and — with `--git` — commits+pushes it so other clones see it on their next pull.
  A raced commit or push is retried (pull --rebase, up to 3×) rather than dropped.
- **`git pull`, then ask two questions, before you build.** *Is the phase taken?* — `claim` answers it and
  refuses a live holder. *Does anything live share my working tree?* — `phase-lock.sh <slug> conflicts <N>
  --scope "<csv>"` answers it across **every plan** (exit 0 clear / 1 conflicts / 2 usage). On either
  refusal **stop and ask the user**: wait, stop the other session, `--force` take over, or start a ready
  phase with a disjoint scope. Never build a phase two sessions hold at once.
- `claim` deliberately enforces only the *same-phase* rule, never scope. Policy belongs where it can be
  acted on (the console's scheduler, or a session that can ask a human), and keeping `claim` unchanged is
  what lets an older script and an older console keep working against a scoped lock.
- `scope=` is optional in the file. **Absent means UNKNOWN, and unknown collides with everything** — a lock
  written before scopes existed must never read as harmless.
- `session=` is optional too: the Claude session that holds the lock (`--session <id>`, else
  `$PE_SESSION_ID` — runner-injected — else `$CLAUDE_CODE_SESSION_ID`; a same-owner refresh that names none
  keeps the line). It is the key Phase Console's **session registry** answers presence for, fed by the
  user-scope hook `scripts/session-hook.sh` (installed from Settings ▸ Automation ▸ Session presence or
  `phase-console install-hooks`): a lock whose session the registry shows **ended** is debris at once —
  the scheduler admits the queue behind it and the convergence loop releases the file — a lock whose
  session is **live** is a queue to wait in (`foreign-live`), and a lock nobody reports keeps lease
  rules. Only the lock's own `session=` may ever mean debris; matching a session by `<user>@<host>` and
  time is display.
- `worktree=` is optional as well: the linked worktree this session is working in (`--worktree <path>`,
  else `$PE_WORKTREE` — set by the console's worktree lanes, and worth passing by hand when a boot prompt
  told you to make one). It is **half of the pair that changes an answer** — see `branch=` below and
  §Scoped concurrency. A tree alone carves nothing; it is also what a person reading a lock, or the
  console drawing it, uses to see WHERE the holder is working.
- `branch=` is optional too, and together with `worktree=` it is the **pair** that **changes an answer**:
  `--branch <name>` (else `$PE_BRANCH`; a same-owner refresh that names none keeps the line) records the
  branch this session's work rides, and `conflicts` reads both. **Absent in EITHER dimension means
  UNQUALIFIED, which collides with everything** — same fail-safe direction as an absent `scope`, so every
  lock written before the fields existed serialises exactly as it did. `status` and `list` print them.
  See §Scoped concurrency.
- Leases auto-expire (default 30 min) so a dead session's lock can be taken over; refresh by re-claiming.
  Release at phase-finish (`phase-lock.sh <slug> release <N> --owner … --git`). Cooperative, not a hard mutex.
  **An operator can also release it out from under you** — the console's Locks view forces one, and the
  convergence loop releases the lock of a session it can prove is dead (`references/console-surface.md`).
  The lock is yours until phase-finish by convention, not by enforcement.

## Scoped concurrency (working-tree safety)
- **The invariant: never two live sessions whose scopes intersect. Same repo ⇒ serialized; `all` ⇒
  exclusive; disjoint ⇒ parallel.** What makes two sessions unsafe is a shared *working tree* — they
  overwrite each other's files mid-edit and tests fail for unrelated reasons — not the mere fact of being
  two. So the rule is about scope, not about counting sessions.
- **Scope = the plan's Repos column**, normalised by `shared/scope.js` (JS) and `scripts/scope.sh` (bash);
  `phase-graph.sh <slug> --repos <N>` prints it. `all` and an *undeclared* cell touch everything. A path
  token nests segment-wise: `packages` ∩ `packages/cart-api` collide, `api` and `api-gateway` do not.
  Ambiguity always resolves toward colliding — a false conflict costs parallelism, a missed one corrupts a
  tree.
- **A phase whose scope is `all` serialises the entire docs root while it holds its lock.** That is the
  rule working as designed, not a bug, but it is worth knowing before you write the cell: every other
  plan's phases queue behind it — across plans, not just within one — until the lease expires or it
  releases. Under the console's autopilot they queue rather than fail (the holder is named, with its
  lease end, and the wait is woken by lock churn, a lease-expiry timer and the idle poll, capped at two
  hours). Name real repositories where you can; keep `all` for phases that genuinely touch everything.
- **Two sessions on the same repo still need their own checkouts if you insist on overlapping** — a
  separate clone or a `git worktree`, never one shared directory. The scope rule is what tells you when
  you don't need that at all.
  ⚠️ **The console no longer tells a session to make one by hand, and this bullet used to say it did.**
  It prescribed `git worktree add` to a session whose branch a neighbour held — a tree the console's own
  sweeper cannot see (it walks only its own homes, `<root>/.worktrees/runs/<slug>/<runId>` and the older
  `<stateDir>/worktrees/<runId>`), left behind for a person to find.
  What replaced it is two console-managed shapes and one honest refusal: a **lane worktree** or a
  **mirror** the console itself builds, mounts and removes (the boot prompt then says "your cwd IS the
  checkout" and forbids `git worktree add` explicitly); or, with the repository guard off, admission
  simply lets the overlapping run in. When a session genuinely cannot proceed without a branch somebody
  else holds, the instruction now is to work only in scoped files in the checkout it has, or to declare
  `blocked --watch lock:<slug>/<N>` and stop — never to create a tree nothing will clean up. **A hand
  session that genuinely needs a second checkout** (a read-only QA round beside a build) takes one
  through `scripts/phase-lane.sh` — `create` puts it under `<root>/.worktrees/hand/<slug>/p<N>[-qa<r>]`
  on `pe/<slug>-p<N>[-qa<r>]` (or detached), locked; `merge` folds it back; `remove` cleans it up —
  never a sibling folder of the project and never a worktree of the superproject itself. The branch
  name is the SAME one the console gives phase N's lane, on purpose: a phase has one lane branch
  whoever makes its tree, so on a plan that lanes its phases itself (`- **Worktrees:** on`) the
  script refuses a build lane and offers `--detach` or `--qa` beside the console's; the console's
  sweeps report a hand lane once as `run.worktrees-unmanaged` and never touch it.
- **Run isolation is the console-managed version of that escape hatch, and it is a RUN setting, not a
  plan line.** An operator can give a whole work-branch run a checkout of its own, which is what lets two
  runs whose scopes intersect be admitted together (branch qualification, below, is the rule that permits
  it). It changes three things a session must not get wrong and is told about rather than left to infer:
  your **cwd is a linked worktree**, so a cwd-upward git walk answers the worktree and not the run's root
  — `$DOCS_ROOT` is the docs root, always, and must not be overridden; `$PE_BRANCH` is the branch to
  commit on — or `detached@<sha12>` when the run's checkout is detached at the trunk (it then names
  the commit the tree stands at, not a branch to commit to); and `$PE_WORKTREE` is the tree to
  record on the lock. Isolation can be **refused** (a `scope-unmapped` scope, a full
  disk, the worktree cap) and every refusal degrades to the shared checkout with
  ordinary queue semantics — so a session that finds itself in the run's own root is not a bug and
  nothing about the procedure changes. Nothing here is a licence to overlap scopes by hand: two
  hand-driven sessions in one repo still need two checkouts and two branches.
- **Worktree lanes (opt-in) give each concurrent lane its own checkout — and change NOTHING about
  scope.** A plan that writes `- **Worktrees:** on` in §Session budget has Phase Console run each of its
  lanes in a `git worktree` of the run branch, under the run's state directory, merging the lane back
  when it settles. It is a performance and safety measure for the FILES; it is **not** a licence to
  overlap scopes. A linked worktree shares the repository's object database, its refs and — crucially —
  the branch two lanes both commit to, so two lanes are still contending, and `git worktree add` on a
  repo somebody else is mid-rebase in is still a bad afternoon. `phase-lock.sh --worktree <path>` (or
  `$PE_WORKTREE`) records where a session is working, and `status`/`list` and the console's lock model
  carry it — a busy repo with a clean `git status` is a linked worktree, not a stale lock — and the `scope=`
  line stays the REPO. **Per-LANE** worktrees refuse on a superproject: a linked worktree of a repo with
  submodules has EMPTY submodule directories, and a scoped phase would board a session into nothing. But
  the **RUN** takes a MIRROR instead — one linked worktree per scoped sub-repository, decided once in the
  drive preamble — so those phases share the run's mirror, serialized per scope. The phase-14 deferral
  that made the refusal look permanent was reopened and shipped on 2026-08-28: the branch-ambiguity
  objection was answered by the TREE dimension rather than by repo-qualifying branches, so equal branch
  names in unrelated object databases stop mattering (they never carve on their own). Since 2026-09-05
  the mirror also mounts the superproject's own ROOT — a scope meaning the root is its first tree, with
  the initialized submodules under it — so `scope-unmapped` and `has-submodules` are the two that still
  refuse by name; `root-scoped` is no longer produced and is kept only so stored journal lines still
  render. See `references/plan-format.md` §Session budget.
- **Branch AND tree qualification is what actually carves two sessions out of one repo — and both are
  lock FIELDS, never scope tokens.** The rule, stated once per language (`claimsDisjoint` in
  `shared/scope.js`, `claim_disjoint` in `scripts/scope.sh`, one table of cases green in both
  `viewer/test/scope.test.ts` and `tests/unit/lock-scope.bats`): **two claims whose scopes intersect are
  nevertheless disjoint iff BOTH declare a branch AND a working tree and both differ; anything else
  collides.** Different branches means their commits cannot land on top of each other and different trees
  means they are not editing one another's files — so `phase-lock.sh conflicts <N> --scope "<csv>"
  --branch pe/a --worktree /w/a` is clear against a live lock carrying `branch=pe/b` in `/w/b`, and still
  refuses one carrying `branch=pe/a`, one in the same tree (or a tree nested inside it — the test is
  segment-wise), and one unqualified in either dimension. A branch ALONE no longer carves: it said nothing
  about two sessions editing one shared checkout, which is the case that made the pair necessary.
  It is a NARROWING of the scope rule and never a replacement: the scope stays the repo,
  and both questions must pass. Branches do **not** nest segment-wise the way scope paths do (`main` and
  `pe/main` are two branches) and they are case-sensitive (refs are). A field rather than a
  `repo@branch` token because `@` does not survive `normalizeToken` in either language, and bending the
  token grammar would churn the whole engine-parity surface to express something orthogonal to what a
  token means.
- **The CONSOLE applies the same rule, from the same function.** `phase-lock.sh conflicts` is the answer a
  session gets at a terminal; the scheduler's `conflictsFor` is the answer the autopilot gets, and it
  narrows all three of its holder sources — the grants it handed out, the locks on disk, and the tokens an
  aged entry has reserved — by `claimsDisjoint`, so **two isolated runs on one repository are
  admitted at the same time.** An admission's branch is `RunnerBase.branchFor` — the same call that writes
  the lock's `branch=` and the session's `$PE_BRANCH`, because a request claiming one branch while its own
  lock claims another is one session making two claims that disagree. **In practice that is the RUN branch
  `pe/<slug>` or nothing**: admission runs *before* the lane exists, so two lanes of one run present the
  same branch and are not carved apart from each other — lane concurrency still rests on disjoint scopes,
  as it always has. The gap runs the safe way: admission claims strictly less than the lock will, so it can
  over-serialise and never over-admit. The honesty probe `overlapsFor` narrows with it too — the DIY caution
  must never fire between two console-managed trees. **The same slug+phase never carves**, whatever branches
  are involved and whatever the repository guard says: that wall is `sameUnitOfWork`, and it outranks both
  the branch and the guard.
- **Handoff, INDEX and lock commits in the docs repo are NOT part of a phase's scope.** Every session
  writes there, and treating it as scope would serialise the whole system. Git's own `index.lock` plus a
  pull-rebase retry (≤3) is the serialization; the scripts do it, and a session that races a commit or push
  should rebase and retry rather than give up.
- **Never `git stash` to hand work to another session.** A stash lives in one working tree and is invisible
  to any other session or clone — the classic "I stashed it but the other session can't see it" trap.
  Instead **commit** (a WIP commit is fine) and let the next session continue from the commit; squash WIP
  before the phase-finish commit.
- **Commit before you switch, pull before you start.** End a session on a clean, committed tree; the next
  session `git pull`s (and `phase-lock.sh … conflicts` / `… claim`s) before touching anything. The
  filesystem of a closed session is not a channel — git is.

## QA gating (opt-in — verify before dependents start)
- **QA is opt-in, off by default.** No QA subagent runs and no `test-status.md` is created unless the plan
  enables QA: a `**QA gate:** on` line in §Session budget (recorded at plan time when the user asked),
  `new-handoff.sh --qa` at a finish (the user asks now), or a plan that already has `test-status.md`
  (legacy). A plan-recorded **waiver** (`**QA gate:** off`, or legacy "QA gate: WAIVED…" prose) means rows
  are recorded as `waived` and a subagent is **never** dispatched — the finishing session's own
  §Verification run is the quality bar. `phase-graph.sh <slug> --qa-mode` reports the regime
  (`off` · `on <reason>` · `waived <reason>`).
- **When QA is on:** at each phase-finish the skill dispatches a **fresh-context QA subagent** (an `Agent`
  with a clean context — independent of the builder's blind spots; brief via `phase-graph.sh --qa-prompt N`).
  It reviews the real diff per `references/qa-method.md`, runs/extends tests, writes the report file **the
  brief names** (round 1 `reports/phase-NN-qa.md`, later rounds `reports/phase-NN-qa-roundR.md`), and
  records the result via `scripts/qa-record.sh` into `docs/handoffs/<slug>/test-status.md`, which holds
  three sections: `## QA status` (ONE row per phase — the current verdict, the only thing that gates,
  with a `Round` column), `## QA rounds` (the append-only ledger `--qa-history` lists) and `## QA waivers`
  (the `--reason` behind each waiver, keyed by phase and round). The closeout
  dispatches a `qa-full` subagent for the whole plan.
- **When QA is `on`, the engine gates dependents on verification**: a dependent is `ready` only when every
  dependency is `done` **and** QA `pass`/`waived`. A `fail` holds all dependents until a re-QA passes —
  always commit + push the report + test-status.md so the gate propagates to every clone.
- **A `pending` row holds dependents exactly as hard as a `fail`.** It is the row `new-handoff.sh` writes
  when a phase finishes under QA-on, and nothing in the system produces a verdict on its own — so
  finishing a phase means *dispatching the verdict*, not just writing the handoff. The engine's boot
  prompt says so; the autopilot's ladder climbs it (`qa-pending` → resume the phase's session and run the
  subagent, `qa-failed` → fix what the report named and re-record) and asks a person only when that runs
  out. A plan that finishes a phase and walks away is a plan that deadlocks itself.
- **Per phase: `- **QA:** on|off` in the phase's own §Phase section.** The phase's word wins, silence
  inherits the plan — the same resolution as `- **MCP policy:**`, and for the same reason: a regime
  is one answer and the more specific statement wins. It governs both halves (an exempt phase is
  never asked for a verdict, and a verdict recorded against it holds nothing), so it is the right
  tool for a docs phase, a scaffold, or a ship phase whose real check is the deploy — and for the
  reverse, singling out the two phases that touch money on a plan that otherwise does not gate.
  `--qa-mode <N>` reports the resolved regime and which level it came from.
- **`**QA gate:** off` releases the gate for the whole plan.** Gating follows `--qa-mode`, not the mere
  existence of `test-status.md`: under a waiver the recorded verdicts stay in the table and every surface
  still reports them, they simply stop holding dependents. That is the plan-level exit; re-QA is the
  per-phase one. (Before 2026-08-22 no setting at any level could release a recorded `fail` — the only
  way out was editing the table by hand.)
- **Both switches have one writer: `scripts/qa-mode.sh <slug> [--phase N] on|off|inherit`.** It sets
  the plan's `**QA gate:**` line (adding the line, or the section, when there is none) or the phase's
  `- **QA:**` bullet — `inherit` removes the bullet — writing exactly the shape the engine reads, and
  prints `--qa-mode`'s read-back as the proof. The console's QA toggle writes through it; editing the
  plan file by hand remains valid, and the two never disagree about where a switch lives.
- **Closing the plan is the other way out of a `fail`, and it is a different claim.** A QA failure is a
  statement about *progress*, and a closed plan makes none — so `close-plan.sh` retires the report
  without a re-QA, while the row, the failed phase and the search hit all stay exactly as they were
  (reopening restores the gate, still holding). Re-QA is how you *clear* a failure; closure is how you
  stop *caring* about one. Never reach for closure to make a live plan's failure go away.
- On first mid-plan activation, **whatever creates `test-status.md`** — `new-handoff.sh` or
  `qa-record.sh`, and the console's own "turn QA on" reaches the second — backfills already-complete
  phases as `waived` (pre-activation) so gating doesn't retroactively block their dependents. Use `waived` only for a
  genuinely non-applicable check or a recorded plan-level waiver.

## Gates (human vs ai — one approval door)

A gate blocks a phase on something outside the plan's own dependency graph. Every gate is
**categorized** by its `Gate-check` directive (`scripts/phase-graph.sh <slug> --gate-kind N` answers:
`human` · `ai` · `auto` · `none`; the vocabulary lives in `scripts/gates.env`, one source for the
engine and the console):

- **ai** (`Gate-check: ai <check>`) — an AI session may clear it, and the boot prompt makes that the
  session's FIRST task: verify each condition in the Gates bullet for real, do the work to make
  failing ones true, record the clearance, then implement. **Bias gates here** — a person should only
  be interrupted by gates that genuinely need one.
- **human** (`Gate-check: manual <who/what>`, or a `*(GATED)*` heading with no directive at all) — a
  person does the Gates bullet's numbered steps, then approves: the console's phase-page **Gate
  card**, or `scripts/gate-approve.sh <slug> <N> --by "<who>" --note "<what was done>"`. Sessions and
  the autopilot stop at an unapproved human gate — **unless the operator delegates it**
  (Settings ▸ Automation ▸ *Delegate human gates*, **off by default**, per console). Delegation does not
  make the gate the session's judgement to make: the boot prompt requires evidence it can cite for each
  condition, records the clearance as `by: ai-session-delegated`, and STOPS with the condition named
  (`phase-outcome.sh … blocked --reason`) the moment one cannot be verified — a visual sign-off nobody
  has given, a credential it lacks, a preview nobody has looked at. Turn it on for a plan whose gates are
  machine-verifiable in practice; leave it off when a gate means what it says.
- **auto** (`date` / `deadline` / `by` / `phase` / `phases` / `plan` / `cmd`) — the engine evaluates
  it by itself. `cmd` executes only under `PHASE_EXEC_GATES=1` — the autopilot's deliberate opt-in;
  page views and boot prompts never execute a gate command, and report **`unevaluated:`** when they
  decline. That word is its own verdict on purpose: it used to say `manual:`, so one gate told the
  autopilot *proceed* (it had run the command) and the session it boarded *stop and fetch a person* (it
  had not) — at the same instant, about the same phase. `unevaluated` means **nobody is needed**; a
  session willing to run the printed command evaluates the gate itself with the flag.

**The approval record** is `docs/handoffs/<slug>/gate-status.md` (its `## Gate approvals` table),
written only by `gate-approve.sh` — an idempotent upsert, the same shape as QA's `qa-record.sh`. An
approved row clears `--gate-status` for EVERY kind (the operator's override, same philosophy as a QA
waiver); `--revoke` restores the gate. It is deliberately NOT `test-status.md`: that file's very
existence switches QA gating on, and clearing a gate must never flip an unrelated regime. Commit +
push it — a clearance only exists where it can be pulled. The `*(GATED)*` heading marker stays until
the plan's author removes it: an approval opens the door once; the marker says the door exists
(batching still seals around it, and the boot prompt notes the approval and proceeds).

The autopilot enforces the split: an unclear **ai** gate boots the session anyway (clearing it IS the
session's job); an unclear **human/auto** gate holds the phase as `gated` until approved — and the
Gate card's approve can continue the parked run in the same action. Never batch past a gate of any
kind.

## Rulings — the decisions the plan did not make for you

A phase session makes judgement calls the plan could not: an instruction that admitted two readings,
a departure from what the plan said, a sub-case deliberately left for later. Every one of those is a
decision the next session will hit again, and every one of them lands — when it lands at all — in a
paragraph of a handoff that the next session skims, because at the time it felt obvious.

**Record it as it happens:**

```bash
bash scripts/phase-outcome.sh <slug> <N> ruling --kind ambiguity|deviation|deferral   --what "<what you decided>" --why "<why>" [--cost-if-wrong "<what it costs if this was wrong>"]
```

One appended NDJSON line, to `$PE_RULINGS_FILE` (the runner injects it) or, unsupervised, to
`runs/<instance>/<slug>/rulings.ndjson` beside the outcomes inbox. Phase Console ingests it into the
run, journals it as `phase.ruling`, and shows it on the run page, the phase diagnosis and the inbox
as an `fyi` row. The three kinds:

- **`ambiguity`** — the plan admitted two readings and you picked one. The reader needs to know a
  choice was made at all. **The default** when `--kind` is absent: it is the weakest of the three,
  and guessing `deviation` for a session that merely chose would record a disagreement that never
  happened.
- **`deviation`** — the plan said one thing and you did another, with a reason. The reader needs to
  know the plan and the tree now disagree.
- **`deferral`** — something in scope was deliberately left. The reader needs it on a list, not in
  prose.

**A ruling is not an outcome and never becomes one.** The outcome protocol says how a session ENDED
and the runner acts on it; **nothing acts on a ruling** — it does not park a phase, does not climb
the ladder, does not change what runs next, and does not end your turn. That is precisely what makes
it safe to record whenever you are in doubt: it costs one line and it buys a reader. Declaring a
ruling is never a substitute for declaring an outcome; do both.

The ledger is per PLAN and append-only, so a decision made in phase 3 is still there explaining
phase 9 two runs later, and an acknowledgement is a further appended line rather than an edit.
Put the same decisions in the handoff's **Key decisions / gotchas** in words: the ledger is what the
console reads, the handoff is what a person reads.

## Docs layout & repo split
- **Work-state lives in the project repo** under `docs/` (its `.gitignore` tracks only `/docs/`):
  `plans/<slug>.md` and `handoffs/<slug>/{INDEX.md, phase-NN-*.md, reports/phase-NN-qa.md, test-status.md,
  .locks/phase-NN.lock}`. Commit + push so any account/machine can pull and continue.
- **The skill lives in its own install** — a plugin, or a clone under `~/.claude*/skills/`. If you keep
  several clones, edit one and **commit → push → pull** in the others so all stay byte-identical. Never put
  work-state in the skill folder, or skill code in the project repo.

## Multi-repo commit atomicity
- A phase touching several repos makes one commit per repo — there's no cross-repo transaction. Guard
  against half-committed phases: do the commits **last** (after the work is verified), in a fixed repo
  order; if one fails, `git reset` the repos already committed for that phase before retrying, and never
  write the handoff until `git log -1` in each repo confirms the expected sha.
