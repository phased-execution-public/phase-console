/**
 * **One plan's band** on the operations board.
 *
 * A band is a plan: its lanes in flight, and underneath them the admissions of
 * that same plan that are still waiting for a scope. Those two lists used to
 * live on different pages — the lanes here, the queue on `#/runs` — so the one
 * question an operator actually asks ("is this plan moving, and if not, what is
 * in the way?") needed two destinations and a mental join.
 *
 * ## What the band header promises
 *
 * The header is the glance (L0), and every figure on it is transported:
 * how many lanes, how many are waiting, and — the fact that makes concurrency
 * legible — **how many distinct checkouts** those lanes are working in. One
 * checkout with three lanes is three sessions serialized by the tree they
 * share; three checkouts is three sessions genuinely in parallel. They look
 * identical on a flat list and they are not the same machine.
 *
 * ## The waiting rows are not lanes and are not drawn as lanes
 *
 * An admission entry has no process: it cannot be frozen, tailed or steered,
 * and the only verb it takes is a bump. Giving it a `LaneRow` would offer three
 * controls that would fail. It gets a quieter row that says who is in the way,
 * in that holder's own terms.
 */

import { useState } from 'react';
import { GitBranch, Layers } from 'lucide-react';
import {
  Badge,
  Card,
  Chip,
  Inspector,
  InspectorSection,
  KeyValue,
  MonoId,
  RelativeTime,
} from '@/components/ui';
import { elapsed } from '@/lib/format';
import { useNow } from '@/lib/clock';
import { cn } from '@/lib/cn';
import { plainText } from '@/lib/plain-text';
import { planHref } from '@shared/routes.js';
import type { QueueEntry } from '@/lib/api';
import { LaneRow } from './lane-row';
import type { ConsoleLine } from '@/features/runs/console-model';
import {
  carveable,
  holderKindWord,
  leaseLapsed,
  leaseRemainingMs,
  waitIsForAPerson,
  waitSummary,
  waitedMs,
  type Swimlane,
} from './ops-model';

export function SwimlaneBand({
  band,
  tails,
  waiters,
  allowRun,
}: {
  band: Swimlane;
  /** The section's one SSE ring, sliced per lane key. */
  tails: Map<string, ConsoleLine[]>;
  /** Entries waiting on a lane of THIS band, keyed by `slug#phase`. */
  waiters: Map<string, QueueEntry[]>;
  allowRun: boolean;
}) {
  return (
    <section
      data-testid="swimlane"
      data-slug={band.slug}
      aria-label={`${band.slug} — ${band.lanes.length} in flight, ${band.waiting.length} waiting`}
      className="rounded-lg border border-rule bg-ground-deep/40"
    >
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-rule px-3 py-2">
        <a
          href={planHref(band.slug, 'run')}
          className="min-w-0 truncate font-display text-md leading-tight hover:text-action"
          title={plainText(band.planTitle)}
        >
          {band.slug}
        </a>
        <span className="text-2xs text-ink-faint">
          {band.lanes.length ? `${band.lanes.length} in flight` : 'nothing running'}
          {band.waiting.length ? ` · ${band.waiting.length} waiting` : ''}
        </span>
        {/* The concurrency fact. Only worth drawing once there is more than one
            lane — "1 checkout" beside a single lane is noise, and beside three
            lanes it is the whole story. */}
        {band.lanes.length > 1 && (
          <Chip
            tone="neutral"
            title={
              band.trees > 1
                ? `${band.trees} separate checkouts — these lanes are genuinely running side by side.`
                : 'One checkout: these lanes share a working tree and take turns in it.'
            }
          >
            <Layers size={11} aria-hidden />
            {band.trees > 1 ? `${band.trees} checkouts` : 'one checkout'}
          </Chip>
        )}
      </header>

      {band.lanes.length > 0 && (
        <ul className="flex flex-col gap-2 p-2">
          {band.lanes.map((lane) => (
            <LaneRow
              key={lane.key}
              lane={lane}
              {...(tails.get(lane.key) ? { tail: tails.get(lane.key)! } : {})}
              {...(waiters.get(`${lane.slug}#${lane.phase}`)
                ? { waiters: waiters.get(`${lane.slug}#${lane.phase}`)! }
                : {})}
              allowRun={allowRun}
            />
          ))}
        </ul>
      )}

      {band.waiting.length > 0 && (
        <ul
          data-testid="waiting-rows"
          className={cn('flex flex-col gap-1.5 p-2', band.lanes.length > 0 && 'border-t border-rule')}
        >
          {band.waiting.map((entry) => (
            <WaitingRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One admission still waiting for a scope.
 *
 * L0 is the summary line; L2 is the inspector, which is where the holders live
 * — one card each, with what collided, whose it is, and how the wait ends. That
 * split is deliberate: an operator scanning the board wants "behind X"; an
 * operator who has stopped on this row wants the whole chain, and putting the
 * chain on the row would make a screenful of queued plans unreadable.
 */
export function WaitingRow({ entry }: { entry: QueueEntry }) {
  const [open, setOpen] = useState(false);
  const now = useNow(true);
  const summary = waitSummary(entry);

  return (
    <li data-testid="waiting-row" data-entry={entry.id}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded border border-rule bg-surface px-2.5 py-2 text-start hover:bg-surface-raised [@media(hover:none)]:min-h-(--tap-min)"
      >
        <Badge tone="wait">queued</Badge>
        <span className="min-w-0 flex-1 truncate text-sm text-ink">
          {entry.phase == null ? 'the run' : `phase ${entry.phase}`} — {summary}
        </span>
        {/* Aged out: its tokens now block everything behind it, which is the
            scheduler protecting it from starving and is worth saying out loud —
            an operator reading a long queue would otherwise read it as stuck. */}
        {entry.reserving && (
          <Chip
            tone="neutral"
            title="Aged out of the queue: its scope now blocks everything behind it, so it cannot starve. Nobody is being asked for anything — deliberately not amber."
          >
            reserving
          </Chip>
        )}
        {entry.bumped && <Chip tone="neutral">bumped</Chip>}
        {entry.priority && entry.priority !== 'normal' && <Chip tone="neutral">{entry.priority}</Chip>}
        <span className="shrink-0 font-mono text-2xs tabular-nums text-ink-muted">
          {elapsed(waitedMs(entry, now))}
        </span>
      </button>

      <Inspector
        open={open}
        onOpenChange={setOpen}
        title={`${entry.slug}${entry.phase == null ? '' : ` — phase ${entry.phase}`}`}
        description="Waiting for a scope. Nothing has been checked out for it yet."
        meta={
          <>
            <Badge tone="wait">queued</Badge>
            <MonoId id={entry.runId} />
            <span className="text-2xs text-ink-muted">
              waiting <RelativeTime at={new Date(entry.since).toISOString()} className="text-2xs" />
            </span>
          </>
        }
        raw={<pre className="font-mono text-2xs whitespace-pre-wrap">{JSON.stringify(entry, null, 2)}</pre>}
      >
        <InspectorSection heading="What it asked for">
          <KeyValue
            items={[
              ['Scope', entry.scope.length ? entry.scope.join(', ') : 'not declared'],
              // Unqualified is not a gap, it is the worst case: a claim that
              // states neither dimension collides with everything.
              ['Branch', entry.branch ?? 'not declared — collides with every branch'],
              ['Checkout', entry.tree ?? 'not declared — collides with every tree'],
              entry.bypassed > 0 &&
                ([
                  'Let past',
                  `${entry.bypassed} later ${entry.bypassed === 1 ? 'entry' : 'entries'}`,
                ] as const),
            ]}
          />
        </InspectorSection>

        {entry.held && (
          <InspectorSection heading="Held">
            <p className="text-2xs text-ink-muted">
              Nothing of this run boards while the hold stands
              {entry.held.by ? `, and ${entry.held.by} set it` : ''}. Release it to let it queue normally.
            </p>
          </InspectorSection>
        )}

        {entry.after && (
          <InspectorSection heading="Chained">
            <p className="text-2xs text-ink-muted">
              It waits for <span className="font-mono">{entry.after}</span> to finish before it may queue at
              all.
            </p>
          </InspectorSection>
        )}

        <InspectorSection heading={`In the way (${entry.waitingOn.length})`}>
          {entry.waitingOn.length === 0 ? (
            <p className="text-2xs text-ink-faint">
              Nothing holds its scope. It is waiting for a free lane rather than for another claim.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {entry.waitingOn.map((holder, i) => {
                const left = leaseRemainingMs(holder, now);
                const lapsed = leaseLapsed(holder, now);
                const carve = carveable(entry, holder);
                return (
                  <li
                    key={`${holder.kind}:${holder.slug}:${holder.phase ?? 'run'}:${i}`}
                    data-testid="holder"
                    className="rounded border border-rule bg-surface px-2.5 py-2"
                  >
                    <p className="text-sm text-ink">
                      {holder.clock
                        ? holder.owner
                        : `${holder.slug}${holder.phase == null ? '' : ` P${holder.phase}`}`}
                      <span className="ml-1.5 text-2xs text-ink-faint">{holderKindWord(holder)}</span>
                    </p>
                    {/* A clock has no owner to name, no lease to outlive and
                        nobody to go and find. Saying so is the point. */}
                    {holder.clock ? (
                      <p className="mt-0.5 text-2xs text-ink-muted">
                        Not another session — a console policy. It ends by itself; there is nobody to ask.
                      </p>
                    ) : (
                      <>
                        <p className="mt-0.5 text-2xs text-ink-muted">
                          held by <span className="font-mono">{holder.owner}</span>
                          {holder.overlaps.length ? ` · collided on ${holder.overlaps.join(', ')}` : ''}
                        </p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs">
                          {/* `null` is "there is no lease", a negative number is
                              "the lease lapsed". Three readings, never merged. */}
                          {left == null ? (
                            <span
                              className="text-ink-faint"
                              title="A lane of this console holds its scope for as long as it runs. There is no lease to count down."
                            >
                              no lease
                            </span>
                          ) : lapsed ? (
                            <span className="text-needs-you">
                              its lease has lapsed — this claim is debris
                            </span>
                          ) : (
                            <span className="text-ink-muted tabular-nums">lease ends in {elapsed(left)}</span>
                          )}
                          {waitIsForAPerson(holder) && (
                            <span className="text-ink-muted">
                              somebody is in that session now — a queue to wait in, not a lease to outlive
                            </span>
                          )}
                          {holder.eta?.label && (
                            <span
                              className="text-ink-muted"
                              title="The server's own rate reading for that plan. A range, never a promise."
                            >
                              its plan has {holder.eta.label}
                            </span>
                          )}
                        </p>
                        {(holder.branch || holder.tree) && (
                          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-ink-faint">
                            {holder.branch && (
                              <span className="inline-flex items-center gap-1 font-mono">
                                <GitBranch size={10} aria-hidden />
                                {holder.branch}
                              </span>
                            )}
                            {/* Only ever `true` — never "different". A missing
                                half is "cannot say", and rendering it as a
                                difference is how an operator concludes a
                                carve-out was available when the scheduler had
                                already ruled it out. */}
                            {carve === false && (
                              <span className="text-waiting">same ground as you — no carve-out</span>
                            )}
                            {carve === true && (
                              <span className="text-ink-muted">
                                different branch and checkout — the scan can carve past this
                              </span>
                            )}
                          </p>
                        )}
                        {holder.session && (
                          <p className="mt-0.5 text-2xs text-ink-faint">
                            session <MonoId id={holder.session} className="text-ink-faint" />
                          </p>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </InspectorSection>
      </Inspector>
    </li>
  );
}

/** The empty band: nothing of this plan is running and nothing is queued. */
export function NoBands({ headline, detail }: { headline: string; detail: string }) {
  return (
    <Card className="state-ready px-3 py-2.5 md:px-4">
      <p className="text-md">{headline}</p>
      <p className="mt-0.5 text-2xs text-ink-muted">{detail}</p>
    </Card>
  );
}
