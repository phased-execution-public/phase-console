/**
 * Logs ▸ Delivery (7.0, quiet-console phase 20) — the delivery cases of 6.2's
 * Debug page suite, ported from its tiles to the tally sentence, the outcome
 * words and the kit grid.
 *
 * The ledger keeps four words honest, and each case below is one of them:
 *
 *  - **Sent is not seen.** The push service accepted it — the browser and the
 *    operating system are two more yeses this console never hears.
 *  - **Quiet is held**, neither delivered nor failed: the device was inside its
 *    quiet hours and nothing was attempted, on purpose — and a quiet row is
 *    never described as a service that stayed silent.
 *  - **The server's tally wins.** "Reached nobody" is not the failed count, and
 *    the counts are over the whole retained ledger, where the rows are a page.
 *  - **A cut window says it was cut**, with the way to the rest.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The server's answers by path (the part before `?`); every request is logged whole. */
const server = vi.hoisted(() => ({
  reads: {} as Record<string, unknown>,
  calls: [] as string[],
}));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  const answer = async (path: string) => {
    server.calls.push(path);
    const read = server.reads[path.split('?')[0]!];
    if (read instanceof Error) throw read;
    if (typeof read === 'function') return (read as (path: string) => unknown)(path);
    if (read !== undefined) return read;
    throw new actual.ApiError(`Nothing is fixtured for ${path}`, 404, path);
  };
  return { ...actual, request: (path: string) => answer(path), post: (path: string) => answer(path) };
});

import type { DebugEntry, DebugIndex } from '@/data/api';
import { ApiError } from '@/data/http';
import { queryClientConfig } from '@/data/keys';
import { setPrefs } from '@/lib/prefs';
import { MemoryRouterProvider } from '@/shell/router';
import { parseHash, type Route } from '@/shell/routes';
import { TooltipProvider } from '@/ui/tooltip';
import DeliverySection, { OUTCOMES } from './delivery-section';
import { logsSectionHref } from './routes';

vi.setConfig({ testTimeout: 20_000 });

/* ---------------- the server's answers ---------------- */

/** One device's row for one announcement, as `server/push` writes it. */
function entry(outcome: string, data: Record<string, unknown> = {}, text = `Phone: ${outcome}`): DebugEntry {
  return {
    source: 'delivery',
    at: '2026-09-01T10:00:00.000Z',
    level: 'info',
    event: `delivery.${outcome}`,
    text,
    data: { outcome, label: 'Phone', category: 'phase', notification: 'n1', ...data },
  };
}

function index(over: Partial<DebugIndex> = {}): DebugIndex {
  return {
    entries: [entry('sent', {}, 'Phase 3 done')],
    sources: [{ source: 'delivery', available: true, count: 1 }],
    truncated: false,
    slugs: [],
    ...over,
  };
}

/* ---------------- the page ---------------- */

function mount() {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const address = logsSectionHref('delivery');
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={address}>
        <TooltipProvider>
          <DeliverySection route={parseHash(address) as Route} />
        </TooltipProvider>
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

/** The per-outcome counts as drawn: each outcome's word and its figure, in order. */
const counted = () =>
  [...screen.getByTestId('delivery-counts').children].map((one) => [
    one.querySelector('[data-status]')?.getAttribute('data-status'),
    one.lastElementChild?.textContent,
  ]);

/** The ledger's rows, under its header. */
const ledgerRows = () =>
  within(screen.getByRole('table', { name: 'Delivery ledger' }))
    .getAllByRole('row')
    .slice(1);

/** Open each row's own record, in order: the toggle on its identity cell. */
async function openRows(): Promise<HTMLElement[]> {
  const toggles = await screen.findAllByRole('button', { name: /^Show the rest of this row/ });
  for (const toggle of toggles) fireEvent.click(toggle);
  return toggles.map((toggle) => document.getElementById(toggle.getAttribute('aria-controls')!)!);
}

beforeEach(() => {
  localStorage.clear();
  setPrefs({ tables: {}, everything: {} });
  server.calls = [];
  server.reads = { '/api/debug/index': index() };
});

/* ------------------------------------------------------------------ *
 * What the words mean
 * ------------------------------------------------------------------ */

describe('the delivery ledger tells the truth about "sent"', () => {
  it('reads only the delivery source, the newest 500 rows', async () => {
    mount();
    await screen.findByTestId('delivery');
    expect(server.calls).toEqual(['/api/debug/index?source=delivery&limit=500']);
  });

  it('says sent means the service accepted it, not that anybody saw it — and counts quiet as held', async () => {
    mount();
    await screen.findByTestId('delivery');
    // Folded, the fold counts what it holds — and holds it unmounted.
    const fold = screen.getByRole('button', { name: /What each outcome means/ });
    expect(fold).toHaveTextContent(`(${OUTCOMES.length})`);
    expect(screen.queryByText(/not “you saw it”/)).toBeNull();

    fireEvent.click(fold);
    const region = document.getElementById(fold.getAttribute('aria-controls')!)!;
    const meanings = Object.fromEntries(
      [...region.querySelectorAll('dt')].map((dt) => [
        dt.querySelector('[data-status]')?.getAttribute('data-status'),
        dt.nextElementSibling?.textContent ?? '',
      ]),
    );
    expect(Object.keys(meanings)).toEqual([
      'sent',
      'quiet',
      'throttled',
      'failed',
      'gone',
      'skipped',
      'no-device',
    ]);
    expect(meanings.sent).toContain('The push service accepted it — not “you saw it”.');
    expect(meanings.sent).toContain('Counts as delivered.');
    // The word is load-bearing: folding quiet into either column would
    // misreport a device doing exactly what its operator configured.
    expect(meanings.quiet).toContain('nothing was attempted, on purpose.');
    expect(meanings.quiet).toContain('Counts as held.');
    for (const id of ['throttled', 'failed', 'gone', 'skipped', 'no-device'])
      expect(meanings[id]).toContain('Counts as not delivered.');
  });
});

/* ------------------------------------------------------------------ *
 * The server's tally
 * ------------------------------------------------------------------ */

describe('the delivery ledger renders the server’s answer', () => {
  it('shows the server’s reached-no-device count rather than re-deriving one', async () => {
    // `undelivered` is not the `failed` count: a fan-out where one device took
    // it is delivered, and one every device held as quiet was never attempted.
    server.reads['/api/debug/index'] = index({
      entries: [],
      delivery: { outcomes: { sent: 4, failed: 1 }, undelivered: 2, announcements: 5, devices: 3 },
    });
    mount();
    expect(await screen.findByTestId('delivery-tally')).toHaveTextContent(
      '5 announcements; 2 reached no device.',
    );
  });

  it('says none went undelivered when the server counts none', async () => {
    server.reads['/api/debug/index'] = index({
      delivery: { outcomes: { sent: 1 }, undelivered: 0, announcements: 1, devices: 1 },
    });
    mount();
    expect(await screen.findByTestId('delivery-tally')).toHaveTextContent(
      '1 announcement; none went undelivered.',
    );
  });

  it('never counts the no-device placeholder as a device reached', async () => {
    // The tally's `devices` is every device the ledger NAMES, and a fan-out to
    // nobody is written as one row for a placeholder device. The 6.2 sentence
    // read it as reached: "7 announcements reached 1 device; 7 reached nobody".
    server.reads['/api/debug/index'] = index({
      delivery: { outcomes: { 'no-device': 7 }, undelivered: 7, announcements: 7, devices: 1 },
    });
    mount();
    const tally = await screen.findByTestId('delivery-tally');
    expect(tally).toHaveTextContent('7 announcements; none reached a device.');
    expect(tally).not.toHaveTextContent(/\d+ devices?\b/);
  });

  it('draws no sentence over a ledger with no announcement in it', async () => {
    server.reads['/api/debug/index'] = index({
      entries: [],
      delivery: { outcomes: {}, undelivered: 0, announcements: 0, devices: 0 },
    });
    mount();
    await screen.findByTestId('delivery');
    expect(screen.queryByTestId('delivery-tally')).toBeNull();
  });

  it('prefers the server’s per-outcome counts over the page it fetched', async () => {
    // The page holds two failures and a send; the server counted the whole
    // retained ledger, and its answer is the one drawn — whole, never mixed.
    server.reads['/api/debug/index'] = index({
      entries: [entry('failed'), entry('failed'), entry('sent')],
      delivery: { outcomes: { sent: 41 }, undelivered: 0, announcements: 41, devices: 1 },
    });
    mount();
    await screen.findByTestId('delivery-counts');
    expect(counted()).toEqual([['sent', '41']]);
  });

  it('counts the rows it read only when the server sent no tally, and then draws no tally sentence', async () => {
    server.reads['/api/debug/index'] = index({ entries: [entry('failed'), entry('quiet'), entry('failed')] });
    mount();
    await screen.findByTestId('delivery-counts');
    expect(counted()).toEqual([
      ['quiet', '1'],
      ['failed', '2'],
    ]);
    expect(screen.queryByTestId('delivery-tally')).toBeNull();
  });

  it('draws every outcome under Everything, a zero included, in the delivery vocabulary', async () => {
    server.reads['/api/debug/index'] = index({
      delivery: { outcomes: { sent: 3 }, undelivered: 0, announcements: 3, devices: 1 },
    });
    mount();
    await screen.findByTestId('delivery-counts');
    expect(counted()).toEqual([['sent', '3']]);

    fireEvent.click(screen.getByRole('switch', { name: 'Everything' }));
    await waitFor(() => expect(counted()).toHaveLength(OUTCOMES.length));
    expect(counted()).toEqual([
      ['sent', '3'],
      ['quiet', '0'],
      ['throttled', '0'],
      ['failed', '0'],
      ['gone', '0'],
      ['skipped', '0'],
      ['no-device', '0'],
    ]);
    const words = [...screen.getByTestId('delivery-counts').querySelectorAll('[data-status]')];
    expect(words.every((word) => word.getAttribute('data-vocab') === 'delivery')).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * A cut window
 * ------------------------------------------------------------------ */

describe('what could not be read is never absorbed', () => {
  it('says when its window was cut, and links the explorer for the rest', async () => {
    server.reads['/api/debug/index'] = index({ truncated: true });
    mount();
    const banner = await screen.findByTestId('delivery-truncated');
    expect(banner).toHaveTextContent(
      'More delivery rows matched than were read, so the counts are over the newest 1 of them.',
    );
    expect(within(banner).getByRole('link', { name: 'Open them in the explorer' })).toHaveAttribute(
      'href',
      '#/logs?source=delivery',
    );
  });

  it('and says nothing when it was not', async () => {
    mount();
    await screen.findByTestId('delivery');
    expect(screen.queryByTestId('delivery-truncated')).toBeNull();
  });

  it('says the ledger could not be read, in its own words, with a way to ask again', async () => {
    let asks = 0;
    server.reads['/api/debug/index'] = () => {
      asks += 1;
      if (asks === 1) throw new ApiError('the delivery log is unreadable', 500, '/api/debug/index');
      return index();
    };
    mount();
    const failed = await screen.findByText(
      'The delivery ledger could not be read: the delivery log is unreadable',
    );
    expect(failed.closest('[data-severity]')).toHaveAttribute('data-severity', 'error');
    expect(screen.queryByTestId('delivery-counts')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('delivery')).toBeInTheDocument();
    expect(asks).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * The rows
 * ------------------------------------------------------------------ */

describe('the ledger’s rows', () => {
  it('draws each row: the announcement, its outcome as a word, the device, the category and when', async () => {
    server.reads['/api/debug/index'] = index({
      entries: [
        entry('sent', {}, 'Phase 3 done'),
        entry('bounced', { label: undefined, category: undefined }, 'Phase 4 done'),
      ],
    });
    mount();
    const table = await screen.findByRole('table', { name: 'Delivery ledger' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Announcement', 'Outcome', 'Device', 'Category', 'When']);
    const [sent, bounced] = ledgerRows().map((row) => within(row).getAllByRole('cell'));
    expect(sent![0]).toHaveTextContent('Phase 3 done');
    const word = sent![1]!.querySelector('[data-status]');
    expect(word).toHaveAttribute('data-vocab', 'delivery');
    expect(word).toHaveAttribute('data-status', 'sent');
    expect(word).toHaveTextContent('Sent');
    expect(sent![2]).toHaveTextContent('Phone');
    expect(sent![3]).toHaveTextContent('phase');
    expect(sent![4]!.querySelector('time')).not.toBeNull();
    // A word the vocabulary lacks is drawn as itself — never dropped, never painted as a known one.
    expect(bounced![1]).toHaveTextContent('bounced');
    expect(bounced![1]!.querySelector('[data-status]')).toBeNull();
    expect(bounced![2]).toHaveTextContent('none named');
    expect(bounced![3]).toHaveTextContent('none');
  });

  it('names each row by its announcement’s title — the prefix the server wrote is taken off only when it matches', async () => {
    // `<device>: <outcome> — <detail> · <title>` is the explorer's one line;
    // the ledger has columns for the first three and the fold for the detail.
    server.reads['/api/debug/index'] = index({
      entries: [
        entry(
          'no-device',
          { label: 'no device', device: 'no-device', detail: 'no device is subscribed to this console' },
          'no device: no-device — no device is subscribed to this console · Still your turn: grant a permission — tower phase 7',
        ),
        entry('quiet', {}, 'Phone: quiet · Phase 3 done · again'),
        // Written some other way: shown whole, never cut in the wrong place.
        entry('failed', {}, 'Phone: failed, oddly · Phase 4 done'),
      ],
    });
    mount();
    await screen.findByRole('table', { name: 'Delivery ledger' });
    // The identity cell also holds the row's fold toggle, named in words.
    const title = (row: HTMLElement) =>
      within(row).getAllByRole('cell')[0]!.textContent!.replace('Show the rest of this row', '');
    expect(ledgerRows().map(title)).toEqual([
      'Still your turn: grant a permission — tower phase 7',
      'Phase 3 done · again',
      'Phone: failed, oddly · Phase 4 done',
    ]);
  });

  it('a quiet row is not described as a service that stayed silent', async () => {
    server.reads['/api/debug/index'] = index({
      entries: [entry('quiet', { notification: 'n1' }, 'Phone: quiet · Phase 3 done')],
    });
    mount();
    const [record] = await openRows();
    // The ROW's sentence, not the meanings' fold: both say "quiet hours".
    expect(
      within(record!).getByText(/^Nothing was attempted: the device was inside its quiet hours\.$/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/The service gave no reason/)).toBeNull();
  });

  it('a send says what accepted means, a refusal gives the refusal, and a bare failure says it gave no reason', async () => {
    server.reads['/api/debug/index'] = index({
      entries: [
        entry('sent', { notification: 'n-sent', urgent: true }, 'Sent row'),
        entry('failed', { detail: 'HTTP 413: payload too large', notification: 'n-413' }, 'Refused row'),
        entry('failed', { notification: undefined }, 'Bare row'),
      ],
    });
    mount();
    const [sent, refused, bare] = await openRows();
    expect(sent).toHaveTextContent(
      'Accepted by the push service. Whether the browser and the OS showed it are two more yeses this console never sees.',
    );
    expect(sent).toHaveTextContent('n-sent, urgent');
    expect(sent).not.toHaveTextContent('gave no reason');
    expect(refused).toHaveTextContent('HTTP 413: payload too large');
    expect(refused).toHaveTextContent('n-413');
    expect(bare).toHaveTextContent('The service gave no reason.');
    expect(bare).toHaveTextContent('no notification id');
  });

  it('says when a row will appear, inside the ledger’s frame, when nothing has been delivered', async () => {
    server.reads['/api/debug/index'] = index({ entries: [] });
    mount();
    const table = await screen.findByRole('table', { name: 'Delivery ledger' });
    expect(table).toHaveTextContent(
      'Nothing has been delivered to a device yet: a row appears per device per announcement once a browser subscribes to push.',
    );
    expect(screen.queryByTestId('delivery-counts')).toBeNull();
  });
});
