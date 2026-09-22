/**
 * One inbox row, by kind — what the row promises on every surface that draws it
 * (Now, the drawer, `#/approve`'s list and the fleet page), zero-touch phase 19:
 *
 *  - a ruling that can be remembered offers it, and pressing it sends the
 *    server's own endpoint and body;
 *  - a policy answer reads as what it is — the key, the answer, the shipped
 *    default — under its own label;
 *  - a relayed question counts its window down, and says when the console is
 *    answering by rule;
 *  - on a list merged across consoles the console is named and the title links
 *    where the list says, not into this page's hash.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { queryClientConfig } from '@/lib/queries';
import type { InboxAction, InboxItem } from '@/lib/api';
import { InboxRow } from './inbox-row';

const item = (over: Partial<InboxItem>): InboxItem =>
  ({
    id: 'ruling:demo:4::abcdef012345',
    kind: 'ruling',
    severity: 'fyi',
    slug: 'demo',
    phase: 4,
    title: 'demo phase 4 — Ambiguity · qa.exhausted',
    need: 'waive',
    how: 'Why: the round cap was spent.',
    since: new Date(Date.now() - 60_000).toISOString(),
    href: '#/plan/demo/phase/4',
    actions: [],
    ...over,
  }) as InboxItem;

function mount(row: InboxItem, extra: Partial<React.ComponentProps<typeof InboxRow>> = {}) {
  const perform = vi.fn<(item: InboxItem, action: InboxAction, says?: string) => void>();
  render(
    <QueryClientProvider client={new QueryClient(queryClientConfig)}>
      <MemoryRouterProvider initial="#/now">
        <ul>
          <InboxRow item={row} perform={perform} {...extra} />
        </ul>
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
  return perform;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a ruling row', () => {
  it('offers to remember the ruling, and a press carries the server’s endpoint and body', () => {
    const plan: InboxAction = {
      verb: 'remember-plan',
      label: 'Remember for this plan',
      endpoint: '/api/run/demo/rulings/abcdef012345/remember',
      method: 'POST',
      body: { scope: 'plan' },
    };
    const global: InboxAction = {
      ...plan,
      verb: 'remember-global',
      label: 'Remember on this console',
      body: { scope: 'global' },
    };
    const row = item({ actions: [plan, global] });
    const perform = mount(row);

    expect(screen.getByRole('button', { name: /Remember on this console/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Remember for this plan/ }));
    expect(perform).toHaveBeenCalledTimes(1);
    const [pressedItem, pressed] = perform.mock.calls[0]!;
    expect(pressedItem.id).toBe(row.id);
    expect(pressed.endpoint).toBe('/api/run/demo/rulings/abcdef012345/remember');
    expect(pressed.body).toEqual({ scope: 'plan' });
  });
});

describe('a policy-answered row', () => {
  it('reads as the console deciding by itself: its label, its key, and the shipped default behind How', () => {
    mount(
      item({
        id: 'policy:demo:4::qa.exhausted',
        kind: 'policy',
        title: 'demo phase 4 — Policy answered · qa.exhausted',
        need: 'The console answered "waive" by the shipped default — nobody was asked.',
        how: 'Shipped default for `qa.exhausted`: waive. To answer differently, set it under Settings ▸ Automation ▸ Policy answers.',
      }),
    );
    expect(screen.getByText('Policy answered')).toBeTruthy();
    expect(screen.getByText(/Policy answered · qa\.exhausted/)).toBeTruthy();
    expect(screen.getByText(/"waive" by the shipped default/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /How/ }));
    expect(screen.getByText(/Shipped default for/)).toBeTruthy();
  });
});

describe('a question row', () => {
  it('counts its window down, then says the console is answering by rule', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T12:00:00.000Z'));
    mount(
      item({
        id: 'question:demo:4::card-1%3Aq',
        kind: 'question',
        severity: 'urgent',
        title: 'Which branch?',
        expiresAt: '2026-09-15T12:00:30.000Z',
      }),
    );
    expect(screen.getByTestId('inbox-window').textContent).toBe('30 s to answer');
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByTestId('inbox-window').textContent).toBe('25 s to answer');
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByTestId('inbox-window').textContent).toBe('answering by rule');
  });

  it('an ask with no window shows no clock', () => {
    mount(item({ kind: 'approval', severity: 'urgent' }));
    expect(screen.queryByTestId('inbox-window')).toBeNull();
  });
});

describe('a row on a list merged across consoles', () => {
  it('names its console and links where the list says', () => {
    const row = item({
      console: { id: 'a1b2c3d4-alpha', name: 'alpha' },
      href: '/c/a1b2c3d4-alpha/#/plan/demo/phase/4',
    });
    mount(row, { hrefFor: (entry) => entry.href });
    expect(screen.getByText('alpha · demo · phase 4')).toBeTruthy();
    expect(screen.getByRole('link', { name: row.title }).getAttribute('href')).toBe(
      '/c/a1b2c3d4-alpha/#/plan/demo/phase/4',
    );
  });
});

/*
 * The two rows many-plans-one-repo phase 15 draws over the server's own
 * actions (`server/inbox.ts`): a session's message to the operator (phase 10)
 * and an issue draft (phase 12). The shapes below are the server's, verbatim —
 * the row promises to press exactly what it was handed.
 */
describe('a message row — a session asking the operator', () => {
  const answer: InboxAction = {
    verb: 'answer',
    label: 'Answer',
    endpoint: '/api/run/demo/messages/m-1/reply',
    method: 'POST',
    body: { to: 'phase:4', phase: 4 },
    says: { field: 'text', label: 'Your answer', placeholder: 'What the session should know' },
  };
  const seen: InboxAction = {
    verb: 'seen',
    label: 'Mark seen',
    endpoint: '/api/run/demo/messages/m-1/ack',
    method: 'POST',
  };
  const row = () =>
    item({
      id: 'message:demo:m-1',
      kind: 'message',
      severity: 'needs-you',
      title: 'demo phase 4 asks: which base branch?',
      need: 'The plan says nothing and the console default is origin/HEAD.',
      how: 'Answer sends your words to the session; Mark seen closes the row without answering.',
      actions: [answer, seen],
    });

  it('offers a box for the answer and sends the words with the server’s endpoint and body, verbatim', () => {
    const perform = mount(row());
    const box = screen.getByLabelText('Your answer');
    fireEvent.change(box, { target: { value: 'release/5.1 — the plan is about to say so' } });
    fireEvent.click(screen.getByRole('button', { name: /^Answer/ }));
    expect(perform).toHaveBeenCalledTimes(1);
    const [, pressed, said] = perform.mock.calls[0]!;
    expect(pressed.endpoint).toBe('/api/run/demo/messages/m-1/reply');
    expect(pressed.body).toEqual({ to: 'phase:4', phase: 4 });
    expect(said).toBe('release/5.1 — the plan is about to say so');
  });

  it('Mark seen presses its own endpoint and carries no words', () => {
    const perform = mount(row());
    fireEvent.click(screen.getByRole('button', { name: /Mark seen/ }));
    const [, pressed, said] = perform.mock.calls[0]!;
    expect(pressed.endpoint).toBe('/api/run/demo/messages/m-1/ack');
    expect(said).toBeUndefined();
  });

  it('a held Answer — the console without --allow-run — is disabled and says how to fix it', () => {
    mount(item({ ...row(), actions: [{ ...answer, flag: 'run' }, seen] }));
    expect(screen.getByRole('button', { name: /^Answer/ })).toBeDisabled();
    expect(screen.getByText(/Runs are off\. Restart the console with --allow-run\./)).toBeTruthy();
  });
});

describe('an issue-draft row — a session’s draft waiting for a person', () => {
  const endpoint = (verb: string) => `/api/run/demo/issues/d-1/${verb}`;
  const actions = (publish: boolean): InboxAction[] => [
    {
      verb: 'approve',
      label: 'Approve',
      endpoint: endpoint('file'),
      method: 'POST',
      ...(publish ? {} : { flag: 'publish' }),
    },
    { verb: 'discard', label: 'Discard', endpoint: endpoint('discard'), method: 'POST' },
    {
      verb: 'edit-title',
      label: 'Edit title',
      endpoint: endpoint('edit'),
      method: 'POST',
      says: { field: 'title', label: 'New title', placeholder: 'runner: the settle prune races the sweep' },
    },
    {
      verb: 'edit-body',
      label: 'Rewrite body',
      endpoint: endpoint('edit'),
      method: 'POST',
      says: {
        field: 'body',
        label: 'New body',
        placeholder: 'The whole body, as it should be filed — the provenance footer is appended',
      },
    },
  ];
  const row = (publish: boolean) =>
    item({
      id: 'issue-draft:demo:d-1',
      kind: 'issue-draft',
      severity: 'needs-you',
      title: 'file on acme/demo: runner: the settle prune races the sweep',
      need: 'At `viewer/server/runner/worktree.ts`. The prune fired while the sweep held the tree.',
      actions: actions(publish),
    });

  it('Approve, Discard and the two edits each press their own endpoint, verbatim', () => {
    const perform = mount(row(true));
    for (const [name, verb] of [
      [/^Approve/, 'file'],
      [/^Discard/, 'discard'],
      [/^Edit title/, 'edit'],
      [/^Rewrite body/, 'edit'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name }));
      const [, pressed] = perform.mock.calls.at(-1)!;
      expect(pressed.endpoint).toBe(endpoint(verb));
    }
    expect(perform).toHaveBeenCalledTimes(4);
  });

  it('an edit sends the words from the row’s one box', () => {
    const perform = mount(row(true));
    fireEvent.change(screen.getByLabelText('New title'), { target: { value: 'runner: prune vs sweep' } });
    fireEvent.click(screen.getByRole('button', { name: /^Edit title/ }));
    const [, pressed, said] = perform.mock.calls[0]!;
    expect(pressed.verb).toBe('edit-title');
    expect(said).toBe('runner: prune vs sweep');
  });

  it('Approve on a console without --allow-publish is disabled, with the eighth flag’s hint', () => {
    mount(row(false));
    expect(screen.getByRole('button', { name: /^Approve/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Discard/ })).not.toBeDisabled();
    expect(screen.getByText(/Publishing is off\. Restart the console with --allow-publish\./)).toBeTruthy();
  });
});
