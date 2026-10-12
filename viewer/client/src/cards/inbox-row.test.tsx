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

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { inboxAct, toast } = vi.hoisted(() => ({ inboxAct: vi.fn(), toast: vi.fn() }));
vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, api: { ...actual.api, inboxAct } };
});
vi.mock('@/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui')>();
  return { ...actual, toast };
});
import { MemoryRouterProvider } from '@/shell/router';
import { queryClientConfig } from '@/data/keys';
import type { InboxAction, InboxItem } from '@/data/api';
import { InboxRow, useInboxActions } from './inbox-row';

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
    // Three words, the console first — never one string glued with dots.
    expect(screen.getByTestId('inbox-where').textContent).toBe('alpha, demo, phase 4');
    expect(screen.getByRole('link', { name: row.title }).getAttribute('href')).toBe(
      '/c/a1b2c3d4-alpha/#/plan/demo/phase/4',
    );
  });
});


/*
 * Every verb a row presses goes through the owner door, `data/press.ts`: a
 * console with an owner key answers a press from another door with 202
 * `{requested}` — a 2xx that did NOTHING yet. Read as done, the row told the
 * operator a recovery had happened when it was waiting on the owner (#277's
 * family). It is said once, here, as asked of the owner.
 */
describe('a press goes through the owner door', () => {
  const recover: InboxAction = {
    verb: 'recover',
    label: 'Recover & continue',
    endpoint: '/api/run/demo/recover',
    method: 'POST',
  };
  const errand = item({
    id: 'errand:demo:4::verify-red',
    kind: 'errand',
    severity: 'needs-you',
    title: 'demo — phase 4 needs you',
    actions: [recover],
  });

  /** The row as the bell draws it: its presses are `useInboxActions`'s. */
  function Pressing({ row }: { row: InboxItem }) {
    const { perform, busy } = useInboxActions();
    return (
      <ul>
        <InboxRow item={row} perform={perform} {...(busy ? { busy } : {})} />
      </ul>
    );
  }

  function mountPressing(row: InboxItem) {
    render(
      <QueryClientProvider client={new QueryClient(queryClientConfig)}>
        <MemoryRouterProvider initial="#/runs">
          <Pressing row={row} />
        </MemoryRouterProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    inboxAct.mockReset();
    toast.mockReset();
  });

  it('a 202 reads "asked of the owner" — once, and never as done', async () => {
    inboxAct.mockResolvedValue({
      requested: true,
      error: 'This press waits for the owner to confirm it.',
      request: {
        id: 'q1',
        at: '',
        state: 'open',
        door: 'device',
        label: 'Recover demo',
        press: 'recover',
        authority: 'run',
        risk: 'low',
        method: 'POST',
        path: '/api/run/demo/recover',
        body: {},
        summary: 'Recover demo',
        item: null,
        repeats: 0,
        ask: 'asked by phone through device — recover demo — confirm?',
      },
    });
    mountPressing(errand);
    fireEvent.click(screen.getByRole('button', { name: 'Recover & continue' }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(inboxAct.mock.calls[0]![0]).toBe(recover);
    expect(toast).toHaveBeenCalledWith('Recover & continue — asked of the owner.', 'info', 8000);
    expect(toast.mock.calls.flat().join(' ')).not.toMatch(/done/);
  });

  it('a done press says the server’s own words, and a stalled outcome warns', async () => {
    inboxAct.mockResolvedValueOnce({ outcome: 'resumed', detail: 'The run continues from phase 4.' });
    mountPressing(errand);
    fireEvent.click(screen.getByRole('button', { name: 'Recover & continue' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('The run continues from phase 4.', 'ok', undefined),
    );

    inboxAct.mockResolvedValueOnce({
      outcome: 'errand',
      detail: 'Nothing was launched: a person is needed.',
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Recover & continue' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Nothing was launched: a person is needed.', 'warn', 8000),
    );
  });

  it('only the owner door reads a request — no card or bell file tells a 202 from a done press itself', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..');
    const readers: string[] = [];
    for (const folder of ['cards', 'shell/bell']) {
      for (const name of readdirSync(join(src, folder))) {
        if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
        const text = readFileSync(join(src, folder, name), 'utf8');
        if (/\brequested\s*===\s*true\b|\.requested\b/.test(text)) readers.push(`${folder}/${name}`);
      }
    }
    expect(readers).toEqual([]);
    // …and the row presses through it.
    expect(readFileSync(join(src, 'cards', 'inbox-row.tsx'), 'utf8')).toMatch(/from '@\/data\/press'/);
  });
});
