# Conventions

Contents: Slug · Task list · Commits · Branches · Memory · Status source of truth ·
Phase dependencies (the DAG) · Session sizing & hygiene · Helper scripts · Locking ·
Scoped concurrency · QA gating (opt-in) · Gates (human vs ai) · Rulings · A person's turn · Issues ·
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
  running model's budget (~0.2 × window in phase weight; `references/sizing.md`). **The console runs one
  phase per session; batch only by hand.** Driving the phases yourself, any **ready** phase — sequential on
  the one just finished *or* an independent sibling — that fits the **remaining budget** may be
  **batched** into the same session; it saves a full bootstrap + closeout and keeps the prefix cache warm.
  Open a fresh session (`/clear`) when the budget is spent, at a GATED phase, to switch model, or — with
  QA on — when the next phase depends on a still-unrecorded verdict.
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
- Leases auto-expire (default **2 h**, `phase-lock.sh` `lease=7200`) so a dead session's lock can be
  taken over; refresh by re-claiming. It is two hours because a real phase of a real plan runs for
  forty-five minutes to two, and a lease shorter than the work it protects hands the tree to the next
  caller mid-phase. The console keepalives its own lanes every lease/3.
  Release at phase-finish (`phase-lock.sh <slug> release <N> --owner … --git`). Cooperative, not a hard mutex.
  **An operator can also release it out from under you** — the console's Locks view forces one, and the
  convergence loop releases the lock of a session it can prove is dead (`references/console-surface.md`).
  The lock is yours until phase-finish by convention, not by enforcement.
- **Under an autopilot the lock's git mirror is the console's, not yours** (control-tower phase 63).
  The console holds the grant and the lease already, and a `--git` claim pulled, committed and pushed
  the docs root inside the session's turn — 107 s at the median on the hub monorepo, where 36 of 92
  claims outran the CLI's 120 s Bash timeout and went to the background unread. So the runner exports
  **`PE_LOCK_MIRROR=console`** to every session it spawns and to the boot prompts it asks for: the
  prompt prints its `conflicts` and `claim` lines without `--git`, and `phase-lock.sh` skips a `--git`
  passed anyway (claim, release or conflicts — one line on stderr, never a refusal, because older
  prompts still print it). The console then runs **`phase-lock.sh <slug> mirror <N>`** itself, off the
  turn: after its provisional claim and after every release, it commits where the lock stands now —
  the file, or its deletion — as ONE commit of that path alone, and never pulls and never pushes; the
  next push of the docs root carries it. A mirror that cannot land says `UNMIRRORED` and leaves the lock
  on disk, where every reader on the machine looks anyway. **A person driving by hand keeps `--git`.**
- **The docs root is declared scope** (control-tower phase 63, #88). Every phase writes its handoff,
  INDEX, locks and ledgers under `docs/handoffs/<slug>/` whatever its Repos cell says, so the boot prompt
  names that **per-slug token** beside the scope (`scope_root_token` / `rootScopeToken`; a phase scoped
  `all` already covers it). It is declared, **never admitted on**: a plan's own lanes all write it, and
  carving on it would serialise every phase of the plan. What orders those writes instead is the docs
  root's **critical section** — a directory at `<git-dir>/pe-root-section`, taken with `mkdir` around
  every commit and every rebase `phase-lock.sh` makes there and released before any push
  (`PE_ROOT_SECTION_WAIT`, default 30 s, bounds the wait; a section whose writer's pid is gone — or,
  should the pid have been reused, one older than `PE_ROOT_SECTION_STALE`, default 900 s — was left by a
  writer that died and is broken, and a writer removes only a section it still owns). Every lock commit names its own path
  (`git commit --only -- <path>`), so a file another session staged in the shared index never rides
  along under a `phase-lock:` subject — commit your own handoff the same way, by path.
- **A scope-drift line means the phase itself left its scope.** The console compares each repository
  outside a phase's scope before and after it, and since phase 63 it credits a new commit only when it
  is on the lane's branch or the lane's own session printed it (`[branch sha] subject`), and never when
  it is a `phase-lock:` commit, another plan's (`docs/handoffs/<other>/`, `docs/plans/<other>.md`), or a
  write inside the declared scope — the Repos tokens, the per-slug token and the plan's own documents
  (`docs/plans/<slug>.md` and its `<slug>-…` companions). The line lists what it credited and counts
  what it left out. Detection, not containment.
- **The console's provisional claim names the lane's branch** (control-tower phase 82, #116). At grant
  the runner claims the phase for a short lease with the PAIR only — the tree as `--worktree`, the
  branch as `--branch` — so the lock's `branch=` line is the run branch (`pe/<slug>`) until the session
  re-claims. It used to pass the repository key, a path, as a second `--branch`, which won: for that
  window a same-branch sibling in another tree read as disjoint.
- **A terminal session holds what it TOUCHED, never where it was opened** (control-tower phase 82,
  #119). A hand session with no `PE_SCOPE` is read from its own transcript: the paths its
  Edit/Write/MultiEdit/NotebookEdit calls named, the repositories it changed (a changing
  `git -C <dir> …`), and the plans its `phase-lock.sh` / `phase-graph.sh` calls named — a plan of
  another docs root (its `DOCS_ROOT=`) is evidence it works elsewhere, a lock call's `--scope` is its
  own word. What it touched here it holds until the claim window (`PEER_CLAIM_WINDOW_MS`, 10 min) after
  its LAST touch; a session whose every touch is elsewhere holds nothing; one that has touched nothing
  holds what its cwd could reach only for the unknown lease — the same 10 min from its newest start —
  and nothing after. The queue and the run card name the terminal (id, pid, scope, how it was read)
  and offer **Release** (`POST /api/sessions/<id>/release {hours?}`, `--allow-run`), and the session's
  own presence hook prints one notice when it starts blocking a run. Claim a lock when you do work a
  phase: a lock is the one statement nothing has to infer.

## Scoped concurrency (working-tree safety)
- **The invariant: never two live sessions whose scopes intersect. Same repo ⇒ serialized; `all` ⇒
  exclusive against every unqualified claim; disjoint ⇒ parallel.** What makes two sessions unsafe is a
  shared *working tree* — they overwrite each other's files mid-edit and tests fail for unrelated
  reasons — not the mere fact of being two. So the rule is about scope, not about counting sessions.
- **`all` is exclusive against every *unqualified* claim — not against the world.** The older wording
  ("`all` ⇒ exclusive", full stop) described a rule the code has never had: `all` is carved like any
  other scope once **both** claims are qualified. Two claims that each declare a branch AND a working
  tree, and differ in both, are physically disjoint — different files on disk — and may run at the same
  time even when one of them says `all`. What `all` cannot be carved against is a claim that declares
  neither, because such a claim has said nothing about where it is working. Unqualified in *either*
  dimension collides with everything (`claimsDisjoint` in `shared/scope.js`, `claim_disjoint` in
  `scripts/scope.sh`).
- **A lock with no `scope=` line reads as `all`, in both languages.** It is an *unknown* scope, so it
  collides with everything — and the scheduler and bash now agree on that. They did not always: the
  scheduler once read a scopeless lock as the plan's Repos cell while bash read it as `all`, so one
  side admitted work the other had refused. Never infer a lock's scope from its plan; a lock that did
  not say is a lock that owns the tree.
- **A hand lane under a superproject is swept like any other.** `phase-lane.sh remove` takes the tree,
  the merged branch and the lock away whether or not the repository has submodules; there is no class
  of lane the sweep skips and leaves for a person to find.
- **Scope = the plan's Repos column**, normalised by `shared/scope.js` (JS) and `scripts/scope.sh` (bash);
  `phase-graph.sh <slug> --repos <N>` prints it. `all` and an *undeclared* cell touch everything. A path
  token nests segment-wise: `packages` ∩ `packages/cart-api` collide, `api` and `api-gateway` do not.
  Ambiguity always resolves toward colliding — a false conflict costs parallelism, a missed one corrupts a
  tree. **The superproject's own name is not a free token** (control-tower phase 90, #154): it mounts
  the whole root, every submodule under it, into an isolated run, and holds the phase against any run
  that has the root repository on its branch. A phase that writes only in submodules — a closeout, a
  docs pass — lists the submodules and leaves the root out (`references/plan-format.md` §Phase graph;
  lint **F34**).
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
  `blocked --needs lock --watch lock:<holder-slug>/<holder-phase>` and stop — never to create a tree
  nothing will clean up. **A watch is for somebody ELSE's lock** (#42): the lock that names the
  declaring phase is the one its own session holds and its own closeout releases, so a watch on it
  could only ever fire on the phase's own teardown. `phase-outcome.sh` refuses it (exit 2), the console
  refuses it again at ingest from an older script, and a block whose only lock was its own parks for a
  person. A block on a person (`--needs ambiguity`) takes no watch and no wait clock at all: nothing a
  clock can see settles it, and its `phase.outcome` line says what it dropped. **A hand
  session that genuinely needs a second checkout** (a read-only QA round beside a build) takes one
  through `scripts/phase-lane.sh` — `create` puts it under `<root>/.worktrees/hand/<slug>/p<N>[-qa<r>]`
  on `pe/<slug>-p<N>[-qa<r>]` (or detached), locked; `merge` folds it back; `remove` cleans it up —
  never a sibling folder of the project and never a worktree of the superproject itself. The branch
  name is the SAME one the console gives phase N's lane, on purpose: a phase has one lane branch
  whoever makes its tree, so on a plan that lanes its phases itself (`- **Worktrees:** on`) the
  script refuses a build lane and offers `--detach` or `--qa` beside the console's; the console's
  sweeps report a hand lane once as `run.worktrees-unmanaged` and never touch it.
  **Under a console run** (control-tower phase 90, #154) a session the console spawned takes at most a
  review tree (`--detach`) or a QA round's (`--qa`) — never a build lane, never a `merge`, never a
  `pe/<slug>` checkout or `git switch -c` (`phase-lane.sh` refuses the first two when `PE_OWNER` is
  the console's): the console owns the run's trees and branches. A hand tree of the plan standing on the run branch takes the branch the
  run's own checkout needs — measured, a resumed session whose mirror had been pruned made one, and the
  rebuild was refused `branch-in-use` until a person detached it. The console now detaches such a tree
  in place at the run's next boundary (`run.isolation-reclaimed {detached: true}`; files and commits
  untouched; another plan's tree is never moved), but the phases in between ran without isolation.
- **Never clone, and never `git submodule update --init`, inside a run's checkout** (control-tower
  phase 90, #139 #154). A repository the phase's scope does not name is not mounted in the run's
  mirror — its directory there is EMPTY, which is what an unmounted submodule looks like — so read it
  at the shared root, read-only; the boot prompt names that path. A clone or an init fills the
  directory the console mounts into: the next rebuild met `already exists`, and a run lost its
  isolation for eleven hours. The console denies `git clone` and `gh repo clone` into a run tree
  (`run-tree-clone`, naming the root checkout to read instead), asks before `git submodule` inside one
  (and allows it at the run root, where a refusal's own `git submodule update --init` advice runs), and
  moves foreign content it finds at a mount to `<run>/stale-mounts/<ts>/<mount>` — by itself when it
  is clean and pushed, after a person's **Repair checkout** when it is dirty or unpushed, and never
  deletes either. A person's commands for a parked phase belong in an **errand tree** —
  `POST /api/run/<slug>/errand-tree {phase}` makes `<root>/.worktrees/hand/<slug>/p<N>-errand`,
  detached at the PUSHED run branch in every repository the run mounts, locked, and never pruned by
  the console — not in the run's own mirror, which the console prunes on its own schedule. The errand
  card names the tree once it exists, and `validate.sh` warns on a handoff `!` line that points into a
  run tree. A session never DETACHES its run's own checkout either (`git switch --detach`, `git checkout
  <commit>` — denied as `run-tree-detach`): the console refuses the next boarding over a detached mount.
  A release that squash-merged the run branch needs no detach — once the trunk holds every change of the
  branch (a `git merge-tree` proof), the console re-seats `pe/<slug>` on `origin/<trunk>` itself, before
  its own verification and at every boundary. A run finishes only when every repository's run branch is
  on `origin/<trunk>` by that same proof; otherwise it parks `unlanded`, and its card opens a merge errand
  tree.
- **A scoped run finishes when its phases do** (`onlyPhases`, the console's "Run only this";
  control-tower phase 90, #154). The run boards only the phases it was asked for and FINISHES when
  those settle — `run.finished {onlyPhases}`, with a `finishedReason` naming the scope — whatever else
  the plan has ready. It is never the plan's final run, so it opens no pull request, and its last
  phase is not settled as a final one. That is why an unattended watchdog never scopes a run to move
  one stuck phase: the run drives that phase and then stops driving the plan. The tools for one phase
  are `resume-phase` (Retry) on the unscoped run, and `isolate-phase` for a phase held behind another
  run's branch; a scoped run is for a person who wants exactly that.
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
- **The lock is per PHASE; the branch is per RUN.** A new-branch run in the SHARED checkout leaves each
  repository its sessions checked out on `pe/<slug>` there between its phases, when it holds no lock —
  so the run HOLDS that repository until the run settles (a record under `<state>/trees/`, written after
  the phase and removed at the settle, which returns the tree to the branch it was found on when that is
  safe). `conflicts` reads those holds beside the locks: a repository of your scope standing on the
  branch another open run holds is a `CONFLICT … run <id> — holds <repo> on <branch>` line, and the
  console's scheduler queues its own phases on the same rule. Against a hold the claim rule flips once
  (`claimsDisjoint` with `hold: true`, `claim_disjoint_hold`): the branch the tree already stands on is
  no collision, and a different branch on the same ground always is. A checkout of your own
  (`phase-lane.sh`, a mirror, an isolated run) is never held. Waiting on it: the holder's run settles,
  or the tree leaves its branch.
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
- **human** (`Gate-check: manual <who/what>`; a `*(GATED)*` heading with no directive at all reads as
  **ai** since 5.0.0 — `scripts/gates.env` `GATE_DEFAULT` — and fails `validate.sh`, F24) — a
  person does the Gates bullet's numbered steps, then approves: the console's phase-page **Gate
  card**, or `scripts/gate-approve.sh <slug> <N> --by "<who>" --note "<what was done>"` in a person's
  own terminal. Sessions and the autopilot stop at an unapproved human gate, and **a gate the plan
  marks `manual` is a person's whatever the `gates` decision says** (control-tower phase 107, #174 —
  an unattended session read a plan's "all permissions" as delegating one, recorded its own
  `ai-session-delegated` approval and changed production data). Three things hold it:
  - **never delegated** — the runner asks the engine for the gate's kind (`--gate-kind`: `human` for
    `manual` and for a type it does not know) and never boards a session on one; the boot prompt tells
    a session to STOP and declare `phase-outcome.sh … needs-human --needs gates`;
  - **refused at the door** — `gate-approve.sh` names its DOOR from its own environment, never from
    `--by`: `session` (`PE_OWNER=autopilot/*|console/*`, `PE_OUTCOME_FILE`, `PE_SESSION_KIND`,
    `CLAUDECODE=1`), `console` (the console's own write for a person's press: the Gate card from a
    browser, a phone's signed Approve, a supervisor-chat act a person confirmed), `terminal` (stdin is a
    tty, no session marker) or `script` (anything else). A manual gate is approved only through
    `console` or `terminal`, and never by an `ai-*`, `autopilot*` or `console/*` approver; a revoke is
    taken from any door;
  - **ignored when read** — the door is recorded in `gate-status.md`'s `Door` column, and
    `--gate-status` honours a manual row only when a person's door wrote it, so a door-less legacy row
    or a hand-written one opens nothing.
  The `gates` decision still answers the rest of the human family — an overdue `deadline`/`by` gate,
  which the engine reports as `OVERDUE`: the plan's `## Decisions` row first, then this console's
  `policy.gates` answer (Settings ▸ Automation ▸ *Let a session clear an overdue gate* folds into it, **on by
  default**), then the shipped `delegated`. Delegation does not make the gate the session's judgement
  to make: the boot prompt requires evidence it can cite for each condition and STOPS with the
  condition named (`phase-outcome.sh … blocked --needs gates --reason`) the moment one cannot be
  verified. A delegated gate whose verdict states **no condition** a session could evidence is not
  boarded: it stays `gated` for a person.
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
bash scripts/phase-outcome.sh <slug> <N> ruling --kind ambiguity|deviation|deferral   --what "<what you decided>" --why "<why>" [--cost-if-wrong "<what it costs if this was wrong>"]   [--for <M|next|all>] [--needs <decision key>] [--remember plan|global] [--by WHO]
```

One appended NDJSON line, to `$PE_RULINGS_FILE` (the runner injects it) or, unsupervised, to
`runs/<instance>/<slug>/rulings.ndjson` beside the outcomes inbox — stamped with its id (the digest
the console derives, so an ack, the inbox and `decisions.sh promote` all name one ruling by one id).
Phase Console ingests it into the run, journals it as `phase.ruling`, and shows it on the run page,
the phase diagnosis and the inbox as an `fyi` row. **Name the decision key it answers** (`--needs
<key>`, one of the manifest's — never a blocker short form, a ruling is not a blocker) whenever there
is one: a keyed ruling is a row of its own in the inbox with **Remember for this plan** and, when its
words are an answer the console can hold for the key, **Remember on this console**. The three kinds:

- **`ambiguity`** — the plan admitted two readings and you picked one. The reader needs to know a
  choice was made at all. **The default** when `--kind` is absent: it is the weakest of the three,
  and guessing `deviation` for a session that merely chose would record a disagreement that never
  happened.
- **`deviation`** — the plan said one thing and you did another, with a reason. The reader needs to
  know the plan and the tree now disagree.
- **`deferral`** — something in scope was deliberately left. The reader needs it on a list, not in
  prose. **It is the one kind with an addressee**: `--for <M|next|all>` says which phase you left it
  to (a number, every phase that depends on yours, or all of them), defaulting to `next` — and that
  is what puts it in `phase-graph.sh <slug> --notes M`, and so into M's boot prompt, whether or not
  anybody remembers to copy it into a handoff. `--for` is refused on the other two kinds, because an
  ambiguity and a deviation are a session explaining ITSELF and a note nobody is addressed by is a
  note nobody reads.

**Where a forward-looking ruling ends up, and why there are two places.** A `deferral --for M` and a
handoff's `- **Phase M:** …` bullet are collected by the same reader and arrive in the same block of
M's boot prompt, so neither is a substitute for the other and both are worth writing: **the ledger
is what the console reads and the handoff is what a person reads**, and a phase that is never
boarded again still has a reader. Write the ruling when you make the call — that is the moment you
know why — and the bullet at phase-finish, when you know how it turned out.
`references/handoff-format.md` §6 has the bullet grammar and the bound.

**A ruling is not an outcome and never becomes one.** The outcome protocol says how a session ENDED
and the runner acts on it; **nothing acts on a ruling** — it does not park a phase, does not climb
the ladder, does not change what runs next, and does not end your turn. That is precisely what makes
it safe to record whenever you are in doubt: it costs one line and it buys a reader. Declaring a
ruling is never a substitute for declaring an outcome; do both.

The ledger is per PLAN and append-only, so a decision made in phase 3 is still there explaining
phase 9 two runs later, and an acknowledgement is a further appended line rather than an edit.
Put the same decisions in the handoff's **Key decisions / gotchas** in words: the ledger is what the
console reads, the handoff is what a person reads.

**A ruling can be remembered, at once or later.** `--remember plan` writes it as a `## Decisions` row
of the plan's twin the moment it is recorded (`decisions.sh promote`: value `--what`, source `ruling`,
evidence the id) and acks it in the ledger with `--by` (default `$PE_OWNER`, else user@host); the
inbox's action does the same for a person. `--remember global` asks the console that owns the
repository to hold the words as its own `policy.<key>` answer — the same door the inbox's second
action uses, `POST /api/run/<slug>/rulings/<id>/remember` — so `--what` must be an answer word for the
key (the console names the words when it is not), and with no console answering the script exits 1
naming Settings ▸ Automation ▸ Policy answers rather than dropping the request. Either way the ruling
itself was recorded first: the request failing is not the ruling failing.

**A question the console answered is a ruling too.** When a run's relay (`relay: last-resort`) answers
an `AskUserQuestion` a session raised (`references/console-surface.md` §Questions), the console appends
the line itself: kind `ambiguity`, `decisionKey: ambiguity`, `by` either `relay` or the person who
answered inside the window, and a `relay` object — `{tool, key, answer, answeredBy, ruleId?}`, where
`answeredBy` is `human`, `rule`, `recommended` or `first-option` (`QUESTION_ANSWERED_BY`) and `ruleId`
names the relay rule that chose it. It reads like any other ruling, and the inbox offers one more action
for it, **Remember as a relay rule** (the same remember route with `scope: 'rule'`): "this question,
this answer" is a relay rule, never a `## Decisions` row.

**The decisions the plan DID make live in its `## Decisions` manifest** (`references/plan-format.md`
§Decisions): one row per key of a closed vocabulary — `credentials`, `accounts`, `gates`, `waits`,
`human-acts`, `ambiguity`, … (`scripts/decisions.env`). Every ruling, errand and `needs-human`
reason names the row it belongs to as its **`decisionKey`**, and the two ledgers meet in two places:
a ruling can be promoted to a standing answer (`scripts/decisions.sh <slug> promote --from-ruling
<id> [--key <key>]` writes it to the twin with `source: ruling`; a ruling that carries its own
`decisionKey` needs no `--key`), and a block is declared **by key** —
`phase-outcome.sh <slug> <N> blocked|needs-human --needs <key>`, required there (exit 2 without),
where `<key>` is a decision key or a blocker class as its short form (`credential`, `permission`,
`gate`, `external`, `lock`). The runner reads the key BEFORE the prose, so what a session needs is
its own word rather than a regex's guess over its sentences; a key the manifest lacks is a defect
report, not a routine ask. Never ask in prose: prose reaches nobody.

## A person's turn — human steps (control-tower phase 41)

When the work needs an act only a person can do — a sign-in that opens a browser and waits, a device
code, a token to paste, a password at the machine, an approval on somebody else's dashboard — that is
not a failure, not a stall and not a free-text errand. It is a **human step**: a typed record with a
workflow. The console informs (ONE `human-step` inbox row, ONE `needs-you` push naming *Open* and
*I did it*, and a device code when the kind has one), waits (the phase parks on a PERSON — an
unbudgeted wait of kind `person`, situation `blocked-declared:human-acts`, no ladder rung ever spent
on it), and — from phase 43 — lets the person open it again, proves it, and resumes the same session.

A session declares one with `phase-outcome.sh <slug> <N> needs-human --needs <key> --step <kind>
--title "<what>" [--open-url <http(s) link> | --open-command "<cmd>"] [--where host|any]
[--proof <ref>] [--step-line "<step>"]… [--code <device code>] [--credential <id>] [--due-when <ref>]`,
hands off `in-progress`, and stops. The seventeen kinds are `scripts/human-steps.env`'s; `--act` is
`--step operator-act`, the operator's own act — a command or a click path — and `--due-when <ref>`
keeps any step `upcoming` (shown under *Coming up*, announced once, when the ref lands) until it is
due (control-tower phase 121). Three rules:

- **Never run the sign-in yourself.** In a `-p` session it hangs on a browser or a prompt nobody sees.
- **Never put a secret in a flag.** A value shaped like a token, a password, a one-time code or a URL
  query secret is refused (exit 2, nothing written, the value never echoed); the person types it where
  the step opens. A `secret-entry` step names only the registry id its secret is stored under.
- **A session's step never opens by itself.** Only a plan's bullet may carry `auto-open: host`.

What the console keeps is the ledger `<instance state>/human-steps.ndjson` — append-only, one line per
move, last state wins, a torn last line dropped, rotated past 4 MB with the rotated copy still read —
in eight states: `declared` → `notified` → `opened` → `checking` → `proven`, or `expired`, `cannot`,
`dismissed`. No code, token, password or URL query secret reaches it, a journal line, a push payload,
the log or a transcript: each of the five is redacted.

**The console notices one, too (phase 44).** Run `gh auth login` (or any `SIGN_IN_SHAPES` member)
anyway and the hook refuses it before it runs, with the declaration to make instead — kind, title,
command and proof filled in; declare it and stop. A plan's `- **Human step:**` bullets are asked for
at the launch door, their proofs run first, so a step already true never reaches the phase. A lane
that falls silent after printing a sign-in link is offered to a person as a suspected step; nothing
converts it by itself.

## Issues — the label lifecycle (control-tower phase 90, #154)

An issue a plan owns moves through three states, and each is written where every console and every
person can read it:

1. **`awaiting-plan`** — filed, and no plan owns it yet.
2. **`plan:<slug>`** — an amendment planned it: the relabel, plus one comment naming the fixing phase.
   A deferral relabels it `plan:<slug>-deferred`.
3. **Closed** — by the fixing phase at its finish, or by the plan's landing phase.

The fixing phase commits with **`Refs #N`**, never a closing keyword: its commit lands on the run
branch, and a keyword would close the issue the day the branch merges, whoever reads it. Whether a
phase may close its issue **before the fix is on `main`** is the plan's decision, in its
`permission.destructive` and `issues` rows. Where it may, the close comment says so in words —
"fixed on `<branch>`, not yet live" — with the sha and the test that proves it: every running console
still shows the defect until the fix lands and the console updates, and an issue closed without that
sentence reads as a claim that the bug is gone. Where it may not, the landing phase closes it once the
fix is on `main`.

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
