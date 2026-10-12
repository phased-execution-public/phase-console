/**
 * The honest state for a launch on a console that cannot start one. The review
 * itself is the departure notice's: the departure line and its route open it,
 * every boarding finding is a line with its own action, and what differs from
 * a fresh console closes it.
 */

import { useConsoleState } from '@/data/console';
import { composeStartCommand } from '@/lib/start-command';
import { Banner } from '@/ui';
import { CopyButton } from '@/ui/copy-button';

/**
 * The honest state for a console that cannot start a run: it says so, and
 * offers the line that would. It stands above the whole form, because a form
 * that lets somebody fill in every category before telling them the button is
 * off is a form that wasted their time.
 */
export function NoAllowRun() {
  const { data: state } = useConsoleState();
  const command = composeStartCommand(state ?? {});
  return (
    <Banner severity="warn">
      <p className="max-w-(--measure)">
        <strong className="font-semibold">This console cannot start runs.</strong> It was started without{' '}
        <code className="font-mono">--allow-run</code>, so Launch is off here. Restart it with every
        capability on:
      </p>
      <span className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 wrap-anywhere rounded bg-ground px-2 py-1 font-mono text-meta text-ink">
          {command}
        </code>
        <CopyButton text={command} label="Copy the command" copiedLabel="Copied" />
      </span>
    </Banner>
  );
}
