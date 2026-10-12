/**
 * Which run a section reads — the plan, its run and, for the journal, a phase
 * — shared by Journal, Timeline and Git.
 *
 * ```
 * Plan quiet-console ▾   Run a0de94f27bb4 ▾   Phase 7 ▾        Export this run
 * ```
 *
 * The plans offered are the ones that have run: read off the slim run list
 * every page already holds, finished runs included, because a plan that never
 * ran has no journal to draw and offering it reads as a broken picker. A plan
 * the address names is offered even when the list has not heard of it — a
 * pasted link is answered, never blanked. The runs are the plan's journal
 * directory, newest first, so a finished run is as readable as a live one.
 */

import { useMemo, type ReactNode } from 'react';
import { useDebugRuns } from '@/data/logs';
import { useRunList } from '@/data/runs';
import { cn } from '@/lib/cn';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';

/** Every plan that has a run on record, sorted, the address's own first if the list lacks it. */
export function usePlansThatRan(named?: string): string[] {
  const { data } = useRunList();
  return useMemo(() => {
    const seen = new Set<string>();
    for (const run of data ?? []) seen.add(run.slug);
    if (named) seen.add(named);
    return [...seen].sort();
  }, [data, named]);
}

/** The run a section reads: the address's, else the plan's newest. */
export function useRunPick(query: Readonly<Record<string, string>>) {
  const plans = usePlansThatRan(query.slug || undefined);
  const slug = query.slug || plans[0] || '';
  const runs = useDebugRuns(slug || undefined);
  const runId = query.run || runs.data?.runs[0] || undefined;
  return { plans, slug, runId, runs: runs.data?.runs ?? [], runsPending: Boolean(slug) && runs.isPending };
}

/** One labelled choice: the word, then what is chosen — "Plan quiet-console". */
function Pick({
  label,
  value,
  options,
  onChange,
  placeholder,
  className,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={!options.length}>
      <SelectTrigger aria-label={label} className={cn('w-full sm:w-auto sm:min-w-40', className)}>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="text-ink-muted">{label}</span>
          <span className="min-w-0 truncate">
            <SelectValue placeholder={placeholder} />
          </span>
        </span>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The pickers, on one line that wraps — a phone stacks them. Choosing a plan
 * drops the run and the phase, which named things in the old plan; choosing a
 * run drops the phase for the same reason.
 */
export function RunPick({
  plans,
  slug,
  runs,
  runId,
  phases,
  phase,
  onChange,
  action,
}: {
  plans: readonly string[];
  slug: string;
  runs: readonly string[];
  runId: string | undefined;
  /** The journal's phase choice; absent, no phase picker. */
  phases?: readonly number[];
  phase?: string;
  onChange: (next: { slug?: string; run?: string; phase?: string }) => void;
  /** The section's one act about this run, at the line's end. */
  action?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="run-pick">
      <Pick
        label="Plan"
        value={slug}
        options={plans.map((one) => ({ value: one, label: one }))}
        onChange={(next) => onChange({ slug: next, run: undefined, phase: undefined })}
        placeholder="none has run"
        className="sm:min-w-48"
      />
      <Pick
        label="Run"
        value={runId ?? ''}
        options={runs.map((one) => ({ value: one, label: one }))}
        onChange={(next) => onChange({ slug, run: next, phase: undefined })}
        placeholder="the newest"
      />
      {phases && (
        <Pick
          label="Phase"
          value={phase ?? ''}
          options={phases.map((one) => ({ value: String(one), label: `Phase ${one}` }))}
          onChange={(next) => onChange({ slug, run: runId, phase: next })}
          placeholder="pick one"
          className="sm:min-w-32"
        />
      )}
      {action != null && <div className="flex min-w-0 items-center sm:ms-auto">{action}</div>}
    </div>
  );
}
