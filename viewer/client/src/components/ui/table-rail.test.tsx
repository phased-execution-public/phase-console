/**
 * The pinned rail's arithmetic, and the two guards that stand behind it.
 *
 * `railOffsets` is the primitive's one new piece of arithmetic: pure, exported,
 * and — until this file — reached by nothing. `table.tsx` states the principle
 * itself ("Pure, so it is testable without a layout engine"), which is exactly
 * why `planColumns` has `table-columns.test.ts`. Same reason, same shape.
 *
 * The source scans below ride with it rather than in `styles/touch.test.ts`
 * because they are about the same claim from the other side: the rail is only
 * correct if every table in the tree actually reaches this primitive, and the
 * one thing that can make a `tap-*` floor a lie is the host clipping it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DataTable, railOffsets, trackOf, type Column } from './table';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', '..');

type Row = { id: string; name: string };
const col = (over: Partial<Column<Row>> & { id: string }): Column<Row> => ({
  head: over.id,
  cell: (r) => r.name,
  ...over,
});

describe('railOffsets', () => {
  it('pins only the identity when the identity is the first column', () => {
    const shown = [col({ id: 'a', min: 100, identity: true }), col({ id: 'b', min: 100 })];
    expect([...railOffsets(shown, shown[0], 1000).entries()]).toEqual([['a', 0]]);
  });

  it('pins the whole run up to the identity, each at the tracks in front of it', () => {
    const shown = [
      col({ id: 'pick', min: 40, width: '40px' }),
      col({ id: 'number', min: 92, identity: true }),
      col({ id: 'title', min: 200, flex: true }),
    ];
    const rail = railOffsets(shown, shown[1], 1000);
    expect([...rail.entries()]).toEqual([
      ['pick', 0],
      ['number', 40],
    ]);
    expect(rail.has('title')).toBe(false);
  });

  it('refuses a rail wider than half the box and falls back to the identity at 0', () => {
    const shown = [
      col({ id: 'pick', min: 40, width: '40px' }),
      col({ id: 'number', min: 92, identity: true }),
    ];
    expect([...railOffsets(shown, shown[1], 200).entries()]).toEqual([['number', 0]]);
    expect([...railOffsets(shown, shown[1], 400).entries()]).toEqual([
      ['pick', 0],
      ['number', 40],
    ]);
  });

  it('never refuses when the box is unmeasured', () => {
    const shown = [col({ id: 'pick', width: '40px' }), col({ id: 'number', identity: true })];
    expect(railOffsets(shown, shown[1], 0).size).toBe(2);
  });

  it('pins nothing when the identity is not among the shown columns', () => {
    const shown = [col({ id: 'a' })];
    expect(railOffsets(shown, col({ id: 'ghost', identity: true }), 1000).size).toBe(0);
    expect(railOffsets(shown, undefined, 1000).size).toBe(0);
  });

  it('offsets on the declared track, the same number the cut and the layout use', () => {
    const shown = [
      col({ id: 'a', min: 50, width: '7rem' }), // 112
      col({ id: 'b', align: 'end' }), //           76 (NUMERIC_MIN)
      col({ id: 'c', identity: true }),
    ];
    expect(trackOf(shown[0])).toBe(112);
    expect(trackOf(shown[1])).toBe(76);
    expect([...railOffsets(shown, shown[2], 2000).entries()]).toEqual([
      ['a', 0],
      ['b', 112],
      ['c', 188],
    ]);
  });
});

describe('Column.cellClassName', () => {
  it('lands on the cell and not on the header', () => {
    render(
      <DataTable<Row>
        label="QA"
        rows={[{ id: '1', name: 'one' }]}
        getRowKey={(r) => r.id}
        cards={false}
        columns={[
          col({ id: 'k', identity: true, priority: 1 }),
          col({ id: 'v', priority: 1, cellClassName: 'align-top', cell: () => 'v' }),
        ]}
      />,
    );
    const table = screen.getByRole('table', { name: 'QA' });
    const td = [...table.querySelectorAll('td')].find((c) => c.textContent === 'v');
    expect(td?.className).toContain('align-top');
    for (const th of table.querySelectorAll('th')) expect(th.className).not.toContain('align-top');
  });
});

describe('the "reaches DataTable or says why" guard', () => {
  /**
   * The shipped pattern, after the hole was closed.
   *
   * It was `/<(?:Table\b(?![\w])|table\s)/g`, which required WHITESPACE after
   * the lowercase tag name — so `<table>` and `<table/>`, the two simplest
   * spellings of a render site, were invisible to it while `<Table>` and
   * `<Table/>` were caught. `styles/touch.test.ts` now reads `[\s>/]` on both
   * branches; these three tests are what says so.
   */
  const RENDER_SITE = /<(?:Table|table)[\s>/]/g;

  it('sees a self-closing tag in either case', () => {
    expect('<Table/>'.match(RENDER_SITE)).not.toBeNull();
    // F11: `table\s` did not. This is the byte that used to get through.
    expect('<table/>'.match(RENDER_SITE)).not.toBeNull();
  });

  it('sees a bare tag too — an attribute-less render site does not evade it', () => {
    expect('<table>'.match(RENDER_SITE)).not.toBeNull();
    expect('<table className="x">'.match(RENDER_SITE)).not.toBeNull();
    expect('<Table fixed>'.match(RENDER_SITE)).not.toBeNull();
    // …and still not the wrapper, whose next character is not one of the three.
    expect('<TableWrap scrolls>'.match(RENDER_SITE)).toBeNull();
  });

  it('no bare <table> or <Table/> render site exists in the tree TODAY', () => {
    const offenders: string[] = [];
    for (const path of walk(SRC)) {
      if (!path.endsWith('.tsx')) continue;
      if (path.endsWith('/components/ui/table.tsx')) continue;
      if (/<table>|<table\/>|<Table\/>|<Table>/.test(stripComments(readFileSync(path, 'utf8')))) {
        offenders.push(path.slice(SRC.length + 1));
      }
    }
    expect(offenders, 'the guard would not see these').toEqual([]);
  });
});

describe('exit criterion 2 — every table reaches DataTable or says why', () => {
  it('holds when render sites are counted on comment-stripped source', () => {
    const offenders: string[] = [];
    for (const path of walk(SRC)) {
      if (!path.endsWith('.tsx')) continue;
      const relative = path.slice(SRC.length + 1);
      if (relative === 'components/ui/table.tsx') continue;
      const raw = readFileSync(path, 'utf8');
      const sites = [...stripComments(raw).matchAll(/<(?:Table|table)[\s>/]/g)].length;
      if (sites === 0) continue;
      const reasons = [...raw.matchAll(/hand-rolled because:/g)].length;
      if (reasons < sites) offenders.push(`${relative}: ${sites} site(s), ${reasons} reason(s)`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('exit criterion 4 — tap-area / tap-line hosts', () => {
  /**
   * `tap-area`/`tap-line` put the hit area in an absolutely positioned `::before`
   * whose containing block is the host (both set `position: relative`), so the
   * HOST's own overflow clips it — and `truncate` is `overflow: hidden`. Measured
   * in headless Chromium with the shipped stylesheet: on a `tap-line truncate`
   * host all four corners of the intended 44x44 square miss the control; remove
   * `truncate` and all four hit.
   *
   * The canonical guard is `styles/touch.test.ts`, where every other touch rule
   * lives and where the class-list reader handles all three spellings of
   * `className`. This is the criterion stated where the QA that found it left
   * it — the same rule read a second way.
   */
  it('no tap-area / tap-line host also clips its own overflow', () => {
    const offenders: string[] = [];
    const CLIP = /\b(truncate|overflow-hidden|overflow-x-hidden|overflow-y-hidden|overflow-clip)\b/;
    for (const path of walk(SRC)) {
      if (!/\.tsx?$/.test(path)) continue;
      const text = readFileSync(path, 'utf8');
      for (const [attr] of text.matchAll(/className=(?:"[^"]*"|\{`[^`]*`\}|\{[^}]*\})/g)) {
        if (/\btap-(area|line)\b/.test(attr) && CLIP.test(attr)) {
          offenders.push(`${path.slice(SRC.length + 1)}: ${attr.slice(0, 120)}`);
        }
      }
    }
    expect(offenders, 'overflow:hidden on the host clips the 44px ::before hit area').toEqual([]);
  });
});

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(tsx?)$/.test(name) && !/\.test\./.test(name)) yield path;
  }
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
