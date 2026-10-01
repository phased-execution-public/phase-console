/**
 * The QA report sheet — the report rendered rather than pathed, by (phase,
 * round), with a picker over the ledger. It was the QA tab's; the tab folded
 * into the phase table (control-tower phase 23) and the sheet kept its
 * `?report=` address, so every link to a report still opens one.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { QaReportSheet } from './qa-report-sheet';

const { qaReport } = vi.hoisted(() => ({ qaReport: vi.fn() }));
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, qaReport } };
});

function mount(node: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('the QA report sheet', () => {
  it('renders the round the address names, and moves between rounds on the ledger', async () => {
    qaReport.mockImplementation(async (_slug: string, _phase: number, round?: number) => ({
      path: `reports/phase-03-qa-round${round ?? 2}.md`,
      round: round ?? 2,
      text: `# Round ${round ?? 2}\n\nfindings ${round === 1 ? 'one' : 'two'}`,
    }));
    mount(<QaReportSheet slug="alpha" phase={3} round={2} rounds={2} onClose={() => {}} />);
    expect(await screen.findByText('findings two')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'round 2' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'round 1' }));
    expect(await screen.findByText('findings one')).toBeInTheDocument();
    expect(qaReport).toHaveBeenLastCalledWith('alpha', 3, 1);
  });

  it('says so when no report is on file, rather than showing a blank sheet', async () => {
    qaReport.mockRejectedValue(new Error('404'));
    const onClose = vi.fn();
    mount(<QaReportSheet slug="alpha" phase={4} onClose={onClose} />);
    expect(await screen.findByText('No report is on file for this round.')).toBeInTheDocument();
    // One round or none: there is nothing to pick between.
    expect(screen.queryByRole('group', { name: 'Round' })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
