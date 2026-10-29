/**
 * One handoff, as its own page — the baton, rendered whole (7.0, quiet-console
 * phase 10; ported from `features/plans/handoff-panel.test.tsx`). The handoffs
 * LIST is a reading of the phases grid; this page is the document it opens.
 *
 * 7.0 draws the status as a dot and a word, the graph's edges as links, and
 * an error as the server's words with a way out.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandoffDetail, PlanDetail } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { TooltipProvider } from '@/ui/tooltip';
import { expectNoAxeViolations } from '@/test/axe';
import { HandoffPanel } from './handoff-panel';

const { handoff } = vi.hoisted(() => ({ handoff: vi.fn() }));

vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, api: { ...actual.api, handoff } };
});

const DETAIL = { summary: { slug: 'alpha' } } as unknown as PlanDetail;

const SEVENTH = {
  slug: 'alpha',
  phase: 7,
  file: 'phase-07-the-seventh.md',
  path: 'docs/handoffs/alpha/phase-07-the-seventh.md',
  title: 'The seventh',
  status: 'complete',
  completed: '2026-09-28',
  dependsOn: [5, 6],
  blocks: [8],
  parallelSafe: [],
  skillsUsed: ['superpowers:test-driven-development'],
  body: '## What landed\n\nThe **baton**.',
  keyFiles: ['viewer/client/src/x.tsx'],
  prompts: [{ phase: 2, gated: false, text: 'Boot phase 2.' }],
  bytes: 120,
  mtime: 0,
} as HandoffDetail;

function mount(phase = '7') {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <HandoffPanel detail={DETAIL} phase={phase} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  handoff.mockReset().mockResolvedValue(SEVENTH);
});

describe('the handoff page', () => {
  it('renders the handoff whole, with its status painted and its place in the graph', async () => {
    mount();
    const title = await screen.findByRole('heading', { level: 1 });
    expect(title).toHaveTextContent('Phase 7 The seventh');
    expect(handoff).toHaveBeenCalledWith('alpha', '7');
    expect(document.querySelector('[data-status="complete"]')).toBeTruthy();
    // Where it sits in the graph — each edge a link to the phase it names.
    expect(screen.getByText(/depends on/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'P5' })).toHaveAttribute('href', '#/plan/alpha/phase/5');
    expect(screen.getByRole('link', { name: 'P6' })).toHaveAttribute('href', '#/plan/alpha/phase/6');
    expect(screen.getByText(/blocks/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'P8' })).toHaveAttribute('href', '#/plan/alpha/phase/8');
    // The body is markdown, rendered.
    expect((await screen.findByText('baton')).tagName).toBe('STRONG');
    expect(screen.getByRole('link', { name: 'Open phase 7' })).toHaveAttribute(
      'href',
      '#/plan/alpha/phase/7',
    );
    expect(screen.getByText('viewer/client/src/x.tsx')).toBeInTheDocument();
    expect(screen.getByText('superpowers:test-driven-development')).toBeInTheDocument();
  });

  it('says separate facts as separate words — no middle-dot meta string', async () => {
    mount();
    const title = await screen.findByRole('heading', { level: 1 });
    expect(title.closest('header')!.textContent).not.toContain('·');
    expect(screen.getByText('completed 2026-09-28')).toBeInTheDocument();
  });

  it('shows the server’s words and a way out when the handoff cannot be read', async () => {
    handoff.mockRejectedValueOnce(new Error('No handoff for phase 7 yet.'));
    mount();
    expect(await screen.findByText('No handoff for phase 7 yet.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Read it again' }));
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('The seventh');
    expect(handoff).toHaveBeenCalledTimes(2);
  });

  it('draws a shape, not a page, while the handoff is on its way', () => {
    handoff.mockReturnValue(new Promise(() => {}));
    mount();
    expect(screen.getByLabelText('Reading the handoff')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = mount();
    await screen.findByText('baton');
    await waitFor(() => expect(screen.getByText('viewer/client/src/x.tsx')).toBeInTheDocument());
    await expectNoAxeViolations(container);
  });
});
