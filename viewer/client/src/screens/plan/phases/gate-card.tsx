/**
 * The gate, as one card — mounted wherever a gated phase is shown (7.0,
 * quiet-console phase 10). `GateCard` is the card; `PhaseGate` is the same
 * card for a caller that knows a slug and a phase number and nothing else (the
 * phase drawer's diagnosis, the run page): it reads the phase, its gate status
 * and this console's write flag itself, and draws nothing for a phase with no
 * gate.
 *
 * A gate that is a person's ask TODAY — a manual gate on a phase the board
 * calls ready — is an item of Your turn (control-tower phase 139, #216): the
 * card wears the summons and draws that item's row (its one primary, and a
 * link to its place on the page) instead of a form of its own — one ask, one
 * shape. A gate nobody is asked about (an ai or auto gate, a phase not ready
 * yet) keeps the plan's own door to gate-status.md — approving ahead, or
 * revoking — which the engine reads and §Architecture 19 keeps.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Hand } from 'lucide-react';
import { api, type GateStatus, type PhaseView } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { useAttentionInbox } from '@/data/inbox';
import { keys } from '@/data/keys';
import { useGateStatus, usePlan } from '@/data/plans';
import { press } from '@/data/press';
import { useRun } from '@/data/runs';
import { asksNow, gateRow } from '@/data/turn';
import { cn } from '@/lib/cn';
import { Button, Input, KeyValue, Mono, toast } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { ConfirmButton } from '@/ui/confirm';
import { Markdown } from '@/ui/markdown';
import { OpsStatus } from '@/ui/status';
import { useInboxActions } from '@/cards/inbox-row';
import { LazyItemRow } from '@/cards/lazy-item-row';

/** Who can clear a gate the card draws — an ungated phase draws no card. */
type CardKind = Exclude<NonNullable<PhaseView['gateKind']>, 'none'>;

/** Who clears it, said once per kind. */
const KIND_HINT: Record<CardKind, string> = {
  human: 'A person does these steps, then approves. The autopilot holds this phase until then.',
  ai:
    'A booted session verifies these conditions itself, does the work to make them true and records the ' +
    'clearance before implementing. Approving here clears it too.',
  auto: 'The engine evaluates this check by itself. Approving overrides a stuck check.',
};

/**
 * The gate as a thing to act on, not a warning to read.
 *
 * Every kind shares the one door: an approval row in gate-status.md, which
 * `--gate-status` honours before anything else. A human gate carries its
 * numbered steps (the plan's own Gates bullet); an ai gate says the session
 * clears it itself; an auto gate shows the engine's live reading. Approving
 * asks first, because it widens what a run may do next.
 */
export function GateCard({
  slug,
  view,
  gate,
  allowWrites,
  scriptsDir = 'scripts',
}: {
  slug: string;
  view: PhaseView;
  gate?: GateStatus | undefined;
  allowWrites: boolean;
  /** Where `gate-approve.sh` lives on this machine, for the hand command. */
  scriptsDir?: string;
}) {
  const client = useQueryClient();
  const [note, setNote] = useState('');
  const [continueRun, setContinueRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const kind: CardKind = view.gateKind && view.gateKind !== 'none' ? view.gateKind : 'human';
  const approved = Boolean(gate?.clear && /^approved by /.test(gate.detail));
  const { data: inbox } = useAttentionInbox();
  const { perform, busy: acting } = useInboxActions();
  const item = approved ? undefined : gateRow(inbox?.items ?? [], slug, view.phase);
  // The summons is the ask itself: an item that asks a person NOW.
  const asked = item && asksNow(item) ? item : undefined;

  // "Continue the run" is offered only while this plan's run holds the phase
  // as gated — approving must never quietly resume a run stopped for another
  // reason.
  const { data: run } = useRun(slug, view.gated);
  const gatedRecord = run?.run?.phases?.[String(view.phase)]?.status === 'gated';

  const answerGate = async (approve: boolean) => {
    setBusy(true);
    try {
      const pressed = await press(() =>
        api.approveGate(slug, view.phase, {
          approve,
          note: note.trim() || undefined,
          continueRun: approve && gatedRecord && continueRun,
        }),
      );
      if (pressed.state === 'asked') toast(pressed.words, 'info');
      else setAnswer(pressed.result.detail);
    } catch (cause) {
      toast(
        cause instanceof Error && cause.message ? cause.message : 'The press failed and said nothing.',
        'error',
      );
    } finally {
      setBusy(false);
      // The phase, the list it sits on and the run parked on it — re-read on a
      // failure too: the commonest one is another console having answered first.
      for (const queryKey of keys.afterGate(slug)) void client.invalidateQueries({ queryKey });
    }
  };

  const command = `bash ${scriptsDir}/gate-approve.sh ${slug} ${view.phase}`;

  return (
    <section
      aria-label={`Gate on phase ${view.phase}`}
      data-testid="gate-card"
      data-summons={asked ? '' : undefined}
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-lg border border-rule bg-surface px-3 py-2.5',
        asked && 'state-needs-you border-s-2 border-s-state',
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {asked && (
          <span className="inline-flex items-center gap-1.5 text-meta font-medium text-state">
            <Hand size={13} aria-hidden className="shrink-0" />
            Needs you
          </span>
        )}
        <span className="text-body font-medium text-ink">
          {approved ? 'Gate approved' : gate?.clear ? 'Gate is clear' : 'Gates must clear first'}
        </span>
        <OpsStatus vocab="gate" word={kind} />
      </div>
      <p className="max-w-prose text-meta text-ink-muted">{KIND_HINT[kind]}</p>
      {view.gates && <Markdown text={view.gates} className="max-w-prose" />}
      <KeyValue
        items={[
          view.gateCheck ? ['Gate check', <Mono value={view.gateCheck} className="wrap-anywhere" />] : null,
          gate
            ? ['The engine reads', gate.clear ? `clear (${gate.detail})` : `${gate.kind}: ${gate.detail}`]
            : null,
        ]}
      />
      {kind === 'auto' && view.gateCheck?.startsWith('cmd ') && !gate?.clear && (
        <p className="max-w-prose text-meta text-ink-muted">
          The autopilot runs a cmd gate and this page never does, so the reading above is the directive
          unevaluated.
        </p>
      )}

      {asked ? (
        <LazyItemRow row={asked} perform={perform} {...(acting ? { busy: acting } : {})} />
      ) : allowWrites ? (
        <div className="flex min-w-0 flex-col gap-2">
          {approved ? (
            <div>
              <Button size="sm" disabled={busy} onClick={() => void answerGate(false)}>
                {busy ? 'Revoking' : 'Revoke the approval'}
              </Button>
            </div>
          ) : (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Input
                aria-label="Approval note"
                placeholder="What was done or verified"
                spellCheck={false}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                className="min-w-0 flex-1 basis-48"
              />
              {/* A question, not a second press of the same button: approving
                  widens what an unattended run may do next, and the dialog's
                  body is where that is said — a phone shows no title. */}
              <ConfirmButton
                size="sm"
                variant="primary"
                busy={busy}
                title="Approve this gate?"
                description={
                  <>
                    Records your approval, with your note, in{' '}
                    <Mono value={`docs/handoffs/${slug}/gate-status.md`} />. The runner checks the gate again
                    and boards the phase on its next pass. Nothing bypasses the gate: this is the gate being
                    answered.
                  </>
                }
                confirmLabel="Approve the gate"
                onConfirm={() => void answerGate(true)}
              >
                {busy ? 'Approving' : 'Approve the gate'}
              </ConfirmButton>
              {gatedRecord && (
                <label className="inline-flex items-center gap-2 text-meta text-ink">
                  <Checkbox checked={continueRun} onCheckedChange={(next) => setContinueRun(next === true)} />
                  Continue the run
                </label>
              )}
            </div>
          )}
          {/* The answer, in place; a failure is a toast. */}
          {answer && (
            <p role="status" className="max-w-prose text-meta text-ink-muted">
              {answer}
            </p>
          )}
        </div>
      ) : (
        <p className="min-w-0 max-w-prose text-meta text-ink-muted">
          {kind === 'human' ? 'Do the steps above, then approve the gate. ' : ''}
          Writes are off in this console: restart it with --allow-writes to approve here, or run{' '}
          <Mono copyable className="wrap-anywhere" value={command} /> from a terminal.
        </p>
      )}
    </section>
  );
}

/**
 * The card for a caller that knows only which phase it is looking at. The
 * plan and the gate status are already-cached reads on every surface that
 * mounts this, so the common case costs no request; a phase with no gate
 * draws nothing, so a caller mounts it unconditionally.
 */
export function PhaseGate({ slug, phase }: { slug: string; phase: number }) {
  const { data: plan } = usePlan(slug);
  const view = plan?.phases?.find((p) => p.phase === phase);
  const gated = Boolean(view && (view.gated || view.gates));
  const { data: gate } = useGateStatus(slug, view?.phase, gated);
  const { data: state } = useConsoleState();
  if (!view || !gated) return null;
  return (
    <GateCard
      slug={slug}
      view={view}
      gate={gate}
      allowWrites={Boolean(state?.allowWrites)}
      {...(state?.scriptsDir ? { scriptsDir: state.scriptsDir } : {})}
    />
  );
}
