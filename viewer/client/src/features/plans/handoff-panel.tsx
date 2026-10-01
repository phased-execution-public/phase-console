/**
 * One handoff, as its own page (`#/plan/:slug/handoff/:n`).
 *
 * The handoffs LIST folded into the phase table in control-tower phase 23 — a
 * column, a filter and a view (`?view=handoffs`) — and this page, which is the
 * baton itself, stayed.
 */

import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Badge,
  CopyButton,
  PageError,
  Skeleton,
} from '@/components/ui';
import { Markdown } from '@/components/markdown';
import { useHandoff } from '@/lib/queries';
import { phaseHref } from '@shared/routes.js';
import { OpsBadge, type WordOf } from '@/components/ui/status';
import type { PlanDetail } from '@/lib/api';

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
              <OpsBadge vocab="handoff" word={handoff.status as WordOf<'handoff'>} />
              {handoff.completed && <Badge mono>{handoff.completed}</Badge>}
              {handoff.dependsOn.length > 0 && (
                <Badge mono>depends on P{handoff.dependsOn.join(', P')}</Badge>
              )}
              {handoff.blocks.length > 0 && <Badge mono>blocks P{handoff.blocks.join(', P')}</Badge>}
              {handoff.skillsUsed.map((skill) => (
                <Badge key={skill} mono>
                  {skill}
                </Badge>
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
