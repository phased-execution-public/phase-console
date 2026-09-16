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
  const perform = vi.fn<(item: InboxItem, action: InboxAction) => void>();
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
