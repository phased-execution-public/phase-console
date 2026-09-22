/**
 * The build gate, driven against synthetic builds.
 *
 * `check-dist.mjs` is the only thing standing between a green `npm run build`
 * and a shipped regression in the one artifact nobody reads: `client/dist`. Its
 * header says every assertion in it is something that actually went wrong once
 * — a worker that stopped handling push and silently unsubscribed two devices,
 * 89 KB of terminal emulator folded into a precached destination chunk, a first
 * paint that drifted 211 → 220 KB while a printed line went unread.
 *
 * But the gate itself has never been tested. It has only ever been run against
 * the real build, where it passes — so an assertion that quietly stopped
 * asserting (a regex that no longer matches anything, a check that reads an
 * empty list as success) would look exactly like a healthy gate.
 *
 * So: build a minimal dist that PASSES, then break one thing at a time and
 * assert the gate fails, and fails naming that thing. Each case below is a
 * failure mode from the header.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VIEWER = fileURLToPath(new URL('..', import.meta.url));
const GATE = join(VIEWER, 'scripts', 'check-dist.mjs');

type Dist = {
  /** Chunk basename → contents, written under `assets/`. */
  assets: Record<string, string | Buffer>;
  html: { preload: string[]; entry: string; extraHead: string };
  sw: { precache: string[]; push: boolean } | null;
  buildRev: boolean;
  manifest: boolean;
};

/** A build that satisfies every check — the baseline each case mutates. */
function baseline(): Dist {
  return withRepoChunk({
    assets: {
      'index-aaaa.js': 'navigator.serviceWorker.register("/sw.js");\n',
      'sessions-bbbb.js': 'export const Sessions = 1;\n',
      'settings-cccc.js': 'export const Settings = 1;\n',
      'insights-dddd.js': 'export const Insights = 1;\n',
      // Phase 4's two. A destination chunk missing from the precache is a page
      // absent from the offline shell, so the gate names each one — which means
      // the baseline has to carry each one too.
      'debug-nnnn.js': 'export const Debug = 1;\n',
      'mcp-eeee.js': 'export const Mcp = 1;\n',
      'permissions-ffff.js': 'export const Permissions = 1;\n',
      // The emulator, in the chunk the worker's globIgnores exclude by name.
      'pane-gggg.js': 'import { Terminal } from "xterm";\nexport { Terminal };\n',
      // The plan route, and one chunk it legitimately imports. The check walks
      // this graph looking for `run-setup-*`; a baseline with no `detail-*` at
      // all could not tell a clean graph from a missing one.
      'detail-jjjj.js': 'import { x } from "./phase-groups-kkkk.js";\nexport const Plan = x;\n',
      'phase-groups-kkkk.js': 'export const x = 1;\n',
    },
    html: { preload: [], entry: 'index-aaaa.js', extraHead: '' },
    sw: {
      precache: [
        'index.html',
        'sessions-bbbb.js',
        'settings-cccc.js',
        'insights-dddd.js',
        'repo-mmmm.js',
        'debug-nnnn.js',
      ],
      push: true,
    },
    buildRev: true,
    manifest: true,
  });
}

// The free tree strips the Pro lines above, and with them the repo chunk that
// carried the dynamic import — so a free baseline puts a plain repo chunk back.
// In the Pro tree the key already exists and this is a no-op.
function withRepoChunk(dist: Dist): Dist {
  dist.assets['repo-mmmm.js'] ??= 'export const Repo = 1;\n';
  return dist;
}

function render(dist: Dist, dir: string): void {
  mkdirSync(join(dir, 'assets'), { recursive: true });
  for (const [name, body] of Object.entries(dist.assets)) {
    writeFileSync(join(dir, 'assets', name), body);
  }
  const head = [
    '<link rel="manifest" href="/manifest.webmanifest">',
    ...dist.html.preload.map((n) => `<link rel="modulepreload" href="/assets/${n}">`),
    dist.html.extraHead,
  ].filter(Boolean).join('\n    ');
  writeFileSync(join(dir, 'index.html'),
    `<!doctype html>\n<html lang="en">\n  <head>\n    ${head}\n`
    + `    <script type="module" crossorigin src="/assets/${dist.html.entry}"></script>\n`
    + '  </head>\n  <body><div id="root"></div></body>\n</html>\n');
  if (dist.manifest) writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"Phase Console"}\n');
  if (dist.sw) {
    const listener = dist.sw.push ? 'self.addEventListener("push", (e) => e.waitUntil(0));\n' : '';
    writeFileSync(join(dir, 'sw.js'),
      `${listener}const precache = ${JSON.stringify(dist.sw.precache)};\n`);
  }
  if (dist.buildRev) writeFileSync(join(dir, '.build-rev'), 'abc1234\n');
}

/** Run the gate against a synthetic dist; never throws on a non-zero exit. */
function runGate(dist: Dist): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'check-dist-'));
  try {
    render(dist, dir);
    try {
      const out = execFileSync(process.execPath, [GATE], {
        cwd: VIEWER, encoding: 'utf8', env: { ...process.env, PC_DIST_DIR: dir },
      });
      return { ok: true, out };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The failing check lines, so a case asserts on its own failure not any failure. */
function failures(out: string): string[] {
  return out.split('\n').filter((line) => line.startsWith('✗'));
}

test('the baseline synthetic build passes every check', () => {
  // If this ever fails, the fixture is behind the gate — fix the fixture, not
  // the gate. It exists so the cases below mean "this ONE thing broke it".
  const { ok, out } = runGate(baseline());
  assert.ok(ok, `the baseline must pass, or no case below proves anything:\n${out}`);
  assert.match(out, /all \d+ checks passed/);
});

test('a missing service worker fails — subscriptions are bound to /sw.js', () => {
  const dist = baseline();
  dist.sw = null;
  const { ok, out } = runGate(dist);
  assert.equal(ok, false);
  assert.ok(failures(out).some((l) => l.includes('sw.js is at the ROOT')), out);
});

test('a worker that stopped handling push fails — the silent-unsubscribe shape', () => {
  const dist = baseline();
  dist.sw!.push = false;
  const { ok, out } = runGate(dist);
  assert.equal(ok, false);
  assert.ok(failures(out).some((l) => l.includes('still handles push')), out);
});

test('a RENAMED emulator chunk in the precache still fails — the rename-proof check', () => {
  // The regression that motivated it: adding one shared module renamed
  // `pane-*` → `ended-*`, matched no globIgnores entry, and put 346 KB of
  // xterm in the precache. Every name-pinned check would pass here.
  const dist = baseline();
  dist.assets['ended-hhhh.js'] = 'import { Terminal } from "xterm";\n';
  dist.sw!.precache.push('ended-hhhh.js');
  const { ok, out } = runGate(dist);
  assert.equal(ok, false);
  assert.ok(failures(out).some((l) => l.includes('the precache excludes the emulator')), out);
});

/*
 * The plan route's chunk GRAPH, not its chunk.
 *
 * What went in was never visible from any one file: `groupRows` — ten lines —
 * was exported from the 888-line run table, and `LaunchDialog` (the whole
 * 77.6 KB run-setup surface) was a static import in two components the plan
 * page mounts, both of which render it only on a press. Nobody reading
 * `detail.tsx` would have seen either.
 */
test('run-setup reached from the plan chunk by a STATIC import fails', () => {
  const dist = baseline();
  dist.assets['run-setup-llll.js'] = 'export const Setup = 1;\n';
  dist.assets['detail-jjjj.js'] =
    'import { x } from "./phase-groups-kkkk.js";\nimport { Setup } from "./run-setup-llll.js";\nexport const Plan = x + Setup;\n';
  const { ok, out } = runGate(dist);
  assert.equal(ok, false);
  assert.ok(failures(out).some((l) => l.includes('never statically pulls run-setup')), out);
  assert.match(out, /lazy-launch-dialog/, 'the detail names the module to import instead');
});

test('run-setup reached from the plan chunk INDIRECTLY fails too', () => {
  // The real shape: `detail` → `route-tab` → `health-panel` → `recovery-actions`
  // → `launch-dialog`. A one-hop check would have called that clean.
  const dist = baseline();
  dist.assets['run-setup-llll.js'] = 'export const Setup = 1;\n';
  dist.assets['phase-groups-kkkk.js'] = 'import "./run-setup-llll.js";\nexport const x = 1;\n';
  const { ok, out } = runGate(dist);
  assert.equal(ok, false);
  assert.ok(failures(out).some((l) => l.includes('never statically pulls run-setup')), out);
});

/*
 * The same rule for the Repo destination's one heavy section.
 *
 * React Flow and d3-dag (~97 KiB gzipped, `test/fixtures/spikes/react-flow-bundle.md`)
 * ride behind the Landscape section, which is reached through
 * `features/repo/pro/lazy-landscape`. Three ways that stops being true, each
 * named: a static import folds the library into the precached repo chunk;
 * the landscape chunk itself gets precached (the worker's globIgnores name it);
 * the document preloads it. All three are rename-proof — they find whichever
 * chunk carries React Flow — because the pane check taught that a name is
 * exactly what a bundler is free to change.
 */
test('React Flow reached from the repo chunk by a STATIC import fails', () => {
  const dist = baseline();
  dist.assets['map-rrrr.js'] = 'export const Map = "react-flow__pane";\n';
  dist.assets['repo-mmmm.js'] = 'import { Map } from "./map-rrrr.js";\nexport const Repo = Map;\n';
  const { ok, out } = runGate(dist);
  assert.equal(ok, false);
  assert.ok(failures(out).some((l) => l.includes('carries no React Flow')), out);
  assert.match(out, /lazy-landscape/, 'the detail names the module to import instead');
});

test('a React Flow chunk in the precache fails, whatever it is called', () => {
  const dist = baseline();
  dist.assets['map-rrrr.js'] = 'export const Map = "react-flow__pane";\n';
  dist.sw!.precache.push('map-rrrr.js');
  const { ok, out } = runGate(dist);
  assert.equal(ok, false);
  assert.ok(failures(out).some((l) => l.includes('the precache excludes React Flow')), out);
});

test('modulepreloading a React Flow chunk fails — fetched on first paint by everyone', () => {
  const dist = baseline();
  dist.assets['map-rrrr.js'] = 'export const Map = "react-flow__pane";\n';
  dist.html.preload.push('map-rrrr.js');
  const { ok, out } = runGate(dist);
  assert.equal(ok, false);
  assert.ok(failures(out).some((l) => l.includes('never modulepreloads React Flow')), out);
});



test('run-setup reached by a DYNAMIC import is exactly what is wanted', () => {
  // The whole fix is a `lazy()`. A check that counted this edge would report
  // every correct answer as a regression.
  const dist = baseline();
  dist.assets['run-setup-llll.js'] = 'export const Setup = 1;\n';
  dist.assets['detail-jjjj.js'] =
    'import { x } from "./phase-groups-kkkk.js";\nexport const open = () => import("./run-setup-llll.js");\nexport const Plan = x;\n';
  const { ok, out } = runGate(dist);
  assert.ok(ok, out);
});

test('the plan route having no chunk of its own fails — nothing to walk is not clean', () => {
  const dist = baseline();
  delete dist.assets['detail-jjjj.js'];
  const { ok, out } = runGate(dist);
  assert.equal(ok, false);
  assert.ok(failures(out).some((l) => l.includes('the plan route is its own chunk')), out);
});

test('modulepreloading the emulator fails — the second way a lazy chunk stops being lazy', () => {
  const dist = baseline();
  dist.html.preload.push('pane-gggg.js');
  const { ok, out } = runGate(dist);
  assert.equal(ok, false);
  assert.ok(failures(out).some((l) => l.includes('never modulepreloads the emulator')), out);
});

test('an emulator folded into the Sessions destination chunk fails, and names the edit', () => {
  const dist = baseline();
  dist.assets['sessions-bbbb.js'] = 'import { Terminal } from "xterm";\nexport const Sessions = 1;\n';
  const { ok, out } = runGate(dist);
  assert.equal(ok, false);
  assert.ok(failures(out).some((l) => l.includes('Sessions destination chunk carries no emulator')), out);
  assert.match(out, /lazy\(\(\) => import\('\.\/pane'\)\)/, 'the detail names the edit that did it');
});

test('an inline <script> fails — the served CSP has no hash and no nonce', () => {
  const dist = baseline();
  dist.html.extraHead = '<script>window.__BOOT__ = 1;</script>';
  const { ok, out } = runGate(dist);
  assert.equal(ok, false);
  assert.ok(failures(out).some((l) => l.includes('no inline <script>')), out);
});

test('first paint over budget fails even when the ENTRY is comfortably under it', () => {
  // Exactly the shape the gate exists for: a chunk migrating out of the entry
  // into a preload costs a visitor the same and makes the entry check greener.
  // Random bytes so gzip cannot rescue it.
  const dist = baseline();
  dist.assets['big-iiii.js'] = randomBytes(260 * 1024);
  dist.html.preload.push('big-iiii.js');
  const { ok, out } = runGate(dist);
  assert.equal(ok, false);
  const failed = failures(out);
  assert.ok(failed.some((l) => l.includes('first paint is')), out);
  assert.ok(!failed.some((l) => l.includes('is under the budget')),
    'the ENTRY budget still passes — that is the whole point of the first-paint gate');
});

test('a dist with no .build-rev fails — the staleness warning reads it', () => {
  const dist = baseline();
  dist.buildRev = false;
  const { ok, out } = runGate(dist);
  assert.equal(ok, false);
  assert.ok(failures(out).some((l) => l.includes('.build-rev exists')), out);
});

test('an empty dist is refused before any check, with the command to fix it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-dist-empty-'));
  try {
    let out = '';
    let ok = true;
    try {
      execFileSync(process.execPath, [GATE], {
        cwd: VIEWER, encoding: 'utf8', env: { ...process.env, PC_DIST_DIR: dir },
      });
    } catch (error) {
      ok = false;
      const e = error as { stdout?: string; stderr?: string };
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    assert.equal(ok, false);
    assert.match(out, /run `npm run build` first/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
