---
name: phased-execution
description: "Plan and run large multi-phase software work as a sequence of right-sized Claude sessions to control token cost and protect output quality. Use when creating a phased plan for big work, starting or continuing a phase of an existing plan in a fresh session, finishing a phase and handing off, batching or splitting phases to a session budget, resuming a plan mid-DAG, QA-verifying a phase on request, or checking/clearing/approving a phase gate — and whenever the user mentions phased execution, a phase handoff, a plan under docs/plans/, a session budget, a gated phase, or booting the next phase."
argument-hint: "[plan|start|finish] [slug]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
metadata:
  version: 6.2.1
---

# Phased Execution

Run large work as a sequence of **right-sized sessions** — **the console runs one phase per session;
batch only by hand** (a person driving the phases may let adjacent ones **share** a session), and a phase
too big for one session is **split**, sized to the model you're running. The point is twofold: **bound
cost** and **protect output quality**. A session only delivers if it can be **fully bootstrapped from
disk** — that's what lets the next one start cold. This skill defines how.

**Sizing is the core idea — `references/sizing.md` is the source of truth; read it.** A warm session's
cost is roughly *linear* (Claude Code caches the prefix), so the levers that actually matter are **context
rot**, **cache-busting events** (model/effort switch, `/compact`, a >5-min idle gap), and **bootstrap
overhead** — not raw turn count. The rule:

> **One coherent, right-sized chunk of work per session** — big enough to amortize bootstrap and keep
> the cache warm, small enough to stay clear of context rot and the harness auto-compaction threshold.

Right size depends on the running model's window, so the plan records a **session budget** (~0.2 × the
window in phase weight — ~200K for 1M-class models). What a session actually holds is **measured**, never a
multiple of that weight: a floor every session pays before its work counts, plus a slope × the phase's
weight (`references/sizing.md`). The engine forecasts a plan in sessions from it and — for a person
driving by hand — proposes which phases may share one. A session boundary is a *cost*, not a virtue:
it's earned by a spent budget, an external gate, or a model switch — never by tidiness.

## Three artifacts + two optional — each has ONE job (never duplicate)

- **Plan** → `docs/plans/<slug>.md` — the durable blueprint: every phase, the dependency graph, the
  session budget, per-phase self-contained detail, end-to-end verification. The roadmap source of truth.
- **Handoff** → `docs/handoffs/<slug>/phase-NN-<title>.md` (+ `INDEX.md`) — the per-phase *baton* for the
  NEXT session: state now, files changed, decisions, exact next commands, skills used. Links back to plan +
  memory. Written at the END of each phase.
- **Memory** → `project_<slug>` in the memory index (the replacement for the removed `remember` plugin) —
  durable cross-session facts: cumulative phase status, commits, deploy/commit gates, gotchas.
- **QA status (OPTIONAL — only when QA is enabled)** → `docs/handoffs/<slug>/test-status.md` (+ reports
  under `docs/handoffs/<slug>/reports/`) — per-phase QA results. **QA is opt-in and off by default**: the
  artifact exists only when the user asked for QA (plan directive `**QA gate:** on`, `new-handoff.sh --qa`,
  or a legacy plan that already has the file). Its existence turns on **QA gating**: a dependent phase is
  `ready` only once every dependency is *verified* (handoff `complete` **and** QA result `pass`/`waived`),
  so a broken phase can't silently propagate. `scripts/phase-graph.sh <slug> --qa-mode` says which regime
  a plan is in (`off` · `on <reason>` · `waived <reason>`).
- **Gate approvals (OPTIONAL — only once a gate is cleared/approved)** → `docs/handoffs/<slug>/gate-status.md`
  — per-phase gate clearances written by `scripts/gate-approve.sh` (the console's Gate card, an AI session
  that verified an `ai` gate, or a hand run). `--gate-status` honours an approved row for **every** gate
  kind. Deliberately a separate file from `test-status.md`: recording an approval must never flip QA
  gating on.

All artifacts live in the **project repo** under `docs/` (versioned + pushed, so any account/machine
can pull and continue); the skill itself lives wherever it was installed. The plan holds the
roadmap; handoffs **link** to it and never re-list all phases. The handoff holds
operational next-session state. Memory holds durable facts. Full schemas/templates:
`references/plan-format.md`, `references/handoff-format.md`, `references/conventions.md`,
`references/sizing.md`, and for a person's turn `references/turn.md`.

## Phases are a DAG, not a line

A plan is a **dependency graph**: each phase declares the phases that must finish before it can start.
That makes two things possible that a linear "phase N → N+1" model can't express:

- **Fan-out, run by scope** — when one phase completes it may unblock *several* phases at once. What
  decides whether they may run **at the same time** is their **scope**: the repos they touch, taken from
  the plan's **Repos** column. The invariant: *never two live sessions whose scopes intersect; same repo
  ⇒ serialized; `all` ⇒ exclusive against every unqualified claim; disjoint ⇒ parallel* (`references/conventions.md` §Scoped concurrency).
  Ask before you start — `phase-lock.sh <slug> conflicts <N> --scope "<csv>"` — and **stop and ask the
  user** on a reported hit. Driving by hand, ready phases may also **share one session** while the budget
  lasts (execution inside a session is serial, so even same-scope siblings are safe that way); the console
  never batches.
- **Out-of-order progress** — you can complete a deep chain (e.g. 1→4→5) before its siblings (2, 3). The
  system must still know 2 and 3 aren't done. "Finished" means **every** phase is `done`, never "reached
  the highest number".

The engine that makes this real is **`scripts/phase-graph.sh <slug>`**. It reads dependencies from the
plan's `## Phase graph` table and the **live** per-phase status from each handoff's frontmatter, then
classifies every phase into one of five **board buckets** — `done | in-progress | stuck | ready | waiting`
— where **ready = not started and every dependency done**, and **`stuck` is a handoff that says
`blocked`**: the engine folds that word before the board ever sees it, which is why the bucket list and
the handoff-status list are two different vocabularies and why Mode 2 treats `stuck` as a resume rather
than a failure. Readiness is computed from the done-*set*, so it is always correct under serial and
out-of-order execution. Never hand-maintain a "current phase" cursor; ask the engine. Run it any time to
see the board (and the suggested batches); the other scripts call it to pick next phases and fill handoff
frontmatter.

## Running under Phase Console (when a supervisor boards you)

A phase may be run by a person, or spawned by **Phase Console**'s runner (`--allow-run`) as an
unattended `claude -p` session. The procedure below is identical either way — but a supervised session
runs inside machinery it should not mistake for a malfunction. The short version; the full account is
**`references/console-surface.md`**.

- **You are supervised if `$PE_OUTCOME_FILE` is set.** With it, `phase-outcome.sh`, `phase-tasks.sh` and
  the ruling ledger write where the runner reads. Without it they fall back to the console's inbox, so a
  hand-driven session's declaration still reaches a running console. `$PE_OWNER` / `$PE_SESSION_ID` are
  your lock identity — never override `--owner`, or the supervisor cannot release your lock.
- **The Stop hook can refuse your exit, twice.** Ending a turn with the phase not `done` on the board and
  no declared outcome is blocked, with the instruction handed back: finish the closeout, or declare the
  wait. So is an EXIT — a `partial` or `complete` declared, or the board already done — while a
  background subagent or monitor you launched still runs: wait for it in one bounded foreground call
  (`TaskOutput`, `block: true`, at most ten minutes), or stop it with `TaskStop` and name under
  **Outstanding** what it was doing, because the CLI stops it ten minutes after your turn ends, mid-edit.
  It fails open on any uncertainty and never blocks a third time. A turn that "will not end" is this
  contract, not a bug.
- **A denied tool is a decision, not a failure.** The run's permission profile (`guarded` · `trusted` ·
  `bypass`) moves only what a person is *asked* about; the `deny` wall is identical in all three and holds
  with the console dead. Do the work that does not need the denied tool and record the rest as an operator
  errand under **Outstanding** — never route around the wall, and never press the console to lower it:
  the hook denies a supervised session's call to any authority route or verb of any console on the
  machine, however it is carried (`console-forge`). If the phase cannot proceed without the tool,
  declare the wall you met — `phase-outcome.sh <slug> <N> blocked --needs permission --rule "<rule>"
  --command "<command>"` — and stop. When the console recorded that wall for your lane it raises ONE
  permission item on Your turn (else exit 4: nothing refused this — run it), and a person answers it with
  a grant at a scope — this call, this phase, this plan, this repository, always — a denial, or *I'll do
  it myself*; you are resumed with the answer. The never list (a forced push, `sudo`, a protected path, a
  secret's value, …) has no grant: say what remains instead. `references/turn.md` §A permission
  block. (Identical *across profiles* — not
  immutable: an operator can strike a built-in rule out of the wall, per plan or globally, and that
  strike then applies to every profile at once.)
- **Never wait on somebody else's clock inside a turn — and never poll.** A supervised session's `Bash`
  call that waits on a clock outside the session — `gh run watch`, `sleep 600`, `until gh run view …;
  do sleep …; done`, `kubectl rollout status` — is **denied before it runs**, on every profile, with this
  procedure as the reason. It is not a `deny`-list rule and it cannot be configured away: the turn
  produces nothing and the phase's exclusive lock stays held for the whole wait. A wait on a job you
  started yourself is allowed.

  **Waiting without polling.** Every tool call re-reads your whole context, so a status check costs as
  much as an edit. Never make two status checks in a row (`ListAgents`, `TaskOutput`, `date`,
  `tail`/`grep`/`cat` of a log, `pgrep`, `gh run view`), and never check on a subagent you dispatched.
  1. **Work remains** → keep working; a background result arrives by itself as a `<task-notification>`.
  2. **You need a subagent's answer** (a reviewer's verdict) → dispatch the `Agent` in the FOREGROUND;
     the call returns with the answer and costs nothing while it runs.
  3. **You need your own shell job and nothing else is left** → wait in ONE foreground call bounded by
     the Bash timeout: `until <probe>; do sleep 10; done` with `timeout: 600000`, at most once per ten
     minutes. The console allows a wait on your own job; it refuses one on somebody else's clock.
  4. **Only subagents or monitors running in the background are left** → end your turn; the session
     stays alive and their notification wakes you. They are stopped ten minutes after your turn ends —
     dispatch a subagent that may take longer in the FOREGROUND. A background SHELL dies when your turn
     ends — never end it with one you still need.
  5. **Somebody else's clock** (CI, a deploy, a person) → commit, hand off `in-progress`,
     `phase-outcome.sh <slug> <N> waiting-external --wait-minutes <M> --watch <ref>`, stop. **Name the
     ref**: a wait declared without one right after the console refused your in-turn wait takes a ref
     minted from the refused command, else the plan's `- **Waits on:**` refs, else it is refused and the
     phase parks for a person (`phase.watch-missing`). A sibling phase's finish is
     `--watch phase:<slug>/<N>`, never a `cmd:` grep of its handoff; your own red lines going green
     again is `--watch verify:<slug>/<N>`; a job on another machine is `--watch unit:<host>/<unit>`,
     and a `date:` beside a live ref is only its backstop — the schemes are listed under
     `phase-outcome.sh` below.

  **A wait on your own job runs on the console's clock too.** One still open after 10 minutes draws
  one nudge, and one still open at 45 minutes parks the phase in the console's own name
  (`stallLocalJobMs`; it never spends your waits) — so never start a long suite in the background and
  wait on it in-turn. Record the proofs you already have, leave the long lines to §Verification (the
  console runs those itself), and when a wait is unavoidable declare `waiting-external` with a
  `--watch` ref BEFORE 45 minutes, not after. A short `sleep` is fine.
  **§Verification runs on a clock too:** when the console verifies a phase it cuts each command at 30
  minutes, unless the plan names a longer limit or the line's own measured history earns one — so a line
  that needs longer, a device sweep or a suite slow under load, says so on its phase:
  `- **Verify timeout:** 90m` (or `**Verify timeout:**` in §Session budget, for every phase; see
  `--verify-timeout` below).
- **A question is held, never a permission.** `AskUserQuestion` is answered by the console. With the
  run's relay armed (`relay: last-resort`, CLI 2.1.268+, your phase's own session) a person gets 60 s,
  then a relay rule, the sole `(Recommended)` option or the first answers — you are told which, and if
  it is wrong you declare `blocked --needs ambiguity` rather than asking again; a question it will not
  answer by rule (multi-select, a destructive option, a repeat, …) comes back unanswerable — hand off
  `in-progress`, declare `needs-human --needs ambiguity`, stop. With no relay the plan's `ambiguity` row
  answers: `ruling` — decide from the plan, record `ruling --kind ambiguity`, carry on; `ask`/`halt` —
  `needs-human --needs ambiguity`, stop. **The floor:** every session the relay is not armed for is
  spawned with `--permission-prompts none` (CLI 2.1.259+) — nothing can ask a person, the
  tool is not even offered, and a call that would prompt is denied: do not retry it.
- **An operator can change the run under you** — model, effort, budgets, skills, MCP servers, even
  `reviewEachPhase`, which inserts a fresh reviewer over your diff at phase-finish whose
  `requested-changes` holds your dependents exactly as a person's would. If the board does not move after a
  green finish, look for a review before looking for a bug. A reviewer your own plan orders is dispatched in
  the FOREGROUND (the wait procedure's rule 2), never sent to the background and checked on.
- **The run's checkout is the console's.** Never clone a repository or initialise a submodule inside
  it: a repository your scope does not name is an EMPTY directory there, and you read it at the shared
  root, read-only (the boot prompt names the path; a clone into a run tree is denied, `run-tree-clone`).
  A person's commands for a parked phase go in an **errand tree** (`POST /api/run/<slug>/errand-tree
  {phase}`), never in the run's mirror, which the console prunes. Isolation is chosen at LAUNCH — a
  resume cannot add it; `isolate` (the run, at its next boundary) and `isolate-phase` (one phase) are
  the explicit escapes. A scoped run (`onlyPhases`) FINISHES when its phases settle, so it is never
  the way to move one stuck phase. `references/conventions.md` §Scoped concurrency.
- **The console runs one phase per session, and watches its context.** It never batches: every phase
  boards in a session of its own (`1 phase ≥ 1 session`), so a supervised session stops after its
  handoff and never continues into another phase — batching is a person's move, by hand (Mode 3 step 6).
  On every API call your context is compared with your model's window
  (`viewer/server/runner/usage.ts`): at **0.6×** you are told once to wrap up — finish the step you are
  on, commit, hand off `in-progress`, declare `partial --reason context`, stop — and at **0.8×** the
  console checkpoints the session itself. Either way the next attempt boards FRESH from the handoff; the
  wrap-up is the cheap exit, not a fault. **What to commit depends on the branch, and the notice says
  which:** a lane's own branch commits what is done; on a SHARED branch commit only work whose checks you
  ran green and leave the rest UNCOMMITTED — the console then runs the plan's fast §Verification lines on
  your commit, and a red is recorded against your phase (`wipRed`) and named, with its files, in every
  sibling's brief.
- **An unfinished phase is retried, differently.** A convergence loop re-reads stopped runs on a clock,
  releases dead sessions' locks, and climbs a bounded **ladder** of remediations. Uncommitted work in the
  tree is the previous attempt's: read `git status` first, and never `git stash` / `git reset` it away.
  A resume usually continues the phase's OWN session — but only when the phase ever announced one (a lane
  that wedged before the CLI's init frame has no session id, and is boarded FRESH with a resume brief), and
  a session is resumed only while it is worth resuming: one that ended at ≥ 250k tokens of context and is
  cold (idle ≥ 55 min) or under another account, that declared `partial --reason budget|context`, or that
  the console checkpointed is boarded FRESH with the resume brief instead — and so, at any size, is one
  that ended at or past **0.55×** of its window (the 0.6× wrap-up line less `RESUME_WRAPUP_MARGIN`):
  resumed, it would start inside the wrap-up zone. So the tree, the handoff and the journal are the memory
  that survives; the transcript is not.
- **A message can arrive mid-phase, from two different places.** *Ask* (answer, then carry on) and
  *steer* (do this differently from here) are written to your stdin from the console or `bin/btw` — a
  steer may also be a person's answer, from the inbox, to a prompt your lane stopped on. A steer
  outranks the plan for the rest of the phase — record the departure as a `ruling --kind deviation`.

## Modes

Pick the mode that matches the situation and announce it ("Using phased-execution: <mode>").

### Mode 1 — `plan` (no plan exists yet)
1. **Set the session budget, then minimize phase count.** Identify the model that will *run* these phases —
   you know your own from your system context; if a different model will execute them, ask
   (`AskUserQuestion`; the common split is Fable plans, Opus executes — default `claude-opus-5`). Look up
   its budget in `references/sizing.md` and **author the fewest phases that each fit one session** — by
   the measured model there (the floor every session pays plus the slope × the phase's weight, under the
   target), never by weight over budget — then add a boundary only where one is *earned* — an
   external gate, a deliberate model switch, or a checkpoint the user asked for. Never split for subsystem
   tidiness alone — extra phases buy repeated bootstrap + handoff ceremony. They buy real parallelism only
   when the split falls along **repo boundaries**, since disjoint scopes may run as concurrent sessions;
   splitting inside one repo buys none. Don't author three trivial phases that should be one, or one
   giant phase that should be three (a phase that does not fit one session is two phases —
   `--session-plan` flags it `over budget — split`). Record the
   target model + budget in a `## Session budget` note in the plan, and tag each phase's rough
   `- **Size:** S|M|L` (drives the batch engine; default is `M`). **QA is off by default** — only if the
   user asked for QA on this work, record `**QA gate:** on` in that note (see Mode 3 step on QA).
   **Worktrees are off by default too** — record `- **Worktrees:** on` only when this plan's disjoint
   lanes should each get their own git checkout rather than sharing the run's. It changes nothing for a
   hand-driven session; Phase Console reads it, runs each concurrent lane in a `git worktree` of the run
   branch and merges the lane back when it settles. It needs the console's new-branch git strategy. On a
   **superproject** a plain linked worktree still refuses — a worktree of a repo with submodules has EMPTY
   submodule directories — but since 2026-08-28 the run takes a **MIRROR** instead: one linked worktree per
   scoped SUB-repository, one mirror per RUN rather than per lane, so a monorepo-of-submodules plan does get
   isolation, just not per-lane (phases share the mirror, serialized per scope). **Since 2026-09-05 the
   superproject's own ROOT mounts too** — a scope meaning the root (its name, `all`, or a plain directory
   of it) is the mirror's first tree, with its initialized submodules checked out under it, so the
   ordinary monorepo-of-submodules plan gets an isolated checkout rather than a refusal that took the
   whole run's isolation with it. Two things still refuse by name — `scope-unmapped` (a scope naming no
   repository, or an uninitialized submodule) and per-LANE worktrees under a superproject
   (`has-submodules`). The older `root-scoped` is no longer produced and survives only so stored journal
   lines still render — `references/plan-format.md`.
   Each lane commits to **`pe/<slug>-p<N>`**, a *sibling* of the run branch `pe/<slug>` (the hyphen is
   load-bearing — `pe/<slug>/p4` is impossible in git while `pe/<slug>` exists), merged back when the
   phase settles; the run's checkpoint records each lane's `worktree` + `branch`, and **absent means
   shared**, so a phase without them ran in the run's own root. Every refusal is named in the journal and
   degrades to a shared checkout — a plan that asks for lanes and cannot have them still runs.
   **`$DOCS_ROOT` is injected into every spawned session and must not be overridden**: skill scripts
   resolve their docs root from it first and a cwd-upward git walk second, and inside a lane's worktree
   that walk answers the worktree, not the run's root — which is how a phase once landed cleanly and still
   read `no-handoff`.
   **If the user named skills to use for this work** (e.g. `design-system`,
   a TDD skill), record them on a `**Skills (every session):**` line in that note — backtick each — so the
   engine re-injects them into every phase's boot prompt (and the QA brief) and each fresh session re-invokes
   them.
   **If the work needs MCP servers** (a browser, an issue tracker, a docs server), record them the
   same way on an `**MCP servers (every session):**` line — backticked *registry ids* from Phase
   Console → MCP, three to six at most. A phase that needs one the rest of the plan does not gets its
   own `- **MCP:** \`server\`` bullet, which is UNIONED with the plan-wide line. The console checks
   them before a phase boards, so a wall costs a probe rather than an hour. By default a server that
   cannot connect does NOT stop the phase: it runs without that server, is told which ones are
   missing and told to record the gap as an operator errand, and the operator is warned. **If a phase
   genuinely cannot proceed without its server, say so** — `**MCP policy:** require` in §Session
   budget, or a per-phase `- **MCP policy:** require` bullet, which overrides the plan-wide one so a
   single phase can carve itself out either way. Use `require` sparingly: a parked phase with no
   other ready phase behind it halts the whole plan.
   Also record the **branch** in that note: by default the branch already
   checked out — **don't create a new branch**; only if the user explicitly asked, create ONE feature
   branch for the whole plan (every phase, including concurrent ones, commits to it) and record its name.
   (The console can also impose a run-level work branch `pe/<slug>` at launch; the plan line stays the
   default for hand-driven sessions.) See `references/conventions.md` §Branches.
   **Then elicit the decision manifest — ONE question at a time, before authoring.** Nothing asks a
   person mid-run: every decision a run can need is asked here, once, and written as a row of the
   plan's **`## Decisions`** table (`references/plan-format.md` §Decisions). Ask each with
   `AskUserQuestion`, the Tier-1 default first and marked `(Recommended)`, and write the answer as
   `| \`<key>\` | <value> | <who answered> | answered | <yes|no> | plan | <evidence> |`; a key the
   user leaves open stays `outstanding` with an owner (an `outstanding` row with NO owner fails
   `validate.sh`, F25), and one they rule out is `waived` with the reason as its value. The nineteen
   keys, in order — `permission.policy` (this plan's ask/deny/allow overlay, `autoApprove`; also
   goes on a `**Permissions:**` line) · `permission.destructive` (publishing and destructive verbs:
   `deny`, with named per-phase exceptions — `**May publish:**`) · `credentials` (backticked ids on
   `**Credentials:**` + `**Credential policy:** require|continue`; a phase adds its own with
   `- **Credentials:**`) · `accounts` (`**Accounts:**` as `\`id:minHeadroom\`` pairs, a percent) ·
   `mcp` (the MCP question above) · `gates` (`Gate-check` on every `*(GATED)*` heading — a missing one
   fails the lint, F24, and reads as `ai` — and `Gates: delegated|operator`) ·
   `verification.person-check` (allow, halt, or an owner when a §Verification fragment is prose —
   `- **Person-check:**`) · `qa.exhausted` (`**QA exhausted:** waive|halt|<owner>`; skip when QA is
   off) · `waits` (each expected external wait, its `--watch` ref and its maximum — `**Wait budget:**`
   and per phase `- **Waits on:** <ref> · <max>`) · `human-acts` (steps denied to an agent, each with
   the ref that proves it landed — `- **Human step:** <kind> · <what> · open: <url or command> · proof:
   <ref> · where: host|any · window: <duration>`, whose 5.1.0 `<who, what, proof ref>` spelling is
   superseded and fails the lint, F37) · `ambiguity` (ruling, ask or halt when the
   plan did not decide — `**When in doubt:**`) · `budgets` (run, phase and turn ceilings) ·
   `resume.on-restart` (continue, hold or ask — the RUN's answer) · `plan-health` (whether the advisory
   lints gate this plan) · `stop` (`autonomy`, and who is told on a halt) · `relay` (`off` or
   `last-resort` — a question a session asks mid-run gets 60 s in front of a person, then a rule
   answers; arms only at CLI 2.1.268+) · `announce` (which categories push, to whom) · `plan-approval`
   (`hold` or `continue` — what a plan-mode phase's presented plan waits for: a person's Approve, or
   nobody; `hold` is the default). The shipped
   defaults (`POLICY_DEFAULTS`): `gates: delegated` · `qa.exhausted: waive` · `resume.on-restart:
   continue` · `ambiguity: ruling` — the template's four — and `verification.person-check: operator` ·
   `credentials: continue` · `mcp: continue` · `relay: off` · `waits: window` · `plan-approval: hold`. The template carries
   the skeleton; `scripts/phase-graph.sh <slug> --decisions`
   reads it back, and the boot prompt hands each phase its rows.
2. Draft the plan in the `references/plan-format.md` shape. **Every phase must be self-contained** — written
   so a session with zero prior context can execute it from the plan + its handoff alone. **Required and
   load-bearing: the `## Phase graph` table.** Its `Depends on` column is the machine-readable dependency
   source the engine parses — every phase must list **every** phase that must finish first (comma-separated
   numbers, ranges like `1–7`, or `—` for none). Also fill `Parallel-safe with`, repos, exit criteria, and
   the explicit **"Blocking vs simultaneous"** callout. **Every phase needs a runnable
   `- **Verification:**`** — whole backticked commands or a fenced block proving its exit criteria
   (`validate.sh` fails F14 `verification-empty-open` on any open phase without one; the autopilot parks
   such a phase at boarding).
   **Gates are categorized.** Mark externally-gated
   phases `*(GATED)*` in their `### Phase N` heading with a `- **Gates (must clear first):** …` line AND a
   category directive `- **Gate-check:** …`:
   - **`ai <one-line check>` — the DEFAULT unless a person is genuinely required.** An AI session can
     verify the conditions, do the work to make them true, and record the clearance itself — the boot
     prompt orders it to. The whole point is to automate; don't strand a human on a gate a session could
     clear.
   - **`manual <who/what>` — only when a person is truly required** (a physical action, a third party,
     credentials no session holds). Then the Gates bullet MUST be full **numbered step-by-step operator
     instructions** — the console renders them on the phase's Gate card next to its Approve button, and
     the boot prompt prints them for whoever is asked.
   - **Self-evaluating checks** (`date` · `phase`/`phases` · `plan` · `deadline`/`by` · `cmd`) when a
     machine can answer directly. Full grammar + the approval lifecycle: `references/plan-format.md`.
3. Scaffold it: `bash <skill-root>/scripts/new-plan.sh <slug>` then fill it in. (`<skill-root>` is the
   base directory this skill loaded from — the Skill banner names it, and `$CLAUDE_PLUGIN_ROOT` holds it
   in a plugin install. Never assume a home-directory skills path — plugin installs and hub copies live
   elsewhere; F13.)
4. **Sanity-check the graph + preview batches:** run `scripts/phase-graph.sh <slug>` — it should list every
   phase, show the correct roots as `ready`, and (with `Size:` tags) print `SUGGESTED BATCHES:`. Run
   `scripts/phase-graph.sh <slug> --session-plan <model>` to see the proposed session grouping for your
   budget. If the count is wrong or a phase is missing, the table has a row the parser skipped (odd
   phase-number formatting) — fix it before proceeding.
5. **Commit** the plan (`docs/plans/<slug>.md`).
6. **Immediately implement the root phase(s) in this same session** → switch to Mode 2. (Driving by hand,
   keep going into further ready phases while the budget lasts — Mode 3 step 6; the console runs one phase
   per session. Whatever doesn't fit runs in later sessions via the pasted prompts from Mode 3 —
   concurrently where their scopes are disjoint.)

### Mode 2 — `phase-start` (begin or continue a phase in a fresh session)
1. **Bootstrap from disk only:** run `scripts/handoff-status.sh <slug>` — it prints the INDEX, per-file
   status, **and** the live DAG board, so you see at a glance what is done, what this phase depends on, and
   whether it is genuinely `ready`. Read this phase's **dependency** handoffs (the phase's `depends_on`, not
   merely the previous number), `docs/plans/<slug>.md` §Phase N + §Session budget, and memory
   `project_<slug>`. In a dependency handoff's `▶ Start next phase(s)` section, read the shared boot and
   **your own phase's block only — never a sibling's**: your boot prompt already carries the whole of it,
   and a sibling's block is another session's prompt (#115). **Read the phase's decision rows** — `scripts/phase-graph.sh <slug> --decisions <N>`
   (the boot prompt prints them; an `outstanding` row is a decision nobody has answered, and a
   `blocked` or `needs-human` you declare must name its key with `--needs`). **Read your notes** —
   `scripts/phase-graph.sh <slug> --notes <N>`, which your boot prompt already carries as
   `### Notes from earlier phases`: what finished phases deliberately left for THIS one, from their
   handoffs and their deferral rulings. It is the only channel that
   reaches a phase before it starts, so nothing else will tell you, and a note nobody answers is a
   note nobody writes next time — say in your handoff what became of each.
   **Invoke any skills named
   on §Session budget's `Skills (every session):` line** before
   implementing (the boot prompt lists them too). If the plan or the phase names **MCP servers**, confirm
   they are connected (`/mcp`, or `claude mcp list`) before implementing; if one needs authentication,
   **stop and ask the operator to sign it in** rather than working around it — the plan chose that server
   for a reason, and a phase that quietly did without is worse than one that stopped and said why.
   (**Unattended** — no operator present: your boot prompt already names any server the console could
   not reach. Do not improvise a substitute for it and do not treat it as a blocker: do the work that
   does not depend on it, and record what you could not do — naming the server — under **Outstanding**
   in the handoff, as an errand for the operator. Only when the phase genuinely cannot proceed at all,
   record it — `bash scripts/phase-outcome.sh <slug> <N> needs-human --needs mcp --reason "mcp <name>
   needs sign-in"` — hand off `blocked`, and stop.)
   That must be enough — if it isn't, the previous handoff was
   deficient; note the gap so it gets fixed.
2. **Confirm readiness, then the budget.** If the board shows this phase as `waiting`, a dependency isn't
   actually done — stop and surface that rather than building on an unfinished base (earlier-numbered phases
   may legitimately be incomplete; rely on the board, not phase numbers).
   **If the board shows this phase as `in-progress` or `stuck` and the lock is yours-or-stale**, you are
   RESUMING an interrupted session (a died console, a usage-limit stop, a manual pause, a session that
   declared `partial`) — recovery, not a restart: read `git status` and `git diff` FIRST; anything
   uncommitted is the interrupted session's work. Never `git stash`, `git checkout --` or `git reset` it
   away. Re-claim the lock (`--force` only when `status` says the lease expired), then continue from where
   it stopped to the exit criteria — a usage-limit stop says nothing about the work, so fix nothing on
   account of it. (This RESUMING path is exactly what the autopilot drives by itself: a phase it finds
   unfinished boards with a **resume brief** appended to its boot prompt — the handoff's status, the
   uncommitted paths, the last verification, the last session's words — or continues its own session
   with the same instruction; a phase whose handoff reads `blocked` gets ONE **unblock brief**, explicitly
   allowed to do the unblocking work. The brief is the supervisor's snapshot; the repository wins.) Then
   check the plan's
   `## Session budget` target model against the model you're *actually* running — if they differ, recompute
   the budget from `references/sizing.md` (and, driving by hand, re-batch accordingly). **Then check
   scope, then claim (concurrency guard):** `git pull`, read the phase's scope
   (`scripts/phase-graph.sh <slug> --repos <N>` — the boot prompt already states it), then
   ```
   scripts/phase-lock.sh <slug> conflicts <N> --scope "<csv>" --git   # 0 = clear, 1 = collides
   scripts/phase-lock.sh <slug> claim <N> --scope "<csv>" --git
   ```
   `--owner` defaults to `$PE_OWNER` (which an autopilot exports to its sessions — do not override
   it, or the supervisor cannot release your lock) else `<user>@<host>`. Pass
   `--owner "<account>/<session>"` only when driving phases by hand as one of several people.
   **Pass `--session <id>` when you know your Claude session id** (Phase Console's session-presence hook tells a
   fresh session its id at start; `$PE_SESSION_ID` — runner-injected — or `$CLAUDE_CODE_SESSION_ID` in the
   environment is read automatically, so usually nothing to type): the lock then names its session, and the
   console can show it on the Pulse, queue autopilot lanes behind it while it lives, and release the lock the
   moment the session ends instead of at the end of its lease.
   **Pass `--here` when your work rides a checkout of its own** — it derives BOTH qualification
   dimensions from your cwd: the branch this checkout stands on and its toplevel path (`--branch <name>`
   and `--worktree <path>` state them explicitly; `$PE_BRANCH`/`$PE_WORKTREE` — runner-injected — are
   read automatically, so under the console there is nothing to type). The PAIR is what changes an
   answer: two claims whose scopes intersect are nevertheless disjoint **iff both declare a branch AND a
   working tree and both differ** — so a session in its own checkout on `pe/a` is clear against a live
   lock carrying `branch=pe/b` in another tree, and still refuses one on the same branch, in the same
   tree (or inside it), or unqualified in either dimension. A branch alone no longer carves: it said
   nothing about two sessions editing one shared checkout. Declaring a place you are not actually
   working is how two sessions end up in one tree; declaring nothing is merely conservative.
   `conflicts` looks across **every plan**, because a working tree doesn't know which plan asked for it.
   If it names a live session — or `claim` reports the phase already held — **stop and ask the user**
   whether to wait, stop that session, take over (`--force`), or pick a ready phase with a disjoint
   scope. Never build over a live session. **Need a checkout of your own** — a QA round or a review
   beside a live build, in a tree the builder is not editing? `scripts/phase-lane.sh <slug> create <N>
   [--qa <round>] [--detach] [--repo <token>] [--owner <id>]` makes one under `<root>/.worktrees/hand/`
   on `pe/<slug>-p<N>[-qa<round>]` (or detached, for a review that commits nothing), locked while it
   lives, and prints the `claim … --here` line for it; `merge` folds it onto `pe/<slug>` — a fast-forward
   when it can, a merge commit when it cannot — and `remove [--force]` takes the tree, the merged branch and the lock away
   (`list` shows every hand lane). Never `git worktree add` a sibling folder of the project by hand —
   nothing sweeps it and, until now, nothing inside it found the docs root. **Under a console run** a
   session takes at most a review tree (`--detach`) or a QA round's (`--qa`) — never a build lane or a
   `merge`, never a `pe/<slug>` checkout or `git switch -c`: the console owns the run's trees and
   branches, and the script refuses the rest. (**Unattended**: never wait for an answer that cannot come —
   file `bash scripts/phase-outcome.sh <slug> <N> blocked --needs lock --reason "lock held by <owner>"
   --watch lock:<holder-slug>/<holder-phase>` — the HOLDER's lock, as `conflicts` named it, never your
   own phase's, which your own closeout releases (the script refuses that watch, exit 2) — hand off
   `in-progress` if you already did work, and stop; the supervisor queues the retry for when that lock
   frees.) The lock auto-expires (lease) and is released at phase-finish.
   See `references/conventions.md` §Locking + §Scoped concurrency.

   **Gate check — GATED phases only, and BEFORE implementing.** Run
   `scripts/phase-graph.sh <slug> --gate-status <N>` (the boot prompt states the same duty):
   - `clear …` (including `clear (approved by …)`) → proceed.
   - `ai: …` → **the gate is yours to clear.** Verify each condition in the plan's Gates bullet for
     real; where one does not hold yet, DO THE WORK to make it true — clearing this gate is in scope for
     this session. Then record it — `bash scripts/gate-approve.sh <slug> <N> --by ai-session
     --note "<one line of evidence>"` — commit + push `docs/handoffs/<slug>/gate-status.md`, and continue
     into the phase. Only if a condition is genuinely out of reach (missing credentials, a third party):
     STOP, report exactly what is missing and what you verified, and hand the gate to the operator.
   - `unevaluated: …` → **not a refusal, and not a person's gate.** This is a `cmd` gate the read
     declined to execute: running a command written in a plan is remote code execution by document, so
     `--gate-status` only runs one for a caller that opts in with **`PHASE_EXEC_GATES=1`** (the console's
     runner does; a page view and a plain command line do not). Read the command the verdict prints, and
     if you are willing to run it, evaluate the gate yourself:
     `PHASE_EXEC_GATES=1 scripts/phase-graph.sh <slug> --gate-status <N>` — then treat that verdict.
     Do **not** escalate it to the operator: the same gate answers `clear (cmd ok)` for the autopilot,
     and asking a person to clear a command is how one gate came to give a session and its supervisor
     opposite instructions at the same instant.
   - `manual: …` / `blocked: …` / `OVERDUE: …` → **STOP.** Tell the operator what the gate needs and
     where to clear it: Phase Console → plan → phase → **Gate card** (Approve), or
     `scripts/gate-approve.sh <slug> <N> --by "<who>"`. Never implement past an unapproved human gate.
     (**Unattended**: file `bash scripts/phase-outcome.sh <slug> <N> needs-human --needs gates --reason
     "<gate> needs the operator"` and stop.)
3. **Publish the task list** — `scripts/phase-tasks.sh`, not a task tool. Reset (which drops the
   previous phase's), then one `create` per task with subjects prefixed **`pN.taskM`**
   (e.g. `p2.task1 — wire endpoint`), and an `update` as each starts and finishes:
   ```bash
   bash <skill-root>/scripts/phase-tasks.sh <slug> <N> reset
   bash <skill-root>/scripts/phase-tasks.sh <slug> <N> create --subject "pN.task1 — wire endpoint"
   bash <skill-root>/scripts/phase-tasks.sh <slug> <N> update --id pN.task1 --status in_progress
   bash <skill-root>/scripts/phase-tasks.sh <slug> <N> update --id pN.task1 --status completed
   ```
   The id is yours — an unnamed `create` is numbered `pN.task1`, `pN.task2` … in order — so an update
   needs nothing read back. Phase Console renders the list live as **"What it is doing"** and the runner
   folds it into the run record, so it survives a reload and a console restart.
   **Do not go looking for `TodoWrite`/`TaskCreate`/`TaskUpdate`.** The CLI stopped providing them to
   sessions in August 2026; that is why this script exists. A harness that still has them may use them
   too — they feed the same list. Keep the roadmap in the plan, not the task list.
   (See `references/conventions.md` §Task list.)
4. Implement the phase to its exit criteria. Offload high-token exploration/verification to `Agent`
   subagents (they return summaries; the tokens never enter your session) — see Guardrails.
   **Record a ruling whenever the plan did not decide something for you.** A judgement call —
   an instruction that admitted two readings, a departure from what the plan said, something in
   scope you deliberately left — is the thing the next session most needs and the thing a handoff
   most often omits, because at the time it felt obvious:
   ```
   bash scripts/phase-outcome.sh <slug> <N> ruling --kind ambiguity|deviation|deferral \
     --what "<what you decided>" --why "<why>" [--cost-if-wrong "<what it costs if this was wrong>"] \
     [--for <M|next|all>]  # a DEFERRAL's addressee — what phase M's own boot prompt will carry \
     [--needs <decision key>] [--remember plan|global]
   ```
   One appended NDJSON line, and **nothing acts on it** — it is not an outcome, it does not park the
   phase and it never ends your turn, which is exactly what makes it safe to record whenever you are
   in doubt. It costs a line and it buys a reader. **Name the decision key it answers** (`--needs
   <key>`, one of the manifest's) whenever there is one: a keyed ruling is what the console's inbox
   offers to remember, and `--remember plan` writes it as a `## Decisions` row the moment it is recorded
   (`--remember global` asks the owning console to make it this console's `policy.<key>` answer — the
   words must be an answer word for the key). `references/conventions.md` §Rulings.
   **A person's turn is a human step, not prose.** When the work needs an act only a person can do —
   a sign-in that opens a browser, a device code, a secret only they hold, money, terms, a decision
   the plan left open, hands at a device, a system you cannot reach, somebody else's approval —
   declare it typed, hand off `in-progress`, and stop:
   ```
   bash scripts/phase-outcome.sh <slug> <N> needs-human --needs credential \
     --step browser-login --title "Sign the gh CLI in to the acme org" --why identity \
     --guide <guide file> --open-command "gh auth login" --proof 'cmd:"gh auth status"'
   ```
   Never run the sign-in yourself: in a `-p` session it hangs on a browser nobody sees, and the
   console refuses it before it runs, naming this declaration filled in. Never put a code, a token
   or a password in any flag — the script refuses it, and the console never takes a secret either:
   the item tells the person where to store it. The item appears on **Your turn** (`#/turn`); the
   console announces it once, checks it when the person presses *I've done this — check*, and resumes
   THIS session with what was proven or answered. Five things make it an item a person can act on
   (control-tower phases 130–136):
   **give the reason** — `--why <reason>`, one of ten, held to what the kind allows
   (`scripts/turn.env`); **write the guide** — `--guide <file>`: a why paragraph, numbered steps with
   their commands, and "If it goes wrong" — in the language the plan names (a `**Guide language:**`
   line in §Session budget, else English), passed as `--lang`; **state the proof in words** — a
   `--proof` ref the console reads, or `--proof-words` a checker reads the person's evidence against,
   or `--proof-type attest` for their bare word, by name (a decision's answer is its own proof:
   `--option`, `--recommended`, `--allow-decline`, `--decision-key`); **never ask for what you can do
   yourself** — the guard refuses, with exit 4, a declared `permission`, `reserved` or `reach` reason
   when this run's own policy would let you run every command its guide asks for (run them), and a
   `reach` with no `--tried`; did it, and it failed? declare again with `--tried "<what you ran and
   how it failed>"` (a proof that already holds raises nothing: exit 3, carry on); and **record what
   you handled** — when you got past a wall within your rights, or did yourself what you might have
   asked for, say so with `phase-outcome.sh <slug> <N> handled --what "<what>" [--link commit:<sha>]`,
   one row on Your turn's *Handled by the AI*, never an outcome. The grammar, a template per kind, the
   guard's seven rules, a permission block and the doors: `references/turn.md`; the lifecycle:
   `references/conventions.md` §A person's turn.

### Mode 3 — `phase-finish` (phase is done)

**Before anything else, publish this checklist with `scripts/phase-tasks.sh` and work it top to
bottom.** Step 1
(verify) is the step a hurried finish silently drops, because committing *feels* like the end — the
checklist is what makes it unmissable: **never hand off a phase whose verification is red.**

```
1. VERIFY — run EVERY line of plan §Phase N's Verification; ALL green (never hand off red)
2. Commit changed files — explicit paths; verify the sha with: git log -1
3. Write the handoff — new-handoff.sh, then the body; `complete` + INDEX last, once every line is green
4. Leave notes for later phases — one addressed bullet each; nothing else reaches them
5. Update memory project_<slug> + its MEMORY.md index line
6. Stop & hand off — the console runs one phase per session; batch only by hand
```

1. **Verify.** Run the phase's own `Verification` commands from plan §Phase N (tests, build, lint —
   whatever the plan names) and confirm **every exit criterion** against them. All green is the bar for
   `status: complete`. If something is red and you can't fix it now, hand off **blocked**
   (`new-handoff.sh <slug> <N> <title> blocked`) with the failure recorded — never a `complete` handoff
   on red verification. **Not run is not green:** a line owed, deferred or skipped (a device sweep left
   for later, a check "owed at idle") means the handoff says `in-progress` and, under a supervisor, the
   phase declares `partial` (`waiting-external` when the line waits on a clock you do not control) —
   never `complete`. `complete`, and the INDEX row's flip to it, are written LAST, after every
   §Verification line ran green: the board reads a `complete` handoff as done the moment it holds a
   body, and its dependents board at once (#153). **Record each command as you run it**, red ones too:
   `bash scripts/phase-outcome.sh <slug> <N> verified --command "<the command as the plan writes it>"
   --exit <its exit status>`. A supervising console then re-runs only what you did not prove at an
   equivalent tree (the same one, or one where only your handoff, a lock or `CHANGELOG.md` changed
   since), and a red verdict of its own re-opens the phase whatever the handoff says.
2. **Commit** changed files — explicit paths, never `git add -A`; commit inside the relevant submodule(s);
   end the message with the repo's `Co-Authored-By:` trailer. Commit to the plan's recorded branch — **the
   current branch by default; never `git checkout -b`** unless the user asked and the plan names a branch
   (then that single branch carries *all* phases, sequential and concurrent), or the boot prompt names a
   console-declared run branch — that prompt then owns the branch discipline. **Verify with `git log -1` —
   never copy a sha from memory; the environment may have auto-committed.**
3. **Handoff:** `bash <skill-root>/scripts/new-handoff.sh <slug> <N> <title>` (its status defaults to
   `complete`; pass `in-progress` while any §Verification line is still owed — step 1), then
   fill the frontmatter and body (see `references/handoff-format.md`) — and put every ruling you
   recorded into **Key decisions / gotchas**, since the handoff is what a person reads and the ledger
   is what the console reads. The script auto-fills `depends_on` +
   `blocks` from the graph and **auto-generates the `## ▶ Start next phase(s)` section** — the whole boot
   prompt of the one phase this phase unblocks, or, when it unblocks several, **the shared boot ONCE and a
   block per phase** holding only that phase's own parts (its reading list, notes, gate, and whatever else
   differs), from which `next-phase-prompt.sh <slug> <N> --phase <M>` and the console compose the full
   prompt at launch — review it, don't rewrite it. (It reads the just-finished phase as done,
   so the prompts are correct even before you commit the handoff.) Writing the handoff every phase keeps it
   resumable from a fresh session **even when you batch** the next one.
4. **Leave notes for later phases.** Fill the handoff's `## Notes for later phases` with what you
   learned that a later phase would otherwise have to rediscover — a measured fact, a trap, a name it
   must not re-spell. **This is the only channel that reaches a phase which has not started**: it has
   no session, no transcript and no inbox, and `scripts/phase-graph.sh <slug> --notes N` is what puts
   your bullet into its boot prompt months later. Every bullet is **addressed** — `- **Phase 7:** …`
   (one phase), `- **Next:** …` (every phase that depends on yours), `- **All:** …` — because the
   reader is asked per phase and an unaddressed line is collected by nobody; one naming a phase the
   plan does not have fails the lint (**F26**) and one naming a phase already done is a warning.
   Only a `complete` handoff's notes are read. Delete the section if there is genuinely nothing:
   say nothing rather than everything. Grammar, the 500-character note and the 12-note bound:
   `references/handoff-format.md` §6. A decision you made mid-phase belongs in the ledger too —
   `phase-outcome.sh <slug> <N> ruling --kind deferral --for <M|next|all>` arrives in the same block,
   and the two are not substitutes: the ledger is what the console reads, the handoff what a person does.
5. **Memory:** update `project_<slug>` (phase status, commits, gates) + its one-line `MEMORY.md` index
   entry. Record status as a **set** — "done: 1,4,5 / ready: 2,3" — never a single "current phase", so the
   record stays truthful under out-of-order progress. The live board is always recomputable with
   `scripts/phase-graph.sh <slug>`; memory holds the durable narrative, not the cursor.

   **QA gate — only when this plan runs QA.** QA subagents are **opt-in, off by default**; check
   `scripts/phase-graph.sh <slug> --qa-mode`:
   - `off` → skip this entirely (the default — step 1's verification is the phase's quality bar).
   - `waived <reason>` → the plan waived QA: `new-handoff.sh` records the row as `waived` automatically;
     **never dispatch a QA subagent**.
   - `on <reason>` → insert the QA gate here, before step 6: the building session shares the author's
     blind spots, so dispatch an **independent `Agent` subagent with a clean context** using the brief from
     `scripts/phase-graph.sh <slug> --qa-prompt <N>` (discipline: `references/qa-method.md`). It reads the
     real diff cold, runs/extends tests, records `pass|fail|waived` via `qa-record.sh`. Always commit +
     push the report + `test-status.md` (a `fail` must propagate to gate dependents in every clone). On
     `fail`: the finishing session owns the fix — fix now and re-dispatch a **fresh** QA subagent, whose
     brief (`--qa-prompt N`) is ROUND-AWARE and names the report file that round must write, so a second
     reviewer cannot overwrite the first's; a run bounds this with `qaMaxRounds` (never
     re-run inside the failed one's context), or hand off blocked
     (`new-handoff.sh <slug> <N> <title> blocked --force`) with the follow-ups listed. Don't start any
     dependent until the verdict is `pass`/`waived`. Batched phases QA one subagent per phase, at each
     phase's own boundary.
   - The user asks for QA on a plan that didn't record it? Pass `--qa` to `new-handoff.sh` (it creates
     `test-status.md`, backfilling earlier completed phases as `waived`), then follow the `on` path.
   **External waits — when the proof depends on a clock you don't control** (a CI image build, a PR's
   auto-merge, a deploy window): do not end the session silently waiting, and do not try to outlive the
   wait with background watchers — in an unattended (`claude -p`) session a background shell dies when
   your turn ends and `ScheduleWakeup` wakes nothing; an `Agent` or `Monitor` running in the background
   keeps the session alive only for the CLI's background-wait ceiling (ten minutes), a clock no CI run
   keeps; and a clean
   exit with no handoff reads as a failed phase. Instead: (1) commit what is done; (2) write the handoff **now** with
   `status: in-progress` — the durable pause marker (`references/handoff-format.md`) — recording what is
   done, what remains, and what you are waiting on; (3) declare the wait machine-readably:
   `bash scripts/phase-outcome.sh <slug> <N> waiting-external --wait-minutes <M> --reason "<what>"
   --watch <ref>`; (4) stop. The supervisor parks the phase and resumes THIS session when the window
   elapses — within the phase's wait budget (past what is left, a wait naming a ref it can watch is
   given what is left, and one naming none parks on a spent budget with a `budgets` errand for a
   person — never a failure; `- **Waits on:** <ref> · <max>` allows more), and never while your
   session is still running. (An interactive session may instead simply keep the turn
   and wait.) **A session nobody supervises** (no
   `PE_OUTCOME_FILE` in its environment) writes the same declaration into the console's inbox
   (`runs/<instance>/<slug>/outcomes/phase-NN.json`, printed on stderr); a running Phase Console with `--allow-run`
   picks it up, parks the phase `waiting` and resumes THAT session at the window — a hand-driven session can
   declare its wait and close. Plans avoid the park
   entirely by splitting build ∥ verify-later behind a Gate-check — `references/plan-format.md`.
   **Stopping with work still left — nothing wrong, just out of budget or context:** under a supervisor
   a clean exit with an `in-progress` handoff reads as a failed phase and buys a closeout that is forbidden
   from doing the work. Instead: (1) commit what is done; (2) write the handoff `in-progress` with the
   Outstanding section naming exactly what remains; (3) declare it —
   `bash scripts/phase-outcome.sh <slug> <N> partial --reason <budget|context|other>`; (4) stop. The
   supervisor reads `partial` as *work in progress, resume me* and continues THIS session (or boards a
   fresh one with a resume brief) by itself. (Unsupervised, the same file reaches the console's inbox and
   the console boards the phase again with a resume of your session.) `partial` is for work that remains; `waiting-external` is for
   a clock you don't control; `blocked`/`needs-human` are for things a machine cannot settle; and
   `no-defect` — "I looked, and there was nothing to fix" — is the repair family's word, for a session the
   console sent to mend one specific thing that turned out to be already mended. It is neither `complete`
   (it fixed nothing) nor a failure (nothing was wrong).

6. **Stop & hand off — the console runs one phase per session; batch only by hand.** If the proof is
   waiting on an external clock, use the
   §External-waits protocol above — under a supervisor, `phase-outcome.sh … waiting-external`
   is the ONLY channel it can read; prose reads as a failed phase. Then run the
   end-of-phase script (it prints the live board, batching advice for a person driving by hand,
   and the boot for **every** phase now ready — one phase's START COPY / END COPY prompt, or a fan-out's
   shared boot once with a block per phase, any of which `--phase <M>` composes whole):
   ```bash
   DOCS_ROOT=<hub-root> bash <skill-root>/scripts/next-phase-prompt.sh <slug> <N>
   ```
   Then decide, and **release the phase lock when you stop** (`phase-lock.sh <slug> release <N> --owner … --git`):
   - **Under a supervisor (`$PE_OUTCOME_FILE` set), this is the stop** — never continue into another
     phase, whatever the script's batching advice says: the console boards every phase in a session of
     its own, and the next one is its to start.
   - **Batch (continue in THIS session) — by hand only.** Driving the phases yourself, if a ready phase
     fits the **remaining session budget** (your live context meter, `references/sizing.md`) — sequential
     on this one *or* an independent sibling — just continue into it (Mode 2 in place, lock and all). You
     save a full bootstrap + closeout and keep the cache warm. (`--session-plan` shows which phases
     belong together.)
   - **Stop & hand off (fresh session)** — when the budget is spent, the next phase is **GATED** (never
     batch past a gate: a 🔒GATED·ai phase's fresh session clears the gate itself, a 🔒GATED·human one
     waits for the operator's approval first), it wants a **different model**, the **account's usage window is
     exhausted** (session/weekly limit — note the reset time in the handoff so the next session knows when
     work can resume, or resumes at once under another account), or — with QA `on` — it depends on this
     phase's still-unrecorded verdict. Print the script's output verbatim as the **last message of this
     session**, then **STOP** — after the handoff exists; a session that stops without one has not
     finished.
   - **Several phases ready:** run them in any order. Ones with **disjoint scopes** may run as separate
     sessions at the same time (the banner names which pairs those are); ones sharing a repo run one at a
     time. By hand, continue into ONE of them here if the budget allows; the output lists a boot prompt
     for each of the rest, and every prompt carries its own `conflicts` check.
   - **No phase ready but work remains:** the just-finished phase unblocked nothing yet (downstream still
     waits on other deps). The script says so; pick up any *other* phase the board shows as `ready`.
   - **Final / all done:** when the board shows every phase `done`, the script prints the closeout — run
     the plan's §End-to-end verification yourself (always), dispatch the fresh **`qa-full` subagent only
     if the closeout prints its brief** (QA-on plans), then — only once every line is green — mark the
     plan `status: complete` and check memory for user gates. You can also pass `none` to force the
     closeout.

## Helper scripts (deterministic, output-only — code never enters context)
Run from the repo root that owns `docs/` (in this monorepo, the **superproject root**), or set `DOCS_ROOT`.
Scripts resolve the superproject root automatically when run from inside a submodule directory.
**Which copy of the scripts:** a session Phase Console starts carries `PE_SCRIPTS` — the console's own
scripts directory — and every prompt it composes names a script as `$PE_SCRIPTS/<script>`; a boot prompt
says `"${PE_SCRIPTS:-<skill-root>/scripts}"`, so the same line runs by hand. Run them that way, and write
them that way in a handoff — never a skill copy's own path, which pins later sessions to that copy. The boot
prompt also carries the console's commit, and says so when the skill you loaded is at another one: then the
prompt and `$PE_SCRIPTS` win. `scripts/skill-api.env` stamps the interface (`PE_API`, `PE_API_MIN`); a run
refuses to start when the console's and the skill's do not meet, naming the half to update.
- `scripts/new-plan.sh <slug>` — scaffold `docs/plans/<slug>.md`.
- `scripts/phase-graph.sh <slug>` — **the engine.** Default: the live DAG board (done / ready / waiting,
  with unmet deps, gated flags, and `SUGGESTED BATCHES:` when sizes are present). Machine modes used by the
  other scripts (and handy directly): `--ready`, `--ready-after N`, `--deps N`, `--dependents N`,
  `--gated N`, `--boot-prompt N`, **`--boot-fanout "N M …"`** (the shared boot once — `<N>` for the
  number, a `⟨section⟩` line wherever the siblings differ — then each phase's own block; the shared boot
  plus a block composes to that phase's `--boot-prompt`, byte for byte), `--size N`, **`--repos N`** (phase N's SCOPE as a normalized csv, read
  from the Repos column — never empty; an undeclared phase reads as `all`),
  **`--session-plan [model|budget]`** (the unit first — `1 phase ≥ 1 session`, since the console's
  autopilot never batches — then the plan's weight as a generated line to quote, the remaining phases
  forecast in MEASURED sessions per phase, the session model — a floor paid once plus a slope — and
  this repository's boot floor; then live-aware grouping a person may batch by hand — done phases
  excluded, GATED/over-budget/unmet-dep groups flagged; with no argument it sizes for the plan's own
  `**Target model:**`, as the board does; `references/sizing.md`),
  **`--setup N`** (phase N's bring-up commands, one per line, in the order they run — the plan-wide
  `**Setup (every phase):**` line then the phase's own `- **Setup:**` bullet; the runner runs these
  BEFORE §Verification and never marks a phase red for one),
  **`--checkout N`** (phase N's `- **Checkout:** <branch>` bullet, verbatim and empty when it has
  none — which branch that phase's session works ON. The console acts on ONE value, the default
  branch: `main`, `master`, or the word `default`, meaning *do not stand this phase on the run
  branch* — board it in a checkout DETACHED at the trunk's head, which owns no ref and so may stand
  beside any number of others. That is what a phase after the run's pull request has merged needs.
  Every other value is documentation the console reads and acts on for nobody),
  **`--verify-in N`** (phase N's `**Verify in:**` directory on one line — bold and backticks stripped,
  an empty line for the repository root — read by the console's own rule: a bold label, top-level or
  nested under `**Verification:**`, the first one. It is where §Verification AND Setup run, so a
  `cd` or a path in either is spelled from there),
  **`--floor [N]`** (phase N's `- **Wall-clock floor:** <duration>` bullet, in MINUTES rounded up — the
  phase's FIXED floor (a full gate run, a CD wait), separate from its `Size:` tag, which weights context
  rather than clock time; with no argument, every phase that declares one as `N<TAB>minutes`, ascending
  order; nothing when a phase has none),
  **`--lint`** (structural validation: exit non-zero on a malformed row (**F1**), an undefined
  dependency (**F2**), a cycle (**F3**), a table whose SHAPE the parser cannot trust — no header row, no
  `Depends on` column, no `Repos` column, a row shorter than the header (**F20**) — or a cell it read but
  could not believe: a discarded `Depends on` token, a repeated Phase row, a zero-padded number, a phase
  with two handoff files (**F21**) — naming each. F20 and F21 are F1-tier gates, not advisories: a board
  whose scopes are fiction is how two sessions end up in one working tree. **Since 5.0.0 four more
  checks gate, each naming itself in its line:** `verification-empty-open` (**F14** — an open, not-done
  phase whose §Verification holds nothing runnable; it warned before), `gate-directive-missing` and
  `gate-type-unknown` (**F24** — a `*(GATED)*` heading with no `Gate-check`, which reads as `ai` until
  it has one, and a directive whose type is not on the list), and `decision-outstanding-unowned`
  (**F25** — a `## Decisions` row nobody owes; its siblings `decision-key-unknown`,
  `decision-state-unknown`, `decision-source-unknown` are the same tier). **Since 6.0.0 a fifth:**
  `human-step-superseded`, `human-step-kind-unknown` and `human-step-field-invalid` (**F37** — a
  `- **Human step:**` bullet the reader skips: the 5.1.0 `<who, what, proof ref>` spelling, named in the
  line with the grammar that replaced it; a kind that is not one of the eighteen; a field, `where`,
  `window`, `auto-open`, `credential`, `due` or `open:` link the grammar cannot read).
  Plus the **advisory family F15–F19, F22–F23, F28, F30, F32–F36, F38–F40** on stderr, which
  never changes the exit code: F15 an unregistered MCP server, credential or account ·
  F16 a verification that waits on an external clock · F17 a lead binary not installed here ·
  F18 a cwd-sensitive lead with no `**Verify in:**` · F19 a plan that cannot progress at all ·
  **F22** bring-up inside §Verification (move it to `- **Setup:**`) · **F23** an expected failure stated
  in prose beside a command (the runner reads exit codes, not sentences) · **F30** a forward note
  addressed to a phase that is already done, which nothing will ever board with · **F32** a
  §Verification line whose exit code reads FLEET-WIDE state (`task hygiene`, `task drift`, a
  machine-wide `ps … | grep`), which cannot pass while anyone else is working — the warning names only
  forms the task accepts: `task hygiene` has none, so assert the plan's own footprint; one
  `task drift:<gate>`; a process named by its pid ·
  **F33** a Repos cell naming a repository outside the docs root, in a plan whose other cells are inside
  it: that phase alone cannot be isolated (it runs in the run's checkout with an unqualified claim) ·
  **F34** a Repos cell naming the superproject itself in a phase whose `Files` are all in submodules or
  under `docs/` — name the submodules it writes · **F35** a `Checkout:` value the console never acts on
  (only `main`, `master` or `default` means anything to it) · **F36** a `Waits on:` max shorter
  than the timeout of the workflow it watches (`wait-window-short`, told through `PE_WAIT_TIMEOUTS`
  — `<ref>=<minutes>` pairs; unset is off, set but empty an answer) · **F38** a `Human step:` that
  names no `proof:` ref (`human-step-no-proof`) — only a person's word can ever close it ·
  **F39** a §Verification line that runs a package-manager script or a `.venv/bin/*` binary in a
  repository the phase's Setup never installs (`setup-deps-missing`) — a run's isolated checkout
  mounts it with no `node_modules`/`.venv`, so it goes red before it tests anything; Setup runs in
  the `Verify in:` directory, so spell the install's path from there (the lint names the line to add) ·
  **F40** a `Human step:` that names no `why:` (`human-step-no-why`) — it is given its kind's default
  reason, marked inferred on the item.
  `references/plan-format.md` has the full reasoning for each), **`--qa-mode [N]`** (the QA regime: `off` ·
  `on <reason>` · `waived <reason>` — with no argument the PLAN's, and with a phase number that phase's
  resolved answer naming which level decided it, since `- **QA:** on|off` in a §Phase section beats the
  plan-wide line), **`--qa-result N`** / **`--qa-history N`** / **`--qa-prompt N`** (the CURRENT QA
  verdict — the one that gates / EVERY round on file, oldest first, as
  `round<TAB>result<TAB>report<TAB>recorded`, where empty output means no review has ever been recorded,
  a different fact from `--qa-result` answering `none` / the fresh QA-subagent brief, which is
  round-aware: it names the next round's own report file so a second reviewer cannot overwrite the
  first's, and quotes the earlier verdicts as evidence), **`--gate-status N`** (evaluate the gate — every type: `phase` `phases`
  `plan` `cmd` `date` `deadline` `by` `manual` `ai` `landed` `pr-merged`; a recorded approval clears ANY of
  them; exit 0 clear, 1 blocked/manual/ai), **`--gate-kind N`** (the gate's category: `human` · `ai` · `auto` · `none`),
  **`--land [N]`** / **`--gitlink [N]`** / **`--isolation [N]`** / **`--issues [N]`** /
  **`--conflict-policy`** / **`--messaging`** / **`--base-branch`** (where a phase's work HAPPENS and
  where it LANDS, each as `value<TAB>phase|plan|default` — the source token is the point: these words
  have engine-owned defaults, so `hold` alone would be two facts wearing one spelling, "this plan chose
  hold" and "this plan never considered landing", and the wizard has to tell them apart. The first four
  take a phase and read its bullet over the plan's line; the last three are plan-wide and REFUSE a phase
  argument, because a per-phase base branch or conflict policy is a claim about the RUN. `--isolation`
  alone can answer nothing at all: a phase that says nothing inherits the run, and the run is not in the
  plan), **`--clash-zones`** (the paths two concurrent phases must never both touch, as a csv — a list,
  so no source token), **`--landing N`** (the landing LEDGER's rows for phase N as TSV — what actually
  happened, which is a different question from `--land`'s what-should; nothing at all when the phase has
  no record, and that silence is what a `landed N` gate blocks on), **`--notes N`** (what phase N is
  handed by the phases before it, from all three places anything can be left for a phase that has no
  session: a DONE handoff's `## Notes for later phases` bullets addressed to N — by number, by `Next`
  (every phase depending on the writer) or by `All` — a `ruling --kind deferral --for` line, and mail
  queued for N's boot. One `source<TAB>kind<TAB>id<TAB>at<TAB>text` row per note, urgent mail first
  and then oldest to newest, bounded at 12 with a `trailer` row naming what was dropped; `--boot-prompt N`
  carries the same list as `### Notes from earlier phases`, and `**Messaging:** off` suppresses the mail
  source alone),
  **`--memory-block`** (the canonical done/ready/waiting block for memory),
  **`--verified`** (the phases that are done **and** QA-verified, space-separated — the set a
  DEPENDENT may build on, and what a `plan <slug>:<phases>` gate now compares against: under
  QA-on the two differ by exactly the phases whose verdict is `fail`, which are `done` on the
  board and are the ones another plan must not gate through),
  **`--mcp [N]`** / **`--mcp-policy [N]`** (which MCP servers a phase runs with, and what the plan says
  to do when one will not connect — with no phase argument, the plan-wide `## Session budget` line alone;
  with one, that phase's answer, which for `--mcp` is the plan line UNIONED with the phase's own bullet
  and for `--mcp-policy` is the phase's bullet OVERRIDING the plan's. Empty `--mcp-policy` means the plan
  has no opinion, which is a different fact from `continue`), **`--permission-mode [N]`** (the
  `--permission-mode` a phase's session starts in, as `mode<TAB>phase|plan` — the phase's
  `- **Permission mode:**` bullet OVERRIDING the plan's `**Permission mode:**` line, any case, printed as
  the CLI spells it; nothing when both are silent, so the run's default answers and `acceptEdits` below
  it; a word that is not a mode fails the lint, **F31** `permission-mode-unknown`),
  **`--model-policy [N]`** (what a run may do to a phase's model, as `ladder|pinned<TAB>phase|plan` —
  the phase's answer over the §Session budget line; nothing when the plan is silent, so the run's
  `modelPolicy` answers, and `ladder` below it),
  **`--credentials [N]`** /
  **`--credential-policy [N]`** (the credential ids a phase needs and what the plan says when one is not
  held — the two MCP shapes exactly: `**Credentials:**` ∪ `- **Credentials:**`, and
  `**Credential policy:** require|continue` overridden by the phase's bullet, silence printing nothing),
  **`--accounts`** (the `**Accounts:**` line as `id<TAB>minHeadroom` per line), **`--wait-budget [N]`**
  (how long a phase may stay parked on its declared waits, as `minutes<TAB>phase|plan` — its own
  `- **Waits on:** <ref> · <max>` bullet, else the plan's `**Wait budget:**`; nothing means the console's
  default) / **`--waits-on N`** (that bullet's refs, one per line — a `date:` among them countersigns a
  wait up to that instant) / **`--wait-count [N]`** (how many waits a phase may DECLARE, as
  `n<TAB>phase|plan` — its own `- **Wait count:** <n>` bullet, else the plan's `**Wait count:**`, a whole
  number from 1 to 99; nothing means the console's four, control-tower phase 121, #40),
  **`--verify-timeout [N]`** (how long ONE §Verification command may run
  before the console cuts it, as `minutes<TAB>phase|plan` — the phase's `- **Verify timeout:**`
  bullet, else the plan's `**Verify timeout:**`; nothing means the console scales the limit from the
  line's measured history. A command cut by its clock is retried once at twice the limit, and a second
  cut parks the phase `verify-timeout` — never a red), **`--qa-exhausted`** (the `**QA exhausted:**` line's one word — `waive`,
  `halt`, or an owner — the answer the console acts on when a phase's QA rounds run out) /
  **`--person-check N`** (that phase's `- **Person-check:**` bullet — `allow`, `halt`, or an owner — what
  to do with a §Verification fragment written as prose; silence prints nothing and the console's
  policy table answers), **`--human-steps [N]`** (the acts only a person can do that phase N declares,
  one `- **Human step:** <kind> · <what> · open: … · proof: … · where: … · window: … [· auto-open: host]
  [· credential: <id>] [· due: <ref>]` bullet per line as `kind<TAB>what<TAB>open<TAB>proof<TAB>where
  <TAB>window-minutes<TAB>auto-open<TAB>credential`, and a ninth field, the `due:` ref, when the bullet
  names one — `where` resolved to the kind's default when the bullet is silent; with no argument, every
  phase's, each line led by `N<TAB>`, phase `0` being the plan's own acts under its `## Operator errands`
  heading; a bullet the lint refuses (F37) is not a step; the eighteen kinds are
  `scripts/human-steps.env`'s),
  **`--decisions [N]`**
  (the decision manifest as it HOLDS — the plan's `## Decisions` rows with
  `docs/handoffs/<slug>/decisions.md` merged over them and, with a phase, that phase's own rows over
  both — one `key<TAB>state<TAB>owner<TAB>blocking<TAB>source<TAB>value` line per row that exists,
  in vocabulary order; a plan with no manifest prints nothing), and **`--plan-status`** (the stored operator
  decision as one bare word — the raw `status:`, where `--closed` is the predicate over it). The board is
  model-aware
  (batches size to the plan's `## Session budget`) and shows QA markers when gating is on. Parses the
  `## Phase graph` table (deps, ranges, markdown-bold cells) + `### Phase N` `Size:`/`Gate-check:` bullets +
  handoff statuses + `test-status.md` + `gate-status.md`; warns on drift. Sizing/budget constants live in
  `scripts/sizing.env` and the model vocabulary (aliases, full ids, the `[1m]` window suffix) in
  `scripts/models.env`; the gate vocabulary + category split + the undeclared-gate default (`GATE_DEFAULT`)
  in `scripts/gates.env`; the MCP surcharge in
  `scripts/mcp.env`; the verification-command vocabulary the F16/F17/F18 lints read (cwd-sensitive
  leads, names never worth a warning, commands that wait on an external clock) in `scripts/verify.env`;
  and the decision manifest's keys, states, sources and `--needs` classes in `scripts/decisions.env` — the
  bash twin of `viewer/shared/decisions-model.js`, which owns them.
- `scripts/new-handoff.sh <slug> <N> <title> [status] [--qa] [--force]` — scaffold the phase handoff +
  create/update `INDEX.md`. Auto-fills `depends_on` + `blocks` from the graph and the
  `## ▶ Start next phase(s)` section (the next phase's boot prompt, or a fan-out's shared boot once and a
  block per unblocked phase). `status` is one of the four
  writable handoff words — **`complete | in-progress | blocked | pending`**, frozen (a fifth would change
  what "done" means; owner `viewer/shared/plan-vocab.js` `HANDOFF_STATUSES`) — and defaults to `complete`;
  pass `in-progress`/`blocked` mid-phase, and `pending` for a handoff scaffolded before its phase runs.
  Note these are not the board's buckets: the board folds `blocked` to `stuck` and has no `pending`.
  `--force` overwrites an existing handoff (the only way to repair one). Touches `test-status.md` only
  when the plan's qa-mode is not `off`; `--qa` forces QA on for this finish (creates the file,
  backfilling earlier completed phases as `waived`).
- `scripts/handoff-status.sh <slug>` — INDEX + per-file status + the live DAG board (calls the engine).
- `scripts/next-phase-prompt.sh <slug> <completed-phase|none> [--phase N]` — end-of-phase stop banner, live
  board, batching advice, and the boot for **every** phase the completed phase unblocks (a lone next
  phase's START COPY / END COPY prompt; a fan-out's shared boot once and a block per phase), and with
  `--phase N` only phase N's full prompt, composed at launch
  (on a QA-`on` plan, run it only *after* the verdict is recorded). Pass the phase you just finished (not
  the next number); `none` forces the final-phase closeout (which prints the `qa-full` brief only for
  QA-`on` plans).
- `scripts/validate.sh <slug>` — deterministic validator: structural lint of the plan
  (F1/F2/F3/F14/F20/F21/F24/F25/F26/F27/F29/F31/F37, and the advisory family F15–F19, F22–F23, F28, F30, F32–F36, F38–F40 on stderr) **plus**
  handoff body/consistency checks (valid status, required sections, `depends_on` agreeing with the graph).
  Run before trusting a board or finishing a phase.
- `scripts/phase-lock.sh <slug> <claim|release|status|list|conflicts|mirror> <N> [--owner ID] [--lease S]
  [--scope CSV] [--session ID] [--worktree PATH] [--branch NAME] [--git] [--force]` — cooperative phase
  locks (concurrency guard). `--session` (or `$PE_SESSION_ID` / `$CLAUDE_CODE_SESSION_ID`, read
  automatically) names the Claude conversation holding the lock, which is what lets the console show it
  on the Pulse and release it the moment the session ends instead of at the end of its lease;
  `--worktree` (or `$PE_WORKTREE`) records the linked worktree this session is working in, and it is
  **half of the pair that changes an answer** (see `--branch` below): a tree alone carves nothing, but
  without one a branch carves nothing either. Lock files at
  `docs/handoffs/<slug>/.locks/phase-NN.lock`; `--git` pulls before checking and commits+pushes the claim
  so other clones see it (retrying a raced commit/push up to 3×) — committing the lock's path ALONE, inside
  the docs root's short critical section. **Under an autopilot (`$PE_LOCK_MIRROR=console`, which the
  runner exports) `--git` is skipped** and your lock calls are file-only: the console runs `mirror` — one
  commit of that lock path where it stands now, never a pull or a push — outside your turn. `--scope` (or `$PE_SCOPE`) records the
  repos the session is working in as a `scope=` line — older locks simply have none, which reads as
  *unknown* and therefore collides with everything. `--branch` (or `$PE_BRANCH`) records the branch the
  work rides as a `branch=` line, and together with `worktree=` it is the PAIR that CHANGES an answer:
  two claims whose scopes intersect are nevertheless disjoint iff **both** declare a branch AND a working
  tree and both differ (`claimsDisjoint` in `shared/scope.js`, `claim_disjoint` in `scripts/scope.sh`; a
  tree nested inside another is the same ground). Unqualified in **either** dimension collides with
  everything, exactly like an unstated scope — a branch alone said nothing about two sessions editing one
  shared checkout. **`conflicts [N] --scope "<csv>"`** is
  the read-only
  question "does anything live share my working tree?", scanned across **all** plans: exit 0 clear /
  1 conflicts (one line per holder) / 2 usage. `claim` still refuses only the same phase of the same plan —
  scope is policy, and policy lives where it can be acted on. See conventions §Locking + §Scoped concurrency.
- `scripts/phase-lane.sh <slug> <create|merge|remove|list> <N> [--qa R] [--detach] [--repo TOKEN]
  [--owner ID] [--force]` — a checkout of your OWN beside a live build, for a QA round or a review that
  must read a tree the builder is not editing. `create` puts one under `<root>/.worktrees/hand/` on
  `pe/<slug>-p<N>[-qa<R>]` (or detached, for a review that commits nothing), locks it while it lives, and
  prints the `claim … --here` line for it; `merge` folds it onto `pe/<slug>` — a fast-forward when it can,
  a merge commit when it cannot — and `remove` takes the tree, the merged branch and the lock away. Never
  `git worktree add` a sibling folder of the project by hand: nothing sweeps it, and nothing inside it
  finds the docs root. Under a console run (`PE_OWNER=autopilot/…`) a build lane and `merge` refuse:
  a hand tree on the run branch takes the branch the run's own checkout needs.
- `scripts/phase-landing.sh <slug> <N> <state> [--repo KEY] [--policy WORD] [--ref REF] [--sha SHA]
  [--pr URL] [--by WHO] [--note TEXT]` · `<slug> list [N]` — the deterministic, idempotent writer for
  `docs/handoffs/<slug>/landing.md`, the ledger the `landed N` and `pr-merged N` gates read. `state` is
  one of `held integrated pushed pr-open pr-merged landed conflict failed` (`scripts/landing.env`).
  **A row is a POSITION, not a log**: the upsert key is (phase, repo) and a second record REPLACES the
  first, because a phase that is pushed, then PR-open, then merged has MOVED — it has not happened three
  times, and two rows for one phase would make "the state" ambiguous for every reader at once. The key
  carries the repository because a mirror run lands N times, once per submodule, each on its own clock.
  Written by the landing session; never hand-edited; never touches git (the caller commits). The point
  of a file rather than a question: a gate that shells out to `gh` gives different answers to a page
  view, a session and the autopilot, and this one reads a file and runs nothing.
- `scripts/qa-record.sh <slug> <N> <pass|fail|waived|pending> --report <rel-path> [--round R]
  [--reason TEXT]` — the
  deterministic, idempotent writer for `test-status.md` (the QA gate). The QA subagent calls it when QA is
  enabled; never hand-edit the table. (Recording a row also *activates* gating — it's a QA-on trigger.)
  **`--round`** is which review produced the verdict, and it defaults to previous + 1, so a re-record is a
  new round without anyone counting. It writes TWO tables, because a verdict and a history are different
  questions: `## QA status` keeps ONE row per phase — the current verdict, the only thing that gates — now
  with a fourth `Round` column, and `## QA rounds` is the append-only ledger `--qa-history` lists. A
  three-column table written before rounds still reads (`Result` is the third cell either way) and is
  upgraded in place on the next record. `--round` is refused with `pending`: a round is a review that
  happened, and `pending` is the absence of one. **`--reason`** is `waived`-only — refused on the other
  three rather than dropped — and lands in a THIRD append-only section, `## QA waivers`, keyed
  `(phase, round)` like the ledger. A waiver is the one verdict with no report to explain it: `pass` and
  `fail` point at a review somebody wrote, while a waiver is a DECISION ("this finding does not apply to
  this phase") regularly recorded with no report at all, so without a reason the row says only that
  somebody decided something. It is a third section rather than a fifth cell because both tables are
  COUNTED positionally by the bash and JS readers, and prose is the one value that cannot promise to be
  short. See `references/qa-method.md`.
- `scripts/wait-budget.sh <slug> [--phase N [--ref REF]…] <max>` · `<slug> [--phase N] --count <n>` —
  the deterministic writer for the two wait-budget directives `--wait-budget` reads: the phase's `- **Waits on:** <refs> · <max>` (the
  refs and any note kept; `--ref` names them when the phase has no bullet yet) or, without `--phase`,
  the plan's `**Wait budget:**` line. `<max>` is `90m`, `2h`, `3d` or bare minutes, written in its
  plainest unit. Idempotent, atomic, never touches git; its only output is the engine's read-back
  (`minutes<TAB>phase|plan`), and a disagreement is exit 1. What the console's one-press raise runs
  (control-tower phase 14, #40). `--count <n>` writes the other number instead (control-tower phase
  121): the phase's `- **Wait count:** <n>` or the plan's `**Wait count:**`, 1 to 99, read back through
  `--wait-count` — how many waits the phase may declare, where `<max>` is how long they may take.
- `scripts/qa-mode.sh <slug> [--phase N] on|off|inherit` — the deterministic writer for the two QA
  switches the engine reads. Without `--phase` it sets the plan's `**QA gate:** on|off` line in
  §Session budget (adding the line — or the whole section — when there is none); with one it sets that
  phase's own `- **QA:** on|off` bullet, and `inherit` deletes the bullet so the phase follows the plan
  again (`inherit` is refused without `--phase`). This is what the console's QA toggle runs; editing the
  plan by hand stays valid, because the script writes exactly the shape `--qa-mode` reads back — and
  that read-back, `phase-graph.sh <slug> --qa-mode [N]` after the edit, is its only output. Idempotent,
  atomic, never touches git; an unknown phase (no `### Phase N` section), an unknown mode or a missing
  plan is refused (exit 2). Turning the plan `on` creates no `test-status.md` by itself — the next
  phase-finish (or `qa-record.sh`) does, backfilling earlier phases as `waived` as it always has.
- `scripts/phase-tasks.sh <slug> <N> <reset|create|update> [--id ID] [--subject TEXT]
  [--status pending|in_progress|completed|deleted] [--active-form TEXT]` — publish the session's
  **task list**, the panel Phase Console renders as *"What it is doing"*. Append-only NDJSON to
  `$PE_TASKS_FILE` (runner-injected, tailed into `PhaseRecord.tasks` so it survives a reload and a
  restart) or, unsupervised, to the console's own inbox. **Use this, not a task tool** — the CLI
  stopped provisioning `TodoWrite`/`TaskCreate`/`TaskUpdate` to sessions in August 2026. Ids default
  to `pN.task1`, `pN.task2` … so an update needs nothing read back. `deleted` is a tombstone rather
  than a state, so it belongs to `update` alone — a task cannot be born deleted, and
  `create --status deleted` is refused (exit 2) even though the flattened signature above reads as if
  every word were legal everywhere.
- `scripts/phase-outcome.sh <slug> <N> <complete|waiting-external|blocked|needs-human|partial|no-defect>
  [--reason TEXT] [--watch REF]… [--wait-minutes N | --until ISO8601] [--needs KEY] [--rule TEXT]
  [--command TEXT] [--step KIND --title TEXT [--open-url URL | --open-command CMD] [--where host|any]
  [--proof REF] [--step-line TEXT]… [--code CODE] [--credential ID] [--due-when REF | --due ISO]
  [--why REASON] [--guide FILE [--lang CODE]] [--effort MIN] [--unblocks PHASES] [--proof-type TYPE]
  [--proof-words TEXT] [--option ID=LABEL[::CONSEQUENCE]]… [--recommended ID] [--allow-decline] [--decision-key KEY]
  [--window DURATION] [--tried TEXT]] [--act]` — the
  session→runner channel: ONE atomic JSON file at `$PE_OUTCOME_FILE`, read once and consumed.
  **A parking declaration that names `--watch` refs asks the console first** (`POST /hooks/declaration`,
  20 s at most): when a ref has ALREADY landed, nothing is written or parked and the script **exits 3**
  with `already landed — continue: <ref>` — carry on with the phase; never stop on it.
  **`--needs <key>` is REQUIRED on `blocked` and `needs-human`** (exit 2 without it) and refused on
  the rest: the decision the session is missing, as a key of the plan's `## Decisions` manifest
  (`scripts/decisions.env`) or a blocker class as its short form — `credential`, `permission`, `gate`,
  `external`, `lock`. The runner reads it BEFORE the prose, so `blocked-declared:credential` is what a
  declaration `--needs credential` classifies as whatever its `--reason` says, and
  `blocked-declared:unknown` now means "a key the manifest lacks" — a defect report, not a routine.
  `--rule`/`--command` structure a permission block beside it (the rule that refused, the command).
  `--wait-minutes` and `--until` are the resume clock and belong to the three statuses that PARK —
  `waiting-external`, `blocked` and `needs-human` (mutually exclusive; absent means the runner's
  default window) — `--until` is the right one when you know the wall-clock moment rather than the
  duration. On `blocked`/`needs-human` the clock does NOT replace the ask: the errand still stands and
  a person still settles it; the clock only decides when the console next brings the phase up, so say
  both when you know both ("a person must look, and not before the release lands at 09:00").
  `--watch` is repeatable to 8 refs, and the console polls them on a timer of its own
  (`viewer/server/watch-scheduler.ts`), resuming YOUR session when one lands: `gh:<repo>#run/<id>`
  (the run reaches `completed`, any conclusion) · `gh:<repo>#pr/<n>` (the PR leaves OPEN) ·
  `date:<ISO8601>` (that instant passes) · `unit:<host>/<unit>` (the systemd unit on that host leaves
  `activating`/`active` — a job on another machine, `unit:build-box/nightly-build.service`: asked every
  5 minutes over ONE shared ssh connection per host, whose address, user, key and port come from
  `hosts.<host>` in the machine profile `~/.config/phase-console/fleet.json` — a host not named there is
  refused, and none of it is written into the run record — and its `Result=` and exit time land in the
  wait history) · `credential:<id>` (the credential is PRESENT, read by name and never its value —
  `credential:gh`, `credential:claude`, `credential:env:<NAME>`, `credential:keychain:<service>`,
  `credential:file:<path>`; the proof a `secret-entry` step names, so storing the secret proves it with
  nothing read back) · `lock:<slug>/<phase>` (nothing holds that scope any more —
  somebody ELSE's lock: one naming the declaring phase is refused, exit 2, because the only release it
  could see is its own closeout's) · `phase:<slug>/<N>` (the console's RECORD of sibling phase N reads
  done, after its §Verification — the way to wait on a sibling, re-probed the moment that phase moves;
  a re-opened phase un-lands it; prefer it to any `cmd:` grep of a handoff) · `verify:<slug>/<N>` (your
  OWN phase only: your red §Verification lines are re-run whenever the branch head moves, and it lands
  when all of them pass on one head — for "my blocker is a sibling's red") ·
  `cmd:"<command>"` (it exits 0 — **run** under the same policy a plan's §Verification gets — NOT
  read-only: `npm ci` passes it — 60 s, backing off 5 m → 15 m → 1 h → 6 h **until the phase's wait
  budget ends**, after which the ref reads `refused`; so write a ref that only READS and costs little).
  **A `cmd:` probe is self-contained**, because the console runs it later, from its own directory, with
  none of your shell: absolute paths, no shell variables, no backticks, no cd, balanced quotes, and
  exit 0 only when the thing has happened. A ref is at most 1,000 characters, and the script never cuts
  one: a longer ref, or a `cmd:` ref holding a `$` or a path relative to your cwd, exits 2 with nothing
  written (a script at an absolute path is one short ref). The resume instruction names what actually
  happened, so read it rather than assuming the thing you waited for succeeded — a cancelled run is not
  a result. A ref no scheme parses is still recorded, with a warning on stderr: nothing will ever check it.
  **A `date:` beside a live ref is the wait's BACKSTOP** (#181): the live ref wakes the phase the moment
  it lands, and the date only bounds the wait — if it passes first, the phase is resumed told that the
  ref has NOT landed and what it last read. The script says so when it records one.
  **Declarations are bounded.** `waiting-external` spends the phase's 4 waits (more where the plan's
  `Wait count:` says so) and its wait budget — and a wait past either whose ref still polls goes on
  waiting on that ref alone, the run reading `waiting`, never an errand to re-check it by hand;
  each other status is acted on at most 4 times per phase — a fifth is recorded, not acted on, and parks
  the phase for a person until an operator's Retry; a `blocked`/`needs-human` clock is capped at 7 days;
  and unsupervised, two `partial`s within 5 minutes are one act. A declaration stands until a newer one,
  a `git commit` or `phase-outcome.sh` call in the resumed session, the board closing the phase, or a
  Retry spends it.
  **`--step KIND` makes a `needs-human` a HUMAN STEP** (control-tower phase 41) — refused on every
  other status: the ask becomes a typed record the console holds in its ledger, raises as ONE
  `human-step` inbox row and ONE `needs-you` push, and parks with wait kind `person`, charging no
  external-wait budget. KIND is one of the eighteen (`scripts/human-steps.env`); `--title` (required)
  says what the person must do, `--open-url` (http or https only) or `--open-command` what to open,
  `--where host|any` where (default: the kind's), `--proof` the watch ref that proves it, `--step-line`
  a numbered step (repeatable), `--code` a device code (`device-code` only), `--credential` the
  registry id a `secret-entry` stores under (required there). A value shaped like a secret — a token,
  a password, a one-time code, a URL query secret — is refused (exit 2, nothing written, the value
  never echoed): the person types it where the step opens, never into a declaration. A session's
  step never opens by itself; only a plan's `auto-open: host` may.
  **`--act` is `--step operator-act`** (control-tower phase 121, #182): an act only the operator does —
  a command to run (`--open-command`) or a click path (`--open-url`, `--step-line`). **`--due-when
  <ref>`** (any kind) says when it becomes due: until that watch ref lands the step is `upcoming` —
  listed under *Coming up*, unannounced, unreminded, its window not started — and the moment it lands
  (or the console finds it never can) the step is due, with ONE push, `NOW: <command>`; its proof
  landing clears it and resumes the phase that needed it. A plan declares the same act with a `due: <ref>` field on its `- **Human step:**`
  bullet — in a phase, or under `## Operator errands` for the plan itself.
  **Your turn's flags** (control-tower phase 130, #207): `--why REASON` — why only a person fits it,
  one of `scripts/turn.env`'s `WHY_PERSON` that the kind allows (`KIND_REASONS`; refused by name,
  exit 2, otherwise), and when it is absent the kind's default is recorded, marked inferred;
  `--guide FILE` — the full guide in the grammar of `viewer/shared/guide-grammar.js` (at most 20 steps
  and 24 KB, http(s) links only, every line through the secret screen), `--lang CODE` its language;
  `--effort MIN`, `--due ISO` (the same as `--due-when date:ISO`), `--unblocks PHASES` (`12,13`),
  `--window DURATION` (`90m`, `2h`, `3d`); `--proof-type probe|answer|judgement|attest|grant` and
  `--proof-words TEXT` — a step needs a proof ref or proof words unless its answer is the result, and
  `attest` is the person's word only when named (exit 2 otherwise); a decision's `--option
  ID=LABEL[::CONSEQUENCE]` (repeatable), `--recommended ID`, `--allow-decline` and `--decision-key KEY`
  (a `decision` step only: the `## Decisions` row its answer is written to, through `decisions.sh`,
  before the session is resumed — control-tower phase 140); `--tried TEXT` —
  what the session tried and how it failed. **The guard** runs at the door and again at ingest:
  exit 4 refuses a declared `permission`/`reserved` reason whose every guide command this run's own
  policy allows (the commands named — run them), and a `reach` with no `--tried`; a command a rule
  stops re-shapes the item as a `permission` item naming the wall; raised again with `--tried` it is
  accepted and marked overruled; the same item declared by another lane is ONE item with another
  waiter. A proof that already reads true raises nothing (exit 3).
  Its second
  shape, **`… <N> ruling --what … [--why …] [--kind ambiguity|deviation|deferral] [--cost-if-wrong …]
  [--for <M|next|all>]
  [--needs <key>] [--remember plan|global] [--by WHO]`**,
  appends one NDJSON line to the plan's ruling ledger (`$PE_RULINGS_FILE`, else
  `runs/<instance>/<slug>/rulings.ndjson`) — what a session DECIDED, as opposed to how it ended —
  stamped with its id (the digest `rulings.ts` derives) and, with `--needs`, the manifest KEY it
  answers (`decisionKey`; a key, never a blocker short form — a ruling is not a blocker).
  A ruling is never an outcome: nothing acts on it, it takes none of the outcome flags above, and
  declaring one does not declare the other. `--remember plan` promotes it at once — a `## Decisions`
  row through `decisions.sh promote` (source `ruling`, evidence the id) and an attributed ack in the
  ledger; `--remember global` asks the console that owns the repository to hold the words as its
  `policy.<key>` answer, through the same route the inbox's action uses, and exits 1 naming the
  Settings page when no console answers.
  Its third shape, **`… <N> verified --command TEXT --exit N [--in DIR]`**, records what the
  session's OWN §Verification proved: one NDJSON line to `$PE_PROOFS_FILE`, else
  `runs/<instance>/<slug>/proofs.ndjson`, naming the command (whitespace folded), its exit status and
  the WORKING tree it ran against — committed or not, computed in a private index copy, so the
  session's own index is never touched; `--in` names where the command ran (default: here), and
  outside a git working tree it exits 2. Like a ruling it is never an outcome. The console's pass
  after the session skips a command proven green at an equivalent tree — the same tree, or one where
  only paperwork (`docs/handoffs/**`, `.locks/**`, `CHANGELOG.md`) changed since — runs everything
  else, and journals any disagreement between the two verdicts (`phase.verify-disagreed`).
  Its fourth shape, **`… <N> progress --label TEXT --done N --of M`**, says how far the active task's
  long operation has got (a sweep, a batch): one line on the task channel (`$PE_TASKS_FILE`, else the
  console's inbox task file), journalled `phase.progress` on the task in progress at the next tool
  result, and drawn as that task's bar in the phase report. Never an outcome; `1 ≤ --of`,
  `--done ≤ --of`, and a malformed call exits 2 having written nothing.
  Its fifth shape, **`… <N> handled --what TEXT [--note TEXT] [--link REF]…`** (control-tower phase
  136), records what the session did INSTEAD of asking a person — a command it found it could run, a
  wall it worked around within its rights — as one row of Your turn's *handled* log: one line to
  `$PE_HANDLED_FILE`, else `handled-sessions.ndjson` under the console's instance state — the
  sessions' own file, never the console's `handled.ndjson`, and every line of it reads as a session's
  whatever it claims. Never an
  outcome. `--link` (at most 8) is held to a commit (`commit:<sha>`, a GitHub commit URL), a pull
  request (`pr:[owner/name]#<n>`, a GitHub pull URL), an issue (`issue:[owner/name]#<n>`, `#<n>`, a
  GitHub issue URL) or a journal line (`journal:<slug>/<runId>#<line>`); any other link, or a value
  shaped like a secret in any field, exits 2 having written nothing.
- `scripts/decisions.sh <slug> [--phase N] answer <key> --value TEXT | waive <key> --reason TEXT |
  promote --from-ruling <id> --key <key> | list` — the deterministic writer for the decision
  manifest's mutable twin, `docs/handoffs/<slug>/decisions.md`, which `--decisions` merges OVER the
  plan's own `## Decisions` rows (a twin row replaces the plan's whole row for its key; a row written
  with `--phase N` replaces both, for that phase). `answer` records a value (state `answered`, source
  `run`, keeping the row's `blocking` unless `--blocking yes|no` says otherwise); `waive` records that
  the decision does not apply, with the reason as its value; `promote` turns a ruling from the plan's
  ledger into a standing answer (source `ruling`, evidence `ruling <id>`); `list` is the engine's own
  read-back. `--by` names who (default `$PE_OWNER`, else user@host) and `--evidence` what backs the
  answer (default the script's own stamp). It writes exactly the shape the readers parse (the
  `qa-mode.sh` rule), atomically and
  idempotently, validates the key against `scripts/decisions.env` and the phase against the plan
  (exit 2), reads its own row back through `phase-graph.sh --decisions` (exit 1 if the file carries a
  row it did not write), and never touches git. Never edit the twin by hand.
- `scripts/gate-approve.sh <slug> <N> [--by WHO] [--note TEXT] [--revoke]` — record (or revoke) a gate
  clearance in `docs/handoffs/<slug>/gate-status.md` — the approval `--gate-status` honours for **every**
  gate kind. Written by the console's Gate card, by an AI session that verified an `ai` gate's conditions,
  or by hand; never hand-edit the table. Deliberately a separate file from `test-status.md` (whose
  existence flips QA gating on). Commit + push it so every clone sees the clearance.
- `scripts/repair-artefacts.sh <slug> [--apply] [--reset-not-started N[,N…]]` — deterministic repair
  of a plan's WORK-STATE artefacts, and the free first rung of the console's `plan-broken` ladder.
  Four disagreements that need no judgement: an `INDEX.md` status cell against the handoff it links
  to, a handoff's `depends_on:` against the plan graph, a lock whose lease has passed (released
  through `phase-lock.sh`, never `rm`), and a `blocked` handoff written by an attempt that never
  started — the last only for phases the caller NAMES, because a `blocked` marker is testimony
  unless the run knows nothing wrote it. **Reports by default; `--apply` makes the change.** Prints
  one JSON summary, is idempotent, and never edits a plan table or a handoff BODY — those repairs
  are judgement, and judgement is a session's or a person's. (Free of MONEY, not of permission:
  Phase Console drives it only under `--allow-writes`, since it rewrites work-state.)
- `scripts/close-plan.sh <slug> [--status abandoned|superseded|complete] [--reason "…"] [--reopen]
  [--force]` — the stored decision "does anyone still care?", which no board can compute. Sets the plan's
  `status:`, `closed:` and `closed_reason:`, and releases the plan's own phase locks. A closed plan stops
  reporting ready phases, boot prompts, batching and QA/stuck warnings while its board still renders and
  search still finds it. Idempotent; never touches git. Ask with `phase-graph.sh <slug> --closed`.
- **Three more ship and are not verbs you call.** `scripts/session-hook.sh` is a user-scope Claude Code
  hook (SessionStart / SessionEnd / Stop / Notification) that tells the console which sessions are live on
  this machine — installed from Settings ▸ Automation or `phase-console install-hooks`, always exits 0, and
  on SessionStart prints your own session id back to you with the `phase-lock.sh --session <id>` line and
  names the other live sessions in the repository. With no console answering it drops the event into the
  instance's inbox and, node present, drains it itself with `phase-console sessions ingest`
  (`PHASE_CONSOLE_HOOK_INGEST=0` leaves the inbox for the console).
  `scripts/instance.sh` and `scripts/scope.sh` are **sourced, never executed**: they are the bash halves of
  `viewer/shared/instances.mjs` (where a console's state directory is) and `viewer/shared/scope.js` (how a
  plan's Repos column is read), so the scripts answer identically with no console up and no node on PATH.
  Never edit one half alone — `viewer/test/engine-parity.test.ts` holds them together.
- Tests: `tests/run-tests.sh` runs the bats unit + integration suite (under bash 3.2). **QA is opt-in** —
  when a plan enables it (`**QA gate:** on`, `--qa`, or an existing `test-status.md`), a fresh-context QA
  subagent reviews each phase-finish (brief via `--qa-prompt`) and a `qa-full` pass runs at closeout; the
  discipline lives in `references/qa-method.md`. By default none of that runs — step 1's verification is
  the quality bar.
- **`start`** (→ `viewer/run`) — **Phase Console**, a local web app over the whole system: every plan's live
  board, the graph drawn as a route map, phase/handoff detail, copyable boot prompts, portfolio
  statistics and full-text search (`viewer/README.md`). It delegates every status claim to these same
  scripts. **With no flags it only reads.** Eight flags each unlock one act, and **all eight default off**:
  `--allow-writes` (scaffold plans/handoffs, record QA, take locks — it never commits or pushes, and
  never passes `--git`) · `--allow-run` (spawn unattended `claude -p` sessions that edit a repo for
  hours — this is what drives phases through these scripts by itself, and what the outcome protocol
  above exists for) · `--allow-terminal` (a real shell) · `--allow-agent` (interactive sessions and the
  plan wizard) · `--allow-accounts` (register Claude accounts, pick one per run, switch mid-run —
  *reading* the usage meters needs no flag) · `--allow-webhooks` (POST every announcement to URLs
  you register — Slack, Discord, Telegram, your own relay; one of the two that send anything off the
  machine, and *reading* the destination list needs none) · `--allow-publish` (push a finished phase's
  `pe/*` branch — never a trunk, never with force — only where the plan's `permission.destructive` row
  allows it; off means the console pushes nothing — the other of the two that reach outward) ·
  `--allow-mcp` (register MCP servers, hold their credentials, attach them to plans and phases —
  *reading* the registry needs no flag).
  Shut down is deliberately not behind a flag. One flag switches something OFF rather than on: **`--no-converge`**
  stops the convergence loop's automatic triggers (boot / docs change / timer / the minute after a halt);
  the operator's own *Recover & continue* press converges regardless. `phase-console doctor [instance]`
  runs the run-start prelude's probes and the machine checks — the Claude CLI against the relay floor,
  `gh auth status`, the hooks — with no plan in front of them, and exits 1 naming the first blocking
  row; `phase-console sessions ingest [instance]` drains the session-presence inbox with no console up. What
  that loop does, and everything else the console wraps around a session, is
  `references/console-surface.md`.

- **For maintainers of this repository, never for a session working a plan:** `scripts/gates.sh
  [--quick] [--list] [--ci] [--build] [--keep-going] [--install-hook] [--help]` — the release gate, on
  this machine (there is no CI): bash engine, engine parity, the server and client suites, both
  typechecks, lint, format, the build gate, the real-browser tour (`viewer/e2e`), the scrub and the
  tarball assertions, in that order;
  `--quick` is the cheap subset, `--list` prints the plan, `--install-hook` points the clone's
  `core.hooksPath` at `scripts/git-hooks/` so a push to `main` or a tag runs the full matrix and any
  other ref the quick one (`PHASE_CONSOLE_SKIP_GATES=1` skips, and says so).
  `docs/releasing.md` is the contract.

## Guardrails
The load-bearing rules a session must not get wrong; full rationale in `references/conventions.md` +
`references/sizing.md`.
- **Right-size; don't reflexively split.** One coherent chunk per session, sized to the running model's
  budget (~0.2 × window in weight) by the measured model; split any phase that won't fit alone. The
  console runs one phase per session; batch only by hand — ready phases, sequential or siblings, that fit
  together. A session boundary is earned by budget, gate, or model switch — never tidiness. (sizing.md;
  conventions §Session sizing)
- **Keep the cache warm; offload to `Agent` subagents.** No model/effort switch or `/compact` mid-phase
  (open a fresh session instead). Push broad search, multi-file reads, and independent verification to
  `Agent` subagents — they return only a summary, so the tokens stay out of your session (the biggest
  in-session lever for cost *and* rot); don't over-delegate a lone read or edit. (conventions §Session sizing)
- **`git log -1` is the truth for shas.** Never carry a sha from memory into a handoff; stale "uncommitted"
  claims are the #1 handoff defect. (conventions §Commits)
- **Branches off by default** — commit to the current branch; only on explicit request (or a
  console-declared run branch named in the boot prompt), one branch for the whole plan, every phase on
  it. (conventions §Branches)
- **The handoff is the contract.** If a fresh session can't start cold from it, fix the handoff; link to the
  plan, never re-list the roadmap. (conventions §Memory, §Docs layout)
- **Record the decisions the plan did not make for you** — `phase-outcome.sh <slug> <N> ruling …`, one
  line per judgement call, nothing acts on it. The handoff carries the same words for a person. And
  the decisions it DID make live in its `## Decisions` manifest: a block you cannot get past is
  declared by key (`blocked --needs <key>`), never asked in prose — prose reaches nobody.
  (conventions §Rulings)
- **`phase-graph.sh` is the truth for done/ready/next** — never infer from phase numbers or a remembered
  cursor; "finished" means the board shows **every** phase `done`. (conventions §Status source of truth)
- **One session per phase — check scope, then claim the lock** before building (`conflicts` then `claim
  --scope`); if it names a live session, ask the user how to proceed. (conventions §Locking)
- **Scope decides concurrency — one session per working *tree*.** Never two live sessions whose scopes
  intersect; same repo ⇒ serialized; `all` ⇒ exclusive against every unqualified claim; disjoint ⇒ parallel. **Never `git stash`** to hand
  work across sessions — commit (a WIP commit if needed) instead. (conventions §Scoped concurrency)
- **QA is opt-in, and the plan says whether it gates.** No QA subagent runs unless the plan enables it
  (`--qa-mode` says which regime applies). With QA `on`, a dependent is `ready` only when its deps are
  `done` **and** QA `pass`/`waived` — a `fail` **and a still-`pending` row hold every dependent equally**,
  which is why finishing a phase under QA-on means dispatching the verdict, not just writing the handoff
  (the boot prompt says so). Three exits: re-QA to `pass`/`waived`; **`**QA gate:** off` in §Session
  budget**, which releases the gate for the whole plan (the verdicts stay recorded and reported, they
  simply stop holding dependents); or **closing the plan** (`close-plan.sh`), which retires the report
  without a re-QA because a closed plan claims nothing about progress, and reopening restores the gate
  untouched. Anything that CREATES `test-status.md` backfills already-complete phases as `waived`, so
  turning QA on mid-plan never retroactively un-verifies finished work. **One phase can opt out (or
  in) on its own** with `- **QA:** off|on` in its §Phase section — the phase's word beats the plan's,
  silence inherits, and `--qa-mode <N>` reports which level answered. (conventions §QA gating)
- **Gates are categorized; approval is the one door.** An `ai` gate is the fresh session's FIRST task —
  verify each condition, do the work to make failing ones true, record it (`gate-approve.sh`), then
  implement; a `manual` (human) gate stops everything until a person does the numbered steps and approves
  (console Gate card or `gate-approve.sh`); auto checks (`date`/`phase`/…) answer by themselves. An
  approval clears ANY kind; `--revoke` restores the gate. Never implement past an unapproved human gate.
  **A gate the plan marks `manual` is a person's, whatever the `gates` row says** (control-tower phase
  107, #174): never delegated, `gate-approve.sh` refuses it from a session or an `ai-*` approver, and
  `--gate-status` honours its approval only when a person's door wrote it (the console's Gate card or a
  person's own terminal — the `Door` column, never the `By` text). Declare `needs-human --needs gates`
  and stop. Delegation (`gates: delegated`) reaches only a human-family verdict on a gate the plan did
  not mark manual — an overdue `deadline` — where the boot prompt briefs you to verify each condition
  against evidence you can cite, or STOP naming the one you could not. Never approve a gate you cannot
  cite evidence for. (plan-format §Gates; conventions §Gates)
- **Validate before you trust the board** — `scripts/validate.sh <slug>` catches malformed rows, undefined
  deps, cycles, a table whose columns cannot be located by name, cells it could not believe, an open
  phase with nothing runnable to verify it, a gated heading with no `Gate-check` (or an unknown type),
  a decision row nobody owes, and inconsistent handoffs; a silently-wrong board is the worst failure.
- **Skill vs work-state split.** The skill lives in its own install (a plugin, or a clone under
  `~/.claude*/skills/`); plans/handoffs/reports/test-status/locks are work-state in the project repo's
  `docs/`. Never write work-state into the skill folder. (conventions §Docs layout & repo split)
