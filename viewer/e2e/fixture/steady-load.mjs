// The machine's load, held still for the e2e fixture's console.
//
// The console draws one thing from `os.loadavg()`: the phase report's "Slow
// because: machine load … is above the guard", a line in the Now card of a live
// lane's page. It is there on a busy machine and gone on a quiet one, and it
// moves everything under it — so the register measured one first screen at load
// 70 and another at load 8, and read the difference as NEW and FIXED findings.
// The fixture console loads this before anything else (`--import`, through
// NODE_OPTIONS — `console.ts`), so it reads the same quiet load whatever the
// machine is doing. The supervisor's `machine-load` situation reads the same
// sample, and is held `off` besides.
//
// The node suite holds it too (control-tower phase 34): `test/state-sandbox.ts`
// imports it, and `test/spawn-console.ts` hands it to every console a test
// starts. The scheduler's load guard holds every NEW admission on a busy
// machine (phase 100), so an `admit()` a test awaited queued for ever.
import { createRequire, syncBuiltinESMExports } from 'node:module';

const os = createRequire(import.meta.url)('node:os');
os.loadavg = () => [1, 1, 1];
// `import { loadavg } from 'node:os'` is a live binding: this re-points it.
syncBuiltinESMExports();
