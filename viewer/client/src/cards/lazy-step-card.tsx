/**
 * The one card, loaded when a person's turn is first drawn from its inbox row
 * (control-tower phase 42; the door to `item-card.tsx`'s `StepCard` since
 * measured-console phase 32 folded the human-step card into it).
 *
 * A row that may hold a person's turn is cheap; the card — its glyphs, its
 * terminal sheet, the step model's tables, the item card's act forms — is
 * not, so a surface reaches it through this door, and a page with no person's
 * turn waiting never downloads it.
 */

import { lazy, Suspense } from 'react';
import type { StepCardProps } from './item-card';

const Card = lazy(() => import('./item-card').then((m) => ({ default: m.StepCard })));

export function LazyStepCard(props: StepCardProps) {
  return (
    <Suspense fallback={null}>
      <Card {...props} />
    </Suspense>
  );
}
