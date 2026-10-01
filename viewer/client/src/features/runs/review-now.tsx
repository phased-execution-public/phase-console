/**
 * *Review now* (control-tower phase 25): one cloud review of this run's branch,
 * pressed by a person. `POST /api/run/<slug>/ultrareview` had a CLI verb and no
 * button. It is billed work on the operator's own account, so the press asks
 * first and does exactly one review; the answer is the review's own result —
 * one that could not happen says why, and never reads as "nothing found".
 */

import { useState } from 'react';
import { ConfirmButton } from '@/components/ui';
import { api } from '@/lib/api';

type Answer = Awaited<ReturnType<typeof api.runUltraReview>>;

export function reviewAnswerText(answer: Answer): string {
  if (answer.state !== 'landed')
    return `The review could not run: ${answer.reason ?? 'no reason was given'}.`;
  const findings = answer.findings ?? 0;
  return `Reviewed phase ${answer.phase}: ${answer.verdict ?? 'done'} — ${findings} finding${findings === 1 ? '' : 's'}.`;
}

export function ReviewNow({ slug, disabled }: { slug: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <ConfirmButton
        size="sm"
        variant="ghost"
        title="Review this run’s branch now?"
        description="One cloud review of the branch as it stands, billed to your own account. It changes nothing on the branch."
        confirmLabel="Review now"
        busy={busy}
        busyLabel="Reviewing…"
        disabled={disabled || busy}
        onConfirm={() => {
          setBusy(true);
          setSaid(null);
          api
            .runUltraReview(slug)
            .then((answer) => setSaid(reviewAnswerText(answer)))
            .catch((error: Error) => setSaid(`The review could not run: ${error.message}`))
            .finally(() => setBusy(false));
        }}
      >
        Review now
      </ConfirmButton>
      {said ? (
        <span className="text-2xs text-ink-muted" data-testid="review-now-answer" role="status">
          {said}
        </span>
      ) : null}
    </span>
  );
}
