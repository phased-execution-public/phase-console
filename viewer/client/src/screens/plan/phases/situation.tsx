/**
 * The situation, rendered: what the classifier says this phase IS, why, and
 * the evidence it read — the first thing the phase's "Why is this not done?"
 * panel shows, because it is the first thing the unattended healer reads.
 *
 * Pure presentation: the words come from the shared model via the server
 * payload, the evidence lines are already sentences. No queries, no verbs —
 * the Ways forward beside it carry those.
 *
 * Drawn as the ladder strip draws a situation (`cards/errand.tsx`): its name,
 * and who acts on it said once beside it in words. The evidence folds behind
 * the kit's expand, which says how many lines it holds.
 */

import type { WallReading } from '@shared/situation-model.js';
import type { SituationView } from '@/lib/situation';
import { Mono } from '@/ui';
import { Disclosure } from '@/ui/disclosure';

/** `12:50Z` — the instants a wall line names. */
const clock = (iso: string): string => `${iso.slice(11, 16)}Z`;

const ACTOR_WORDS: Record<string, string> = {
  machine: 'the autopilot climbs its ladder',
  person: 'a person is needed',
  wait: 'nothing to do but wait',
  none: 'nothing is wrong',
};

export function SituationSummary({
  situation,
  evidence,
  compact = false,
  wall,
}: {
  situation: SituationView | null | undefined;
  /** `summariseEvidence` lines from the server — folded under the kit's expand. */
  evidence?: string[];
  /** The name, who acts and the key only — for a table row. */
  compact?: boolean;
  /**
   * The usage wall the phase is parked on, read NOW (`wallReading`, control-tower
   * phase 86, #132 #78): its live sentence, the "at the latest" reset and the
   * last reading that judged it — never a countdown frozen at the park.
   */
  wall?: WallReading | null;
}) {
  if (!situation) return null;
  const actor = ACTOR_WORDS[situation.actor] ?? situation.actor;
  // A usage wall's first line is the wall itself, and the wall block below
  // reads it NOW — the classifier's copy quotes the park (control-tower phase
  // 86, #78), so the card says it once, current.
  const why =
    wall && !compact && situation.key === 'resource-wall:usage' ? situation.why.slice(1) : situation.why;
  return (
    <div className="flex min-w-0 flex-col gap-1 text-meta" data-testid="situation">
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="text-ink-muted">Situation</span>
        <span className="font-medium text-ink" title={situation.blurb}>
          {situation.label}
        </span>
        <span className="text-ink-muted">{actor}</span>
        <Mono value={situation.key} className="text-ink-faint" />
      </p>
      {!compact && <p className="text-ink-muted">{situation.blurb}</p>}
      {!compact && why.length > 0 && (
        <ul className="ms-4 list-disc text-ink" data-testid="situation-why">
          {why.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
      {!compact && wall && (
        <div className="flex flex-col gap-0.5 text-ink-muted" data-testid="situation-wall">
          <p>{wall.sentence}</p>
          <p className="flex flex-wrap gap-x-3 text-ink-faint tabular-nums">
            <span>
              {wall.reset ? 'Reset' : 'At the latest'} {clock(wall.latest)}
            </span>
            {wall.lastReading && (
              <span>
                Last reading {clock(wall.lastReading.at)} by {wall.lastReading.by}
                {wall.lastReading.resetsAt ? `, resets ${clock(wall.lastReading.resetsAt)}` : ''}
                {wall.lastReading.ok ? ', headroom' : ', still walled'}
              </span>
            )}
          </p>
        </div>
      )}
      {!compact && evidence && evidence.length > 0 && (
        <Disclosure label="Evidence it read" openLabel="Hide the evidence" count={evidence.length}>
          <ul className="ms-4 mt-1 list-disc font-mono text-ink-muted" data-testid="situation-evidence">
            {evidence.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}
