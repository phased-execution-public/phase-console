## Console flags

All seven capability switches are off unless named. Flags are read once, at startup.

| Flag | Meaning |
|---|---|
| `--root <dir>` / `-r` | Open this repository immediately, skipping the picker. |
| `--allow-writes` | Scaffold plans and handoffs, record QA, take locks, close and reopen plans. Never commits, never pushes. |
| `--allow-run` | Enable the autopilot. Separate from writes on purpose. |
| `--no-converge` | Keep the convergence loop's automatic passes off — boot, a docs change, the sweep, the minute after a stop. *Recover & continue* still runs one pass when you press it. |
| `--allow-terminal` | Open a shell in the browser. No deny list, no approval hook: whoever is at the keyboard is the policy. |
| `--allow-agent` | Interactive `claude` sessions — including recovery and QA reviews — and the *New plan with AI* wizard. |
| `--allow-accounts` | Register Claude accounts and choose one per run. The usage meters need no flag. |
| `--allow-mcp` | Register MCP servers, hold their credentials, and attach them to plans and phases. *Reading* the registry, the statuses and the catalog needs no flag. |
| `--allow-webhooks` | POST every announcement this console makes to URLs you register — Slack, Discord, Telegram, your own relay. Off means no outbound request is made at all, whatever is registered. *Reading* the destination list needs no flag. The payload schema and the Slack/Discord/Telegram recipes are in [docs/webhooks.md](https://github.com/phased-execution-public/phase-console/blob/main/docs/webhooks.md) — a link rather than a path, because a packaged copy ships no `docs/` directory. |
| `--port <n>` / `-p` | Pin a port instead of deriving one from the repository path. Never probed past. |
| `--host <addr>` | The bind address. Defaults to `127.0.0.1` and there is no good reason to change it — see **Mobile setup**. |
| `--no-open` | Do not open a browser on start. `PHASE_CONSOLE_NO_OPEN=1` does the same. |
| `--remote <host>` | Also answer to this hostname, behind a proxy that authenticates callers. Turns on strict `Host` checking. |
| `--remote-user <login>` | A login allowed to arrive that way. **Required** by `--remote`. |
| `--max-sessions <n>` | Global ceiling on concurrent sessions. Default 3; a run may ask for fewer, never more. |
| `--default-skills <csv>` | Skills seeded into every new run. Repeatable and additive — unticking one in the console is still a real off. |
| `--scripts <dir>` | Use a different phased-execution checkout. |
| `--log-file <path>` / `--no-log-file` | Structured log destination. Defaults under `~/.local/state/phase-console/`. |

## Environment variables

| Variable | Does |
|---|---|
| `PHASE_CONSOLE_NOTIFY` | A command run as `cmd "<title>" "<body>"` for every announcement. Environment-only on purpose. |
| `PHASE_CONSOLE_URL` | Which console `btw` talks to. |
| `PHASE_CONSOLE_HOME` | Where the console's own install lives, for the CLI. |
| `PHASE_CONSOLE_REMOTE_USERS` | Comma-separated logins, the same as repeating `--remote-user`. |
| `PHASE_CONSOLE_MAX_SESSIONS` | The default for `--max-sessions`. |
| `PHASE_CONSOLE_DEFAULT_SKILLS` | The default for `--default-skills`. |
| `PHASE_CONSOLE_NO_OPEN` | `1` suppresses the browser launch. |
| `PHASE_CONSOLE_LOG` | The default log path; empty disables the file. |
| `PHASE_EXEC_GATES` | `1` lets `cmd` gate checks actually run a command. |

## Console verbs

| Verb | Does |
|---|---|
| `phase-console <repo>` | Run the console for that repository. A bare first argument is a **root**, not a verb. |
| `phase-console install-skill` | Put the skill files where Claude Code reads them. For a packaged copy — a plugin or a clone never needs it. `uninstall-skill` takes them out again. |
| `phase-console install-hooks` | Add the session-presence hook to `~/.claude/settings.json`, so the console knows which sessions are live. `uninstall-hooks` removes it; `hooks-status` says whether it is there. |
| `phase-console doctor [instance] [--json]` | Whether this machine is ready to run: the checks a run's start makes, with no plan — accounts, MCP servers, the `claude` login, a delivery channel, the presence hooks, the CLI version against the relay floor, `gh auth status`. Exit 1 names the first blocking row that fails. |
| `phase-console sessions ingest [instance]` | Apply the presence hook's queued drops while no console is running — the hook runs it itself when its POST finds nobody. It does nothing while the console answers, because that console drains its own inbox. |

`./start` is the clone's equivalent, and it takes a **repository, not a verb**: its first bare
argument becomes `--root`.

## Gate checks

Add `- **Gate-check:** <type> …` to a phase to say what holds it up — and **who can clear it**. An
`ai` gate is cleared by the booted session itself; a `manual` gate waits for a person; the rest clear
themselves.

| Syntax | Category | Clears when |
|---|---|---|
| `ai <check>` | ai | A booted session verifies the plan's Gates conditions, does the work to make them true, and records the clearance — or you approve it. Prefer this. |
| `manual <who>` | human | Never by itself. A person does the Gates bullet's numbered steps, then approves on the phase page's Gate card. |
| `phase 8` | auto | Phase 8 of this plan is done. |
| `phases 6,7,9` | auto | All of them are done. |
| `plan other-slug:6,8` | auto | Those phases in a different plan are done. |
| `date 2026-12-01` | auto | On or after that date. Range-checked, so a nonsense date fails closed. |
| `deadline 2026-12-01` (or `by …`) | auto | Only before that date — after it the gate reads OVERDUE. |
| `cmd <command>` | auto | The command exits 0. **The autopilot evaluates it (`PHASE_EXEC_GATES=1`); page views never execute it** — running a command written in a document is worth an explicit opt-in. |

**Approving** — the phase page's Gate card, or `scripts/gate-approve.sh <slug> <N> --by <who>` —
clears a gate of **any** kind: the row lands in `docs/handoffs/<slug>/gate-status.md`, and revoking
it restores the gate. A `*(GATED)*` heading with no Gate-check at all reads as an **ai** gate (the
default since 5.0.0) — and fails the plan's lint until the author says which it is.

## Review holds

A `requested-changes` verdict on a phase (**Plan → a phase → Read the diff**) stops this console
from boarding every phase that DIRECTLY depends on it. It behaves like an unapproved gate — the
phase record reads `gated`, the journal line is `phase.review-held` — and it is released by
approving or withdrawing the verdict.

| Where it lives | `runs/<instance>/<slug>/review/phase-NN.json` (never `docs/`) |
| --- | --- |
| Who honours it | this console only — `phase-graph.sh` cannot see it |
| Verdicts | `approved` · `requested-changes` · `commented` |
| Flag to record one | `--allow-writes` (reading the diff needs none) |
| Endpoint | `GET`/`POST /api/plans/<slug>/review/<phase>` |

## Review comments and Send back

Comments are anchored to `path` + `side` + `line` and stored alongside the verdict in the same
file (schema v2). **Send back** re-boards the phase with every unresolved comment quoted; the
prompt is composed on the server, never taken from the request body.

| Flag to comment | `--allow-writes` |
| --- | --- |
| Flag to send back | `--allow-run` — it starts a session that edits the repository |
| Endpoints | `POST /api/plans/<slug>/review-comment/<phase>` · `POST /api/plans/<slug>/review-send-back/<phase>` |
| Journal line | `phase.review-follow-up` |
| Boarding | rung `reboard-review-follow-up`, situation `review:follow-up` — the one hint that boards a phase the board reads `done` |

## Auto reviewer

Off by default. With **Review each phase** on, a fresh session reads each finished phase's diff
and records its findings as comments. It never resumes the phase's own session.

| Setting | `reviewEachPhase` (run) · `reviewEachPhaseByDefault` (preference) |
| --- | --- |
| What it may record | `reviewerPolicy`: `comment-only` (default — nothing is held) or `may-hold` |
| Tools it is given | `Read`, `Grep`, `Glob` — no `Bash`, no `Edit`, no `Write` |
| Cost | ¼ of the phase budget, charged to the phase and the run |
| Journal lines | `phase.review-session` · `phase.review-session-done` · `phase.review-session-skipped` · `phase.review-session-failed` |

## The ultra tiers

Two opt-ins the CLI can do and the console does not turn on for you. Both are off on every run, in
every profile, and neither is a stored preference: they spend, and a thing that spends is chosen in
front of somebody.

**Ultracode** is a word, not a flag. With it on, every prompt this run composes — the boot prompt
and all five briefs — carries a standing line saying the session may use the Workflow tool where
the work fans out. A workflow runs dozens of agents at once, so it is a token bill rather than a
speed setting. The bounded sessions beside a phase never get it: the auto reviewer, the QA verdict,
the closeout, the PR and merge-queue sessions are each asked for one artefact and given the budget
for one.

| Setting | `ultracode` — on the run, on one phase (`phaseOptions`), or on an agent ticket |
| --- | --- |
| Resolution | the phase's answer beats the run's, in both directions; silence at both is off |
| Where it lands | the phase prompt only — `ULTRACODE_LINE` in `server/skills.ts` |
| Cost | tokens, unbounded by anything this console meters |

**Cloud review** runs `claude ultrareview` — a multi-agent review in Anthropic's cloud, billed to
the account the run spends. Findings ride the same channel the auto reviewer's do: same file, same
banner, same `reviewerPolicy`. The runner spawns it, never a phase session, because it blocks for
up to half an hour.

| Setting | `ultraReview`: `off` (default) · `each-phase` · `at-settle` |
| --- | --- |
| Where it reads | the phase's own lane worktree, or the run's checkout before the branch settles |
| One click | `POST /api/run/<slug>/ultrareview` — the at-settle shape, on demand, at any time |
| If the CLI cannot do it | the run says so and carries on: `unknown` with a reason, never a verdict and never a park |
| Journal lines | `run.ultrareview` · `run.ultrareview-done` · `run.ultrareview-skipped` |

## Run timeline

**Plan → a run → Run timeline** draws the run on one absolute axis: a row per phase, bars
bracketed by two journal entries each. It answers a different question from the *Timeline* card
below it — that one splits each phase's own clock, this one says *when* each phase held the lane.

| Bar | What the lane was doing |
| --- | --- |
| `working` | a session was alive and spending |
| `verifying` | §Verification was running (`phase.awaiting-verification` → `phase.verify`) |
| `waiting` | parked on something outside the phase — a wait, an MCP preflight |
| `frozen` | stopped by the operator (a SIGSTOP: no spend, real wall-clock) |

A **hatched** bar is still open. Ticks along a lane mark `board`, `verify`, `rung`, `park`,
`wall`, `outcome`, `session` (a session ended — its mode, how it ended, what it cost), `ask` (a
question or a card was raised or answered) and `policy` (the console answered something by itself);
`start` ticks sit on the axis itself, one per start of the run, naming its door. The **critical path** highlighted here is the longest dependency chain
weighted by what each lane MEASURED — not the plan page's estimate, which answers what is left
rather than what happened.

A phase boarded twice offers **attempt comparison**: what changed between two boardings —
outcome, model, duration, spend, ladder rung, and every §Verification command whose result moved.
An attempt is one BOARDING, and its spend is summed from its own `phase.session` lines, so it is
never the phase's cumulative total. A figure that was never recorded reads *not recorded*, never
`$0.00`.

| Where it comes from | the run journal — nothing is read from the checkpoint |
| --- | --- |
| Endpoint | `GET /api/run/<slug>/timeline` · `GET /api/run/<slug>/attempts/<phase>` |
| Flag to see it | none — reading is always allowed |
| If the journal was truncated | the header says so, and the lanes it cut are marked partial |

## Landing packet

The console never pushes, so a finished plan hands you its work as files. **Route tab → Landing
packet**, or the API below.

| Thing | Value |
|---|---|
| Where it is written | `~/.local/state/phase-console/runs/<instance>/<slug>/landing/` |
| The manifest | `landing.json` — branch, range, commits, file list, apply commands |
| The history | `<slug>.bundle` — `git bundle`, fetchable |
| The readable copy | `patches/NNNN-….patch` — `git format-patch`, appliable with `git am` |
| The range | parent of the plan's oldest commit … `HEAD` |
| Reading it | `GET /api/plans/<slug>/landing` — no flag |
| Composing it | `POST /api/plans/<slug>/landing` — `--allow-writes` |
| Downloading one | `GET /api/plans/<slug>/landing/<name>` — only a name the manifest lists |

Composing replaces the previous packet. It carries commits, so anything uncommitted is not in it and
the card says how much.

## Where things live

| Path | What is in it |
|---|---|
| `docs/plans/` | The plans. Yours, in git. |
| `docs/handoffs/` | Per-phase handoffs and locks. Yours, in git. |
| `~/.local/state/phase-console/` | Run checkpoints, journals, the log. Never inside your repository, so `git status` stays clean. |
| `~/.config/phase-console/` | Preferences — notification categories, push devices — and your autopilot policy, plus `instances.json`, which records this console's root, port and name. |
| `~/.config/phase-console/fleet.json` | The machine profile a console inherits and may override: the remote host and logins, the notify command, webhooks, categories, quiet hours, the machine's lane ceiling. |
| `~/.local/state/phase-console/accounts/learned.json` | What the machine has learned about each Claude credential — its walls, the entitlement breaker, when its meters were last read, its organisation (hashed), and the tombstone of a removed registration. Every console on the machine reads the same file; the registrations themselves stay per console. |
| `~/.local/state/phase-console/cli-init.json` | The newest Claude CLI version a session on this console reported — what the relay's floor is judged against. |
| `~/.local/state/phase-console/relay/state.json` | The relay's memory across a restart: the questions each run has asked, and the answers kept for a session that resumes. |
| `.phase-console.json` | Optional, committed at a repository root: `{"name": …, "port": …}` names that project's console for everyone who clones it. |

## The engine, if you would rather drive it yourself

Everything the console shows comes from these scripts. It never recomputes status in the browser, so
what you see here and what you get in a terminal cannot disagree.

```bash
scripts/phase-graph.sh <slug>              # the board
scripts/validate.sh <slug>                 # lint the plan
scripts/phase-lock.sh <slug> status N      # who is working this phase
scripts/qa-record.sh <slug> N pass --report …   # record a QA result
```

The full set — boot prompts, session batching, gate status, handoff scaffolding — is in
`docs/controls.md`.

## Keyboard

Three keys, not eight. The 2.x list was seven single-letter jumps you had to memorise from a card you
had to remember to visit. The palette replaced all of them with one chord that shows you its own
contents — every destination, every plan, every run, every verb — and prints the chord on itself, in
the header, on every page.

| Key | Does |
|---|---|
| `⌘ K` | The command palette — search and every verb |
| `/` | The same, without a modifier |
| `Esc` | Close a dialog, a sheet or the palette |

Everything the old letters reached is in the palette by name: type `ready` for what is next up,
`stats` or `insights` for the numbers, `guide` for this page.

## The eight states

Every badge in the console is one of eight **UI states**, each with its own colour, icon and plain
word — and colour is never the only carrier: the word and the icon are always there. Amber is one
state's alone: **Needs you**. The underlying vocabularies (a run's status, a phase record, the board,
a situation) each map onto these eight; the tables further down list every word under the state it
reads as.

| State | Badge | What it means | Underlying words |
|---|---|---|---|
| `needs-you` | **Needs you** | Stopped until a person does something — an approval, a gate, a sign-in, a decision, an errand. The only amber. | run `halting` `halted` `parked` `interrupted` · phase `gated` `parked` `awaiting-verification` `interrupted` · board `gated` `blocked` `stuck` · a situation for a person, or any with an errand |
| `failed` | **Failed** | The attempt failed — a red verification, or a session that produced nothing the board accepts. | phase `failed` · QA `fail` |
| `running` | **Running** | A session is working right now. The only state that may pulse. | run `running` · phase `running` · board `in-progress` · a machine's situation |
| `verifying` | **Verifying** | The session finished; the console is running the plan's §Verification itself. Running's family, drawn dashed on a map or strip. | phase `verifying` |
| `waiting` | **Waiting** | Asleep on something that settles by itself — a dependency, a usage window, an external clock, a pause you asked for. | run `waiting` `paused` `pausing` `frozen` `stopping` · phase `waiting` · board `waiting` · a situation that waits on time or someone else |
| `queued` | **Queued** | In line — next up, or behind something holding the same repos. A board phase that is `ready` reads **Next up**. | run `queued` · phase `queued` `pending` · board `ready` · QA `pending` |
| `skipped` | **Skipped** | Taken off this run's list by the operator. Not finished, not failed. | phase `skipped` · QA `waived` |
| `done` | **Done** | Finished and recorded on the board. | run `finished` · phase `done` · board `done` · QA `pass` · a situation the board already settled |

A thing several vocabularies describe at once reads as the **worst** of them, in the order above —
except that the board saying `done` wins over everything: a run record the board has overtaken is
history, not a state.

## The vocabularies underneath

They coexist on purpose, and they nest. A **plan** has a status (is anyone still pursuing this at
all). A **run** has a status (what the autopilot is doing with it right now). Each **phase in that
run** has a record (what happened to it here). The **board** states what is true of a phase on disk.
And a **claim** says whether somebody is already working it.

Every badge in the app says this on hover; the tables below are the same text in one place, and the
badge each word wears is its UI state's.

## Plan status

The only one that is *stored* rather than computed — "does anyone still care?" cannot be read off the
files. The last three are **terminal**, which is what the app calls **closed**.

| Word | What it means | What to do |
|---|---|---|
| `active` | Live work. The plan asks for attention: ready phases, boot prompts, warnings, notifications. | Whatever the board says is boarding. |
| `approved` | Signed off, not started. | Start it when a lane frees. |
| `proposal` | Drafted, not signed off. | Get a decision on it. |
| `backlog` | Parked deliberately, with intent to return. | Nothing yet — it is waiting on purpose. |
| `complete` | Every phase landed and the work is finished. | Nothing — it has stopped asking. |
| `abandoned` | Dropped. It will not be finished, and that is a decision, not a failure. | Nothing. Reopen if it comes back. |
| `superseded` | Replaced by a different plan. The reason names the replacement. | Follow the plan that replaced it. |

A closed plan **goes quiet without going away**: no ready phases, no boot prompts, no notifications,
and it leaves every portfolio total. Its board still renders, search still finds it, and real
structural damage is still reported. Close or reopen from **⋯ ▸ Close plan** — reopening is always
available, so closing is a cheap, reversible call.

## Run status

| Word | Reads as | What it means | What to do |
|---|---|---|---|
| `running` | Running | The autopilot is driving: sessions spawn, verify and hand off by themselves. | Nothing — watch the phase tabs. Pause, Freeze and Stop all apply. |
| `pausing` | Waiting | A pause is armed: whatever is running finishes, and nothing new boards. | Wait for the boundary, or Cancel pause to keep going. |
| `paused` | Waiting | Stopped between phases at your request; nothing is running. | Press Continue when ready — it picks up exactly where it left off. |
| `waiting` | Waiting | Asleep on a clock: an account's usage window reopening, an external wait a session declared, or — while a verification or permission card stands — a person, with the run's clock at the soonest card's expiry. A card that runs out its clock unanswered parks its phase as `awaiting-person`. | Nothing, unless it is waiting on you: then answer the card. |
| `frozen` | Waiting | Every session is stopped where it stands (mid-token), warm and losing nothing. A freeze on ONE session of several is recorded on that session's tab instead, and the run stays `running`. | Continue the frozen session to resume instantly, or Stop it. |
| `parked` | Needs you | Every remaining phase needs a person first — a gate, an approval, a decision. | Read "Why this is stopped": each blocker is named with its remedy. |
| `queued` | Queued | In line behind another plan holding the same repos; starts itself when the scope frees. | Nothing — the holder is named on the queued chip. |
| `halting` | Needs you | A halt was recorded; live sessions are finishing before the run fully stops. | Read the halt card. The run reads halted once the last session settles. |
| `halted` | Needs you | Stopped on something that must not be automated past — usually a red verification. | 'Finish in its own session' or 'Fix with a new agent' on the halt card, or fix the cause yourself and Retry the phase. |
| `stopping` | Waiting | A stop was requested; sessions are being wound down. | Wait a moment. |
| `finished` | Done | Nothing left to run on this plan. | Nothing. |
| `interrupted` | Needs you | Nothing is driving it and nothing recorded why — a console or session died mid-flight. | Resume with AI, or press Continue — work already on disk is kept. |

## Phase record

The "This run" column: what happened to a phase *in this run*, as opposed to what is true of it on
disk.

| Word | Reads as | What it means | What to do |
|---|---|---|---|
| `pending` | Queued | This run has not started the phase yet. | Nothing — the loop reaches it when its dependencies are done. |
| `gated` | Needs you | Held at the plan's gate — a human or automatic condition the run cannot clear itself (ai gates never park: their session is booted to clear them). | Do the gate's steps and Approve on the phase page's Gate card (it can continue the run in the same action), or Retry to re-check. |
| `running` | Running | A session is working this phase right now. | Watch its tab; Ask reaches the session mid-flight. |
| `verifying` | Verifying | The session finished; the console runs the plan's verification commands itself. | Nothing — green marks it done, red halts with the evidence. |
| `awaiting-verification` | Needs you | The machine checks passed; steps only a person can confirm remain. | Answer the verification card — it lists exactly what needs your eyes. |
| `done` | Done | Finished and independently verified in this run. | Nothing. |
| `failed` | Failed | The attempt failed — a red verification, or a session that produced nothing. | Why? shows the evidence; 'Fix with a new agent' repairs it, or Retry restarts the run here. |
| `interrupted` | Needs you | The session or console died mid-phase — or the operator stopped this one session from its tab; the working tree is wherever it stopped. | Resume with AI or Retry — the session id is kept, and uncommitted work is preserved, never redone blindly. |
| `skipped` | Skipped | Taken off this run's list by the operator. | Retry it later if it should still happen. |
| `parked` | Needs you | Needs a person before the loop will touch it again — the note says exactly why. | Read the note (gate, foreign lock, decision), act on it, then Retry. |
| `waiting` | Waiting | Parked on an external clock the session declared — a CI build, a PR auto-merge, a deploy window. | Nothing — the runner resumes the phase's own session when the window elapses. |
| `queued` | Queued | Waiting for repos another phase or plan is holding; starts itself when they free. | Nothing — the queued chip names what it waits on. |

A `failed` record under a phase the **board** calls done means: this run's attempt stopped, and the
work was finished and verified outside it. The row says "nothing to fix — done elsewhere".

## Why a phase or a run stopped

A halt carries a **kind**, and the kind says what it is about. A phase-level kind settles that one
phase, and the phases already queued or in flight keep their places. A run-level kind stops the run.

| Kind | Level | What happened |
|---|---|---|
| `verify-failed` | phase | §Verification ran and came back red. |
| `no-handoff` | phase | The session ended without writing its handoff. |
| `phase-blocked` | phase | The session declared itself blocked. |
| `waiting-external-timeout` | phase | A declared external wait was not resumed. |
| `needs-human` | phase | An errand only a person can settle. |
| `awaiting-person` | phase | A person was asked — a verification or permission card — and its clock ran out unanswered. |
| `phase-crashed` | phase | The phase failed inside the runner. |
| `verification-preflight` | phase | The phase's §Verification gave the runner nothing it could run. |
| `mcp-preflight` | phase | An MCP server the phase requires would not connect. |
| `recovery-failed` | phase | A recovery crashed, or said why it could not finish. |
| `orphaned-session` | phase | A live session from an earlier console was found still working. |
| `worktree-merge` | phase | A lane's commits would not merge into the run branch; every commit survives on its lane branch. |
| `budget` | run | The run's budget is spent. |
| `plan-unreadable` · `plan-lint` | run | The plan could not be read, or stopped linting. |
| `failure-streak` | run | Too many phases failed in a row. Only a person's press relaunches it. |
| `models-exhausted` | run | Every model is exhausted or at capacity. |
| `run-preflight` | run | The start was refused: the auth or configuration preflight failed. |
| `runner-crashed` | run | The drive loop itself threw. |
| `plan-deadlocked` | run | A QA verdict holds every phase that is left; nothing is ready and nothing is in flight. |
| `nothing-ready` | run | Phases remain, each behind a gate, an errand, a Retry or another plan's lock. |
| `interrupted-by-restart` | run | The run was found in flight with no live session after the console driving it went away. |
| `operator-stop` | run | Stop was pressed on a run this console was not driving. |
| `credential-refused` | run | The API refused the credential the run spends, and the account is retired for its organisation. Only a person's press relaunches it. |

## Board state

The "Status" column — what is true of a phase on disk, as `phase-graph.sh` computes it. The badge
shows the UI state's word (`ready` reads **Next up**).

| State | Reads as | What it means | What to do |
|---|---|---|---|
| `done` | Done | The handoff is complete; the work is finished and verified. | Nothing. |
| `ready` | Next up | Every dependency is met; this phase can start now. | Start it (or the autopilot will), or copy its boot prompt from the phase page. |
| `in-progress` | Running | A session is on this phase right now. | Watch its lane. The board catches up when the handoff lands. |
| `waiting` | Waiting | An earlier phase it depends on is not done yet. | Nothing here; finish what it waits on. |
| `stuck` / `blocked` | Needs you | Its handoff is marked blocked — the Outstanding section says exactly why. | Read the excerpt on the phase page, or use Ways forward on the run page. |
| `gated` | Needs you | The plan gates this phase — on a person (`manual`), a session's own check (`ai`), or an automatic condition. | The phase page's Gate card shows the steps and the Approve button; ai gates clear themselves when their session boots. |

## The claim

A claim is one session saying "I am working this phase". It lives in a file —
`docs/handoffs/<slug>/.locks/phase-NN.lock` — written by `phase-lock.sh claim`, and carries a
**lease** (2 hours by default; a console-driven session claims 90 minutes) that the holder renews while it works. Every phase table shows it,
because it is the one fact that decides whether the buttons beside it do anything.

| State | Chip | What it means | What to do |
|---|---|---|---|
| `live` | **held by …** | Another session claimed this phase and its lease has not run out. Starting a second session here is refused — by this console and by the server. | Let it finish. If that session is gone, use **Release the claim** on the phase's row and confirm. |
| `stale` | **stale claim** | The lease lapsed: whoever took it stopped renewing, so nothing is working this phase. | Nothing, unless you want a tidy board — it does **not** block a run. **Release it** clears the file. |

A lapsed claim blocking work is the failure this distinction exists to prevent: a session that dies
without releasing would otherwise hold its phase for the full lease and then keep holding it, because
nothing renews a dead claim.
