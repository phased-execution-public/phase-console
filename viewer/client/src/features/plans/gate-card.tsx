/**
 * The gate, as one component — mounted wherever a gated phase is shown.
 *
 * It used to live inside the plan's phase panel, which meant the gate could
 * only be answered from the one page that happened to render it. An operator
 * watching a run park on a human gate had to leave the autopilot, find the
 * plan, open the phase and approve there — and the errand the runner had just
 * written told them to do exactly that, in prose, because there was no button
 * within reach.
 *
 * So the card moved here and nothing was copied: `GateCard` is the same
 * presentational component the plan page always rendered, and `PhaseGate` is
 * the self-resolving form for callers that hold a slug and a phase number and
 * nothing else — the run page, its phase drawer, the halt card. One mutation,
 * one set of invalidations, one piece of copy per gate kind.
 */

import { useState } from 'react';
import { Banner, Button, Checkbox, Chip, ConfirmButton, field } from '@/components/ui';
import { Markdown } from '@/components/markdown';
import { api } from '@/lib/api';
import { keys, useApiMutation, useConsoleState, useGateStatus, usePlan, useRun } from '@/lib/queries';
import { cn } from '@/lib/cn';
import type { GateStatus, PhaseView } from '@/lib/api';

/** Gate copy per category — who can clear it, said once. */
const GATE_KIND_COPY: Record<'human' | 'ai' | 'auto', { label: string; hint: string }> = {
  human: {
    label: 'human gate',
    hint: 'A person does these steps, then approves — the autopilot holds this phase until then.',
  },
  ai: {
    label: 'ai gate',
    hint:
      'A booted session verifies these conditions itself, does the work to make them true, ' +
      'and records the clearance before implementing. Approving here also clears it.',
  },
  auto: {
    label: 'auto gate',
    hint: 'The engine evaluates this check by itself. Approving overrides a stuck check.',
  },
};

/**
 * The gate, as a thing you can act on — not just a warning to read.
 *
 * Every gate kind shares the one door: an approval row in gate-status.md,
 * which `--gate-status` honours before anything else. Human gates carry their
 * numbered operator steps (the plan's own Gates bullet, rendered as markdown);
 * ai gates say the session will clear them itself; auto gates show the live
 * verdict. The Approve button asks twice — it widens what a run may do.
 */
export function GateCard({
  slug,
  view,
  gate,
  allowWrites,
}: {
  slug: string;
  view: PhaseView;
  gate?: GateStatus;
  allowWrites: boolean;
}) {
  const [note, setNote] = useState('');
  const [continueRun, setContinueRun] = useState(true);
  const kind = view.gateKind && view.gateKind !== 'none' ? view.gateKind : 'human';
  const copy = GATE_KIND_COPY[kind];
  const approved = Boolean(gate?.clear && /^approved by /.test(gate.detail));

  // The continue-the-run offer appears only when this plan's run actually
  // holds the phase as gated — approving must not silently resume a run the
  // operator stopped for unrelated reasons.
  const { data: run } = useRun(slug, view.gated);
  const gatedRecord = run?.run?.phases?.[String(view.phase)]?.status === 'gated';

  // A gate moves the phase, the list it sits on and the run that was parked on
  // it — `afterGate` is exactly those three, and it re-reads on a failure too,
  // because the commonest failure here is another console having answered first.
  const mutation = useApiMutation<boolean, { detail: string }>({
    fn: (approve) =>
      api.approveGate(slug, view.phase, {
        approve,
        note: note.trim() || undefined,
        continueRun: approve && gatedRecord && continueRun,
      }),
    invalidates: keys.afterGate(slug),
  });

  return (
    <Banner severity={approved || gate?.clear ? 'info' : 'warn'}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <strong>
            {approved ? 'Gate approved.' : gate?.clear ? 'Gate is clear.' : 'Gates must clear first.'}
          </strong>
          <Chip tone="gate">{copy.label}</Chip>
        </div>
        <p className="mt-0.5 text-2xs text-ink-muted">{copy.hint}</p>
        {view.gates && <Markdown text={view.gates} />}
        {(view.gateCheck || gate) && (
          <div className="mt-1 font-mono text-2xs">
            {view.gateCheck && <>gate-check: {view.gateCheck}</>}
            {gate && (
              <>
                {view.gateCheck ? ' — ' : ''}
                {gate.clear ? `clear (${gate.detail})` : `${gate.kind}: ${gate.detail}`}
              </>
            )}
          </div>
        )}
        {kind === 'auto' && view.gateCheck?.startsWith('cmd ') && !gate?.clear && (
          <p className="mt-1 text-2xs text-ink-faint">
            cmd gates are executed by the autopilot, never by this page — the verdict above shows the
            directive unevaluated.
          </p>
        )}

        {allowWrites ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {!approved && (
              <>
                {/* The shared control class, on the card's own background —
                    the note is a form field like any other, and its old local
                    spelling was the fourth copy of that string. */}
                <input
                  value={note}
                  placeholder="note — what was done or verified"
                  spellCheck={false}
                  onChange={(event) => setNote(event.target.value)}
                  className={cn(field, 'flex-1 basis-48 font-mono text-2xs placeholder:text-ink-faint')}
                />
                {/* A dialog, not a second press of the same button. Approving
                    widens what an unattended run may do next, and "press again"
                    said none of that — the whole explanation was in a `title`,
                    which a phone never shows. */}
                <ConfirmButton
                  size="sm"
                  busy={mutation.isPending}
                  busyLabel="Approving…"
                  title="Approve this gate?"
                  description={
                    'Records your approval in docs/handoffs/<slug>/gate-status.md with your note — ' +
                    'the runner re-checks the gate and boards the phase on its next pass. ' +
                    'Nothing bypasses the gate; this IS the gate being answered.'
                  }
                  confirmLabel="Approve gate"
                  onConfirm={() => mutation.mutate(true)}
                >
                  Approve gate
                </ConfirmButton>
                {gatedRecord && (
                  <label className="flex items-center gap-1.5 text-2xs text-ink-muted">
                    <Checkbox
                      checked={continueRun}
                      onCheckedChange={(next) => setContinueRun(next === true)}
                    />
                    continue the run
                  </label>
                )}
              </>
            )}
            {approved && (
              <Button
                size="sm"
                variant="ghost"
                disabled={mutation.isPending}
                onClick={() => mutation.mutate(false)}
              >
                Revoke approval
              </Button>
            )}
            {/* The answer, inline; the failure is a toast — one error leg. */}
            {mutation.data && <span className="text-2xs text-ink-muted">{mutation.data.detail}</span>}
          </div>
        ) : (
          <p className="mt-2 text-2xs text-ink-faint">
            {kind === 'human'
              ? 'Do the steps above, then approve the gate. Writes are off in this console — restart ' +
                'with --allow-writes, or run scripts/gate-approve.sh from a terminal.'
              : 'Writes are off in this console — approving needs --allow-writes, or ' +
                'scripts/gate-approve.sh from a terminal.'}
          </p>
        )}
      </div>
    </Banner>
  );
}

/**
 * The same card, for a caller that knows only which phase it is looking at.
 *
 * Resolves the phase's own view, its gate status and this console's write
 * capability itself, and renders NOTHING when the phase has no gate — so a
 * caller can mount it unconditionally beside a phase and it appears only when
 * there is something to answer. The plan detail and the gate status are both
 * already-cached queries on every surface that would mount this, so the common
 * case costs no request at all.
 */
export function PhaseGate({ slug, phase }: { slug: string; phase: number }) {
  const { data: plan } = usePlan(slug);
  const view = plan?.phases?.find((p) => p.phase === phase);
  const gated = Boolean(view && (view.gated || view.gates));
  const { data: gate } = useGateStatus(slug, view?.phase, gated);
  const { data: state } = useConsoleState();
  if (!view || !gated) return null;
  return <GateCard slug={slug} view={view} gate={gate} allowWrites={Boolean(state?.allowWrites)} />;
}
