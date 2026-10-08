/**
 * Every datum, within two interactions (control-tower phase 137, #214, exit
 * criterion 3).
 *
 * A ledger record holding everything a record can — the reason, a guide with
 * a command, an expected result, a warning, a link and a fix, the proof in
 * words, the effort, the window, what it unblocks, two attempts with their
 * verdicts and evidence, a question, an answer, who raised it — is drawn on
 * its card, and each datum is found:
 *
 *   ID-1 on the card as it opens: the why, every step with its command,
 *        expected result, warning and link (its full address), the fix, how it
 *        is checked, the effort, the countdown, what it unblocks, the verdict
 *        with the attempt and what to redo, the AI's note;
 *   ID-2 one press in (the history): who raised it and when, every attempt
 *        side by side with its verdict and evidence, every move, the
 *        question and the answer;
 *   ID-3 one more (the raw record): the record itself.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { humanStepView } from '@shared/human-step-model.js';
import { MemoryRouterProvider } from '@/app/router';
import { CHECK_LABEL } from '@/components/human-step-words';
import { queryClientConfig } from '@/lib/queries';
import type { HumanStepRecord, InboxAction, TurnItem } from '@/lib/api';
import { ItemCard } from './item-card';

const NOW = Date.parse('2026-10-07T12:00:00.000Z');

const at = (verb: string): string => `/api/human-steps/s1/${verb}`;
const ACTIONS: InboxAction[] = [
  { verb: 'check', label: CHECK_LABEL, endpoint: at('check'), method: 'POST' },
  { verb: 'snooze', label: 'Snooze an hour', endpoint: at('snooze'), method: 'POST' },
  { verb: 'cannot', label: "I can't do this", endpoint: at('cannot'), method: 'POST' },
];

const RECORD: HumanStepRecord = {
  id: 's1',
  kind: 'secret-entry',
  title: 'Put the npm token in the keychain',
  where: 'host',
  birth: 'session',
  slug: 'alpha',
  phase: 4,
  runId: '9c66853e1db3',
  sessionId: 'sess-77',
  state: 'returned',
  declaredAt: '2026-10-07T09:15:00.000Z',
  at: '2026-10-07T11:40:00.000Z',
  opened: 2,
  proof: 'cmd:"security find-generic-password -s phase-console-npm-token"',
  windowEnd: '2026-10-07T15:00:00.000Z',
  secretWhere: 'the keychain item `phase-console-npm-token`',
  why: 'secret',
  whySource: 'declared',
  proofType: 'probe',
  proofWords: 'The keychain answers with the item.',
  effortMin: 5,
  unblocks: [{ slug: 'alpha', phase: 5 }],
  waiters: [{ slug: 'beta', phase: 2, runId: 'run-b' }],
  source: { kind: 'phase-outcome', ref: 'needs-human' },
  tried: 'It read the keychain and found no item by that name.',
  guide: {
    version: 1,
    lang: 'en',
    dir: 'ltr',
    summary: 'The publish step needs the registry token, which only you hold.',
    steps: [
      {
        text: 'Create a token on the registry',
        link: { label: 'The registry’s token page', url: 'https://www.npmjs.com/settings/tokens/new' },
        warn: 'Choose an automation token, not a publish one.',
      },
      {
        text: 'Store it in the keychain',
        code: 'security add-generic-password -s phase-console-npm-token -a npm -w',
        expect: 'The command asks for the password and prints nothing.',
      },
    ],
    trouble: [{ symptom: 'The command says the item exists', fix: 'Delete the old one first.' }],
  },
  attempts: 2,
  verdict: {
    state: 'rejected',
    note: 'The keychain has no item by that name.',
    redo: ['Store it under the service name phase-console-npm-token'],
    read: ['security: item not found'],
    at: '2026-10-07T11:40:00.000Z',
    by: 'probe',
    attempt: 2,
  },
  verdicts: [
    {
      state: 'rejected',
      note: 'Nothing was stored yet.',
      redo: ['Run the second step'],
      read: ['security: item not found'],
      at: '2026-10-07T10:30:00.000Z',
      by: 'probe',
      attempt: 1,
    },
    {
      state: 'rejected',
      note: 'The keychain has no item by that name.',
      redo: ['Store it under the service name phase-console-npm-token'],
      read: ['security: item not found'],
      at: '2026-10-07T11:40:00.000Z',
      by: 'probe',
      attempt: 2,
    },
  ],
  evidence: [
    {
      attempt: 1,
      kind: 'image',
      ref: 'sha256:aa',
      bytes: 2048,
      mime: 'image/png',
      name: 'keychain-before.png',
      at: '2026-10-07T10:29:00.000Z',
    },
    {
      attempt: 2,
      kind: 'note',
      ref: 'sha256:bb',
      bytes: 40,
      mime: 'text/plain',
      name: 'what-i-typed.txt',
      at: '2026-10-07T11:39:00.000Z',
    },
  ],
  question: [{ at: '2026-10-07T10:00:00.000Z', text: 'Which account should own the token?' }],
  answer: { option: 'personal', label: 'My personal account', at: '2026-10-07T10:05:00.000Z', by: 'owner' },
  moves: [
    { state: 'notified', verb: 'notify', at: '2026-10-07T09:16:00.000Z', pushed: true },
    { state: 'opened', verb: 'open', at: '2026-10-07T10:20:00.000Z', where: 'here' },
    { state: 'returned', verb: 'check', at: '2026-10-07T11:40:00.000Z', note: 'item not found' },
  ],
};

const ITEM: TurnItem = {
  item: 's1',
  record: 'ledger',
  source: 'declared',
  kind: 'secret-entry',
  why: 'secret',
  proofType: 'probe',
  group: 'now',
  rows: ['human-step:alpha:4:s1'],
  title: RECORD.title,
  need: 'The phase publishes.',
  how: 'Store the token, then check.',
  severity: 'needs-you',
  slug: 'alpha',
  phase: 4,
  runId: '9c66853e1db3',
  since: RECORD.declaredAt,
  href: '/plan/alpha/phase/4',
  actions: ACTIONS,
  humanStep: humanStepView({ kind: 'secret-entry', title: RECORD.title, state: 'returned', stepId: 's1' }),
};

function mount() {
  const client = new QueryClient(queryClientConfig);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/turn/s1">
        <ItemCard item={ITEM} record={RECORD} perform={vi.fn()} focused />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
  return screen.getByTestId('turn-item');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('ID-1 on the card as it opens', () => {
  it('draws the why, every step with its command, expectation, warning and link, and the fix', () => {
    const card = mount();
    expect(within(card).getByTestId('turn-why').textContent).toContain('only you hold the secret it needs');
    expect(within(card).getByTestId('guide-why').textContent).toContain('needs the registry token');
    const steps = within(card).getAllByTestId('guide-step');
    expect(steps).toHaveLength(2);
    expect(steps[0]!.textContent).toContain('Create a token on the registry');
    expect(within(steps[0]!).getByTestId('guide-warning').textContent).toContain('automation token');
    expect(within(steps[0]!).getByTestId('guide-link-address').textContent).toBe(
      'https://www.npmjs.com/settings/tokens/new',
    );
    expect(within(steps[1]!).getByTestId('guide-command').textContent).toContain(
      'security add-generic-password',
    );
    expect(within(steps[1]!).getByTestId('guide-expect').textContent).toContain('prints nothing');
    expect(within(card).getByTestId('guide-trouble').textContent).toContain('Delete the old one first.');
  });

  it('says how it is checked, the effort, the countdown and what it unblocks', () => {
    const card = mount();
    const check = within(card).getByTestId('turn-check-words').textContent ?? '';
    expect(check).toContain('security find-generic-password');
    expect(check).toContain('The keychain answers with the item.');
    expect(within(card).getByTestId('turn-effort').textContent).toContain('About 5 min');
    expect(within(card).getByTestId('turn-due').textContent).toContain('in 3 h');
    const unblocks = within(card).getByTestId('turn-unblocks');
    expect(within(unblocks).getByRole('link', { name: 'phase 5' })).toBeTruthy();
    expect(within(unblocks).getByRole('link', { name: 'beta phase 2' })).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'alpha' }).getAttribute('href')).toContain('alpha');
    expect(within(card).getByRole('link', { name: 'Phase 4' })).toBeTruthy();
    expect(within(card).getByRole('link', { name: '9c66853e' })).toBeTruthy();
  });

  it('draws the verdict — the attempt and exactly what to redo — and what the AI tried first', () => {
    const card = mount();
    const verdict = within(card).getByTestId('turn-verdict');
    expect(verdict.textContent).toContain('Back to you — attempt 2: The keychain has no item by that name.');
    expect(within(verdict).getByTestId('turn-redo').textContent).toContain(
      'Store it under the service name phase-console-npm-token',
    );
    expect(within(card).getByTestId('turn-ai-note').textContent).toContain('found no item by that name');
    // The one primary — the redo is checked once done — and never a field for the value.
    expect(within(card).getByTestId('turn-primary').textContent).toBe(CHECK_LABEL);
    expect(within(card).getByTestId('step-secret-where')).toBeTruthy();
    expect(within(card).queryByRole('textbox')).toBeNull();
  });
});

describe('ID-2 one press in — the history', () => {
  it('names who raised it and when, every attempt side by side with its evidence, every move, the question and the answer', () => {
    const card = mount();
    expect(within(card).queryByTestId('turn-history')).toBeNull();
    fireEvent.click(within(card).getByTestId('turn-history-toggle'));
    const history = within(card).getByTestId('turn-history');
    expect(within(history).getByTestId('turn-raised-by').textContent).toContain('sess-77');
    const attempts = within(history).getAllByTestId('turn-attempt');
    expect(attempts.map((a) => a.getAttribute('data-attempt'))).toEqual(['1', '2']);
    expect(attempts[0]!.textContent).toContain('Nothing was stored yet.');
    expect(attempts[0]!.textContent).toContain('keychain-before.png');
    expect(attempts[1]!.textContent).toContain('what-i-typed.txt');
    expect(within(history).getAllByTestId('step-move')).toHaveLength(3);
    expect(within(history).getByTestId('turn-questions').textContent).toContain(
      'Which account should own the token?',
    );
    expect(within(history).getByTestId('turn-answer').textContent).toContain('My personal account');
    expect(history.textContent).toContain('phase-outcome');
  });
});

describe('ID-3 one more — the raw record', () => {
  it('shows the record itself', () => {
    const card = mount();
    fireEvent.click(within(card).getByTestId('turn-history-toggle'));
    fireEvent.click(within(card).getByTestId('turn-raw-toggle'));
    const raw = within(card).getByTestId('turn-raw').textContent ?? '';
    expect(JSON.parse(raw)).toMatchObject({ id: 's1', attempts: 2, effortMin: 5 });
  });
});
