# Invariants that tests enforce — don't break them casually

The invariant paragraphs `CLAUDE.md` carried until 2026-10-25 under `### Invariants that tests enforce —
don't break them casually`, moved here verbatim by measured-console phase 5. Each names the test that
holds it; `CLAUDE.md` lists them by name. The architecture they protect is `viewer/docs/architecture.md`.

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
  **F14** rides the same arm and has GATED since 5.0.0 (`verification-empty-open`): an open, not-done
  phase whose §Verification holds nothing runnable. It asks only "is anything runnable?"; what the
  autopilot actually parks on — a single fragment it will not run under `Person-check: halt` — is
  answered by ONE review, `runner/verify-review.ts`, which boarding, the start response, the plan
  page, plan health, the repair gate and the prelude's fifth probe all ask (2026-09-18, run f0da619a:
  five weaker readers had called a `bats` line fine).
  **F15** rides the same arm as a WARNING (stderr, exit untouched): a plan or phase naming an MCP server, an
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
  that phase red). **F28** joins them in 5.1.0 (`land-needs-lane`): a phase that LANDS from a
  checkout it shares lands whatever else is in it. **F30** (`note-target-done`): a
  forward note addressed to a phase that is already done — the near miss of F26, and its own id
  because an id that both gates and warns cannot answer "did the lint fail?". **F32**
  (`verification-fleet-wide`, control-tower phase 62, #47) closes the family: a §Verification line
  whose exit code reads fleet-wide state (`task hygiene`, `task drift`, a machine-wide `ps … | grep`)
  can never pass while another plan or the run's own branches are live, so the lint names what to
  write instead — only forms the task accepts (phase 89, #71 PEH-3: phase 62's `--plan`/`--root` were
  refused or ignored), per read, from `FLEET_WIDE_READS` / `FLEET_WIDE_SCOPED` in
  `scripts/verify.env`. **F33** (`repos-outside-root`,
  control-tower phase 82, #94) names a Repos token that is not a path under the docs root, in a plan
  whose other cells are: that phase alone is refused isolation — the run keeps its checkout, which one
  such cell used to refuse for every phase. **F34** (`repos-root-token`, control-tower phase 90, #154)
  names a Repos cell that says the superproject's own name in a phase whose `Files` bullet lists only
  submodule and `docs/` paths — the token mounts the whole root and holds the phase against any run
  on the root repository, for nothing — and **F35** (`checkout-inert`, the same phase) a `Checkout:`
  value other than `main`, `master` or `default`, which the console carries and never acts on.
  **F36** (`wait-window-short`, control-tower phase 14, #40) names a `Waits on:` max shorter than the
  timeout of the workflow it watches — told through `PE_WAIT_TIMEOUTS`, `<ref>=<minutes>` pairs the
  console resolves once per `gh:…#run/<id>` (`watch-refs.ts`); unset is off, set but empty an answer.
  **F38** (`human-step-no-proof`, control-tower phase 41) names a `- **Human step:**` with no `proof:`
  ref. **F39** (`setup-deps-missing`, control-tower phase 106, #185) names a §Verification line that
  runs a package-manager script or a `.venv/bin/*` binary in a repository the phase's resolved Setup
  installs nothing for — a run's isolated checkout mounts every repository as a fresh worktree with no
  `node_modules` or `.venv`, so the line is red at baseline before it tests anything. The line's
  repository is its `**Verify in:**` (the same reader `--verify-in N` prints), moved by a `cd` and
  the package manager's own directory flag; Setup is resolved from the SAME directory, because the
  runner hands both one cwd, and an install counts only for its own ecosystem. Its word lists stay in
  `phase-graph.sh`, not `verify.env`: no runtime reader asks them. The advisory family is therefore
  F15–F19, F22–F23, F28, F30, F32–F36, F38–F41, F43, F45–F46 and F49–F52 — twenty-five ids (F49, `amendment-malformed`, measured-console phase 30: the two
  halves of a plan amendment — a phase's `- **Amendment:** K` and the `*(Amendment K, …)*` note under
  the title — disagree; F50,
  `directive-mid-line`, F51, `path-no-dir`, and F52, `verification-shared-checkout`, measured-console
  phase 2: a directive label where no reader reads it, a Repos token or `Verify in:` path that names no
  directory under the docs root, and a §Verification line that `cd`s into the shared checkout's absolute
  path; F45,
  `proof-unparsable`, and F46, `proof-script-run-branch-only`, one-pool phase 13: a `Human step:`
  proof the check reader would refuse, and a `cmd:` proof whose script is not on its repository's
  trunk — both read through `scripts/cmd-ref.sh`, the bash twin of the one `cmd:` reader; F40, `human-step-no-why`,
  control-tower phase 130: a `Human step:` with no `why:`, given its kind's default reason; F41,
  `human-step-no-guide`, and F43, `errand-row-unbound`, turn-by-turn phase 2: a task or decision with
  no guide file, no options and no bound `## Operator errands` row, and a table row no bullet names —
  `HUMAN_STEP_GUIDED_KINDS` and the one awk, `errand_refs`, stay in `phase-graph.sh`); F14 gates, and so do F26
  (`note-target-unknown`), F27 (`land-word-unknown`), F29
  (`landed-gate-unknown-phase`), F31 (`permission-mode-unknown`, control-tower phase 11): a
  `Permission mode:` line or bullet whose word is not one of `scripts/permission.env`'s, which the
  reader falls through exactly as F27's do — and F37 (`human-step-superseded`,
  `human-step-kind-unknown`, `human-step-field-invalid`, phase 41): a `Human step:` bullet the reader
  skips, the 5.1.0 `<who, what, proof ref>` spelling named with the grammar that replaced it.
  F42 (`guide-file-missing`, turn-by-turn phase 2) gates too: a `Human step:`'s `guide:` that is not a
  file under the docs root. The bullet's three newer keys — `options:`, `recommended:`, `deadline:` —
  are validated by both parsers and printed by neither: `--human-steps` stays byte-identical, and the
  console reads them, and the `## Operator errands` table (`server/parse/errands.ts`), from the plan.
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
  declared outcome (at most twice), lets one go whose own subagents or monitors still run in the
  background (`hook.stop-awaiting` — their notification starts its next turn), fails open, and the
  runner's own exit-time outcome check — not the hook — is the load-bearing enforcement.
- **The outcome protocol is the session→runner channel; prose never is.** A session declares how it
  ended via `scripts/phase-outcome.sh` → one atomic JSON file at `PE_OUTCOME_FILE`, read once,
  journalled, consumed, staleness-guarded twice (deleted pre-spawn; `written_at` checked against the
  attempt). `waiting-external` parks the phase as `waiting` and the resume is the phase's own session
  (`--resume`), never a pty agent — but a session is resumed only while it is worth resuming: one that
  ended at ≥ 250k tokens of context and is cold (idle ≥ 55 min) or under another account, that declared
  `partial --reason budget|context`, or that the console checkpointed is boarded FRESH with the resume
  brief instead (`phase.resume-policy`). The one gate, `resumableSession`, asks `resumePolicy`
  (`runner/usage.ts`, where the numbers live) for every `--resume`, after the gone and live checks and
  before any transcript port. The handoff `.md` stays the
  engine/human contract; its status vocabulary (`complete|in-progress|blocked|pending`) is frozen —
  `waiting` is a runner state, never a handoff status.
- **Reconcile closes records, never re-runs them.** The drive loop's reconcile pass (and the
  read-path resolver) flips a record the board has overtaken to `done` ("closed outside this run", or
  "closed while checkpointed — the board reads done; not verified by this run" when this run had started
  the phase) and dissolves halts anchored to it; a `failed` record whose phase the board does not show done is
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
  need. The lint allows seven other `.kill(` files, each by name and reason (`KILL_ALLOWED` in the
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
  tests. The usage belt is the same idea for the network (one-pool phase 30, #241): a `UsagePoller` in
  a test process with nothing injected reads no meters at all (`usageSealed` in
  `server/accounts/usage.ts` — it records "a test process reads no usage endpoint" instead of asking).
  A test that wants a reading gives the poller `fetchFn` or `base`, or names an endpoint with
  `PHASE_CONSOLE_USAGE_BASE`.

