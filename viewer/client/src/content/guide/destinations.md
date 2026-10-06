## Runs — does anything need me?

**Runs** is the home page, also called the Tower. Its bays run in the order of what it costs to ignore
them: **Needs you**, **Live**, **Waiting**, **Queued**, **Ready to start** and **Settled**. Each run is
one strip with the one button that fits where it sits. When **Needs you** is empty, nothing is waiting
on you. The **Tower** guide walks through each bay.

A line across the top of every page counts the same things, and on a desk each figure links to its bay.
On a phone the rail becomes a tab bar with **Runs** first, and **More** holds the pages the bar leaves
out, under **The work**, **The record** and **The console**.

## Plans — where does each plan stand?

**Plans** lists every plan in this source with its progress, the phases ready to start and anything
waiting on you. **Find a plan** filters it; **Recent**, **Closest to done**, **Most ready**, **Needs
attention** and **Name** order it; cards or a table show it. Closed plans wait in a **Closed plans** fold
and **Documents** stay hidden until you turn them on. **New plan** needs `--allow-writes` and **New plan
with AI** needs `--allow-agent`.

A plan opens on three tabs. **Phases** is every phase in one table, in four views: **Table**, **Map**,
**QA** and **Handoffs**. **Autopilot** is this plan's run: start it there (the console needs
`--allow-run`), then watch and steer it. **Source** is the plan file, as **Reading** or as **Markdown**.
On a phone, **Plans** is on the tab bar.

## Sessions — what is running, and can I get at it?

**Sessions** lists every process this console owns or can see, in four groups: **Autopilot lanes**,
**Agent sessions**, **Shells** and **Other sessions on this machine**. Search by name, directory or id.
Open a session for its terminal; one this console only knows about offers to resume it. **New session**
starts an agent and **New shell** a plain shell, and they need `--allow-agent` and `--allow-terminal`.
**Locks** lists every phase claim and who holds it. With neither flag, Sessions is missing from the rail
and lanes still show on **Runs**. On a phone it is on the tab bar when offered.


## Repo — what did the work do to the tree?

**Repo** shows what the work did to your repositories. A card at the top gives the checked-out branch,
its ahead and behind counts, and what is uncommitted under `docs/`. Pick a **Repository** when there is
more than one, then a section. On a phone, **Repo** is under **More**, in **The record**.

- **History** — commits and the lanes they were committed on.
- **Branches** — every local branch, what claims it, and how far it has diverged.
- **Working trees** — where the parallel work is, and what is left over from work that ended.
- **Changes** — what changed between any two points, one file at a time.
- **Settles** — how each run's work reached the trunk, or why it did not.
- **Issues** — the Issues desk: a repository's whole issue list, each issue with its category, severity and plan status. Every column sorts, and the filters and the sort live in the URL. Add any GitHub `owner/name` to read it beside your own repositories. Tick some to **Author a plan from N issues** (needs `--allow-agent`).

The desk reads each issue's words off its labels. Its category is a bug, an enhancement, documentation,
a question or other. Its severity comes from a `severity:` label: critical, high, medium or low, or
none. Its plan status says where it stands: it needs a plan (`awaiting-plan`), it is planned in a plan
and phase (`plan:<slug>`), it is deferred (`plan:<slug>-deferred`) or it is fixed (closed with a plan
label). A repository you add is read-only and marked *outside this console*.


## Insights — how long, how much, how fast?

**Insights** answers the questions about time and money, in bands from top to bottom: **How long is
left**, **What it costs** (today's spend against the caps), **What each session cost**, **How fast**,
**Who was asked**, **What shape the work is in** and **On what**. It opens on **Every plan**; pick one in
the selector at the top and the address becomes `#/insights?plan=<slug>`, with **What this plan cost** and
**This plan's record** added. On a phone it is on the tab bar; if the bar does not show it, open **More**,
under **The record**.

## Debug — what did the console see?

**Debug** is where you go when something already went wrong, so it carries no badge. On a phone, it is
under **More**, in **The record**. Its sections:

- **Logs** — every log the console writes, on one time axis.
- **Journal** — one run drawn as it happened, and why a phase is not done.
- **Delivery** — what happened to each announcement, per device.
- **Health** — the doctor's checks, this process and the metrics, and a redacted **Download bundle**.
- **Access** — who this console has served: this machine, and every phone that reached it.


## Settings — what may this console do, and as whom?

**Settings** opens on an index of sections, from what everyone needs to what only an unattended console
does. Each has an address, `#/settings/<section>`, so a note can link to one, and the palette finds one by
what is inside it: `⌘K quiet hours`. On a phone, **Settings** is under **More**, in **The console**.

- **Essentials** — what the console reads, how it is started, what it may do, and the keys.
- **Appearance** — theme, density, and how the terminal paints.
- **Automation** — the values every launch opens with, and the ladder's caps.
- **Notifications** — every kind the console announces, and where each one lands.
- **Accounts** — which account a session runs as, and its usage.
- **MCP servers** — the servers a session may reach.
- **Permissions** — what a session may run without being asked.
- **This instance** — which console is running, how it is reached, and how to restart or stop it.


## Palette — go anywhere, find anything, run a verb

The palette is one box that takes you to any page, plan, phase or run, searches the text of every plan
and handoff, and runs a verb. Press ⌘K (Ctrl+K elsewhere) from anywhere, even while you type, or `/`
when nothing has your typing. On a desk the **Search or jump to…** field in the header opens it; on a
phone it is the magnifier in the top bar. `?k=<text>` in the address opens it with that text typed in.

Rows come in groups: **Go to** (every page, and **Help**), **Plans**, **Runs**, **Settings** and **Do**,
with **In the documents** for text hits. **Do** offers only what this console may do, and **Freeze the
whole console…** and **Shut this console down…** only take you to the page where the button and its
confirm live. Enter opens a row; Esc, or ⌘K again, closes the palette.

## Bell — what needs you, and what was said

The bell in the header opens a drawer titled **Inbox**, with two panels. The number beside the bell counts
unread announcements. A hand beside it appears while a session is stopped waiting for an answer.

**Needs you** holds the same rows as the Tower's **Needs you** bay, so an answer given here clears the row
everywhere. **Announcements** is the log of what the console has said, and each row says what became of
it: sent to N devices, held by quiet hours, or not delivered. **Unread only** and the category chips
narrow it; opening a row takes you to its subject and marks it read. **Mark all read** zeroes the count,
and **Clear read** and **Clear all** delete records. `?bell=1` opens the drawer. On a phone the bell is in
the top bar.

## Help — this guide, over any page

Help is this guide, and it opens over the page you are on, so you can read how something works without
leaving it. A row of sections runs across the top: **Concepts**, **Quick start**, **Launch**, **Getting
around** and the rest. Each section is cards you open and close.

On a desk, press ⌘K, type `help` and press Enter. On a phone, open **More** and press **Help**. Any
address can carry `?help=<section>`, such as `?help=destinations`, and **Link to this card** gives a
card its own address. Esc closes it.

