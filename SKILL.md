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
  version: 9.0.0
---

# Phased Execution

Run large work as a sequence of **right-sized sessions**, each **fully bootstrapped from disk**, so the
next one starts cold. The point is twofold: **bound cost** and **protect output quality** — and **the
console runs one phase per session; batch only by hand** (the forecast's unit is `1 phase ≥ 1 session`).
A phase too big for one session is **split**.

**Sizing is the core idea — `references/sizing.md` is the source of truth.** A warm session's cost is
roughly linear (the prefix is cached), so the levers are **context rot**, **cache-busting events**
(model/effort switch, `/compact`, a >5-min idle gap) and **bootstrap overhead**. The rule: **one
coherent, right-sized chunk of work per session.** What a session holds is **measured** — a floor every
session pays plus a slope × the phase's weight — and a session boundary is earned by a spent budget, an
external gate or a model switch.

## Five artifacts, one job each

- **Plan** → `docs/plans/<slug>.md` — the blueprint: every phase, the `## Phase graph`, the session
  budget, self-contained per-phase detail, end-to-end verification (`references/plan-format.md`).
- **Handoff** → `docs/handoffs/<slug>/phase-NN-<title>.md` (+ `INDEX.md`) — the baton for the NEXT
  session, written at the end of each phase (`references/handoff-format.md`).
- **Memory** → `project_<slug>` in the memory index — durable cross-session facts.
- **QA status (optional, only when QA is on)** → `docs/handoffs/<slug>/test-status.md`. **QA is opt-in
  and off by default**; its existence turns on **QA gating** (`references/qa-method.md`).
- **Gate approvals (optional)** → `docs/handoffs/<slug>/gate-status.md`, written by
  `scripts/gate-approve.sh` — a separate file, so an approval never flips QA gating on.

All live in the project repo under `docs/`; the skill lives wherever it was installed. The plan holds
the roadmap, the handoff the next session's state, memory the durable facts — each links to the others.

## Phases are a DAG

Each phase declares the phases that must finish first. **`scripts/phase-graph.sh <slug>`** reads the
`## Phase graph` table and each handoff's `status:` and sorts every phase into five **board buckets** —
`done | in-progress | stuck | ready | waiting` — where **ready = not started and every dependency
done**, and `stuck` is a handoff that says `blocked`. A handoff's status is one of four words,
**`complete | in-progress | blocked | pending`**. Readiness comes from the done-*set*, so deep chains may finish
before their siblings; "finished" means **every** phase `done`. Ask the engine for the cursor.

**Scope decides concurrency** — the repos a phase touches, from the plan's **Repos** column: never two
live sessions whose scopes intersect; same repo ⇒ serialized; `all` ⇒ exclusive against every
unqualified claim; disjoint ⇒ parallel (`references/conventions.md` §Scoped concurrency).

## Under Phase Console — the contract

A phase may be driven by a person or spawned by **Phase Console**'s runner as an unattended `claude -p`
session. The procedure is the same; the machinery around it is in `references/console-surface.md`.

- **You are supervised if `$PE_OUTCOME_FILE` is set.** Then `phase-outcome.sh`, `phase-tasks.sh` and the
  ruling ledger write where the runner reads. `$PE_OWNER` / `$PE_SESSION_ID` are your lock identity;
  keep `--owner` at its default so the supervisor can release your lock.
- **The Stop hook can refuse your exit, twice.** Ending a turn with the phase not `done` and no declared
  outcome is blocked, with the instruction handed back; so is an exit while a background subagent or
  monitor you launched still runs — wait for it in one bounded foreground call (`TaskOutput`, `block:
  true`, at most ten minutes) or stop it with `TaskStop` and name it under **Outstanding**. Finishing
  with red fast lines is held once, with the failing ids named (`references/console-surface.md`).
- **A denied tool is a decision, not a failure.** The run's permission profile (`guarded` · `trusted` · `bypass`)
  moves what a person is asked about; the `deny` wall is the same in all three. Do the work that needs
  no denied tool and record the rest under **Outstanding**. When the phase cannot proceed, declare the
  wall — `phase-outcome.sh <slug> <N> blocked --needs permission --rule "<rule>" --command "<command>"`
  — and stop; a person answers it with a grant at a scope (`references/turn.md` §A permission block).
  **An act only the RUN can take** — relaunch isolated, switch account, raise the budget, stop, hold —
  is `blocked --needs run --run-act <act>` (`isolate` · `switch-account` · `raise-budget` · `stop` ·
  `hold`). A press on any console's authority route or verb from a session is denied (`console-forge`).
- **Somebody else's clock is waited on outside the turn.** A call that waits on a clock outside the
  session — `gh run watch`, `sleep 600`, `until gh run view …; do sleep …; done` — is **denied before
  it runs**, on every profile, with this procedure as the reason. A wait on a job you started yourself
  is allowed.

  **Waiting without polling.** Every tool call re-reads your whole context, so a status check costs as
  much as an edit. Never make two status checks in a row (`ListAgents`, `TaskOutput`, `date`,
  `tail`/`grep`/`cat` of a log, `pgrep`, `gh run view`), and never check on a subagent you dispatched.
  1. **Work remains** → keep working; a background result arrives by itself as a `<task-notification>`.
  2. **You need a subagent's answer** (a reviewer's verdict) → dispatch the `Agent` in the FOREGROUND;
     the call returns with the answer and costs nothing while it runs.
  3. **You need your own shell job and nothing else is left** → wait in ONE foreground call bounded by
     the Bash timeout: `until <probe>; do sleep 10; done` with `timeout: 600000`, at most once per ten
     minutes. The console allows a wait on your own job; it refuses one on somebody else's clock.
     Never wait on `pgrep -f` text that is in your own command — the loop's shell matches it and the
     wait never ends; wait on the job's pid (`while kill -0 <pid>`) or a sentinel it writes
     (`until [ -f x.exit ]`).
  4. **Only subagents or monitors running in the background are left** → end your turn; the session
     stays alive and their notification wakes you. They are stopped ten minutes after your turn ends —
     dispatch a subagent that may take longer in the FOREGROUND. A background SHELL dies when your turn
     ends — never end it with one you still need.
  5. **Somebody else's clock** (CI, a deploy, a person) → commit, hand off `in-progress`,
     `phase-outcome.sh <slug> <N> waiting-external --wait-minutes <M> --watch <ref>`, stop. **Name the
     ref** (the schemes: `phase-outcome.sh --help`): a sibling phase's finish is
     `--watch phase:<slug>/<N>`, your own red lines going green again `--watch verify:<slug>/<N>`, a
     job on another machine `--watch unit:<host>/<unit>`, and a `date:` beside a live ref is only its
     backstop. Exit 3 means a ref has ALREADY landed: nothing parked, carry on.

  **A wait on your own job runs on the console's clock too.** One still open after 10 minutes draws one
  nudge, and one still open at 45 minutes parks the phase in the console's own name (`stallLocalJobMs`;
  it spends none of your waits) — so never start a long suite in the background and wait on it in-turn.
  Record the proofs you already have, leave the long lines to §Verification (the console runs those
  itself), and when a wait is unavoidable declare `waiting-external` with a `--watch` ref BEFORE 45
  minutes. **§Verification runs on a clock too:** the console cuts each command at 30 minutes unless the
  plan names a longer limit or the line's measured history earns one — so a line that needs longer, a
  device sweep or a suite slow under load, says so on its phase: `- **Verify timeout:** 90m`.
- **The outcome verbs.** `phase-outcome.sh <slug> <N>` takes one status: `complete`,
  `waiting-external` (a clock you do not control), `blocked` and `needs-human` (both need `--needs
  <key>` — a `## Decisions` key or `credential`, `permission`, `gate`, `external`, `lock`, `run`),
  `partial` (work remains: `--reason budget|context|other`, and the supervisor resumes you) and
  `no-defect` (sent to mend something already mended). Four more shapes are records, never outcomes:
  `ruling` (a judgement call), `verified` (a §Verification line you ran), `progress` and `handled`.
  `phase-outcome.sh --help` prints every flag.
- **A question is answered by the console.** With the run's relay armed (`relay: last-resort`) a person
  gets 60 s, then a rule or the sole `(Recommended)` option answers. With no relay the plan's
  `ambiguity` row answers: `ruling` — decide, record `ruling --kind ambiguity`, carry on; `ask`/`halt`
  — `needs-human --needs ambiguity`, stop. Sessions the relay does not cover run with
  `--permission-prompts none`, and a call that would prompt is denied.
- **One phase per session, and the console watches your context.** At **0.6×** of your model's window
  you are told once to wrap up — commit, hand off `in-progress`, `partial --reason context`, stop — and
  at **0.8×** the console checkpoints the session itself. The next attempt boards FRESH from the
  handoff, and so does one that ended at or past **0.55×** (the resume rules: `references/mode-phase-start.md`).
- **The run's checkout is the console's.** A repository your scope does not name is an EMPTY directory
  in the run tree: read it at the shared root, read-only. Clone nothing into the run tree.
- **A message can arrive mid-phase**: *ask* (answer, carry on) or *steer* (do this differently — it
  outranks the plan for the rest of the phase; record a `ruling --kind deviation`).

## Modes

Pick the mode that matches the situation, announce it ("Using phased-execution: <mode>"), and **read
its file whole before acting** — each is under 20 KB and holds that mode's every step.

- **`plan` — no plan exists yet → `references/mode-plan.md`.** Set the session budget, elicit the
  decision manifest one question at a time, author the fewest phases that each fit one session, lint
  the graph, commit, then implement the root phase.
- **`phase-start` — begin or continue a phase → `references/mode-phase-start.md`.** Bootstrap from disk
  (your boot prompt, your phase's `--section N`, dependency handoffs, memory), confirm readiness, check
  scope and claim the lock, clear an `ai` gate, publish the task list, implement to the exit criteria.
- **`phase-finish` — the phase is done → `references/mode-phase-finish.md`.** Verify every §Verification
  line green, commit, write the handoff (`complete` last), leave addressed notes, update memory, stop.

## The scripts

Run every helper as `bash "$PE_SCRIPTS/<script>"` under a console (the boot prompt names it, with
`<skill-root>/scripts` as the hand default), and write it the same way in a handoff. **What each script
does and every flag it takes: `references/scripts.md`.** The engine prints its own catalogue:
`phase-graph.sh --help` (every mode, one line), `--explain <F-code>` (one lint's paragraph) and
`--section N` (your phase, its graph row and the §Session budget lines that bind it).
`scripts/skill-api.env` stamps the interface (`PE_API`, `PE_API_MIN`); a run refuses to start when the
console's and the skill's do not meet, naming the half to update.

## Guardrails

- **Right-size.** One coherent chunk per session by the measured model; a phase that does not fit one
  session is two phases. A boundary is earned by budget, gate or model switch (`references/sizing.md`).
- **Keep the cache warm; offload to `Agent` subagents.** Hold model and effort for the whole phase (a
  switch or `/compact` opens a fresh session instead). Broad search, multi-file reads and independent
  verification go to subagents, which return a summary.
- **`git log -1` is the truth for shas.** Copy a sha from the log, and only from the log.
- **Branches.** Commit to the current branch, or the run branch the boot prompt names; one branch per
  plan when the user asks for one (`references/conventions.md` §Branches).
- **The handoff is the contract.** A fresh session must start cold from it; it links to the plan and
  lists no roadmap.
- **Record the decisions the plan did not make** — `phase-outcome.sh <slug> <N> ruling …`, one line per
  judgement call. A block you cannot get past is declared by key (`blocked --needs <key>`).
- **`phase-graph.sh` is the truth for done/ready/next**; "finished" means the board shows **every**
  phase `done`.
- **One session per working tree.** Check scope, then claim the lock (`phase-lock.sh … conflicts`, then
  `claim --scope`); a live holder means stop and ask. Hand work across sessions by committing (a WIP
  commit if needed) — the stash is shared.
- **QA gates only when the plan turns it on** (`--qa-mode`); then a dependent waits for a
  `pass`/`waived` verdict.
- **Gates are categorized; approval is the one door.** An `ai` gate is the fresh session's first task;
  a `manual` gate is a person's, cleared on the console's Gate card; auto checks answer by themselves.
- **Validate before you trust the board** — `scripts/validate.sh <slug>`.
- **Skill vs work-state.** Plans, handoffs, reports, test-status and locks are work-state in the project
  repo's `docs/`; the skill folder holds the skill alone.
