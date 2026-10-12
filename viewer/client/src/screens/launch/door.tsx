/**
 * The ONE door to the launch form (7.0, quiet-console phases 13–14).
 *
 * Every surface that opens a launch — Start, Continue, a QA review, a recovery
 * agent — draws `LaunchDoor` with the request it already builds, and every page
 * that holds the form inline — the sessions launcher, the plan wizard, the Run
 * view's settings — draws `LaunchForm`. Both arrive when they are drawn, never
 * with the page: the form is the heaviest thing the console has, and
 * `check-dist` holds the plan and repo routes to no static `run-setup` chunk.
 * So this file imports the form only through `import()`, and its types only as
 * types, which the compiler erases.
 *
 * The dialog's fallback is nothing, on purpose — a spinner replaced within a
 * frame on a console served from localhost reads as a flicker, not as progress.
 * An inline form takes its host's fallback, because the host knows what stands
 * in its place.
 */

import { Suspense, lazy, type ReactNode } from 'react';
import type { LaunchDialogProps } from './launch-dialog';
import type { RunSetupProps } from './run-setup';

export type { LaunchRequest, QaTarget } from './launch-dialog';
export type { RunSetupProps } from './run-setup';

const Dialog = lazy(() => import('./launch-dialog').then((m) => ({ default: m.LaunchDialog })));
const Form = lazy(() => import('./run-setup').then((m) => ({ default: m.RunSetup })));

/** What a launch is asked for: the request, and what to do when it closes or starts. */
export type LaunchDoorProps = LaunchDialogProps;

export function LaunchDoor(props: LaunchDoorProps) {
  return (
    <Suspense fallback={null}>
      <Dialog {...props} />
    </Suspense>
  );
}

/** The form inline on a page, in the mode its host names. */
export function LaunchForm({ fallback = null, ...props }: RunSetupProps & { fallback?: ReactNode }) {
  return (
    <Suspense fallback={fallback}>
      <Form {...props} />
    </Suspense>
  );
}
