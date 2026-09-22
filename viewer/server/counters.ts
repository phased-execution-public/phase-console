/**
 * Process-lifetime counters — the cheap half of the evidence.
 *
 * The log says what happened; a counter says how OFTEN, which is the question
 * a log cannot answer without being read end to end. "Is this console running
 * more git than it used to", "did the journal start overflowing", "how much
 * transcript are we shedding" are all one scrape and no parsing.
 *
 * Deliberately tiny, and deliberately NOT durable:
 *
 * **Monotonic within a process, reset by a restart.** That is what a Prometheus
 * counter is — the scraper owns rate and reset detection, and a console that
 * tried to persist these would be inventing a second, worse store beside the
 * journal. `phase_console_build_info` already carries the identity a scraper
 * needs to tell one process's series from the next.
 *
 * **Bounded label cardinality, enforced here.** A counter keyed by anything a
 * caller can invent — a slug, a path, a ref — is how a metrics endpoint becomes
 * the thing that runs the machine out of memory. Every family below is keyed by
 * a closed vocabulary or by a value this module caps, and `LABEL_CAP` is the
 * backstop for the ones (a git verb, a shell command's name) that are a closed
 * set in practice and not in the type system.
 *
 * It imports nothing but itself: `log.ts` counts every line it writes, so
 * anything this file imported would have to be loadable before logging is.
 */

/** Distinct label values one family may hold before new ones fold into `other`. */
const LABEL_CAP = 64;

export type CounterFamily =
  | 'log_lines_total'
  | 'journal_appends_total'
  | 'journal_overflow_total'
  | 'transcript_shed_total'
  | 'git_commands_total'
  | 'git_command_seconds_total'
  | 'engine_calls_total'
  | 'http_requests_total'
  | 'shell_commands_total'
  | 'retention_removed_total'
  ;

type Bucket = Map<string, number>;

const families = new Map<CounterFamily, Bucket>();

function bucket(family: CounterFamily): Bucket {
  let found = families.get(family);
  if (!found) { found = new Map(); families.set(family, found); }
  return found;
}

/**
 * The label key, capped.
 *
 * Past `LABEL_CAP` distinct values a family stops growing and everything new
 * lands under `other` — which is a truthful answer (the total is still right)
 * where an unbounded map is a slow leak with a metrics endpoint on top of it.
 */
function key(family: CounterFamily, labels: string[]): string {
  const raw = labels.map((value) => String(value ?? '').slice(0, 64)).join('\u0000');
  const held = bucket(family);
  if (held.has(raw) || held.size < LABEL_CAP) return raw;
  return labels.map((_, i) => (i === 0 ? 'other' : '')).join('\u0000');
}

/** Add to a counter. `by` may be fractional — one family counts seconds. */
export function count(family: CounterFamily, labels: string[], by = 1): void {
  if (!Number.isFinite(by)) return;
  const held = bucket(family);
  const at = key(family, labels);
  held.set(at, (held.get(at) ?? 0) + by);
}

/** Every value of one family, as `[labels, value]` — labels in the order given. */
export function read(family: CounterFamily): [string[], number][] {
  return [...bucket(family).entries()].map(([at, value]) => [at.split('\u0000'), value]);
}

/** Every family that has ever been touched, for the renderer. */
export function readAll(): Map<CounterFamily, [string[], number][]> {
  const out = new Map<CounterFamily, [string[], number][]>();
  for (const family of families.keys()) out.set(family, read(family));
  return out;
}

/** Test seam only. Production never resets — a restart is the reset. */
export function resetCounters(): void {
  families.clear();
}
