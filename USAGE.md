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
Every Ways forward shows the situation, the rungs tried and the next one; the dashboard's *Waiting on
you* lists only errands, permission cards and sign-ins; the Pulse shows each plan's last convergence
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
