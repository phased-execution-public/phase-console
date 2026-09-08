/**
 * The panic button, and the sentence it leaves on screen.
 *
 * Two exports over ONE mutation pair, because the freeze has to be visible in
 * two very different places and must not become two implementations of the
 * same act:
 *
 *  - `FleetFrozenBanner` — app-wide, above every destination. A frozen console
 *    looks exactly like a console with nothing to do, which is the single
 *    hardest state to diagnose from the outside; the banner is what makes the
 *    difference legible from whatever page the operator happens to be on.
 *  - `FleetFreezeControl` — the control that arms it, on the orchestration
 *    board's header AND on the Settings ▸ Automation row. That header was
 *    named here as "the real home (phase 19)", and when phase 19 built it the
 *    header grew its OWN freeze verb over the same hook instead of adopting
 *    this one — so the act had three render sites and two behaviours, and the
 *    comment promising otherwise sat six lines above the divergence. `confirm`
 *    is the only thing the two ever disagreed about, so it is a prop.
 *
 * Both go through `useFleetLifecycle`, so there is one busy shape, one toast
 * vocabulary and one invalidation set. That hook moved to
 * `lib/run-lifecycle.ts` in phase 18, beside the seven per-run verbs: the same
 * argument at a different scope, and the single-source guard is over the DOORS
 * rather than over the per-run ones alone.
 */

import { Snowflake } from 'lucide-react';

import { useConsoleState } from '@/lib/queries';
import { useFleetLifecycle } from '@/lib/run-lifecycle';
import { AlertDialog, AlertDialogContent, AlertDialogTrigger, Banner, Button } from '@/components/ui';
import { relativeTime } from '@/lib/format';

/** The fleet's state as the client reads it, with an old server's silence as "not frozen". */
export function fleetOf(
  state: { fleet?: { frozen: boolean; at: string | null; by: string | null } } | undefined,
) {
  return state?.fleet ?? { frozen: false, at: null, by: null };
}

/**
 * The app-wide banner. Renders nothing at all when the console is not frozen,
 * so it costs one field read on every page and no layout.
 */
export function FleetFrozenBanner() {
  const { data: state } = useConsoleState();
  const fleet = fleetOf(state);
  const { thaw, busy } = useFleetLifecycle();
  if (!fleet.frozen) return null;
  // `relativeTime` takes epoch millis; `fleet.at` is the ISO string the marker
  // file holds. An unparseable one simply drops the clause rather than
  // rendering `NaN` beside a sentence about the console being stopped.
  const at = fleet.at ? Date.parse(fleet.at) : NaN;
  const since = Number.isFinite(at) ? relativeTime(at) : null;
  return (
    <Banner severity="warn">
      <Snowflake size={15} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <strong>This console is frozen.</strong> Every running session is stopped where it stands and nothing
        new will start — no queued phase, no wait, no recovery.
        {fleet.by ? ` Frozen by ${fleet.by}` : ' Frozen'}
        {since ? ` ${since}` : ''}. Thawing puts the whole fleet back exactly where it was.
      </div>
      {state?.allowRun && (
        <Button size="sm" disabled={busy != null} onClick={() => void thaw()}>
          Thaw all
        </Button>
      )}
    </Banner>
  );
}

/**
 * The control that arms it — one component, two surfaces.
 *
 * **Thaw is never behind a confirmation, on either surface.** It restores, and
 * phase 15 made it exact (a thawed session continues mid-token), so a
 * confirmation would be a question about nothing.
 *
 * **Freeze confirms only where it sits beside a Stop.** On the board it does:
 * Stop cannot be taken back, Freeze can, and two adjacent buttons one reflex
 * apart with opposite reversibility is how the wrong one gets pressed. On the
 * Settings row there is no Stop beside it and a panic button is one press.
 * That difference — and nothing else — is what `confirm` carries; everything
 * about WHAT the act does stays here, once.
 */
export function FleetFreezeControl({ confirm = false }: { confirm?: boolean } = {}) {
  const { data: state } = useConsoleState();
  const fleet = fleetOf(state);
  const { freeze, thaw, busy } = useFleetLifecycle();
  if (!state?.allowRun) return null;

  if (fleet.frozen) {
    return (
      <Button size="sm" aria-pressed disabled={busy != null} onClick={() => void thaw()}>
        Thaw all
      </Button>
    );
  }

  if (!confirm) {
    return (
      <Button size="sm" aria-pressed={false} disabled={busy != null} onClick={() => void freeze()}>
        Freeze all
      </Button>
    );
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" aria-pressed={false} disabled={busy != null}>
          <Snowflake size={13} aria-hidden /> Freeze all
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent
        title="Freeze the whole console?"
        description="Every running session is stopped where it stands and nothing new starts — no queued phase, no wait, no recovery. Nothing is lost: thawing puts the fleet back exactly where it was, mid-token."
        confirmLabel="Freeze all"
        onConfirm={() => void freeze()}
      />
    </AlertDialog>
  );
}
