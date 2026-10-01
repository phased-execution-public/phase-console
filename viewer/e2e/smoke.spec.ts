import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, sep } from 'node:path';

import { expect, test } from '@playwright/test';

import { CONSOLE_PORT, STOPS, VIEWPORTS, fixture, visit } from './lib/shots.ts';

// What every other spec stands on, checked before anything is measured.

const TMP = realpathSync(tmpdir());
const underTmp = (path: string): boolean => realpathSync(path).startsWith(TMP + sep);
const api = async <T>(path: string): Promise<T> =>
  (await (await fetch(`http://127.0.0.1:${CONSOLE_PORT}${path}`)).json()) as T;

test.describe('the fixture console', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== VIEWPORTS[0].name, 'a fact about the console, not a viewport');
  });

  test('keeps its state and its library in a temporary directory — in its own words', async () => {
    const fx = await fixture();
    // The library it opened, as the console reports it.
    const state = await api<{ root: { path: string } }>('/api/state');
    expect(underTmp(state.root.path), `library ${state.root.path}`).toBe(true);
    // Where it writes its log is where its state directory is — the push
    // register, the run journals and the inbox all live beside it.
    const debug = await api<{ sources: { path?: string | null }[] }>('/api/debug/index?source=supervisor');
    const log = debug.sources.map((s) => s.path).find((p) => p?.endsWith('console.out.log'));
    expect(log, 'the console named no log file').toBeTruthy();
    expect(underTmp(dirname(log!)), `state ${dirname(log!)}`).toBe(true);
    expect(realpathSync(dirname(log!))).toBe(realpathSync(fx.stateDir));
  });

  test('has one run on the toured plan with a live lane, and the seeded runs besides', async () => {
    const fx = await fixture();
    expect(fx.live, fx.why ?? '').toBe(true);
    const runs = await api<
      { runs?: { slug: string; status: string }[] } | { slug: string; status: string }[]
    >('/api/runs');
    const list = Array.isArray(runs) ? runs : (runs.runs ?? []);
    expect(list.some((r) => r.slug === fx.tourPlan && r.status === 'running')).toBe(true);
    for (const seeded of fx.runs) expect(list.map((r) => r.slug)).toContain(seeded.slug);
  });
});

test('a touch viewport really has no hover and a coarse pointer; a desk really has both', async ({
  page,
}, info) => {
  const viewport = VIEWPORTS.find((v) => v.name === info.project.name);
  expect(viewport, `no viewport named ${info.project.name}`).toBeTruthy();
  // At least one of each kind exists, or every touch assertion in the register
  // would pass vacuously.
  expect(VIEWPORTS.some((v) => v.touch)).toBe(true);
  expect(VIEWPORTS.some((v) => !v.touch)).toBe(true);
  await page.goto('/#/runs');
  const media = await page.evaluate(() => ({
    noHover: matchMedia('(hover: none)').matches,
    coarse: matchMedia('(pointer: coarse)').matches,
  }));
  expect(media).toEqual({ noHover: viewport!.touch, coarse: viewport!.touch });
});

// Dist mode (`PHASE_CONSOLE_DIST_DIR`, what `scripts/gates.sh` runs): the page
// is the production build, served by the console under its real headers. Every
// stop of the tour loads under that policy and the browser records not one
// `securitypolicyviolation` — an inline script, an eval, a font or a socket the
// policy does not name would each be one. In dev mode Vite serves the page and
// the console's policy is not on it, so there is nothing to measure.
test('every stop loads under the console’s own CSP, and the policy is never violated', async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== VIEWPORTS[VIEWPORTS.length - 1].name,
    'a fact about the build, not a viewport',
  );
  test.skip(!process.env.PHASE_CONSOLE_DIST_DIR, 'dev mode: Vite serves the page, not the console');
  const fx = await fixture();
  const refused: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) refused.push(m.text());
  });
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __pcCsp: string[] }).__pcCsp = seen;
    document.addEventListener('securitypolicyviolation', (e) =>
      seen.push(`${e.effectiveDirective} ${e.blockedURI || '(inline)'} ${e.sourceFile}:${e.lineNumber}`),
    );
  });
  const first = await page.goto('/');
  const policy = first?.headers()['content-security-policy'] ?? '';
  expect(policy, 'the served page carries no CSP — is this the console, or Vite?').toContain(
    "script-src 'self'",
  );
  expect(policy).not.toContain('unsafe-eval');
  const violations: string[] = [];
  for (const stop of STOPS) {
    await visit(page, stop, fx.anchor);
    // A hash change keeps the document, so the list carries across stops; a
    // new document starts a new one. Read and drain it at every stop.
    const now = await page.evaluate(() => {
      const w = window as unknown as { __pcCsp?: string[] };
      return (w.__pcCsp ?? []).splice(0);
    });
    violations.push(...now.map((v) => `${stop.name}: ${v}`));
  }
  expect([...violations, ...refused], 'CSP violations').toEqual([]);
});
