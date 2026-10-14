/**
 * A section's title and its count (#296):
 *
 *   SH-1 the title and the count are two boxes of one flex pair with a gap
 *        between them — never one run of text — so under `dir="rtl"` the
 *        number keeps its distance from an English title ("Do now 5", not
 *        "Do now5");
 *   SH-2 with no count the title is the heading's own text; the aside sits apart.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SectionHeading } from './section-heading';

describe('SH-1 the count is its own box', () => {
  it('a flex pair with a gap, the title and the count its two boxes, in an rtl document too', () => {
    const { container } = render(
      <div dir="rtl">
        <SectionHeading count={5}>Do now</SectionHeading>
      </div>,
    );
    const heading = screen.getByRole('heading', { level: 2 });
    const pair = heading.firstElementChild as HTMLElement;
    expect(pair.className).toMatch(/(^|\s)inline-flex(\s|$)/);
    expect(pair.className).toMatch(/(^|\s)gap-2(\s|$)/);
    const [title, count] = [...pair.children] as HTMLElement[];
    expect(title?.getAttribute('data-slot')).toBe('title');
    expect(title?.textContent).toBe('Do now');
    expect(count?.getAttribute('data-slot')).toBe('count');
    expect(count?.textContent).toBe('5');
    // The gap is between the boxes; no margin on the count can fall outside a bidi run.
    expect(count?.className).not.toMatch(/(^|\s)-?m[sexlr]?-/);
    expect(container.querySelector('[dir="rtl"]')).toBeTruthy();
  });
});

describe('SH-2 no count', () => {
  it('only the title, the aside beside the heading', () => {
    render(
      <SectionHeading as="h3" aside={<button type="button">More</button>}>
        Coming up
      </SectionHeading>,
    );
    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading.querySelector('[data-slot="count"]')).toBeNull();
    expect(heading.textContent).toBe('Coming up');
    expect(heading.contains(screen.getByRole('button', { name: 'More' }))).toBe(false);
  });
});
