/**
 * The launch door for a session (7.0, quiet-console phase 15): what
 * `?new=agent` and `?new=shell` open, and the two presses that start one.
 *
 * A shell is one press — there is nothing to choose before the pty exists, so
 * the button starts it and lands on it. A Claude session has choices that must
 * exist before the process does (model, effort, permissions, the first
 * prompt, the skills, the account), so its door is a page: the one launch
 * form in `session` mode, the same fields the run page and the plan wizard
 * draw, through the launch door (`LaunchForm`). The server
 * re-validates every field against the runner's own lists (`server/agent.ts`),
 * so the form is convenience, never the wall; `bypassPermissions` is not
 * offered here and is refused there.
 *
 * Every start is born at the size the pane will settle on, so nothing lays
 * its first screen out at 80×24 for a window it is not in.
 */

import { useCallback } from 'react';
import { useConsoleState } from '@/data/console';
import { useSessionStart, useTerminals } from '@/data/sessions';
import { usePhone } from '@/lib/media';
import { estimateTerminalSize } from '@/lib/terminal';
import { Button, Empty, Page, Spinner } from '@/ui';
import { useNavigate } from '@/shell/router';
import { sessionsHref } from '@/shell/routes';
import { AGENT_FLAG_REFUSAL } from './foreign';
import { LaunchForm } from '@/screens/launch/door';
import { capOf, capWords } from './sections';

/** What a Claude session is started with — enum choices, a bounded prompt, nothing executable. */
export interface LaunchBody {
  model?: string;
  effort?: string;
  permissionMode?: string;
  prompt?: string;
  skills?: string[];
  /** A conversation to pick up — what Resume and Take over send. */
  resume?: string;
  /** Which registered account the session spends. Absent = the machine login. */
  accountId?: string;
}

const SHELL_OFF = 'This console opens no shells (no --allow-terminal).';

/** What every door to a pty says when the console cannot open one — the 6.2 sentence, kept. */
export const NO_TERMINAL =
  'No terminal is available: node-pty did not load, so this console cannot open one. Run npm install in the viewer directory and restart; the rest of the console is unaffected.';

/** Open a shell at the size its pane will settle on, and land on it. */
export function useOpenShell(): { open: () => void; busy: boolean } {
  const phone = usePhone();
  const navigate = useNavigate();
  const { busy, openShell } = useSessionStart();
  const open = useCallback(() => {
    void openShell(estimateTerminalSize(phone)).then((ticket) => {
      if (ticket) navigate(sessionsHref(ticket.sessionId));
    });
  }, [openShell, phone, navigate]);
  return { open, busy: busy === 'shell' };
}

/** Start a Claude session — a new one, or one that resumes a conversation — and land on it. */
export function useLaunch(): { launch: (body: LaunchBody) => void; busy: boolean } {
  const phone = usePhone();
  const navigate = useNavigate();
  const { busy, startAgent } = useSessionStart();
  const launch = useCallback(
    (body: LaunchBody) => {
      void startAgent({ ...body, ...estimateTerminalSize(phone) }).then((ticket) => {
        if (ticket) navigate(sessionsHref(ticket.sessionId));
      });
    },
    [startAgent, phone, navigate],
  );
  return { launch, busy: busy === 'agent' };
}

const back = (
  <Button size="sm" variant="ghost" asChild>
    <a href={sessionsHref()}>Every session</a>
  </Button>
);

/** `?new=agent` — the form, for every choice that must exist before the pty does. */
export function NewSessionPage() {
  const { data: state } = useConsoleState();
  const allowAgent = state?.allowAgent === true;
  const root = state?.root?.path;
  const { data: terminals } = useTerminals(allowAgent);
  const { atCap, limit } = capOf(terminals);
  const { launch, busy } = useLaunch();

  return (
    <Page
      title="New session"
      lead={`Claude Code in a terminal, running in ${root ?? 'your home directory'}. You approve its actions in the terminal itself.`}
      actions={back}
      data-testid="session-launcher"
    >
      {!allowAgent ? (
        <Empty title={AGENT_FLAG_REFUSAL} />
      ) : terminals?.available === 'no' ? (
        <Empty title={NO_TERMINAL} />
      ) : (
        <div className="flex min-w-0 max-w-2xl flex-col gap-3">
          <LaunchForm
            fallback={<Spinner label="Loading the session options" />}
            mode="session"
            skillsEnabled={Boolean(root)}
            // Pending blocks too: a second press before the answer lands is a
            // second session nobody asked for.
            blocked={atCap || busy}
            {...(atCap
              ? { blockedReason: capWords(limit) }
              : busy
                ? { blockedReason: 'Starting the session…' }
                : {})}
            onLaunch={(body: Record<string, unknown>) => launch(body as LaunchBody)}
          />
          {!root && (
            <p className="text-meta text-ink-muted">
              Open a source directory to pick skills for the session.
            </p>
          )}
        </div>
      )}
    </Page>
  );
}

/** `?new=shell` — a shell asked for by name: one press away, and where it will start. */
export function NewShellPage() {
  const { data: state } = useConsoleState();
  const allowTerminal = state?.allowTerminal === true;
  const { data: terminals } = useTerminals(allowTerminal);
  const { atCap, limit } = capOf(terminals);
  const shell = useOpenShell();
  return (
    <Page title="New shell" actions={back} data-testid="shell-launcher">
      {!allowTerminal ? (
        <Empty title={SHELL_OFF} />
      ) : terminals?.available === 'no' ? (
        <Empty title={NO_TERMINAL} />
      ) : (
        <Empty
          title={
            atCap
              ? capWords(limit)
              : `No shell is open. A new one starts in ${state?.root?.path ?? 'your home directory'}.`
          }
          action={
            <Button variant="primary" disabled={atCap || shell.busy} onClick={shell.open}>
              {shell.busy ? 'Opening a shell…' : 'Open a shell'}
            </Button>
          }
        />
      )}
    </Page>
  );
}
