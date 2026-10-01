/**
 * The status ratchet (control-tower phase 16).
 *
 * Status model v2 lands beside the one-enum paint owner, and the pages move to
 * the typed family one phase at a time. This counts, per file, every LEGACY
 * status site left — a place that still paints a status through the old
 * one-question path — and holds the count to `status-ratchet.json` in BOTH
 * directions, the way the real-browser baseline is held:
 *
 *   - a file whose count ROSE (or a new file with sites) is a regression: new
 *     code draws status through the typed family (`@/components/ui/status`);
 *   - a file whose count FELL must be banked — lower the snapshot in the same
 *     commit (`STATUS_RATCHET_WRITE=1 npm --prefix viewer run test:client --
 *     client/src/components/ui/status/ratchet.test.ts`), so a later phase
 *     cannot quietly spend the room.
 *
 * Each page phase lowered its own files, and control-tower phase 31 reached
 * zero: the snapshot is empty, so from here on the count is a ban — any site at
 * all is a regression. Not counted: the legacy primitives' own definitions, the
 * typed family itself, and tests. The same phase deleted what the ratchet was
 * counting down to — the 2.x `Chip`/`StateChip`, their tone words and the
 * `--line-*` aliases — and the source scan below holds them gone.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Through a helper, never `new URL('<literal>', import.meta.url)` inline: Vite
// rewrites that shape as an asset reference, and the path stops being a file.
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SRC = here('../../../');
const SNAPSHOT = here('./status-ratchet.json');
const CHECK_DIST = here('../../../../../scripts/check-dist.mjs');

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

/** The definitions of the legacy primitives are what is being ratcheted away, not sites of it. */
const NOT_SITES = new Set(['components/ui/status-badge.tsx', 'lib/status-vocab.ts']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Legacy status sites per file, relative to `client/src`, zero-count files omitted. */
function countLegacySites(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file).split('\\').join('/');
    if (NOT_SITES.has(rel) || rel.startsWith('components/ui/status/')) continue;
    const text = readFileSync(file, 'utf8');
    const n = LEGACY.reduce((sum, [, re]) => sum + (text.match(re)?.length ?? 0), 0);
    if (n > 0) counts[rel] = n;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

type Snapshot = { about: string; total: number; files: Record<string, number> };

describe('the status ratchet', () => {
  const now = countLegacySites();
  const total = Object.values(now).reduce((a, b) => a + b, 0);

  if (process.env.STATUS_RATCHET_WRITE === '1') {
    const snapshot: Snapshot = {
      about:
        'Legacy status sites per file (client/src), held two-way by ratchet.test.ts. Control-tower phase 31 ' +
        'reached zero; the empty snapshot makes any site a regression.',
      total,
      files: now,
    };
    writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Snapshot;

  it('is at zero, and the snapshot says so (control-tower phase 31)', () => {
    expect(snapshot.total).toBe(0);
    expect(snapshot.files).toEqual({});
    expect(now, 'a legacy status site is back — draw it through the typed family').toEqual({});
  });

  it('the legacy chip, its tone words and the 2.x aliases no longer exist — a source scan', () => {
    expect(existsSync(join(SRC, 'components/ui/chip.tsx')), 'components/ui/chip.tsx').toBe(false);
    // Comments may tell the history; code may not carry it.
    const RETIRED: readonly [string, RegExp, RegExp][] = [
      ['StateChip', /\.tsx?$/, /\bStateChip\b/],
      ['<Chip>', /\.tsx?$/, /<Chip\b|\bChipTone\b|\bchipVariants\b|\bLEGACY_TONE\b/],
      ['a --line-* token', /\.(?:css|tsx?)$/, /--line-[a-z]/],
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
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? walk(full) : [full];
      });
    for (const file of walk(SRC)) {
      if (/\.test\.tsx?$/.test(file)) continue;
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:\x27"])\/\/.*$/gm, '$1');
      for (const [what, applies, re] of RETIRED) {
        if (applies.test(file) && re.test(code)) found.push(`${relative(SRC, file)}: ${what}`);
      }
    }
    expect(found, 'retired in control-tower phase 31').toEqual([]);
  });

  it('no file gained a legacy status site — new code draws status through the typed family', () => {
    const rose = Object.entries(now)
      .filter(([file, n]) => n > (snapshot.files[file] ?? 0))
      .map(([file, n]) => `${file}: ${snapshot.files[file] ?? 0} → ${n}`);
    expect(rose, 'NEW legacy sites').toEqual([]);
  });

  it('every file that lost one has banked it — the snapshot is the measured truth', () => {
    // A file this tree does not carry was not fixed: the free tree drops the Pro
    // pages, and their banked sites with them. The Pro tree asks about deleted
    // files below.
    const carried = Object.entries(snapshot.files).filter(([file]) => existsSync(join(SRC, file)));
    const fell = carried
      .filter(([file, n]) => (now[file] ?? 0) < n)
      .map(([file, n]) => `${file}: ${n} → ${now[file] ?? 0}`);
    expect(fell, 'FIXED legacy sites — lower status-ratchet.json (STATUS_RATCHET_WRITE=1)').toEqual([]);
    expect(total).toBe(carried.reduce((a, [, n]) => a + n, 0));
  });


  it('the record band — Repo and Insights — holds no legacy status site (control-tower phase 26)', () => {
    // Pro's landscape included: its map, legend and inspector draw the radar,
    // the landings and the runs through the family like every table beside it.
    const band = Object.keys(now).filter((file) => /^features\/(repo|insights)\//.test(file));
    expect(band, 'Repo and Insights draw every status through the typed family').toEqual([]);
    expect(Object.keys(snapshot.files).filter((file) => /^features\/(repo|insights)\//.test(file))).toEqual(
      [],
    );
  });

  it('the typed family and the model it draws are never counted', () => {
    expect(Object.keys(now).filter((f) => f.startsWith('components/ui/status/'))).toEqual([]);
  });

  it('first paint stays gated at 190 KB — the ceiling this phase was held to', () => {
    // `verify:dist` enforces the number; this holds the number itself, so a
    // later phase that needs room has to say so here rather than edit a constant.
    const gate = /const FIRST_PAINT_SERVED = (\d+) \* 1024;/.exec(readFileSync(CHECK_DIST, 'utf8'));
    expect(gate, 'check-dist.mjs states the first-paint gate').not.toBeNull();
    expect(Number(gate![1])).toBeLessThanOrEqual(190);
  });
});
