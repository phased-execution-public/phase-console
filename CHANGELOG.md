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
