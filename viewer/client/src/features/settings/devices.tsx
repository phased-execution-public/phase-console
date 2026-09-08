/**
 * The delivery plumbing: how a notification gets out of this process.
 *
 * The distinction this card is built around is the whole reason someone opens
 * it:
 *
 *   **in this tab** — the Notification API. Free, instant, and gone with the tab.
 *     Raised by the shell off the server's `notification` event
 *     (`lib/tab-notify.ts`) for a hidden tab in a browser with no push
 *     subscription — this card only asks for the permission.
 *   **on this device** — a push subscription, which arrives with nothing open.
 *     With, since parallel-repaint P2, its own delivery quiet hours.
 *
 * Being told about a halted run at 3am and being told about it when you next
 * look at the console are not the same feature, and only one of them needs a
 * service worker and a signing key.
 *
 * ⚠️ Phase 7 owns the service worker's *contents* (vite-plugin-pwa). It must
 * keep `/sw.js` at the same URL and scope: the subscriptions this card creates
 * are bound to them, and moving the file silently unsubscribes every device
 * with nothing to announce that it happened. See `lib/push.ts`.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { keys, toastError, useInbox, usePush } from '@/lib/queries';
import { api, type PushDevice, type PushQuietHours } from '@/lib/api';
import { askToNotify, notifyState, type NotifyState } from '@/lib/notify';
import { blocker, currentEndpoint, describeBrowser, disable, enable, iosNeedsInstall } from '@/lib/push';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  CardSkeleton,
  Checkbox,
  Chip,
  Input,
  RelativeTime,
  SectionHeading,
  toast,
} from '@/components/ui';
import { plural } from '@/lib/format';

export function DevicesCard() {
  const client = useQueryClient();
  const { data: push, isPending } = usePush();
  // The last few announcements, so the card can answer "did anything actually
  // arrive" rather than only "is a device registered".
  const { data: reach } = useInbox({ limit: 25 });

  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [inTab, setInTab] = useState<NotifyState>(() => notifyState());

  useEffect(() => {
    void currentEndpoint().then(setEndpoint);
  }, []);

  const refresh = async () => {
    setEndpoint(await currentEndpoint());
    await client.invalidateQueries({ queryKey: keys.push() });
  };

  // Which row is this browser? The endpoint is the only thing that says so, and
  // the server never returns it — so the client matches on the one it holds.
  const mine = push?.devices.find((d) => d.service && endpoint?.startsWith(d.service)) ?? null;
  const subscribed = Boolean(endpoint && mine);
  const why = blocker();

  const subscribe = useMutation({
    mutationFn: () => enable(),
    onSuccess: async (result) => {
      toast(
        result.ok ? 'This device will be notified.' : (result.detail ?? 'Not subscribed'),
        result.ok ? 'ok' : 'error',
      );
      await refresh();
    },
    onError: toastError,
  });

  const unsubscribe = useMutation({
    mutationFn: () => disable(),
    onSuccess: refresh,
    onError: toastError,
  });

  const test = useMutation({
    mutationFn: (id: string) => api.pushTest(id),
    onSuccess: (result) => {
      // "Accepted" is the truth and is not the same as "you saw it": the push
      // service, the browser and the operating system are three separate yeses,
      // and only the first one answers back. Saying just "sent" makes a muted
      // OS look like a broken console.
      toast(
        result.ok
          ? 'Handed to the push service. If nothing appeared, it got no further than your system ' +
              'notification settings for this browser.'
          : `Not sent — ${result.detail}`,
        result.ok ? 'ok' : 'error',
      );
    },
    onError: toastError,
  });

  const categories = useMutation({
    mutationFn: ({ id, next }: { id: string; next: Record<string, boolean> }) => api.pushCategories(id, next),
    onSuccess: refresh,
    onError: toastError,
  });

  const quiet = useMutation({
    mutationFn: ({ id, next }: { id: string; next: PushQuietHours | null }) => api.pushQuiet(id, next),
    onSuccess: refresh,
    onError: toastError,
  });

  if (isPending && !push) return <CardSkeleton loading h="64" />;

  const deviceCount = push?.devices.length ?? 0;
  const busy =
    subscribe.isPending || unsubscribe.isPending || test.isPending || categories.isPending || quiet.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Devices</CardTitle>
        <span className="text-2xs text-ink-faint">{plural(deviceCount, 'device')} subscribed</span>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {!deviceCount && !why && (
          <Banner severity="info">
            {/* An empty state is an invitation to act, so the banner carries
                the verb rather than pointing at one further down the card —
                the same words the bell drawer's own empty banner uses to send
                a reader here in the first place. */}
            <span className="min-w-0 flex-1">
              <strong>Nothing has ever been sent from this console.</strong> No browser has subscribed, so
              every announcement so far reached the inbox and stopped there. It takes one permission prompt,
              and covers this device with the console closed.
            </span>
            <Button
              size="sm"
              variant="action"
              className="shrink-0"
              disabled={busy}
              onClick={() => subscribe.mutate()}
            >
              {subscribe.isPending ? 'Subscribing…' : 'Set a device up'}
            </Button>
          </Banner>
        )}

        <Lane
          title="In this tab"
          detail="Raised by the page when this tab is in the background and this browser has no push
                  subscription. Costs nothing and needs no setup, but only exists while a tab is open."
        >
          {inTab === 'granted' ? (
            <Chip tone="ok">on</Chip>
          ) : inTab === 'denied' ? (
            <span className="text-2xs text-ink-faint">blocked in browser settings</span>
          ) : inTab === 'unsupported' ? (
            <span className="text-2xs text-ink-faint">unsupported here</span>
          ) : (
            <Button size="sm" onClick={async () => setInTab(await askToNotify())}>
              Allow
            </Button>
          )}
        </Lane>

        <Lane
          title="On this device"
          detail={`Delivered through a push service, so it arrives with the console closed — the case an
                   unattended run exists for. ${describeBrowser()}.`}
        >
          {subscribed && mine ? (
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => test.mutate(mine.id)}>
                {test.isPending ? 'Sending…' : 'Send a test'}
              </Button>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => unsubscribe.mutate()}>
                Turn off
              </Button>
            </div>
          ) : why ? null : (
            <Button size="sm" variant="action" disabled={busy} onClick={() => subscribe.mutate()}>
              {subscribe.isPending ? 'Subscribing…' : 'Turn on'}
            </Button>
          )}
        </Lane>

        {why && <Banner severity={iosNeedsInstall() ? 'info' : 'warn'}>{why}</Banner>}

        {subscribed && mine && push?.categories.length ? (
          <div>
            <SectionHeading as="h3" className="mb-2">
              What to push to this device
            </SectionHeading>
            {/*
              This list narrows; it does not enable. It used to be the only
              category control in the console, which made it look global — and
              on a console with no device subscribed it did not exist at all.
              Whether a category is announced is decided above, in
              "What to announce".
            */}
            <p className="mb-2 text-2xs text-ink-muted">
              Only narrows what <strong>What to announce</strong> already allows — a category switched off
              there never reaches any device, whatever is ticked here.
            </p>
            <div className="flex flex-col gap-2">
              {push.categories.map((category) => (
                <label key={category.id} className="flex items-start gap-2">
                  <Checkbox
                    className="mt-1"
                    checked={mine.categories?.[category.id] === true}
                    disabled={busy}
                    aria-label={category.label}
                    onCheckedChange={(next) =>
                      categories.mutate({
                        id: mine.id,
                        next: { ...mine.categories, [category.id]: next === true },
                      })
                    }
                  />
                  <span className="min-w-0">
                    <span className="text-sm text-ink">{category.label}</span>
                    {category.urgent && (
                      <Chip tone="warn" className="ml-1.5">
                        urgent
                      </Chip>
                    )}
                    <span className="mt-0.5 block text-2xs text-ink-muted">{category.detail}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        {subscribed && mine ? (
          <QuietHoursEditor
            quiet={mine.quiet ?? null}
            busy={busy}
            onChange={(next) => quiet.mutate({ id: mine.id, next })}
          />
        ) : null}

        {deviceCount > 1 && (
          <div>
            <SectionHeading as="h3" className="mb-2">
              Other devices
            </SectionHeading>
            <div className="flex flex-col gap-1">
              {push!.devices
                .filter((d) => d.id !== mine?.id)
                .map((device) => (
                  <OtherDevice
                    key={device.id}
                    device={device}
                    busy={busy}
                    onTest={() => test.mutate(device.id)}
                  />
                ))}
            </div>
          </div>
        )}

        {reach && <DeliveryReadout reach={reach} />}

        {subscribed && (
          <p className="text-2xs text-ink-muted">
            A test that says it was handed over and never appears has almost always been stopped by the
            operating system rather than by anything here — macOS{' '}
            <em>System Settings → Notifications → your browser</em>, or Windows{' '}
            <em>Settings → System → Notifications</em>. A Focus or Do Not Disturb mode does the same thing
            silently.
          </p>
        )}

        <p className="text-2xs text-ink-muted">
          For a machine with no browser in the picture at all,{' '}
          <code>PHASE_CONSOLE_NOTIFY=&lt;command&gt;</code> is run with the title and body of every one of
          these.{' '}
          {reach && !reach.outOfBand?.configured ? (
            <>
              It is <strong>not set</strong> for this process.
            </>
          ) : reach ? (
            'It is set.'
          ) : null}
        </p>
      </CardBody>
    </Card>
  );
}

function Lane({ title, detail, children }: { title: string; detail: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-rule bg-surface-raised px-3 py-2">
      <div className="min-w-0 flex-1">
        <strong className="text-sm text-ink">{title}</strong>
        <p className="mt-0.5 text-2xs text-ink-muted">{detail}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** The window quiet hours open with: the night. Edited from there. */
export const DEFAULT_QUIET_HOURS: PushQuietHours = { start: '22:00', end: '08:00', allowUrgent: true };

const isClockTime = (value: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

/**
 * Delivery quiet hours, per device.
 *
 * Suppression at the last leg only: inside the window nothing is pushed to
 * THIS device, while the inbox record, the bell, an open tab and
 * `PHASE_CONSOLE_NOTIFY` all still fire — the morning finds the night in the
 * bell, and the delivery ledger reads `quiet` for each held push rather than
 * nothing. Urgent traffic breaks through unless told not to, because an
 * approval suppressed at 3am still stops the fleet dead until morning.
 *
 * Every change saves as it is made, like the category list above it — there
 * is no draft state to lose. The time inputs are uncontrolled and re-keyed on
 * the saved window, so a value mid-edit is never snapped back by a refetch.
 */
function QuietHoursEditor({
  quiet,
  busy,
  onChange,
}: {
  quiet: PushQuietHours | null;
  busy: boolean;
  onChange: (next: PushQuietHours | null) => void;
}) {
  const on = quiet !== null;
  const set = (patch: Partial<PushQuietHours>) => onChange({ ...(quiet ?? DEFAULT_QUIET_HOURS), ...patch });
  return (
    <div>
      <SectionHeading as="h3" className="mb-2">
        Quiet hours on this device
      </SectionHeading>
      <p className="mb-2 text-2xs text-ink-muted">
        Inside the window nothing is pushed here. The inbox still gets every announcement, and each held push
        is written to the delivery ledger as <em>quiet</em>. Times are on the console&apos;s own clock.
      </p>
      <label className="flex items-start gap-2">
        <Checkbox
          className="mt-1"
          checked={on}
          disabled={busy}
          aria-label="Quiet hours"
          onCheckedChange={(next) => onChange(next === true ? DEFAULT_QUIET_HOURS : null)}
        />
        <span className="min-w-0">
          <span className="text-sm text-ink">Quiet hours</span>
          <span className="mt-0.5 block text-2xs text-ink-muted">
            {on
              ? `${quiet.start} to ${quiet.end}${quiet.allowUrgent ? ' · urgent still gets through' : ''}`
              : 'off'}
          </span>
        </span>
      </label>
      {on && (
        <div className="mt-2 flex flex-wrap items-end gap-3 pl-6" key={`${quiet.start}-${quiet.end}`}>
          <label className="flex flex-col gap-1 text-2xs text-ink-muted">
            From
            <Input
              type="time"
              aria-label="Quiet from"
              defaultValue={quiet.start}
              disabled={busy}
              onChange={(event) => {
                if (isClockTime(event.target.value)) set({ start: event.target.value });
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-2xs text-ink-muted">
            Until
            <Input
              type="time"
              aria-label="Quiet until"
              defaultValue={quiet.end}
              disabled={busy}
              onChange={(event) => {
                if (isClockTime(event.target.value)) set({ end: event.target.value });
              }}
            />
          </label>
          <label className="flex items-center gap-2 pb-2">
            <Checkbox
              checked={quiet.allowUrgent}
              disabled={busy}
              aria-label="Urgent still gets through"
              onCheckedChange={(next) => set({ allowUrgent: next === true })}
            />
            <span className="text-2xs text-ink-muted">Urgent still gets through</span>
          </label>
        </div>
      )}
    </div>
  );
}

function OtherDevice({ device, busy, onTest }: { device: PushDevice; busy: boolean; onTest: () => void }) {
  const chosen = Object.values(device.categories ?? {}).filter(Boolean).length;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-rule px-3 py-2">
      <div className="min-w-0 flex-1">
        <strong className="text-sm text-ink">{device.label}</strong>
        {device.quiet && (
          <Chip
            className="ml-1.5"
            title={`Quiet ${device.quiet.start} to ${device.quiet.end}${
              device.quiet.allowUrgent ? ' · urgent still gets through' : ''
            }`}
          >
            quiet {device.quiet.start}–{device.quiet.end}
          </Chip>
        )}
        <span className="ml-1.5 text-2xs text-ink-faint">
          {plural(chosen, 'category', 'categories')} ·{' '}
          {device.lastOkAt ? (
            <>
              last reached <RelativeTime at={device.lastOkAt} live={false} />
            </>
          ) : (
            'never reached'
          )}
        </span>
      </div>
      <Button size="sm" disabled={busy} onClick={onTest}>
        Test
      </Button>
    </div>
  );
}

/**
 * What actually became of the last few announcements.
 *
 * The register answers "is a device subscribed", which is not the question. A
 * subscription can be live, chosen for every category, and still deliver
 * nothing — a push service refusing, an endpoint that died months ago, an
 * operating system dropping it silently. `announce()` is deliberately not
 * awaited so none of that can stall a run, which is exactly why none of it was
 * ever visible. Here it is.
 */
function DeliveryReadout({
  reach,
}: {
  reach: { items: { delivery?: { label: string; outcome: string }[] }[] };
}) {
  const items = reach.items ?? [];
  if (!items.length) return null;

  const attempted = items.filter((r) => (r.delivery ?? []).length);
  const undelivered = items.length - attempted.length;
  // `quiet` is a device inside its own quiet hours — held on purpose, and
  // neither a delivery nor a failure. Counted on its own line.
  const failures = attempted.flatMap((r) =>
    (r.delivery ?? []).filter((d) => d.outcome !== 'sent' && d.outcome !== 'quiet'),
  );
  const held = attempted.flatMap((r) => (r.delivery ?? []).filter((d) => d.outcome === 'quiet')).length;

  return (
    <div className="rounded border border-rule bg-surface-raised px-3 py-2">
      <strong className="text-sm text-ink">What has been reaching you</strong>
      <p className="mt-0.5 text-2xs text-ink-muted">
        Of the last {plural(items.length, 'announcement')}, {attempted.length} went to a device
        {undelivered ? ` and ${undelivered} reached no device at all — those exist only in the inbox` : ''}.
      </p>
      {failures.length > 0 && (
        <p className="mt-1 text-2xs text-blocked">
          {plural(failures.length, 'handover')} did not succeed:{' '}
          {[...new Set(failures.map((f) => `${f.label} · ${f.outcome}`))].join(', ')}.
        </p>
      )}
      {held > 0 && (
        <p className="mt-1 text-2xs text-ink-muted">{plural(held, 'handover')} held by quiet hours.</p>
      )}
    </div>
  );
}
