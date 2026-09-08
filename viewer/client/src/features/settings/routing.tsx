/**
 * Where every kind of announcement actually lands — the routing matrix.
 *
 * The console has three tiers of notification preference and, until Phase 7,
 * three separate cards to read them from: the console-wide switch here, a
 * narrowing per push device, and a narrowing per webhook destination. Each was
 * a correct list of sixteen checkboxes and none of them could answer the
 * question an operator actually has, which is not *is `qa` allowed* but **where
 * does a `qa` announcement go right now**. Answering it meant opening three
 * cards and cross-referencing them by eye.
 *
 * So the sixteen kinds are rows and the destinations are the reading: for each
 * kind, whether the console says it at all (the control — this card OWNS the
 * console-wide switch, it is not a copy of one), whether it reaches this
 * browser, and how many webhook destinations would actually receive it — which
 * is what `announce()` would POST to, not what is registered: `--allow-webhooks`
 * and a row's failure backoff both make a registered destination unreachable,
 * and a bare count cannot say so. It is the operator-facing
 * projection of the pipeline map in `docs/plans/console-parallel-repaint-findings.md`
 * §"Kind × channel routing table".
 *
 * **Three of that table's columns are deliberately not here.** *Announced from*
 * and *Tag* are server internals — which call site raises a kind, and which tag
 * collapses repeats — and belong to the delivery ledger, not to a page of
 * settings. *Deep link* looks like a per-kind constant and is not: `routeFor`
 * needs the slug and phase off the announcement, so a settings page could only
 * print a pattern, and a second copy of a server vocabulary is a copy that
 * drifts. What is here is what an operator can change plus the two catalogue
 * facts that decide how it behaves: whether it is urgent, and what it does
 * before anyone touches it.
 *
 * Rows, not a grid of cells: this section renders beside a 220px rail, and six
 * columns of checkbox at that width is a horizontal scroll on a laptop and
 * nothing at all on a phone. Each kind is a row with its control, its name, and
 * a routing line under it — which reads the same at every width and is the
 * only shape that survives a screen reader in a single pass.
 */

import { useEffect, useState } from 'react';
import { useConsoleState, usePush, useSavePrefs, useWebhooks } from '@/lib/queries';
import { currentEndpoint } from '@/lib/push';
import { settingsHref } from '@/app/routes';
import { plural } from '@/lib/format';
import { Banner, Card, CardBody, CardHeader, CardSkeleton, CardTitle, Checkbox, Chip } from '@/components/ui';

/**
 * The kinds that mean "nothing proceeds until you look". Turning one off is a
 * legitimate choice — an operator watching the console all day does not need
 * telling twice — but it is the choice most likely to be made by accident while
 * trying to stop a firehose, so it says so once, in place, rather than being
 * discovered when a run sits halted overnight.
 */
const LOAD_BEARING = new Set(['approval', 'session-ask', 'needs-you', 'halted']);

export function RoutingCard() {
  const { data: state, isPending } = useConsoleState();
  // The catalogue is served beside the push register; it is the same table the
  // server gates on, so the two cannot drift.
  const { data: push } = usePush();
  // Reading the destination list never needs `--allow-webhooks`; a console
  // that cannot POST can still be asked where a kind would go. The same
  // response carries the flag, which is what makes that answer honest.
  const { data: webhooks } = useWebhooks();

  // Which push row is this browser? The endpoint is the only thing that says
  // so and the server never returns it, so the client matches on the one it
  // holds — the same match the Devices card makes.
  const [endpoint, setEndpoint] = useState<string | null>(null);
  useEffect(() => {
    void currentEndpoint().then(setEndpoint);
  }, []);

  // A delta, not the whole map: the server merges `notify` over what is
  // stored, so two tabs toggling different kinds do not overwrite each other.
  const save = useSavePrefs();

  if (isPending && !state) return <CardSkeleton loading h="64" />;

  const categories = push?.categories ?? [];
  const notify = state?.prefs?.notify ?? {};
  // Before the catalogue arrives there is nothing to render rows from, and a
  // card that renders an empty list reads as "no kinds", not "loading".
  if (!categories.length) return <CardSkeleton loading h="64" />;

  const thisDevice = push?.devices.find((d) => d.service && endpoint?.startsWith(d.service)) ?? null;
  const hooks = webhooks?.hooks ?? [];
  // `--allow-webhooks`, off in the shipping default. `announce()` returns
  // before the first `fetch` without it, so rows on disk are registered and
  // unreachable at the same time — a restart is all it takes to get there with
  // the destinations intact. A count that ignored the flag would be this
  // card's own failure mode: a confident answer that is wrong.
  const allowWebhooks = webhooks?.allowWebhooks ?? false;
  // The same instant for every row, because `announce()` also skips a row
  // inside its failure backoff and an announcement that lands during one is
  // dropped, never retried.
  const now = Date.now();
  const silenced = categories.filter((c) => (notify[c.id] ?? c.byDefault) === false);
  const mutedImportant = silenced.filter((c) => LOAD_BEARING.has(c.id));

  return (
    <Card>
      <CardHeader>
        <CardTitle>What is announced, and where it goes</CardTitle>
        <span className="text-2xs text-ink-faint">
          {categories.length} kinds
          {silenced.length ? ` · ${silenced.length} silenced` : ''}
        </span>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="text-2xs text-ink-muted">
          The checkbox is the whole console: a kind switched off is not written to the inbox, not sent to an
          open tab, not passed to <code>PHASE_CONSOLE_NOTIFY</code> and not pushed anywhere. The line under
          each kind is where it lands with that switch on — narrowed per device in Devices below, and per
          destination in Channels.
        </p>

        {!allowWebhooks && hooks.length > 0 && (
          <p className="text-2xs text-ink-muted">
            <strong className="text-ink">None reachable</strong> is the {plural(hooks.length, 'destination')}{' '}
            registered in Channels: this console was started without <code>--allow-webhooks</code>, so it
            makes no outbound request at all until it is restarted with the flag.
          </p>
        )}

        {mutedImportant.length > 0 && (
          <Banner severity="warn">
            <strong>
              {mutedImportant.map((c) => c.label).join(', ')} {mutedImportant.length === 1 ? 'is' : 'are'}{' '}
              off.
            </strong>{' '}
            {mutedImportant.length === 1 ? 'That kind' : 'Those kinds'} covers work that stops dead until you
            act — a halted run or an unanswered permission card will now wait without telling you.
          </Banner>
        )}

        <ul className="flex min-w-0 flex-col gap-2">
          {categories.map((category) => {
            // A kind the config has never seen takes its catalogue default,
            // exactly as the server resolves it — so the checkbox shows what
            // would actually happen rather than an unchecked box.
            const on = notify[category.id] ?? category.byDefault;
            // A device and a webhook each narrow what the console already
            // allows, and each register is COMPLETE by construction:
            // `sanitiseCategories` fills every key from `defaultCategories()`
            // on subscribe, on update and on load, so a key absent here is a
            // key the server has never held either. What it would resolve to
            // if it ever were absent is that kind's CATALOGUE default — which
            // is `false` for the three kinds that ship off — and never "on",
            // because both send gates are fail-closed on the same record
            // (`d.categories[category]`, `hook.categories[category] &&`).
            const onThisDevice = thisDevice
              ? (thisDevice.categories?.[category.id] ?? category.byDefault)
              : false;
            const takes = hooks.filter((hook) => hook.categories?.[category.id] ?? category.byDefault);
            // In backoff: `announce()` skips it and the announcement is
            // dropped, so it is a destination that does not receive this one.
            const backingOff = takes.filter((hook) => (hook.quietUntil ?? 0) > now).length;
            const boxId = `routing-${category.id}`;

            return (
              <li key={category.id} className="flex min-w-0 items-start gap-2">
                <Checkbox
                  id={boxId}
                  className="mt-1"
                  checked={on}
                  disabled={save.isPending}
                  aria-label={category.label}
                  onCheckedChange={(next) => save.mutate({ notify: { [category.id]: next === true } })}
                />
                {/* The row IS the control's label, as it was before the matrix:
                    a 16px box is the whole hit area otherwise, which is the
                    one target size that fails on the device most likely to be
                    reading this. `aria-label` above still names the box, so
                    the accessible name stays the kind rather than the whole
                    paragraph under it. */}
                <label htmlFor={boxId} className="min-w-0 flex-1 cursor-pointer">
                  <span className="text-sm text-ink">{category.label}</span>
                  {category.urgent && (
                    <Chip tone="warn" className="ml-1.5">
                      urgent
                    </Chip>
                  )}
                  {!category.byDefault && <Chip className="ml-1.5">off by default</Chip>}
                  <span className="mt-0.5 block text-2xs text-ink-muted">{category.detail}</span>
                  <RoutingLine
                    on={on}
                    device={thisDevice ? onThisDevice : null}
                    takenBy={takes.length - backingOff}
                    backingOff={backingOff}
                    hooks={hooks.length}
                    allowWebhooks={allowWebhooks}
                  />
                </label>
              </li>
            );
          })}
        </ul>

        <p className="text-2xs text-ink-faint">
          Stored with the console, in <code>~/.config/phase-console/config.json</code> — so it survives a
          restart and applies however you are reading the console.
        </p>
      </CardBody>
    </Card>
  );
}

/**
 * One kind's destinations, in words.
 *
 * Words rather than ticks, and one sentence rather than three columns, because
 * this is read once per row down a list of sixteen: "inbox · this device ·
 * 2 of 3 channels" is scannable, and a row of ✓/— is a legend lookup every
 * time. A silenced kind says so and stops — listing where it would have gone
 * is the sentence that makes an operator think it still goes there.
 *
 * `device` is a tri-state on purpose: `null` means no browser here is
 * subscribed at all, which is a different fact from "subscribed and narrowed
 * out" and needs a different verb.
 *
 * The webhook leg is never a bare count, because a count is the one shape that
 * cannot say "registered and unreachable" — the state a console without
 * `--allow-webhooks` is in with rows on disk, and the state a row in failure
 * backoff is in on its own. `takenBy` is what `announce()` would POST to right
 * now; `backingOff` is what it would have.
 */
function RoutingLine({
  on,
  device,
  takenBy,
  backingOff,
  hooks,
  allowWebhooks,
}: {
  on: boolean;
  device: boolean | null;
  takenBy: number;
  backingOff: number;
  hooks: number;
  allowWebhooks: boolean;
}) {
  if (!on) {
    return (
      <span className="mt-0.5 block text-2xs text-ink-faint">
        Silenced — nothing is recorded and nothing is sent.
      </span>
    );
  }

  const channels =
    hooks === 0
      ? 'no channels'
      : !allowWebhooks
        ? `${plural(hooks, 'channel')}, none reachable`
        : takenBy === hooks
          ? plural(hooks, 'channel')
          : `${takenBy} of ${hooks} channels`;

  const legs = [
    'the inbox',
    device === null ? 'no device here' : device ? 'this device' : 'not this device',
    channels,
  ];

  return (
    <span className="mt-0.5 block text-2xs text-ink-faint">
      Goes to {legs.join(' · ')}.
      {allowWebhooks && backingOff > 0
        ? ` ${plural(backingOff, 'channel')} ${backingOff === 1 ? 'takes' : 'take'} it but ${
            backingOff === 1 ? 'is' : 'are'
          } backing off after a failure.`
        : ''}
    </span>
  );
}

/**
 * The bell, and the one thing this section cannot show: what has already been
 * said. A settings page is about what WILL happen; the log of what did is the
 * drawer, and it is the first place to look when a routing question is really
 * "did it reach me".
 */
export function AnnouncementsPointer({ href }: { href: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>What has already been announced</CardTitle>
      </CardHeader>
      <CardBody>
        <p className="text-sm text-ink-muted">
          Every announcement the console has made — including the ones that arrived while nothing was open to
          hear them — is the bell in the header.{' '}
          <a href={href} className="text-action underline">
            Open the announcements
          </a>
          . Quiet hours below hold a push back on one device; they never hold back the record, so the inbox is
          the morning&rsquo;s source of truth.{' '}
          <a href={settingsHref('automation')} className="text-action underline">
            Automation
          </a>{' '}
          has the separate quiet hours that decide when a phase may BOARD.
        </p>
      </CardBody>
    </Card>
  );
}
