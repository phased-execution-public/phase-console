/**
 * The packs' words on the card (measured-console phase 29):
 *
 *   PK-1 a session's closing questions are ONE Decision: every question in its
 *        steps, two options, the recommended one marked and none chosen;
 *   PK-2 a wizard's Task guide draws a step per stage with its commands, and
 *        a secret is said by where it goes — the card offers no field for it
 *        (its one box is the check's note, never a secret's).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { humanStepView } from '@shared/human-step-model.js';
import type { TurnItem } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { MemoryRouterProvider } from '@/shell/router';
import { TurnItemCard } from './parts';

const BASE = {
  record: 'ledger',
  source: 'session',
  rows: [],
  need: 'It is your decision.',
  how: 'Any device.',
  severity: 'needs-you',
  slug: 'alpha',
  phase: 3,
  since: '2026-10-28T01:00:00.000Z',
  href: '/plan/alpha/phase/3',
  actions: [],
  personStatus: 'todo',
  readiness: 'now',
} as const;

const PROSE: TurnItem = {
  ...BASE,
  item: 'prose-1',
  kind: 'decision',
  why: 'decision',
  proofType: 'answer',
  group: 'decide',
  type: 'decide',
  title: 'Answer the 2 questions the session ended on',
  humanStep: humanStepView({
    kind: 'decision',
    title: 'Answer the 2 questions the session ended on',
    state: 'notified',
    stepId: 'prose-1',
  }),
  steps: [
    { text: '1. Should the old export endpoint stay for one release? — the session recommends: keeping it.' },
    { text: '2. Should the migration run now? — the session recommends: yes, behind the flag.' },
    { text: 'Your answer goes back to the same session, which carries on from it.' },
  ],
  step: {
    id: 'prose-1',
    kind: 'decision',
    title: 'Answer the 2 questions the session ended on',
    state: 'notified',
    why: 'decision',
    whySource: 'declared',
    proofType: 'answer',
    attempts: 0,
    waiters: [],
    declaredAt: '2026-10-28T01:00:00.000Z',
    birth: 'console',
    source: { kind: 'prose-question', ref: 'sess-1' },
    options: [
      {
        id: 'recommended',
        label: 'Go with the recommended answers',
        consequence: 'The session carries on with: keeping it; yes, behind the flag',
        recommended: true,
      },
      {
        id: 'my-answers',
        label: 'Answer them myself',
        consequence: 'Write your answers in the note; the session carries on with them.',
      },
    ],
  } as unknown as TurnItem['step'],
} as unknown as TurnItem;

const WIZARD: TurnItem = {
  ...BASE,
  item: 'wizard-1',
  kind: 'operator-act',
  why: 'reserved',
  proofType: 'attest',
  group: 'now',
  type: 'do',
  title: 'Set up the deploy',
  humanStep: humanStepView({
    kind: 'operator-act',
    title: 'Set up the deploy',
    state: 'notified',
    stepId: 'wizard-1',
  }),
  steps: [
    {
      text: 'Run the wizard on your machine — it walks every stage below and shows how many are left.',
      code: 'bash scripts/deploy-wizard.sh',
    },
    {
      text: "Stage 2 of 3 · Vercel: deploy token. Paste the deploy token — a secret: it goes to the repository's GitHub secret VERCEL_TOKEN, which `gh secret set VERCEL_TOKEN` asks for hidden.",
      code: 'open https://vercel.com/account/tokens\ngh secret set VERCEL_TOKEN',
      warn: 'Enter the secret only at a hidden prompt — never in Phase Console, a chat or a note.',
    },
  ],
  step: {
    id: 'wizard-1',
    kind: 'operator-act',
    title: 'Set up the deploy',
    state: 'notified',
    why: 'reserved',
    whySource: 'declared',
    proofType: 'attest',
    attempts: 0,
    waiters: [],
    declaredAt: '2026-10-28T01:00:00.000Z',
    birth: 'plan',
  } as unknown as TurnItem['step'],
} as unknown as TurnItem;

function mount(item: TurnItem) {
  return render(
    <QueryClientProvider client={new QueryClient(queryClientConfig)}>
      <MemoryRouterProvider initial="#/turn">
        <TurnItemCard item={item} perform={vi.fn()} />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

describe('PK-1 a session’s closing questions', () => {
  it('are one Decision: both questions, two options, the recommended one marked and none chosen', () => {
    mount(PROSE);
    const card = screen.getByTestId('turn-item');
    const steps = within(card)
      .getAllByRole('listitem')
      .map((li) => li.textContent ?? '');
    expect(
      steps.some((text) =>
        /Should the old export endpoint stay for one release\? — the session recommends: keeping it/.test(
          text,
        ),
      ),
    ).toBe(true);
    expect(
      steps.some((text) =>
        /Should the migration run now\? — the session recommends: yes, behind the flag/.test(text),
      ),
    ).toBe(true);
    const choices = within(screen.getByTestId('decision-card')).getAllByRole('radio');
    expect(choices).toHaveLength(2);
    expect(choices.every((choice) => !(choice as HTMLInputElement).checked)).toBe(true);
    const marked = card.querySelectorAll('[data-recommended="true"]');
    expect(marked).toHaveLength(1);
    expect(marked[0]!.textContent).toMatch(/Go with the recommended answers/);
  });
});

describe('PK-2 a wizard’s Task guide', () => {
  it('draws a step per stage with its commands, and offers no field for the secret', () => {
    mount(WIZARD);
    const card = screen.getByTestId('turn-item');
    expect(within(card).getByText(/^Stage 2 of 3 · Vercel: deploy token/)).toBeTruthy();
    expect(card.textContent).toMatch(/gh secret set VERCEL_TOKEN/);
    expect(card.textContent).toMatch(/only at a hidden prompt — never in Phase Console/);
    expect(card.querySelectorAll('input[type="password"], input[type="text"]')).toHaveLength(0);
    expect([...card.querySelectorAll('textarea')].map((box) => box.getAttribute('data-testid'))).toEqual([
      'turn-check-note-box',
    ]);
  });
});
