/**
 * A session, in full — L2 and L3 for the sessions surface.
 *
 * The list draws four different kinds of process through one `SessionRow`: a
 * lane the autopilot is driving, a pty this console owns, an agent, and a
 * registry record for a session running somewhere else. That flattening is what
 * lets them be read together, and it is exactly what an operator needs to see
 * past the moment a row does not say what they expected — a lane, a pty and a
 * registry record answer different questions, and none of them survives the
 * flattening whole.
 *
 * So the facts here are the row's, and the RECORD underneath is the raw rung.
 * `docs/design.md` §1: full structured detail one interaction from where the
 * record is summarized, and the machine's own version one rung below that.
 *
 * Nothing is fetched. Every session surface already holds its rows — the page,
 * the strip's sheet, the run page's "elsewhere" list — and a sheet that went
 * back to the server for what its caller is already rendering would be a second
 * answer with its own staleness.
 */

import {
  Chip,
  Duration,
  Inspector,
  InspectorSection,
  KeyValue,
  MonoId,
  RelativeTime,
  StatusBadge,
} from '@/components/ui';
import { TaskLine } from '@/features/runs/task-summary';
import { KIND_LABEL, type SessionRow } from './list';

export function SessionInspector({
  row,
  open,
  onOpenChange,
}: {
  row: SessionRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Only a pty this console minted carries QA metadata; a lane row's `record`
  // is a rung, and a foreign session's is somebody else's. Read defensively for
  // the same reason `row.record` is rendered raw: the shape is a union.
  const qa = (
    row.record as
      | {
          meta?: {
            qa?: {
              slug: string;
              phase: number;
              before?: string;
              round?: number;
              report?: string;
            };
          };
        }
      | undefined
  )?.meta?.qa;
  return (
    <Inspector
      open={open}
      onOpenChange={onOpenChange}
      title={row.label}
      description={row.detail}
      meta={
        <>
          {row.state && <StatusBadge state={row.state} label={row.note ?? (row.live ? 'live' : 'ended')} />}
          <Chip tone="neutral">{KIND_LABEL[row.kind]}</Chip>
          {/* Two different ids, and the distinction is load-bearing: `id` is a
              pty THIS console owns and can close, `sessionId` is a Claude
              conversation that may be running on another machine entirely. A
              sheet that printed one "id" would erase that. */}
          {row.id && <MonoId id={row.id} />}
          {row.sessionId && row.sessionId !== row.id && <MonoId id={row.sessionId} />}
        </>
      }
      raw={
        row.record == null ? undefined : (
          <pre className="m-0 font-mono text-2xs whitespace-pre-wrap">
            {JSON.stringify(row.record, null, 2)}
          </pre>
        )
      }
    >
      <InspectorSection heading="What it is">
        <KeyValue
          items={[
            ['Kind', KIND_LABEL[row.kind]],
            /* Not "Where": three of the four kinds put a working directory in
               `detail`, but a LANE puts its phase title there (`list.tsx`). One
               label for both, and it names what the row is showing rather than
               what three of them happen to be. */
            ['What it is working on', row.detail],
            ['Standing', row.live ? 'live' : 'not running'],
            ['Note', row.note],
            // Named for what it means rather than for its field: a person is
            // being waited for, and which kind of answer decides what to do.
            [
              'Waiting on you',
              row.attention
                ? row.attention.kind === 'permission'
                  ? 'a permission card'
                  : 'an answer'
                : null,
            ],
            ['Since', row.attention?.since ? <RelativeTime at={Date.parse(row.attention.since)} /> : null],
          ]}
        />
      </InspectorSection>

      <InspectorSection heading="Clocks">
        {/* Two instants, and they are different questions for three of the four
            kinds — `startedAt` is the LAST thing that happened, `createdAt` is
            when it began. The list shows one; a sheet that also showed one
            would drop the half that answers "how long has this been going". */}
        <KeyValue
          items={[
            [
              'Began',
              row.createdAt != null && Number.isFinite(row.createdAt) ? (
                <RelativeTime at={row.createdAt} />
              ) : null,
            ],
            [
              'Last heard',
              row.startedAt != null && Number.isFinite(row.startedAt) ? (
                <RelativeTime at={row.startedAt} />
              ) : null,
            ],
            [
              'Running for',
              row.live && row.createdAt != null && Number.isFinite(row.createdAt) ? (
                <Duration since={row.createdAt} live />
              ) : null,
            ],
          ]}
        />
      </InspectorSection>

      {qa ? (
        <InspectorSection heading="What it is reviewing">
          {/* A QA session decides whether every phase depending on this one may
              start, and it costs money — and until this it was the least
              inspectable thing the console spent on: which phase, which round
              and which report were knowable only from the prompt it was handed.
              `before` is the snapshot taken at mint time, which is what turns
              "it ended" into "it recorded something". */}
          <KeyValue
            items={[
              ['Plan', qa.slug],
              ['Phase', String(qa.phase)],
              ['Round', qa.round ? String(qa.round) : null],
              ['Report it writes', qa.report ? <code className="font-mono">{qa.report}</code> : null],
              ['Verdict before it started', qa.before ?? 'none recorded'],
            ]}
          />
        </InspectorSection>
      ) : null}

      {row.tasks?.length ? (
        <InspectorSection heading="What it says it is doing">
          {/* The one thing on the row the SESSION wrote, rather than something
              the console inferred about it. */}
          <TaskLine tasks={row.tasks} className="flex" />
        </InspectorSection>
      ) : null}
    </Inspector>
  );
}
