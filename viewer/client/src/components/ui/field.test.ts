/**
 * The control class, in its two backgrounds.
 *
 * jsdom computes no styles, so these are source-text promises in the shape
 * `styles/theme.test.ts` established. What they hold: the two looks differ in
 * the background and NOTHING ELSE that matters — same height, same thumb floor,
 * same border, same disabled treatment — because a second control class that
 * drifted was the defect being closed. `styles/touch.test.ts` separately holds
 * that this file is the only place under `src/` where the literal is defined.
 */

import { describe, expect, it } from 'vitest';
import { field, fieldSurface } from './field';

/** The half that is not a background, on both. */
const SHARED = [
  'h-9',
  'min-w-0',
  '[@media(hover:none)]:min-h-(--tap-min)',
  'rounded',
  'border',
  'border-rule',
  'px-2',
  'text-sm',
  'text-ink',
  'disabled:opacity-50',
];

describe('field / fieldSurface', () => {
  it('share every class that is not the background', () => {
    for (const cls of SHARED) {
      expect(field.split(' '), `field is missing ${cls}`).toContain(cls);
      expect(fieldSurface.split(' '), `fieldSurface is missing ${cls}`).toContain(cls);
    }
  });

  it('differ in exactly the background, and the hover the raised one earns', () => {
    expect(field).toContain('bg-ground');
    expect(field).not.toContain('bg-surface');
    expect(fieldSurface).toContain('bg-surface');
    expect(fieldSurface).not.toContain('bg-ground');
    // A control the page ground is already behind has nothing to lift on hover.
    expect(fieldSurface).toContain('hover:border-rule-strong');
    expect(field).not.toContain('hover:border-rule-strong');
  });

  it('carries the thumb floor only where there is no hover', () => {
    // 44px of chrome around every select on a desktop makes a filter strip
    // taller than the rows it filters; a 36px one on a phone is unpressable.
    for (const cls of [field, fieldSurface]) {
      expect(cls).toContain('[@media(hover:none)]:min-h-(--tap-min)');
      expect(cls).not.toMatch(/(^|\s)min-h-\(--tap-min\)/);
    }
  });

  it('never sets its own font size — the 16px touch floor must win', () => {
    // Every historic copy's `text-sm` (13.2px) beat the base input floor, which
    // is how focusing a select zoomed iOS and left it zoomed. The floor now
    // wins globally through an unlayered rule in theme.css; nothing here may
    // reintroduce a size that outranks it in the cascade.
    for (const cls of [field, fieldSurface]) {
      expect(cls).not.toContain('!text-');
      expect(cls).not.toMatch(/text-\[/);
    }
  });
});
