/**
 * How an announcement leaves this process for a person's devices (7.0,
 * quiet-console phase 22; the Devices card of 6.x).
 *
 * ```
 * This browser
 * In this tab                                     On
 * On this device                [Send a test] [Turn off]
 *
 * Devices
 * iPhone · Safari   This browser   quiet 22:00 to 08:00   12 kinds   last reached 3 h ago   [Send a test]
 *   What it hears, and when it is quiet  ▸
 * ```
 *
 * Two lanes, and the reason someone opens this: **in this tab** is the
 * Notification API — free, instant, gone with the tab, raised by the shell for
 * a hidden tab in a browser with no subscription (`lib/tab-notify.ts`); **on
 * this device** is a push subscription, which arrives with nothing open. Being
 * told about a halted run at 3 a.m. and being told when you next look are not
 * the same feature, and only the second needs a service worker and a key.
 *
 * Then every subscribed device, this browser first, each with what it hears
 * (a narrowing of what the console announces, never a widening) and its quiet
 * hours — the one quiet-hours setting there is: inside the window nothing is
 * pushed THERE, while the inbox, an open tab and the notify command still hear
 * everything, and each held push is written to the delivery ledger as `quiet`.
 * Every device is edited by its id, so a phone's window is set from the desk.
 *
 * ⚠ The subscriptions are bound to `/sw.js` and scope `/` (`lib/push.ts`):
 * moving the worker unsubscribes every device with nothing to say it happened.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  api,
  type DeliveryRecord,
  type NotificationCategory,
  type NotificationRecord,
  type PushDevice,
  type PushQuietHours,
} from '@/data/api';
import { useInbox, usePush } from '@/data/inbox';
import { keys } from '@/data/keys';
import { plural } from '@/lib/format';
import { askToNotify, notifyState, type NotifyState } from '@/lib/notify';
import { blocker, describeBrowser, disable, enable, iosNeedsInstall } from '@/lib/push';
import { Banner, Button, Input, Mono, RelativeTime, Skeleton, toast } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { Disclosure } from '@/ui/disclosure';
import { useThisDevice } from './routing';
import { SettingRow, SettingsGroup, failureWords } from './setting';

/** The window quiet hours open with — the night — edited from there. */
export const DEFAULT_QUIET_HOURS: PushQuietHours = Object.freeze({
  start: '22:00',
  end: '08:00',
  allowUrgent: true,
});

const isClockTime = (value: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

/** A device's quiet window in words — or that it keeps none. */
export function quietWords(quiet: PushQuietHours | null | undefined): string {
  if (!quiet) return 'no quiet hours';
  return `quiet ${quiet.start} to ${quiet.end}${quiet.allowUrgent ? ', urgent still gets through' : ''}`;
}

/** The presses this group makes, each re-reading the register when it lands. */
function usePushPresses() {
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const reread = () => client.invalidateQueries({ queryKey: keys.push() });
  const run = async <T,>(which: string, call: () => Promise<T>, after?: (result: T) => void) => {
    setBusy(which);
    try {
      const result = await call();
      after?.(result);
    } catch (error) {
      toast(failureWords(error), 'error');
    } finally {
      setBusy(null);
      void reread();
    }
  };
  return {
    busy,
    subscribe: () =>
      run(
        'subscribe',
        () => enable(),
        (result) =>
          toast(
            result.ok
              ? 'This device will be notified.'
              : (result.detail ?? 'This device was not subscribed.'),
            result.ok ? 'ok' : 'error',
          ),
      ),
    unsubscribe: () =>
      run(
        'unsubscribe',
        () => disable(),
        () => toast('This device is no longer notified.', 'ok'),
      ),
    // "Handed to the push service" is the truth and is not "you saw it": the
    // service, the browser and the system are three yeses, and only the first
    // answers back — saying just "sent" makes a muted system look like a broken console.
    test: (id: string) =>
      run(
        `test:${id}`,
        () => api.pushTest(id),
        (result) =>
          toast(
            result.ok
              ? 'Handed to the push service. If nothing appeared, it got no further than the system’s notification settings for that browser.'
              : `Not sent: ${result.detail}`,
            result.ok ? 'ok' : 'error',
          ),
      ),
    kinds: (id: string, next: Record<string, boolean>) =>
      run(`kinds:${id}`, () => api.pushCategories(id, next)),
    quiet: (id: string, next: PushQuietHours | null) => run(`quiet:${id}`, () => api.pushQuiet(id, next)),
  };
}

type Presses = ReturnType<typeof usePushPresses>;

/* ---------------- this browser ---------------- */

export function ThisBrowserGroup() {
  const { data: push, isPending } = usePush();
  const mine = useThisDevice(push?.devices);
  const presses = usePushPresses();
  const [inTab, setInTab] = useState<NotifyState>(() => notifyState());
  const why = blocker();
  const subscribed = mine !== null;

  return (
    <SettingsGroup id="this-browser" title="This browser">
      <SettingRow
        label="In this tab"
        hint="Raised by the page while this tab is in the background and this browser has no push subscription. It needs no setup, and lasts only while a tab is open."
      >
        <span className="flex min-w-0 items-center gap-2" data-testid="in-tab">
          {inTab === 'granted' ? (
            <span className="text-body font-medium text-ink">On</span>
          ) : inTab === 'denied' ? (
            <span className="text-meta text-ink-muted">Blocked in this browser’s settings</span>
          ) : inTab === 'unsupported' ? (
            <span className="text-meta text-ink-muted">Not supported here</span>
          ) : (
            <Button size="sm" onClick={() => void askToNotify().then(setInTab)}>
              Allow
            </Button>
          )}
        </span>
      </SettingRow>
      <SettingRow
        label="On this device"
        hint={`Delivered through a push service, so it arrives with the console closed — the case an unattended run exists for. ${describeBrowser()}.`}
      >
        {isPending && !push ? (
          <Skeleton className="h-8 w-40" aria-busy="true" aria-label="Reading the devices" />
        ) : subscribed ? (
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <Button size="sm" disabled={presses.busy !== null} onClick={() => void presses.test(mine.id)}>
              {presses.busy === `test:${mine.id}` ? 'Sending…' : 'Send a test'}
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={presses.busy !== null}
              onClick={() => void presses.unsubscribe()}
            >
              Turn off
            </Button>
          </span>
        ) : why ? (
          <span className="text-meta text-ink-muted">Not available here</span>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={presses.busy !== null}
            onClick={() => void presses.subscribe()}
          >
            {presses.busy === 'subscribe' ? 'Turning on…' : 'Turn on'}
          </Button>
        )}
      </SettingRow>
      {why && (
        <Banner severity={iosNeedsInstall() ? 'info' : 'warn'} data-testid="push-blocker">
          {why}
        </Banner>
      )}
      {subscribed && (
        <p className="max-w-(--measure) text-meta text-ink-muted">
          A test that was handed over and never appears was almost always stopped by the operating system, not
          by anything here — macOS System Settings, Notifications, then this browser; or Windows Settings,
          System, Notifications. A Focus or Do Not Disturb mode does the same thing silently.
        </p>
      )}
    </SettingsGroup>
  );
}

/* ---------------- every device ---------------- */

/**
 * Inside the window nothing is pushed to the device; the inbox, an open tab and
 * the notify command still hear everything. Each change saves as it is made —
 * there is no draft to lose — and the time fields are keyed on the saved
 * window, so a value mid-edit is never snapped back by a re-read.
 */
export function QuietHoursEditor({
  label,
  quiet,
  busy,
  onChange,
}: {
  /** The device's name, for the controls' accessible names. */
  label: string;
  quiet: PushQuietHours | null;
  busy: boolean;
  onChange: (next: PushQuietHours | null) => void;
}) {
  const on = quiet !== null;
  const set = (patch: Partial<PushQuietHours>) => onChange({ ...(quiet ?? DEFAULT_QUIET_HOURS), ...patch });
  return (
    <div className="flex min-w-0 flex-col gap-2" data-quiet-editor>
      <label className="flex min-w-0 items-start gap-2.5 text-body [@media(hover:none)]:min-h-(--tap-min)">
        <Checkbox
          className="mt-0.5"
          checked={on}
          disabled={busy}
          aria-label={`Quiet hours on ${label}`}
          onCheckedChange={(next) => onChange(next === true ? DEFAULT_QUIET_HOURS : null)}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-ink">Quiet hours</span>
          <span className="max-w-(--measure) text-meta text-ink-muted">
            Inside the window nothing is pushed here; the inbox still gets every announcement, and each held
            push is written to the delivery ledger as quiet. Times are on the console’s own clock.
          </span>
        </span>
      </label>
      {on && (
        <div
          className="flex min-w-0 flex-wrap items-end gap-3 ps-[1.625rem]"
          key={`${quiet.start}-${quiet.end}`}
        >
          <label className="flex flex-col gap-1 text-meta text-ink-muted">
            From
            <Input
              type="time"
              aria-label={`Quiet from, on ${label}`}
              defaultValue={quiet.start}
              disabled={busy}
              className="w-32"
              onChange={(event) => {
                if (isClockTime(event.target.value)) set({ start: event.target.value });
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-meta text-ink-muted">
            Until
            <Input
              type="time"
              aria-label={`Quiet until, on ${label}`}
              defaultValue={quiet.end}
              disabled={busy}
              className="w-32"
              onChange={(event) => {
                if (isClockTime(event.target.value)) set({ end: event.target.value });
              }}
            />
          </label>
          <label className="flex items-center gap-2 pb-2 text-meta text-ink-muted [@media(hover:none)]:min-h-(--tap-min) [@media(hover:none)]:pb-0">
            <Checkbox
              checked={quiet.allowUrgent}
              disabled={busy}
              aria-label={`Urgent still gets through, on ${label}`}
              onCheckedChange={(next) => set({ allowUrgent: next === true })}
            />
            Urgent still gets through
          </label>
        </div>
      )}
    </div>
  );
}

/** What one device hears: a narrowing of what the console announces, never a widening. */
function DeviceKinds({
  device,
  categories,
  busy,
  onChange,
}: {
  device: PushDevice;
  categories: readonly NotificationCategory[];
  busy: boolean;
  onChange: (next: Record<string, boolean>) => void;
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-2" data-device-kinds={device.id}>
      <legend className="mb-1 max-w-(--measure) text-meta text-ink-muted">
        What it hears. This only narrows what the console announces — a kind switched off above never reaches
        any device, whatever is ticked here.
      </legend>
      {categories.map((category) => (
        <label
          key={category.id}
          className="flex min-w-0 items-start gap-2.5 text-body [@media(hover:none)]:min-h-(--tap-min)"
        >
          <Checkbox
            className="mt-0.5"
            checked={device.categories?.[category.id] === true}
            disabled={busy}
            aria-label={`${category.label}, on ${device.label}`}
            onCheckedChange={(next) => onChange({ ...device.categories, [category.id]: next === true })}
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="min-w-0 break-words text-ink">{category.label}</span>
            {category.urgent && <span className="text-meta text-ink-muted">Urgent</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function DeviceRow({
  device,
  mine,
  categories,
  presses,
}: {
  device: PushDevice;
  mine: boolean;
  categories: readonly NotificationCategory[];
  presses: Presses;
}) {
  const kinds = Object.values(device.categories ?? {}).filter(Boolean).length;
  const busy = presses.busy !== null;
  return (
    <li
      data-device={device.id}
      className="flex min-w-0 flex-col gap-2 border-t border-rule pt-3 first:border-t-0 first:pt-0"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
            <span className="min-w-0 break-words text-body font-medium text-ink">{device.label}</span>
            {mine && <span className="text-meta text-ink-muted">This browser</span>}
          </span>
          <span className="flex min-w-0 flex-wrap gap-x-3 text-meta text-ink-muted">
            <span>{quietWords(device.quiet)}</span>
            <span>{plural(kinds, 'kind')}</span>
            <span>
              {device.lastOkAt ? (
                <>
                  last reached <RelativeTime at={device.lastOkAt} live={false} />
                </>
              ) : (
                'never reached'
              )}
            </span>
            {device.failures > 0 && <span>{plural(device.failures, 'failure')} in a row</span>}
          </span>
          <Mono value={device.service} className="min-w-0 wrap-anywhere" />
        </div>
        <Button size="sm" disabled={busy} onClick={() => void presses.test(device.id)}>
          {presses.busy === `test:${device.id}` ? 'Sending…' : 'Send a test'}
        </Button>
      </div>
      <Disclosure
        label="What it hears, and when it is quiet"
        openLabel="Done"
        testId={`device-open-${device.id}`}
      >
        <div className="flex min-w-0 flex-col gap-4 pt-2">
          {categories.length > 0 && (
            <DeviceKinds
              device={device}
              categories={categories}
              busy={busy}
              onChange={(next) => void presses.kinds(device.id, next)}
            />
          )}
          <QuietHoursEditor
            label={device.label}
            quiet={device.quiet ?? null}
            busy={busy}
            onChange={(next) => void presses.quiet(device.id, next)}
          />
        </div>
      </Disclosure>
    </li>
  );
}

export function DevicesGroup() {
  const { data: push, isPending } = usePush();
  const mine = useThisDevice(push?.devices);
  const presses = usePushPresses();
  const devices = push?.devices ?? [];
  // This browser first: it is the one a person can also turn off from here.
  const ordered = mine ? [mine, ...devices.filter((device) => device.id !== mine.id)] : devices;

  return (
    <SettingsGroup
      id="devices"
      title="Devices"
      aside={
        push ? (
          <span className="text-meta text-ink-muted">{plural(devices.length, 'device')} subscribed</span>
        ) : undefined
      }
    >
      {isPending && !push ? (
        <Skeleton className="h-16" aria-busy="true" aria-label="Reading the devices" />
      ) : devices.length === 0 ? (
        <p className="max-w-(--measure) text-body text-ink-muted" data-testid="no-device">
          No device is subscribed, so every announcement so far reached the inbox and stopped there. Turn this
          browser on above — one permission prompt, and it hears the console while it is closed.
        </p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-3" data-testid="devices">
          {ordered.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              mine={device.id === mine?.id}
              categories={push?.categories ?? []}
              presses={presses}
            />
          ))}
        </ul>
      )}
    </SettingsGroup>
  );
}

/* ---------------- what has been reaching you ---------------- */

/**
 * The rows that went to a device. Two ledger rows name none: `no-device` (no
 * device was there to take it) and `skipped` (the console exited before any
 * report landed). Each stands where the ledger would otherwise be empty
 * (`shared/ops-vocab.js`). So an announcement that carries only those reached
 * no device, as its empty ledger said before the rows existed, and neither row
 * is a handover that failed.
 */
const handovers = (item: NotificationRecord): DeliveryRecord[] =>
  (item.delivery ?? []).filter((one) => one.outcome !== 'no-device' && one.outcome !== 'skipped');

/**
 * What became of the last announcements. The register answers "is a device
 * subscribed", which is not the question: a subscription can be live, take
 * every kind and still deliver nothing — a refusing push service, an endpoint
 * long dead, a system dropping it. `announce()` is never awaited, so none of
 * that could stall a run, and none of it was visible. Here it is.
 */
export function DeliveryGroup() {
  const { data: reach } = useInbox({ limit: 25 });
  const items = reach?.items ?? [];
  const attempted = items.map(handovers).filter((rows) => rows.length);
  const reachedNone = items.length - attempted.length;
  // `quiet` is a device inside its own window — held on purpose, neither a delivery nor a failure.
  const failures = attempted.flatMap((rows) =>
    rows.filter((one) => one.outcome !== 'sent' && one.outcome !== 'quiet'),
  );
  const held = attempted.flatMap((rows) => rows.filter((one) => one.outcome === 'quiet')).length;

  return (
    <SettingsGroup id="delivery" title="What has been reaching you">
      {!reach ? (
        <Skeleton className="h-10" aria-busy="true" aria-label="Reading the announcements" />
      ) : (
        <div className="flex min-w-0 flex-col gap-1.5 text-body" data-testid="delivery">
          {items.length === 0 ? (
            <p className="text-ink-muted">Nothing has been announced yet.</p>
          ) : (
            <p className="max-w-(--measure) text-ink">
              Of the last {plural(items.length, 'announcement')}, {attempted.length} went to a device
              {reachedNone
                ? ` and ${reachedNone} reached no device at all — those exist only in the inbox`
                : ''}
              .
            </p>
          )}
          {failures.length > 0 && (
            <p className="max-w-(--measure) text-meta text-ink" data-testid="delivery-failures">
              {plural(failures.length, 'handover')} did not succeed:{' '}
              {[...new Set(failures.map((one) => `${one.label}, ${one.outcome}`))].join('; ')}.
            </p>
          )}
          {held > 0 && (
            <p className="text-meta text-ink-muted">{plural(held, 'handover')} held by quiet hours.</p>
          )}
          <p className="max-w-(--measure) text-meta text-ink-muted" data-testid="notify-command">
            For a machine with no browser at all, <Mono value="PHASE_CONSOLE_NOTIFY=<command>" /> is run with
            the title and body of every announcement.{' '}
            {reach.outOfBand?.configured ? (
              'It is set for this process.'
            ) : (
              <>
                It is not set for this process.
              </>
            )}
          </p>
        </div>
      )}
    </SettingsGroup>
  );
}
