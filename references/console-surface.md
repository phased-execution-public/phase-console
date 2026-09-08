# Console surface — what a supervised session runs inside

Contents: What a supervised session is · The convergence loop · The watch clock ·
The Stop hook · Permission profiles and the deny wall · Never wait inside a turn ·
Run settings ·
The remediation ladder · Freeze and thaw · Talking to a running phase ·
Session terminals · Reading the console's API · Where the state lives

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
here: **the process exits when your turn ends** (no `ScheduleWakeup`, no background watcher survives
it), and **your deliverable is the handoff** — a clean exit with no handoff and no declared outcome
reads as a failed phase, not as a quiet success.

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

**What happens when one lands:** your OWN session is resumed, with your declaration still on the
record and `declared.landed` beside it, and an instruction that names what actually happened. A run
that ended `cancelled` gets "decide whether to re-run it", not "re-check it" — so read the
instruction rather than assuming the thing you waited for succeeded. Three resumes per landing; after
that it becomes an operator errand. Once your session produces work the declaration is spent and the
watch stops — so if you are still waiting on something else, declare it again.

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
handoff, or declare `waiting-external` / `blocked` / `needs-human` / `partial` / `no-defect`.

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
those commands themselves, deliberately.

## Never wait inside a turn

There is one refusal that is NOT a deny rule, and a session meets it as a deny, so it is worth
knowing which is which. A `Bash` call that by construction waits — `until …; do sleep …; done`,
`while true; do sleep …`, `sleep 90`, `sleep 5m`, `watch -n`, `gh run watch`, a `--watch` flag,
`tail -f`, a foreground `docker compose up` — is refused **before it runs**, on every profile, by
`Service.decideToolUse` (rule `in-turn-wait`, journalled `phase.tool-denied`). The vocabulary is the
shared one in `scripts/verify.env`, the same list lint F16 warns from at plan time. `docker compose
up -d` is carved out: it returns.

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

Two remedies, and which one applies depends on whose clock you are on:

| the wait is on | do this |
|---|---|
| **a job you started** — a suite, a build, a log | background it (`run_in_background: true`, or `… > /tmp/x.log 2>&1 &`) and carry on; poll it with a SINGLE bounded check per turn |
| **somebody else's clock** — CI, a deploy, a release | commit, hand off `in-progress`, `phase-outcome.sh <slug> <N> waiting-external --wait-minutes <M> --watch <ref>`, stop |

And if a wait is already open when the console looks — the guard catches the call you are about to
make, not one you made before it existed, or one spelled in a way the vocabulary does not know — the
same split decides what happens to you, read off the command (`liveness.ts` `waitScope`):

- **External** (`gh`, `aws`, `kubectl`, `ssh`, a URL): after `stallExternalWaitMs` (5 min) the phase
  is **parked** and its lock released, exactly as if you had declared the wait yourself. Nothing is
  lost — you are resumed on your own session id.
- **Local** (a `/tmp` log, a `tasks/*.output`, a `pgrep`, a `[ -f … ]`): you get **one nudge** into
  your stdin saying what to do instead, and the park only after `stallLocalJobMs` (45 min). A local
  park carries your own loop's condition as a `cmd:` watch ref — `until test -f /tmp/done; do …`
  becomes `cmd:"test -f /tmp/done"` — so you come back when the job is genuinely finished rather than
  at the end of a guessed window. The gap exists because parking a session 40 minutes into its own
  suite does not release anything useful; it throws the suite away and runs it again.

A §Verification command is exempt from all of it: while the lane is verifying the plan is entitled to
a slow command, and that path has its own 30-minute bound and its own signal.

## Run settings — what an operator can change under you

`viewer/shared/run-settings.js` is the single list of what a run may be told. It matters to a session
because **most of it is changeable mid-run**: `model`, `effort`, `maxParallel`, `autonomy`, the phase
and run budgets, `skills`, `mcpServers`, `mcpPolicy`, `permissionProfile`, `gitMode`, `openPr`,
`reviewEachPhase`, `reviewerPolicy`, `ultracode`, `ultraReview`, `onLimit`, `autoRecover`,
`maxConsecutiveFailures`, `onlyPhases`, `phaseOptions`, `isolation` (a drop lands, a raise 409s),
`settle`, `priority`, `attachDefaultSkills`, and the five that belong to the Fix & re-QA loop —
`qaMaxRounds`, `qaModel`, `qaEffort`, `qaFixStrategy`, `qaRoundBudgetUsd`. A handful
are start-only — `resumeRunId`, `startAfter`, `qa`, `accountId`.

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
declared blocker whose reason names the console's own permission wall — a tool that was denied, a
path that was "not granted" — reads `blocked-declared:permission` and climbs no rung; the wall is the
operator's, so record what you could not do under **Outstanding** and stop, rather than spending an
unblock session on it. And two operator opt-ins, both off by default, widen what runs without a
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
  that fetch a person; `partial` routes to the ones that resume you; `waiting-external` parks the
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
of its lease.

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
