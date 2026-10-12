/**
 * What can be done to one session this console owns (7.0, quiet-console
 * phase 15) — the panel's Actions for an open session, and the verbs an
 * expanded row offers.
 *
 * Freeze is SIGSTOP to the session's process group, losing nothing; Continue
 * resumes it mid-token. Stop is the polite ladder — SIGTERM, a force-end only
 * after a grace it ignored — and the record STAYS: a stopped recovery still
 * has its outcome read against the board, and the `--resume` id survives.
 * Close is the kill with the record removed; Dismiss drops a record whose
 * process has already ended. Every verb goes through the one press door
 * (`data/sessions.ts` `useSessionActs`), whose answer is the list as it now is.
 *
 * The sentences under the controls are said, not hover titles: a phone's
 * finger cannot hover, and the panel is a sheet there.
 */

import { RotateCcw } from 'lucide-react';
import type { TerminalSession } from '@/data/api';
import { useSessionActs, type SessionActs } from '@/data/sessions';
import { elapsed } from '@/lib/format';
import { Button, ButtonGroup } from '@/ui';
import { ConfirmButton } from '@/ui/confirm';
import { CopyButton } from '@/ui/copy-button';

/**
 * What a freeze IS, and what ends it. A freeze is HELD, so the question it
 * raises is when it stops being held: past `escalateAt` it is stopped
 * gracefully, on the same clock a lane's freeze uses. A record written before
 * deadlines existed keeps the old sentence rather than inventing a time.
 */
export function frozenTitle(frozen: NonNullable<TerminalSession['frozen']>, now = Date.now()): string {
  const held = `Frozen by ${frozen.by}, ${elapsed(now - frozen.at)} ago — continues mid-token, in the same process`;
  const at = Date.parse(frozen.escalateAt ?? '');
  if (!Number.isFinite(at)) return held;
  return at <= now
    ? `${held}. Past its deadline — it is being stopped now.`
    : `${held}. Left frozen past ${new Date(at).toLocaleTimeString()} (${elapsed(at - now)} from now) it is stopped gracefully.`;
}

/** Freeze or Continue, and Stop — for a live session; nothing for an ended one. */
export function SessionControls({ session, acts }: { session: TerminalSession; acts?: SessionActs }) {
  const own = useSessionActs();
  const { busy, act } = acts ?? own;
  if (session.exited) return null;
  const frozen = session.frozen;
  const stopping = Boolean(session.stopping);
  const disabled = busy != null;
  return (
    <ButtonGroup aria-label={`${session.label} session controls`} data-testid="session-controls">
      {frozen ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          title={frozenTitle(frozen)}
          onClick={() => void act('thaw', session)}
        >
          {busy === 'thaw' ? 'Continuing…' : 'Continue'}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || stopping}
          title={
            stopping ? 'A stop is already in flight' : 'Stop its processes where they stand, losing nothing'
          }
          onClick={() => void act('freeze', session)}
        >
          {busy === 'freeze' ? 'Freezing…' : 'Freeze'}
        </Button>
      )}
      <ConfirmButton
        size="sm"
        variant="ghost"
        disabled={disabled || stopping}
        busy={busy === 'stop' || stopping}
        title={`Stop ${session.label}?`}
        confirmLabel="Stop the session"
        cancelLabel="Keep running"
        destructive
        description="It gets SIGTERM first, so the CLI shuts down properly; a force-end follows only after a 15-second grace it ignored. Unlike Close, the record stays in the list — a recovery or QA session stopped here still has its outcome checked, and its --resume id survives."
        onConfirm={() => void act('stop', session)}
      >
        {stopping ? 'Stopping…' : 'Stop'}
      </ConfirmButton>
    </ButtonGroup>
  );
}

/**
 * Every act on one open session, with what each does said beside it — the
 * panel's Actions tab. `onGone` is where the page goes once the record is
 * closed or dismissed; `onResume` starts a new claude on an ended
 * conversation, and is offered only where there is one to pick up.
 */
export function SessionActions({
  session,
  atCap,
  onGone,
  onResume,
}: {
  session: TerminalSession;
  /** The shared cap is reached — a resume would be refused, so it says so. */
  atCap: boolean;
  onGone: (id: string) => void;
  onResume?: (conversation: string) => void;
}) {
  const acts = useSessionActs();
  const { busy, act } = acts;
  const conversation = session.kind === 'claude' ? session.meta?.claudeSessionId : undefined;

  if (session.exited) {
    return (
      <div className="flex min-w-0 flex-col gap-4" data-testid="session-actions">
        {conversation && onResume && (
          <section className="flex min-w-0 flex-col gap-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Button size="sm" disabled={atCap} onClick={() => onResume(conversation)}>
                <RotateCcw size={14} aria-hidden /> Resume here
              </Button>
              <CopyButton text={`claude --resume ${conversation}`} label="Copy resume command" />
            </div>
            <p className="text-meta text-ink-muted">
              {atCap
                ? 'Close a live session first — the limit counts running sessions across shells and agents.'
                : 'Starts a new session that continues this conversation, with its history.'}
            </p>
          </section>
        )}
        <section className="flex min-w-0 flex-col gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            disabled={busy != null}
            onClick={() => void act('dismiss', session).then((done) => done && onGone(session.id))}
          >
            Dismiss
          </Button>
          <p className="text-meta text-ink-muted">Removes this ended session from the list.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="session-actions">
      <section className="flex min-w-0 flex-col gap-1.5">
        <SessionControls session={session} acts={acts} />
        <p className="text-meta text-ink-muted">
          {session.frozen
            ? frozenTitle(session.frozen)
            : 'Freeze stops the session’s processes where they stand (SIGSTOP), losing nothing; Continue resumes them mid-token.'}
        </p>
        <p className="text-meta text-ink-muted">
          Stop sends SIGTERM and force-ends only after a 15-second grace it ignored; the record — and a
          session’s resume id — stay in the list.
        </p>
      </section>
      <section className="flex min-w-0 flex-col gap-1.5">
        <ConfirmButton
          size="sm"
          variant="danger"
          className="self-start"
          disabled={busy != null}
          busy={busy === 'close'}
          title={`Close ${session.label}?`}
          confirmLabel="Close the session"
          cancelLabel="Keep it"
          destructive
          description="The process is killed and its record removed from the list. Stop is the gentle way, and keeps the record."
          onConfirm={() => void act('close', session).then((done) => done && onGone(session.id))}
        >
          Close
        </ConfirmButton>
        <p className="text-meta text-ink-muted">Kills the process and removes the record.</p>
      </section>
    </div>
  );
}
