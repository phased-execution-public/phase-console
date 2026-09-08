/**
 * Plan from issues — the launch, on the run-setup field system.
 *
 * ## It EXTENDS the wizard, it does not fork a second launcher
 *
 * `RunSetup mode="plan"` is the same field set `features/sessions/wizard.tsx`
 * opens ("New plan with AI"), the same `buildLaunch` payload and the same
 * `intent: 'plan'` door. What this surface adds is the two things a wizard
 * cannot know: WHICH issues, and a brief written with them in front of you.
 * Forking a second launcher is how the console came to have four spellings of
 * "which model" before Phase 5, and `modes.ts` exists so it cannot happen again.
 *
 * ## Refs, not text
 *
 * The ticket carries `owner/repo#12` and nothing else. The server resolves each
 * ref against its own issue cache, composes the "Issues to solve" section
 * itself, and applies its own sanitiser to every GitHub-authored field — the
 * discipline three QA rounds of Phase 15 paid for. A client that pasted issue
 * TEXT into the brief would walk straight around all of it, and would also
 * spend the operator's 8 KB on somebody else's words.
 *
 * ## The gap between the ticket's fields and this dialog's
 *
 * `AGENT_TICKET_FIELDS` is the server's whole vocabulary for a session ticket,
 * and it covers three intents. `TICKET_FIELD_GAPS` below names every field this
 * dialog does not send and why, and `issues-launch.test.tsx` walks the two
 * against each other — so a field the server gains and this dialog cannot reach
 * is a failing test rather than a capability nobody notices is missing.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type TerminalState, type TerminalTicket } from '@/lib/api';
import { usePhone } from '@/lib/media';
import { keys, useApiMutation } from '@/lib/queries';
import { estimateTerminalSize } from '@/lib/terminal';
import { navigate } from '@/app/router';
import { Button, Dialog, DialogClose, DialogContent, Textarea } from '@/components/ui';
import { RunSetup } from '@/features/run-setup/run-setup';
import { SELECTION_MAX } from './issues';

/**
 * The textarea's `maxLength`, and the wizard's — 8 000 CHARACTERS.
 *
 * A coarse cap, and not the one that decides: `maxLength` counts UTF-16 code
 * units and the server counts BYTES.
 */
export const BRIEF_MAX = 8000;

/**
 * The server's actual ceiling — `MAX_BRIEF_BYTES` in `server/agent.ts`, which
 * answers `400 the brief is too long (8 KB max).` past it.
 *
 * Counted in bytes HERE too, because the two units disagree wherever the text
 * is not ASCII: ~4 100 Persian characters clear `maxLength` and are refused by
 * the server. That is the same "one click composes a refusal" shape as round
 * 1's High, arriving through the other end of the field, so it is closed the
 * same way — the dialog refuses what the server would, before the click.
 * (QA round 2, Low.)
 */
export const BRIEF_MAX_BYTES = 8192;

/** UTF-8 bytes, the way the server counts them. */
export const briefBytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * A plan session needs a brief, and the server is where that is enforced:
 * `agent.ts` answers `400 a plan session needs a brief.` on an empty one.
 *
 * QA round 1 (High): this dialog offered "Start authoring" with the textarea
 * untouched, so the one click the phase exists for produced a 400 — while the
 * sibling wizard blocked on exactly this condition. The rule is stated once,
 * here, and both the button and its reason read it.
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
 * Pure, and exported, for the reason `modes.ts` gives about its own builders: a
 * contract you can only exercise by rendering a dialog and clicking a button is
 * a contract nobody re-checks. The interesting part is the OMISSIONS — an empty
 * brief and an empty selection are both absences rather than empty values,
 * because a ticket that sends `issues: []` and one that sends nothing must not
 * be two different things to a server whose absent state IS "no issues".
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
 * with the reason. Each entry is a decision, not an omission — the test reads
 * this table and fails on a field that is in neither it nor the payload.
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

export interface IssuesLaunchProps {
  /** The selected refs, in the order they were picked. */
  issues: readonly string[];
  onClose: () => void;
  /** `--allow-agent`. Without it the console may not mint a session at all. */
  allowAgent: boolean;
  /** Whether `/api/skills` can be asked — it needs an open source directory. */
  rootOpen: boolean;
}

export function IssuesLaunchDialog({ issues, onClose, allowAgent, rootOpen }: IssuesLaunchProps) {
  const client = useQueryClient();
  const phone = usePhone();
  const [brief, setBrief] = useState('');
  const overCap = issues.length > SELECTION_MAX;

  const start = useApiMutation<Record<string, unknown>, TerminalTicket>({
    fn: (body) => api.agentTicket(body as never),
    invalidates: [keys.terminal()],
    onDone: (ticket) => {
      // Seeded from the ticket so the next render is right — the invalidation
      // above only confirms it, and is deliberately not awaited.
      if (ticket.session) {
        client.setQueryData(keys.terminal(), (prev: TerminalState | undefined) =>
          prev ? { ...prev, available: 'yes' as const, sessions: [...prev.sessions, ticket.session] } : prev,
        );
      }
      onClose();
      navigate(`sessions/${ticket.sessionId}`);
    },
  });

  const blockedReason = launchBlockedReason({
    allowAgent,
    rootOpen,
    issues,
    brief,
    pending: start.isPending,
  });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        title={`Author a plan from ${issues.length} issue${issues.length === 1 ? '' : 's'}`}
        description={
          'A Claude session opens in the Agent terminal and invokes the phased-execution skill’s ' +
          'plan mode. The console sends the issue REFS — the server reads each one from its own ' +
          'cache and composes the “Issues to solve” section, so your brief is never what gets cut.'
        }
      >
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-2xs uppercase tracking-wide text-ink-faint">Selected</p>
            <ul data-testid="launch-selection" className="mt-1 flex max-h-32 flex-wrap gap-1 overflow-y-auto">
              {issues.map((ref) => (
                <li key={ref} className="rounded border border-rule px-1.5 py-0.5 font-mono text-2xs">
                  {ref}
                </li>
              ))}
            </ul>
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-2xs uppercase tracking-wide text-ink-faint">The brief</span>
            <Textarea
              block
              className="min-h-28"
              placeholder="What should this plan achieve beyond closing these issues? Constraints, repos, anything the author must know."
              maxLength={BRIEF_MAX}
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
            />
          </label>

          {/* Stated where a Permissions select would be, and still not a
              control — `plan` mode offers none (`modes.ts`), and a row that
              simply vanished would read as one the form forgot. */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-2xs uppercase tracking-wide text-ink-faint">Permissions</span>
            <span
              className="text-ink-muted"
              title="Plan-authoring sessions always start in plan mode: the session explores and presents the plan for approval before anything is written."
            >
              plan mode — fixed for authoring
            </span>
          </div>

          {overCap && (
            <p className="text-sm text-accent" data-testid="launch-over-cap">
              A ticket carries at most {SELECTION_MAX} issues — {issues.length} are selected. Deselect{' '}
              {issues.length - SELECTION_MAX} and the launch opens.
            </p>
          )}
          {!allowAgent && (
            <p className="text-sm text-ink-muted" data-testid="launch-no-flag">
              This console runs without <code className="font-mono">--allow-agent</code>, so it may not start
              a session. Restart it with that flag to author a plan from here.
            </p>
          )}
          {!rootOpen && (
            <p className="text-sm text-ink-faint">
              Open a source directory first — the plan is written into its docs/plans/.
            </p>
          )}

          <RunSetup
            mode="plan"
            skillsEnabled={rootOpen}
            // `isPending` blocks too: minting is one POST and the dialog closes
            // on the answer, so a second press before it lands is a second
            // plan-authoring session nobody asked for.
            blocked={blockedReason !== undefined}
            {...(blockedReason !== undefined ? { blockedReason } : {})}
            onLaunch={(body: Record<string, unknown>) =>
              start.mutate(issuesTicket(body, { brief, issues, size: estimateTerminalSize(phone) }))
            }
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
