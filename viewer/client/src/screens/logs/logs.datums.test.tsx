/**
 * Logs' datum ledger (quiet-console phase 26, exit criterion 3; `docs/design.md`
 * §5: "No datum removed · every datum within 2 interactions"): what the start
 * ceiling (`GET /api/ceiling`) and the stray-console scan (`GET
 * /api/doctor/strays`) answer is drawn on Logs ▸ Health, each fact within two
 * presses of the section's address.
 *
 * Both answer at the glance — no press at all — because a ceiling that is
 * refusing starts and a console running code that is gone are what a person
 * opens Health to find out. Each row is a datum, the question that draws it
 * and the most presses it may cost; a datum that moves deeper, or off the
 * page, fails its row by name. The section is mounted at its own address, as
 * the place mounts it, over the server answering by path.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The server's answers by path (the part before `?`). */
const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown> }));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  const answer = async (path: string) => {
    const read = server.reads[path.split('?')[0]!];
    if (read !== undefined) return read;
    throw new actual.ApiError(`Nothing is fixtured for ${path}`, 404, path);
  };
  return { ...actual, request: (path: string) => answer(path), post: (path: string) => answer(path) };
});

import type { StartCeilingCounters, StrayConsoles } from '@/data/machine';
import { queryClientConfig } from '@/data/keys';
import { MemoryRouterProvider } from '@/shell/router';
import { parseHash, type Route } from '@/shell/routes';
import { TooltipProvider } from '@/ui/tooltip';
import HealthSection from './health-section';
import { logsSectionHref } from './routes';

/** When the full limit frees: its oldest start leaves the hour. */
const UNTIL = '2026-10-12T11:12:00.000Z';

/** The work ceiling full on starts, the probe with room and no dollar limit. */
const CEILING: StartCeilingCounters = {
  work: {
    starts: 40,
    usd: 61.4,
    limits: { startsPerHour: 40, usdPerHour: 250 },
    windowMs: 3_600_000,
    doors: { 'converge-relaunch': 31, 'wait-clock': 9 },
    full: 'startsPerHour',
    until: UNTIL,
  },
  probe: {
    starts: 6,
    usd: 0,
    limits: { startsPerHour: 24, usdPerHour: 0 },
    windowMs: 3_600_000,
    doors: {},
    full: null,
    until: null,
  },
};

const STRAYS: StrayConsoles = {
  at: '2026-10-12T10:00:00.000Z',
  strays: [
    {
      pid: 4711,
      pgid: 4700,
      command: 'node /home/x/old/viewer/server/main.ts --port 4131',
      root: '/home/x/old',
    },
  ],
  stop: 'phase-console doctor --stop-strays',
};

/** A fact, where Health draws it, and the most presses the section may make a person spend on it. */
type Datum = { name: string; question: 'ceiling' | 'strays'; presses: 0 | 1 | 2; find: string };

const LEDGER: Datum[] = [
  // The start ceiling.
  { name: 'which limit is full', question: 'ceiling', presses: 0, find: 'The work ceiling is full' },
  { name: 'the count against it', question: 'ceiling', presses: 0, find: '40 starts against a limit of 40' },
  {
    name: 'until when nothing starts by itself',
    question: 'ceiling',
    presses: 0,
    find: new Date(UNTIL).toLocaleTimeString(),
  },
  { name: 'the window it counts over', question: 'ceiling', presses: 0, find: 'Counted over a sliding 1h' },
  { name: 'the work starts against their limit', question: 'ceiling', presses: 0, find: '40 of 40' },
  { name: 'the work spend against its limit', question: 'ceiling', presses: 0, find: '$61.40 of $250.00' },
  { name: 'the starts by door', question: 'ceiling', presses: 0, find: 'converge-relaunch 31, wait-clock 9' },
  { name: 'the probe’s starts against its budget', question: 'ceiling', presses: 0, find: '6 of 24' },
  { name: 'the probe’s spend, with no limit', question: 'ceiling', presses: 0, find: '$0.00, no limit' },
  // The stray consoles.
  { name: 'how many strays', question: 'strays', presses: 0, find: '1 console process on this machine' },
  { name: 'each stray’s pid and group', question: 'strays', presses: 0, find: 'pid 4711, group 4700' },
  {
    name: 'each stray’s command',
    question: 'strays',
    presses: 0,
    find: 'node /home/x/old/viewer/server/main.ts --port 4131',
  },
  { name: 'each stray’s root', question: 'strays', presses: 0, find: 'root /home/x/old' },
  {
    name: 'the CLI’s line that stops them',
    question: 'strays',
    presses: 0,
    find: 'phase-console doctor --stop-strays',
  },
];

function mount() {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const address = logsSectionHref('health');
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={address}>
        <TooltipProvider>
          <HealthSection route={parseHash(address) as Route} />
        </TooltipProvider>
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

/** A question's region, by the id its section carries. */
const question = (id: Datum['question']) => document.querySelector<HTMLElement>(`[data-health="${id}"]`)!;

beforeEach(() => {
  server.reads = {
    '/api/state': {},
    '/api/accounts': { accounts: [], allowAccounts: false },
    '/api/ceiling': CEILING,
    '/api/doctor/strays': STRAYS,
  };
});

describe('Logs ▸ Health: the ceiling and the strays, every datum within two interactions', () => {
  it('nothing on the ledger costs a press: each is on the section as it opens', async () => {
    mount();
    await screen.findByTestId('ceiling-verdict');
    await screen.findByRole('list', { name: 'Stray consoles' });
    const missing: string[] = [];
    for (const datum of LEDGER.filter((d) => d.presses === 0)) {
      const text = (question(datum.question).textContent ?? '').replace(/\s+/g, ' ');
      if (!text.includes(datum.find)) missing.push(`${datum.name} → “${datum.find}”`);
    }
    expect(missing).toEqual([]);
  });

  it('no stray is still a datum: one quiet line, never an empty space', async () => {
    server.reads['/api/doctor/strays'] = { ...STRAYS, strays: [] };
    mount();
    await waitFor(() =>
      expect(question('strays')).toHaveTextContent(
        'None: every console process on this machine still has its code.',
      ),
    );
  });
});
