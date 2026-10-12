/**
 * What Repo's sections share (7.0, quiet-console phase 17): the failed read,
 * the loading shape, and the repository picker every git section carries in
 * its toolbar's Filter slot.
 */

import { Fragment, useId, type MouseEvent, type ReactNode } from 'react';
import { ApiError, type RepoTarget, type RepoTargetKind } from '@/data/api';
import { useRepoTargets } from '@/data/repo';
import { cn } from '@/lib/cn';
import { navigate } from '@/shell/routes';
import { Banner, Button, Skeleton } from '@/ui';
import { rowClickNavigates } from '@/ui/grid/card-list';
import { RadioGroup, RadioItem } from '@/ui/radio-group';
import { repoSectionHref, type RepoSectionId } from './routes';

/** The HTTP status a failed read carried, when it carried one. */
export const statusOf = (error: unknown): number | undefined =>
  error instanceof ApiError ? error.status : undefined;

/** A read that failed: the server's own words and a way out — never a blank, never "no data". */
export function ReadError({
  error,
  retry,
  children,
}: {
  error: unknown;
  retry: () => void;
  children?: ReactNode;
}) {
  const said = error instanceof Error && error.message ? error.message : 'The read failed and said nothing.';
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="repo-read-error">
      <Banner
        severity="error"
        action={
          <Button size="sm" variant="ghost" onClick={retry}>
            Try again
          </Button>
        }
      >
        {said}
      </Banner>
      {children}
    </div>
  );
}

/** Rows that have not arrived yet — a shape, never a sentence about nothing. */
export function RowsLoading({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label={label}>
      <Skeleton className="h-8 max-w-sm" />
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-7" />
      ))}
    </div>
  );
}

/** A target's kind, said — the picker's line under each name. */
const KIND_WORDS: Readonly<Record<RepoTargetKind, string>> = {
  root: 'The repository this console opened',
  submodule: 'A submodule of it',
  linked: 'A linked working tree',
  mount: 'A repository mounted into a run',
};

/**
 * The repositories a git section may be about — `GET /api/repo/targets`.
 * A key, never a directory: an unknown key is a 404 rather than a quiet fall
 * back to the root, which is what makes a pasted link right or visibly wrong.
 */
export function useTargets(): readonly RepoTarget[] {
  return useRepoTargets().data?.targets ?? [];
}

/** The picked target's name, for a toolbar's note — the root's label when none is named. */
export function targetLabel(targets: readonly RepoTarget[], key: string | undefined): string | undefined {
  const found = targets.find((t) => t.key === (key ?? 'root'));
  return found?.label ?? key;
}

/**
 * The repository picker, as a panel of the toolbar's Filter slot. Choosing one
 * keeps the section and drops what belonged to the old repository — a commit,
 * a ref, a range, a file — because none of it names anything in the new one.
 */
export function TargetPanel({
  section,
  current,
  targets,
}: {
  section: RepoSectionId;
  current: string | undefined;
  targets: readonly RepoTarget[];
}) {
  const id = useId();
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-2 text-meta text-ink-muted">Repository</legend>
      <RadioGroup
        aria-label="Which repository"
        value={current ?? 'root'}
        onValueChange={(key) =>
          navigate(repoSectionHref(section, { repo: key === 'root' ? undefined : key }))
        }
        data-testid="repo-target"
      >
        {targets.map((target) => (
          <RadioItem
            key={target.key}
            id={`${id}-${target.key}`}
            value={target.key}
            label={target.label}
            description={KIND_WORDS[target.kind] ?? target.kind}
          />
        ))}
      </RadioGroup>
    </fieldset>
  );
}

/**
 * A grid row's props for a record whose link the address may already name:
 * following that link moves nothing, so the row opens the panel itself. A
 * capture listener, so the grid's own click — which follows the link — runs
 * as well, and a control inside the row (a fold, a copy) is left alone.
 */
export function reopens(href: string, open: () => void) {
  return {
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      const onLink = (event.target as HTMLElement | null)?.closest('a[data-row-link]');
      if (!onLink && !rowClickNavigates(event)) return;
      if (window.location.hash === href) open();
    },
  };
}

/** One choice of a toolbar panel: a labelled radio group, each option with the line that says what it means. */
export function PanelChoices<V extends string>({
  name,
  value,
  options,
  onChange,
  testId,
}: {
  name: string;
  value: V;
  options: readonly { id: V; label: ReactNode; blurb?: string }[];
  onChange: (value: V) => void;
  testId?: string;
}) {
  const id = useId();
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-2 text-meta text-ink-muted">{name}</legend>
      <RadioGroup
        aria-label={name}
        value={value}
        onValueChange={(next) => onChange(next as V)}
        data-testid={testId}
      >
        {options.map((option) => (
          <RadioItem
            key={option.id}
            id={`${id}-${option.id}`}
            value={option.id}
            label={option.label}
            description={option.blurb}
          />
        ))}
      </RadioGroup>
    </fieldset>
  );
}

/**
 * A path that may break after any slash. Truncated, a long path on a phone
 * loses its end, which is the file's own name; broken anywhere, it splits a
 * folder's name in two. So a line ends at a slash, and a segment breaks only
 * when it is wider than the line by itself.
 */
export function PathWords({ path, title, className }: { path: string; title?: string; className?: string }) {
  const parts = path.split('/');
  return (
    <code
      className={cn('min-w-0 break-words font-mono text-meta text-ink-muted', className)}
      title={title ?? path}
    >
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 && (
            <>
              /<wbr />
            </>
          )}
        </Fragment>
      ))}
    </code>
  );
}
