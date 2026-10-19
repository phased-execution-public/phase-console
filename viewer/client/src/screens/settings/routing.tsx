/**
 * What is announced, and where each kind lands (7.0, quiet-console phase 22;
 * the routing matrix of 6.x, parallel-repaint phase 7).
 *
 * ```
 * What is announced
 * [x] A phase that needs you
 *     The run stops until you act.
 *     Goes to the inbox, this device and 2 of 3 webhooks.
 *     Urgent
 * ```
 *
 * One row per kind of announcement, in the order the server's catalogue gives
 * them. The checkbox IS the console-wide switch (`notify.<kind>`, a key of the
 * settings schema, saved as a delta the server merges): a kind switched off is
 * not written to the inbox, not sent to an open tab, not handed to the notify
 * command and not pushed anywhere. The line under each says where it lands
 * with the switch on — this browser, if it is subscribed, and how many webhooks
 * would actually receive it, which is what `announce()` would POST to rather
 * than what is registered: without `--allow-webhooks`, or inside a failure's
 * backoff, a registered webhook receives nothing, and a bare count could not
 * say so. Devices and webhooks narrow a kind further, each in its own group.
 */

import { useEffect, useId, useState } from 'react';
import { useConsoleState } from '@/data/console';
import { usePush } from '@/data/inbox';
import type { NotificationCategory, PushDevice, WebhookRow } from '@/data/api';
import { useWebhooks } from '@/data/webhooks';
import { plural } from '@/lib/format';
import { currentEndpoint } from '@/lib/push';
import { endpointTag, matchThisDevice } from '@/lib/push-match';
import { Banner, Skeleton } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { Origin, SettingsGroup, useSetting } from './setting';

/**
 * The kinds that mean "nothing proceeds until you look". Turning one off is a
 * legitimate choice, and the one most often made by accident while stopping a
 * flood — so the group says so, in place, rather than leaving it to be found
 * when a run sits halted overnight.
 */
const LOAD_BEARING: ReadonlySet<string> = new Set(['approval', 'session-ask', 'needs-you', 'halted']);

/**
 * Which subscribed device is this browser: the endpoint is the only thing that
 * says so, and the server never returns it — only its tag, the sha256 prefix
 * this page computes from its own endpoint (#325).
 */
export function useThisDevice(devices: readonly PushDevice[] | undefined): PushDevice | null {
  const [mine, setMine] = useState<{ endpoint: string | null; tag: string | null }>({
    endpoint: null,
    tag: null,
  });
  useEffect(() => {
    let live = true;
    void currentEndpoint().then(async (endpoint) => {
      const tag = endpoint ? await endpointTag(endpoint) : null;
      if (live) setMine({ endpoint, tag });
    });
    return () => {
      live = false;
    };
  }, [devices]);
  // By the endpoint's tag, never the push service's origin alone (#325).
  return matchThisDevice(devices, mine.endpoint, mine.tag);
}

/**
 * Where one kind lands with its switch on, in words: the inbox, this device,
 * and the webhooks that would receive it now. A device and a webhook each
 * narrow what the console allows, and each register is complete by
 * construction — a key absent from one is a key the server never held, which
 * resolves to the kind's catalogue default, never "on".
 *
 * `device` is three facts, not two: `null` is no subscribed browser here at
 * all, a different fact from subscribed and narrowed out.
 */
export function routeWords({
  device,
  takenBy,
  backingOff,
  hooks,
  allowWebhooks,
}: {
  device: boolean | null;
  takenBy: number;
  backingOff: number;
  hooks: number;
  allowWebhooks: boolean;
}): string {
  const where = device === null ? 'no device here' : device ? 'this device' : 'not this device';
  const webhooks =
    hooks === 0
      ? 'no webhooks'
      : !allowWebhooks
        ? `${plural(hooks, 'webhook')}, none reachable`
        : takenBy === hooks
          ? plural(hooks, 'webhook')
          : `${takenBy} of ${hooks} webhooks`;
  const back =
    allowWebhooks && backingOff > 0
      ? ` ${plural(backingOff, 'webhook')} ${backingOff === 1 ? 'takes' : 'take'} it but ${
          backingOff === 1 ? 'is' : 'are'
        } backing off after a failure.`
      : '';
  return `Goes to the inbox, ${where} and ${webhooks}.${back}`;
}

function KindRow({
  category,
  device,
  hooks,
  allowWebhooks,
  fallback,
  now,
}: {
  category: NotificationCategory;
  device: PushDevice | null;
  hooks: readonly WebhookRow[];
  allowWebhooks: boolean;
  /** What the console holds for the kind when the schema has no row for it — a newer server's kind. */
  fallback: boolean | undefined;
  now: number;
}) {
  const pref = `notify.${category.id}`;
  const setting = useSetting<boolean>(pref);
  const id = useId();
  // The schema's value (its default is the catalogue's); a kind it has no row
  // for reads what the console holds, then the catalogue — as the server resolves it.
  const on = typeof setting.value === 'boolean' ? setting.value : (fallback ?? category.byDefault);
  const takes = hooks.filter((hook) => hook.categories?.[category.id] ?? category.byDefault);
  // Inside its failure backoff `announce()` skips a webhook and the announcement is dropped.
  const backingOff = takes.filter((hook) => (hook.quietUntil ?? 0) > now).length;
  const line = on
    ? routeWords({
        device: device ? (device.categories?.[category.id] ?? category.byDefault) : null,
        takenBy: takes.length - backingOff,
        backingOff,
        hooks: hooks.length,
        allowWebhooks,
      })
    : 'Off: nothing is recorded and nothing is sent.';
  return (
    <div data-pref={pref} data-kind={category.id} className="flex min-w-0 flex-col gap-1">
      <label className="flex min-w-0 items-start gap-2.5 text-body [@media(hover:none)]:min-h-(--tap-min)">
        <Checkbox
          className="mt-0.5"
          checked={on}
          aria-label={category.label}
          aria-describedby={`${id}-detail ${id}-line`}
          onCheckedChange={(next) => setting.save(next === true)}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="min-w-0 break-words text-ink">{category.label}</span>
          <span id={`${id}-detail`} className="max-w-(--measure) break-words text-meta text-ink-muted">
            {category.detail}
          </span>
          <span
            id={`${id}-line`}
            data-route-line
            className="max-w-(--measure) break-words text-meta text-ink-muted"
          >
            {line}
          </span>
        </span>
      </label>
      {(category.urgent || !category.byDefault) && (
        <div className="flex min-w-0 flex-wrap gap-x-3 ps-[1.625rem] text-meta text-ink-muted">
          {category.urgent && <span>Urgent: it breaks through a device’s quiet hours</span>}
          {!category.byDefault && <span>Off unless you turn it on</span>}
        </div>
      )}
      <Origin pref={pref} row={setting.row} files={setting.files} className="ps-[1.625rem]" />
    </div>
  );
}

export function RoutingGroup() {
  const { data: state } = useConsoleState();
  // The catalogue is served beside the push register: the same table the server gates on.
  const { data: push, isPending } = usePush();
  // Reading the webhooks never needs `--allow-webhooks`; the answer carries the flag.
  const { data: webhooks } = useWebhooks();
  const device = useThisDevice(push?.devices);
  const categories = push?.categories ?? [];
  const notify = state?.prefs?.notify ?? {};
  const hooks = webhooks?.hooks ?? [];
  const allowWebhooks = webhooks?.allowWebhooks ?? false;
  // One instant for every row: the backoff is measured against it.
  const now = Date.now();
  const off = categories.filter((category) => (notify[category.id] ?? category.byDefault) === false);
  const mutedImportant = off.filter((category) => LOAD_BEARING.has(category.id));

  return (
    <SettingsGroup
      id="routing"
      title="What is announced"
      lead="A kind switched off is not recorded or sent anywhere. Each kind says where it lands while it is on; a device and a webhook can each narrow it further below."
      aside={
        categories.length ? (
          <span className="text-meta text-ink-muted">
            {plural(categories.length, 'kind')}
            {off.length ? `, ${off.length} off` : ''}
          </span>
        ) : undefined
      }
    >
      {mutedImportant.length > 0 && (
        <Banner severity="warn" data-testid="routing-muted">
          {mutedImportant.map((category) => category.label).join(', ')}{' '}
          {mutedImportant.length === 1 ? 'is' : 'are'} off. That covers work that stops until you act — a
          halted run or an unanswered permission will wait without telling you.
        </Banner>
      )}
      {!allowWebhooks && hooks.length > 0 && (
        <p className="max-w-(--measure) text-meta text-ink-muted">
          {plural(hooks.length, 'webhook')} {hooks.length === 1 ? 'is' : 'are'} registered, and none is
          reachable: this console was started without <code className="font-mono">--allow-webhooks</code>, so
          it makes no outbound request until it restarts with it.
        </p>
      )}
      {categories.length === 0 ? (
        isPending ? (
          <Skeleton className="h-40" aria-busy="true" aria-label="Reading the kinds of announcement" />
        ) : (
          <p className="text-meta text-ink-muted">This server does not say which kinds it announces.</p>
        )
      ) : (
        <div className="flex min-w-0 flex-col gap-4" data-testid="routing-kinds">
          {categories.map((category) => (
            <KindRow
              key={category.id}
              category={category}
              device={device}
              hooks={hooks}
              allowWebhooks={allowWebhooks}
              fallback={notify[category.id]}
              now={now}
            />
          ))}
        </div>
      )}
    </SettingsGroup>
  );
}
