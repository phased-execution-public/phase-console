/**
 * The L2 surface's contract: the record's name always visible, the identity
 * row first, the body padded by the DENSITY tokens (compact reaches
 * inspectors), and the raw record one rung down behind a Disclosure — present
 * but folded, which is the whole disclosure ladder in one surface.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Inspector, InspectorSection } from './inspector';

const open = (props: Partial<Parameters<typeof Inspector>[0]> = {}) =>
  render(
    <Inspector open onOpenChange={() => {}} title="Run 496dfaea" {...props}>
      <InspectorSection heading="Timing">
        <p>booted 09:14</p>
      </InspectorSection>
    </Inspector>,
  );

describe('Inspector', () => {
  it('names its record, visibly', async () => {
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Run 496dfaea' });
    // `showTitle` — the name is drawn, not only announced.
    expect(screen.getByText('Run 496dfaea')).toBeVisible();
    expect(dialog).toBeInTheDocument();
  });

  it('pads the body with the density tokens, so compact reaches inspectors', async () => {
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Run 496dfaea' });
    const body = dialog.lastElementChild as HTMLElement;
    expect(body.className).toContain('px-(--pad-x)');
    expect(body.className).toContain('py-(--pad-y)');
  });

  it('renders the identity row before the sections', async () => {
    open({ meta: <span>m-badge</span> });
    const dialog = await screen.findByRole('dialog', { name: 'Run 496dfaea' });
    const body = dialog.lastElementChild as HTMLElement;
    const meta = screen.getByText('m-badge').parentElement as HTMLElement;
    expect(body.firstElementChild).toBe(meta);
  });

  it('keeps the raw record one rung down: present, folded, named', async () => {
    open({ raw: <pre>{'{"id":"496dfaea"}'}</pre> });
    await screen.findByRole('dialog', { name: 'Run 496dfaea' });
    expect(screen.queryByText('{"id":"496dfaea"}')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Raw record/ }));
    expect(screen.getByText('{"id":"496dfaea"}')).toBeInTheDocument();
  });

  it('has no raw affordance when there is no raw record — never an empty door', async () => {
    open();
    await screen.findByRole('dialog', { name: 'Run 496dfaea' });
    expect(screen.queryByRole('button', { name: /Raw record/ })).not.toBeInTheDocument();
  });
});

describe('InspectorSection', () => {
  it('signposts with the band eyebrow at a heading level, not a size', () => {
    render(<InspectorSection heading="Timing">rows</InspectorSection>);
    const eyebrow = screen.getByRole('heading', { level: 3, name: 'Timing' });
    expect(eyebrow.className).toContain('uppercase');
  });
});
