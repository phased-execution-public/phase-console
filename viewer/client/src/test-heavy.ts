/**
 * The per-case bound of the client suite's HEAVY cases (#404) — a render that
 * walks every field, every section or a whole page under axe. Under a loaded
 * full run (load 15–59 on 14 cores, beside the e2e tour) these lost vitest's
 * suite-wide 20 s, and the five files that timed out were green alone in 22 s.
 *
 * Like `testTimeout` in `vite.config.ts` it is a liveness bound on the harness,
 * never a claim about the app: a passing case never waits for it and a hang
 * still fails. A case adopts it by name, so a grep says which cases are heavy.
 */
import { cleanup } from '@testing-library/react';

export const HEAVY_CASE_TIMEOUT = 90_000;

/**
 * The teardown a file with a heavy case runs after each case: unmount, then
 * empty the body. A case that timed out keeps running after vitest moved on,
 * and the DOM it then mounts must not become the next case's "Found multiple
 * elements" (run-setup, #404).
 */
export function clearDom(): void {
  cleanup();
  document.body.innerHTML = '';
}
