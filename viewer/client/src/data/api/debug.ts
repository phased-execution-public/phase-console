/**
 * The Logs destination's fetchers (Debug until 7.0, and its routes keep the
 * name). The shapes are the wire's (`shared/wire/debug.js`, measured-console
 * phase 32), one declaration the server's handlers import too.
 *
 * Everything here is a read. The bundle is a read too — `?download=1` only
 * changes the headers — so nothing in this module needs the CSRF header or the
 * write flag.
 */

import { post, q, request } from '../http';
import type { DebugIndexParams } from '../logs';
import type {
  DebugBundle,
  DebugIndex,
  DebugLevel,
  DebugLevelBody,
  DebugLevelState,
  DebugRuns,
  DebugSource,
  DoctorReport,
  RetentionReport,
} from '@shared/wire/debug.js';

export type {
  DebugBundle,
  DebugEntry,
  DebugIndex,
  DebugLevel,
  DebugLevelBody,
  DebugLevelState,
  DebugRuns,
  DebugSource,
  DebugSourceStatus,
  DeliveryTally,
  DoctorReport,
  DoctorRow,
  MetricFamily,
  MetricSample,
  RetentionAction,
  RetentionReport,
  RetentionSinkReport,
} from '@shared/wire/debug.js';
export type { DebugIndexParams } from '../logs';

/**
 * Where a row came from. The server's list, in the server's order.
 *
 * Kept as a `const` array rather than a bare union so the filter bar can render
 * the vocabulary without a second copy of it; held to the wire's `DebugSource`
 * (`shared/wire/debug.js`) by `satisfies`, so a word the wire does not know is a
 * compile error rather than a chip that filters nothing.
 */
export const DEBUG_SOURCES = [
  'console',
  'supervisor',
  'journal',
  'outcome',
  'ruling',
  'delivery',
  'health',
] as const satisfies readonly DebugSource[];

export const DEBUG_LEVELS = ['info', 'warn', 'error'] as const satisfies readonly DebugLevel[];

/** Only the parameters that were actually given — an empty value is not a request. */
function query(params: Readonly<Record<string, string | number | boolean | undefined>>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    parts.push(`${key}=${q(String(value))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * Build the index path.
 *
 * `source` and `level` are repeated keys rather than one comma-joined value.
 * The server reads both, and repeating is what a `URLSearchParams` round-trip
 * survives — a comma inside an encoded value would come back as one word.
 */
export function debugIndexPath(base: string, params: DebugIndexParams = {}): string {
  const { source, level, ...rest } = params;
  const repeated = [
    ...(source ?? []).map((value) => `source=${q(value)}`),
    ...(level ?? []).map((value) => `level=${q(value)}`),
  ];
  const scalar = query(rest).replace(/^\?/, '');
  const all = [...repeated, ...(scalar ? [scalar] : [])];
  return `${base}${all.length ? `?${all.join('&')}` : ''}`;
}

/** The follow stream's path — the same parameters as the index, so a filter follows exactly what it shows. */
export function debugTailPath(params: DebugIndexParams = {}): string {
  return debugIndexPath('/api/debug/tail', params);
}

/* ------------------------------------------------------------------ *
 * The trace — the run on one axis, across all four sources (Pro)
 * ------------------------------------------------------------------ */


export const debugApi = {
  debugIndex: (params: DebugIndexParams = {}) =>
    request<DebugIndex>(debugIndexPath('/api/debug/index', params)),
  debugRuns: (slug: string) => request<DebugRuns>(`/api/debug/runs${query({ slug })}`),
  debugBundle: (params: { slug?: string } = {}) => request<DebugBundle>(`/api/debug/bundle${query(params)}`),
  debugRetention: () => request<RetentionReport>('/api/debug/retention'),
  doctor: () => request<DoctorReport>('/api/doctor'),
  debugLevel: () => request<DebugLevelState>('/api/debug/level'),
  /**
   * Turn the log up (or down) for `ttlMs`; the server reverts it by itself at
   * the deadline. `debug` names the channels whose debug lines are written
   * whatever the level — a csv of event prefixes (`git, runner`) or `*`.
   */
  setDebugLevel: (body: DebugLevelBody) => post<DebugLevelState>('/api/debug/level', body),
  revertDebugLevel: () => request<DebugLevelState>('/api/debug/level', { method: 'DELETE' }),
  /*
     A plain href, not a fetch: the browser's own download machinery names the
     file from `content-disposition` and streams it to disk. The same reason
     the landing packet is an `<a download>` — a tar.gz through `request()`
     would be parsed as JSON, fail, and lose the bytes.
  */
  runBundleHref: (slug: string, runId: string, since?: string) =>
    `/api/debug/bundle${query({ slug, run: runId, since, download: 1 })}`,
};
