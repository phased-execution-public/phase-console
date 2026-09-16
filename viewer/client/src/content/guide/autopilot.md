## Answer what actually needs you

Most tool calls are answered without troubling you. A few are not.

When a session reaches something on the ask list — a commit, a migration, an install — it pauses and
a card appears on the Autopilot tab and in **Runs**. The card carries the working tree, the diff, the
verification so far and the exact command, so you are answering a question rather than a prompt.

Nobody answers within **about an hour** and the call is denied, with the reason passed back to the
session so it can adapt or stop rather than hang — and the reason is specific: *nobody answered in
time — the phase is parked, not failed; answer the card and retry the phase.* A card you find waiting
after lunch is very likely still answerable; a card that did time out cost you a park, not the work.

Read-only work never becomes a card. A queue that fills with `grep` and `find` is a queue nobody
reads, and one nobody reads only teaches you to tap yes.

## What "verified" means

Three independent checks have to agree before a phase advances:

1. The plan's verification commands ran green.
2. `validate.sh` still passes.
3. The board, re-read from disk, says `done`.

All three are run by the runner, not by the session. That is the whole design: a session cannot
verify itself.

## …and what it does not mean

Plans write verification as prose with commands embedded. `… -m "not slow"` is a continuation
fragment; "targeted pytest + safe set" names two suites in English and no command at all.

The runner executes only what is recognisably a command and demonstrably read-only, and **reports
every fragment it left behind** against the phase on the Autopilot tab. Those are yours to check. On
the careful autonomy an incomplete verification stops the run instead of calling it green.

The classifier is **segment-aware**: a `cd …`, an environment prefix or a wrapper does not hide what
follows it, and every segment of a chained command is gated separately. `FOO=1 ./deploy.sh` and
`… && curl -X POST …` are both caught by that.

## When a phase did the work but is not done

A phase can finish its work and still not flip the board — a handoff that was never written, a
verification that needs re-running, a lint that broke on something unrelated. Rather than leaving you
with only *Retry* (which throws the work away) or *Skip* (which lies about it), the console offers the
verb that matches what is actually missing.

| Verb | Use it when |
|---|---|
| **Recheck** | The work looks done. Re-runs verification, lint and the board without spawning anything. |
| **Closeout** | The work is done but the phase never closed itself out — one continuation session that commits, writes the handoff and updates the board. |
| **Resume phase** | The session stopped mid-thought. Continues it with `--resume`, optionally with an instruction. |
| **Retry** | Start the phase again from scratch. The right answer when the attempt was wrong, not merely incomplete. |
| **Retry with edits…** | The same retry, carrying an instruction and settings for **that attempt only**. |
| **Skip** | Mark it not-to-be-run. Deliberate, and recorded as such. |

**Recheck**, **Closeout** and **Resume phase** are recoveries, and a phase's recoveries are held to a
ledger. Pressed again over the evidence the last one already ran under — the board, the handoff, the
locks and the gate reading exactly as they did — a recovery is refused as *nothing has changed*,
because running it again would only rewrite the same halt; and a phase recovered six times in one run
is refused until **Retry** starts it over, which clears the count. Both refusals are journalled
(`run.recover.refused`).

### Retrying with edits

Plain Retry boards the phase again with byte-identical settings, which is right when the attempt was
simply unlucky and wrong when you have just read the failure and know something the plan does not.
Until now the only ways to say so were to edit the plan — a versioned file — or the run's per-phase
settings, which would then govern every later attempt too.

**Retry with edits…** opens a box beside the button. Type what this attempt should do differently and,
if it matters, pick a different model or effort. Then:

- The instruction is appended to the boot prompt **after the failure evidence**, framed as the
  operator's words for this attempt — so the session reads what went wrong and then what you want done
  about it. It is quoted verbatim; the console never paraphrases it.
- The settings outrank both the run's per-phase choices and the plan's own bullets, because they are
  the most recent and most specific thing anyone has said about this phase.
- All of it is **spent at the boarding it causes**. The next Retry starts from the plan again, and the
  plan file is never touched.
- The override is journalled as `phase.retry-override` before it is spent, so *why did phase 7 run on
  Opus that once* stays answerable from the journal alone.

Pressing **Retry with edits…** and typing nothing does nothing — that is what plain Retry is for.

Each phase row opens on a **diagnosis**: what the board says, what verification actually returned,
whether a session is resumable, what is uncommitted, and who holds the lock. A phase that is not done
always offers a way forward.

## Every warning carries its remedy

A dashboard that lists problems and offers nothing is a dashboard you stop reading. Each card under
**Waiting on you** carries the verb that answers it, and each verb works out what it needs rather
than asking you to retype it.

| The card | The verb beside it |
|---|---|
| A halted or interrupted run | **Continue**, **Dismiss**, or an AI recovery — and if the phases it stopped for have since gone green, it is resolved for you before you get there. |
| A stale claim | **Release** — one, or all at once. The owner is read off the lock file, so there is nothing to type. A lease that is still live is refused rather than stolen. |
| Unread notifications | **Mark all read**. |
| A plan that will not parse | The actual issues, each a link to the line, and **Repair the plan with a new agent**. |

The inbox also shows what the console did **without** asking. A **Policy answered** row has nothing to
press: it says what the console answered by itself, where that answer came from and what the shipped
default is, and where to answer differently — Settings ▸ Automation ▸ Policy answers, or the plan's
`## Decisions` table. And a question a session raised on a run whose relay is armed is a row with one
button per option and its window ticking down — *N s to answer*, then *answering by rule*.

## A resolved run is annotated, never deleted

It keeps its status, its halt reason and its place on the Runs page — you can see what happened and
why it no longer demands anything, and undoing that is a click.

What you overrode by hand is remembered as an override, so the next read does not quietly re-derive
it and make the button look broken.

## When runs share a repository

The scheduler serialises runs whose repository scopes overlap — the **repository guard**, on by
default (Settings ▸ Automation). A queued run says who it is waiting on.

Turning the guard off admits overlapping runs at once; a work-branch run that overlaps a live one is
then instructed to do its work inside a linked `git worktree` rather than switching the shared
checkout. The guard never changes the rule *within* one run: two lanes of the same run still never
share a repository.

## The ladder — what it tries before it asks you

A phase that stopped short is never healed by the name of its halt. The console **classifies** it
from evidence that already exists — the board line, the handoff's status and Outstanding text, the
run's record, the lock and who holds it, the working tree, the last verification, what the session
declared — into one **situation**: never started · work in progress · done but unrecorded ·
verification red · declared blocked (a lock, a credential, a gate, something external, or unknown) ·
a resource wall (usage, auth, budget, model) · an unreachable MCP server · a broken plan · a stale or
a live foreign claim · a manual gate · a QA verdict.

Each situation has a **ladder** of rungs, climbed in order and never the same rung twice on one
phase: its own session resumed first (cheap — the context is intact), a fresh briefed session next,
an account or model switch at a wall, one bounded unblock session on a declared blocker, a takeover
of a stale claim. The ladder is bounded in **rungs and dollars** — per phase, per run, per day —
and every cap is a knob on Settings ▸ Automation's ladder card. Every **Ways forward** shows the
situation, the rungs tried with how each ended, and the rung it tries next, so what you press is
never something the machine already tried.

**Every rung names who drives it**: the console itself, the console only under `--allow-writes`, a
fresh session or agent (`--allow-run`, else `--allow-agent`), or nobody — an operator-only rung is a
person's instruction. A rung this console cannot drive is skipped rather than waited on, and a
situation none of whose untried rungs can be driven here counts as exhausted: its errand says, rung by
rung, what is in the way — a flag, a preference, a clock, an account.

**One rung offers instead of acting.** A phase stopped by a rule of the permission policy gets
**Offer the rule to widen**: the denied rule and the command it stopped on go on an approval card, and
approving strikes that one rule for this plan and resumes the phase's own session. Nothing spends
until a person answers; a card nobody answers in twelve hours reads as denied, and the errand stands.

**A refused credential stops the run, not the phase.** When the API refuses the credential the run
spends — an organisation policy, an expired or signed-out login, a billing hold, a certificate it will
not trust — the run halts as `credential-refused`, the account is retired for its organisation on this
machine, so no run picks it again until a person clears it, and the errand names the account and what
to sign in. That halt and `failure-streak` are the two the convergence loop never relaunches by
itself: relaunching by clock was exactly what reset the failure streak, and a retired credential would
only meet the same wall. The phases' own ladders still climb; only your press starts the run again.

**Above every ladder sits the start ceiling.** A console makes at most 40 automatic `claude` starts
and $250 of session spend in any sliding hour — the two knobs under *Start ceiling* on the same card,
where `0` switches one off. Past either, nothing automatic starts until the hour frees; the refusal is
journalled on the run it would have started (`run.start-refused`) and announced once an hour. A
person's Start, Retry or Continue is never refused by it.

When every rung is spent, or the situation was yours from the start, the phase is parked with
**one errand**: what is needed, how to give it, what was already tried. That card is the only thing
the dashboard's *Waiting on you* shows besides permission cards and sign-ins — a halted run with no
errand is the loop's to climb, not yours to stare at. Do the errand, then press **Recover &
continue**: the board is re-read, what the errand settled stands down, and the run carries on.

## It keeps looking — convergence

Nobody has to be watching. The **convergence loop** re-reads every open plan at boot, on a docs
change, every few minutes (the sweep), a minute after any stop, and on *Recover & continue* — closes
the records the board has overtaken, classifies what is still open, climbs the ladder for runs the
system stopped (never one you paused or stopped, never a resolved one), releases lock debris left
by dead runs and ended sessions, and resumes the lanes a console restart killed. Each pass is one
journal line on the run and one line on the Pulse's **Converge** row — "re-boarded P12 (Never
started → Re-board fresh) · released a stale claim on P3" — so what it did is readable after the
fact. `--no-converge` keeps the automatic passes off; a console without `--allow-run` never
converges by itself. The convergence LOOP never dispatches a reviewer; the ladder does, as a rung
inside a run — `qa-pending` and `qa-failed` each resume the phase's own session and ask it to dispatch
the fresh-context subagent and record the verdict.

## Who is in the repository

Install the **session-presence hook** (Settings ▸ Automation ▸ Session presence, or `phase-console
install-hooks`) and every Claude session on this machine whose directory a console owns reports
itself: a hand-run `claude` appears on the Pulse as a lane of its own kind, its phase lock names its
session, and the lock is a queue to wait in while the session lives and **debris the moment it
ends** — released without waiting for the lease. Presence is three-valued: live, ended, unknown;
nothing is ever released on a guess. A hand session's `phase-outcome.sh` declarations reach the
console too, so a person's *waiting-external* or *partial* drives the same machinery as a lane's.
