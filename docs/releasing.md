# 🏷️ Versioning and releasing

Releases are cut by hand, on a maintainer's machine. Nothing here runs on a server, nothing
publishes on its own, and there is no registry of any kind — npm, GitHub Packages and the Homebrew
tap were all withdrawn on 2026-09-03. GitHub holds the repositories, the tags and the Release
assets, and that is the whole distribution story. `viewer/test/release-split.test.ts` greps for the
withdrawn channels in `scripts/`, `.github/scripts/` and `package.json`, so the claim in this
paragraph is a check rather than a promise.

| Channel | Name | Cadence | Made by |
|---|---|---|---|
| Claude Code plugin | `phased-execution@phased-execution-public` | **every push to `main`** | the push itself — this repo *is* the marketplace |

A clone is the other way in.
There is no npm package and no Homebrew formula any more — both were
withdrawn on 2026-09-03 — and the tarball a Release carries exists so that a machine without git can
still be handed exactly what a tag holds.

## How a change becomes an update

**Every merge to `main` IS a plugin release.** There is no version number on that channel by
design — Claude Code refreshes installed plugins from `main` in the background. So the bar for
pushing `main` is "this is releasable", always; `scripts/gates.sh` exists to hold that bar, and the
pre-push hook runs it for you.

**The gates — `scripts/gates.sh`.** In this order: `tests/run-tests.sh` (shellcheck + bats), the
engine-parity test, the server suite serially, the three timing-sensitive files with one retry
each, the client suite, both typechecks, lint, the format check, the build gate (`verify:dist`, a
scratch build — `--build` builds `client/dist` for real), the scrub, and the tarball assertions.
`--quick` is typechecks + lint + format + scrub, under a minute; `--list` prints what a call would
run; `--ci` reinstalls `viewer/node_modules` first; `--keep-going` runs past a failure. A green full
run records the sha it verified in `.git/phase-console-gates-ok`. Every `node --test` the gates run,
like `npm test`, carries `--test-timeout=600000 --test-force-exit`: a test still running after ten
minutes fails by name, and its file exits instead of waiting on a handle nothing will close.


**The hook — `scripts/git-hooks/pre-push`.** Once per clone, `scripts/gates.sh --install-hook`
sets `core.hooksPath` to `scripts/git-hooks/`. A push that touches `main` or a tag runs the full
gates (a recorded green run for the same sha on a clean tree stands in for it); any other ref runs
`--quick`. `PHASE_CONSOLE_SKIP_GATES=1 git push …` skips them and says so on stderr — the
emergency door, not a habit.


## What a change must carry with it

| If you change… | You must also update, in the same commit |
|---|---|
| Anything the server needs at runtime (a new `server/` import, a new `scripts/*.sh` it shells, a new `templates/`/`references/` file a prompt names) | the root `package.json` `files` allowlist **and** `.github/scripts/assert-tarball.sh` — the tarball assertions are the backstop, never trust the allowlist alone |
| A setup prompt in `viewer/shared/setup-prompts.js` | its verbatim carriers (README.md, docs/install.md, the in-app guide) — `viewer/test/setup-prompts.test.ts` fails otherwise |
| The Node floor | every gate: root + viewer `package.json` engines, `viewer/run`, `bin/phase-console.mjs` — plus the docs that state it. `viewer/test/node-floor.test.ts` lifts each gate's own predicate and RUNS it either side of every boundary, so they can no longer disagree silently, and it asserts the SIZE of that set so a gate cannot be dropped from the list quietly |
| English docs | the Persian mirror (`README.fa.md`, `USAGE.fa.md`, `viewer/README.fa.md`) — **gated** since 3.1 by `viewer/test/docs-parity.test.ts`: heading counts per level, the flag set, and the images must match. Titles are translated, so it asserts structure and the tokens that survive translation, never prose |
| A push category, a settings section, an engine mode, or a repo path a doc cites | the docs that name them — the same `docs-parity.test.ts` holds `docs/phone.md`'s table to `CATEGORIES`, every `Settings ▸ X` to the eight real sections, and every backticked repo path and bare script name in `docs/` + `references/` to a file that exists |
| A message a **user** reads at runtime that points at a doc — `--help`, a refusal, the in-app guide, `USAGE.md` | a link built from `DOCS_URL` (`viewer/server/config.ts`), never a repo-relative path. `docs/` is on the never-ship list, so the packed tarball has no `docs/` directory and a bare `docs/webhooks.md` is a pointer to a file that install does not have. Repo-relative paths stay right inside `docs/`, `references/` and `viewer/README.md`, which are read from a clone and gated on resolving |
| Anything user-visible | a `CHANGELOG.md` line (open an `## [Unreleased]` section if none exists) |
| Behaviour the **plugin listing** describes | `.claude-plugin/marketplace.json`'s `description` — the largest user-facing prose surface here. Since 3.1 `viewer/test/packaging.test.ts` carries a **version-staleness gate**: the newest version the description names must be at least the tree's MAJOR.MINOR. A patch may ship without touching it; a minor may not, because a minor is where the behaviour a listing describes changed |

Before **every** commit: `bash .github/scripts/scrub.sh` — run it bare, not piped (failures are on
stderr and a pipe eats the exit code). It scans tracked ∪ staged files, so another workstream's
untracked files never block you.

To check the **tarball** locally, use `bash .github/scripts/pack-and-assert.sh`, not
`assert-tarball.sh` directly: the latter exits 2 without a tarball path, and a plain `npm pack` runs
`prepack`, which rebuilds `viewer/client/dist` — the build the live console serves per request. The
wrapper does the two things `prepack` does that the assertions need (the pack `tsc` emit, then
`npm pack --ignore-scripts`), asserts, and cleans up precisely: only untracked `.js` with a matching
`.ts` sibling, because `viewer/server/fallback-sw.js` is real tracked source sitting among the ~148
emitted files. `--keep` leaves the tarball in place and prints its path, and `--tree DIR` packs
another checkout of this repository, which is how a tag behind `HEAD` is released.
The tarball is **7.1 MB** — 693 entries, 20 MB unpacked, measured at **5.1.0** with the pack `tsc`
emit in place, which is what a release actually packs (5.0.0 was 5.9 MB and 599 entries, 4.0.0
4.7 MB and 503; 5.1 added the landing, messaging, issues, trace, retention and reach modules and
the emitted `.js` beside each; the free tarball is 576 entries).
`assert-tarball.sh` prints the same 693: this
tarball carries no directory entries, so the older note about `tar -tzf` counting them no longer
applies, and the two numbers agreeing is now the expected answer rather than a discrepancy to
explain. It was ~36 MB until 3.1 shipped the screencast from a
hosted URL instead of `assets/console.gif`, which is now on the never-ship list so the regression
cannot come back quietly. It grew from 2.2 MB at 3.1 because 3.2's `precompress` step writes a
`.br`/`.gz` sibling beside every compressible file in `client/dist` — those are load-bearing, not
slack: `server/http/static.ts` serves them and never compresses at request time, and
`check-dist.mjs` gates first paint on the bytes that would actually be **served**. Re-measure with
`bash .github/scripts/pack-and-assert.sh --keep` and read the file it names, rather than trusting
this line — a bare `npm pack --dry-run` skips the emit and undercounts by the ~148 files it adds.

## Upgrading to 5.1.0

The root `package.json` says 5.1.0, and `CHANGELOG.md` carries its section. 5.1.0 is a minor version
and it is **additive**: nothing a 5.0.0 plan, session or script does meets a refusal it did not meet
before. Every new door — a run's own checkout, landing, notes, the publish flag — is closed until a
plan directive or a capability flag opens it, and every new lint fires only on a directive 5.0.0 did
not have. What follows is what an operator, a plan author or a session running an older copy will
notice, in the order they are likely to notice it.

### Plans: new directives, and the lints over them

- **Nine directives the engine and the console parse identically**, each answering
  `word<TAB>phase|plan|default` — `--land`, `--landing`, `--base-branch`, `--gitlink`,
  `--conflict-policy`, `--isolation`, `--clash-zones`, `--issues`, `--messaging`, plus `--notes` and
  `--verified`. A plan that writes none of them reads exactly as it did under 5.0.0.
- **Five lint ids are new, and each names itself in its line.** Three gate: F26 `note-target-unknown`
  (a forward note addressed to a phase the plan does not have), F27 `land-word-unknown` (a `Land:`
  word outside the vocabulary), F29 `landed-gate-unknown-phase` (a `landed N` gate naming a phase the
  plan lacks). Two advise on stderr and never change the exit code: F28 `land-needs-lane` (a phase
  that lands from a checkout it shares) and F30 `note-target-done` (a note addressed to a phase that
  has already finished). The advisory family is therefore F15–F19, F22–F23, F28 and F30.
- **Two self-evaluating gate kinds**, `landed N` and `pr-merged N`, read the landing ledger and run
  nothing. A plan that uses neither is unchanged.
- **The handoff format gains `## Notes for later phases`**, the only channel that reaches a phase
  which has not started; `phase-graph.sh <slug> --notes N` collects a phase's notes into its boot
  prompt. Optional — a handoff without the section is a valid handoff.

### Sessions: new scripts and arms

- `phase-graph.sh <slug> --notes N`, `--verified`, and the directive arms above; `phase-outcome.sh
  <slug> <N> ruling --kind deferral --for <M|next|all>`; `scripts/phase-landing.sh`, the landing
  ledger's deterministic writer.
- **A 5.0.0 copy of the scripts rejects the new flags as unknown options (exit 2).** As at 5.0.0: a
  session declares with the script its boot prompt names, so move the runtime console's copy and the
  plugin together — that is the roll-out's first step — before a boot prompt tells a session to pass
  `--for` or read `--notes`.

### The run: a checkout of its own, locks, one trace id

- **`--allow-publish` is the eighth capability flag**, off by default like the other seven: it is what
  lets the console push a finished phase's `pe/*` branch — never a trunk, never with force — and file
  issues on the repository's behalf, where a plan's `permission.destructive` row allows the act.
  `phase-console doctor` gains a non-blocking `publish` row. A console started without it behaves as
  5.0.0 did.
- **A run's branch forks from the trunk at a pinned sha** (`run.isolation` records `base`/`baseSha`,
  `run.base-branch` records the word and who declared it); a console's worktrees are `git worktree
  lock`ed with a reason naming the console, the plan, the phase and the time, and sweeps unlock only the
  console's own stale locks. The retention word — `keep-on-failure` (the default) · `prune` · `keep` ·
  `ttl:<h>` — decides what becomes of a checkout when the run settles; a dirty tree is never removed. A
  per-repository cap bounds how many isolated runs stand beside each other; `.worktreeinclude` copies
  ignored-but-needed files into a fresh worktree; `- **Isolation:** shared|worktree` lets one phase
  carve itself out of the plan-wide word.
- **Locks are claimed with `ln`**, so two concurrent claimers can no longer both be told "claimed"; a
  lock with no `scope=` line reads as `all` in the scheduler as it always did in bash; the runner claims
  provisionally at grant and STOPS the lane on losing the lock; run ids are twelve hex characters (every
  reader widened together). New journal line `phase.lock-provisional`.
- **One trace id joins a run's HTTP request, drive, phase attempts, sessions, scripts, presence hook
  and git commands**; `viewer/server/shell.ts` is the one seam under every child process. The log
  envelope is v2, with a `debug` level and `PHASE_CONSOLE_DEBUG=<channel>`; a journal at its cap writes
  an in-band `journal.full` marker and keeps a reserve for `run.finished`.
- **Nothing grows without a bound.** `viewer/server/retention.ts` sweeps transcripts, task ledgers,
  outcomes, git traces and the supervisor's stdio by a table Settings ▸ This instance ▸ Logs and
  retention can preview; rulings are never pruned. `sessions/<id>.events.ndjson` keeps each session's
  raw hook payloads, capped at 1 MB with one marker line. `GET /api/debug/bundle?slug=&run=` and
  `phase-console diagnostics --run <id>` export one run as one redacted tarball — the second works with
  the console down.
- **Nine shared-`.git` verbs raise a permission card on every profile** (`git stash`, `config`,
  `worktree`, `submodule`, `checkout`, `switch`, and `gh issue create`/`comment`/`close`), because one
  of them in a shared checkout is another lane's problem. A plan that never runs them is unchanged.


### Packaging: what the tarball gained

- The root `package.json` `files` allowlist gained `viewer/shared/landing-model.js`,
  `viewer/shared/message-model.js`, `viewer/shared/issues-model.js` and `viewer/shared/poll-loop.js`.
- `.github/scripts/assert-tarball.sh` asserts the new runtime files: `viewer/server/trace.ts`,
  `viewer/server/shell.ts`, `viewer/server/git-trace.ts`, `viewer/server/counters.ts`,
  `viewer/server/retention.ts`, `viewer/server/retention-policy.ts`, `viewer/server/debug/bundle.ts`,
  `viewer/server/debug/tar.ts`, `viewer/server/runner/usage.ts`, `viewer/server/runner/verify-review.ts`,
  `bin/diagnostics-verb.mjs`, `scripts/phase-landing.sh`, `scripts/landing.env`, `scripts/messages.env`
  and `scripts/issues.env`.


## Upgrading to 5.0.0

The root `package.json` says 5.0.0, and `CHANGELOG.md` carries its section. The tag and the Releases
are cut by hand, never by a session. This section is the migration list that changelog entry points
at. Each change below is something a plan author, an operator, a script or a session running an older
copy will meet.

### Plans: three lint ids now gate

The engine's `--lint` — and `validate.sh`, which delegates to it — now fails a plan on checks that were a
warning or did not exist under 4.1.0. Each names itself in the failing line, so a failure can be grepped for:

| Id | Line | Fails when |
|---|---|---|
| F14 | `verification-empty-open` | An open, not-done phase's §Verification holds nothing runnable — no backticked span containing a letter, and no fence. A done phase is exempt. It was an advisory. |
| F24 | `gate-directive-missing`, `gate-type-unknown` | A `*(GATED)*` heading has no `Gate-check:` directive — new: 4.1.0 skipped such a heading silently, and the board still answers `GATE_DEFAULT` (`ai`) — or its type is not on the list, which already failed lint under 4.1.0 (the board answers `manual`). |
| F25 | `decision-outstanding-unowned`, `decision-key-unknown`, `decision-state-unknown` | A `## Decisions` row — in the plan's table or its twin — is `outstanding` with no owner, names a key outside the vocabulary, or has a state outside `answered`, `outstanding` and `waived`. A plan with no `## Decisions` has no rows and passes. |

A plan that linted clean under 4.1.0 can fail under 5.0.0, and a run of it meets the runner's own
`validate.sh` check. Lint every live plan with the 5.0.0 scripts before a console is restarted onto them.

### Sessions: `--needs` is required, and rulings carry keys

- `phase-outcome.sh <slug> <phase> blocked` (or `needs-human`) without `--needs <key>` exits 2 and names
  the vocabulary — the keys in `scripts/decisions.env`, or their short classes.
- Every ruling line is stamped with an `id`; a ruling given `--needs <key>` is also stamped `decisionKey`,
  and `--remember plan|global` promotes it as it is recorded.
- **A 4.1.0 copy of `phase-outcome.sh` rejects both `--needs` and `--remember`** as an unknown option
  (exit 2). A session declares with the script its boot prompt names, so a 5.0.0 duty handed to a 4.1.0
  script fails the declaration. Move every copy a session may be told to call — the runtime console's and
  the plugin's — to 5.0.0 before a session is told to pass either flag.

### The run door and the policy defaults

- **A fresh start answers 400 without its three answers.** `POST /api/run/<slug>/start` must carry
  `resumeOnRestart` (a boolean), `relay` (`off` or `last-resort`) and a non-empty `accounts` list, and the
  refusal names what is `missing`. A resume (`resumeRunId`) answered them at its own door and is exempt.
  The console's Decisions stage sends all three; a script that starts runs over HTTP must now send them
  too.
- **A well-formed start the prelude refuses answers 409.** A start with no delivery channel is admitted
  only with `acknowledgedWaivers: ['announce']`.
- **`delegateHumanGates` ships `true`** (4.1.0 shipped `false`), and `policy.gates` overrides it. A
  delegated human gate whose gate status states no condition stays `gated`.
- **`qa.exhausted` defaults to `waive`.** At QA exhaustion the phase is waived by policy — journalled
  `phase.qa-waived` with `by: policy`, and `phase.policy-answered` — where 4.1.0 parked it with an errand.
  `halt` halts the run `plan-deadlocked`; an owner's name parks the phase with that owner named.
- **`phase.tool-auto-granted` is renamed `phase.approval-auto-granted`.** The old row stays in
  `docs/journal-events.md`, retired; anything that reads journals across the upgrade must match both.
- **An approval card is never `expired` any more.** A card a restart leaves unanswerable is filed
  `unanswerable` with a reason — `session-gone` (the default for what `pending.json` held), `token-lost`,
  `asker-gone`, `reoffered` or `hook-closed`.
- `MAX_AGENT_PROMPT_BYTES` (`viewer/server/agent.ts`) is 32 KB, up from 16 KB.

### Claude CLI floors

Both constants live in `viewer/shared/run-settings.js`:

| Constant | Floor | What it gates |
|---|---|---|
| `RELAY_CLI_FLOOR` | **2.1.268** | A `last-resort` run arms the relay only on a version a session's `system/init` reported at or above the floor, and journals `run.relay-armed` or `run.relay-refused` (`version-unknown`, `below-floor`) when that changes. An unknown version refuses, so a fresh console's first session runs relay-off and its own `system/init` arms the next. A refused run's sessions run as relay-off ones do. |
| `PERMISSION_PROMPTS_CLI_FLOOR` | **2.1.259** | A relay-off session spawns with `--permission-prompts none`. On a CLI that reported a version below the floor it spawns without the flag, and `run.permission-prompts-skipped` is journalled once per run. |

### Push, the machine profile and liveness

- **Every console's notification tags change once.** Tags are namespaced by the console's id, so a card
  delivered before the upgrade is not replaced by its successor after it. Titles now name the console.
- **Every console reads `~/.config/phase-console/fleet.json` at startup** — remote host and logins,
  notifier, webhook rows — and a flag still wins. Remote settings written there no longer belong on any
  command line; a console that finds only half of the remote pair there boots local-only.
- **Liveness comes from a heartbeat.** A registry row whose console has not yet run under 5.0.0 reads
  `unknown` until it starts once.


### Packaging: what the tarball gained

- The root `package.json` `files` allowlist gained `viewer/shared/decisions-model.js`,
  `viewer/shared/cli-tools.js`, `viewer/shared/policy-model.js`, `viewer/shared/relay-model.js` and
  `viewer/shared/fleet-model.js`; the free tree's allowlist gained the same five.
- `.github/scripts/assert-tarball.sh` asserts the new runtime files: `viewer/server/accounts/learned.ts`,
  `viewer/server/accounts/entitlement-probe.ts`, `viewer/server/runner/session-record.ts`,
  `viewer/server/runner/wait-budget.ts`, `viewer/server/runner/run-paths.ts`, `viewer/server/actor.ts`,
  `viewer/server/api/actor.ts`, `viewer/server/start-ceiling.ts`, `viewer/server/runner/policy.ts`,
  `viewer/server/prelude.ts`, `viewer/server/credentials-probe.ts`, `viewer/server/doctor.ts`,
  `viewer/server/relay.ts`, `viewer/server/relay-host.ts` and its emitted `.js`,
  `viewer/server/cli-init.ts`, `viewer/server/shutdown.ts`, `viewer/server/fleet.ts`, the five shared
  modules, `bin/doctor-verb.mjs`, `bin/sessions-verb.mjs`, `scripts/decisions.sh` and
  `scripts/decisions.env`.



## Secrets

None. No token exists for any registry, and the release script acts as the person running it
(`gh auth status`). `.secrets/` stays gitignored for whatever a machine keeps locally, and nothing
in this repository reads it.
