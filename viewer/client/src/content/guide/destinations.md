## Runs — does anything need me?

**Runs** is the home page, `#/runs`, and it answers that question first. Its heading is one sentence, the
situation, and under it everything is grouped by what it costs to ignore: **Your turn**, the acts only you
can do, each one line with its first move; then **Running**, **Waiting**, **Queued**, **Ready to start** and
**Settled today**, which stays folded behind **Show N settled runs**. Each run is one line: its status, its
name, its phases as a short track, one clock, what it has cost, and the one action that fits where it sits.
**Groups** and **All runs**, at the top, switch between the groups and one table of every run. The **Runs
home** guide walks through each group.

Expand a run's line (**Everything about** the plan) for its halt, its lanes and what it is doing now;
**Inspect** in the open line puts the run in the panel; **Everything** shows every fact on every line.

The header carries the same counts on every page, and leaves out what is zero: *2 need you*, *Your turn
(1)*, *checkout-rewrite is running — phase 3*, *1 waiting*, *4 phases ready*, *$41 today*. On a desk each is a
link to its group, the page or **Insights**; on a phone they are plain words on a row of their own.

On a desk the rail down the side holds the eight places in three groups — **Runs**, **Your turn**,
**Plans**, **Sessions**; **Repo**, **Insights**, **Logs**; **Settings** — with the **Switcher** above them and
**Help** and the usage meter at its foot. On a phone the rail becomes a tab bar: **Runs**, **Your turn**,
**Plans**, **Sessions** and **More**. **More** holds the rest: **Repo**, **Insights** and **Logs**, then
**Settings**, then **Help** for the page you are on, the usage limits, and whether this console may write.


## Your turn — what only you can do

**Your turn**, `#/turn`, is every act only you can do: a sign-in, a code, a secret, a payment, an
approval, a decision, an errand at the machine. It is second in the rail, after **Runs**, and its badge
counts what needs you now; **Runs** carries no count of its own. The page opens on what is open, one line
per item, and its tabs hold what is done and what the AI handled on its own. Press a line and its whole
card opens in the panel, with its steps, its check and its one button. **View** draws the items as a
**List**, a **Board**, **Cards** or a **Timeline**; **Group**, **Sort** and the filters narrow them, and
every choice is part of the address.

A plan has the same page as one of its views, **Your turn**, at `#/plan/<slug>/turn`, narrowed to that
plan. The **Your turn** guide walks through the page and every item on it.

## Plans — where does each plan stand?

**Plans** lists every plan in this source, one line each: its status, its name, its line of phases, what
is running now, what it waits on, the phases next up, its items on **Your turn**, the sessions left with the
estimate, what its runs have spent, the account that pays and the model, and when it last moved. A desk that
cannot fit them all scrolls the table sideways, and the status and the name stay put while it does. Search
it; **Filter**, **Group**, **Sort** and **View** narrow, group, order and draw it, as a **List** or as
**Cards**; closed plans and documents wait in folds that give their counts. **New plan** offers three ways
to begin one: **Write it with AI** (needs `--allow-agent`), **Scaffold from the template** (needs
`--allow-writes`), and **Plan from issues**, which opens the Issues desk at the issues that need a plan.

Every status says why. Press **Why** beside a plan's status and the panel opens on the reasons behind the
word: what needs you, each item with the way to it on **Your turn**; what stopped its run, as the stop's
own card with its one recommended recovery; which phases are running, and since when; what it waits on, and
until when — a usage window and its reset, its place in the queue, another session's claim, the phase before
it, a gate that clears by itself; what can start next; and, for a plan that is over, how it ended. Under the
reasons the plan's phases stand in their own order, and every fact about the plan follows.

A plan opens on its glance: the title, its status, its line, what is left and what it costs, and the one
act that fits, such as **Start phase 1** when nothing is running. Under it, four views, each an address:
**Phases** (as a **Table**, a **Map**, **Handoffs & QA** — each phase's handoff and its QA side by side — a **Schedule** or a **Burn-up**), **Run** (this plan's run, `#/plan/<slug>/run`:
start it, watch it and steer it — the console needs `--allow-run` — and **History**, its earlier runs),
**Your turn** (this plan's acts only you can do, `#/plan/<slug>/turn`, with how many are open) and
**Source** (the plan file and its handoffs). A phase's **Details** opens it in place, **Inspect phase N** puts it in the panel, and
**Everything** shows every column of the table.

A plan's line is a pipeline drawn to scale: every phase a cell in its share's colour, each stretch as wide
as its share of the plan, and the share done as a badge at its end, *35 %*. Under it every share is a badge
in the colour of its stretch — *12 done*, *1 held by QA*, *2 in progress*, *1 stuck*, *3 next up*, *9
waiting*, *2 gated* — and what is left is said in words, *4 left*. A closed plan's line says what never ran
instead: *30 done*, *4 never ran*. Where a plan's or a phase's status
is a row's headline — the Plans list and cards, the plan's header, the Phases table, the Run view's phase
rows and Sessions — it is drawn as a badge: the status's icon and word in its colour, inside an outline,
with no fill.

## Sessions — what is running, and can I get at it?

**Sessions** lists every process this console owns or can see, by kind: the lanes of a run, the agent
sessions and shells opened here, and the other Claude sessions on this machine. Search it by name, directory
or id; open one and it takes the whole page, `#/sessions/<id>`, terminal and all, and one this console only
knows about offers to resume it. **New session** starts an agent and **New shell** a plain shell; they need
`--allow-agent` and `--allow-terminal`, and with neither flag **Sessions** leaves the rail and the lanes
still show on **Runs**. **Locks**, beside **Sessions** at the top, is every phase claim and who holds it,
at `#/sessions/locks`, and its **Map** (`#/sessions/locks?view=map`) draws each claim as a bar on its
repository's lane, from when it was claimed to the end of its lease. A session's **Details** opens it in
place, **Inspect** puts it in the panel, and **Everything** adds every column.

## Repo — what did the work do to the tree?

**Repo** shows what the work did to your repositories. The sentence under the title gives the
checked-out branch, how far it is ahead and behind, and what is uncommitted under `docs/`. Pick a section;
each is an address, such as `#/repo/branches`, and when there is more than one repository its **Filter**
offers a **Repository**, which the other sections keep.

- **History** — the commit graph, with the lanes the commits were made on.
- **Branches** — every local branch, what claims it, and how far it has drifted.
- **Working trees** — where the parallel work is, and what is left over from work that ended.
- **Changes** — what changed between two points, one file at a time.
- **Settles** — how each run's work reached the trunk, or why it did not.
- **Issues** — the Issues desk: a repository's whole issue list, each issue with its category, severity
  and plan status. The filters and the order live in the address. **Add a repository**, under **⋯**,
  reads any GitHub `owner/name` beside your own. Pick some to **Author a plan from N issues** (needs
  `--allow-agent`).

The desk reads each issue's words off its labels. Its category is a bug, an enhancement, documentation, a
question or other. Its severity comes from a `severity:` label: critical, high, medium or low, or none. Its
plan status says where it stands: it needs a plan (`awaiting-plan`), it is planned in a plan and phase
(`plan:<slug>`), it is deferred (`plan:<slug>-deferred`) or it is fixed (closed with a plan label). A
repository you add is read-only and marked *outside this console*. On the desk an issue's line opens in
place, its title puts it in the panel, and **Everything** adds every column.


## Insights — how long, how much, how fast?

**Insights** answers the questions about time and money, one under another: how long is left, what it
costs, what each session cost, what a session may spend, how fast the work goes, how this week went, who
was asked, what shape the work is in, and on what. It reads every plan until you pick one in the toolbar's
**Plan** filter (on a phone, in the **View** sheet); the address then becomes `#/insights?plan=<slug>`, and
the plan's own cost and record join the page. **Everything** opens every fold; under **What it costs**, a
run's line opens its **Details**, and **Inspect** there puts its spend against its budget in the panel.


## Logs — what did the console see?

**Logs** is every log this console writes, with the journal, delivery and health beside them. It is where you
go when something already went wrong, so it carries no badge, and the old address, `#/debug`, still lands
here with its section and its filters. Each section is an address, `#/logs/<section>`:

- **Logs** — every log the console writes, on one time axis, with its live tail and the level it writes at.
- **Journal** — one run drawn as it happened, and why a phase is not done.
- **Delivery** — what happened to each announcement, per device.
- **Health** — the doctor's checks, this process, the automatic starts this hour, stray consoles, the
  metrics, and **Download the bundle**, everything above redacted into one file.
- **Access** — who this console has served: this machine, and every phone that reached it.


A log line opens in the panel, a delivery record opens its **Details** in place, and **Everything** shows
every column.

## Settings — what may this console do, and as whom?

**Settings** opens on an index: one sentence that counts the settings set here and by the machine
profile, then its sections, each an address, `#/settings/<section>`, so a note can link to one. **Find a
setting**, at the top of every Settings page, answers with sections and single settings alike, each setting
with its control: `quiet hours` finds the place and the switch.

- **Essentials** — what this console reads, what it may do, and the line that starts it.
- **Appearance** — how the console looks in this browser, and what the lists show. Its **Palette** is
  **Quiet**, 7.0's room, or **Departures**, the 6.x room: a grey-blue page under white cards, with drawn
  rules. The status colours are the same in both.
- **Automation** — what every launch opens on, how far the console repairs by itself, and when work may start.
- **Notifications** — what the console announces, where each kind lands, and when your turns are said again.
- **Accounts** — which account a session runs as, its usage, and what happens at a wall.
- **MCP servers** — the servers a session may reach, and the catalog to add from.
- **Permissions** — every grant and what it changed, the owner keys, and what a session may run unasked.
- **This instance** — which console is running, how it is reached, and how to replace or stop it.
- **Everything** — every setting this console stores, where its value came from, and the line that
  changes it: its value or a control, its default, its origin and **Reset**.

On **Everything**, a setting's **Details** opens it in place and **Inspect** puts it in the panel.


## Three doors — expand, inspect, Everything

Every place above is one column of one-line rows, and every place opens the same three doors to what a
line leaves out. Nothing the console knows is left off; each fact is within two presses.

- **Expand** opens a row where it stands — **Show details** on most rows, **Everything about** the plan
  on a run's — and a fold names what it holds, with a count while it is shut. Runs remembers the lines you
  left open, and a run's page its folds.
- **Inspect** puts the record in the **Panel**, beside the page, so it stays in view while you work: its
  **Overview**, the **Actions** you may press on it, its **History** and the **Raw** record.
- **Everything** is a switch at the end of the page's toolbar. On, the page shows every column, every fact
  and every folded section instead of the essentials. Each page keeps its own, in this browser.

The toolbar is one row in the same order on every page that lists things: the search, then **Filter**,
**Group**, **Sort**, **View**, **⋯** (**More actions**) and **Everything** — a page draws only the ones it
has. On a phone the search stays on the bar and the rest fold into one **View** button, whose sheet holds
them all with **Everything** last.

## Switcher — which console is this?

The switcher at the top of the rail names this console. Press it for its menu: **This console** first,
with the directory it reads, then **Other consoles on this machine** when there are any, each with whether
it is running and its port; pressing one opens that console in this tab. **Open another source here** comes
last, with the sources opened recently and **Browse for a directory…**. A console started for one source
says so there instead, and names the command that gives another source a console of its own. On a phone
the switcher sits at the start of the header.


## Panel — the details beside the page

The panel is where **Inspect** puts a record. At 1200 px and wider it is a column beside the page that
stays open as you move between pages, until you close it with its × or ⌘I (Ctrl+I elsewhere): drag its
edge, or focus the edge and press ← or →, to set a width from 320 to 640 px. From 900 to 1200 px it is a
sheet over the page, and on a phone a sheet that rises from the bottom; Esc or a tap outside closes either.
This browser remembers whether it was open, how wide and in which mode.

It shows **Details**: the record you picked, on the tabs **Overview**, **Actions**, **History** and **Raw**,
with only the tabs the record has something for. **Actions** lists every verb that applies to the record —
a press, then **Confirm** — and a verb this console lacks the switch for says which: *Needs --allow-run on
this console.* A phase's actions include its place in the queue. With nothing picked it says so, and asks
you to pick a row.


## Palette — go anywhere, find anything, run a verb

The palette is one box that takes you to any page or plan, finds the ready phases, the runs, the settings
and the text of every plan and handoff, and does what the console can do. Press ⌘K (Ctrl+K elsewhere) from
anywhere, even while you type, or `/` when nothing has your typing. On a desk **Search or jump to…** in the
header opens it; on a phone it is the magnifier in the header. `?k=<text>` in the address opens it with that
text typed in.

Rows come in groups: **Go to** (every place, **Your turn** among them, and **Help**), **Plans**, **Runs**, **Settings**
(**Everything** among them), **Do** and **In the documents**. **Do** lists every verb the console has for what
the address names — the plan, the phase, the lane — and a verb this console lacks the switch for is drawn
dim with the switch it needs. An act on the record takes a second press to confirm; a verb that needs more
from you, such as a note, opens where it is drawn; a row that is a terminal line copies it. Enter opens a
row; Esc, or ⌘K again, closes the palette.

## Bell — what needs you, and what was said

The bell in the header opens a sheet titled **Inbox**, with two panels. The number beside the bell counts
unread announcements.

**Needs you** is a preview of **Your turn**. **Open Your turn** sits at its top, then at most five of the
asks, one line each — the sessions asking you first, then the rest — and *N more on Your turn* when more
wait. An answer given here clears the row everywhere. **Announcements** is the log of what the console has
said, newest first, and each row says what became of it: *sent to 2*, *held by quiet hours*, *no device*.
**Unread only** and the category chips narrow it; opening a row takes you to its subject and marks it read;
a row that carries buttons answers in place. Tick records, then **Mark read**, **Put back**, which marks
them unread again, or **Delete**, which deletes them. **Mark all read** zeroes the count, and **Clear
read** and **Clear all** delete records. `?bell=1` opens it. On a phone the bell is in the header too.

## Help — this guide, over any page

Help is this guide, and it opens over the page you are on, at that page's own part, so you can read how
something works without leaving it: over Runs, the **Runs home** guide; over a plan, **A run**; over a place
with no guide of its own, this one, at its card. A row of sections runs across the top: **Concepts**,
**Quick start**, **Starting up**, **Getting around** and the rest, and each section is cards you open and
close. Under the first line, **What this page reads and presses** lists what the page asks of the console.

On a desk press **Help** at the foot of the rail; on a phone, open **More** and press **Help**. Any address
can carry `?help=<section>`, such as `?help=destinations`, and **Link to this card** gives a card its own
address. Esc closes it.
