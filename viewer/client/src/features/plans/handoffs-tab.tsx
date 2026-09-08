import {
  Button,
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
  StateChip,
} from '@/components/ui';
import { Markdown } from '@/components/markdown';
import { useHandoff } from '@/lib/queries';
import { pad2 } from '@/lib/format';
import { handoffHref, phaseHref, planHref } from '@shared/routes.js';
import { handoffState } from './phase-panel';
import type { PlanDetail } from '@/lib/api';

/** Every handoff written for this plan, newest information first-hand. */
export function HandoffsTab({ detail }: { detail: PlanDetail }) {
  const slug = detail.summary.slug;
  const indexRows = new Map(detail.index.map((row) => [row.phase, row]));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Handoffs</CardTitle>
        <span className="text-xs text-ink-faint">
          {detail.handoffs.length} of {detail.summary.phases} phases
        </span>
      </CardHeader>
      <DataTable
        label="Handoffs"
        className="rounded-none border-0 border-t border-rule"
        columns={[
          {
            id: 'phase',
            head: '#',
            priority: 1,
            min: 56,
            identity: true,
            // No anchor of its own: `rowHref` below makes the identity cell
            // the row's real link, and an `<a>` inside that one is markup a
            // browser resolves by dropping one of them.
            cell: (handoff) => <span className="font-mono">{pad2(handoff.phase)}</span>,
          },
          {
            id: 'title',
            head: 'Title',
            priority: 1,
            min: 220,
            flex: true,
            card: 'title',
            // Clamped to one line with the whole title on hover: a handoff
            // title is prose off the file's frontmatter and runs to a sentence,
            // and one long one used to set the height of every row beside it.
            cell: (handoff) => (
              <span className="block truncate text-ink" title={handoff.title}>
                {handoff.title}
              </span>
            ),
          },
          {
            id: 'status',
            head: 'Status',
            priority: 1,
            min: 120,
            card: 'meta',
            cell: (handoff) => <StateChip state={handoffState(handoff.status)} label={handoff.status} />,
          },
          {
            id: 'completed',
            head: 'Completed',
            priority: 2,
            min: 116,
            cell: (handoff) => <span className="font-mono text-xs">{handoff.completed ?? '—'}</span>,
          },
          {
            id: 'skills',
            head: 'Skills',
            priority: 4,
            min: 132,
            cell: (handoff) => (
              <span
                className="block truncate font-mono text-2xs text-ink-faint"
                title={handoff.skillsUsed.join(', ')}
              >
                {handoff.skillsUsed.join(', ') || '—'}
              </span>
            ),
          },
          {
            id: 'size',
            head: 'Size',
            priority: 3,
            min: 76,
            align: 'end',
            cell: (handoff) => `${Math.round(handoff.bytes / 1024)}K`,
          },
          {
            id: 'index',
            head: 'Index row',
            priority: 3,
            min: 120,
            // A status word is painted like every other status word in the
            // console. It was the one place a state was printed as plain grey
            // text, which reads as a note about the row rather than a claim
            // about it — and `missing` beside it is a chip, so the two states
            // of this column did not even look like the same column.
            cell: (handoff) =>
              indexRows.has(handoff.phase) ? (
                <StateChip
                  state={handoffState(indexRows.get(handoff.phase)!.status)}
                  label={indexRows.get(handoff.phase)!.status}
                />
              ) : (
                <Chip
                  tone="warn"
                  title="INDEX.md has no row for this handoff. Re-running new-handoff.sh for the phase rebuilds it — or Repair with AI."
                >
                  missing
                </Chip>
              ),
          },
        ]}
        rows={detail.handoffs}
        getRowKey={(handoff) => String(handoff.phase)}
        rowHref={(handoff) => handoffHref(slug, handoff.phase)}
        empty={
          <Empty
            title="No handoffs yet"
            body="A handoff is written at the end of each phase — that is what lets the next session start cold."
            action={
              <Button asChild size="sm">
                <a href={planHref(slug, 'route')}>See the boot prompts</a>
              </Button>
            }
          />
        }
      />
    </Card>
  );
}

/** One handoff, rendered whole — it is the baton, so nothing is summarised. */
export function HandoffPanel({ detail, phase }: { detail: PlanDetail; phase: string | undefined }) {
  const slug = detail.summary.slug;
  const { data: handoff, error, isPending, refetch } = useHandoff(slug, phase);

  if (error) {
    return <PageError error={error} retry={refetch} />;
  }

  if (isPending || !handoff) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-16" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader className="flex-wrap">
          <div className="min-w-0">
            <CardTitle className="normal-case">
              Phase {handoff.phase} — {handoff.title}
            </CardTitle>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <StateChip state={handoffState(handoff.status)} label={handoff.status} />
              {handoff.completed && <Chip mono>{handoff.completed}</Chip>}
              {handoff.dependsOn.length > 0 && <Chip mono>depends on P{handoff.dependsOn.join(', P')}</Chip>}
              {handoff.blocks.length > 0 && <Chip mono>blocks P{handoff.blocks.join(', P')}</Chip>}
              {handoff.skillsUsed.map((skill) => (
                <Chip key={skill} mono>
                  {skill}
                </Chip>
              ))}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button asChild size="sm">
              <a href={phaseHref(slug, handoff.phase)}>Phase</a>
            </Button>
            <CopyButton text={handoff.body} label="Copy markdown" />
          </div>
        </CardHeader>
        <CardBody>
          <Markdown text={handoff.body} />
        </CardBody>
      </Card>

      {handoff.keyFiles?.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Key files</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-0.5">
            {handoff.keyFiles.map((file) => (
              <code key={file} className="font-mono text-xs break-all text-ink-muted">
                {file}
              </code>
            ))}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
