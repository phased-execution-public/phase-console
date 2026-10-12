/**
 * The status ratchet, at its floor.
 *
 * A status is drawn through the typed family in this folder and nowhere else:
 * a dot and a word, painted by `shared/status-model.js`. This counts, per file,
 * every LEGACY status site under `client/src` — a place that paints a status
 * through the old one-question path — and holds the count to
 * `status-ratchet.json`, which is empty. The count was ratcheted down to zero
 * one page at a time, so from here it is a ban: any site at all is a
 * regression. Not counted: the typed family itself, and tests.
 *
 * The second half is a source scan for the names that path used — the 2.x
 * `Chip`/`StateChip`, their tone words, the `--line-*` aliases, the 6.x
 * `StatusBadge`/`StatusDot`/`ViewBadge` — over every source file, so a copy
 * pasted back from an old branch fails here by name.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Through a helper, never `new URL('<literal>', import.meta.url)` inline: Vite
// rewrites that shape as an asset reference, and the path stops being a file.
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SRC = here('../../');
const SNAPSHOT = here('./status-ratchet.json');
const CHECK_DIST = here('../../../../scripts/check-dist.mjs');

/** What a legacy site looks like. A template state class fed by the model's own paint is not one. */
const LEGACY: readonly [string, RegExp][] = [
  ['<StatusBadge', /<StatusBadge\b/g],
  ['<StatusDot', /<StatusDot\b/g],
  ['<StateChip', /<StateChip\b/g],
  ['statusBadgeClass(', /\bstatusBadgeClass\(/g],
  ['decorateStatusWord(', /\bdecorateStatusWord\(/g],
  ['…UiState(', /\b(?:run|phase|board|situation|actor|word)UiState\(/g],
  ['uiState(', /\buiState\(/g],
  ['STATE_META[', /\bSTATE_META\[/g],
  [
    '`state-${word}`',
    /`state-\$\{(?!(?:NOTE_ROWS\b|view\.paint|fact\.paint|meta\.paint|row\.paint|paint\b))/g,
  ],
];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const isTest = (file: string) => /\.test\.tsx?$/.test(file);

/** Legacy status sites per file, relative to `client/src`, zero-count files omitted. */
function countLegacySites(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of walk(SRC)) {
    if (!/\.tsx?$/.test(file) || isTest(file)) continue;
    const rel = relative(SRC, file).split('\\').join('/');
    // The family is what draws a status; `DotWord` writes `state-${view.paint}`.
    if (rel.startsWith('ui/status/')) continue;
    const text = readFileSync(file, 'utf8');
    const n = LEGACY.reduce((sum, [, re]) => sum + (text.match(re)?.length ?? 0), 0);
    if (n > 0) counts[rel] = n;
  }
  return counts;
}

/** Source with comments removed: a comment may tell the history, code may not carry it. */
const code = (file: string) =>
  readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\x27"])\/\/.*$/gm, '$1');

type Snapshot = { about: string; total: number; files: Record<string, number> };

describe('the status ratchet', () => {
  it('is at zero — every status under client/src is drawn through the typed family', () => {
    const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Snapshot;
    expect(snapshot.total).toBe(0);
    expect(snapshot.files).toEqual({});
    expect(countLegacySites(), 'a legacy status site — draw it through @/ui/status').toEqual({});
  });

  it('no retired status name is spelled in any source file', () => {
    const RETIRED: readonly [string, RegExp, RegExp][] = [
      ['StateChip', /\.tsx?$/, /\bStateChip\b/],
      ['<Chip>', /\.tsx?$/, /<Chip\b|\bChipTone\b|\bchipVariants\b|\bLEGACY_TONE\b/],
      ['the 6.x status badge', /\.tsx?$/, /\bStatusBadge\b|\bStatusDot\b|\bViewBadge\b/],
      ['a --line-* token', /\.(?:css|tsx?)$/, /(?<![\w-])--line-[a-z]/],
      ['a 2.x colour name', /\.(?:css|tsx?)$/, /--color-(?:ready|progress|blocked|stuck|gated)\b/],
      [
        'a 2.x colour utility',
        /\.tsx?$/,
        /(?<![\w-])(?:text|bg|border|fill|stroke|ring|from|to)-(?:ready|progress|blocked|stuck|gated)(?![\w-])/,
      ],
      [
        'a board-word state class',
        /\.(?:css|tsx?)$/,
        /(?<![\w-])state-(?:ready|in-progress|blocked|stuck|gated)(?![\w-])/,
      ],
    ];
    const found: string[] = [];
    for (const file of walk(SRC)) {
      if (isTest(file) || !/\.(?:css|tsx?)$/.test(file)) continue;
      const text = code(file);
      for (const [what, applies, re] of RETIRED) {
        if (applies.test(file) && re.test(text)) found.push(`${relative(SRC, file)}: ${what}`);
      }
    }
    expect(found, 'a retired status name').toEqual([]);
  });

  it('first paint stays gated at 170 KB served', () => {
    // `verify:dist` enforces the number; this holds the number itself, so a
    // change that needs room has to say so here rather than edit a constant.
    const gate = /const FIRST_PAINT_SERVED = (\d+) \* 1024;/.exec(readFileSync(CHECK_DIST, 'utf8'));
    expect(gate, 'check-dist.mjs states the first-paint gate').not.toBeNull();
    expect(Number(gate![1])).toBeLessThanOrEqual(170);
  });
});
