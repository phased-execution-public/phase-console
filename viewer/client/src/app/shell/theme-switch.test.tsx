/**
 * The one theme control, and the promise that there is only one.
 *
 * What this holds: three choices, the current one pressed, a press that writes
 * the preference — and, as source text, that neither of the two chrome surfaces
 * that render it has kept a copy of the THEMES list. Two copies of a three-word
 * vocabulary is two chances for a fourth theme to appear in one of them.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { getPrefs, setPrefs } from '@/lib/prefs';
import { ThemeSwitch } from './theme-switch';

const here = dirname(fileURLToPath(import.meta.url));

describe('ThemeSwitch', () => {
  // Prefs are module state shared across this file's cases; every case starts
  // from the shipped default rather than from whatever ran before it.
  beforeEach(() => setPrefs({ theme: 'system' }));

  it('offers the three choices as one named group', async () => {
    const { container } = render(<ThemeSwitch />);
    const group = screen.getByRole('group', { name: 'Theme' });
    for (const label of ['Auto', 'Night', 'Paper']) {
      expect(within(group).getByRole('button', { name: label })).toBeTruthy();
    }
    await expectNoAxeViolations(container);
  });

  it('says which one is on, and writes the choice when another is pressed', () => {
    render(<ThemeSwitch />);
    fireEvent.click(screen.getByRole('button', { name: 'Paper' }));
    expect(screen.getByRole('button', { name: 'Paper' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Night' })).toHaveAttribute('aria-pressed', 'false');
    expect(getPrefs().theme).toBe('light');
  });

  it('is the only place the theme vocabulary is written', () => {
    // The header and the More sheet each carried a verbatim copy — same list,
    // same labels, same ButtonGroup — because a phone drops the control into a
    // sheet and a desktop keeps it in the bar.
    for (const file of ['header.tsx', 'more-sheet.tsx']) {
      const source = readFileSync(join(here, file), 'utf8');
      expect(source, `${file} must render the shared control`).toContain('<ThemeSwitch');
      expect(source, `${file} must not keep its own THEMES list`).not.toContain('const THEMES');
    }
  });
});
