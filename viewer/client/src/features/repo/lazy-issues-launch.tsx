/**
 * The plan-from-issues dialog, fetched when it is OPENED rather than when the
 * board that can open it is rendered.
 *
 * `issues-launch.tsx` pulls `RunSetup` — the whole run-setup surface, the skill
 * picker, the MCP picker and the zod schema behind them, 71 KB as a chunk of
 * its own — and the board renders it as `{launching && <Dialog/>}`, on a
 * deliberate press. A *static* import is paid at chunk load whatever the render
 * does, so importing it directly made everyone who opened `#/repo` to read a
 * commit graph download a form they had not asked for. Measured before this
 * module existed: the Repo chunk's static closure went from 11 chunks to 12,
 * and the twelfth was `run-setup`.
 *
 * ⚠️ Import THIS module from `issues-section.tsx`, never `./issues-launch`.
 * `check-dist.mjs` asserts the repo chunk does not carry run-setup, so a static
 * import that creeps back is a red gate rather than a silent 71 KB — the same
 * arrangement, and the same reasoning, as
 * `features/run-setup/lazy-launch-dialog.tsx`.
 *
 * The fallback is `null` on purpose: the alternative is a spinner that appears
 * and is replaced within a frame or two on a console served from localhost,
 * which reads as a flicker rather than as progress.
 */

import { Suspense, lazy } from 'react';
import type { IssuesLaunchProps } from './issues-launch';

const Dialog = lazy(() => import('./issues-launch').then((m) => ({ default: m.IssuesLaunchDialog })));

export function IssuesLaunchDialog(props: IssuesLaunchProps) {
  return (
    <Suspense fallback={null}>
      <Dialog {...props} />
    </Suspense>
  );
}
