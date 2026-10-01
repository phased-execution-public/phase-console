/**
 * The ingest probe (control-tower phase 50, #86): a declaration's pollable
 * refs are asked the moment it is written, while the session that wrote it is
 * still alive inside `phase-outcome.sh` — and a ref that has ALREADY landed
 * answers "continue" instead of parking anything.
 *
 * Measured over a week: 5 of 30 declared refs were already true when declared,
 * 8 of 30 at the first probe (9–119 s later). Three workflow runs had completed
 * before the session said it would wait for them — one 346 s before. Each cost
 * a full park, a probe on the next tick (`WATCH_FLOOR_MS`) and a resume of a
 * 300–470k-token context, because the script checked a ref's syntax and
 * nothing else, and the console asked nothing until the session had gone.
 *
 * The door's shape is the whole of its safety:
 *
 *   - the script STAGES its declaration first (`<file>.tmp.<pid>`, beside the
 *     place it will land), and the request names only that file. The console
 *     reads the refs from the file, never from the request, and accepts only a
 *     file in its OWN state directory for that plan — the supervised
 *     `run-<id>-p<N>-outcome.json` beside every run, or the unsupervised inbox.
 *     So the door can make the console ask, sooner, exactly what its timer
 *     would have asked anyway; it cannot hand it a command of its own.
 *   - it is a session's door on this machine (`/hooks/declaration`, loopback
 *     and not through the remote proxy — the presence hook's trust model).
 *   - the answer is advice to the script, which then acts: on `landed` it
 *     removes its staged file and exits `ALREADY_LANDED_EXIT`; on anything
 *     else — `pending`, a refusal, no console at all — it moves the file into
 *     place and the declaration parks exactly as it always did.
 *
 * Every probe is bounded by `DECLARED_PROBE_BUDGET_MS` in total, and a ref not
 * answered by then reads `unknown` — which parks. A slow `gh` must never hold
 * a session hostage, and "I could not tell" is never a landing.
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import { outcomeInboxDir, readOutcome, type PhaseOutcome } from './runner/outcome.ts';
import { runDir } from './runner/state.ts';
import { pollableRefs, type WatchState } from './watch-refs.ts';

/** The whole ingest probe's bound — every ref asked at once, answered within it or `unknown`. */
export const DECLARED_PROBE_BUDGET_MS = 20_000;

/**
 * `phase-outcome.sh`'s exit code for "a watched ref has already landed —
 * nothing was parked, carry on". Distinct from 0 (recorded), 1 (a ruling not
 * remembered) and 2 (usage). The script owns the number; this is its twin,
 * held equal by `declare-already-landed.test.ts`.
 */
export const ALREADY_LANDED_EXIT = 3;

/** The journal line a landed ingest probe writes on the run it belongs to. */
export const ALREADY_LANDED_EVENT = 'phase.watch-already-landed';

/** A staged declaration older than this is not the one a live session is waiting on. */
export const DECLARED_PROBE_MAX_AGE_MS = 5 * 60_000;

/** The statuses that PARK — the only declarations whose refs a wait is made of. */
const PARKING: readonly string[] = ['waiting-external', 'blocked', 'needs-human'];

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** `run-<id>-p<N>-outcome.json.tmp.<pid>` (supervised) or `phase-NN[-stamp].json.tmp.<pid>` (the inbox). */
const STAGED_RE = /^(?:run-([A-Za-z0-9_-]{1,64})-p(\d+)-outcome|phase-(\d{2,})(?:-\d{8}T\d{6}Z)?)\.json\.tmp\.\d{1,10}$/;

export type DeclaredProbeAnswer =
  | { status: 200; verdict: 'landed'; ref: string; detail: string | null; sentence: string; refs: WatchState[] }
  /**
   * A ref the console will NEVER run or read as written (control-tower phase
   * 88, #125) — its policy, a shape it cannot run from its own root, a phase
   * naming itself. The script exits 2 with `sentence`: a park on it is a park
   * nothing resumes, and the session that can fix the ref is still here.
   */
  | { status: 200; verdict: 'refused'; ref: string; detail: string | null; sentence: string; refs: WatchState[] }
  | { status: 200; verdict: 'pending'; refs: WatchState[] }
  | { status: 400 | 404 | 409; error: string };

export type DeclaredProbeDeps = {
  /** The console's repository root, or null when it has none. */
  root: string | null;
  now?: number;
  /** Ask the refs — `WatchScheduler.probeDeclared`, the timer's own probe. */
  probe: (slug: string, phase: number, refs: readonly string[]) => Promise<{ landed: WatchState | null; refs: WatchState[] }>;
  /** Journal the landing on the run it belongs to (the run id, when the file names one). */
  journal?: (slug: string, runId: string | null, kind: string, data: Record<string, unknown>, phase: number) => void;
};

function same(a: string, b: string): boolean {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

/** The sentence the script prints — quote-free, so bash can lift it from the JSON as it is. */
export function alreadyLandedSentence(landed: WatchState): string {
  const detail = landed.detail ? ` (${landed.detail})` : '';
  return `already landed — continue: ${landed.ref}${detail}. Nothing was parked; carry on with the phase from what landed.`
    .replace(/["\\]/g, "'");
}

/** The refusal the script prints before it exits 2 — quote-free, like the landing's. */
export function refusedSentence(refused: WatchState): string {
  const why = refused.detail ? `: ${refused.detail.replace(/\.$/, '')}` : '';
  return `refused — ${refused.ref}${why}. The console would never run it as written, so nothing would ever resume this phase: `
    + 'fix the ref (absolute paths, no $, no cd; phase:<slug>/<N> for a sibling) and declare again, or declare without it.'
    .replace(/["\\]/g, "'");
}

/** Answer one ingest probe. Every refusal is a 4xx the script reads as "park as before". */
export async function answerDeclaredProbe(
  body: { slug?: unknown; phase?: unknown; file?: unknown },
  deps: DeclaredProbeDeps,
): Promise<DeclaredProbeAnswer> {
  if (!deps.root) return { status: 404, error: 'this console has no repository' };
  const slug = typeof body.slug === 'string' ? body.slug : '';
  const phase = typeof body.phase === 'number' ? body.phase : Number(body.phase);
  const file = typeof body.file === 'string' ? body.file : '';
  if (!SLUG_RE.test(slug)) return { status: 400, error: 'not a plan slug' };
  if (!Number.isSafeInteger(phase) || phase <= 0) return { status: 400, error: 'not a phase number' };
  if (!file || !isAbsolute(file)) return { status: 400, error: 'the staged declaration must be named by its absolute path' };

  // The file must be one this console owns for this plan, staged under the
  // name it is about to land as — never a path the request chose freely.
  const path = resolve(file);
  const name = basename(path);
  const shape = STAGED_RE.exec(name);
  if (!shape) return { status: 400, error: 'not a staged declaration' };
  const named = Number(shape[2] ?? shape[3]);
  if (named !== phase) return { status: 400, error: 'the staged declaration names another phase' };
  const home = shape[1] ? runDir(deps.root, slug) : outcomeInboxDir(deps.root, slug);
  if (!existsSync(path) || !same(dirname(path), home)) {
    return { status: 404, error: 'no staged declaration of this plan there' };
  }

  const declared: PhaseOutcome | null = readOutcome(path, { slug, phase });
  if (!declared) return { status: 400, error: 'not a declaration of that plan and phase' };
  if (!PARKING.includes(declared.status)) return { status: 409, error: `${declared.status} parks nothing — there is nothing to probe` };
  const now = deps.now ?? Date.now();
  const wrote = Date.parse(declared.written_at);
  if (!Number.isFinite(wrote) || now - wrote > DECLARED_PROBE_MAX_AGE_MS) {
    return { status: 409, error: 'the staged declaration is stale' };
  }
  if (!pollableRefs(declared.watch).length) return { status: 200, verdict: 'pending', refs: [] };

  const answer = await deps.probe(slug, phase, declared.watch);
  if (!answer.landed) {
    // Landed first — a wait already over is over whatever else it named. A
    // refusal next: the script exits 2 rather than park on it (#125).
    const refused = answer.refs.find((r) => r.state === 'refused');
    if (refused) {
      return {
        status: 200, verdict: 'refused', ref: refused.ref, detail: refused.detail ?? null,
        sentence: refusedSentence(refused).replace(/["\\]/g, "'"), refs: answer.refs,
      };
    }
    return { status: 200, verdict: 'pending', refs: answer.refs };
  }
  const landed = answer.landed;
  try {
    deps.journal?.(slug, shape[1] ?? null, ALREADY_LANDED_EVENT, {
      ref: landed.ref, detail: landed.detail ?? null, status: declared.status,
      writtenAt: declared.written_at, sessionId: declared.session_id ?? null,
      refs: answer.refs.map((r) => ({ ref: r.ref, state: r.state })),
    }, phase);
  } catch { /* a journal must never cost the session its answer */ }
  return {
    status: 200, verdict: 'landed', ref: landed.ref, detail: landed.detail ?? null,
    sentence: alreadyLandedSentence(landed), refs: answer.refs,
  };
}
