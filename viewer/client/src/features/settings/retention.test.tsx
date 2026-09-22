/**
 * The Logs-and-retention card.
 *
 * The assertions worth having are the ones a size card can plausibly get
 * wrong, and each one is a question an operator actually asks.
 *
 * "What is using my disk" — a sink with no files must not be a row, or ten
 * zeroes hide the three numbers that matter.
 *
 * "Is it about to delete something I want" — the `due` count comes from the
 * planner's own pure output, so the card can say what the next sweep WOULD do.
 * A card that could only report the past is the reason people turn retention
 * off, so this is the property the whole `planRetention`-is-pure design exists
 * to make possible.
 *
 * "Can I change it" — only with `--allow-writes`, because these numbers decide
 * what this console DELETES, and the gate has to be visible rather than a
 * silent no-op on press.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';

const { state, savePrefs, debugRetention } = vi.hoisted(() => ({
  state: vi.fn(),
  savePrefs: vi.fn(),
  debugRetention: vi.fn(),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, savePrefs, debugRetention } };
});

const MB = 1024 * 1024;

const REPORT = {
  at: '2026-09-18T12:00:00.000Z',
  policy: {
    consoleLogMaxBytes: 16 * MB,
    supervisorLogMaxBytes: 32 * MB,
    supervisorLogKeepBytes: 8 * MB,
    runRetainDays: 30,
    runRetainMin: 20,
    runsMaxBytes: 2048 * MB,
    taskInboxDays: 30,
    rulingsOversizedBytes: 16 * MB,
    outcomeInboxDays: 30,
    outcomeInboxMax: 200,
    sessionEventsMaxBytes: MB,
    gitTraceLeftoverHours: 24,
    gitTraceDirMaxBytes: 64 * MB,
    messagesRotateBytes: 8 * MB,
    messagesRetainDays: 90,
  },
  sinks: [
    { sink: 'run-records', files: 42, bytes: 12 * MB, due: 3 },
    { sink: 'rulings', files: 2, bytes: 4096, due: 0 },
    { sink: 'fleet-log', files: 0, bytes: 0, due: 0 },
  ],
  bytes: 12 * MB + 4096,
  actions: [
    { kind: 'delete', sink: 'run-records', path: '/x/run-a.jsonl', bytes: 10, why: 'older than 30 days' },
    { kind: 'delete', sink: 'run-records', path: '/x/run-b.jsonl', bytes: 10, why: 'older than 30 days' },
    { kind: 'delete', sink: 'run-records', path: '/x/run-c.jsonl', bytes: 10, why: 'older than 30 days' },
  ],
};

async function mount(allowWrites: boolean, report: unknown = REPORT) {
  state.mockResolvedValue({ root: { ok: true, path: '/repo' }, allowWrites, prefs: {} });
  debugRetention.mockResolvedValue(report);
  savePrefs.mockResolvedValue({});
  const { RetentionCard } = await import('./retention');
  const client = new QueryClient(queryClientConfig);
  render(
    <QueryClientProvider client={client}>
      <RetentionCard />
    </QueryClientProvider>,
  );
  await screen.findByText(/across 2 sinks/);
}

describe('RetentionCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows each sink’s size and its policy in words, and hides the empty ones', async () => {
    await mount(true);
    expect(screen.getByText('Runs, journals and their sidecars')).toBeTruthy();
    expect(screen.getByText('Ruling ledgers')).toBeTruthy();
    // A policy row about nothing is not a row.
    expect(screen.queryByText('Fleet supervisor log')).toBeNull();
    // The number, in words a person reads, not in bytes.
    expect(screen.getAllByText('12 MB').length).toBeGreaterThan(0);
    expect(screen.getByText(/30 days, at least 20 per plan/)).toBeTruthy();
    expect(screen.getByText(/never pruned — reported past/)).toBeTruthy();
  });

  it('says what the NEXT sweep would do, before it does it', async () => {
    await mount(true);
    expect(screen.getByText(/would act on 3 file\(s\)/)).toBeTruthy();
  });

  it('says so plainly when nothing is due', async () => {
    await mount(true, { ...REPORT, actions: [] });
    expect(screen.getByText(/Nothing is due/)).toBeTruthy();
  });

  it('saves the whole block, with the MB fields converted back to bytes', async () => {
    await mount(true);
    const days = screen.getByLabelText(/Keep runs for/);
    fireEvent.change(days, { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: /Save retention/ }));

    await waitFor(() => expect(savePrefs).toHaveBeenCalledTimes(1));
    const [patch] = savePrefs.mock.calls[0] as [{ retention: Record<string, number> }];
    expect(patch.retention.runRetainDays).toBe(7);
    // Every other row rides along unchanged — a partial block would read as a
    // request to reset the rest to their defaults.
    expect(patch.retention.runsMaxBytes).toBe(2048 * MB);
    expect(patch.retention.messagesRetainDays).toBe(90);
  });

  it('is read-only without --allow-writes, and says why rather than failing on press', async () => {
    await mount(false);
    const days = screen.getByLabelText(/Keep runs for/) as HTMLInputElement;
    expect(days.disabled).toBe(true);
    expect(days.title).toMatch(/--allow-writes/);
    const save = screen.getByRole('button', { name: /Save retention/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.title).toMatch(/--allow-writes/);
  });
});
