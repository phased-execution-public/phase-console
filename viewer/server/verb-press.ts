/**
 * The one in-process door for a triggerable verb (control-tower phase 98, #137).
 *
 * A stored trigger presses a verb with no request behind it, so it cannot go
 * through the route — but it must not go AROUND it either: a second copy of
 * "what pause does" is exactly how a button and a script come to disagree.
 * So each case below calls the same `Service` method the route's case calls
 * (`OPERATOR_VERBS[].method`, held to both files by `test/verb-model.test.ts`),
 * with the arguments the route would have read off the body, and answers in
 * one shape — `{ ok, status, error?, body? }` — which is what `trigger.fired`
 * records and what a supervisor reading the journal later needs.
 *
 * Only rows the table marks `trigger` are here; a verb that is not is refused
 * by name before anything is pressed.
 */

import { verbNamed } from '../shared/verb-model.js';
import type { StartActor } from './actor.ts';
import type { ServiceRuns } from './service-runs.ts';
import type { VerbAnswer } from './triggers.ts';

/** The service methods a trigger may reach — nothing else of the service. */
export type VerbDoor = Pick<ServiceRuns,
  | 'pauseRun' | 'resumeRun' | 'pressResume' | 'pressRetry' | 'steerRun' | 'bumpQueueEntry'
  | 'clearFailureStreak' | 'boardAtBoundary' | 'holdRun' | 'releaseRun' | 'switchAccountRun' | 'noteRun'
  | 'queueSnapshot'>;

const text = (value: unknown, max: number): string | undefined =>
  (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);

const phaseOf = (body: Record<string, unknown>): number | null => {
  const n = Number(body.phase);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const refused = (status: number, error: string): VerbAnswer => ({ ok: false, status, error });

/** A press's answer (`PressAnswer`), folded to the one shape. */
function pressed(answer: { ok: true; launched?: unknown; queued?: unknown } | { ok: false; status: number; error: string }): VerbAnswer {
  if (!answer.ok) return refused(answer.status, answer.error);
  return { ok: true, status: 200, body: 'launched' in answer && answer.launched ? { launched: answer.launched } : { queued: answer.queued } };
}

export async function pressVerb(
  service: VerbDoor, slug: string, name: string, body: Record<string, unknown>, actor: StartActor,
): Promise<VerbAnswer> {
  const row = verbNamed(name);
  if (!row?.trigger) return refused(400, `"${name}" is not a verb a trigger may press`);
  const phase = phaseOf(body);
  const needPhase = (): VerbAnswer => refused(400, `${name} needs {phase}`);

  switch (row.name) {
    case 'pause': {
      const run = service.pauseRun(slug, actor);
      return run ? { ok: true, status: 200 } : refused(409, `nothing to pause: no run of ${slug} is driving`);
    }
    case 'resume': {
      const answer = await service.resumeRun(slug, actor);
      return answer.ok ? { ok: true, status: 200, body: { resumed: answer.resumed } } : refused(answer.status, answer.error);
    }
    case 'resume-phase': {
      if (phase === null) return needPhase();
      const instruction = text(body.instruction ?? body.note, 8_000);
      return pressed(await service.pressResume(slug, phase, 'resume', { ...(instruction ? { instruction } : {}), actor }));
    }
    case 'retry': {
      if (phase === null) return needPhase();
      const addendum = text(body.addendum, 4_000);
      return pressed(await service.pressRetry(slug, phase, { ...(addendum ? { addendum } : {}), by: actor.by }, actor));
    }
    case 'steer': {
      const instruction = text(body.instruction ?? body.text, 8_000);
      if (!instruction) return refused(400, 'steer needs {instruction}');
      const sent = service.steerRun(slug, instruction, actor.by, undefined, phase, actor.reason);
      return sent.ok ? { ok: true, status: 200 } : refused(409, sent.reason ?? 'the steer was refused');
    }
    case 'bump': {
      if (phase === null) return needPhase();
      const entry = service.queueSnapshot().entries.find((one) => one.slug === slug && one.phase === phase);
      if (!entry) return refused(404, `no queued entry for ${slug} phase ${phase}`);
      return service.bumpQueueEntry(entry.id, actor) ? { ok: true, status: 200 } : refused(404, `entry ${entry.id} has already started`);
    }
    case 'clear-streak': {
      const cleared = service.clearFailureStreak(slug, actor);
      return cleared.ok ? { ok: true, status: 200, body: { was: cleared.was } } : refused(cleared.status, cleared.error);
    }
    case 'board-at-boundary': {
      if (phase === null) return needPhase();
      const instruction = text(body.instruction ?? body.note, 8_000);
      return pressed(await service.boardAtBoundary(slug, phase, { ...(instruction ? { instruction } : {}), actor }));
    }
    case 'hold':
      return service.holdRun(slug, actor) ? { ok: true, status: 200 } : refused(409, `no run of ${slug} to hold`);
    case 'release':
      return service.releaseRun(slug, actor) ? { ok: true, status: 200 } : refused(409, `no run of ${slug} to release`);
    case 'switch-account': {
      const accountId = text(body.accountId, 64);
      if (!accountId) return refused(400, 'switch-account needs {accountId}');
      const when = body.when === 'boundary' ? 'boundary' as const : body.when === undefined || body.when === 'now' ? undefined : null;
      if (when === null) return refused(400, 'when must be now or boundary');
      const outcome = service.switchAccountRun(slug, accountId, actor, when ? { when } : {});
      return outcome.ok ? { ok: true, status: 200 } : refused(409, outcome.reason ?? 'the switch was refused');
    }
    case 'note': {
      const note = text(body.text, 2_000);
      if (!note) return refused(400, 'note needs {text}');
      const out = service.noteRun(slug, { text: note, pinned: body.pinned === true, ...(phase !== null ? { phase } : {}) }, actor);
      return out.ok ? { ok: true, status: 200, body: { note: out.note.id } } : refused(out.status, out.error);
    }
    default:
      return refused(400, `"${name}" has no in-process door`);
  }
}
