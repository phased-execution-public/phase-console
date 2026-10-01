/**
 * Every datum a session row carries is reached within two interactions, with a
 * raw view, and every state on the list is the typed family's (control-tower
 * phase 24; `docs/design.md` §1).
 *
 * The list folds four shapes of session into one row — a lane the console
 * drives, a pty it owns, a `claude` it can only see — and the row is the
 * glance: its word (the phase's, the pty's `terminal` word, the registry's
 * presence), its name, the summons and its kind, the note, the clock. The
 * inspector is one press (L2) and its raw record two (L3). A row that fails
 * names the datum, not an index.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { ForeignSession, TerminalSession } from '@/lib/api';
import type { NowLane } from '@/features/runs/lanes-model';
import { queryClientConfig } from '@/lib/queries';
import { SessionList, sessionRows } from './list';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, sessionHooks: vi.fn(async () => ({ events: [] })) } };
});

const NOW = Date.now();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const LANE = {
  key: 'run-1#3',
  slug: 'alpha',
  planTitle: 'Alpha',
  runId: 'run-1',
  phase: 3,
  title: 'Server B',
  status: 'running',
  runStatus: 'running',
  startedAt: at(12),
  costUsd: 1.25,
  attempts: 1,
  frozen: false,
  enriched: false,
} as unknown as NowLane;

const PTY: TerminalSession = {
  id: 'pty-9',
  label: 'a shell',
  cwd: '/repo',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  pid: 4242,
  clients: 1,
  createdAt: NOW - 30 * 60_000,
  exited: { code: 1 },
  exitedAt: NOW - 60_000,
} as unknown as TerminalSession;

const FOREIGN: ForeignSession = {
  kind: 'foreign',
  sessionId: 'f-77',
  cwd: '/elsewhere',
  startedAt: at(40),
  lastSeen: at(1),
  turns: 3,
  presence: 'live',
  waiting: { since: at(2), kind: 'permission', note: 'Claude needs your permission' },
} as unknown as ForeignSession;

function page() {
  const rows = sessionRows({ lanes: [LANE], terminals: [PTY], foreign: [FOREIGN], now: NOW });
  const client = new QueryClient(queryClientConfig);
  render(
    <QueryClientProvider client={client}>
      <SessionList rows={rows} />
    </QueryClientProvider>,
  );
  return rows;
}

describe('the sessions list: every datum within two interactions (control-tower phase 24)', () => {
  it('the glance: each row’s word is the typed family’s, with its icon — never a bare dot', () => {
    page();
    const words = [...document.querySelectorAll('[data-status][data-vocab]')].map(
      (badge) => `${badge.getAttribute('data-vocab')}:${badge.getAttribute('data-status')}`,
    );
    expect(words).toEqual(expect.arrayContaining(['phase:running', 'terminal:failed', 'presence:live']));
    for (const badge of document.querySelectorAll('[data-status][data-vocab]')) {
      expect(badge.querySelector('svg')).not.toBeNull();
    }
    // The summons is the attention mark beside the word, and its kind is named.
    expect(document.querySelector('[data-attention="needs-you"]')).not.toBeNull();
    expect(screen.getByText('needs permission')).toBeTruthy();
    // Names, on the glance.
    const missing = ['Alpha · P3', 'a shell'].filter((name) => !document.body.textContent?.includes(name));
    expect(missing).toEqual([]);
  });

  it('one press opens the inspector for a row, two its raw record — the row as the machine holds it', () => {
    const rows = page();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect a shell' }));
    const sheet = screen.getByRole('dialog');
    // L2: the inspector carries the word again, and what it is.
    expect(within(sheet).getByText('Exited with an error')).toBeTruthy();
    expect(within(sheet).getByText('What it is')).toBeTruthy();
    // L3: the raw record, one more press.
    fireEvent.click(within(sheet).getByRole('button', { name: /Raw record/ }));
    const raw = within(sheet).getByText(/"pid": 4242/);
    const record = rows.find((row) => row.kind === 'shell')!.record;
    expect(JSON.parse(raw.textContent ?? '')).toEqual(JSON.parse(JSON.stringify(record)));
  });
});
