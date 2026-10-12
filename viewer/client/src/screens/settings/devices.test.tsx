/**
 * Settings ▸ Notifications ▸ This browser, Devices and What has been reaching
 * you (quiet-console phase 22; the 6.x Devices card's cases).
 *
 * This browser keeps two lanes apart because they are two features: in this
 * tab is the page's own permission — Allow, On, blocked, unsupported, each
 * said in words — and on this device is a push subscription, turned on and off
 * through the browser's push (`lib/push.ts`, stood in for here: jsdom has no
 * service worker), tested by its own id, and refused with the reason when the
 * browser cannot hold one.
 *
 * Devices lists EVERY subscribed device, this browser first, each with its
 * quiet words, how many kinds it hears, when it was last reached, its failures
 * and its push service; each is tested, narrowed and given quiet hours by its
 * own id, so a phone's window is set from the desk. Quiet hours save as they
 * change — on is the night window, a field saves alone, off is `null` — and
 * hold urgent back only when told to. Every write reads the register back.
 *
 * What has been reaching you reads the last 25 announcements: what went to a
 * device, what reached none, what failed, and what quiet hours held — which is
 * never a failure, and neither is the row that says no device was there.
 *
 * Each case mounts its own query client; the one whose words depend on the
 * clock fixes the clock.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DeliveryRecord,
  InboxPage,
  NotificationCategory,
  NotificationRecord,
  PushDevice,
  PushQuietHours,
  PushState,
} from '@/data/api';
import type { NotifyState } from '@/lib/notify';
import type { PushOutcome } from '@/lib/push';
import { renderWithClient, sent, type FixtureServer } from './test-kit';

const server = vi.hoisted((): FixtureServer => ({ reads: {}, calls: [] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);
/** This browser's half — its push subscription and its page permission, neither of which jsdom has — set per case. */
const browser = vi.hoisted(() => ({
  endpoint: null as string | null,
  blocker: null as string | null,
  ios: false,
  permission: 'default' as NotifyState,
  enable: vi.fn<() => Promise<PushOutcome>>(),
  disable: vi.fn<() => Promise<void>>(),
  askToNotify: vi.fn<() => Promise<NotifyState>>(),
}));
vi.mock('@/lib/push', () => ({
  currentEndpoint: () => Promise.resolve(browser.endpoint),
  blocker: () => browser.blocker,
  describeBrowser: () => 'Mac · Chrome',
  iosNeedsInstall: () => browser.ios,
  enable: browser.enable,
  disable: browser.disable,
}));
vi.mock('@/lib/notify', () => ({ notifyState: () => browser.permission, askToNotify: browser.askToNotify }));
// What a press says lands in a toast; the tray is the shell's, so the call is what is read.
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/ui')>()), toast }));

import { DEFAULT_QUIET_HOURS, DeliveryGroup, DevicesGroup, ThisBrowserGroup, quietWords } from './devices';

/** The kinds around a person's turn — the catalogue the server serves, in its order. */
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
    detail: 'A grant was applied.',
    byDefault: true,
    urgent: false,
  },
];

const GOOGLE = 'https://fcm.googleapis.com';
const APPLE = 'https://web.push.apple.com';
/** This browser's subscription as its push service issued it; the register knows it by its origin alone. */
const MAC_ENDPOINT = `${GOOGLE}/fcm/send/mac-1`;

/** What a test press says when the push service took it — which is not that anybody saw it. */
const HANDED =
  'Handed to the push service. If nothing appeared, it got no further than the system’s notification settings for that browser.';

/** A device as the register serves it — every kind present. */
function device(id: string, label: string, over: Partial<PushDevice> = {}): PushDevice {
  return {
    id,
    label,
    service: GOOGLE,
    categories: { 'needs-you': true, digest: false, granted: true },
    createdAt: '2026-10-08T00:00:00.000Z',
    lastOkAt: null,
    failures: 0,
    ...over,
  };
}

const MAC = device('d-mac', 'Mac · Chrome');
const PHONE = device('d-phone', 'iPhone · Safari', { service: APPLE });

function serve(devices: PushDevice[]) {
  server.reads['/api/push'] = { publicKey: 'k', devices, categories: CATEGORIES } satisfies PushState;
}

/**
 * A register that keeps what is saved, as the server's does: each write
 * answers the device as it now stands, and the read after it reads it back.
 */
function keepSaves(devices: PushDevice[]) {
  let held = devices;
  serve(held);
  const save = (id: string, change: (one: PushDevice) => PushDevice) => {
    held = held.map((one) => (one.id === id ? change(one) : one));
    serve(held);
    return { device: held.find((one) => one.id === id) };
  };
  server.reads['POST /api/push/categories'] = (body: { id: string; categories: Record<string, boolean> }) =>
    save(body.id, (one) => ({ ...one, categories: body.categories }));
  server.reads['POST /api/push/quiet'] = (body: { id: string; quiet: PushQuietHours | null }) =>
    save(body.id, ({ quiet: _cleared, ...one }) => (body.quiet ? { ...one, quiet: body.quiet } : one));
}

/** An answer the case releases when it chooses — a press held in flight. */
function deferred() {
  let release!: (answer: unknown) => void;
  const answer = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  return { answer, release };
}

/** The device rows, top to bottom, by id. */
const order = () =>
  [...document.querySelectorAll('[data-device]')].map((row) => row.getAttribute('data-device'));
const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-device="${id}"]`)!;

/** One announcement and what became of it. */
function record(id: string, delivery: DeliveryRecord[]): NotificationRecord {
  return {
    id,
    at: '2026-10-11T09:00:00.000Z',
    category: 'needs-you',
    title: `Announcement ${id}`,
    body: '',
    url: '',
    urgent: false,
    read: false,
    delivery,
  };
}

const handed = (id: string, label: string, outcome: DeliveryRecord['outcome']): DeliveryRecord => ({
  device: id,
  label,
  outcome,
  at: '2026-10-11T09:00:01.000Z',
});

function announce(items: NotificationRecord[], configured = false) {
  server.reads['/api/notifications'] = {
    items,
    total: items.length,
    unread: 0,
    more: false,
    categories: CATEGORIES,
    devices: 0,
    outOfBand: { configured },
  } satisfies InboxPage;
}

beforeEach(() => {
  server.calls = [];
  server.reads = {};
  browser.endpoint = null;
  browser.blocker = null;
  browser.ios = false;
  browser.permission = 'default';
  browser.enable.mockReset();
  browser.disable.mockReset();
  browser.askToNotify.mockReset();
  toast.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('this browser', () => {
  it.each([
    { permission: 'granted', words: 'On' },
    { permission: 'denied', words: 'Blocked in this browser’s settings' },
    { permission: 'unsupported', words: 'Not supported here' },
  ] as const)(
    'in this tab, a $permission permission reads “$words”, with nothing to press',
    ({ permission, words }) => {
      browser.permission = permission;
      serve([]);
      renderWithClient(<ThisBrowserGroup />);
      const lane = screen.getByTestId('in-tab');
      expect(lane).toHaveTextContent(words);
      expect(within(lane).queryByRole('button')).toBeNull();
      expect(browser.askToNotify).not.toHaveBeenCalled();
    },
  );

  it.each([
    { answer: 'granted', words: 'On' },
    { answer: 'denied', words: 'Blocked in this browser’s settings' },
  ] as const)(
    'in this tab, Allow asks once and a $answer answer reads “$words”',
    async ({ answer, words }) => {
      browser.askToNotify.mockResolvedValue(answer);
      serve([]);
      renderWithClient(<ThisBrowserGroup />);
      // The lane says what it is: the page's own, and only while a tab is open.
      expect(screen.getByText('In this tab')).toBeInTheDocument();
      expect(
        screen.getByText(/while this tab is in the background and this browser has no push subscription/),
      ).toBeInTheDocument();
      const lane = screen.getByTestId('in-tab');
      fireEvent.click(within(lane).getByRole('button', { name: 'Allow' }));
      await waitFor(() => expect(lane).toHaveTextContent(words));
      expect(within(lane).queryByRole('button')).toBeNull();
      expect(browser.askToNotify).toHaveBeenCalledTimes(1);
    },
  );

  it('on this device, waits for the register, then turns a browser with no subscription on through its push', async () => {
    const register = deferred();
    server.reads['/api/push'] = () => register.answer;
    const pressed = deferred();
    browser.enable.mockImplementation(async () => {
      await pressed.answer;
      // What a subscribe leaves behind: the browser holds an endpoint, and the register a row for it.
      browser.endpoint = MAC_ENDPOINT;
      serve([MAC]);
      return { ok: true };
    });
    renderWithClient(<ThisBrowserGroup />);
    expect(screen.getByText('On this device')).toBeInTheDocument();
    expect(screen.getByText(/the case an unattended run exists for\. Mac · Chrome\./)).toBeInTheDocument();
    // Nothing is offered before the register says whether this browser is on it.
    expect(document.querySelector('[aria-label="Reading the devices"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull();

    register.release({ publicKey: 'k', devices: [], categories: CATEGORIES } satisfies PushState);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    expect(await screen.findByRole('button', { name: 'Turning on…' })).toBeDisabled();
    // No narrowing of its own: the device hears what the console announces.
    expect(browser.enable).toHaveBeenCalledWith();

    pressed.release(undefined);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('This device will be notified.', 'ok'));
    // The register is read again, and this browser is on it now.
    expect(await screen.findByRole('button', { name: 'Turn off' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Send a test' })).toBeEnabled();
    expect(sent(server, 'GET', '/api/push')).toHaveLength(2);
  });

  it('says what a refused subscribe said — or, when it said nothing, that nothing was subscribed', async () => {
    serve([]);
    browser.enable
      .mockResolvedValueOnce({ ok: false, detail: 'Permission was not granted.' })
      .mockResolvedValueOnce({ ok: false })
      .mockRejectedValueOnce(new Error('This console has no service worker to subscribe with.'));
    renderWithClient(<ThisBrowserGroup />);
    const press = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Turn on' })).toBeEnabled());
    };

    await press();
    expect(toast).toHaveBeenLastCalledWith('Permission was not granted.', 'error');
    await press();
    expect(toast).toHaveBeenLastCalledWith('This device was not subscribed.', 'error');
    await press();
    expect(toast).toHaveBeenLastCalledWith('This console has no service worker to subscribe with.', 'error');
    expect(browser.enable).toHaveBeenCalledTimes(3);
  });

  it('a subscribed browser sends itself a test by its own id, and says a handover is not an arrival', async () => {
    browser.endpoint = MAC_ENDPOINT;
    serve([PHONE, MAC]);
    server.reads['POST /api/push/test'] = { ok: true, detail: `accepted by ${GOOGLE} (201)` };
    renderWithClient(<ThisBrowserGroup />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send a test' }));
    await waitFor(() => expect(sent(server, 'POST', '/api/push/test')).toEqual([{ id: 'd-mac' }]));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(HANDED, 'ok'));
    // Where a test that was handed over and never shows was stopped — said to a subscribed browser only.
    expect(
      screen.getByText(/almost always stopped by the operating system, not by anything here/),
    ).toBeInTheDocument();
  });

  it('says why a test was not sent: the push service’s answer, or the request’s failure', async () => {
    browser.endpoint = MAC_ENDPOINT;
    serve([MAC]);
    server.reads['POST /api/push/test'] = { ok: false, detail: 'gone 410' };
    renderWithClient(<ThisBrowserGroup />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send a test' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Not sent: gone 410', 'error'));

    server.reads['POST /api/push/test'] = new Error('Request failed (500)');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send a test' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send a test' }));
    await waitFor(() => expect(toast).toHaveBeenLastCalledWith('Request failed (500)', 'error'));
  });

  it('turns this browser off through its push, reads the register again, and offers Turn on', async () => {
    browser.endpoint = MAC_ENDPOINT;
    serve([MAC]);
    browser.disable.mockImplementation(async () => {
      browser.endpoint = null;
      serve([]);
    });
    renderWithClient(<ThisBrowserGroup />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('This device is no longer notified.', 'ok'));
    expect(browser.disable).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Turn on' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Send a test' })).toBeNull();
    expect(screen.queryByText(/almost always stopped by the operating system/)).toBeNull();
    expect(sent(server, 'GET', '/api/push')).toHaveLength(2);
  });

  it('a browser that cannot subscribe says why in a warning, and offers nothing to press', async () => {
    browser.blocker = 'This browser does not support push notifications.';
    serve([]);
    renderWithClient(<ThisBrowserGroup />);
    const banner = screen.getByTestId('push-blocker');
    expect(banner).toHaveTextContent('This browser does not support push notifications.');
    expect(banner).toHaveAttribute('data-severity', 'warn');
    expect(await screen.findByText('Not available here')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull();
    expect(browser.enable).not.toHaveBeenCalled();
  });

  it('on an iPhone outside the Home Screen, the same banner is a hint rather than a warning', async () => {
    browser.blocker = 'On iOS, notifications only work once this is added to the Home Screen.';
    browser.ios = true;
    serve([]);
    renderWithClient(<ThisBrowserGroup />);
    expect(screen.getByTestId('push-blocker')).toHaveAttribute('data-severity', 'info');
    expect(await screen.findByText('Not available here')).toBeInTheDocument();
  });
});

describe('devices', () => {
  it('lists every subscribed device, this browser first, each with its quiet words, kinds, last reach, failures and push service', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
    browser.endpoint = MAC_ENDPOINT;
    serve([
      device('d-phone', 'iPhone · Safari', {
        service: APPLE,
        quiet: { start: '22:00', end: '07:00', allowUrgent: true },
        categories: { 'needs-you': true, digest: false, granted: false },
        lastOkAt: '2026-10-11T09:00:00.000Z',
      }),
      device('d-ipad', 'iPad · Safari', {
        service: APPLE,
        quiet: { start: '23:00', end: '06:30', allowUrgent: false },
        lastOkAt: '2026-10-10T12:00:00.000Z',
        failures: 3,
      }),
      device('d-mac', 'Mac · Chrome', { categories: { 'needs-you': true, digest: true, granted: true } }),
    ]);
    renderWithClient(<DevicesGroup />);
    // The register's order, with this browser lifted to the top once the browser says which it is.
    await waitFor(() => expect(order()).toEqual(['d-mac', 'd-phone', 'd-ipad']));
    expect(screen.getByText('3 devices subscribed')).toBeInTheDocument();

    const mac = rowOf('d-mac');
    expect(within(mac).getByText('This browser')).toBeInTheDocument();
    expect(within(mac).getByText('no quiet hours')).toBeInTheDocument();
    expect(within(mac).getByText('3 kinds')).toBeInTheDocument();
    expect(within(mac).getByText('never reached')).toBeInTheDocument();
    expect(within(mac).queryByText(/in a row/)).toBeNull();
    expect(within(mac).getByText(GOOGLE)).toBeInTheDocument();

    const phone = rowOf('d-phone');
    expect(within(phone).queryByText('This browser')).toBeNull();
    expect(within(phone).getByText('quiet 22:00 to 07:00, urgent still gets through')).toBeInTheDocument();
    expect(within(phone).getByText('1 kind')).toBeInTheDocument();
    expect(phone).toHaveTextContent('last reached 3 hours ago');
    expect(within(phone).getByText(APPLE)).toBeInTheDocument();

    const ipad = rowOf('d-ipad');
    expect(within(ipad).getByText('quiet 23:00 to 06:30')).toBeInTheDocument();
    expect(within(ipad).getByText('2 kinds')).toBeInTheDocument();
    expect(ipad).toHaveTextContent('last reached 1 day ago');
    expect(within(ipad).getByText('3 failures in a row')).toBeInTheDocument();

    // Each its own test, and its own fold.
    for (const id of order()) {
      expect(within(rowOf(id!)).getByRole('button', { name: 'Send a test' })).toBeEnabled();
      expect(within(rowOf(id!)).getByTestId(`device-open-${id}`)).toHaveTextContent(
        'What it hears, and when it is quiet',
      );
    }
  });

  it('with no device subscribed, says every announcement so far stopped at the inbox', async () => {
    serve([]);
    renderWithClient(<DevicesGroup />);
    expect(await screen.findByTestId('no-device')).toHaveTextContent(
      'No device is subscribed, so every announcement so far reached the inbox and stopped there.',
    );
    expect(screen.getByText('0 devices subscribed')).toBeInTheDocument();
    expect(screen.queryByTestId('devices')).toBeNull();
  });

  it('sends a test to any device by its own id, and holds every other press while one is in flight', async () => {
    serve([MAC, PHONE]);
    const held = deferred();
    server.reads['POST /api/push/test'] = () => held.answer;
    renderWithClient(<DevicesGroup />);
    await screen.findByTestId('devices');
    const phone = rowOf('d-phone');
    fireEvent.click(within(phone).getByTestId('device-open-d-phone'));
    fireEvent.click(within(phone).getByRole('button', { name: 'Send a test' }));
    expect(await within(phone).findByRole('button', { name: 'Sending…' })).toBeDisabled();
    // One press at a time: the other device's test, and every control in the open fold, wait with it.
    expect(within(rowOf('d-mac')).getByRole('button', { name: 'Send a test' })).toBeDisabled();
    const boxes = within(phone).getAllByRole('checkbox');
    expect(boxes).toHaveLength(CATEGORIES.length + 1);
    for (const box of boxes) expect(box).toBeDisabled();

    held.release({ ok: true, detail: `accepted by ${APPLE} (201)` });
    await waitFor(() => expect(within(phone).getByRole('button', { name: 'Send a test' })).toBeEnabled());
    expect(sent(server, 'POST', '/api/push/test')).toEqual([{ id: 'd-phone' }]);
    expect(toast).toHaveBeenCalledWith(HANDED, 'ok');
  });

  it('opens what a device hears in its fold, and narrows any device by its own id — this browser or another', async () => {
    browser.endpoint = MAC_ENDPOINT;
    keepSaves([MAC, PHONE]);
    renderWithClient(<DevicesGroup />);
    await waitFor(() => expect(order()).toEqual(['d-mac', 'd-phone']));
    const phone = rowOf('d-phone');
    // Folded, none of it is drawn.
    expect(within(phone).queryByRole('checkbox')).toBeNull();
    fireEvent.click(within(phone).getByTestId('device-open-d-phone'));
    expect(within(phone).getByTestId('device-open-d-phone')).toHaveTextContent('Done');

    const kinds = phone.querySelector<HTMLElement>('[data-device-kinds="d-phone"]')!;
    expect(kinds).toHaveTextContent('This only narrows what the console announces');
    expect(
      within(kinds)
        .getAllByRole('checkbox')
        .map((box) => [box.getAttribute('aria-label'), box.getAttribute('aria-checked')]),
    ).toEqual([
      ['A phase needs you, on iPhone · Safari', 'true'],
      ['Hourly digest, on iPhone · Safari', 'false'],
      ['Permission granted, on iPhone · Safari', 'true'],
    ]);
    expect(within(kinds).getAllByText('Urgent')).toHaveLength(1);

    fireEvent.click(within(kinds).getByRole('checkbox', { name: 'Hourly digest, on iPhone · Safari' }));
    await waitFor(() =>
      expect(sent(server, 'POST', '/api/push/categories')).toEqual([
        { id: 'd-phone', categories: { 'needs-you': true, digest: true, granted: true } },
      ]),
    );
    // Read back: the box and the count follow the register.
    expect(await within(phone).findByText('3 kinds')).toBeInTheDocument();
    expect(
      within(kinds).getByRole('checkbox', { name: 'Hourly digest, on iPhone · Safari' }),
    ).toHaveAttribute('aria-checked', 'true');

    // This browser's own row, the same way.
    const mac = rowOf('d-mac');
    fireEvent.click(within(mac).getByTestId('device-open-d-mac'));
    fireEvent.click(within(mac).getByRole('checkbox', { name: 'A phase needs you, on Mac · Chrome' }));
    await waitFor(() => expect(sent(server, 'POST', '/api/push/categories')).toHaveLength(2));
    expect(sent(server, 'POST', '/api/push/categories')[1]).toEqual({
      id: 'd-mac',
      categories: { 'needs-you': false, digest: false, granted: true },
    });
    expect(await within(mac).findByText('1 kind')).toBeInTheDocument();
  });

  it('switches quiet hours on for any device with the night window, urgent still let through', async () => {
    browser.endpoint = MAC_ENDPOINT;
    keepSaves([MAC, PHONE]);
    renderWithClient(<DevicesGroup />);
    await waitFor(() => expect(order()).toEqual(['d-mac', 'd-phone']));
    const phone = rowOf('d-phone');
    expect(within(phone).getByText('no quiet hours')).toBeInTheDocument();
    fireEvent.click(within(phone).getByTestId('device-open-d-phone'));
    const box = within(phone).getByRole('checkbox', { name: 'Quiet hours on iPhone · Safari' });
    expect(box).toHaveAttribute('aria-checked', 'false');
    expect(within(phone).queryByLabelText('Quiet from, on iPhone · Safari')).toBeNull();

    fireEvent.click(box);
    await waitFor(() =>
      expect(sent(server, 'POST', '/api/push/quiet')).toEqual([
        { id: 'd-phone', quiet: { start: '22:00', end: '08:00', allowUrgent: true } },
      ]),
    );
    // Read back: the row says the window, and the editor opens on it.
    expect(
      await within(phone).findByText('quiet 22:00 to 08:00, urgent still gets through'),
    ).toBeInTheDocument();
    expect(within(phone).getByLabelText('Quiet from, on iPhone · Safari')).toHaveValue('22:00');
    expect(within(phone).getByLabelText('Quiet until, on iPhone · Safari')).toHaveValue('08:00');
    expect(
      within(phone).getByRole('checkbox', { name: 'Urgent still gets through, on iPhone · Safari' }),
    ).toHaveAttribute('aria-checked', 'true');
    // Set from the desk: this browser's own window was never touched.
    expect(within(rowOf('d-mac')).getByText('no quiet hours')).toBeInTheDocument();
  });

  it('saves each field of a set window on its own, holds urgent back when told, and clears the window with null', async () => {
    keepSaves([
      device('d-phone', 'iPhone · Safari', {
        service: APPLE,
        quiet: { start: '22:00', end: '07:00', allowUrgent: true },
      }),
    ]);
    renderWithClient(<DevicesGroup />);
    await screen.findByTestId('devices');
    const phone = rowOf('d-phone');
    fireEvent.click(within(phone).getByTestId('device-open-d-phone'));
    expect(within(phone).getByRole('checkbox', { name: 'Quiet hours on iPhone · Safari' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const field = (name: string) => within(phone).getByLabelText(`${name}, on iPhone · Safari`);

    // A field cleared mid-edit is not a time: nothing is saved, and the field is left as it is.
    fireEvent.change(field('Quiet until'), { target: { value: '' } });
    expect(sent(server, 'POST', '/api/push/quiet')).toEqual([]);
    expect(field('Quiet until')).toHaveValue('');

    fireEvent.change(field('Quiet until'), { target: { value: '07:30' } });
    expect(
      await within(phone).findByText('quiet 22:00 to 07:30, urgent still gets through'),
    ).toBeInTheDocument();
    fireEvent.change(field('Quiet from'), { target: { value: '23:15' } });
    expect(
      await within(phone).findByText('quiet 23:15 to 07:30, urgent still gets through'),
    ).toBeInTheDocument();
    fireEvent.click(
      within(phone).getByRole('checkbox', { name: 'Urgent still gets through, on iPhone · Safari' }),
    );
    expect(await within(phone).findByText('quiet 23:15 to 07:30')).toBeInTheDocument();
    fireEvent.click(within(phone).getByRole('checkbox', { name: 'Quiet hours on iPhone · Safari' }));
    expect(await within(phone).findByText('no quiet hours')).toBeInTheDocument();
    expect(within(phone).queryByLabelText('Quiet from, on iPhone · Safari')).toBeNull();

    expect(sent(server, 'POST', '/api/push/quiet')).toEqual([
      { id: 'd-phone', quiet: { start: '22:00', end: '07:30', allowUrgent: true } },
      { id: 'd-phone', quiet: { start: '23:15', end: '07:30', allowUrgent: true } },
      { id: 'd-phone', quiet: { start: '23:15', end: '07:30', allowUrgent: false } },
      { id: 'd-phone', quiet: null },
    ]);
  });

  it('says a refused save in its own words, reads the register again, and shows nothing as saved', async () => {
    serve([PHONE]);
    server.reads['POST /api/push/quiet'] = new Error('no such device');
    renderWithClient(<DevicesGroup />);
    await screen.findByTestId('devices');
    fireEvent.click(screen.getByTestId('device-open-d-phone'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Quiet hours on iPhone · Safari' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('no such device', 'error'));
    await waitFor(() => expect(sent(server, 'GET', '/api/push')).toHaveLength(2));
    expect(within(rowOf('d-phone')).getByText('no quiet hours')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Quiet hours on iPhone · Safari' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('words a window, or that a device keeps none', () => {
    expect(quietWords(null)).toBe('no quiet hours');
    expect(quietWords(undefined)).toBe('no quiet hours');
    expect(quietWords({ start: '22:00', end: '07:00', allowUrgent: true })).toBe(
      'quiet 22:00 to 07:00, urgent still gets through',
    );
    expect(quietWords({ start: '23:00', end: '06:30', allowUrgent: false })).toBe('quiet 23:00 to 06:30');
  });

  it('opens quiet hours on the night, urgent let through, from a default no edit can change', () => {
    expect(DEFAULT_QUIET_HOURS).toEqual({ start: '22:00', end: '08:00', allowUrgent: true });
    expect(Object.isFrozen(DEFAULT_QUIET_HOURS)).toBe(true);
  });
});

describe('what has been reaching you', () => {
  it('reads the last 25 announcements, and says how many went to a device and how many reached none', async () => {
    announce([
      record('n1', [handed('d-mac', 'Mac · Chrome', 'sent')]),
      record('n2', [handed('d-mac', 'Mac · Chrome', 'sent'), handed('d-phone', 'iPhone · Safari', 'failed')]),
      record('n3', []),
    ]);
    renderWithClient(<DeliveryGroup />);
    const delivery = await screen.findByTestId('delivery');
    expect(server.calls.map((call) => call.path)).toEqual(['/api/notifications?limit=25']);
    expect(delivery).toHaveTextContent(
      'Of the last 3 announcements, 2 went to a device and 1 reached no device at all — those exist only in the inbox.',
    );
    expect(screen.getByTestId('delivery-failures')).toHaveTextContent(
      '1 handover did not succeed: iPhone · Safari, failed.',
    );
    expect(screen.queryByText(/held by quiet hours/)).toBeNull();
  });

  it('counts a held push as quiet hours, never as a failed handover, and names each failure once', async () => {
    announce([
      record('n1', [
        handed('d-mac', 'Mac · Chrome', 'quiet'),
        handed('d-phone', 'iPhone · Safari', 'failed'),
      ]),
      record('n2', [handed('d-mac', 'Mac · Chrome', 'quiet')]),
      record('n3', [handed('d-phone', 'iPhone · Safari', 'failed'), handed('d-old', 'Old laptop', 'gone')]),
    ]);
    renderWithClient(<DeliveryGroup />);
    expect(await screen.findByTestId('delivery')).toHaveTextContent(
      'Of the last 3 announcements, 3 went to a device.',
    );
    expect(screen.getByText('2 handovers held by quiet hours.')).toBeInTheDocument();
    const failures = screen.getByTestId('delivery-failures');
    expect(failures).toHaveTextContent(
      '3 handovers did not succeed: iPhone · Safari, failed; Old laptop, gone.',
    );
    expect(failures).not.toHaveTextContent(/quiet/);
  });

  it('never reads the row that says no device was there as a device reached, nor as a failed handover', async () => {
    announce([
      record('n1', [
        {
          device: '',
          label: 'no device',
          outcome: 'no-device',
          at: '',
          detail: 'no device is subscribed to this console',
        },
      ]),
      record('n2', [
        {
          device: '',
          label: 'no device takes this category',
          outcome: 'no-device',
          at: '',
          detail: '1 device subscribed, none to digest',
        },
      ]),
      record('n3', [
        {
          device: 'console',
          label: 'this console',
          outcome: 'skipped',
          at: '',
          detail: 'process exiting — no device or webhook to deliver to',
        },
      ]),
      record('n4', [handed('d-mac', 'Mac · Chrome', 'sent')]),
    ]);
    renderWithClient(<DeliveryGroup />);
    expect(await screen.findByTestId('delivery')).toHaveTextContent(
      'Of the last 4 announcements, 1 went to a device and 3 reached no device at all — those exist only in the inbox.',
    );
    expect(screen.queryByTestId('delivery-failures')).toBeNull();
  });

  it('says so when nothing has been announced yet', async () => {
    announce([]);
    renderWithClient(<DeliveryGroup />);
    const delivery = await screen.findByTestId('delivery');
    expect(delivery).toHaveTextContent('Nothing has been announced yet.');
    expect(screen.queryByTestId('delivery-failures')).toBeNull();
  });

  it('says whether the notify command is set for this process', async () => {
    announce([], false);
    const unset = renderWithClient(<DeliveryGroup />);
    const line = await screen.findByTestId('notify-command');
    expect(line).toHaveTextContent(
      'For a machine with no browser at all, PHASE_CONSOLE_NOTIFY=<command> is run with the title and body of every announcement.',
    );
    expect(line).toHaveTextContent('It is not set for this process.');
    unset.unmount();

    announce([], true);
    renderWithClient(<DeliveryGroup />);
    const set = await screen.findByTestId('notify-command');
    expect(set).toHaveTextContent('It is set for this process.');
    expect(set).not.toHaveTextContent(/launchd/);
  });
});
