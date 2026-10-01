/**
 * The human-step card, loaded when a person's turn is first drawn
 * (control-tower phase 42).
 *
 * The inbox row is first paint; a card with its glyphs, its terminal sheet and
 * the step model's tables is not — so the row reaches it through this door,
 * and a page with no person's turn waiting never downloads it. The Tower's
 * strip has a door of its own, in its own chunk (`tower/strip.tsx`).
 */

import { lazy, Suspense } from 'react';
import type { HumanStepCardProps } from './human-step-card';

const Card = lazy(() => import('./human-step-card').then((m) => ({ default: m.HumanStepCard })));

export function LazyHumanStepCard(props: HumanStepCardProps) {
  return (
    <Suspense fallback={null}>
      <Card {...props} />
    </Suspense>
  );
}
