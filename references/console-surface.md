# Console surface — what a supervised session runs inside

A file named here in backticks under server/, shared/ or client/ is the console's own source, relative
to its source directory.

Contents: What a supervised session is · The convergence loop · The watch clock ·
The Stop hook · Permission profiles and the deny wall · Never wait inside a turn ·
Questions · Run settings ·
The remediation ladder · When a run stops itself · Budgets that stop work · What a status word means ·
Freeze and thaw · Talking to a running phase ·
What happens around your phase · A person's turn · Session terminals · Reading the console's API ·
Where the state lives

SKILL.md and its mode files say how to execute a phase; this file says what Phase Console wraps around a `claude -p`
session when a run drives phases by itself (`--allow-run`). A turn that will not end is the Stop hook;
a model changed mid-run is an operator's setting — write the handoff from what the record says. None of
it exists when a person runs a phase by hand: the scripts behave identically. The operator's half is
`docs/loop.md` and `docs/controls.md`. Every flag and status of the outcome script is printed by
`phase-outcome.sh --help`.

## What a supervised session is

The runner injects into the environment:

| Variable | What it is |
|---|---|
| `PE_OUTCOME_FILE` | Where `scripts/phase-outcome.sh` writes; read once and consumed |
| `PE_TASKS_FILE` | Where `scripts/phase-tasks.sh` appends; tailed into the run record |
| `PE_RULINGS_FILE` | The plan's ruling ledger, append-only |
| `PE_OWNER` / `PE_SESSION_ID` | The lock identity — **never override `--owner`**, or the supervisor cannot release your lock |

`PE_SCOPE` and `PE_WORKTREE` may also be set (`scripts/phase-lock.sh` reads them all), and so are
`PE_PROOFS_FILE`, `PE_VERIFY_DIR` and `PE_RUN_ROOT`: the proof ledger, the directory the console runs
this phase's §Verification in, and the run root. `phase-outcome.sh … verified` keys a proof by
`PE_VERIFY_DIR` whatever your shell's directory, resolves a relative `--in` against `PE_RUN_ROOT`
(never `$PWD`), and refuses a proof the verdict could only refuse (a tree the judging repository does
not hold). `PE_OUTCOME_FILE` being set is the test for "am I supervised"; without it the scripts write
to the console's inbox, so a hand-run declaration still reaches a running console.

**What loads in your session** (measured-console phase 11). Under the console's `autopilotLoads:
console-set` you run with the console's own skill tree for its revision (`--plugin-dir`, so this skill
is the console's commit), the curated seed's plugins (`CLAUDE_CODE_PLUGIN_SEED_DIR`) and the personal
plugins a person switched on for autopilot — named as `enabledPlugins` in the run's settings — under
`--setting-sources project,local`: the repository's settings and the run's own load, the operator's
user-level hooks, plugins and skills do not. A skill your plan names arrives as ONE line, `Before you
start: Call the Skill tool with "<plugin>:<name>".` — make each call; the journal records named against
invoked (`phase.skill-invoked`). A seeded mattpocock skill brings the six-line unattended adapter, which
rules where its words assume a person. Under `operator-config` your config dir decides, as in 8.0.

**Say how far a long operation has got** (a sweep, a migration, a batch of N files) with
`phase-outcome.sh <slug> <N> progress --label <text> --done <n> --of <m>`. It is not an outcome and
never ends your turn: one line on `PE_TASKS_FILE`, journalled `phase.progress` on your in-progress task,
drawn as that task's bar and timed for its ETA. Say it as the count moves (every few minutes, not every
item). Whole numbers, `1 ≤ --of`, `--done ≤ --of`; a malformed call exits 2 and records nothing.

**What survives the end of your turn is narrow**: a background shell is stopped within seconds and
`ScheduleWakeup` wakes nothing, while an `Agent` or `Monitor` running in the background keeps the
process alive (up to the CLI's background-wait ceiling, ten minutes) and its completion starts your
next turn; with nothing outstanding the process exits. **Your deliverable is the handoff**: a clean
exit with no handoff and no declared outcome reads as a failed phase.

**Two caps you did not choose.** Every session carries `--max-budget-usd` and `--max-turns` from
`capsFor` (`server/runner/session-record.ts`): a phase session gets the run's `phaseBudgetUsd`, else the
phase's measured caps (each mode's p99 over this console's sessions plus 50 %; else the shipped $120 /
490 turns, `references/sizing.md`), its derivation recorded on the session. A session continuing the
phase's work (a resume with an instruction, a wait-resume) gets the same dollars and what is left of
the turns, never under 120; a closeout, QA round, PR session or reviewer gets a quarter of the dollars
and 60 turns, a repair 90. A cap that bites resumes the same session with that cap doubled.

**A stop closes your turn first.** The console sends SIGCONT, one SIGINT, waits `INT_GRACE_MS` (5 s) so
the CLI can write its `result` (your spend reaches the record), then SIGTERMs the process group, with a
SIGKILL backstop (`server/runner/signals.ts`).

**The context line, judged on every API call** (`server/runner/usage.ts`). The console folds each
call's `message.usage` and compares your newest context with your model's window (`scripts/models.env`:
`[1m]` and the big families 1M, anything else 200k).

- At **0.6 ×** a `Supervisor check` tells you once to finish the step you are on, commit, hand off
  `in-progress` and declare `phase-outcome.sh <slug> <N> partial --reason context`. It says what to
  commit (`wrapupCommitStep`): on a lane's own branch, what is done; on a SHARED branch, only work
  whose checks you ran green — the rest stays uncommitted. After you stop, the console runs the plan's
  fast §Verification lines (measured never over five minutes) on that commit; a red is written on your
  phase as `wipRed {sha, files, lines}`, your phase boards ahead of every sibling but a person's press,
  and every sibling's brief names the red files as yours.
- At **0.8 ×** the console checkpoints the session itself and boards the next attempt FRESH with the
  resume brief, never `--resume`d.

Each line acts once per session, only on the phase's own session (never a closeout, QA round or
repair). Counters are journalled `phase.tokens` and kept as `tokens[]`.

**A resume is judged before it happens** (`resumePolicy` in `server/runner/usage.ts`): a session is resumed only while it is worth resuming: one that ended at ≥ 250k tokens of context and is cold (idle ≥ 55 min) or under another account, that declared `partial --reason budget|context`, or that the console checkpointed is boarded FRESH with the resume brief instead — and so, at any size, is one that ended at or past **0.55 ×** of its window (the 0.6 × line less
`RESUME_WRAPUP_MARGIN`). That holds for every resume (a landed wait, a `partial`, an account switch, a
QA round), and the brief carries your handoff, the uncommitted paths, your last words and, for a wait,
its refs. Each decision is journalled `phase.resume-policy`. Declaring `partial --reason context` when
told to wrap up is the cheap exit, not a request to be resumed into the same context.



## The convergence loop — converge, classify, climb

`server/converge.ts` decides what the console can about a **stopped** run: at boot, on docs changes
(debounced), every `convergeEveryMs` (5 minutes), a minute after a halt, and on *Recover & continue*.
On by default; off with `--no-converge`. It never spawns a session: it releases locks whose holder is
provably dead, hints re-boardings, writes errands, runs the ladder, and hands the run to the runner.
A run a person paused, stopped or dismissed is left alone until their own press. Every act is
journalled on its run; boot resumes are capped per phase.

So **a phase you left `in-progress` may be re-boarded without a person**, and a lock held by a dead
process is released within minutes — the handoff, not your memory, is the durable record.

## The watch clock — your `--watch` refs, polled on their own timer

`server/watch-scheduler.ts` polls your `--watch` refs on their own clock (a 60-second floor, per-scheme
cadences above it), separate from the convergence loop, so a landing is acted on when it happens.

| write | landed when |
|---|---|
| `gh:owner/repo#run/<id>` | the run reaches `completed` — **any** conclusion, a failure included |
| `gh:owner/repo#pr/<n>` | the PR leaves `OPEN`, merged or closed |
| `date:<ISO8601>` (or `until:`) | that instant passes |
| `lock:<slug>/<phase>` | nothing holds that phase's scope any more — somebody ELSE's lock: one naming your own phase is refused (exit 2 at the script, `phase.watch-refused` at ingest) |
| `cmd:"<command>"` | the command exits 0 |

The other schemes (`phase:`, `verify:`, `unit:`, `credential:`) are listed by `phase-outcome.sh --help`.

**A ref that has already landed parks nothing — exit 3.** A wait, block or needs-human with `--watch`
refs asks the console (`POST /hooks/declaration`, 20 s at most) whether one has ALREADY landed. If so,
nothing is written, the script prints `already landed — continue: <ref> (<what it saw>)` and **exits
3**: carry on with the phase. Any other answer, or no console, writes the declaration and exits 0.

Inside your declared window a `cmd:` ref is asked at least every sixth of the window (every five
minutes when it wraps `gh run` or `gh pr`); the 5 → 15 → 60 → 360-minute back-off starts when the
window ends.

**When one lands** your OWN session is resumed (or the phase boards fresh with what landed, when the
session is not worth resuming), with `declared.landed` beside your declaration and an instruction naming
what happened — a run that ended `cancelled` gets "decide whether to re-run it". Read the instruction;
do not assume success. Three resumes per landing, then an operator errand. **A declaration is spent
only by the session speaking to it** — a `git commit` or a `phase-outcome.sh` call in the resumed
session (`isDurableProgress`; a turn or `git status` is not enough) — or by a newer declaration, the
board closing the phase, or an operator's Retry (`DECLARATION_CONSUMERS`). Once spent the watch stops:
still waiting on something else, declare again.

**`cmd:` runs your command, repeatedly**, under §Verification's policy (a denylist of mutating verbs,
an inverted allowlist for off-machine verbs, 60 seconds, a process-group kill — `npm ci` passes it), for
as long as the phase is parked: after 5 minutes, 15, an hour, then every 6 hours
(`WATCH_CMD_BACKOFF_MS`) until the phase's wait budget ends, then it reads `refused` (a 200-run
backstop, `MAX_CMD_RUNS_PER_PHASE`, refuses the same way). Write one that only LOOKS and costs little:
`cmd:"gh run list --workflow deploy.yml"`, never `cmd:"npm ci"`. Its output tail is quoted in the
journal, the resume instruction and a desktop notification — print nothing secret. A refused command is
journalled once and dropped; with `watchCmdRefs` off such a ref reads `unknown` and resumes nothing.

**`--wait-minutes`/`--until` work with `blocked` and `needs-human` too**: a person is still asked; the
clock says when the console next brings the phase up. Say both when both are true.

**Declarations are bounded; spending a bound is never a failure.** A `waiting-external` spends the
phase's wait budget: at most 4 waits (`WAIT_MAX_PER_PHASE`) and 8 h parked (`DEFAULT_WAIT_BUDGET_MS`)
unless the plan says otherwise — the count by `**Wait count:**` or the phase's `- **Wait count:** <n>`,
the time by `**Wait budget:**` or the phase's `- **Waits on:** <ref> · <max>` (a `date:` ref there
countersigns a wait up to that instant; beside a live ref it is only the backstop). Your boot prompt
states the ceiling. Past what is left, a wait naming a pollable `--watch` ref gets the rest and then
waits on that ref alone; one naming none parks on a SPENT budget — `waiting`, no clock, a `budgets`
errand for a person — never a failure, never a streak charge. So name the ref and the real end. Each
other status is acted on at most 4 times per phase (`DECLARATIONS_MAX_PER_PHASE`): a fifth is
recorded, not acted on, and parks the phase `needs-human` on `unknown:declaration-cap` until an
operator's Retry. A `blocked`/`needs-human` clock is capped at 7 days (`DECLARED_CLOCK_MAX_MS`), and
on unsupervised paths two `partial`s inside 5 minutes are one act (`DECLARATION_COOLDOWN_MS`).

**A resume is refused while the declaring session is live** (still running, or still holding the lock
on its lease): journalled `phase.resume-refused`, re-checked every 5 minutes
(`RESUME_REFUSED_RECHECK_MS`). Declare, then stop.

**`blocked` and `needs-human` require `--needs <key>`** (exit 2 without): a row of the plan's
`## Decisions` manifest or a blocker class as its short form — `phase-outcome.sh --help` lists both;
the boot prompt prints the phase's rows. The runner reads the key BEFORE your prose: `--needs
credential` classifies `blocked-declared:credential` whatever `--reason` says; a
`blocked-declared:unknown` is a key the manifest lacks — a defect. `--rule`/`--command` structure a
permission block.

## The Stop hook — the closeout contract, enforced

The runner installs an HTTP `Stop` hook (`server/runner/approvals.ts` → `/hooks/stop`). When you end
your turn it asks: **does the board read this phase done, or is a valid outcome declared?** If neither,
it refuses the stop and says to finish the closeout or declare the wait.

**A session ends when its agents do.** With the board done or `partial`/`complete` declared, a
background subagent or monitor YOU launched that still runs makes the hook refuse the exit
(`hook.stop-background`): the CLI stops it ten minutes after your turn ends, mid-edit. Either wait for
it in one bounded foreground call (`TaskOutput`, `block: true`, at most ten minutes), or `TaskStop` it
and name under **Outstanding** what it was doing and the files it touched. A turn that ends to WAIT on
such an agent with nothing declared is let go (`hook.stop-awaiting`), as is a declared wait. The 0.6×
wrap-up notice names live agents with the same choices; one killed after a handoff is named in the next
attempt's brief.

**It runs your fast lines once as you finish.** With the board done or `complete` declared, the
console runs the phase's fast §Verification lines (those measured at five minutes or less, ten in all)
on the tree as you leave it, uncommitted work included. Any red one holds the exit ONCE, naming each
line and its failing ids (`phase.fast-gate`): fix them and finish, or rewrite the handoff
`in-progress` naming what is red and declare `partial`. It never runs while the CLI is already
continuing for a Stop hook (`stop_hook_active`), never twice for one session, never on a line nobody
has measured yet, and never on a phase whose section says `- **Fast gate:** off`. The console still
re-runs every line itself at phase-finish.

- **It refuses at most twice per session** (the fast gate once more), then allows the stop.
- **It fails open** on an unreadable board, unknown phase or unreachable console; the runner's
  exit-time check is the load-bearing layer. The CLI applies no `onFailure` to `Stop`, so a Stop hook
  that cannot run lets the session stop.
- **It is not the presence hook.** `scripts/session-hook.sh` also registers for `Stop`, machine-wide,
  and always exits 0.

A turn that "will not end" is the closeout contract: write the handoff, or declare `waiting-external`
/ `blocked` / `needs-human` / `partial` / `no-defect` (`blocked` and `needs-human` with `--needs <key>`).

## Permission profiles and the deny wall

A run's **permission profile** is `guarded` (default), `trusted` or `bypass` (`shared/run-settings.js`);
profiles move only the **ask** list. The `deny` list is identical in all three, evaluated inside the
CLI with no network, and holds with the console dead. An operator can STRIKE a built-in rule
(`removed.deny` in a policy edit, per plan or globally — `approvals.ts`, `loadPolicyFor`), and a strike
holds on every profile at once. If a command you expected refused runs, read the plan's policy file.
The default deny list (`server/runner/approvals.ts`) covers pushing, hard resets and reaching outside
this repo; repository rules belong in the operator's `autopilot.json`.

A `PreToolUse` HTTP hook on `Bash|Write|Edit|NotebookEdit|WebFetch|WebSearch` parks the session and asks
a person for work that *may* proceed with their say-so. Every hook the run writes carries
`onFailure: "block"`: a hook that cannot start, times out or answers garbage BLOCKS the call. So while
the console restarts, your tool calls are refused until it is back. Retry them after a short pause,
and declare nothing on account of it.

**The protected files.** You never write `e2e/baseline.json`, `status-ratchet.json`,
`known-reds.json`, the quarantine list (`quarantine.env` under `scripts/`), a `__snapshots__/`
directory or a `*.snap` file. Deleting a `*.test.*` or `*.spec.*` file is allowed only when the
phase's section says `- **May delete tests:** yes`. The file tools, redirections, `rm`, `cp`/`mv` targets, `sed -i`, `git rm` and `bash -c`
payloads are all read. Each is a bar a change is held to, so a change must not move it. The deny
(`protected-file`, journalled `phase.guard-denied`) is the console's own classifier, served by the
HTTP hook and by the local command hook `scripts/guard-hook.sh`, which answers the same with the
console down. To change one, record it with `phase-outcome.sh … ruling --kind deferral` for a person.

**When a tool is denied**, read the reason. Do the work that does not need the tool and record what you
could not do under **Outstanding** as an operator errand. Never try to defeat the wall. A deny-list
denial is stamped on your record (`toolDenied`: tool, rule, command); a phase stopped on it reads
`blocked-declared:permission`, whose one rung, `widen-rule`, raises the permission item naming the
rule; its Grant, at the scope the person picks, resumes your own session (`references/turn.md` §A
permission block). If the phase cannot proceed, declare
`phase-outcome.sh <slug> <N> blocked --needs permission --rule "<the rule>" --command "<the command>"`
and stop. Only the console's own recorded denial drives the card: a wall described in prose, a denial
naming no rule, and the `in-turn-wait` and `poll-loop` guards offer nothing to widen.

**A session never presses its own console** (`console-forge`). The hook denies, on every profile and
before it runs, any call that would press a route or CLI verb in `shared/door-model.js`'s
`AUTHORITY_ROUTES`: answering a permission card (`POST /api/approvals/:id`, `phase-console run
approve|deny`), editing the policy, changing a run's settings (profile, carve-out, auto-grant), approving
a gate (the gate route and `/api/write`), and checking or dismissing a person's step.
It reads an HTTP client (`curl`, `wget`, `http`, `xh`) against a console's address, the CLI however
reached, and — where an opaque payload runs (`python3 -c`, `node -e`, `eval`, a script piped into a
shell, a URL in a variable) — text carrying a console address and a fenced path. A write into the
console's state or config directories (file tools or shell redirection) is denied too; your run's own
checkout and your memory there stay writable. Reads, `/hooks/*`, your own message token, the skill's
scripts and the operational verbs (`update`, `update-plugin`, `doctor`, `hooks-status`, a run's `hold`
and `release`) pass. The denial names the declaration to make instead — `blocked --needs permission`,
`needs-human --needs gates` or `needs-human --needs human-acts` — journalled
`phase.tool-denied {rule: 'console-forge', verb}`; nothing about it is widened from a card. The one
door through is the plan's `permission.destructive` row naming the press for your phase
(`` `phase-console run approve` `` names the card's route too).

**A permission block must cite a recorded wall.** The console records every wall your lane met: each
refusal of its own hook (a deny rule, every guard) and of the CLI's permission system (a tool outside
the allow list, an ungranted MCP tool, the CLI's copy of a deny rule). Declare
`blocked --needs permission --rule "<the rule>" --command "<the command>"` naming that wall: one
permission item is raised (the command, your phase, your `--reason`, the wall and its risk tier) and
you are resumed with the answer. A declaration citing no recorded wall is refused, exit 4: *nothing
refused this — run it* — so run the command first. The person may Grant at a scope (this call, this
phase, this plan, this repository or always), *Deny* — you are told "Denied — do not retry; find
another way inside the plan or say what remains" — or take it over (*I'll do it myself*), and you are
resumed once they have run it. A guard, a forced or deleting push, the host family (`sudo`,
`shutdown`, `reboot`, `mkfs`, `dd`), a protected path and a secret's value are never granted: plan
around them.

## Never wait on somebody else's clock inside a turn — and never poll

A `Bash` call that waits by construction — `until …; do sleep …; done`, `while true; do sleep …`,
`sleep 90`, `sleep 5m`, `watch -n`, `gh run watch`, a `--watch` flag, `tail -f`, a foreground `docker
compose up` — is matched **before it runs**, on every profile, by `Service.decideToolUse`, and refused
when the clock it waits on is not yours (rule `in-turn-wait`, journalled `phase.tool-denied`; not a
deny rule, never struck or widened). The vocabulary is `scripts/verify.env` (lint F16 warns from it).
`docker compose up -d` returns, so it passes.

Whose clock (`liveness.ts` `waitScope`): a named remote — `gh`, `aws`, `kubectl`, `ssh`, a URL, a deploy
verb — is somebody else's and always outranks; a local name — a `/tmp` path, a `.log`, a `[ -f … ]`
test, a `pgrep` — is your own; neither is somebody else's. **A wait on your own job is allowed.**

It judges **per statement, as bash splits it** (`liveness.ts` `splitStatements`): a statement ending in
a single `&` is backgrounded and never a wait (a later `wait` re-foregrounds them); `( … )` / `{ … }`
groups are looked into; a `$(…)` or backtick substitution is judged on its own; a quoted string is data
(`git commit -m "until … do"` commits) — except for `sleep`/`wait` and the compounds. **Data that
reaches a shell is code**: a statement led by `bash -c`, `eval`, `ssh`, `xargs`, `git submodule
foreach`, `docker exec`, `find -exec`, or piped into one, is judged whole. A here-doc body is data
unless a shell reads it (`bash <<EOF`, `/bin/bash`, `sudo bash`, `docker exec … bash <<EOF`, `ssh host
<<EOF`, `cat <<EOF | bash`). `phase-outcome.sh … --watch <ref>` is carved out. An unterminated quote
fails closed; an unreadable command is refused. `sleep 8` (a bring-up pause) passes.

**Waiting without polling.** Every tool call re-reads your whole context, so a status check costs as
much as an edit. Never make two status checks in a row (`ListAgents`, `TaskOutput`, `date`,
`tail`/`grep`/`cat` of a log, `pgrep`, `gh run view`), and never check on a subagent you dispatched.

| when | do this |
|---|---|
| **Work remains** | keep working; a background result arrives by itself as a `<task-notification>`. |
| **You need a subagent's answer** (a reviewer's verdict) | dispatch the `Agent` in the FOREGROUND; the call returns with the answer and costs nothing while it runs. |
| **You need your own shell job and nothing else is left** | wait in ONE foreground call bounded by the Bash timeout: `until <probe>; do sleep 10; done` with `timeout: 600000`, at most once per ten minutes. The console allows a wait on your own job; it refuses one on somebody else's clock. Never wait on `pgrep -f` text that is in your own command — the loop's shell matches it and the wait never ends; wait on the job's pid (`while kill -0 <pid>`) or a sentinel it writes (`until [ -f x.exit ]`). The guard refuses such a loop and names the two forms that end. |
| **Only subagents or monitors running in the background are left** | end your turn; the session stays alive and their notification wakes you. They are stopped ten minutes after your turn ends — dispatch a subagent that may take longer in the FOREGROUND. A background SHELL dies when your turn ends — never end it with one you still need. The Stop hook lets that turn end (`hook.stop-awaiting`), and liveness does not read the quiet as `silent` until `stallLocalJobMs`. |
| **Somebody else's clock** (CI, a deploy, a person) | commit, hand off `in-progress`, `phase-outcome.sh <slug> <N> waiting-external --wait-minutes <M> --watch <ref>`, stop. |

**A run of status checks is refused** (rule `poll-loop`, `shared/poll-loop.js`). Counted, your own calls
only: `ListAgents`, a non-blocking `TaskOutput`, `BashOutput`, a `Bash` made only of clock and process
probes and log reads (`date`, `pgrep`, `ps`, `sleep`, and `tail`/`cat`/`grep`/`wc`/`ls`/`stat` of a
`*.log`, a `*.output` or a `/tasks/` path), and any Bash command repeated, digits folded, within two
minutes. The sixth inside two minutes with no other call between is refused, and every status check
after it until you make a different call or go two minutes without one. One notice per lane
(`phase.poll-loop`); each refusal `phase.tool-denied`; same on every profile, nothing to widen. A
blocking `TaskOutput` and a foreground `Agent` do not count. A `Monitor` reaches the stream as
`task_type: local_bash`; the console pairs it to its tool call by `tool_use_id`.

**A wait already open when the console looks** is split the same way (`liveness.ts` `waitScope`):

- **External** (`gh`, `aws`, `kubectl`, `ssh`, a URL): after `stallExternalWaitMs` (5 min) the console
  **parks** the phase and releases its lock, in its own name (`by: 'watchdog'`), on its own allowance of
  4 parks per phase (`WATCHDOG_PARKS_MAX_PER_PHASE`), never your declared waits or wait budget. You are
  resumed on your own session id (or boarded fresh with the resume brief).
- **Local** (a `/tmp` log, a `tasks/*.output`, a `pgrep`, a `[ -f … ]`): **one nudge** into your stdin,
  and the park only after `stallLocalJobMs` (45 min).

Either park mints a watch ref from the command (`until test -f /tmp/done; do …` →
`cmd:"test -f /tmp/done"`); a minted `cmd:` ref is **NOT run** unless `watchMintedCmdRefs` is on (it
ships off) — until then it reads `unknown` and you come back on the park's own clock. With
`stallAutomaticPark` off nothing parks by itself; the stall card and the nudge still happen.

**A ref-less wait after that refusal is adopted or refused.** `waiting-external` without `--watch`
after the guard refused an in-turn wait this attempt: the console mints the ref from the refused
command, else takes the phase's `- **Waits on:**` refs, else REFUSES the declaration and parks the phase
`needs-human` with a `blocked-declared:external` errand — each step journalled `phase.watch-missing`.
Name the ref yourself.

A §Verification command is exempt from all of it; it has its own 30-minute bound.

## Questions — held, relayed, or answered by the plan

`AskUserQuestion` is never a permission. Every call is **held** (`QUESTION_CLASS` in
`server/runner/approvals.ts`, checked right after the deny list, before any profile or allow list).

**The relay is armed** when the run answered `relay: last-resort`, the CLI is at or above
`RELAY_CLI_FLOOR` (2.1.268, from `system/init`), and this is the phase's own session (its boarding or
the resume of its own conversation — never a QA round, repair, resume with an instruction, closeout, PR
session or reviewer). The question meets the deny list, then `QUESTION_EXCLUSIONS` (`deny-list`,
`multi-select`, `destructive-option`, `run-stopped`, `repeated-key`) and the phase's budget of 8
(`RELAY_QUESTIONS_PER_PHASE`). **An excluded question is not answered by rule**: the call comes back
unanswerable, the phase parks `needs-human`, one push goes out, and you hand off `in-progress`, declare
`needs-human --needs ambiguity --reason "<the question>"`, and stop. Anything else goes on a card for
60 s (`RELAY_WINDOW_MS`): a person inside the window wins; otherwise at 55 s the console answers by the
operator's relay rules, else the sole `(Recommended)` option, else the first. **One question per lane
is open at a time.** Every answer is filed as a ruling (`references/conventions.md` §Rulings); when the
console answered, your stdin gets one sentence per question (`frameRelayAnswer`,
`server/runner/runner-core.ts`):

> No operator answered within 60 s. The console answered `<label>` by `<rule>`. This is NOT a change to
> the phase. If that answer is wrong, declare `blocked --needs ambiguity` rather than asking again.

Nothing needs saying back: carry on.

**The relay is not armed** (`relay: off`, a CLI below the floor, or no version read yet): the plan's
`ambiguity` row answers (`phase.policy-answered`; shipped answer `ruling`) and the hook says `deny` with
that answer as its reason. Under `ruling`, decide from the plan, record it (`phase-outcome.sh <slug> <N>
ruling --kind ambiguity …`) and carry on; under `ask` or `halt`, hand off `in-progress`, declare
`needs-human --needs ambiguity`, and stop. Usually the tool is not offered: **every session the relay is
not armed for is spawned with `--permission-prompts none`** (`PERMISSION_PROMPTS_CLI_FLOOR`, 2.1.259) —
anything that would prompt is denied (do not retry), `AskUserQuestion` is removed and elicitations are
cancelled. A CLI known to predate the flag runs without it (`run.permission-prompts-skipped`).

## Run settings — what an operator can change under you

**The platform's pieces (measured-console phase 12), each at your next spawn.**
- `humanStepMode` (`park` · `defer`): how a person's step meets you (`references/turn.md` §A deferred step).
- `compaction` (`console` · `native` · `alternate`) and `compactionWindow`. Under `native` the CLI
  compacts you at the window, the console's 0.8× checkpoint is off, and the 0.6× line is a notice to
  carry on, so keep what a summary would lose on disk.
- Under every arm, a wrap-up asks you to push what is green where the plan allows it, and the phase
  shows commits no push carried until one lands.
- Every session that can declare also returns its outcome as `structured_output` (`--json-schema`).
  Return the same word you declared, or `none` if you declared nothing; a different word is journalled
  `phase.outcome-disagreed` and the structured one is acted on.

`shared/run-settings.js` lists what a run may be told. **Changeable mid-run**: `model`, `effort`,
`maxParallel`, `autonomy`, the phase and run budgets, `skills`, `mcpServers`, `mcpPolicy`,
`permissionProfile`, `gitMode`, `openPr`, `reviewEachPhase`, `reviewerPolicy`, `ultracode`,
`ultraReview`, `onLimit`, `autoRecover`, `maxConsecutiveFailures`, `onlyPhases` (a scoped run FINISHES
when those phases settle — never the way to move one stuck phase; `references/conventions.md` §Scoped
concurrency), `phaseOptions`, `isolation` (a drop lands, a raise 409s), `settle`, `priority`,
`attachDefaultSkills`, and the Fix & re-QA five — `qaMaxRounds`, `qaModel`, `qaEffort`, `qaFixStrategy`,
`qaRoundBudgetUsd`. **Start-only**: `resumeRunId`, `startAfter`, `qa`, `accountId`, and the run's
answers to the decision manifest: `resumeOnRestart`, `relay`, `accounts` (`[{id, minHeadroomPct}]`),
`acknowledgedWaivers` and `manifestOverride`.

**The start door refuses before it spawns.** A fresh `POST /api/run/:slug/start` omitting
`resumeOnRestart`, `relay` or `accounts` is **400** naming the field. With them, the **prelude**
(`server/prelude.ts`) runs the plan's `## Decisions` rows and five probes — accounts, MCP, credentials,
delivery, verification — and a blocking row still `outstanding`, an unacknowledged `waived` row, or a
failed blocking probe answers **409** `{unanswered: [{key, why}], prelude}`. `manifestOverride: {by}`
starts anyway (`run.manifest-override`); a channel-less start needs `acknowledgedWaivers: ['announce']`.
A resume (`resumeRunId`) skips the prelude. `GET /api/run/:slug/prelude` shows the report;
`phase-console doctor` runs the probes with no plan. For a session: the plan's credentials were probed
before you boarded (`phase.credential-preflight`) — under credential policy `require` a missing one
parks the phase at boarding with a `blocked-declared:credential` errand; under `continue` (default) your
boot prompt names each missing credential by id: do the work that does not need it, record the rest as
an operator errand, and declare `blocked --needs credential` only if the phase cannot proceed. A policy
answer given in your place is journalled `phase.policy-answered`.

One phase can override (`PHASE_OPTION_FIELDS`): `model`, `effort`, `tools`, `permissionMode`, `skills` /
`skillsOff`, `mcpServers` / `mcpOff`, `mcpPolicy`, `autoApprove`, `ultracode`. The plan's
`- **Model:**` / `- **Effort:**` bullets feed the same resolution (`references/plan-format.md`).

**`reviewEachPhase`** (off unless turned on) dispatches a fresh reviewer session over the phase's diff
at every phase-finish (`server/reviewer.ts`), capped at a quarter of the phase budget and the
closeout's turn cap. A `requested-changes` holds this phase's dependents as a person's would, unless
`reviewerPolicy` is `comment-only` (the default; the other is `may-hold`). If your phase finishes and
the board does not move, look for a review first.

**A reviewer your PLAN orders runs in the FOREGROUND** (a `subagent_type` reviewer, a §Adversarial
review): dispatch it as a foreground `Agent`, which returns with the verdict and costs nothing while it
runs. With `reviewEachPhase` on as well the diff is reviewed twice; keeping one is the operator's call.

**The ultra tiers spend, and both are off.** With `ultracode` on, your boot prompt (and every resume or
unblock brief) says you may use the `Workflow` tool where the work genuinely fans out — a licence, not
an instruction: a workflow runs dozens of agents at once. A phase may carve itself out either way.
`ultraReview` (`off` · `each-phase` · `at-settle`) is the runner spawning `claude ultrareview` on the
operator's cloud budget, never you; findings ride the review channel under `reviewerPolicy`; a CLI
without the subcommand degrades to `unknown`, journalled.

## The remediation ladder — what happens when a phase fails

A phase that ends badly is classified into a **situation** (`shared/situation-model.js`: `verify-red`,
`done-unrecorded`, `blocked-declared`, `waiting-external`, `mcp-unavailable`, `resource-wall`,
`qa-failed`, `plan-broken`, `never-started`, …) and a **ladder** of rungs is climbed
(`server/runner/ladder.ts`, table in `shared/ladder-model.js`): re-board fresh, resume your session with
an instruction, re-board with a resume brief, a bounded unblock session, a closeout agent, a fix agent
at a stronger model, a plan-repair pass, another account — and, when exhausted or a person's to begin
with, an **errand**. Never the same rung twice per situation per phase; defaults 3 rungs and $100 per
phase, 10 and $400 per run, $600 per day per console (Settings ▸ Automation).

An errand **stands**: re-read every five minutes, rewritten only if the ask changed. A block on the
console's permission wall (`blocked-declared:permission`) climbs one rung, `widen-rule` (§Permission
profiles); record what you could not do under **Outstanding** and stop. Two operator opt-ins, both off:
`allowUnverifiedPhases` passes a phase with no §Verification on its handoff alone
(`phase.verify-waived`), and `ladderExtendOnProgress` grants one more rung, once, when the newest
settled rung landed commits (`phase.ladder-extended`). Neither moves the deny wall or a capability flag.

- **A phase you did not finish will be tried again, differently.** Uncommitted work in the tree is the
  previous attempt's — read `git status` first, and never `git stash` / `git checkout --` /
  `git reset` it away.
- **Declare; prose routes to nothing.** `blocked` / `needs-human` fetch a person, their `--needs <key>`
  choosing the rung; `partial` resumes you; `waiting-external` parks and comes back.
- **A remediation is a SESSION under this run.** `fix-agent`, `closeout-agent`, `plan-repair-agent` and
  `stale-claim-takeover` spawn `claude -p` in the run's frame: its settings file (deny wall, hooks),
  profile, lane, scope grant, lease, journal, account and tree, briefed from outside with no
  `--resume`. A pty is minted only for the operator's own button, or on a console with `--allow-agent`
  but not `--allow-run`.
- **A repair declares how it went.** `phase-outcome.sh <slug> <N> <status>`: `complete` settles the rung
  `fixed` (retiring the stop); `no-defect` — "I looked, and there was nothing to fix" — settles
  `no-defect`, the stop standing; `blocked`/`needs-human` settle `no-defect` and keep the errand;
  `partial` settles `work-in-progress`. Declaring nothing settles `failed`, quoting your last words.
- **`plan-broken` starts on a free rung**, which edits INDEX.md, handoff frontmatter and lock files, so
  only under **`--allow-writes`**; otherwise the ladder falls through to the repair session.
  `scripts/repair-artefacts.sh <slug> [--apply] [--reset-not-started N]` repairs an INDEX status cell
  against its handoff's frontmatter, a `depends_on` against the plan graph, an expired lock, and a
  `blocked` marker from an attempt that never started — idempotent, never a plan table or handoff body.
  Run it bare to see; `--apply` changes.
- **Worktrees and branches a session makes are registered** (`run.agent-artefacts`), never deleted.
  When another live session shares your repository, work in the checkout you have, or declare `blocked
  --needs lock --watch lock:<holder-slug>/<holder-phase>` — the holder's lock — and let admission queue
  you.

## When a run stops itself — halts, the fence, the connectivity wait

A **halt** has a kind (`HALT_KINDS`, `shared/recovery-model.js`): `PHASE_HALT_KINDS` settle one phase and
the run boards its other candidates (`verify-failed`, `no-handoff`, `phase-blocked`, `needs-human`,
`verify-timeout`, …); `RUN_HALT_KINDS` stop the run (`budget`, `failure-streak`, `credential-refused`,
`models-exhausted`, `plan-deadlocked`, …); `PLAN_HALT_KINDS` (`plan-lint`, `plan-unreadable`) end when
the plan lints clean. Each reaches the operator as ONE card with **Recover & continue**.
`failure-streak` and `credential-refused` are press-only (`PRESS_ONLY_HALT_KINDS`). Full list:
`docs/loop.md`.

- **The streak counts failed PHASES.** Only a merit failure charges it — a red final §Verification, a
  lint left failing, no handoff and nothing on disk, a declared `blocked`, every attempt crashed — and
  one phase failing twice is one failure. A retry-rescued command, a spent wait budget and an ending the
  board contradicts charge nothing. A `blocked` you declare is a charge; a `waiting-external` is not.
- **A refused credential and the network never charge.** A `connectivity` stop waits on the network
  (wait kind `connectivity`) and resumes when the API answers; `credential-refused` waits for a sign-in.
- **`blocked --watch <ref>`** on a pollable ref parks `waiting` on that ref (`declared-wait`), no charge.
- **A declared external wall fences its scope.** While a phase sits on `needs-human` / `blocked --needs
  external` that can still come down by itself (a live watch ref, or an errand inside its wait budget),
  every candidate whose scope intersects it is held `queued` with `waitingOn: [{kind: 'fence', …}]`
  (`applyScopeFence`, `server/runner/scheduler.ts`); disjoint phases board. A fence in your brief is not
  yours to clear.
- **`withdrawn`** is a lane that never spawned (a sibling took the scope, or a park withdrew its queue
  entry): free, uncapped, the rung still climbable.
- **The console runs its own git in your tree** (verification, landing, merge-back) with
  `GIT_CONFIG_NOSYSTEM=1` and `core.hooksPath=/dev/null`. A hook path, fsmonitor, driver or credential
  helper in the tree's git config halts the phase `run-tree-config` ("A session changed its tree's git
  configuration in a way the console will not run.", `phase.run-tree-config`); an `index.lock` older
  than two minutes that nothing writes halts it `run-tree-locked` ("A git lock file nothing is writing
  blocks the run's tree."). Both are phase-level. Never `git config` a hook or helper into a run tree,
  and never leave a `git` running in the background past your turn.
- **A loaded machine holds new work, never yours.** No NEW lane is admitted while CPU busy over the last
  30 s is at or above 85 % (at the default `loadGuardFactor` 1.5, scaled by the factor, held to 5–98 %)
  or the 5-minute load average exceeds factor × cores × 2; `0` disables it. A HEAVY §Verification or
  baseline line (a suite, a build, a gate) takes a seat in one machine-wide budget (cores / 7, at least
  1): `phase.verify-queued` while waiting ("verification queued — …"), `phase.verify-dequeued` when it
  runs. A queue, not a hang. When the session ends, whoever ended it, your orphaned test runners — and
  every process one of them started, a Playwright `webServer`, a dev server — are reaped, except a job
  your park's watch names: its sentinel's path (or a sibling of its stem, its log) or the pid it
  probes. That job is spared for 12 hours, the console's own in-turn wait checkpoint included; a
  declared `waiting-external` spares every detached job for the same window.

## Budgets that stop work — and the verb that raises one

Every budget that can stop work — a phase's wait budget, phase or run dollars, the ladder's cap, the
failure streak — announces under the `budget` category at 80 % (`phase.budget-approaching`) and when
spent. The operator raises it with `POST /api/run/<slug>/raise-budget {budget, phase?, add? | to?,
scope?}` — `wait` writes the plan's `Waits on:` max or `Wait budget:` through `scripts/wait-budget.sh`;
`phase-usd`, `run-usd` and `ladder` patch the run — journalled `run.budget-raised`, then a retry. The
streak is cleared (`clear-streak`), never raised. A spent wait budget parks your phase with a `budgets`
errand, and your session resumes when it is raised (`docs/controls.md`, `docs/session-budget.md`).

## What a status word means — the status model, and the lock ledger

Statuses are read through `shared/status-model.js`: each word has a **tense** (`live`, `standing`,
`settled`), an **outcome** once settled, and an **attention** level. **Amber is never derived from a
status word** — only from an open inbox item or a person-actor word (`PERSON_WORDS`: a sign-off, an MCP
or account sign-in, an outstanding decision, a landing conflict). A `stuck` phase reads **Stuck** in the
waiting paint; `halted` and `parked` runs read as waits. Describe colours in these terms; a
`needs-human` you declare turns amber through the errand it raises.

Locks are also written to the append-only **lock ledger**, `locks.ndjson` in the console's state
directory (rotated at 4 MB, one kept): who held which scope, when, and who released it. A failed write
is said once (`locks.ledger-failed`) and changes nothing.


## Freeze and thaw — a phase held, and a lock released

An operator can **freeze** a lane: its child is held, not killed, and the lane reads *frozen* in the
plan's **Run** view. Past **15 minutes** the freeze escalates by itself (wake-then-terminate, then a
record *Continue* can resume), even with the console gone (`server/runner/freeze.ts`). **Thaw** releases
it; a frozen phase is not scheduled until then.

**An operator can release your phase lock out from under you**: `scripts/phase-lock.sh` leases are
cooperative, Sessions ▸ Locks (`#/sessions/locks`) can force one, and the convergence loop releases
locks of provably dead sessions. If a `claim --force` by someone else is plausible, re-check the lock
before a long unattended stretch.

## Talking to a running phase — btw, ask and steer

A supervised phase keeps its stdin open until its first completed turn (the runner closes it at the
first result, `server/runner/spawn.ts`); after that the lane is unreachable and the verbs refuse by
name. Two verbs (`server/runner/runner-control.ts`):

- **ask** — a question, framed so the model answers and **carries on where it left off**.
- **steer** — an instruction: do this differently from here.

Either is one more turn in the same conversation; the answer shows in the plan's **Run** view under
**Sessions and their consoles**. Both are idempotent under a caller-supplied key. From a terminal,
`bin/btw` is the ask verb:

```
btw "why did you skip the cache?"
btw --plan my-plan "is that migration reversible?"
```

It finds the console owning your directory, or takes `--url` / `$PHASE_CONSOLE_URL`; the console needs
`--allow-run`. A plugin install puts `btw` on `PATH`; a clone needs one symlink (its `--help` prints it).

**For a session:** answer an *ask* and resume; treat a *steer* as an instruction that outranks the plan
for the rest of the phase, and record the departure with `scripts/phase-outcome.sh <slug> <N> ruling
--kind deviation` — the next session reads the handoff, not the chat. When the presence hook reports
your session stopped on a prompt, the inbox's `session-ask` row carries **Answer it**, and the answer
arrives as a *steer* (a lane with a pending approval card for the phase gets the card instead).

**Every verb says who sent it** (`actorOfRequest`, `server/api/actor.ts`): `via` is `cli` for
`phase-console` and `btw`, which name themselves in their User-Agent, and `api` otherwise; `origin` is
`local` or the calling host; `remoteUser` is the login the proxy verified, read only under `--remote`;
`by` is the body's LABEL (at most 64 characters), else that login, else `operator` for a browser or the
CLI and `script` otherwise. A label is never who pressed: `pressDoor` is, decided from what the request
can prove — `session` for a run token, `device` for a login the proxy verified or a signed lock-screen
action, else `local`. A script that says `by: operator` is recorded `local`, with its label; a request
carrying your own token is refused at every authority route your plan's `permission.destructive` row
does not name (`shared/door-model.js`).

**The owner key.** A passkey enrolled through `phase-console owner enroll`'s one-time link makes a
browser the `owner` door for twelve hours idle; a high-risk press needs the key touched within five
minutes. Once a console has a key, an authority press through any other door (a script, the CLI, a
keyless browser, your token) is recorded as a REQUEST (`202 {requested: true}`), shown as "asked by
<label> — confirm?", and pressed only when the owner confirms. A 202 is not a done press: declare what
you need rather than waiting on it. What the plan's `permission.destructive` row names for your phase
still executes. `/api/owner/…` and `phase-console owner enroll|lock` are in `AUTHORITY_ROUTES` (your hook
denies them); `owner status` reads. A console with no key says `ownerDoor: unenrolled`.

**A grant** answers your permission item at a scope (this call, this phase, this plan, this repository
or always); you are resumed with "The operator granted `<rule>` for <scope> until <end> — run it again"
— run the call again rather than declaring blocked a second time. Below plan scope it covers exactly
your phase and rule, and for `call` the one call; a sibling lane, another rule or the same call after
your phase settled is refused. A grant may arrive with no item of yours; the item withdraws itself with
"the AI can do this itself now". The never list (forced and deleting pushes,
`sudo`/`shutdown`/`reboot`/`mkfs`/`dd`, every guard, a protected path, a secret's value) is never
granted: say what remains. `POST /api/human-steps/:id/grant` and the revokes are in `AUTHORITY_ROUTES`.

## What happens around your phase — landing, notes, issues, the trace id

**Your branch is landed for you; you never push it.** At settle the console reads the plan's `Land:`
word; pushing is its act, behind `--allow-publish`, through a frozen argv that pushes only a `pe/*`
branch and never forces. **Never `git push`** and never open the PR by hand: under `pr` or `trunk` the
console pushes your lane and spawns a landing session for the PR. A lane that will not merge is the
plan's `Conflicts:` word; you may be resumed with an instruction to merge the run branch *into* your
lane — merge, resolve, re-verify, commit, stop; never rebase, never force, never touch another branch.
Write to the landing ledger only through `scripts/phase-landing.sh`, and only when told to.

**Notes from earlier phases arrive in your boot prompt** under *"Notes from earlier phases"* (handoff
bullets addressed to you, deferral rulings, mail queued for your boot). Say in your handoff what became
of each. Leave yours in `## Notes for later phases` — the only channel to a phase not yet started.

**One trace id** rides every line your phase writes (HTTP, drive, attempt, session, scripts, git), and a
resumed run continues it. You do not set it.

**Two detectors only mark.** `looping`: an identical failing tool call repeated over the last ten calls;
`stuck`: a live session silent for twenty minutes. About to retry the same failing command a fourth
time? Stop and declare.


## A person's turn — what the console does with a human step

How to declare one: `references/turn.md` (and `references/conventions.md` §A person's turn). A
`needs-human --step <kind> …` declaration is recorded in `human-steps.ndjson` in the console's state
directory, sends ONE `needs-you` push (title: kind and phase; its `step` block: id, kind, where, the
lock-screen actions its kind allows — *Open* and *I did it* for an act; *Allow* and *Deny*, *Open* and
*Deny*, or *Open* alone for a permission item or decision — and a `device-code` step's code), moves to
`notified`, and derives ONE `human-step` inbox row while open. The phase parks with its errand in the
step's words under `blocked-declared:human-acts` (empty ladder); its wait entry of kind `person` is
UNBUDGETED — never charged to the external-wait budget, ended by no `Waits on:` max. Journal:
`phase.human-step`. The same happens through any door (outcome file, a live run's inbox, a hand-run
session's inbox).

**One door, one list.** Every source passes `raiseTurn` (`server/turn/index.ts`): a plan's bullet, a
session's step, a person errand (an `operator-act` item), a credential the preflight finds missing (a
`secret-entry` item, proof `credential:<id>`, read by presence), an MCP server unreachable under
`require` (`mcp-login`), a converted stall and a relayed question not answered by rule (a `decision`
keeping its options). A second raise of an open source is the same item. Every inbox row asking a person
to act carries a `turn` view, and `GET /api/turn` folds them into one item per thing to do (`{round,
headline, groups, handled, counts}`) on **Your turn** (`#/turn`; one item at `#/turn/<id>`), also led on
the Runs home. An errand that IS an item announces nothing of its own; its row's *I've done this —
check* (and "Done — continue") checks the item, so a done step ends `proven`.

**The verbs**, each attributed and a ledger move: `GET /api/human-steps[?open=1]` (steps, window, next
reminder, moves); `POST /api/human-steps/:id/open` — the link for the caller's browser (`where: here`),
on the machine (`host`, behind `--allow-terminal` or `--allow-agent`, only once the caller sent back the
FULL URL it was shown), or for a command an embedded terminal that runs it on the person's Enter (any
number of times short of settled, each open journalled); `…/check` runs the proof NOW; `…/snooze`,
`…/cannot {reason}`, `…/dismiss`. Only `http(s)` links; nothing typed in the terminal reaches the
ledger, a journal or the ticket.

**The owner's moves**: `…/answer {option?, note?}` answers and proves a decision; `…/decline {reason}`
settles an `allowDecline` item as `declined` (*Not doing this*; `dismissed` is the console's
withdrawal); `…/ask {text}` records a question; `…/evidence` attaches a note, image or file (at most
160 KB each, six an attempt, screened for secrets, stored 0600 by content hash under `turn-evidence/`,
never pushed, journalled only by kind and size). Answer and decline are `AUTHORITY_ROUTES` rows (a
session's or the supervisor's door is refused at the router, your call at the hook); question and
evidence are refused to an agent's door by route. **Each answer is ONE resume per waiter**
(`pressResume`): "The operator answered `<option>`: <note>" · "The operator declined: <reason>. Do not
ask again; find another way inside the plan or say what remains" · a pass's "the person's turn this
phase declared is done". The person's questions ride that resume ("The person asked: …"); snooze,
question and attachment resume nothing. An item naming a `## Decisions` key (`decision_key`) has its
answer written to the plan's twin through `decisions.sh` FIRST, behind `--allow-writes`. **No secret is
typed into the console**: `check` refuses a body carrying one (a `secret` field or a secret-shaped
value) naming where it goes; a `secret-entry` is proven by name — its `credential:` proof, else the
keychain item `phase-console-<id>` (a 0600 file under `secrets/` off macOS).

**The check**: every *I've done this — check* gets a VERDICT — `passed`, `rejected` with what to redo,
or `needs-info` with what to send — `{state, note, redo[], read[], at, by, attempt}`, one per attempt.
By proof type: a `probe` (a watch ref, or `credential:<id>`) is read at once, a miss rejected quoting
what it read; an `answer` passes on its answer; an `attest` passes only through a person's door, marked
unverified; a `judgement` is read by a **checking session** — one short read-only `claude -p` for that
ONE item (`PE_SESSION_KIND=check`, no lock, no outcome file; Read, Grep, Glob and `Bash` held to the
verify table's read-only leads, searches only where Read's rules allow — its scratch and the docs root,
never a secret path; item and submission framed as data; at most 12 turns, $0.50 and five minutes;
model and effort from Settings ▸ Automation, `sonnet` at `low` shipped), whose verdict is the LAST
fenced `verdict` block it writes; none means the check could not run. The checker is an automatic start
(door `turn-checker`) the ceiling counts and a freeze skips; with judgement off such a proof is an
`attest`. A rejection or needs-info moves the item to `returned` and tells the person once; nothing
resumes. A pass moves it to `proven` and resumes every waiter once with what was proven, by whom and
what the check read. The `turnEscalateAfter`-th rejection (3) escalates once: a push, every attempt side
by side, and `…/rewrite` (withdrawn; the raiser resumed with the rejection history to raise a new
version), `…/cannot`, or `…/override` (the owner's *Accept anyway*). **No agent marks its own item
passed**: a verdict is written in-process by a probe or the checker for THAT item, and over HTTP only by
`override`, open to the owner alone (a `local` press on a keyless console) and denied to a supervised
session by the forge guard; `check` only asks. A judgement passes only on what the PERSON sent for the
attempt (a note or evidence) — a checker's pass with nothing sent is `needs-info`. `attest`, `override`
and `rewrite` count only through a person's door; a call naming no door changes nothing.

**The proof is a watch**, polled off the record on the `cmd:` back-off (5 m, 15 m, 1 h, then 6 h),
bounded by the step's window (seven days when none), never by a wait budget. When it lands, or *I did it
— check* finds it true (a terminal's exit 0 proves a step naming no proof; a person's word proves a
step with none), the step reads `proven` (`phase.human-step-proven`) and the SAME session resumes,
told "the person's turn this phase declared is done: …" with the step's words, the proof and what it
read. A check that does not land says what it read; the step waits on.

**It never loops.** Reminders at +15 m, +1 h, +6 h, then daily (after the last reminder, open or check),
under the first push's tag, deferred out of `reminderQuiet` hours and past a snooze. At the window's end
the step reads `expired` and the errand is rewritten; *I can't do this* does the same at once with the
person's reason. Neither re-arms; a settled step leaves the watch; a step whose phase closed or moved on
is withdrawn. So a session that declares a step stops; it is resumed told what was proven, or a person
reads the errand.

**What the console notices.** A supervised Bash call that starts an interactive sign-in — a
`SIGN_IN_SHAPES` member at a statement's lead, seen through wrappers, `sudo`, `npx`/`bunx`/`pnpm dlx`,
env prefixes, groups and chains, never in here-doc data — is DENIED before it runs, on every profile,
and the refusal carries the `needs-human --step …` declaration to make: the kind, and the tool's status
verb as `--proof` where the command judge runs that tool (`SIGN_IN_STEPS`; else no proof). A status verb
(`gh auth status`) and a non-interactive sign-in (`SIGN_IN_UNATTENDED`: `--with-token`,
`--password-stdin`, `--identity`, …) run. A lane gone `silent` with an http(s) link beside waiting words
in its last output (`SUSPECT_WAIT_WORDS`; "open this link in your browser" only for a non-loopback link)
is a SUSPECTED step: `suspectedStep` on the stall, `phase.human-step-suspected`, and the silent row
offers *Make it a person's turn* (`POST /api/human-steps/suspected`, a step born `console` that parks
nothing, withdrawn once that lane stops). The console never converts or opens one by itself. At the
launch door probe 9 runs the proofs of the plan's `- **Human step:**` bullets for the phases the run
will drive, pre-clears the proven and returns the rest (`Prelude.humanSteps`); a start records the owed
ones, born `plan`, each withdrawn once its phase's handoff reads complete. Every inbox row asking a
person to act carries one `humanStep` view (`humanStepView`, `HUMAN_STEP_FOLDS`), drawn as one card;
the row's own actions still answer it.

## Session terminals — other sessions on this machine

Every Claude session reports presence through `scripts/session-hook.sh` (SessionStart / SessionEnd /
Stop / Notification → `/hooks/session`): a hand-run session shows beside the lanes, a lock whose session
ENDED is debris at once, and a live session's lock is queued behind. The installer is
`server/hooks-install.ts` (Settings ▸ Automation, or `phase-console install-hooks`); it merges into
`~/.claude/settings.json`.

On SessionStart the hook prints your session id with the `phase-lock.sh --session <id>` instruction
(claim your lock as *yourself*, so it is released the moment you end), names the **other live Claude
sessions** in this repository (id, pid, where, the phase when known), and tells you to check
`phase-lock.sh <slug> conflicts <N>` before claiming. With no console answering, the hook drops the
event into the instance's inbox and — node present and the connection refused — drains it with
`phase-console sessions ingest`; `PHASE_CONSOLE_HOOK_INGEST=0` leaves it for the console.

A queued phase names what it waits behind: a lock's owner; `session <id> (pid N)` — a live session in
the same scope without a lock yet, for ten minutes after it starts or resumes (as long as it lives when
it already works that phase); `session cap` (`N of N lanes`); or `machine cap` (`the machine is full —
N of M lanes: …`). None is a fault in your phase.

Terminals are children of a detached **broker** (`server/pty/broker.ts`), not the console: a console
restart leaves them alive with their scrollback.

## Reading the console's API — the `?include=` projections

`GET /api/plans/<slug>` and `GET /api/state` are **projected** (`shared/projection.js`, used by server
and client):

| `?include=` | What it adds back |
|---|---|
| `prose` | the per-phase prose a `### Phase N` section carries at length |
| `document` | the plan's own markdown |
| `handoffs` | the handoff array's `outstanding` text |
| `memory` | the plan's memory file, read whole |
| `full` | the escape hatch — byte-identical to the pre-projection response |

`/api/state` takes `full` or `runs`. Groups compose (`?include=prose,memory`). **`full` must stay
byte-identical.** A field reaches a page only if a component that page mounts asks for its group (a row
expanded in place, the panel's **Inspect**, the page with **Everything** on) — follow the JSX from the
page's entry component; grepping the page's file is how a field gets projected away.

## Where the state lives — the instance rule

```
id        = sha256(<root path, lexical>)[:8] "-" basename(root)
state     = ${XDG_STATE_HOME:-~/.local/state}/phase-console
runs dir  = <state>/runs/<id>/<slug>
```

Implemented twice: `shared/instances.mjs` (node) and `scripts/instance.sh` (sourced, never executed)
for `scripts/phase-outcome.sh` and `scripts/session-hook.sh`, which find it with no console and no
node. `scripts/scope.sh` is the bash half of `shared/scope.js`, so `scripts/phase-lock.sh` and
`scripts/phase-graph.sh` read a plan's **Repos** column once; `test/engine-parity.test.ts` holds the
halves together — never fix one alone.


