/**
 * `server/platform.ts` — the WSL seam, which nothing exercised (coverage-12).
 *
 * WSL is indistinguishable from Linux to Node: same `process.platform`, same
 * syscalls. The one tell is the kernel string in `/proc/version`, and the whole
 * module is three branches over it. Untested, the failure is quiet and remote:
 * a console on WSL answers `['xdg-open']`, the launcher shells a binary that is
 * usually absent from a WSL image, and the operator is told the browser could
 * not be opened — on the one platform where the browser lives on the far side
 * of a kernel boundary.
 *
 * ## Why every case runs in a child process
 *
 * `/proc/version` cannot be created on a developer's macOS, and on Linux CI it
 * says whatever that kernel says — so neither host can produce both answers on
 * its own. It has to be faked, and faking it in-process does not work: an ESM
 * named import (`import { readFileSync } from 'node:fs'`) is bound when the
 * `node:fs` facade is first instantiated, and this file's own static imports
 * instantiate it before any statement in the body can run. Patching the CJS
 * `fs` object after that changes `fs.readFileSync` for direct callers and
 * changes nothing for the module under test — which reads as a passing patch
 * and a failing assertion.
 *
 * So each scenario is a fresh child that patches `fs` BEFORE importing the
 * module, and reports back as JSON. The module under test is the real one, and
 * the answers are identical on macOS, Linux and CI.
 *
 * Needs no plan library, no PHASE_CONSOLE_TEST_ROOT, no client build.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM = join(HERE, '..', 'server', 'platform.ts');

const WSL2 = 'Linux version 5.15.90.1-microsoft-standard-WSL2 (oe-user@oe-host) #1 SMP';
const WSL1 = 'Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com) #1237-Microsoft';
const REAL_LINUX = 'Linux version 6.8.0-45-generic (buildd@lcy02) #45-Ubuntu SMP';

/**
 * Run `body` against a freshly-imported `platform.ts` in a child process.
 *
 * In scope for `body`: `M` (the module), `setPlatform(name)` and
 * `setProcVersion(text | null)` — `null` meaning the file cannot be read at
 * all. Whatever `body` returns is JSON round-tripped back.
 */
function probe(body: string): unknown {
  const src = `
import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(`file://${join(HERE, 'probe.ts')}`)});
const fs = require('fs');
const real = fs.readFileSync;
let proc = null;
fs.readFileSync = (p, ...rest) => {
  if (String(p) === '/proc/version') {
    if (proc == null) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    return proc;
  }
  return real(p, ...rest);
};
const setProcVersion = (text) => { proc = text; };
const setPlatform = (name) => Object.defineProperty(process, 'platform', { value: name, configurable: true });
const M = await import(${JSON.stringify(`file://${PLATFORM}`)});
const out = await (async () => { ${body} })();
process.stdout.write(JSON.stringify(out ?? null));
`;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', src], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout);
}

test('isWSL: the tell is Microsoft in the kernel string, case-insensitively', () => {
  const answers = probe(`
    const out = {};
    setPlatform('linux');
    for (const [name, text] of ${JSON.stringify([['wsl2', WSL2], ['wsl1', WSL1], ['linux', REAL_LINUX]])}) {
      setProcVersion(text); M.resetWSLCache(); out[name] = M.isWSL();
    }
    return out;
  `) as Record<string, boolean>;

  assert.equal(answers.wsl2, true, 'WSL2 names itself microsoft in lower case');
  assert.equal(answers.wsl1, true, 'WSL1 capitalises it — the regex is /i for exactly this');
  assert.equal(answers.linux, false, 'an ordinary Linux kernel is not WSL');
});

test('isWSL: an unreadable /proc/version is false, never a throw', () => {
  const out = probe(`
    setPlatform('linux'); setProcVersion(null); M.resetWSLCache();
    try { return { threw: false, wsl: M.isWSL() }; } catch (e) { return { threw: true, error: String(e) }; }
  `) as { threw: boolean; wsl?: boolean };

  assert.equal(out.threw, false, 'a missing or unreadable /proc/version must not be fatal');
  assert.equal(out.wsl, false, 'a question we cannot answer is answered "no"');
});

test('isWSL: platform is checked first, so no non-Linux host can be WSL', () => {
  // The `&&` short-circuits before the read. That matters beyond tidiness: a
  // macOS or Windows host must never take the WSL branch on the strength of a
  // file it had no business reading.
  const out = probe(`
    const r = {};
    setProcVersion(${JSON.stringify(WSL2)});
    for (const p of ['darwin', 'win32']) { setPlatform(p); M.resetWSLCache(); r[p] = M.isWSL(); }
    return r;
  `) as Record<string, boolean>;

  assert.equal(out.darwin, false, 'darwin is not WSL even if something answers for /proc/version');
  assert.equal(out.win32, false, 'and neither is Windows itself');
});

test('isWSL: the answer is cached, and resetWSLCache is the only way back', () => {
  const out = probe(`
    setPlatform('linux');
    setProcVersion(${JSON.stringify(WSL2)}); M.resetWSLCache();
    const first = M.isWSL();
    // Change the world WITHOUT resetting: the cached answer must stand. The
    // cache is the point — this is consulted on every open, and /proc/version
    // does not change under a running kernel.
    setProcVersion(${JSON.stringify(REAL_LINUX)});
    const stillCached = M.isWSL();
    M.resetWSLCache();
    const afterReset = M.isWSL();
    // A cached FALSE has to stick as firmly as a cached true: the guard is
    // \`wsl == null\`, and a plain \`!wsl\` there would re-read for ever.
    setProcVersion(${JSON.stringify(WSL2)});
    const falseStillCached = M.isWSL();
    return { first, stillCached, afterReset, falseStillCached };
  `) as Record<string, boolean>;

  assert.equal(out.first, true);
  assert.equal(out.stillCached, true, 'a second call must not re-read the file');
  assert.equal(out.afterReset, false, 'after a reset it reads the world again');
  assert.equal(out.falseStillCached, false, 'a cached false is still a cached answer');
});

test('openerCandidates: each platform gets the openers that can reach its desktop', () => {
  const out = probe(`
    const r = {};
    const cases = [
      ['darwin', 'darwin', null],
      ['linux',  'linux',  ${JSON.stringify(REAL_LINUX)}],
      ['wsl',    'linux',  ${JSON.stringify(WSL2)}],
      ['win32',  'win32',  ${JSON.stringify(REAL_LINUX)}],
      ['other',  'freebsd', ${JSON.stringify(REAL_LINUX)}],
    ];
    for (const [name, platform, version] of cases) {
      setPlatform(platform); setProcVersion(version); M.resetWSLCache();
      r[name] = M.openerCandidates();
    }
    return r;
  `) as Record<string, string[]>;

  assert.deepEqual(out.darwin, ['open'], 'macOS has exactly one, and it always works');
  assert.deepEqual(out.linux, ['xdg-open'], 'an ordinary Linux desktop');
  assert.deepEqual(out.wsl, ['wslview', 'xdg-open', 'explorer.exe'],
    'WSL: wslview first because it translates the path, explorer.exe last as the always-there fallback');
  assert.deepEqual(out.win32, [], 'an empty list means "print the URL" — never an error');
  assert.deepEqual(out.other, [], 'and so does anything else unrecognised');
});

test('openerCandidates: xdg-open stays in the WSL list, and is never tried first', () => {
  // A WSL distro that really does run a Linux desktop must still work, so
  // xdg-open cannot be dropped; on the ordinary headless image it is absent,
  // so it cannot be first either.
  const openers = probe(`
    setPlatform('linux'); setProcVersion(${JSON.stringify(WSL1)}); M.resetWSLCache();
    return M.openerCandidates();
  `) as string[];

  assert.ok(openers.includes('xdg-open'), 'a WSL distro with a real desktop is still served');
  assert.equal(openers[0], 'wslview', 'but the translating opener leads');
  assert.notEqual(openers[0], 'xdg-open', 'xdg-open is the fallback, not the first attempt');
});
