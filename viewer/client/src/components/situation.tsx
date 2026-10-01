/**
 * The situation, rendered: what the classifier says this phase IS, why, and
 * the evidence it read — the first thing the phase's "Why is this not done?"
 * panel shows, because it is the first thing the unattended healer reads.
 *
 * Pure presentation: the words come from the shared model via the server
 * payload, the evidence lines are already sentences. No queries, no verbs —
 * the Ways forward beside it carry those.
 */

import { Badge } from '@/components/ui';
import type { SituationView } from '@/lib/situation';
import type { WallReading } from '@shared/situation-model.js';

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
  /** `summariseEvidence` lines from the server — shown under a disclosure. */
  evidence?: string[];
  /** Chip + blurb only — for a table row. */
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
    <div className="flex flex-col gap-1 text-2xs" data-testid="situation">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink-faint">Situation</span>
        <Badge
          title={situation.blurb}
          tone={
            situation.actor === 'person'
              ? 'accent'
              : situation.actor === 'machine'
                ? 'live'
                : situation.actor === 'none'
                  ? 'ok'
                  : 'neutral'
          }
        >
          {situation.label}
        </Badge>
        <span className="text-ink-faint">· {actor}</span>
        <code className="font-mono text-ink-faint">{situation.key}</code>
      </div>
      {!compact && <div className="text-ink-muted">{situation.blurb}</div>}
      {!compact && why.length > 0 && (
        <ul className="ml-4 list-disc" data-testid="situation-why">
          {why.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
      {!compact && wall && (
        <div className="text-ink-muted" data-testid="situation-wall">
          <div>{wall.sentence}</div>
          <div className="font-mono tabular-nums text-ink-faint">
            {wall.reset ? 'reset' : 'at the latest'} {clock(wall.latest)}
            {wall.lastReading && (
              <>
                {' · last reading '}
                {clock(wall.lastReading.at)} by {wall.lastReading.by}
                {wall.lastReading.resetsAt ? ` — resets ${clock(wall.lastReading.resetsAt)}` : ''}
                {wall.lastReading.ok ? ' — headroom' : ' — still walled'}
              </>
            )}
          </div>
        </div>
      )}
      {!compact && evidence && evidence.length > 0 && (
        <details>
          <summary className="cursor-pointer">Evidence it read ({evidence.length})</summary>
          <ul className="ml-4 mt-1 list-disc font-mono" data-testid="situation-evidence">
            {evidence.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
