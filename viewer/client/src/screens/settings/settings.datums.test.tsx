/**
 * Settings II's control ledger (quiet-console phase 22, exit criterion 1): every
 * control 6.2's five sections carried — Notifications, Accounts, Owner keys,
 * Reach, Grants — exists in 7.0, by the name a person meets it under, and at
 * most ONE press deep (a fold opened, a row opened, a dialog raised). The left
 * column is 6.2's control as its card spelled it; the right is 7.0's role and
 * accessible name. A control that goes, is renamed past recognition or moves a
 * press deeper fails its row by name, with every control its stage did draw.
 *
 * A stage is one section in one state — a console with the flag, a browser
 * subscribed, an owner session gone stale — because some controls exist only
 * in a state (Sign in with the owner key, before a session; Clear retired, on
 * a retired account). Every fixture is the server's shape, served through the
 * one fixture server the Settings tests share (`test-kit.tsx`).
 *
 * What 7.0 draws that 6.2 never did keeps a row too, `(7.0)` in the left
 * column (quiet-console phase 26, exit criterion 3): what this machine holds
 * on Accounts — every credential asked again, or one, and the plans that name
 * it — and This instance's machine profile, each field's line to copy, beside
 * what the console keeps.
 *
 * Three 6.2 controls became one control or a fact, by ruling: the usage-alerts
 * switch on Accounts is the `notify.limits` kind in Notifications (Accounts
 * says so and links there); Pro's dashboard verbs — probe, clear retired,
 * credits, tombstones — are Accounts' own in both trees; the kinds checklist
 * and quiet hours of THIS browser are each device's, editable for any device.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { AccountView, NotificationCategory, PushDevice } from '@/data/api';
import { renderWithClient, schemaAnswer, type FixtureServer } from './test-kit';

const server = vi.hoisted((): FixtureServer => ({ reads: {}, calls: [] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);
// Which push row is this browser comes from the service worker, which jsdom lacks.
const push = vi.hoisted(() => ({ endpoint: null as string | null }));
vi.mock('@/lib/push', () => ({
  currentEndpoint: () => Promise.resolve(push.endpoint),
  blocker: () => null,
  describeBrowser: () => 'Chrome on macOS',
  iosNeedsInstall: () => false,
  enable: vi.fn(),
  disable: vi.fn(),
}));
vi.mock('@/lib/notify', () => ({ notifyState: () => 'default', askToNotify: vi.fn() }));

import { AccountsSection } from './accounts';
import { GrantsGroup } from './grants';
import { InstanceSection } from './instance';
import { NotificationsSection } from './notifications';
import { OwnerKeysGroup } from './owner-keys';
import { ReachGroup } from './reach';

vi.setConfig({ testTimeout: 20_000 });

const HOUR = 3_600_000;
const fromNow = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

/* ------------------------------------------------------------------ *
 * The fixtures — the server's shapes, populated so every control draws
 * ------------------------------------------------------------------ */

const CATEGORIES: NotificationCategory[] = [
  {
    id: 'needs-you',
    label: 'A phase needs you',
    detail: 'The run stops until you act.',
    byDefault: true,
    urgent: true,
  },
  { id: 'digest', label: 'Hourly digest', detail: 'A summary of the hour.', byDefault: false, urgent: false },
];

const DEVICES: PushDevice[] = [
  {
    id: 'd1',
    label: 'Mac · Chrome',
    service: 'https://web.push.example.com',
    categories: { 'needs-you': true, digest: false },
    createdAt: '2026-10-01T09:00:00.000Z',
    lastOkAt: '2026-10-10T09:00:00.000Z',
    failures: 0,
  },
  {
    id: 'd2',
    label: 'iPhone · Safari',
    service: 'https://web.push.apple.com',
    categories: { 'needs-you': true, digest: true },
    createdAt: '2026-10-02T09:00:00.000Z',
    lastOkAt: null,
    failures: 1,
    quiet: { start: '22:00', end: '07:00', allowUrgent: true },
  },
];

const HOOK = {
  id: 'h1',
  label: '#ops',
  origin: 'https://hooks.example.com',
  tail: 'a1',
  categories: { 'needs-you': true, digest: false },
  createdAt: '2026-10-01T09:00:00.000Z',
  lastOkAt: null,
  failures: 2,
  lastFailure: { at: '2026-10-10T09:00:00.000Z', status: 500, reason: 'Internal Server Error' },
};

function notifications({ subscribed }: { subscribed: boolean }) {
  push.endpoint = subscribed ? 'https://web.push.example.com/abc' : null;
  server.reads['/api/push'] = {
    publicKey: 'k',
    devices: subscribed ? DEVICES : DEVICES.slice(1),
    categories: CATEGORIES,
  };
  server.reads['/api/webhooks'] = { allowWebhooks: true, hooks: [HOOK], categories: CATEGORIES };
  server.reads['/api/state'] = { prefs: { notify: { 'needs-you': true } } };
  server.reads['/api/prefs/schema'] = schemaAnswer({
    'notify.needs-you': { value: true, default: true, source: 'instance' },
  });
  server.reads['/api/notifications'] = {
    items: [],
    total: 0,
    unread: 0,
    more: false,
    categories: CATEGORIES,
    devices: DEVICES.length,
    outOfBand: { configured: false },
  };
}

const MACHINE: AccountView = {
  id: 'default',
  kind: 'default',
  builtIn: true,
  email: 'me@example.com',
  plan: 'max',
  authState: 'ok',
  meter: 'ok',
  entitlement: { state: 'entitled', via: 'credential', by: 'probe', at: fromNow(-2) },
  usage: {
    buckets: {
      five_hour: { utilization: 42, resetsAt: fromNow(3), polledAt: fromNow(-0.05) },
      seven_day: { utilization: 18, resetsAt: fromNow(100), polledAt: fromNow(-0.05) },
    },
    fetchedAt: fromNow(-0.05),
  },
  probe: { at: fromNow(-2), status: 'ok', reason: 'The API took work under it.', by: 'operator', count: 3 },
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
};

/** A profile never signed in, on the machine login's identity: its Sign in, and the duplicate banner. */
const WORK: AccountView = {
  id: 'work',
  kind: 'profile',
  builtIn: false,
  name: 'work',
  email: 'me@example.com',
  signedIn: false,
  authState: 'signed-out',
  meter: 'none',
  entitlement: { state: 'unknown', via: 'none' },
};

/** A token account its organisation retired, still using credits: Clear retired and Stop using credits. */
const SPARE: AccountView = {
  id: 'spare',
  kind: 'token',
  builtIn: false,
  name: 'spare',
  authState: 'ok',
  meter: 'ok',
  tokenExpiresAt: fromNow(24 * 200),
  entitlement: {
    state: 'retired',
    via: 'org',
    class: 'org-policy',
    by: 'classifier',
    at: fromNow(-30),
    reason: 'Organisation policy blocks this credential.',
  },
  credits: {
    allowed: true,
    available: true,
    carrying: false,
    reason: 'Credits carry runs past the plan’s windows.',
    used: 4,
    limit: null,
    cap: null,
    remaining: null,
    currency: 'USD',
    capUsd: 20,
    onCredit: false,
  },
};

/** `lapsed`: the machine login and the token both expired — the repairs each kind of login has. */
function accounts({ lapsed = false } = {}) {
  const expired = { authState: 'expired' } as const;
  server.reads['/api/accounts'] = {
    allowAccounts: true,
    accounts: lapsed ? [{ ...MACHINE, ...expired }, WORK, { ...SPARE, ...expired }] : [MACHINE, WORK, SPARE],
    tombstones: [
      {
        id: 'account-1a2b',
        name: 'old work login',
        retiredAt: '2026-08-01T00:00:00.000Z',
        credential: 'c0ffee12',
        entitlement: {
          state: 'retired',
          via: 'credential',
          reason: 'Organisation policy blocks this credential.',
        },
      },
    ],
  };
  server.reads['/api/state'] = { allowAccounts: true, prefs: {} };
  server.reads['/api/prefs/schema'] = schemaAnswer();
}

const KEY = {
  id: 'k1',
  alg: 'ES256',
  label: 'MacBook',
  origin: 'http://localhost:4130',
  rpId: 'localhost',
  createdAt: '2026-10-01T09:00:00.000Z',
  lastUsedAt: '2026-10-10T09:00:00.000Z',
  counter: 4,
  backedUp: true,
};

function owner(state: 'unenrolled' | 'enrolled' | 'unlocked') {
  server.reads['/api/owner'] = {
    state,
    mode: state === 'unenrolled' ? 'unenrolled' : 'enrolled',
    keys: state === 'unenrolled' ? [] : [KEY],
    session:
      state === 'unlocked'
        ? {
            id: 's1',
            keyId: 'k1',
            label: 'MacBook',
            origin: 'http://localhost:4130',
            startedAt: fromNow(-1),
            lastSeenAt: fromNow(-0.1),
            assertedAt: fromNow(-1),
            idleEndsAt: fromNow(11),
            // Touched an hour ago: a high-risk press needs the key again.
            freshUntil: fromNow(-0.9),
            fresh: false,
          }
        : null,
    requests:
      state === 'unenrolled'
        ? []
        : [
            {
              id: 'q1',
              at: fromNow(-0.2),
              state: 'open',
              door: 'session',
              label: 'a session',
              press: 'grant',
              authority: 'grant',
              risk: 'high',
              method: 'POST',
              path: '/api/permissions/grant',
              body: {},
              summary: 'Grant Bash(npm publish:*) for this phase',
              item: null,
              repeats: 0,
              ask: 'asked by a session — grant — confirm?',
            },
          ],
    relyingParty: { id: 'localhost', origin: 'http://localhost:4130' },
  };
  server.reads['POST /api/owner/enroll/link'] = {
    link: 'http://localhost:4130/#/settings/permissions?enrol=t1',
    expiresAt: fromNow(0.1),
    first: false,
  };
}

const GRANT = {
  id: 'g1',
  at: fromNow(-3),
  by: 'owner',
  door: 'owner',
  item: 'permission:alpha:3:npm',
  wall: 'deny',
  tool: 'Bash',
  rule: 'Bash(npm publish:*)',
  family: 'publish',
  risk: 'high',
  scope: 'phase',
  slug: 'alpha',
  phase: 3,
  runId: 'r1',
  until: null,
  changed: [{ kind: 'hook', rule: 'Bash(npm publish:*)', runId: 'r1', phase: 3 }],
  state: 'live',
};

function grants() {
  server.reads['/api/permissions/grants'] = {
    grants: [
      GRANT,
      {
        ...GRANT,
        id: 'g2',
        rule: 'Bash(git push:*)',
        state: 'revoked',
        endedAt: fromNow(-1),
        endedBy: 'owner',
      },
    ],
    live: 1,
  };
}

function tailscale() {
  server.reads['/api/tailscale'] = {
    state: 'running',
    tailnet: 'example.ts.net',
    magicDns: true,
    magicDnsSuffix: 'example.ts.net',
    self: { hostName: 'mac', dnsName: 'mac.example.ts.net', ips: ['100.64.0.1'], os: 'macOS', online: true },
    peers: [
      { hostName: 'phone', dnsName: 'phone.example.ts.net', ips: ['100.64.0.2'], os: 'iOS', online: true },
    ],
    // Served, but for another console's port: the serve command is drawn to copy.
    serve: { active: true, forOurPort: false, url: 'https://mac.example.ts.net' },
  };
}

/** What this machine holds (quiet-console phase 26): a credential held, and one a plan and its phase name and lack. */
function credentials() {
  server.reads['/api/credentials'] = {
    at: fromNow(-0.02),
    cacheMs: 60_000,
    credentials: [
      { id: 'gh', status: 'ok', reason: 'gh auth status exits 0', known: true, named: [] },
      {
        id: 'env:STRIPE_KEY',
        status: 'fail',
        reason: 'the variable is not set',
        known: true,
        named: [{ slug: 'alpha' }, { slug: 'alpha', phase: 3 }],
      },
    ],
  };
}

/** This instance (quiet-console phase 23): the process, what it keeps, and the machine profile it reads. */
function instance() {
  const supervisor = { kind: 'launchd', detail: 'launchd (com.phase-console)', supervised: true };
  const sessions = { live: 0, agent: 0, terminal: 0, ended: 0, sessions: [], survives: true };
  server.reads['/api/state'] = {
    instance: { id: 'aaaaaaaa-alpha', name: 'alpha', pinned: false },
    port: 4123,
    home: '/home/x',
    allowRun: true,
    allowWrites: true,
    serverStale: false,
    bootedAt: fromNow(-2),
    staticRoot: 'dist',
    supervisor,
    execArgv: ['--max-old-space-size=6144'],
    remoteHosts: [],
    remoteUsers: [],
    prefs: {},
  };
  server.reads['/api/restart'] = { ok: true, supervisor, busy: false, run: null, sessions };
  server.reads['/api/tailscale'] = { state: 'not-installed' };
  server.reads['/api/debug/retention'] = {
    at: fromNow(0),
    policy: {},
    sinks: [{ sink: 'run-records', files: 3, bytes: 2048, due: 0 }],
    bytes: 2048,
    actions: [],
  };
  server.reads['/api/prefs/schema'] = schemaAnswer({
    'profile.maxSessions': { value: 6, source: 'profile' },
  });
  server.reads['/api/fleet/profile'] = {
    profile: { maxSessions: 8 },
    console: {
      id: 'aaaaaaaa-alpha',
      name: 'alpha',
      remoteHosts: [],
      remoteUsers: [],
      notifyCommand: false,
      maxSessions: 6,
      machineMaxSessions: 8,
      autostart: true,
      overridden: ['maxSessions'],
    },
  };
}

/* ------------------------------------------------------------------ *
 * The ledger
 * ------------------------------------------------------------------ */

type Role = 'button' | 'checkbox' | 'textbox' | 'combobox' | 'link' | 'group' | 'meter' | 'list' | 'dialog';

/** A control by its role and accessible name — or, for a field ARIA gives no role (a time, a password), by its label. */
type Control = { was: string } & ({ role: Role; name: string | RegExp } | { label: string });

interface Stage {
  /** The section, and the state that draws these controls. */
  stage: string;
  serve: () => void;
  ui: () => ReactElement;
  /** What the stage waits for before it reads a control: something only its LOADED body draws. */
  ready: { role: Role; name: string | RegExp };
  /** The ONE press that reaches `controls`, when they are a fold, a row or a dialog deep. */
  press?: { role: Role; name: string | RegExp };
  /** …or the one choice: a picker set to a value. */
  pick?: { name: string; value: string };
  controls: Control[];
}

const LEDGER: Stage[] = [
  // ---------------- Notifications ----------------
  {
    stage: 'Notifications, this browser not subscribed',
    serve: () => notifications({ subscribed: false }),
    ui: () => <NotificationsSection />,
    ready: { role: 'checkbox', name: 'A phase needs you' },
    controls: [
      { was: 'Announcements: Open the bell', role: 'link', name: 'Open the announcements' },
      { was: 'Announcements: Automation’s quiet hours', role: 'link', name: 'Automation' },
      { was: 'Routing: a switch per kind', role: 'checkbox', name: 'A phase needs you' },
      { was: 'Routing: a switch per kind (off by default)', role: 'checkbox', name: 'Hourly digest' },
      {
        was: '(7.0) a kind set here goes back to its default',
        role: 'button',
        name: 'Reset notify.needs-you to its default',
      },
      { was: 'Devices: Allow (in this tab)', role: 'button', name: 'Allow' },
      { was: 'Devices: Set a device up', role: 'button', name: 'Turn on' },
      { was: 'Devices: another device’s Test', role: 'button', name: 'Send a test' },
      { was: 'Webhooks: URL', role: 'textbox', name: 'Webhook URL' },
      { was: 'Webhooks: Name', role: 'textbox', name: 'Name' },
      { was: 'Webhooks: Add destination', role: 'button', name: 'Add webhook' },
      { was: 'Webhooks: Remove (now asked first)', role: 'button', name: 'Remove' },
    ],
  },
  {
    stage: 'Notifications, this browser subscribed',
    serve: () => notifications({ subscribed: true }),
    ui: () => <NotificationsSection />,
    ready: { role: 'button', name: 'Turn off' },
    controls: [
      { was: 'Devices: Send a test (this browser)', role: 'button', name: 'Send a test' },
      { was: 'Devices: Turn off', role: 'button', name: 'Turn off' },
    ],
  },
  {
    stage: 'Notifications, a device’s fold opened',
    serve: () => notifications({ subscribed: true }),
    ui: () => <NotificationsSection />,
    ready: { role: 'button', name: 'Turn off' },
    press: { role: 'button', name: 'What it hears, and when it is quiet' },
    controls: [
      {
        was: 'Devices: the kinds this browser hears',
        role: 'checkbox',
        name: 'Hourly digest, on Mac · Chrome',
      },
      { was: 'Devices: quiet hours on or off', role: 'checkbox', name: 'Quiet hours on Mac · Chrome' },
    ],
  },
  {
    stage: 'Notifications, a quiet device’s fold opened',
    serve: () => notifications({ subscribed: false }),
    ui: () => <NotificationsSection />,
    ready: { role: 'button', name: 'Turn on' },
    press: { role: 'button', name: 'What it hears, and when it is quiet' },
    controls: [
      { was: 'Devices: quiet hours From', label: 'Quiet from, on iPhone · Safari' },
      { was: 'Devices: quiet hours Until', label: 'Quiet until, on iPhone · Safari' },
      {
        was: 'Devices: Urgent still gets through',
        role: 'checkbox',
        name: 'Urgent still gets through, on iPhone · Safari',
      },
      { was: '(7.0) another device’s kinds', role: 'checkbox', name: 'Hourly digest, on iPhone · Safari' },
    ],
  },
  {
    stage: 'Notifications, a webhook’s fold opened',
    serve: () => notifications({ subscribed: false }),
    ui: () => <NotificationsSection />,
    ready: { role: 'button', name: 'Add webhook' },
    press: { role: 'button', name: 'What it receives' },
    controls: [{ was: 'Webhooks: the Categories toggle', role: 'checkbox', name: 'Hourly digest, to #ops' }],
  },

  // ---------------- Accounts ----------------
  {
    stage: 'Accounts, with --allow-accounts',
    serve: accounts,
    ui: () => <AccountsSection />,
    ready: { role: 'button', name: 'Refresh every account' },
    controls: [
      { was: 'Limits: Refresh all', role: 'button', name: 'Refresh every account' },
      { was: 'Limits: the duplicate banner’s remove', role: 'button', name: 'Remove work' },
      { was: 'Limits: an account’s Refresh', role: 'button', name: 'Refresh' },
      { was: 'Limits: an account opened in place', role: 'button', name: 'Show details of me@example.com' },
      {
        was: 'Usage alerts: Turn off (one control, in Notifications)',
        role: 'link',
        name: 'Turn usage alerts off in Notifications',
      },
      {
        was: 'Registry: Sign another account in (its name)',
        role: 'textbox',
        name: 'Sign another account in',
      },
      { was: 'Registry: Sign in…', role: 'button', name: 'Sign in' },
      { was: 'Registry: Paste a token…', role: 'button', name: 'Paste a token' },
    ],
  },
  {
    stage: 'Accounts, the machine login opened',
    serve: accounts,
    ui: () => <AccountsSection />,
    ready: { role: 'button', name: 'Refresh every account' },
    press: { role: 'button', name: 'Show details of me@example.com' },
    controls: [
      { was: 'Limits: the meter per window', role: 'meter', name: 'me@example.com: 5-hour window' },
      { was: 'Limits: the weekly meter', role: 'meter', name: 'me@example.com: weekly, all models' },
      { was: 'Dashboard (Pro): Probe entitlement', role: 'button', name: 'Probe entitlement' },
      {
        was: 'Dashboard (Pro): Use credits past plan limits',
        role: 'button',
        name: 'Use credits past plan limits',
      },
      { was: 'Registry: Rename', role: 'button', name: 'Rename' },
    ],
  },
  {
    stage: 'Accounts, a profile never signed in, opened',
    serve: accounts,
    ui: () => <AccountsSection />,
    ready: { role: 'button', name: 'Refresh every account' },
    press: { role: 'button', name: 'Show details of work' },
    controls: [
      { was: 'Registry: Sign in (a profile)', role: 'button', name: 'Sign in' },
      { was: 'Registry: Remove (asked first)', role: 'button', name: 'Remove' },
    ],
  },
  {
    stage: 'Accounts, the machine login lapsed, opened',
    serve: () => accounts({ lapsed: true }),
    ui: () => <AccountsSection />,
    ready: { role: 'button', name: 'Refresh every account' },
    press: { role: 'button', name: 'Show details of me@example.com' },
    controls: [
      { was: 'Registry: Sign in again', role: 'button', name: 'Sign in again' },
      { was: 'Repair: Copy the command', role: 'button', name: 'Copy the command' },
    ],
  },
  {
    stage: 'Accounts, a retired token account opened',
    serve: () => accounts({ lapsed: true }),
    ui: () => <AccountsSection />,
    ready: { role: 'button', name: 'Refresh every account' },
    press: { role: 'button', name: 'Show details of spare' },
    controls: [
      { was: 'Dashboard (Pro): Clear retired', role: 'button', name: 'Clear retired' },
      { was: 'Dashboard (Pro): Stop using credits', role: 'button', name: 'Stop using credits' },
      { was: 'Repair: Replace token', role: 'button', name: 'Replace token' },
    ],
  },
  {
    stage: 'Accounts, Paste a token pressed',
    serve: accounts,
    ui: () => <AccountsSection />,
    ready: { role: 'button', name: 'Paste a token' },
    press: { role: 'button', name: 'Paste a token' },
    controls: [
      { was: 'Paste a token: Name', role: 'textbox', name: 'Name' },
      { was: 'Paste a token: Token', label: 'Token' },
      { was: 'Paste a token: Add account', role: 'button', name: 'Add account' },
    ],
  },
  {
    stage: 'Accounts, what this machine holds',
    serve: () => {
      accounts();
      credentials();
    },
    ui: () => <AccountsSection />,
    ready: { role: 'button', name: 'Check every credential again' },
    controls: [
      { was: '(7.0) every credential asked again', role: 'button', name: 'Check every credential again' },
      { was: '(7.0) one credential asked again', role: 'button', name: 'Check again' },
      { was: '(7.0) a credential opened in place', role: 'button', name: 'Show details of env:STRIPE_KEY' },
    ],
  },
  {
    stage: 'Accounts, a credential opened',
    serve: () => {
      accounts();
      credentials();
    },
    ui: () => <AccountsSection />,
    ready: { role: 'button', name: 'Check every credential again' },
    press: { role: 'button', name: 'Show details of env:STRIPE_KEY' },
    controls: [
      { was: '(7.0) the plan that names it', role: 'link', name: 'alpha' },
      { was: '(7.0) the phase that names it', role: 'link', name: 'alpha P3' },
    ],
  },

  // ---------------- Owner keys ----------------
  {
    stage: 'Owner keys, none enrolled',
    serve: () => owner('unenrolled'),
    ui: () => <OwnerKeysGroup />,
    ready: { role: 'button', name: 'Copy the command' },
    controls: [{ was: 'The machine’s enrol command, copied', role: 'button', name: 'Copy the command' }],
  },
  {
    stage: 'Owner keys, a key and no session here',
    serve: () => owner('enrolled'),
    ui: () => <OwnerKeysGroup />,
    ready: { role: 'list', name: 'Enrolled owner keys' },
    controls: [
      { was: 'Sign in with the owner key', role: 'button', name: 'Sign in with the owner key' },
      { was: 'Lock every session', role: 'button', name: 'Lock every session' },
      { was: 'A key’s Remove (asked first)', role: 'button', name: 'Remove' },
      { was: 'The requests waiting: Your turn', role: 'link', name: 'Your turn' },
    ],
  },
  {
    stage: 'Owner keys, a session gone stale',
    serve: () => owner('unlocked'),
    ui: () => <OwnerKeysGroup />,
    ready: { role: 'list', name: 'Enrolled owner keys' },
    controls: [
      { was: 'Touch the key again', role: 'button', name: 'Touch the key again' },
      { was: 'Make a link for another device', role: 'button', name: 'Make a link for another device' },
      { was: 'Lock this browser', role: 'button', name: 'Lock this browser' },
      { was: 'Lock every session', role: 'button', name: 'Lock every session' },
      { was: 'Name this key', role: 'textbox', name: 'Name this key' },
      { was: 'Add a passkey in this browser', role: 'button', name: 'Add a passkey in this browser' },
    ],
  },
  {
    stage: 'Owner keys, a link made',
    serve: () => owner('unlocked'),
    ui: () => <OwnerKeysGroup />,
    ready: { role: 'list', name: 'Enrolled owner keys' },
    press: { role: 'button', name: 'Make a link for another device' },
    controls: [{ was: 'The link, copied', role: 'button', name: 'Copy the link' }],
  },

  // ---------------- Reach ----------------
  {
    stage: 'Reach, Tailscale running',
    serve: tailscale,
    ui: () => <ReachGroup port={4130} remoteHosts={['mac.example.ts.net']} remoteUsers={['me@github']} />,
    ready: { role: 'list', name: 'Devices on this tailnet' },
    controls: [
      { was: 'Copy prompt', role: 'button', name: 'Copy the setup prompt' },
      { was: 'Devices on this tailnet', role: 'list', name: 'Devices on this tailnet' },
      { was: 'The setup commands', role: 'group', name: 'Setup commands' },
      { was: 'A command’s Copy', role: 'button', name: 'Copy the serve command' },
      { was: 'The prompt, shown', role: 'button', name: 'Have Claude set this up instead' },
    ],
  },

  // ---------------- This instance (quiet-console phase 23's groups) ----------------
  {
    stage: 'This instance, the machine profile and what it keeps',
    serve: instance,
    ui: () => <InstanceSection />,
    ready: { role: 'link', name: 'Everything lists them with every other key' },
    controls: [
      {
        was: '(7.0) a profile field’s line, to copy',
        role: 'button',
        name: 'phase-console profile set maxSessions <json>',
      },
      {
        was: '(7.0) every profile key, in Everything',
        role: 'link',
        name: 'Everything lists them with every other key',
      },
      { was: '(7.0) what this console keeps', role: 'list', name: 'What this console keeps' },
    ],
  },

  // ---------------- Grants ----------------
  {
    stage: 'Grants, one live',
    serve: grants,
    ui: () => <GrantsGroup />,
    ready: { role: 'list', name: 'Every grant' },
    controls: [
      { was: 'Revoke all (asked first)', role: 'button', name: 'Revoke all' },
      { was: 'A live grant’s Revoke', role: 'button', name: 'Revoke' },
      { was: 'The item that asked', role: 'link', name: 'The item that asked' },
    ],
  },
  {
    stage: 'Grants, Revoke pressed',
    serve: grants,
    ui: () => <GrantsGroup />,
    ready: { role: 'list', name: 'Every grant' },
    press: { role: 'button', name: 'Revoke' },
    controls: [
      { was: '(7.0) why it is revoked', role: 'textbox', name: 'Why Bash(npm publish:*) is revoked' },
    ],
  },
  {
    stage: 'Grants, Revoke all pressed',
    serve: grants,
    ui: () => <GrantsGroup />,
    ready: { role: 'list', name: 'Every grant' },
    press: { role: 'button', name: 'Revoke all' },
    controls: [
      { was: '(7.0) why every one is revoked', role: 'textbox', name: 'Why every live grant is revoked' },
    ],
  },
];

/** A control's name as near as the page spells it: its aria-label, its label, else its text. */
function nameOf(el: HTMLElement): string {
  const labels = (el as HTMLInputElement).labels;
  return (el.getAttribute('aria-label') ?? labels?.[0]?.textContent ?? el.textContent ?? '')
    .trim()
    .slice(0, 80);
}

/** Every control a stage drew — what a failing row prints beside the name it could not find. */
function drawn(): string[] {
  const roles: Role[] = [
    'button',
    'checkbox',
    'textbox',
    'combobox',
    'link',
    'group',
    'meter',
    'list',
    'dialog',
  ];
  const fields = [
    ...document.querySelectorAll<HTMLInputElement>('input[type="time"], input[type="password"]'),
  ];
  return [
    ...roles.flatMap((role) => screen.queryAllByRole(role).map((el) => `${role} “${nameOf(el)}”`)),
    ...fields.map((el) => `field “${nameOf(el)}”`),
  ];
}

beforeEach(() => {
  server.calls = [];
  server.reads = {};
  push.endpoint = null;
  // A passkey needs the browser's WebAuthn, which jsdom lacks.
  vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
  Object.defineProperty(navigator, 'credentials', { value: {}, configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Settings II: every control of 6.2’s five sections, at most one press deep', () => {
  for (const stage of LEDGER) {
    it(stage.stage, async () => {
      stage.serve();
      renderWithClient(stage.ui());
      await screen.findByRole(stage.ready.role, { name: stage.ready.name }, { timeout: 10_000 });
      if (stage.press) {
        const [opener] = await screen.findAllByRole(stage.press.role, { name: stage.press.name });
        fireEvent.click(opener!);
      }
      if (stage.pick) {
        const picker = await screen.findByRole('combobox', { name: stage.pick.name });
        await waitFor(() =>
          expect(picker.querySelector(`option[value="${stage.pick!.value}"]`)).not.toBeNull(),
        );
        fireEvent.change(picker, { target: { value: stage.pick.value } });
      }
      await waitFor(() => {
        const missing = stage.controls
          .filter((control) =>
            'label' in control
              ? screen.queryAllByLabelText(control.label).length === 0
              : screen.queryAllByRole(control.role, { name: control.name }).length === 0,
          )
          .map((control) =>
            'label' in control
              ? `${control.was} → the field labelled “${control.label}”`
              : `${control.was} → ${control.role} “${String(control.name)}”`,
          );
        expect(missing, `this stage drew:\n  ${drawn().join('\n  ')}`).toEqual([]);
      });
    });
  }
});
