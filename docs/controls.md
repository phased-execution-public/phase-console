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
| Cut this run's branch from a chosen base, cap the runs beside it, say what becomes of its checkouts | the launch form ▸ *Branch and checkout* ▸ **Base branch** · **Runs beside it in the repository** · **When the run settles, its checkouts** — each speaks only where the plan's `**Base branch:**` / `**Repo capacity:**` / `**Worktree retention:**` line is silent, and each opens on the Settings ▸ Automation default; the base is refused (`409`) once the branch exists, the cap is clamped to the console's own | the console · the plan |
| Read where every lane was cut from | the run page's phase table and the Now page's lane row ▸ the branch chip's title — *Cut from `<ref>` at `<sha>` (which git arm; who declared it)*, from the run record's `base` | the console |
| See that a lane's tree is locked | the Now page's lane row ▸ **locked** chip — the `git worktree lock` reason the runner fastened, on git's word (`ChildRef.locked`); absent means no lock this console holds | the console |
| Bring a stack up before a phase can be proved | `- **Setup:**` in that `### Phase N` block (or one `**Setup (every phase):**` line in §Session budget) | the plan |
| How long a session may sit on its OWN background job before the console parks it | Settings ▸ Automation ▸ `stallLocalJobMs` (45 min shipped) | the console |
| Bound the console's own checkouts (cap, setup command, `.env` copy, branch reclaim) | Settings ▸ Automation (shown only while isolation is on) | the console |
| Delete a run's `pe/*` branches once their PR has merged | Settings ▸ Automation | the console |
| Open a PR when the plan completes | Settings ▸ Automation ▸ Open a PR (needs the work branch) | the console |
| Queue runs whose repos overlap | Settings ▸ Automation ▸ Repository guard | the console |
| Let the console heal a stopped run by itself | Settings ▸ Automation ▸ Auto-recover halted runs (and the ladder card's toggles) | the console |
| Bound what it may spend by itself | Settings ▸ Automation · the ladder ▸ Caps (rungs and dollars per phase / run / day) | the console |
| See who is in the repository, and queue behind them | Settings ▸ Automation ▸ Session presence ▸ Install (or `phase-console install-hooks`) | the console · `~/.claude/settings.json` |
| Answer every decision a run could ask BEFORE it starts | the launch form's **Decisions** stage: the manifest with each row's state, the five pre-spawn probes (accounts · MCP · credentials · delivery · verification commands — approve an exact command or waive a check, once, before anything spawns), the four required answers (`resumeOnRestart`, `relay`, the accounts with their minimum headroom, the acknowledged waivers) and the one recorded override (`run.manifest-override`); the start door answers 409 on an open blocking row (`GET /api/run/<slug>/prelude` is the same computation) | the console · the plan's `## Decisions` |
| Check a console and its machine by hand | `phase-console doctor [instance] [--json]` — the prelude's probes with no plan in front of them, then the machine, one row each: `accounts`, `mcp`, `credentials` (the machine `claude` login), `delivery`, `hooks`, `cli` (the Claude CLI version against the relay floor), `gh` (`gh auth status`), `environment` and `console`. It asks the console answering on the instance's port (`GET /api/doctor`, which is what `--json` prints); with none it reads the state directory and the machine (`mode: offline`), and a row only a running console can answer says `skip`, never `ok`. PATH advisories print as `↳` warnings under their row, not failures. Exit 1 names the first failing row that blocks — `accounts`, `credentials`, `hooks`, `environment`, or `console` when the console answers and reports itself degraded | the console · the machine |
| Answer a decision class for every plan on this console | Settings ▸ Automation ▸ Policy answers — the policy table's rows (one control each, the closed words or one line of text), with a plan picker that shows that plan's own row and the answer in force with its source; every change is `policy.changed {key, from, to, by}` | the console (`policy.<key>`) |
| Keep what a session decided | a keyed ruling (`phase-outcome.sh … ruling --needs <key>`) is an inbox row with **Remember for this plan** (a `## Decisions` row, source `ruling`, through `decisions.sh promote`) and — when its words are an answer the console can hold — **Remember on this console** (`policy.<key>`); the session itself can do the first with `--remember plan` and ask for the second with `--remember global` (`POST /api/run/<slug>/rulings/<id>/remember {scope: plan\|global}`) | the inbox · the plan's twin · the console |
| Answer a relayed question the same way on every run | Settings ▸ Automation ▸ Policy answers ▸ **Relay rules** (`relayRules`), or **Remember as a relay rule** on an answered question's inbox row (`{scope: rule}` on the same route) — see [Relayed questions and relay rules](#relayed-questions-and-relay-rules) | the console · the inbox |
| Answer a lane's session that stopped to ask you | the inbox's session-ask row on an autopilot lane ▸ **Answer it** — your words reach that lane's session as an instruction (`POST /api/run/<slug>/steer {phase, instruction}`, `--allow-run`) | the inbox |
| See how often a person was asked, and how often auto-grant answered instead | Insights ▸ **Who was asked** — the instance's `approvals/counter.json` (`raised`, `autoGranted`, `since`, `lastRaisedAt`), carried by `GET /api/state` as `approvals` with the `pending` count beside it | the console |
| Know when the policy in force cannot ask, or the deny wall is struck | Settings ▸ Permissions shows an acknowledgeable banner per advisory (`ask-empty` · `deny-struck`), logged once per boot as `policy.advisory`, carried by `GET /api/policy` as `advisory`, acknowledged with `POST /api/policy/advisory/acknowledge {kind}` against the rules it named | the console |
| Stop the console, as hard as you mean it | Settings ▸ This instance ▸ **Shut down** (`mode: exit`) or **Stay off…** (`mode: unload`) — each opens a dialog listing what the console is holding; see [Shutting the console down](#shutting-the-console-down) | the console |
| Send every announcement to a chat channel | Settings ▸ Notifications ▸ Channels (needs `--allow-webhooks`) | the console · `docs/webhooks.md` |
| Let the console push a finished phase's branch | start it with `--allow-publish` AND let the plan's `permission.destructive` row allow `git push` — both, or the landing parks with `phase.landing-push-refused`; `phase-console doctor` has a `publish` row saying whether a push is possible at all | the start command · the plan's `## Decisions` |


### Who a press is recorded as

Every verb that reaches the console over HTTP — a button, `curl`, the CLI — is recorded under an actor
derived from the request itself (`actorOfRequest`), never from a name the client volunteers alone:

- **`via`** — `cli` when the User-Agent begins `phase-console` or `btw`, otherwise `api`.
- **`origin`** — `local` for a loopback Host, otherwise that hostname.
- **`remoteUser`** — the `tailscale-user-login` header, read only under `--remote` and only for a
  request that did not arrive on loopback; without `--remote` nothing has vouched for it.
- **`by`** — the body's `by` label when it offers one (trimmed, at most 64 characters), else the proxy's
  login, else `operator` for a browser or the CLI, else `script` for anything else.

The app sends no `by` of its own, so a press in the browser reads as `operator` locally and as the
signed-in login through the proxy. Shut down, Stay off, Release, the ruling routes, the account
clearance and the account check all carry this actor into their log lines and journal rows.

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
| Open a PR at completion | on | Work-branch runs only: the plan's **last** phase is told to push `pe/<slug>` and open a PR per scoped repo. For that run — and only that run — bare `git push` moves from the deny wall to an approval card, and `gh pr create` stays a card even under the `trusted` profile; force-pushes and `--delete` stay denied outright. Auto-grant never answers those two cards: each raises a real card for a person unless the plan's `permission.destructive` row names the rule as an exception, and a grant under that exception is announced. |
| Repository guard | on | The scheduler queues runs whose repository scopes overlap. Off: overlapping runs may start together, and a work-branch run sharing a repo with a live one is told to work in a linked `git worktree` instead of switching the shared checkout. |
| Take the run branch back from a clean checkout | Clean only | Isolated runs only: a checkout sitting on `pe/<slug>` with nothing uncommitted in it is switched to the default branch so the run can have its own tree. A checkout holding work — including a file nothing ever added — is never touched, and the run refuses `branch-in-use` naming those files. No branch is deleted and no ref moves. `Never` turns it off. |
| Isolated runs per repository | 3 | How many of this console's runs may hold a checkout in ONE repository at a time (`maxConcurrentPerRepo`). The machine-wide cap beside it bounds disk; this one bounds how much is happening in a repository a person may have to read, and the narrower of the two answers first. A fourth run waits on a `repo cap` holder — named on the queue, never a park — while a run in another repository starts at once. |
| Serialise conflicted branches | off | When the repository's conflict radar measures two LIVE branches as `conflicted`, the phase the landing order puts second waits behind a `radar` holder until the first has landed, and the wait is journalled `phase.radar-hold` with the pair and both orders (`radarSerialize`, many-plans-one-repo phase 9). The landing order is the landscape's — topological over `Depends on`, ties broken clash-zone first, then radar overlap, then FIFO — so the queue and the map agree. Off (shipped): the radar stays advisory, exactly as before; the pair is shown on the git card and the landscape and nothing waits. An `overlap` never serialises under either setting. A free console has no radar, so the switch does nothing there. |
| What becomes of a run's worktree | Keep on failure | `keep-on-failure` keeps a red run's checkout, because it holds the only copy of what went wrong, and removes a green one's, which holds nothing its branch does not. `prune` always removes, `keep` never does, and `ttl:<h>` removes a clean, landed, unlocked tree after that many hours. **A dirty tree is never removed under any word** — uncommitted work outranks every retention setting there is. |
| Base branch of `pe/<slug>` | `origin/HEAD` | What a new run branch is cut from. `origin/HEAD` is the remote's own default branch, falling back to the local trunk; `head` is whatever the checkout has out (the behaviour before this setting existed); anything else is a ref, verified — and a ref that does not resolve forks nothing new and says so, rather than silently using the trunk. A plan's own `**Base branch:**` outranks this. The resolution is pinned to a COMMIT, so a trunk that moves between the decision and the checkout cannot move the run's starting point. |
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
| Resume killed lanes at boot | **ask** | What this console does about work its own restart stopped — a killed lane, a run a shutdown stopped, a wait whose clock went by while nothing ran (`resumeAtBoot`: `ask` · `auto` · `off`). A run's own answer comes first: the launch form's `resumeOnRestart` continues (`true`) or writes the errand (`false`), and only a run carrying neither falls through to this preference. **Ask** — the shipped default — starts nothing and puts the question in front of whoever opens the app next, naming the runs and phases, and a `continue` there outranks a stored `false`; **Always** resumes without asking; **Never** writes the errand straight away. A resume a live console makes on its own clock is the session's own declaration and is not asked about. Every automatic resume of a phase, restart-caused or not, is counted on one per-phase counter (`bootResumes`, read by `automaticResumeGate`), and at 3 (`MAX_BOOT_RESUMES`) the next one is an errand whatever woke it. The question is asked once per console start, and answering it is not stored — a restart is the event that makes it new again. |
| Switch accounts at a wall | on | A signed-out run account, or a usage window too far out to sleep on, switches to a registered account that can pay (`autoAccountSwitch`); off, the wall halts with an errand. |
| Delegate human gates | **on** | A `manual` gate is briefed to the phase's own session to VERIFY its conditions against citable evidence and record the clearance as `by: ai-session-delegated`, instead of stopping the run for a person (`delegateHumanGates`). **Off by default and deliberately so** — the plan author wrote `human`, and "the owner approves the visual result" is not a thing a session can judge. What makes it safe is not trust: the brief requires cited evidence per condition and STOPS with the condition named when it has none. Turn it on for a plan whose gates are machine-verifiable in practice. |
| Policy answers | none | This console's answers to the decision manifest's rows, keyed by decision key (`policy`, an object; `shared/policy-model.js` `DECISION_ANSWERS`, one line of text for the free-text keys). Read below a plan's own `## Decisions` row and above the shipped defaults — `gates: delegated` · `qa.exhausted: waive` · `resume.on-restart: continue` · `ambiguity: ruling`. Edited row by row on the **Policy answers** card (Settings ▸ Automation), written whole through `POST /api/prefs`, every changed key journalled as `policy.changed {key, from, to, by}`; a ruling remembered on this console lands here too. |
| Board a phase that states no verification | **off** | A phase whose plan omits the §Verification bullet boards anyway and passes on its handoff alone (`allowUnverifiedPhases`), instead of parking at boarding with "add a §Verification command, then Retry". The record says `phase.verify-waived`, so nobody reads "0 commands green" as proof, and a bullet the runner cannot read still parks — that is a formatting fault the author should hear about. |
| One more rung while the work is moving | **off** | When a phase has spent its rungs but the newest settled rung landed commits, the ladder is granted ONE extra rung for that phase (`ladderExtendOnProgress`, journalled `phase.ladder-extended`). Once per phase; the dollar caps stand. |
| Run `cmd:` watch refs | on | A session's `--watch cmd:"…"` is run on the console's own timer to see whether what it waits for has landed — under the read-only policy a plan's §Verification gets, 60 s, never a shell (`watchCmdRefs`). Off: such a ref is never run and nothing resumes on it. |
| Run `cmd:` refs the console minted | **off** | When the watchdog parks a lane that was polling inside its turn, it files the command it was polling with as a watch ref of its own (`watchMintedCmdRefs`). Off: that ref is recorded and never run — the console's own inference does not execute a command against a repository nobody is watching — and the park still resumes on its clock. On: minted refs run exactly as declared ones do. |
| Park a waiting lane by itself | on | A lane waiting inside its turn — an open poll loop, or a wait the console refused — is checkpointed and parked in the console's own name, on its own allowance and never the session's declared waits (`stallAutomaticPark`). Off: the stall card still stands and the local-job nudge still goes, but nothing is parked. |
| Automatic starts per hour · Session spend per hour | 40 · $250 | The ladder card's **Start ceiling** (`ceilingStartsPerHour`, `ceilingUsdPerHour`). Every `claude` this console starts by itself — a boot re-adoption, a wait clock, a converge relaunch, the MCP probe, the reviewer — is counted over a sliding hour, and so is what the sessions that ended in that hour reported costing; past either, the next automatic start is refused by name (`run.start-refused {door, ceiling, limit, count, until}`) and announced once per window. Your own Start, Retry and Continue are never counted and never refused. 0 turns a limit off. |
| Relay rules | none | This console's standing answers to relayed questions (`relayRules`) — see [Relayed questions and relay rules](#relayed-questions-and-relay-rules). |
| Boarding schedule | **off** | When this console is willing to START phases (`boardingSchedule`). See below. |

The three checkout defaults above — the base branch, the runs beside it, the checkouts' retention —
are rendered by the same launch form the run opens on (`<RunSetup mode="defaults">`, many-plans-one-repo
phase 15), so the words an operator reads when setting a default are the words they read when
starting a run; each launch may override them for itself, and a plan's own line outranks both.


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
  immediately, because pressing a button at 02:00 is asking for it. Never held is not never refused,
  though: a recovery press over exactly the evidence the last recovery of that phase ran under (the
  board, the handoff, the locks, the gate) is refused as `unchanged`, and one past six recoveries of a
  phase in a run as `capped` (`RECOVER_MAX_PER_PHASE`) — both journalled `run.recover.refused`, the
  sentence naming the recovery it repeats. Retry starts the phase over and clears the count.
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

Each credential also carries where it stands with the organisation that pays for it —
`unknown` · `entitled` · `cooling` · `retired` (`ENTITLEMENT_STATES`), learned machine-wide and keyed by
organisation as well as by account. A usage wall leaves an account `cooling` until the wall's own reset
(30 minutes when none parsed, `ACCOUNT_COOLDOWN_MS`); a credential-class refusal — an organisation
policy, a billing hold, a revoked key — leaves it `retired`, and every account sharing its organisation
with it, until a person clears it. Two routes, both behind `--allow-accounts` and both attributed to the
request that asked:

- `POST /api/accounts/<id>/clear-retired` — the one door out of `retired`: the credential and its
  organisation go back to `unknown`, and the next successful meter read or spend proves them again.
- `POST /api/accounts/<id>/probe-entitlement` — asks the API directly, with one declared one-turn session
  under that account, and waits for the answer. A credential-class refusal retires it exactly as a
  phase's refusal would; any answer — a usage limit included, since the API took the credential and then
  counted — promotes `unknown` to `entitled`; a session that could not answer moves nothing. 409 while a
  check is already running for it.


### Relayed questions and relay rules

A run's relay is one of `RELAY_MODES` — `off` · `last-resort` — answered on the launch form's
Decisions stage. Under `last-resort`, a question a session raises through `AskUserQuestion` reaches
you as a card held open for its window; unanswered, the console answers it by its relay rules when the
window closes ([The loop](loop.md) has the window and the order the console answers in). Under `off`
the console answers nothing on the session's behalf, and the run carries `--permission-prompts none`. Answering from anywhere but
the card is `POST /api/run/<slug>/answer {approvalId, answers: [{key|question, label}]}` — at most four
picks, behind `--allow-run` like the permission card beside it, and 409 once the window has closed.

`relayRules` is a list of `{id, tool, key, profile, answer}`:

- **`key`** — a glob (`*` spans anything), matched case-insensitively against the question's key
  (`questionKey`): its header slugged to 24 characters, a colon, its text slugged to 60.
- **`tool`** — the asking tool, `AskUserQuestion` when omitted; **`profile`** — the run's permission
  profile, `*` (any) when omitted; **`id`** — derived from the other three when not given.
- **`answer`** — an option label, matched exactly or as the unique prefix of one, case-insensitive
  (`Blue` answers `Blue (Recommended)`). A rule whose answer names no option of the question does not
  apply, and the answer falls through to the recommendation.

A malformed rule is dropped rather than repaired — a repaired rule answers a question its author never
wrote it for — and at most 50 are kept (`MAX_RELAY_RULES`). The table is edited on Settings ▸ Automation
▸ Policy answers ▸ **Relay rules**; an answered question's inbox row offers **Remember as a relay rule**,
which is `POST /api/run/<slug>/rulings/<id>/remember {scope: rule}` — it writes this preference rather
than a `## Decisions` row, so it carries the mutation guard alone, like `global` — and the rule it writes
matches that question on any profile.

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
card for you. It never touches a **frozen** or **pausing** lane either — every lane of a console frozen
whole included: those are silent because the console made them so.

Underneath it, and independent of all of the above, every session now carries a **first-event
bound** — a session that produces no output at all for twenty minutes is ended through the normal
teardown, even with no console driving it. Twenty and not fifteen so that it lands strictly after
the recycle rather than level with it: the two clocks must never race over whether the session is
kept. Output that cannot be parsed is logged and counted rather than dropped, so "it said nothing"
stays a claim you can trust.

## Stopping things, at three sizes

Three surfaces carry the same verbs, scoped differently. The **run controls** act on the whole run:
*Pause after this phase* (boundary), *Freeze now* (SIGSTOP every session, reversible), *Stop now*
(SIGINT to each session first, so its turn closes and writes its result, then SIGTERM to its process
group after a 5 s grace, with an awaited SIGKILL behind that — `viewer/server/runner/signals.ts`;
each phase's **status** records `interrupted` — its lifecycle **state** folds
that to `failed`, as it folds every stop, so the two words are two axes and never a red
verification). Each **session tab** — on the
autopilot page, the Runs page's lanes, and the session console's own toolbar — carries **Freeze/
Continue** and **Stop** for that one session: the rest of the run keeps scheduling, a stopped
phase keeps its session id for Retry, and a queued phase's Stop takes it out of the admission line
before anything spawns. The **run cards** on the Runs board carry the run-level Freeze/Continue and
Stop, so a live run is never a card you can only link away from. None of these touch the
consecutive-failure budget. Only a person's press resets it — Start, Continue or Retry; every
automatic door (the convergence loop, a watch landing, a boot re-adoption, the healer's rungs) carries
the streak forward, and a run that stopped on a spent streak is refused the loop's own relaunch
(`run.relaunch-refused`) until somebody presses. The fourth and largest size is the whole console at
once — the next section.

## Freezing the whole console

The fourth size, and the one to reach for when you are stepping away or something is going wrong
faster than you can read it. **Freeze all** (Settings ▸ Automation, and the orchestration
board's header on `#/runs`) stops every running session where it stands and starts nothing new — no queued
phase, no elapsed wait, no recovery, no convergence pass. **Thaw all** puts the whole console back
exactly where it was.

Four things are worth knowing, because each is the opposite of what a stop button usually does:

- **Nothing is lost, and nothing becomes a checkpoint.** A frozen session is `SIGSTOP`ped, so it
  thaws mid-token in the same process. Unlike a per-lane *Freeze now*, a whole-console freeze carries **no
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
you froze it. `GET /api/fleet` (`{fleet, allowRun}`) and `/api/state`'s `fleet` field carry the
state, which is what the app-wide banner renders on every page. The freeze itself is `freeze.json`
(`{at, by}`) in the instance's state directory.

**The wire says `fleet`; the words say console.** `FLEET_TIERS` in `viewer/shared/fleet-model.js` names
three tiers, narrowest first: `run` (one plan's autopilot), `console` (one process, one repository,
every run it drives) and `fleet` (every console of one person on one machine). This section is the
console tier. Its routes and state field keep their older spelling so a client in the field keeps
working — `state.fleet`, `/api/fleet/freeze`, `/api/fleet/thaw` (`LEGACY_CONSOLE_TIER_NAMES`) — and
`state.fleet` is `{frozen, at, by}`, where `frozen` is this console's own freeze and nothing else.


**Freeze, then stop** is two presses, not one verb: **Freeze all**, then **Shut down** (next section).
The freeze marker is instance state, so the console that comes back is still frozen and starts nothing.

## Shutting the console down

Settings ▸ This instance carries the off switch in two strengths (`SHUTDOWN_MODES`):

| Press | `mode` | What it does |
|---|---|---|
| **Shut down** | `exit` (the default) | The process drains and exits. Under a supervisor that keeps the job alive (launchd `KeepAlive`, systemd `Restart=`) it comes straight back, so this stops the work — every run checkpoints and resumes — rather than the console. |
| **Stay off…** | `unload` | The unit is unloaded **and disabled**, and a stop marker is written before either step, so neither the next login nor a hand-started process picks the automation back up until somebody clears it. It needs a unit this process can name; with none there is nothing to unload, and `exit` already stops it. |

What a press achieves is one of four words (`SHUTDOWN_DURABILITIES`), said by the dialog before the
press and on the `shutdown.requested` log line after it: `returns` — a supervisor brings it straight
back; `until-login` — nothing brings it back now, and the next login starts the unit again;
`stays-off` — nothing supervises it, so nothing starts it again; `disabled` — `unload`'s word, the unit
disabled and the stop marker holding the boot.

**The dialog is an inventory.** Before it opens, the app reads `GET /api/shutdown`: both plans
(`modes.exit`, `modes.unload`), the command that undoes each (`restartHint`, `unloadHint`), any
`bootHold`, and the `inventory` — what the exit would stop, computed from work rather than from counted
terminals:

- `lanes` — every lane a live runner holds, with its pid and session;
- `clocks` — every in-process clock the exit discards, each with its moment and its source
  (`SHUTDOWN_CLOCK_SOURCES`: `wait-resume` · `freeze-escalation` · `mcp-require` · `outcome-inbox` ·
  `session-inbox` · `converge`), every one re-armed from disk by the next boot;
- `runs` — the runs the next boot picks back up, each with its wait clock;
- `liveSessions` — the sessions the presence registry shows live;
- `pendingApprovals` — the cards still waiting on a person;
- `inboxDepth` — `{sessions, outcomes}`: presence drops and unsupervised declarations not yet read.

`empty` says the whole inventory is empty, and `soonestClock` names the work clock that matters first.
Confirming in the dialog acknowledges the list it showed.

**The route refuses a press that has not said what it means.** `POST /api/shutdown` carries the
cross-site guard and nothing else — not `--allow-run`, because a read-only console must still be able to
stop — and takes `{confirm: true, mode?: "exit" or "unload", acknowledge?: true}`. A refusal answers
with the inventory it is about:

| Status | `needs` | When |
|---|---|---|
| 400 | — | no `confirm: true`, so a stray POST cannot end the console |
| 400 | `mode` | a `mode` that is neither `exit` nor `unload` |
| 409 | `unload` | `unload` with no unit to unload, or a stop marker that could not be written — a "stay off" that would not hold is not carried out weaker than it was named |
| 409 | `acknowledge` | `unload` without `acknowledge: true`, always, the reason naming the command that undoes it |
| 409 | `acknowledge` | any press without `acknowledge: true` over a non-empty inventory — the reason is the inventory, soonest work clock first — or over an inventory that could not be read |

**Going down is announced, and the announcement is waited for.** A press that goes through logs
`shutdown.requested` with the request's actor, the mode, the durability and the inventory's digest,
then sends a `health` announcement — *Phase Console is shutting down*, who pressed it and what it was
holding — and the drain holds for its delivery for up to 5 s (`SHUTDOWN_ANNOUNCE_WAIT_MS`). When nothing
reports a delivery, the record gets a `skipped` delivery row saying why, never an empty list.

**Every abandoned run is told why.** Why the process went away is one of `SHUTDOWN_INTENTS`:
`shutdown` (a Shut down press), `restart` (a Restart press) or `signal` (a SIGTERM or SIGINT no request
explains — a logout, a `kill`, launchd stopping the job). The `shutdown.begin` and `exit` log lines carry
it, and so do `run.shutdown-child` and `run.console-shutdown`: a run a live runner drives writes its own
from its checkpoint, and every other run the inventory lists — queued, waiting, paused or parked on a
clock — gets one on its own journal naming the clock the exit discards.

### The stop marker, and who clears it

A `mode: unload` press writes `stopped-by-console.json` in the instance's state directory before
anything is unloaded (`{at, by, via, origin, remoteUser, mode, durability, label, resurrect}`). A
console that boots under it holds its automation — `BOOT_HOLD_KINDS` `stopped`: nothing is re-adopted,
nothing converges, no sweep and no watch clock run, and `boot.hold` says so once. Your own presses are
never held. The other hold, `autostart-off`, is the machine profile saying this console does not start
its work unattended ([below](#whether-a-login-starts-it)).

The hold is `GET /api/automation/hold` (`{bootHold}`); `/api/state` and `GET /api/shutdown` carry the
same `bootHold`. Settings ▸ This instance shows it as a banner with one press — **Clear the stop and
resume** for `stopped`, **Release it for this boot** for `autostart-off` — which is
`POST /api/automation/hold/release` (`--allow-run`, because releasing starts work; 409 when nothing
holds): the marker is removed and the boot pass the hold skipped runs now, the re-adoption and then the
convergence loop. The profile is not edited, so an `autostart: false` still holds the next boot. A
marker removed from outside, under a console that is holding for it, counts the same: that console runs
its held boot pass itself (`boot.hold-released`, `how: marker-removed`).


### Whether a login starts it

The machine profile's `instances.<id>.autostart` — `true`, `false` or `once` — is the start policy a
login and a boot read ([The machine profile](#the-machine-profile)). `false` holds this console's
automation at every boot (the `autostart-off` hold) until it is released for that boot. `once` is spent
by the boot it grants: the entry becomes `false` and the console's own unit is disabled, so the next
login does not start it again (`boot.autostart-once`).


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
superproject's recorded gitlink shas: the one-tree settle (`merge-queue`) refuses a multi-repo run
by name (`run.settle-unsupported`); `integration` settles every mount into its own staging tree,
deepest first, and raises an errand for the pointer bump when a submodule's staging took a merge
commit; and `pr` opens one pull request per mounted repository that has commits. Every refusal **degrades to the shared checkout with queue semantics** — exactly the
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
`keep` does nothing, so neither gets it. A clean tree is removed when the run settles — unless the
retention setting says otherwise — and a **dirty** one is kept and journalled, because uncommitted
work is never the console's to throw away.

**A live tree says so, and that is enforced by git and not by us.** Every checkout the console holds
carries a `git worktree lock` while it is live, with a reason naming the run —
`phase-console lane <slug> p<N> <runId> <ISO>`. That is not decoration: `git worktree prune` skips a
locked registration and `git worktree remove` refuses a locked tree, so the belt holds against this
console's sweeps, a second console's, and a hand typed in the wrong terminal. Two consequences worth
knowing before you meet them:

- **To remove a console tree by hand, unlock it first** — `git worktree unlock <path>`, then remove.
  git refuses otherwise (it wants `--force` twice), and the refusal is the feature working. Every
  path the console takes unlocks first by itself, so a run that needs its tree back still gets it.
- **A lock the console did not write is never taken.** Your own
  `git worktree lock --reason "resolving this by hand"` is a sentence addressed to the sweeps, and
  they obey it: the tree is kept and named once (`run.worktree-locked-foreign`). The same holds for
  the staging tree — a settle that finds `pe/integration` locked by a person merges nothing and says
  so, rather than merging into a tree somebody is standing in.


**The console pushes only under `--allow-publish`, and only a branch of its own.** The eighth
capability flag, off by default, lets a landing push a finished phase's `pe/*` branch —
`pe/<slug>-p<N>` for a lane, `pe/<slug>` for an isolated or mirror run — to `origin`, through the one
seam that may ever reach a remote (`pushRef` in `runner/worktree.ts`) with one frozen argv:
`git push --porcelain --no-follow-tags origin refs/heads/<ref>:refs/heads/<ref>`. It never pushes a
trunk, never `pe/integration` (a tree several plans meet on; 5.1 leaves publishing it to a person on
purpose), never with force, never a delete, never a retry of a rejected non-fast-forward push, and
never a name outside `^pe/[A-Za-z0-9._-]+(-p\d+)?$`. Two conditions must both hold — the flag is on
AND the plan's `permission.destructive` row names `git push` as an allowed exception — and without
either the landing journals `phase.landing-push-refused {reason}` and parks: nothing is spawned and
nothing reaches the origin. `phase-console doctor` carries a non-blocking `publish` row saying whether
a push is possible at all. A free console parses the flag and pushes nothing.

**A phase may take a checkout of its own, or decline one** — `- **Isolation:** worktree` or
`shared` in its `### Phase N` section, which outranks the plan-wide `**Worktrees:**` line in both
directions. A phase doing isolated work carves itself in; one that must see its siblings' work as it
lands carves itself out. Silence inherits.

**A checkout the console mints is missing whatever git ignores**, which for a lot of repositories is
what a build needs. `.worktreeinclude` at the repository root fixes that: one path per line, `#`
comments, files or directories, copied into a tree this console just created. It rides the same
switch as the `.env` copy (Settings ▸ Automation), because it is the same decision. Three refusals,
each named in the journal rather than silently dropped: a path that resolves outside the repository,
a path that is not there, and anything past the 200-file / 50 MB cap.

**Two branches can both be editing something that merges cleanly and is wrong afterwards** — a
lockfile, two migrations, `.gitmodules`, a generated file. Those are **clash zones**, and the
repository's conflict radar warns about them while serializing the two is still cheap: an `fyi` row
in the inbox, a `clash zone` badge beside the pair on the run's Branch & checkout card, and
`run.clash-zone` in each involved run's journal. Never a refusal — nothing is broken yet, which is
the whole point of saying it now. The defaults cover the four families above; a repository adds its
own in `.phase-console/clash-zones` (one glob per line, `**` crossing directories), and a plan adds
work-specific ones on a `**Clash zones:**` line. All three are unioned — a plan naming one glob
never turns the lockfile rule off.

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
scripts/phase-graph.sh <slug> --credentials [N]  # the credential ids the plan (or phase N) needs
scripts/phase-graph.sh <slug> --credential-policy [N]   # require | continue | "" (the phase overrides)
scripts/phase-graph.sh <slug> --accounts         # the **Accounts:** line as id<TAB>minHeadroom per line
scripts/phase-graph.sh <slug> --qa-exhausted     # waive | halt | <owner> | "" (the **QA exhausted:** line)
scripts/phase-graph.sh <slug> --person-check N   # allow | halt | <owner> | "" (phase N's Person-check bullet)
scripts/phase-graph.sh <slug> --decisions [N]    # the decision manifest as it holds: key<TAB>state<TAB>owner<TAB>blocking<TAB>source<TAB>value
scripts/phase-graph.sh <slug> --wait-budget [N]  # minutes<TAB>phase|plan — how long a phase may stay parked on its declared waits; nothing when the plan is silent
scripts/phase-graph.sh <slug> --waits-on N       # the refs phase N's `- **Waits on:**` bullet names, one per line
scripts/phase-graph.sh <slug> --gated N          # yes | no
scripts/phase-graph.sh <slug> --gate-kind N      # human | ai | auto | none
scripts/phase-graph.sh <slug> --gate-status N    # evaluate the gate (approval clears any kind)
scripts/gate-approve.sh <slug> N --by <who>      # record a clearance (--revoke restores the gate)
scripts/phase-graph.sh <slug> --notes N          # what earlier phases LEFT for phase N: source<TAB>kind<TAB>id<TAB>at<TAB>text
scripts/phase-graph.sh <slug> --boot-prompt N    # the copy-paste prompt for phase N (notes block included)
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
| `phase-outcome.sh <slug> <N> complete\|waiting-external\|blocked\|needs-human\|partial\|no-defect [--reason …] [--needs KEY] [--rule …] [--command …] [--wait-minutes M \| --until ISO] [--watch ref]` | Declare how a session ended, machine-readably — the runner's channel (`PE_OUTCOME_FILE`); unsupervised, it lands in the console's inbox and is picked up the same way. `--needs <key>` is REQUIRED on `blocked` and `needs-human` (a decision key of the plan's manifest, or `credential` / `permission` / `gate` / `external` / `lock`) and is what the classifier reads before the prose. `--wait-minutes`/`--until` are accepted only with the three that PARK (`waiting-external`, `blocked`, `needs-human`). `no-defect` is "I looked, and there was nothing to fix". `--watch` is repeatable (at most 8: `gh:<repo>#run/<id>` · `gh:<repo>#pr/<n>` · `date:<ISO>` · `lock:<slug>/<phase>` · `cmd:"<command>"`); a ref of no shape the console polls is warned about on stderr ("will never be checked") and journalled `phase.watch-unpollable`. What the console does with the words: a `waiting-external` window is judged against the phase's wait budget (`--wait-budget` above: its `Waits on:` bullet, else the plan's `Wait budget:`, else the console's 8 h) — granted inside it, and a declared window past it refused with the arithmetic unless the plan countersigned a `date:` reaching that far; a `blocked` or `needs-human` clock is capped at 7 days (`DECLARED_CLOCK_MAX_MS`) and the cap journalled. Each word is acted on at most 4 times per phase (`DECLARATIONS_MAX_PER_PHASE`; past it `phase.declaration-refused`, and Retry clears the count), `waiting-external` being bounded by its own park count instead; unsupervised, a second `partial` inside 5 minutes collapses into the first (`DECLARATION_COOLDOWN_MS`). |
| `phase-outcome.sh <slug> <N> ruling --what "…" [--why "…"] [--kind ambiguity\|deviation\|deferral] [--cost-if-wrong "…"] [--for <M\|next\|all>] [--needs <key>] [--remember plan\|global] [--by WHO]` | The same script's **second shape**: what a session *decided*, as opposed to how it ended. Appends one NDJSON line to the plan's ruling ledger (`PE_RULINGS_FILE`, else `runs/<instance>/<slug>/rulings.ndjson`), stamped with its id and — with `--needs` — the decision key it answers (a manifest key, never a blocker short form). A ruling is never an outcome — nothing acts on it, and declaring one does not declare the other. `--remember plan` promotes it at once (a `## Decisions` row through `decisions.sh promote`, source `ruling`, then an attributed ack); `--remember global` asks the owning console to hold the words as its `policy.<key>` answer and exits 1 naming Settings ▸ Automation ▸ Policy answers when no console answers. |
| `session-hook.sh` | The user-scope Claude Code hook — four entries, SessionStart · SessionEnd · Stop · Notification — that reports a session to the console owning its directory; installed by `phase-console install-hooks` or Settings ▸ Automation ▸ Session presence. Notification carries the ask's own `message` and its `notification_type`. The owner is resolved through the registry (`viewer/shared/instances.mjs owner`, from `$DOCS_ROOT` when it is an absolute existing directory, else the session's cwd) with no only-console fallback; a directory no registered console claims is recorded `unowned` in the machine's sink, `<state home>/fleet/sessions/inbox/`, rather than dropped or filed against the wrong console. The record is POSTed with a 2 s timeout; when no console answers it lands in the instance's `sessions/inbox/`, and when the console refused the connection and there is a `node`, the hook drains that inbox itself with `phase-console sessions ingest` — in the background, except at SessionStart, where it waits for the peers line it puts in the new session's context. `PHASE_CONSOLE_HOOK_INGEST=0` leaves the inbox for the console; `PHASE_CONSOLE_HOOK_OFF=1` silences the hook. Always exits 0. |
| `decisions.sh <slug> [--phase N] answer <key> --value … \| waive <key> --reason … \| promote --from-ruling <id> --key <key> \| list` | Write the decision manifest's twin (`docs/handoffs/<slug>/decisions.md`), which `--decisions` merges over the plan's own `## Decisions` rows — never edit it by hand. `answer` records a value, `waive` that the decision does not apply, `promote` turns a ruling into a standing answer (found by the id `phase-outcome.sh` stamps on the RULING line, never its ack; `--key` is optional for a ruling that carries its own `decisionKey`); `--phase N` scopes the row to one phase. |
| `qa-record.sh <slug> <N> <pass\|fail\|waived\|pending> [--report <path>] [--round N] [--reason TEXT]` | Record a QA verdict. `--round` defaults to previous + 1 and is what writes the `## QA rounds` ledger (refused with `pending`); `--reason` is `waived`-only and lands in `## QA waivers`. Read the history back with `phase-graph.sh <slug> --qa-history N`. |
| `close-plan.sh <slug> [--status abandoned\|superseded\|complete] [--reason "…"] [--reopen] [--force]` | Close a plan that will never finish, or `--reopen` one. Sets `status:`, `closed:` and `closed_reason:`, and releases the plan's own phase locks. Idempotent; never touches git. |
| `validate.sh <slug>` | Full validation — plan structure *and* handoff consistency. |

## The console's own commands

| Command | What it does |
|---|---|
| `phase-console install-hooks \| uninstall-hooks \| hooks-status [--settings <file>]` | Add, remove or report the four session-presence entries in `~/.claude/settings.json` (or the file `--settings` names) — merged, never clobbered, idempotent. `hooks-status` exits 0 when they are installed and 1 when not. |
| `phase-console doctor [instance] [--json]` | The report described in [the control surface](#the-control-surface-at-a-glance): the prelude's probes and the machine rows, from the console on the instance's port or, with none, from disk (`mode: offline`). Exit 1 names the first failing row that blocks; `--json` prints the report as `GET /api/doctor` serves it. |
| `phase-console sessions ingest [instance] [--root DIR] [--json] [--quiet] [--peers-of <session>]` | Drain an instance's session-presence inbox through the registry's own code with no console up: every event applied with its lateness, one older than the history horizon applied as history, one older than a week refused. It never drains under a console — when the instance's own console answers on its port, or the port answers too slowly to tell, it says so and does nothing, because a running console drains its own inbox. Prints `drained <name>: N applied (N as history), N refused, N left`; `--peers-of` adds one `peers=<sentence>` line, the live sessions in the root without that one. One drain at a time across processes. |


## The machine profile

`~/.config/phase-console/fleet.json` holds what is true of the machine rather than of one project. Every
console on the machine reads it; it is written from a shell, never from a browser:

| Field | What it is |
|---|---|
| `remoteHost` · `remoteUsers[]` | The `--remote` hostname and the logins allowed through it — inherited as a pair, so a half-written pair leaves a console local-only rather than refusing to boot |
| `notifyCommand` | The out-of-band notifier, used when `PHASE_CONSOLE_NOTIFY` is unset |
| `webhooks[]` | `{url, name?, categories?}` |
| `categories` | `{<id>: bool}` |
| `quietHours` | `{start, end, allowUrgent}` |
| `maxSessions` | The machine's lane ceiling — every console's live lanes summed |
| `hookScript` | An absolute path; a relative one is ignored |
| `instances.<id>` | `{autostart, overrides}` — one console's start policy (`true`, `false` or `once`, [above](#whether-a-login-starts-it)) and its own values for the overridable fields |

Each field resolves in one order: a flag or environment variable wins (`--remote`, `PHASE_CONSOLE_NOTIFY`),
then this console's `overrides`, then the machine-wide value. Six fields can be overridden per console
(`OVERRIDABLE_PROFILE_KEYS`: `remoteHost`, `remoteUsers`, `notifyCommand`, `webhooks`, `categories`,
`quietHours`); `maxSessions` and `hookScript` are the machine's alone. `GET /api/fleet/profile` shows what
this console takes from the file with each field's source named, so an override is visible rather than a
surprise.



---

