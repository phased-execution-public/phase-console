## Start a run 🟡

Open the plan, go to **Autopilot**, and start. A fresh plan and a half-finished one use the same
button — readiness is derived from what is already done, so there is nothing to resume and nothing to
reset.

The run needs `--allow-run`. Without it the Autopilot tab still shows you everything; it just cannot
start anything.

### The five stages 🟡

A run-shaped launch opens as a **staged overlay**, not one long form:

| Stage | What it settles |
|---|---|
| **Decisions** | Every decision this run could ask for, answered before it starts: the manifest, what the probes found, and what the start requires. |
| **What runs** | The plan, the phases ready now, the sessions they batch into, and where the run picks up. |
| **How it runs** | The model, the guard rails, the branch it works on, and what every session is given. |
| **Money and stops** | What it may spend, and every condition that stops it. |
| **Review** | Every choice this run makes, where each came from, and what boarding will find. |

On a desk it is two panes — the stages on the left, a live **ticket** on the right saying what will
happen — and they merge on the Review stage. On a phone it is a full-screen sheet where only the stage
scrolls. The stepper carries a per-stage *"2 changed"* note, and the Review stage lists every
non-default choice **with its provenance** and a Change link back to the stage that owns it.

**Decisions comes first, and a launch with anything to ask opens on it.** It shows the plan's
`## Decisions` manifest as the console resolves it for this draft — every row with its state and where
its answer came from — and the five probes a start runs before anything spawns (accounts, MCP servers,
credentials, delivery, verification commands) with what each found; a §Verification command the run would
stop on is approved here by its exact text, or waived for the run. Then it asks what the start requires: whether the run
continues by itself after a console restart, whether the **relay** is armed (*last resort*: a person is
asked first, and after 60 s the console answers by rule — see **Permissions**), which accounts the run
may spend and the headroom each must show, and an acknowledgement of every waived row. The answers are
judged by the server (`GET /api/run/<slug>/prelude`), so the stage shows what the start will decide.
While a blocking row is outstanding, Launch stays disabled and names it —
`Decision outstanding: <key> — <why>` — and the one way past is **Start anyway, recorded as**, which
writes who signed the override on the run (`run.manifest-override`).

The one amber **Launch** button sits on every stage on a desk — the ticket has already said what will
happen — and on the **Review stage only** on a phone.

## What you choose at launch 🟡

**One form, one vocabulary, one component — and each surface shows the subset its act needs**, with the
button naming the act (*Start*, *Continue*, *Run phase N*, *Start review*, *Fix & re-QA phase N*, *Apply
from next phase*). A recovery ticket offers five fields; a full run offers about thirty. Four surfaces
used to each decide privately which choices to offer, which is the failure this replaced.

Staged: *Start*, *Continue*, *Run only this phase*, *live edits*, *Fix & re-QA*. Flat: a review, a
recovery ticket, a session, a plan, the defaults editor — and a form rendered *inline* on a page is
always flat whatever its mode.

| Choice | What it decides |
|---|---|
| **Model** and **Effort** | Resolved field by field: your choice for this run, then the plan's own `**Model:**` / `**Effort:**` bullets, then the run's defaults. Choosing a model does not throw away an effort the plan asked for. Overridable per phase under *Per phase*. |
| **Account** | Which registered Claude account the sessions run as. Needs `--allow-accounts`. |
| **On usage limit** | `switch` to an account with headroom, `wait` for the window to reopen, or `pause`. Applied to the live session as the wall happens — a rate-limited session usually never exits, it just retries — as well as when one ends on a limit. A limit on one *model* switches model, not account. |
| **Permission profile** | How much the CLI asks. See **Permissions**. |
| **Skills** | Every skill a session could invoke — yours, this repository's, every installed plugin's. Ticked ones are named in each phase's boot prompt, on top of the plan's own `Skills (every session)` line. |
| **Attach default skills** | Whether this machine's `--default-skills` list rides along. Off unless you turn it on. |
| **QA gate** | Activates the plan's QA gating at start. |
| **Branch** | Puts the whole run on one work branch, `pe/<slug>`, instead of whatever is checked out. |
| **Open a PR** | With **Branch** on, the plan's last phase pushes and opens the PR after one approval tap. |
| **Ultracode** | Lets a session use the Workflow tool where the work fans out — dozens of agents at once, so a token bill rather than a speed setting. Off unless you turn it on, and overridable per phase in either direction. |
| **Cloud review** | Runs `claude ultrareview` after every phase, or once before the branch settles. Billed to the account this run spends; its findings land beside the reviewer's, under the same hold rule. Never, unless you pick a moment. |
| **Budgets** | Per phase and per run, in dollars. A phase that hits its cap resumes the *same* session with a larger one rather than starting over, so work already done is kept. |
| **Give this run its own checkout** | Isolation. Lanes get a `git worktree` of the run branch instead of sharing yours; on a superproject the run takes a mirror of the scoped sub-repositories. A drop lands mid-run, a raise does not. |
| **When the plan completes** | The settle: keep the branches, merge them, open a PR. The one-tree settles refuse a multi-repo run by name. |
| **Review each phase** / **…and let it hold dependent phases** | Puts a fresh reviewer over each phase's diff at finish. Its `requested-changes` holds dependents exactly as a person's would. |
| **Stop after N failed QA rounds**, **QA model**, **QA effort**, **Budget per QA round**, **How the fix session starts** | The Fix & re-QA loop's own settings, separate from the run's. |
| **MCP servers** / **If an MCP server will not connect** | Which servers each phase runs with, and whether an unreachable one parks the phase or is merely reported. The plan's own line outranks the run's. |
| **Max parallel**, **Stop after N failures**, **Queue priority**, **Start after**, **Only these phases**, **Per-phase overrides** | How much runs at once, what stops it, when it begins, and what it is allowed to touch. |
| **Auto-recover halts** | Whether the ladder climbs by itself when a phase stops. |

Settings ▸ Automation holds the defaults these forms open with; each launch can override them for
itself.

## Autonomy — keep going, or stop and ask 🟡

- **Keep going where it safely can** — after a failure it moves to the next ready phase instead of
  stopping. It still halts on two consecutive failures, an exhausted budget, or anything needing a
  person.
- **Stop and ask me** — halts on anything ambiguous: a failed phase, a verification it could not
  fully check, a gate.

## One phase, one process 🟢

Clearing the context between phases needs no mechanism: the process exits and the context goes with
it.

1. **Gate** — if the phase declares one and it is not clear, the phase parks and the runner tries
   another ready phase.
2. **Lock** — the runner checks who holds the phase. It does not take the lock; the session doing the
   work does.
3. **Prompt** — the boot prompt comes from the engine, unaltered.
4. **Session** — one `claude -p` process, streamed to the Autopilot tab as it works.
5. **Verify** — the runner runs the plan's own verification commands itself.
6. **Lint** — `validate.sh` must still pass.
7. **Confirm** — the board is re-read from disk and must say `done`.

> The last three are the point. A session that exits cleanly claiming success while writing nothing
> halts the run, because nothing here takes the session's word for it.

## Watching it 🟢

The session console shows text as it is written, the tool calls it makes, and the work of any
subagent it dispatches — without that last one, a phase that delegates is a silent gap of several
minutes.

**Detail** adds the model's own reasoning and every hook call: worth having when something is wrong,
noise when it is not.

## Asking it something mid-flight 🟡

The box under the console puts a question to the session running *now*. It becomes one more turn in
the same conversation — the context is intact and the phase carries on afterwards — rather than a
reason to stop it. It is framed as out-of-band before it is sent, so an answer does not turn into a
change of direction.

The same question works from any terminal with `btw "…"`.

## Pause, freeze, stop 🟡

Three different things, and the difference matters when a phase is halfway through something. The
run-level verbs act on **every** session at once:

| Verb | What happens | Getting going again |
|---|---|---|
| **Pause after this phase** | Arms a pause and names the phase that has to finish first. Nothing is cut off. | Cancel it until it arrives, or press Continue after. |
| **Freeze now** | Stops every running session where it stands, mid-token, warm and losing nothing. | Continue the frozen session and each one resumes instantly. |
| **Stop now** | Interrupts everything. Records cut-off phases as `interrupted`, not `failed`, because a phase cut off partway may have half-finished something. | Retry the phase, or read what it left behind first. |

Each session tab also carries the same verbs **scoped to that one session** — and so does each lane
on the Runs page and the session console's own toolbar:

| Verb | What happens |
|---|---|
| **Freeze** (one tab) | `SIGSTOP` for that session alone. The others keep working; the run only reads `frozen` when nothing is left running. |
| **Stop** (one tab) | Ends that session politely — woken first, then asked to close its turn (SIGINT to the CLI itself, with five seconds to leave), then SIGTERM to its process group and the SIGKILL backstop — so the CLI still books the turns and dollars it spent. Records its phase `interrupted` with the session id kept — Retry can resume it — and the run carries on scheduling. On a queued phase it takes it out of the admission line before anything spawns. |

Neither touches the consecutive-failure budget: an operator's stop is neither a failure nor an
endorsement.

## Reviewing what it changed 🟢

Open a phase (**Plan → Phases → a phase**) and press **Read the diff**. The card shows the files
that phase changed, hunk by hunk, plus the commits in the window. Nothing is fetched until you
press it — the read behind it is three `git` invocations, so a page that did it for every phase
would be a page nobody could open.

**The window is a heuristic, and the card says so.** A phase does not record which commits it made.
What it certainly writes is its handoff, so the diff is bracketed from the plan's *previous*
handoff landing to *this* phase's newest one — which on a plan whose phases land in order is
exactly its own work, code commits included, even though most of them never went near `docs/`. A
phase that committed after writing its handoff, two plans landing into one branch, or a rebase will
move that bracket. The base and the tip are printed; a `?base=&tip=` on the request overrides them.
A phase with no handoff yet shows the working tree instead.

With `--allow-writes` you can record a verdict: **Approve**, **Request changes**, or **Comment
only** — with a note. Reading needs no flag; recording one does, because:

**Requesting changes holds every phase that depends on this one.** The autopilot refuses to board
them, exactly as it refuses a phase whose gate is not clear, and the run's journal records
`phase.review-held`. Approving or withdrawing the verdict releases them at once.

**The hold is this console's, not the engine's.** `scripts/phase-graph.sh` knows nothing about
reviews: the board still reads the phase `ready`, a session booted from a terminal will not see the
hold, and another machine's console has its own verdicts. The verdict lives beside the run
(`runs/<instance>/<slug>/review/phase-NN.json`), never in `docs/` — a local opinion does not belong
in every clone, and the file that DOES gate through git (`test-status.md`) turns QA on for a whole
plan by merely existing.

If the phase lands another commit after a verdict, the card says the verdict was given on an older
tip rather than quietly re-using it. It does not expire the verdict; deciding what that is worth is
yours.

### Comments, and sending a phase back 🟢

A verdict that holds dependents is only half a loop — the thing that has to change is the phase.
With `--allow-writes`, press **+** on any diff line to leave a comment anchored to that file and
line; comments are listed under the diff, and **Mark answered** keeps one on the record without
re-asking for it. The anchor is `path` + `side` + `line`, never a hunk index: a hunk index is a
position in a rendering, so re-running the diff against a moved tip would silently point comment 3
at different code.

With `--allow-run`, **Send back** re-boards the phase with every *unresolved* comment quoted, each
with its anchor and the line it was written about. It is a Retry that carries words: nothing the
phase already landed is reverted, the plan is not edited, and the follow-up prompt is composed on
the server from the stored comments — a browser names which phase to send back, never what the
session is told. The session is asked to address each comment, to say by id where it disagrees and
why, and then to finish the phase the normal way. The journal records `phase.review-follow-up`.

Sending back needs `--allow-run` rather than `--allow-writes` because it starts a session that
edits the repository: reading a diff, recording a verdict, and putting a phase back to work are
three different permissions.

One consequence worth knowing: the engine's board still reads the phase `done`, because the handoff
it wrote before the review is still on disk. The runner boards it anyway — a follow-up is the one
boarding that deliberately targets a phase the board calls finished. If the run has already
stopped, the phase is queued instead, and continuing the run boards it.

### Reviewing every phase automatically 🟢

**Review each phase** (in the run setup, off by default) launches a fresh session at each
phase-finish that reads the diff against the plan's exit criteria and records what it finds. It is
never the phase's own session — a review inherited from the author is the author agreeing with
themselves — and it gets `Read`, `Grep` and `Glob` and nothing else, so it cannot edit or commit
the code it is reading. Its findings land as ordinary comments, marked `auto-reviewer`, so **Send
back** composes one follow-up over yours and its together.

It costs about a quarter of a phase budget per phase, and that money lands on the phase's own total
and the run's — it is in the cost panels, not beside them.

By default the reviewer **cannot hold work**: a `requested-changes` it asks for is recorded as
`commented`, findings and all. Turn on **…and let it hold dependent phases** to let it park the
phases behind the one it read. Use that deliberately — an unattended run whose reviewer is strict
enough will stop itself. A reviewer that answers in no readable format is recorded as having
produced nothing, never as an approval.

## Where the time went 🟢

Two charts sit under the console, and they answer two different questions. The **Timeline** card
splits each phase's own clock into working, waiting and frozen — a run that is mostly amber was
blocked, not slow. The **Run timeline** above it puts every phase on one absolute axis, so you can
line a bar up against the thing you were watching elsewhere: a CI run, a deploy, a wall.

Read it for the shape. A row per phase; each bar bracketed by two journal entries, so nothing on
it is modelled. A **hatched** bar has not finished — "worked for forty minutes" and "has been
working for forty minutes" look different on purpose. The highlighted chain is the **critical
path** by measured time: the phases that actually made the run as long as it was, which is often
not the ones that felt slow. If the journal was long enough to be read as a tail, the header says
so and the affected lanes are marked partial, because a confident wrong picture is worse than an
admitted gap.

A phase boarded more than once shows `p<N> ×2` — press it. The **attempt comparison** answers the
question a four-boarding phase always raises: what was different about the one that worked. It
names the outcome, the model, the duration, the spend, any ladder rung climbed, and every
§Verification command whose result moved — matched by command name, so a §Verification you
repaired between attempts shows the command appearing rather than two unrelated commands
"flipping". A number that was never recorded says *not recorded*; it is never rounded to `$0.00`.

## Why it started, and what it cost 🟢

Two cards on the run page answer what a run nobody remembers pressing raises.

**Why this run started** lists every start of the run, not only the first: which door started it,
what fired that door — a timer, a boot, an event — which guard let it through and which start of that
door it was, and who asked from where. The words are the journal's own `run.start` lines. Beside them
is the start door's report: the decisions it resolved and where each answer came from, what its
probes found, and the override a person signed, if one did.

**What it cost and how long it ran** is one row per session, read from its `phase.session` line: the
mode, how it ended and whether the console ended it, its turns, what it said it cost, how long it ran,
and the two caps it ran under with where each came from. A session that never reported a cost reads
*unknown*, never `$0.00`. Under the table the sessions' own figures are reconciled against the run's
spend — when they disagree, the gap is shown as a finding rather than averaged away — and below that,
what each ladder rung settled with: its situation, its cost and who drives that rung. A rung's cost is
its session's, already in the table, so it is shown beside the total and never added to it.

A session the console started for a run — a repair, a QA round, a ladder rung — shows the same door
and ending on its own page, read from the same journal, so the two pages cannot disagree about why it
exists.

## When the plan runs out 🟢

The run reaches the end of its graph and finishes itself: the last handoff is written, the plan is
annotated, and — if **Open a PR** was on — the work branch is pushed and a pull request opened after
one approval tap. On the way there, the board is re-read after every phase, so newly unlocked work
starts itself; the **Waiting** tab lists the phases whose turn has not come, with exactly what each
waits on. Pressing Start or Continue restores the consecutive-failure budget — a resumed run never
inherits a spent one.

Nothing is deleted. A finished run keeps its journal, its transcripts and its per-phase costs, which
is what lets **Insights** say where the time went. It is a destination rather than a plan tab — the
analysis numbers answer better estate-wide than on one plan — so open it scoped to this plan at
`#/insights?plan=<slug>`, which is exactly where the old `…/analysis` address now redirects.

## Landing what it built 🟢

The console does not push. Every write it makes lands on this machine, and the one act it will not
do on your behalf is publish — so the last thing a finished plan gives you is not a green tick, it
is the work in a form you can carry somewhere else.

The **Landing packet** card on a plan's Route tab answers two questions. First, without composing
anything: which branch the work is on, how many commits that is, and whether the branch exists
anywhere but here — an unpushed branch says so plainly, because "it is only on this laptop" is the
fact worth knowing before you close the lid.

Then **Compose landing packet** writes two files beside the run's own state:

| File | What it is |
|---|---|
| `<slug>.bundle` | A `git bundle` of the whole range — the exact history, one file, fetchable with `git fetch`. |
| `patches/NNNN-….patch` | The same commits as a `git format-patch` series: readable, editable, appliable one at a time with `git am`. |
| `landing.json` | The manifest — the branch, the range, the commit list, the file list and the commands to apply it. |

Both are produced by git verbs that write a file and touch no ref, no index and no remote. Download
either from the card; the commands to land them are printed there with a Copy button, and the last
line of them is the one this console will not run for you.

The range is bracketed from the commit **before** the plan first touched the repository — the parent
of the oldest commit that touched its plan file or its handoffs — up to `HEAD`. That is wider than a
phase review's window on purpose: a review asks what one phase changed, a landing asks what is on
this branch.

Two things the card will tell you rather than hide. A packet composed while the working tree is
dirty does not carry the uncommitted files, because a bundle carries commits — the note says how
many. And composing again **replaces** the packet: a stale `0001-` from an older compose is a
different commit from the new one, so the directory is emptied of the old series first.
