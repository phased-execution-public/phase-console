## A halt is a run that stopped itself

A run stops for one of two reasons. You stopped it, or it reached something it will not decide alone.
The second is a **halt**. A pause or stop you pressed reads **Paused by you** or **Stopped by you**,
stays quiet, and nothing restarts it until you do. A halt reads **Halted**, **Parked** or
**Interrupted** — **When stuck** tells the words apart — and it is not always the end: the console
climbs what it can before it asks you.

A halt is not painted as an alarm. **Halted** sits in the waiting paint with an alert glyph, in the
Tower's **Waiting** bay. It turns amber, and moves to **Needs you**, only when something is asked of
you: an errand, an approval or a sign-in.

## One card, one sentence, one way forward

Every halt is explained by one card, the same wherever you meet it: in full on the run page under
**Halted.** and in an expanded strip on the Tower, folded to a line in the plan's health panel.

- **The family**, one of nine, with an icon. The Tower lights a lamp for each; press one to narrow
  the bays to that family. A family is never amber.
- **One sentence** saying what happened, with the fix the family usually wants under it.
- **The controls** this stop needs: a budget's raise, **Clear the streak**, a row and a button for
  each phase that holds a run with nothing ready, or the plan a plan-mode session wants approved.
- **The recommended button**, drawn first: the way forward the console would take itself. Further
  ways fold under **More ways forward**. Once the run is live again the note reads
  **Stopped earlier — running again.** and the card offers no buttons.
- **Details: the runner’s words, the ladder, the watch**, one press away: what the runner wrote,
  verbatim, what the ladder tried, and the refs the phase watches.


## The nine families

| Family (lamp) | What stopped the run | What usually moves it |
|---|---|---|
| **Needs your decision** (**Decision**) | A session wrote a blocked handoff or needs a step only a person can take. A plan-mode session waits for you to approve its plan. A card went unanswered. A QA verdict holds every phase that is left. | Answer what it asks — approve, re-run or waive QA — then continue. |
| **Credentials and accounts** (**Accounts**) | The run's Claude account was refused, now signs in as somebody else, or failed the checks at the start. | Sign in again, or move the run to another account, then continue. |
| **Usage limits and budget** (**Limits**) | The run spent all the money it was allowed, or every model it may use is at its usage limit. | Switch account, or raise the budget. |
| **Environment and network** (**Environment**) | An MCP server a phase needs would not connect, or a session, a recovery or the console's drive loop crashed. | Continue once the network or the server is back, or continue without it. |
| **Plan defect** (**Plan**) | The plan fails its lint, cannot be read, or has a verification line the console will not run as written. | Repair the plan file, then continue. |
| **Verification and unfinished work** (**Verification**) | A phase finished and its verification did not pass, a session wrote no handoff, a verification command ran past its time limit twice, or too many phases failed in a row. | Resume the phase with the failure, close it out, or retry it. |
| **External wait** (**External**) | Something outside the console has to happen first: a CI run, a date, a phase of another plan. | Look again once the thing it waits on has happened. |
| **Conflicts, locks and restarts** (**Conflicts**) | Two lanes changed the same lines, a finished phase would not merge onto the run branch, an earlier console's session still holds a phase, the console restarted mid-run, a run could not get the checkout it asked for, or nothing is ready to run. | Release the lock, continue, or retry the phase that holds it. |
| **Stopped by you** (**By you**) | You stopped the run. | Start the run again when you want it to carry on. |

Most halts are about one phase, and under **Keep going where it safely can** the run goes on with
whatever does not depend on it. A few are about the whole run: its money, its account, its plan file.

## Recover & continue

One press that does the whole sequence, in order. It needs `--allow-run`, and it reports each step.

1. It re-reads the board and stands down anything the board has moved past.
2. A stop about the plan itself — a failed lint, an unreadable file — is answered by the plan. A clean
   lint clears it. A red one keeps it and quotes what `validate.sh` said.
3. With nothing wrong left, the run continues. With a real halt left, the console climbs the ladder
   now, the way the unattended loop would. A rung may start a session, which costs money; the
   button's tooltip, or its ⓘ on a phone, says what will start.
4. Anything only you can settle comes back by name as one errand. It is never retried blindly.

The card leads with **Recover & continue** when a stop belongs to no single phase: a budget, an
account, a plan file. On one phase it leads with that phase's own verb, such as **Re-check**;
**Autopilot** lists them.

## What the console tries before it asks you

The console reads the evidence on a stopped phase — the board, the handoff, the lock, the working
tree, the last verification, what the session declared — and puts it in one **situation**, such as
*Verification red* or *Declared blocked*. Each situation has a ladder of rungs, climbed in order, and
a rung that ran is not tried twice on one phase. The cheap ones come first: the phase's own session
resumed, then a fresh briefed session; at a wall, an account or model switch.

The ladder is bounded in rungs and dollars: by default three rungs and $100 a phase, ten rungs and
$400 a run, $600 a day, each a knob on the **Automation · the ladder** card in Settings ▸ Automation.
When a rung fixes the phase, the run carries on by itself; under **Stop and ask me** it waits for you.

When every rung is spent, or the situation was yours from the start, the phase is parked with one
errand: the card headed **Needs you — phase N**, with what is needed, **How:** to give it, and what
was already tried. The run page keeps each settled rung in its session ledger, under
**Why it started and what it cost**, with an **Outcome** and a **Why**.

- **Withdrawn** means the rung never ran. The phase was put back on the board, but no session started:
  another lane took its scope, or a park or halt took its place in the queue. It costs nothing, counts
  toward no cap, and the rung can be tried again.
- **On its merits**, **The machine** and **Never ran** say what ended a rung. One the machine
  defeated — a refused credential, a network that was down — is given back while the machine is the
  reason, and counts as tried only after five such tries.

## A failure streak

A failed phase does not always stop the run: under **Keep going where it safely can** it moves on to
the next ready phase. Two phases that fail in a row do stop it, the console saying the plan itself
may be wrong. **Stop after N failures** in the launch form changes the two.

The streak counts phases that failed on their merits, each phase once.

- A command that failed and passed on its retry is green. It is not a failure.
- A second ending of a phase already counted is the same failure, not the next one.
- Phases stopped by one cause, such as a sibling's red commit, are charged once.
- A wait, a spent wait budget, a refused credential and an outage are never charged.

The card shows the count, *2/2 phases failed in a row*, beside **Clear the streak**; under **Details**
the runner names them: *phase 1, then phase 2*. The loop never relaunches this stop by the clock.
Only your press does — **Continue**, a phase's **Retry from scratch**, or **Recover & continue** —
and it resets the count.

## An outage is not a credential fault

Two stops look alike and are not. The console tells them apart by the CLI's own error, never by a
session's prose: a session that quotes a refusal in its answer has not been refused.

**The API cannot be reached.** The network is down, or a proxy is in the way. Nobody is at fault, so
nothing is charged: not the attempt, not the streak, not a rung. The run reads **Waiting**, *on the
network*. The console looks at the API every minute and goes on at the first answer, resuming the
session that lost it where it can; the back-off of 1, 2, 5, 10 and 15 minutes is only the latest it
sleeps. Past twelve hours of outage it fails the phase, still without charging the streak. A slow
engine is the same kind of wait, *on a busy engine*: the run waits out eight timed-out board reads,
and only a ninth in a row halts it, with *The console could not read the plan file.*

**The API refuses the credential.** An organisation policy, an expired or signed-out login, a billing
hold. Now the run halts — *The run’s Claude account was refused.* — and the console retires the
account, so no run spends it while it stays retired. The errand names the account and what to sign
in. If every registered account is unusable, the card says so, because there is nothing to switch to.
Sign in again under Settings ▸ Accounts, or register another account and move the run to it.

## A block that names a watch is a wait

A session that cannot go on says why: it is *blocked*, or *waiting on the outside*. When it also
names something the console can check on its own — a GitHub run or pull request, a date, another
phase's lock or result, a job on another machine, a command that exits 0 — the stop is a wait and not
a failure.

- The phase parks as **Waiting**. It is never recorded failed, it charges no streak and it raises no
  halt. When a ref lands, the phase's own session resumes in its lane, told what landed.
- A date beside another ref is a backstop, not a second thing to wait for. The phase wakes the moment
  the ref lands; if the date passes first, its session is told that the ref has *not* landed and what
  it last read.
- The wait has a budget: four declared waits and eight hours parked in all, by default. The phase's
  `Waits on:` line or the plan's `Wait budget:` raises the hours, and a `Wait count:` line the number
  of waits. When the budget is spent while a ref the phase named is still being checked, the console
  keeps checking that ref as before and resumes the phase the moment it lands; the run itself looks
  again every six hours. Only when nothing is left to check — a date alone, or every ref refused —
  does it park for you, with one errand that states the arithmetic: allowed, spent, left. For the
  hours, the errand offers **+30m**, **+60m** or an amount you type, with **Raise and retry**; a wait
  budget lives in the plan, so this needs `--allow-writes`. For the count, the phase's **Retry** opens
  it again.

A block that names nothing the console can check, or only a ref it already waited out, is a real
stop: it goes to the ladder, then to an errand. If every ref a phase declared was refused, the card
says *None of the refs it declared can land*, because nothing will resume the phase by itself.

## A job on another machine

A wait can name a systemd unit on another machine: `unit:<host>/<unit>`, such as
`unit:build-box/nightly-build.service`. Every five minutes the console asks that machine whether the
unit is still running, over one ssh connection per host that every wait on it shares. The wait lands
at the first check after the unit stops — finished, failed or stopped by hand — and its history
records the unit's result and when it exited. A unit the host's systemd does not know is refused.

The host is a name, not an address. Its address, user, key and port live in the machine profile,
`~/.config/phase-console/fleet.json`, under `hosts.<name>`. A wait on a host the profile does not name
is refused, and none of those details is written into a run's record. The
connection never asks for a password, so the key must already let a plain `ssh` in. When ssh fails,
the wait says what kind of failure it was, such as a refused login or a host it cannot reach, and
never quotes ssh's own output.

## What is yours, and what is the loop's

The loop needs nobody watching. It re-reads every open plan at boot, when the docs change, every few
minutes and a minute after any stop. It closes records the board has overtaken, climbs the ladder on
runs the console stopped, releases locks left by dead runs, resumes the lanes a restart killed once
you have allowed it, and boards a waiting phase when its ref lands. It never touches a run you
paused or stopped.

What is yours, it asks once, with a named errand:

- a sign-in or a code only you can give — see **Your turn**;
- a `manual` gate, or a credential a session named and nobody holds;
- a tool the permission policy refused: **Offer the rule to widen** strikes one rule when you allow
  it — see **Permissions**;
- an approval a session waits for, including a plan presented in plan mode;
- a blocker no category fits, after its one unblock session;
- anything destructive or publishing, and anything the console could not classify.

A failure streak, a refused account and a changed login are press-only: the loop does not relaunch a
run halted by one of them, and only your press starts it again.
