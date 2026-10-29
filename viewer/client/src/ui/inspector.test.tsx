/**
 * The inspector's frame (quiet-console phase 3; headless since Tower strips,
 * 2026-10-20):
 *
 *   IN-1 inline, it names its record: the heading, the line under it and the
 *        identity row over the tabs;
 *   IN-2 headless, the record draws its own head (a Your turn card): the frame
 *        draws no heading, no line and no identity row, so one record wears
 *        one title and one status — and the title still names the region.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '@/test/axe';
import { Inspector } from './inspector';

function frame(headless: boolean) {
  return render(
    <Inspector
      host="inline"
      title="Sign the gh CLI in"
      description="A sign-in — alpha, phase 3."
      meta={<span data-testid="meta-row">Waiting on you</span>}
      overview={<p>The record’s own card</p>}
      raw="{}"
      headless={headless}
    />,
  );
}

describe('IN-1 the frame names its record', () => {
  it('draws the heading, the line under it and the identity row', () => {
    frame(false);
    expect(screen.getByRole('heading', { name: 'Sign the gh CLI in' })).toBeTruthy();
    expect(screen.getByText('A sign-in — alpha, phase 3.')).toBeTruthy();
    expect(screen.getByTestId('meta-row')).toBeTruthy();
  });
});

describe('IN-2 headless', () => {
  it('draws no heading, no line and no identity row — and the title still names the region', async () => {
    const { container } = frame(true);
    expect(screen.queryByRole('heading', { name: 'Sign the gh CLI in' })).toBeNull();
    expect(screen.queryByText('A sign-in — alpha, phase 3.')).toBeNull();
    expect(screen.queryByTestId('meta-row')).toBeNull();
    expect(screen.getByRole('region', { name: 'Sign the gh CLI in' })).toBeTruthy();
    expect(screen.getByText('The record’s own card')).toBeTruthy();
    await expectNoAxeViolations(container);
  });
});
