/**
 * Every datum of a person's turn is within TWO interactions (control-tower
 * phase 42, criterion 8): who declared it and when, each open, each check and
 * what it read, the proof ref and the window — and a raw view.
 *
 * The card's face is the act, not the record, so the test first asserts the
 * datums are NOT all on the first screen; then one press (Details) shows each,
 * and a second (the raw record) shows the ledger's own words.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ humanSteps: vi.fn() }));
vi.mock('@/lib/api/human-steps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/human-steps')>();
  return { ...actual, humanStepsApi: { ...actual.humanStepsApi, ...api } };
});

import { humanStepView } from '@shared/human-step-model.js';
import { TooltipProvider } from '@/components/ui';
import { queryClientConfig } from '@/lib/queries';
import type { HumanStepRecord, InboxItem } from '@/lib/api';
import { HumanStepCard } from './human-step-card';

const RECORD: HumanStepRecord = {
  id: 's1',
  kind: 'browser-login',
  title: 'Sign the gh CLI in',
  where: 'host',
  birth: 'session',
  slug: 'alpha',
  phase: 3,
  runId: 'r1',
  sessionId: 'sess-7f3a',
  openUrl: 'https://github.com/login/device',
  proof: 'cmd:"gh auth status"',
  state: 'notified',
  declaredAt: '2026-09-30T08:00:00.000Z',
  at: '2026-09-30T08:40:00.000Z',
  opened: 2,
  checks: 1,
  checkedAt: '2026-09-30T08:40:00.000Z',
  read: 'pending — gh: not signed in',
  windowEnd: '2026-10-07T08:00:00.000Z',
  nextReminderAt: '2026-09-30T09:40:00.000Z',
  moves: [
    { state: 'notified', verb: 'notify', at: '2026-09-30T08:00:01.000Z', by: 'console', pushed: true },
    { state: 'opened', verb: 'open', at: '2026-09-30T08:10:00.000Z', by: 'ana', where: 'here' },
    { state: 'opened', verb: 'open', at: '2026-09-30T08:30:00.000Z', by: 'ana', where: 'host' },
    { state: 'checking', verb: 'check', at: '2026-09-30T08:39:59.000Z', by: 'ana' },
    {
      state: 'notified',
      verb: 'check',
      at: '2026-09-30T08:40:00.000Z',
      by: 'ana',
      note: 'pending — gh: not signed in',
    },
  ],
};

function mount() {
  api.humanSteps.mockResolvedValue({
    steps: [RECORD],
    reminders: { series: [900_000], quiet: null },
    can: { openHost: true, terminal: true, resume: true },
  });
  const item: InboxItem = {
    id: 'human-step:alpha:3:s1',
    kind: 'human-step',
    severity: 'needs-you',
    slug: 'alpha',
    phase: 3,
    runId: 'r1',
    title: 'Your turn',
    need: RECORD.title,
    how: '',
    since: RECORD.declaredAt,
    actions: [],
    href: '/plan/alpha/phase/3',
    humanStep: humanStepView({
      kind: RECORD.kind,
      title: RECORD.title,
      where: RECORD.where,
      state: RECORD.state,
      stepId: RECORD.id,
      openUrl: RECORD.openUrl!,
      proof: RECORD.proof!,
      check: true,
    }),
  };
  const client = new QueryClient(queryClientConfig);
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <HumanStepCard item={item} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('every datum of a step is within two interactions', () => {
  it('who declared it, each open, each check and what it read, the proof and the window — then raw', async () => {
    mount();
    // The status line reads the ledger once it arrives.
    await waitFor(() => expect(screen.getByTestId('step-status').textContent).toContain('opened 2×'));
    const text = () => document.body.textContent ?? '';
    // Not all on the first screen — otherwise the count below means nothing.
    expect(text()).not.toContain('sess-7f3a');
    expect(screen.queryAllByTestId('step-move')).toHaveLength(0);

    let presses = 0;
    fireEvent.click(screen.getByTestId('step-details-toggle'));
    presses += 1;
    const datums = await screen.findByTestId('step-datums');
    // Who declared it, and when.
    expect(datums.textContent).toContain('the phase’s session (sess-7f3a)');
    // The proof ref, and the window.
    expect(datums.textContent).toContain('cmd:"gh auth status"');
    expect(datums.textContent).toMatch(/until/);
    // Each open and each check, and what the check read.
    const moves = screen.getAllByTestId('step-move');
    expect(moves.map((m) => m.getAttribute('data-verb'))).toEqual([
      'notify',
      'open',
      'open',
      'check',
      'check',
    ]);
    expect(moves[1]!.textContent).toContain('in a browser');
    expect(moves[2]!.textContent).toContain('on the machine');
    expect(moves[4]!.textContent).toContain('pending — gh: not signed in');

    fireEvent.click(screen.getByTestId('step-raw-toggle'));
    presses += 1;
    const raw = screen.getByTestId('step-raw').textContent ?? '';
    expect(raw).toContain('"id": "s1"');
    expect(raw).toContain('"declaredAt": "2026-09-30T08:00:00.000Z"');
    expect(presses).toBeLessThanOrEqual(2);
  });
});
