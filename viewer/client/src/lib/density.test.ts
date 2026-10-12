/**
 * Density — the preference `Prefs` declared and nothing read.
 *
 * It shipped in the type and in `DEFAULTS` and was consumed by no component
 * and no stylesheet, so Settings could offer it and it would do nothing: the
 * worst kind of dead preference, because it looks like a feature. Phase 11
 * wired it the same way the theme is wired — one attribute on the root, four
 * tokens in `theme.css`, and every card reading them.
 *
 * jsdom applies no stylesheet, so what is assertable here is the SWITCH (the
 * attribute goes on and comes off) and the CONTRACT (the surfaces read the
 * tokens rather than hard-coded padding). The values themselves are asserted
 * from the stylesheet, where they are declared.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDensity, setPrefs } from './prefs';

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, '..', 'styles', 'theme.css'), 'utf8');
// The kit's three surfaces that carry padding (7.0): the page frame, a card of
// the card list, and a table cell.
const kit = (...path: string[]) => readFileSync(join(HERE, '..', 'ui', ...path), 'utf8');
const page = kit('page.tsx');
const card = kit('grid', 'card-list.tsx');
const table = kit('table.tsx');

afterEach(() => {
  document.documentElement.removeAttribute('data-density');
});

describe('density', () => {
  it('is the absence of the attribute when comfortable, and a value when compact', () => {
    // Comfortable is what shipped, so it must not need a rule that has to win a
    // specificity fight — same shape as `theme: 'system'`.
    applyDensity('compact');
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
    applyDensity('comfortable');
    expect(document.documentElement.hasAttribute('data-density')).toBe(false);
  });

  it('is applied by setPrefs, not only by the boot call', () => {
    setPrefs({ density: 'compact' });
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
    setPrefs({ density: 'comfortable' });
    expect(document.documentElement.hasAttribute('data-density')).toBe(false);
  });

  it('declares all four padding tokens, and overrides all four when compact', () => {
    const TOKENS = ['--pad-x', '--pad-y', '--tile-pad-x', '--tile-pad-y'];
    const compact = css.slice(css.indexOf("[data-density='compact']"));
    const block = compact.slice(0, compact.indexOf('}'));
    for (const token of TOKENS) {
      expect(css, token).toContain(`${token}:`);
      // A token declared once and never overridden is a knob with one setting.
      expect(block, token).toContain(`${token}:`);
    }
  });

  it('has the page, the card and the table cell read the tokens rather than fixed padding', () => {
    // The whole switch is these className strings. A surface that goes back to
    // `px-4 py-3` does not fail to compile, it just stops responding to the
    // preference — silently, on one surface.
    expect(page).toContain('px-(--pad-x) py-(--pad-y)');
    expect(card).toContain('px-(--tile-pad-x) py-(--tile-pad-y)');
    expect(table).toContain("'px-(--tile-pad-x) py-(--tile-pad-y)'");
    for (const file of [page, card, table]) expect(file).not.toMatch(/'px-4 py-3'/);
  });
});
