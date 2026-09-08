import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { usePhone } from '@/lib/media';
import { Disclosure } from './disclosure';
import { SectionHeading } from './section-heading';
import { Sheet, SheetContent, type SheetSide } from './sheet';

/**
 * The inspector — the disclosure ladder's L2 surface (`docs/design.md`).
 *
 * Every record in this console (a run, a phase, a lock, a delivery) owes the
 * operator a full structured account of itself, one interaction from wherever
 * it is summarized. The sheets that grew for this each arranged their own
 * header, their own padding and their own way (or no way) down to the raw
 * record. This is that arrangement, made once:
 *
 *   header   the record's NAME (always visible — an inspector that hides its
 *            title is a drawer full of unattributed facts) + optional prose
 *   meta     the record's identity row — badges, ids, times — first in the body
 *   body     the caller's sections (`InspectorSection` for the eyebrows),
 *            padded by the density tokens so compact reaches inspectors too
 *   raw      L3, one rung down: the record as the machine holds it, behind a
 *            Disclosure that names it "Raw record"
 *
 * A phone gets the bottom edge, a desk the right — the same rule the ad-hoc
 * sheets each rediscovered; `side` overrides for the exceptions.
 */
export function Inspector({
  open,
  onOpenChange,
  title,
  description,
  meta,
  raw,
  side,
  className,
  bodyClassName,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The record's name. Always shown — this is a surface about something. */
  title: string;
  /** One sentence under the name, when the name is not enough. */
  description?: ReactNode;
  /** The identity row: badges, `MonoId`s, times. Renders first in the body. */
  meta?: ReactNode;
  /** L3 — the raw record. Behind "Raw record"; give it `font-mono text-2xs`. */
  raw?: ReactNode;
  /** Overrides the phone-bottom / desk-right default. */
  side?: SheetSide;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}) {
  const phone = usePhone();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={title}
        side={side ?? (phone ? 'bottom' : 'right')}
        showTitle
        {...(description != null ? { description } : {})}
        className={className}
        bodyClassName={cn('px-(--pad-x) py-(--pad-y)', bodyClassName)}
      >
        {meta != null && <div className="mb-3 flex flex-wrap items-center gap-2">{meta}</div>}
        {children}
        {raw != null && (
          <Disclosure label="Raw record" className="mt-4 border-t border-rule pt-3">
            <div className="mt-2 min-w-0 overflow-x-auto">{raw}</div>
          </Disclosure>
        )}
      </SheetContent>
    </Sheet>
  );
}

/**
 * A band inside an inspector: eyebrow + rows. The eyebrow is `SectionHeading`
 * at its `band` size — an inspector is a page in miniature and keeps the
 * page's own signposting, not a private dialect of it.
 */
export function InspectorSection({
  heading,
  children,
  className,
}: {
  heading: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('mt-4 first:mt-0', className)}>
      <SectionHeading as="h3" size="band" className="mb-2">
        {heading}
      </SectionHeading>
      {children}
    </section>
  );
}
