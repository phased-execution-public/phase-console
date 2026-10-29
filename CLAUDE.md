# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
It is a pointer file: the long form is `viewer/docs/architecture.md` (the map, the vocabularies, accounts,
MCP, the flags, packaging) and `docs/invariants.md` (every invariant's paragraph, verbatim). Read the
section a task touches before changing it.

## What this repository is

The **source of the `phased-execution` Agent Skill itself** — not a project that uses it: the procedure
Claude follows (`SKILL.md` and `references/`), the bash engine that computes phase state (`scripts/`),
and Phase Console, the local web app that reads it (`viewer/`).

It installs two ways from one tree: as a plain skill or as a plugin (`.claude-plugin/marketplace.json`,
`strict: false`). **There is deliberately no `plugin.json`** — the marketplace entry carries the metadata
so the folder stays a valid bare skill. Keep it that way.

**Skill vs work-state.** Plans, handoffs, QA reports, locks and `test-status.md` are work-state and live
in the consuming project's repo under `docs/plans` / `docs/handoffs`; `tests/fixtures/plans/` is the only
place plan markdown belongs here.

## Commands

```bash
tests/run-tests.sh            # the bash engine: shellcheck (if present) + bats unit + integration
bats tests/unit/parse.bats    # one suite (bare bats skips the PE_* scrub: run it under env -u DOCS_ROOT -u PE_OWNER …)
cd viewer && npm ci           # once
npm test                      # server + shared contracts (node --test, needs no build)
node --test test/runner.test.ts                     # a single server test file
npm run test:client           # client suite (Vitest + jsdom)
npm run typecheck:client      # the app and the service worker programs
npm run lint:client           # ESLint, zero warnings; npm run format:check is the formatter's gate
npm run verify:dist           # build into client/.dist-verify + the gate — the LIVE dist untouched
npm run test:e2e:dist         # the real-browser tour against a production build (what scripts/gates.sh runs)
npm run build && npm run check:dist   # emit client/dist, then the build gate — after every build
bash scripts/gates.sh [--quick]       # the release gate on this machine (there is no CI)
```

```bash
./start [<repo-with-docs-plans>] [--allow-writes] [--port N] [--no-open]   # run the console
phase-console doctor [<instance>] [--json]      # the start's probes + the machine checks, no plan needed
phase-console sessions ingest [<instance>]      # drain the presence inbox while no console is up
```


The Node suite keeps passing **without** a client build (`viewer/test/static.test.ts`). Instance
identity, the registry and ports are `viewer/shared/instances.mjs` (lexical paths, never `realpath`).
The tour's scratch HOME, the bats scrub and identity at module load: architecture.md §Commands.

## The three layers

Strict dependency order, each lower layer authoritative for the one above. **`scripts/`** — the engine
(bash 3.2, deterministic, output-only): `phase-graph.sh` is the single source of truth for done / ready /
waiting, batching, boot prompts, QA regime and lint, recomputed from the plan's `## Phase graph` and the
handoffs every time, with no stored cursor; every other script calls it. **`SKILL.md`** — the procedure,
a core plus one `references/mode-*.md` per mode; deep material lives in `references/`. **`viewer/`** —
Phase Console: a Node 22.18+/23.6+ server that runs TypeScript directly and shells out to the engine for
every status claim (`server/service.ts` the model, `engine.ts` the wrapper, `runner/` the autopilot,
`accounts/` the identities, `api/routes.ts` the surface), a Vite/React client that is built output, and
`shared/`, dependency-free ESM both import. The client's map, shell and doors: architecture.md §The
client; the design law: `viewer/docs/design.md`.

## Invariants — each held by a test (paragraphs: `docs/invariants.md`)

| Invariant | Held by |
|---|---|
| Engine parity — the JS board equals `phase-graph.sh`'s; run it after touching either parser | `viewer/test/engine-parity.test.ts` |
| F5, one sizing source — `scripts/sizing.env` (+ `scripts/mcp.env`): 55K + 183K + 1.91 × weight, `p33-after.json`'s fit | `viewer/test/sizing-env.test.ts` |
| The structural lint and the advisory family (F1–F3, F14, F20–F21 … F52) | `tests/unit/lint.bats`, `tests/unit/validate.bats` |
| An empty `ready` set is four facts — the `blocked:` line is a contract | `viewer/test/engine-parity.test.ts` |
| QA gates only when the plan says so; a `pending` row holds as hard as `fail` | `tests/unit/qa-gating.bats` |
| bash 3.2 — no associative arrays, `${var^^}` or `mapfile` | `tests/helpers/test_helper.bash` |
| Never implicitly build the client | `viewer/test/static.test.ts` |
| `sw.js` stays at the root and push-capable | `viewer/scripts/check-dist.mjs` |
| The console binds to `127.0.0.1`, always | `viewer/test/access.test.ts` |
| Permission `deny` is identical across all three run profiles | `viewer/test/approvals.test.ts` |
| The outcome protocol is the session→runner channel; the resume gate | `viewer/test/invariants.test.ts` |
| Reconcile closes records, never re-runs them | `viewer/test/reconcile.test.ts` |
| A process is a fact; a record is a claim | `viewer/test/invariants.test.ts`, `viewer/test/pid.test.ts` |
| The ladder climbs; a person is asked once, with an errand | `viewer/test/ladder.test.ts` |
| The engine is the authority on gate state, the healer included | `viewer/test/situation.test.ts` |
| A foreign unexpired lock queues, never terminally parks | `viewer/test/scheduler.test.ts` |
| A shipped default is struck by name — `deny` included | `viewer/test/approvals.test.ts` |
| One spawn door, and every start names its door | `viewer/test/invariants.test.ts` |
| Halts, parks and waits have kinds | `viewer/test/waiting-is-a-state.test.ts`, `viewer/test/run-lifecycle.test.ts` |
| Every journal and log name has a row in `docs/journal-events.md` | `viewer/test/docs-parity.test.ts` |
| The relay is one call site, behind two floors | `viewer/test/invariants.test.ts` |
| Tests never touch the operator's state | `viewer/test/state-isolation.test.ts` |
| A vocabulary lives in `shared/`, imported by identity | `viewer/test/vocab-owners.test.ts` |
| Every backend option has a door | `viewer/test/surface-parity.test.ts` |
| A status is drawn only through `client/src/ui/status/` | `viewer/client/src/ui/status/ratchet.test.ts` |

`viewer/test/state-isolation.test.ts` belongs in every verification batch that runs node tests.

## The vocabularies' owners

Add a state, a rung, a route or a word in its owner file and nowhere else (architecture.md §The client
says what each holds): `shared/status-vocab.js` (the UI states and `BOARD_BUCKETS`, the engine's five
buckets), `shared/status-model.js`, `shared/route-meta.js`, `shared/situation-model.js`,
`shared/ladder-model.js`, `shared/recovery-model.js`, `shared/attention-model.js`,
`shared/evidence-model.js`, `shared/plan-vocab.js` (the frozen handoff statuses), `shared/ops-vocab.js`,
`shared/run-settings.js`, `shared/run-lifecycle.js`, `shared/decisions-model.js`,
`shared/policy-model.js`, `shared/relay-model.js`, `shared/cli-tools.js`, `shared/fleet-model.js`,
`shared/turn-model.js`, `shared/door-model.js`, `shared/plugin-sets.js` (the per-phase plugin kinds).
A bash twin under `scripts/*.env` is held to its owner by a parity test.

## Flags

Eight capability flags, each unlocking one act and all default off — the set is `CAPABILITY_FLAGS` in
`viewer/server/config.ts`. `--no-converge` switches the convergence loop's automatic triggers off and is
not one of the eight.
Each flag's act: architecture.md §Flags gate capability, one act each.

## Packaging, in five lines

- Run `bash .github/scripts/scrub.sh` before every commit — bare, never piped; tokens live in `.secrets/`.
- A new server-runtime file goes in the root `package.json` `files` **and** `.github/scripts/assert-tarball.sh`.
- Never commit the type-stripped `.js` that `npm pack` emits; `fallback-sw.js` is the one real `.js` in `server/`.
- The Node floor (22.18+/23.6+) lives in five gates and the docs — change it everywhere or nowhere.
- A release is a version bump, a `CHANGELOG.md` section, a tag and a person's push — the contract is `docs/releasing.md`.

## Docs and conventions

`README.md` is short; the long form is `docs/` (indexed by `docs/README.md`), the console's own is
`viewer/README.md`. An English file with a Persian sibling (`README.fa.md`, `USAGE.fa.md`,
`viewer/README.fa.md`, each guide's `.fa.md`) changes with it — `docs-parity.test.ts` and
`guide-coverage.test.ts` hold the pairs. A text file's Pro material sits in `!pro:start` … `!pro:end`
regions, which the free tree drops. Commits use conventional prefixes and a
declarative summary of the change's effect, not a list of files.
