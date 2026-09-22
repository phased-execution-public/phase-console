// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFrontMatter, fmString, fmList, fmPhaseList, scalar } from '../server/parse/frontmatter.ts';
import {
  parsePlan, parseDependsOn, detachRequestedIn,
  landFor, isolationFor, issuesFor, baseBranchOf, conflictPolicyOf, messagingOf, clashZonesOf,
} from '../server/parse/plan.ts';
import { parseHandoff, parseHandoffFilename, normaliseStatus } from '../server/parse/handoff.ts';
import { parseIndex, parseTestStatus, parseLock } from '../server/parse/folder.ts';
import { labelledBullets, sections, fences } from '../server/parse/markdown.ts';

const PLAN = `---
slug: demo-plan
created: 2026-08-02
status: active            # active | complete | abandoned
phases: 4
handoffs: docs/handoffs/demo-plan/
memory: project_demo-plan
---

# Demo Plan

> Continues from \`docs/handoffs/other/phase-03-x.md\`.

## Context

Why this exists.

## Architecture / approach

Key files by repo.

## Session budget

**Target model:** \`claude-opus-5\` (1M window) · **Budget:** ~200K weight/session · **Branch:** current branch (no new branch)
**Skills (every session):** \`api-conventions\`, \`design-system\`
**QA gate:** on

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Schema | — | — | api | tables migrated |
| 2 | Routes | 1 | 3 | api | routes green |
| **3** | Relay | 1 | 2 | aws | relay green |
| 4 | Capstone *(GATED)* | 1–3 (+2) | — | all | shipped |

**Blocking:** 1 → {2, 3} → 4
**Independent (run in any order, one at a time):** 2 ∥ 3

## Phases

### Phase 1 — Schema
- **Goal:** the tables.
- **Size:** S
- **Read first:** this plan.
- **Files:** \`app/models/x.py\`
- **Steps:** models → migration.
- **Exit criteria:**
  1. Migration round-trips.
  2. Guard lists 36 tables.
- **Verification:** \`pytest -q\`
- **Verify in:** services/api
- **Handoff must record:** revision id.

### Phase 2 — Routes
- **Goal:** the API.
- **Size:** L
- **Exit criteria:** routes enforce status sets.

### Phase 3 — Relay
- **Goal:** the relay.
- **Model:** claude-haiku-4-5

### Phase 4 — Capstone *(GATED)*
- **Goal:** ship it.
- **Size:** M
- **Gates (must clear first):** operator runs the checklist.
- **Gate-check:** date 2026-09-01

## End-to-end verification

Run the whole loop.
`;

test('front matter survives trailing legends and block lists', () => {
  const fm = parseFrontMatter(`---
status: complete          # active | complete | abandoned
phases: 10
key_files:
  - packages/api/src/one.ts
  - packages/api/src/two.ts
depends_on: [5]
blocks: [10]
skills_used: [api-conventions, design-system]
metadata:
  type: project
---
body`);
  assert.equal(fmString(fm, 'status'), 'complete');
  assert.equal(fmString(fm, 'phases'), '10');
  assert.deepEqual(fmList(fm, 'key_files'), ['packages/api/src/one.ts', 'packages/api/src/two.ts']);
  assert.deepEqual(fmPhaseList(fm, 'depends_on'), [5]);
  assert.deepEqual(fmList(fm, 'skills_used'), ['api-conventions', 'design-system']);
  assert.deepEqual(fm.values.metadata, { type: 'project' });
});

test('front matter is optional and never throws', () => {
  const fm = parseFrontMatter('# Just a document\n\nNo front matter here.');
  assert.equal(fm.lines, 0);
  assert.equal(fmString(fm, 'status'), undefined);
});

test('a value may contain a hash when no space precedes it', () => {
  assert.equal(scalar('https://x.test/a#anchor   # trailing note'), 'https://x.test/a#anchor');
});

test('dependency cells accept numbers, lists, ranges and the em-dash', () => {
  assert.deepEqual(parseDependsOn('—'), []);
  assert.deepEqual(parseDependsOn('4'), [4]);
  assert.deepEqual(parseDependsOn('4, 5'), [4, 5]);
  assert.deepEqual(parseDependsOn('1–7'), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(parseDependsOn('1–7 (+9–10)'), [1, 2, 3, 4, 5, 6, 7, 9, 10]);
  assert.deepEqual(parseDependsOn('after 2 and 3'), [2, 3]);
});

test('plan parse reads the graph, phases, sizes, gates and budget', () => {
  const plan = parsePlan(PLAN, 'demo-plan', '/tmp/demo-plan.md');

  assert.equal(plan.phased, true);
  assert.equal(plan.title, 'Demo Plan');
  assert.equal(plan.declaredPhases, 4);
  assert.equal(plan.status, 'complete' === plan.status ? plan.status : 'active');
  assert.equal(plan.memoryKey, 'project_demo-plan');
  assert.ok(plan.provenance?.includes('Continues from'));

  assert.equal(plan.graph.length, 4);
  assert.deepEqual(plan.graph.map((r) => r.phase), [1, 2, 3, 4]);
  assert.deepEqual(plan.graph[3].dependsOn, [1, 2, 3]);
  assert.equal(plan.graph[2].title, 'Relay');          // bold cell survives
  assert.equal(plan.graph[1].repos, 'api');

  assert.equal(plan.sessionBudget.targetModel, 'claude-opus-5');
  assert.equal(plan.sessionBudget.qaGate, 'on');
  assert.deepEqual(plan.sessionBudget.skills, ['api-conventions', 'design-system']);
  assert.match(plan.sessionBudget.branch ?? '', /current branch/);
  // This plan says nothing about worktrees, and silence must read as silence —
  // `undefined`, which `optedIn()` turns into OFF. A parser that answered `off`
  // here would be indistinguishable from one that answered `on`, since both are
  // "a value the plan never wrote".
  assert.equal(plan.sessionBudget.worktrees, undefined);

  assert.equal(plan.phases[1].size, 'S');
  assert.equal(plan.phases[2].size, 'L');
  assert.equal(plan.phases[3].size, 'M');              // no Size bullet → default M
  assert.equal(plan.phases[3].model, 'claude-haiku-4-5');
  assert.equal(plan.phases[4].gated, true);
  assert.equal(plan.phases[1].gated, false);
  assert.match(plan.phases[4].gates ?? '', /operator runs the checklist/);
  assert.equal(plan.phases[4].gateCheck, 'date 2026-09-01');

  assert.match(plan.phases[1].exitCriteria ?? '', /Migration round-trips/);
  assert.match(plan.phases[1].exitCriteria ?? '', /Guard lists 36 tables/);
  assert.equal(plan.phases[1].verification, '`pytest -q`');
  // Two bullets whose labels share a prefix as far as "Verif". `bullet()` matches
  // on prefix, so the pair is worth pinning: neither string starts with the
  // other, and reading one into the other would run the suite in the wrong tree.
  assert.equal(plan.phases[1].verifyIn, 'services/api');
  assert.equal(plan.phases[2].verifyIn, undefined, 'a plan that says nothing means the root');
  assert.match(plan.context ?? '', /Why this exists/);
  assert.match(plan.endToEnd ?? '', /whole loop/);
  assert.equal(plan.callouts.length, 2);
});

test('a heading that covers a range of phases keeps the graph title', () => {
  const plan = parsePlan(`# T

## Phase graph

| Phase | Title | Depends on |
|---|---|---|
| 1 | crm-core (spec/runner/ingest) | — |
| 2 | vendor app import | 1 |

## Phases

### Phase 1–5 — DONE
See the earlier handoff for the record.

### Phase 2 — vendor app import
- **Goal:** the screen.
`, 'ranged', '/tmp/ranged.md');

  assert.equal(plan.phases[1].title, 'crm-core (spec/runner/ingest)');
  assert.equal(plan.phases[2].title, 'vendor app import');
});

test('a document without a phase graph parses as unphased rather than failing', () => {
  const plan = parsePlan('# Design spike\n\n## Findings\n\nNo graph here.\n', 'spike', '/tmp/spike.md');
  assert.equal(plan.phased, false);
  assert.equal(plan.graph.length, 0);
  assert.equal(plan.title, 'Design spike');
});

test('other pipe tables in a plan are never read as phase rows', () => {
  const plan = parsePlan(`# T

## Repos

| Repo | Owner |
|---|---|
| 1 | api |

## Phase graph

| Phase | Title | Depends on |
|---|---|---|
| 1 | Only phase | — |

## Risks

| 9 | something |
`, 't', '/tmp/t.md');
  assert.equal(plan.graph.length, 1);
  assert.equal(plan.graph[0].title, 'Only phase');
});

test('handoff parse reads front matter, sections and boot prompts', () => {
  const text = `---
plan: docs/plans/demo-plan.md
phase: 2
title: routes
status: complete            # complete | in-progress | blocked | pending
completed: 2026-08-01
next_phase: 3
depends_on: [1]
blocks: [4]
parallel_safe: [3]
skills_used: [api-conventions]
key_files:
  - api/routes.py
memory: project_demo-plan
---

# Phase 2 → next handoff: routes

## What this phase did

Shipped the routes.

## State now (verified)

Tests 12/12 green; committed \`abc1234\`.

## Files changed

- api/routes.py

## Key decisions / gotchas

Chose polling over SSE.

## ▶ Start next phase(s) (paste into fresh sessions)

\`\`\`
/phased-execution

Continue the "demo-plan" plan — start Phase 3 in this fresh session.
Stop + hand off when done.
\`\`\`

## Outstanding / blockers

none
`;
  const handoff = parseHandoff(text, 'demo-plan', 'phase-02-routes.md', '/tmp/x.md', { size: 10, mtimeMs: 1 });
  assert.equal(handoff.phase, 2);
  assert.equal(handoff.status, 'complete');
  assert.equal(handoff.completed, '2026-08-01');
  assert.deepEqual(handoff.dependsOn, [1]);
  assert.deepEqual(handoff.blocks, [4]);
  assert.deepEqual(handoff.keyFiles, ['api/routes.py']);
  assert.match(handoff.whatItDid ?? '', /Shipped the routes/);
  assert.match(handoff.stateNow ?? '', /abc1234/);
  assert.equal(handoff.outstanding, 'none');
  assert.equal(handoff.prompts.length, 1);
  assert.equal(handoff.prompts[0].phase, 3);
  assert.match(handoff.prompts[0].text, /^\/phased-execution/);
});

test('handoff filenames and off-roster statuses degrade safely', () => {
  assert.deepEqual(parseHandoffFilename('phase-07-cart-api-endpoint.md'),
    { phase: 7, title: 'cart-api-endpoint' });
  assert.deepEqual(parseHandoffFilename('README.md'), { title: 'README' });
  assert.equal(normaliseStatus('complete'), 'complete');
  assert.equal(normaliseStatus('COMPLETE  '), 'complete');
  assert.equal(normaliseStatus('half-done'), 'unknown');
  assert.equal(normaliseStatus(undefined), 'unknown');
});

test('INDEX, QA table and lock files parse', () => {
  const index = parseIndex(`# Handoffs — demo

| Phase | Title | Status | Handoff |
|------:|-------|--------|---------|
| 01 | schema | complete | [phase-01-schema.md](phase-01-schema.md) |
| 02 | api | pending | TBD |
`);
  assert.deepEqual(index.map((r) => [r.phase, r.status]), [[1, 'complete'], [2, 'pending']]);
  assert.equal(index[0].link, 'phase-01-schema.md');
  assert.equal(index[1].link, undefined);

  const qa = parseTestStatus(`## QA status

| Phase | Result | Report |
|------:|--------|--------|
| 1 | waived | - |
| 2 | fail | [reports/phase-02-qa.md](reports/phase-02-qa.md) |
`);
  assert.deepEqual(qa.map((r) => [r.phase, r.result]), [[1, 'waived'], [2, 'fail']]);
  assert.equal(qa[1].report, 'reports/phase-02-qa.md');

  const future = Math.floor(Date.now() / 1000) + 600;
  const lock = parseLock(`slug=demo
phase=8
owner=me@example.com/session
host=box
claimed_at=1785622531
lease_until=${future}
`, 'phase-08.lock');
  assert.equal(lock?.phase, 8);
  assert.equal(lock?.owner, 'me@example.com/session');
  assert.equal(lock?.expired, false);

  const stale = parseLock('slug=demo\nphase=2\nowner=x\nlease_until=1000\n', 'phase-02.lock');
  assert.equal(stale?.expired, true);
});

test('a lock says what the session is working in, and an old one says nothing', () => {
  const future = Math.floor(Date.now() / 1000) + 600;
  const scoped = parseLock(
    `slug=demo\nphase=3\nowner=me/session\nlease_until=${future}\nscope=api-server,packages/cart-api\n`,
    'phase-03.lock',
  );
  assert.deepEqual(scoped?.scope, ['api-server', 'packages/cart-api']);

  // Written before scopes existed, or by a claim that named none. Absent is
  // UNKNOWN, not "collides with nothing" — the reader has to decide, so the
  // parser must not invent an empty list that reads as harmless.
  const scopeless = parseLock(`slug=demo\nphase=4\nowner=me/session\nlease_until=${future}\n`, 'phase-04.lock');
  assert.equal(scopeless?.scope, undefined);
  assert.equal(scopeless?.phase, 4);

  // A hand-written scope goes through the same normalisation as everything else.
  const messy = parseLock(
    `slug=demo\nphase=5\nowner=me/session\nlease_until=${future}\nscope=API-Server, \`web-app\` (deploy)\n`,
    'phase-05.lock',
  );
  assert.deepEqual(messy?.scope, ['api-server', 'web-app']);
});

test('markdown helpers split sections, bullets and fences', () => {
  const secs = sections('## One\n\na\n\n## Two\n\nb\n');
  assert.deepEqual(secs.map((s) => s.title), ['One', 'Two']);

  const bullets = labelledBullets(`- **Goal:** ship it.
- **Exit criteria:**
  1. first
  2. second
- plain bullet, not a field
- **Verification:** \`pytest\``);
  assert.deepEqual(bullets.map((b) => b.label), ['Goal', 'Exit criteria', 'Verification']);
  assert.match(bullets[1].body, /first[\s\S]*second/);

  const code = fences('text\n\n```bash\nrun me\n```\n');
  assert.equal(code.length, 1);
  assert.equal(code[0].code, 'run me');
});

test('indented sub-bullets continue their field instead of ending it', () => {
  // The shape a real run parked on: every command nested 2 spaces under the
  // label. The field must keep the whole list, and the nested labelled bullet
  // must stay addressable on its own.
  const bullets = labelledBullets(`- **Verification:**
  - **Verify in:** services/billing-api
  - \`task audit:schema\`
  - \`pytest -q\`
- **Handoff must record:** the revision id.`);

  assert.deepEqual(
    bullets.map((b) => b.label),
    ['Verification', 'Verify in', 'Handoff must record'],
    'parent emitted before its nested child; the sibling closes the parent',
  );
  const verification = bullets.find((b) => b.label === 'Verification')?.body ?? '';
  assert.match(verification, /task audit:schema/);
  assert.match(verification, /pytest -q/);
  assert.match(verification, /\*\*Verify in:\*\*/, 'the nested line stays in the parent body too');
  assert.equal(
    bullets.find((b) => b.label === 'Verify in')?.body, 'services/billing-api',
    'a nested single-value field carries its same-line remainder only, never the sibling lines',
  );
});

test('bullet boundaries: only a LABELLED bullet closes a field; legacy indent opens when nothing is open', () => {
  // An unlabelled bullet continues the open field at any indent — it used to
  // close the field at column 0 and DISCARD its line, which gave
  // `- **Verification:**` followed by un-indented command bullets an empty
  // body while the engine read the same plan as runnable (parse-recovery-2).
  // A field now ends where the author put the next labelled bullet.
  const kept = labelledBullets('- **Steps:** a\n- plain sibling\n  - orphan nested line');
  assert.deepEqual(kept.map((b) => b.label), ['Steps']);
  assert.equal(
    kept[0].body, 'a\n- plain sibling\n- orphan nested line',
    'unlabelled siblings continue the field instead of being thrown away',
  );

  // …and a LABELLED top-level bullet still ends it.
  const closed = labelledBullets('- **Steps:** a\n- plain sibling\n- **Exit criteria:** green');
  assert.deepEqual(closed.map((b) => b.label), ['Steps', 'Exit criteria']);
  assert.equal(closed[0].body, 'a\n- plain sibling', 'the labelled bullet is the boundary');
  assert.equal(closed[1].body, 'green', 'and it does not inherit the previous field');

  const legacy = labelledBullets('   - **Goal:** indented but top level');
  assert.deepEqual(legacy.map((b) => b.label), ['Goal']);
  assert.equal(legacy[0].body, 'indented but top level');

  // Bullet-shaped lines inside a fence never open, close, or emit anything.
  const fenced = labelledBullets('- **Verification:**\n  ```\n  - **Not a field:** x\n  - not a close\n  ```\n  tail');
  assert.deepEqual(fenced.map((b) => b.label), ['Verification']);
  assert.match(fenced[0].body, /Not a field/);
  assert.match(fenced[0].body, /tail/);
});

test('a phase written with nested verification parses whole', () => {
  // Structural mirror of the real plan whose five phases all parsed to
  // verification: '' and parked the run at boarding (private names changed —
  // this repository is public and a fixture is still a string in it).
  const plan = parsePlan(`# Nested

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|---|---|---|---|---|---|
| 1 | Backend | — | — | api | green |

## Phases

### Phase 1 — Backend
- **Goal:** stamped-basis billing.
- **Size:** M
- **Files to create/modify:**
  - **Migration** (one Alembic file): the columns
  - \`api/routes.py\`: the reserve
- **Exit criteria:**
  1. Charges once.
- **Verification:**
  - **Verify in:** services/billing-api
  - \`task audit:schema\`
  - \`pytest -q\`
- **Handoff must record:** the shapes as shipped.
`, 'nested', '/tmp/nested.md');

  assert.match(plan.phases[1].verification ?? '', /task audit:schema/);
  assert.match(plan.phases[1].verification ?? '', /pytest -q/);
  assert.equal(plan.phases[1].verifyIn, 'services/billing-api');
  assert.match(plan.phases[1].files ?? '', /Migration/, 'nested bold sub-bullets no longer empty the field');
  assert.match(plan.phases[1].files ?? '', /api\/routes\.py/);
  assert.match(plan.phases[1].handoffMustRecord ?? '', /shapes as shipped/);
});

test('a fenced code block cannot be mistaken for a heading or bullet', () => {
  const secs = sections('## Real\n\n```\n## Not a heading\n```\n\ntail\n');
  assert.equal(secs.length, 1);
  assert.match(secs[0].body, /## Not a heading/);
});

/* ------------------------------------------------------------------ *
 * Size is read from the phase's own block — the JS half of engine-5
 * ------------------------------------------------------------------ */

test('plan parse: a Size bullet under a long blockquote is still found', () => {
  // Both parsers used to read a fixed eight-line window from the heading. Two
  // phases of a live plan carry a reconciliation blockquote between the heading
  // and their `- **Size:**` bullet, so both silently answered M — agreeing with
  // each other while disagreeing with the plan. engine-parity now covers this
  // against the real corpus; this pins the JS half on its own.
  const plan = parsePlan(`---
slug: sized
phases: 3
---

# Sized

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | One   | — | — | repoA | x |
| 2 | Two   | 1 | — | repoA | x |
| 3 | Three | 2 | — | repoA | x |

## Phases

### Phase 1 — One
> **RECONCILED (2026-07-08).** A long provenance blockquote of the kind a real
> plan grows: what the original text claimed, which document superseded it,
> which sub-scope was carved out into its own plan, who is authoritative now,
> and where the executed-state ledger lives. Nine lines and counting, which is
> exactly how far the old window reached before giving up and answering M.
>
> A second paragraph, because these always have one.
- **Goal:** something
- **Size:** L
- **Verification:** \`true\`

### Phase 2 — Two
- **Goal:** the neighbour test — no Size bullet of its own
- **Verification:** \`true\`

### Phase 3 — Three
- **Goal:** prose that merely mentions resize and sizes is not a tag
- **Size:** S
- **Verification:** \`true\`
`, 'sized', '/tmp/sized.md');

  assert.equal(plan.phases[1].size, 'L', 'found past the blockquote');
  assert.equal(plan.phases[2].size, 'M', 'no bullet of its own — never the neighbour\'s');
  assert.equal(plan.phases[3].size, 'S');
});

test('plan parse: prose containing "sizes" is not a Size tag', () => {
  const plan = parsePlan(`---
slug: prose
phases: 1
---

# Prose

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | One | — | — | repoA | x |

## Phases

### Phase 1 — One
- **Goal:** resize the thumbnails and normalise their sizes
- **Verification:** \`true\`
`, 'prose', '/tmp/prose.md');

  assert.equal(plan.phases[1].size, 'M');
});

/* ------------------------------------------------------------------ *
 * The phase table's columns, mapped by NAME
 * ------------------------------------------------------------------ *
 * `_table_scan` reads the header row once and maps `depends` / `^repos` /
 * `^title` out of it. Reading them by POSITION was a ship-breaker on the bash
 * side (engine-1) and this half was still doing it: a five-column table gave
 * every phase a scope invented from its exit-criteria text. `engine-parity`
 * compares deps, size, gated, repos and gate-kind against the engine for every
 * fixture — it has no `--title` mode to compare against, so the title rules are
 * pinned here instead.
 */

const withGraph = (header: string, rows: string) => parsePlan(
  `# T\n\n## Phase graph\n\n${header}\n\n## Phases\n`.replace('\n\n## Phases', `\n${rows}\n\n## Phases`),
  'cols', '/tmp/cols.md',
);

test('columns are found by header name, not by position', () => {
  // Five columns: `Parallel-safe with` dropped. Repos is at index 3 here, where
  // the old positional reader looked for it at 4 and found "tests pass".
  const plan = withGraph(
    '| Phase | Title | Depends on | Repos | Exit criteria |\n|--:|--|--|--|--|',
    '| 1 | Alpha | — | api | tests pass |\n| 2 | Beta | 1 | web | docs updated |',
  );
  assert.deepEqual(plan.graph.map((r) => r.repos), ['api', 'web']);
  assert.deepEqual(plan.graph.map((r) => r.title), ['Alpha', 'Beta']);
  assert.deepEqual(plan.graph.map((r) => r.dependsOn), [[], [1]]);
  assert.deepEqual(plan.graph.map((r) => r.exitCriteria), ['tests pass', 'docs updated']);
});

test('a column the header does not name reads EMPTY — deps and repos are never guessed', () => {
  // No Repos column at all. The engine answers empty and lets `--repos` fall
  // back to `all` (collides with everything); inventing a scope from whatever
  // sits at index 4 is the damage engine-1 did.
  const plan = withGraph(
    '| Phase | Title | Depends on | Exit criteria |\n|--:|--|--|--|',
    '| 1 | Alpha | — | tests pass |',
  );
  assert.equal(plan.graph[0].repos, '', 'a table that names no Repos column says nothing about scope');
  assert.equal(plan.graph[0].title, 'Alpha');
  assert.deepEqual(plan.graph[0].dependsOn, []);
});

test('an unnamed TITLE falls back to the second cell, because a label is not a claim', () => {
  // Two live hub plans head their table exactly like this: the phase NUMBER
  // under `#` and the phase's name under `Phase`, so nothing matches /^title/.
  // `_table_scan` ends with `if (ti == 0) ti = 3` for this case — deps and
  // repos get -1 (empty), the title gets a position. Blanking it here renamed
  // every phase of those plans to nothing.
  const plan = withGraph(
    '| # | Phase | Depends on | Parallel-safe with | Repos | Exit criteria (summary) |\n|--:|--|--|--|--|--|',
    '| 1 | Catalog structure | — | 2 | shop/shop-backend | green |',
  );
  assert.equal(plan.graph[0].phase, 1);
  assert.equal(plan.graph[0].title, 'Catalog structure');
  assert.equal(plan.graph[0].repos, 'shop/shop-backend');
});

test('a table with no header at all falls back to position, as the engine does', () => {
  const plan = withGraph(
    '| 1 | Alpha | — | 2 | api | tests pass |',
    '| 2 | Beta | 1 | — | web | docs updated |',
  );
  assert.deepEqual(plan.graph.map((r) => r.repos), ['api', 'web']);
  assert.deepEqual(plan.graph.map((r) => r.title), ['Alpha', 'Beta']);
  assert.deepEqual(plan.graph.map((r) => r.dependsOn), [[], [1]]);
});

test('the FIRST row of a duplicated phase wins, matching the engine\'s load loop', () => {
  const plan = withGraph(
    '| Phase | Title | Depends on | Repos |\n|--:|--|--|--|',
    '| 1 | Alpha | — | api |\n| 1 | Alpha again | 2 | web |\n| 2 | Beta | 1 | api |',
  );
  assert.deepEqual(plan.graph.map((r) => r.phase), [1, 2], 'the repeat is dropped, not appended');
  assert.equal(plan.graph[0].title, 'Alpha');
  assert.equal(plan.graph[0].repos, 'api');
});

test('the Worktrees directive is read in every shape a person writes it', () => {
  const budget = (line: string) => parsePlan(
    `---\nslug: w\n---\n\n# W\n\n## Session budget\n\n- **Target model:** \`claude-opus-5\`\n${line}\n`,
    'w', '/tmp/w.md',
  ).sessionBudget.worktrees;

  // The bullet prefix and the bold markers are both optional — exactly the
  // lesson `QA gate` learned the hard way, where `- **QA gate:** off` missed
  // both rules and silently read as ON.
  assert.equal(budget('- **Worktrees:** on'), 'on');
  assert.equal(budget('**Worktrees:** on'), 'on');
  assert.equal(budget('* Worktrees: on'), 'on');
  assert.equal(budget('- Worktrees: ON'), 'on');
  assert.equal(budget('> - **Worktrees:** on'), 'on', 'a blockquoted budget still counts');
  assert.equal(budget('- **Worktrees:** on — two lanes, two trees'), 'on',
    'a trailing note after the word must not hide it');

  // Off is a value, and absence is not.
  assert.equal(budget('- **Worktrees:** off'), 'off');
  assert.equal(budget('- **Budget:** ~200K'), undefined);
  assert.equal(budget('- **Worktrees:** maybe'), undefined, 'a word that is not on/off says nothing');

  // The one that must NOT match: prose that merely mentions worktrees.
  assert.equal(
    budget('- Note: use a linked worktree if another session is live on this repo'),
    undefined,
    'prose about worktrees is not a directive',
  );
});

/* ------------------------------------------------------- the Checkout bullet */

// A tiny two-phase plan whose only variable is Phase 2's Checkout line — the
// same per-line closure shape the Worktrees directive test uses above. The
// graph table matters: `detachRequestedIn` walks `plan.graph`, so a fixture
// without rows would answer false for every bullet and prove nothing.
const checkoutPlan = (line: string) => parsePlan(
  '---\nslug: c\n---\n\n# C\n\n## Phase graph\n\n'
  + '| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |\n'
  + '|------:|-------|-----------|--------------------|-------|---------------|\n'
  + '| 1 | One | — | — | api | done |\n'
  + '| 2 | Two | 1 | — | api | done |\n\n'
  + '## Phases\n\n### Phase 1 — One\n- **Goal:** g.\n\n'
  + '### Phase 2 — Two\n- **Goal:** g.\n' + (line ? line + '\n' : ''),
  'c', '/tmp/c.md',
);

test('the Checkout bullet is read in every shape a person writes it', () => {
  const co = (line: string) => checkoutPlan(line).phases[2]?.checkout;

  assert.equal(co('- **Checkout:** main'), 'main');
  assert.equal(co('* **Checkout:** master'), 'master', 'the bullet marker may be an asterisk');
  assert.equal(co('- **checkout:** pe/release'), 'pe/release', 'the label is case-insensitive');
  // The JS field reader requires the BOLD label — true of every phase bullet
  // it reads (Size, MCP, QA…) — where the engine's bash `checkout_directive`
  // is bold-optional. The authored spelling (references/plan-format.md) is
  // bold, so the narrower reader sits on the safe side of that asymmetry;
  // pinned here so a change to it is a decision rather than a drift.
  assert.equal(co('- Checkout: pe/release'), undefined, 'an unbolded label is not a field to this reader');
  assert.equal(co(''), undefined, 'no bullet reads as undefined, never an empty string');
  assert.equal(checkoutPlan('- **Checkout:** main').phases[1]?.checkout, undefined,
    'a neighbour phase does not inherit the bullet');
});

test('detachRequestedIn is the run-level Checkout question, scoped to onlyPhases', () => {
  const asks = (line: string, phases?: number[]) => detachRequestedIn(checkoutPlan(line), phases);

  assert.equal(asks('- **Checkout:** main'), true);
  assert.equal(asks('- **Checkout:** master'), true);
  assert.equal(asks('- **Checkout:** DEFAULT'), true, 'the spelling is wantsDefaultCheckout to judge: case-insensitive');
  assert.equal(asks('- **Checkout:** `main`'), true, 'backticks are stripped by the vocabulary, not re-read here');
  assert.equal(asks('- **Checkout:** pe/other'), false, 'a verbatim branch is documentation, not a detach ask');
  assert.equal(asks(''), false, 'no bullet anywhere');

  assert.equal(asks('- **Checkout:** main', [1]), false, 'scoped out: the bullet is on phase 2');
  assert.equal(asks('- **Checkout:** main', [2]), true);
  assert.equal(asks('- **Checkout:** main', []), true, 'an empty scope means every phase counts');
});

/* ------------------------------------------------------------------ *
 * Where the work happens and where it lands (5.1.0)
 * ------------------------------------------------------------------ */

/** A two-phase plan with a §Session budget line and a phase-2 bullet, either optional. */
const directivePlan = (planLine: string, phaseBullet: string) => parsePlan(
  '---\nslug: d\n---\n\n# D\n\n## Session budget\n'
  + '**Target model:** `claude-opus-5`\n' + (planLine ? planLine + '\n' : '')
  + '\n## Phase graph\n\n'
  + '| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |\n'
  + '|------:|-------|-----------|--------------------|-------|---------------|\n'
  + '| 1 | One | — | — | api | done |\n'
  + '| 2 | Two | 1 | — | api | done |\n\n'
  + '## Phases\n\n### Phase 1 — One\n- **Goal:** g.\n\n'
  + '### Phase 2 — Two\n- **Goal:** g.\n' + (phaseBullet ? phaseBullet + '\n' : ''),
  'd', '/tmp/d.md',
);

test('the landing directives resolve phase over plan over default, and SAY which', () => {
  const land = (planLine: string, bullet: string) => {
    const r = landFor(directivePlan(planLine, bullet), 2);
    return `${r.value}/${r.source}`;
  };

  assert.equal(land('', ''), 'hold/default', 'a plan that says nothing lands nothing, and says it is a default');
  assert.equal(land('**Landing:** pr', ''), 'pr/plan');
  assert.equal(land('', '- **Land:** trunk'), 'trunk/phase', 'a bullet with no plan line behind it is still the phase');
  assert.equal(land('**Landing:** pr', '- **Land:** integrate'), 'integrate/phase', 'the bullet wins');
  // The word AGREEING with the plan does not make it the plan's: a phase that
  // states its policy has stated it, and the console shows the two differently.
  assert.equal(land('**Landing:** pr', '- **Land:** pr'), 'pr/phase');
  // A sibling does not inherit phase 2's bullet.
  assert.equal(
    `${landFor(directivePlan('', '- **Land:** trunk'), 1).value}`, 'hold',
    'phase 1 has no bullet and the plan has no line',
  );

  // The plan-wide label is `Landing` and the phase's is `Land`; neither reads
  // the other's spelling, which is what keeps "the policy for this plan" and
  // "what THIS phase does" from quietly becoming one field.
  assert.equal(land('**Land:** pr', ''), 'hold/default', 'the plan-wide label is Landing, not Land');
  assert.equal(land('', '- **Landing:** pr'), 'hold/default', "the phase's label is Land, not Landing");
});

test('an unrecognised directive word falls THROUGH rather than being adopted', () => {
  // The fail-safe direction, and the reason lint F27 exists: a reader that
  // coerced `sometimes` to the default would be right about the behaviour and
  // silent about the typo, so `Land: prr` would behave exactly like a plan
  // that had never mentioned landing and nothing would ever say so.
  const r = landFor(directivePlan('**Landing:** pr', '- **Land:** sometimes'), 2);
  assert.deepEqual(r, { value: 'pr', source: 'plan' }, 'the phase said nothing readable, so the plan answers');
  const both = landFor(directivePlan('**Landing:** whenever', '- **Land:** sometimes'), 2);
  assert.deepEqual(both, { value: 'hold', source: 'default' }, 'neither level said a word, so neither is credited');
});

test('isolation is the one directive with no default — silence is an answer', () => {
  // A phase that says nothing inherits the RUN, and the run is not in the
  // plan. Answering `shared` here would be the parser deciding a question the
  // operator owns, and would make a run-level `worktree` setting unreachable
  // on every plan ever written.
  assert.equal(isolationFor(directivePlan('', ''), 2), undefined);
  assert.deepEqual(isolationFor(directivePlan('', '- **Isolation:** worktree'), 2), { value: 'worktree', source: 'phase' });
  assert.deepEqual(isolationFor(directivePlan('**Isolation:** shared', ''), 2), { value: 'shared', source: 'plan' });
});

test('the plan-wide directives are plan-wide — a phase bullet cannot answer them', () => {
  // `Messaging` off for the run with one phase claiming `on`: honouring the
  // bullet would let one phase switch on a transport the plan turned off for
  // everybody, which is a decision about the run and not about the phase.
  const plan = directivePlan('**Messaging:** off', '- **Messaging:** on');
  assert.deepEqual(messagingOf(plan), { value: 'off', source: 'plan' });
  assert.deepEqual(messagingOf(directivePlan('', '')), { value: 'on', source: 'default' });
  assert.deepEqual(conflictPolicyOf(directivePlan('**Conflicts:** rebase-session', '')), { value: 'rebase-session', source: 'plan' });
  assert.deepEqual(conflictPolicyOf(directivePlan('', '')), { value: 'halt', source: 'default' });
});

test('the base branch is a ref, not a vocabulary — the slash and the dot survive', () => {
  assert.deepEqual(baseBranchOf(directivePlan('**Base branch:** release/5.1', '')), { value: 'release/5.1', source: 'plan' });
  assert.deepEqual(baseBranchOf(directivePlan('**Base branch:** `head`', '')), { value: 'head', source: 'plan' }, 'backticks are stripped');
  assert.deepEqual(baseBranchOf(directivePlan('', '')), { value: 'origin/HEAD', source: 'default' });
  // Two WORDS are special and every other value is a ref passed through whole,
  // so an unknown value is not a fall-through here the way a policy word is.
  assert.deepEqual(baseBranchOf(directivePlan('**Base branch:** feature/whatever-42', '')), { value: 'feature/whatever-42', source: 'plan' });
});

test('clash zones are the backticked paths, deduped, and an empty list is not a null', () => {
  assert.deepEqual(clashZonesOf(directivePlan('**Clash zones:** `a/`, `b.ts`, `a/`', '')), ['a/', 'b.ts']);
  assert.deepEqual(clashZonesOf(directivePlan('', '')), [], 'a plan that named none and a plan with none are one instruction');
  assert.deepEqual(clashZonesOf(directivePlan('**Clash zones:** none, really', '')), [],
    'unbackticked prose names no path — the same harvest the MCP and Credentials lines use');
});

test('the issues directive narrows per phase, and defaults to off', () => {
  const issues = (planLine: string, bullet: string) => issuesFor(directivePlan(planLine, bullet), 2);
  assert.deepEqual(issues('', ''), { value: 'off', source: 'default' }, 'an outward write is never a default');
  assert.deepEqual(issues('**Issues:** file', ''), { value: 'file', source: 'plan' });
  assert.deepEqual(issues('**Issues:** file', '- **Issues:** draft'), { value: 'draft', source: 'phase' });
  assert.deepEqual(issues('**Issues:** file', '- **Issues:** off'), { value: 'off', source: 'phase' });
});
