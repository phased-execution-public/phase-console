/**
 * The QA report sheet (7.0, quiet-console phase 10; ported from
 * `features/plans/qa-report-sheet.test.tsx`) — the report rendered rather than
 * pathed, by (phase, round), with a picker over the ledger, and an honest line
 * when nothing is on file.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/data/keys';
import { QaReportSheet } from './qa-report';

const { qaReport } = vi.hoisted(() => ({ qaReport: vi.fn() }));

vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, api: { ...actual.api, qaReport } };
});

function mount(node: ReactElement) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/** Answers like the route: the round asked for, or the latest (2) when none was. */
const byRound = async (_slug: string, _phase: number, round?: number) => ({
  path: `reports/phase-03-qa-round${round ?? 2}.md`,
  round: round ?? 2,
  text: `# Round ${round ?? 2}\n\nfindings ${round === 1 ? 'one' : 'two'}`,
});

beforeEach(() => {
  qaReport.mockReset();
});

describe('the QA report sheet', () => {
  it('renders the round the address names, and moves between rounds on the ledger', async () => {
    qaReport.mockImplementation(byRound);
    mount(<QaReportSheet slug="alpha" phase={3} round={2} rounds={2} onClose={() => {}} />);
    expect(await screen.findByText('findings two')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Round 2' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Round 1' }));
    expect(await screen.findByText('findings one')).toBeInTheDocument();
    expect(qaReport).toHaveBeenLastCalledWith('alpha', 3, 1);
    expect(screen.getByRole('button', { name: 'Round 1' })).toHaveAttribute('aria-pressed', 'true');
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

  it('asks for the latest round when the address names none, and marks the round it answered', async () => {
    qaReport.mockImplementation(byRound);
    mount(<QaReportSheet slug="alpha" phase={3} rounds={2} onClose={() => {}} />);
    expect(await screen.findByText('findings two')).toBeInTheDocument();
    expect(qaReport).toHaveBeenCalledWith('alpha', 3, undefined);
    expect(screen.getByRole('button', { name: 'Round 2' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('is titled by its phase and described by the report’s path, a machine value', async () => {
    qaReport.mockImplementation(byRound);
    mount(<QaReportSheet slug="alpha" phase={3} round={2} rounds={2} onClose={() => {}} />);
    const sheet = await screen.findByRole('dialog', { name: 'QA report for phase 3' });
    await screen.findByText('findings two');
    const path = screen.getByText('reports/phase-03-qa-round2.md');
    expect(path.tagName).toBe('CODE');
    expect(sheet).toHaveAccessibleDescription('reports/phase-03-qa-round2.md');
  });

  it('says it is reading while the report is on its way', async () => {
    qaReport.mockReturnValue(new Promise(() => {}));
    mount(<QaReportSheet slug="alpha" phase={3} onClose={() => {}} />);
    expect(await screen.findByRole('status')).toHaveTextContent('Reading the report');
  });
});
