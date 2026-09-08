/**
 * `LaunchDialog`, fetched when it is opened rather than when its button is
 * rendered.
 *
 * The dialog is the run-setup surface — the skill picker, the MCP picker, the
 * per-phase table, the zod schema behind them — and it weighs 77.6 KB. Every
 * one of its callers renders it as `{open && <LaunchDialog/>}`, so it is on
 * screen only after a deliberate press; but a *static* import is paid at chunk
 * load whatever the render does, and two of those callers
 * (`components/recovery-actions.tsx`, `components/qa-launcher.tsx`) are mounted
 * on the PLAN route. That is how a form the plan page cannot show came to be
 * downloaded by everyone who opened a plan.
 *
 * ⚠️ Import THIS module, never `./launch-dialog`, from anything reachable on a
 * route that does not launch runs. `check-dist.mjs` asserts the plan chunk does
 * not carry the run-setup chunk, so a static import that creeps back is a red
 * gate rather than a silent 77.6 KB.
 *
 * The fallback is `null` on purpose: the alternative is a spinner that appears
 * and is replaced within a frame or two on a console served from localhost,
 * which reads as a flicker rather than as progress.
 */

import { Suspense, lazy } from 'react';
import type { LaunchRequest } from './launch-dialog';

const Dialog = lazy(() => import('./launch-dialog').then((m) => ({ default: m.LaunchDialog })));

export function LaunchDialog(props: {
  request: LaunchRequest;
  onClose: () => void;
  onDone?: (sessionId?: string) => void;
}) {
  return (
    <Suspense fallback={null}>
      <Dialog {...props} />
    </Suspense>
  );
}
