/**
 * Plan from issues — the wizard's launch, with the issues it is about (7.0,
 * quiet-console phase 18).
 *
 * It is the session *New plan with AI* opens (`screens/plans/wizard.tsx`): the
 * one launch form in `plan` mode through the launch door, the same
 * `buildLaunch` payload and the same `intent: 'plan'` ticket. What this dialog
 * adds is the two things a wizard cannot know — WHICH issues, and a brief
 * written with them in front of you. A second launcher is how the console
 * once had four spellings of "which model", so it extends the one it has.
 *
 * The ticket carries refs (`owner/repo#12`) and never issue text: the server
 * resolves each ref against its own cache, composes the "Issues to solve"
 * section itself and sanitises every GitHub-authored field on the way. Text
 * pasted in here would walk around that sanitiser, and would spend the
 * operator's 8 KB on somebody else's words.
 *
 * `TICKET_FIELD_GAPS` names every ticket field this dialog does not send, and
 * why; `issues-launch.test.tsx` walks it against `AGENT_TICKET_FIELDS`, so a
 * field the server gains and this dialog cannot reach is a failing test rather
 * than a capability nobody notices is missing.
 *
 * The desk fetches this module when the launch is asked for: nothing on the
 * desk's first paint needs it.
 */

import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type TerminalState } from '@/data/api';
import { keys } from '@/data/keys';
import type { AgentLaunch } from '@/data/sessions';
import { plural } from '@/lib/format';
import { usePhone } from '@/lib/media';
import { estimateTerminalSize } from '@/lib/terminal';
import { Banner, Button, Label, Mono, Spinner } from '@/ui';
import { Dialog, DialogClose, DialogContent } from '@/ui/dialog';
import { Textarea } from '@/ui/textarea';
import { useNavigate } from '@/shell/router';
import { sessionsHref } from '@/shell/routes';
import { LaunchForm } from '@/screens/launch/door';
import { BRIEF_MAX, BRIEF_MAX_BYTES, SELECTION_MAX, briefBytes } from './issues';

// The brief's limits live with the desk's rows, so the compose sheet reads them
// without pulling this dialog into the desk's first chunk; they are said here
// too, where the launch's own tests have always found them.
export { BRIEF_MAX, BRIEF_MAX_BYTES, briefBytes };

/**
 * Everything the server would refuse, refused before the press — in the words
 * the dialog says beside Launch. A plan session needs a brief (`agent.ts`
 * answers `400 a plan session needs a brief.` on an empty one), so the one
 * press this dialog exists for never composes a 400.
 */
export function launchBlockedReason(input: {
  allowAgent: boolean;
  rootOpen: boolean;
  issues: readonly string[];
  brief: string;
  pending: boolean;
}): string | undefined {
  if (input.pending) return 'Starting the session…';
  if (!input.allowAgent) return 'This console was started without --allow-agent.';
  if (!input.rootOpen) return 'Open a source directory first — the plan is written into its docs/plans/.';
  if (input.issues.length === 0) return 'Select at least one issue.';
  if (input.issues.length > SELECTION_MAX) return `At most ${SELECTION_MAX} issues per ticket.`;
  if (!input.brief.trim()) return 'Write the brief first — it is what the session is given.';
  const bytes = briefBytes(input.brief.trim());
  if (bytes > BRIEF_MAX_BYTES) {
    return `The brief is ${bytes} bytes; the server takes ${BRIEF_MAX_BYTES}. Shorten it.`;
  }
  return undefined;
}

/**
 * What this dialog composes on top of `buildLaunch(values, 'plan', …)`.
 *
 * Pure, so the contract is checked without rendering a dialog. The point is
 * the OMISSIONS: an empty brief and an empty selection are absences, never
 * empty values, because a ticket that sends `issues: []` and one that sends
 * nothing must not be two different things to a server whose absent state IS
 * "no issues".
 */
export function issuesTicket(
  launch: Record<string, unknown>,
  {
    brief,
    issues,
    size,
  }: { brief: string; issues: readonly string[]; size?: { cols: number; rows: number } },
): Record<string, unknown> {
  const trimmed = brief.trim();
  return {
    ...launch,
    intent: 'plan' as const,
    ...(trimmed ? { brief: trimmed } : {}),
    ...(issues.length ? { issues: [...issues] } : {}),
    ...(size ?? {}),
  };
}

/**
 * Every `AGENT_TICKET_FIELDS` member this dialog deliberately does not send,
 * with the reason. Each entry is a decision: the test fails on a field that is
 * in neither this table nor the payload.
 */
export const TICKET_FIELD_GAPS: Readonly<Record<string, string>> = Object.freeze({
  slug: 'A plan-authoring ticket has no plan yet — writing one is what it is for. `slug` names an EXISTING plan and belongs to the qa and recovery intents.',
  phase:
    'Same: there is no phase to review or repair. A plan-from-issues session authors the phases this field would later name.',
  runId: 'A recovery names the run it is repairing. Nothing here is repairing a run.',
  recoveryClass: 'Recovery vocabulary. This ticket is not a recovery.',
  activate:
    'Turns a plan’s QA gate on as part of a QA review. There is no plan to turn it on for; the plan this session writes declares its own `**QA gate:**` line.',
  permissionProfile:
    'Deliberately absent, and the same choice `modes.ts` records for the wizard: a plan-authoring session always starts in plan mode, so it presents the graph for approval before writing. A profile chosen here could write a plan nobody approved.',
  permissionMode: 'The CLI spelling of the same thing, absent for the same reason.',
  prompt:
    'A session’s first typed message. This ticket sends a `brief` instead — the server composes the boot prompt from it, the skill’s own plan mode, and the resolved issues.',
  resume: 'Picks up an existing conversation. A launch from a fresh selection has none.',
});

/** A refusal in the server's own words; the honest floor when it said nothing. */
const refusalWords = (cause: unknown): string =>
  cause instanceof Error && cause.message ? cause.message : 'The press failed and said nothing.';

export interface IssuesLaunchProps {
  /** The selected refs, in the order they were picked. */
  issues: readonly string[];
  onClose: () => void;
  /** `--allow-agent`: without it the console may not start a session at all. */
  allowAgent: boolean;
  /** Whether a source directory is open — the plan is written into it, and the skill list is read from it. */
  rootOpen: boolean;
}

export function IssuesLaunchDialog({ issues, onClose, allowAgent, rootOpen }: IssuesLaunchProps) {
  const client = useQueryClient();
  const phone = usePhone();
  const navigate = useNavigate();
  const ids = useId();
  const [brief, setBrief] = useState('');
  const [starting, setStarting] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const over = issues.length - SELECTION_MAX;
  const blockedReason = launchBlockedReason({ allowAgent, rootOpen, issues, brief, pending: starting });

  const start = async (body: Record<string, unknown>) => {
    setStarting(true);
    setRefusal(null);
    try {
      const ticket = await api.agentTicket(
        issuesTicket(body, {
          brief,
          issues,
          // The size the pane will settle on: the CLI lays its first screen
          // out for the window it is in.
          size: estimateTerminalSize(phone),
        }) as AgentLaunch,
      );
      // Seeded from the ticket so the next render is right; the re-read only confirms it.
      if (ticket.session) {
        client.setQueryData(keys.terminal(), (prev: TerminalState | undefined) =>
          prev
            ? {
                ...prev,
                available: 'yes' as const,
                sessions: [...prev.sessions.filter((one) => one.id !== ticket.session.id), ticket.session],
              }
            : prev,
        );
      }
      void client.invalidateQueries({ queryKey: keys.terminal() });
      onClose();
      navigate(sessionsHref(ticket.sessionId));
    } catch (failure) {
      // Kept beside Launch until the next press: a toast would take the
      // server's answer away before it was read.
      setRefusal(refusalWords(failure));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        title={`Author a plan from ${plural(issues.length, 'issue')}`}
        description="A Claude session writes the plan with you in the terminal, in the skill’s plan mode: it shows the phase list for your approval before anything is written. The console sends the issues’ references and the server reads each one from its own cache, so your brief is never what gets cut."
      >
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <p id={`${ids}-issues`} className="text-body font-medium text-ink">
              The issues
            </p>
            <ul
              aria-labelledby={`${ids}-issues`}
              data-testid="launch-selection"
              className="flex min-w-0 flex-wrap gap-x-3 gap-y-1"
            >
              {issues.map((ref) => (
                <li key={ref} className="min-w-0 wrap-anywhere">
                  <Mono value={ref} />
                </li>
              ))}
            </ul>
          </div>

          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor={`${ids}-brief`}>The brief</Label>
            <Textarea
              id={`${ids}-brief`}
              block
              rows={5}
              maxLength={BRIEF_MAX}
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              placeholder="What should this plan achieve beyond closing these issues? Constraints, repositories, anything the author must know."
              data-testid="launch-brief"
            />
          </div>

          {/* Said where a select would be, and still not a control: `plan` mode
              offers no permission field, and a form that omitted the row would
              read as one that forgot it. */}
          <p className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-body">
            <span className="text-ink-muted">Permissions</span>
            <span
              className="text-ink"
              title="A plan-writing session always starts in plan mode: it explores and presents the plan for approval before anything is written."
            >
              plan mode — fixed for authoring
            </span>
          </p>

          {over > 0 && (
            <p className="max-w-(--measure) text-body text-ink" data-testid="launch-over-cap">
              A ticket carries at most {SELECTION_MAX} issues, and {issues.length} are selected. Deselect{' '}
              {over} and the launch opens.
            </p>
          )}
          {!allowAgent && (
            <p className="max-w-(--measure) text-body text-ink-muted" data-testid="launch-no-flag">
              This console runs without <Mono value="--allow-agent" />, so it may not start a session. Restart
              it with that flag to author a plan from here.
            </p>
          )}
          {!rootOpen && (
            <p className="max-w-(--measure) text-body text-ink-muted">
              Open a source directory first — the plan is written into its docs/plans/.
            </p>
          )}

          <LaunchForm
            fallback={<Spinner label="Loading the session options" />}
            mode="plan"
            skillsEnabled={rootOpen}
            // Starting blocks too: the press is one POST and the dialog closes
            // on its answer, so a second press before it lands is a second
            // session nobody asked for.
            blocked={blockedReason !== undefined}
            blockedReason={blockedReason}
            footerNote={
              refusal ? (
                <Banner severity="error" role="alert" data-testid="launch-refused">
                  {refusal}
                </Banner>
              ) : undefined
            }
            onLaunch={(body: Record<string, unknown>) => void start(body)}
            cancel={
              <DialogClose asChild>
                <Button variant="ghost">Cancel</Button>
              </DialogClose>
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
