/**
 * The plan's git lines against this launch (#18, control-tower phase 22).
 *
 * Probe 7 (`server/prelude.ts` `probeGitStrategy`) names every git line of the
 * plan the chosen strategy will not honour — a `**Branch:**` the new-branch
 * strategy never creates, `Worktrees: on` in a checkout that cannot grant it,
 * a `Checkout: main` a shared checkout leaves inert — and the start door
 * refuses to launch over one until it is answered. This panel is where it is
 * answered: inside the Git tile, and ONLY when the prelude reports a
 * difference, because an answer to a question nobody asked is noise.
 *
 * `honour` gives the run a checkout of its own where that makes the plan hold;
 * `override` runs over the lines and tells every session the branch it is
 * really on. A line isolation cannot fix is refused `honour` by the door, so
 * the choice is not offered for it.
 */

import { GitCompare } from 'lucide-react';
import { RadioGroup, RadioItem } from '@/components/ui';
import type { GitStrategyLine, Prelude } from '@/lib/api';
import { GIT_STRATEGY_ACKS } from '@shared/run-settings.js';
import { useDraftPrelude } from './decisions';
import { Provenance } from './fields';
import { useSetupForm } from './form-context';

type GitAck = (typeof GIT_STRATEGY_ACKS)[number];

/** The two answers, in the operator's words. */
export const GIT_ACK_LABELS: Readonly<Record<GitAck, { name: string; says: string }>> = Object.freeze({
  honour: {
    name: 'Honour the plan',
    says: 'Give the run a checkout of its own where that makes the plan’s lines hold.',
  },
  override: {
    name: 'Override the plan',
    says: 'Run over the lines, and tell every session the branch it is really on.',
  },
});

/** Probe 7's rows, when the prelude reports any — empty for an older console or a plan that agrees. */
export function gitLinesOf(prelude: Prelude | undefined): GitStrategyLine[] {
  const detail = prelude?.probes['git-strategy']?.detail as { lines?: unknown } | undefined;
  return Array.isArray(detail?.lines) ? (detail.lines as GitStrategyLine[]) : [];
}

/** Can `honour` make every line hold? The door refuses it otherwise. */
export function honourable(lines: readonly GitStrategyLine[]): boolean {
  return lines.length > 0 && lines.every((line) => line.honourable);
}

export function GitReconcile() {
  const f = useSetupForm();
  const { data: prelude } = useDraftPrelude();
  if (!f.on('gitStrategyAck')) return null;
  const lines = gitLinesOf(prelude);
  if (!lines.length) return null;
  const canHonour = honourable(lines);
  const answer = f.values.gitStrategyAck;
  return (
    <section
      data-testid="git-reconcile"
      aria-labelledby="git-reconcile-title"
      className="flex min-w-0 flex-col gap-3 rounded-md border border-accent/50 p-3"
    >
      <h4 id="git-reconcile-title" className="flex items-center gap-2 text-sm font-medium text-ink">
        <GitCompare size={14} aria-hidden className="shrink-0 text-accent" />
        The plan’s git lines and this launch disagree
      </h4>
      <ul className="flex flex-col gap-2 text-sm">
        {lines.map((line) => (
          <li key={`${line.kind}:${line.plan}`} className="flex min-w-0 flex-col gap-0.5">
            <span className="min-w-0 break-words text-ink">
              The plan says <code className="font-mono text-xs">{line.plan}</code>
            </span>
            <span className="min-w-0 break-words text-xs text-ink-muted">
              This run: {line.run}
              {line.honourable ? '' : ' — no checkout of its own can make this line hold.'}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex min-w-0 flex-col gap-1">
        <span id="git-reconcile-choice" className="text-xs text-ink-muted">
          Plan git lines <Provenance source={f.src('gitStrategyAck')} />
        </span>
        <RadioGroup
          aria-label="Plan git lines"
          aria-describedby="git-reconcile-choice"
          value={answer}
          onValueChange={(next) => f.set('gitStrategyAck', next as GitAck)}
        >
          {GIT_STRATEGY_ACKS.map((ack) => {
            const refused = ack === 'honour' && !canHonour;
            return (
              <RadioItem
                key={ack}
                id={`git-ack-${ack}`}
                value={ack}
                disabled={refused}
                label={GIT_ACK_LABELS[ack].name}
                description={
                  refused
                    ? 'Not offered: a line above cannot hold in any checkout, and the start door refuses honour for it.'
                    : GIT_ACK_LABELS[ack].says
                }
              />
            );
          })}
        </RadioGroup>
        {!answer && <p className="text-2xs text-accent">Launch waits for this answer.</p>}
      </div>
    </section>
  );
}
