## One switch per category

**Settings ▸ Notifications ▸ What is announced, and where it goes** has a switch per kind — and, under each one, the line saying which legs it actually reaches. It is not a push
setting. Turning a category off means that category produces:

- no record in the inbox,
- no live event to an open tab,
- no hand-off to whatever `PHASE_CONSOLE_NOTIFY` points at,
- and no push to any device.

A category that is off leaves no trace anywhere. Worth stating, because the obvious alternative —
silencing only the buzz — leaves the badge climbing and the inbox filling, which is how people end up
ignoring the inbox entirely.

## The sixteen categories

| Category | Tells you | Default |
|---|---|---|
| **Permission needed** | A session is blocked on a decision only you can make. Nothing proceeds until you answer. | On, urgent |
| **Session waiting on you** | A Claude session hit a permission prompt or asked for input — an agent session, one you ran in a terminal, an autopilot lane with no permission card already up for it, or a question the relay is holding, with the seconds left before the console answers it by rule. Sent once more if an ask waits an hour unanswered. | On, urgent |
| **A phase needs you** | A phase stopped at a check no automation may sign off. Not failed, not finished — waiting. | On, urgent |
| **Gate needs a person** | A phase is held at a gate only a person may clear. The board calls it ready the moment you approve it and not before. | On |
| **QA verdict owed or failed** | A finished phase still owes its QA verdict, or QA recorded a fail — the plan gates on it, so every dependent is held until pass or waived is recorded. Sent only after the console's own chase left the verdict owed. | On, urgent |
| **Run halted** | A run stopped on something that must not be automated past, or was interrupted with nothing driving it. | On, urgent |
| **Run parked or waiting** | Every remaining phase needs a person, or a usage window has to reopen. | On |
| **Nothing is happening** | A session is still running and still spending but has stopped producing work — silent for ten minutes, six turns without a tool call, or three attempts that changed nothing. | On |
| **Phase finished or failed** | Each phase as it lands, with what it cost. | On |
| **Plan finished** | A run reached the end of its plan. | On |
| **A session ended** | An agent session or terminal finished while you were not watching, or exited with an error. | On |
| **Console problems** | The console degraded, its file watch went deaf, or it restarted after a crash. | On |
| **Usage limits** | A Claude account hit a usage window, with when it resets and what the run did about it — and an account that needs signing in again. | On |
| **Usage climbing** | Early warning while a window fills: 80% and 95% crossings. The meters show the same numbers all the time. | **Off** |
| **Work became ready** | A phase became startable — including because of work you finished yourself, elsewhere. | **Off** |
| **Plans changed on disk** | Any plan or handoff was written. An agent editing a handoff mid-phase fires this. | **Off** |

The last three are off by default because they are early warnings or firehoses rather than signals.
A channel that always buzzes is a channel you turn off, and the notification it was hiding goes with
it. The wall itself — and everything a run does about one — still announces under **Usage limits**,
so muting the climb never mutes the crash.

**Nothing is happening** — a stalled session — is deliberately not urgent. Nothing is blocked on you
and the run has not stopped; it is the money question, not the permission question, and a card that
buzzes a wrist for it would be turned off within a week. The console names which of the five signals
it saw (silent, spinning, stalemate, retrying, waiting on an external clock) and offers the verbs that
answer one — steer the session, freeze it where it stands, stop that lane. With one exception below it
does not act by itself. A phase inside its
own §Verification is exempt, because a build is silent and fine. On the Now inbox a stalled lane
becomes a row of its own only once it has been silent for half an hour: this notification arrives
sooner, and it is the one you can dismiss.

**Retrying** is the one signal with a different answer. A session pinned inside the CLI's own retry
watchdog is alive and cannot reach the API, so nudging it does nothing — its row offers *freeze* and
*stop* instead, and the run's own **On usage limit** policy has already tried to move it to an account with
headroom before you ever see it. Retries do not count as output: a lane that has produced nothing but
429s for twenty minutes reads as stalled, which before this it did not.

**Waiting on an external clock** is the one signal that ACTS, and it is the only one, because it is the
only one where doing nothing costs somebody else. A session that opens `gh run watch`, an
`until … sleep` poll or anything else with a `--watch` flag is not working — it is watching — and
while it watches it holds an exclusive phase lock that looks perfectly healthy from outside, because
the lease keepalive refreshes on a timer whether or not anything is happening. Measured: a phase sat
35 minutes in two concurrent poll loops holding a claim on an entire repository, blocking every other
lane whose scope touched it. After five minutes the console does what the skill already tells a
session to do — park the phase, **release the lock** so others can move, and resume that same session
when the window elapses. The waiting was never the problem; the squatting was. The vocabulary is
shared with the plan-time lint that warns about the same commands in a §Verification block, so the two
can never disagree about what counts — and with a PreToolUse rule that now refuses such a call
outright, before it is ever opened.

One exception, and it is the commonest case rather than a corner: when what the session waits on is a
job **it started itself** — a suite, a build, a log in `/tmp` it is tailing — it is not squatting, it
is between two halves of one piece of work, and taking the lane away throws that work away. Measured:
26 park-and-resume cycles at a median of 70 minutes each, every one of them interrupting a machine
doing exactly what it had been asked to do. So the console tells whose clock it is by reading the
command, and a local one gets a single nudge — background the job and carry on — with the park only
after `stallLocalJobMs` (45 minutes). A park hands the loop's own condition over as a watch ref, but a
`cmd:` ref the console minted from a command is run only when `watchMintedCmdRefs` is on — off unless
you turn it on, and only under `--allow-run` — so by default that ref is recorded unrun and the lane
comes back on the park's own clock rather than the moment the job finishes.

The console may park a lane by itself at most four times a phase — its own allowance, separate from
the waits a session declares — and `stallAutomaticPark` (Settings ▸ Automation) switches that off
altogether: the card still comes and the local job's nudge still goes, but no lane is parked in the
session's place.

**Urgent** is reserved for *nothing proceeds without you*. The categories marked urgent above may
interrupt a focus mode and buzz a wrist.

## Turning off the usage-limit alerts

If the account meters are announcing more than you want to hear, there are two places with the same
switch, and either one silences every leg:

- **The usage meter** — open it from the rail (or the top bar on a phone) and use **Usage alerts**
  at the bottom.
- **Settings ▸ Accounts ▸ Claude accounts** — the same control, under the meters.
- **Settings ▸ Notifications ▸ Usage limits** — the full list, where every other
  category lives too.

The meters keep updating either way; only the announcements stop. Be aware of what goes quiet with
them: the **Usage limits** category carries **a run that parked waiting for a window to reopen**,
**an account that could not sign in — including a login that expired and needs signing in again**,
and **a run refused before it started** because the account was already at its limit. If a run seems
to have gone silent after you mute these, that is where to look. The *window is filling up* early
warning is its own category — **Usage climbing**, off unless you turn it on.

## Devices only ever narrow

Each browser you have subscribed for push has its own category list, and it can only **subtract**
from the global one. A category disabled globally is not deliverable, so no device can opt back into
it; a category enabled globally still only reaches devices that asked for it.

So you can keep `Phase finished` in the inbox on the laptop and off the phone, but you cannot have
the phone buzz for a category the console does not raise at all — which means a quiet phone is never
hiding a message that exists somewhere else.

Setting push up on a phone is its own walk-through: **Mobile setup**.

## The inbox, and getting it back to zero

Every announcement that survives the switches lands on **Notifications**. A record knows what it is
about — a plan, a run, a phase, a session — so it routes to the thing rather than to a list.

- **Reading a page reads its notifications.** Sitting on a plan or session page for a moment marks
  that page's records read, scoped to that page. The count falls because you actually looked.
- **Mark all read** on the dashboard card zeroes the count in one act, for the flood you are never
  going to read item by item.
- Nothing is deleted by either. The record stays; only its unread state changes.

> If announcements arrive in the inbox and never anywhere else, `PHASE_CONSOLE_NOTIFY` is unset and
> no device is subscribed — the Notifications page says so at the top rather than leaving you to
> conclude it. Each record says it too: a delivery that found no device reads `no-device` rather than
> nothing, and a console with no way to reach you at all raises that as a problem with its delivery,
> naming the category that reached nobody.

Every push carries the name of the console that sent it, after its title.
