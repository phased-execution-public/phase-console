/**
 * The one theme control, and the promise that the chrome keeps no other.
 *
 * What this holds: three choices, the current one pressed, a press that writes
 * the preference AND repaints the page, a choice made elsewhere (the palette's
 * verbs) shown here at once — and, as source text, that the shell's chrome
 * keeps no copy of the vocabulary. 7.0 took the control out of the header:
 * theme and density live in Settings ▸ Appearance and in the palette, and the
 * header is where you are, the situation, search and the bell — nothing else.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { getPrefs, setPrefs } from '@/lib/prefs';
import { ThemeSwitch } from './theme-switch';

// Through a helper, never `new URL('<literal>', import.meta.url)` inline: Vite
// rewrites that shape as an asset reference, and the path stops being a file.
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const LABELS = ['Auto', 'Night', 'Paper'] as const;

describe('ThemeSwitch', () => {
  // Prefs are module state shared across this file's cases; every case starts
  // from the shipped default rather than from whatever ran before it.
  beforeEach(() => setPrefs({ theme: 'system' }));
  afterAll(() => setPrefs({ theme: 'system' }));

  it('offers the three choices as one named group, in order', async () => {
    const { container } = render(<ThemeSwitch />);
    const group = screen.getByRole('group', { name: 'Theme' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([...LABELS]);
    await expectNoAxeViolations(container);
  });

  it('says which one is on — Auto, by default', () => {
    render(<ThemeSwitch />);
    expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Night' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Paper' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('writes the choice when another is pressed, and the page repaints', () => {
    render(<ThemeSwitch />);
    const root = document.documentElement;

    fireEvent.click(screen.getByRole('button', { name: 'Paper' }));
    expect(screen.getByRole('button', { name: 'Paper' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'false');
    expect(getPrefs().theme).toBe('light');
    expect(root.getAttribute('data-theme')).toBe('light');

    fireEvent.click(screen.getByRole('button', { name: 'Night' }));
    expect(getPrefs().theme).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');

    // Auto hands the choice back to the operating system: no attribute at all.
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    expect(getPrefs().theme).toBe('system');
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('shows a choice made elsewhere at once — the palette and Settings write the same preference', () => {
    render(<ThemeSwitch />);
    act(() => setPrefs({ theme: 'dark' }));
    expect(screen.getByRole('button', { name: 'Night' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('passes a class to its group, for the surface that places it', () => {
    render(<ThemeSwitch className="ms-auto" />);
    expect(screen.getByRole('group', { name: 'Theme' })).toHaveClass('ms-auto');
  });
});

describe('the chrome keeps no theme control of its own (7.0)', () => {
  it('leaves it out of the header, the rail, the tab bar, the More sheet and the layout', () => {
    // Each of these once carried — or could grow back — a verbatim copy of the
    // three words: a phone dropped the control into a sheet, a desktop kept it
    // in the bar. The header is where you are, the situation, search and the
    // bell; theme and density are Settings ▸ Appearance's and the palette's.
    for (const file of ['header.tsx', 'rail.tsx', 'tab-bar.tsx', 'more-sheet.tsx', 'layout.tsx']) {
      const source = readFileSync(here(`./${file}`), 'utf8');
      expect(source, `${file} must not draw a theme control`).not.toContain('<ThemeSwitch');
      expect(source, `${file} must not keep its own THEMES list`).not.toContain('const THEMES');
      expect(source, `${file} must not write the theme`).not.toMatch(/setPrefs\(\{\s*theme/);
    }
  });

  it('names the themes in exactly one file of the shell — its folders included — and owns none of them', () => {
    const shell = readdirSync(here('.'), { recursive: true, encoding: 'utf8' }).filter(
      (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name),
    );
    expect(shell.length).toBeGreaterThan(20);
    const read = (name: string) => readFileSync(here(`./${name}`), 'utf8');
    // The words a person reads ("Auto", "Night", "Paper") are the control's.
    expect(shell.filter((name) => read(name).includes('const THEME_WORDS'))).toEqual(['theme-switch.tsx']);
    // The members are `shared/prefs-model.js`'s since quiet-console phase 21:
    // the server reads the same list, so no file here writes them out again.
    expect(shell.filter((name) => /const THEMES\b/.test(read(name)))).toEqual([]);
    expect(read('theme-switch.tsx')).toContain("import { THEMES } from '@shared/prefs-model.js'");
  });
});
