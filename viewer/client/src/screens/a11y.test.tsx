/**
 * Axe over the shell at every destination, in both of its shapes (7.0,
 * quiet-console phase 3).
 *
 * The chrome around a page changes with the page: the rail lights another
 * place, the header says another word, a phone's tab bar marks another tab or
 * none. So "the shell passes axe" is seven claims per shape, not one — and each
 * of them is checked here with every badge lit, the account meter drawn and the
 * header's situation line fully arrived, because a count that renders nothing
 * cannot fail a name check. The page itself is a heading: the destinations'
 * own pages are `screens/pages.a11y.test.tsx`'s. The shell's own contracts —
 * spoken names, landmarks, the skip link, the announcer — are
 * `shell/a11y.test.tsx`'s.
 *
 * jsdom lays nothing out, so contrast is not asked here — `styles/contrast.test
 * .ts` computes every (state, surface) pair from the stylesheet instead.
 */

import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESTINATIONS } from '@shared/route-meta.js';
import type { AccountsState, ConsoleState } from '@/data/api';
import type { ShellCounts } from '@/data/console';
import { queryClientConfig } from '@/data/keys';
import { expectNoAxeViolations } from '@/test/axe';
import { ShellLayout } from '@/shell/layout';
import { navItem } from '@/shell/nav';
import { spokenHead } from '@/shell/route-frame';
import { MemoryRouterProvider, useRoute } from '@/shell/router';
import { hrefOf } from '@/shell/routes';

const STATE: ConsoleState = {
  autopilot: true,
  allowRun: true,
  allowWrites: true,
  // Both kinds of process, so Sessions is offered and its badge is drawn.
  allowTerminal: true,
  allowAgent: true,
  staticRoot: 'dist',
  root: { path: '/repo', ok: true, label: 'repo', planCount: 3, handoffCount: 2 },
  instance: { id: 'a1b2c3d4-repo', name: 'repo', pinned: false },
  recentRoots: [{ path: '/other', label: 'other' }],
  unread: 7,
};

// Every badge lit.
const COUNTS: ShellCounts = {
  plans: 3,
  phases: 11,
  ready: 2,
  approvals: 1,
  needsYou: 1,
  asks: 1,
  sessions: 4,
  unread: 7,
  agentSessions: 1,
  terminalSessions: 3,
  mcpAttention: 1,
};

const ACCOUNTS: AccountsState = {
  allowAccounts: false,
  accounts: [
    {
      id: 'default',
      kind: 'default',
      builtIn: true,
      usage: { buckets: { five_hour: { utilization: 42, resetsAt: '2026-10-09T12:00:00.000Z' } } },
    },
  ],
};

/**
 * The wire, by path — enough for every part of the situation line to speak:
 * a run live, a run waiting, two queued, two phases ready, a turn, a spend.
 * Anything not here answers 404, as an older server would.
 */
const WIRE: Record<string, unknown> = {
  '/api/state': STATE,
  '/api/accounts': ACCOUNTS,
  '/api/runs?view=slim': [
    { id: 'r1', slug: 'demo', status: 'running', activePhase: 3, verifying: {} },
    { id: 'r2', slug: 'alpha', status: 'waiting', activePhase: null, verifying: {} },
  ],
  '/api/queue': { entries: [{ id: 'q1' }, { id: 'q2' }] },
  '/api/plans': [{ slug: 'demo', title: 'Demo', kind: 'plan', phases: 6, ready: [5, 6] }],
  '/api/turn': { counts: { total: 3, handled: 1 } },
  '/api/spend': { today: { settledUsd: 12.5 } },
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const body = WIRE[String(input)];
      return new Response(JSON.stringify(body ?? { error: 'not here' }), {
        status: body === undefined ? 404 : 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** The shell as `App.tsx` composes it, around a page that is only its heading. */
function Shell({ phone }: { phone: boolean }) {
  const route = useRoute();
  return (
    <ShellLayout state={STATE} counts={COUNTS} route={route} phone={phone}>
      <h1>{spokenHead(route.segments[0])}</h1>
    </ShellLayout>
  );
}

const mount = (ui: ReactElement, at: string) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          ...queryClientConfig,
          defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
        })
      }
    >
      <MemoryRouterProvider initial={at}>{ui}</MemoryRouterProvider>
    </QueryClientProvider>,
  );

for (const [shape, phone] of [
  ['on a desk — rail, header, one scroller', false],
  ['on a phone — header, one scroller, tab bar', true],
] as const) {
  describe(`the shell has no axe violations ${shape}`, () => {
    for (const id of DESTINATIONS) {
      it(`at ${id}`, async () => {
        const { container } = mount(<Shell phone={phone} />, hrefOf(id));
        const nav = await screen.findByRole('navigation', { name: 'Main' });
        // The situation words are lazy and read five things; the last of them
        // to speak is the spend. Axe walks the header a person actually sees.
        await waitFor(() =>
          expect(screen.getByTestId('situation-line').querySelector('[data-part="spend"]')).not.toBeNull(),
        );
        expect(screen.getByTestId('header-title').textContent).toBe(navItem(id)!.label);
        if (!phone) {
          // On a desk the rail always says where you are.
          const current = within(nav)
            .getAllByRole('button')
            .filter((button) => button.getAttribute('aria-current') === 'page');
          expect(current).toHaveLength(1);
          expect(current[0]).toHaveTextContent(navItem(id)!.label);
        }
        await expectNoAxeViolations(container);
      });
    }
  });
}
