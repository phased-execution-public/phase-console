/**
 * The human-step card, loaded when a person's turn is first drawn
 * (control-tower phase 42).
 *
 * A row that may hold a person's turn is cheap; the card — its glyphs, its
 * terminal sheet, the step model's tables — is not, so a surface reaches it
 * through this door, and a page with no person's turn waiting never
 * downloads it.
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
