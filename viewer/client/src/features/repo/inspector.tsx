/**
 * The L2/L3 inspector every row in this destination opens.
 *
 * Its own module, not the page's, because the page composes the six sections and
 * each section opens one of these — a section importing the page back would be a
 * cycle. (The sections are not lazy: they ride in the destination's own chunk,
 * and `index.tsx` says why at length.)
 *
 * `record` is not optional and that is deliberate: this destination's whole
 * claim is that it shows you the repository rather than telling you about it, so
 * every object it draws can be read as the server sent it (L3). `meta` carries
 * the badges the row already wore, so an inspector never contradicts the row
 * that opened it.
 */

import type { ReactNode } from 'react';
import { Inspector } from '@/components/ui';

export function RepoInspector({
  open,
  onClose,
  title,
  description,
  meta,
  record,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  meta?: ReactNode;
  /** L3 — the server's own record, verbatim. */
  record: unknown;
  children?: ReactNode;
}) {
  return (
    <Inspector
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title}
      {...(description !== undefined ? { description } : {})}
      {...(meta !== undefined ? { meta } : {})}
      raw={<pre className="overflow-x-auto font-mono text-2xs">{JSON.stringify(record, null, 2)}</pre>}
    >
      {children}
    </Inspector>
  );
}
