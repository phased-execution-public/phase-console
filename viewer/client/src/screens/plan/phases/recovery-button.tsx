/**
 * Start a recovery for a phase, or go to the one already running.
 *
 * Three states and no fourth: a live session is a link, a permitted console is
 * a button, and a console without `--allow-agent` is a disabled button that
 * says which flag turns it on. Never simply absent — a remedy that exists and
 * is unavailable has to say so, or the row is a dead end.
 *
 * Pressing it opens the launch form rather than firing at once: model, effort
 * and skills are choices, and a session minted on one press is a session
 * nobody got to shape. The button owns its dialog, so a caller names only the
 * target.
 */

import { useState } from 'react';
import { Bot } from 'lucide-react';
import { Button } from '@/ui';
import { LaunchDoor } from '@/screens/launch/door';
import { sessionsHref } from '@/shell/routes';
import { RECOVERY_BLURBS, RECOVERY_LABELS, type RecoveryClass } from '@/lib/recovery';

export function RecoveryButton({
  kind,
  allowAgent,
  runningSessionId,
  target,
}: {
  kind: RecoveryClass;
  allowAgent: boolean;
  runningSessionId?: string;
  /** What the recovery is about — the form and the ticket both need it. */
  target: { slug: string; phase?: number; runId?: string };
}) {
  const [open, setOpen] = useState(false);
  if (runningSessionId) {
    return (
      <Button size="sm" asChild>
        <a href={sessionsHref(runningSessionId)}>
          <Bot size={13} aria-hidden /> Recovery running
        </a>
      </Button>
    );
  }
  return (
    <>
      <Button
        size="sm"
        className="h-auto shrink whitespace-normal"
        disabled={!allowAgent}
        title={
          allowAgent
            ? RECOVERY_BLURBS[kind]
            : 'Agent sessions are disabled. Restart the console with --allow-agent.'
        }
        onClick={() => setOpen(true)}
      >
        <Bot size={13} aria-hidden /> {RECOVERY_LABELS[kind]}
      </Button>
      {open && (
        <LaunchDoor
          request={{
            kind: 'recovery',
            recoveryClass: kind,
            slug: target.slug,
            ...(target.phase != null ? { phase: target.phase } : {}),
            ...(target.runId ? { runId: target.runId } : {}),
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
