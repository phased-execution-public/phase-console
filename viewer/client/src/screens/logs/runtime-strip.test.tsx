/**
 * The console's own runtime strip (control-tower phase 29, #32 gap 4; Logs ▸
 * Health's first question since quiet-console phase 20): the process gauges
 * read off the metrics scrape, shown before anything is asked for.
 *
 * Two properties, and both are about not drawing a zero nobody measured: a
 * gauge the scrape did not emit is "not reported" — a meter with no whole, or a
 * delay of `0 ms`, would be a reading the console never took — and a scrape
 * that failed says so in its own words instead of leaving the strip blank.
 *
 * The scrape is fetched for real here (`readRuntime` → `request`) over a
 * stubbed `fetch`, because the exposition is TEXT and the transport's
 * content-type branch is part of what has to hold; the section's other
 * questions are `health-section.test.tsx`'s.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { queryClientConfig } from '@/data/keys';
import { RuntimeStrip } from './health-section';
import { parseRuntime } from './runtime';

/** The console's answer to `/api/metrics`, as the browser would get it. */
const serve = (text: string, status = 200) =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(text, { status, headers: { 'content-type': 'text/plain' } }));

const SCRAPE = [
  '# HELP phase_console_process_heap_used_bytes V8 heap in use by this console process.',
  '# TYPE phase_console_process_heap_used_bytes gauge',
  'phase_console_process_heap_used_bytes 1610612736',
  'phase_console_process_heap_limit_bytes 6442450944',
  'phase_console_process_event_loop_delay_seconds 0.042',
  'phase_console_process_sse_clients 3',
  'phase_console_process_handles 57',
].join('\n');

afterEach(() => vi.restoreAllMocks());

describe('parseRuntime', () => {
  it('reads the four gauges the strip shows, and nothing it does not', () => {
    expect(parseRuntime(SCRAPE)).toEqual({
      heapUsedBytes: 1610612736,
      heapLimitBytes: 6442450944,
      eventLoopDelaySeconds: 0.042,
      sseClients: 3,
    });
  });

  it('leaves a gauge the scrape did not emit absent — not reported is not zero', () => {
    expect(parseRuntime('phase_console_process_sse_clients 0\n')).toEqual({ sseClients: 0 });
    expect(parseRuntime('')).toEqual({});
  });

  it('reads a labelled sample, and never a longer name that merely starts with a gauge’s', () => {
    expect(parseRuntime('phase_console_process_heap_used_bytes{pid="4130"} 2048\n')).toEqual({
      heapUsedBytes: 2048,
    });
    expect(parseRuntime('phase_console_process_sse_clients_total 9\n')).toEqual({});
  });

  it('drops a value that is not a finite number rather than carrying NaN onto the strip', () => {
    expect(parseRuntime('phase_console_process_event_loop_delay_seconds NaN\n')).toEqual({});
  });
});

describe('RuntimeStrip', () => {
  const show = () =>
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            ...queryClientConfig,
            defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
          })
        }
      >
        <RuntimeStrip />
      </QueryClientProvider>,
    );

  it('draws the heap against its limit in words, the loop delay and the stream clients', async () => {
    serve(SCRAPE);
    show();
    const heap = await screen.findByRole('meter', { name: 'Heap' });
    expect(heap).toHaveAttribute('aria-valuenow', '1610612736');
    expect(heap).toHaveAttribute('aria-valuemax', '6442450944');
    // A screen reader hears the reading, never the raw byte count.
    expect(heap).toHaveAttribute('aria-valuetext', '1.5 GB of 6.0 GB');
    const strip = screen.getByTestId('runtime-strip');
    expect(within(strip).getByText('42 ms')).toBeInTheDocument();
    expect(within(strip).getByText('3')).toBeInTheDocument();
    expect(
      within(strip).getByText(/^As of .*, read every 15 seconds while this section is open\.$/),
    ).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/metrics', expect.anything());
  });

  it('paints a heap near its limit as the failure it is heading for', async () => {
    serve(
      'phase_console_process_heap_used_bytes 5900000000\nphase_console_process_heap_limit_bytes 6442450944\n',
    );
    show();
    const heap = await screen.findByRole('meter', { name: 'Heap' });
    expect(heap).toHaveClass('state-failed');
    expect(heap).not.toHaveClass('state-running');
  });

  it('says a gauge was not reported rather than drawing an empty meter or a zero', async () => {
    serve('phase_console_process_sse_clients 0\n');
    show();
    const strip = await screen.findByTestId('runtime-strip');
    // The heap and the loop delay were not emitted: two "not reported", no meter.
    await within(strip).findAllByText('not reported');
    expect(within(strip).getAllByText('not reported')).toHaveLength(2);
    expect(screen.queryByRole('meter')).toBeNull();
    expect(within(strip).queryByText(/\bms$/)).toBeNull();
    // Zero streams WAS reported, and is an answer.
    expect(within(strip).getByText('0')).toBeInTheDocument();
  });

  it('says the scrape could not be read, in its own words, rather than drawing a blank strip', async () => {
    serve('the metrics renderer threw', 500);
    show();
    const strip = await screen.findByText(/could not be read from/);
    expect(strip).toHaveTextContent(
      'The runtime could not be read from /api/metrics: the metrics renderer threw',
    );
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.queryByText('not reported')).toBeNull();
  });
});
