/**
 * The strip's "why is this not moving" line (control-tower phase 102, #145 E
 * and #163) — one sentence under the glance, from the first of three sources
 * that has something to say:
 *
 *  1. the supervisor's newest detection for the run, handed in by the Pro tree
 *     ("Phase 67 is queued ahead of a phase it depends on — the supervisor
 *     suggests: bump the dependency.");
 *  2. for a live phase, the phase report's first reason it is slow (phase 95:
 *     a repeated verification, the machine's load, a context near wrap-up, an
 *     in-turn wait, a queue hold);
 *  3. or, when nothing is slow, what it is doing and when it should finish —
 *     the task it is on, the measured operation, the ETA from its own rate.
 *
 * The report is the one `GET /api/run/:slug/phase/:n/report` every surface
 * reads, refreshed by the journal lines that move it, so the line and the Now
 * panel one press below cannot disagree.
 */

import type { PhaseReport } from '@/lib/api';
import { usePhaseReport } from '@/lib/queries';

/** A sentence someone else composed — the supervisor's, in the Pro tree. */
export interface WhyNote {
  text: string;
  /** Its first piece of evidence, as the line's title. */
  title?: string;
}

/** The report's line: why it is slow when it is, else what it is doing and when it should end. */
export function reportWhy(report: PhaseReport): { kind: 'slow' | 'doing'; text: string } | null {
  if (!report.live) return null;
  const [slow, ...more] = report.whySlow;
  if (slow) {
    const others = more.length ? ` (and ${more.length} more)` : '';
    return { kind: 'slow', text: `Slow: ${slow.text}${others}.` };
  }
  const task = report.doing.task;
  const op = report.doing.operation;
  const parts = [task ? `On ${task.text}` : `Phase ${report.phase} is ${report.status}`];
  if (op) parts.push(`${op.label} ${op.done}/${op.of}`);
  const eta = report.eta.minutes;
  const when = eta ? ` — about ${eta.low}–${eta.high} min left` : '';
  return { kind: 'doing', text: `${parts.join(', ')}${when}.` };
}

const LINE = 'min-w-0 text-2xs break-words text-ink-muted';

export function WhyLine({
  slug,
  phase,
  detection,
}: {
  slug: string;
  /** The first live phase, when one is live — the report's subject. */
  phase: number | undefined;
  detection?: WhyNote | null;
}) {
  if (detection) {
    return (
      <p data-testid="strip-why" data-why="detection" className={LINE} title={detection.title}>
        {detection.text}
      </p>
    );
  }
  if (phase == null) return null;
  return <ReportWhy slug={slug} phase={phase} />;
}

function ReportWhy({ slug, phase }: { slug: string; phase: number }) {
  const { data } = usePhaseReport(slug, phase);
  const line = data ? reportWhy(data) : null;
  if (!line) return null;
  return (
    <p data-testid="strip-why" data-why={line.kind} className={LINE} title={data?.summary}>
      {line.text}
    </p>
  );
}
