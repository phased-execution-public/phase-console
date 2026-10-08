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
 * them. Since control-tower phase 137 the human-step ledger holds an item in
 * every group of Your turn (`seedTurn`), and the handled log one row.
 */
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
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
  /** The ledger items Your turn draws, by the group each lands in (control-tower phase 137). */
  turn: TurnSeed;
};

/** The seeded items: each id, and the group `GET /api/turn` puts it in. */
export type TurnSeed = {
  id: string;
  group: 'now' | 'decide' | 'upcoming' | 'checking' | 'done';
  kind: string;
}[];

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
  seedIssues(box, anchor);
  const turn = seedTurn(box, anchor);
  return {
    anchor,
    tourPlan: 'tower',
    plans,
    turn,
    runs: runs.map((r) => ({
      slug: r.slug,
      id: r.id,
      status: r.status,
      halt: r.halt?.kind ?? r.records.find((x) => x.halt)?.halt?.kind ?? null,
    })),
  };
}

/** The repository the Issues desk's stop reads (control-tower phase 118). */
export const DESK_REPO = 'example/tower-issues';

/**
 * The Issues desk's data: one repository ADDED to the desk by its owner/name
 * (`prefs.issueRepos`), and its issue list already in the cache, as a refresh
 * leaves it — so the stop draws a real desk without ever reaching GitHub (the
 * GET never fetches). Every category, severity and plan state is here once,
 * a closed one fixed and a closed one merely closed, and one title long
 * enough to wrap on a phone.
 */
function seedIssues(box: ConsoleSandbox, anchor: number): void {
  const at = (min: number): string => new Date(anchor - min * 60_000).toISOString();
  const config = join(box.configHome, 'phase-console', 'config.json');
  mkdirSync(join(box.configHome, 'phase-console'), { recursive: true });
  const prior = existsSync(config)
    ? (JSON.parse(readFileSync(config, 'utf8')) as Record<string, unknown>)
    : {};
  writeFileSync(config, `${JSON.stringify({ ...prior, issueRepos: [DESK_REPO] }, null, 2)}\n`);

  type Row = [number, string, string[], string, number, number?];
  const rows: Row[] = [
    [
      52,
      'Ground crews need the after-dark radio channel printed on every vehicle, the tug and the fuel truck included',
      ['enhancement', 'awaiting-plan'],
      'ops-lead',
      25,
    ],
    [
      48,
      'Night landings need a second lighting check',
      ['bug', 'awaiting-plan', 'severity:high'],
      'airfield-ops',
      40,
    ],
    [
      47,
      'The runway survey misses the eastern apron',
      ['bug', 'plan:tower', 'severity:medium'],
      'surveyor',
      180,
    ],
    [
      45,
      'Hangar door sensors read open when closed',
      ['bug', 'awaiting-plan', 'severity:critical'],
      'maintenance',
      1_440,
    ],
    [
      44,
      'Explain the fuel-truck rota in the handbook',
      ['documentation', 'plan:tower-deferred'],
      'ops-lead',
      2_880,
    ],
    [
      41,
      'Show the wind sock on the tower board',
      ['enhancement', 'plan:tower', 'severity:low'],
      'controller',
      4_320,
    ],
    [39, 'Which channel do ground crews use after dark?', ['question'], 'new-starter', 7_200],
    [
      36,
      'Taxiway lights flicker on cold mornings',
      ['bug', 'plan:tower', 'severity:medium'],
      'surveyor',
      8_640,
      8_640,
    ],
    [30, 'An old checklist link is dead', ['documentation'], 'ops-lead', 12_960, 12_960],
  ];
  const issues = rows.map(([number, title, labels, author, updated, closed]) => ({
    number,
    title,
    state: closed === undefined ? 'OPEN' : 'CLOSED',
    labels,
    assignees: number === 47 ? ['surveyor'] : [],
    author,
    createdAt: at(updated + 600),
    updatedAt: at(updated),
    ...(closed === undefined ? {} : { closedAt: at(closed) }),
    url: `https://github.com/${DESK_REPO}/issues/${number}`,
  }));
  const dir = join(box.stateHome, 'phase-console', 'issues');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${DESK_REPO.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`),
    JSON.stringify({ nameWithOwner: DESK_REPO, fetchedAt: anchor - 4 * 60_000, issues }),
  );
}

/**
 * Your turn's items (control-tower phase 137, #214): the human-step ledger,
 * written as the console writes it — a v2 declaration per item, then its
 * moves — with an item in every group the page draws:
 *
 *   - *Do now*: a sign-in whose guide carries a command too long for a phone
 *     (it scrolls inside its card), a secret the check sent back once (the
 *     verdict and what to redo), and an operator act whose guide is Persian —
 *     right-to-left, its command left-to-right;
 *   - *Needs one detail*: a decision with three options, one recommended;
 *   - *Coming up*: an act whose due-when is a date a month away;
 *   - *Being checked*: a check in flight — its `at` is AHEAD of the anchor, so
 *     the console's sweep of interrupted checks (six minutes) leaves it alone
 *     for the whole tour, while its `declaredAt` stays behind;
 *   - *Done*: a sign-in proven within the day.
 *
 * And the handled log one row — a standing grant that answered three times.
 * They hang off `tower`'s last phases, which no run of the fixture is on.
 */
function seedTurn(box: ConsoleSandbox, anchor: number): TurnSeed {
  const at = (min: number): string => new Date(anchor - min * 60_000).toISOString();
  const ahead = (min: number): string => new Date(anchor + min * 60_000).toISOString();
  const guide = (
    summary: string,
    steps: {
      text: string;
      code?: string;
      expect?: string;
      warn?: string;
      link?: { label: string; url: string };
    }[],
    trouble: { symptom: string; fix: string }[] = [],
    lang = 'en',
  ) => ({ version: 1, lang, dir: lang === 'fa' ? 'rtl' : 'ltr', summary, steps, trouble });
  const declare = (id: string, min: number, step: Record<string, unknown>) => ({
    v: 2,
    id,
    where: 'host',
    birth: 'session',
    slug: 'tower',
    phase: 7,
    state: 'declared',
    declaredAt: at(min),
    at: at(min),
    opened: 0,
    attempts: 0,
    whySource: 'declared',
    waiters: [{ slug: 'tower', phase: 7 }],
    ...step,
  });
  const move = (
    id: string,
    state: string,
    verb: string,
    when: string,
    extra: Record<string, unknown> = {},
  ) => ({
    v: 2,
    id,
    state,
    verb,
    at: when,
    ...extra,
  });

  const lines: Record<string, unknown>[] = [
    declare('turn-now-signin', 50, {
      kind: 'browser-login',
      title: 'Sign the gh CLI in to the estate',
      why: 'identity',
      proofType: 'probe',
      proof: 'cmd:"gh auth status"',
      proofWords: 'gh answers with your account, signed in.',
      openUrl: 'https://github.com/login/device',
      effortMin: 3,
      unblocks: [{ slug: 'tower', phase: 8 }],
      guide: guide(
        'The phase pushes its branch, and **only you can sign in as yourself** — the session has no browser.',
        [
          {
            text: 'Sign in from a terminal on this machine',
            code: 'gh auth login --hostname github.com --git-protocol https --web --scopes repo,read:org,workflow,write:packages',
            expect: 'A one-time code, then a browser page asking you to confirm it.',
          },
          {
            text: 'Confirm the code in the browser',
            link: { label: 'GitHub device sign-in', url: 'https://github.com/login/device' },
            warn: 'Sign in as the account that owns the estate, not a personal one.',
          },
          { text: 'Come back and check', expect: 'The item moves to Being checked, then Done.' },
        ],
        [
          {
            symptom: 'The browser never opens',
            fix: 'Open the link yourself and type the code shown in the terminal.',
          },
        ],
      ),
    }),
    move('turn-now-signin', 'notified', 'notify', at(49), { by: 'console', pushed: false }),

    declare('turn-now-secret', 120, {
      kind: 'secret-entry',
      title: 'Put the npm token in the keychain',
      why: 'secret',
      proofType: 'probe',
      proof: 'cmd:"security find-generic-password -s phase-console-npm-token"',
      secretWhere: 'the keychain item `phase-console-npm-token`',
      effortMin: 5,
      guide: guide('The release publishes with a token **only you hold**.', [
        { text: 'Create an automation token on the registry' },
        {
          text: 'Store it in the keychain',
          code: 'security add-generic-password -s phase-console-npm-token -a npm -w',
          expect: 'The command asks for the token and prints nothing.',
        },
      ]),
    }),
    move('turn-now-secret', 'notified', 'notify', at(119), { by: 'console' }),
    move('turn-now-secret', 'opened', 'open', at(100), { where: 'here' }),
    move('turn-now-secret', 'checking', 'check', at(60)),
    move('turn-now-secret', 'returned', 'return', at(59), {
      verdict: {
        state: 'rejected',
        note: 'The keychain has no item by that name.',
        redo: ['Store it under the service name phase-console-npm-token'],
        read: ['security: The specified item could not be found in the keychain.'],
        at: at(59),
        by: 'probe',
        attempt: 1,
      },
    }),

    declare('turn-now-fa', 40, {
      kind: 'operator-act',
      title: 'کلید استقرار را روی این دستگاه بچرخانید',
      why: 'reserved',
      proofType: 'attest',
      openCommand: 'phase-console capability pe-hub add --allow-issues',
      effortMin: 2,
      guide: guide(
        'این کار را **فقط شما** انجام می‌دهید: یک قاعده آن را برای یک نفر نگه داشته است.',
        [
          {
            text: 'این فرمان را در ترمینال اجرا کنید',
            code: 'phase-console capability pe-hub add --allow-issues',
            expect: 'خروجی `capability added` را چاپ می‌کند، در کمتر از 2 ثانیه.',
          },
          { text: 'برگردید و دکمهٔ بررسی را بزنید' },
        ],
        [],
        'fa',
      ),
    }),
    move('turn-now-fa', 'notified', 'notify', at(39), { by: 'console' }),

    declare('turn-decide', 30, {
      kind: 'decision',
      title: 'Choose when the release ships',
      why: 'decision',
      proofType: 'answer',
      allowDecline: true,
      options: [
        {
          id: 'monday',
          label: 'Ship it on Monday',
          consequence: 'The release waits two days; the notes get a review.',
          recommended: true,
        },
        { id: 'today', label: 'Ship it today', consequence: 'Nobody reviews the notes before they go out.' },
        { id: 'hold', label: 'Hold it', consequence: 'Phase 8 waits until you choose again.' },
      ],
    }),
    move('turn-decide', 'notified', 'notify', at(29), { by: 'console' }),

    declare('turn-upcoming', 20, {
      kind: 'operator-act',
      state: 'upcoming',
      title: 'Publish the package once the nightly build is green',
      why: 'reserved',
      proofType: 'probe',
      proof: 'cmd:"npm view acme-widget version"',
      openCommand: 'npm publish --access public',
      dueWhen: `date:${ahead(30 * 24 * 60)}`,
    }),

    declare('turn-checking', 90, {
      kind: 'physical',
      title: 'Plug the hardware key into the build machine',
      why: 'physical',
      proofType: 'judgement',
      proofWords: 'The machine lists the key under USB devices.',
    }),
    move('turn-checking', 'notified', 'notify', at(89), { by: 'console' }),
    move('turn-checking', 'opened', 'open', at(80), { where: 'here' }),
    move('turn-checking', 'checking', 'check', ahead(180)),

    declare('turn-done', 300, {
      kind: 'claude-login',
      title: 'Sign Claude in again on this machine',
      why: 'identity',
      proofType: 'probe',
      proof: 'cmd:"claude auth status"',
    }),
    move('turn-done', 'notified', 'notify', at(299), { by: 'console' }),
    move('turn-done', 'proven', 'prove', at(240), { by: 'a person' }),

    // A permission item the console raised from a recorded deny wall (phase
    // 138): high at every scope, so the card shows all five, the blast radius
    // and the typed rule — the phone's hardest shape.
    declare('turn-permit', 35, {
      kind: 'permission',
      birth: 'console',
      title: 'Allow npm publish for the release phase',
      why: 'permission',
      proofType: 'grant',
      permission: {
        wall: 'deny',
        tool: 'Bash',
        rule: 'Bash(npm publish:*)',
        command: 'npm publish --access public --tag next ./dist/acme-widget-2.4.0.tgz',
        need: 'The phase publishes the prebuilt package once both Releases exist.',
        family: 'any',
        risk: 'high',
        scopes: ['call', 'phase', 'plan', 'repository', 'always'],
        source: 'hook',
        at: at(35),
      },
    }),
    move('turn-permit', 'notified', 'notify', at(34), { by: 'console' }),
  ];
  const dir = join(box.stateHome, 'phase-console');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'human-steps.ndjson'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  // One live grant, made from this console (phase 138): Settings ▸ Permissions ▸
  // Grants lists it with its cause, and the `granted` push opens it by its id.
  writeFileSync(
    join(dir, 'grants.ndjson'),
    `${JSON.stringify({
      type: 'grant',
      row: {
        id: 'g-e2e0permit0',
        at: at(25),
        by: 'e2e',
        door: 'local',
        item: 'turn-permit',
        wall: 'ask',
        tool: 'Bash',
        rule: 'Bash(npm test:*)',
        family: 'any',
        risk: 'medium',
        scope: 'plan',
        slug: 'tower',
        phase: 7,
        runId: null,
        until: null,
        changed: [
          {
            kind: 'policy',
            layer: 'plan',
            file: 'tower.json',
            slug: 'tower',
            list: 'allow',
            rule: 'Bash(npm test:*)',
            op: 'add',
          },
        ],
        reason: 'The suite runs on every phase of this plan.',
      },
    })}\n`,
  );
  writeFileSync(
    join(dir, 'handled.ndjson'),
    `${JSON.stringify({
      source: 'auto-grant',
      what: 'Allowed git push of the run branch pe/tower',
      at: at(15),
      first: at(200),
      count: 3,
      slug: 'tower',
      phase: 2,
      links: [{ kind: 'commit', ref: '41bc1f14d0c0ffee' }],
    })}\n`,
  );
  return [
    { id: 'turn-now-signin', group: 'now', kind: 'browser-login' },
    { id: 'turn-now-secret', group: 'now', kind: 'secret-entry' },
    { id: 'turn-now-fa', group: 'now', kind: 'operator-act' },
    { id: 'turn-decide', group: 'decide', kind: 'decision' },
    { id: 'turn-upcoming', group: 'upcoming', kind: 'operator-act' },
    { id: 'turn-checking', group: 'checking', kind: 'physical' },
    { id: 'turn-done', group: 'done', kind: 'claude-login' },
    { id: 'turn-permit', group: 'now', kind: 'permission' },
  ];
}
