/**
 * What the toured console holds: a plan library and a run history, written to
 * disk BEFORE the console boots so every page has something true to show.
 *
 * - `tower`, the plan the plan tabs are toured on: eight phases, two done (with
 *   handoffs), a gated one, a finished run in its history — and, once the
 *   console is up, the fixture's LIVE run on it (`stub-claude.mjs`).
 * - One plan per halt category of the control-tower plan's §4 (and `operator`),
 *   each with a stored run halted, parked or interrupted the way the runner
 *   writes that kind — so Now's inbox and the Runs ledger carry one of each.
 * - The stale shapes: a run a restart interrupted three days ago, a paused one.
 *
 * Only statuses that survive `settle()` with no process behind them (halted,
 * parked, interrupted, paused, finished; records pending, parked, failed, done)
 * and `child: null` everywhere: a stored pid that happened to be alive would be
 * adopted as an orphan. Nothing here imports `server/` — its paths are bound to
 * THIS process's environment at import, and this process is not sandboxed.
 * Later phases extend the shapes; the handoff of control-tower phase 15 lists
 * them.
 */
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { instanceId } from '../../shared/instances.mjs';
import type { ConsoleSandbox } from '../../test/spawn-console.ts';

type Rec = {
  phase: number;
  status: 'pending' | 'parked' | 'failed' | 'done' | 'interrupted';
  attempts: number;
  costUsd: number;
  startedAt?: string;
  endedAt?: string;
  note?: string;
  halt?: Halt;
};
type Halt = { at: string; kind: string; reason: string; phase?: number };
type RunSeed = {
  slug: string;
  id: string;
  status: 'halted' | 'parked' | 'interrupted' | 'paused' | 'finished';
  stoppedBy?: 'operator' | 'system';
  createdMin: number;
  updatedMin: number;
  spentUsd: number;
  halt: Halt | null;
  records: Rec[];
  finishedReason?: string;
};

export type SeedInfo = {
  anchor: number;
  tourPlan: string;
  plans: string[];
  runs: { slug: string; id: string; status: string; halt: string | null }[];
};

const TITLES: Record<string, [string, string[]]> = {
  tower: [
    'Tower — the toured plan',
    [
      'Survey the estate',
      'Lay the runway',
      'Tower cab and radios',
      'Approach lighting',
      'Ground movement radar',
      'Handover drills',
      'Night operations',
      'Open the field',
    ],
  ],
  decide: ['Needs your decision', ['Draft the change', 'Sign the deploy', 'Ship it']],
  signin: ['Credentials and accounts', ['Rotate the key', 'Re-sign the runner']],
  limits: ['Usage limits and budget', ['Batch the import', 'Backfill the archive']],
  network: ['Environment and network', ['Reach the docs server', 'Index the pages']],
  repair: ['Plan defect', ['Parse the ledger', 'Reconcile the ledger']],
  verify: ['Verification and unfinished work', ['Write the parser', 'Prove the parser', 'Ship the parser']],
  external: ['External wait', ['Open the pull request', 'Merge after review']],
  restart: ['Conflict, locks and restart', ['Migrate the schema', 'Swap the reader']],
  stopped: ['Stopped by the operator', ['Explore the idea', 'Keep what worked']],
  quiet: ['Paused mid-run', ['Warm the cache', 'Cut over']],
};

function planMd(slug: string): string {
  const [title, phases] = TITLES[slug];
  const rows = phases
    .map(
      (t, i) =>
        `| ${i + 1} | ${t} | ${i === 0 ? '—' : slug === 'tower' && i === 3 ? '1' : String(i)} | — | app | ${t.toLowerCase()} is done |`,
    )
    .join('\n');
  const sections = phases
    .map((t, i) => {
      const gated = slug === 'tower' && i === 6;
      return [
        `### Phase ${i + 1} — ${t}${gated ? ' *(GATED)*' : ''}`,
        '',
        `- **Size:** ${i % 3 === 0 ? 'L' : i % 3 === 1 ? 'M' : 'S'}`,
        ...(gated
          ? [
              '- **Gates (must clear first):** the night-operations sign-off',
              '- **Gate-check:** manual the airfield manager signs the night-operations sheet',
            ]
          : []),
        `- **Goal:** ${t.toLowerCase()}, to its exit criteria.`,
        '- **Verification:**',
        '  - `test -d docs`',
        '',
      ].join('\n');
    })
    .join('\n');
  return `---
slug: ${slug}
created: 2026-09-01
status: active
phases: ${phases.length}
handoffs: docs/handoffs/${slug}/
memory: project_${slug}
---

# ${title}

## Session budget

> **Target model:** \`claude-opus-5\` · **Budget:** ~200K weight/session.

## Decisions

| key | value | owner | state | blocking | source | evidence |
|---|---|---|---|---|---|---|
| \`credentials\` | none beyond the machine login | operator | answered | yes | plan | the fixture answers it |

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|---|---|---|---|---|---|
${rows}

## Phases

${sections}`;
}

function handoffMd(slug: string, phase: number, title: string, blocks: number[]): string {
  return `---
plan: ${slug}
phase: ${phase}
title: ${title}
status: complete
date: 2026-09-20
depends_on: [${phase === 1 ? '' : phase - 1}]
blocks: [${blocks.join(', ')}]
---

# Phase ${phase} — ${title}

## State now

${title} is done and verified.

## Files changed

- \`app/${slug}-${phase}.ts\`

## ▶ Start next phase(s)

Phase ${blocks.join(' and ')} can start.
`;
}

export function seed(box: ConsoleSandbox, anchor: number): SeedInfo {
  const at = (min: number): string => new Date(anchor - min * 60_000).toISOString();
  const plans = Object.keys(TITLES);
  for (const slug of plans) {
    writeFileSync(join(box.root, 'docs', 'plans', `${slug}.md`), planMd(slug));
    mkdirSync(join(box.root, 'docs', 'handoffs', slug), { recursive: true });
  }
  const [, towerPhases] = TITLES.tower;
  writeFileSync(
    join(box.root, 'docs', 'handoffs', 'tower', 'phase-01-survey-the-estate.md'),
    handoffMd('tower', 1, towerPhases[0], [2, 4]),
  );
  writeFileSync(
    join(box.root, 'docs', 'handoffs', 'tower', 'phase-02-lay-the-runway.md'),
    handoffMd('tower', 2, towerPhases[1], [3]),
  );

  const h = (min: number, kind: string, reason: string, phase?: number): Halt => ({
    at: at(min),
    kind,
    reason,
    ...(phase ? { phase } : {}),
  });
  const done = (phase: number, cost: number, from: number, to: number): Rec => ({
    phase,
    status: 'done',
    attempts: 1,
    costUsd: cost,
    startedAt: at(from),
    endedAt: at(to),
  });
  const pending = (phase: number): Rec => ({ phase, status: 'pending', attempts: 0, costUsd: 0 });

  const runs: RunSeed[] = [
    {
      slug: 'tower',
      id: 'e2e0000000a1',
      status: 'finished',
      createdMin: 1560,
      updatedMin: 1320,
      spentUsd: 7.4,
      halt: null,
      finishedReason: 'phases 1 and 2 done',
      records: [done(1, 3.1, 1560, 1500), done(2, 4.3, 1500, 1320)],
    },
    {
      slug: 'decide',
      id: 'e2e0000000b1',
      status: 'parked',
      stoppedBy: 'system',
      createdMin: 250,
      updatedMin: 47,
      spentUsd: 5.2,
      halt: h(47, 'needs-human', 'phase 2 needs a person: the deploy is signed by hand', 2),
      records: [
        done(1, 3.9, 250, 130),
        {
          phase: 2,
          status: 'parked',
          attempts: 1,
          costUsd: 1.3,
          startedAt: at(130),
          endedAt: at(47),
          note: 'declared needs-human',
          halt: h(47, 'needs-human', 'the deploy is signed by hand', 2),
        },
        pending(3),
      ],
    },
    {
      slug: 'signin',
      id: 'e2e0000000c1',
      status: 'halted',
      stoppedBy: 'system',
      createdMin: 400,
      updatedMin: 17,
      spentUsd: 0.4,
      halt: h(17, 'credential-refused', 'the default account was refused at sign-in — sign in again'),
      records: [
        { phase: 1, status: 'pending', attempts: 1, costUsd: 0.4, startedAt: at(32), endedAt: at(17) },
        pending(2),
      ],
    },
    {
      slug: 'limits',
      id: 'e2e0000000d1',
      status: 'halted',
      stoppedBy: 'system',
      createdMin: 700,
      updatedMin: 90,
      spentUsd: 25.0,
      halt: h(90, 'budget', 'the run spent its $25.00 budget'),
      records: [
        done(1, 19.5, 700, 250),
        { phase: 2, status: 'pending', attempts: 1, costUsd: 5.5, startedAt: at(250), endedAt: at(90) },
      ],
    },
    {
      slug: 'network',
      id: 'e2e0000000e1',
      status: 'parked',
      stoppedBy: 'system',
      createdMin: 130,
      updatedMin: 32,
      spentUsd: 0,
      halt: h(32, 'mcp-preflight', 'phase 1 needs the MCP server docs, which could not connect', 1),
      records: [
        { phase: 1, status: 'parked', attempts: 0, costUsd: 0, note: 'MCP server docs unreachable' },
        pending(2),
      ],
    },
    {
      slug: 'repair',
      id: 'e2e0000000f1',
      status: 'halted',
      stoppedBy: 'system',
      createdMin: 70,
      updatedMin: 62,
      spentUsd: 0,
      halt: h(
        62,
        'plan-lint',
        'the plan does not lint: phase 2 depends on a phase the graph does not define',
      ),
      records: [pending(1), pending(2)],
    },
    {
      slug: 'verify',
      id: 'e2e0000000a2',
      status: 'parked',
      stoppedBy: 'system',
      createdMin: 250,
      updatedMin: 17,
      spentUsd: 11.8,
      halt: null,
      records: [
        done(1, 6.2, 250, 170),
        {
          phase: 2,
          status: 'failed',
          attempts: 2,
          costUsd: 5.6,
          startedAt: at(170),
          endedAt: at(17),
          note: '§Verification was red: 3 of 41 tests failed',
          halt: h(17, 'verify-failed', '§Verification was red: 3 of 41 tests failed', 2),
        },
        pending(3),
      ],
    },
    {
      slug: 'external',
      id: 'e2e0000000b2',
      status: 'parked',
      stoppedBy: 'system',
      createdMin: 900,
      updatedMin: 150,
      spentUsd: 2.1,
      halt: null,
      records: [
        {
          phase: 1,
          status: 'parked',
          attempts: 1,
          costUsd: 2.1,
          startedAt: at(900),
          endedAt: at(150),
          note: 'waited 8 h on the review',
          halt: h(
            150,
            'waiting-external-timeout',
            'the wait on the pull request ran out of its 8 h budget',
            1,
          ),
        },
        pending(2),
      ],
    },
    {
      slug: 'restart',
      id: 'e2e0000000c2',
      status: 'interrupted',
      stoppedBy: 'system',
      createdMin: 5100,
      updatedMin: 5040,
      spentUsd: 3.3,
      halt: h(5040, 'interrupted-by-restart', 'the console restarted while phase 2 was running', 2),
      records: [
        done(1, 2.0, 5100, 5070),
        {
          phase: 2,
          status: 'interrupted',
          attempts: 1,
          costUsd: 1.3,
          startedAt: at(5070),
          endedAt: at(5040),
        },
      ],
    },
    {
      slug: 'stopped',
      id: 'e2e0000000d2',
      status: 'interrupted',
      stoppedBy: 'operator',
      createdMin: 170,
      updatedMin: 150,
      spentUsd: 1.0,
      halt: h(150, 'operator-stop', 'stopped by the operator'),
      records: [
        { phase: 1, status: 'interrupted', attempts: 1, costUsd: 1.0, startedAt: at(170), endedAt: at(150) },
        pending(2),
      ],
    },
    {
      slug: 'quiet',
      id: 'e2e0000000e2',
      status: 'paused',
      stoppedBy: 'operator',
      createdMin: 400,
      updatedMin: 250,
      spentUsd: 4.0,
      halt: null,
      records: [done(1, 4.0, 400, 250), pending(2)],
    },
  ];

  // Distinct, deterministic file times. The Plans page sorts most-recent first,
  // and files written in the same second tie — a tie the list then breaks
  // differently on every boot, reordering the cards the register measures.
  const touch = (path: string, min: number): void => {
    const t = new Date(anchor - min * 60_000);
    utimesSync(path, t, t);
  };
  const quiet: Record<string, number> = { tower: 3 };
  for (const r of runs) quiet[r.slug] = Math.min(quiet[r.slug] ?? Infinity, r.updatedMin);
  for (const slug of plans) touch(join(box.root, 'docs', 'plans', `${slug}.md`), quiet[slug] ?? 7_000);
  const demo = join(box.root, 'docs', 'plans', 'demo.md'); // the sandbox helper's own plan
  if (existsSync(demo)) touch(demo, 10_080);
  for (const h of ['phase-01-survey-the-estate.md', 'phase-02-lay-the-runway.md']) {
    touch(join(box.root, 'docs', 'handoffs', 'tower', h), 1_320);
  }

  const root = resolve(box.root);
  for (const r of runs) {
    const dir = join(box.stateHome, 'phase-console', 'runs', instanceId(root), r.slug);
    mkdirSync(dir, { recursive: true });
    const state = {
      id: r.id,
      slug: r.slug,
      root,
      status: r.status,
      ...(r.stoppedBy ? { stoppedBy: r.stoppedBy } : {}),
      autonomy: 'keep-going',
      model: 'opus',
      phaseBudgetUsd: null,
      runBudgetUsd: r.slug === 'limits' ? 25 : null,
      spentUsd: r.spentUsd,
      maxConsecutiveFailures: 2,
      consecutiveFailures: r.records.some((x) => x.status === 'failed') ? 1 : 0,
      createdAt: at(r.createdMin),
      updatedAt: at(r.updatedMin),
      activePhase: null,
      child: null,
      waitUntil: null,
      halt: r.halt,
      pause: null,
      freeze: null,
      ...(r.finishedReason
        ? { finishedReason: r.finishedReason }
        : r.halt
          ? { finishedReason: r.halt.reason }
          : {}),
      phases: Object.fromEntries(r.records.map((x) => [String(x.phase), x])),
    };
    writeFileSync(join(dir, `run-${r.id}.json`), `${JSON.stringify(state, null, 2)}\n`);
  }
  return {
    anchor,
    tourPlan: 'tower',
    plans,
    runs: runs.map((r) => ({
      slug: r.slug,
      id: r.id,
      status: r.status,
      halt: r.halt?.kind ?? r.records.find((x) => x.halt)?.halt?.kind ?? null,
    })),
  };
}
