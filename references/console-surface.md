# Console surface — what a supervised session runs inside

Contents: What a supervised session is · The convergence loop · The watch clock ·
The Stop hook · Permission profiles and the deny wall · Never wait inside a turn ·
Questions · Run settings ·
The remediation ladder · Freeze and thaw · Talking to a running phase ·
What happens around your phase · Session terminals · Reading the console's API ·
Where the state lives

SKILL.md tells a session how to execute a phase. This file tells it what is executing it — the
machinery Phase Console wraps around a `claude -p` session when a run drives phases by itself
(`--allow-run`). None of it is optional knowledge: a session that does not know the Stop hook exists
reads its own refusal to exit as a harness bug; one that does not know an operator can change its
model mid-run writes a handoff that claims the wrong one.

Everything here is **absent when a person runs a phase by hand** — the scripts behave identically,
there is simply nobody driving them. The operator-facing account of the same machinery is
`docs/loop.md` (the autopilot) and `docs/controls.md` (the buttons); this is the session's half.

## What a supervised session is

A supervised phase is `claude -p` spawned by the console's runner with four things injected into its
environment that a hand-run session does not have:

| Variable | What it is |
|---|---|
| `PE_OUTCOME_FILE` | Where `scripts/phase-outcome.sh` writes; read once and consumed |
| `PE_TASKS_FILE` | Where `scripts/phase-tasks.sh` appends; tailed into the run record |
| `PE_RULINGS_FILE` | The plan's ruling ledger, append-only |
| `PE_OWNER` / `PE_SESSION_ID` | The lock identity — **never override `--owner`**, or the supervisor cannot release your lock |

`PE_SCOPE` and `PE_WORKTREE` may also be set; `scripts/phase-lock.sh` reads all of them by itself.
The presence of `PE_OUTCOME_FILE` is the reliable test for "am I supervised" — the scripts fall back
to the console's inbox without it, which is how a hand-driven session's declaration still reaches a
running console.

Two consequences the contract in SKILL.md's boot prompt spells out and that are worth restating
here: **what survives the end of your turn is narrow** — a background shell is stopped within
seconds and `ScheduleWakeup` wakes nothing, while an `Agent` or `Monitor` running in the background keeps the process
alive (for the CLI's background-wait ceiling, ten minutes) and its completion starts your next turn;
with nothing outstanding the process exits — and **your deliverable is the handoff** — a clean exit
with no handoff and no declared outcome reads as a failed phase, not as a quiet success.

Two more facts about the process itself. **It runs under two caps it did not choose.** Every session
the console spawns carries `--max-budget-usd` and `--max-turns`, set per session by `capsFor`
(`viewer/server/runner/session-record.ts`): a phase session gets the run's `phaseBudgetUsd`, or — when
the run set none — its size row (`SESSION_CAPS_BY_SIZE`: S $25 / 150 turns · M $60 / 300 · L $120 /
600; `references/sizing.md`); a closeout, QA round, PR session or reviewer gets a quarter of those
dollars and 60 turns, a repair 90. A cap that bites resumes the same session with that cap doubled, so
meeting one is not the end of the phase. **And a stop asks your turn to close before it asks the
process to leave.** When the console stops a session it wakes the process (SIGCONT), sends the CLI one
SIGINT and gives it `INT_GRACE_MS` (5 s) — long enough for the CLI to close the turn and write its
`result`, so what the session spent reaches the record — and only then SIGTERMs the process group, with
a SIGKILL backstop (`viewer/server/runner/signals.ts`).

**It also runs under a context line, judged on every API call** (autopilot-token-drain phase 3,
`viewer/server/runner/usage.ts`). Each call re-reads the whole conversation, so the console folds every
call's `message.usage` and compares your newest context with your model's window (`scripts/models.env`
classes: `[1m]` and the big families 1M, anything else 200k). At **0.6 ×** you are told once, in a
`Supervisor check`, to finish the step you are on, commit, hand off `in-progress` and declare
`phase-outcome.sh <slug> <N> partial --reason context`. At **0.8 ×** the console checkpoints the session
itself and boards the next attempt FRESH with the resume brief — that session is never `--resume`d,
because resuming it would re-read all of it. Each line acts once per session, and only on the phase's
own session: a closeout, a QA round or a repair is never cut off. Every session's counters are journalled
`phase.tokens` and kept on the record as `tokens[]`; the run view shows a live lane's context now and at
its peak, its cache rebuilds and its status checks.

**And a resume is judged before it happens** (autopilot-token-drain phase 4, `resumePolicy` in
`viewer/server/runner/usage.ts`). A `--resume` re-reads the whole conversation, and a cold one writes all
of it into the cache again on its first call — a 681k session resumed four hours later rewrote 554k before
it did anything. So a session is resumed only while it is worth resuming: one that ended at ≥ 250k tokens
of context and is cold (idle ≥ 55 min) or under another account, that declared `partial --reason
budget|context`, or that the console checkpointed is boarded FRESH with the resume brief instead. That
holds for every resume — a wait whose window elapsed or whose ref landed, a `partial`, an account switch,
a model's window, a QA round — and the brief carries what the resume would have: your handoff, the
uncommitted paths, your last words and, for a wait, its refs and what it was waiting on. Each decision is
journalled `phase.resume-policy`. Declaring `partial --reason context` when told to wrap up is the cheap
exit, not a request to be resumed into the same context.

## The convergence loop — converge, classify, climb

`viewer/server/converge.ts` is what decides everything the console can decide about a **stopped**
run, on a clock as well as on events: at boot, when the docs change (debounced), every
`convergeEveryMs` (default 5 minutes), a minute after a halt, and on the operator's *Recover &
continue* press. It is **on by default** and turned off with the console's `--no-converge` flag.

It never spawns a session itself. It releases locks whose holder is provably dead, hints re-boardings,
writes operator errands, runs the ladder below, and hands the run back to the runner — which is the
only thing that starts phases. Two promises it is built around:

- **An operator's stop is respected.** A run a person paused or stopped, or one they dismissed, is
  pinned: the loop reads it and leaves it alone. Only their own press overrides that.
- **Every act is journalled and bounded.** Debris releases and boot resumes each write a journal line
  on the run they touch, boot resumes are capped per phase, and the ladder's caps bound the rest.

What this means for a session: **a phase you left `in-progress` may be re-boarded without a person
doing anything**, and a lock you were holding when your process died is released within minutes. Both
are reasons the handoff — not your memory of the turn — is the durable record.

## The watch clock — your `--watch` refs, polled on their own timer

The refs you pass to `phase-outcome.sh --watch` are not decoration. `viewer/server/watch-scheduler.ts`
polls them on a clock of its own (a 60-second floor, per-scheme cadences above it) — **separate from
the convergence loop**, so a landing is acted on when it happens rather than when a five-minute sweep
next visits your plan. Five schemes:

| write | landed when |
|---|---|
| `gh:owner/repo#run/<id>` | the run reaches `completed` — **any** conclusion, a failure included |
| `gh:owner/repo#pr/<n>` | the PR leaves `OPEN`, merged or closed |
| `date:<ISO8601>` (or `until:`) | that instant passes |
| `lock:<slug>/<phase>` | nothing holds that phase's scope any more |
| `cmd:"<command>"` | the command exits 0 |

**What happens when one lands:** your OWN session is resumed (or, when it is no longer worth resuming —
above — the phase boards fresh with what landed in its brief), with your declaration still on the
record and `declared.landed` beside it, and an instruction that names what actually happened. A run
that ended `cancelled` gets "decide whether to re-run it", not "re-check it" — so read the
instruction rather than assuming the thing you waited for succeeded. Three resumes per landing; after
that it becomes an operator errand. **A declaration is spent only by the session speaking to it** — a
`git commit` or a `phase-outcome.sh` call in the resumed session (`isDurableProgress`; a turn or a
`git status` is not enough) — or by a newer declaration, the board closing the phase, or an operator's
Retry (`DECLARATION_CONSUMERS`). Once it is spent the watch stops, so if you are still waiting on
something else, declare it again.

**`cmd:` runs your command, repeatedly.** Through the same policy a plan's §Verification gets — a
denylist of mutating verbs, an inverted allowlist for verbs that reach off this machine, 60 seconds,
a process-group kill. That policy is not "read-only" in the strict sense (`npm ci` and `cargo build`
pass it), and your ref runs every five minutes while the phase is parked — **at most 12 times per
phase**, after which the console stops running it and the ref reads `refused` in words
(`MAX_CMD_RUNS_PER_PHASE`) — so write one that only LOOKS and costs little: `cmd:"gh run list --workflow deploy.yml"`, never `cmd:"npm ci"`. Its
output tail rides the journal, the resume instruction and a desktop notification, so do not have it
print anything you would not want quoted. A command the policy refuses is journalled once and dropped; the operator
can also switch the whole scheme off (`watchCmdRefs`), in which case such a ref simply reads
`unknown` and nothing resumes on it.

**`--wait-minutes`/`--until` now work with `blocked` and `needs-human` too**, not only
`waiting-external`. A person is still asked; the clock only says when the console next brings the
phase up. If you know both — a person must look, *and* not before the release lands at 09:00 — say
both.

**What a declaration may ask for is bounded, and past a bound it is refused, never cut.** A
`waiting-external` spends this phase's wait budget: at most 4 waits (`WAIT_MAX_PER_PHASE`) and 8 h
parked in total (`DEFAULT_WAIT_BUDGET_MS`) unless the plan's `**Wait budget:**` line or the phase's
`- **Waits on:** <ref> · <max>` bullet says otherwise — a `date:` ref there countersigns a wait up to
that instant. Your boot prompt's contract states the ceiling and where it came from, and a window past
what is left is REFUSED with a `waiting-external-timeout` halt carrying the arithmetic — never shortened,
so name the real end of the wait. Each of the other statuses is acted on at most 4 times for one phase
(`DECLARATIONS_MAX_PER_PHASE`): a fifth is recorded, not acted on, and parks the phase `needs-human` on
the `unknown:declaration-cap` errand until an operator's Retry clears the count. A `blocked` or
`needs-human` clock is capped at 7 days (`DECLARED_CLOCK_MAX_MS`, the cap journalled), and on the
unsupervised paths two `partial` declarations inside 5 minutes are one act (`DECLARATION_COOLDOWN_MS`).

**A resume is refused while the session that declared is still live.** The console never resumes a
session on top of itself: a declaration whose session is still running — or still holding the phase
lock on its lease — is journalled `phase.resume-refused`, announced once, and acted on when that session
ends; the console looks again every 5 minutes (`RESUME_REFUSED_RECHECK_MS`). Declare, then stop.

**`blocked` and `needs-human` name their decision key — `--needs <key>` is required** (since 5.0.0;
exit 2 without it). The key is a row of the plan's `## Decisions` manifest (`credentials`, `gates`,
`accounts`, `mcp`, `waits`, `human-acts`, …) or a blocker class as its short form (`credential`,
`permission`, `gate`, `external`, `lock`); the boot prompt prints the phase's rows. The runner reads
it BEFORE your prose: `--needs credential` classifies `blocked-declared:credential` whatever the
`--reason` says, and a `blocked-declared:unknown` is now a key the manifest lacks — a defect report.
`--rule`/`--command` structure a permission block beside it.

## The Stop hook — the closeout contract, enforced

The runner installs an HTTP `Stop` hook (`viewer/server/runner/approvals.ts` → `/hooks/stop`) into
every supervised session. When you try to end your turn it asks the console one question: **does this
phase read done on the board, or has a valid outcome been declared?** If neither, the hook refuses the
stop and hands back the instruction — finish the closeout, or declare the wait.

Three properties, all deliberate:

- **It refuses at most twice per session.** After two blocks it allows the stop regardless. It is a
  loop guard, not a cage.
- **It fails open on every uncertainty** — an unreadable board, an unknown phase, an unreachable
  console. It carries workflow, never safety; the runner's own exit-time check remains the
  load-bearing layer.
- **It is not the same hook as session presence.** `scripts/session-hook.sh` also registers for
  `Stop`, machine-wide, and always exits 0. The two do different jobs and neither can stop a session
  the console is not supervising.

If your turn "will not end", you have not hit a bug: you have hit the closeout contract. Write the
handoff, or declare `waiting-external` / `blocked` / `needs-human` / `partial` / `no-defect`
(`blocked` and `needs-human` with their `--needs <key>`).

## Permission profiles and the deny wall

A run carries a **permission profile** — `guarded` (the default), `trusted`, or `bypass`
(`viewer/shared/run-settings.js`). What moves between them is only the **ask** list. The `deny` list
is identical in all three and is the actual wall: it is evaluated inside the CLI with no network
involved, and it holds with the console dead. A profile that could widen it would make a wall a
preference.

Identical **across profiles** is not the same as immutable, and the difference has bitten a reader of
this file. An operator can STRIKE a built-in rule out of the wall — `removed.deny` in a policy edit,
per plan or globally (`approvals.ts`, `loadPolicyFor`) — and because everything downstream consumes
one merge, a strike holds on every profile at once or on none. So: no profile can widen the wall, and
a person can. If a command you expected to be refused runs, read the plan's policy file before
concluding the wall is gone.

The default deny list (`viewer/server/runner/approvals.ts`) covers what an unattended agent has no
business doing at 3am — pushing, hard resets, and the rest of the reach-outside-this-repo family. It
ships in a public skill deliberately generic; repository-specific rules belong in the operator's own
`autopilot.json`.

Beside it the runner installs a `PreToolUse` HTTP hook on `Bash|Write|Edit|NotebookEdit|WebFetch|WebSearch`,
which parks the session and asks a person, with evidence, for work that *may* proceed with a human's
say-so. That hook **fails open** — measured, not assumed — which is exactly why nothing dangerous is
allowed to depend on it alone.

**What a session should do when a tool is denied.** The denial reaches you as a decision with a
reason, not as an unexplained failure — read it. It is not a bug and not something to route around:
do the part of the work that does not need the denied tool, and record what you could not do under
**Outstanding** in the handoff as an operator errand. Never try to defeat the wall; a person runs
those commands themselves, deliberately — or widens the wall for this plan, which the console offers
them. A deny-list denial is stamped on your phase record (`toolDenied`: the tool, the rule, the
command), a phase stopped on it reads `blocked-declared:permission`, and that situation's one rung is
`widen-rule`: a standing approval card naming the rule, whose Allow strikes it for this plan and
resumes your own session. If the phase cannot proceed without the tool, declare it by key with the
rule and the command as fields —
`phase-outcome.sh <slug> <N> blocked --needs permission --rule "<the rule>" --command "<the command>"`
— and stop. The card is driven only from the console's own recorded denial: a wall described in prose,
a denial that names no rule, and the guards' `in-turn-wait` and `poll-loop` offer nothing to widen.

## Never wait on somebody else's clock inside a turn — and never poll

There is one refusal that is NOT a deny rule, and a session meets it as a deny, so it is worth
knowing which is which. A `Bash` call that by construction waits — `until …; do sleep …; done`,
`while true; do sleep …`, `sleep 90`, `sleep 5m`, `watch -n`, `gh run watch`, a `--watch` flag,
`tail -f`, a foreground `docker compose up` — is matched **before it runs**, on every profile, by
`Service.decideToolUse`, and refused when the clock it waits on is not the session's own (rule
`in-turn-wait`, journalled `phase.tool-denied`). The vocabulary is the shared one in
`scripts/verify.env`, the same list lint F16 warns from at plan time. `docker compose up -d` is
carved out: it returns.

Whose clock is read off the command (`liveness.ts` `waitScope`): a named remote — `gh`, `aws`,
`kubectl`, `ssh`, a URL, a deploy verb — is somebody else's and always outranks; a command that
names something local — a `/tmp` path, a `.log`, a `[ -f … ]` test, a `pgrep` — is your own; one that
names neither is treated as somebody else's. **A wait on your own job is allowed** (autopilot-token-drain,
2026-09-16, reversing the refusal half of RCV-5): one foreground call bounded by the Bash timeout
costs one call, and refusing it left a session with a background job and nothing to do but poll —
311 status-only calls in one measured phase.

The command is judged **per statement, split the way bash splits it** (`liveness.ts`
`splitStatements`): a statement ending in a single `&` is backgrounded and never a wait — the one
before it still is, and a later `wait` re-foregrounds them all — a `( … )` / `{ … }` group is looked
into, a `$(…)` or backtick substitution is judged on its own before whatever prints it, and a
quoted string is data to the command that receives it (`git commit -m "until … do"` commits) — except
for `sleep`/`wait` and the compounds, whose quoted values are code. **Data that reaches a shell is
code**: a statement led by something that runs what it is handed (`bash -c`, `eval`, `ssh`, `xargs`,
`git submodule foreach`, `docker exec`, `find -exec`) or piped into one is judged whole, nothing
masked. A here-doc body is data to the command that reads it — writing a file that *mentions* a poll
loop is fine — unless a shell reads it: the owner (`bash <<EOF`, `/bin/bash`, `sudo bash`), a shell
started for it (`docker exec … bash <<EOF`, `ssh host <<EOF`), or one it is piped into
(`cat <<EOF | bash`). The remedy itself — `phase-outcome.sh … --watch <ref>` — is carved out of the
vocabulary, so obeying the deny is never denied. An unterminated quote fails closed; a command the
guard cannot read is refused, never dropped.

It lives outside `policy.deny` deliberately. A `Bash(sleep:*)` rule there would take a strike, appear
in the rule editor, be switchable per plan — and make `sleep 8`, the standard bring-up pause,
impossible. The harm here is identical on every profile and is not a matter of trust: while the call
is open the turn produces nothing, no stream event arrives, and the phase's exclusive lock stays held
on a lease keepalive that looks perfectly healthy from outside. One measured phase sat 35+ minutes in
two such loops holding `scope=all`.

What to do instead is one procedure, the same words the deny reason, the boot prompt and SKILL.md
carry:

**Waiting without polling.** Every tool call re-reads your whole context, so a status check costs as
much as an edit. Never make two status checks in a row (`ListAgents`, `TaskOutput`, `date`,
`tail`/`grep`/`cat` of a log, `pgrep`, `gh run view`), and never check on a subagent you dispatched.

| when | do this |
|---|---|
| **Work remains** | keep working; a background result arrives by itself as a `<task-notification>`. |
| **You need a subagent's answer** (a reviewer's verdict) | dispatch the `Agent` in the FOREGROUND; the call returns with the answer and costs nothing while it runs. |
| **You need your own shell job and nothing else is left** | wait in ONE foreground call bounded by the Bash timeout: `until <probe>; do sleep 10; done` with `timeout: 600000`, at most once per ten minutes. The console allows a wait on your own job; it refuses one on somebody else's clock. |
| **Only subagents or monitors running in the background are left** | end your turn; the session stays alive and their notification wakes you. They are stopped ten minutes after your turn ends — dispatch a subagent that may take longer in the FOREGROUND. A background SHELL dies when your turn ends — never end it with one you still need. The Stop hook lets that turn end (`hook.stop-awaiting`), and liveness does not read the quiet as `silent` until `stallLocalJobMs`. |
| **Somebody else's clock** (CI, a deploy, a person) | commit, hand off `in-progress`, `phase-outcome.sh <slug> <N> waiting-external --wait-minutes <M> --watch <ref>`, stop. |

**A run of status checks is refused too** (rule `poll-loop`, autopilot-token-drain phase 2). The console
counts your own calls, never a subagent's: `ListAgents`, a `TaskOutput` that does not block,
`BashOutput`, a `Bash` made only of clock and process probes and reads of a log or task output
(`date`, `pgrep`, `ps`, `sleep`, and `tail`/`cat`/`grep`/`wc`/`ls`/`stat` of a `*.log`, a `*.output` or a
`/tasks/` path), and any Bash command repeated, digits folded, within two minutes. Six of those inside
two minutes with no other call between is a loop: the sixth is refused, and so is every status check
after it until you make a different call or go two minutes without one (`shared/poll-loop.js`). The
episode opens with one notice written into your session — once per lane, journalled `phase.poll-loop` —
and each refusal is journalled `phase.tool-denied`. Like `in-turn-wait` it is not a deny rule: the same
on every profile, never stamped on the record, nothing to widen. A blocking `TaskOutput` and a
foreground `Agent` are the waits the procedure asks for, and neither counts.

What survives the end of a turn was measured (CLI 2.1.273, this runner's framing, stdin closed at
the first result as the runner closes it): a background `Bash` is stopped about five seconds after
the turn ends; an `Agent` or a `Monitor` running in the background keeps the process alive and its completion starts
a new turn; a foreground bounded `until … sleep` loop is not blocked by the CLI; a foreground `Agent`
makes zero parent API calls while it runs. A `Monitor` reaches the stream as `task_type: local_bash`
— only the tool that started it tells it from a background `Bash` — so the console pairs the task
to its tool call by `tool_use_id`.

And if a wait is already open when the console looks — the guard catches the call you are about to
make, not one you made before it existed, or one spelled in a way the vocabulary does not know — the
same split decides what happens to you, read off the command (`liveness.ts` `waitScope`):

- **External** (`gh`, `aws`, `kubectl`, `ssh`, a URL): after `stallExternalWaitMs` (5 min) the console
  **parks** the phase and releases its lock — in its own name (`by: 'watchdog'`), on its own allowance
  of 4 parks per phase (`WATCHDOG_PARKS_MAX_PER_PHASE`), never your declared waits or your wait budget.
  Nothing is lost — you are resumed on your own session id (or boarded fresh with the resume brief,
  when that session is no longer worth resuming).
- **Local** (a `/tmp` log, a `tasks/*.output`, a `pgrep`, a `[ -f … ]`): you get **one nudge** into
  your stdin saying what to do instead, and the park only after `stallLocalJobMs` (45 min). The gap
  exists because parking a session 40 minutes into its own suite does not release anything useful; it
  throws the suite away and runs it again.

Either park mints a watch ref from the command it caught — a poll loop's condition becomes a `cmd:`
ref, `until test -f /tmp/done; do …` → `cmd:"test -f /tmp/done"` — and a minted `cmd:` ref is **NOT
run** unless the operator turned `watchMintedCmdRefs` on (it ships off): until then it reads `unknown`,
and you come back on the park's own clock rather than the moment the job lands. With
`stallAutomaticPark` off the console parks nothing by itself — the stall card still stands and the
nudge still goes.

**A wait declared with no ref after that refusal is adopted or refused, never left blind.** Declare
`waiting-external` without `--watch` after the guard refused an in-turn wait in this attempt, and the
console mints the ref from the command it refused and adopts it; failing that it takes the phase's
`- **Waits on:**` refs from the plan; failing both it REFUSES the declaration and parks the phase
`needs-human` with a `blocked-declared:external` errand naming the command and the plan line that
would have allowed it — each step journalled `phase.watch-missing`. Name the ref yourself.

A §Verification command is exempt from all of it: while the lane is verifying the plan is entitled to
a slow command, and that path has its own 30-minute bound and its own signal.

## Questions — held, relayed, or answered by the plan

`AskUserQuestion` is never treated as a permission. Every call to it is **held** (`QUESTION_CLASS` in
`viewer/server/runner/approvals.ts`, checked right after the deny list and before anything a profile or
an operator's allow list can reach), and the console answers it one of two ways.

**The relay is armed** — the run answered `relay: last-resort`, the CLI read at or above
`RELAY_CLI_FLOOR` (2.1.268, from `system/init`), and this is the phase's own session: its boarding or
the resume of its own conversation. A QA round, a repair, a resume with an instruction, a closeout, the
PR session and the reviewer never carry it. The question meets the deny list first, then the
exclusions (`QUESTION_EXCLUSIONS`: `deny-list`, `multi-select`, `destructive-option`, `run-stopped`,
`repeated-key`) and the phase's budget of 8 (`RELAY_QUESTIONS_PER_PHASE`). **An excluded question is
not answered by rule at all**: the whole call comes back unanswerable, the phase parks `needs-human`,
one push goes out, and the tool result tells you to hand off `in-progress`, declare
`needs-human --needs ambiguity --reason "<the question>"`, and stop. Anything else goes on a card for
60 s (`RELAY_WINDOW_MS`): a person inside the window wins; otherwise, at 55 s, the console answers by the
operator's relay rules, else the sole `(Recommended)` option, else the first. **One question per lane is
open at a time** — a second call waits for the first. Every answer is filed as a ruling
(`references/conventions.md` §Rulings), and when the console answered rather than a person, a notice
arrives down your stdin with one sentence per question, exactly these words (`frameRelayAnswer`,
`viewer/server/runner/runner-core.ts`):

> No operator answered within 60 s. The console answered `<label>` by `<rule>`. This is NOT a change to
> the phase. If that answer is wrong, declare `blocked --needs ambiguity` rather than asking again.

Nothing needs saying back: carry on with the phase.

**The relay is not armed** — `relay: off`, a CLI below the floor, or no version read yet. The plan's
`ambiguity` row answers (`phase.policy-answered`; the shipped answer is `ruling`), and the hook is told
`deny` with that answer as its reason, which is not a refusal of your work: under `ruling`, decide from
the plan, record the call (`phase-outcome.sh <slug> <N> ruling --kind ambiguity …`) and carry on; under
`ask` or `halt`, hand off `in-progress`, declare `needs-human --needs ambiguity`, and stop. Usually the
tool is not offered at all: **every session the relay is not armed for is spawned with
`--permission-prompts none`** (`PERMISSION_PROMPTS_CLI_FLOOR`, 2.1.259) — anything that would prompt is
denied, the session is told nobody can approve it and not to retry, `AskUserQuestion` is removed and
elicitations are cancelled. A CLI known to predate the flag runs without it, and the run says so once
(`run.permission-prompts-skipped`).

## Run settings — what an operator can change under you

`viewer/shared/run-settings.js` is the single list of what a run may be told. It matters to a session
because **most of it is changeable mid-run**: `model`, `effort`, `maxParallel`, `autonomy`, the phase
and run budgets, `skills`, `mcpServers`, `mcpPolicy`, `permissionProfile`, `gitMode`, `openPr`,
`reviewEachPhase`, `reviewerPolicy`, `ultracode`, `ultraReview`, `onLimit`, `autoRecover`,
`maxConsecutiveFailures`, `onlyPhases`, `phaseOptions`, `isolation` (a drop lands, a raise 409s),
`settle`, `priority`, `attachDefaultSkills`, and the five that belong to the Fix & re-QA loop —
`qaMaxRounds`, `qaModel`, `qaEffort`, `qaFixStrategy`, `qaRoundBudgetUsd`. A handful
are start-only — `resumeRunId`, `startAfter`, `qa`, `accountId`, and since 5.0.0 the run's own
answers to the decision manifest: `resumeOnRestart`, `relay`, `accounts` (`[{id, minHeadroomPct}]`),
`acknowledgedWaivers` and `manifestOverride`.

**The start door refuses before it spawns (since 5.0.0).** A fresh `POST /api/run/:slug/start` that
omits `resumeOnRestart`, `relay` or `accounts` is answered **400** naming the missing field — the
launch form's Decisions stage is where they are answered, and a scripted start has to answer them
too. With them given, the **prelude** (`viewer/server/prelude.ts`) runs the plan's `## Decisions`
rows and five probes — accounts, MCP, credentials, delivery, verification — and a blocking row still `outstanding`,
a `waived` row nobody acknowledged, or a failed blocking probe answers **409** `{unanswered: [{key,
why}], prelude}`. `manifestOverride: {by}` starts anyway and journals `run.manifest-override`; a
channel-less start is admitted only with `acknowledgedWaivers: ['announce']`. A resume
(`resumeRunId`) skips the prelude — the run already answered. `GET /api/run/:slug/prelude` is the
same report for display, and `phase-console doctor` runs the same probes with no plan in front of
them. What it means for a session: the credentials the plan named were probed before you boarded
(`phase.credential-preflight`) — under credential policy `require` a missing one parks the phase at
boarding, before anything is spent, with a `blocked-declared:credential` errand; under `continue` (the
default) you are boarded anyway and your boot prompt names each missing credential by id, telling you
to do the work that does not need it, record the rest as an operator errand, and declare
`blocked --needs credential` only if the phase cannot proceed at all. And a policy answer the console
gave in your place is on the journal as `phase.policy-answered` rather than on a card.

One phase can override a smaller set for itself (`PHASE_OPTION_FIELDS`): `model`, `effort`, `tools`,
`permissionMode`, `skills` / `skillsOff`, `mcpServers` / `mcpOff`, `mcpPolicy`, `autoApprove`,
`ultracode`. A
plan's own `- **Model:**` / `- **Effort:**` bullets feed the same resolution — see
`references/plan-format.md`.

**`reviewEachPhase` is the one that reaches into Mode 3's territory.** With it on, every phase-finish
dispatches a fresh reviewer session over the phase's diff (`viewer/server/reviewer.ts`) — the QA
subagent's discipline applied to the diff instead of the tests, and on QA-off plans the only second
reader there is. Three things follow: it is **off unless somebody turned it on**; it is capped like
any extra session (a quarter of the phase budget, the closeout's turn cap); and **its verdict is a
review with real consequences** — a `requested-changes` holds this phase's dependents exactly as a
person's would. `reviewerPolicy` (`comment-only`, the default, or `may-hold`) is what restricts that.

So: if your phase finishes and the board does not move, look for a review before looking for a bug.

**A reviewer your PLAN orders runs in the FOREGROUND.** When the plan tells you to dispatch a reviewer
at phase-finish (a `subagent_type` reviewer, a §Adversarial review), dispatch it as a foreground
`Agent`: the wait procedure's rule 2, a call that returns with the verdict and costs nothing while it
runs. A reviewer sent to the background leaves a builder with nothing to do but check on it: run
`deadaff9`'s P3 waited on its reviewers with `ListAgents` + `date` every ~4 s, in streaks of 100 and 198
calls, and status-only calls were 79 % of that session's context tokens. With
`reviewEachPhase` on as well, the same diff is reviewed twice; the launch form says so beside the toggle
(the plan's words, or a QA gate that is on), and keeping one of the two is the operator's call, not yours.

**The two ultra tiers are opt-ins that spend, and both are off.** `ultracode` has no CLI flag — the
opt-in is the word, so with it on your boot prompt (and every resume or unblock brief) carries a
standing line saying you may use the `Workflow` tool where the work genuinely fans out. Read it as
a licence rather than an instruction: a workflow runs dozens of agents at once, and reaching for one
where a single pass would do spends the budget the fan-out was meant for. A phase can carve itself
out of the run's answer in either direction, so its absence from your prompt is a decision somebody
made and not an oversight. `ultraReview` (`off` · `each-phase` · `at-settle`) is the console
spending the operator's CLOUD budget on `claude ultrareview` — the runner spawns it, never you, and
its findings ride the same review channel under the same `reviewerPolicy`. A CLI that has no such
subcommand degrades to `unknown` with the reason journalled; nothing parks on a tool's absence.

## The remediation ladder — what happens when a phase fails

When a phase ends badly the console classifies the **situation** (`viewer/shared/situation-model.js`:
`verify-red`, `done-unrecorded`, `blocked-declared`, `waiting-external`, `mcp-unavailable`,
`resource-wall`, `qa-failed`, `plan-broken`, `never-started`, … ) and climbs a **ladder** of rungs for
it (`viewer/server/runner/ladder.ts`, table in `viewer/shared/ladder-model.js`): re-board fresh,
resume your own session with an instruction, re-board with a resume brief, a bounded unblock session,
a closeout agent, a fix agent at a stronger model, a plan-repair pass, a switch to another account —
and, when the ladder is exhausted or the situation was a person's to begin with, an **errand** for the
operator.

It is bounded by attempts *and* dollars, never the same rung twice for one situation on one phase.
Defaults: 3 rungs and $100 per phase, 10 and $400 per run, $600 per day per console — all operator
preferences in Settings ▸ Automation.

Three things about the ladder from the posture sweep (console-parallel-repaint P12) that a session
may notice. An errand written for a person **stands**: the sweep re-reads it every five minutes and
writes nothing new unless the ask changed, so the clock on the card is when it was first asked. A
declared blocker on the console's own permission wall reads `blocked-declared:permission` and climbs
exactly one rung, `widen-rule` — the standing card described under §Permission profiles, offered only
when the console recorded the denial itself; the wall is the operator's to widen, so record what you
could not do under **Outstanding** and stop, rather than spending an unblock session on it. And two operator opt-ins, both off by default, widen what runs without a
person: `allowUnverifiedPhases` boards a phase whose plan states no §Verification and passes it on
the handoff alone (`phase.verify-waived` on the record), and `ladderExtendOnProgress` grants one more
rung, once, when the newest settled rung landed commits (`phase.ladder-extended`). Neither moves the
deny wall or a capability flag.

For a session, the practical consequences are:

- **A phase you did not finish will be tried again, differently.** Boarding with a *resume brief*
  (SKILL.md Mode 2's RESUMING path) is a rung; so is resuming your own conversation. Uncommitted work
  in the tree is the previous attempt's — read `git status` before doing anything, and never
  `git stash` / `git checkout --` / `git reset` it away.
- **A declared outcome short-circuits the guessing.** `blocked` and `needs-human` route to the rungs
  that fetch a person — and their `--needs <key>` decides WHICH rung, before any prose is read;
  `partial` routes to the ones that resume you; `waiting-external` parks the
  phase and comes back. Prose routes to nothing.
- **A remediation that reaches you is a SESSION under this run, not a TUI.** The four "a fresh
  briefed agent" rungs — `fix-agent`, `closeout-agent`, `plan-repair-agent`, `stale-claim-takeover` —
  spawn `claude -p` inside the run's own frame: its settings file (so the deny wall and the hooks
  apply), its permission profile, its lane, its scope grant, its lease, its journal, its account, and
  its tree. They are briefed from the outside and get no `--resume`, so a phase whose own session is
  gone is still reachable. An interactive pty is minted only for the operator's own button, and as
  the fallback for a console started with `--allow-agent` but not `--allow-run`.
- **A repair says how it went, and the rung is settled from that.** Declare with
  `phase-outcome.sh <slug> <N> <status>`: `complete` settles the rung `fixed` (and retires the stop),
  `no-defect` — "I looked, and there was nothing to fix" — settles it `no-defect` and leaves the stop
  standing, `blocked`/`needs-human` settle `no-defect` and keep the errand, `partial` settles
  `work-in-progress`. Declaring nothing settles `failed`, quoting your last words. Before this, the
  only settle path asked whether the phase read `done` — which a plan-wide repair can never satisfy,
  so nine of ten repair rungs were recorded as failures.
- **`plan-broken` starts on a free rung — free of MONEY, not of permission.** It edits INDEX.md,
  handoff frontmatter and lock files, so the console drives it only under **`--allow-writes`**;
  without that flag the rung is unavailable and the ladder falls through to the repair session.
  `scripts/repair-artefacts.sh <slug> [--apply]
  [--reset-not-started N]` repairs the four mechanical disagreements — an INDEX status cell against
  its handoff's frontmatter, a `depends_on` against the plan graph, an expired lock, and a `blocked`
  marker left by an attempt that never started. No session, no model, idempotent, and it never edits
  a plan table or a handoff body. Run it yourself to see what it would do; `--apply` makes the change.
- **A worktree or branch a session makes is registered, not swept.** `run.agent-artefacts` names
  every checkout and `pe/*` branch that appeared under a phase or repair session. Nothing deletes
  them — a checkout may hold uncommitted work — but nothing hides them either. The boot prompt no
  longer tells you to make one: when another live session shares your repository, work in the
  checkout you have, or declare `blocked --watch lock:<slug>/<N>` and let admission queue you.

## Freeze and thaw — a phase held, and a lock released

An operator can **freeze** a lane: the phase's child is held rather than killed, and the console
renders the promise on the lane card. `viewer/server/runner/freeze.ts` is what keeps that promise
when the console that armed it is gone — past **15 minutes** the freeze escalates by itself
(wake-then-terminate, then the record is converted into something *Continue* can resume), and a
freeze that escalated in a live console and one that escalated at boot leave byte-identical records.
**Thaw** is the operator's release; a frozen phase is simply not scheduled until then.

The same category holds a fact SKILL.md's Mode 2 does not: **an operator can release your phase lock
out from under you.** `scripts/phase-lock.sh` leases are cooperative, the console's Locks view can
force one, and the convergence loop releases the locks of sessions it can prove are dead. The lock is
yours until phase-finish *by convention*, not by enforcement. If a `claim --force` by someone else is
plausible in your situation, re-check the lock before a long unattended stretch rather than assuming.

## Talking to a running phase — btw, ask and steer

A supervised phase holds its stdin open, so it is a session you can speak to without stopping it. Two
verbs, deliberately separate (`viewer/server/runner/runner-control.ts`):

- **ask** — a question. The console frames it so the model answers and then **carries on where it left
  off**; dropped in bare, a question reads as a new instruction and quietly redirects the phase.
- **steer** — an instruction: do this differently from here.

Either way it becomes one more turn in the same conversation — same context, same warm prompt cache —
and the answer appears in the console's session window. Both are idempotent under a caller-supplied
key, so a double-click is one write and one journal line.

From any terminal, `bin/btw` is the ask verb without the browser:

```
btw "why did you skip the cache?"
btw --plan my-plan "is that migration reversible?"
```

It finds the console that owns the directory you are standing in, or takes
`--url` / `$PHASE_CONSOLE_URL`. The console must be running with `--allow-run`. An installed plugin
gets `btw` on `PATH`; a clone needs one symlink, which its own `--help` prints.

**What this means for a session:** a message can arrive mid-phase that is neither your plan nor your
boot prompt. Treat an *ask* as a question to answer and resume from, and a *steer* as an instruction
that outranks the plan for the rest of the phase — then record the departure with
`scripts/phase-outcome.sh <slug> <N> ruling --kind deviation`, because the next session reads the
handoff, not the console's chat.

Two more ways words reach you. **A lane's own ask is answerable from the inbox**: when the presence
hook reports your session stopped on a prompt, the inbox's `session-ask` row for your lane carries
**Answer it**, and a person's words arrive as a *steer* — an instruction for the rest of the phase. (A
lane with a pending approval card for the same phase gets the card instead of the row.) And **every
verb says who sent it**: a route derives the actor from the request (`actorOfRequest`,
`viewer/server/api/actor.ts`) — `via` is `cli` for `phase-console` and `btw` and `api` otherwise,
`origin` is `local` or the calling host, `remoteUser` is the proxy's login and is read only under
`--remote`, and `by` is the request body's label (at most 64 characters), else that login, else
`operator` for a browser or the CLI and `script` for anything else. A message a script sent is
recorded as the script's, never as the operator's.

## What happens around your phase — landing, notes, issues, the trace id

Five things the console does around a phase since 5.1.0. None of them is something you do; all of
them change what your handoff should say.

**Your branch is landed for you, and you never push it.** When a phase settles, the console reads the
plan's `Land:` word and acts on it — and pushing is *its* act, behind `--allow-publish`, through a
frozen argv that can only ever push a `pe/*` branch and can never force. So: **never `git push`
yourself**, and never open the pull request by hand. A phase whose word is `pr` or `trunk` ends with
the console pushing your lane and spawning a separate landing session whose only job is the PR; if
you push first, that session finds work already done and the ledger disagrees with the repository. If
your lane will not merge, that is the plan's `Conflicts:` word to answer, not yours — you may be
resumed with a bounded instruction to merge the run branch *into* your lane and resolve it, and that
instruction is deliberately narrower than it looks: merge, resolve, re-verify, commit, stop. Never
rebase, never force, never touch another branch. The landing ledger is the console's file; write to
it only through `scripts/phase-landing.sh`, and only when an instruction tells you to.

**Notes from earlier phases arrive in your boot prompt.** A handoff bullet addressed to you, a
deferral ruling left for you, and mail queued for your boot are collected into one block under
*"Notes from earlier phases"*. Each was left by a session that is gone, so nothing else will ever
tell you. Say in your handoff what became of each — acted on, or deliberately not. Leave your own the
same way, in `## Notes for later phases`: it is the only channel that reaches a phase which has not
started yet.

**Every line your phase writes carries one trace id.** The run derives it once and it rides the HTTP
request, the drive, your attempt, your session, the bash scripts and every git command — so a
post-mortem is one `grep`, and a resumed run continues the same trace instead of splitting in two.
You do not set it; it matters because it is what makes "what happened during phase 9" answerable at
all, and it is why a bundle is worth attaching to a bug report.

**Two detectors watch and do nothing.** `looping` notices a lane repeating an identical failing tool
call over its last ten calls; `stuck` notices a live session silent for twenty minutes. Neither
acts — they raise a mark a person can see. If you are about to retry the same failing command a
fourth time, the detector is right and the plan is not going to change under you: stop and declare.


## Session terminals — other sessions on this machine

Every Claude session on the machine reports presence through `scripts/session-hook.sh`
(SessionStart / SessionEnd / Stop / Notification → `/hooks/session`), which is what lets the console
show a hand-run session beside the autopilot's lanes, treat a lock whose session has ENDED as debris
the moment it ends, and queue behind a lock whose session is live. The installer is
`viewer/server/hooks-install.ts` (Settings ▸ Automation, or `phase-console install-hooks`); it merges
into the operator's `~/.claude/settings.json` and never clobbers it.

On SessionStart the hook prints your own session id back to you along with the
`phase-lock.sh --session <id>` instruction — which is why a hand-driven session can claim its lock as
*itself*, and why the console can release that lock the moment the session ends instead of at the end
of its lease. The same context names the **other live Claude sessions** the registry shows in this
repository — each with its id, pid, where it stands and the plan phase it works when that is known —
and ends by telling you to check `phase-lock.sh <slug> conflicts <N>` before claiming, because one of
them may be about to work it. When the hook's POST finds no console, it drops the event into the
instance's inbox and — with node present and the connection refused, not merely slow — drains that
inbox itself with `phase-console sessions ingest`, which then supplies the peers line too; `PHASE_CONSOLE_HOOK_INGEST=0` leaves the inbox for the console.

A phase the scheduler queues says what it waits behind, in words worth recognising: a lock's owner;
`session <id> (pid N)` — a live session in the same scope that has not claimed a lock yet, the one
window a lock cannot guard, for ten minutes after it starts or resumes (for as long as it lives when
it is already working that very phase); `session cap` (`N of N lanes`) — this console is full; or `machine cap`
(`the machine is full — N of M lanes: …`) — every console on this machine together is. None of them
is a fault in your phase.

Those sessions are **openable**: the console can attach a terminal to another session and resume it.
The one thing a session must know about that machinery is where a pty lives — a terminal is a child
of a detached **broker** (`viewer/server/pty/broker.ts`), not of the console, so restarting or
shutting down the console leaves live terminals alive with their scrollback.

## Reading the console's API — the `?include=` projections

`GET /api/plans/<slug>` and `GET /api/state` are **projected**: they answer the board's working set
and leave the prose behind. `viewer/shared/projection.js` owns the vocabulary, and both halves speak
it — the server projects with it, the client asks with it:

| `?include=` | What it adds back |
|---|---|
| `prose` | the per-phase prose a `### Phase N` section carries at length |
| `document` | the plan's own markdown |
| `handoffs` | the handoff array's `outstanding` text |
| `memory` | the plan's memory file, read whole |
| `full` | the escape hatch — byte-identical to the pre-projection response |

`/api/state` takes `full` or `runs`. Groups compose (`?include=prose,memory`).

Two rules for anyone touching this: **`full` must stay byte-identical** — it is the compatibility
promise the projection is allowed to exist because of — and **a tab's own source file is not its
render tree**. A field is reachable from a page only if some component that page actually mounts asks
for its group; following the JSX from the tab's entry component is the only way to know, and grepping
the tab's file is how a field gets projected away silently.

## Where the state lives — the instance rule

A console's state directory is derived from the repository root it serves, not configured:

```
id        = sha256(<root path, lexical>)[:8] "-" basename(root)
state     = ${XDG_STATE_HOME:-~/.local/state}/phase-console
runs dir  = <state>/runs/<id>/<slug>
```

The rule is implemented twice on purpose — `viewer/shared/instances.mjs` for anything with node, and
`scripts/instance.sh` (sourced, never executed) for `scripts/phase-outcome.sh` and
`scripts/session-hook.sh`, which must find that directory with **no console answering and no node**.
That is what makes an unsupervised declaration land in the console's inbox rather than nowhere.

`scripts/scope.sh` is the same pattern for a different fact: the bash half of `viewer/shared/scope.js`,
so `scripts/phase-lock.sh` and `scripts/phase-graph.sh` read a plan's **Repos** column exactly once.
`viewer/test/engine-parity.test.ts` holds the two halves against every real plan — which is the only
thing that keeps them honest, and the reason neither may be "fixed" alone.
