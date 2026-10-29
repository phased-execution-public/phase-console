/**
 * A session's vitals: the plan and phase it serves, how long it has been at
 * it, the phase's own estimate, the door that started it and how it ended
 * (7.0, quiet-console phase 15; the vitals since control-tower phase 19).
 *
 * The linkage is the session's own meta — recovery and QA sessions are minted
 * against a `(slug, phase)` — and the estimate is the plan detail's per-phase
 * ETA. Past the estimate the line says "over", never a countdown to a zero
 * that is not coming. A session with no linkage shows its clock alone — never
 * an invented attribution.
 */

import type { TerminalSession } from '@/data/api';
import { usePlan } from '@/data/plans';
import { useNow } from '@/ui/clock';
import { elapsed } from '@/lib/format';
import { runHref } from '@/shell/routes';
import { KeyValue, type KeyValueItem } from '@/ui';
import { useSessionLedger } from './ledger';

/** The plan and phase a session was minted against, when it names one. */
export function sessionLinkage(session: TerminalSession): { slug?: string; phase?: number } {
  const meta = session.meta;
  if (meta?.recovery?.slug) {
    return {
      slug: meta.recovery.slug,
      ...(meta.recovery.phase != null ? { phase: meta.recovery.phase } : {}),
    };
  }
  if (meta?.qa?.slug) return { slug: meta.qa.slug, phase: meta.qa.phase };
  return {};
}

export function SessionVitals({ session }: { session: TerminalSession }) {
  const { slug, phase } = sessionLinkage(session);
  const live = !session.exitedAt;
  const now = useNow(live);
  const { data: detail } = usePlan(slug);
  const ledger = useSessionLedger(session);
  const eta = phase != null ? detail?.eta?.perPhase.find((estimate) => estimate.phase === phase) : undefined;
  const ms = Math.max(0, (live ? now : (session.exitedAt ?? now)) - session.createdAt);
  const over = Boolean(eta && ms > eta.estMs);

  const items: KeyValueItem[] = [
    slug
      ? [
          'Serves',
          <a key="plan" href={runHref(slug)} className="text-ink underline-offset-2 hover:underline">
            {slug}
            {phase != null ? ` P${phase}` : ''}
          </a>,
        ]
      : null,
    session.meta?.intent === 'plan' && !slug
      ? ['Serves', 'a plan it is writing — it gets a slug once approved']
      : null,
    [
      live ? 'Running for' : 'Ran for',
      <span key="clock" className="tnum" data-testid="session-clock">
        {elapsed(ms)}
      </span>,
    ],
    // This session's own clock against the PHASE's estimate of working time —
    // named as working time, so the two clocks are never read as one.
    eta
      ? [
          'Estimate',
          <span key="eta" className="tnum" title={`This phase's own estimate — ${eta.label}.`}>
            {over ? `over the ~${elapsed(eta.estMs)} estimate of work` : `~${elapsed(eta.estMs)} of work`}
          </span>,
        ]
      : null,
    ...ledger,
  ];
  return <KeyValue items={items} />;
}
