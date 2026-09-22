# Changelog

This repository is a **published snapshot**, not a development history: every release is one push of
a materialized tree, so its commits say when a version was published and nothing about how it got
there. The per-version notes live on the Releases page instead, where each tag carries its own:

**https://github.com/phased-execution-public/phase-console/releases**

The version this tree is at is the `version` field of `package.json`, and the release with the
matching `vX.Y.Z` tag is its entry.

Installed as a Claude Code plugin, you are on the commit channel rather than a tagged one — every
push to `main` here is a release, and Claude Code refreshes installed plugins in the background — so
the Releases page is also the way to read what arrived since you last looked.

**This file is where those notes are written.** Each Release's body is the section below with the
matching version, published verbatim; keeping them here as well means a clone has the history
without a network round trip, and means the notes are reviewed as part of the tree rather than typed
into a web form at the moment of release.

## [Unreleased]

## [5.1.0] - 2026-09-21

**Many plans, one repository.** Several plans can now work one repository at the same time without
treading on each other: each run in a checkout of its own, locks two processes cannot both win, one
trace id through everything a run does, and notes that reach a phase before it starts. It is a minor
version because it is additive — a 5.0.0 plan lints and runs unchanged, and every new door stays
closed until a plan directive or a capability flag opens it. `docs/releasing.md`, §Upgrading to 5.1.0,
is the list of what an older copy will notice.

### Migration
- **None.** Five lint ids are new — F26 `note-target-unknown`, F27 `land-word-unknown` and F29
  `landed-gate-unknown-phase` fail a plan, F28 `land-needs-lane` and F30 `note-target-done` advise —
  and each fires only on a directive 5.0.0 did not have. Update the console's scripts and the plugin
  together, as at 5.0.0: a 5.0.0 `phase-graph.sh` has no `--notes` arm and a 5.0.0 `phase-outcome.sh`
  rejects `--for`.
- **One tightening.** Nine shared-`.git` verbs (`git stash`, `config`, `worktree`, `submodule`,
  `checkout`, `switch`, and `gh issue create`/`comment`/`close`) now raise a permission card on every
  profile: one of them in a shared checkout is another lane's problem.

### Added
- **A checkout of its own, per repository.** A run's branch forks from the trunk at a pinned sha and
  records who chose the base; the console's worktrees are `git worktree lock`ed with a reason naming the
  console, the plan, the phase and the time, and sweeps unlock only the console's own stale locks. A
  retention word — `keep-on-failure` (the default) · `prune` · `keep` · `ttl:<h>` — says what becomes of
  a checkout when the run settles, and a dirty tree is never removed. A per-repository cap bounds how
  many isolated runs stand beside each other, `.worktreeinclude` copies ignored-but-needed files into a
  fresh worktree, and `- **Isolation:** shared|worktree` lets one phase carve itself out.
- **Locks two processes cannot both win.** A claim is made with `ln`, which the filesystem makes
  atomic; a lock with no `scope=` line reads as `all` everywhere; the runner claims provisionally at
  grant and stops the lane on losing the lock rather than editing on; the unsupervised outcome inbox
  stamps its filenames so a second declaration never destroys an unread first; run ids are twelve hex
  characters.
- **Worktrees, lanes and settles that tell the truth.** The run pruner reads the phase list from disk;
  merges into one tree are serialised per directory; a vanished lane directory is rebuilt and a drifted
  mirror mount is named and reattached; a settle that ends on a usage wall no longer claims the branch
  was published.
- **One trace id, one seam under every child process.** A run's trace id rides the HTTP request, the
  drive, every phase attempt, the spawned session, the scripts, the presence hook and every git command;
  one module is the seam under every child and logs its `argv`, `cwd`, `ms` and `code`. The log
  envelope is v2 with a `debug` level, `PHASE_CONSOLE_DEBUG=<channel>` admits one channel at `debug`,
  `/api/debug/level` flips it on a deadline, and a journal at its cap writes an in-band `journal.full`
  marker and keeps a reserve so `run.finished` is always reachable.
- **Nothing grows without a bound, and one run exports as one file.** A retention planner sweeps
  transcripts, task ledgers, outcomes, git traces and the supervisor's stdio by a table Settings ▸ This
  instance ▸ Logs and retention can preview before it acts; rulings are never pruned. Each session's raw
  hook payloads are kept beside its record, capped at 1 MB with one marker line. `GET
  /api/debug/bundle?slug=&run=` answers one run as a redacted tarball, and `phase-console diagnostics
  --run <id>` builds the same thing with no console up.
- **`--allow-publish`, the eighth capability flag.** Off by default like the other seven, it is what
  lets the console push a finished phase's `pe/*` branch — never a trunk, never with force — and file
  issues on the repository's behalf, where a plan's `permission.destructive` row allows the act.
  `phase-console doctor` gains a non-blocking `publish` row.
- **Notes reach the phase that needs them.** A handoff bullet addressed forward and a deferral ruling
  (`phase-outcome.sh … ruling --kind deferral --for <M|next|all>`) are collected by
  `phase-graph.sh <slug> --notes N` into that phase's boot prompt, shown on the plan page, and linted
  (F30) when addressed to a phase that has already finished.
- **The contracts.** Three new vocabularies with bash twins (landing, messages, issues); the plan
  directives `--land`, `--landing`, `--base-branch`, `--gitlink`, `--conflict-policy`, `--isolation`,
  `--clash-zones`, `--issues`, `--messaging` and `--notes`, each answering `word · phase|plan|default`;
  two self-evaluating gate kinds, `landed N` and `pr-merged N`, that read a ledger and run nothing;
  `scripts/phase-landing.sh`, the ledger's writer; and an eighteenth decision key, `issues`.
- **The verification launch door.** Every §Verification command a run would stop on is answered
  once, at the start door: the prelude's fifth probe, `verification`, lists each by exact text, phase
  and reason, to approve (bound to a hash of its whole text) or waive for the run; one verification
  review answers boarding, the start response, the plan page, plan health and the repair gate alike.
  The launch form says what each phase will run as and where the plan and the run differ; context is
  counted per call (`412K ctx · peak 455K · 2 rebuilds · 17 polls`) and a session is told to wrap up
  at 0.6 × its window; live spend shows beside booked spend.
- **`doctor` probes git** under the console's own `PATH`, blocking — under launchd that path led to
  Apple's `git` shim, which exits 69 until the Xcode licence is accepted.
- **`bootedAt` on `/api/state`** — the process's identity, so the page that pressed Restart reloads
  once a different one answers.
- **Smaller things.** Base branch, "Runs beside it in the repository" and "When the run settles, its
  checkouts" on the launch form and in Settings ▸ Automation; a `Land:` chip and a locked chip on the
  run and Now pages; a per-action words box on inbox rows; `refusalReasons` on `GET /api/state`;
  "Serialise conflicted branches" and "Call it looping after" among the automation preferences.

### Changed
- **One wait procedure, in every place a session meets it**, and a runaway run of status checks
  (six inside two minutes with nothing else between) is refused at the hook with the procedure.
- **A session is resumed only while it is worth resuming** — one that ended at ≥ 250k tokens and is
  cold, that declared `partial --reason budget|context`, or that the console checkpointed is boarded
  fresh with the resume brief.
- **A nearly spent account stops taking on lanes**, and a usage wall that cannot clear soon is waited
  out at the first burst rather than after twenty minutes of retries.

### Fixed
- **A fresh run carries the start door's `maxParallel`** — it reached a continued run and never a new one.
- **`bats` is a command**, `git merge-base`/`merge-tree` are reads, `2>&1` is not a separator, and
  `! grep …` is judged as the command it negates; a `$(…)` inside double quotes is judged too, and a
  backgrounded `cmd &` no longer reports green without waiting.
- **The self-heal no longer dead-ends or buys a session for an approval**, and a `Person-check: halt`
  park names the refused command and the remedy that exists.
- **Every turn of a multi-turn session is booked**; a phase this run worked is no longer called
  "closed outside this run"; `phase-console stop` reports a console stopped when its process has left;
  a hung server test fails by name; a terminal left open no longer holds the autopilot.
- **The findings 5.0.0 left open**, each ended in one state: a generated prompt names the docs root it
  was read from; the recovery panel stops offering a resume the policy refuses; a wait-resume onto a
  lost session boards with the resume brief; a pull request is no longer cancelled by a declined
  resume; the local-job nudge waits out the window the procedure grants; paging a file is not a poll;
  a closeout that could not resume says why in English; `preFirstTurn` asks what this session spent.

## [5.0.0] - 2026-09-15

**Zero-touch: what a run would stop to ask is asked before it starts.** This is a major version
because a plan, a session and a script that starts runs each meet something that now refuses.
`docs/releasing.md`, §Upgrading to 5.0.0, is the full list.

### Migration
- **Three lint ids now fail a plan.** F14 `verification-empty-open`: give every open phase's
  §Verification a runnable command. F24 `gate-directive-missing`: put a `- **Gate-check:**` line under
  every `*(GATED)*` heading. F25: every `outstanding` row in `## Decisions` names an owner, a known key
  and a known state. Lint every live plan with the 5.0.0 scripts before a console runs it.
- **`phase-outcome.sh … blocked|needs-human` requires `--needs <key|class>`.** A 4.1.0 copy of the
  script rejects the flag, so update the console and the plugin together.
- **A run started over HTTP must carry `resumeOnRestart`, `relay` and `accounts`** (400 without them).
  It is refused with 409 while a blocking decision is still open, a waiver is unacknowledged or a
  probe fails.
- **Defaults and names moved.** `delegateHumanGates` now ships on and `qa.exhausted` answers `waive`.
  `phase.tool-auto-granted` is now `phase.approval-auto-granted`, and `phase.resume-at-boot` is now
  `phase.resume-automatic`.
- **The relay needs `claude` 2.1.268 or later.** Sessions that are not relayed run with
  `--permission-prompts none` from 2.1.259.

### Added
- **The decision manifest.** `## Decisions` has seventeen keys; read it with
  `phase-graph.sh --decisions` and answer it with `scripts/decisions.sh`.
- **The run-start prelude.** Four probes run before anything spawns: accounts, MCP servers,
  credentials and a delivery channel. `phase-console doctor` runs the same probes by hand.
- **The policy table and ruling memory.** Eighteen kinds of interruption are answered by default and
  journalled. `--remember` promotes a ruling into the next plan, and the table is edited under
  Settings ▸ Automation ▸ Policy.
- **The relay.** A question a session asks is held for sixty seconds, then answered by rule, else the
  recommended option, else the first. It is never answered on a deny-list match.
- **Honest sessions.** Every stop sends SIGINT first, so turns and cost are booked. Every session
  carries a turn cap and a dollar cap, and every automatic start names its door and counts against a
  ceiling.
- **Honest waits.** A declared wait longer than the console's budget is refused with the arithmetic
  instead of being cut. Every resume checks that the session is not live, and an overdue clock at boot
  is ruled on rather than fired.
- **Accounts at the wall.** A credential an organisation refuses is retired for every console on the
  machine. The run climbs to the next account, or parks the phase with one errand.
- **An off switch that stays off.** Shut down lists what is running first, and Stay off holds every
  later boot until it is cleared. `phase-console sessions ingest` records session presence with no
  console up.
- **Delivery.** A console with no device to notify says so, and an unattended start with no channel
  asks for an acknowledgement.
- **Why a run started and what it cost,** on every run and session page, reconciled against the run's
  spend.

### Changed
- **The documentation describes all of the above** — `docs/`, the references, `SKILL.md` and the
  in-app guide, in English and Persian.

## [4.1.0] - 2026-09-08

### Added
- **Tagged releases.** Alongside the plugin channel — which is unchanged, and is still every push to
  `main` — each version now also gets a `vX.Y.Z` tag here and a GitHub Release carrying the packed
  tarball, so a machine without git can be handed exactly what a tag holds, and so an install can be
  pinned to a version rather than tracking `main`. The Releases page carries these notes per tag.

### Changed
- **This repository is published, not developed in.** `main` is replaced wholesale by each release
  rather than committed to by hand, which is why its history says when a version was published and
  nothing about how it got there. Issues and discussions are the way to reach the maintainers;
  pull requests against a generated tree cannot be merged.
