/**
 * The Node floor is stated in every gate that can refuse a node, and they
 * must all agree.
 *
 * The server runs TypeScript directly, so the floor is >= 22.18 (when type
 * stripping became the default) and >= 23.6 (23.0-23.5 kept it behind a flag).
 * That rule is written out in the two `package.json` `engines` ranges, in
 * `viewer/run` and in `bin/phase-console.mjs`,
 * which is one fact restated by every gate that can refuse a node.
 *
 * A gate that drifts does not fail loudly: it either refuses a node the docs
 * promise works, or lets one through that crashes on the first `.ts` import
 * with a syntax error nobody reads as a version problem. So this test does not
 * compare the sources as text — it EXTRACTS each gate's own predicate and runs
 * it against versions either side of every boundary, then asserts every
 * verdict is identical, and identical to the documented rule.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

/** Either side of every boundary the floor has, plus the ordinary cases. */
const VERSIONS = [
  '18.20.4', '20.19.0', '21.7.3',
  '22.0.0', '22.17.9', '22.18.0', '22.18.1', '22.20.0',
  '23.0.0', '23.5.0', '23.5.9', '23.6.0', '23.6.1', '23.11.0',
  '24.0.0', '24.13.1', '25.1.0',
];

/**
 * The rule as prose, not as a copy of any gate's expression: 22.18 is where
 * type stripping became the default, 23.0-23.5 is the window that kept it
 * behind a flag, and everything above is fine.
 */
function documented(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  if (major < 22) return false;
  if (major === 22) return minor >= 18;
  if (major === 23) return minor >= 6;
  return true;
}

/**
 * The `node -e` probe the three shell gates embed, lifted out and run against
 * a stubbed `process`. Running it is the point: a probe that reads plausibly
 * and computes the wrong boundary is exactly the failure this guards.
 */
function shellProbe(source: string, where: string): (v: string) => boolean {
  const match = source.match(/-e '(const \[maj, min\][\s\S]*?)'/);
  assert.ok(match, `${where}: no \`node -e\` floor probe found — did the gate move?`);
  const body = match[1];
  return (version: string) => {
    let code: number | undefined;
    const stub = {
      versions: { node: version },
      exit: (status: number) => { code = status; },
    };
    // eslint-disable-next-line no-new-func
    new Function('process', body)(stub);
    assert.notEqual(code, undefined, `${where}: the probe did not call process.exit`);
    return code === 0;
  };
}

/** The same, for `bin/phase-console.mjs`, which writes the test out in JS. */
function binProbe(source: string): (v: string) => boolean {
  const match = source.match(/const parts = process\.versions\.node[\s\S]*?const ok = ([\s\S]*?);\n/);
  assert.ok(match, 'bin/phase-console.mjs: no floor expression found');
  const expression = match[1];
  return (version: string) => {
    const parts = version.split('.').map(Number);
    // eslint-disable-next-line no-new-func
    return Boolean(new Function('parts', `return (${expression});`)(parts));
  };
}

/**
 * `engines` is a semver RANGE, so it needs a range evaluator rather than an
 * expression: comparators separated by spaces are ANDed, `||` ORs the groups.
 * That is the whole grammar these two fields use, and hand-evaluating it keeps
 * the test dependency-free like everything else here.
 */
function enginesProbe(range: string, where: string): (v: string) => boolean {
  const groups = range.split('||').map((g) => g.trim().split(/\s+/).filter(Boolean));
  assert.ok(groups.length > 0 && groups[0].length > 0, `${where}: empty engines range`);
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i += 1) {
      if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0) ? -1 : 1;
    }
    return 0;
  };
  return (version: string) => {
    const v = version.split('.').map(Number);
    return groups.some((group) => group.every((comparator) => {
      const m = comparator.match(/^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/);
      assert.ok(m, `${where}: unsupported comparator ${comparator}`);
      const order = cmp(v, m[2].split('.').map(Number));
      switch (m[1] ?? '=') {
        case '>=': return order >= 0;
        case '>': return order > 0;
        case '<=': return order <= 0;
        case '<': return order < 0;
        default: return order === 0;
      }
    }));
  };
}

/** Every gate, by the name the release checklist calls it. */
function gates(): Array<{ name: string; verdict: (v: string) => boolean }> {
  const rootPkg = JSON.parse(read('package.json'));
  const viewerPkg = JSON.parse(read('viewer/package.json'));
  assert.ok(rootPkg.engines?.node, 'the root package.json declares engines.node');
  assert.ok(viewerPkg.engines?.node, 'viewer/package.json declares engines.node');
  return [
    { name: 'package.json engines', verdict: enginesProbe(rootPkg.engines.node, 'package.json') },
    { name: 'viewer/package.json engines', verdict: enginesProbe(viewerPkg.engines.node, 'viewer/package.json') },
    { name: 'viewer/run', verdict: shellProbe(read('viewer/run'), 'viewer/run') },
    { name: 'bin/phase-console.mjs', verdict: binProbe(read('bin/phase-console.mjs')) },
  ];
}

test('every node-floor gate answers identically, and answers the documented rule', () => {
  const all = gates();
  // The set itself, not just its verdicts: a gate quietly dropped from the list
  // above would leave this test green while the floor went unchecked in the file
  // it was dropped for. Six statements here; four in the free tree, where
  // `viewer/deploy/` is not shipped at all.
  assert.equal(
    all.length, existsSync(join(REPO, 'viewer', 'deploy')) ? 6 : 4,
    `this tree has ${all.length} node-floor gates, which is not the number it should have`,
  );
  for (const version of VERSIONS) {
    const want = documented(version);
    for (const gate of all) {
      assert.equal(
        gate.verdict(version), want,
        `${gate.name} says node ${version} is ${gate.verdict(version) ? 'fine' : 'too old'}, `
        + `but the floor says it is ${want ? 'fine' : 'too old'}`,
      );
    }
  }
});

test('the floor is where it is for a reason — the 23.0-23.5 hole is deliberate', () => {
  // Not folded into the loop above: this is the boundary a "simplification" to
  // `>=22.18` would quietly erase, and 23.0-23.5 would then be admitted to a
  // console that cannot import a single .ts file.
  const all = gates();
  for (const gate of all) {
    assert.equal(gate.verdict('23.5.9'), false, `${gate.name} must refuse 23.5.9`);
    assert.equal(gate.verdict('23.6.0'), true, `${gate.name} must accept 23.6.0`);
    assert.equal(gate.verdict('22.17.9'), false, `${gate.name} must refuse 22.17.9`);
    assert.equal(gate.verdict('22.18.0'), true, `${gate.name} must accept 22.18.0`);
  }
});

test('the docs state the same floor the gates enforce', () => {
  // The statements a person reads before ever hitting a gate — including the
  // Persian mirrors, which drift silently because nobody re-reads them.
  // `docs/releasing.md` is deliberately NOT in this list: it names the gates
  // rather than the number, which is what makes it the checklist and not a
  // seventh copy of the fact.
  for (const doc of ['README.md', 'README.fa.md', 'docs/install.md', 'docs/reference.md',
    'viewer/README.md', 'viewer/README.fa.md']) {
    const text = read(doc);
    assert.match(text, /22\.18/, `${doc} states the floor`);
    assert.match(text, /23\.6/, `${doc} states the 23.6 half of it`);
  }
  // And the checklist still points at every gate this test executes.
  const releasing = read('docs/releasing.md');
  const named = ['viewer/run', 'bin/phase-console.mjs', 'engines'];
  for (const gate of named) {
    assert.ok(releasing.includes(gate), `docs/releasing.md's Node-floor row names ${gate}`);
  }
});
