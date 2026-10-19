/**
 * The next step a press answered, drawn on the card it was pressed on
 * (one-pool phase 13, #368): the words, each command in the one command
 * block, each path copyable — kept until the card goes or another press
 * replaces it (`cards/next-step.ts`).
 */

import { CodeBlock } from '@/ui/code-block';
import { Mono } from '@/ui';
import { useNextStep } from './next-step';

export function NextStepNote({ id }: { id: string }) {
  const next = useNextStep(id);
  if (!next) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="next-step" role="status">
      <p className="text-meta text-ink">{next.words}</p>
      {(next.commands ?? []).map((command) => (
        <CodeBlock key={command} code={command} testId="next-step-command" />
      ))}
      {(next.paths ?? []).map((path) => (
        <Mono key={path} value={path} copyable />
      ))}
    </div>
  );
}
