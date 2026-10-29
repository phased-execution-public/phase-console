/**
 * The accessibility smoke — every destination's page, every Settings section,
 * the Pro sections that are addresses of their own, and the step card (`StepCard`).
 *
 * The SHELL's chrome around each destination is `screens/a11y.test.tsx`'s, and
 * its own contracts — names, landmarks, the skip link — are
 * `shell/a11y.test.tsx`'s (the chrome is on screen everywhere, so a violation
 * there is a violation on every page). This file is the other half: the pages
 * that render inside it.
 *
 * A page nobody runs through axe is how two navigations end up sharing one
 * accessible name, or a control's label turns out to be a paragraph.
 *
 * jsdom lays nothing out, so this cannot see contrast (asserted from the
 * stylesheet by `styles/contrast.test.ts`) or anything that needs a viewport.
 * What it CAN see is everything structural: names, roles, labels, ARIA
 * validity, heading and landmark nesting, duplicate ids, form labelling. Those
 * are the failures that make a page unusable with a screen reader, and they are
 * the ones a human reviewer never notices because the page looks right.
 *
 * The fixtures are deliberately POPULATED rather than empty. An empty page
 * renders empty states, and an empty state has no table, no list, no toolbar
 * and no dialog trigger — a smoke that only ever saw those would pass on every
 * page in the app while proving nothing about any of them.
 */

import { Suspense } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEAVY_CASE_TIMEOUT } from '@/test-heavy';
import { DESTINATIONS as SHELL_DESTINATIONS, ROUTE_HEADS } from '@shared/route-meta.js';
import { queryClientConfig } from '@/data/keys';
import { schemaAnswer } from '@/screens/settings/test-kit';
import { expectNoAxeViolations } from '@/test/axe';

/* ------------------------------------------------------------------ *
 * One fetch stub for the whole app.
 *
 * Every fetcher in `data/api/*` funnels through `data/http.ts` `request()`,
 * which funnels through `fetch`. Stubbing there rather than mocking `api` is
 * what lets every destination share one harness — and it exercises the real
 * fetchers, so a page that asks for something nobody has fixtured fails here
 * rather than silently rendering a skeleton forever.
 * ------------------------------------------------------------------ */

const STATE = {
  autopilot: true,
  allowRun: true,
  allowWrites: true,
  allowMcp: false,
  staticRoot: 'dist',
  distRev: 'abc123def456',
  root: { path: '/repo', ok: true, planCount: 3, handoffCount: 2 },
  scriptsDir: '/scripts',
  sizing: { S: 15_000, M: 40_000, L: 90_000, budgetBig: 200_000, budgetHaiku: 40_000 },
  searchDocs: 42,
  supervisor: { detail: 'launchd', supervised: true },
  repo: { available: true, branch: 'main', dirty: ['docs/plans/demo.md'] },
  recentRoots: [],
  models: ['claude-opus-5', 'claude-fable-5'],
  port: 4123,
  unread: 2,
  prefs: {},
  // A supervisor beats on this machine, so the machine-wide destination renders
  // its content rather than its "none answers" state.
  fleet: { frozen: false, at: null, by: null, reachable: true, hold: null },
};

const PLANS = [
  {
    slug: 'demo',
    kind: 'plan',
    title: 'A demo plan',
    phases: 8,
    ready: [2],
    status: 'active',
    closed: false,
  },
  { slug: 'other', kind: 'plan', title: 'Another', phases: 6, ready: [], status: 'complete', closed: true },
];

const PORTFOLIO = {
  generatedAt: Date.parse('2026-08-22T12:00:00Z'),
  totals: {
    plans: 2,
    documents: 1,
    orphans: 1,
    closed: 1,
    phases: 14,
    done: 9,
    ready: 2,
    waiting: 2,
    inProgress: 1,
    stuck: 0,
    percent: 64,
    remainingWeight: 310_000,
    remainingSessions: 2,
  },
  byStatus: [
    { status: 'active', count: 1, closed: false },
    { status: 'complete', count: 1, closed: true },
  ],
  activeLocks: [{ slug: 'demo', phase: 2, owner: 'someone@host', expired: true, leaseUntil: 0 }],
  issues: [
    { slug: 'demo', kind: 'index-drift', severity: 'warning', message: 'INDEX.md disagrees', phase: 2 },
    { slug: 'other', kind: 'orphan', severity: 'info', message: 'a handoff folder with no plan' },
  ],
  velocity: [
    { week: '2026-W30', count: 2 },
    { week: '2026-W31', count: 5 },
  ],
  calendar: [{ date: '2026-08-21', count: 3 }],
  medianCycleDays: 1,
  sizeMix: [
    { size: 'S', count: 3 },
    { size: 'M', count: 8 },
  ],
  repos: [{ repo: 'phased-execution', count: 11 }],
  skills: [{ skill: 'phased-execution', count: 4 }],
  models: [{ model: 'claude-fable-5', count: 11 }],
  stalled: [{ slug: 'demo', days: 12, ready: [2, 3] }],
  busiest: [{ slug: 'demo', completions: 9 }],
  rate: { ratePerWeight: 60, basis: 'plan', samples: 5, spread: 0.4 },
};

const SPEND = {
  today: { settledUsd: 12.5, ladderUsd: 3.25, capUsd: 600 },
  runs: [{ runId: 'r1', slug: 'demo', spentUsd: 12.5, budgetUsd: 40 }],
  series: [
    { day: '2026-08-21', settledUsd: 8, ladderUsd: 1 },
    { day: '2026-08-22', settledUsd: 12.5, ladderUsd: 3.25 },
  ],
};

const INBOX = [
  {
    id: 'demo#2#gate',
    kind: 'gate',
    severity: 'needs-you',
    title: 'Phase 2 is behind a human gate',
    detail: 'Approve it on the plan page.',
    slug: 'demo',
    phase: 2,
    at: Date.parse('2026-08-22T11:00:00Z'),
    actions: [],
  },
];

/**
 * `PolicyView`, in the shape `data/api/policy.ts` declares it — not a plausible
 * one. `PolicyCard` indexes `effective` and `defaults` by list name, so a body
 * missing either is not an empty page, it is a `TypeError` mid-render.
 *
 * Populated on purpose: chips only exist when there are rules, the strike path
 * only exists when a shipped default is present, and `inert`/`support`/`seen`
 * each render a section that axe would otherwise never see.
 */
const POLICY = {
  defaults: {
    deny: ['Bash(rm -rf /)', 'Read(./.env)'],
    ask: ['Bash(git push:*)', 'WebFetch'],
    allow: ['Read', 'Glob', 'Grep'],
  },
  extra: {
    deny: [],
    ask: ['Bash(docker:*)'],
    allow: ['Bash(npm test:*)'],
    removed: { deny: [], ask: ['WebFetch'], allow: [] },
  },
  plan: null,
  effective: {
    deny: ['Bash(rm -rf /)', 'Read(./.env)'],
    ask: ['Bash(git push:*)', 'Bash(docker:*)'],
    allow: ['Read', 'Glob', 'Grep', 'Bash(npm test:*)'],
  },
  file: '/repo/.claude/settings.json',
  profiles: [
    { id: 'trusted', label: 'Trusted' },
    { id: 'guarded', label: 'Guarded' },
  ],
  inert: [{ raw: 'Bash(*)', note: 'a bare wildcard matches nothing the hook honours' }],
  support: [{ raw: 'Bash(npm test:*)', tool: 'Bash', form: 'prefix', support: 'honoured' }],
  hookTools: ['Bash', 'Write'],
  wrappersNotStripped: ['env'],
  seen: ['Bash', 'Read', 'Write'],
};

/**
 * `TailscaleStatus` is a three-way union on `state` (`data/api/system.ts`,
 * mirrored by `server/tailscale.ts`) — there is no `available` field anywhere in
 * it. An unrecognised body falls past both early returns in `Body` and reads
 * `status.serve`, which is how a fixture becomes a crash.
 *
 * `running` is the state worth fixturing: it is the only one that renders the
 * key/value table, the device list and the command blocks.
 */
const TAILSCALE = {
  state: 'running',
  tailnet: 'example.ts.net',
  magicDns: true,
  magicDnsSuffix: 'example.ts.net',
  self: {
    hostName: 'mac',
    dnsName: 'mac.example.ts.net',
    ips: ['100.64.0.1'],
    os: 'macOS',
    online: true,
  },
  peers: [
    { hostName: 'phone', dnsName: 'phone.example.ts.net', ips: ['100.64.0.2'], os: 'iOS', online: true },
    {
      hostName: 'laptop',
      dnsName: 'laptop.example.ts.net',
      ips: ['100.64.0.3'],
      os: 'Linux',
      online: false,
      lastSeen: '2026-08-21T09:00:00Z',
    },
  ],
  serve: { active: true, forOurPort: true, url: 'https://mac.example.ts.net' },
};

/**
 * The settings schema (`GET /api/prefs/schema`), built from the shared table
 * as the server builds it, with the session plan's model and the run's dollar
 * rung set here — so Appearance and Automation each draw a key's origin and a
 * Reset, and the index its sentence.
 */
const SCHEMA = schemaAnswer({
  model: { value: 'claude-opus-5', source: 'instance' },
  ladderPerRunUsd: { value: 30, default: 20, source: 'instance' },
});

/**
 * Settings ▸ Notifications (quiet-console phase 22): two kinds the server
 * announces, a device of this machine keeping quiet hours, and a webhook
 * backing off after a failure — so the walk covers a kind's switch, a device's
 * fold and a webhook's row rather than three empty groups.
 */
const CATEGORIES = [
  {
    id: 'needs-you',
    label: 'A phase needs you',
    detail: 'The run stops until you act.',
    byDefault: true,
    urgent: true,
  },
  { id: 'digest', label: 'Hourly digest', detail: 'A summary of the hour.', byDefault: false, urgent: false },
];

const PUSH = {
  publicKey: 'k',
  devices: [
    {
      id: 'd1',
      label: 'Mac · Chrome',
      service: 'https://web.push.example.com',
      categories: { 'needs-you': true, digest: false },
      createdAt: '2026-08-20T09:00:00Z',
      lastOkAt: '2026-08-22T11:00:00Z',
      failures: 0,
      quiet: { start: '22:00', end: '07:00', allowUrgent: true },
    },
  ],
  categories: CATEGORIES,
};

const WEBHOOKS = {
  allowWebhooks: true,
  hooks: [
    {
      id: 'h1',
      label: '#ops',
      origin: 'https://hooks.example.com',
      tail: 'a1',
      categories: { 'needs-you': true, digest: false },
      createdAt: '2026-08-20T09:00:00Z',
      lastOkAt: null,
      failures: 2,
      lastFailure: { at: '2026-08-22T11:30:00Z', status: 500, reason: 'Internal Server Error' },
    },
  ],
  categories: CATEGORIES,
};

/**
 * Settings ▸ Accounts (quiet-console phase 22), in the shape `GET /api/accounts`
 * serves: the machine's own login with both windows read, a check, its credits
 * and a run paying with it, and a removed registration still remembered — so
 * the walk covers an account's row opened to its facts, and the tombstones.
 * The clocks are relative to now: a window whose reset has passed is drawn as
 * stale, which is not the picture this section exists for.
 */
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const ACCOUNTS = {
  allowAccounts: true,
  accounts: [
    {
      id: 'default',
      kind: 'default',
      builtIn: true,
      email: 'me@example.com',
      plan: 'max',
      authState: 'ok',
      meter: 'ok',
      entitlement: { state: 'entitled', via: 'credential', by: 'probe', at: hoursFromNow(-2) },
      usage: {
        buckets: {
          five_hour: { utilization: 42, resetsAt: hoursFromNow(3), polledAt: hoursFromNow(-0.05) },
          seven_day: { utilization: 18, resetsAt: hoursFromNow(100), polledAt: hoursFromNow(-0.05) },
        },
        fetchedAt: hoursFromNow(-0.05),
      },
      probe: {
        at: hoursFromNow(-2),
        status: 'ok',
        reason: 'The API took work under it.',
        by: 'operator',
        count: 3,
        costUsd: 0.02,
      },
      breaker: { candidate: true, rank: 1 },
      credits: {
        allowed: false,
        available: true,
        carrying: false,
        reason: 'Credits are available and not in use.',
        used: null,
        limit: null,
        cap: null,
        remaining: null,
        currency: null,
        onCredit: false,
      },
      paying: [{ slug: 'demo', runId: 'r1' }],
    },
  ],
  tombstones: [
    {
      id: 'account-1a2b',
      name: 'old work login',
      retiredAt: '2026-08-01T00:00:00Z',
      credential: 'c0ffee12',
      entitlement: {
        state: 'retired',
        via: 'credential',
        class: 'org-policy',
        by: 'classifier',
        at: '2026-08-01T00:00:00Z',
        reason: 'Organisation policy blocks this credential.',
      },
    },
  ],
};

/** path → body. A miss is an explicit 404, never an accidental empty object. */
const ROUTES: [RegExp, unknown][] = [
  // Your turn (a destination in both editions since one-pool phase 14): nothing owed on
  // this console. Outside the Pro region, because the free edition draws the page too.
  [
    /^\/api\/turn(\?|$)/,
    {
      round: { at: '2026-08-22T12:00:00Z', n: 1, ranAt: '2026-08-22T12:00:00Z', changedAt: null },
      headline: 'Nothing needs you now.',
      groups: { approve: [], now: [], decide: [], checking: [], upcoming: [], done: [] },
      handled: [],
      counts: { approve: 0, now: 0, decide: 0, checking: 0, upcoming: 0, done: 0, total: 0, handled: 0 },
      seen: null,
      issues: null,
    },
  ],
  [/^\/api\/state/, STATE],
  [/^\/api\/plans\/[^/]+\/verify-preflight/, { warnings: [] }],
  [/^\/api\/plans\/[^/]+/, null],
  [/^\/api\/plans/, PLANS],
  [/^\/api\/stats/, PORTFOLIO],
  [/^\/api\/spend/, SPEND],
  // A person's turn (control-tower phase 42): the ledger the step card reads.
  [
    /^\/api\/human-steps/,
    {
      steps: [],
      reminders: { series: [900_000, 3_600_000, 21_600_000, 86_400_000], quiet: null },
      can: { openHost: false, terminal: false, resume: false },
    },
  ],
  [/^\/api\/inbox/, INBOX],
  [/^\/api\/approvals/, []],
  [/^\/api\/runs\/scopes/, { scopes: [] }],
  [/^\/api\/runs/, []],
  [
    /^\/api\/queue/,
    {
      max: 3,
      live: 0,
      queued: 0,
      throttledUntil: null,
      grants: [],
      entries: [],
      // What Settings ▸ Automation ▸ The queue draws: a plan with a word of its
      // own, and the load guard reading.
      policy: { console: 'seniority', plans: { demo: 'critical-path' }, default: 'seniority' },
      load: { avg5: 2.5, cores: 8, factor: 1.5, threshold: 12, holding: false },
    },
  ],
  [/^\/api\/sessions/, { sessions: [], max: 8 }],
  [/^\/api\/terminal/, { sessions: [], max: 8 }],
  // Settings ▸ Hooks (measured-console phase 28): one hook of each source, and one plan's rules.
  [
    /^\/api\/hooks$/,
    {
      hooks: [
        {
          source: 'plugin',
          file: '/opt/skill/hooks/hooks.json',
          event: 'SessionStart',
          type: 'command',
          runs: 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/session-hook.sh"',
          timeout: 15,
        },
        {
          source: 'run',
          file: 'run-<id>.json',
          event: 'PreToolUse',
          matcher: 'Bash',
          type: 'http',
          runs: '<console>/hooks/pre-tool-use',
          timeout: 3600,
          onFailure: 'block',
        },
      ],
      hookify: [
        {
          slug: 'demo',
          rules: [
            {
              rule: 'publish',
              name: 'pe-demo-publish',
              file: 'hookify.pe-demo-publish.local.md',
              event: 'bash',
              action: 'block',
              pattern: 'git\\s+push',
              source: 'permission.destructive',
              words: 'This plan (demo) denies publishing.',
            },
          ],
          onDisk: [],
        },
      ],
    },
  ],
  [/^\/api\/mcp\/catalog/, { entries: [] }],
  [/^\/api\/mcp/, { servers: [], allowMcp: false }],
  [/^\/api\/policy/, POLICY],
  // Logs ▸ Health's over-time series (measured-console phase 31).
  [
    /^\/api\/health\/series/,
    {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-29T10:00:00.000Z',
      bounds: { maxPoints: 2100, days: 30, sampleMs: 300_000 },
      measures: {
        gate: [{ at: '2026-09-20T12:00:00.000Z', v: 410 }],
        load: [
          { at: '2026-09-29T09:55:00.000Z', v: 0.75 },
          { at: '2026-09-29T10:00:00.000Z', v: 0.5 },
        ],
        persist: [{ at: '2026-09-29T09:55:00.000Z', v: 12.4 }],
        reconcile: [],
      },
    },
  ],
  [/^\/api\/accounts/, ACCOUNTS],
  [/^\/api\/push/, PUSH],
  [/^\/api\/webhooks/, WEBHOOKS],
  [
    /^\/api\/notifications/,
    {
      items: [],
      total: 0,
      unread: 0,
      more: false,
      categories: [],
      devices: 0,
      outOfBand: { configured: false },
    },
  ],
  [/^\/api\/tailscale/, TAILSCALE],
  // Settings (quiet-console phase 21): every key with its value and where it
  // came from, two of them set here; the presence hook's file, half installed;
  // where a Desktop launcher would go.
  [/^\/api\/prefs\/schema/, SCHEMA],
  [
    /^\/api\/hooks-install/,
    {
      path: '/repo/.claude/settings.json',
      exists: true,
      installed: false,
      partial: true,
      events: { SessionStart: true, SessionEnd: false, Stop: false },
      command: 'bash "/scripts/session-hook.sh"',
      stale: false,
    },
  ],
  [
    /^\/api\/launcher/,
    {
      platform: 'linux',
      supported: true,
      path: '/home/x/Desktop/phase-console-repo.desktop',
      kind: 'desktop-entry',
      note: '',
      rootOpen: true,
      fullFlags: ['--allow-writes', '--allow-run'],
    },
  ],
  [/^\/api\/hook/, { installed: false }],
  [/^\/api\/skills/, { skills: [] }],
  [/^\/api\/auth/, { loggedIn: true, checkedAt: '2026-08-22T00:00:00Z' }],
  [/^\/api\/search/, { query: '', total: 0, groups: [] }],
  // Populated on purpose, like every fixture above it: an empty index
  // renders an `Empty` with no list, no toolbar rows and no inspector
  // trigger, and a smoke that only ever saw that would prove nothing
  // about the destination it is named for.
  // Repo's History (7.0, quiet-console phase 17): a merge of a lane, a run
  // branch and a tag, so the walk is over real commit rows and the gutter.
  [
    /^\/api\/repo\/graph/,
    {
      trunk: 'main',
      tips: ['main', 'pe/demo', 'pe/demo-p2'],
      tipsTruncated: false,
      truncated: false,
      commits: [
        {
          sha: 'a'.repeat(40),
          short: 'aaaaaaa',
          parents: ['b'.repeat(40), 'c'.repeat(40)],
          refs: ['HEAD -> pe/demo'],
          subject: 'Settle the demo lane onto its run branch',
          author: 'demo session',
          at: '2026-09-01T09:00:00Z',
        },
        {
          sha: 'c'.repeat(40),
          short: 'ccccccc',
          parents: ['b'.repeat(40)],
          refs: ['pe/demo-p2'],
          subject: 'The lane’s own work',
          author: 'demo session',
          at: '2026-09-01T08:00:00Z',
        },
        {
          sha: 'b'.repeat(40),
          short: 'bbbbbbb',
          parents: [],
          refs: ['main', 'tag: v1.0.0'],
          subject: 'The trunk as it stands',
          author: 'the operator',
          at: '2026-08-30T08:00:00Z',
        },
      ],
    },
  ],
  [
    /^\/api\/debug\/index/,
    {
      entries: [
        {
          source: 'console',
          at: '2026-09-01T10:00:00.000Z',
          level: 'error',
          event: 'api.unhandled',
          text: 'the route threw',
          data: { path: '/api/x' },
        },
        {
          source: 'journal',
          at: '2026-09-01T09:59:00.000Z',
          level: 'info',
          event: 'phase.boarded',
          text: 'model=opus',
          slug: 'demo',
          runId: 'aaaa1111',
          phase: 2,
        },
      ],
      sources: [
        { source: 'console', available: true, count: 1, path: '~/.local/state/phase-console/console.log' },
        { source: 'supervisor', available: false, count: 0, note: 'Not started by launchd here.' },
        { source: 'journal', available: true, count: 1 },
        { source: 'outcome', available: true, count: 0 },
        { source: 'ruling', available: true, count: 0 },
        { source: 'delivery', available: true, count: 0 },
        { source: 'health', available: true, count: 0 },
      ],
      truncated: false,
      slugs: ['demo'],
    },
  ],
];

function body(path: string): unknown | undefined {
  for (const [pattern, value] of ROUTES) if (pattern.test(path)) return value;
  return undefined;
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(
        typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url,
      );
      const value = body(path);
      if (value === undefined) {
        return new Response('not fixtured', { status: 404, headers: { 'content-type': 'text/plain' } });
      }
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ *
 * The destinations
 * ------------------------------------------------------------------ */

/** Every destination, the route it renders at, and a string proving it painted. */
const DESTINATIONS: { id: string; route: string[]; query?: Record<string, string>; settled: RegExp }[] = [
  { id: 'plans', route: ['plans'], settled: /demo/i },
  { id: 'runs', route: ['runs'], settled: /run|nothing/i },
  // Your turn, a destination since one-pool phase 14: its headline is drawn by the loaded answer only.
  { id: 'turn', route: ['turn'], settled: /Nothing needs you now/ },
  { id: 'sessions', route: ['sessions'], settled: /session|nothing|new/i },
  // The two 4.0 stubs. Settle on content ONLY THE LOADED BRANCH renders — the
  // subtitle is drawn by the pending branch too, so settling on it let axe walk
  // a `CardSkeleton` and pass a page of `div`s. (QA round 2 proved it: an
  // `<img>` with no alt injected into Repo's loaded content did not fail the
  // smoke; the same injection into the pending branch did.)
  // Repo opens on its History (7.0): a commit's subject is drawn only by a loaded walk.
  { id: 'repo', route: ['repo'], settled: /Settle the demo lane/ },
  // The ETA's answer, not its question: 7.0 draws every question's heading
  // while its answer is still read (quiet-console phase 19), so a heading
  // would settle on a page of placeholders.
  { id: 'insights', route: ['insights'], settled: /sessions left/i },
  // Not the facts lead: that is drawn as soon as `/api/state` lands, while the
  // log explorer under it is still a placeholder — settling on it would let axe
  // walk a skeleton and pass a page that never rendered the surface this
  // destination is for. Not a log ROW either: those live in a virtualized
  // `DataList`, and jsdom lays nothing out, so the virtualizer measures a
  // zero-height scroller and renders none of them. Stubbing layout here would
  // change how `useTableFit` folds columns on every OTHER destination in this
  // table, which is a bigger change than this file is for. The source-status
  // strip is loaded-only, unvirtualized, and the one piece of the explorer
  // that is structural rather than a row. The rows' own accessibility is held
  // by `ui/data-list.test.tsx` (which does stub layout) and their
  // content by `screens/logs/logs.test.tsx`.
  { id: 'logs', route: ['logs'], settled: /not readable here/i },
  // The index's one sentence, read from the schema: the section list under it
  // is drawn before anything has been read (quiet-console phase 21).
  { id: 'settings', route: ['settings'], settled: /runs with 2 keys set here/ },
];

/**
 * Settings is a place of sections, each its own address — smoke them all, from
 * the same vocabulary the place renders, so a section cannot be added without a
 * smoke arriving with it.
 */
const { SETTINGS_SECTIONS } = await import('@/screens/settings/nav');

/**
 * What only a section's LOADED body draws. Since 7.0 a section's title
 * is the place's h1, drawn before its body has read a thing, so it settles
 * nothing (phase 19's rule, carried to Settings by phase 21). A section with no
 * row here is waited for as a region named with its title.
 */
const SECTION_SETTLED: Readonly<Record<string, () => Promise<unknown>>> = {
  essentials: () => screen.findByTestId('runs-by-itself', undefined, { timeout: WAIT }),
  // The session plan's model, set here in the schema fixture.
  appearance: () => screen.findByRole('button', { name: 'Reset model to its default' }, { timeout: WAIT }),
  automation: () => screen.findByTestId('load-reading', undefined, { timeout: WAIT }),
  everything: () => screen.findByTestId('settings-everything', undefined, { timeout: WAIT }),
  // A kind's switch exists only once the catalogue has been read (phase 22).
  notifications: () => screen.findByRole('checkbox', { name: 'A phase needs you' }, { timeout: WAIT }),
  // The list of accounts replaces its placeholder only once the accounts are read.
  accounts: () => screen.findByTestId('account-list', undefined, { timeout: WAIT }),
  // Phase 23's three: the registry's answer (the fixture registers none), the rule
  // editor's scope (drawn once the policy is read), this process's facts.
  mcp: () => screen.findByText(/No server is registered/, undefined, { timeout: WAIT }),
  permissions: () => screen.findByTestId('rules-scope', undefined, { timeout: WAIT }),
  // Phase 28: the run's PreToolUse is fixtured, and the plugin list once read.
  hooks: () => screen.findByTestId('hooks-list', undefined, { timeout: WAIT }),
  instance: () => screen.findByTestId('process-facts', undefined, { timeout: WAIT }),
};

async function mountAt(segments: string[], query: Record<string, string> = {}) {
  const head = segments[0];
  const { ROUTE_TABLE } = await import('@/shell/router');
  const entry = ROUTE_TABLE[head];
  if (!entry || entry.kind !== 'page') throw new Error(`${head} is not a page`);
  const View = entry.lazy;
  const route = { segments, query, path: segments.join('/') };
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<div>loading</div>}>
        <View route={route} />
      </Suspense>
    </QueryClientProvider>,
  );
}

/*
 * Two generous clocks, for two different reasons.
 *
 * `TIMEOUT` — axe over a whole page takes seconds in jsdom and this file runs
 * it fourteen times; the default 5 s turns a slow assertion into a timeout
 * that reads like a page that never painted.
 *
 * `WAIT` — every destination and every Settings section is behind a `lazy()`,
 * and `findBy*`'s default is ONE second. In isolation a chunk resolves inside
 * it; under the full 95-file parallel suite it does not, and `now` failed on
 * three consecutive runs with the Suspense fallback still on screen. Both
 * waits carry this explicitly. Raised rather than retried: a chunk that
 * genuinely never resolves must still fail, and a retry would hide exactly
 * that — as would leaving the default in place and calling the result flaky.
 */
const TIMEOUT = HEAVY_CASE_TIMEOUT;
const WAIT = 30_000;

describe('axe — every destination', () => {
  /*
   * The roster above is a local fixture list — each destination needs a route,
   * sometimes a query, and a `settled` matcher that only its LOADED branch
   * renders, and none of that belongs in shared vocabulary. But "local" was
   * also why it could silently fall behind: `shared/route-meta.js` is where a
   * destination is added, and adding a ninth there would have left it with no
   * axe coverage and nothing saying so. Settings sections are already held to
   * their vocabulary this way; this is the same promise for the eight.
   */
  it('covers exactly the destinations the shell actually has', () => {
    // 7.0 (quiet-console phase 3): the destinations are the same in both (eight since one-pool phase 14)
    // editions, and the Pro pages here that are not destinations (the
    // Supervisor's page, Fleet behind the switcher) are still route heads.
    const ids = DESTINATIONS.map((d) => d.id);
    expect(
      [...SHELL_DESTINATIONS].filter((id) => !ids.includes(id)),
      'every destination is smoked',
    ).toEqual([]);
    expect(
      ids.filter((id) => !(ROUTE_HEADS as readonly string[]).includes(id)),
      'a row the shell has no address for',
    ).toEqual([]);
  });

  for (const destination of DESTINATIONS) {
    it(
      `${destination.id} has no accessibility violations`,
      async () => {
        const { container } = await mountAt(destination.route, destination.query);
        // Wait for the real content, not the skeleton: a skeleton is a div, and a
        // page of divs passes every rule there is — and wait EXPLICITLY, because
        // the destination is behind a `lazy()` and `findBy`'s 1 s default is not
        // enough for a chunk under a 95-file parallel suite.
        await screen.findAllByText(destination.settled, undefined, { timeout: WAIT });
        await expectNoAxeViolations(container);
      },
      TIMEOUT,
    );
  }
});

describe('axe — every settings section', () => {

  for (const section of SETTINGS_SECTIONS) {
    it(
      `settings/${section.id} has no accessibility violations`,
      async () => {
        const { container } = await mountAt(['settings', section.id]);
        const settled = SECTION_SETTLED[section.id];
        if (settled) await settled();
        else await screen.findByRole('region', { name: section.title }, { timeout: WAIT });
        // And nothing in it still being read: every rebuilt group marks its
        // placeholders `aria-busy`, so a walk over one is a walk over a skeleton.
        await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull(), {
          timeout: WAIT,
        });
        await expectNoAxeViolations(container);
      },
      // `everything` draws every section at once, so axe walks the whole of
      // Settings in one pass: 44.7 s beside the gate's concurrent suites at a
      // load of 30 (measured-console phase 7's boarding red), where a single
      // section takes seconds. The bound scales with what the case walks.
      section.id === 'everything' ? TIMEOUT * 3 : TIMEOUT,
    );
  }
});

/**
 * A person's turn (control-tower phase 42): the step card joins the halt
 * card's family, and a card drawn on the Tower, in the bell and on the
 * phone's answer page is walked here in both its variants — the device code,
 * the WHERE badge, the one action and the folds all included.
 */
describe('the step card from an inbox row', () => {
  it(
    'has no accessibility violations, full or folded to its row',
    async () => {
      const { humanStepView } = await import('@shared/human-step-model.js');
      const { StepCard } = await import('@/cards/item-card');
      const { TooltipProvider } = await import('@/ui/tooltip');
      const item = {
        id: 'human-step:demo:2:s1',
        kind: 'human-step' as const,
        severity: 'needs-you' as const,
        slug: 'demo',
        phase: 2,
        title: 'Your turn — enter a device code for demo phase 2',
        need: 'Pair the deploy CLI',
        how: '',
        since: '2026-08-22T11:00:00Z',
        actions: [],
        href: '/plan/demo/phase/2',
        humanStep: humanStepView({
          kind: 'device-code',
          title: 'Pair the deploy CLI',
          stepId: 's1',
          openUrl: 'https://example.com/device',
          code: 'ABCD-1234',
          lines: ['Open the link on any device.', 'Type the code shown here.'],
          check: true,
        }),
      };
      const client = new QueryClient(queryClientConfig);
      const { container } = render(
        <QueryClientProvider client={client}>
          <TooltipProvider>
            <ul>
              <li>
                <StepCard item={item} />
              </li>
              <li>
                <StepCard item={item} variant="row" />
              </li>
            </ul>
          </TooltipProvider>
        </QueryClientProvider>,
      );
      await screen.findAllByTestId('step-primary');
      await expectNoAxeViolations(container);
    },
    TIMEOUT,
  );
});
