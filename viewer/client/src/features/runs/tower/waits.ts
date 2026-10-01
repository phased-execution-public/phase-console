/**
 * What a run is waiting on, in words — the lines a strip says under its name
 * (control-tower phase 20, exit criteria 4 and 7).
 *
 * Four things hold a run up without being a stop somebody must answer, and
 * the record already carries each of them:
 *
 *   - the operator's HOLD (`run.hold`) — nothing new boards until Release;
 *   - a SCOPE FENCE — a phase's `waitingOn` holder of kind `fence`: a sibling
 *     phase of this run parked on a declared external wall whose scope meets
 *     this one's, with the refs it still waits on (phase 6, #19);
 *   - a FOLDED ERRAND — one ask standing for several phases that met the same
 *     wall (`recoveries[n].errand.alsoPhases`, phase 6's fold, #19);
 *   - the ADMISSION QUEUE — the queued lane's entry, whose holders include a
 *     sibling run's BRANCH on a shared checkout since phase 40 (#41).
 *
 * A strip that said only "Waiting" or "Queued" over any of these made the
 * operator open it to learn why. The run-level wait (a usage window, a clock,
 * an external watch) is already on the badge — `describeRun`'s note — and is
 * not said twice.
 *
 * Pure: the page's clock is passed in.
 */

import type { NowLane } from '@/features/runs/lanes-model';
import type { QueueEntry, RunState } from '@/lib/api';
import { waitingLabel } from '../queue-words';

export interface WaitLine {
  /** Stable across polls — keys React. */
  key: string;
  kind: 'hold' | 'fence' | 'fold' | 'queue';
  text: string;
}

/** `P7, P8 and P9` — how the console names a run of phases in a sentence. */
export function phaseList(phases: readonly number[]): string {
  const names = phases.map((phase) => `P${phase}`);
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** `14:05Z` — the wall-clock end of a fence, in the words the wait notes use. */
function clockOf(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)}Z`;
}

export function waitLines(
  run: RunState,
  lanes: readonly NowLane[],
  entry: QueueEntry | undefined,
  now: number,
): WaitLine[] {
  const out: WaitLine[] = [];

  if (run.hold) {
    out.push({
      key: 'hold',
      kind: 'hold',
      text: `Held${run.hold.by ? ` by ${run.hold.by}` : ''}: nothing new boards until it is released`,
    });
  }

  const records = Object.values(run.phases ?? {})
    .filter((record) => record != null)
    .sort((a, b) => a.phase - b.phase);

  for (const record of records) {
    for (const holder of record.waitingOn ?? []) {
      if (holder.kind !== 'fence' || holder.phase == null) continue;
      const refs = holder.refs?.length ? holder.refs.join(', ') : 'the errand it filed';
      const lifts =
        holder.until != null && holder.until > now
          ? `; the fence lifts by itself at ${clockOf(holder.until)}`
          : '';
      out.push({
        key: `fence:${record.phase}`,
        kind: 'fence',
        text: `P${record.phase} is fenced by P${holder.phase}'s external wall, waiting on ${refs}${lifts}`,
      });
    }
  }

  for (const [key, slot] of Object.entries(run.recoveries ?? {})) {
    const also = slot?.errand?.alsoPhases?.filter((phase) => String(phase) !== key) ?? [];
    if (!also.length) continue;
    out.push({
      key: `fold:${key}`,
      kind: 'fold',
      text: `P${key}'s errand also stands for ${phaseList([...also].sort((a, b) => a - b))}: one wall, one ask`,
    });
  }

  const queued = lanes.find((lane) => lane.status === 'queued');
  if (queued) {
    const said = waitingLabel(entry);
    // Only when the queue snapshot names a holder: the badge already reads
    // "queued", and repeating the bare word under it says nothing.
    if (said !== 'queued')
      out.push({ key: `queue:${queued.phase}`, kind: 'queue', text: `P${queued.phase} ${said}` });
  }

  return out;
}
