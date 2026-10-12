/**
 * New plan with AI — a brief becomes a plan-authoring Claude session (7.0,
 * quiet-console phase 9; the wizard since control-tower).
 *
 * The server owns the boot prompt (`server/agent.ts` — the skill's own plan
 * mode, as steps); this dialog collects the brief and the session's options,
 * mints `{intent: 'plan'}` and lands on the session's terminal, where the
 * person answers the model's questions and approves the phase list. The plan
 * file appearing on disk reaches the library through the ordinary `changed`
 * event. The ticket is the 6.2 wizard's, byte for byte: the fields are the one
 * launch form's in `plan` mode (`LaunchForm`, through the launch door),
 * the brief, and the size the pane will open at — and NO permission mode,
 * because a plan intent is plan mode and the omission is the choice.
 *
 * Gated on the AGENT capability, not on writes: the session writes the plan,
 * the console writes nothing. The dialog is its own chunk, and the form inside
 * it another, so the library carries neither until somebody asks.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type TerminalState } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { keys } from '@/data/keys';
import { usePhone } from '@/lib/media';
import { estimateTerminalSize } from '@/lib/terminal';
import { Button, Spinner, toast } from '@/ui';
import { Dialog, DialogClose, DialogContent } from '@/ui/dialog';
import { Textarea } from '@/ui/textarea';
import { useNavigate } from '@/shell/router';
import { sessionsHref } from '@/shell/routes';
import { LaunchForm } from '@/screens/launch/door';

/** The brief's ceiling — what the server accepts for one. */
const BRIEF_MAX = 8000;

export function NewPlanWizard({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const phone = usePhone();
  const navigate = useNavigate();
  const { data: state } = useConsoleState();
  const rootOpen = Boolean(state?.root?.path);
  const [brief, setBrief] = useState('');
  const [starting, setStarting] = useState(false);

  const start = async (body: Record<string, unknown>) => {
    setStarting(true);
    try {
      const ticket = await api.agentTicket({
        ...body,
        intent: 'plan',
        brief: brief.trim(),
        // The size the pane will settle on — the CLI lays its first screen out
        // for the window it is in (the pane corrects it on open).
        ...estimateTerminalSize(phone),
      } as Parameters<typeof api.agentTicket>[0]);
      // Seeded from the ticket so the next render is right; the invalidation
      // only confirms it.
      if (ticket.session) {
        client.setQueryData(keys.terminal(), (prev: TerminalState | undefined) =>
          prev ? { ...prev, available: 'yes' as const, sessions: [...prev.sessions, ticket.session!] } : prev,
        );
      }
      void client.invalidateQueries({ queryKey: keys.terminal() });
      onClose();
      navigate(sessionsHref(ticket.sessionId));
    } catch (failure) {
      toast(String((failure as Error).message ?? failure), 'error');
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
        title="New plan with AI"
        description="A Claude session writes the plan with you: it shows the phase list for your approval first, then writes docs/plans/<slug>.md, checks it and commits. You answer its questions in the terminal."
      >
        <div className="flex min-w-0 flex-col gap-4">
          <label className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
            What should this plan achieve?
            <Textarea
              block
              rows={6}
              maxLength={BRIEF_MAX}
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              placeholder="What should this plan achieve? Constraints, repositories, anything the author must know."
              data-testid="wizard-brief"
            />
          </label>

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

          {!rootOpen && (
            <p className="text-body text-ink-muted">
              Open a source directory first — the plan is written into its docs/plans/.
            </p>
          )}

          <LaunchForm
            fallback={<Spinner label="Loading the session options" />}
            mode="plan"
            skillsEnabled={rootOpen}
            // Pending blocks too: a second press before the answer lands is a
            // second session nobody asked for.
            blocked={!brief.trim() || !rootOpen || starting}
            blockedReason={
              starting
                ? 'Starting the session…'
                : rootOpen
                  ? 'Write the brief first — it is what the session is given.'
                  : undefined
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

/** The library's way into the wizard — nothing at all without the agent capability. */
export function NewPlanWizardButton({
  allowAgent,
  variant = 'primary',
}: {
  allowAgent: boolean;
  variant?: 'primary' | 'default' | 'ghost';
}) {
  const [open, setOpen] = useState(false);
  if (!allowAgent) return null;
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>
        New plan with AI
      </Button>
      {open && <NewPlanWizard onClose={() => setOpen(false)} />}
    </>
  );
}

export default NewPlanWizard;
