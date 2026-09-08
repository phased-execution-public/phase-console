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

The console is **eight destinations**, a command palette, a bell drawer and a help sheet. Every older
address still resolves — a bookmark, a handoff link or a push notification minted by an earlier
version lands where its page went, keeping whichever half of the address still means something.

| Destination | Answers |
|---|---|
| **Now** | *Does anything need me, and what is running?* The needs-you inbox with inline actions (approvals, gates, errands, expired accounts, stalled lanes), the live lanes with heartbeat, cost and ETA, what is next up across every plan, and the plans in flight. |
| **Plans** | *Where is each plan on its route?* Every plan with progress, ready phases, locks, QA regime and health; open one for its Route (the transit map, plus a health panel and the verify-preflight prediction), Phases (state-grouped, with a drawer per phase carrying gate, lock, QA and evidence), Run, Handoffs and Source. |
| **Runs** | *What has this cost and what happened?* Every run this console has started, with settled-today against the day cap, and per run: the status strip, the ways forward, the lanes and their panes, the state-grouped phases with evidence, liveness and rulings, the timeline, and the journal. |
| **Sessions** | *What processes exist?* One list for autopilot lanes, agent sessions, shells and the Claude sessions the presence hook reports — and one pane, the phone-first browser terminal, for any of them. A session this console holds a pty for opens straight into that pane; a session it merely *knows about* offers to resume it (or to join it, while it is live), and then it has a pty too. |
| **Repo** | *What did the work do to the tree — and which of several trees?* History (a commit graph), Branches, Working trees (the reclaim surface: a tree the console made that no surviving run record claims), Changes (any range, a file at a time), Settles and Issues — the first five over `GET /api/repo/…`, the sixth over `GET /api/issues`: every repository's GitHub issues in one table, four filters in the URL, and a multi-select whose one click mints the plan-wizard ticket, with each repository's freshness (`fresh` · `stale` with its age · `unknown` with the reason) beside its rows. On a superproject every initialised submodule is a repository of its own here: the Repository picker lists each by its root-relative path (the plan's scope token), and the working-trees registry spans them all, each row naming its repository. Above them the glance `/api/state` reports: the branch, its ahead/behind counts, and what is uncommitted **under `docs/`** — the only corner that read covers (`server/git.ts` `repoInfo` scopes its `git status` there), which is why the card names it. |
| **Insights** | *How long, how much, how fast?* The estimate and the basis under it, settled spend against the caps, a plan's QA verdicts, the velocity trend and completions calendar, the state and size mix, the locks and health issues, and the repos, skills and models the work runs on. Portfolio-wide, or scoped to one plan with `?plan=` — which adds what that plan cost phase by phase, a finish date with its assumptions spelled out, and a CSV of the lot. The same numbers are scrapeable at `/api/metrics` ([docs/metrics.md](metrics.md)). |
| **Debug** | *What did the console see?* What this process is running as, and every log it writes on one time axis — the run journals, the watch scheduler's decisions, the health record and every refused tool call — filterable by time, run and phase, readable without leaving the console. `GET /api/debug/bundle` hands the same picture over as one redacted JSON snapshot sized for a context window. |
| **Settings** | *What may this console do, and as whom?* Eight addressed sections, ordered minimal → advanced — Essentials, Appearance, Automation, Notifications, Accounts, MCP servers, Permissions, This instance — each at `#/settings/<section>`, so a setting can be linked to from a handoff, a guide page or a note, and each indexed in the palette by its CONTENTS (`⌘K quiet hours`). The pre-4.0 ids `general`, `alerts` and `process` redirect. |

Riding on every page, on the query string rather than as pages of their own:

| Overlay | What |
|---|---|
| **⌘ K palette** | Search across plans and handoffs, plus every verb and every destination by name. `/` opens it without a modifier. |
| **Bell drawer** | What still needs a person, and the log of everything the console has announced — the same rows as Now's inbox, from the same component, so answering one on a phone clears it on the laptop. |
| **Help sheet** | This guide, in the app, at `?help=<section>`. |
| **Usage meters** | In the chrome on every page: each Claude account's 5-hour, weekly and per-model windows with reset countdowns — the same numbers `/usage` shows. Registering additional accounts sits in Settings ▸ Accounts behind `--allow-accounts`; every launch surface then offers an account per run and an on-limit policy (switch account / wait / pause). |
| **Source picker** | Chromeless and full-screen at `#/source`, because until a root is open there is nothing to navigate to. Settings ▸ Essentials is the door. |

It **updates itself**: a watch on `docs/` pushes changes over server-sent events, so a handoff written
by an agent session appears without a reload.


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
| **A page asks for what it renders** | The two big read endpoints take `?include=` — `prose`, `document`, `handoffs`, `memory`, or `full`. The board asks for what a board draws; the Source tab asks for the plan's own markdown; nothing asks for everything. **Nothing was removed:** `?include=full` returns the pre-3.2 shape byte for byte, so a script that reads these endpoints keeps working by naming it. |
| **The board is windowed** | A thirty-one-phase plan renders the rows you can see plus a small overscan, against the page's own scroller. The row count in the accessibility tree is still the true one. |

Together those took a cold plan open on a large library from ~1,753 KB to ~442 KB on the wire, and
took an 11.27 s wait on the plan validator off the read path entirely — the lint still arrives, as
its own event, after the page is already drawn.

Details: [viewer/README.md](../viewer/README.md).

---

