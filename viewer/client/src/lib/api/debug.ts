/**
 * The Debug destination's wire.
 *
 * Types are re-declared here by hand rather than imported from `server/` — the
 * house rule for every module in this directory. The client and the server are
 * two programs that agree on a JSON shape; importing the server's type would
 * make a server refactor silently retype the client, and the wire would stop
 * being a thing either side could see.
 *
 * Everything here is a read. The bundle is a read too — `?download=1` only
 * changes the headers — so nothing in this module needs the CSRF header or the
 * write flag.
 */

import { q, request } from './client';

/**
 * Where a row came from. The server's list, in the server's order.
 *
 * Kept as a `const` array rather than a bare union so the filter bar can render
 * the vocabulary without a second copy of it, and so a source the server adds
 * shows up here as a compile error rather than as a silently missing chip.
 */
export const DEBUG_SOURCES = [
  'console',
  'supervisor',
  'journal',
  'outcome',
  'ruling',
  'delivery',
  'health',
] as const;
export type DebugSource = (typeof DEBUG_SOURCES)[number];

export const DEBUG_LEVELS = ['info', 'warn', 'error'] as const;
export type DebugLevel = (typeof DEBUG_LEVELS)[number];

/** One row, whatever it came from. `at` is `''` when the source had no time. */
export interface DebugEntry {
  source: DebugSource;
  at: string;
  level: DebugLevel;
  event: string;
  text: string;
  slug?: string;
  runId?: string;
  phase?: number;
  data?: Record<string, unknown>;
}

/**
 * Whether a source could be read, and why not.
 *
 * `available: false` with a `note` is an ANSWER — "there is no supervisor log
 * on this machine" — and the page must render it as one. An absent note on an
 * unavailable source means the reason is structural and stated elsewhere.
 */
export interface DebugSourceStatus {
  source: DebugSource;
  available: boolean;
  path?: string;
  count: number;
  note?: string;
}

export interface DebugIndex {
  entries: DebugEntry[];
  sources: DebugSourceStatus[];
  /** The limit cut the answer. The page says so rather than implying "all". */
  truncated: boolean;
  /** The plans this answer covers — bounded when no slug was named. */
  slugs: string[];
  /**
   * Present when the read included the `delivery` source.
   *
   * The SERVER's tally, not a client re-derivation: `undelivered` counts an
   * announcement no device took, which is a different question from how many
   * rows said `failed`, and two implementations of that rule would be two
   * answers.
   */
  delivery?: DeliveryTally;
}

export interface DebugRuns {
  slug: string;
  runs: string[];
}

export interface MetricSample {
  labels: Record<string, string>;
  value: number;
}

export interface MetricFamily {
  name: string;
  type: string;
  help: string;
  samples: MetricSample[];
}

export interface DeliveryTally {
  /** One count per outcome word actually seen — `sent`, `quiet`, `failed`, … */
  outcomes: Record<string, number>;
  /** Announcements no device took. Not the same as the `failed` count. */
  undelivered: number;
  announcements: number;
  devices: number;
}

export interface DebugBundle {
  schema: string;
  version: number;
  generatedAt: string;
  console: Record<string, unknown>;
  root: string | null;
  plans: { slug: string; runs: string[] }[];
  health: {
    environment: { kind: string; detail: string; fix: string }[];
    watches: { passes: number; asked: string[]; open: boolean } | null;
  };
  metrics: MetricFamily[];
  delivery: DeliveryTally;
  entries: DebugEntry[];
  sources: DebugSourceStatus[];
  /** What was left out, and how to ask for it. */
  notes: string[];
}

/**
 * The index's parameters.
 *
 * `type`, not `interface` — only a type alias is assignable to the
 * `Record<string, …>` the query builder takes, the same reason `repo.ts` gives.
 */
export type DebugIndexParams = {
  source?: DebugSource[];
  level?: DebugLevel[];
  slug?: string;
  run?: string;
  phase?: number;
  q?: string;
  since?: string;
  until?: string;
  limit?: number;
};

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

export const debugApi = {
  debugIndex: (params: DebugIndexParams = {}) =>
    request<DebugIndex>(debugIndexPath('/api/debug/index', params)),
  debugRuns: (slug: string) => request<DebugRuns>(`/api/debug/runs${query({ slug })}`),
  debugBundle: (params: { slug?: string } = {}) => request<DebugBundle>(`/api/debug/bundle${query(params)}`),
};
