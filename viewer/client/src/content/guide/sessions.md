## One list, four kinds

**Sessions** shows every process this console owns or can see, in one place:

- **Autopilot lanes** — the phases a run is driving. The row opens the plan's **Run** view, where the
  lane's console is a pane of **Sessions and their consoles**, with its ask box; while a permission
  waits, the open row also offers **Answer on Your turn**.
- **Agent sessions** — interactive Claude sessions you opened here.
- **Shells** — a plain shell on this machine, from a laptop or a phone.
- **Other sessions on this machine** — Claude sessions the presence hook reported: your own CLI,
  another console's lane. The row exists because *that* is what a scope conflict is. A row tied to a
  phase of a plan opens that phase; any other opens a page of its own, from which the conversation can
  be **resumed** in a terminal here.

Search the list, narrow it with **Filter** by kind, **Group** it by kind or not at all, **Sort** it by
activity, start or kind, and **Everything** adds every column. **Locks**, beside **Sessions** at the top,
is every phase claim and who holds it, at `#/sessions/locks`.

Above the list a strip counts the machine at a glance: the live lanes, the shells, the agents, the other
sessions, how many wait on you, and how many accounts the live sessions spend. The list's columns are
**Status**, **Session**, **Working on** (a lane, a shell, an agent, a QA review, a recovery or a foreign
session), **Account**, **Model and effort**, **Progress**, **Spend**, **Context**, **Elapsed** and **Last
heard**; **Everything** adds **Kind**, **Note**, **Began**, **Attempts**, **Turns**, **Worktree**,
**Terminal**, **Conversation** and **Doing**. **Inspect** says **What it runs on**: the model and effort the
session itself reported, over what it was asked for.

**Locks** has a **Map** too (`#/sessions/locks?view=map`): which plan holds which repository right now,
and for how long. Each repository is a lane, and each claim a bar from when it was taken to the end of its
lease, painted as held, holding others up, or lapsed (hatched: still on disk, holding for no reason). A
claim that names no repository is drawn on every lane, because it collides with everything. A ◌ at a
claim's end is a phase waiting on it. A bar opens the claim in the panel, with the same **Release** the
table offers.

Only the middle two are processes this console holds a terminal for, so only those offer **Freeze** and
**Stop**, and, in an open session's panel, **Close**. A
foreign row's own address is `#/sessions/<conversation id>`, which resolves to the pty once one is
running that conversation — so the link keeps working after you open it, and after a restart.

Nothing here attaches to a session someone else is typing in: there is no multiplexer, and a
terminal belongs to the tty that started it. Resuming starts a *second* `claude` on the same
conversation, in the directory that session was working in. So the page offers **Resume** on a
session that has ended, and **Take over** — behind a confirm that says what a second process means —
on one that is still running (or that the hook cannot vouch for). It needs `--allow-agent`, like
every other Claude session this console starts; reading the list needs no flag.

A session record is written by the presence hook, which is a shell script and therefore carries no
console credential — so the directory on a record is not a fact this console can vouch for, and it
is where the resume starts. A directory outside the open root and the recent ones takes the confirm
whatever the session's presence, and the confirm names the path.

`#/agent/<id>` and `#/terminal/<id>` still work — they were two pages until 3.0 and both are in
bookmarks. Each keeps its session id through the redirect; with no id, `#/agent` opens **New session**,
the form that starts one, and `#/terminal` opens **New shell**, because that is what each address meant.

## A session is a process, not a tab

An agent session and a shell are both processes on the machine running this console. Closing the tab
detaches the socket; the process keeps working. Reopening reattaches to it, scrollback and all.

- **Nothing is reaped for being idle.** A session you started an hour ago and have not looked at
  since is still there. Idleness is not evidence of anything — the point of an agent session is that
  it works while you do something else.
- **A session ends when you end it.** Nothing else stops one — not the console going down, either.
  The ptys belong to a small detached broker rather than to the web server, so restarting the
  console, or shutting it down on purpose, leaves every shell and every interactive `claude`
  running with its scrollback. A fresh console adopts them and the address that named one still
  names it; the restart and shutdown dialogs list what keeps running. The broker retires by itself
  once its last session ends.

The cap of **8** counts live processes only, so records of finished work never crowd out a new
session.

## On a phone

Sessions works under a thumb. An open session keeps one line above its terminal: **‹** back to every
session, its status and name, **Switch** (**Open another**, **New session**, **New shell**, **Every
session**) and **Details**, which raises the panel from the bottom with its vitals, its facts and its
controls; the line steps aside while the keyboard is up. Under the terminal sits a fixed key bar with the
keys a phone keyboard lacks; a Claude session gets a composer, *Message the session*, with **Send**; the
pty is born at the size of your screen, with an `A−`/`A+` font stepper; and reconnects happen by
themselves. **Mobile setup ▸ Driving a session from the phone** walks through it.

## Ended is not gone

A session that exits stays in the list with its exit status until you dismiss it, and for an agent
session that record carries the `claude --resume <id>` that picks the work up again. That handle is
why the record outlives the process: discarding it discards the only way back into the conversation.
Records are dropped 24 hours after death, or when you dismiss them.

Opening `#/sessions/<id>` for a session that has already exited shows its scrollback under one line that
says how it ended — *This session exited cleanly 2 minutes ago.* — with **Resume here**, **Copy resume
command** and **Dismiss**, rather than an empty terminal pretending to connect. A record already retired
says so.

## Where they all are

**Sessions** is the list; the **Running** group on **Runs** is the same lanes ranked by what needs you,
and the badge on the rail's **Sessions** counts this console's live shells and agent sessions — so a
session started from one plan's page is not lost to another.

The **A session ended** notification category covers the case you cannot see: a session that
finished, detached, while you were elsewhere. Closing one yourself is never announced.

## The console can start the session that unsticks it

Every halt card and errand a Claude session could act on carries a button that opens one. The prompt
is not a text box you fill in: **the server composes it**, reading the board, the run, the phase
diagnosis, the lock and the health issues itself. The browser names only the target.

**Two ways to hand a stuck phase to AI, and every card now says which is which.** *Finish in its own
session* resumes the phase's OWN session through the runner (`claude -p --resume`) — its context is
intact and the run's settings, deny rules and hooks all apply; cheap, and the right first move when a
session stopped one step short. *… with a new agent* opens a FRESH interactive session briefed by the
console with the evidence — fresh eyes that know the facts, not the conversation; it costs a full
session, and you watch it on **Sessions**, where it is listed as `Recover checkout-rewrite P3` while the
card reads *— running* and links to it. Every button carries the exact what-will-happen as its tooltip (tap
the ⓘ on a phone).

| The card says | The button | The session is told to |
|---|---|---|
| A phase halted on its verification | **Fix with a new agent** | Diagnose the failing command, fix the cause, finish the phase. |
| A phase did the work but wrote no handoff | **Close out with a new agent** | Close the phase out — commit, handoff, board. |
| A run was interrupted | **Pick up with a new agent** | Continue from where it stopped. |
| The session stopped at a sign-in | **Pick up with a new agent** | Continue after you sign in — the card routes you to the login first. |
| A claim is stale | **Take over with a new agent** | Take the phase over from a session that is gone. |
| A plan will not parse | **Repair the plan with a new agent** | Repair the plan against the format the engine reads. |

**The outcome is checked, not assumed.** When the session exits, the board is re-read from disk and
the notification says which it was — the phase is done, or it is still waiting and wants your eyes.

## When it refuses

Three situations, and it says which rather than making a mess: while the autopilot is driving, while
a recovery for that same phase is already live (the refusal links to it, so you land in the running
session instead of being told no), and when the problem is that you are signed out.

A recovery of a run working on `pe/<slug>` is told to commit there — checking the branch out first if
the repository is not on it, or using the run's linked worktree when one exists.

## Asking for a review

Recording a QA verdict was always possible; **getting** one is the other half. From a finished phase
— in the plan's phase table, the phase's details or its panel, and in the **Phases** fold of its run —
**QA this phase** opens a session whose brief is the skill's own `--qa-prompt`, embedded verbatim, plus
what the engine
cannot know: the handoff the phase wrote, its key files, the commits that touched it, and that
phase's exit criteria and verification quoted rather than summarised.

You choose model, effort, permission profile and skills, exactly as for any agent session. Once it
starts, the button reads **QA running** and links to the session, listed as `QA checkout-rewrite P3`,
whose panel says **What it is reviewing**.

**The session records the verdict; the console only reads it back.** The brief ends with the exact
`qa-record.sh` line, report path already filled in, and when the session exits `test-status.md` is
re-read and compared with a snapshot taken at launch. A session that ended without running that
command is reported as *no verdict recorded* — including on a phase that already read `pass`, where
assuming otherwise would be the easiest possible lie.

## Four things a review will not do

1. **Resume the session that built the phase.** A review is a fresh reading or it is not a review.
2. **Run while the autopilot drives.** A review reads the working tree and runs the phase's tests; a
   run on any phase invalidates both.
3. **Run while a session is still building that phase.** Reviewing a moving target is not a review.
4. **Start twice for the same phase.** The refusal carries the live session, so you open it.

Turning QA on for a plan goes through the skill's own `--qa` path, which **waives the phases that are
already finished** rather than gating them. Switching QA on must not make five green phases go yellow
and stall everything downstream of them.

## The off switch

**Settings ▸ This instance ▸ Shut down** ends the console and everything it owns, as a graceful
exit that says what it is taking with it — and what the exit achieves, in the dialog's own sentence:
*Shut the console down?*, confirmed with **Shut down**. The palette's *Shut this console down…* goes there.

- **The dialog is an inventory, not a warning.** It lists what the console is holding — the lanes in
  flight, the clocks armed, the runs on disk, the live sessions, the cards still waiting for an
  answer, and the session and outcome drops nobody has read yet — and confirming it is acknowledging
  it: the server refuses a bare press over a non-empty inventory, or over one it could not read, so a
  stray request cannot end work nobody was shown. The runs are checkpointed first and resume when the
  console comes back, and the sessions are listed under *this keeps running* — since the pty broker
  they outlive the console, and a dialog that claimed to stop them would be the old silence with the
  sign flipped. It also gives the command that starts it all again. *Are you sure?* is not a question
  anybody can answer; *this stops the demo run and keeps 2 agent sessions running* is.
- **It is not behind `--allow-run`**, unlike Restart. A read-only console is the common case, and the
  one thing every console must be able to do is stop.

**Restart the console** shows the same inventory — but since the pty broker the sessions *survive* it,
so both dialogs list them under "This keeps running" rather than claiming to stop them.
