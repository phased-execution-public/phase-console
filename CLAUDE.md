# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This is the **source of the `phased-execution` Agent Skill itself** — not a project that uses it.
Work here is skill authoring: the procedure Claude follows (`SKILL.md`), the bash engine that computes
phase state (`scripts/`), and Phase Console, the local web app that reads it (`viewer/`).

It installs two ways from one tree: as a plain skill (clone into `~/.claude/skills/`) or as a plugin
(`.claude-plugin/marketplace.json`, `strict: false`). **There is deliberately no `plugin.json`** — the
marketplace entry carries the metadata so the folder stays a valid bare skill. Don't add one.

**Skill vs work-state.** Plans, handoffs, QA reports, locks and `test-status.md` are *work-state* and
live in the consuming project's repo under `docs/plans` / `docs/handoffs`. Never write work-state into
this tree; `tests/fixtures/plans/` is the only place plan markdown belongs here.

## Commands

```bash
tests/run-tests.sh            # the bash engine: shellcheck (if present) + bats unit + integration
bats tests/unit/parse.bats    # a single suite
bats -f "gated" tests/unit    # a single test by name filter
```

`bats-core` is required (`brew install bats-core`). Tests are hermetic: each creates its own
`DOCS_ROOT` in `$BATS_TEST_TMPDIR` and copies a fixture plan in.

```bash
cd viewer
npm ci                        # once
npm test                      # server + shared contracts (node --test, needs no build)
PHASE_CONSOLE_TEST_ROOT=~/code/your-repo npm test   # + integration and engine-parity tests
node --test test/runner.test.ts                     # a single server test file
npm run test:client           # client suite (Vitest + jsdom)
npm run typecheck:client      # two programs: the app (DOM libs) and the service worker (WebWorker libs)
npm run lint:client           # ESLint over client/src + shared (typescript-eslint, react-hooks) — zero warnings
npm run format                # Prettier over the same files (`format:check` is what CI runs)
npm run dev                   # Vite on :5173, proxying the live console on :4123
npm run verify:dist           # build into client/.dist-verify + the gate — leaves the LIVE dist untouched
npm run build                 # emit client/dist and stamp .build-rev
npm run check:dist            # the build gate — run it after every build
```

```bash
./start [<repo-with-docs-plans>] [--allow-writes] [--port N] [--no-open]   # run the console
phase-console doctor [<instance>] [--json]      # the start's probes + the machine checks, no plan needed
phase-console sessions ingest [<instance>]      # drain the presence inbox while no console is up (the hook runs it)
```


**Identity, the registry and ports** live in
`viewer/shared/instances.mjs` — the single definition everything else imports rather than re-deriving
(`config.ts` and `bin/phase-console.mjs`).
An instance id is
`sha256(resolve(root))[:8]-basename(root)` — resolution is **lexical, never `realpath`**
(`instances.mjs`, `scripts/instance.sh`), so `/p/repo`, `/p/repo/` and `/p/sub/../repo` are one
instance while a **symlinked root is a different instance from its target**: start the console and run
its sessions from the same spelling of the path, or they write to two different state directories.
The default instance keeps port 4123, the bare
`com.phase-console` unit name and the top-level state paths.
Identity **must** resolve at module load — log, notification, push and approval paths
are module-level consts, so a late resolution writes global state while reporting a private id.

The Node suite must keep passing **without** a client build — a fresh clone verifies the server before
`dist` exists (`test/static.test.ts` holds the not-built answers, including the `/sw.js` fallback).

## Architecture

Three layers, in strict dependency order. Each lower layer is authoritative for the one above.

**1. `scripts/` — the engine (bash, deterministic, output-only).**
`phase-graph.sh` is the single source of truth for **done / ready / waiting**, session batching, boot
prompts, QA regime and lint. It parses the plan's `## Phase graph` table plus live handoff frontmatter
and recomputes state every time — there is no stored "current phase" cursor anywhere in the system, by
design, so out-of-order and resumed work stay correct. The other scripts (`new-plan.sh`,
`new-handoff.sh`, `next-phase-prompt.sh`, `handoff-status.sh`, `validate.sh`, `phase-lock.sh`,
`qa-record.sh`) all call it rather than reimplementing readiness.

**2. `SKILL.md` — the procedure.** Frontmatter (`name` + `description`) is the only part always in
context; the body loads only when the skill fires. Three modes: `plan`, `phase-start`, `phase-finish`.
Deep material is deferred to `references/` (plan format, handoff format, conventions, sizing, QA
method) so the body stays small — keep new detail there, not inline.

**3. `viewer/` — Phase Console.** Node 22.18+/23.6+ server (runs TypeScript directly, zero required
runtime deps — `node-pty`/`ws` are optional with honest degradation) plus a Vite/React client that
is *built output*. It **shells out to the layer-1 scripts**
for every status claim and never recomputes them; its own JS parsing covers only what the scripts
don't expose (prose sections, handoff bodies) plus analysis they don't provide (critical path,
velocity). `server/service.ts` is the model, `engine.ts` the script wrapper, `store.ts` the files,
`runner/` the autopilot, `accounts/` the Claude identities it may spend, `launcher.ts` the desktop
artifact, `api/routes.ts` the surface. `shared/` is dependency-free ESM imported by both the Node
tests and the client.

### The client — eight destinations, and the vocabularies they share

Since 4.0 the client is eight destinations in three bands — **the work** (Now · Plans · Runs ·
Sessions) · **the record** (Repo · Insights · Debug) · **the console** (Settings) — under one shell
(`client/src/app/`), with every older address still resolving. The band is the rail's grouping and
the phone tab bar's split: the four work destinations ARE the bar, the rest are the More sheet.
`Repo` and `Debug` are 4.0's additions, both built: Repo is six sections over the `GET /api/repo/…`
and `GET /api/issues` surfaces (`features/repo/` — the sixth is the issues estate), Debug is every
log this console writes on one time axis plus the redacted bundle (`features/debug/`). `views/` is gone;
a page lives in `client/src/features/<destination>/`. Overlays (`?k=` palette, `?help=`, `?bell=`)
are query params, never routes: open ⟺ the URL says so, so navigating anywhere closes them.

Its rule is the same one-source rule as `sizing.env`, and it is what the whole redesign existed to
establish — a vocabulary lives in `shared/` and is imported by identity by server, client and tests:

- `shared/status-vocab.js` — the 8 UI states worst-first (`needs-you failed running verifying
  waiting queued skipped done`), the status→state maps, and `isLiveStatus`/`LIVE_RUN_STATUSES`
  (which is deliberately NOT the server's `IN_FLIGHT`: it includes `queued`, because a loop is
  behind a queued run even though it holds no child and no lock). Hue and icon are read in exactly
  one component, `ui/status-badge.tsx`.
- `shared/route-meta.js` — the route heads and the eight destinations, asserted at module load.
- `shared/situation-model.js` · `shared/ladder-model.js` · `shared/recovery-model.js` — the
  situation, rung and recovery-class vocabularies.
- `shared/attention-model.js` (the inbox — and the OWNER of `RULING_KINDS`, which
  `evidence-model.js` re-exports) and `shared/evidence-model.js` (`deriveEvidence`, exposed
  as `proof`, never `evidence` and never `done`).
- `shared/plan-vocab.js` — the plan-file words: plan status + the three terminal ones, the QA
  vocabularies, the FROZEN handoff statuses, gate kinds.
- `shared/ops-vocab.js` — the console-machinery words: health severity, MCP status/transport,
  account kind + auth state, the entitlement breaker (`ENTITLEMENT_STATES`,
  `ENTITLEMENT_TRANSITIONS`), delivery outcome (`no-device` included), ETA basis, and the shutdown
  words — `SHUTDOWN_MODES` (`exit`, `unload`), `SHUTDOWN_DURABILITIES`, `SHUTDOWN_INTENTS`,
  `SHUTDOWN_CLOCK_SOURCES` — plus `BOOT_HOLD_KINDS` (`stopped`, `autostart-off`).
- `shared/run-settings.js` — the run's own settings, including the permission profiles, their
  labels, the CLI permission modes, `RELAY_MODES`, the two CLI floors (`RELAY_CLI_FLOOR`,
  `PERMISSION_PROMPTS_CLI_FLOOR`) and `versionAtLeast`, the one comparison both are read through.
- `shared/run-lifecycle.js` — every word a run, a phase, a rung, a queue entry or a watch ref can be,
  plus `START_DOORS` (with `OPERATOR_DOOR`), `SESSION_MODES` and the reviewer policies.
- `shared/decisions-model.js` — the decision manifest (`DECISION_KEYS`, `DECISION_STATES`,
  `DECISION_SOURCES`); `shared/policy-model.js` — the policy table over it: each class of
  intervention, the manifest row that answers it, the shipped default and the journal line.
- `shared/relay-model.js` — the relay's window and answer clock, the per-phase question budget, the
  exclusions and unanswerable reasons, who answered, the relay rules, and `pickAnswer`.
- `shared/cli-tools.js` — `CLI_TOOLS`, the tool names Claude Code provides, which is what a
  permission rule may name.

Add a state, a rung or a route in the shared file and nowhere else. Three copies that agree today
are three copies that disagree the day a word is added — which is how a finished run gets painted as
running on one page and settled on another. **`test/vocab-owners.test.ts` is what enforces this**:
it asserts each consumer holds the owner's OBJECT (not an equal copy), and scans `server/`,
`client/src/` and `shared/` for any file that writes a vocabulary's members out as a literal again.

#### The BOARD words — which list is the engine's truth (settled in P23)

Five board word-lists are live, and they are one vocabulary with four deliberate shapes. Do not
"unify" them; the differences are load-bearing.

**The engine's truth is the FIVE BUCKETS** — `done · in-progress · stuck · ready · waiting` — owned
by `shared/status-vocab.js` as **`BOARD_BUCKETS`**. That is exactly what `phase-graph.sh
--memory-block` emits (`scripts/phase-graph.sh:1825-1829`) and exactly what `server/engine.ts`
parses. Every phase is in exactly one bucket.

| List | Shape | Why it differs |
|---|---|---|
| `status-vocab.js` `BOARD_BUCKETS` | the 5 | **the owner** — the only place members are written |
| `phase-model.js` `BOARD_ORDER` | the 5, operator order | a display ORDER over the owner's members |
| `analysis/metrics.ts` `PHASE_STATES` | the 5, emit order | Prometheus label values; order kept so scrape diffs do not churn |
| `evidence-model.js` `BOARD_WORDS` | the 5 **+ `unknown`** | the evidence layer also has to say "the board could not be read" |
| `status-vocab.js` `BOARD_STATE_UI` | the 5 **+ `gated` + `blocked`** | a PAINT table, which also paints two console-only overlays |

Two words look like board states and are not buckets: **`blocked`** is a HANDOFF status that
`phase_status()` folds to `stuck` before the board sees it (`phase-graph.sh:560` — the `blocked:`
line in the machine block is a different field, the blockedBy pairs), and **`gated`** is a per-phase
FLAG orthogonal to the bucket, so a phase can be `ready` AND gated. They live in
`BOARD_OVERLAY_STATES`.

Adding a sixth bucket means editing `BOARD_BUCKETS` and nothing else.

### Accounts and the usage window

`server/accounts/` is two stores with two scopes. The **registrations** are per instance, like the
push keys and unlike `runs/` — two consoles on one machine are usually two projects with two ideas
about whose quota they may burn: `store.ts` is the registry of three kinds (`default`, the machine's
own `claude` login, synthesized on every read and never stored or deleted; `profile`, a
console-managed `CLAUDE_CONFIG_DIR` the operator signs into; `token`, a pasted `claude
setup-token`), under `INSTANCE_STATE_DIR/accounts`, and `accounts.json` never holds a secret. What
the machine has **learned** about a credential is machine-wide: `learned.ts` keeps one
`<stateHome>/accounts/learned.json`, keyed by the credential's fingerprint — its walls, the
entitlement breaker (`unknown · entitled · cooling · retired`, moved only along
`ENTITLEMENT_TRANSITIONS`; a transition outside that table is refused and logged), the meter-read
clocks, the hashed organisation id (a `retired` organisation excludes every account in it) and the
tombstone a removed registration is still named by — because a wall one console learned used to be
invisible to the other. `credentials.ts` is the only file that touches secrets — keychain or a 0600
file for ours, **read-only** for the CLI's own, because a second writer is how two processes corrupt
one login — `usage.ts` polls the same endpoint the CLI's own `/usage` asks (gently: single-flight,
every ~90 s for an account a runner is spending and every ten minutes otherwise, harder backoff on
429), `transcripts.ts` copies a session's `.jsonl` into the target account's config dir so `--resume`
finds the conversation, and `index.ts` is the facade whose every answer is already redacted, so the
boundary is there and not in a route. Its quota door (`headroom`) refuses a start by name on a
retired credential, until the reset on a learned wall, and at `PREFLIGHT_REFUSE_PCT` (97) on a live
five-hour meter.

Two rules the code is built around. **Bucket names are data, not schema** (`five_hour`, `seven_day`,
`seven_day_opus`, whatever tier ships next) — anything with a `utilization` and a `resets_at` is a
meter, rendered by name; a per-model wall files under its own bucket so `auto` skips an account only
for that model. And **the poller is telemetry, never the detector** — the runner's own limit
classifier works with the meters unavailable, so a 429 or a vanished endpoint degrades to stale
numbers with their age attached, never an error page.

At a wall the run's `onLimit` policy decides: `wait` sleeps on the window (restart-safe — the run
reconciles to `paused` with its clock intact and the service re-arms the resume at boot), `switch`
checkpoints the live session and re-attempts at once under the account with headroom, `pause` means
what it says. The scheduler's usage throttle is keyed **per account**, so one spent login never
stalls a queue another account would pay for; `throttledUntil` stays as the soonest expiry for
readers that predate that.

### Getting the console started — the desktop artifact and the start command

`server/launcher.ts` behind `/api/launcher` writes the desktop artifact itself, per platform and
honestly: macOS gets the shipped `.command` template with its knobs patched, Linux an
XDG `.desktop` whose `Exec` paths are baked absolute (Exec lines expand no variables), Windows the
WSL story rather than a shortcut that would break. Everything filesystem-shaped is a parameter, so
tests never touch a real Desktop. **Bump `LAUNCHER_REV` whenever the template's argv changes** — that
is what tells an installed copy it is stale instead of letting it start a console whose Settings
disagrees with it. The Settings start-command card composes the same line from the console's own
facts and renders every path as `$HOME/…`: the line must paste on any account and a screenshot must
carry no username, and a scrubbed test keeps the shipped template personal-path-free. `viewer/run`
looks past the PATH's `node` when it is below the floor (Homebrew, `/usr/local`, volta, newest nvm)
rather than refusing.

### Invariants that tests enforce — don't break them casually

- **Engine parity.** `viewer/test/engine-parity.test.ts` re-derives every plan's board from the JS
  parser and asserts it matches `phase-graph.sh`. Run it after touching *either* parser.
- **F5 — one sizing source.** `scripts/sizing.env` holds every size weight and per-model budget, and
  `scripts/mcp.env` the per-attached-server surcharge.
  `phase-graph.sh` sources it, `references/sizing.md` documents those exact numbers, and
  `viewer/server/analysis/graph.ts` reads the same file. Change a number only there.
- **F1/F2/F3/F20/F21 — structural lint** (malformed phase cell, undefined dependency, cycle, a table
  whose columns cannot be located by name, a cell the parser read but could not believe) lives in
  `phase-graph.sh --lint`; `validate.sh` delegates to it and adds handoff body/consistency checks.
  F20 and F21 are F1-tier gates, not advisories — `LINT OK` on a plan whose scopes are fiction is how
  two sessions end up in one working tree.
  **F14** rides the same arm as a WARNING (stderr, exit untouched): an open, not-done phase whose
  §Verification holds nothing runnable — the thing the autopilot would otherwise park on at boarding.
  **F15** rides it too, same tier and same reasoning: a plan or phase naming an MCP server, an
  account or a credential this machine has not registered — the console tells bash its registries
  through `PE_MCP_SERVERS`, `PE_ACCOUNTS` and `PE_CREDENTIALS` (unset disables the check; set but
  empty is a real answer), and the run-start prelude is the gate that acts on it. **F16** rides it too: a §Verification command that waits on an
  external clock (`gh run watch`, `task deploy`, `--watch`/`wait` flags, long sleeps) — runnable by
  F14's test, unfinishable inside a session's turn; split the phase behind a Gate-check or expect a
  runtime park. **F17** and **F18** complete the family, both born from one measured incident class
  (16 verify-failed halts, 15 spurious): F17 warns when a §Verification lead is not installed on
  THIS machine (`rg` a shell function elsewhere, `python` meaning python3) — the runner now SKIPS
  such a command at verification (recorded, never failed; a phase whose every check is skipped
  parks) — and F18 when a cwd-sensitive lead (`pnpm`, `docker`, …) has no `**Verify in:**`, since
  verification runs at the repository root. `scripts/verify.env` is the F5-style single source for
  those two word-lists, sourced by bash and parsed by `runner/verify-env.ts` with a drift test.
  **F19** is next: an open plan that cannot progress at all — nothing ready, nothing in
  flight, and a QA verdict holding every remaining phase. **F22** and **F23** close it, both about a
  §Verification that will be read by a machine: F22 when a bring-up command sits inside it (move it to
  `- **Setup:**`, which runs BEFORE verification and can never colour a phase red), F23 when an expected
  failure is stated in PROSE beside a command (the runner reads exit codes, not sentences, so it calls
  that phase red). The advisory family is therefore F14–F19 plus F22–F23 — eight ids.
- **An empty `ready` set is four facts, so the engine says which.** `--memory-block` is the only
  engine command the runner reads, and it emitted five bucket lines — collapsing "finished", "all in
  flight", "closed" and "nothing can ever move again" into one silence. It now also emits
  `blocked: 2<-1(qa:fail) 4<-2(not-done),3(qa:pending)` when something is waiting, parsed into
  `Board.blockedBy` / `Board.qa` (`engine.ts`), and that is what lets a deadlocked plan halt with
  `kind: 'plan-deadlocked'` anchored on the phase actually holding it. The line is additive —
  `readMemoryBlock` ignores lines it does not know — but it is a CONTRACT now: change the shape in
  `phase-graph.sh` and `engine.ts` together, and run `viewer/test/engine-parity.test.ts`.
- **QA gates only when the plan says so.** `QA_GATING` derives from `qa_mode()`, not from
  `test-status.md` merely existing: `**QA gate:** off` (→ `waived`) means recorded verdicts stop
  holding dependents, which is the only release there is. It is opt-in and in writing, per plan —
  `fail` under `on` gates exactly as before. Two rules ride with it: a `pending` row holds dependents
  as hard as a `fail` (so `--boot-prompt` names the finish-time QA duty an unattended session would
  otherwise never learn), and anything that CREATES `test-status.md` must backfill already-complete
  phases as `waived` — `new-handoff.sh` always did, `qa-record.sh` now does, and the console's own
  "turn QA on" reaches the second one.
- **bash 3.2.** The scripts' target runtime is macOS system bash. `tests/helpers/test_helper.bash`
  forces `/bin/bash` for every script under test — no associative arrays, no `${var^^}`, no `mapfile`.
- **Never implicitly build the client.** `client/dist` is gitignored; the console warns when the build
  is stale and serves an explanatory page when it's missing, but nothing builds on its own. The
  launchd boot path especially never builds, so a crash loop can't burn its throttle interval.
- **`sw.js` stays at the root and stays push-capable.** Live push subscriptions are bound to
  `('/sw.js', scope '/')`; moving or renaming it unsubscribes every device silently. `check-dist.mjs`
  guards this and several other one-time regressions — read its header before weakening an assertion.
- **The console binds to `127.0.0.1`, always.** `--remote` adds an allowlisted proxy hostname and
  identity check; it deliberately does not widen `--host`. The `Tailscale-User-Login` header is only
  trustworthy because nothing but the proxy can reach the port.
- **Permission `deny` is identical across all three run profiles.** Profiles move only the ask list.
  The classifier, `classifyTool` (`runner/approvals.ts`), reads deny FIRST, then answers `hold` for
  `QUESTION_CLASS` (`AskUserQuestion`) from its own constant — never from the ask list, which a
  profile, a strike or a written allow rule can empty; a `hold` is answered by the relay on an armed
  run and by the plan's `ambiguity` row everywhere else. The two publishing asks in `OPEN_PR_ASK`
  (`git push`, `gh pr create`) are never auto-granted: only a `permission.destructive` row in the
  plan's manifest lets the console answer one, and that answer is announced.
  The PreToolUse hook fails open and carries workflow, never safety. The **Stop hook** rides the same
  settings file with the same philosophy: it nudges a session ending with neither a handoff nor a
  declared outcome (at most twice), fails open, and the runner's own exit-time outcome check — not
  the hook — is the load-bearing enforcement.
- **The outcome protocol is the session→runner channel; prose never is.** A session declares how it
  ended via `scripts/phase-outcome.sh` → one atomic JSON file at `PE_OUTCOME_FILE`, read once,
  journalled, consumed, staleness-guarded twice (deleted pre-spawn; `written_at` checked against the
  attempt). `waiting-external` parks the phase as `waiting` and the resume is ALWAYS the phase's own
  session (`--resume`) — never a fresh boot, never a pty agent. The handoff `.md` stays the
  engine/human contract; its status vocabulary (`complete|in-progress|blocked|pending`) is frozen —
  `waiting` is a runner state, never a handoff status.
- **Reconcile closes records, never re-runs them.** The drive loop's reconcile pass (and the
  read-path resolver) flips a record the board has overtaken to `done` ("closed outside this run")
  and dissolves halts anchored to it; a `failed` record whose phase the board does not show done is
  untouched. Recovery is resolve-first (board re-read before any launch), the session API is the
  first vehicle (`--allow-run`), the pty agent is for plan repairs (`--allow-agent`) and people, and
  "found nothing wrong" is a recorded outcome (`no-defect`), not a failure.
- **A process is a fact; a record is a claim — settle the claim against the fact.** The class this
  closes: a phase-9 session outlived its console, sat in state `T` for three and a half hours holding
  its session id and its lock, and the run record went on reading `running` the whole time — because
  the record was settled against `state.status`, which is another claim by the same dead writer.
  Three clauses, all pinned by `viewer/test/invariants.test.ts`. **One place asks:** `server/pid.ts`'s
  `processState` is the only probe — the only `kill(pid, 0)` and the only shelled `ps` in `server/` —
  because two probes disagreeing about one process is how a stopped session read as alive (`ps -o
  comm=` answers `claude`; `ucomm` answers the version string the CLI execs, so it is `comm`).
  **One place acts:** `server/runner/signals.ts` is the only place that signals one — SIGCONT first
  (a stopped process queues SIGTERM and never runs its handler); then SIGINT, once, to the CLI leader
  itself and never its group — SIGINT closes the turn and writes the `result` the CLI books turns and
  dollars in, SIGTERM does not — with `INT_GRACE_MS` (5 s) to leave; then SIGTERM to the process
  GROUP (`-pid`, so the child's bash, MCP servers and subagents go with it); and always a SIGKILL
  backstop, **awaited** rather than armed on a `setTimeout` that dies with the console that set it.
  The MCP probe takes the same ladder with the interrupt rung off — it has no turn to close — so its
  ending is SIGTERM to its group, `PROBE_TERM_GRACE_MS` (3 s), then the SIGKILL its `npx` shims
  need. The lint allows six other `.kill(` files, each by name and reason (`KILL_ALLOWED` in the
  test), and fails when that set changes in EITHER direction, so a reason cannot rot. **The handle outlives the console that made it:** `syncMirror` MERGES `state.children`
  and never rebuilds it, so a ChildRef for a phase this console holds no lane for survives
  byte-for-byte and only the probe may drop it; identity is the `(pid, procStartedAt)` tuple, never
  `child.startedAt`, which is the PHASE's clock and is hours off on a retry. **And no reader ever
  sees work in flight over a process that is gone** — `settleInFlightRecords` runs on the read path
  for every run status, not only the in-flight ones, because the statuses a dead console leaves
  behind (`parked`, `halted`, `interrupted`) are exactly the ones the old early-return skipped.
- **The ladder climbs; a person is asked once, with an errand (since 2.3.0).** A stopped phase is
  never healed by its halt kind: `runner/situation.ts` classifies it from evidence (board, handoff,
  record, lock + the session registry, the tree, the transcript, the declared outcome, gate, MCP,
  health) into one of the sixteen situations in `shared/situation-model.js`, and `runner/ladder.ts`
  climbs the rung table in `shared/ladder-model.js` — never the same rung twice per situation per
  phase, bounded by attempts AND dollars (the `ladder*` prefs), every rung journalled
  (`phase.situation` → `phase.rung` → `phase.errand`). Exhaustion parks the phase with ONE
  `Errand {need, how, tried}` and the run keeps driving; only the errand is pushed (`needs-you`).
  `Service.converge` (`converge.ts`) is the one unattended orchestration — at boot, on change, every
  `convergeEveryMs`, a minute after a halt, on Recover & continue — and it acts THROUGH the runner
  (`startRun({resumeRunId, reboard})`), never beside it; it touches only runs the operator did not
  stop, never a resolved one, and a console without `--allow-run` or with `--no-converge` never
  converges by itself. Presence is three-valued (`live` · `ended` · `unknown`,
  `sessions/registry.ts`): only a lock whose own `session=` the registry shows ENDED is debris
  before its lease; an owner/time match is display only and releases nothing. The three
  vocabularies (situation, ladder, recovery) are imported by identity by server, client and tests
  — add a situation, rung or class in the shared file and nowhere else. The console never spawns a
  reviewer itself; what the QA rungs do is resume the PHASE's own session and instruct it to
  dispatch the fresh-context subagent and record the verdict (`qa-verdict`, `qa-fix`), which is
  why both QA situations are actor `machine`. `autoClass: 'ladder*'` in `KIND_PROFILE` is still a
  word for a surface, never a launch. Every rung's vehicle has a driver in `VEHICLE_DRIVERS`
  (`console` · `writes` · `agent` · `never`, held total by `test/ladder.test.ts`): a rung this
  console cannot drive is skipped, a table with nothing drivable left is exhausted and its errand
  names what is in the way (`undrivableSentence`), and nothing waits on a rung nobody owns. A halt
  only a person's press relaunches is in `PRESS_ONLY_HALT_KINDS` (`converge.ts`) — `failure-streak`,
  because relaunching by clock was what reset the streak, and `credential-refused`, because a
  retired credential only meets the same wall — and converge closes just the run-level relaunch to
  them; the phases' own ladders still climb.
- **The engine is the authority on gate state, including for the healer.** `collectEvidence` takes
  a `gate` dep and `Service.evidenceDeps` supplies it as a live `--gate-status` read; the
  `record.gate` fallback is only for a read that could not RUN. It once had no dep at all, so the
  classifier judged a phase by the snapshot stored before the operator approved, answered
  `gated-manual` forever, and left the run halted while the board and the engine both said `clear`.
  For the same reason `evidenceFingerprint` includes the gate's stamp: approving moves neither the
  run, its records, nor the board word, so without it converge skips with "nothing has changed"
  against a gate a person has just opened. Both are pinned by tests — don't drop either.
- **A foreign unexpired lock queues, never terminally parks.** The scheduler owns the wait (holder
  named, lease end shown; woken by the docs watcher, a lease-expiry timer, and the idle poll;
  bounded by the 2-hour lock-wait cap); the boarding belt-check owns only the grant→spawn race
  window and resolves it back to the queue. The runner keepalives its lane's lock every lease/3
  under the shared `PE_OWNER` and stands down — never fights — on a foreign takeover.
- **A shipped default is struck by name — `deny` included, since 2026-08-06.** Removing a default
  records it under `removed.<list>` in the policy file rather than copying the list out and editing
  it — a copied list would freeze the defaults at whatever version the first edit saw, and an
  upgrade's new rules must still apply. Restoring is deleting that name. The deny half is a
  deliberate reversal of the old "no browser can unpick the wall" shape, on the operator's explicit
  ask; its terms are: the browser **confirms** a shipped-deny strike before writing it (the one
  confirm on the policy page — it widens what every future run may do, the CLI-side settings
  included), the per-run push carve-out **never resurrects** a struck wall, and profiles still never
  move deny. `approvals.test.ts` pins all three.
- **One spawn door, and every start names its door.** Every `claude -p` under `runner/` goes through
  `RunnerBase.spawnSession`, which is also the one writer of `phase.session`, and each
  `SESSION_MODES` member is exactly one call site — a session spawned beside the door is a session no
  census can see (`invariants.test.ts` clause 1). Every `startRun(` site names its door from
  `START_DOORS` (SLF-1) and passes `accountId` or `resumeRunId` (ACT-1). The automatic doors are
  counted by the per-instance start ceiling (`server/start-ceiling.ts`: 40 starts and $250 of reported
  session spend per sliding hour, `ceilingStartsPerHour`/`ceilingUsdPerHour`); `OPERATOR_DOOR` never
  is. The actor is DERIVED rather than defaulted — a route builds it with `actorOfRequest`
  (`server/api/actor.ts`), an automatic door with `doorActor` — and every `phase.situation` /
  `phase.rung` line carries `by` (RCV-9). Every `trySwitchAccount(` is preceded by `leaveAccount(`
  (ACT-5), and an exported setter on `Accounts` needs a production caller (ACT-3).
- **Halts, parks and waits have kinds.** `halt()` and `park()` take a `HaltKind` from
  `shared/recovery-model.js` — a writer naming a word the list lacks is a type error, and
  `waiting-is-a-state.test.ts` holds every written kind to `HALT_KINDS` and to exactly one of
  `PHASE_HALT_KINDS` / `RUN_HALT_KINDS`. A wait is `setRunState(state, 'waiting', { kind, until })`
  with a `WAIT_REASONS` kind — a standing verification or approval card is the `person` wait, never a
  `running` run with no child (`run-lifecycle.test.ts`).
- **Every journal and log name has a row in `docs/journal-events.md`.** Each
  `'<phase|run|policy>.<name>'` literal under `viewer/server/` and each `log.info/warn/error` first
  argument is documented there, checked in both directions; a name is never composed from a template
  literal, and a retired event keeps its row with `retired <version>` in the emitter column
  (`docs-parity.test.ts`). A new event is a new row in the same commit.
- **The relay is one call site, behind two floors.** `server/relay.ts` is the only file that calls
  `pickAnswer(`, the service enters `relayQuestion(` from one place, and inside it the deny list is
  read before any window opens (`invariants.test.ts` AC-14). The relay arms only at
  `RELAY_CLI_FLOOR` (2.1.268), judged from `system/init.claude_code_version` as `server/cli-init.ts`
  remembers it, never from `capabilities`; every session that is not armed carries
  `--permission-prompts none` at `PERMISSION_PROMPTS_CLI_FLOOR` (2.1.259) or later, and under a known
  older CLI the flag is skipped and journalled (`run.permission-prompts-skipped`). `phase-console
  doctor` compares the installed CLI against the relay floor.
- **Tests never touch the operator's state.** Every node test file that imports from `server/`
  imports `./state-sandbox.ts` first (or redirects `XDG_STATE_HOME` inline before that import — static
  imports evaluate in source order), and a console is spawned only through `test/spawn-console.ts`.
  `test/state-isolation.test.ts` enforces both, and belongs in every verification batch that runs node
  tests.

### MCP servers

`server/mcp/` is per-instance, like the account registrations and for the same reason. `store.ts`
holds no secret (`credentials.ts` is the only file that does — keychain, else 0600); `health.ts` is
the probe, and the probe is a **one-turn `claude -p`** whose `system/init` reports each server's real
status before any model call, because that is the only place `needs-auth` is knowable; `catalog.ts`
degrades to a shipped curated list when the official registry is unreachable; `config.ts` writes the
per-run `--mcp-config`, 0600, `chmod` after the write. The probe runs as `PE_OWNER=console/mcp-probe`
with `PHASE_CONSOLE_PROBE=1`, so the session registry keeps its record but leaves it out of every
operator-facing list; one answer is reused for `HEALTH_TTL_MS` (5 min), which is also the health
clock's period, and the boarding preflight reads that cache and joins a probe already in flight
rather than starting its own; and every probe is an automatic start, charged to the start ceiling.

Four rules the code is built around. **`--mcp-config` is always paired with `--strict-mcp-config`**
— alone it would UNION the machine's own servers into an unattended run, and determinism here is a
safety property; a phase degraded to zero reachable servers therefore still passes `strictMcp`, since
an emptied set must stay a closed one. **The preflight resolves before the spawn, never after**: an
unattended session cannot sign a server in (no `/mcp` panel in `-p`; the CLI tells the *model* the
tools are missing), so a wall found at boarding costs a probe and a wall found later costs an hour.
**A probe that could not RUN never degrades anything** — "I could not check" and "they are down" are
different facts (an id the registry does not hold is a third fact, and needs no probe). And **the
verdict is a policy, defaulting to `continue`** — since 2026-08-11, on a live failure: `parked` is
settled, so a run whose ready phases all park has no candidates and halts, and one signed-out server
stopped an eleven-phase plan that named no MCP servers at all. `continue` boards without the
unreachable servers, names them in the prompt with the record-an-errand instruction, writes
`record.mcpDegraded` and announces once per run per server; `require` is the old park, and its halt
now carries `kind: 'mcp-preflight'` plus the `mcp-continue` verb behind the halt card's button.

Resolution is `phaseOptions.mcpPolicy` → the PLAN (phase bullet, then §Session budget) → the run →
`continue`. **The plan outranking the run is deliberate and is the one place that ordering reverses**
— `optionsFor` resolves model and effort run-first, because those are preferences about spending;
this is a claim about the work. Only an operator's per-phase choice may overrule it. At the plan
level both words are recognised and everything else is silence, a THIRD state: an explicit `continue`
is how a phase carves itself out of a plan-wide `require`, and silence is what lets the run's setting
speak at all.

A phase's servers are the union of what the PLAN says (`--mcp` from the engine), what the run
attaches, and what the phase attaches; `mcpOff` drops only the run's, because the plan's statement is
versioned and describes the work. Policies **override** rather than union, for the reason above. F15
warns at plan time when a plan names a server the registry lacks — and names the consequence the
resolved policy actually produces, since a lint describing behaviour the console does not have is
worse than none. The engine is TOLD the registry through `PE_MCP_SERVERS` rather than reading JSON in
bash 3.2. An unfilled `${VAR}` in a server's own command (the catalog's `${MCP_FS_ROOT}`) surfaces as
`McpServerView.needsConfig`: it can never connect, so it is never attachable and never merely
"unchecked".

### Flags gate capability, one act each

`--allow-writes` (scaffold plans/handoffs, record QA, take locks — never commits or pushes, `--git` is
never passed), `--allow-run` (spawn unattended `claude -p` sessions that edit a repo for hours),
`--allow-terminal` (a real shell), `--allow-agent` (interactive sessions and the plan wizard),
`--allow-accounts` (register Claude accounts for this instance, pick one per run, switch mid-run —
*reading* the usage meters needs no flag), `--allow-mcp` (register MCP servers, hold their
credentials, attach them to plans and phases — *reading* the registry, the statuses and the catalog
needs no flag), `--allow-webhooks` (POST every announcement to the URLs you register — Slack, Discord,
Telegram, your own relay; the only flag that sends anything off the machine, and *reading* the
destination list needs none). All seven default off — the set is `CAPABILITY_FLAGS` in
`server/config.ts`, and `viewer/test/skill-sync.test.ts` holds this paragraph's count to it. Shut down
is deliberately *not* behind a flag. One flag switches something OFF rather than on: `--no-converge`
stops the convergence loop's automatic triggers; it is not a capability flag and is not one of the seven.

## Packaging, versions and releases

This tree ships through **two channels** — the Claude Code plugin (commit channel: **every push to
`main` is a release**, this repo is its own marketplace) and tagged releases (`vX.Y.Z` tags with a
GitHub Release carrying the packed tarball, cut by hand on the releasing machine — no registry, no
CI: `scripts/gates.sh` and the pre-push hook are the gates).
The full contract — how a change becomes an update, and the release steps — is
**`docs/releasing.md`**. The parts that bite:

- **Run `bash .github/scripts/scrub.sh` before every commit** (bare, never piped — failures are on
  stderr). Tokens go in gitignored `.secrets/`, never the tree — there is no CI and no secret store.
- A new server-runtime file (an import, a shelled script, a prompt-named reference) must be added to
  the root `package.json` `files` allowlist **and** `.github/scripts/assert-tarball.sh`.
- `npm pack` emits type-stripped `.js` beside every server `.ts` (Node refuses to strip under
  `node_modules`, where npm installs live); `postpack` deletes them. Never commit those `.js` files;
  never import `server/*.js` by hand — `fallback-sw.js` is the one real `.js` there.
- The Node floor (22.18+/23.6+) lives in five gates + docs — change it everywhere or nowhere
  (`docs/releasing.md` lists them).
- A package release = root `package.json` version bump + `CHANGELOG.md` section + `git tag vX.Y.Z`
  + a human `git push origin main vX.Y.Z`. Nothing pushes or publishes on its own.

## Docs and conventions

`README.md` is deliberately short — two copy-paste prompts and what the thing is. The long form is
`docs/` (indexed by `docs/README.md`); the console's own technical documentation is
`viewer/README.md`. English files have a Persian sibling (`README.fa.md`, `USAGE.fa.md`,
`viewer/README.fa.md`) — update both when changing either.

Commits use conventional prefixes with a human, declarative summary describing the change's *effect*
(`feat(run): automation defaults — opt-in skills, QA-on-launch, work branch + PR, repo guard`), not a
list of files touched.
