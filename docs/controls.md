# What you control

This is the part most people miss. The plan is a plain markdown file, and a handful of lines in it are
**read by the engine**. Change a line, change the behaviour. You can ask Claude for any of these in
plain language at plan time, or edit the file yourself afterwards.

## The control surface at a glance

| You want to… | Put this in the plan | Where |
|---|---|---|
| Choose the executing model | `**Target model:** claude-opus-5` | `## Session budget` |
| Change how much work fits a session | `**Budget:** ~200K weight/session` | `## Session budget` |
| Use a different model for one phase | `- **Model:** haiku` | that `### Phase N` block |
| Say how big a phase is | `- **Size:** S` \| `M` \| `L` | that `### Phase N` block |
| Turn QA on | `**QA gate:** on` | `## Session budget` |
| Turn QA off explicitly | `**QA gate:** off` | `## Session budget` |
| Commit to a specific branch | `**Branch:** feature/checkout` | `## Session budget` |
| Force skills into every session | ``**Skills (every session):** `design-system` `` | `## Session budget` |
| Name the MCP servers every session needs | ``**MCP servers (every session):** `context7` `` | `## Session budget` |
| Add a server only one phase needs (UNIONED with the plan's) | ``- **MCP:** `github` `` | that `### Phase N` block |
| Park rather than continue when a server will not connect | `**MCP policy:** require` | `## Session budget` |
| Carve one phase out of a plan-wide `require` | `- **MCP policy:** continue` | that `### Phase N` block |
| Turn QA off (or on) for ONE phase | `- **QA:** off` \| `on` — the phase's word beats the plan's | that `### Phase N` block |
| Say which repos a phase touches (its **scope** — what decides concurrency) | the `Repos` column; empty means `all`, which makes the phase run alone | `## Phase graph` table |
| Say a phase depends on others | the `Depends on` column | `## Phase graph` table |
| Block a phase behind something external | `*(GATED)*` + `- **Gates (must clear first):** …` (numbered steps for human gates) | that `### Phase N` heading |
| Say who can clear that gate | `- **Gate-check:** ai <check>` (a session — prefer) \| `manual <who>` (a person) \| `date 2026-09-01` (itself) | that `### Phase N` block |
| Clear / approve a gate (any kind) | the phase page's **Gate card**, or `gate-approve.sh <slug> <N> --by <who>` | the console · `docs/handoffs/<slug>/gate-status.md` |
| Retire a plan nobody will finish | `status: abandoned` + a reason — set it with `close-plan.sh` | the plan's frontmatter |
| Bring a retired plan back | `close-plan.sh <slug> --reopen` | the plan's frontmatter |
| Put a console run on one work branch | Settings ▸ Automation ▸ Branch (or the launch form) | the console |
| Give a run its own checkout, so two plans in one repo drive at once | the launch form ▸ *Give this run its own checkout* (needs the work branch) | the console |
| Say what a finished branch becomes | the launch form ▸ *When the plan completes* — PR · merge queue · integration · keep | the console |
| Bring a stack up before a phase can be proved | `- **Setup:**` in that `### Phase N` block (or one `**Setup (every phase):**` line in §Session budget) | the plan |
| How long a session may sit on its OWN background job before the console parks it | Settings ▸ Automation ▸ `stallLocalJobMs` (45 min shipped) | the console |
| Bound the console's own checkouts (cap, setup command, `.env` copy, branch reclaim) | Settings ▸ Automation (shown only while isolation is on) | the console |
| Delete a run's `pe/*` branches once their PR has merged | Settings ▸ Automation | the console |
| Open a PR when the plan completes | Settings ▸ Automation ▸ Open a PR (needs the work branch) | the console |
| Queue runs whose repos overlap | Settings ▸ Automation ▸ Repository guard | the console |
| Let the console heal a stopped run by itself | Settings ▸ Automation ▸ Auto-recover halted runs (and the ladder card's toggles) | the console |
| Bound what it may spend by itself | Settings ▸ Automation · the ladder ▸ Caps (rungs and dollars per phase / run / day) | the console |
| See who is in the repository, and queue behind them | Settings ▸ Automation ▸ Session presence ▸ Install (or `phase-console install-hooks`) | the console · `~/.claude/settings.json` |
| Send every announcement to a chat channel | Settings ▸ Notifications ▸ Channels (needs `--allow-webhooks`) | the console · `docs/webhooks.md` |

## Console automation defaults

The console keeps its automation preferences in Settings ▸ Automation (stored per instance under
`~/.config/phase-console/`). **Ten of them are the opening values a launch surface starts from** —
`attachDefaultSkills`, `qaByDefault`, `gitMode`, `openPrOnComplete`, `isolation`, `settle`,
`reviewEachPhaseByDefault`, `reviewerPolicy`, `autoRecoverByDefault`, `mcpPolicy` (the keys of
`buildPrefs()` in `features/run-setup/modes.ts`). Each launch can override them for itself, and how many
a given surface even shows depends on its mode — a recovery ticket offers five fields in all, of which
`attachDefaultSkills` is the only one of these ten. The preferences are where "for all plans" is said
once. The others in this table — the repository guard, the run-branch and merged-branch policies, and
the ladder card — are console-wide policy rather than launch values, and say
what the autopilot may do **by itself** once a phase stops short, and how much of it
([The loop](loop.md) is the specification). Every one round-trips through `POST /api/prefs`.

| Preference | Default | What it does |
|---|---|---|
| Attach default skills | off | Seed the machine's `--default-skills` list into new runs, and pre-tick it in launch dialogs. |
| QA by default | off | Launch surfaces open with the QA gate ticked, so starting a run activates QA for the plan (needs `--allow-writes`; earlier finished phases are backfilled `waived`). |
| Branch | current branch | `Work branch per run` puts every console-minted session of a run on one plan-wide branch, `pe/<slug>` — created from the default branch if missing, reused by later phases. |
| Open a PR at completion | on | Work-branch runs only: the plan's **last** phase is told to push `pe/<slug>` and open a PR per scoped repo. For that run — and only that run — bare `git push` moves from the deny wall to an approval card, and `gh pr create` stays a card even under the `trusted` profile; force-pushes and `--delete` stay denied outright. |
| Repository guard | on | The scheduler queues runs whose repository scopes overlap. Off: overlapping runs may start together, and a work-branch run sharing a repo with a live one is told to work in a linked `git worktree` instead of switching the shared checkout. |
| Take the run branch back from a clean checkout | Clean only | Isolated runs only: a checkout sitting on `pe/<slug>` with nothing uncommitted in it is switched to the default branch so the run can have its own tree. A checkout holding work — including a file nothing ever added — is never touched, and the run refuses `branch-in-use` naming those files. No branch is deleted and no ref moves. `Never` turns it off. |
| Delete merged run branches | on | After a `pr` settle, a run's `pe/<slug>` and `pe/<slug>-p<N>` are deleted once the trunk contains them. Always `git branch -d` — git's own refusal for an unmerged branch is the safety, and `-D` exists nowhere in this codebase — so a squash-merge the local trunk has not fetched keeps its branch until the next drive. |
| When an MCP server is unavailable | Continue and warn | The phase boards without the servers that would not answer, its prompt names them and tells it to record the gap under **Outstanding** as an errand, and you are told once per run per server. `Park the phase` is the older behaviour — use it when the work genuinely cannot proceed, remembering that a run whose ready phases have all parked has nothing left to start. Settable per run in the launch dialog and per phase in the run's phase matrix; a plan's own `**MCP policy:** require` outranks both the run choice and this preference. |
| Auto-recover halted runs | on | New runs opt into the ladder (`autoRecoverByDefault`): a stopped phase is classified and climbed by itself, within the caps below; off, every stop is yours. |
| Continue runs a recovery fixed | on | When a recovery leaves the board reading fixed, the run resumes by itself (`autoContinueRecovery`). |
| Rungs per phase · Spend per phase | 3 · $100 | The ladder's per-phase caps (`ladderPerPhaseRungs`, `ladderPerPhaseUsd`) — how many rungs one phase may climb and what they may cost before its errand is written. |
| Rungs per run · Spend per run | 10 · $400 | The per-run caps (`ladderPerRunRungs`, `ladderPerRunUsd`); the one automatic budget raise stays inside the USD cap. |
| Spend per day | $600 | Across every run this console drives in a day (`ladderPerDayUsd`). |
| Sweep every | 5 min | How often the convergence loop re-reads every open plan even when nothing happened (`convergeEveryMs`; 0 turns the timer off — boot, a docs change and the minute after a stop always run a pass). |
| Park on a required MCP server for | 30 min | A phase parked by the `require` policy continues without the server after this long, an errand recorded (`mcpRequireTimeoutMs`; 0 waits for it to heal, however long). |
| Raise a spent run budget once by | 25 % | The resource ladder's one budget raise, within the per-run cap (`budgetAutoRaisePct`; 0 never raises). |
| Unblock attempts | on | A handoff marked blocked for a reason no machine category fits gets ONE bounded session allowed to do the unblocking work — then an errand (`unblockAttempts`). |
| Take over stale claims | on | An expired foreign lock over unfinished work is taken over and the work continued; a live session's claim is never touched (`staleClaimTakeover`). |
| Resume killed lanes at boot | **ask** | What this console does about the runs its own restart stopped (`resumeAtBoot`). **Ask** — the shipped default — starts nothing and puts the question in front of whoever opens the app next, naming the runs and phases; **Always** resumes each killed lane's own session without asking, at most 3 restarts in a row per phase, then an errand; **Never** writes the errand straight away. The question is asked once per console start, and answering it is not stored — a restart is the event that makes it new again. |
| Switch accounts at a wall | on | A signed-out run account, or a usage window too far out to sleep on, switches to a registered account that can pay (`autoAccountSwitch`); off, the wall halts with an errand. |
| Delegate human gates | **off** | A `manual` gate is briefed to the phase's own session to VERIFY its conditions against citable evidence and record the clearance as `by: ai-session-delegated`, instead of stopping the run for a person (`delegateHumanGates`). **Off by default and deliberately so** — the plan author wrote `human`, and "the owner approves the visual result" is not a thing a session can judge. What makes it safe is not trust: the brief requires cited evidence per condition and STOPS with the condition named when it has none. Turn it on for a plan whose gates are machine-verifiable in practice. |
| Board a phase that states no verification | **off** | A phase whose plan omits the §Verification bullet boards anyway and passes on its handoff alone (`allowUnverifiedPhases`), instead of parking at boarding with "add a §Verification command, then Retry". The record says `phase.verify-waived`, so nobody reads "0 commands green" as proof, and a bullet the runner cannot read still parks — that is a formatting fault the author should hear about. |
| One more rung while the work is moving | **off** | When a phase has spent its rungs but the newest settled rung landed commits, the ladder is granted ONE extra rung for that phase (`ladderExtendOnProgress`, journalled `phase.ladder-extended`). Once per phase; the dollar caps stand. |
| Boarding schedule | **off** | When this console is willing to START phases (`boardingSchedule`). See below. |

### The boarding schedule

Every other clock on this page is the machine's — the session cap, the account's usage window, the
scopes. This one is yours: *is now a time I want sessions starting at all.* Nothing could infer it,
and a laptop is perfectly capable of boarding an eleven-phase plan at 03:40.

Three rules, composed in this order and no other:

| Rule | Kind | What it means |
|---|---|---|
| **Boarding windows** | allow | `from`–`to` local time, optionally restricted to certain days. With none set, every hour is allowed. A window whose `to` is not after its `from` runs past midnight and belongs to the day it STARTED on — 22:00→06:00 on Friday is Friday night, and covers Saturday 02:00. |
| **Cron openings** | allow | Five-field expressions in local time; each match opens boarding for `cronMinutes` (60 by default). The same allow-list, said in the vocabulary a crontab already uses — including Vixie's day-of-month/day-of-week union, so `0 0 1 * 1` means the 1st **and** every Monday. |
| **Quiet hours** | deny | Nothing boards inside these, whatever the windows say. Quiet hours win; that is what makes them worth setting. (A *device's* quiet hours — when a phone stays silent — are a different, per-device setting: `docs/phone.md`, Step 6.) |

Outside the schedule a ready phase **queues** rather than failing: the queue names the boarding
window as what it waits on and says when that opens, and the phase boards on the very next scan
after it does. The console wakes at the opening rather than polling for it.

Two deliberate exemptions:

- **A recovery you ask for is never held.** The schedule governs what the AUTOPILOT starts. Re-check,
  Finish in its own session, Resume with an instruction, Retry and Fix with a new agent all run
  immediately, because pressing a button at 02:00 is asking for it.
- **A live phase is never interrupted.** The schedule decides whether a session may START; a session
  already running when quiet hours begin runs to its own end. Stopping work mid-edit to keep a
  timetable would leave a working tree nobody owns.

An unreadable window or a malformed cron expression is **dropped**, never defaulted — a schedule
nobody can parse must never silently become "board at any hour". The card refuses a bad expression
out loud rather than swallowing it.

Beside the preferences, every launch surface offers two per-run choices when accounts are
registered (`--allow-accounts`): **Account** — which Claude login the run's sessions spend,
including `auto` (most 5-hour headroom) — and **On usage limit** — `switch` (checkpoint and
continue at once under the account with headroom; the dialogs' default), `wait` (sleep to the
reset and resume by itself, restart-safe), or `pause` (checkpoint and stop for a person). A
model-specific limit keeps switching models, not accounts — and files its wall under the model's
own bucket, so `auto` skips that account only for runs of that model. `Switch account` on a live
run acts immediately and lists every account with the current one marked; the scheduler throttles
only the limited account. Accounts rename (display name only) and remove from Settings; an expired
login raises a *Sign in again* alert and a run pinned to it is refused at preflight instead of
burning sessions.

## What it does by itself, and what it asks you

Since 2.3.0 a stopped phase is not a dead end. The console **classifies** it — never started, work
in progress, done but unrecorded, verification red, declared blocked (lock · credential · gate ·
external · unknown), a resource wall (usage · auth · budget · model), an unreachable MCP server, a
broken plan, a stale or a live foreign claim, a manual gate, a QA verdict — and **climbs that
situation's ladder**: its own session first (`--resume`), a fresh briefed session next, an account or
model switch at a wall, one bounded unblock session on a declared blocker, a takeover of a stale
claim. The **convergence loop** runs it at boot, on a docs change, every sweep, a minute after any
stop, and on **Recover & continue**. When every rung is spent — or the situation was yours from the
start — it leaves **one errand**: what is needed, how to give it, what was already tried. You see
the ladder on every **Ways forward** group (the situation chip, the rungs tried, the next rung, or the
errand card), the errands and nothing else under the dashboard's **Waiting on you**, each plan's last
pass on the Pulse's **Converge** line, and the caps and toggles above. Sessions see each other
through the **session-presence hook** (Settings ▸ Automation ▸ Session presence, `phase-console install-hooks`):
a hand-run `claude` in the repository shows on the Pulse, its lock is a queue to wait in while it
lives and debris the moment it ends, and its `phase-outcome.sh` declarations drive the same machinery
as a lane's. What stays yours: a sign-in, a manual gate, a credential, a blocker no category fits, a
QA verdict the ladder tried for and could not produce, anything destructive or published.
[The loop](loop.md) has every word of it.

### A session that boots and then says nothing

The ladder above is for a phase that **stopped**. A session that is still running and has simply
gone quiet is a different animal, and the console used to be able to do nothing but put a card up
about it: one lane in a measured incident sat silent for seventy minutes and the whole cost of that
was one notification an hour earlier.

Now the console does what the operator did, on a clock. At ten minutes of total silence it
**writes to the session itself** (journal: `phase.auto-nudged`) — the same thing a Steer does, and
the only thing that has ever recovered one of these by hand. Five minutes later, if the lane is
still silent, it **recycles** the session (`phase.auto-recycled`): the child is ended, the phase
goes back to `pending` with its session id kept, and the ordinary drive loop re-boards it as a
resume — same conversation, same lock, same lease. **One nudge and one recycle per phase, ever**:
if it wedges again with both spent, the console stops trying and **parks the phase with one
errand** (`phase.stall-parked`) naming what was already tried, while the run keeps driving its
other lanes. Pressing **Retry** clears the ledger and lets it try once more. A session that
*answers* the nudge and then wedges again still gets its recycle — the bound counts what was
actually done, not how many times the lane went quiet.

It only ever fires **before a session's first turn** — no tool call has ever opened, no turn has
ended, nothing has been spent on this attempt, no task list published, nothing committed and the
tree clean. That is the one class where ending a process provably loses nothing, and every one of
those facts is about **this attempt**, not the phase's history: a phase that committed last time
round is still helped this time. A silent session with any work in it is left alone and stays a
card for you. It never touches a **frozen**, **pausing** or **fleet-held** lane either: those are
silent because the console made them so.

Underneath it, and independent of all of the above, every session now carries a **first-event
bound** — a session that produces no output at all for twenty minutes is ended through the normal
teardown, even with no console driving it. Twenty and not fifteen so that it lands strictly after
the recycle rather than level with it: the two clocks must never race over whether the session is
kept. Output that cannot be parsed is logged and counted rather than dropped, so "it said nothing"
stays a claim you can trust.

## Stopping things, at three sizes

Three surfaces carry the same verbs, scoped differently. The **run controls** act on the whole run:
*Pause after this phase* (boundary), *Freeze now* (SIGSTOP every session, reversible), *Stop now*
(SIGTERM everything; phases record `interrupted`, never `failed`). Each **session tab** — on the
autopilot page, the Runs page's lanes, and the session console's own toolbar — carries **Freeze/
Continue** and **Stop** for that one session: the rest of the run keeps scheduling, a stopped
phase keeps its session id for Retry, and a queued phase's Stop takes it out of the admission line
before anything spawns. The **fleet rows** on the Runs page carry the run-level Freeze/Continue and
Stop, so a live run is never a row you can only link away from. None of these touch the
consecutive-failure budget, and pressing Start/Continue resets it — a resumed run never inherits a
spent one. The fourth and largest size is the whole console at once — the next section.

## Freezing the whole console

The fourth size, and the one to reach for when you are stepping away or something is going wrong
faster than you can read it. **Freeze all** (Settings ▸ Automation, and the orchestration
board's header on `#/runs`) stops every running session where it stands and starts nothing new — no queued
phase, no elapsed wait, no recovery, no convergence pass. **Thaw all** puts the whole fleet back
exactly where it was.

Four things are worth knowing, because each is the opposite of what a stop button usually does:

- **Nothing is lost, and nothing becomes a checkpoint.** A frozen session is `SIGSTOP`ped, so it
  thaws mid-token in the same process. Unlike a per-lane *Freeze now*, a fleet freeze carries **no
  fifteen-minute conversion**: it is a standing freeze, so a console left frozen over a weekend is
  still exactly frozen on Monday.
- **No clock is moved.** Every timer keeps running and simply finds the console frozen when its
  moment comes. A wait whose window passed during the freeze fires **once**, at the thaw; a queued
  entry stays queued, names the freeze as what it waits on, and never ages into a reservation.
- **One case needs a press.** A run whose phase happened to be *between* its session ending and
  its closeout when you froze settles `paused` and attributed to you — and a run a person paused
  is deliberately one the console will not resume by itself. Thaw-all wakes everything and unholds
  the queue; that run wants **Continue**. Nothing is lost (its phase is `pending` and keeps the
  session id, so Continue resumes rather than re-runs), but it is the one place "exactly where it
  was" means "plus one press".
- **It survives a restart.** The freeze is a marker file in the console's instance state, so a
  console that dies — or a laptop that closes — does not quietly hand its work back. A console that
  boots under one re-adopts nothing and spawns nothing.
- **Your own hands still work.** Freeze/Thaw and Stop on a single run, and *Recover & continue*, are
  operator acts rather than auto-starts, so they go through. What stops is the console acting by
  itself.

The gate is one predicate, consulted by every mechanism that could begin work, and the list of those
mechanisms is pinned in `viewer/test/fleet-freeze.test.ts`: a new one cannot be added without
declaring where its freeze gate lives.

`POST /api/fleet/freeze` and `/api/fleet/thaw` (both `--allow-run`) are the endpoints — each answers
409 with a reason when there is nothing to do, so pressing Freeze twice never re-stamps the moment
you froze it. `GET /api/fleet` and `/api/state`'s `fleet` field carry the state, which is what the
app-wide banner renders on every page.

## Two plans in one repository, at the same time

The scheduler's rule has always been *never two live sessions whose scopes intersect*, and the only
way it could keep that promise was to make the second run wait. **Isolation** is the other way to
keep it: give the run a checkout of its own, and the two are no longer in one working tree.

Turn it on for a run with *Give this run its own checkout* on the launch form. It rides the
**work-branch** git strategy — a run with no branch of its own has nothing to check out — and on a
live run the switch only turns **off**: a run's commits are on the branch in the checkout it
started in, and there is no honest moment to move them.

**Asked-for and got are two different facts, and the console keeps them apart.** A run that asks to
isolate can be refused — the scope names no repository or an uninitialized submodule
(`scope-unmapped`), the disk cannot take another tree, the cap is reached. A superproject itself is
**not** one of those any more: since 2026-08-28 the run takes a **mirror** — one linked worktree per
scoped sub-repository, one mirror per RUN rather than per lane, so per-LANE worktrees under a
superproject share the run's mirror, serialized per scope; and since 2026-09-05 the mirror mounts the
superproject's own ROOT as well, as its first tree with the initialized submodules under it, so a scope
meaning the root no longer takes the whole run's isolation with it (the `root-scoped` refusal that did
is no longer produced, and is kept only so stored journal lines still render). Only the plain
non-mirror worktree of a repo with submodules still refuses, as `has-submodules`, because
`git worktree add` there gives EMPTY submodule directories. The console still never moves a
superproject's recorded gitlink shas: the one-tree settles (`integration`, `merge-queue`) refuse a
multi-repo run by name (`run.settle-unsupported`), and `pr` opens one pull request per mounted
repository that has commits. Every refusal **degrades to the shared checkout with queue semantics** — exactly the
behaviour that existed before the feature — and says which impossibility it hit, in the run journal
(`run.isolation`, `run.isolation-kept`) and on the run page. Nothing fails.

Four settings under Settings ▸ Automation govern the console's own trees, and they are shown only
while isolation is on: **Worktrees at once** (a cap, shipped at 3 — each is a full checkout on
disk), a **setup command** run once inside a fresh tree (`npm ci`, a symlink, nothing), whether
to **copy the source checkout's ignored `.env` files** into it — off by default, because copying
secrets into a second directory is a decision, not a discovery — and whether the console may
**take the run branch back from a clean checkout**.

**The console may switch your clean checkout off `pe/<slug>`** (Settings ▸ Automation ▸ *Take the run
branch back from a clean checkout*, shipped ON). The wedge it ends is one the console itself creates:
the work-branch strategy tells every session to check `pe/<slug>` out, so your own checkout ends up
holding it — and git allows a branch exactly one working tree, so from then on every run of that plan
meets `branch-in-use` and silently shares that tree. With the setting on, a checkout sitting on the
run branch **with nothing uncommitted in it** is switched to the default branch and the run takes its
own; the journal says which tree moved and where to (`run.isolation-reclaimed`), and the isolation
preflight says *"will reclaim &lt;path&gt;"* before you launch. A checkout holding **anything** — a
tracked edit or a file nothing ever added — is never touched: the run refuses `branch-in-use` and
names the files that stopped it. No branch is deleted and no ref moves; the branch is exactly where it
was, with one fewer working tree on it. The reclaim also consults the **lock table** (read off the
lock files themselves, so a claim made a second ago counts): a checkout a live lock names in its
`worktree=` line — any plan's, unexpired, its session not ended — is never moved, and a live lock
that names **no** tree (the ordinary hand claim, `claim N --scope … --git` with no `--here`) holds
**every** checkout of the repository its scope touches, because a claim that never said where its
work rides may be riding this one. Either way the refusal names the holder. (Until
console-parallel-repaint P1 only dirtiness protected a live session's tree, which held most of the
time.) `Never` turns it off.

**Post-merge phases board a detached mirror.** A run whose pull request has merged and whose
`pe/<slug>` has been deleted still has phases to drive — and re-creating that branch would re-open
work the merge just closed. Such a run boards a checkout **detached** at the default branch's head
instead: it owns no ref, so any number of them may stand beside each other and beside whoever holds
the branch. Its lock is qualified `branch=detached@<sha12>`, which contends with nobody holding a
real ref, and with another detached claim only when the two name the *same* working tree — two runs
detached at the same commit in two console-managed trees run side by side (they were serialised
before console-parallel-repaint P1). A plan can ask for it deliberately with `- **Checkout:** main`
on a phase (`main`, `master` or the word `default`; anything else is documentation the console does
not act on). The journal line is `run.isolation-detached`.

**Merged `pe/*` branches are deleted after a `pr` settle** (Settings ▸ Automation ▸ *Delete merged
run branches*, shipped ON). Once the trunk contains a run's commits the branch is a name for
something that already happened, and a console that drives thirty runs otherwise leaves thirty of
them behind. Evidence, not assumption: the deletion is always `git branch -d`, git's own refusal to
delete a branch whose commits are reachable from nothing else, so a squash-merge the local trunk has
not fetched simply reads as unmerged and the branch survives until the next drive. `-D` does not
exist anywhere in this codebase. A branch still checked out somewhere is kept and named
(`run.branches-pruned` reports what went).

**A worktree this console did not make is reported, never removed.** Every boot and every drive
sweeps the repository's registrations: one whose directory is gone is pruned (it was holding a branch
for nothing), and a live hand-made checkout on a `pe/*` branch is named in the journal
(`run.worktrees-unmanaged`) and left exactly as it is — it may hold work, and every sweep here keeps a
checkout that does. A checkout on your own feature branch is none of the console's business and is
not mentioned.

**Lock leases default to 2 h; the runner claims 90 min.** A lapsed lease is takeable by anyone — that
is the cooperative design — so the number has to outlast the work it protects, and 30 minutes was
shorter than a phase. The console's own sessions never noticed, because the runner refreshes on a
timer, which is exactly why the wrong default survived: it only ever hurt a session driven by hand,
which has nothing refreshing anything. The runner still states its own (`--lease 5400` —
`RUNNER_LEASE_S`, a literal in seconds: 90 minutes, nine times its 10-minute refresh cadence, so
eight ticks may be missed before a claim it is actively holding can lapse).

**What two live branches are doing to each other is measured, not guessed.** The run page's Git card
carries ahead/behind against the base, the files the branch has changed, the tree's disk footprint,
and a **radar** verdict for every pair of live branches — `clean` (no common file), `overlap`
(common files, still merges), `conflicted` (a real merge conflict is already sitting there) and
`unknown` (the probe could not answer, which is deliberately *not* `clean`). The verdicts come from
`git merge-tree`; the whole view arrives on one `run:git` event, and `phase_console_branch_conflicted_files`
([metrics](metrics.md)) is the same number for a scraper. A pair that turns `conflicted` mints one
**inbox item** whose Serialize action patches the other run back to `queue` — one press, and the
overlap is gone.

**A branch has to end up somewhere, and you choose where** — *When the plan completes*, on the same
form, for any work-branch run whether or not it isolated:

| Strategy | What happens when the run finishes |
|---|---|
| **Pull request** (default) | Push the branch and open a PR — the only ending with a person reading the diff |
| **Merge queue** | One more session rebases on whatever landed while the run drove, re-runs the plan's §End-to-end verification, and pushes **only if that passes** |
| **Integration** | The console merges the branch into its own staging checkout (`pe/integration`, one per console) and stops — no remote touched, no session spent |
| **Keep** | Nothing. The branch and its checkout stay exactly where they are |

Only the two that end at a remote may open the push carve-out; `integration` merges locally and
`keep` does nothing, so neither gets it. A clean tree is removed when the run settles; a **dirty**
one is kept and journalled, because uncommitted work is never the console's to throw away.

## The board

`#/runs` answers *what is happening* with a **board** (`runsView`). Four columns —
**running · queued · waiting · frozen** — a card per live run carrying its plan, its phase strip,
its spend, its branch chip and the facts about what it is waiting on; and every verb inline on the
card it acts on: freeze, continue, pause, resume, hold, release, stop, priority, bump, and the
repair actions. **Freeze all** and **Thaw all** are in the header. Alongside the queued column it
shows the same **ordering advice** `GET /api/queue` carries — remaining weight and an ETA per
queued plan — as a suggested order, computed when you ask and never acted on.


Nothing on it is a new control: the columns, the lane rows, the holder facts, the branch chip, the
meters and every lifecycle door are the same primitives the run and Now pages use, which is why a
verb cannot behave one way here and another way there.

## Steering which plan goes first

Four controls, and none of them is a heuristic — the scheduler still runs the same deterministic
first-fit scan it always has, and these are inputs to it.

**Queue priority** (`high` · `normal` · `low`, on the launch dialog and on a live run's settings)
decides which class an admission is scanned in. First come, first served still decides *within* a
class, and the starvation bound is untouched: an entry that has been bypassed enough times, or has
simply waited ten minutes, reserves its tokens against everything behind it **including a higher
class**. A `low` plan that starves outranks a `high` one that just arrived. A class is a preference;
starvation is a bug.

**Hold** and **Release** (beside Pause/Resume on the run controls) stop a run boarding anything new
while its running phases finish and write their handoffs. That is the whole difference from Pause:
a pause waits for the next phase boundary and then *settles* the run, so bringing it back is a
Start; a hold refuses the next admission and nothing else, so a Release puts it straight back in
the queue. Held entries name who held them on the queue page, and never age into a reservation —
standing aside must not turn a plan into an obstacle.

**Bump** moves one queued entry to the front of its class. It never crosses a class boundary (the
priority control is what says that out loud), and it is one-shot: the mark lives on that queue
entry and dies with it, so a phase that queues again later starts from its class's tail.

**Start after `<slug>`** (launch only) chains a run behind another plan: it boards nothing until
that plan's latest run *ends* — finished, paused, parked, halted or stopped, whichever comes — and
the chain survives a console restart because it lives on the run's checkpoint. The queue page shows
it as *waiting for `<slug>` to settle*. The slug is not validated: one that names no plan settles
at once, rather than refusing to start a run whose predecessor you are about to create.

`GET /api/queue` carries **ordering advice** alongside the entries — remaining plan weight and an
ETA per queued plan, computed when you ask and never stored. Nothing on the server reads it back:
it is the figure to look at before deciding to use one of the four controls above.

**Run-level beats plan prose for console-minted sessions.** When a run uses the work branch and the
plan's own `**Branch:**` line names a different branch, the session is told to use the run's branch
and to record the discrepancy in its handoff — the console never silently rewrites the plan.
Hand-driven sessions (copy-paste boot prompts) keep following the plan's line.

# Command reference

Run these from the repository that owns `docs/`, or set `DOCS_ROOT`.

## The engine

```bash
scripts/phase-graph.sh <slug>                    # the board (default)
scripts/phase-graph.sh <slug> --lint             # structural validation; non-zero on a problem
scripts/phase-graph.sh <slug> --ready            # ready phase numbers
scripts/phase-graph.sh <slug> --ready-after N    # the ready set assuming N just completed
scripts/phase-graph.sh <slug> --deps N           # N's prerequisites
scripts/phase-graph.sh <slug> --dependents N     # phases N blocks
scripts/phase-graph.sh <slug> --size N           # S | M | L
scripts/phase-graph.sh <slug> --repos N          # N's SCOPE as a csv — the input to every lock check
scripts/phase-graph.sh <slug> --mcp [N]          # the MCP servers the plan (or phase N) needs
scripts/phase-graph.sh <slug> --mcp-policy [N]   # continue | require
scripts/phase-graph.sh <slug> --gated N          # yes | no
scripts/phase-graph.sh <slug> --gate-kind N      # human | ai | auto | none
scripts/phase-graph.sh <slug> --gate-status N    # evaluate the gate (approval clears any kind)
scripts/gate-approve.sh <slug> N --by <who>      # record a clearance (--revoke restores the gate)
scripts/phase-graph.sh <slug> --boot-prompt N    # the copy-paste prompt for phase N
scripts/phase-graph.sh <slug> --session-plan opus   # proposed session grouping
scripts/phase-graph.sh <slug> --qa-mode          # off | on <reason> | waived <reason>
scripts/phase-graph.sh <slug> --qa-result N      # the recorded verdict
scripts/phase-graph.sh <slug> --qa-prompt N      # the QA subagent's brief
scripts/phase-graph.sh <slug> --plan-status      # active | complete | abandoned | superseded
scripts/phase-graph.sh <slug> --closed           # exit 0 if the plan is closed, 1 if open
scripts/phase-graph.sh <slug> --memory-block     # done/ready/waiting, for the memory entry
```

A **closed** plan answers differently on purpose: `--ready` and `--ready-after` come back empty,
`--session-plan` returns a notice instead of groups, `--lint` still lints but exits `0`, and the board
prints a `🔒 CLOSED` banner in place of the ready/waiting/batching lines. `validate.sh` skips it and
`next-phase-prompt.sh` offers no boot prompts. See [the artifacts](artifacts.md#a-plan-can-be-closed).

## The helpers

| Script | What it does |
|---|---|
| `new-plan.sh <slug>` | Scaffold `docs/plans/<slug>.md` from the template. |
| `new-handoff.sh <slug> <N> <title> [status] [--qa] [--force]` | Scaffold the phase handoff, update `INDEX.md`, auto-fill dependencies and generate a boot prompt per unblocked phase. |
| `handoff-status.sh <slug>` | The INDEX, per-file status, and the live board. |
| `next-phase-prompt.sh <slug> <N\|none>` | End-of-phase banner, board, batching advice, and a boot prompt for every newly ready phase. |
| `phase-lock.sh <slug> claim\|release\|status\|list\|conflicts <N> [--owner <id>] [--scope <csv>] [--session <id>] [--force] [--git]` | Claim, release or inspect a phase lock; `conflicts` asks across every plan whether a live session shares your scope. `--session` (default `$PE_SESSION_ID`, else `$CLAUDE_CODE_SESSION_ID`) names the session in the lock, so the console can release it the moment that session ends. |
| `phase-lane.sh <slug> create\|merge\|remove <N> [--qa <round>] [--detach] [--repo <token>] [--owner <id>] [--force]` · `phase-lane.sh list [<slug>]` | A hand session's own checkout, made where the console keeps its own: a locked worktree of the phase's repository under `<root>/.worktrees/hand/<slug>/p<N>[-qa<r>]` on `pe/<slug>-p<N>[-qa<r>]` (or detached), folded back with ff-then-`--no-ff`, removed with `worktree remove` + `branch -d` — never a sibling folder of the project. |
| `phase-outcome.sh <slug> <N> complete\|waiting-external\|blocked\|needs-human\|partial\|no-defect [--reason …] [--wait-minutes M \| --until ISO] [--watch ref]` | Declare how a session ended, machine-readably — the runner's channel (`PE_OUTCOME_FILE`); unsupervised, it lands in the console's inbox and is picked up the same way. `--wait-minutes`/`--until` are accepted only with the three that PARK (`waiting-external`, `blocked`, `needs-human`). `no-defect` is "I looked, and there was nothing to fix". |
| `phase-outcome.sh <slug> <N> ruling --what "…" [--why "…"] [--kind ambiguity\|deviation\|deferral] [--cost-if-wrong "…"]` | The same script's **second shape**: what a session *decided*, as opposed to how it ended. Appends one NDJSON line to the plan's ruling ledger (`PE_RULINGS_FILE`, else `runs/<instance>/<slug>/rulings.ndjson`). A ruling is never an outcome — nothing acts on it, and declaring one does not declare the other. |
| `session-hook.sh` | The user-scope Claude Code hook (SessionStart · Stop · SessionEnd) that reports a session to the console owning its directory; installed by `phase-console install-hooks` or Settings ▸ Automation ▸ Session presence. Fail-open; `PHASE_CONSOLE_HOOK_OFF=1` silences it. |
| `qa-record.sh <slug> <N> <pass\|fail\|waived\|pending> [--report <path>] [--round N] [--reason TEXT]` | Record a QA verdict. `--round` defaults to previous + 1 and is what writes the `## QA rounds` ledger (refused with `pending`); `--reason` is `waived`-only and lands in `## QA waivers`. Read the history back with `phase-graph.sh <slug> --qa-history N`. |
| `close-plan.sh <slug> [--status abandoned\|superseded\|complete] [--reason "…"] [--reopen] [--force]` | Close a plan that will never finish, or `--reopen` one. Sets `status:`, `closed:` and `closed_reason:`, and releases the plan's own phase locks. Idempotent; never touches git. |
| `validate.sh <slug>` | Full validation — plan structure *and* handoff consistency. |

---

