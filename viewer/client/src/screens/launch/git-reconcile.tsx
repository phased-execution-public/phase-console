/**
 * The plan's git lines against this launch (#18).
 *
 * Probe 7 (`server/prelude.ts` `probeGitStrategy`) names every git line of the
 * plan the chosen strategy will not honour — a `**Branch:**` the new-branch
 * strategy never creates, `Worktrees: on` in a checkout that cannot grant it,
 * a `Checkout: main` a shared checkout leaves inert — and the start door
 * refuses to launch over one until it is answered. This panel is where it is
 * answered: inside the Git category, and ONLY when the prelude reports a
 * difference, because an answer to a question nobody asked is noise.
 *
 * `honour` gives the run a checkout of its own where that makes the plan hold;
 * `override` runs over the lines and tells every session the branch it is
 * really on. A line isolation cannot fix is refused `honour` by the door, so
 * the choice is not offered for it.
 */

import { GitCompare } from 'lucide-react';
import type { GitStrategyLine } from '@/data/api';
import { cn } from '@/lib/cn';
import { RadioGroup, RadioItem } from '@/ui/radio-group';
import { GIT_STRATEGY_ACKS } from '@shared/run-settings.js';
import { gitLinesOf, useDraftPrelude } from './model/facts';
import { Provenance } from './fields';
import { useSetupForm } from './form-context';

// Probe 7's reader is the launch model's; the Git category reads it here.
export { gitLinesOf };

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
      // Unanswered, the panel holds Launch, so its leading edge is the summons;
      // answered, it is a choice on record and goes quiet.
      className={cn(
        'flex min-w-0 flex-col gap-3 border-s-2 ps-3',
        answer ? 'border-rule-strong' : 'state-needs-you border-state',
      )}
    >
      <h4
        id="git-reconcile-title"
        className="flex min-w-0 items-center gap-2 text-section font-semibold text-ink"
      >
        <GitCompare
          size={15}
          aria-hidden
          className={cn('shrink-0', answer ? 'text-ink-muted' : 'text-state')}
        />
        The plan’s git lines and this launch disagree
      </h4>
      <ul className="flex min-w-0 flex-col gap-2 text-body">
        {lines.map((line) => (
          <li key={`${line.kind}:${line.plan}`} className="flex min-w-0 flex-col gap-0.5">
            <span className="min-w-0 break-words text-ink">
              The plan says <code className="wrap-anywhere font-mono text-meta">{line.plan}</code>
            </span>
            <span className="min-w-0 break-words text-meta text-ink-muted">
              This run: {line.run}
              {line.honourable ? '' : ' — no checkout of its own can make this line hold.'}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex min-w-0 flex-col gap-1.5">
        <span
          id="git-reconcile-choice"
          className="flex min-w-0 flex-wrap items-baseline gap-x-3 text-meta text-ink-muted"
        >
          <span>Plan git lines</span> <Provenance source={f.src('gitStrategyAck')} />
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
        {!answer && <p className="text-meta text-state">Launch waits for this answer.</p>}
      </div>
    </section>
  );
}
