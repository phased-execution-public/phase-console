## Nothing will start

If a plan's **Run** view says *This console is read-only for runs*, and every control there says *Needs
--allow-run on this console.*, the console was started without `--allow-run`. **The first line of this
Help sheet says which it is** — *Runs are enabled on this console.*, or *This console can show runs but not
start them* — because it reads this console's own switches rather than describing a console in general.

The fix is a restart with the flag: **Starting up ▸ The eight switches** has the command, and Settings ▸
Essentials ▸ **Start command** composes it for you, with **Copy the command**.

**Is the machine ready at all?** `phase-console doctor` runs the checks a run's start would, with no
plan in front of it — accounts, MCP servers, the machine's `claude` login, a delivery channel, the
session-presence hooks, the Claude CLI's version against the relay's floor, `gh auth status` — and
exits 1 naming the first blocking row that fails. It asks the running console when one answers on its
port, and reads the machine itself when none does; `--json` prints the whole report.

## When a run stops

Four ways a run comes to rest. **Only one of them is a problem.**

| It says | What happened | Do |
|---|---|---|
| `halted` | Something the runner will not decide alone. | Read the halt reason, fix the cause, Retry that phase. |
| `parked` | Everything left is waiting on something outside the run. | Clear the gate or release the lock, then start again. |
| `waiting` | A usage window is exhausted. | Leave it. It resumes itself. |
| `interrupted` | A phase was cut off partway. | Look at what changed, then Retry or Skip deliberately. |

## Halted

*Something the runner will not decide on its own.*

Verification failed · the plan stopped linting · the board did not flip to done · two phases failed in
a row · the budget ran out · the API refused the run's own credential · a person is needed.

Read the halt card at the top of the plan's **Run** view, fix the cause, then press its way forward —
**Retry from scratch** for a phase whose attempt was wrong. If the phase actually did its work and only
failed to close itself out, **Finish in its own session** is the move rather than a retry — see
**Autopilot**.

## Parked

*Every remaining phase is waiting on something outside the run.*

A gate that has not cleared · a lock held by another session · a phase that needs a decision.

Clear the gate or release the lock, then start the run again. Nothing was lost — the run's fold **Ways
forward** names each blocker with its remedy.

**Every phase is done, but the run's branch is not on its trunk yet.** A run that works on its own
branch finishes only once that branch, in every repository it mounted, is held by the trunk on
`origin`. Until then it parks as *unlanded*, with one errand naming what is in the way, such as a
conflict and its files. The errand's card opens a merge errand tree; once the branch has landed,
**Recover & continue** checks again and the run finishes.

## Waiting

*A usage window is exhausted. Nothing is wrong.*

A plan-level limit that only time fixes. A limit on one model instead switches model and carries on.

Leave it: the run resumes itself at the stated time. Further out than twelve hours and it parks for
you instead. With more than one account registered, the launch's **On usage limit** set to *switch
account, else wait* moves it to an account with headroom rather than waiting at all — and it does so *while the wall is happening*, off
the session's own stream, rather than waiting for the session to exit. That matters because a session
that hits the wall mid-turn often never exits: the CLI absorbs the 429 and retries every thirty
seconds indefinitely. A lane in that state reads **Retrying** on its row, and if no account had
headroom to move it to, Runs raises it under **Your turn** after a quarter of an hour. The run does not sit there
silently either: the third such wall inside an hour with nowhere to move stops being merely noted —
the phase waits out the window when its reset is known, or parks with an errand — and it announces
under **Usage limits** either way.

**A registered account is not always one a run may spend.** What the machine has learned about each
credential is shared by every console on it: `cooling` after a wall, until the wall resets (half an
hour when it named no reset), and `retired` once the API refused the credential for its organisation
— out of every run until a person clears it. A run is also refused before it starts when its
account's five-hour window already reads 97 % or more, with the time it resets, rather than finding
the wall the expensive way.

## Interrupted

*A phase was cut off partway.*

You stopped the run, or the console died while a session was working.

The phase is never re-run silently — it may have half-landed. Look at what changed, then Retry or
Skip it deliberately.

## Things that look broken and are not

**The board disagrees with what I just did.** It does not: every status comes from
`scripts/phase-graph.sh`, never recomputed in the browser. If the board and a file disagree, the file
is not what you think it is — run `scripts/validate.sh <slug>` and read what it says.

**A fix I made to the server did not work.** Node reads `server/` once, at startup; reloading the page
reloads the client and nothing else. Settings ▸ This instance ▸ **This process** says whether it is *Older
than what is on disk — restart it*, **Restart the console** just below it restarts it, and every page says
*This console is running older code than is on disk.* while it is.

**404s in the browser console on the Runs page.** The same thing: a client from disk talking to a
server that started before the autopilot existed. The page says so rather than showing a stack of
failed requests, and this sheet's first line reads *This console predates the autopilot.*

**A press says the page is from a previous release.** The console was updated while this page was open, so
the page still runs the earlier release's code. Nothing was done: the press is refused with *This page is
from a previous release of the console — reload it, then press again.*, and a toast, *This page is from a
previous release of the console.*, offers **Reload**. Reload, then press again. A page opened just after an
update reads *Updating to the new version of the console…* for a moment while it swaps to the new release.

**A verification line has been waiting a long time.** A heavy line, a full test suite or a build, waits
for a seat in the machine's one budget of heavy jobs, which every console shares (about one seat for every
seven cores, at least one). The journal's `phase.verify-queued` names who holds the seats, and the line runs
as soon as one frees. It is queued, not hung.

**A card I answered on my phone is still on the laptop.** It is not — press it and you get a 404 for a
decision already made, and the queue re-reads itself at that point.

**Notifications say "handed to the push service" and nothing appears.** Almost always the operating
system: macOS *System Settings ▸ Notifications ▸ your browser*, or Windows *Settings ▸ System ▸
Notifications*. A Focus or Do Not Disturb mode does the same thing silently.

**Nothing can reach me at all.** No device is subscribed and no `PHASE_CONSOLE_NOTIFY` command is set,
so announcements arrive in the inbox and stop there. Settings ▸ Notifications says so under **Devices**,
and the bell's **Announcements** opens with *Nothing can reach you out of band yet.*

**The usage alerts went quiet.** Check whether **Usage limits** got switched off in Settings ▸
Notifications — see **Alerts ▸ Turning off the usage-limit alerts** for what that silences.

**Two sessions on one phase.** Take the lock (`scripts/phase-lock.sh <slug> claim <N>`) before
building, and release it when you stop. Sessions ▸ **Locks** lists every claim and who holds it, and
Insights ▸ What shape the work is in shows how much lease each has left.
