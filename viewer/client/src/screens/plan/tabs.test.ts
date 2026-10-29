/**
 * The plan page's view vocabulary, as a contract (7.0, quiet-console phase 10;
 * ported from `features/plans/tabs.test.ts`).
 *
 * Three properties, and each one is a bug this codebase has actually shipped:
 *
 * 1. **Every id in `PLAN_TABS` has a label and a body.** `autopilot` was once
 *    registered as `run` in the router and spelled `autopilot` in the server's
 *    notification links, so every approval push opened a blank page for the
 *    life of that feature. A test that walks the shared array is the only thing
 *    that catches an id existing in the URL vocabulary and nowhere else.
 * 2. **`run` survives.** The server routes every in-flight-run notification to
 *    it (`server/push/catalogue.ts`), and the Node suite asserts the other half.
 * 3. **A retired id still resolves.** `analysis`, `overview` and `raw` are in
 *    bookmarks and in handoff prose; the redirect is what moves the address,
 *    and this is what the page shows for the render before it lands.
 *
 * The body side is asserted against `index.tsx`'s own switch (`ViewBody`)
 * rather than a second list of ids — a list here would agree with itself and
 * with nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_PLAN_TABS, PLAN_PHASE_VIEWS, PLAN_RUN_VIEWS, PLAN_TABS } from '@shared/route-meta.js';
import {
  DOCUMENT_PLAN_FIELDS,
  HANDOFF_PROSE_FIELDS,
  MEMORY_FIELDS,
  PLAN_INCLUDES,
  PROSE_PHASE_FIELDS,
} from '@shared/projection.js';
import {
  DETAIL_TABS,
  PHASES_VIEW_IDS,
  PHASES_VIEW_LABELS,
  PLAN_VIEW_LABELS,
  PROSE_INCLUDES,
  RUN_VIEW_IDS,
  TAB_IDS,
  TAB_INCLUDES,
  includesForTab,
  isDetailRoute,
  isLegacyTab,
  legacyTabTarget,
  phasesViewOf,
  resolveTab,
  runViewOf,
  sourceViewOf,
  tabLabel,
} from './tabs';

const here = dirname(fileURLToPath(import.meta.url));

/** `index.tsx` — the page, whose `ViewBody` is the body side of the contract, read as source. */
const pageSource = readFileSync(join(here, 'index.tsx'), 'utf8');

describe('the plan view vocabulary', () => {
  it('is exactly the shared list, in the shared order', () => {
    expect(TAB_IDS).toEqual([...PLAN_TABS]);
  });

  it('gives every id a real label — never the id falling through', () => {
    for (const id of PLAN_TABS) {
      expect(PLAN_VIEW_LABELS[id], `no label for '${id}'`).toBeTruthy();
      expect(tabLabel(id)).not.toBe(id);
    }
  });

  it('gives every id, and both detail routes, a real body in ViewBody', () => {
    // `phases` is also the switch's `default:` — deliberate, so that an id the
    // vocabulary gains before its body lands on the grid rather than on
    // nothing — and it names its own case too.
    for (const id of [...PLAN_TABS, ...Object.keys(DETAIL_TABS)]) {
      expect(pageSource, `ViewBody has no case for '${id}'`).toContain(`case '${id}':`);
    }
  });

  it('is four views since 8.0 — phases, run, your turn, source (one-pool phase 14, #366)', () => {
    expect([...PLAN_TABS]).toEqual(['phases', 'run', 'turn', 'source']);
    expect(tabLabel('turn')).toBe('Your turn');
  });

  it('keeps `run` — every in-flight notification is routed to it', () => {
    expect(PLAN_TABS).toContain('run');
  });

  it('has no id that is both live and retired', () => {
    for (const id of PLAN_TABS) expect(isLegacyTab(id), `'${id}' is both`).toBe(false);
  });
});

describe('the retired tabs', () => {
  it('names all six, and only tabs that really left', () => {
    expect(Object.keys(LEGACY_PLAN_TABS).sort()).toEqual([
      'analysis',
      'handoffs',
      'overview',
      'qa',
      'raw',
      'route',
    ]);
  });

  it('folds Route, QA and Handoffs into readings of the phase grid, carrying the reading', () => {
    // The server still mints `#/plan/:slug/route` — it must land on the map.
    const legacy = LEGACY_PLAN_TABS as Record<string, { tab?: string; view?: string }>;
    expect(legacy.route).toEqual({ tab: 'phases', view: 'map' });
    // QA and Handoffs are ONE reading since 2026-10-20 (Tower strips): both land on it.
    expect(legacy.qa).toEqual({ tab: 'phases', view: 'handoffs' });
    expect(legacy.handoffs).toEqual({ tab: 'phases', view: 'handoffs' });
    for (const id of ['route', 'qa', 'handoffs']) {
      expect(resolveTab(id), id).toBe('phases');
      expect(PHASES_VIEW_IDS, `${id}'s reading is a real reading`).toContain(legacy[id]!.view);
    }
  });

  it('sends the two file readings to Source and the numbers off the page', () => {
    expect(legacyTabTarget('overview')).toBe('source');
    expect(legacyTabTarget('raw')).toBe('source');
    // `analysis` names a HEAD, not a view of this page — the redirect turns
    // that into `#/insights?plan=…`.
    expect(legacyTabTarget('analysis')).toBeUndefined();
  });

  it('resolves a retired id to what it became, not to the fallback', () => {
    expect(resolveTab('overview')).toBe('source');
    expect(resolveTab('raw')).toBe('source');
  });

  it('keeps `raw` distinguishable from `overview` — see the ?view= note', () => {
    const raw = LEGACY_PLAN_TABS.raw as { tab?: string; view?: string };
    const overview = LEGACY_PLAN_TABS.overview as { tab?: string; view?: string };
    expect(raw.view).toBe('raw');
    expect(overview.view).toBeUndefined();
    // …and the Source view reads the half of the address that says so.
    expect(sourceViewOf(raw.view)).toBe('raw');
    expect(sourceViewOf(overview.view)).toBe('reading');
  });

  it('keeps a word for every retired id, for the render before its redirect lands', () => {
    for (const id of Object.keys(LEGACY_PLAN_TABS)) expect(tabLabel(id), id).not.toBe(id);
  });
});

describe('the readings of each view', () => {
  it('Phases: the shared five, each with a word of its own', () => {
    expect([...PHASES_VIEW_IDS]).toEqual([
      'table',
      'map',
      'handoffs',
      'schedule',
      'burnup',
    ]);
    expect([...PHASES_VIEW_IDS]).toEqual([...PLAN_PHASE_VIEWS]);
    for (const id of PHASES_VIEW_IDS) expect(PHASES_VIEW_LABELS[id], id).toBeTruthy();
    expect(PHASES_VIEW_LABELS.handoffs).toBe('Handoffs & QA');
  });

  it('Phases: reads an unknown or absent ?view= as the table', () => {
    expect(phasesViewOf(undefined)).toBe('table');
    expect(phasesViewOf('raw')).toBe('table');
    expect(phasesViewOf('map')).toBe('map');
    // The QA reading's old address opens the reading it became.
    expect(phasesViewOf('qa')).toBe('handoffs');
    expect(phasesViewOf('handoffs')).toBe('handoffs');
  });

  it('Run and Source: the shared run readings, and anything unknown is the default reading', () => {
    expect([...RUN_VIEW_IDS]).toEqual([...PLAN_RUN_VIEWS]);
    expect(runViewOf(undefined)).toBe('live');
    expect(runViewOf('history')).toBe('history');
    expect(runViewOf('nonsense')).toBe('live');
    expect(sourceViewOf(undefined)).toBe('reading');
    expect(sourceViewOf('nonsense')).toBe('reading');
  });
});

describe('resolveTab', () => {
  it('opens on Phases with no segment, and for a word nobody registered', () => {
    expect(resolveTab(undefined)).toBe('phases');
    expect(resolveTab('')).toBe('phases');
    expect(resolveTab('not-a-tab')).toBe('phases');
  });

  it('shows the list a detail page was reached from', () => {
    expect(resolveTab('phase')).toBe('phases');
    // A handoff's list is a reading of the phase grid since 6.0.
    expect(resolveTab('handoff')).toBe('phases');
    // And those two lists are themselves real views.
    for (const target of Object.values(DETAIL_TABS)) expect(PLAN_TABS).toContain(target);
    for (const id of Object.keys(DETAIL_TABS)) expect(isDetailRoute(id), id).toBe(true);
    for (const id of PLAN_TABS) expect(isDetailRoute(id), id).toBe(false);
  });

  it('is identity on every live id', () => {
    for (const id of PLAN_TABS) expect(resolveTab(id)).toBe(id);
  });
});

/**
 * What each view FETCHES, held against what it RENDERS.
 *
 * The plan detail is projected (`shared/projection.js`): the board answer is
 * 47.8 KB and the full one 286.5 KB, so a view asks for the groups it renders.
 * The failure mode this guards is silent — a view added without an entry gets
 * the board projection, and its prose is simply `undefined` on the page with
 * no error anywhere.
 */
describe('the include set each view asks for', () => {
  it('names a group every view and detail route registers', () => {
    for (const id of [...PLAN_TABS, ...Object.keys(DETAIL_TABS)]) {
      expect(
        TAB_INCLUDES,
        `'${id}' has no include entry — it would silently get the board projection`,
      ).toHaveProperty(id);
    }
  });

  it('only asks for groups the server actually accepts', () => {
    for (const [tab, groups] of Object.entries(TAB_INCLUDES)) {
      for (const group of groups) {
        expect(
          PLAN_INCLUDES,
          `view '${tab}' asks for '${group}', which is not a documented include`,
        ).toContain(group);
      }
      // `full` would put the projection back exactly where it was.
      expect(
        groups,
        `view '${tab}' asks for everything — that is the payload this phase removed`,
      ).not.toContain('full');
    }
  });

  it('gives the same array identity every call, so a query key is stable across renders', () => {
    // `usePlan` puts the include set in its TanStack query key. A fresh literal
    // per render would be a fresh key per render: refetch on every paint, and
    // `keepPreviousData` never able to hold the previous answer.
    expect(includesForTab('phases')).toBe(includesForTab('phases'));
    expect(includesForTab('route')).toBe(includesForTab('route'));
    expect(includesForTab('not-a-tab')).toBe(includesForTab('also-not-a-tab'));
  });

  it('asks for prose only where the long prose is rendered', () => {
    // The board surfaces render `title`, `goal`, `proof`, `row`, `analysis`,
    // the lock and the handoff STATUS — all board fields, so the views that
    // show them ask for nothing. The two that render the page-length prose
    // (the phase page, and the run view's grid) ask.
    for (const tab of ['phases', 'handoff']) {
      expect(includesForTab(tab), `view '${tab}'`).toEqual([]);
    }
    for (const tab of ['phase', 'run']) {
      expect(includesForTab(tab)).toContain('prose');
      expect(includesForTab(tab)).toContain('handoffs');
    }
    expect(includesForTab('source')).toEqual(['document', 'memory']);
    // What a phase's drawer and inspector fetch for themselves IS the phase
    // page's set — so on the phase page and the Run view the key is warm.
    expect(PROSE_INCLUDES).toBe(TAB_INCLUDES.phase);
  });

  /**
   * THE RENDER TREE, per COMPONENT — not the import graph, and not per file.
   *
   * Three wrong answers were tried before this one, and each was green while
   * the Route tab rendered two fields it never asked for:
   *
   *   1. **A hand-written file→view map.** A cells file is mounted by four
   *      views and the map named only the one that happened to ask.
   *   2. **An import-graph walk.** A view imports a helper from a file that
   *      also exports a prose renderer — so an import walk demands `prose` for
   *      a view that renders none of it.
   *   3. **A file-granular render walk.** `phases/cells.tsx` exports both the
   *      board cells (`DepsCell`, `SizeCell`) and `PhaseDetails`; reaching the
   *      file says nothing about which of them was mounted.
   *
   * So the unit is a COMPONENT. From each view's entry — what `index.tsx`'s
   * `ViewBody` mounts for it, read off the switch — and from everything the
   * page mounts OUTSIDE `ViewBody` on every view, every `<Name>` tag in a
   * component's own body is resolved to the component that defines it and
   * walked in turn, and field reads are checked against each body alone. A
   * call (`groupRows(...)`) is not a render edge and is correctly ignored.
   *
   * The resolver follows what 7.0's tree is made of: a named import (`as`
   * included), a re-export door (`export { PhaseTable } from …`, which is how
   * the old run page draws the new grid), a `lazy(() => import(…))` — with
   * `.then` naming the export, or the module's default — and a `memo(X)`.
   *
   * ⚠️ **WHAT THIS CANNOT SEE.** A static JSX walk has real blind spots, and a
   * QA pass planted a defect in each to prove they are blind. None hides a
   * live defect today; all are things to check BY HAND when you touch a
   * projected field:
   *
   *   1. A destructured read — `const { steps } = phase`.
   *   2. A renamed receiver — `ph.steps` (the pattern below knows `phase`,
   *      `view`, `p`, `h`, `record`, `detail`, `plan`).
   *   3. **A field read inside a plain function that is CALLED, not rendered.**
   *      `inspectPhase` is that shape — it hands the panel its JSX through a
   *      call — which is why it is a ROOT of the Phases view below.
   *   4. A component reached through a variable — `[C].map(…)`, or a table of
   *      components: the grid's column arrays, which are roots for the same
   *      reason.
   *   5. Anything behind a directory barrel (`@/ui`, `@/ui/status`) — the
   *      resolver reads files, not directories, so an index re-export ends the
   *      walk.
   *
   * The right response to a blind spot is not to widen the regex until it
   * over-reports; it is to keep field reads close to the component that renders
   * them, where this test can see them.
   */
  it("every view that renders a projected field asks for that field's group", () => {
    const srcRoot = join(here, '..', '..');
    const PAGE = 'screens/plan/index';

    /**
     * A projected field → the include group that returns it, DERIVED from
     * `shared/projection.js` rather than written out again.
     *
     * A hand-written copy is how the first version of this test passed while
     * `goal` was projected away and the Route tab rendered a blank: the field
     * had been moved into a group and nobody added it here. Deriving it means
     * moving a field between groups — or into one — cannot outrun its guard.
     */
    const FIELD_GROUP: Record<string, string> = Object.fromEntries([
      ...PROSE_PHASE_FIELDS.map((f) => [f, 'prose'] as const),
      ...DOCUMENT_PLAN_FIELDS.map((f) => [f, 'document'] as const),
      ...HANDOFF_PROSE_FIELDS.map((f) => [f, 'handoffs'] as const),
      ...MEMORY_FIELDS.map((f) => [f, 'memory'] as const),
    ]);
    expect(Object.keys(FIELD_GROUP).length, 'no projected fields to check?').toBeGreaterThan(5);

    /**
     * Keys, extensionless — every path in this walk is relative to
     * `client/src` and has no extension, so a component reached from two
     * places under two spellings is ONE key. A map keyed on one spelling
     * silently matches nothing from the other, which reads exactly like a
     * boundary that does not work.
     */
    const norm = (file: string) => file.replace(/\.tsx?$/, '');

    const sources = new Map<string, string | null>();
    const read = (rel: string): string | null => {
      const key = norm(rel);
      if (sources.has(key)) return sources.get(key)!;
      let found: string | null = null;
      for (const ext of ['.tsx', '.ts']) {
        try {
          found = readFileSync(join(srcRoot, key + ext), 'utf8');
          break;
        } catch {
          /* next */
        }
      }
      sources.set(key, found);
      return found;
    };

    /** Comments out: a tag or a field named in a note is not a render. */
    const code = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1 ');

    /** Every top-level `function`/`const` in a file, name → its body text. */
    const bodiesOf = (source: string): Map<string, string> => {
      const decl = /^(?:export\s+)?(?:default\s+)?(?:function|const)\s+([A-Za-z0-9_]+)/gm;
      const marks = [...source.matchAll(decl)].map((m) => ({ name: m[1], at: m.index! }));
      const out = new Map<string, string>();
      marks.forEach((mark, i) => {
        out.set(mark.name, source.slice(mark.at, marks[i + 1]?.at ?? source.length));
      });
      return out;
    };

    /** `<Name` tags inside one component body, DOM tags excluded. */
    const tagsIn = (body: string): string[] =>
      [...code(body).matchAll(/<([A-Z][A-Za-z0-9_]*)/g)].map((m) => m[1]);

    /** A module specifier as a path relative to `client/src` — `null` for a package or `@shared`. */
    const pathOf = (file: string, spec: string): string | null => {
      const base = spec.startsWith('@/')
        ? norm(spec.slice(2))
        : spec.startsWith('.')
          ? norm(join(dirname(file), spec))
          : null;
      if (base == null) return null;
      // A folder's module is its index file — the Run view is `./run` (quiet-
      // console phase 11) — named as the file, so ITS relative imports resolve.
      return read(base) == null && read(`${base}/index`) != null ? `${base}/index` : base;
    };

    /** `{ a, b as c }` → [exported, local] pairs. */
    const namesIn = (list: string): [string, string][] =>
      list
        .split(',')
        .map((x) => x.trim().replace(/^type\s+/, ''))
        .filter(Boolean)
        .map((x) => {
          const [exported, local] = x.split(/\s+as\s+/);
          return [exported!.trim(), (local ?? exported!).trim()];
        });

    /** Where `name`, as `file` sees it, is IMPORTED from — the module, and the name it has there. */
    const importOf = (source: string, file: string, name: string): [string, string] | null => {
      for (const m of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
        const hit = namesIn(m[1]).find(([, local]) => local === name);
        if (!hit) continue;
        const target = pathOf(file, m[2]);
        return target ? [target, hit[0]] : null;
      }
      return null;
    };

    /** The name a module's `export default` gives its component. */
    const defaultOf = (source: string): string | null =>
      source.match(/export\s+default\s+(?:function\s+)?([A-Za-z0-9_]+)/)?.[1] ?? null;

    /**
     * Which component `name` IS, seen from `file`: its own declaration, or —
     * through an import, a re-export door, a `lazy(() => import(…))` or a
     * `memo(X)` — the declaration those lead to. `null` for a package, a
     * barrel (blind spot 5), or a name nothing defines.
     */
    const resolve = (file: string, name: string, depth = 0): [string, string] | null => {
      if (depth > 12) return null;
      const at = norm(file);
      const source = read(at);
      if (source === null) return null;
      const body = bodiesOf(source).get(name);
      if (body !== undefined) {
        const lazy = body.match(
          /^(?:export\s+)?const\s+\w+\s*=\s*lazy\(\s*\(\)\s*=>\s*import\('([^']+)'\)(?:\.then\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\(\{\s*default:\s*\2\.(\w+)\s*\}\)\s*\))?/,
        );
        if (lazy) {
          const target = pathOf(at, lazy[1]);
          const targetSource = target ? read(target) : null;
          const exported = lazy[3] ?? (targetSource ? defaultOf(targetSource) : null);
          return target && exported ? resolve(target, exported, depth + 1) : null;
        }
        const memo = body.match(/^(?:export\s+)?const\s+\w+\s*=\s*memo\(\s*([A-Za-z0-9_]+)\s*\)/);
        if (memo) return resolve(at, memo[1], depth + 1);
        return [at, name];
      }
      const imported = importOf(source, at, name);
      if (imported) return resolve(imported[0], imported[1], depth + 1);
      for (const m of source.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
        const hit = namesIn(m[1]).find(([, exported]) => exported === name);
        // A re-export reads `export { inner as outer }`: the pair is reversed.
        if (!hit) {
          const aliased = namesIn(m[1]).find(([, local]) => local === name);
          if (!aliased) continue;
          const target = pathOf(at, m[2]);
          return target ? resolve(target, aliased[0], depth + 1) : null;
        }
        const target = pathOf(at, m[2]);
        return target ? resolve(target, hit[0], depth + 1) : null;
      }
      return null;
    };

    const page = read(PAGE);
    expect(page, 'no screens/plan/index.tsx').not.toBeNull();
    const pageBodies = bodiesOf(page!);

    /**
     * What `ViewBody` mounts for each view, READ OFF ITS SWITCH — a case with
     * no `return` of its own falls through to the next one (`phases` is the
     * `default:`'s). A hand-written list here would be a second copy of the
     * switch, free to disagree with it.
     */
    const viewBody = pageBodies.get('ViewBody');
    expect(viewBody, 'index.tsx no longer has a ViewBody — the walk has no entries').toBeDefined();
    const ENTRY: Record<string, [file: string, component: string][]> = {};
    {
      const marks = [...code(viewBody!).matchAll(/case '([^']+)':|default:/g)];
      let waiting: string[] = [];
      marks.forEach((mark, i) => {
        if (mark[1]) waiting.push(mark[1]);
        const segment = code(viewBody!).slice(mark.index! + mark[0].length, marks[i + 1]?.index);
        if (!/\breturn\b/.test(segment)) return;
        const entries = tagsIn(segment)
          .map((tag) => resolve(PAGE, tag))
          .filter((x): x is [string, string] => x !== null);
        for (const id of waiting) ENTRY[id] = entries;
        waiting = [];
      });
    }

    // F-N3: the map above is derived, but a switch can still lose a case —
    // so it needs a completeness check, or a view with no body walks nothing.
    for (const tab of [...PLAN_TABS, ...Object.keys(DETAIL_TABS)]) {
      expect(ENTRY, `ViewBody mounts nothing for '${tab}' — its render tree is never walked`).toHaveProperty(
        tab,
      );
      expect(ENTRY[tab]!.length, `ViewBody's case for '${tab}' resolves to no component`).toBeGreaterThan(0);
    }
    expect(Object.keys(ENTRY).sort()).toEqual([...PLAN_TABS, ...Object.keys(DETAIL_TABS)].sort());

    /**
     * What the page mounts OUTSIDE `ViewBody` renders on EVERY view — the
     * glance, the trouble, the QA line, the banners, the facts — so it is a
     * root of every walk, not a child of any one of them. Read off `PlanPage`
     * itself: a card added above the views is walked the day it lands.
     */
    const planPage = pageBodies.get('PlanPage');
    expect(planPage, 'index.tsx no longer has a PlanPage').toBeDefined();
    const pageTags = tagsIn(planPage!);
    expect(pageTags, 'PlanPage no longer mounts ViewBody — the walk is vacuous').toContain('ViewBody');
    const ALWAYS = pageTags
      .filter((tag) => tag !== 'ViewBody')
      .map((tag) => resolve(PAGE, tag))
      .filter((x): x is [string, string] => x !== null);

    /*
     * Roots a JSX walk cannot reach (blind spots 3 and 4), walked as if they
     * were components. The phase grid's column array is a root of both views
     * that draw the grid: its cells are render functions in an array. The
     * inspector is a root of the Phases view, whose grid is the inspectable one:
     * Inspect hands the panel its JSX through `inspectPhase(row)`, a call. The
     * Source view's two grids build their columns in functions.
     */
    const COLUMNS: [string, string] = ['screens/plan/phases/table', 'PHASE_COLUMNS'];
    const INSPECT: [string, string] = ['screens/plan/phases/inspector', 'inspectPhase'];
    const EXTRA: Record<string, [file: string, component: string][]> = {
      phases: [COLUMNS, INSPECT],
      run: [COLUMNS],
      source: [
        ['screens/plan/source/source-tab', 'graphColumns'],
        ['screens/plan/source/source-tab', 'decisionColumns'],
      ],
    };
    // The roots are claims too: each must exist, and the inspector is a root
    // only where the grid offers Inspect.
    for (const [file, name] of Object.values(EXTRA).flat()) {
      expect(bodiesOf(read(file) ?? '').get(name), `${file}#${name}: no such root`).toBeDefined();
    }
    expect(code(read('screens/plan/phases/view') ?? ''), 'the Phases view no longer offers Inspect').toMatch(
      /<PhaseTable[\s\S]*?\binspectable\b/,
    );

    /**
     * Components that fetch their OWN projection groups — a boundary the walk
     * has to know about, or it reports a defect that is not there.
     *
     * The rule this guard enforces is "a rendered field must have been
     * FETCHED", and a view's include set is only one way to fetch it. A
     * component that calls `usePlan` with its own include set has satisfied
     * the rule for everything below it, and forcing its host view to ask
     * instead would make every plan open pay for prose nobody had asked to
     * read — the exact cost `tabs.ts` explains at length.
     *
     * This is a strengthening, not an exemption: the entry is verified against
     * the component's source below, so a boundary that stops fetching (or that
     * quietly narrows what it asks for) fails here rather than rendering
     * blanks. Nothing is trusted because it was written in this map.
     */
    const SELF_FETCHING: Record<string, readonly string[]> = {
      // The phase's prose under a grid row's detail AND in the inspector's
      // Overview (quiet-console phase 10) — one boundary, two hosts.
      'screens/plan/phases/drawer#PhaseProse': ['prose', 'handoffs'],
    };

    /**
     * The include constants a boundary may NAME rather than spell, each read
     * at RUNTIME from the module that exports it — never from its text.
     */
    const INCLUDE_CONSTANTS: Record<string, { from: string; groups: readonly string[] }> = {
      PROSE_INCLUDES: { from: 'screens/plan/tabs', groups: PROSE_INCLUDES },
    };

    /** One key shape, used by BOTH the head dedup and the enqueue guard. */
    const keyOf = (file: string, name: string, asked: Set<string>) =>
      `${norm(file)}#${name}#${[...asked].sort().join(',')}`;

    // The honesty check. A map entry is a CLAIM about a component; this is the
    // component being made to back it. Without this the map would be a way to
    // silence the guard by typing a line into it.
    for (const [key, groups] of Object.entries(SELF_FETCHING)) {
      const [file, name] = key.split('#') as [string, string];
      const source = read(file);
      expect(source, `${key}: no such file`).not.toBeNull();
      const body = bodiesOf(source!).get(name);
      expect(body, `${key}: no such component`).toBeDefined();
      /*
       * The include list must be a module-level constant (a fresh literal per
       * render is a fresh query key per render). Named from another module, it
       * is read at runtime from THAT module — and the import must lead there;
       * written in this file, it is asserted against the file with its
       * COMMENTS STRIPPED. Searching the raw source let a narrowed constant
       * stay green as long as the removed group survived in a `// was [...]`
       * note beside it, which is the one way this check could be talked out of
       * its job.
       */
      const call = code(body!).match(/usePlan\(\s*[^,()]+,\s*([A-Za-z0-9_.!]+)\s*\)/);
      expect(call, `${key} claims to self-fetch but never calls usePlan with an include set`).not.toBeNull();
      const named = INCLUDE_CONSTANTS[call![1]];
      if (named) {
        expect(importOf(source!, file, call![1])?.[0], `${key} names ${call![1]} from somewhere else`).toBe(
          named.from,
        );
        for (const group of groups) {
          expect(named.groups, `${key} claims ?include=${group} and ${call![1]} does not carry it`).toContain(
            group,
          );
        }
      } else {
        for (const group of groups) {
          expect(code(source!), `${key} claims ?include=${group} and its code never names it`).toContain(
            `'${group}'`,
          );
        }
      }
    }

    const problems: string[] = [];
    const reached = new Map<string, Set<string>>();
    for (const [tab, entries] of Object.entries(ENTRY)) {
      const tabAsked = new Set(includesForTab(tab));
      const seen = new Set<string>();
      // Each node carries the include set in force where it was reached — a
      // self-fetching boundary widens it for its whole subtree and for nothing
      // else, so a component that renders prose OUTSIDE the boundary is still
      // caught on a view that did not ask for it.
      const queue: [file: string, component: string, asked: Set<string>][] = [
        ...entries,
        ...ALWAYS,
        ...(EXTRA[tab] ?? []),
      ].map(([file, name]) => [norm(file), name, tabAsked]);
      let walked = 0;
      while (queue.length) {
        const [file, name, inherited] = queue.shift()!;
        /*
         * Keyed by the include set IN FORCE as well as by the component.
         *
         * A self-fetching boundary widens the set for its subtree, so a
         * component reachable both inside a boundary and outside it is two
         * different questions. Keyed on the component alone, whichever path
         * the queue reached first would answer for both, and the
         * outside-the-boundary reader (the one that actually renders blanks)
         * would be skipped.
         */
        const key = keyOf(file, name, inherited);
        if (seen.has(key)) continue;
        const source = read(file);
        if (source === null) continue;
        const body = bodiesOf(source).get(name);
        if (body === undefined) continue;
        seen.add(key);
        walked++;
        const own = SELF_FETCHING[`${file}#${name}`];
        const asked = own ? new Set([...inherited, ...own]) : inherited;

        const text = code(body);
        for (const [field, group] of Object.entries(FIELD_GROUP)) {
          // Reading the field off a phase, a phase-like local, or the detail.
          if (!new RegExp(`\\b(?:phase|view|p|h|record|detail|plan)\\??!?\\.${field}\\b`).test(text))
            continue;
          if (!asked.has(group)) {
            problems.push(
              `view '${tab}' renders <${name}> (${file}), which reads .${field} — that is ` +
                `?include=${group}, and the view asks for [${[...asked].join(', ') || 'nothing'}]`,
            );
          }
        }

        for (const tag of new Set(tagsIn(body))) {
          const target = resolve(file, tag) ?? [file, tag];
          // The SAME key shape the head of the loop dedups on.
          if (!seen.has(keyOf(target[0], target[1], asked))) queue.push([target[0], target[1], asked]);
        }
      }
      expect(
        walked,
        `render tree for '${tab}' is empty — is the entry component name right?`,
      ).toBeGreaterThan(0);
      reached.set(tab, seen);
    }

    // THE WALKER ITSELF, red-proved against the edges that matter. A walk that
    // quietly stopped following JSX would report no problems and look exactly
    // like a clean bill of health, so it has to be made to show that it
    // reaches components several hops from the entry — through each kind of
    // edge the resolver claims to follow.
    const has = (tab: string, name: string) =>
      [...(reached.get(tab) ?? [])].some((key) => key.split('#')[1] === name);
    expect(has('phases', 'PhasesView'), 'phases → PhasesView (the view’s body)').toBe(true);
    expect(has('phases', 'PhaseTable'), 'phases → PhaseTable (the one grid)').toBe(true);
    expect(has('phases', 'IdentityCell'), 'phases → the columns → IdentityCell (renders p.goal)').toBe(true);
    expect(has('phases', 'PhaseRowDetail'), 'phases → a row’s detail').toBe(true);
    expect(has('phases', 'PhaseProse'), 'phases → PhaseProse (the self-fetching boundary)').toBe(true);
    expect(has('phases', 'PhaseDetails'), 'phases → PhaseProse → PhaseDetails (every prose field)').toBe(
      true,
    );
    expect(has('phases', 'PhaseRecordSections'), 'phases → inspectPhase → the eight sections').toBe(true);
    expect(has('phases', 'PhasesFoot'), 'phases → the foot (prompts, what is left, the landing)').toBe(true);
    expect(has('phases', 'MapView'), 'phases → the map, through its lazy()').toBe(true);
    expect(has('run', 'RunView'), 'run → the old run page, through a lazy() default export').toBe(true);
    expect(has('run', 'PhaseTable'), 'run → the run page → PhaseTable, through its re-export door').toBe(
      true,
    );
    expect(has('run', 'PhaseDetails'), 'run → PhaseTable → PhaseDetails (renders every prose field)').toBe(
      true,
    );
    expect(has('phase', 'PhasePanel'), 'phase → the phase page').toBe(true);
    expect(has('phase', 'PromptFold'), 'phase → its prompts').toBe(true);
    expect(has('handoff', 'HandoffPanel'), 'handoff → the handoff page').toBe(true);
    expect(has('source', 'SourceTab'), 'source → the Source view').toBe(true);
    expect(has('source', 'EngineFold'), 'source → the engine’s fold').toBe(true);
    for (const tab of Object.keys(ENTRY)) {
      for (const always of ['PlanGlance', 'PlanTrouble', 'QaLine', 'PlanBanners', 'PlanFacts']) {
        expect(has(tab, always), `${tab} → ${always} (mounted above every view)`).toBe(true);
      }
    }

    expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
  });
});
