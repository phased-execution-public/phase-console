## What the Runs home is

**Runs**, `#/runs`, is the home of the console. It answers one question in two seconds: does anything need
me? Its heading is the answer, one sentence of counts — *2 need you, Your turn (1), checkout-rewrite is
running — phase 3, 1 waiting, 4 phases ready, $41 today* — with every zero left out, except that it always
says what is running, even *Nothing running right now*. The header of every other page carries the same
words.

Under it, everything the console knows of sits in six groups, ordered by what it costs to ignore them:
**Your turn**, **Running**, **Waiting**, **Queued**, **Ready to start** and **Settled today**. Above the
groups the console puts only what is wrong with itself: *Claude Code is signed out*, *Nothing is driving
this phase* when the board reads a phase as in progress and nothing is working on it, and a line for a
repository whose GitHub jobs are not starting.

Old addresses still land here, at the matching group: `#/now`, `#/ready`, `#/pulse`, `#/queue`, and any
`?bay=`.

## The six groups

Most urgent first:

- **Your turn** — the acts only you can do, now: not runs, but the items of the **Your turn** page that
  wait on you, one line each, oldest first, with the first move on the line. Its heading offers **Open
  Your turn**, which says how many more are coming up. Empty, it says *Nothing needs you right now*, and
  when the console looks next.
- **Running** — a session is working: running, pausing, stopping or halting.
- **Waiting** — stopped or asleep: halted, parked or interrupted, frozen, or waiting on a usage window,
  outside work, the schedule or the network.
- **Queued** — in line for a scope or a lane, or paused or stopped by you.
- **Ready to start** — plans, not runs: the ready phases of every open plan.
- **Settled today** — over: finished, overtaken by a newer run of the plan, resolved, on a closed plan, or
  quiet for a week. It stays folded behind **Show 12 settled runs**, with *3 today, 1 dormant* beside it.

An item line draws the kind's mark, the title, the plan and phase it belongs to, and one button pressed
exactly as the console spells it — *Open sign-in*, *I've done this — check*, a permission's **Grant** — or
**Open on Your turn**, which opens the item's own card. A permission of low or medium risk is granted in
one press, at the narrowest scope it offers. A permission of high risk or one the console never grants,
and a choice between options, lead with **Open on Your turn** instead, because what they need — the rule
typed back, the reason it is never granted, the options side by side — is on the page. The **Your turn**
guide covers the page.

**Ready to start** rows show the phase and its plan, with up to two reasons: *frees 3 phases*, *on the
critical path*, *claimed by …*, *QA failed here before*. Six show, then **Show all 9 ready phases**. The
row's button is **Start**, which opens the launch for that one phase, or **Open phase** when another
session holds the phase or the console lacks `--allow-run`. Before it launches, the launch lists what the
run will need from you; **The launch door**, below, covers that.


## What puts a run in a group

A run's group is what it is, and one rule table decides it, so the page and the header cannot disagree.
The first rule that fits wins:

1. **Running**, if a session is working.
2. **Settled today**, if it is over.
3. **Queued**, if it waits for its scope, or you paused or stopped it.
4. **Waiting**, for everything else — a halted run included.

A run never sits in **Your turn** or **Ready to start**: those hold the asks themselves and the ready
phases. When something is asked of you about a run, its word turns amber where it stands and the ask joins
**Your turn**. A finished run that left a phase unsettled stays in **Settled today** and says so in red,
such as *1 failed*.

## One line per run

Each run is one line, and a line offers exactly one thing to press. It holds the status as a dot and a
word (**Running**, **Halted**, **Paused by you** — amber when it summons you, red when it is urgent), the
plan's name, which opens its **Run** view, its phases folded into a short track — *6 done ─ P7 running ─
28 left* — one clock, how many phases are done (`2/9`), what the run has cost, the action and a chevron.
The cost is the sum so far; the budget is in its hover, and the sum turns red past it. The clock is
labelled: `running 12m 03s`, `halted 12m 3s ago`, `queued 4m`, `wakes in 20m`, `ran 1h 04m`.

Under the line come only the things that hold it: a hold (*Held by …: nothing new boards until it is
released*), whoever the queue waits on, and one line on why it is slow or what it is doing: *Slow: machine
load 82 on 14 CPUs is above the guard (and 1 more).* or *On p6.task2 — wire the endpoint — about 20–35 min
left.*


The one action is chosen in this order:

| When the run | The one action |
|---|---|
| Stopped and is not recovering | The halt card's recommended way forward, such as **Recover & continue**, **Re-check** or **Retry from scratch**; **Open run** when none fits |
| Has a turn of yours open | The button of its oldest item, such as *Open sign-in*, *I've done this — check* or **Grant**, or **Open on Your turn** when the item needs the page |
| Is frozen, pausing or paused | **Thaw**, **Cancel pause** or **Resume** |
| Is running | **Pause**, at the next phase boundary |
| Is queued | **Hold**, or **Release** when it is held |
| Waits | The first recovery that fits, else **Pause** |
| Is settled | **Open run** |

Without `--allow-run` a line offers **Open run**, the one move no flag guards, unless it is your turn.

## Expand, inspect, and every run

The chevron, **Everything about** the plan, opens the line in place: the item's card when it is your
turn, the halt card, the lanes and when each was last heard, the queue's facts, **Phase N now** — the task
in hand, what it waits on, why it is slow, about how long is left — the clocks, the whole track, and every
verb the run takes: **Freeze**, **Pause**, **Hold**, **Bump**, **Board P7 first**, **Stop**, its priority.
**Inspect** at its foot puts the run in the panel, beside **Open run**. Runs remembers the lines you left
open.


The toolbar's **View** switches between **Groups** and **All runs** (`?view=all`), every run in one table:
plan, status, phases, spent, worked, why and updated, with **Everything** adding the run's id and model.
A row opens in place, and a resolved run offers **Resolve** and **Put the card back** there. **⋯** adds
the runs of closed plans.

## The words in the header

The header of every page carries the home's sentence in short: *3 need you*, *Your turn (1)*, *2 live* —
or *checkout-rewrite is running — phase 3* when exactly one run is live — *1 waiting*, *2 queued*, *4
phases ready*, *$41 today*. A pending permission counts as needing you. *Your turn (n)* counts only the
items waiting on you now, under **Do now** and **Needs one detail from you**, an errand and the step it
describes counting once; what is coming up, being checked or done is not in it.

On a desk each figure is a link — to its group, such as `#/runs?group=needs-you`, to `#/turn` for *Your
turn (n)*, and to **Insights** for the money — and a part that does not fit leaves whole, from the end. On a
phone the words are plain, on a row of their own, and the rail's **Runs** badge counts what needs you.

## The filter and the toolbar

The toolbar is the search (**Filter by plan**, which narrows every group), then **Filter**, **View**,
**⋯** and **Everything**. **Filter** holds nine lamps that count the stopped runs of each family:
**Decision**, **Accounts**, **Limits**, **Environment**, **Plan**, **Verification**, **External**,
**Conflicts** and **By you**. Press a lit lamp and the groups narrow to that family; press it again to let
go. A lamp with nothing behind it is dim, dashed, and cannot be pressed. **Halts** explains the families.
**⋯** holds **Freeze everything** and **Thaw everything**, with `--allow-run`.


## The queue

There is no queue page of its own: `#/queue` opens the **Queued** group. A queued run's line says whom it
waits on, and opening it says why — *queued — waiting on …*, *Also behind …*, *Held … ago by … —
release it to let this line move*, *Chained behind …* — and moves it: **Bump**, **Board P7 first**,
**Hold** and its priority. One phase's own place in line is in its **Actions**, in the panel: **Hold in
the queue**, **Release**, **Defer until…**, **Withdraw** and **Requeue at the front**, each with
`--allow-run`. Nothing is thrown away: a held phase keeps its age, and a withdrawn one can be requeued.
Settings ▸ Automation ▸ **The queue** decides how the line is ordered.

## The launch door

Before **Start** spawns anything, the launch says what the run will ask of you. When the plan declares acts
only a person can do — a sign-in, a code, a token — a box reads **This run will need you 3 times — 1
already done**. That box is the door. It lists the run's items, each drawn the way it will be on **Your
turn**: the kind's mark, where it can be done (**At the machine** or **Any device**), the phase and what to
do, and where its proof stands:

- **Done — its proof already holds.** The door ran the proof and it passed, so nothing is asked.
- **Needed — the proof read: …** Something is still missing, and the line says what the proof read.
- **Not checked — its proof could not be run here.**

**Do it now** opens a link in a new tab, or shows the command to copy. If an earlier launch has already
raised the item, **Do it now** opens that item on Your turn instead. **Check again** reads the door
again and runs every proof again. Do them now rather than at three in the morning.

A plan step marked `auto-open: host` opens by itself. The door shows its link whole first, and when you
launch, the console opens that link on the machine it runs on. It does so behind `--allow-terminal` or
`--allow-agent`. Under either flag the door says `Opens on this machine when you launch: <link>`. With
neither it says `The plan asks to open <link> on this machine at launch; this console was started
without --allow-terminal or --allow-agent, so open it yourself.` Only an `http` or `https` link opens,
and only a link the door showed: the launch sends back exactly those and no others. A resume promises
nothing, and nor does another phase's step on a launch of one phase. A step a session declares never
opens by itself.

## What the colours promise

**Amber means a person must act, and nothing else.** It comes only from an open item or from a word that
only a person can move — a sign-off owed, a sign-in, an outstanding decision — never from a status word
alone. A run that has only stopped reads **Halted**, **Parked** or **Interrupted** in the quiet waiting
paint until something is asked of you about it; then its word turns amber where it stands. An urgent ask is
red, not amber, and the lamps are never amber at all.

A phase the board calls **Stuck**, because its handoff is marked blocked, wears the waiting paint with an
alert glyph, not amber. It turns amber only when an errand asks you for something. Settled things lose
their colour and go quiet, and a mark breathes only while a session is seen working. Colour is never the
only carrier: the word is always there. **Reference** lists every status word under the state it reads as.

## On a desk and on a phone

- **Desk.** A run is one row: mark, name, track, clock, cost and action side by side. The header's words
  are links, and dim lamps keep their place in **Filter**.
- **Tablet.** The track takes a line of its own under the name, so its stations stay readable.
- **Phone.** A run's first row is its mark, its name and the chevron; the track and the facts follow, and
  its one action spreads across the foot, at least 44 px tall. The search stays on the toolbar and the
  rest folds into one **View** sheet, lamps and all. The header's words are plain, and **Runs** is the
  first tab.
