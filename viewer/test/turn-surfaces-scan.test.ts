/**
 * The old cards moved in (control-tower phase 139, #216, exit criteria 1, 2
 * and 5) — a source scan.
 *
 * Nothing draws a person's ask in a shape of its own any more: a permission
 * ask, a question, a gate, an errand, a sign-in or a step is drawn by the
 * family — Your turn's page (`client/src/screens/turn/` since 7.0, quiet-console phase 8) and the cards it
 * draws (`cards/`: the item, its row, the decision, the guide, and the step
 * card with its words, its lazy door and its terminal sheet) — and every older
 * surface draws the ITEM through the family's row variant (`cards/item-row.tsx`,
 * reached through `lazy-item-row.tsx`), which links to the item on the page. This file reads the client's source and
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
  rel.startsWith('screens/turn/') ||
  // The card's parts since turn-by-turn phase 8: its head, timing grid, steps, act forms and verdict.
  rel.startsWith('cards/turn/') ||
  rel.startsWith('data/') ||
  [
    'cards/item-card.tsx',
    'cards/item-row.tsx',
    'cards/lazy-item-row.tsx',
    'cards/decision-card.tsx',
    'cards/guide.tsx',
    'cards/human-step-words.ts',
    'cards/lazy-step-card.tsx',
    'cards/step-terminal-sheet.tsx',
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
  // A person declines, with a reason the session reads; the OWNER withdraws, on Your turn alone (7.0, phase 8).
  { what: 'a step withdrawn outside Your turn — Withdraw is the page’s, through data/turn', re: /humanStepWithdraw|\bwithdrawItem\(/ },
];

/**
 * The ones that stand, by ruling (§Architecture 19 "what stays as it is").
 * Each names its file, the shape, and why — and must still match.
 */
const STANDS: readonly { rel: string; what: string; why: string }[] = [
  {
    rel: 'screens/plan/phases/gate-card.tsx',
    what: 'a gate approved by a form of its own',
    why: 'the plan’s door to gate-status.md for a gate NOBODY is asked about (an ai or auto gate, a phase not ready) — the engine reads it; a gate that asks a person wears the summons and draws its item (quiet-console phase 10)',
  },
  {
    rel: 'cards/errand.tsx',
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
  assert.deepEqual(offenders, [], 'draw the item through cards/lazy-item-row instead');
  const stale = STANDS.filter((entry) => !used.has(`${entry.rel} — ${entry.what}`)).map((entry) => entry.rel);
  assert.deepEqual(stale, [], 'a ruling that matches nothing any more is stale — delete it');
});

test('TS-2 each older surface draws the item through the row variant, which links to the page', () => {
  // The Run view's asks (quiet-console phase 11, the 6.2 approval queue's place).
  for (const rel of ['screens/plan/run/halt.tsx']) {
    assert.match(read(rel), /from '@\/cards\/lazy-item-row'/, `${rel} draws its item through LazyItemRow`);
  }
  // The errand card is a card itself since quiet-console phase 5: it reaches the row beside it.
  assert.match(read('cards/errand.tsx'), /from '\.\/lazy-item-row'/, 'cards/errand.tsx draws its item through LazyItemRow');
  // 7.0's run row — its one action, `row-action.tsx` — and its Your turn group
  // (quiet-console phase 7) reach the same row through the family's lazy door,
  // and the row's one action is still its run's oldest item's primary.
  for (const rel of ['screens/runs/row-action.tsx', 'screens/runs/your-turn.tsx']) {
    assert.match(read(rel), /from '@\/cards\/lazy-item-row'/, `${rel} draws its item through LazyItemRow`);
  }
  // So does 7.0's gate card (quiet-console phase 10), for a gate that asks a person now.
  assert.match(
    read('screens/plan/phases/gate-card.tsx'),
    /from '@\/cards\/lazy-item-row'/,
    'screens/plan/phases/gate-card.tsx draws its item through LazyItemRow',
  );
  assert.match(read('screens/runs/model.ts'), /\brunItems\(/);
  // The row links to the item: `#/turn/<id>`.
  const row = read('cards/item-row.tsx');
  assert.match(row, /data-testid="item-link"/);
  assert.match(read('screens/turn/surfaces.ts'), /turnHref\(itemIdOf\(row\)\)/);
  // The row is reached lazily: the step card is no first paint's business.
  const lazyDoor = read('cards/lazy-item-row.tsx');
  assert.match(lazyDoor, /lazy\(\(\) => import\('\.\/item-row'\)\)/);
  for (const { rel, source } of files) {
    assert.doesNotMatch(source, /from '@\/cards\/item-row'/, `${rel} imports the row statically`);
  }
  // So is the one card, where a surface draws a step from its inbox row (measured-console phase 32).
  assert.match(read('cards/lazy-step-card.tsx'), /lazy\(\(\) => import\('\.\/item-card'\)/);
  for (const rel of ['cards/inbox-row.tsx', 'screens/runs/run-detail.tsx']) {
    assert.doesNotMatch(read(rel), /from '(@\/cards|\.)\/item-card'/, `${rel} imports the card statically`);
    assert.match(read(rel), /\bLazyStepCard\b/, `${rel} draws a step through LazyStepCard`);
  }
});

test('TS-3 Your turn is the items: no loose rows, a summoned run keeps its group, and Your turn (n) counts items and opens the page', () => {
  // The home's groups are decided in ONE fold (7.0, quiet-console phase 7):
  // Your turn is the items a person owes now, counted as such, and a run a
  // person's turn summons sits in the group of what it IS — never a loose row
  // beside the strips, never a run drawn twice.
  const fold = read('data/run-groups.ts');
  assert.doesNotMatch(fold, /\bloose\b\s*[:,]/, 'the groups carry no loose rows');
  assert.match(fold, /const items = itemsNow\(inbox\)/);
  assert.match(fold, /'needs-you': items\.length/);
  assert.match(fold, /\brunItems\(/);
  // The group draws the items through the family's row, in no shape of its own.
  for (const rel of ['screens/runs/groups.tsx', 'screens/runs/your-turn.tsx']) {
    assert.doesNotMatch(
      read(rel),
      /\bInboxRow\b|\bLooseRows\b|\bSuggestionCard\b/,
      `${rel} draws the items through the family's row`,
    );
  }
  const yourTurn = read('screens/runs/your-turn.tsx');
  assert.match(yourTurn, /from '@\/cards\/lazy-item-row'/);
  assert.match(yourTurn, /data-testid="bay-turn"/);
  assert.match(yourTurn, /href=\{turnHref\(\)\}/);
  // The situation words count what a person owes NOW — Do now and Needs one
  // detail, the two groups the page's own headline counts — and open the page.
  const line = read('shell/situation-line.tsx');
  assert.match(line, /turn\.counts\.now \+ turn\.counts\.decide/);
  assert.match(line, /href: turnHref\(\)/);
});

test('TS-4 the launch door lists items, and a plan’s auto-open link is shown whole and sent back', () => {
  // The departure notice is the door (7.0, quiet-console phase 13); the form still records what it showed.
  const door = read('screens/launch/quick.tsx');
  assert.match(door, /turnHref\(step\.item\)/, 'Do it now opens the item');
  assert.match(door, /data-testid="door-step-auto"/);
  assert.match(door, /showAtDoor\(slug/);
  assert.match(read('screens/launch/run-setup.tsx'), /shownAtDoor\(slug\)/);
});

test('TS-5 Not doing this is the person’s no; Withdraw is the owner’s, on Your turn alone', () => {
  // A person declines with a reason the session reads (control-tower phase 139);
  // the dead Dismiss fetcher stays gone. 7.0 (quiet-console phase 8) gives the
  // OWNER a *Withdraw* — the console's own `dismiss`, through the owner door —
  // pressed from the page through `data/turn.ts` and from nowhere else (TS-1).
  const fetchers = read('data/human-steps.ts');
  assert.doesNotMatch(fetchers, /humanStepDismiss/);
  assert.match(fetchers, /humanStepWithdraw:[^\n]*\n[^\n]*at\(id, 'dismiss'\)/);
  assert.match(read('data/turn.ts'), /export function withdrawItem\(/);
  assert.match(read('screens/turn/index.tsx'), /\bwithdrawItem\(/);
  // The person's no is the Task's act form since turn-by-turn phase 8 (`cards/turn/act.tsx`).
  assert.match(read('cards/turn/act.tsx'), />\s*Not doing this\s*</);
});

