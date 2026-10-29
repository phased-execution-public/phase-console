/**
 * The ledger's older settled steps — *Done*'s history (7.0, quiet-console
 * phase 8; control-tower phase 137's "Earlier").
 *
 * The day's settled items are the turn's and are drawn as cards under *Done*;
 * everything older the ledger still lists is one line each, newest first: the
 * state as a hollow dot and its word, the title, where it belonged and when it
 * settled. Nothing here is acted on, so nothing here is a card.
 */

import { stamp } from '@/cards/turn/step-words';
import type { HumanStepRecord } from '@/data/human-steps';
import { OpsStatus } from '@/ui/status';

export function EarlierSteps({ steps }: { steps: readonly HumanStepRecord[] }) {
  if (!steps.length) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="turn-done-history">
      <h3 className="text-meta font-medium text-ink">Earlier</h3>
      <ol className="flex list-none flex-col divide-y divide-rule p-0">
        {steps.map((step) => (
          <li
            key={step.id}
            data-testid="turn-done-earlier"
            className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5"
          >
            <OpsStatus vocab="step" word={step.state} />
            <span className="min-w-0 max-w-(--measure) break-words text-body text-ink">{step.title}</span>
            <span className="text-meta text-ink-muted">
              {step.slug}
              {step.phase ? `, phase ${step.phase}` : ''}, {stamp(step.at)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
