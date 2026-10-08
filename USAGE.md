# Using phased-execution (right-sized sessions, QA on request)

**English** · [فارسی](USAGE.fa.md)

`phased-execution` **plans** large multi-phase work and **runs** it in right-sized sessions — several
phases usually share a session (sized to ~0.2 × the model's window in phase weight; ~200K for 1M-class
models), each phase still gets its own handoff, and a copy-pasteable boot prompt chains the sessions.
Phases whose **scopes are disjoint** (the repos each touches, from the plan's Repos column) may run as
separate sessions at the same time; anything sharing a repo runs one at a time. Every phase-finish runs
the phase's own **Verification commands green** before handing off.

**QA subagents are opt-in (off by default).** When you ask for QA — a `**QA gate:** on` line in the
plan's §Session budget, `new-handoff.sh --qa` at a finish, or a plan that already has a
`test-status.md` — each finished phase is verified by a **fresh-context QA subagent** that reads the
real diff cold and records `pass | fail | waived`; a `fail` — and a verdict still **`pending`** — gates
every dependent until re-QA'd. Three ways out: re-QA to `pass`/`waived`, `**QA gate:** off` in the plan's
§Session budget (the verdicts stay recorded, they stop holding dependents), or **closing** the plan,
which retires its reports without pretending they passed. The autopilot climbs the first of those by
itself and asks you only when it runs out.
`scripts/phase-graph.sh <slug> --qa-mode` tells you which regime a plan is in.

**A plan you will never finish can be closed.** `scripts/close-plan.sh <slug> --reason "…"` marks it
`abandoned` (or `superseded`, or `complete`) with a date and a reason; `--reopen` reverses it. A closed
plan stops reporting ready phases, boot prompts, warnings and notifications, while its board, its
history and its search results stay exactly where they were — closing quiets a plan, it never hides one.

This file is a human-facing orientation. The executable procedure — the three modes, the helper scripts,
and the guardrails — lives in `SKILL.md` + `references/`; that is what Claude loads and follows.

## Seeing it all at once — the console

```bash
~/.claude/skills/phased-execution/start        # opens http://127.0.0.1:4123 in your browser
phase-console                                  # same thing, when installed as a plugin or from a clone
phase-console ~/code/your-repo                 # or point it straight at a repository
```


**Phase Console** (`viewer/`) is a local web app for reading this system: every plan with its live
board, the dependency graph drawn as a route map, phase and handoff detail, the boot prompt for any
ready phase, portfolio statistics (velocity, critical paths, locks, health), and full-text search
across plans and handoffs. It updates itself as agent sessions write files, and it takes every status
claim from `scripts/phase-graph.sh` rather than recomputing it. Read-only unless you pass
`--allow-writes` (guarded scaffold / QA / lock / close verbs), `--allow-run` (the **autopilot** — one
`claude -p` per phase, driving a plan unattended, with approvals for anything reaching outside the
working tree), `--allow-agent` (interactive `claude` sessions in a browser terminal, on the
**Sessions** page, plus a *New plan with AI* wizard that authors a plan from a brief),
`--allow-accounts` (register several **Claude accounts** per instance — sign-ins or
`claude setup-token` tokens — pick one per run, and let a run that hits its usage limit switch to
the account with headroom; the usage meters themselves need no flag),
`--allow-mcp` (register **MCP servers** — a browser, an issue tracker, a docs server — hold their
credentials, and attach them to a plan, a run or one phase; a phase whose servers cannot connect
runs without them and says so — or parks *before* it spends anything, if the plan or the run asks
for that — and reading the registry and its statuses needs no flag),
`--allow-webhooks` (**POST every announcement somewhere else** — a Slack channel, a Discord server,
a Telegram chat, your own relay; the first of two switches that send anything off this machine, so off means
no outbound request at all even for a URL already registered, payloads carry ids and titles with
secret-shaped strings masked, and reading the destination list needs no flag —
[docs/webhooks.md](https://github.com/phased-execution-public/phase-console/blob/main/docs/webhooks.md)),
`--allow-publish` (**push a finished phase's own `pe/*` branch** to `origin` — never a trunk, never
`pe/integration`, never with force, never a delete — and only where the plan's `permission.destructive`
row allows `git push`; the second switch that sends anything off this machine, and off means the
console pushes nothing — a `Land: pr` phase then parks with the reason),
or `--allow-terminal` (a real shell). The server itself never pushes except through that one flag —
a session's `git push` is denied unless the run opens a PR, and then it is a card and one tap. All
eight default off. One-time setup per machine:
`cd viewer && npm ci && npm run build` — see `viewer/README.md`.

**It heals its own runs, and asks once.** A phase that stopped short is classified (never started,
work in progress, done but unrecorded, verification red, declared blocked, a resource wall, a stale
or live foreign claim, a manual gate…) and its situation's ladder is climbed by the autopilot itself —
at boot, on a docs change, every few minutes, a minute after any stop, and on Recover & continue —
within caps in rungs **and** dollars you set in Settings ▸ Automation; when the ladder is spent it
leaves **one errand** (what is needed, how to give it, what it tried) and drives everything else.
Every Ways forward shows the situation, the rungs tried and the next one; *Your turn* lists only
errands, permission asks and sign-ins; the Pulse shows each plan's last convergence
pass. Install the session-presence hook (Settings ▸ Automation ▸ Session presence or `phase-console
install-hooks`) and a hand-run `claude` in the repository is seen too — queued behind for ten minutes
after it starts or resumes (for as long as it lives once it works that very phase), its lock released
the moment it ends. A **boarding schedule** (Settings ▸ Automation, off by default)
says when this console may START phases at all — windows, cron openings and quiet hours that win over
both; outside it a ready phase queues saying when boarding opens, a recovery you ask for is never
held, and a phase already running is never interrupted. `docs/loop.md` is the specification.

**Nothing asks you mid-run.** Since 5.0.0 the launch form opens on a **Decisions** stage: the plan's
`## Decisions` manifest with each row's state, four probes run before anything is spent (the accounts
the run may spend, its MCP servers, the credentials it names, a channel to announce on), and the
answers the door requires — continue after a console restart, arm the relay, which accounts with how
much headroom, an acknowledgement of every waived row. A blocking row still open disables Launch and
names itself; the one way past it is an override the run records. `phase-console doctor` runs the
same probes and the machine checks by hand — hooks, unit, CLI version, `gh`, the environment — and
exits non-zero naming the first failing row (`--json` prints the report).

**The relay answers what a session still asks.** It is off by default: a run without it carries
`--permission-prompts none`, so anything that would prompt is denied and the session is told nobody can
answer. Armed (`relay: last-resort`), it arms only at a Claude CLI of 2.1.268 or later — below that the
run keeps the floor and journals `run.relay-refused` — and a question a session raises
(`AskUserQuestion`) is held 60 s for a person on its question card; unanswered, the console answers at
55 s by a relay rule, else the sole `(Recommended)` option, else the first, with no model call, and
files a ruling keyed `ambiguity`. A multi-select question, one with a destructive option, a deny-list
match, a question on a halted or parked run, the same question twice in one phase, and anything past
the phase's question budget go to a person instead — a `needs-human` park and one push.
`docs/decisions.md` has the row.

**What a session decided reaches the next plan.** A ruling that names its decision key
(`phase-outcome.sh … ruling --needs <key>`) is an inbox row with **Remember for this plan** (a
`## Decisions` row, source `ruling`) and, when its words are an answer the console can hold,
**Remember on this console**; a session can do the first as it records (`--remember plan`). The
console's own answers live on Settings ▸ Automation ▸ **Policy answers** — every row of the policy
table, edited in place, each change journalled — and the plan wizard opens by reading the
repository's ledgers, then asks the manifest and the plan's machine-read fields one numbered
question at a time, showing the manifest filled in before anything is written. Settings ▸
Permissions raises an acknowledgeable banner when the policy in force cannot ask (the ask list
struck empty) or the deny wall is struck, and refuses a rule that would never match
(`Bash(:*)`, `git(:*)`).

**A refused account stays refused until you clear it.** When the API refuses an account's credential
itself (not its usage), the account is `retired` together with every account in its organisation, and
no run spends any of them. `POST /api/accounts/<id>/clear-retired` is the one way back — for the
credential and its whole organisation — and `POST /api/accounts/<id>/probe-entitlement` asks first: one
declared one-turn session under that account, whose answer can retire it again. Both need
`--allow-accounts`; `docs/controls.md` has the rest.


**Shut down, at the strength you mean.** Settings' **Shut down** exits the console, and its dialog says
beforehand whether that lasts (nothing supervises the process), lasts until the next login, or comes
straight back with every run checkpointed (a supervisor keeps it alive). Where a unit runs the console,
**Stay off…** also unloads and disables the unit and leaves a stop marker (`stopped-by-console.json` in
its state directory), so not even a login brings the work back. Both dialogs list what will stop and
what survives — lanes, clocks, runs on disk, live sessions, cards, unread inboxes — and confirming
acknowledges that list. A console that boots under the marker, or under `autostart: false` in the
machine profile, holds its automation: nothing is re-adopted or converged until **Clear the stop and
resume** (or **Release it for this boot**) in Settings — `POST /api/automation/hold/release`,
`--allow-run` — runs the boot pass it held. The profile is not edited, so `autostart: false` holds the
next boot too.

**The machine has limits of its own.** `~/.config/phase-console/fleet.json` is the machine profile every
console reads — remote access, the notifier, webhooks, quiet hours, each console's `autostart` — and its
`maxSessions` is the machine's lane ceiling: every console's live lanes summed, beside each console's own
`--max-sessions`, so a phase queued behind it names `machine cap` as its holder. `GET /api/instances` is
the census of every console the machine records. A session in a directory no console claims is never
handed to whichever console happens to be running: its presence events wait in the machine's unowned
sink (`~/.local/state/phase-console/fleet/sessions/inbox/`). And while a console is down, its own
presence inbox is drained without it by `phase-console sessions ingest` — the hook runs it when its
POST finds nobody — which does nothing while that console answers.

**A repository's issues, on one desk.** Repo ▸ Issues reads a repository's whole issue list, open and
closed, up to 2,000, and shows what each issue says about itself: its category (bug, enhancement,
documentation, question or other), its severity from a `severity:` label (critical, high, medium or
low), and where it stands in a plan — it needs one (`awaiting-plan`), it is planned in a plan's phase
(`plan:<slug>`), it is deferred, or it is fixed. Every column sorts, and the sort and the category,
severity and plan-status filters live in the URL. Any GitHub `owner/name` can be added and read beside
your own repositories, read-only. Tick some issues to **Author a plan from N issues**, an interactive
session that writes the plan (`--allow-agent`).

**A wait names what it waits on.** A session that has to wait declares what it waits for, and the
console checks it by itself: a GitHub run or pull request, a date, another phase, a command — and,
since 6.1, a systemd unit on another machine, `unit:<host>/<unit>`, asked every five minutes over one
ssh connection per host, whose address, user, key and port come from `hosts.<name>` in the machine
profile. A date beside such a ref is only its backstop. A phase may declare four waits and stay parked
eight hours in all; a plan raises the hours with `Wait budget:` or `Waits on:` and the count with
`Wait count:`, and a spent budget whose ref is still being checked goes on waiting on it rather than
asking you.

**The acts only you do, queued.** An `operator-act` is a step only you carry out — a command to run, a
click path to follow — declared by a session (`phase-outcome.sh … needs-human --act --due-when <ref>`)
or written into the plan (`due: <ref>` on a `Human step:` bullet, in a phase or under
`## Operator errands`). Until its ref lands it waits, silent, under *Coming up* on Your turn;
then it is due, with one notification — `NOW:` and its command, or its title for a click path — and
its proof clears it and resumes the phase that needed it.

**Your turn: every act only a person can do, on one page.** `#/turn`, titled *Your turn* and lighting Runs,
lists them in six sections, always in this order: *Do now*, *Needs one detail from you*, *Coming up*,
*Being checked*, *Done* and *Handled by the AI*. Each item is one card: why only you can do it (one of ten
reasons — `permission`, `identity`, `secret`, `money`, `legal`, `decision`, `physical`, `reach`,
`third-party` or `reserved`), the plan, phase and run it belongs to, what it unblocks, the effort, its guide as
steps, how it will be checked, and one primary action. A guide's commands are copyable — *Copy* as
written, *Copy for Claude Code* behind a `!` — and are never run by the page; a link shows its whole address
before it opens; a guide written in Persian is drawn right to left, its commands left to right. The plan, run,
kind, reason and risk filters and the search live in the address; *Export* downloads the open items as one
Markdown document and *Print* prints the same. `#/approve` and `#/approve?step=<id>` land on the page and a
push opens `#/turn/<id>`. The approval queue, a question, a gate and an errand all draw the same item with
*Open on Your turn*; the Tower's Needs-you bay keeps runs and one line linking here, and *Your turn (n)* in the
situation line counts items.

**Every source feeds the one list.** A person errand is an item, so its *Done — continue* checks the same item
and a step you did ends `proven`. A credential the preflight finds missing raises a `secret-entry` item,
proven by a `credential:<id>` watch (`gh`, `claude`, `env:NAME`, `keychain:SERVICE` or `file:PATH`, read by
presence and never by value); an MCP server the console cannot reach under `require` raises an `mcp-login`
item; a relayed question the console will not answer by rule raises a `decision` item that keeps its
options. A session raises its own with `phase-outcome.sh … needs-human --step`, and the console holds the
declaration to a reason its kind allows (`--why`), a guide (`--guide`: a why paragraph, `## Steps` and `## If it
goes wrong`; at most 20 steps and 24 KB) and a proof a person can read. It refuses what the AI could do itself
with exit 4, and a step with no proof with exit 2; `references/turn.md` is the session's reference.

**The check.** *I've done this — check* gets a verdict: passed; rejected, with exactly what to redo (the
item says *Back to you*, the attempt and the miss); or needs-info. A command's proof is read at once and a
miss says what it read. A proof only words can state is read by a short read-only checking session for that
one item — at most 12 turns, $0.50 and five minutes, `sonnet` at `low` unless Settings ▸ Automation says
otherwise (*Check what a command cannot*; switched off, the item is accepted on your word and marked
unverified). A pass resumes every waiting session once, saying what was proven. After the third rejection
(Settings ▸ Automation ▸ *Send to the owner after*) the item asks how it ends: rewrite the guide, *I can't*, or
the owner's *Accept anyway*, recorded as unverified. No session and no agent can mark its own item passed.

**Your moves.** Beside the check you can answer a decision — one of its options, a note, or both (*Send my
answer*) — decline an item that allows it, with a reason (*Not doing this*, which ends `declined`), ask a
question about it (*Ask*) and attach evidence (*Attach*): a note, an image or a file, 160 KB a piece and six an
attempt, screened for secrets and kept 0600 in `turn-evidence/`, never pushed. Each answer goes back to every
waiting session once, in a sentence the console composes. The console never takes a secret: a `secret-entry`
item says where the value goes — the keychain item `phase-console-<id>` on macOS, a 0600 file elsewhere, or
its own `credential:<id>` place — and the check finds it there.

**Permission items, and grants.** Every wall a session meets is recorded, and a session that declares
`blocked --needs permission` citing one raises ONE `permission` item, "raised because the AI lacks permission
…", with the command, the phase, why it was needed, the wall and its risk. Answer it on its card: *Grant* —
*This call*, *This phase* (until it settles, 24 hours at most), *This plan*, *This repository* (every plan of
this console) or *Always* (every plan on this machine) — or *I'll do it myself*, which turns it into your own
act, or *Deny*, after which the session finds another way. A low or medium grant is one press; a high one
shows what it reaches, asks for the rule typed back, and on a console with an owner key waits for a touch of
the key within the last five minutes. The **never list** offers no grant through any door: a forced or
deleting push, `sudo`, `shutdown`, `reboot`, `mkfs` and `dd`, a protected path, a secret's value, the console's
own guard, a missing credential, a sandbox or network wall, and Claude Code's own classifier — the item says
why and gives the manual path. The console applies a grant itself: below plan scope its hook lets exactly
that lane and rule through, and the run's settings carry the rule lowered for that run only until the grant
ends — for that long the CLI's own list does not hold it with the console dead. The waiting session resumes
by itself. Every grant is a row in `grants.ndjson` — who granted it through which door, the item, the wall,
the rule, the scope, the end and exactly what it changed. `phase-console grants list` shows them (so does
Settings ▸ Permissions ▸ **Grants**), `phase-console grants revoke <id>` undoes exactly what its row says,
`phase-console grants revoke-all` ends every live one, and a *Permission granted* push announces each.

**The owner key.** A passkey proves a press is yours. Every request has one door, decided by what it can
prove — `owner`, `device`, `local` or `session` — and the `by` label is only a label.
`phase-console owner enroll` prints a one-time link, good for ten minutes: open it in a browser on this
machine, at `localhost` (an IP address is refused), and enrol a passkey (Touch ID, Windows Hello, a security
key — the console requires user verification); later keys are added in an owner session from Settings ▸
Permissions ▸ **Owner keys**. From then on the console has an owner: a browser signed in with the key is the
owner's for twelve idle hours, and a high-risk press — a profile raise, a capability, a key, trust — needs the
key touched again within five minutes. A press through any other door (a script, the CLI, a browser with no
key, a phone beyond its low and medium answers, a session's token) is neither applied nor dropped: it
waits as "asked by … — confirm?" for the owner to confirm or refuse in one press, and what the plan's manifest
already allows still runs. `phase-console owner status` says whether the console is `unenrolled` or `enrolled`,
with the keys and the requests waiting (`unlocked` is what a browser inside an owner session reads in
`/api/state.ownerDoor`), and `phase-console owner lock` ends every owner session. A console with no key behaves as before
and says so. The residual risk, in full: a process running as you that deliberately rewrites the console's own
files can forge anything below the owner key, and can replace the key registry itself; the console walls the
paths a session takes and makes every grant visible, and it is not a boundary against your own account.

**Kept up to date, and what the AI handled.** A round ends the grants that ran out, sends the reminders that
are due, withdraws an item nobody needs any more or a live grant now covers, brings an upcoming act due with its
one push, and reads the proofs the console owns. It runs every minute and two seconds after any run's journal
line, changes the page only when something changed, and announces itself with one server-sent event, `turn`.
The sentence above the sections is composed by rules — how many need you now and for how long the oldest has
waited, how many are being checked, how many are coming up, how many were handled since you last looked —
never by a model. *Handled by the AI* is the other half of the record: what the guard refused to raise, the
auto-grants the rule table gave (one row per rule per phase, with a count), relay answers by rule, the ladder's
recoveries, and anything a session records with `phase-outcome.sh <slug> <N> handled --what …`, each linked
to the journal line that says it. `phase_console_turn_rounds_total`, `phase_console_turn_handled_total`,
`phase_console_turn_checks_total` and `phase_console_turn_check_usd_total` count them.


**Reading a run from a shell.** `phase-console run status <slug>` prints the latest run in a small
shape (the status word every page shows — `waiting` for a run asleep on a clock nobody paused — halt,
lanes, one word per phase); `run runs`, `run queue`, `run accounts`,
`run approvals`, `run journal <slug>`, `run triggers <slug>`, `run tail <slug> <N>` and
`run explain <slug> <N>` read the rest, and `explain` prints the phase report's summary first.
`phase-console doctor` lists console processes whose install root no longer exists, and
`doctor --stop-strays` stops exactly those.

## Where things live (two places)

- **The skill** (this repo — cloned to `~/.claude/skills/phased-execution`, installed as a plugin,
  or a copy inside a hub folder): the procedure (`SKILL.md`), `scripts/`, `references/`, `templates/`,
  `tests/` and `viewer/`. If you run several Claude homes (`~/.claude`, `~/.claude-a`, …), each
  holds its own clone — edit one, then `commit → push → pull` in the others so all stay identical.
- **The work-state** (your project repo's `docs/`): `plans/<slug>.md` and
  `handoffs/<slug>/{phase-NN-*.md, INDEX.md, .locks/}` (+ `reports/` and `test-status.md` when QA is
  enabled, and `gate-status.md` once any gate is cleared) — committed + pushed, so any account or
  machine can pull and continue a partially-finished plan.

Full procedure: `SKILL.md` and its `references/`.

## Licensing

The free edition is open source under the MIT License, at
[phased-execution-public/phase-console](https://github.com/phased-execution-public/phase-console).
