## What the Tower is

The Tower is the **Runs** page, `#/runs`, and the home of the console. It answers one question in two
seconds: does anything need me? Six bays, ordered by what it costs to ignore them, hold every run and
every phase ready to start, and one line in the header counts them on every page.

Above the bays come the asks that are a session waiting on you right now: the **Waiting on you** card
for permission requests and questions, a sign-in card when Claude Code is signed out, and **Nothing is
driving this phase** when the board reads a phase as in progress and nothing is working on it.

Nothing on the console draws a person’s ask in a shape of its own. The **Waiting on you** card, its
question card, the gate card and the errand card each draw the same row, one *item* of **Your turn**:
the kind’s mark, the title, the plan and phase it belongs to, one button pressed exactly as the console
spells it, and **Open on Your turn**, which opens the item’s own page, where everything else about it is
one press away. Which button leads depends on the item. A permission of low or medium risk is granted
in one press, at the narrowest scope it offers. A permission of high risk or one the console never
grants, and a choice between options, lead with **Open on Your turn** instead, because what they need
— the rule typed back, the reason it is never granted, the options side by side — is on the page. An
item that is still coming up, being checked or done offers only the link. A gate that is not a person’s
ask today — an `ai` gate, or a phase the board is not calling ready — keeps the plan’s own **Approve**.
The Your turn guide covers the page.

The Now page of earlier versions is gone: its inbox is **Needs you**, its lanes are **Live** and its Next
up is **Ready to start**. Old addresses such as `#/now` and `#/ready` still land on the Tower, at the
matching bay when there is one.

## The six bays

Most urgent first. A bay with nothing in it stays on the page as one line saying so, so the order never
moves under your eye.

- **Needs you** — a person must act. It holds runs, one strip each; urgent ones come first, then the
  oldest. The asks that belong to no run — a plan’s gate, a sign-in, an act still coming up — live on
  **Your turn**. One line at the foot of the bay gives that page’s counts, every item whichever run it is
  of, and links to it: *Your turn: 2 need you, 1 coming up — open the page*.
- **Live** — a session is working: running, pausing, stopping or halting.
- **Waiting** — stopped or asleep with nothing for you to do: halted, parked or interrupted with no open
  ask, frozen, or waiting on a usage window, outside work, the schedule or the network.
- **Queued** — in line for a scope or a lane, or paused or stopped by you.
- **Ready to start** — plans, not runs: the ready phases of every open plan.
- **Settled** — over: finished, overtaken by a newer run of the plan, resolved, on a closed plan, or quiet
  for a week. Folded until you press **Show 12 settled runs**, with *3 today, 1 dormant* beside it.

In the other bays the newest run comes first. **Ready to start** rows show the phase and its plan, with up
to two reasons as badges: *frees 3 phases*, *on the critical path*, *claimed by …*. With more than one row,
five buttons order them — **Last modified**, **Leverage**, **Critical path**, **Quick wins** and
**Unstick** — and your choice is kept. The row’s button is **Start**, which opens **Quick start**, or
**Open phase** when another session holds the phase or the console lacks `--allow-run`. Before it
launches, Quick start lists what the run will need from you; **The launch door**, below, covers that.


## What puts a run in a bay

One rule table decides, and the bays, the strips and the header line all ask it, so they cannot
disagree. The first rule that fits wins, so urgency beats everything:

1. **Needs you**, if a person has to act. That is a stop with an open item in the inbox, a wait only a
   person can end, or an item of **Your turn** open on the run — even while another lane is working.
2. **Live**, if a session is working.
3. **Settled**, if it is over.
4. **Queued**, if it is queued, waits for its scope, or you paused or stopped it.
5. **Waiting**, for everything else.

**Ready to start** is not a run’s bay; it lists phases the board reads as ready. A halted run with no
open ask sits in **Waiting**; when something is asked of a person about it, it moves to **Needs you**. A
finished run that left a phase unsettled stays in **Settled** and says so in red, such as *1 failed*.

## The strip

Each run in a bay is one strip, and a strip offers exactly one thing to press. Its left edge carries the
status paint. The top line holds the status word with its icon (**Running**, **Halted**, **Paused by
you**), a mark for how much you are needed (**Worth a look**, **Needs you** or **Urgent**), the plan’s
name, which opens the run page, and one labelled clock: `running 12m 03s`, `halted 12m 3s ago`,
`ran 1h 04m`. The second line holds the phases as a track, `2/5` done, what the run has cost against its
budget, and the action. **held** and **frozen** show as chips.

Under them a strip says what it waits on: a hold, a scope fence, one errand standing for several phases,
or whoever holds the lane or the branch. A live strip adds the last thing its session did and one line on
why it is slow or what it is doing: *Slow: machine load 82 on 14 CPUs is above the guard (and 1 more).*
or *On p6.task2 — wire the endpoint — about 20–35 min left.* Press the last-activity line for the
**Now** panel.


The one action is chosen by the bay:

| Bay | The one action |
|---|---|
| **Needs you** | The button of the run’s oldest item on **Your turn**, such as *Open sign-in*, *I've done this — check* or a permission’s **Grant**, or **Open on Your turn** when the item needs the page; else the halt card’s recommended recovery; **Open run** when none fits |
| **Live** | **Pause**, at the next phase boundary |
| **Waiting** | The first recovery that fits, else **Pause** |
| **Queued** | **Hold**, or **Release** when it is held |
| **Settled** | **Open run** |

A frozen run offers **Thaw**, a pausing one **Cancel pause** and a paused one **Resume**. Without
`--allow-run` a strip offers **Open run**, the one move no flag guards, unless it is a person’s turn.
Everything else is one press away under the chevron at the end of the strip: the halt card, the item’s
own card, the lanes, the **Now** panel, the clocks, every other verb, **Inspect** for the raw record,
and **Open run**.

## The line in the header

The header of every page carries the Tower’s numbers as one line: *3 need you*, *Your turn (1)*,
*2 live* — or *checkout-rewrite is running — phase 3* when exactly one run is live — *1 waiting*,
*2 queued*, *4 phases ready*, *$41 today*. They are the bays’ own counts, and a pending permission card
counts as needing you. Bays with nothing in them are left out, except **Live**: when nothing is running
the line says **Nothing running right now**. *Your turn (n)* singles out what only you can do: a sign-in,
a code, a look. It counts the items waiting on you now, under **Do now** and **Needs one detail from
you**, an errand and the step it describes counting once; what is coming up, being checked or done is
not in it.

On a desk each figure is a link to its bay, such as `#/runs?bay=needs-you`, *Your turn (n)* opens the
page itself, `#/turn`, and the money goes to **Insights**. A part that does not fit leaves whole, from
the end, so the money goes first. On a phone the line is plain words on a row of its own, and the
**Runs** tab carries the same count.

## Filter, lamps and the bar

The top row holds **Filter by plan**, which narrows every bay and is remembered, and a bar of the
console’s own state: `lanes 1/3` — lanes in use against the cap — a link reading **3 queued — see why**
(or **Queue** when nothing waits), whether boarding is open or closed, a usage window when one holds, and,
with `--allow-run`, **Freeze all** (**Thaw all** once frozen).

Under it, nine lamps count the stopped runs of each family: **Decision**, **Accounts**,
**Limits**, **Environment**, **Plan**, **Verification**, **External**, **Conflicts** and **By you**. Press
a lit lamp and the bays narrow to that family, with a line reading *Showing only …* and **Clear the
filter**; press it again to let go. A lamp with nothing behind it is dim and cannot be pressed. **Halts**
explains the families.


## The queue page

**3 queued — see why** opens the queue page, `#/queue`. It lists every phase waiting for a lane in the
order it will board: **Place**, **Phase**, **Why here**, **Waits on**, **Class**, **Waiting since** and
**Account**. *Why here* is the rule that put it there — *after its dependency*, *moved ahead*, *first
come, first served* — and *Waits on* names who holds what. A row opens to show every rule that placed
it. The **Live lanes**, the phases **Asked to board, not queued yet**, the **Withdrawn** ones and a
**Recent changes** strip sit around the table.

With `--allow-run` a **Change** column adds **Move ahead**, **Hold**, **Defer 1 h** and **Withdraw**; a
held or deferred phase offers **Release**. A **Why** field at the top records your reason with every
change. Nothing is thrown away: a held phase keeps its age, and a withdrawn one offers **Re-queue**.

## The launch door

Before **Start** spawns anything, **Quick start** says what the run will ask of you. When the plan
declares acts only a person can do — a sign-in, a code, a token — a box reads **This run will need you 3
times — 1 already done**. That box is the door. It lists the run’s items, each drawn the way it will be
on **Your turn**: the kind’s mark, where it can be done (**At the machine** or **Any device**), the phase
and what to do, and where its proof stands:

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
nothing, and nor does another phase’s step on a launch of one phase. A step a session declares never
opens by itself.

## What the colours promise

**Amber means a person must act, and nothing else.** It comes only from an open item in the inbox or from
a word that only a person can move — a sign-off owed, a sign-in, an outstanding decision — never from a
status word alone. A run that has only stopped reads **Halted**, **Parked** or **Interrupted** in the
quiet waiting paint until an ask is open about it; then it turns amber and moves to **Needs you**. An
urgent ask is red, not amber, and the lamps are never amber at all.

A phase the board calls **Stuck**, because its handoff is marked blocked, wears the waiting paint with an
alert glyph, not amber. It turns amber only when an errand asks you for something. Settled things lose
their colour and go quiet, and a badge breathes only while a session is seen working. Colour is never the
only carrier: the word and the icon are always there. **Reference** lists every status word under the
state it reads as.

## On a desk and on a phone

- **Desk.** Strips sit two to a row on a wide screen, the header line is a row of links, and dim lamps
  stay in place, dashed, so the row does not jump.
- **Phone.** Strips stack, and a strip’s one action spreads across its foot with the chevron beside it,
  at least 44 px tall. Dim lamps give up their row, so the lit ones take less room. The header line is plain
  words, and **Runs** is the first tab, carrying the same count.
