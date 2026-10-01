/**
 * The console's own runtime strip (control-tower phase 29, #32 gap 4): the
 * process gauges read off the metrics scrape, shown before anything is asked
 * for, with an unreported gauge said as such rather than drawn as zero.
 */

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RuntimeStrip } from './health-section';
import { parseRuntime } from './runtime';

/** The console's answer to `/api/metrics`, as the browser would get it. */
const serve = (text: string) =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(text, { headers: { 'content-type': 'text/plain' } }));

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
});

describe('RuntimeStrip', () => {
  const show = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RuntimeStrip />
      </QueryClientProvider>,
    );

  it('draws the heap against its limit, the loop delay and the stream clients', async () => {
    serve(SCRAPE);
    show();
    const heap = await screen.findByRole('meter', { name: 'Heap' });
    expect(heap).toHaveAttribute('aria-valuenow', '1610612736');
    expect(heap).toHaveAttribute('aria-valuemax', '6442450944');
    expect(screen.getByText('42 ms')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/As of/)).toBeInTheDocument();
  });

  it('says a gauge was not reported rather than drawing an empty meter', async () => {
    serve('phase_console_process_sse_clients 1\n');
    show();
    expect(await screen.findByText(/Heap: not reported/)).toBeInTheDocument();
    expect(screen.queryByRole('meter')).toBeNull();
  });
});
