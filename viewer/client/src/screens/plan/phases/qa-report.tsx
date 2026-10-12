/**
 * The QA report sheet — open ⟺ the address says so (`?report=<phase>[:<round>]`,
 * `qaReportHref`), so a round on a run page or a verdict on Insights links to
 * the report itself instead of printing a path (7.0, quiet-console phase 10).
 */

import { useState } from 'react';
import { useQaReport } from '@/data/plans';
import { usePhone } from '@/lib/media';
import { Button, ButtonGroup, Mono, Spinner } from '@/ui';
import { Markdown } from '@/ui/markdown';
import { Sheet, SheetContent } from '@/ui/sheet';

/**
 * The report, rendered, with a round picker over the ledger when the phase has
 * had more than one. Fetched by (phase, round) from the one route that serves
 * a report; no round means the latest the ledger records. An end sheet on a
 * desk, a bottom sheet on a phone.
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
  round?: number | undefined;
  /** How many rounds the ledger records for this phase — the picker's extent. */
  rounds?: number | undefined;
  onClose: () => void;
}) {
  const [which, setWhich] = useState<number | undefined>(round);
  const report = useQaReport(slug, phase, which);
  const phone = usePhone();
  const picker = rounds && rounds > 1 ? Array.from({ length: rounds }, (_, i) => i + 1) : [];
  const shown = report.data?.round ?? which ?? rounds;
  const path = report.data?.path;
  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side={phone ? 'bottom' : 'end'}
        title={`QA report for phase ${phase}`}
        showTitle
        data-testid="qa-report-sheet"
        // The path describes the sheet; until it is read, nothing does, and the
        // dialog must not point at a description that is not there.
        {...(path
          ? { description: <Mono value={path} className="wrap-anywhere" /> }
          : { 'aria-describedby': undefined })}
        subheader={
          picker.length ? (
            <div className="py-2">
              <ButtonGroup aria-label="Round">
                {picker.map((n) => (
                  <Button
                    key={n}
                    size="sm"
                    variant="ghost"
                    aria-pressed={shown === n}
                    onClick={() => setWhich(n)}
                  >
                    Round {n}
                  </Button>
                ))}
              </ButtonGroup>
            </div>
          ) : undefined
        }
      >
        {report.isPending ? (
          <Spinner label="Reading the report" />
        ) : report.isError || !report.data ? (
          <p className="text-body text-ink-muted">No report is on file for this round.</p>
        ) : (
          <Markdown text={report.data.text} />
        )}
      </SheetContent>
    </Sheet>
  );
}
