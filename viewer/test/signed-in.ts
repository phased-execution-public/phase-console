/**
 * The machine reads signed in (measured-console phase 14).
 *
 * A run's preflight asks `claude auth status` whether this console is signed in
 * (`server/runner/auth.ts`), and a `Runner` a test builds without its own
 * `checkAuth` asks the REAL one, on PATH. Where there is none — the release
 * gate runs under `env -i`, with a PATH that has no `~/.local/bin` — every such
 * run parks `run-preflight` ("Claude Code is not signed in for this console")
 * before it boards anything, and the test that awaited its phase waits out the
 * suite's 600 s timeout. The phase 14 gate lost 69 tests and twelve hours that
 * way (pe #434); `credits-carry.test.ts` passes in a second with `claude` on
 * PATH and times out without it.
 *
 * So every test process gets a `claude` first on PATH that answers the
 * sign-in probe — with or without `--json` — the way a signed-in machine does,
 * and hands every other invocation to the next `claude` on PATH, exactly as
 * before, or answers 127 as a missing CLI would. A test of the probe itself
 * injects its own exec or its own PATH, and is unaffected.
 *
 * Imported by `state-sandbox.ts`, and by each file that redirects inline and
 * loads `steady-load.mjs` alone; consoles a test spawns inherit the PATH.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pc-signed-in-'));
const bin = join(dir, 'bin');
mkdirSync(bin);
const stub = join(bin, 'claude');
writeFileSync(stub, `#!/bin/sh
if [ "$1" = auth ] && [ "$2" = status ]; then
  echo '{"loggedIn":true,"authMethod":"claude.ai","email":"stub@example.invalid"}'
  exit 0
fi
self_dir='${bin}'
IFS='${delimiter}'
for d in $PATH; do
  [ "$d" = "$self_dir" ] && continue
  [ -n "$d" ] && [ -x "$d/claude" ] && exec "$d/claude" "$@"
done
echo "claude: command not found" >&2
exit 127
`);
chmodSync(stub, 0o755);

process.env.PATH = [bin, process.env.PATH].filter(Boolean).join(delimiter);

process.on('exit', () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* a leftover tmpdir is not a failure */ }
});

/** The directory the stub lives in, first on PATH. */
export const SIGNED_IN_BIN = bin;
