/**
 * Settings ▸ Notifications (quiet-console phase 22): what is announced and
 * where each kind lands, the reminders of a person's turn, and the section
 * around them.
 *
 * What it holds: one switch per kind of the server's catalogue, each the
 * schema's `notify.<kind>` key, saved as the delta the server merges; a kind
 * the file never held reads its catalogue default; the line under each kind
 * says where it lands — this browser, and the webhooks that would actually
 * receive it; a kind that stops work, switched off, is said once. The reminder
 * series is the console's clock, and the quiet hours a reminder keeps are each
 * device's, named from the push register — never a window of its own (#215).
 *
 * The line never lies about a webhook in the ways it could: a console without
 * `--allow-webhooks` posts to none, a webhook inside its failure backoff drops
 * what it skips (and one past it is counted again), and no browser subscribed
 * here is a different fact from one that narrowed the kind out. A register
 * silent about a kind reads that kind's catalogue default — never "on". The
 * fixtures are whole registers, as the server serves them, except where a case
 * names the silence it tests.
 *
 * #269: the reminders case once read another case's window under the full
 * suite's load. Each case here mounts its own query client, and the window
 * case runs on a fixed clock, so nothing a neighbour leaves behind or the
 * wall clock's minute can reach it.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMINDER_SERIES_MS } from '@shared/human-step-model.js';
import type { NotificationCategory, PushDevice, WebhookRow } from '@/data/api';
import { keys } from '@/data/keys';
import { renderWithClient, schemaAnswer, sent, type FixtureServer } from './test-kit';

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

import { SETTINGS_SECTIONS } from './nav';
import { NotificationsSection } from './notifications';
import { RemindersGroup, gapWords, quietSentence, reminderDevices } from './reminders';
import { RoutingGroup, routeWords } from './routing';

/** The kinds around the twentieth — the catalogue the server serves, in its order. */
const CATEGORIES: NotificationCategory[] = [
  {
    id: 'needs-you',
    label: 'A phase needs you',
    detail: 'The run stops until you act.',
    byDefault: true,
    urgent: true,
  },
  { id: 'digest', label: 'Hourly digest', detail: 'A summary.', byDefault: false, urgent: false },
  {
    id: 'granted',
    label: 'Permission granted',
    detail: 'A grant was applied — the push opens Settings ▸ Permissions ▸ Grants at it.',
    byDefault: true,
    urgent: false,
  },
];

/** A device as the register serves it — every kind present. */
function device(id: string, label: string, over: Partial<PushDevice> = {}): PushDevice {
  return {
    id,
    label,
    service: 'https://web.push.example.com',
    categories: { 'needs-you': true, digest: false, granted: true },
    createdAt: '2026-10-08T00:00:00.000Z',
    lastOkAt: null,
    failures: 0,
    ...over,
  };
}

/** A webhook as the register serves it — every kind present. */
function hook(id: string, label: string, over: Partial<WebhookRow> = {}): WebhookRow {
  return {
    id,
    label,
    origin: 'https://hooks.example.com',
    tail: id,
    categories: { 'needs-you': true, digest: false, granted: true },
    createdAt: '2026-10-08T00:00:00.000Z',
    lastOkAt: null,
    failures: 0,
    ...over,
  };
}

function answer({
  devices = [] as PushDevice[],
  hooks = [] as unknown[],
  allowWebhooks = false,
  notify = {} as Record<string, boolean>,
  schema = {} as Parameters<typeof schemaAnswer>[0],
  categories = CATEGORIES,
} = {}) {
  server.reads['/api/push'] = { publicKey: 'k', devices, categories };
  server.reads['/api/webhooks'] = { allowWebhooks, hooks, categories };
  server.reads['/api/state'] = { prefs: { notify } };
  server.reads['/api/prefs/schema'] = schemaAnswer(schema);
}

/** The line under one kind that says where it lands. */
const lineOf = (kind: string) =>
  document.querySelector<HTMLElement>(`[data-kind="${kind}"] [data-route-line]`);

beforeEach(() => {
  server.calls = [];
  server.reads = { 'POST /api/prefs': {} };
  push.endpoint = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('what is announced', () => {
  it('draws one switch per kind of the catalogue, in its order, each the schema’s notify key', async () => {
    answer();
    renderWithClient(<RoutingGroup />);
    await screen.findByRole('checkbox', { name: 'Permission granted' });
    expect([...document.querySelectorAll('[data-pref]')].map((el) => el.getAttribute('data-pref'))).toEqual([
      'notify.needs-you',
      'notify.digest',
      'notify.granted',
    ]);
    const needsYou = document.querySelector<HTMLElement>('[data-kind="needs-you"]')!;
    expect(needsYou).toHaveTextContent('Urgent: it breaks through a device’s quiet hours');
    expect(document.querySelector('[data-kind="digest"]')).toHaveTextContent('Off unless you turn it on');
    expect(screen.getByText('3 kinds, 1 off')).toBeInTheDocument();
  });

  it('shows the twentieth kind — Permission granted — with its own switch, on by default, and saves a delta', async () => {
    answer({ schema: { 'notify.granted': { value: true, default: true } } });
    const view = renderWithClient(<RoutingGroup />);
    const box = await screen.findByRole('checkbox', { name: 'Permission granted' });
    await waitFor(() => expect(view.client.getQueryState(keys.prefsSchema())?.status).toBe('success'));
    // A file that never held the kind reads its catalogue default: on.
    expect(box).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(box);
    await waitFor(() => expect(sent(server, 'POST', '/api/prefs')).toEqual([{ notify: { granted: false } }]));
  });

  it('holds the switch where the console holds it, and says it was set here', async () => {
    answer({
      notify: { granted: false },
      schema: { 'notify.granted': { value: false, default: true, source: 'instance' } },
    });
    renderWithClient(<RoutingGroup />);
    const box = await screen.findByRole('checkbox', { name: 'Permission granted' });
    await waitFor(() => expect(box).toHaveAttribute('aria-checked', 'false'));
    const row = document.querySelector<HTMLElement>('[data-kind="granted"]')!;
    expect(within(row).getByText('Off: nothing is recorded and nothing is sent.')).toBeInTheDocument();
    expect(within(row).getByText('Set here')).toBeInTheDocument();
    // A member of the announcement map goes back to its default by its dotted name.
    fireEvent.click(within(row).getByRole('button', { name: 'Reset notify.granted to its default' }));
    await waitFor(() => expect(sent(server, 'POST', '/api/prefs')).toEqual([{ 'notify.granted': null }]));
  });

  it('falls back to a kind’s catalogue default when nothing the console holds names it', async () => {
    // A newer server's kind: the catalogue serves it, the schema has no row for it, the file never held it.
    const newer: NotificationCategory = {
      id: 'release',
      label: 'A release was cut',
      detail: 'A tag and its notes.',
      byDefault: true,
      urgent: false,
    };
    answer({ categories: [...CATEGORIES, newer], notify: { 'needs-you': true } });
    const view = renderWithClient(<RoutingGroup />);
    const box = await screen.findByRole('checkbox', { name: 'A release was cut' });
    await waitFor(() => {
      expect(view.client.getQueryState(keys.state())?.status).toBe('success');
      expect(view.client.getQueryState(keys.prefsSchema())?.status).toBe('success');
    });
    expect(box).toHaveAttribute('aria-checked', 'true');
    expect(document.querySelector('[data-kind="release"]')).toHaveAttribute('data-pref', 'notify.release');
    // …and a kind that ships off, never written, stays off rather than reading as on.
    expect(screen.getByRole('checkbox', { name: 'Hourly digest' })).toHaveAttribute('aria-checked', 'false');
  });

  it('toggles a kind when its name is pressed, not only its 16px box', async () => {
    answer();
    renderWithClient(<RoutingGroup />);
    // The row IS the label: a box whose only hit area is the one drawn fails on a phone.
    const name = await screen.findByText('Hourly digest');
    expect(name.closest('label')).not.toBeNull();
    fireEvent.click(name);
    // It ships off, so the press turns it on — that one kind, as a delta.
    await waitFor(() => expect(sent(server, 'POST', '/api/prefs')).toEqual([{ notify: { digest: true } }]));
  });

  it('says where each kind lands: this browser, and the webhooks that would receive it now', async () => {
    push.endpoint = 'https://web.push.example.com/abc';
    answer({
      devices: [
        device('d1', 'Mac · Chrome', { categories: { 'needs-you': true, digest: false, granted: false } }),
      ],
      allowWebhooks: true,
      hooks: [
        {
          id: 'h1',
          label: '#ops',
          origin: 'https://hooks.example.com',
          tail: 'a1',
          categories: { 'needs-you': true, granted: true },
          createdAt: '',
          lastOkAt: null,
          failures: 0,
        },
        {
          id: 'h2',
          label: '#builds',
          origin: 'https://hooks.example.com',
          tail: 'b2',
          categories: { 'needs-you': true, granted: false },
          createdAt: '',
          lastOkAt: null,
          failures: 3,
          quietUntil: Date.now() + 60_000,
        },
      ],
    });
    renderWithClient(<RoutingGroup />);
    const needsYou = await waitFor(() => {
      const row = document.querySelector<HTMLElement>('[data-kind="needs-you"] [data-route-line]');
      expect(row).toHaveTextContent('this device');
      return row!;
    });
    expect(needsYou).toHaveTextContent(
      'Goes to the inbox, this device and 1 of 2 webhooks. 1 webhook takes it but is backing off after a failure.',
    );
    expect(document.querySelector('[data-kind="granted"] [data-route-line]')).toHaveTextContent(
      'Goes to the inbox, not this device and 1 of 2 webhooks.',
    );
  });

  it('tells “no browser here is subscribed” apart from “subscribed and narrowed out”, and says “no webhooks” rather than “0 of 0”', async () => {
    // Another browser is subscribed and has narrowed the kind out; this one is not subscribed at all.
    answer({
      devices: [
        device('d1', 'iPhone · Safari', { categories: { 'needs-you': false, digest: false, granted: true } }),
      ],
    });
    renderWithClient(<RoutingGroup />);
    await screen.findByRole('checkbox', { name: 'A phase needs you' });
    expect(lineOf('needs-you')).toHaveTextContent('Goes to the inbox, no device here and no webhooks.');
    expect(lineOf('needs-you')).not.toHaveTextContent(/not this device/);
  });

  it('resolves a kind no register holds to its catalogue default, on both legs', async () => {
    // A shape the server never serves — it fills every key — read as the server WOULD resolve it, never as "on".
    push.endpoint = 'https://web.push.example.com/abc';
    answer({
      devices: [device('d1', 'Mac · Chrome', { categories: {} })],
      allowWebhooks: true,
      hooks: [hook('h1', '#ops', { categories: {} })],
      // Switched on console-wide, so its row says where it lands at all.
      notify: { digest: true },
      schema: { 'notify.digest': { value: true, default: false, source: 'instance' } },
    });
    renderWithClient(<RoutingGroup />);
    // `needs-you` ships on: silence reads on, on both legs.
    await waitFor(() =>
      expect(lineOf('needs-you')).toHaveTextContent('Goes to the inbox, this device and 1 webhook.'),
    );
    // `digest` ships off: silence reads off, on both legs.
    await waitFor(() =>
      expect(lineOf('digest')).toHaveTextContent('Goes to the inbox, not this device and 0 of 1 webhooks.'),
    );
  });

  it('counts only the webhooks that take a kind, and gives the bare count when every one does', async () => {
    answer({
      allowWebhooks: true,
      hooks: [
        hook('h1', '#ops'),
        hook('h2', '#builds', { categories: { 'needs-you': true, digest: false, granted: false } }),
      ],
    });
    renderWithClient(<RoutingGroup />);
    // Nothing narrows `needs-you`, so the count is not worth spelling as "2 of 2".
    await waitFor(() =>
      expect(lineOf('needs-you')).toHaveTextContent('Goes to the inbox, no device here and 2 webhooks.'),
    );
    expect(lineOf('needs-you')).not.toHaveTextContent(/of 2/);
    // #builds has struck `granted`.
    expect(lineOf('granted')).toHaveTextContent('Goes to the inbox, no device here and 1 of 2 webhooks.');
  });

  it('never gives a bare count of webhooks this console may not post to, and says why once', async () => {
    // Without `--allow-webhooks` the console posts nothing, so every registered webhook is unreachable.
    answer({ allowWebhooks: false, hooks: [hook('h1', '#ops'), hook('h2', '#builds')] });
    renderWithClient(<RoutingGroup />);
    await waitFor(() =>
      expect(lineOf('needs-you')).toHaveTextContent(
        'Goes to the inbox, no device here and 2 webhooks, none reachable.',
      ),
    );
    expect(lineOf('granted')).toHaveTextContent('2 webhooks, none reachable.');
    // …and the reason is said once, for the group, not under every kind.
    const group = document.querySelector<HTMLElement>('[data-settings-group="routing"]')!;
    expect(group.textContent?.match(/--allow-webhooks/g)).toHaveLength(1);
    expect(screen.getByText(/started without/)).toHaveTextContent(
      '2 webhooks are registered, and none is reachable',
    );
  });

  it('counts a webhook whose backoff has already ended', async () => {
    // A fixed clock: the backoff is measured against the render's instant, never the wall's.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
    answer({
      allowWebhooks: true,
      hooks: [hook('h1', '#ops', { failures: 3, quietUntil: Date.parse('2026-10-11T11:59:59Z') })],
    });
    renderWithClient(<RoutingGroup />);
    // A webhook that has served its penalty takes the kind again; leaving it out would understate.
    await waitFor(() =>
      expect(lineOf('needs-you')).toHaveTextContent('Goes to the inbox, no device here and 1 webhook.'),
    );
    expect(lineOf('needs-you')).not.toHaveTextContent(/backing off/);
  });

  it('says once that a kind which stops work is off, and that registered webhooks are unreachable without the flag', async () => {
    answer({
      notify: { 'needs-you': false },
      schema: { 'notify.needs-you': { value: false, default: true, source: 'instance' } },
      hooks: [
        {
          id: 'h1',
          label: '#ops',
          origin: 'https://hooks.example.com',
          tail: 'a1',
          categories: {},
          createdAt: '',
          lastOkAt: null,
          failures: 0,
        },
      ],
    });
    renderWithClient(<RoutingGroup />);
    expect(await screen.findByTestId('routing-muted')).toHaveTextContent('A phase needs you is off.');
    expect(screen.getByText(/1 webhook is registered, and none is reachable/)).toBeInTheDocument();
  });

  it('words a route from the facts alone', () => {
    expect(routeWords({ device: null, takenBy: 0, backingOff: 0, hooks: 0, allowWebhooks: true })).toBe(
      'Goes to the inbox, no device here and no webhooks.',
    );
    expect(routeWords({ device: true, takenBy: 2, backingOff: 0, hooks: 2, allowWebhooks: true })).toBe(
      'Goes to the inbox, this device and 2 webhooks.',
    );
    expect(routeWords({ device: false, takenBy: 2, backingOff: 0, hooks: 2, allowWebhooks: false })).toBe(
      'Goes to the inbox, not this device and 2 webhooks, none reachable.',
    );
  });
});

describe('the budget kind (control-tower phase 14, #40)', () => {
  /**
   * The catalogue's own row: on, and not urgent — a spent budget holds the
   * work rather than stopping it dead, and the remedy is a raise. The group has
   * no list of its own; it draws whatever the server serves.
   */
  const BUDGET: NotificationCategory = {
    id: 'budget',
    label: 'Budget spent or running low',
    detail: 'A budget that can stop work reached 80% or ran out. Not urgent: a spent budget holds the work.',
    byDefault: true,
    urgent: false,
  };
  const WITH_BUDGET = [...CATEGORIES, BUDGET];

  it('has a switch of its own, on for a console that never wrote it, marked neither urgent nor off, and writes notify.budget alone', async () => {
    answer({ categories: WITH_BUDGET, schema: { 'notify.budget': { value: true, default: true } } });
    const view = renderWithClient(<RoutingGroup />);
    const box = await screen.findByRole('checkbox', { name: 'Budget spent or running low' });
    await waitFor(() => expect(view.client.getQueryState(keys.prefsSchema())?.status).toBe('success'));
    expect(box).toHaveAttribute('aria-checked', 'true');
    const row = document.querySelector<HTMLElement>('[data-kind="budget"]')!;
    expect(row).toHaveAttribute('data-pref', 'notify.budget');
    expect(within(row).queryByText('Urgent: it breaks through a device’s quiet hours')).toBeNull();
    expect(within(row).queryByText('Off unless you turn it on')).toBeNull();
    // The shipped default says nothing about where it was set.
    expect(within(row).queryByText('Set here')).toBeNull();
    fireEvent.click(box);
    await waitFor(() => expect(sent(server, 'POST', '/api/prefs')).toEqual([{ notify: { budget: false } }]));
  });

  it('silenced, it is counted but raises no stops-dead warning', async () => {
    // The digest is off too — the firehose a person silences first — and neither holds work until you act.
    answer({
      categories: WITH_BUDGET,
      notify: { budget: false, digest: false },
      schema: {
        'notify.budget': { value: false, default: true, source: 'instance' },
        'notify.digest': { value: false, default: false, source: 'instance' },
      },
    });
    renderWithClient(<RoutingGroup />);
    const box = await screen.findByRole('checkbox', { name: 'Budget spent or running low' });
    await waitFor(() => expect(box).toHaveAttribute('aria-checked', 'false'));
    expect(await screen.findByText('4 kinds, 2 off')).toBeInTheDocument();
    expect(screen.queryByTestId('routing-muted')).toBeNull();
  });
});

describe('the reminders of your turns', () => {
  it('draws the series the clock runs, one gap per line', () => {
    answer();
    renderWithClient(<RemindersGroup />);
    const series = screen.getByTestId('reminder-series').querySelectorAll('li');
    expect(series).toHaveLength(REMINDER_SERIES_MS.length);
    expect(series[0]!.textContent).toBe(`after ${gapWords(REMINDER_SERIES_MS[0]!)}`);
    expect(series[series.length - 1]!.textContent).toMatch(/then every day$/);
  });

  // #269: its own client, a fixed clock — nothing outside the case reaches the windows it reads.
  it('holds no quiet hours of its own — it names each device’s window, set under Devices', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T23:45:00Z'));
    answer({
      devices: [
        device('d1', 'iPhone · Safari', { quiet: { start: '23:30', end: '07:00', allowUrgent: true } }),
        device('d2', 'Mac · Chrome'),
        // A device that does not take a person's turn never hears a reminder.
        device('d3', 'iPad', { categories: { 'needs-you': false, digest: false, granted: true } }),
      ],
    });
    renderWithClient(<RemindersGroup />);
    const rows = await screen.findAllByTestId('reminder-device');
    expect(rows.map((row) => row.textContent)).toEqual([
      'iPhone · Safariquiet 23:30 to 07:00',
      'Mac · Chromeno quiet hours',
    ]);
    expect(screen.getByTestId('reminder-quiet')).toHaveTextContent(/the one quiet-hours setting there is/);
    expect(screen.getByTestId('reminder-quiet-rule')).toHaveTextContent(
      'Mac · Chrome keeps no quiet hours, so a reminder goes out when it is due.',
    );
    // No form of its own: nothing to save, and `reminderQuiet` is never written.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(sent(server, 'POST', '/api/prefs')).toEqual([]);
  });

  it('says a reminder waits for the first device to wake when every one is quiet', () => {
    const quiet = { start: '22:00', end: '07:00', allowUrgent: true };
    const both = reminderDevices([device('a', 'phone', { quiet }), device('b', 'tablet', { quiet })]);
    expect(quietSentence(both)).toMatch(/waits for the first to wake — deferred, never dropped/);
    expect(quietSentence([])).toMatch(/nothing to be quiet on/);
  });

  it('is found under Notifications by the words a person would search for', () => {
    const section = SETTINGS_SECTIONS.find((entry) => entry.id === 'notifications');
    expect(section?.blurb).toMatch(/your turns/);
  });
});

describe('the section', () => {
  it('points at the bell first, then draws its groups in the order of the question', async () => {
    answer();
    server.reads['/api/notifications'] = {
      items: [],
      total: 0,
      unread: 0,
      more: false,
      categories: CATEGORIES,
      devices: 0,
      outOfBand: { configured: false },
    };
    renderWithClient(<NotificationsSection />);
    expect(screen.getByTestId('announcements-pointer')).toHaveTextContent('Open the announcements');
    await screen.findByRole('checkbox', { name: 'A phase needs you' });
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'What is announced',
      'Reminders for your turns',
      'This browser',
      'Devices',
      'What has been reaching you',
      'Webhooks',
    ]);
  });
});
