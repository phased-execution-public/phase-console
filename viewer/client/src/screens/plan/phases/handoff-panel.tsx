/**
 * One handoff, as its own page — `#/plan/:slug/handoff/:n` (7.0, quiet-console
 * phase 10).
 *
 * The baton itself, rendered whole: nothing here is summarised, because the
 * next session reads exactly this file and a person checking what it was told
 * should read the same words. The handoffs LIST is a reading of the phases
 * grid (`?view=handoffs`); this page is the document it links to.
 *
 * It asks `GET /api/plans/<slug>/handoff/<n>` itself, so the plan around it
 * needs no projection for it (`TAB_INCLUDES.handoff` is empty).
 */

import { Fragment } from 'react';
import type { PlanDetail } from '@/data/api';
import { useHandoff } from '@/data/plans';
import { Button, Empty, Mono, SectionHeading, Skeleton } from '@/ui';
import { CopyButton } from '@/ui/copy-button';
import { Markdown } from '@/ui/markdown';
import { OpsStatus, type WordOf } from '@/ui/status';
import { phaseHref } from '@/shell/routes';
import { PhaseLink } from './cells';

/** Phases as links, comma-separated — a handoff's place in the graph. */
function PhaseLinks({ slug, phases }: { slug: string; phases: readonly number[] }) {
  return (
    <>
      {phases.map((phase, i) => (
        <Fragment key={phase}>
          {i > 0 ? ', ' : ''}
          <PhaseLink slug={slug} phase={phase} />
        </Fragment>
      ))}
    </>
  );
}

export function HandoffPanel({ detail, phase }: { detail: PlanDetail; phase: string | undefined }) {
  const slug = detail.summary.slug;
  const { data: handoff, error, isPending, refetch } = useHandoff(slug, phase);

  if (error) {
    return (
      <Empty
        title={error.message || 'The handoff could not be read, and the server said nothing more.'}
        action={
          <Button size="sm" onClick={() => void refetch()}>
            Read it again
          </Button>
        }
      />
    );
  }

  if (isPending || !handoff) {
    return (
      <div className="flex min-w-0 flex-col gap-3" aria-busy="true" aria-label="Reading the handoff">
        <Skeleton className="h-7 w-72 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <article className="flex min-w-0 flex-col gap-6" data-testid="handoff-page">
      <header className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <h1 className="min-w-0 max-w-(--measure) break-words text-title font-semibold text-ink">
            <span className="text-ink-muted">Phase {handoff.phase}</span> {handoff.title}
          </h1>
          <span className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm">
              <a href={phaseHref(slug, handoff.phase)}>Open phase {handoff.phase}</a>
            </Button>
            <CopyButton text={handoff.body} label="Copy the markdown" />
          </span>
        </div>
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1 text-meta text-ink-muted">
          <OpsStatus vocab="handoff" word={handoff.status as WordOf<'handoff'>} />
          {handoff.completed && <span>completed {handoff.completed}</span>}
          {handoff.dependsOn.length > 0 && (
            <span>
              depends on <PhaseLinks slug={slug} phases={handoff.dependsOn} />
            </span>
          )}
          {handoff.blocks.length > 0 && (
            <span>
              blocks <PhaseLinks slug={slug} phases={handoff.blocks} />
            </span>
          )}
          {handoff.skillsUsed.length > 0 && (
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              skills used
              {handoff.skillsUsed.map((skill) => (
                <Mono key={skill} value={skill} />
              ))}
            </span>
          )}
        </p>
      </header>

      <Markdown text={handoff.body} className="min-w-0 max-w-(--measure)" />

      {handoff.keyFiles?.length > 0 && (
        <section aria-label="Key files" className="flex min-w-0 flex-col gap-2">
          <SectionHeading>Key files</SectionHeading>
          <ul className="flex min-w-0 flex-col gap-0.5">
            {handoff.keyFiles.map((file) => (
              <li key={file} className="min-w-0 wrap-anywhere">
                <Mono value={file} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
