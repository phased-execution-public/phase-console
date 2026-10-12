/**
 * The sweep guard — the assertions that keep the 3.0 rebuild from growing its
 * predecessor back.
 *
 * Phases 6–11 moved every page out of `views/` into a `features/<destination>/`
 * module, and the last of them deleted the directory. None of that is
 * expressible as a type: nothing stops a future surface from adding
 * `views/thing.tsx` back, or from re-importing the adapter that let a 2.x view
 * render under the new shell. Both would work, and both would quietly restore
 * the two-worlds arrangement the rebuild existed to end.
 *
 * So the guard is a source walk, in the same shape (and for the same reasons)
 * as `screens/launch/single-source.test.ts`. When one fails, the fix is to
 * put the file where it belongs — never to widen the list.
 *
 * 7.0 (quiet-console) is the second rebuild, and the second describe block
 * holds it the same way: the client is `ui/`, `cards/`, `shell/`, `screens/`
 * and `data/` (with `lib/`, `styles/` and `content/` beside them), and the
 * 6.x tree it replaced — `app/`, `features/`, `components/`, `lib/api*` and
 * `lib/queries.ts` — does not exist. No path of it, no import of it, no door
 * into it, and one exported name per thing.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIVE_RUN_STATUSES } from '@shared/status-vocab.js';
import { DESTINATIONS } from '@shared/route-meta.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** This file sits AT the root of the tree it guards. */
const SRC = HERE;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sources(path, out);
      continue;
    }
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
    out.push(path);
  }
  return out;
}

const decommented = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const FILES = sources(SRC).map((path) => ({
  path: relative(SRC, path),
  text: decommented(readFileSync(path, 'utf8')),
}));

function offenders(pattern: RegExp, allowed: readonly string[] = []): string[] {
  return FILES.filter(({ path, text }) => pattern.test(text) && !allowed.includes(path)).map(
    ({ path }) => path,
  );
}

describe('the 3.0 sweep', () => {
  it('has no src/views directory at all', () => {
    // Not "is empty" — absent. An empty directory is an invitation, and the
    // last three files in it (settings, mcp, notifications) each arrived
    // because the one before it was still there.
    expect(existsSync(join(SRC, 'views'))).toBe(false);
  });

  it('has no file importing from @/views or ./views', () => {
    expect(offenders(/from '(@\/views|\.\.?\/+views)/)).toEqual([]);
  });

  it('has no legacy-route adapter left', () => {
    // It was the boundary that let a 2.x view render under the 3.0 shell. The
    // Suspense boundary it carried is permanent and lives on as
    // `shell/route-frame.tsx`; the adapter it was named for is not.
    expect(offenders(/\bLegacyRoute\b/)).toEqual([]);
  });

  it('never imports a bare @/router — the router is @/shell/router', () => {
    // `@/router` was the 2.x path. It resolves to nothing now, but a stale
    // import in a lazily-loaded chunk is a runtime failure on ONE route, which
    // is exactly the kind that ships.
    expect(offenders(/from '@\/router'/)).toEqual([]);
  });

  it('has no Now left — 6.0 folded it into Runs, and its address is a redirect', () => {
    expect(DESTINATIONS).not.toContain('now');
  });

  /**
   * `shared/status-vocab.js` states the rule on LIVE_RUN_STATUSES itself — "one
   * definition because three surfaces ask the question … and they had a copy
   * each" — and CLAUDE.md repeats it. It still grew a fourth copy, in the one
   * client file that did not import `isLiveStatus`, and nothing failed: a
   * hand-written array of run statuses is ordinary-looking code that
   * typechecks. The copy is only wrong the day the vocabulary changes, which
   * is the day nobody is looking at this file.
   *
   * So: no array literal in client/src may restate the LIVE set. A local array
   * naming two of the seven is a local decision ("the timeline draws `waiting`
   * and `frozen` the same"); one naming four or more is an answer to "is this
   * run live?", and that answer has an owner.
   */
  it('never re-spells the live-run vocabulary as a local array', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const [span] of file.text.matchAll(/\[[^[\]]*\]/g)) {
        const named = LIVE_RUN_STATUSES.filter((w) => span.includes(`'${w}'`) || span.includes(`"${w}"`));
        if (named.length >= 4) offenders.push(`${file.path}: [${named.join(', ')}]`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the 7.0 rebuild', () => {
  /**
   * The 6.x client is gone, every file of it. Not "nothing imports it" —
   * absent: a directory left behind is an invitation, and each of the 3.0
   * sweep's last three stragglers arrived because the one before it was still
   * there. And no file reaches for one of its paths, statically or by
   * `import()`, by alias or by a relative escape — a stale import in a lazy
   * chunk is a failure on ONE route, the kind that ships.
   */
  const OLD_PATHS = ['app', 'features', 'components', 'lib/api', 'lib/api.ts', 'lib/queries.ts'];
  const OLD_IMPORT =
    /(?:from\s*|import\(\s*|import\s+|vi\.mock\(\s*)['"](?:@\/|(?:\.\.?\/)+)(?:app|features|components|lib\/api|lib\/queries)(?:['"/.])/;

  it('has no path of the 6.x client: app/, features/, components/, lib/api*, lib/queries.ts', () => {
    expect(OLD_PATHS.filter((path) => existsSync(join(SRC, path)))).toEqual([]);
  });

  it('has no file — page, test or helper — importing, loading or mocking a 6.x path', () => {
    const all = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) all(path, out);
        else if (/\.tsx?$/.test(name)) out.push(path);
      }
      return out;
    };
    // This file is the one that spells the paths, as the examples below.
    const reaching = all(SRC)
      .map((path) => relative(SRC, path))
      .filter((path) => path !== 'sweep.test.ts')
      .filter((path) => OLD_IMPORT.test(decommented(readFileSync(join(SRC, path), 'utf8'))));
    expect(reaching).toEqual([]);
    // The pattern sees each spelling it exists to refuse.
    for (const line of [
      "import { Button } from '@/components/ui';",
      "const m = import('@/features/runs/x');",
      "vi.mock('@/lib/api', () => ({}));",
      "import { q } from '../lib/queries';",
      "export * from '../../app/router';",
    ]) {
      expect(OLD_IMPORT.test(line), line).toBe(true);
    }
    expect(OLD_IMPORT.test("import { api } from '@/data/api';")).toBe(false);
  });

  it('gives every destination a page of its own: screens/<d>/index.tsx', () => {
    // Read off the shared list rather than a copy of it: a destination added
    // there without a page is the dead nav entry this guard exists to catch.
    for (const destination of DESTINATIONS) {
      expect(existsSync(join(SRC, 'screens', destination, 'index.tsx')), `${destination} has no page`).toBe(
        true,
      );
    }
  });

  /**
   * No legacy loader exists (quiet-console phase 21, phase 24's exit criterion
   * 4 by ruling `d9a0c244ee77`). The old pages were drawn inside the 7.0 shell
   * through `screens/legacy.ts`, one loader per place not yet rebuilt; each
   * phase took its place out (7 `runs` and `queue`, 8 `turn`, 9 `plans`, 10
   * `plan`, 15 `sessions`, 16 `chat`, 17 `repo`, 19 `insights`, 20 `logs`, 24
   * `fleet`) and 21 the last two, `settings` and its `source` picker, with the
   * file. Nothing brings it back: a loader of an old page would be a page drawn
   * by the tree 7.0 replaces. The router loads only screens.
   */
  it('has no legacy loader: screens/legacy.ts is gone and the router loads only screens', () => {
    expect(existsSync(join(SRC, 'screens', 'legacy.ts'))).toBe(false);
    const router = readFileSync(join(SRC, 'shell', 'router.tsx'), 'utf8');
    const loaded = [...router.matchAll(/import\('(@\/[^']+)'\)/g)].map((m) => m[1]!);
    expect(loaded.length).toBeGreaterThan(5);
    expect(loaded.filter((path) => !path.startsWith('@/screens/'))).toEqual([]);
  });

  /**
   * No door into the old tree (quiet-console phase 26). A new screen reached a
   * piece not yet rebuilt through one lazy door — `shell/legacy-doors.tsx`, or a
   * screen's own `legacy-sections.tsx` — and each phase that rebuilt a piece
   * closed its door: the launch form's in 14, the terminal's in 15, the
   * Supervisor's in 16, and the last two, the help sheet (`shell/help/`) and
   * the plan page's situation summary, in 26 with both files. Zero doors, and
   * zero loaders: the boundary lint reads static imports only, so a dynamic
   * `import()` of the old tree from the new one is the door this refuses.
   */
  it('has no door into the old tree: no door file anywhere', () => {
    expect(existsSync(join(SRC, 'shell', 'legacy-doors.tsx'))).toBe(false);
    const doorFiles = sources(join(SRC, 'screens')).filter((path) =>
      path.endsWith(`${sep}legacy-sections.tsx`),
    );
    expect(doorFiles.map((path) => relative(SRC, path))).toEqual([]);
  });

  /**
   * The 6.x tree had 29 exported names defined twice or more — three
   * components called "Situation", theme options defined three times. The
   * client holds none: a name is DECLARED in one file and imported everywhere
   * else. A re-export list (`export { x } from`, `export *`) passes a name on
   * rather than defining it, and `default` is a module's own, so neither
   * counts. `data/` is not walked: its wire types name the very words the
   * status family draws (`RunStatus` the type of a run's status word,
   * `RunStatus` the badge that draws it), on the two sides of the data door.
   */
  it('declares no exported name in two files across the client', () => {
    const DECLARED =
      /^[ \t]*export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:const\s+enum|const|let|var|function\*?|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;
    const where = new Map<string, Set<string>>();
    for (const { path, text } of FILES) {
      if (path.split(sep)[0] === 'data') continue;
      for (const [, name] of text.matchAll(DECLARED)) {
        where.set(name!, (where.get(name!) ?? new Set<string>()).add(path));
      }
    }
    // The walk saw the tree: an empty map would pass for the wrong reason.
    expect(where.size).toBeGreaterThan(100);
    const twice = [...where]
      .filter(([, files]) => files.size > 1)
      .map(([name, files]) => `${name}: ${[...files].join(', ')}`);
    expect(twice).toEqual([]);
  });
});
