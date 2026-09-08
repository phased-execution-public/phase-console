/**
 * The plan file — read two ways, in one tab.
 *
 * 3.0 folded `overview` and `raw` together. They were never two subjects: one
 * rendered the file's prose and its machine-read graph table, the other printed
 * the same file byte for byte, and a person who wanted to check what the engine
 * would parse had to try both tabs to find out which one showed it. One tab,
 * one switch.
 *
 * **`?view=raw` is why the switch is in the address.** `#/plan/x/raw` is in
 * bookmarks and in handoff prose; redirecting it to a tab that opens on the
 * prose would keep the link working and lose what it meant. The parameter is
 * the same device `?focus=` uses for Now's bands — deep-linkable, reloadable,
 * and composable with the overlays.
 */

import {
  Button,
  ButtonGroup,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Chip,
  CopyButton,
  DataTable,
  Empty,
  PageError,
  Skeleton,
} from '@/components/ui';
import { Markdown, MarkdownInline } from '@/components/markdown';
import { usePlanRaw } from '@/lib/queries';
import { countdown, pad2 } from '@/lib/format';
import { navigate, phaseHref, planHref } from '@shared/routes.js';
import type { PlanDetail } from '@/lib/api';
import { DepsCell, LockCell } from './phase-cells';
import type { SourceView } from './tabs';

/*
 * `SourceView` and `sourceViewOf` moved to `./tabs` — the module `detail.tsx`
 * already imports eagerly — and are re-exported here for existing callers.
 * They were declared in this file, and `detail.tsx` imported the helper beside
 * the component, which made this whole tab a STATIC import of the plan chunk
 * however many `lazy()`s were written around it. A type re-export costs
 * nothing at runtime; the value deliberately does not come back.
 */
export type { SourceView };

export function SourceTab({ detail, view, slug }: { detail: PlanDetail; view: SourceView; slug: string }) {
  const switcher = (
    <ButtonGroup>
      <Button
        size="sm"
        aria-pressed={view === 'reading'}
        // Replaced, not pushed: flipping the switch is not a place you go, and
        // three flips should not be three presses of Back.
        onClick={() => navigate(`plan/${encodeURIComponent(slug)}/source`, { replace: true })}
      >
        Reading
      </Button>
      <Button
        size="sm"
        aria-pressed={view === 'raw'}
        onClick={() => navigate(`plan/${encodeURIComponent(slug)}/source?view=raw`, { replace: true })}
      >
        Markdown
      </Button>
    </ButtonGroup>
  );

  return view === 'raw' ? (
    <RawSource slug={slug} switcher={switcher} />
  ) : (
    <Reading detail={detail} switcher={switcher} />
  );
}

/* ---------------- the bytes ---------------- */

/** The plan file exactly as it is on disk — the thing every reading is a reading of. */
function RawSource({ slug, switcher }: { slug: string; switcher: React.ReactNode }) {
  const { data, error, isPending, refetch } = usePlanRaw(slug);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono text-sm normal-case">docs/plans/{slug}.md</CardTitle>
        <div className="flex items-center gap-2">
          {data != null && <CopyButton text={data} label="Copy markdown" />}
          {switcher}
        </div>
      </CardHeader>
      {error ? (
        <CardBody>
          <PageError error={error} retry={refetch} />
        </CardBody>
      ) : isPending || data == null ? (
        <CardBody>
          <Skeleton className="h-96" />
        </CardBody>
      ) : (
        /* Bounded by `--app-height`, never `vh`: the large viewport ignores the
           iOS software keyboard, so a box sized in it grows past the screen the
           moment anything on the page takes focus. Seven tenths leaves the card
           header and the switcher above it on screen while the file scrolls. */
        <pre className="m-0 max-h-[calc(var(--app-height,100%)*0.7)] overflow-auto overscroll-contain border-t border-rule bg-ground-deep p-3 font-mono text-xs leading-relaxed whitespace-pre">
          {data}
        </pre>
      )}
    </Card>
  );
}

/* ---------------- the prose ---------------- */

/** The plan file's own words, its machine-read graph, its budget and its memory. */
function Reading({ detail, switcher }: { detail: PlanDetail; switcher: React.ReactNode }) {
  const plan = detail.plan;

  if (!plan) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex justify-end">{switcher}</div>
        <Empty
          title="No plan file"
          body="This slug has handoffs but no plan in docs/plans, so there is no phase graph, no session budget and no prose to read."
          action={
            <Button asChild size="sm">
              <a href={planHref(detail.summary.slug, 'handoffs')}>Read the handoffs</a>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-start">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex justify-end lg:hidden">{switcher}</div>

        {plan.provenance && (
          <Card>
            <CardBody>
              <Markdown text={`> ${plan.provenance.replace(/\n/g, '\n> ')}`} />
            </CardBody>
          </Card>
        )}

        {plan.context && (
          <Card>
            <CardHeader>
              <CardTitle>Context</CardTitle>
            </CardHeader>
            <CardBody>
              <Markdown text={plan.context} />
            </CardBody>
          </Card>
        )}

        {plan.architecture && (
          <Card>
            <CardHeader>
              <CardTitle>Architecture</CardTitle>
            </CardHeader>
            <CardBody>
              <Markdown text={plan.architecture} />
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Phase graph</CardTitle>
            <span className="text-xs text-ink-faint">the machine-read table</span>
          </CardHeader>
          <DataTable
            label="Phase graph"
            className="rounded-none border-x-0 border-t"
            columns={[
              {
                id: 'phase',
                head: '#',
                priority: 1,
                min: 52,
                identity: true,
                // The row's own link is `rowHref` below; an anchor inside the
                // identity cell would be an anchor inside an anchor.
                cell: (row) => <span className="font-mono">{row.phase}</span>,
              },
              {
                id: 'title',
                head: 'Title',
                priority: 1,
                min: 200,
                flex: true,
                card: 'title',
                cell: (row) => (
                  <span className="text-ink">
                    <MarkdownInline text={row.title} />
                  </span>
                ),
              },
              {
                id: 'depends',
                head: 'Depends on',
                priority: 2,
                min: 140,
                // Joined in from the phase view: the graph table is what the
                // engine reads, and who holds a row is the one fact about it
                // that is not in the plan file.
                cell: (row) => {
                  const view = detail.phases.find((p) => p.phase === row.phase);
                  return view ? (
                    <DepsCell slug={plan.slug} phase={view} max={4} />
                  ) : (
                    <span className="font-mono text-xs">{row.dependsOn.join(', ') || '—'}</span>
                  );
                },
              },
              {
                id: 'lock',
                head: 'Lock',
                priority: 4,
                min: 132,
                cell: (row) => <LockCell lock={detail.phases.find((p) => p.phase === row.phase)?.lock} />,
              },
              {
                id: 'parallel',
                head: 'Parallel-safe',
                priority: 4,
                min: 124,
                // Raw cells off the plan's own table: prose the console did
                // not write, so it is clamped to the column and carries the
                // whole value on hover rather than setting the row's height.
                cell: (row) => (
                  <span className="block truncate font-mono text-xs" title={row.parallelSafe}>
                    {row.parallelSafe || '—'}
                  </span>
                ),
              },
              {
                id: 'repos',
                head: 'Repos',
                priority: 3,
                min: 128,
                cell: (row) => (
                  <span className="block truncate font-mono text-xs" title={row.repos}>
                    {row.repos || '—'}
                  </span>
                ),
              },
              {
                id: 'exit',
                head: 'Exit criteria',
                priority: 2,
                min: 200,
                // Two lines, then the rest on hover. Exit criteria is the
                // longest cell in the table and the only one that is a
                // sentence: unclamped, the tallest one set the height of every
                // row in the graph.
                cell: (row) => (
                  <span className="line-clamp-2 text-xs" title={row.exitCriteria}>
                    <MarkdownInline text={row.exitCriteria} />
                  </span>
                ),
              },
            ]}
            rows={plan.graph ?? []}
            getRowKey={(row) => String(row.phase)}
            rowHref={(row) => phaseHref(plan.slug, row.phase)}
            /* Headers over nothing is the one reading this table must never
               have: an empty graph means `phase-graph.sh` could not parse the
               plan's own table, which is a defect in the file rather than a
               plan with no phases. */
            empty={
              <Empty
                title="No machine-readable phase graph"
                body="The engine parsed no rows out of this plan's ## Phase graph table. Read the file itself — a malformed phase cell, a missing column or a stray pipe is what this looks like."
                action={
                  <Button asChild size="sm">
                    <a href={`${planHref(plan.slug, 'source')}?view=raw`}>Read the markdown</a>
                  </Button>
                }
              />
            }
          />
          {(plan.callouts?.length ?? 0) > 0 && (
            <CardBody className="border-t border-rule">
              {plan.callouts!.map((line, i) => (
                <Markdown key={i} text={line} />
              ))}
            </CardBody>
          )}
        </Card>

        {plan.endToEnd && (
          <Card>
            <CardHeader>
              <CardTitle>End-to-end verification</CardTitle>
            </CardHeader>
            <CardBody>
              <Markdown text={plan.endToEnd} />
            </CardBody>
          </Card>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <div className="hidden justify-end lg:flex">{switcher}</div>

        <Card>
          <CardHeader>
            <CardTitle>Session budget</CardTitle>
          </CardHeader>
          <CardBody>
            <Markdown text={plan.sessionBudget.raw} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Memory</CardTitle>
            {detail.memory && (
              <span className="font-mono text-2xs break-all text-ink-faint">{detail.memory.key}</span>
            )}
          </CardHeader>
          <CardBody className={detail.memory ? 'max-h-[32rem] overflow-auto overscroll-contain' : ''}>
            {detail.memory ? (
              <Markdown text={detail.memory.text} />
            ) : (
              <p className="text-sm text-ink-faint">
                No <code className="font-mono">{detail.summary.slug}</code> memory entry found in the Claude
                memory directories.
              </p>
            )}
          </CardBody>
        </Card>

        {detail.locks.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Locks</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-1.5">
              {detail.locks.map((lock) => (
                <div key={lock.phase} className="flex items-center justify-between gap-2 text-sm">
                  <Chip mono>P{pad2(lock.phase ?? 0)}</Chip>
                  <span className="min-w-0 truncate font-mono text-xs text-ink-muted">{lock.owner}</span>
                  <span className="shrink-0 text-xs text-ink-faint">
                    {lock.expired ? 'expired' : countdown(lock.leaseUntil)}
                  </span>
                </div>
              ))}
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}
