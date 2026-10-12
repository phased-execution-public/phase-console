/**
 * What a session page says once the session is over (7.0, quiet-console
 * phase 15; the two states since 3.0).
 *
 *  - **ended** — the record is still here, so the scrollback below is still
 *    real: what it exited with and when, and for a claude session the
 *    `--resume` id that is the whole point of keeping the record.
 *  - **gone** — the record is not here: dismissed, or retired after a day.
 *    Said plainly, with the way back, never a redirect that reads as a tap
 *    that did nothing.
 */

import { RotateCcw } from 'lucide-react';
import type { TerminalSession } from '@/data/api';
import { relativeTime } from '@/lib/format';
import { sessionsHref, sessionsNewHref } from '@/shell/routes';
import { Banner, Button, Empty } from '@/ui';
import { CopyButton } from '@/ui/copy-button';

/** How it ended, in words rather than a number a reader has to interpret. */
export function exitSummary(session: TerminalSession): string {
  const { code = 0, signal, closedByOperator } = session.exited ?? {};
  if (closedByOperator) return 'you closed it';
  if (signal) return `killed by signal ${signal}`;
  return code === 0 ? 'exited cleanly' : `exited with code ${code}`;
}

export function EndedBanner({
  session,
  atCap,
  onResume,
  onDismiss,
  busy = false,
}: {
  session: TerminalSession;
  atCap: boolean;
  /** Claude sessions only — a shell has no conversation to pick up. */
  onResume?: (conversation: string) => void;
  onDismiss: (id: string) => void;
  busy?: boolean;
}) {
  const conversation = onResume ? session.meta?.claudeSessionId : undefined;
  const failed = (session.exited?.code ?? 0) !== 0 || session.exited?.signal != null;
  return (
    <Banner
      severity={failed && !session.exited?.closedByOperator ? 'error' : 'info'}
      data-testid="session-ended"
      className="mx-(--pad-x) mt-2 shrink-0"
      action={
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          {conversation && (
            <>
              <Button size="sm" disabled={atCap || busy} onClick={() => onResume?.(conversation)}>
                <RotateCcw size={14} aria-hidden /> Resume here
              </Button>
              <CopyButton text={`claude --resume ${conversation}`} label="Copy resume command" />
            </>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDismiss(session.id)}>
            Dismiss
          </Button>
        </span>
      }
    >
      This session {exitSummary(session)}
      {session.exitedAt ? ` ${relativeTime(session.exitedAt)}` : ''}.
      {/* Said, not only titled: a finger cannot hover a disabled button. */}
      {conversation && atCap ? ' Close a live session first to resume it.' : ''}
    </Banner>
  );
}

export function SessionGone({ kind }: { kind: 'shell' | 'claude' }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-(--pad-x) py-(--pad-y)">
      <Empty
        data-testid="session-gone"
        title="That session is not here any more: it was dismissed, or it ended over a day ago and its record was retired."
        action={
          <>
            <Button size="sm" asChild>
              <a href={sessionsNewHref(kind === 'claude' ? 'agent' : 'shell')}>
                {kind === 'claude' ? 'Start a new session' : 'Open a new shell'}
              </a>
            </Button>
            <Button size="sm" variant="ghost" asChild>
              <a href={sessionsHref()}>Every session</a>
            </Button>
          </>
        }
      />
    </div>
  );
}
