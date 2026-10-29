# Phase Console — architecture, commands and conventions (the long form)

This is the body `CLAUDE.md` carried until 2026-10-25, moved here verbatim by measured-console phase 5
so that `CLAUDE.md` can be a pointer file a session reads at every boot. Every section keeps the dates
and phase numbers it was written with. The invariants that tests enforce — the old `### Invariants that
tests enforce` section — moved, verbatim too, to `docs/invariants.md`. When a fact here changes, change
it here; `CLAUDE.md` names the section and the test, never the paragraph.

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
`DOCS_ROOT` in `$BATS_TEST_TMPDIR` and copies a fixture plan in. `tests/run-tests.sh` unsets every
`PE_*` variable and `DOCS_ROOT` before bats runs (it prints `== environment: scrubbed … ==`), so a
session's own `PE_OWNER` or `DOCS_ROOT` cannot leak into a test (one-pool phase 30); a bats test that
needs one sets it itself. A bare `bats tests/unit/<file>.bats` gets no such scrub — run it under
`env -u DOCS_ROOT -u PE_OWNER …` (every `PE_*` your shell carries) from inside a session.

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
npm run test:e2e              # the real-browser tour (Playwright, four viewports) — e2e/baseline.json is [], so any finding fails
npm run test:e2e:dist         # the same tour against a production build under the real CSP (what scripts/gates.sh runs)
PHASE_CONSOLE_E2E_REAL_MACHINE=1 npm run test:e2e   # tour this machine's own login, meter, unit and tailnet, not the fixture's
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

The tour runs on a scratch HOME by default — a fixture login, a usage endpoint of its own, no launch
unit, an example tailnet — so no picture carries the operator's email or live meter;
`PHASE_CONSOLE_E2E_REAL_MACHINE=1` opts out and says so on stderr. `scripts/gates.sh` runs the server
suite under `PHASE_CONSOLE_GATE_STAGE=server-suite`, which lets `test/dist-dir.test.ts` skip, naming
why, on pictures from a tour of another route table, because the gate's e2e stage re-shoots the tour
afterwards and asks again (#353).

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
context; the body loads only when the skill fires. Since 9.0 (`PE_API` 3) the body is a core — the
console contract, the modes as pointers, the guardrails, under 16 KB — and each mode is a file read
whole in its mode: `references/mode-plan.md`, `mode-phase-start.md`, `mode-phase-finish.md`. The
helper catalogue is `references/scripts.md`, and the engine prints its own (`phase-graph.sh --help`,
`--explain <F-code>`, `--section N`, `--brief N`). Deep material lives in `references/` (plan format,
handoff format, conventions, sizing, QA method) so the core stays small — keep new detail there.

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

7.0 (the quiet-console plan) rebuilt the client from zero: the 6.x tree under `client/src/` (app/,
features/, components/, lib/api/) is gone, and every address it ever answered still lands, in one hop,
with its query (`client/src/shell/redirects.ts`). The design law is `viewer/docs/design.md` ("Quiet"):
every rule in it names the guard that holds it.

**The map.** Eight destinations in three bands, the same eight in both editions (`DESTINATIONS` in
`shared/route-meta.js`, `NAV` in `client/src/shell/nav.ts`; seven until one-pool phase 14 made Your
turn the eighth): **the work** — Runs (`#/runs`, the home, `DEFAULT_HEAD`), Your turn (`#/turn`),
Plans (`#/plans`; a plan is `#/plan/<slug>`), Sessions (`#/sessions`); **the record** —
Repo (`#/repo/<section>`), Insights (`#/insights`), Logs (`#/logs/<section>`); **the console** —
Settings (`#/settings/<section>`). The Runs home's heading is the situation sentence; under it six
groups — Your turn · Running · Waiting · Queued · Ready to start · Settled today (`?group=`, and 6.x's
`?bay=` still read) — hold one line per run with exactly ONE action, and All runs (`?view=all`) is the
same set as a table; `#/now…` lands on Runs (a `?focus=` on its group), `#/queue` on Queued. A plan
opens on its glance over
four views, each an address: Phases (Table · Map · Handoffs & QA · Schedule · Burn-up; the map's tools —
filters, a trace, colour, layers, layouts, export — live in its address, one-pool phase 16), Run (`#/plan/<slug>/run`;
`?view=history` for its earlier runs), Your turn (`#/plan/<slug>/turn`, the page scoped to the plan,
one-pool phase 14) and Source. Repo is six sections — History, Branches, Working
trees, Changes, Settles and the Issues desk (`screens/repo/issues-section.tsx`: a repository's WHOLE
issue list, each issue's category, severity and plan status derived once in `shared/issues-model.js`,
plus any GitHub `owner/name` an operator adds, read-only). Logs (Debug until 7.0;
`#/debug[/<section>]` lands on its section with its query) is five — Logs, Journal, Delivery, Health
and Access — every log this console writes on one time axis, plus the redacted bundle. Settings is
nine, Everything last: every key `GET /api/prefs/schema` describes, with its value, where it came from
and its reset. **Your turn** (`#/turn`, `screens/turn/`; control-tower phases 130–139, 148 and 149) is
a destination of its own since one-pool phase 14 (it was a head that lit Runs): every act only a person can do as one item — why only they fit it, a guide, a
proof the console checks — in six groups plus *Handled by the AI*, read from `GET /api/turn`, which
the server's `turn/` folds from every source through one door (`raiseTurn`); `#/approve` lands there,
and the approval, gate, question and errand cards elsewhere draw the item and link to it. A permission
item is answered by a scoped grant (`server/permissions/grants.ts`, `grants.ndjson`), and an owner key
(`server/owner/`, a passkey) is what lets a console tell its owner's press from any other door's.

**The shell** (`client/src/shell/`). From 900 px a slim 80 px rail: the instance switcher at its top,
the eight places as a glyph over a word, banded by hairlines, and Help and the account meter at its
foot. The header carries the page title, the situation words (each a link on a desk), search (⌘K) and
the bell. Below 900 a tab bar — `TAB_BAR` in `shell/nav.ts`: Runs · Your turn · Plans · Sessions ·
More (in Pro the Supervisor takes Sessions' slot) — and the More sheet holds the rest. The palette (`?k=`: go to · find · do), the help sheet
(`?help=`) and the bell (`?bell=`) are query params, never routes: open ⟺ the URL says so, so
navigating anywhere closes them. **Three doors to depth, on every page** (design.md §1): **expand** a
row in place, remembered per person; **inspect** it in the panel, on four tabs — Overview · Actions ·
History · Raw; and **Everything**, a per-page switch kept in `prefs.everything` that shows every
column, fact and section. Every list's toolbar is one row in one order — search · Filter · Group ·
Sort · View · ⋯ · Everything — and below 900 the search and one View sheet. **The panel**
(`client/src/shell/panel/`) is where Inspect puts a record, its **Details** mode: the shell grid's
third column at 1200 px and up, a sheet from 900 to 1200, a bottom sheet on a phone. ⌘I opens and
closes it, and its mode, its width and whether it stands persist in `prefs.panel`, because it
survives navigation.

**The code** (`viewer/client/src/`): `ui/` the kit, `cards/` what a person acts on as a unit (a turn
item, a halt, an errand, an inbox row), `shell/`, `screens/<place>/` — each place a lazy chunk the
router loads — and `data/`, the one way to the server; then `styles/`, `lib/` and `content/guide/`.
ESLint holds five doors over the whole tree: one navigation door (only `shell/routes.ts` spells `#/`),
one data door (`useQuery`/`useMutation` only under `data/`), one status renderer (`DotWord` only under
`ui/status/`), one stream (`data/live.ts` opens the console's one `EventSource`; the Logs tail,
`screens/logs/tail.ts`, is the one named exception) and one table engine (`ui/grid/engine.ts`, reached
by `import()`). `data/press.ts` is the one press door: the owner door's 202 (a request the owner
confirms) and 401 (touch the key, then press once more) are handled there, once. `data/surface.ts` is
the surface registry — every route, SSE event, settings key and operator verb, each with the door a
person meets it through or an exemption naming its caller — held to the server both ways by
`viewer/test/surface-parity.test.ts`, its ratchet at zero. First paint is held at 170 KB served, the
Free build's included (`viewer/scripts/check-dist.mjs`).

Its rule is the same one-source rule as `sizing.env`, and it is what the whole redesign existed to
establish — a vocabulary lives in `shared/` and is imported by identity by server, client and tests:

- `shared/status-vocab.js` — the 8 UI states worst-first (`needs-you failed running verifying
  waiting queued skipped done`), the status→state maps, and `isLiveStatus`/`LIVE_RUN_STATUSES`
  (which is deliberately NOT the server's `IN_FLIGHT`: it includes `queued`, because a loop is
  behind a queued run even though it holds no child and no lock).
- `shared/status-model.js` — status model v2 (control-tower phase 16), the signal law: every word of
  every vocabulary gets one row (label, icon, paint, tense, attention), and `describeRun` /
  `describePhase` decide by table. A page draws a status through the typed family
  (`client/src/ui/status/`) as a dot and a word — its renderer, `DotWord`, is imported nowhere else
  (ESLint) — and the status ratchet (`client/src/ui/status/ratchet.test.ts` + `status-ratchet.json`)
  scans the whole of `client/src/`: legacy status sites at ZERO, and the retired names — the 2.x
  `Chip`/`StateChip`, their tone words, the `--line-*` aliases, the 6.x `StatusBadge`/`StatusDot` —
  gone by name. A hue is chosen only there and in theme.css's `.state-<ui>` classes.
- `shared/route-meta.js` — the route heads and the destinations, asserted at module load.
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
- `shared/turn-model.js` — Your turn's words (control-tower phases 130–149; bash twin
  `scripts/turn.env`): the ten reasons only a person fits (`WHY_PERSON`, `REASON_META`) and those each
  kind allows (`KIND_REASONS`), the proof types, `VERDICTS`, the grant scopes, `GRANT_RISK` and the
  never list's reasons, the page's `TURN_GROUPS`, `HANDLED_SOURCES`, the walls and the guard's exit
  (`GUARD_REFUSAL_EXIT`, 4) — and, since turn-by-turn phase 1, the card contract: every item's `type`
  (`ITEM_TYPES`), `personStatus` (`PERSON_STATUSES`), `readiness` (`READINESS`) and `route` (`ROUTE_TO`),
  derived once each (`typeOf`, `personStatusOf`, `readinessOf`, `routeOf`) over `TURN_SOURCES` and
  `TURN_RECORDS`, which it owns. `shared/guide-grammar.js` is the one guide parser, server and page alike.
  Since turn-by-turn phase 3 every person-facing word of an item — its title (the act), meta, steps by
  precedence (`STEPS_FROM`), check, timing — and the inbox row's and the push's words come from ONE
  composer, `server/turn/compose.ts`; a proof ref is said in words by `shared/proof-words.js`, never
  shown (`cmd:`, `POST /api`, "phase 0" reach no person), and a projected item's assigned clock is
  `server/turn/first-seen.ts`'s.
  Since turn-by-turn phase 4 the ladder's `ASKS` table (`runner/ladder.ts`) is the one source of an
  errand's card words — a title, steps, a check and options bound to their verbs (`askFor`,
  `askOptionsFor`; `NOT_RECEIVABLE` names the situations nobody is asked about) — and an errand row's
  buttons derive from its options. Gate, plan-approval, permission, supervisor-suggestion and
  owner-request items carry an `approval` block (what, who asked, if approved, if denied); conflict,
  QA, question and session-ask items carry `options`, at most one recommended. An identity park offers
  exactly its two options, both bound to the run's `identity` verb; a supervisor escalation whose verb
  has no CLI line is an in-app action on its item, never a route written as a command; a plan's
  `## Operator errands` rows no bullet names are `headsUp` items, in no group and never counted.
  Since turn-by-turn phase 5 a press goes where the item says: every option is pressed from its own
  `verb` through `data/press.ts`, and a run verb's body carries `expectRunId` (bound in `inbox.ts`
  `mint` and `turn/compose.ts` `boundToRun`), which the route refuses with a 409 and a sentence when
  the plan's run is another one (`staleBinding`, logged `turn.press-stale`); every item says *Goes
  to* (`route`) and *Checked by* (`checkedBy`, from `CHECKED_BY_LABEL`). *Undo*
  (`POST /api/human-steps/:id/undo`) takes a running check back — the item returns to To do or
  Redo and a verdict for that attempt is dropped — and a terminal press waits a few seconds on the
  page with *Undo* before it is sent (`client/src/data/undo-window.ts`). A check's note is kept on
  its attempt for every proof type (`step.notes`). A pressed projected item — an approval card, a
  gate, a plan approval, a relayed question, an ack-bound option — leaves a settled record
  (`server/turn/settled.ts`, `turn-settled.json`), so Done shows it as Passed or Closed with who
  pressed it and when. An item whose proof reads a gate's row is opened by that gate's Approve,
  never by an answer or a note.
  Since turn-by-turn phase 6 an act only the RUN can take — `RUN_ACTS` in `shared/verb-model.js`:
  isolate, switch-account, raise-budget, stop, hold — is a run request, never a permission:
  `phase-outcome.sh … blocked --needs run --run-act <act>` (the `run` need class,
  `blocked-declared:run`), journalled `run.run-requested`, and a `permission` declaration naming no
  rule or command on a shared checkout whose lane is not on `pe/<slug>` is read as `isolate`
  (`server/turn/run-requests.ts` `isolateCompat`, which G5 never refuses). Its item is ONE approval
  per run and act, every declaring phase a waiter (`POST /api/run/<slug>/run-request`): Approve takes
  the act through the run verb of its name, Deny resumes the waiters told no. In Pro the supervisor's
  `run-requested` remedy presses isolate and hold (`RUN_ACT_AUTONOMY`), the reversible remedies ship
  at `press`, and a refused press (409) counts as pressed for its root cause (#286).
  Since turn-by-turn phase 7 an item nobody needs any more closes itself. ONE predicate,
  `server/runner/supersede.ts` (`supersedeReading`, its refusals named in `SUPERSEDE_REFUSALS`), says
  when a stopped run is SUPERSEDED: a later, unabandoned run of its plan whose scope covers what it
  still owes, the old run not live, not unlanded, not stopped about the plan, not reopened or dismissed
  by a person. The identity park skips such a run and never overwrites an operator's stop; the read
  resolver annotates it `resolved {auto, reason: "superseded by run <id>", supersededBy}` (journal
  `run.superseded`, reversible with `unresolve`); and the round's stale pass (`server/turn/stale.ts`)
  closes the run-specific items of a superseded, resolved or finished run, of a phase done on the
  board, or whose errand is gone — each with a `console` row under *Handled by the AI* — and moves a
  world act (`KIND_OUTLIVES_RUN` in `shared/turn-model.js`) to the successor's lane (`ledger.relane`).
  G7 never folds two operator acts of different phases (#261, #257); a plan item names the session
  item that covers it (`coverLinks`: the same act, or its errands ref), linked, never merged; and a
  session's decision its phase moved past closes as settled by that act, out of the supervisor's
  `turn-unopened` reach (#290).
  Since turn-by-turn phase 8 every item is drawn as ONE card in the board's anatomy
  (`viewer/docs/design.md` §Your turn): NOW or NOT YET with its *when*, the type's mark, the
  person's status (the typed family's `turn` member, `TurnStatus`/`TurnReadiness`, status-model
  vocabularies `turn` and `readiness`), the title and meta, a timing grid on ONE page clock
  (`client/src/ui/clock.ts`: 1 s while a grid is on screen, else 30 s, never 1 s under reduced
  motion), why once, the verdict before the steps, *From the AI*, the steps on the line, *How it's
  checked*, *Goes to* / *Checked by*, and ONE act form per type, its primary chosen by the move
  table `cardMoveOf` (`client/src/cards/turn/moves.ts`, IC-v2). Every command a person runs is
  the one command block, `client/src/ui/code-block.tsx`, which marks a `<placeholder>` command as a
  template.
  Since turn-by-turn phase 9 the page is the board in 7.0's grammar. The groups are v2,
  `TURN_GROUPS` — *Approve* · *Do now* · *Decide* · *Being checked* · *Coming up* · *Done* —
  placed by `groupOf` from the item's type and readiness (an approval to Approve, NOT YET to
  Coming up), `TURN_OPEN_GROUPS` the three the headline, the strip, `asksNow` and the situation
  line count; *Handled by the AI* is a section, never a group, and a heads-up sits in a section
  of its own after it. `GET /api/turn` carries `strip` (to do, checking, passed today, the next
  deadline, `stripOf`); the page draws it (`screens/turn/strip.tsx`) with the round as the live
  line on the one page clock, then one toolbar row whose Filter (Status, Time, Plan, Type, Goes
  to), Group, Sort and View all live in the address, the groups, and *Where the plans stand*
  (`screens/turn/plans-strip.tsx`). `#/turn/<id>` marks its card and opens the panel on it where
  the panel stands beside the page (1200 and up). The explain view's `whyPerson` is the reason's
  sentence alone (`whyPersonWords`, #332), and *Export* carries each item's options, timing and
  approval block.
  Since turn-by-turn phase 10 every other surface speaks the card's words. An inbox row's `turn`
  view carries the card's `type`, `readiness` and NOT YET's `startWhen`, and sits in the group its
  card sits in (`withRowWords` in `server/turn/fold.ts`, applied in `buildInbox`). The Runs home's
  Your turn rows and the bell's needs-you rows lead with NOW or NOT YET and the type's mark
  (`client/src/cards/turn/row-words.tsx`) over the composer's title. A decision with options, and
  an approval that is no permission, open the card. A push's lock screen is chosen by TYPE
  (`lockScreenOf` in `server/push/actions.ts`): a Task gets *Open* and *I did it*, a run request's
  Approval gets *Approve* and *Deny* (both answers the `device` door may give, read again at
  `POST /api/push/action`), any other Approval or a Decision gets *Open*, and a permission item
  keeps its grant-or-open and *Deny*.
  Since turn-by-turn phase 11 `viewer/test/turn-cards-coverage.test.ts` walks every card the console
  can raise — every kind × ledger state × birth and every projected source, in both editions — and
  fails one missing its type, status, readiness, route, *Checked by*, check or (while open) steps,
  options or approval block, or showing a machine word.
  Since one-pool phase 14 (#377 #366 #365) the page is one a person works FROM: tabs (Open · Done ·
  Handled by the AI · All), four views (`?view=list|board|cards|timeline`, the list by default: one
  line per item, its whole card in the panel on selection, `screens/turn/panel-card.tsx`), five
  groupings (`?group=asked|plan|type|deadline|status`), empty groups folded into one line, filter
  chips with counts on a desk, and bulk *Not doing* · *Hand back* · *Snooze* — the words in
  `shared/turn-model.js` (`TURN_VIEWS`, `TURN_TABS`, `TURN_GROUPINGS`, `TURN_BOARD_COLUMNS`), the
  grammar in `viewer/docs/design.md` §Your turn. The composer's `shortTitle` holds every title to 80
  characters (the long form is `headline`), every status word explains itself on hover, focus and
  tap (`shared/status-meanings.js`), and the bell's drawer is a five-row preview of the page.
  The person-facing account of all
  of it is the help guide's *Your turn* (`client/src/content/guide/your-turn.md` and its `.fa.md`
  twin), `references/turn.md` for a session, and `viewer/README.md` §Your turn.
- `shared/door-model.js` — who pressed: the seven `PRESS_DOORS`, the `AUTHORITY_VERBS`, `DOOR_MAY` in
  its two modes (no owner key: `local` presses what it always could; a key: a press through a door
  that may not make it is a request the owner confirms) and `AUTHORITY_ROUTES`, the table the hook's
  `console-forge` guard and the router both read.

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
entitlement breaker (`unknown · entitled · cooling · suspect · retired`, moved only along
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
readers that predate that. Before the wall, a warning past `ALERT_PCT` that no switch can answer
engages the account's **usage brake** (`Scheduler.brake`): no NEW lane on it while one is live —
never a refused start — until a reading of that window under `WARN_PCT` or its reset. At the wall, a
reset further off than `LIMIT_ACTION_COOLDOWN_MS` waits on the first rate-limit burst rather than
after two `none` decisions (autopilot-token-drain phase 6). That wait is "until at the latest"
(control-tower phase 54, #78): the parked phase carries `usageWall`, is re-read on every fresh usage
reading, every spend that went through and a back-off re-probe (`Runner.rereadWalls`), and boards
the moment the account has headroom; a lane that parked itself on a clock puts the run in `waiting`
on that clock rather than `parked`, so the service's wait clock is what resumes it.

### Getting the console started — the desktop artifact and the start command

`server/launcher.ts` behind `/api/launcher` writes the desktop artifact itself, per platform and
honestly: macOS gets the shipped `.command` template with its knobs patched, Linux an
XDG `.desktop` whose `Exec` paths are baked absolute (Exec lines expand no variables), Windows the
WSL story rather than a shortcut that would break. Everything filesystem-shaped is a parameter, so
tests never touch a real Desktop. **Bump `LAUNCHER_REV` whenever the template's argv changes** — that
is what tells an installed copy it is stale instead of letting it start a console whose Settings
disagrees with it. Settings ▸ Essentials ▸ Start command composes the same line from the console's
own facts (`client/src/lib/start-command.ts`) and renders every path as `$HOME/…`: the line must
paste on any account and a screenshot must carry no username, and a scrubbed test keeps the shipped
template personal-path-free. `viewer/run`
looks past the PATH's `node` when it is below the floor (Homebrew, `/usr/local`, volta, newest nvm)
rather than refusing.


### Invariants that tests enforce — moved

Every invariant paragraph that stood here is in `docs/invariants.md`, whole.

### MCP servers

`server/mcp/` is per-instance, like the account registrations and for the same reason. `store.ts`
holds no secret (`credentials.ts` is the only file that does — keychain, else 0600); `health.ts` is
the probe, and the probe is a **one-turn `claude -p`** whose `system/init` reports each server's real
status before any model call, because that is the only place `needs-auth` is knowable; `catalog.ts`
degrades to a shipped curated list when the official registry is unreachable; `config.ts` writes the
per-run `--mcp-config`, 0600, `chmod` after the write. The probe runs as `PE_OWNER=console/mcp-probe`
with `PE_SESSION_KIND=probe`, on which the presence hook registers nothing — a probe is not a session
(#73), and while nothing reads its answers its clock backs off to `HEALTH_IDLE_MAX_MS`; one answer is
reused for `HEALTH_TTL_MS` (5 min), which is also the health clock's period, and the boarding
preflight reads that cache and joins a probe already in flight rather than starting its own; and
every probe is an automatic start on a budget of its OWN (`PROBE_STARTS_PER_HOUR`, logged
`mcp.probe.start`) — never the work-start ceiling, because a probe is not a session (control-tower
phase 100, #73).

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
`--allow-accounts` (register Claude accounts for this instance and pick one per run —
*reading* the usage meters needs no flag; moving a running run to another account is a run act, so
`--allow-run` gates it, one-pool phase 7's ruling on #323), `--allow-mcp` (register MCP servers, hold their
credentials, attach them to plans and phases — *reading* the registry, the statuses and the catalog
needs no flag), `--allow-webhooks` (POST every announcement to the URLs you register — Slack, Discord,
Telegram, your own relay; one of the two that send anything off the machine, and *reading* the
destination list needs none), `--allow-publish` (push a finished phase's `pe/*` branch — never a trunk, never
with force — where a plan's `permission.destructive` row allows it; off means no push — the other
outward-reaching flag, and the only one that writes to a repository somebody else reads). All eight default
off — the set is `CAPABILITY_FLAGS` in `server/config.ts`, and `viewer/test/skill-sync.test.ts` holds this
paragraph's count to it.
Shut down is deliberately *not* behind a flag. One flag switches something OFF rather than on:
`--no-converge` stops the convergence loop's automatic triggers; it is not a capability flag and is not one
of the eight.

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
`viewer/README.fa.md`, and every help-sheet guide's `client/src/content/guide/<id>.fa.md` since
control-tower phase 32) — update both when changing either; `docs-parity.test.ts` holds each pair section
for section, and `guide-coverage.test.ts` fails a section with no twin.

Commits use conventional prefixes with a human, declarative summary describing the change's *effect*
(`feat(run): automation defaults — opt-in skills, QA-on-launch, work branch + PR, repo guard`), not a
list of files touched.
