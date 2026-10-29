# Mode 2 — `phase-start` (begin or continue a phase in a fresh session)

**First:** read your boot prompt whole — it carries the scope, the decision rows, the notes and the
commands for THIS phase — then run `scripts/phase-graph.sh <slug> --section <N>` for your phase's plan
section. Work the steps below in order; each ends on the condition stated in bold.

Contents: Step 1 bootstrap from disk · Step 2 readiness, budget, scope and the lock · Step 3 the gate ·
Step 4 the task list · Step 5 implement · Resuming an interrupted phase · It's working if

## Step 1 — Bootstrap from disk only

A session the console supervises starts with its **brief** at the top of its context — the presence
hook printed `phase-graph.sh <slug> --brief N`: the section head, the decisions still open, the notes,
the scope and lock lines, the previous handoff's summary, the errands and the memory index. Start from
it; the reads below fill in what it points at. No brief there? Print it with the same command.

1. `scripts/handoff-status.sh <slug>` — the INDEX, per-file status **and** the live DAG board: what is
   done, what this phase depends on, whether it is genuinely `ready`.
2. Read this phase's **dependency** handoffs (its `depends_on`, not merely the previous number), the
   plan's §Phase N and §Session budget (`--section N` prints both), and the plan's memory
   (`docs/memory/<slug>/index.md`, else memory `project_<slug>`). A
   dependency handoff's `▶ Start next phase(s)` section is a pointer to the composer (#338) — your boot
   prompt already IS what it composes. In an older handoff with prompts spliced in, read the shared boot
   and **your own phase's block only — never a sibling's**, which is another session's prompt (#115).
3. **The decision rows** — `scripts/phase-graph.sh <slug> --decisions <N>` (the boot prompt prints the
   open ones). An `outstanding` row is a decision nobody has answered; a `blocked` or `needs-human` you
   declare names its key with `--needs`.
4. **Your notes** — `scripts/phase-graph.sh <slug> --notes <N>`, which the boot prompt carries as
   `### Notes from earlier phases`: what finished phases deliberately left for THIS one. It is the only
   channel that reaches a phase before it starts; say in your handoff what became of each.
5. **Skills and MCP servers.** Invoke every skill named on §Session budget's `Skills (every session):`
   line before implementing. Confirm the plan's MCP servers are connected (`/mcp`, or `claude mcp
   list`); one that needs authentication is the operator's to sign in — stop and ask. **Unattended**,
   your boot prompt names any server the console could not reach: do the work that does not depend on
   it and record what you could not do, naming the server, under **Outstanding** as an operator errand.
   Only when the phase cannot proceed at all, declare `phase-outcome.sh <slug> <N> needs-human --needs
   mcp --reason "mcp <name> needs sign-in"`, hand off `blocked`, and stop.

**Done when** you can state the phase's goal, its exit criteria and its scope from what you read. If
the disk is not enough, the previous handoff was deficient — note the gap so it gets fixed.

## Step 2 — Readiness, budget, scope, then the lock

- **Readiness.** A phase the board shows `waiting` has a dependency that is not done: stop and say so
  rather than build on an unfinished base. Rely on the board, not on phase numbers.
- **Budget.** Compare §Session budget's target model with the model you are actually running; if they
  differ, recompute the budget from `references/sizing.md` (and, by hand, re-batch).
- **Scope, then claim** (the concurrency guard). `git pull`, read the phase's scope (`--repos <N>`; the
  boot prompt states it), then:

  ```
  scripts/phase-lock.sh <slug> conflicts <N> --scope "<csv>" --git   # 0 = clear, 1 = collides
  scripts/phase-lock.sh <slug> claim <N> --scope "<csv>" --git
  ```

  Under an autopilot (`$PE_LOCK_MIRROR=console`) `--git` is skipped: the calls are file-only and the
  console mirrors the lock outside your turn. `--owner` defaults to `$PE_OWNER` (else `<user>@<host>`);
  pass `--owner "<account>/<session>"` only when driving by hand as one of several people. `--session`
  is read from `$PE_SESSION_ID` / `$CLAUDE_CODE_SESSION_ID`, so the console can show the lock on the
  Pulse and release it the moment the session ends. **`--here`** derives BOTH qualification dimensions
  from your cwd — the branch this checkout stands on and its toplevel path (`--branch <name>` and
  `--worktree <path>` state them; `$PE_BRANCH`/`$PE_WORKTREE` are read automatically). The PAIR is what
  changes an answer: two claims whose scopes intersect are nevertheless disjoint **iff both declare a
  branch AND a working tree and both differ**; a claim unqualified in either dimension collides with
  everything. Declare only the place you are actually working.

  `conflicts` looks across **every plan**, because a working tree does not know which plan asked for
  it. If it names a live session — or `claim` reports the phase already held — **stop and ask the
  user**: wait, stop that session, take over (`--force`), or pick a ready phase with a disjoint scope.
  **Unattended**, declare `phase-outcome.sh <slug> <N> blocked --needs lock --reason "lock held by
  <owner>" --watch lock:<holder-slug>/<holder-phase>` — the HOLDER's lock as `conflicts` named it (your
  own phase's watch is refused, exit 2) — hand off `in-progress` if you already did work, and stop.
- **A checkout of your own** — a QA round or a review beside a live build: `scripts/phase-lane.sh
  <slug> create <N> [--qa <round>] [--detach] [--repo <token>] [--owner <id>]` makes one under
  `<root>/.worktrees/hand/` on `pe/<slug>-p<N>[-qa<round>]` (or detached), locked while it lives, and
  prints the `claim … --here` line for it; `merge` folds it onto `pe/<slug>` and `remove [--force]`
  takes it away (`list` shows every hand lane). **Under a console run** a session takes at most a
  review tree (`--detach`) or a QA round's (`--qa`): the console owns the run's trees and branches, and
  the script refuses a build lane, a `merge`, a `pe/<slug>` checkout or `git switch -c`.

**Done when** `claim` succeeded on a clear scope. The lock auto-expires (lease) and is released at
phase-finish (`references/conventions.md` §Locking, §Scoped concurrency).

## Step 3 — The gate (GATED phases only, before implementing)

Run `scripts/phase-graph.sh <slug> --gate-status <N>` (the boot prompt states the same duty):

- `clear …` (including `clear (approved by …)`) → proceed.
- `ai: …` → **the gate is yours to clear.** Verify each condition in the plan's Gates bullet for real;
  where one does not hold yet, DO THE WORK to make it true. Then record it — `bash
  scripts/gate-approve.sh <slug> <N> --by ai-session --note "<one line of evidence>"` — commit and push
  `docs/handoffs/<slug>/gate-status.md`, and continue. A condition genuinely out of reach (missing
  credentials, a third party): STOP, report exactly what is missing and what you verified, and hand the
  gate to the operator.
- `unevaluated: …` → **a `cmd` gate the read declined to execute**, since running a command written in
  a plan is remote code execution by document. Read the command the verdict prints; if you are willing
  to run it, evaluate it yourself with `PHASE_EXEC_GATES=1 scripts/phase-graph.sh <slug> --gate-status
  <N>` and treat that verdict. It is yours to evaluate, not the operator's: the same gate answers
  `clear (cmd ok)` for the autopilot.
- `manual: …` / `blocked: …` / `OVERDUE: …` → **STOP.** Tell the operator what the gate needs and where
  to clear it: Phase Console → plan → phase → **Gate card** (Approve), or `scripts/gate-approve.sh
  <slug> <N> --by "<who>"`. A gate the plan marks `manual` is a person's whatever the `gates` row says:
  `gate-approve.sh` refuses it from a session. **Unattended**, declare `phase-outcome.sh <slug> <N>
  needs-human --needs gates --reason "<gate> needs the operator"` and stop. Delegation (`gates:
  delegated`) reaches only a human-family verdict on a gate the plan did not mark manual (an overdue
  `deadline`): verify each condition against evidence you can cite, or STOP naming the one you could
  not.

**Done when** the gate reads `clear`.

## Step 4 — Publish the task list

Use `scripts/phase-tasks.sh`: reset (which drops the previous phase's), one `create` per task with
subjects prefixed **`pN.taskM`**, and an `update` as each starts and finishes:

```bash
bash <skill-root>/scripts/phase-tasks.sh <slug> <N> reset
bash <skill-root>/scripts/phase-tasks.sh <slug> <N> create --subject "pN.task1 — wire endpoint"
bash <skill-root>/scripts/phase-tasks.sh <slug> <N> update --id pN.task1 --status in_progress
bash <skill-root>/scripts/phase-tasks.sh <slug> <N> update --id pN.task1 --status completed
```

An unnamed `create` is numbered `pN.task1`, `pN.task2` … in order, so an update needs nothing read
back. Phase Console renders the list live as **"What it is doing"** and folds it into the run record.
The CLI stopped providing `TodoWrite`/`TaskCreate`/`TaskUpdate` to sessions in August 2026 — this script
is the list; a harness that still has them may use them too. Keep the roadmap in the plan.

**Done when** the list names every task to the exit criteria and the first is `in_progress`.

## Step 5 — Implement to the exit criteria

Offload high-token exploration and verification to `Agent` subagents (they return summaries). Under
the console, `Explore`, `log-reader` and `docs-reader` run read-only on the plan's subagent model
(`**Subagent model:**`), so side work costs less than your own turns. Your Bash output is read back
up to `BASH_MAX_OUTPUT_LENGTH` characters, and the console's own scripts print a summary and a log
path, so read the log rather than re-running for its tail.

Two guards hold while you work (`references/console-surface.md`): the baselines, ratchets, known reds,
quarantine and snapshots are never writable, and a test file is deleted only when your phase says
`- **May delete tests:** yes`. When you finish, the Stop hook runs your fast lines once and holds a
red exit, naming the failing ids.

Four records keep the work legible:

- **A ruling whenever the plan did not decide for you** — an instruction with two readings, a
  departure, something in scope you deliberately left:

  ```
  bash scripts/phase-outcome.sh <slug> <N> ruling --kind ambiguity|deviation|deferral \
    --what "<what you decided>" --why "<why>" [--cost-if-wrong "<what it costs if this was wrong>"] \
    [--for <M|next|all>] [--needs <decision key>] [--remember plan|global]
  ```

  One NDJSON line; nothing acts on it, it parks nothing and ends no turn. Name the decision key it
  answers (`--needs <key>`) whenever there is one: `--remember plan` writes it as a `## Decisions` row
  at once, `--remember global` asks the owning console to make it its `policy.<key>` answer.
  A deferral's `--for` is what phase M's own boot prompt will carry (`references/conventions.md`
  §Rulings).
- **A person's turn is a human step, not prose.** When the work needs an act only a person can do — a sign-in
  that opens a browser, a device code, a secret only they hold, money, terms, a decision the plan left
  open, hands at a device, a system you cannot reach, somebody else's approval — declare it typed, hand
  off `in-progress`, and stop:

  ```
  bash scripts/phase-outcome.sh <slug> <N> needs-human --needs credential \
    --step browser-login --title "Sign the gh CLI in to the acme org" --why identity \
    --guide <guide file> --open-command "gh auth login" --proof 'cmd:"gh auth status"'
  ```

  Leave the sign-in to the person: in a `-p` session it hangs on a browser nobody sees, and the console
  refuses it before it runs. Values stay out of flags — the script refuses a code, a token or a
  password, and the item tells the person where to store it. The item appears on **Your turn**
  (`#/turn`); the console checks it when the person presses *I've done this — check* and resumes THIS
  session with what was proven. Give the reason (`--why`, one of ten, `scripts/turn.env`), write the
  guide (`--guide`, in the plan's `**Guide language:**`, passed as `--lang`), state the proof (`--proof`
  a ref, `--proof-words`, or `--proof-type attest` by name; a decision's answer is its own proof:
  `--option`, `--recommended`, `--allow-decline`, `--decision-key`). Run yourself what your policy lets
  you run: the guard refuses with **exit 4** a `permission`, `reserved` or `reach` reason whose every
  guide command this run allows, and a `reach` with no `--tried`; declare again with `--tried "<what you
  ran and how it failed>"` when you did. A proof that already holds raises nothing (exit 3: carry on).
  Record what you handled yourself with `phase-outcome.sh <slug> <N> handled --what "<what>" [--link
  commit:<sha>]`. The grammar, a template per kind and the guard's rules: `references/turn.md`.
- **What you proved** — `phase-outcome.sh <slug> <N> verified --command "<the plan's command>" --exit
  <status>` for each §Verification line you run, red ones too (Mode 3 step 1).

**Done when** every exit criterion holds — then switch to Mode 3 (`references/mode-phase-finish.md`).


## Resuming an interrupted phase

If the board shows this phase `in-progress` or `stuck` and the lock is yours or stale, you are
RESUMING (a died console, a usage-limit stop, a manual pause, a session that declared `partial`) —
recovery, not a restart. Read `git status` and `git diff` FIRST: anything uncommitted is the interrupted
session's work, so keep it in the tree and build on it (a `git stash`, `git checkout --` or `git reset`
would erase it). Re-claim the lock (`--force` only when `status` says the lease expired), then continue
to the exit criteria. A usage-limit stop says nothing about the work.

The autopilot drives this path by itself and climbs a bounded **ladder** of remediations. A phase it
finds unfinished boards with a **resume brief** appended to the boot prompt — the handoff's status, the
uncommitted paths, the last verification, the last session's words — or continues its own session with
the same instruction; a phase whose handoff reads `blocked` gets ONE **unblock brief**, explicitly
allowed to do the unblocking work. The brief is the supervisor's snapshot; the repository wins. A resume
usually continues the phase's OWN session — but only when the phase ever announced one, and a session is resumed only while it is worth resuming: one that ended at ≥ 250k tokens of context and is cold (idle ≥ 55 min) or under another account, that declared `partial --reason budget|context`, or that the console checkpointed is boarded FRESH with the resume brief instead — and so, at any size, is one that ended at or past **0.55×** of its window (the 0.6× wrap-up line less `RESUME_WRAPUP_MARGIN`). So the tree, the handoff and the journal are the memory that survives; the transcript is not.
A resume brief may quote what this phase's last resume cost, in the resumed session's own `SessionStart`
words (how stale, how many tokens re-sent, the CLI's estimate of the cache write). A deferred person's
step is the one resume that does NOT read as an interruption: the call you made runs again with the
answer (`references/turn.md` §A deferred step).

An operator can change the run under you — model, effort, budgets, skills, MCP servers, even
`reviewEachPhase`, which inserts a fresh reviewer over your diff at phase-finish whose
`requested-changes` holds your dependents. If the board does not move after a green finish, look for a
review before looking for a bug.

## It's working if

- the session started from disk alone and named its goal, exit criteria and scope;
- `claim` succeeded on a clear scope before the first edit;
- a gated phase's gate read `clear` before implementing;
- the task list is published and current;
- every judgement call has a ruling, every act only a person can do a typed human step;
- a resumed phase kept the previous attempt's uncommitted work.
