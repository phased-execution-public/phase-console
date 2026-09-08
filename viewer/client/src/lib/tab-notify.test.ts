/**
 * The "in this tab" leg (parallel-repaint P2, register N2).
 *
 * The leg was promised and dead: permission asked for, displayed, and never
 * used. What is pinned is the decision — the three gates and the freshness
 * rule — with every dependency injected, and the card itself against a fake
 * `Notification` (jsdom has none): title, body, the id as the collapsing tag,
 * silent unless urgent, and a click that focuses and navigates.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { onSse } = vi.hoisted(() => ({ onSse: vi.fn() }));
vi.mock('./sse', () => ({ onSse }));
vi.mock('./push', () => ({ currentEndpoint: vi.fn(async () => null) }));
vi.mock('./notify', () => ({ notifyState: vi.fn(() => 'granted') }));

import {
  TAB_NOTIFY_FRESH_MS,
  armTabNotifications,
  considerTabNotification,
  isFreshAnnouncement,
  raiseTabNotification,
  type TabNotifyDeps,
} from './tab-notify';

const NOW = Date.parse('2026-09-01T10:00:00Z');

function record(over: Record<string, unknown> = {}) {
  return {
    id: 'n-1',
    at: new Date(NOW - 5_000).toISOString(),
    category: 'halted',
    title: 'demo halted',
    body: 'verification red',
    url: '/#/plan/demo/run',
    urgent: true,
    read: false,
    delivery: [],
    ...over,
  };
}

function deps(over: Partial<TabNotifyDeps> = {}): TabNotifyDeps & { raised: unknown[] } {
  const raised: unknown[] = [];
  return {
    permission: () => 'granted',
    hidden: () => true,
    subscribed: async () => false,
    raise: (r) => {
      raised.push(r);
    },
    now: () => NOW,
    raised,
    ...over,
  };
}

describe('isFreshAnnouncement', () => {
  it('accepts an unread, unresolved record younger than a minute', () => {
    expect(isFreshAnnouncement(record(), NOW)).toBe(true);
  });
  it('refuses annotation re-emissions: read or resolved', () => {
    expect(isFreshAnnouncement(record({ read: true }), NOW)).toBe(false);
    expect(isFreshAnnouncement(record({ resolved: { at: '', reason: 'x' } }), NOW)).toBe(false);
  });
  it('refuses a replay older than the freshness window', () => {
    expect(
      isFreshAnnouncement(record({ at: new Date(NOW - TAB_NOTIFY_FRESH_MS - 1).toISOString() }), NOW),
    ).toBe(false);
  });
  it('refuses garbage', () => {
    expect(isFreshAnnouncement(null, NOW)).toBe(false);
    expect(isFreshAnnouncement({ id: 'x' }, NOW)).toBe(false);
    expect(isFreshAnnouncement(record({ at: 'never' }), NOW)).toBe(false);
  });
});

describe('considerTabNotification', () => {
  it('raises for a hidden, unsubscribed, granted tab', async () => {
    const d = deps();
    expect(await considerTabNotification(record(), d)).toBe(true);
    expect(d.raised).toHaveLength(1);
  });
  it('never raises without permission', async () => {
    const d = deps({ permission: () => 'default' });
    expect(await considerTabNotification(record(), d)).toBe(false);
    expect(d.raised).toHaveLength(0);
  });
  it('never raises over a visible tab — the bell already shows it', async () => {
    const d = deps({ hidden: () => false });
    expect(await considerTabNotification(record(), d)).toBe(false);
  });
  it('never raises in a push-subscribed browser — the service worker shows that card', async () => {
    const d = deps({ subscribed: async () => true });
    expect(await considerTabNotification(record(), d)).toBe(false);
  });
  it('never raises for an annotation or a replay', async () => {
    const d = deps();
    expect(await considerTabNotification(record({ read: true }), d)).toBe(false);
    expect(await considerTabNotification(record({ at: new Date(NOW - 120_000).toISOString() }), d)).toBe(
      false,
    );
    expect(d.raised).toHaveLength(0);
  });
  it('asks the cheap gates before the service worker', async () => {
    const subscribed = vi.fn(async () => false);
    await considerTabNotification(record(), deps({ hidden: () => false, subscribed }));
    expect(subscribed).not.toHaveBeenCalled();
  });
});

describe('raiseTabNotification', () => {
  const made: {
    title: string;
    options: NotificationOptions;
    onclick: (() => void) | null;
    closed: boolean;
  }[] = [];
  class FakeNotification {
    onclick: (() => void) | null = null;
    closed = false;
    constructor(
      public title: string,
      public options: NotificationOptions,
    ) {
      made.push(this as never);
    }
    close() {
      this.closed = true;
    }
  }
  beforeEach(() => {
    made.length = 0;
    vi.stubGlobal('Notification', FakeNotification);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the card from the record: id as tag, silent unless urgent', () => {
    raiseTabNotification(record() as never);
    raiseTabNotification(record({ id: 'n-2', urgent: false }) as never);
    expect(made).toHaveLength(2);
    expect(made[0].title).toBe('demo halted');
    expect(made[0].options).toMatchObject({ body: 'verification red', tag: 'n-1', silent: false });
    expect(made[1].options).toMatchObject({ tag: 'n-2', silent: true });
  });

  it('a click focuses the window, navigates to the record, and closes the card', () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    raiseTabNotification(record() as never);
    made[0].onclick?.();
    expect(focus).toHaveBeenCalled();
    expect(window.location.hash).toBe('#/plan/demo/run');
    expect(made[0].closed).toBe(true);
  });

  it('returns null where the page cannot raise one, rather than throwing into the stream', () => {
    vi.stubGlobal(
      'Notification',
      class {
        constructor() {
          throw new TypeError(
            'Illegal constructor. Use ServiceWorkerRegistration.showNotification() instead.',
          );
        }
      },
    );
    expect(raiseTabNotification(record() as never)).toBeNull();
  });
});

describe('armTabNotifications', () => {
  beforeEach(() => {
    onSse.mockReset();
    onSse.mockImplementation(() => () => {});
  });

  it('subscribes the notification event once and is idempotent until disarmed', () => {
    const disarm = armTabNotifications(deps());
    expect(onSse).toHaveBeenCalledTimes(1);
    expect(onSse.mock.calls[0]?.[0]).toBe('notification');
    expect(armTabNotifications(deps())).toBe(disarm);
    expect(onSse).toHaveBeenCalledTimes(1);
    disarm();
    const again = armTabNotifications(deps());
    expect(onSse).toHaveBeenCalledTimes(2);
    // Module state is shared across cases: leave it disarmed.
    again();
  });

  it('routes the event through the decision', async () => {
    const d = deps();
    const disarm = armTabNotifications(d);
    const listener = onSse.mock.calls[0]?.[1] as (data: unknown) => void;
    listener(record());
    await vi.waitFor(() => expect(d.raised).toHaveLength(1));
    disarm();
  });
});
