/**
 * The plan page's tab vocabulary, as a contract.
 *
 * Three properties, and each one is a bug this codebase has actually shipped:
 *
 * 1. **Every id in `PLAN_TABS` has a label and a panel.** `autopilot` was once
 *    registered as `run` in the router and spelled `autopilot` in the server's
 *    notification links, so every approval push opened a blank page for the
 *    life of that feature. A test that walks the shared array is the only thing
 *    that catches an id existing in the URL vocabulary and nowhere else.
 * 2. **`run` survives.** The server routes every in-flight-run notification to
 *    it (`server/push/catalogue.ts`), and the Node suite asserts the other half.
 * 3. **A retired id still resolves.** `analysis`, `overview` and `raw` are in
 *    bookmarks and in handoff prose; the redirect is what moves the address,
 *    and this is what the strip shows for the render before it lands.
 *
 * The panel side is asserted against `detail.tsx`'s own switch rather than a
 * second list of ids — a list here would agree with itself and with nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_PLAN_TABS, PLAN_TABS } from '@shared/route-meta.js';
import {
  DOCUMENT_PLAN_FIELDS,
  HANDOFF_PROSE_FIELDS,
  MEMORY_FIELDS,
  PLAN_INCLUDES,
  PROSE_PHASE_FIELDS,
} from '@shared/projection.js';
import {
  DETAIL_TABS,
  PLAN_TAB_LABELS,
  TAB_IDS,
  TAB_INCLUDES,
  includesForTab,
  isLegacyTab,
  legacyTabTarget,
  resolveTab,
  tabLabel,
} from './tabs';

/** `detail.tsx`'s `TabBody` — the panel side of the contract, read as source. */
const detailSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'detail.tsx'), 'utf8');

describe('the plan tab vocabulary', () => {
  it('is exactly the shared list, in the shared order', () => {
    expect(TAB_IDS).toEqual([...PLAN_TABS]);
  });

  it('gives every id a real label — never the id falling through', () => {
    for (const id of PLAN_TABS) {
      expect(PLAN_TAB_LABELS[id], `no label for '${id}'`).toBeTruthy();
      expect(tabLabel(id)).not.toBe(id === 'run' ? '' : id);
    }
  });

  it('gives every id a real panel in TabBody', () => {
    for (const id of PLAN_TABS) {
      // `route` is the switch's `default:` — the fallback is deliberate, so
      // that an id the vocabulary gains before its panel lands on the map
      // rather than on nothing.
      if (id === 'route') continue;
      expect(detailSource, `TabBody has no case for '${id}'`).toContain(`case '${id}':`);
    }
  });

  it('keeps `run` — every in-flight notification is routed to it', () => {
    expect(PLAN_TABS).toContain('run');
  });

  it('has no id that is both live and retired', () => {
    for (const id of PLAN_TABS) expect(isLegacyTab(id), `'${id}' is both`).toBe(false);
  });
});

describe('the retired tabs', () => {
  it('names all three, and only tabs that really left', () => {
    expect(Object.keys(LEGACY_PLAN_TABS).sort()).toEqual(['analysis', 'overview', 'raw']);
  });

  it('sends the two file readings to Source and the numbers off the page', () => {
    expect(legacyTabTarget('overview')).toBe('source');
    expect(legacyTabTarget('raw')).toBe('source');
    // `analysis` names a HEAD, not a tab of this page — `planTabRedirect` in
    // `app/routes.ts` turns that into `#/insights?plan=…`.
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
  });
});

describe('resolveTab', () => {
  it('opens on Route with no segment, and for a word nobody registered', () => {
    expect(resolveTab(undefined)).toBe('route');
    expect(resolveTab('')).toBe('route');
    expect(resolveTab('not-a-tab')).toBe('route');
  });

  it('shows the list a detail page was reached from', () => {
    expect(resolveTab('phase')).toBe('phases');
    expect(resolveTab('handoff')).toBe('handoffs');
    // And those two lists are themselves real tabs.
    for (const target of Object.values(DETAIL_TABS)) expect(PLAN_TABS).toContain(target);
  });

  it('is identity on every live id', () => {
    for (const id of PLAN_TABS) expect(resolveTab(id)).toBe(id);
  });
});

/**
 * What each tab FETCHES, held against what it RENDERS.
 *
 * The plan detail is projected (`shared/projection.js`): the board answer is
 * 47.8 KB and the full one 286.5 KB, so a tab asks for the groups it renders.
 * The failure mode this guards is silent — a tab added without an entry gets
 * the board projection, and its prose is simply `undefined` on the page with
 * no error anywhere.
 */
describe('the include set each tab asks for', () => {
  it('names a group every tab and detail route registers', () => {
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
          `tab '${tab}' asks for '${group}', which is not a documented include`,
        ).toContain(group);
      }
      // `full` would put the projection back exactly where it was.
      expect(
        groups,
        `tab '${tab}' asks for everything — that is the payload this phase removed`,
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
    // the lock and the handoff STATUS chip — all board fields, so the tabs that
    // show them ask for nothing. The two tabs that render the page-length prose
    // (`phase-panel.tsx`, and `PhaseDetails` under the Autopilot table) ask.
    for (const tab of ['route', 'phases', 'handoffs', 'handoff']) {
      expect(includesForTab(tab), `tab '${tab}'`).toEqual([]);
    }
    for (const tab of ['phase', 'run']) {
      expect(includesForTab(tab)).toContain('prose');
      expect(includesForTab(tab)).toContain('handoffs');
    }
    expect(includesForTab('source')).toEqual(['document', 'memory']);
  });

  /**
   * THE RENDER TREE, per COMPONENT — not the import graph, and not per file.
   *
   * Three wrong answers were tried before this one, and each was green while
   * the Route tab rendered two fields it never asked for:
   *
   *   1. **A hand-written file→tab map.** `phase-cells.tsx` is mounted by four
   *      tabs and the map named only the one that happened to ask.
   *   2. **An import-graph walk.** `phases-tab.tsx` imports `groupRows` from
   *      `phase-table.tsx`, which also exports `PhaseDetails` — so an import
   *      walk demands `prose` for a tab that renders none of it.
   *   3. **A file-granular render walk.** `phase-cells.tsx` exports both the
   *      board cells (`TitleCell`, `FlagsCell`) and `PhaseDetails`; reaching
   *      the file says nothing about which of them was mounted.
   *
   * So the unit is a COMPONENT. From each tab's entry component, every `<Name>`
   * tag in that component's own body is resolved to the component that defines
   * it and walked in turn, and field reads are checked against each body alone.
   * A call (`groupRows(...)`) is not a render edge and is correctly ignored.
   *
   * ⚠️ **WHAT THIS CANNOT SEE.** A static JSX walk has real blind spots, and a
   * second QA pass planted a defect in each to prove they are blind. None hides
   * a live defect today; all five are things to check BY HAND when you touch a
   * projected field:
   *
   *   1. A destructured read — `const { steps } = phase`.
   *   2. A renamed receiver — `ph.steps` (the pattern below knows `phase`,
   *      `view`, `p`, `h`, `detail`, `plan`).
   *   3. **A field read inside a plain function that is CALLED, not rendered.**
   *      This is the one that already bit: `ways-forward.tsx`'s `nextStepRows`
   *      is exactly that shape, and it is where the first QA pass found the
   *      Autopilot tab reading `handoff.outstanding`.
   *   4. A component reached through a variable — `[C].map(…)`, or a table of
   *      components.
   *   5. Anything behind the `@/components/ui` barrel — the resolver reads
   *      files, not directories, so an index re-export ends the walk.
   *
   * The right response to a blind spot is not to widen the regex until it
   * over-reports; it is to keep field reads close to the component that renders
   * them, where this test can see them.
   */
  it("every tab that renders a projected field asks for that field's group", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const srcRoot = join(here, '..', '..');

    /**
     * `PlanHeader` renders on EVERY tab — `detail.tsx` mounts it above the tab
     * strip, outside `TabBody` — so it is a root of every walk, not a child of
     * any of them. Missed on the first cut of this test (it happens to read no
     * projected field, so there was no live defect; the next field it reads
     * would be one).
     */
    const ALWAYS: [file: string, component: string][] = [['features/plans/header.tsx', 'PlanHeader']];

    /** Entry component per tab — what `TabBody` mounts. */
    const ENTRY: Record<string, [file: string, component: string][]> = {
      route: [['features/plans/route-tab.tsx', 'RouteTab']],
      phases: [['features/plans/phases-tab.tsx', 'PhasesTab']],
      phase: [['features/plans/phase-panel.tsx', 'PhasePanel']],
      handoffs: [['features/plans/handoffs-tab.tsx', 'HandoffsTab']],
      handoff: [['features/plans/handoffs-tab.tsx', 'HandoffPanel']],
      source: [['features/plans/source-tab.tsx', 'SourceTab']],
      run: [['features/runs/run-page.tsx', 'RunView']],
      qa: [['features/plans/qa-tab.tsx', 'QaTab']],
    };

    // F-N3: the map above is hand-written, so it needs a completeness check —
    // otherwise deleting a row leaves this file green over a real defect.
    for (const tab of [...PLAN_TABS, ...Object.keys(DETAIL_TABS)]) {
      expect(ENTRY, `no entry component for tab '${tab}' — its render tree is never walked`).toHaveProperty(
        tab,
      );
    }
    expect(Object.keys(ENTRY).sort()).toEqual([...PLAN_TABS, ...Object.keys(DETAIL_TABS)].sort());

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

    const sources = new Map<string, string | null>();
    const read = (rel: string): string | null => {
      if (sources.has(rel)) return sources.get(rel)!;
      let found: string | null = null;
      for (const ext of ['', '.tsx', '.ts']) {
        try {
          found = readFileSync(join(srcRoot, rel + ext), 'utf8');
          break;
        } catch {
          /* next */
        }
      }
      sources.set(rel, found);
      return found;
    };

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
    const tagsIn = (body: string): string[] => [...body.matchAll(/<([A-Z][A-Za-z0-9_]*)/g)].map((m) => m[1]);

    /** Which file defines `name`, as a path relative to `client/src`. */
    const originOf = (source: string, file: string, name: string): string | null => {
      const re = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'([^']+)'/g;
      for (const m of source.matchAll(re)) {
        const named = m[1].split(',').map((x) =>
          x
            .trim()
            .split(/\s+as\s+/)
            .pop()!
            .trim(),
        );
        if (!named.includes(name)) continue;
        const spec = m[2];
        if (spec.startsWith('@/')) return spec.slice(2);
        if (spec.startsWith('.')) return join(dirname(file), spec);
        return null; // a package, or @shared — not our render tree
      }
      const lazy = new RegExp(
        `(?:const|let)\\s+${name}\\s*=\\s*lazy\\(\\s*\\(\\)\\s*=>\\s*import\\('([^']+)'\\)`,
      );
      const found = source.match(lazy);
      if (found) return found[1].startsWith('@/') ? found[1].slice(2) : join(dirname(file), found[1]);
      return null;
    };

    /**
     * Components that fetch their OWN projection groups — a boundary the walk
     * has to know about, or it reports a defect that is not there.
     *
     * The rule this guard enforces is "a rendered field must have been
     * FETCHED", and a tab's include set is only one way to fetch it. A sheet
     * that calls `usePlan` with its own include set has satisfied the rule for
     * everything below it, and forcing its host tab to ask instead would make
     * every plan open pay for prose nobody had asked to read — the exact cost
     * `tabs.ts` explains at length.
     *
     * This is a strengthening, not an exemption: the entry is verified against
     * the component's source below, so a boundary that stops fetching (or that
     * quietly narrows what it asks for) fails here rather than rendering
     * blanks. Nothing is trusted because it was written in this map.
     */
    const SELF_FETCHING: Record<string, readonly string[]> = {
      'features/plans/phase-inspector#PhaseInspector': ['prose', 'handoffs'],
    };

    /**
     * Keys, extensionless.
     *
     * `ENTRY` names files with their extension and `originOf` resolves imports
     * without one, so the same component is reached under two spellings
     * depending on where the walk came from. A map keyed on one of them silently
     * matches nothing from the other — which reads exactly like a boundary that
     * does not work.
     */
    const norm = (file: string) => file.replace(/\.tsx?$/, '');

    /** One key shape, used by BOTH the head dedup and the enqueue guard. */
    const keyOf = (file: string, name: string, asked: Set<string>) =>
      `${file}#${name}#${[...asked].sort().join(',')}`;

    // The honesty check. A map entry is a CLAIM about a component; this is the
    // component being made to back it. Without this the map would be a way to
    // silence the guard by typing a line into it.
    for (const [key, groups] of Object.entries(SELF_FETCHING)) {
      const [file, name] = key.split('#');
      const source = read(file);
      expect(source, `${key}: no such file`).not.toBeNull();
      const body = bodiesOf(source!).get(name);
      expect(body, `${key}: no such component`).toBeDefined();
      expect(body, `${key} claims to self-fetch but never calls usePlan`).toMatch(/usePlan\(/);
      /*
       * The include list must be a module-level constant (a fresh literal per
       * render is a fresh query key per render), so it is asserted against the
       * FILE rather than the component body — but against the file with its
       * COMMENTS STRIPPED. Searching the raw source let a narrowed constant
       * stay green as long as the removed group survived in a `// was [...]`
       * note beside it, which is the one way this check could be talked out of
       * its job.
       */
      const code = source!.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
      for (const group of groups) {
        expect(code, `${key} claims ?include=${group} and its code never names it`).toContain(`'${group}'`);
      }
    }

    const problems: string[] = [];
    const reached = new Map<string, Set<string>>();
    for (const [tab, entries] of Object.entries(ENTRY)) {
      const tabAsked = new Set(includesForTab(tab));
      const seen = new Set<string>();
      // Each node carries the include set in force where it was reached — a
      // self-fetching boundary widens it for its whole subtree and for nothing
      // else, so a component that renders prose OUTSIDE the sheet is still
      // caught on a tab that did not ask for it.
      const queue: [file: string, component: string, asked: Set<string>][] = [...entries, ...ALWAYS].map(
        ([file, name]) => [file, name, tabAsked],
      );
      let walked = 0;
      while (queue.length) {
        const [file, name, inherited] = queue.shift()!;
        /*
         * Keyed by the include set IN FORCE as well as by the component.
         *
         * `asked` used to be one value per tab, so `file#name` was a sound
         * dedup. It varies per PATH now — a self-fetching boundary widens it
         * for its subtree — and a component reachable both inside a boundary
         * and outside it is two different questions. Keyed on the component
         * alone, whichever path the queue reached first would answer for both,
         * and the outside-the-boundary reader (the one that actually renders
         * blanks) would be skipped. `PhaseDetails` is exactly such a shared
         * component, so this is not hypothetical.
         */
        const key = keyOf(file, name, inherited);
        if (seen.has(key)) continue;
        const source = read(file);
        if (source === null) continue;
        const body = bodiesOf(source).get(name);
        if (body === undefined) continue;
        seen.add(key);
        walked++;
        const own = SELF_FETCHING[`${norm(file)}#${name}`];
        const asked = own ? new Set([...inherited, ...own]) : inherited;

        for (const [field, group] of Object.entries(FIELD_GROUP)) {
          // Reading the field off a phase, a phase-like local, or the detail.
          if (!new RegExp(`\\b(?:phase|view|p|h|record|detail|plan)\\??!?\\.${field}\\b`).test(body))
            continue;
          if (!asked.has(group)) {
            problems.push(
              `tab '${tab}' renders <${name}> (${file}), which reads .${field} — that is ` +
                `?include=${group}, and the tab asks for [${[...asked].join(', ') || 'nothing'}]`,
            );
          }
        }

        for (const tag of new Set(tagsIn(body))) {
          const origin = originOf(source, file, tag) ?? file;
          // The SAME key shape the head of the loop dedups on. It was still
          // building a two-segment one after the include set joined the key, so
          // it matched nothing and blocked nothing — 0 blocks in 1020 tag
          // encounters. Correctness survived on the head's own check; a guard
          // that reads as working and is not is the part worth fixing.
          if (!seen.has(keyOf(origin, tag, asked))) queue.push([origin, tag, asked]);
        }
      }
      expect(
        walked,
        `render tree for '${tab}' is empty — is the ENTRY component name right?`,
      ).toBeGreaterThan(0);
      reached.set(tab, seen);
    }

    // THE WALKER ITSELF, red-proved against the two edges that caused the bug.
    // A walk that quietly stopped following JSX would report no problems and
    // look exactly like a clean bill of health, so it has to be made to show
    // that it reaches components several hops from the entry.
    // The key carries the include set as a third segment now, so a component is
    // matched on its OWN segment rather than at the end of the string.
    const has = (tab: string, name: string) =>
      [...(reached.get(tab) ?? [])].some((key) => key.split('#')[1] === name);
    expect(has('route', 'TitleCell'), 'route → TitleCell (renders phase.goal)').toBe(true);
    expect(has('route', 'FlagsCell'), 'route → FlagsCell (renders the handoff chip)').toBe(true);
    expect(has('route', 'PhasesTab'), 'route → PhasesTab (the phone branch)').toBe(true);
    expect(has('run', 'PhaseDetails'), 'run → PhaseTable → PhaseDetails (renders every prose field)').toBe(
      true,
    );

    expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
  });
});
