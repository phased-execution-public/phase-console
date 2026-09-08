/**
 * What this browser last launched a plan with — the launch dialog's memory.
 *
 * The form seeds from three places, in a fixed order: the run's own record
 * beats a Settings ▸ Automation preference beats the shipped default. This
 * adds a fourth between the first two: what the OPERATOR chose the last time
 * they launched THIS plan from this browser. A plan that is always run on
 * Fable with a $60 ceiling should open on Fable with a $60 ceiling, and it
 * should say so — the seed marks every remembered value `from your last
 * launch`, so it is visibly a memory rather than a default.
 *
 * ## What is remembered, and what deliberately is not
 *
 * Posture is remembered: the model, the guard rails, the budgets, the branch
 * strategy, the tools, the stop conditions. Three kinds of value are NOT:
 *
 * - **A scope** (`onlyPhases`, `startAfter`). A scope remembered is a run
 *   silently narrowed to whatever was typed last time — the exact defect a
 *   `continue` was fixed for (client-11), re-created a launch later.
 * - **An act** (`qa`, the activation tick). Turning a plan's gate on is done
 *   once; a form that re-ticks it every time reads as a gate that keeps
 *   needing to be turned on.
 * - **Per-phase overrides** (`phaseOptions`). They name phases, and the
 *   phases that were worth overriding last time are usually done by now.
 *
 * `openPr` and `permissionMode` are owned by other controls (`settle`, the
 * profile) and follow them; `prompt` is a session's first message.
 *
 * ## Storage
 *
 * One `localStorage` key, `phase-console.launch`, holding `{ [slug]: { at,
 * values } }` — the same idiom as `lib/prefs.ts` and the write menu's
 * remembered owner. Capped at `MAX_PLANS` entries, oldest evicted, so a
 * browser that has launched a hundred plans over a year holds twelve. A
 * private-mode browser throws on write and the memory is simply absent;
 * a value the schema no longer has is dropped on read rather than seeded.
 */

import { EMPTY, type RunSetupField, type RunSetupValues } from './schema';

export const LAUNCH_MEMORY_KEY = 'phase-console.launch';
export const MAX_PLANS = 12;

/** The fields a launch remembers. See the header for what is missing and why. */
export const REMEMBERED_FIELDS: readonly RunSetupField[] = Object.freeze([
  'model',
  'effort',
  'autonomy',
  'permissionProfile',
  'accountId',
  'onLimit',
  'phaseBudgetUsd',
  'runBudgetUsd',
  'gitMode',
  'isolation',
  'settle',
  'priority',
  'reviewEachPhase',
  'reviewerPolicy',
  'ultracode',
  'ultraReview',
  'qaMaxRounds',
  'qaModel',
  'qaEffort',
  'attachDefaultSkills',
  'skills',
  'mcpServers',
  'mcpPolicy',
  'autoRecover',
  'maxParallel',
  'maxConsecutiveFailures',
]);

export interface LaunchMemory {
  /** ISO — when it was launched. The eviction order, and shown to a reader. */
  at: string;
  values: Partial<RunSetupValues>;
}

type Store = Record<string, LaunchMemory>;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function read(): Store {
  const store = storage();
  if (!store) return {};
  try {
    const raw = store.getItem(LAUNCH_MEMORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function write(next: Store): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(LAUNCH_MEMORY_KEY, JSON.stringify(next));
  } catch {
    /* private mode, or full — the memory is a convenience, never a requirement */
  }
}

/**
 * Only the remembered fields, and only values whose shape the schema still
 * has: a key this build does not know, or a value of the wrong type, is
 * dropped rather than seeded into a controlled input.
 */
function sanitize(values: unknown): Partial<RunSetupValues> {
  const out: Partial<RunSetupValues> = {};
  if (!values || typeof values !== 'object') return out;
  for (const field of REMEMBERED_FIELDS) {
    const value = (values as Record<string, unknown>)[field];
    if (value === undefined) continue;
    const shape = EMPTY[field];
    const same = Array.isArray(shape)
      ? Array.isArray(value) && value.every((v) => typeof v === 'string')
      : typeof value === typeof shape;
    if (same) (out as Record<string, unknown>)[field] = value;
  }
  return out;
}

/** What this browser launched `slug` with last time, or null when it never has. */
export function recallLaunch(slug: string | undefined): LaunchMemory | null {
  if (!slug) return null;
  const entry = read()[slug];
  if (!entry || typeof entry !== 'object') return null;
  const values = sanitize(entry.values);
  if (!Object.keys(values).length) return null;
  return { at: typeof entry.at === 'string' ? entry.at : '', values };
}

/**
 * Record a launch. `values` is the form as submitted; only the remembered
 * fields that DIFFER from `baseline` are kept, so a value at the shipped
 * default is silence rather than a memory of the default — and a plan
 * launched entirely on defaults leaves no entry at all.
 */
export function rememberLaunch(
  slug: string | undefined,
  values: RunSetupValues,
  baseline: RunSetupValues,
  shown: (field: RunSetupField) => boolean,
  now: () => Date = () => new Date(),
): void {
  if (!slug) return;
  const kept: Partial<RunSetupValues> = {};
  for (const field of REMEMBERED_FIELDS) {
    if (!shown(field)) continue;
    if (JSON.stringify(values[field]) === JSON.stringify(baseline[field])) continue;
    (kept as Record<string, unknown>)[field] = values[field];
  }
  const store = read();
  if (!Object.keys(kept).length) {
    if (slug in store) {
      delete store[slug];
      write(store);
    }
    return;
  }
  store[slug] = { at: now().toISOString(), values: kept };
  // Oldest out, by the launch time. `MAX_PLANS` is a small number on purpose:
  // this is what one operator launches by hand, not an index.
  const slugs = Object.keys(store).sort((a, b) => (store[b]?.at ?? '').localeCompare(store[a]?.at ?? ''));
  for (const stale of slugs.slice(MAX_PLANS)) delete store[stale];
  write(store);
}

export function forgetLaunch(slug: string | undefined): void {
  if (!slug) return;
  const store = read();
  if (!(slug in store)) return;
  delete store[slug];
  write(store);
}
