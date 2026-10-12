/**
 * A session's vitals (7.0, quiet-console phase 15): the plan and phase it
 * serves, how long it has been at it, and the phase's own estimate — the kit's
 * KeyValue rows, the plan read through `data/plans.ts` from a stubbed server.
 *
 * What is pinned is attribution honesty. The linkage comes only from the
 * session's own meta (recovery and QA sessions name a `(slug, phase)`), and a
 * recovery that names no phase gets none invented. A plain shell shows a
 * clock and claims nothing: it reads neither a plan nor a run's ledger. The
 * estimate is the plan's own per-phase ETA, named as work so the two clocks
 * are never read as one, and past it the row says "over" rather than counting
 * to a zero that is not coming.
 *
 * 6.2 drew `alpha · P3` in a badge and the estimate as `/ ~10:00 est of
 * work`; 7.0 says them as rows — "Serves alpha P3", "Estimate ~10:00 of work".
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalSession } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { runHref } from '@/shell/routes';
import { SessionVitals, sessionLinkage } from './vitals';

const session = (over: Partial<TerminalSession> = {}): TerminalSession => ({
  id: 't1',
  label: 'a session',
  kind: 'claude',
  cwd: '/repo',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  pid: 4242,
  clients: 1,
  createdAt: Date.now() - 2 * 60_000,
  ...over,
});

const RECOVERY = { meta: { recovery: { kind: 'halted-verification', slug: 'alpha', phase: 3 } } };

/** The plan's per-phase estimate for phase 3, as `GET /api/plans/alpha` carries it. */
const planWithEstimate = (estMs: number, label: string) => ({
  eta: { plan: null, perPhase: [{ phase: 3, weight: 1, estMs, basis: 'plan', label }] },
});

let sent: string[] = [];
let plan: unknown = {};

const answerFor = (url: string): [number, unknown] => {
  if (/^\/api\/plans\/alpha(\?|$)/.test(url)) return [200, plan];
  // The run's ledger, which a linked session also reads: nothing started or ended yet.
  if (/^\/api\/run\/alpha\/ledger/.test(url)) {
    return [200, { runId: null, starts: [], sessions: [], rungs: [], totals: {} }];
  }
  return [404, { error: 'not here' }];
};

beforeEach(() => {
  sent = [];
  plan = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const path = String(input);
      sent.push(path);
      const [status, body] = answerFor(path);
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function mount(node: ReactElement) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/** The value drawn beside a KeyValue label, or null when the row is not drawn. */
const valueOf = (label: string): string | null =>
  screen.queryByText(label)?.parentElement?.querySelector('dd')?.textContent ?? null;

describe('sessionLinkage', () => {
  it('reads the recovery meta, then the QA meta, and otherwise claims nothing', () => {
    expect(sessionLinkage(session(RECOVERY))).toEqual({ slug: 'alpha', phase: 3 });
    expect(sessionLinkage(session({ meta: { qa: { slug: 'beta', phase: 5 } } }))).toEqual({
      slug: 'beta',
      phase: 5,
    });
    // A recovery minted against a plan alone names the plan alone — no phase is invented.
    expect(sessionLinkage(session({ meta: { recovery: { kind: 'plan-repair', slug: 'alpha' } } }))).toEqual({
      slug: 'alpha',
    });
    expect(sessionLinkage(session())).toEqual({});
  });
});

describe('SessionVitals', () => {
  it("shows the plan and phase it serves, its clock, and the phase's own estimate of work", async () => {
    plan = planWithEstimate(10 * 60_000, '~10m (estimate)');
    mount(<SessionVitals session={session(RECOVERY)} />);

    const serves = screen.getByRole('link', { name: 'alpha P3' });
    expect(serves).toHaveAttribute('href', runHref('alpha'));
    expect(valueOf('Running for')).toBe('2:00');
    const estimate = await screen.findByText('~10:00 of work');
    expect(valueOf('Estimate')).toBe('~10:00 of work');
    // The basis rides in the title: whose estimate this is, in its own words.
    expect(estimate).toHaveAttribute('title', "This phase's own estimate — ~10m (estimate).");
    expect(sent.some((path) => /^\/api\/plans\/alpha(\?|$)/.test(path))).toBe(true);
  });

  it('a plain shell gets its clock and no invented attribution', () => {
    mount(<SessionVitals session={session({ kind: 'shell', meta: undefined })} />);
    expect(valueOf('Running for')).toBe('2:00');
    expect(valueOf('Serves')).toBeNull();
    expect(valueOf('Estimate')).toBeNull();
    expect(screen.queryByText(/P\d/)).toBeNull();
    // Nothing to attribute, so nothing is read: no plan, and no run's ledger.
    expect(sent).toEqual([]);
  });

  it('says "over" past the estimate instead of counting to a fictitious zero', async () => {
    plan = planWithEstimate(60_000, '~1m (estimate)');
    mount(<SessionVitals session={session(RECOVERY)} />);
    expect(await screen.findByText('over the ~1:00 estimate of work')).toBeInTheDocument();
    expect(screen.queryByText(/^~1:00 of work$/)).toBeNull();
  });
});
