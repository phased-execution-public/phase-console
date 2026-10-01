/**
 * ONE card renders why a run stopped (control-tower phase 17).
 *
 * The halt used to be explained four ways — the status strip printed
 * `halt.reason`, Ways forward derived prose around it, the plan's health
 * panel excerpted it, the runs ledger quoted it — each a reasonable local
 * decision, together four accounts of one stop that could disagree about
 * what it was. The card (`components/halt-card.tsx`) is now the only file
 * that reads the runner's own words off a halt; every other surface draws the
 * card, or reads the halt card's sentence and family through
 * `shared/halt-categories.js`.
 *
 * A source walk, coarse on purpose (the run-setup guard's shape): it asks who
 * MENTIONS the field, because a mention is where the drift starts. When it
 * fails, the fix is to render `<HaltCard>` (or its `row` variant), never to
 * widen the allow-list.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..');

/** The one file allowed to read a halt's reason. */
const OWNER = 'components/halt-card.tsx';

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sources(path, out);
      continue;
    }
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
    out.push(path);
  }
  return out;
}

/** Comments out first: a header that names the field is documentation, not a reader. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

/** Any read of a halt's reason: `halt.reason`, `halt?.reason`, `halt!.reason`, or destructured out of a halt. */
const READS = [/\bhalt\s*[?!]?\s*\.\s*reason\b/, /\{[^}]*\breason\b[^}]*\}\s*=\s*[\w.?!]*\bhalt\b/];

describe('the halt card is the one renderer of a halt', () => {
  it('no file but the halt card reads halt.reason', () => {
    const readers = sources(SRC)
      .map((path) => relative(SRC, path).split('\\').join('/'))
      .filter((rel) => rel !== OWNER)
      .filter((rel) => READS.some((re) => re.test(code(readFileSync(join(SRC, rel), 'utf8')))));
    expect(readers, `render <HaltCard> instead — these read a halt's reason themselves`).toEqual([]);
  });

  it('the scan can see: the card itself reads it', () => {
    const card = code(readFileSync(join(SRC, OWNER), 'utf8'));
    // The card reads it through the view; the view is built from the halt.
    expect(card).toMatch(/haltView\(/);
    expect(READS[0]!.test('const r = run.halt?.reason;')).toBe(true);
    expect(READS[0]!.test('record.halt!.reason')).toBe(true);
    expect(READS[1]!.test('const { reason } = run.halt;')).toBe(true);
    expect(READS[0]!.test('// run.halt.reason in a comment'.replace(/^.*$/, (l) => code(l)))).toBe(false);
  });

  it('the four surfaces that explained a stop draw the card', () => {
    const read = (rel: string) => code(readFileSync(join(SRC, rel), 'utf8'));
    expect(read('features/runs/status-strip.tsx')).toMatch(/<HaltCard\b/);
    expect(read('features/plans/health-panel.tsx')).toMatch(/<HaltRow\b/);
    // Ways forward and the errand card take the family and the controls from it.
    expect(read('features/runs/ways-forward.tsx')).toMatch(/from '@\/components\/halt-card'/);
    expect(read('components/errand.tsx')).toMatch(/from '@\/components\/halt-mark'/);
    // The inbox row names the family the SERVER read (first paint loads none of its tables).
    expect(read('components/inbox-row.tsx')).toMatch(/data-halt-category=\{item\.category\.word\}/);
  });
});
