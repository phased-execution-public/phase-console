/**
 * Amber buttons are rationed by a list, not by taste (tokens 6.0, control-tower
 * phase 16).
 *
 * `variant="action"` used to be the amber button, and 33 places used it — Save,
 * Launch, Send, Open phase — so amber meant "a button" and a summons looked like
 * a form. Since 6.0 `action` is the ink-solid primary and `variant="attention"`
 * keeps the amber look for the one thing on a screen that answers a person
 * being summoned. It appears only in the files below, each with the reason a
 * person, and only a person, is the way forward there.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buttonVariants } from './button';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SRC = here('../../');

/** Where a button may be amber. Every entry names the summons it answers. */
const ALLOW: Readonly<Record<string, string>> = {
  'features/runs/approvals.tsx':
    'the permission card — a session is parked until a person allows or denies it',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** A button asked for in amber: the JSX prop, or the variant in a props object. */
const ATTENTION = /\bvariant=(?:"attention"|\{\s*'attention'\s*\})|\bvariant:\s*'attention'/;

describe('the attention button', () => {
  it('is amber through the accent token, and the action button is ink-solid', () => {
    const attention = buttonVariants({ variant: 'attention' });
    expect(attention).toMatch(/\bborder-accent\//);
    expect(attention).toMatch(/\btext-accent\b/);
    expect(attention).not.toMatch(/action|needs-you/);
    const action = buttonVariants({ variant: 'action' });
    expect(action).toMatch(/\bbg-action\b/);
    expect(action).toMatch(/\btext-ground\b/);
    expect(action).not.toMatch(/accent|needs-you/);
  });

  it('appears only where a person is being summoned', () => {
    const uses = sourceFiles(SRC)
      .filter((file) => ATTENTION.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).split('\\').join('/'))
      .sort();
    expect(uses).toEqual(Object.keys(ALLOW).sort());
    for (const [file, why] of Object.entries(ALLOW)) expect(why.length, file).toBeGreaterThan(20);
  });
});
