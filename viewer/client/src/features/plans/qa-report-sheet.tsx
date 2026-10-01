/**
 * The QA report sheet — open ⟺ the address says so (`?report=<phase>[:<round>]`).
 *
 * It was the QA tab's; the tab folded into the phase table in control-tower
 * phase 23, and the sheet kept its address, so a round on a run page and a
 * verdict on Insights still LINK to a report instead of printing a path. The
 * Phases tab mounts it under every view.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Sheet, SheetContent, Spinner } from '@/components/ui';
import { Markdown } from '@/components/markdown';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';

/**
 * The report itself, rendered — with a round picker over the ledger when the
 * phase has had more than one. Fetched by (phase, round) from the one route
 * that serves a report; no round means the latest the ledger records.
 */
export function QaReportSheet({
  slug,
  phase,
  round,
  rounds,
  onClose,
}: {
  slug: string;
  phase: number;
  round?: number;
  /** How many rounds the ledger records for this phase — the picker's extent. */
  rounds?: number;
  onClose: () => void;
}) {
  const [which, setWhich] = useState<number | undefined>(round);
  const query = useQuery({
    queryKey: keys.qaReport(slug, phase, which),
    queryFn: () => api.qaReport(slug, phase, which),
    retry: false,
  });
  const picker = rounds && rounds > 1 ? Array.from({ length: rounds }, (_, i) => i + 1) : [];
  const shown = query.data?.round ?? which ?? rounds;
  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        title={`QA report — phase ${phase}`}
        showTitle
        description={
          query.data?.path ? <code className="font-mono text-2xs">{query.data.path}</code> : undefined
        }
        subheader={
          picker.length ? (
            <div className="flex flex-wrap gap-1 px-3 py-2" role="group" aria-label="Round">
              {picker.map((n) => (
                <Button key={n} size="sm" aria-pressed={shown === n} onClick={() => setWhich(n)}>
                  round {n}
                </Button>
              ))}
            </div>
          ) : undefined
        }
      >
        {query.isPending ? (
          <Spinner label="Reading the report" />
        ) : query.isError || !query.data ? (
          <p className="p-3 text-2xs text-ink-faint">No report is on file for this round.</p>
        ) : (
          <div className="p-3">
            <Markdown text={query.data.text} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
