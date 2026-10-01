/**
 * The L1 rung's contract: a fold that names what it hides and how much,
 * carries its own way back, and unmounts what it folds (a fold is not a
 * cache). The controlled form only reports intent — the same split every
 * Radix surface here keeps.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Disclosure } from './disclosure';

// Through a helper, never `new URL('<literal>', import.meta.url)` inline — Vite
// rewrites that shape as an asset reference and the path stops being a file.
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const THEME = readFileSync(here('../../styles/theme.css'), 'utf8');

describe('Disclosure', () => {
  it('starts folded: content unmounted, the count drawn, the fold named', () => {
    render(
      <Disclosure label="All options" count={12}>
        <p>the twelve</p>
      </Disclosure>,
    );
    const button = screen.getByRole('button', { name: /All options/ });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('(12)')).toBeInTheDocument();
    expect(screen.queryByText('the twelve')).not.toBeInTheDocument();
  });

  it('opens in place: content mounts, the way back is named, the count retires', () => {
    render(
      <Disclosure label="All options" openLabel="Fewer options" count={12}>
        <p>the twelve</p>
      </Disclosure>,
    );
    fireEvent.click(screen.getByRole('button'));
    const button = screen.getByRole('button', { name: /Fewer options/ });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    // The region the button claims to control is the one that appeared.
    expect(screen.getByText('the twelve').parentElement).toHaveAttribute(
      'id',
      button.getAttribute('aria-controls'),
    );
    // The count informed the decision to open; open, it is noise.
    expect(screen.queryByText('(12)')).not.toBeInTheDocument();
  });

  it('folds back on the second press', () => {
    render(
      <Disclosure>
        <p>detail</p>
      </Disclosure>,
    );
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText('detail')).not.toBeInTheDocument();
  });

  it('defaultOpen renders open, uncontrolled', () => {
    render(
      <Disclosure defaultOpen>
        <p>detail</p>
      </Disclosure>,
    );
    expect(screen.getByText('detail')).toBeInTheDocument();
  });

  it('controlled: the button reports intent and moves nothing by itself', () => {
    const onOpenChange = vi.fn();
    render(
      <Disclosure open={false} onOpenChange={onOpenChange}>
        <p>detail</p>
      </Disclosure>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    // Still folded: the parent owns the state it declared.
    expect(screen.queryByText('detail')).not.toBeInTheDocument();
  });

  it('keeps the thumb floor on touch', () => {
    render(
      <Disclosure>
        <p>detail</p>
      </Disclosure>,
    );
    expect(screen.getByRole('button').className).toContain('min-h-(--tap-min)');
  });

  it('opens through the expand transition: a grid row grown from 0fr, on the duration token', () => {
    // docs/design.md §5: motion answers actions, and the expand is a CSS
    // `grid-rows 0fr→1fr` transition — no library, no measured height.
    render(<Disclosure label="Show everything">detail</Disclosure>);
    fireEvent.click(screen.getByRole('button'));
    const region = screen.getByText('detail');
    expect(region.parentElement?.className).toBe('expand-region');
    const rule = THEME.match(/\.expand-region\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/grid-template-rows:\s*1fr/);
    expect(rule).toMatch(
      /transition:\s*grid-template-rows var\(--transition-duration-medium\) var\(--ease-transit\)/,
    );
    // The first frame: a region that MOUNTS on open still grows from nothing.
    expect(THEME).toMatch(/@starting-style\s*\{\s*\.expand-region\s*\{\s*grid-template-rows:\s*0fr;/);
  });
});
