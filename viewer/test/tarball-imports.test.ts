// Ship-integrity gates (console-audit-hardening P1).
//
// The defect this file exists for: viewer/server/inbox.ts statically imported
// viewer/shared/routes.js while package.json's `files` allowlist omitted it and
// assert-tarball.sh asserted it MUST NOT ship — so every packaged copy
// crashed at boot with ERR_MODULE_NOT_FOUND, and the three channels an author
// tests (plugin, clone, dev) were the three that worked. The gate here walks
// the server's real static imports, so the NEXT shared module a server file
// imports fails the suite the moment it is not shipped, instead of failing the
// operator at install time.
//
// Also pinned here, same phase, same theme (the published artifact must match
// the tree): the bash bin dispatches lifecycle verbs instead of booting a
// console named after them; SKILL.md carries no install-specific path; the
// CHANGELOG keeps the sections the release workflow extracts by tag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

/** Every `viewer/shared/<file>` the server statically imports. */
function serverSharedImports(): Set<string> {
  const found = new Set<string>();
  for (const file of walk(join(repoRoot, 'viewer', 'server'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/from\s+['"]([^'"]*shared\/[^'"]+)['"]/g)) {
      const base = m[1].split('shared/')[1];
      found.add(`viewer/shared/${base}`);
    }
  }
  return found;
}

test('every shared module the server imports is in the files allowlist', () => {
  const files: string[] = JSON.parse(
    readFileSync(join(repoRoot, 'package.json'), 'utf8'),
  ).files;
  const missing = [...serverSharedImports()].filter((p) => !files.includes(p));
  assert.deepEqual(
    missing,
    [],
    `server runtime imports missing from package.json "files" — a packed install cannot boot: ${missing.join(', ')}`,
  );
});

test('assert-tarball.sh must-ship and never-ship agree with the server imports', () => {
  const gate = readFileSync(
    join(repoRoot, '.github', 'scripts', 'assert-tarball.sh'),
    'utf8',
  );
  for (const p of serverSharedImports()) {
    assert.ok(
      gate.includes(`"${p}" \\`),
      `${p} is a server runtime import but not in assert-tarball.sh's must-ship list`,
    );
    const bare = p.replace(/\.(js|mjs)$/, '');
    const neverBlock = gate.slice(gate.indexOf('# Never-ship set'));
    assert.ok(
      !neverBlock.includes(`"${bare}"`),
      `${p} is a server runtime import but assert-tarball.sh forbids it from shipping`,
    );
  }
});

// `bin/run-verb.mjs` (control-tower phase 98, EC6): the one module both bins
// dispatch `phase-console run` to — pinned here the way `week-report.test.ts`
// pins `bin/report-verb.mjs`, and not inside a `!pro:` region, because both
// halves of this are true in the FREE tree too. Only the reads of Pro paths
// are marked: in the FREE tree `bin/phase-console.mjs` IS the free bin (the
// override is applied), and `free/` and the Pro tarball's gate do not ship.
test('bin/run-verb.mjs ships in both tarballs and is dispatched by both bins', () => {
  const bins = ['bin/phase-console.mjs'];
  for (const bin of bins) {
    assert.match(readFileSync(join(repoRoot, bin), 'utf8'), /args\[0\] === 'run'[\s\S]{0,200}run-verb\.mjs/, bin);
  }
  const freeSafeGate = readFileSync(join(repoRoot, '.github', 'scripts', 'assert-tarball.sh'), 'utf8').split('!pro:start')[0]!;
  assert.match(freeSafeGate, /"bin\/run-verb\.mjs"/, 'assert-tarball.sh must ship it in the free-safe list');
});




test('SKILL.md and references never hardcode an install path (F13)', () => {
  const offenders: string[] = [];
  const check = (rel: string) => {
    if (readFileSync(join(repoRoot, rel), 'utf8').includes('~/.claude/skills/')) {
      offenders.push(rel);
    }
  };
  check('SKILL.md');
  for (const name of readdirSync(join(repoRoot, 'references'))) {
    if (name.endsWith('.md')) check(`references/${name}`);
  }
  assert.deepEqual(
    offenders,
    [],
    'plugin installs and hub copies do not live under ~/.claude/skills — name <skill-root> instead',
  );
});

