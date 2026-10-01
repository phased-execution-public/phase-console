/**
 * This console's own runtime (control-tower phase 29, #32 gap 4): the four
 * `phase_console_process_*` gauges an operator watches for the climb that
 * parked two runs in #20, read off the metrics scrape the console already
 * renders — no second endpoint to keep in step with it.
 *
 * It lives in the Debug feature rather than `lib/api` because only Debug ▸
 * Health reads it: in `lib/api` it would be first-paint bytes for everyone.
 */

import { useQuery } from '@tanstack/react-query';

import { request } from '@/lib/api/client';

export interface RuntimeFacts {
  heapUsedBytes?: number;
  heapLimitBytes?: number;
  eventLoopDelaySeconds?: number;
  sseClients?: number;
}

const RUNTIME_GAUGES: Record<keyof RuntimeFacts, string> = {
  heapUsedBytes: 'phase_console_process_heap_used_bytes',
  heapLimitBytes: 'phase_console_process_heap_limit_bytes',
  eventLoopDelaySeconds: 'phase_console_process_event_loop_delay_seconds',
  sseClients: 'phase_console_process_sse_clients',
};

/**
 * The gauges out of a Prometheus exposition. A gauge the scrape did not emit
 * stays absent — "not reported" and "zero" are different facts, and the
 * handle count's gauge is the precedent for a build that cannot say.
 */
export function parseRuntime(text: string): RuntimeFacts {
  const out: RuntimeFacts = {};
  for (const [field, name] of Object.entries(RUNTIME_GAUGES) as [keyof RuntimeFacts, string][]) {
    const match = new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+(\\S+)`, 'm').exec(text);
    const value = match ? Number(match[1]) : NaN;
    if (Number.isFinite(value)) out[field] = value;
  }
  return out;
}

/**
 * The runtime every 15 s while something shows it. A scrape, not a history:
 * the strip says "as of" and keeps no series of its own.
 */
export function useRuntime(enabled = true, refetchMs = 15_000) {
  return useQuery({
    queryKey: ['debug', 'runtime'] as const,
    queryFn: async () => parseRuntime(await request<string>('/api/metrics')),
    enabled,
    refetchInterval: refetchMs,
    staleTime: 10_000,
  });
}
