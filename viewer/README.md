# Phase Console

**English** · [فارسی](README.fa.md)

A local web console for phased execution: browse plans, phases and handoffs, see live status,
copy the boot prompt for any ready phase, and read statistics across the whole plan library.

## Start it

```bash
cd viewer && npm ci && npm run build && cd ..   # once per machine, and after an update
./start                                         # from the skill directory — opens your browser
phase-console                                   # from anywhere: a plugin install or a hub copy
```

The server is plain Node (22.18+, or 23.6+ — it runs TypeScript directly, nothing to compile). The
client is **built output**: a Vite/React app whose `client/dist` is gitignored, so every machine
builds its own copy once (a Release tarball ships it prebuilt). Skip
the build and the console still answers — with a page naming the two commands and the exact
directory — and `npm start` warns when the built client is older than the code. Nothing ever builds
implicitly: what serves is always what you last deliberately built. Once built, it works offline and
installs to a phone's home screen.

The first screen asks which directory to read — any repository containing `docs/plans`. It remembers
the ones you pick, and you can switch at any time from the **Source** panel in the left rail or from
**Settings → Source**. To skip the picker, name the directory up front:

```bash
./start ~/code/your-repo      # open this plan library straight away
./start --allow-writes        # also enable the guarded write verbs
./start --port 8080 --no-open # pin a port, don't open a browser
```

**A console belongs to a repository root**, and its identity is derived from that path, so the same
project is always the same console. Everything about that is in
[`shared/instances.mjs`](shared/instances.mjs): the registry at
`~/.config/phase-console/instances.json` and the precedence chain
`--port` → `PHASE_CONSOLE_PORT` → the project's `.phase-console.json` → the port it last actually
bound → derived.


## Keep it running

A console you start in a terminal lives as long as that terminal — closing it, logging out or a
crash all end the process, and Settings ▸ Shut down is the deliberate way to do the same thing.

It tries not to fall over in the first place. An unhandled fault, a file watch that
errors, a browser that vanishes mid-stream — each is recorded as **degraded** state and
served through `/api/state` rather than ending the process. The file watch checks itself
every minute and rebuilds if it has gone deaf, because a frozen board looks exactly like a
working one. Every exit writes down its reason to
`~/.local/state/phase-console/console.log`, and a run that wrote none is reported as a
crash the next time the console starts — so "it just stopped" is a question the log can
answer.

## Stop it

**Settings → Shut down** ends the console and everything it owns — a graceful exit that says what
it is taking with it. With nothing supervising the process, that exit is the stop.

The confirm dialog is an inventory rather than a warning, computed from the work: every live lane, the
soonest clock the exit breaks (a resume, a freeze escalation, an MCP `require` clock) and the rest
counted, the runs on disk the next boot picks up, the live Claude sessions it stops watching, the
pending approval cards, the presence events and declarations not yet read — and the command that
brings it all back. Confirming acknowledges that list: `POST /api/shutdown` refuses a bare
`{"confirm":true}` over a non-empty one, naming it, and a "stay off" always needs `"acknowledge": true`.
Restart shows the terminals' half — it has always killed every pty on the way out and never said so.
Shut down is deliberately **not** behind `--allow-run`: the one thing every console must be able to do
is stop.

`GET /api/shutdown` serves that inventory and the plan for each strength before anyone presses, each
with a `durability` word the dialog turns into its one promise — with nothing supervising the process
the word is `stays-off`, said as "Nothing brings it back" beside the command that does. The press is
announced and the announcement is awaited: the drain holds for a delivery report for up to
`SHUTDOWN_ANNOUNCE_WAIT_MS` (5 s), and a record nothing reported on leaves with the console's own
`skipped` delivery row saying why (`shutdown.announced`), so the inbox never shows a shutdown that was
quietly not sent.

## What it shows

The console is **eight destinations**, three overlays that ride the query string, and a chromeless
source picker. Every address an earlier version minted still resolves — a bookmark, a handoff link
or a push payload from an older server lands where its page went, keeping whichever half of the
address still means something (`#/ready` → `#/now?focus=next`, `#/plan/x/raw` →
`#/plan/x/source?view=raw`, `#/terminal/abc` → `#/sessions/abc`).

| Destination | Answers |
|---|---|
| **Now** | *Does anything need me, and what is running?* Four bands: the needs-you inbox with inline actions (approvals, gates, errands, expired accounts, stalled lanes, a session's question with the seconds left before the console answers it by rule, a correlated lane's **Session ask** answered by steering it — every kind acts in place, and the buttons come from the server's own `{endpoint, method, body}`, so a new kind ships working against a console nobody rebuilt; two kinds carry no button because nothing is owed: **Policy answered**, each answer the policy table gave with nobody asked, and the instance's own health as work — notifications nobody was told about, Tailscale stopped, Serve pointing at another console, a registered console down or its directory gone — each naming the command that fixes it); the operations board — one band per plan, its live lanes with heartbeat, cost, ETA, the branch AND checkout each one rides, and under them that plan's admissions still waiting for a scope (who holds it, what collided, when the lease ends); what is next up across every plan; and the plans in flight. |
| **Plans** | *Where is each plan on its route?* The list with progress, ready phases, locks, QA regime and health, filterable by status, ready, locked or repo. A plan opens on six tabs: **Route** (the transit map — phases are stations, dependencies are track, each suggested session batch is a train — plus the health panel and the verify-preflight prediction of how a phase will halt), **Phases** (state-grouped, with a drawer per phase carrying its goal, files, steps, verification, gate, lock, QA verdict and evidence), **Run**, **QA** (the gate for the plan and for each phase — the regime and where it came from, the verdicts and their rounds, what each verdict holds, the report itself, and the on/off switches), **Handoffs** and **Source** (the plan's own markdown, and its **Decisions** card — each `## Decisions` row's key, state, phase, owner, whether it blocks, source, value and evidence). |
| **Runs** | *What is this doing, why is it stopped, what did it cost?* The **orchestration board** — four columns, running · queued · waiting · frozen, a card per live run with its branch chip, spend and phase strip, and every verb that changes what happens next inline on it, Freeze all in the header — over the record of every run there has ever been, with settled-today against the day cap. Per run: the status strip, the ways forward (one renderer — there is no second place a remedy can appear), the Git card for a run on its own branch, the lanes and their session panes, the state-grouped phases with evidence, liveness and rulings, **Why this run started** (every start and refusal from the run's ledger, with the decisions it began under), **What it cost and how long it ran** (each session with who ended it, its cost, turns, time and caps, the rung settlements, and one line reconciling the sessions' own costs against the run's spend — red, naming the gap, when they disagree), the timeline (with a mark for each session, ask, policy answer and start) and the journal. |
| **Sessions** | *What processes exist, and can I get at one?* One list for autopilot lanes, agent sessions, shells and the Claude sessions the presence hook reports — and one pane, the phone-first browser terminal, for the two kinds this console holds a pty for. Agent sessions need `--allow-agent`, shells `--allow-terminal`; the list renders either way and says which flag is missing. A presence the probe saw end reads `ended · inferred`, a run's session shows the door it came through and who ended it at what cost, and the console's own MCP probe sessions are never listed. |
| **Repo** | *What did the work do to the tree — and which of several trees?* Six sections over the read-only git and issue surfaces: **History** (a commit graph with the run and lane branches decorated), **Branches** (divergence, what claims each one, which working trees hold it), **Working trees** (where the parallel work is, and what no surviving run record claims — the reclaim surface), **Changes** (any range, one file's patch at a time), **Settles** (how each run's work reached the trunk, or why it did not) and **Issues** (every repository's GitHub issues in one table, four filters in the URL, and a multi-select whose one click mints the plan-wizard ticket — freshness per repository is `fresh` · `stale` with its age · `unknown` with the reason, and a probe that cannot answer leaves the last good rows rather than emptying the list). Above them, the glance `/api/state` has always reported: the branch, its tracking counts, and what is uncommitted **under `docs/`** — the only corner that read covers (`repoInfo` scopes its `git status` there), which is why it says so. Every view is addressable and every row opens an inspector carrying the server's record verbatim. |
| **Insights** | *How long, how much, how fast, on what?* The estimate with the basis under it (`plan`, `portfolio` or `heuristic` — the same "≈ 3 days" means three different things), settled spend against the day cap and each run against its budget, **What each session cost** per plan and per account, **Cards raised** (what reached a person, what auto-grant answered, what waits now), a plan's QA verdicts and report paths, the velocity trend and completions calendar, the state/size mix, the locks and health issues, and the repos, skills and models the work runs on. Portfolio-wide, or one plan with `?plan=`. |
| **Debug** | *What did the console see?* What this process is running with — and every log this console writes, on one time axis: the run journals, the watch scheduler's decisions, the health record and every refused tool call, filterable by time, run and phase, readable here rather than only in a terminal. Plus `GET /api/debug/bundle`: one redacted JSON snapshot sized for a context window, so diagnosing a run means handing over a bundle rather than describing a screen. |
| **Settings** | *What may this console do, and as whom?* Eight sections at their own `#/settings/<section>`, ordered minimal → advanced: **Essentials** (the directory, what the console is allowed to do, the start command, the engine, the keys), **Appearance** (theme, density, terminal renderer), **Automation** (the defaults every launch opens on, the ladder's caps and the start ceiling, the stall thresholds, the boarding schedule, **Policy answers** with its **Relay rules**, and the posture read-out), **Notifications** (every kind and where it lands — console, this device, each channel — plus per-device quiet hours), **Accounts**, **MCP servers** (registry and catalog), **Permissions**, **This instance** (what is running, how it is reached, restart, shut down, and the banner of a console whose automation is held). The palette indexes all eight by their CONTENTS, so `⌘K quiet hours` finds the page. `general`, `alerts` and `process` are the pre-4.0 ids and still redirect. |

| Overlay | What |
|---|---|
| **⌘ K palette** | Search across every plan and handoff, plus every destination and verb by name. `/` opens it without a modifier. Three keys is the whole keyboard now — the 2.x list was seven single-letter jumps you had to memorise from a card you had to remember to visit. |
| **Bell drawer** | Two panels: what still needs a person, and the log of everything the console has announced (including what arrived while nothing was open to hear it). The inbox rows are the same component Now renders, so answering one on a phone clears it on the laptop. |
| **Help sheet** | The guide, in the app, at `?help=<section>` — eleven sections, deep-linkable to a single card. |
| **Usage meters** | In the chrome on every page: each account's 5-hour, weekly and per-model windows with reset countdowns — the same numbers `/usage` shows. |
| **Source picker** | `#/source`, chromeless and full-screen: until a root is open there is nothing to navigate to. Settings ▸ Essentials is the door back to it. |

The page updates itself: a watch on `docs/` pushes changes over server-sent events, so a handoff
written by an agent session appears without a reload. It is also an installable PWA: the app shell
is precached so it opens instantly (and offline it says so, rather than showing a stale board — live
data is never cached), and a new build is offered as an update toast, applied only when you accept.

## The autopilot

`--allow-run` lets the console spawn agent sessions. It is a separate flag from `--allow-writes` on
purpose: a write scaffolds a file, a run edits a repository for hours. `--no-converge` keeps the
convergence loop's automatic passes (boot, docs change, the periodic sweep, the minute after a stop)
off while leaving Recover & continue working — see *The convergence loop* below.

Each phase is one `claude -p` process, so "clear the session between phases" needs no implementing —
the process exits and takes its context with it. A phase advances only when three independent checks
agree: the plan's own verification commands pass, `validate.sh` still passes, and the board re-read
**from disk** says done. Nothing asks the session whether it succeeded.

**Before the first spawn, the prelude (since 5.0.0).** A run cannot start with a decision open: the
start door reads the plan's `## Decisions` rows and runs four probes — the declared accounts' sign-in
and headroom, the plan's MCP servers, the credentials it names (`gh`, the `claude` login, `env:`,
`keychain:`, `file:` ids — presence only, never a value) and whether anything could deliver an
announcement — and answers **409** naming each blocking row or failed probe. The launch form's first
stage, *Decisions*, shows the same report and asks the three answers every run must give
(resume-on-restart, relay, accounts); a recorded override starts anyway and journals who overrode
what. Mid-run, an intervention the policy table can answer — a manual gate with `gates: delegated`,
QA exhausted with `qa.exhausted: waive`, a console restart with `resumeOnRestart` — is answered and
journalled as `phase.policy-answered` rather than raised as a card; `blocked-declared:unknown` is
always a card. `phase-console doctor [instance]` runs the same probes by hand, plus the hooks, the
CLI version against the relay floor, `gh auth status`, the environment doctor and the console's own
health, and exits 1 naming the first failing row. The prelude is the run's; a phase asks again at
boarding. The credentials it names are re-probed (`phase.credential-preflight`): under
`**Credential policy:** require` a missing one parks the phase with an errand
(`blocked-declared:credential`), and under `continue` — the default, after the policy table's
`credentials` row — it boards with the gap on its record.

**Every automatic start names itself.** A start nobody pressed is decided at one of the
`START_DOORS` — `boot-readopt`, `wait-clock`, `converge-relaunch`, `converge-heal`, `watch-landed`,
`outcome-inbox`, `auto-reviewer` and the rest — and a person's press is the `operator` door. Every
start and every refusal is written to the run's ledger (`GET /api/run/:slug/ledger`), which the run
page's **Why this run started** card reads back one sentence per start. The automatic doors share one
ceiling per console over a sliding hour — `ceilingStartsPerHour` 40 and `ceilingUsdPerHour` $250
(Settings ▸ Automation's ladder card; 0 turns either off) — past which a start is refused
(`run.start-refused`) and one *Start ceiling reached* health announcement goes out per window. A
press is never counted and never refused.

**The outcome protocol.** A session can declare how it ended instead of leaving the runner to guess
from a clean exit: `scripts/phase-outcome.sh <slug> <N> <status>` writes one atomic JSON file to the
path the runner injects as `PE_OUTCOME_FILE`, and the runner reads, journals and consumes it on
exit. Five statuses — `complete` (advisory; the board still decides), `waiting-external` (the work
needs an external clock: a CI build, a PR auto-merge, a deploy window), `blocked` (with a
`lock:<slug>/<N>` watch ref it re-queues; otherwise the blocker statement decides — see the ladder
below), `needs-human` (parks the run for a person with the errand recorded, not counted as a
failure), and `partial` ("work remains, resume me": the session had to stop — budget, context —
without anything being wrong; the runner reads it as work in progress and continues the session
instead of nudging a closeout that may not do the work). Every prompt the runner sends
carries the unattended-session contract naming this — including the fact that `ScheduleWakeup`,
`Monitor` and backgrounded watchers do not survive a `-p` turn ending. A **Stop hook** enforces it,
belt-and-braces: a session about to end with neither a handoff on the board nor a declared outcome
is told exactly what to do instead (at most twice per session; fails open — the runner's own
exit-time check is the load-bearing layer, and the hook carries workflow, never safety).

**Waiting on external work.** A `waiting-external` outcome parks the phase as `waiting` — not a
failure, not settled: the lane, its scope grant and its lock are released so siblings run, and at
`parkedUntil` the runner **resumes the phase's own session** (`claude -p --resume`, context intact)
to verify and close out, or re-file the wait. When every startable phase is parked, the run itself
waits with the soonest clock (`waitUntil`) — restart-safe: a console reboot re-arms it exactly like
a usage-window sleep. The wait budget keeps the wait honest: at most 4 declared waits and, by default,
8 hours parked per phase (`**Wait budget:**`, or a phase's `- **Waits on:** <ref> · <max>`, raises it).
A window past what is left is never shortened — it halts `waiting-external-timeout` at once with the
arithmetic — and the budget is re-read at resume, so a clock that went by while nothing ran is ruled on
(`run.wait-overdue`: lateness journalled, refs checked, a declaring session still running refused)
rather than fired. The watchdog's own automatic park spends an allowance of its own, never the session's.

**Rulings — what a session decided.** The same script's second shape,
`phase-outcome.sh <slug> <N> ruling --what … [--why …] [--kind ambiguity|deviation|deferral]
[--cost-if-wrong …]`, appends one NDJSON line to `$PE_RULINGS_FILE` (unsupervised:
`runs/<instance>/<slug>/rulings.ndjson`). A ruling is not an outcome and nothing acts on one — it
does not park a phase, climb the ladder or end a turn — which is what makes it safe to record every
judgement call the plan did not make for you. The console ingests the ledger into the run
(`run.rulings`, journal `phase.ruling`), serves it at `GET /api/run/:slug/rulings`, puts the phase's
own on its diagnosis, and raises one `fyi` inbox row per recent one; acknowledging appends a further
line rather than editing a file a live session may still be writing to. Since 5.0.0 every line is
stamped with its id and, with `--needs <key>`, the decision key it answers: a keyed ruling is a row
of its own with **Remember for this plan** (a `## Decisions` row through `decisions.sh promote`,
source `ruling`, behind `--allow-writes`) and — when its words are an answer the console can hold
for the key — **Remember on this console** (`policy.<key>`), both `POST /api/run/:slug/rulings/:id/remember`
and both acking the ruling by name (`appendAck` refuses an ack with nobody behind it). A session does
the first as it records with `--remember plan` and asks for the second with `--remember global`.
The console's answers themselves are Settings ▸ Automation ▸ **Policy answers** — one control per
row of the policy table, the object written whole, every changed key journalled `policy.changed`
— and the plan wizard's prompt opens by reading the repository's ledgers (`Service.planFacts`),
then asks the manifest and every plan field `phase-graph.sh` reads back (`server/plan-fields.ts`,
held to the script's flag list by `test/agent.test.ts`) one numbered question at a time.
Settings ▸ Permissions raises an acknowledgeable banner (`policy.advisory`, once per boot; `GET
/api/policy` → `advisory`) when the merged ask list is empty or a shipped deny rule is struck, and
`editPolicy` refuses a rule that would never match — an empty prefix, a tool the CLI does not
provide (`shared/cli-tools.js`, plus the tools this console has seen).

**Liveness — is the lane actually working?** A wedged `Bash` call, a session reasoning in circles and
a session about to commit all read `running` with a spinner. Every live lane now exposes
`{lastOutputAt, lastToolUseAt, turnsSinceLastTool, commitsSinceStart, treeDirty, openTool?, stall?}`
on `GET /api/run/:slug`, and a 60-second ticker raises signals against it (`STALL_SIGNALS`, worst
first): `stalemate` (`stallStalemateAttempts` attempts that committed nothing and left a clean tree),
`retrying` (`stallRetryBurst` API retries in a row with nothing productive between them),
`external-wait` (below), `silent` (no output for `stallSilentMs`, naming the call open longest) and
`spinning` (`stallSpinTurns` turns with no tool call). A phase inside its own §Verification is exempt
— a build is silent and fine. One episode is one card: only transitions are journalled
(`phase.stall` / `phase.liveness`) and announced, under the **`stalled`** category (*Nothing is
happening*), on by default and deliberately not urgent. Most signals are display, notification and
manual verbs (nudge, freeze, stop the lane); two act by themselves. `external-wait` parks the lane
(below), and a lane that booted and has said nothing at all is nudged once, recycled once if it is
still silent `STALL_NUDGE_GRACE_MS` (5 min) later, and then left for a person — at most one of each
per phase until Retry, and never a session that has already done work
([docs/loop.md](../docs/loop.md)).

**The ladder in the loop.** `interrupted` and `failed` records are not terminal any more. At the top
of every drive tick, after reconcile, the runner **classifies** each of them — and each phase whose
handoff exists but is not complete — against the board, the handoff, the lock and the working tree
(`runner/situation.ts`: `never-started`, `work-in-progress`, `done-unrecorded`, `verify-red`,
`blocked-declared:<sub>`, …), climbs one rung of the remediation ladder (`runner/ladder.ts`, the same
history and caps the healer uses) through its own vehicles, and boards the phase with the **brief**
the rung names: `fresh` (the engine prompt alone — a never-started phase), `resume` (the prompt plus
a RESUMING block: handoff status, uncommitted paths, last verification, last words), `unblock` (the
prompt plus the handoff's Outstanding text and "you MAY do the work; if the blocker is an operator's,
declare `needs-human` with the exact errand" — ONE bounded session), `continue` / `closeout` (the
phase's own session, `--resume`). A blocked handoff therefore no longer halts at once: a lock
sub-kind re-queues, `credential`/`gate` park with an **errand** immediately, `unknown` gets one unblock
session and then the errand. Exhaustion parks the phase with the errand — one named ask, journalled
`phase.errand` — and the run keeps driving whatever else is ready. Journal vocabulary:
`phase.situation` → `phase.rung` → `phase.brief` → `phase.start`, `phase.errand`,
`phase.ladder-deferred` (a rung remains that only the healer can drive, on a stopped run; it names that
rung as `next`). A situation whose table holds no rung this console can drive is spent at once — the
phase parks with its errand, whose *how* says so — rather than waiting on a rung nothing will climb.
Each vehicle has a driver (`VEHICLE_DRIVERS`: `console`, `writes` for what needs `--allow-writes`,
`agent` for a fresh session or pty agent, `never`). A tool call a deny rule refused
(`blocked-declared:permission`) has one rung, `widen-rule`: a card, *Phase N: widen `<rule>`?*, whose
**Allow** strikes that deny rule for this plan and resumes the phase's own session, and whose
**Deny** — or no answer — parks the phase with the errand. The healer reaches
the same vehicle from outside the loop through `startRun({resumeRunId, reboard: [{phase, situation,
rung, brief}]})`. Opt-in is the run's own auto-recovery switch; a never-started phase re-boards fresh
regardless, because that is the run doing its job.

**The convergence loop.** Since 2.3.0 the machinery runs without anyone looking (`server/converge.ts`).
One pass per plan — `planConvergence` (pure) decides, `executeConvergence` acts, `ConvergeScheduler` is
the clock — runs **at boot** (after queued runs are re-adopted), **on a docs change** (trailing debounce
2 s), **every `convergeEveryMs`** (Settings ▸ Automation, default 5 min, floor 30 s), **a minute after
any stop** (the quiet minute the old auto-recovery timer kept; a change inside it does not shorten it),
and **on Recover & continue** (now, awaited, the pins off — it is the operator's press). What a pass
does, in order: release **lock debris** — a claim owned by `autopilot/<runId>` of a run nothing is
driving, expired or not, released as its own owner through `phase-lock.sh release` (`--git` never
passed) and journalled `run.lock-debris-released`; a person's claim is never debris; **relaunch** a run
the console's own restart stopped (`stoppedBy: 'system'`): lanes a restart killed re-board through
`startRun({resumeRunId, reboard})` hinted to **resume their own session** (`brief: continue`; a session
that cannot be resumed degrades to a fresh boot with the resume block), bounded by `MAX_BOOT_RESUMES` 3
per phase and journalled `phase.resume-automatic` with its `trigger` and `path` — the same gate and
counter every automatic resume passes (an overdue wait, a lock-cap re-arm, a shutdown between lanes, a
hand session's `partial`) — with Settings ▸ Automation ▸ *Resume at boot* off the
run waits for a person with one errand naming exactly that; a lock-cap park re-arms when the lock it
waited out is gone (`phase.lock-cap-rearmed`; the live loop does the same at the top of every tick);
and a shutdown between phases simply continues. Then the **healer** (`maybeAutoRecover`: classify the
open phases, climb one rung, drive it through the runner) — once per evidence: a pass that healed
nothing remembers the evidence fingerprint and does not re-read it until something changes. What it
never touches: a run the **operator** paused or stopped (`stoppedBy: 'operator'` — Pause, Stop, an
escalated freeze; for records written before the field, any pause), a **resolved** run, a live one, a
run waiting on its own clock, a `finished` or `queued` one — and it never relaunches a run halted
`failure-streak` or `credential-refused` (`PRESS_ONLY_HALT_KINDS`): only a person's press does, a
relaunch that reaches the runner with the streak spent is refused (`run.relaunch-refused`), and the
healer still climbs that run's phases. `--no-converge` keeps the automatic
triggers off (a bare harness has them off by construction); the operator's press still converges. Every
pass that acts journals `run.converge` on the run it acted on. `POST /api/run/<slug>/recover` answers
`outcome: 'errand'` with the `Errand` body — what is needed and how to give it — wherever nothing
could be launched; there is no bare `needs-you` any more. A `done` record over a board that does not
read done is a health warning, `record-ahead-of-board`, never rewritten.

**The board is live, not per-lane.** The docs watcher pokes running loops, so a handoff written by a
manual session mid-run is seen NOW rather than when a lane settles; a reconcile pass at the top of
every drive tick closes any record the board has overtaken (`done`, noted "closed outside this run")
and dissolves halts anchored to them — it only ever closes records, never re-runs a failed phase.

**Recovery order.** Resolve first: before anything is launched, the board is re-read and reconciled
— a halt the board has moved past becomes `superseded` with nothing spawned. Then the session API:
for `no-handoff`, `verify-failed` and `waiting-external-timeout` halts with a resumable session,
auto-recovery resumes the phase's own session through the runner (settings, deny rules, hooks and
journal all apply; needs only `--allow-run`). The pty agent remains for plan-shaped repairs (an
unrunnable §Verification, a failing `validate.sh`) under `--allow-agent`, and as the manual
fallback. A recovery that finds nothing wrong records `no-defect` — the halt stands down without
inventing `done` — and a recovery finishing under a live loop hands its verdict to the loop instead
of being skipped. A per-phase recovery (`POST /api/run/:slug/recheck`, `closeout` or `resume-phase`)
is refused with 409 and journalled `run.recover.refused` when the evidence has not moved since the
last one (`unchanged`) or the phase has had `RECOVER_MAX_PER_PHASE` (6) already (`capped`); a Retry
clears the count.

**Cross-plan locks.** A foreign unexpired lock — another plan's run, a manual session, another
machine via the git-synced lock files — queues the phase behind the holder (named on the queue page
with its lease end) instead of parking it terminally. The queue wakes on the docs watcher (lock
files live under `docs/handoffs/**/.locks`), on a timer armed at the soonest blocking lease expiry,
and on the idle poll; past a 2-hour lock wait the phase parks honestly, naming the holder. While a
lane's session lives, the runner refreshes its lock every 10 minutes under the shared `PE_OWNER`
(same-owner `claim` extends the lease), so a 47-minute phase can never silently lose its 90-minute
claim; a foreign `--force` takeover is journalled and never fought. **That keepalive is a timer and
nothing more** — it is evidence a process is alive, never evidence it is progressing, so it is
deliberately excluded from the healer's `evidenceFingerprint` (`server/converge.ts`). It used to be
in it, and a lane doing nothing at all told the healer "something changed" every ten minutes.

The park and lock knobs are runner constants, deliberately not in `scripts/sizing.env` (F5
single-sources numbers both bash and TS read; bash never reads these): `WAIT_DEFAULT_MS` 30 min,
`WAIT_MAX_PER_PHASE` 4, `DEFAULT_WAIT_BUDGET_MS` 8 h (a default the plan overrides),
`WATCHDOG_PARKS_MAX_PER_PHASE` 4, `WAIT_SETTLE_GRACE_MS` 10 min (a `waiting` record whose clock
nothing will fire is settled after it), `DECLARED_CLOCK_MAX_MS` 7 d (the ceiling on a
`blocked`/`needs-human` `--until`), `DECLARATIONS_MAX_PER_PHASE` 4 per declared word,
`DECLARATION_COOLDOWN_MS` 5 min (a second unsupervised `partial` inside it collapses into the first),
`LOCK_WAIT_CAP_MS` 2 h, `LEASE_REFRESH_MS` 10 min, `RUNNER_LEASE_S`
90 min — the wait knobs beside `evaluateWait` in `server/runner/wait-budget.ts`, the rest in
`server/runner/runner-core.ts` (all re-exported through `runner.ts`). The watch clock's re-offer
series after a rejected landing is `WATCH_REDELIVER_SERIES_MS` (1, 2, 5, 15, 30 min) in
`server/watch-refs.ts`; `watchMintedCmdRefs` (Settings ▸ Automation, off) is the switch that lets a
console-minted `cmd:` ref run at all.

**Every session is capped and booked, whoever ends it.** Every `claude -p` the runner starts goes
through one door (`RunnerBase.spawnSession`), carries both `--max-turns` and `--max-budget-usd`,
and writes one `phase.session` record of one shape. The caps come from the run's `phaseBudgetUsd`
when it set one, else the phase's `Size:` through `SESSION_CAPS_BY_SIZE` — S $25 / 150 turns,
M $60 / 300, L $120 / 600; side sessions (closeout, repair, QA, PR, review) take a quarter of the
dollars and `CLOSEOUT_MAX_TURNS` 60 or `REPAIR_MAX_TURNS` 90 — and a cap the CLI reports spent
resumes the same session under double it. A deliberate ending asks the turn to close first:
SIGINT, then `INT_GRACE_MS` 5 s, then SIGTERM, then SIGKILL, so the CLI writes the `result` that
books the session's turns and dollars. `spawn.ts`'s own clocks are `SPAWN_FIRST_EVENT_MS` (20 min
with no output) and `SPAWN_INIT_IDLE_MS` (55 min silent between `init` and the first `result`).
Defined in `server/runner/session-record.ts`, `server/runner/signals.ts` and
`shared/attention-model.js`. Every child is also started with `CLAUDE_CODE_MAX_RETRIES` 15,
`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` 600000 and `CLAUDE_CODE_RETRY_WATCHDOG` 1 (`childEnv` in
`server/runner/errors.ts`) — an inherited value wins — and `phase.retry-ceiling` journals which
ceiling it ran under and where that came from.

**A lane waiting on somebody else's clock parks itself.** A `Bash` call matching the shared
external-clock vocabulary — `EXTERNAL_WAIT` in `scripts/verify.env`, the same list lint F16 warns
from at plan time — open past `stallExternalWaitMs` (5 min, `STALL_DEFAULTS`) raises the
`external-wait` stall signal, and that signal acts rather than only telling: the phase parks through the same
`parkWaiting` a declared `waiting-external` uses, **its lock is released**, and its own session is
resumed when the window elapses. The vocabulary is deliberately one string in one file read by two
languages, so what the lint warns about at plan time is exactly what gets parked at run time
(`viewer/test/verify-env.test.ts` runs both engines over the same inputs). Measured: a phase held an
exclusive claim on a whole repository for 35+ minutes inside two poll loops, invisible to every
surface — no stream event arrives while a Bash call is open, and the keepalive above kept the lock
looking healthy. Whose clock it is decides the remedy: a call waiting on the session's own background
job — a suite, a build, a log it started — is steered once to background the job and carry on
(`LOCAL_JOB_NUDGE`), and parks only past the far longer `stallLocalJobMs` (45 min,
`STALL_LOCAL_JOB_MS`). With Settings ▸ Automation's **Park a waiting lane by itself** off
(`stallAutomaticPark`, on by default) the watchdog parks nothing and the stall card stays for a person.

**The run drives to plan completion.** The board is re-read after every phase, so work a finishing
phase unlocks starts itself — the queue only ever shows what can run *now*, and the **Waiting** tab
beside the session tabs shows the rest: each dependency-waiting phase with exactly what it waits on,
so phases 10 and 11 of an 11-phase plan never look abandoned while 7 and 9 run. The run ends when
the whole graph is done, or parks naming precisely what still needs a person. Pressing Start or
Continue also restores the consecutive-failure budget — an operator back in the loop is the same
signal a phase succeeding is. Only a press does: an automatic relaunch keeps the count, and the reset
is journalled `run.failure-streak-reset` with what it was.

**What a phase runs as** is resolved from three places, in this order: what you chose for this run,
then the plan's own `**Model:**` / `**Effort:**` bullets for that phase, then the run's defaults —
per field, so choosing a model does not discard an effort the plan asked for. The journal records
which source answered each one.

**Skills.** The console lists every skill a session could invoke — personal, this repository's, and
every installed plugin's — and appends the ones you pick to the boot prompt, per run or per phase.
The plan's own `Skills (every session)` line still comes from the engine and is shown as fixed.

**Talking to a running phase.** The session's stdin stays open, so a message is one more turn in the
same conversation rather than a reason to stop it:

```bash
btw "why did you skip the cache?"     # or the box under the session console
```

Two modes, because they are different acts. **Ask** is framed as out-of-band before it is sent, so an
answer does not become a change of direction. **Steer** is the opposite and says so: an instruction to
fold into the work — with the caveat that the plan's exit criteria and its verification commands still
decide whether the phase passes, so steering a phase past its gate is not a thing that can happen.
Each message carries a tag; the console shows it once, ticks it when the CLI echoes it back, and puts
the session's reply beside the question rather than losing it in an hour of build output.

**A message is addressed at a LANE.** With three phases running there are three sessions, and the
phase the box was opened under travels with the message — the server resolves that lane's stdin and
falls back to the lowest-numbered live lane only when nobody names one. A settled lane refuses, with
the reason, rather than accepting an instruction nowhere; the box disables itself on the same fact.

The box appears in three places, from one component: the run page's lane pane, the Now page's lane
cards, and the **plan's own phase panel**, beside the state chip that deep-links to the session. On
the plan surface the gate is `PhaseView.live` — something observed to be working the phase — never
the board word, because `in-progress` is a sentence out of a handoff and not a running process. Only
a lane this console is driving can be steered; a phase held by a lock file or a terminal session says
so instead of offering a box that cannot deliver.

**Watching a phase.** A `claude -p` process is opaque by default, and a scrolling transcript answers
"what has it said" rather than "what is it doing". So the run page also reads the same stream as
*state*: the session's **task list**, its **tool calls** with a duration and an ok/error outcome each
— paired by the CLI's own `tool_use` id, so a call still running is told from one that finished
instantly — and **one lane per subagent**, matched to the `Agent` call that started it rather than
folded into a single voice. All three are rebuilt from the stored transcript, so they survive a
reload the same way the console does.

**How much is left** is estimated from what the plan has already done: each phase carries a size,
each finished phase records how long it took, and the rate is an exponential moving average of
duration-per-weight (α 0.4) over every run of that plan — recency-weighted, because model and effort
change between phases. It is shown as a coarse range and never a countdown, the band widens when
there is less evidence, and it is absent entirely until a phase has actually finished. Guessing is
what it is for; pretending to know is not.

**Stopping a phase.** Two pauses, deliberately named apart. *Pause after this phase* waits for the
work in flight to finish and be verified. *Freeze now* stops **every** running session where it
stands (`SIGSTOP`) — instant, reversible, and it loses nothing, because each process is still there
holding its session. A freeze left longer than fifteen minutes converts itself into a checkpoint
instead: the child is asked to stop, its session id is written into the run, and Continue picks it
up with `--resume`. A stopped process holds its memory and a prompt cache that expires anyway, so an
overnight freeze is not the cheap option it looks like.

**Stopping one session.** With several phases in flight, the run-level verbs are a bigger hammer
than one misbehaving session calls for — so every session tab (and each lane on the Runs page)
carries its own **Freeze/Continue** and **Stop**. A per-session Freeze is the same `SIGSTOP`, scoped
to that lane; the run keeps its other sessions working and only reads `frozen` when nothing is left
running. A per-session Stop ends that session (SIGCONT first, then SIGTERM, then the 15-second
SIGKILL backstop), records the phase **interrupted** with its session id kept — Retry can resume it
— and hands the loop straight back to scheduling: the rest of the run carries on, and phases that
depended on the stopped one wait honestly. A queued phase's Stop simply takes it out of the
admission line before anything spawns. None of it touches the failure budget: an operator's stop is
neither a failure nor an endorsement.

**Being told.** Four paths, in increasing order of how far they reach — and one of them keeps a copy.

The **inbox** (`#/notifications`) is the copy. Every announcement is written to an append-only log
before any of it is delivered, so it is complete by construction: an event that arrived with the
phone asleep, no tab open and no device subscribed is still there in the morning. Grouped by day,
unread first, filterable by category, and each row opens the thing it was about. It survives a
restart, holds 500 records or 30 days, and is cleared only when you say so. Every row also carries
what became of it per device — `sent`, `throttled`, `failed`, `gone` — because a push that quietly
went nowhere is otherwise indistinguishable from one that worked.

*In this tab* is the Notification API: free, instant, and gone with the tab. *On this device* is a
push subscription — a service worker and a VAPID keypair, so the notification arrives with the
console closed and the phone locked. Both are in **Notifications → Settings**, per device, across
sixteen categories: permission needed, a session waiting on you, a phase needs you, a gate needs a
person, a QA verdict owed or failed, run halted, run parked or waiting, nothing is happening, phase
finished or failed, plan finished, work became ready, plans changed on disk, a session ended, console
problems, usage limits, usage climbing. Five are sent urgent: permission needed, a session waiting on
you, a phase needs you, a QA verdict owed or failed, and run halted. A push names the console it came
from — its title ends `· <console>` — and a delivery that found no subscribed device, or none taking
that category, is recorded `no-device` rather than dropped silently.
A **Send a test** button goes out through the real push service and back, so it proves the chain
rather than the last hop. An approval notification carries **Allow** and **Deny** as notification
actions, so answering from a lock screen is one tap.

`PHASE_CONSOLE_NOTIFY=<command>` covers what neither can: a machine with no browser in the picture at
all. It is run as `cmd "<title>" "<body>"`, and is an environment variable rather than a setting
because it runs a command on this machine.

Every destination is decided by one function (`routeFor`), used by the SSE announce, the push
payload, the service worker and the inbox row alike, and a test walks the catalogue against the
client's own router. Before it there were two hand-written URLs and both named a tab that does not
exist, so every approval notification for the life of the feature opened the wrong page.

Payloads are encrypted to the subscribing browser ([RFC 8291](https://datatracker.ietf.org/doc/html/rfc8291)),
so a push service relays a notification about your plans without being able to read one. As with the
rest of this console, there is nothing to install — `node:crypto` has every primitive it needs.

**What it will not do.** `permissions.deny` is handed to every session at CLI scope and is the layer
that holds with this console dead — measured, not assumed. The `ask` list goes through an HTTP hook
that **fails open**, so it carries workflow and never safety. Settings shows both, and says which is
which.

### Permissions: how much a run may do

Three profiles, chosen when a run starts and changeable while it is running:

| Profile | Ask list | Child argv | Use it when |
|---|---|---|---|
| **Guarded** (default) | in force — commits, installs, merges raise a card | `--permission-mode acceptEdits` | you are around to answer |
| **Trusted** | emptied | `--permission-mode acceptEdits` | an overnight run on work you trust |
| **Bypass** | emptied | `--permission-mode bypassPermissions` | the CLI's own prompting is in the way too |

**`deny` is identical in all three.** A profile only moves the ask list — "identical" meaning
whatever the operator's edited wall currently holds, struck rules and additions included. That holds
under Bypass too — the CLI's own description of `bypassPermissions` is that it "auto-approves every
tool call *except explicit deny rules*".

**Bypass needs a disclaimer you can only accept interactively.** Read out of the CLI: given
`--permission-mode bypassPermissions` without it, Claude Code does not error and does not honour the
flag — it silently downgrades to `default`, and `default` in `-p` mode means prompting a terminal
that is not there, i.e. refusing every edit. So on a machine where nobody ever accepted it, Bypass
produces a run that can do **less** than Guarded, for no visible reason. Accept it once in a normal
`claude` session, or use Trusted. The console watches for the CLI's own downgrade line and surfaces
it rather than letting the phase quietly fail.

Switching mid-run is journaled as `run.permission-profile`
with who did it, takes effect at the hook on the *next tool call*, and reaches the child's argv at the
next phase — the running child cannot reload its own settings, and the console says so rather than
implying otherwise. A run on anything but Guarded carries a banner for as long as it is in force.

**A question is not an ask, and no profile silences one.** `AskUserQuestion` is its own class
(`QUESTION_CLASS`), checked right after deny and before the ask list, so emptying the ask list under
Trusted or Bypass never turns a question into a silent allow. The hook holds it: with a relay armed
the question becomes a card (*When nobody answers*, below); without one the policy table's
`ambiguity` row answers — under its default, `ruling`, the session is told to decide from the plan,
record a ruling and carry on, and under any other answer to declare `needs-human` and stop —
journalled `phase.policy-answered` with `class: 'question'`. A session the relay does not arm is
started with `--permission-prompts none`: anything that would prompt is denied with the session told
nobody can approve, `AskUserQuestion` is removed and elicitations are cancelled. A CLI known to
predate the flag (`PERMISSION_PROMPTS_CLI_FLOOR`, 2.1.259) gets no flag and the run journals
`run.permission-prompts-skipped` once; an unknown version still gets it, so an old CLI fails loudly at
spawn rather than dropping the floor unnoticed.

### Auto-grant: who answers the ask list

Since 2026-08-23 the console **answers ask-list cards itself by default**: the ask still happens —
the classifier still says ask, the hook still holds — but the answering hand is the console's. Every
auto-granted card is recorded in the approvals history (`decided by auto-grant`) and journaled
(`phase.approval-auto-granted`, with the rule it matched), so nothing is asked less; it is only
waited on less. The deny list is untouched, a wrapper hiding something deny would stop still gets a
person, and verification sign-offs and gates are never auto-granted. **Publishing is never
auto-granted either**: `git push` and `gh pr create` (`OPEN_PR_ASK`) wait for a person unless the
plan's or the run's `permission.destructive` row names that rule as an exception — a grant under one
is announced, *Published under a plan exception*, and its journal line carries the exception. Three scopes, most specific wins: per phase (the launch
dialog's per-phase **More** panel) → per plan → everywhere (Settings ▸ Permissions), default ON.
Turn it off at any scope and those cards wait for a person exactly as before. Insights' **Cards
raised** panel counts both sides since a date — raised for a person, answered by auto-grant, waiting
now, last raised — from the same counts `/api/state` serves as `approvals` (`raised`, `autoGranted`,
`since`, `lastRaisedAt`, `pending`).

### Writing a rule from the card that interrupted you

An approval offers **Always for this plan** and **Always everywhere**, each showing the exact rule
before it writes it. That rule is derived from the ask rule that actually stopped the call, so
accepting it cancels precisely what interrupted — and it is written *before* the card is settled, so
the session's next call is already classified under it.

- Plan-scoped rules live in `~/.config/phase-console/plans/<slug>.json`; global ones in
  `~/.config/phase-console/autopilot.json`. Both are additive over the shipped defaults.
- Evaluation is **deny → an allow you wrote → ask → allow**, first match winning, specificity
  irrelevant. The one deviation from Claude Code's own order is deliberate: a plain allow rule can
  never cancel an ask rule, so "Always allow this" would otherwise write a rule and change nothing.
- Every write is journaled as `policy.edited` against the live run, with the author and the scope,
  and is removable from **Settings → Permissions** with the × on its chip. Shipped defaults are
  removable the same way — struck by name at the chosen scope (so an upgrade that ships a new
  default still applies it), listed struck-through beneath the chips with a ↩ to bring one back,
  and each part has a **Restore defaults** button that returns it to stock in one act. That
  includes the shipped **deny** list: striking one of its rules is the widest edit the page can
  make — the wall moves for every future run, the CLI-side settings each child runs under
  included, with this console dead included — so that one strike, and only that one, asks you to
  confirm first. Your own deny additions stay one-tap removable as always.
- **This widens as well as tightens**, which reverses the console's earlier rule that a browser could
  only ever make a run more careful. What that produced in practice was ten `git commit` cards in one
  run and a person tapping Allow without reading — the failure the strict version existed to prevent,
  by a different road.

### Which rules this console can actually enforce

The PreToolUse hook only fires for `Bash`, `Write`, `Edit`, `NotebookEdit`, `WebFetch` and
`WebSearch`. Rules about anything else — `Read`, `Agent`, `Cd`, `mcp__*` — are real and the CLI
enforces them, but nothing here will show you one being hit, and Settings labels them `cli-only`
rather than implying otherwise. The supported forms are the documented taxonomy: bare tool,
command prefix (`Bash(git commit:*)`), command glob (`Bash(npm run test *)`), one parameter
(`Agent(model:opus)`), paths (`Read(~/.ssh/**)`), domains (`WebFetch(domain:*.example.com)`), MCP,
agent types and `Cd`.

The edges are surfaced in the UI because each has cost someone an afternoon:

- `Bash(ls:*)` is `Bash(ls *)` — it does **not** match `lsof`. `ls *` and `ls*` are different rules.
- Wrappers are seen through — `timeout time nice nohup stdbuf command builtin noglob` and bare
  `xargs` — but **not** `npx`, `docker exec` or `devbox run`.
- `watch`, `setsid`, `flock` and `find -exec` never auto-approve: what they run cannot be seen from
  outside, so they get a card.
- Only `Read(…)` and `Edit(…)` path rules are consulted; `Write(…)`, `NotebookEdit(…)` and `Glob(…)`
  paths are ignored. `Bash(command:rm *)` parses and does nothing. Settings lists any such rule you
  have written under **These parse and do nothing**.

### When nobody answers

A tool card waits **an hour**, not ten minutes. At ten, a real overnight run had a commit refused
because everyone was asleep — the worst outcome available, since the work was done and the session
was told "no" for a reason that was really "you were away". While a card is open the run reads
`waiting` on a person (`run.waiting-person`, naming the card and its deadline) rather than running.
The hook is still answered before its own timeout (silence fails open), but a timeout **parks the
run** with kind `awaiting-person` instead of letting the session treat the refusal as a verdict about
the work: `run.parked`, no failure charged, phase retryable the moment the card is answered.

**A card outlives a restart when its session does.** At boot the console adopts a surviving child's
hook token from its settings file and puts its answerable tool cards back to pending; a card that can
no longer be answered reads `unanswerable` — the word that replaced `expired` — with its reason:
`session-gone`, `token-lost`, `asker-gone`, `reoffered` or `hook-closed`. An answer a person gives a
recovered card is kept, once, and handed over when the session repeats the call.

**A question gets a minute, then a rule.** The launch form's *Decisions* stage asks each run for its
relay: `off` (the console never answers a question on a person's behalf) or `last-resort` (a person is
paged first; after 60 s the console answers by rule). Under `last-resort` a phase session on a CLI at
or past `RELAY_CLI_FLOOR` (2.1.268) is armed (`run.relay-armed`; `run.relay-refused` names
`below-floor` or `version-unknown`), and a question it asks becomes a **question card** — on the run
page, as an inbox `question` row counting down, and as a push, *A session asks — answered by rule in
60 s unless you do* — with one button per option. A person has `RELAY_WINDOW_MS` (60 s); after that the
console answers by a relay rule, else the sole `(Recommended)` option, else the first
(`phase.question-answered`), tells the session nobody answered and that this is not a change to the
phase, and appends a ruling. Relay rules live in Settings ▸ Automation ▸ Policy answers ▸ **Relay
rules** (`relayRules`; none shipped, at most 50): a glob over the question's key, the tool
(`AskUserQuestion` unless named), the run profile (`*` for any) and the option to answer, matched
exactly or as a unique prefix. A question the relay will not answer by rule — `QUESTION_EXCLUSIONS`
(`deny-list`, `multi-select`, `destructive-option`, `run-stopped`, `repeated-key`), or one past
`RELAY_QUESTIONS_PER_PHASE` (8) in a phase — parks the phase `needs-human` and pushes *A question
needs you*.

The runner will also not execute a verification command that reaches outside the working tree unless
it can be shown read-only — `curl -X POST`, `ssh box 'systemctl restart …'` and `psql -c 'DELETE …'`
all go to a person with the reason attached, while `docker ps` and `psql -c 'SELECT …'` still run.

Every Claude session the hook reports — an agent session, a `claude` you ran in a terminal, and since
5.0.0 an autopilot lane — has a second channel: the machine-wide session hook forwards the CLI's
`Notification` events, so a session stopped at a permission prompt or an elicitation shows up as a
**Session ask** in the inbox, on the Sessions list, on the top bar's waiting-on-you chip, and as a push
(**Session waiting on you**); a lane that already has a card pending for its phase is not pushed twice
(`sessions.ask-suppressed`). A row correlated to a lane this console drives answers in place —
**Answer it** steers the lane with your words; for any other session the row says to go to the
terminal it runs in, because the console cannot answer for it. The registry keeps each episode as the
session's `lastWait` (`answered`, `ended` or `unanswered`) and closes one nobody answered after
`WAIT_ANSWER_CAP_MS` (60 min).

### What the healer reads first: the situation

Since 2.3.0 the unattended healer (and the phase page's *Why is this not done?* panel) no longer
picks a remedy from the halt kind alone. Every open phase is **classified** from evidence that
already exists — the board line, the handoff's status and Outstanding text, the run's record and
halt, the lock, the working tree of the repos the phase names, the gate, QA, MCP and health — into
one **situation** (`viewer/shared/situation-model.js`: `never-started`, `work-in-progress`,
`done-unrecorded`, `verify-red`, `blocked-declared:<lock|permission|credential|gate|external|unknown>`,
`waiting-external`, `gated-manual`, `plan-broken` (`lint`, `unreadable`, `verification`, `issue`),
`mcp-unavailable`,
`resource-wall:<usage|auth|budget|model>`, `foreign-live`, `foreign-stale`, `qa-pending`,
`qa-failed`, `superseded`, `unknown`). A **remediation ladder** (`server/runner/ladder.ts`) then
names the next rung for that situation — never the same rung twice on one phase, bounded per
phase / run / day by attempts **and dollars** (Settings ▸ Automation: `ladderPerPhaseRungs` 3,
`ladderPerPhaseUsd` 100, `ladderPerRunRungs` 10, `ladderPerRunUsd` 400, `ladderPerDayUsd` 600) —
and when the ladder is exhausted the phase carries an **Errand**: what is needed, how to give it,
what was already tried. The journal records `phase.situation`, `phase.rung` and `phase.errand`.
The rung table itself is `viewer/shared/ladder-model.js` — imported by the server's ladder, the
client and the tests by identity — so what the autopilot climbs is what every **Ways forward** group
shows: the situation chip, the rungs tried with how each ended, the rung it tries next, and, once
the ladder is spent, the one errand card (what is needed, how to give it, what was tried). The
dashboard's **Waiting on you** lists only errands, permission cards and sign-ins — a halted run
with no errand is the loop's to climb, not yours to stare at; the run page's banner lists a parked
run's errands in full; the Pulse carries a **Converge** line per plan with the loop's last pass
("re-boarded P12 (Never started → Re-board fresh) · released a stale claim on P3") from
`GET /api/converge` and the `run:converge` event; and Settings ▸ Automation's ladder card edits the
caps, the sweep, the four toggles, the one budget raise and the MCP park clock. The whole
specification — situations, rungs, convergence triggers, presence, what is still a person's — is
`docs/loop.md`.

## Sessions, and the two the console starts for you

Agent sessions and shells are processes on this machine, not objects in a tab. Closing the browser
detaches the socket and leaves the work running; reopening reattaches with scrollback. Nothing is
reaped for being idle — **a session ends when you end it, and not when the console does** — and the
cap of 8 counts live processes, so ended ones never crowd out a new one. A session that has exited
stays in the list with its status and its `claude --resume <id>` until you dismiss it, or for 24
hours.

**The ptys belong to a broker, not to the web server.** `service.close()` used to reach every pty
and end it, so pressing Restart ended every shell and every interactive `claude` on the machine —
including hours of work — and nothing threw; the work just stopped. A process cannot be re-parented
after the fact, so it now starts somewhere else. `server/pty/broker.ts` is spawned detached, with no
stdio, and unref'd — the three words that let a shutdown outlive the console — and it owns the ptys
and the scrollback. The console is its client: a `0600` unix
socket under `INSTANCE_STATE_DIR`, a credential presented on connect, and the same ticket wall,
frame protocol, resize clamp, backpressure and retention `Terminals` always had. Only ownership
moved. `resume()` adopts what the last console left running, with the **broker's session id as the
console's**, so `#/terminals/<id>` still resolves across a restart.

Three consequences worth knowing before touching this:

- **`Terminals.close()` no longer kills, and the one guard is whether the spawn was injected.** A
  test that injects its own `options.spawn` owns its ptys and still has them killed; a real console's
  belong to the broker and are let go. Change how that is decided and a restart destroys the
  operator's work again — `pty-broker.test.ts` red-proves it in those words.
- **A deliberate shutdown keeps sessions too**, not only a restart: both go through
  `service.close()`. It is bounded rather than immortal — a broker holding sessions never retires,
  and exits once the last one ends. Both dialogs read `sessionInventory().survives` and list
  survivors under *"This keeps running"*, because claiming to stop a session that survives is the
  same defect as the silence it replaced.
- **The broker knows nothing about labels, kinds or `--resume` ids.** They travel as an opaque blob
  it stores and hands back, which is what lets a console that has never seen a session rebuild the
  whole record. It does not use `log.ts` either (that would reach `config.ts` and re-resolve an
  instance); it appends capped NDJSON to `pty-broker.log` beside its socket — **read that first**
  when a terminal misbehaves.

**Session presence — the hook.** The console also knows about sessions it did not start. A
user-scope Claude Code hook (`scripts/session-hook.sh`, installed from Settings ▸ Automation ▸ Session presence or
`phase-console install-hooks` / `uninstall-hooks` / `hooks-status`; it edits `~/.claude/settings.json`
by merging four entries and never touches another key) reports every Claude session on the machine
whose working directory a console owns — SessionStart, each finished turn, a prompt it stops at
(Notification), SessionEnd — to that
console (`POST /hooks/session`, loopback only), or into the instance's inbox when it is down. The
registry (`GET /api/sessions/registry`, and the Pulse) lists them with a three-valued presence:
*live*, *ended*, *unknown*. A phase lock that names its session (`phase-lock.sh --session`, or the
`PE_SESSION_ID` the runner exports) becomes debris the moment its session ends — the scheduler admits
the phase queued behind it and the convergence loop releases the file — instead of at the end of its
lease; a live session's lock is a queue to wait in; a lock nobody reports keeps lease rules. And a
`phase-outcome.sh` run in a session nobody supervises (no `PE_OUTCOME_FILE`) lands in
`runs/<instance>/<slug>/outcomes/`, where the console picks it up: a `waiting-external` parks the
phase and resumes that very session at the window, a `partial` boards it again with a resume. Off by
default — installing the hook is the operator's choice.

A presence is a claim the console settles against the process: an end the hook reported is
`endedBy: 'hook'`, and one the probe found — the process gone with no `SessionEnd` — is
`endedBy: 'probe'`, dated at the last evidence of life and shown as `ended · inferred`. The console's
own MCP health probes run with `PHASE_CONSOLE_PROBE=1`, and the registry keeps them out of every
session view. When no console is up the hook's events wait in the instance's inbox, and
`phase-console sessions ingest [instance]` drains them by hand — it does nothing while that instance's
own console answers, and the hook itself runs it after a POST that did not arrive — applying an event
older than 10 minutes as history (no push, no lock reaction), refusing one older than 7 days, and
taking `sessions/inbox.lock` so two drains never race. A session a run started also shows, on its
vitals, the door it came through and who ended it at what cost.

**And a reported session is a terminal you can open.** The list could once only say a foreign session
*existed*: the row built no id, so `#/sessions/<id>` resolved to nothing. A foreign row now carries
its CONVERSATION — kept apart from `id`, which is a pty this console owns and can close, and is what
decides whether there is a Close button — and the address resolves in three tries: a pty, then a pty
already **resuming** that conversation, then the registry record, and only then "gone". What the page
will not do is pretend: nothing attaches to a terminal someone else is typing at, because there is no
multiplexer here. So an `ended` session gets a plain Resume and a `live` one (or `unknown`, read as
live) gets Take over behind a confirm saying a second `claude` joins one conversation and the one you
can see keeps running. Without `--allow-agent` the action is not offered and the page names the flag.

The resume is spawned in the directory the **registry** says the session was working in, and that is
measured rather than assumed: `claude --resume <uuid>` resolves a conversation *globally*, so a
resume from the console's root does not fail — it succeeds in the wrong repository, with different
relative paths, a different git repo and a different project `CLAUDE.md`, and nothing says so. The
browser sends an id and nothing else; the server reads the record, exactly as it does for a recovery,
a review and an account.

That makes the record's `cwd` a **spawn parameter**, and `POST /hooks/session` is deliberately
exempt from the console-header and Origin checks — a shell script feeds it, not a browser — which
also makes it reachable as a cross-origin simple request. The mint itself is CSRF-guarded, so the
attack needs a real click, and the guard therefore sits at click time: a directory outside the open
root and the recent ones takes the confirm, **even for an ended session**, and puts the path in
front of whoever is clicking. It is matched on a path boundary after normalising, and a `cwd` that
is not already in normal form is unfamiliar by that fact alone — a record written by a shell hook
carries `$PWD` and never has a `.` or `..` segment, so the only thing that arrives denormalised is
something that wants to look like somewhere else. (`/repo/../../tmp/evil` starts with `/repo/`; the
first version of this guard read it as familiar while the server resolved it and spawned in
`/tmp/evil`.) The page still displays the string the record holds — showing a tidied path the record
does not contain would hide exactly this.

Two kinds are composed for you rather than typed:

**Recovery.** Each way a run comes to rest has a session that answers it — a failed verification, a
phase that did the work but wrote no handoff, an interrupted run, a run stopped at a sign-in, a stale
claim, a plan that will not parse. **The server composes the prompt**, reading the board, the run,
the phase diagnosis, the lock and the health issues itself; the browser names only the target, which
is both the security property and the honest one. It refuses while the autopilot is driving, refuses
a second recovery for the same phase (linking to the live one instead), and on exit re-reads the
board from disk to say whether the phase actually went green.

**Review.** Any finished phase can be handed to a fresh session for QA. The brief is the skill's own
`phase-graph.sh --qa-prompt N`, embedded verbatim, plus what the engine cannot know: the handoff the
phase wrote, its key files, the commits that touched it, and that phase's exit criteria and
verification quoted rather than summarised. It will not resume the session that built the phase, run
while the autopilot drives, run while a session is still building that phase, or start twice for one
phase. **The session records the verdict with `qa-record.sh`; the console only reads it back** —
`test-status.md` is re-read on exit and compared with a snapshot taken at launch, so a session that
ended without recording one is reported as exactly that.

Both ride `POST /api/terminal` behind `--allow-agent`; neither adds a route, and a prompt past
`MAX_AGENT_PROMPT_BYTES` (32 KB) — typed or composed — is refused with 400. `permissionProfile`
(`guarded` | `bypass`) is accepted **only** with a review and refused on every other agent session.
Turning QA on for a plan (`POST /api/plans/:slug/qa-mode`, `--allow-writes`) goes through the
skill's own `--qa` path, which waives the already-finished phases rather than gating them.

## The rule it follows

`phase-graph.sh` is the only source of truth for **done / ready / waiting**, session batches, boot
prompts, QA regime and lint. The console shells out to the skill's own scripts for all of that and
never recomputes it. JavaScript parsing covers only what the scripts do not expose — prose sections,
phase detail, handoff bodies — plus analysis they do not provide (critical path, unblock value,
velocity). `test/engine-parity.test.ts` re-derives every plan's board from the JS parse and asserts
it matches the engine, so the two readings cannot drift apart unnoticed.

**A process is a fact; a record is a claim — so settle the claim against the fact.** A phase-9
session once outlived the console that spawned it, sat stopped for three and a half hours holding
its session id and its lock, and its run record went on reading `running` the whole time: the record
had been settled against the run's own status, which is another claim by the same dead writer.
Three rules came out of that, and `test/invariants.test.ts` enforces all three.

- **One place asks.** `server/pid.ts` holds the only liveness probe — the only `kill(pid, 0)` and the
  only shelled `ps` in `server/`. It answers four ways rather than two: `running`, `stopped`,
  `zombie`, `gone`. Two probes disagreeing about one process is how a stopped session read as alive.
- **One place acts.** `server/runner/signals.ts` holds the only teardown ladder: wake the child with
  SIGCONT first (a stopped process queues SIGTERM and never runs its handler), signal its process
  **group** so its bash, its MCP servers and its subagents go with it, and always leave a SIGKILL
  backstop — awaited, never armed on a timer that would die with the console that set it.
- **The handle outlives the console that made it.** A run's `children` map is merged, never rebuilt,
  so a child a *previous* console started survives a fresh one's recovery byte-for-byte and only the
  probe may drop it. And no reader ever sees a record claiming work in flight over a process that is
  gone — whatever the run says about itself.

## Writes

Off by default. With `--allow-writes` the console can run six scripts, each behind a dialog (or, for
gates, a press-twice confirm) that shows the exact command first:

| Action | Script |
|---|---|
| Scaffold a plan | `new-plan.sh` |
| Scaffold or repair a handoff | `new-handoff.sh` |
| Record a QA result | `qa-record.sh` |
| Approve or revoke a phase gate | `gate-approve.sh` — the phase page's **Gate card**; an approval clears a gate of any kind, and can continue a run the gate parked |
| Claim or release a phase | `phase-lock.sh` |
| Turn QA on for a plan | `new-handoff.sh … --qa` (it backfills finished phases as waived) |
| Close or reopen a plan | `close-plan.sh` (a status and a one-line reason; reopening needs neither) |

`--git` is never passed, so the console never commits or pushes — that stays a deliberate act in a
terminal. Editing plan or handoff bodies is deliberately not offered; agents write those.

### Run isolation — off unless you ask, and it degrades rather than fails

The lanes below are per-PHASE and a plan opts into them. This is the other one, orthogonal: a
per-RUN checkout, so two runs whose repository scopes overlap are admitted **at the same time**
instead of queueing behind each other. Turn it on with *Give this run its own checkout* on the
launch form; it needs the **new-branch** strategy (a run with no branch has nothing to check out),
and on a live run it can only be turned off — the run's commits are on the branch in the checkout it
started in.

What the operator **asked for** and what the run **got** are two different facts, deliberately.
Isolation is refused on a superproject, when the disk cannot take another tree, and when the
worktree cap is reached — and every refusal degrades to the shared checkout with ordinary queue
semantics, naming which impossibility it hit in the journal and on the run page. A run never fails
because it could not have a tree. Three settings under Settings ▸ Automation govern the trees
themselves and appear only while isolation is on: how many may exist at once (shipped: 3), a setup
command run once inside a fresh one, and whether to copy the source checkout's ignored `.env` files
into it — off by default, because copying secrets into a second directory is a decision.

What two live branches are doing to each other is **measured**: the run page's Git card carries
ahead/behind, the changed files, the tree's disk footprint, and a `git merge-tree` verdict for each
pair of live branches — `clean`, `overlap`, `conflicted`, or `unknown` when the probe could not
answer, which is deliberately not the same as clean. A pair that turns `conflicted` raises one inbox
item whose Serialize action puts the other run back in the queue.

When a work-branch run ends, *When the plan completes* decides what its branch becomes: **pull
request** (the default, and the only ending with a person reading the diff), **merge queue** (one
more session rebases on what landed, re-runs the plan's end-to-end verification, and pushes only if
it passes), **integration** (the console merges into its own `pe/integration` staging checkout and
stops — no remote, no session), or **keep** (nothing at all). Only the two that end at a remote may
open the push carve-out. A clean tree is removed at settle; a dirty one is kept and journalled.

### Worktree lanes — off unless a plan asks

Two phases with disjoint scopes may run at once, and by default they share the run's one working
tree. A plan that writes `- **Worktrees:** on` in its §Session budget gets one checkout per lane
instead:

```
<root>/.worktrees/runs/<slug>/<runId>/
    integration/    the run branch (pe/<slug>) — where merges happen
    p4/             lane for phase 4, branch pe/<slug>-p4
    p9/             lane for phase 9, branch pe/<slug>-p9
<root>/.worktrees/staging/          the console-wide pe/integration tree
<root>/.worktrees/hand/<slug>/p<N>  a hand session's own lane (scripts/phase-lane.sh)
```

Everything the console makes lives INSIDE the instance root, under one folder the console writes
into the root's `.git/info/exclude` (Settings ▸ Automation ▸ *Worktree root*; the older placement
under the console's state directory, `runs/<instance>/<slug>/worktrees/`, is still read and swept).
A superproject's mirror keeps that shape too: the mounted repositories stand at their root-relative
paths under `integration/`. Never a sibling folder of the project, never a worktree of the
superproject itself.

**Your own checkout is never touched** — not switched, not merged in, and it does not have to be
clean. When a lane settles its commits go onto the run branch in `integration/`: a fast-forward when
nothing else moved, a merge commit when something did. A **conflict aborts the merge** and halts the
run (`worktree-merge`) naming both lanes and the conflicted files; nothing is lost, because every
commit is still on the lane branch with its checkout still there. At run end the console removes the
lanes that landed and leaves any that did not — and never deletes a branch.

It needs the **new-branch** git strategy (lanes land on the run branch) and it **refuses on a
superproject**: `git worktree add` on a repo with submodules gives EMPTY submodule directories, so a
scoped phase would board a session into nothing. Every refusal is journalled by name and the run
carries on sharing the root exactly as it did before.

**Where each session was editing outlives the console that knew.** The run's checkpoint records a
lane's `worktree` and `branch` alongside its pid, so a console restarted mid-run still shows which
tree a live session is in — and so does a parked orphan hours later, which is the difference between
`git worktree list` naming a directory and an operator knowing whose it is. **Absent means shared:**
a lane with neither field ran in the run's own root, which is what every run does unless a plan asks
otherwise. The journal says the same thing in words rather than `key=value` — the checkout taken,
the refusal that degraded a run to a shared tree, the landing, the conflict that aborted one.

**Every spawned session is told where work-state goes (`$DOCS_ROOT`), and must not override it.**
Skill scripts resolve their docs root from that variable first and a cwd-upward git walk second, and
inside a linked worktree that walk answers the *worktree* rather than the run's root. A lane session
that ignored it wrote its handoff, its `.locks/` and its QA row where the board never looks: the
phase landed cleanly and the board still read `no-handoff`. It is set for every session, lane or
not — one whose cwd already is the root gets the value its own fallback would have computed.

This is the one place the server mutates a repository, and it is deliberately one FILE —
`server/runner/worktree.ts`, holding the only exemption `test/never-push.test.ts` grants. The
remote-talking verbs stay banned even there: the console still never publishes.

The server binds to `127.0.0.1`, and every write requires an `x-phase-console` header plus a
same-origin `Origin`, which a browser will not send cross-origin without a CORS preflight the server
never answers.

## Claude accounts and usage limits

The chrome carries usage meters on every page — the 5-hour session window, the weekly allowance,
and every per-model window the usage endpoint reports (Opus, Fable, … — rendered by key, so a
window that ships tomorrow appears tomorrow), per account, with reset countdowns. The compact bars
read the **worst window across every account**, naming the account supplying the number — a second
account walking into its wall must never hide behind a green machine-login meter — and the dialog
behind them holds the per-account truth. The numbers are the same ones `/usage` shows — polled
every 90 s while a run is spending the account and every 10 minutes otherwise (`USAGE_ACTIVE_MS`,
`USAGE_IDLE_MS`; a 429 backs off harder than other failures), cached, and served stale with their age
attached when the endpoint is unreachable — and they work with no flag at all.

`--allow-accounts` turns on **registration**, and the account registry is the console's own.
Sign a second Claude account in (a managed `CLAUDE_CONFIG_DIR` profile — the console opens a
terminal on `claude auth login`, then reads back the email), or paste a long-lived token from
`claude setup-token` and name it. Secrets go to the keychain (or a 0600 file), never into
`accounts.json`, never to the browser, and the console never writes the CLI's own credentials.
Accounts can be **renamed** (the display name only — the id underneath is a journal key and never
changes) and **removed**: removal takes this console's registration, the profile directory and, on
macOS, the CLI's hashed keychain item that existed only for that directory — never the machine
login's own entry — and refuses while a live run is paying as that account.

**Expired logins announce themselves.** Every account's credential is watched with its meters; a
login that goes from good to expired or signed out (after the CLI's own refresh has been tried)
raises a *Sign in again* notification, badges the account in Settings and the meters, and the run
page's sign-in card names the right account with the right command — a run pinned to a profile is
preflighted **as that profile**, so an expired one refuses before spending a session rather than
burning one per phase discovering it.

**What the console learns about a login outlives the console that learned it.**
`accounts/learned.json` under the machine's state home — one file for every console, 0600, written
atomically under a lock — keys each credential by a fingerprint and remembers its organisation, the
walls it hit, its entitlement and when it last worked; the browser only ever sees a hashed `orgId`.
Entitlement is a breaker (`ENTITLEMENT_STATES`: `unknown`, `entitled`, `cooling`, `retired`). A read
that works promotes `unknown` to `entitled`. A usage wall cools the account until the wall's reset, or
for `ACCOUNT_COOLDOWN_MS` (30 min) when the reset cannot be read, and a cooling account is out of the
`auto` rank until then. A credential-class refusal (`org-policy`, `auth`, `billing`, `certificate`)
**retires** the account and its organisation with it, so every login of that organisation reads
`unusable`; the run journals `run.account-retired`, announces *Account retired*, and halts
`credential-refused`, which only a person's press relaunches. A retired account is refused at start by
name and at every boarding (`run.admission-refused`) until `POST /api/accounts/:id/clear-retired`
(`--allow-accounts`) clears the organisation and every sibling — a new organisation on the same
credential reopens it by itself. A removed account leaves a tombstone, so a journal that names it
still reads `<name> (removed)`; `GET /api/accounts` serves them as `tombstones`, and each account's
`breaker` says whether it is a rank candidate and, if not, why and until when.
`POST /api/accounts/:id/probe-entitlement` (`--allow-accounts`) tests an account with one capped
one-turn session (haiku, `--max-budget-usd 0.05`) that counts toward the start ceiling — a failure
retires it, a success promotes `unknown` to `entitled`.

**Before a run spends, and at the wall.** The start door ranks accounts by headroom and refuses one
that is retired, walled in a learned bucket, or at `PREFLIGHT_REFUSE_PCT` (97 %) of its 5-hour window —
trying the next and, with none left, parking the run with an errand (`run.preflight-refused`). Mid-run
an account at `WALL_PCT` (99 %) is out of the rank, and a run whose on-limit policy twice finds no move
inside an hour (`LIMIT_NONE_MAX` in `LIMIT_NONE_WINDOW_MS`) hands the phase to the ladder as
`resource-wall:usage`: it waits out the window or parks with an errand (`phase.live-wall`).

Every launch surface — the run form, the phase launcher, the recovery and QA dialogs, the agent
launcher — then offers an **Account** choice (including `auto`, most 5-hour headroom) and, for
runs, an **on-limit policy**:

| Policy | At the shared usage window (session/weekly) |
|---|---|
| `switch` *(the dialogs' default)* | Checkpoint the session, continue immediately under the account with the most headroom — same session when its transcript can be carried into that account's config dir, a fresh boot prompt when it cannot. With one account it degrades to `wait`. |
| `wait` *(the on-disk default)* | Sleep to the reset and resume by itself — including across a console restart, which re-arms the clock. |
| `pause` | Checkpoint and stop for you, with the reset time on the banner. |

A model-specific limit (Opus, Fable, …) keeps its own path: the run switches **model**, not
account, because those windows are per-model — and the wall is filed under its own bucket
(`seven_day_opus`, `seven_day_fable`, …), so `auto` skips that account only for runs of that model
and still sends a Sonnet phase there. Mid-run, **Switch account** on the run card acts immediately
— the picker lists **every** account, the current one marked — a live session is checkpointed (its
session id kept) and re-attempted under the other login; the scheduler throttles only the limited
account, so runs paying with a different one keep flowing. Everything is journalled
(`run.account-switch`, `phase.transcript-port`); the `limits` notification category announces every
wall that is actually hit and every login that needs signing in again, and the 80/95% early warning
is its own off-by-default category, *Usage climbing*.


## MCP servers

Sessions can call tools you attach: a browser, an issue tracker, a documentation server. The
console's contribution is narrow — Claude Code connects to MCP servers perfectly well on its own.
What it cannot do is tell you, before an unattended run spends an hour, that the server the plan
chose was never signed in.

A plan states what it needs (`**MCP servers (every session):**` in §Session budget, and a per-phase
`- **MCP:**` bullet, unioned). Those are **registry ids** — what the phase needs, never how to reach
it, because the how is per-machine. The registry lives under the instance's state dir, per instance
like the accounts one and for the same reason: a server that belongs to one project is exactly the
wrong thing to hand another.

Before a phase boards, the console probes the exact set it would run with — a one-turn
`claude -p --strict-mcp-config --mcp-config <set>` whose `system/init` reports each server's real
status before any model call. That matters because an unattended session cannot fix a wall itself:
there is no `/mcp` panel in `-p`, and the CLI reports the missing tools to the *model*, which then
improvises around them. The preflight shares the health clock's cache and single flight
(`HEALTH_TTL_MS`, 5 min), so a set probed in the last five minutes is not probed again, and the
probe's own session carries `PHASE_CONSOLE_PROBE=1`, which keeps it out of every session view.

**What it does about a wall is a policy, and the default is to carry on.** The phase boards with the
servers that answered, its prompt names the ones it did not get and instructs it neither to
improvise a substitute nor to treat them as a blocker — do the work that does not depend on them,
and record the rest under **Outstanding** as an operator errand — and you are told once per run per
server. Set **Settings ▸ Automation → When an MCP server is unavailable** to *Park the phase* for the
old behaviour, per run in the launch dialog, or per phase in the run's phase matrix; a plan can
demand it for itself with `**MCP policy:** require`, which outranks the run-level choice because a
plan is a versioned statement about the work rather than one launch's convenience.

The default moved because the park was answering for the phase that genuinely needs its server and
firing for every phase that merely had one attached. `parked` is a settled status, so a run whose
ready phases all park has no candidates left and halts: one signed-out server stopped an eleven-phase
plan that named no MCP servers of its own, 0 phases done. A phase that does park now names both
doors — sign the server in, or **Continue without these servers**, one button on the halt card — and
signing a server in still requeues everything parked on it, including on a run that has already
stopped.

The spawn always pairs `--mcp-config` with `--strict-mcp-config`, so the resolved set is the whole
set — without it the CLI would union in whatever `~/.claude.json` and the project's `.mcp.json`
happen to hold, and the run would be talking to servers nobody chose for it.

A **token** account's `CLAUDE_CODE_OAUTH_TOKEN` is inherited by every stdio server a session starts,
so a run paying with one keeps only the stdio servers the plan itself declares — remote servers are
always kept — and journals `run.token-scope` with what it kept and dropped.

Three kinds of credential, and the console holds one. **OAuth** goes through
`claude mcp login <id> --no-browser` in a terminal, and the token stays in the CLI's own store — a
second writer is how two processes corrupt one login. **A header token** is ours: keychain on macOS,
a 0600 file elsewhere, never in `servers.json`, never in the browser. **`${VAR}`** is not a secret
but the name of one, passed through unexpanded so the CLI resolves it in the child's environment. A
URL carrying its own credential is refused on add.

### Signing in a server the CLI has never heard of

`claude mcp login` takes a **name** and no config flag, and resolves that name against the CLI's own
registry — not against this console's. So for every server registered here and nowhere else, the
Sign in button opened a terminal that answered `No MCP server named "<id>"` and listed somebody
else's servers. There was no console error, no way forward, and under `require` a phase parked on a
condition the operator could not clear (issue #8).

Sign-in therefore **bridges the definition** for the length of the flow (`server/mcp/login.ts`):

```
claude mcp add --transport <http|sse> --scope user <id> <url>   # a definition, not a credential
claude mcp login <id> --no-browser                              # the name now resolves
claude mcp remove <id> --scope user                             # put the registry back
```

Four rules it keeps. The definition carries **no secret** — the id, the transport, the URL and the
registry's own non-secret headers, nothing the keychain holds; the CLI writes it 0600. A definition
**the operator already had is never removed** — the flow asks (`claude mcp get`) before it writes,
and only takes back what it wrote. The bridge happens **before any terminal is minted**, so a CLI
that refuses the registration produces the exact commands on the card rather than a second terminal
that fails. And a **`ws` server is not offered the button at all**: `claude mcp add` has no spelling
for that transport, so there is no bridge and the card says so instead.

Every step runs under one `CLAUDE_CONFIG_DIR`, and which one matters: the CLI keys its credentials
by `sha256(CLAUDE_CONFIG_DIR)[:8]`, so a token signed in under one dir is invisible to a session run
under another. The default is the console's own dir — the one the health probe reads, which is what
makes `GET /api/mcp` report `connected` right after a sign-in. `POST /api/mcp/<id>/login` also takes
an `accountId`, which runs the whole flow under that **profile** account's config dir instead: use
it when your runs spend a profile account rather than the machine login. The card names the dir the
token landed in, because a sign-in that landed where the run does not look is the same bug wearing a
success message.

Every probe fingerprints the tools a server advertised. A change raises an alert rather than being
absorbed: a server whose tool *descriptions* change can change what your sessions are instructed to
do, which is the documented supply-chain attack against MCP. Tools marked `requiresUserInteraction`
are flagged too — an unattended run can never approve one.

MCP calls never reach the console's PreToolUse hook, so `mcp__server` rules land in the settings
file's `permissions.deny` and hold whether or not this console is running.

`--allow-mcp` gates registration. Reading the registry, the connection statuses and the catalog does
not — seeing what your own sessions connect to is display, not capability.

`--allow-webhooks` is the seventh switch and the only one that points outward: the same
announcements, POSTed as JSON to URLs you register (Slack, Discord, Telegram, your own relay). Off
means no outbound request at all, even for a URL already on file — the flag is read when a payload
is about to be sent, not only when one is registered. A URL is stored and never served back, because
an incoming-webhook URL is the whole authorisation; payloads carry ids, titles and a link home, with
secret-shaped strings masked on the way out. Schema and recipes: `docs/webhooks.md`.

## From a phone

The point of an unattended run is that you stop watching it, and the point of the approval queue is
that a run can ask you something while you are not watching. That only works if the console can be
reached from wherever you are.

It still binds to `127.0.0.1`. What changes is that something in front of that socket authenticates
the caller and says who they are. [Tailscale Serve][serve] is the case this was written for: it
terminates TLS, checks the caller against your private network, and forwards to loopback with their
login in `Tailscale-User-Login`.

```bash
# the console: unchanged bind, plus who may arrive through the proxy
./start --root ~/code/your-repo --allow-writes --allow-run \
        --remote your-machine.your-tailnet.ts.net \
        --remote-user you@example.com

# the proxy: HTTPS on the private network, forwarding to loopback
tailscale serve --bg --https=443 http://127.0.0.1:4123
```

| Flag | Meaning |
|---|---|
| `--remote <host>` | Also answer to this hostname, fronted by an authenticating proxy. Repeatable. Turns on strict `Host` checking. |
| `--remote-user <login>` | A login allowed to arrive that way. Repeatable, or `PHASE_CONSOLE_REMOTE_USERS`. Required by `--remote`; without one the console refuses to start. |

Neither flag is needed when the machine profile says it: `remoteHost` and `remoteUsers` in
`~/.config/phase-console/fleet.json` are inherited as a pair — per field, a flag or environment
variable first, then this console's own override in that file, then the machine's value — and so are
`notifyCommand`, `webhooks`, `categories` and `quietHours`.

Naming a hostname means exactly two kinds of request are served: a loopback `Host` with no identity
header (you, at this machine) and the named hostname with an allowlisted login (you, through the
proxy). Everything else is refused — including a proxied request asking for a loopback `Host`, which
is how someone on the network would otherwise skip the identity check, and any unknown `Host`, which
is what a DNS-rebinding page arrives with. With no `--remote` at all, nothing here applies and every
request is treated exactly as it was before.

**The identity header is only worth anything because the app stays on loopback.** If it listened on a
network interface, anyone could send the header themselves. `--remote` deliberately does not widen
`--host`; the [Tailscale documentation][serve] makes the same point.

A request through the proxy is attributed to its login: the verified `Tailscale-User-Login` becomes
the actor's `remoteUser`, and its `by` unless the request body names a label of its own — a label is
only ever that, and `via`, `origin` and `remoteUser` cannot be set from a body — so a press from a
phone journals as the person who made it.

`tailscale serve --https=443` is the default console's. Any other console's HTTPS port is its own port
plus 4000 (`httpsPortFor`), and the Serve command the console composes (`serveCommandFor`) never takes
a port a running console already serves: it names that occupant and offers another port.

**The full setup** — the two admin-console switches, the phone, the Home Screen install that iOS
notifications require, out-of-band alerts, access rules and a troubleshooting table — is in
[docs/phone.md](../docs/phone.md).

[serve]: https://tailscale.com/docs/features/tailscale-serve


## What a page costs

A local server has no excuse for shipping bytes nobody reads, and this one did: opening a plan on
the 121-plan library it is developed against moved **~1,753 KB** and waited **11.27 s** on a
validator before it could paint. Four things changed, and none of them removes a feature.

**Compression, validators, immutable assets** — `server/http/compress.ts`, `node:zlib` and
`node:crypto` only, because viewer's empty `dependencies` is deliberate. It negotiates
`Accept-Encoding` with q-values (brotli on a tie, gzip fallback, `q=0` read as a refusal), skips
bodies under 1 KB, sends a body that *grew* as-is, and sets `vary: accept-encoding` on everything
compressible — including what came out identity, because the answer's DEPENDENCE on the header is
what `vary` states. A strong `ETag` is taken over the **identity** body rather than the served
bytes, so a conditional request never costs a compression pass, and `If-None-Match` is answered with
a 304 carrying no `content-length` and no `content-type`.

API GET 200s moved from `cache-control: no-store` to `private, no-cache`: under `no-store` a browser
may not keep the body, so it could never send the tag back and the ETag would be decoration.
`no-cache` still revalidates before every use, and `private` keeps it out of any shared cache on
`--remote`. Everything else — POST receipts, errors, downloads, `/api/metrics` — stays `no-store`.
`/events` is never compressed and never will be: a compressor's flush window is exactly what SSE
cannot tolerate, so it writes its own head. `server/http/static.ts` serves the precompressed
`.br`/`.gz` siblings `npm run build` writes and never compresses at request time, with `immutable`
on the hashed assets.

Two traps this leaves behind. **`res.req` is how the request reaches `sendBody`** (Node ≥ 15.7), not
a threaded parameter — there are 243 `json(res, …)` call sites, and a fake response with no `req`
negotiates to identity, which is a silently different path from the server's. And **bodies leave as
`Buffer`s**, so any test asserting on one must decode by `content-encoding` first; copy `decode()`
from `routes.test.ts` or `apiGet()` from `transport.test.ts`. Also: `/api/state` is a snapshot of a
live process, not a stable entity, so **never assert a 304 round trip on it** — two reads a
millisecond apart may legitimately differ. Put that assertion on `/sw.js`, which has stable bytes and
answers in both build states.

**`?include=` — a page asks for what it renders.** Two read endpoints shipped everything they knew to
every caller. `viewer/shared/projection.js` owns the vocabulary, so the server projects and the
client asks with one definition:

| Group | Carries |
|---|---|
| `prose` | each phase's own prose sections |
| `document` | the plan's own markdown — context, architecture, and the source view |
| `handoffs` | the handoff reference's `outstanding` paragraph |
| `memory` | the plan's memory file |
| `full` | everything, byte for byte the pre-3.2 response |

Measured on the live library: a 23-phase plan **286.5 KB → 39.3 KB**, a 31-phase plan **130 KB →
54.0 KB**, and a live run inside `/api/state` **340.4 KB → 11.2 KB**. `include=full` was verified at
315,608 bytes on both sides of the change, so nothing was removed — a caller that wants the old
shape names it. The run summary is an OMISSION list rather than a keep-list, so a field added to
`RunState` tomorrow rides along by itself; `detail()` is not output-cached and every projection
allocates, so two callers with different include sets cannot corrupt each other.

🔴 **A tab's own source file is not its render tree, and getting this wrong is silent.** The first
cut projected away `phase.goal` and the whole `phase.handoff` while the Route tab asked for neither
— because `route-tab.tsx` reads neither *itself*: it mounts a clamped `goal` line and a handoff chip
from a cell module four tabs share. `goal` came back blank on 23 of 23 phases with no error
anywhere. `tabs.test.ts` now walks JSX edges per component with the field→group map derived from
`projection.js`; its blind spots are documented in the file, the sharpest being a field read inside a
plain function that is *called* rather than rendered.

**The validator is off the read path.** `detail()` no longer awaits `lint()` — the lint is still the
engine's word, still revision-keyed, still at `GET /api/plans/<slug>/lint`, but it is scheduled on a
later macrotask *after* the response is built and pushed as a `plan:lint` SSE event the client writes
straight into its cache. The schedule must stay the **last** statement in `detail()`: put it where
the lint is read and the `setTimeout(0)` fires during the following awaits, with `validate.sh`
running before the caller has seen anything. Around it, the revision maps in `engine.ts` and
`service-live.ts` cache the **promise** (`Cached<T>` is `{ revision, value: Promise<T>, settled? }`,
so anything adding a revision-keyed map must go through `this.cached()`/`this.settled()` or it loses
the single-flight), the engine cache gained a TTL, a byte cap and an entry cap, `store.scan()` keeps
a plan's revision when its fingerprint has not moved, and `pid.ts` shells `ps` asynchronously.

**The first paint and the board.** The route chunk preloads from an effect above every early return
— move it below one and the plan chunk waits on an `/api/state` it does not depend on again — and a
route's real cost is the transitive closure of its chunk's **static** imports, which no file shows:
77.6 KB of run-setup rode the plan route through a component that renders a dialog only on a press.
`check-dist.mjs` walks that graph now, following static edges only so a `lazy()` never reads as a
regression. The board itself is windowed against the shell's `<main>` scroller — never one of its
own, because `TableWrap`'s `overflow-x` makes computed `overflow-y` auto and a height-capped wrapper
becomes a second vertical scroller that eats touch flicks meant for the page — as `aria-hidden`
spacer `<tr>`s rather than absolute positioning, since a row taken out of flow stops being a table
row for layout and for a screen reader. `aria-rowcount`/`aria-rowindex` carry the true size.

Two engine facts that cost a pass to learn: `@tanstack/virtual-core` yields **no rows at all** when
the scroller measures zero, so a jsdom test that renders the board must stub `offsetHeight` (and
`getBoundingClientRect().height` too, if it asserts on the window); and it binds its scroll element
in a layout effect, so render #1 has no range. Both are handled by resolving the scroller lazily
inside `getScrollElement` plus an `initialOffset` of 0 — sound because `app/shell/layout.tsx` resets
`scrollTop` on every path change. `OVERSCAN` is an accessibility setting rather than a perf dial: the
row's only focusable element is its phase-number anchor, so lowering it toward 0 makes the board a
tab dead-end at the fold. And every memo on the plan page rests on TanStack Query's
`structuralSharing` being on — turn it off and all ten stop paying while everything still renders
correctly, which is why that premise has a test of its own.

## Development

```bash
npm ci                        # once — the toolchain and the client's dependencies
npm run dev                   # Vite on :5173, proxying the live console on :4123
                              #   (PHASE_CONSOLE_ORIGIN=http://127.0.0.1:4199 targets another)
npm test                      # server + shared contracts (node --test — needs no build)
PHASE_CONSOLE_TEST_ROOT=~/code/your-repo npm test    # + integration & engine parity
npm run test:client           # the client suite (Vitest + jsdom)
npm run typecheck:client      # two programs: the app (DOM libs) and the worker (WebWorker libs)
npm run lint:client           # ESLint over client/src + shared (typescript-eslint, react-hooks)
npm run format                # Prettier over the same files (format:check is what CI runs)
npm run verify:dist           # build into client/.dist-verify + the build gate — the live dist untouched
npm run build                 # vite build → stamp .build-rev → precompress client/dist
npm run precompress           # write the .br/.gz siblings the server serves (part of build)
npm run check:dist            # the build gate: SERVED first paint, precache sanity, sw.js at the root
```

`verify:dist` exists because `client/dist` is what a running console serves: a build into it cuts the
live console over on the next request. `PC_DIST_DIR` (relative to `client/`, or absolute) is the one
knob — `vite.config.ts`, `stamp-build.mjs`, `precompress.mjs` and `check-dist.mjs` all read it; the
server never does — and `verify:dist` sets it to a scratch directory, runs the same gate, and cleans
up (`--keep` to look).

`precompress` is the last step of `build` and is not optional: `server/http/static.ts` serves
`<file>.br` (or `.gz`) when the client accepts it and never compresses at request time, and
`check-dist.mjs` gates first paint on the bytes that would actually be **served**. Skip the step and
the gate reads the identity size and fails — which is the point. For four phases the budget said
192.7 KB gz while the server, which compressed nothing, sent 641.1 KB.
`typescript` is pinned to the 6.x line on purpose: typescript-eslint parses through the TypeScript JS
compiler API, which the native 7.x package does not ship.

The node suite passes without a build on purpose — a fresh clone must be able to verify the server
before it has ever built the client (`test/static.test.ts` holds the not-built answers, including
the `/sw.js` fallback that keeps push subscriptions alive while `dist` is absent). The integration
tests skip unless `PHASE_CONSOLE_TEST_ROOT` points at a real plan library.

```
server/   index.ts (http) · service.ts (the model) · engine.ts (script wrapper) · store.ts (files)
          parse/ (front matter, plan, handoff, folder artefacts) · analysis/ (graph, stats)
          search.ts · git.ts · memory.ts · watch.ts · writes.ts · api/routes.ts
          http/ (compress.ts — Accept-Encoding, ETag, 304 · static.ts — client/dist, immutable)
          terminal.ts (the broker's client + the WS upgrade) · pty/ (broker.ts — the detached
          pty owner · client.ts · protocol.ts · scrollback.ts) · runner/ (the autopilot)
          notifications.ts (the durable inbox) · push/ (register, catalogue + routeFor, RFC 8291)
          log.ts (structured log + exit record) · fallback-sw.js (what /sw.js serves un-built)
          lifecycle.ts (degraded state, ordered shutdown, supervisor detection)
client/   src/ (the React app: app/ (shell, router, help) · features/ · components/ · content/
          (the in-app guide) · lib/ · styles/ · sw.ts)
          public/ (icons, manifest) → dist/ (built output + .build-rev — gitignored)
shared/   routes.js · route-meta.js · projection.js · console-model.js · phase-model.js
          status-vocab.js · plan-vocab.js · sw-push.js — dependency-free ESM, imported by the
          Node tests and the client alike
scripts/  check-dist.mjs (build gate) · verify-dist.mjs (the gate in a scratch build) · stamp-build.mjs · check-stamp.mjs
          precompress.mjs (the .br/.gz siblings the server serves — last step of `npm run build`)
```


Fonts are Instrument Sans (one variable file serving both the UI face and, width-clamped by a second
`@font-face`, the condensed display face) and Martian Mono (SIL Open Font License, notices in
`client/src/assets/fonts/OFL.txt`) — two vendored variable woff2 files bundled by the build, never the
`@fontsource` index CSS, which would precache every subset. The full identity: `docs/design.md`.
