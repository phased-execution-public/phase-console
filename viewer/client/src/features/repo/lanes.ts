/**
 * Commit-graph lane packing — the pure half of the graph, with no React in it.
 *
 * ## Why not `components/dag.tsx`
 *
 * The plan asked this graph to prefer the machinery already in the client over a
 * new dependency, and it does — but the split is not where it first looks. The
 * route map's LAYOUT (`positions`, `platforms`, `trackPath`) solves a different
 * problem: a plan DAG is a few dozen nodes with titles, placed in dependency
 * columns and stacked for legibility. A commit graph is hundreds of rows in a
 * fixed vertical order that git already chose, where the only question is which
 * horizontal lane each row's dot sits in and which lines run between two
 * adjacent rows. Feeding commits through `positions()` would put them in
 * generation columns and lose the one ordering the reader is here for.
 *
 * What IS reused is the map's VIEW machinery — `useMapView`, `clampView`,
 * `fitScale` in `components/dag.tsx` — because pan, zoom, fit and clamping are
 * the same problem on any SVG, and they were solved there with three paint bugs'
 * worth of care. And no dependency was added: this file is the whole algorithm.
 *
 * ## The algorithm
 *
 * One pass, in git's own output order. A **lane** is an array slot holding the
 * sha that slot is currently waiting for. A commit takes the lane that was
 * waiting for it (or the first free one, if it is a tip nobody pointed at); its
 * first parent inherits that lane, and every further parent claims a lane of its
 * own. Slots are never compacted, so a lane occupied in two adjacent rows is the
 * same visual column, and a straight vertical line is the correct drawing.
 */

import type { RepoCommit } from '@/lib/api';

/** One line in the band between a row and the row under it. */
export interface GraphLink {
  /** The lane this line leaves from, at the upper row. */
  from: number;
  /** The lane it arrives in, at the lower row. */
  to: number;
  /** It leaves the commit's dot rather than passing straight through. */
  fromCommit: boolean;
  /**
   * This lane is waiting for a commit the walk never reached — the window's
   * edge, drawn dashed so it reads as *continues below* rather than *ends
   * here*. The flag lives on the LINK rather than on the row because a lane
   * passing through can be waiting for an unreached sha just as a commit's own
   * first parent can, and because a separate stub drawn beside a solid link is
   * simply overdrawn (it was, and was therefore never visible).
   */
  dangling: boolean;
}

export interface GraphRow {
  commit: RepoCommit;
  /** The lane the dot sits in. */
  lane: number;
  /** Lines drawn from this row down to the next. */
  links: GraphLink[];
  /**
   * Parents this commit has that the walk never reached — the window's edge,
   * not a root commit. Named in the row's inspector; the DRAWING of them is the
   * `dangling` flag on the links, so the two cannot disagree.
   */
  danglingParents: string[];
  /**
   * Lanes that were WAITING for this commit and are freed by it — a branch
   * merging back. Their lines must join the dot rather than stop beside it.
   *
   * The packer reports this rather than the renderer inferring it, and that is
   * the whole point: `firstFree` re-allocates a freed slot within the same row
   * whenever the commit has a second parent, so "is that lane index occupied
   * below?" answers **yes** for a lane whose OCCUPANT changed. Index is not
   * identity. A renderer asking the cheaper question drew every merge into a
   * merge-shaped trunk as a line stopping 16 px short (QA round 2, M-2 — the
   * residual of round 1's own fix for round 1's M3).
   */
  merged: number[];
}

export interface GraphLanes {
  rows: GraphRow[];
  /** How many lanes were ever occupied — the drawing's width in lanes. */
  laneCount: number;
}

const firstFree = (lanes: (string | null)[]): number => {
  for (let i = 0; i < lanes.length; i += 1) if (lanes[i] === null) return i;
  lanes.push(null);
  return lanes.length - 1;
};

/**
 * Pack commits into lanes.
 *
 * `commits` must be in the order the server walked them (git's `--date-order`),
 * because that order IS the drawing: this function decides columns, never rows.
 */
export function packLanes(commits: RepoCommit[]): GraphLanes {
  /** Slot → the sha that slot is waiting for. `null` is free. */
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];

  // Every sha in the window, so a parent outside it is distinguishable from a
  // root commit. Both draw nothing below them; only one of them is an edge.
  const present = new Set(commits.map((c) => c.sha));

  for (const commit of commits) {
    let lane = lanes.indexOf(commit.sha);
    if (lane === -1) {
      lane = firstFree(lanes);
      lanes[lane] = commit.sha;
    }
    // A commit with several children is awaited by several lanes. They all
    // arrive here; the leftmost is the one that continues, the rest are freed
    // (their lines were already drawn INTO this row by the rows above) and are
    // reported so the drawing can bend them into the dot.
    const merged: number[] = [];
    for (let i = 0; i < lanes.length; i += 1) {
      if (i !== lane && lanes[i] === commit.sha) {
        lanes[i] = null;
        merged.push(i);
      }
    }

    const parents = commit.parents;
    const dangling = parents.filter((p) => !present.has(p));

    // The first parent inherits this lane; the rest claim their own. A parent
    // some other lane is already waiting for is a merge back into that lane —
    // it must not get a second column.
    const targets: number[] = [];
    if (parents.length === 0) {
      lanes[lane] = null;
    } else {
      lanes[lane] = parents[0];
      targets.push(lane);
      for (const p of parents.slice(1)) {
        const existing = lanes.indexOf(p);
        if (existing === -1) {
          const slot = firstFree(lanes);
          lanes[slot] = p;
          targets.push(slot);
        } else {
          targets.push(existing);
        }
      }
    }

    // The band under this row: one line per occupied lane. A lane this commit
    // sent a parent into leaves the DOT; every other occupied lane is somebody
    // else's history passing through, and runs straight.
    const links: GraphLink[] = [];
    for (let i = 0; i < lanes.length; i += 1) {
      const awaited = lanes[i];
      if (awaited === null) continue;
      const fromCommit = targets.includes(i);
      links.push({ from: fromCommit ? lane : i, to: i, fromCommit, dangling: !present.has(awaited) });
    }

    rows.push({ commit, lane, links, danglingParents: dangling, merged });
  }

  // The width is the widest lane anything was actually DRAWN in, not
  // `lanes.length`: `firstFree` pushes a slot and never pops one, so a graph
  // that briefly forked wide and then settled would otherwise keep paying for
  // columns that hold nothing for the rest of the walk.
  const used = rows.reduce(
    (max, row) => row.links.reduce((m, l) => Math.max(m, l.to + 1), Math.max(max, row.lane + 1)),
    0,
  );
  return { rows, laneCount: Math.max(1, used) };
}

/* ---------------- ref decoration ---------------- */

export type RefKind = 'trunk' | 'run' | 'lane' | 'tag' | 'head' | 'branch';

export interface DecoratedRef {
  name: string;
  kind: RefKind;
  /** For a `pe/<slug>` or `pe/<slug>-p<N>` ref, the plan and phase it names. */
  run?: { slug: string; phase?: number };
}

/**
 * What a decoration on a commit MEANS here.
 *
 * The four the console cares about are its own: the trunk everything settles
 * onto, a run branch `pe/<slug>`, a lane branch `pe/<slug>-p<N>` (a hyphen, not
 * a slash — `pe/<slug>/p4` is impossible in git while `pe/<slug>` exists), and
 * the integration branch every plan's folded work lands on. Anything else is a
 * branch a person made, and is drawn as one.
 *
 * The parse is the same one `git-browse.ts` does server-side for a branch's
 * `run` field, and it is a GUESS in both places for the same reason: a branch
 * name is something an operator can type. Nothing here reads as evidence.
 */
export function decorateRef(name: string, trunk?: string): DecoratedRef {
  if (name === 'HEAD') return { name, kind: 'head' };
  if (name.startsWith('tag: ')) return { name: name.slice(5), kind: 'tag' };
  if (trunk && name === trunk) return { name, kind: 'trunk' };

  const run = parseRunRef(name);
  if (run) return { name, kind: run.phase === undefined ? 'run' : 'lane', run };
  return { name, kind: 'branch' };
}

/** `pe/<slug>` → the run; `pe/<slug>-p<N>` → that run's lane for phase N. */
export function parseRunRef(name: string): { slug: string; phase?: number } | undefined {
  if (!name.startsWith('pe/')) return undefined;
  const rest = name.slice(3);
  if (!rest) return undefined;
  const m = /^(.+)-p(\d+)$/.exec(rest);
  if (m) return { slug: m[1], phase: Number(m[2]) };
  return { slug: rest };
}
