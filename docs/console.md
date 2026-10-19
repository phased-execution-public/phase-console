# 🚉 Phase Console

> *The whole plan library in one page.*

```bash
phase-console                      # installed as a plugin, or from a clone — from anywhere
./start                            # cloned — from the folder
./start ~/code/your-repo           # skip the picker
./start --allow-writes             # plus the guarded write verbs
./start --allow-run                # plus the autopilot

phase-console install-skill        # copy the skill where Claude Code reads it
```


*(First time on a machine: the client is built output — `cd viewer && npm ci && npm run build`, or
let the console's own page tell you.)*

A plan library outgrows a terminal: dozens of plans, hundreds of phases, hundreds of handoff files —
and the engine answers for exactly one plan at a time. The console is the portfolio view: what is
ready **right now** across every plan, which lock is holding what, which plan has stalled, how much
work is left, and whether a plan's graph even lints.

The console is **eight destinations** in three bands, the same eight in both editions: **the work** —
Runs (the home), Your turn, Plans and Sessions; **the record** — Repo, Insights and Logs; and **the
console** — Settings. Around them sit a palette, a bell, a help sheet and a panel beside the page.
**Your turn**, the page for every act only a person can do, was a head under Runs until 8.0 (one-pool
phase 14, #377) made it a destination of its own. Every older address still resolves —
a bookmark, a handoff link or a push notification minted by an earlier version lands where its page
went, in one hop, keeping whichever half of the address still means something: `#/now` on Runs,
`#/debug` on Logs, `#/approve` on Your turn — and, in the free edition, `#/queue` on the Runs home's
**Queued** group.

| Destination | Answers |
|---|---|
| **Runs** | *Does anything need me?* The home (`#/runs`, and any empty or unknown address). Its heading is the situation in one sentence — *2 need you, Your turn (1), checkout-rewrite is running — phase 3, 1 waiting, 4 phases ready, $41 today*, every zero left out — and the header carries the same words on every other page, each figure a link on a desk to its group, to Your turn or to Insights. Under it, everything sits in six groups, ordered by what it costs to ignore: **Your turn** (the items waiting on you, each with its first move), **Running**, **Waiting**, **Queued**, **Ready to start** (every open plan's ready phases, each with up to two reasons it matters — *frees 3 phases*, *on the critical path*) and **Settled today**, folded. Above the groups the console puts only what is wrong with itself: Claude Code signed out, a phase nothing is driving, a repository whose GitHub jobs are not starting. A run is one line — its status as a dot and a word, the plan, its phases as a short track, one clock, what it has cost — with exactly one action, chosen by where it sits: the halt card's recommended way forward, the button of its oldest item, **Thaw**, **Resume**, **Pause**, **Hold** or **Release**, else **Open run**. Its chevron opens the line in place — the halt card, the lanes and when each was last heard, the queue's facts, what **Phase N now** is doing and about how long is left, and every verb the run takes — and **Inspect** puts the run in the panel. **All runs** (`?view=all`) is every run as one table. `?group=` opens a group (`?bay=`, the 6.x word, still lands), and the **Filter** lamps narrow the groups to one family of stop. A run's own record is the plan's **Run** view. |
| **Plans** | *Where does each plan stand?* Every plan in this source, one line each — its status, its name, its line of phases, the sessions left and when it last moved — drawn as a **List** or as **Cards**, with closed plans and documents in folds. **New plan** writes one with AI (`--allow-agent`), scaffolds one from the template (`--allow-writes`) or plans from issues. A plan (`#/plan/<slug>`) opens on its glance — its status, its line, what is left and what it cost, and the one act that fits — over four views, each an address, under whatever is wrong with the plan now (a stopped run, stuck phases, a failing lint). **Phases** is one table of every phase — its state, gate, claim, QA and handoff among its columns — as a **Table**, a **Map**, **QA** or **Handoffs**; a row opens in place onto why the phase is where it is and what moves it (its evidence, the notes earlier phases left, the issues its sessions filed, every way forward), and the view says what boarding will find wrong with each §Verification before a run exists. **Run** (`#/plan/<slug>/run`, the verbs behind `--allow-run`) is the run's glance — its row, the halt card, the one recommended move, the lanes with their clocks — over folds: the phases with this run's record, **Sessions and their consoles**, the journal, **What the ladder tried**, the §Verification runs, the triggers, **Where the time went**, **Why it started and what it cost** (every start's door, trigger, guard and who asked, beside what the start door resolved; one row per session with its caps and who ended it, reconciled against the run's own spend — reconciled means within $0.01 (`LEDGER_GAP_USD`) with every session's cost known; a session that never reported reads *unknown*, never $0; a rung's cost is its session's, shown beside the total and never added — over `GET /api/run/<slug>/ledger`), the notes, the checkout, the ways forward and the raw record; `?view=history` lists the plan's earlier runs. **Your turn** (`#/plan/<slug>/turn`) is the Your turn page scoped to the plan. **Source** is the plan file and its handoffs. |
| **Sessions** | *What processes exist?* One list, by kind, for autopilot lanes, agent sessions, shells and the other Claude sessions the presence hook reports — and one page per session, `#/sessions/<id>`, with the phone-first browser terminal. A session this console holds a pty for opens straight into it; a session it merely *knows about* offers to **Resume** it, or to **Take over** while it is live, behind a confirm, and then it has a pty too. A hook-reported session that has ended reads `ended`, or `ended · inferred` when the probe concluded it from a process that was gone; a session a run started shows the door that started it and how it ended, read from the run's own ledger. **New session** and **New shell** need `--allow-agent` and `--allow-terminal`; with neither, Sessions leaves the rail and the lanes still show on Runs. **Locks** (`#/sessions/locks`) is every phase claim and who holds it. |
| **Repo** | *What did the work do to the tree — and which of several trees?* Six sections, each an address: History (`#/repo`, the commit graph with the lanes the commits were made on), Branches, Working trees (the reclaim surface: a tree the console made that no surviving run record claims), Changes (any range, a file at a time), Settles (how each run's work reached the trunk, or why it did not) and Issues — the first five over `GET /api/repo/…`, the sixth over `GET /api/issues`: the Issues desk, a repository's whole issue list with each issue's category, severity and plan status, the filters and the order in the address, any GitHub `owner/name` added under **⋯** read-only beside your own, a pick that authors a plan from its issues (`--allow-agent`), and each repository's freshness (`fresh` · `stale` with its age · `unknown` with the reason) beside its rows. On a superproject every initialised submodule is a repository of its own here: the **Filter**'s **Repository** lists each by its root-relative path (the plan's scope token), and the working-trees registry spans them all, each row naming its repository. The sentence under the title is the glance `/api/state` reports: the branch, its ahead/behind counts, and what is uncommitted **under `docs/`** — the only corner that read covers (`server/git.ts` `repoInfo` scopes its `git status` there), which is why the sentence names it. |
| **Insights** | *How long, how much, how fast?* One question under another: **How long is left** (the estimate and the basis under it), **What it costs** (settled spend against the caps), **What each session cost** (`LedgerSummaryPanel`: every open plan's newest runs per plan and per account, summed from each session's own line over `GET /api/ledger`, a session with no reported cost counted apart), **What a session may spend**, **How fast** (the velocity trend and the completions calendar), **This week**, **Who was asked** (the cards this console raised for a person, the asks auto-grant answered, and since when), **What shape the work is in** and **On what** (the repos, skills and models the work runs on). Portfolio-wide, or scoped to one plan with `?plan=` — which adds what that plan cost phase by phase, with **Copy as CSV**, its QA record, and a finish date with the basis under it. The same numbers are scrapeable at `/api/metrics` ([docs/metrics.md](metrics.md)). |
| **Logs** | *What did the console see?* Every log this console writes on one time axis, with its live tail and the level it writes at (`#/logs`) — the run journals, the watch scheduler's decisions, the health record and every refused tool call, filterable by time, run and phase — and beside it, each at `#/logs/<section>`: **Journal** (one run drawn as it happened, and why a phase is not done), **Delivery** (what happened to each announcement, per device), **Health** (the doctor's checks, what this process is running as, the automatic starts this hour, stray consoles and the metrics) and **Access** (who this console has served: this machine, and every phone that reached it). It carries no badge: it is where you go when something already went wrong. `#/debug[/<section>]` lands on its section with its filters. `GET /api/debug/bundle` hands the same picture over as one redacted JSON snapshot sized for a context window — **Download the bundle**, on Health. |
| **Settings** | *What may this console do, and as whom?* An index, then nine addressed sections ordered minimal → advanced — Essentials, Appearance, Automation, Notifications, Accounts, MCP servers, Permissions, This instance and **Everything**, every key the console stores (`GET /api/prefs/schema`) with its value or a control, its default, where its value came from and **Reset** — each at `#/settings/<section>`, so a setting can be linked to from a handoff, a guide page or a note. **Find a setting**, at the top of every Settings page, answers with sections and single settings alike, each setting with its control (`quiet hours` finds the place and the switch), and the palette finds them too. The pre-4.0 ids `general`, `alerts` and `process` redirect. |


**Your turn** (`#/turn`, one item at `#/turn/<id>`) lists every act only a person can do — a sign-in,
a code, a secret to put in place, a payment, a permission the AI lacks, a decision, an errand at the
machine — each one item that says why only you fit it, which plan, phase and run waits on it, what it
unblocks, the guide to follow and how it will be checked, in six groups: **Approve**, **Do now**,
**Decide**, **Being checked**, **Coming up** and **Done**, with **Handled by the AI** and
**Heads-up** as sections after them. Its tabs are **Open**, **Done**, **Handled by the AI** and
**All** (`?tab=`), its views a list, a board, cards and a timeline (`?view=`), and it groups by when
asked, plan, type, deadline or status (`?group=`). *I've done this — check* runs the item's proof and
comes back passed, or sent back with exactly what to redo; *Send my decision* sends a decision's
answer and then checks it against its proof; an item bound to a gate closes when the gate opens; and a
proof whose script is missing reads **Cannot run** rather than failing you. The situation line, the
bell and the Runs home's **Your turn** group lead there, and every plan has the same page as its
fourth view.

**Three doors to depth, on every page.** Each place is one column of one-line rows, and every row
opens the same three doors to what the line leaves out: **expand** opens it where it stands, and Runs
remembers the lines you left open; **Inspect** puts the record in the panel — its **Overview**, the
**Actions** you may press on it, its **History** and the **Raw** record; and **Everything**, the last
switch of a page's toolbar, shows every column, fact and folded section, kept per page in this browser.
The toolbar is one row in the same order on every page that lists things — the search, **Filter**,
**Group**, **Sort**, **View**, **⋯** and **Everything** — and on a phone the search and one **View**
sheet holding the rest.

**The shell.** On a desk a rail down the side holds the switcher (this console, the other consoles on
this machine, and **Open another source here**), the eight destinations, and **Help** and the usage
meter at its foot; the header holds the page's title, the situation words, search (⌘K) and the bell.
On a phone the rail becomes a tab bar — **Runs**, **Your turn**, **Plans**, **Sessions** and **More**
— and **More** holds the rest. The panel, where **Inspect** puts a record, is a column beside the page at 1200 px and
wider, a sheet over it from 900 to 1200 px and a sheet that rises from the bottom on a phone; ⌘I opens
and closes it, and this browser remembers whether it was open, how wide and in which mode.

Riding on every page, on the query string rather than as pages of their own:

| Overlay | What |
|---|---|
| **⌘ K palette** | `?k=`: one box that goes anywhere, finds anything and does what the console can — **Go to** every place, **Your turn** and **Help**; the plans, the runs and the settings by name; **Do**, every verb for what the address names, a verb this console lacks the switch for drawn dim with the switch it needs; and the text of every plan and handoff. `/` opens it when nothing has your typing. |
| **Bell** | `?bell=1`, a sheet titled **Inbox**: **Needs you**, the asks the inbox carries — so an answer given on a phone clears the row on the laptop — and **Announcements**, the log of what the console has said, each row with what became of it (*sent to 2*, *held by quiet hours*, *no device*). |
| **Help sheet** | The guides, in the app, at `?help=<section>`, opened over the page you are on at its own part. |
| **Usage meter** | At the foot of the rail, and under **More** on a phone: the worst 5-hour window of any Claude account and one small bar per account. It opens Settings ▸ Accounts, where every 5-hour, weekly and per-model window has its reset countdown — the same numbers `/usage` shows. Registering additional accounts sits there behind `--allow-accounts`; every launch then offers an account per run and an on-limit policy (switch account / wait / pause). |
| **Source picker** | Chromeless and full-screen at `#/source`, because until a root is open there is nothing to navigate to. The switcher's **Open another source here** and Settings ▸ Essentials are its doors. |

It **updates itself**: a watch on `docs/` pushes changes over server-sent events, so a handoff written
by an agent session appears without a reload.


## Reading a status — tense, outcome, and who has to act

Every status the console draws — a dot and its word, a station on a track, a bar — reads through one
model, `viewer/shared/status-model.js` (6.0's status model v2; the paint is still one of the eight UI
states in `viewer/shared/status-vocab.js`).
A word answers three questions instead of one: its **tense** — happening (`live`), standing still
(`standing`) or over (`settled`); for a settled thing, its **outcome** — `ok`, `partial`, `failed`,
`stopped`, `superseded` or `unknown`; and its **attention** — `none`, or the inbox's own severity, so a
badge and the inbox never disagree about how loud something is.

**The law: amber is never derived from a status word.** It comes from an open inbox item, or from a word
that IS a person's move (`PERSON_WORDS`: a sign-off only a person gives, an MCP server or an account to
sign in, an outstanding decision, a landing conflict). Everything else paints what it is:

- a board `stuck` phase reads **Stuck** — the waiting paint with an alert glyph, never amber, because
  nothing about the word says a person must act; the errand that summons one is what turns it amber;
- a `halted`, `parked` or `interrupted` run and a `gated` or `blocked` phase read as waits;
- `halting`, `pausing` and `stopping` are live — the running paint — until they land;
- settled things go quiet, and an unknown word reads **Unknown** in the skipped paint rather than
  borrowing a neighbour's colour.

The Runs home's six groups are the bays of `viewer/shared/bays.js` — `needs-you`, `live`, `waiting`,
`queued`, `ready` and `settled`, drawn as Your turn, Running, Waiting, Queued, Ready to start and
Settled today, and spelled the same in `?group=` — and a run's group is the same model's answer to
"where does this run sit" (`bayOf`), so a run's group and its word cannot disagree. Colour is never
the only carrier: every status is a dot and its word.


**One rule governs the design.** `phase-graph.sh` is the only source of truth for done / ready /
waiting, session batches, boot prompts, QA regime and lint — the console shells out to those same
scripts for every status claim and never recomputes it. JavaScript parsing covers only what the
scripts do not expose (prose, phase detail, handoff bodies) plus analysis they do not provide
(critical path, unblock value, velocity). A parity test re-derives every plan's board from that parse
and asserts it matches the engine, so the two readings cannot drift apart unnoticed.

**Writes are off by default.** With `--allow-writes` the console can scaffold a plan or handoff,
record a QA result, manage phase locks, and close or reopen a plan — each behind a dialog showing the
exact command first.
`--git` is never passed, so it can never commit or push. The server binds to `127.0.0.1`, and keeps
binding there even when you reach it from elsewhere — `--remote` puts an authenticating proxy in
front of the loopback socket rather than opening one on a network.

**Runs are off by default too, behind their own flag.** `--allow-run` enables the **autopilot**: the
console drives a plan unattended, one `claude -p` process per phase, so "clear the session between
phases" needs no implementing — the process exits and takes its context with it. A phase advances only
when three independent checks agree: the plan's own verification passes, `validate.sh` still passes,
and the board re-read *from disk* says done. Nothing asks the session whether it succeeded. Model,
effort and skills are chosen per run or per phase; a command that reaches outside the working tree
raises an **approval** and waits for a person. It is a separate flag from `--allow-writes` on purpose:
a write scaffolds a file, a run edits a repository for hours.

**It runs on a phone.** Watching a run and answering an approval are the two things that cannot wait
until you are back at the desk, so the console can be driven from one — over your own private
network, with nothing exposed to the internet. Setup:
[Reaching it from your phone](phone.md).

## Terminals outlive the console

A terminal is a process on this machine, not an object in a tab, and since 3.2 it is not a child of
the console either. The ptys belong to a **broker** — one small detached process per console,
addressed over a `0600` unix socket in the instance's own state directory — so restarting the
console, or shutting it down on purpose, leaves every shell and every interactive `claude` running
with its scrollback intact. A fresh console adopts what the last one left, and a URL that named a
terminal still names it. Both the restart and the shutdown dialog read the real inventory and list
what keeps running under *"This keeps running"*, rather than claiming to stop what will not stop.
A broker with no sessions left retires by itself, so nothing lingers once the last terminal ends.

Closing the browser was already safe — it detaches the socket and leaves the work running — and
nothing is reaped for being idle. What changed is that *the console going down* is now safe too.

## What it keeps, and where

`<stateHome>` is `$XDG_STATE_HOME/phase-console` — `~/.local/state/phase-console` on most machines.
Some of what the console keeps is its own; some is the machine's, shared by every console on it.

| | |
|---|---|
| **Runs** | `runs/<instance>/<slug>/` under `<stateHome>`, one directory per plan per console checkout: the run records, their journals and transcripts, the plan's rulings ledger, and `outcomes/` — the inbox a session nobody supervises declares into. It sits in the shared state home rather than a console's own directory because it is keyed by root already, so two consoles cannot collide there. A declaration the console will not act on — `stale`, `invalid`, or one whose act `failed` — is moved to `outcomes/ignored/<name>.<reason>` (with a `.<n>` suffix rather than an overwrite) and never deleted. |
| **Learned accounts** | `<stateHome>/accounts/learned.json`, machine-wide: what every console has learned about each Claude *credential*, keyed by a fingerprint of where the login is kept and by organisation — the usage walls, the entitlement breaker, the last meter reads, the newest one-turn check (`probe`) and a tombstone for a removed registration. 0600, written under a lock and read from disk every time, because two consoles writing it is the normal case. *Registration* stays per console: which accounts this console may start work as. |
| **The machine profile** | `~/.config/phase-console/fleet.json`, read by every console: the notifier (`notifyCommand`), webhook rows, remote hosts and users, notification categories, quiet hours and the machine's lane ceiling (`maxSessions`), with per-console overrides inside it. A console reports where each inherited setting came from. |
| **The fleet directory** | `<stateHome>/fleet/` — `lanes/` holds one token per live lane of every console, which is how `maxSessions` holds across all of them, and `sessions/inbox/` is the sink for presence events from a directory no console claims. |
| **Per console** | Settings, logs, notifications, push devices and approvals. Beside `approvals/pending.json`, `approvals/counter.json` (0600) counts the cards raised for a person, the asks auto-grant answered and those pending, since a date — Insights' **Who was asked**. `policy-advisory.json` is the receipt of the policy advisories you acknowledged, keyed by kind to the fingerprint of the rule set: a receipt, not a preference. `cli-init.json` holds the newest CLI version a session reported, which is what arms the relay; `relay/state.json` is the relay's own. |


**Every Claude session on this machine is one of these.** The presence hook
(`scripts/session-hook.sh`, Settings ▸ Automation ▸ Session presence, off until you install it)
reports every `claude` running in a directory this console owns. Such a session belongs to a
terminal the console does not hold, so it cannot be attached to — there is no multiplexer here —
but it can be **resumed**: an ended one with a plain Resume, a live one with Take over behind a
confirm that says a second `claude` joins the same conversation and the one you can see keeps
running. Needs `--allow-agent`. The resume starts in the directory the *registry* recorded, not the
console's root, because `claude --resume` resolves a conversation globally: from the wrong
directory it does not fail, it succeeds in the wrong repository. A directory outside the open root
and the recent ones takes a confirm that shows you the path first.

## What a page costs

The console is a local server, so the cheapest thing it can do is not send bytes it does not need.
Three habits, all of them invisible until you look for them:

| | |
|---|---|
| **Compressed and revalidated** | Every compressible response is negotiated against `Accept-Encoding` — brotli on a tie, gzip as the fallback — with a strong `ETag` over the identity body, so a repeat read that has not changed answers **304** and moves nothing. Static assets under a hashed name are served `immutable` from their precompressed `.br`/`.gz` siblings. `/events` is never compressed: a compressor's flush window is exactly what server-sent events cannot tolerate. |
| **A page asks for what it renders** | The two big read endpoints take `?include=` — `prose`, `document`, `handoffs`, `memory`, or `full`. The board asks for what a board draws; the Source view asks for the plan's own markdown; nothing asks for everything. **Nothing was removed:** `?include=full` returns the pre-3.2 shape byte for byte, so a script that reads these endpoints keeps working by naming it. |
| **The board is windowed** | A thirty-one-phase plan renders the rows you can see plus a small overscan, against the page's own scroller. The row count in the accessibility tree is still the true one. |

Together those took a cold plan open on a large library from ~1,753 KB to ~442 KB on the wire, and
took an 11.27 s wait on the plan validator off the read path entirely — the lint still arrives, as
its own event, after the page is already drawn.

Details: [viewer/README.md](../viewer/README.md).

---

## What each release added

The README names the newest release in a line; here is each release's headline, newest first. Every
version's whole account is its section of the [CHANGELOG](../CHANGELOG.md).

**8.0** makes **Your turn** (`#/turn`) a destination of its own and every plan's fourth view, gives a
plan's map its tools, a Schedule and a Burn-up, and walls the console's own git off from what a session
writes in its tree.

**7.1** tells your turn step by step. Every act only you can do is one card on **Your turn** — an
approval, a task, a decision or a heads-up — with why only you, numbered steps, NOW or NOT YET, a
timing grid, where your press goes and how it is checked, *Undo* and *Hand it back*; an act only the run
can take is one approval per run, and an item the run moved past closes itself.

**6.2** brought that page, a grant with a scope and an end for a permission the AI lacks, an optional
**owner key** and *Handled by the AI*; **6.1** the Issues desk and waits on another machine's job.


---
