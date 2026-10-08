/**
 * The old cards moved in (control-tower phase 139, #216, exit criteria 1, 2
 * and 5) — a source scan.
 *
 * Nothing draws a person's ask in a shape of its own any more: a permission
 * ask, a question, a gate, an errand, a sign-in or a step is drawn by the
 * family — `client/src/features/turn/` and the one card it grew from
 * (`components/human-step-card.tsx`, its words, its lazy door and its terminal
 * sheet) — and every older surface draws the ITEM through the family's row
 * variant (`features/turn/item-row.tsx`, reached through `lazy-item-row.tsx`),
 * which links to the item on the page. This file reads the client's source and
 * fails on a bespoke ask creeping back, with the few that stand by ruling
 * named below, each with its reason — an entry that no longer matches anything
 * fails too, so the list cannot rot.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const viewer = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(viewer, 'client', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(abs);
  }
  return out;
}

const files = walk(SRC).map((abs) => ({ rel: relative(SRC, abs), source: readFileSync(abs, 'utf8') }));
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

/** The family that may draw a person's ask — and the API layer, which draws nothing. */
const FAMILY = (rel: string): boolean =>
  rel.startsWith('features/turn/') ||
  rel.startsWith('lib/api/') ||
  [
    'components/human-step-card.tsx',
    'components/human-step-words.ts',
    'components/human-step-lazy.tsx',
    'components/step-terminal-sheet.tsx',
  ].includes(rel);

/** What a bespoke ask looks like in source — each a shape only the family may draw. */
const BESPOKE: readonly { what: string; re: RegExp }[] = [
  { what: 'a relayed question’s options drawn as buttons', re: /\bquestion\??\.items\b/ },
  { what: 'an approval card answered by hand', re: /\bonDecide\b|\bapi\.decide\(/ },
  { what: 'a relayed question answered by hand', re: /\bonAnswer\b|\bapi\.answerQuestion\(/ },
  { what: 'a card’s deadline extended by hand', re: /\bonExtend\b|\bapi\.extend\(/ },
  { what: 'the retired card shapes', re: /\bfunction (ApprovalCard|QuestionCard)\b/ },
  { what: 'a step pressed outside its card', re: /\bhumanStepsApi\b/ },
  { what: 'a gate approved by a form of its own', re: /\bapi\.approveGate\(/ },
  { what: 'an errand’s ask said in a shape of its own', re: /\berrand\.how\b/ },
  { what: 'a step dismissed by a person — a person declines; only the console withdraws', re: /humanStepDismiss/ },
];

/**
 * The ones that stand, by ruling (§Architecture 19 "what stays as it is").
 * Each names its file, the shape, and why — and must still match.
 */
const STANDS: readonly { rel: string; what: string; why: string }[] = [
  {
    rel: 'features/plans/gate-card.tsx',
    what: 'a gate approved by a form of its own',
    why: 'the plan’s door to gate-status.md for a gate NOBODY is asked about (an ai or auto gate, a phase not ready) — the engine reads it; a gate that IS an ask draws its item',
  },
  {
    rel: 'components/errand.tsx',
    what: 'an errand’s ask said in a shape of its own',
    why: 'the ladder’s how, said only where the inbox holds no item for the errand',
  },
];

test('TS-1 no component outside the family draws a person’s ask in a bespoke shape', () => {
  const offenders: string[] = [];
  const used = new Set<string>();
  for (const { rel, source } of files) {
    if (FAMILY(rel)) continue;
    for (const { what, re } of BESPOKE) {
      if (!re.test(source)) continue;
      const stands = STANDS.find((entry) => entry.rel === rel && entry.what === what);
      if (stands) used.add(`${rel} — ${what}`);
      else offenders.push(`${rel}: ${what} (${re})`);
    }
  }
  assert.deepEqual(offenders, [], 'draw the item through features/turn/lazy-item-row instead');
  const stale = STANDS.filter((entry) => !used.has(`${entry.rel} — ${entry.what}`)).map((entry) => entry.rel);
  assert.deepEqual(stale, [], 'a ruling that matches nothing any more is stale — delete it');
});

test('TS-2 each older surface draws the item through the row variant, which links to the page', () => {
  for (const rel of [
    'features/runs/approvals.tsx',
    'features/plans/gate-card.tsx',
    'components/errand.tsx',
  ]) {
    assert.match(read(rel), /from '@\/features\/turn\/lazy-item-row'/, `${rel} draws its item through LazyItemRow`);
  }
  // The strip's ONE action is its run's oldest item's primary, loaded with the row.
  assert.match(read('features/runs/tower/strip.tsx'), /import\('@\/features\/turn\/item-row'\)/);
  assert.match(read('features/runs/tower/strip-model.ts'), /\brunItems\(/);
  // The row links to the item: `#/turn/<id>`.
  const row = read('features/turn/item-row.tsx');
  assert.match(row, /data-testid="item-link"/);
  assert.match(read('features/turn/surfaces.ts'), /turnHref\(itemIdOf\(row\)\)/);
  // The row is reached lazily: the step card is no first paint's business.
  const lazyDoor = read('features/turn/lazy-item-row.tsx');
  assert.match(lazyDoor, /lazy\(\(\) => import\('\.\/item-row'\)\)/);
  for (const { rel, source } of files) {
    if (rel.startsWith('features/turn/') || rel === 'features/runs/tower/strip.tsx') continue;
    assert.doesNotMatch(source, /from '@\/features\/turn\/item-row'/, `${rel} imports the row statically`);
  }
});

test('TS-3 the Needs-you bay keeps runs: no loose rows, and Your turn (n) counts items and opens the page', () => {
  const model = read('features/runs/tower/tower-model.ts');
  assert.doesNotMatch(model, /\bloose\b\s*[:,]/, 'the Tower model carries no loose rows');
  assert.match(model, /items: itemsNow\(inbox\)/);
  const bays = read('features/runs/tower/bays.tsx');
  assert.doesNotMatch(bays, /\bInboxRow\b|\bLooseRows\b|\bSuggestionCard\b/, 'the bay draws strips, not rows');
  assert.match(bays, /data-testid="bay-turn"/);
  const line = read('features/runs/tower/situation-line.tsx');
  assert.match(line, /tower\.items\?\.length/);
  assert.match(line, /href: turnHref\(\)/);
});

test('TS-4 the launch door lists items, and a plan’s auto-open link is shown whole and sent back', () => {
  const door = read('features/run-setup/quick.tsx');
  assert.match(door, /turnHref\(step\.item\)/, 'Do it now opens the item');
  assert.match(door, /data-testid="door-step-auto"/);
  assert.match(door, /showAtDoor\(slug/);
  assert.match(read('features/run-setup/run-setup.tsx'), /shownAtDoor\(slug\)/);
});

test('TS-5 Not doing this is the person’s no; the Dismiss fetcher is gone', () => {
  assert.doesNotMatch(read('lib/api/human-steps.ts'), /humanStepDismiss/);
  assert.match(read('features/turn/item-card.tsx'), />\s*Not doing this\s*</);
});

