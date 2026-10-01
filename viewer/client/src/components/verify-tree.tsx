/**
 * The tree a verification verdict ran against — `{repo, branch, head}` — as
 * one line (control-tower phase 24, #41).
 *
 * A verdict read without it cannot say WHICH checkout it judged: #41's drift
 * gate compared the box against a sibling run's branch and failed a phase
 * whose build and deploy were green. Phase 40 stamped every verdict on the
 * server (`VerifyRun.tree`, `VerifySummary.trees`) and phase 17 drew the stamp
 * on the halt card; this is that line, shared by every verdict the run page and
 * its drawer draw, so no verdict reads without the tree beside it.
 */

import { cn } from '@/lib/cn';

export interface VerifyTreeStamp {
  repo: string;
  branch: string | null;
  head: string | null;
}

/** The stamp a verdict stands on: its verify-in tree, else the first command's, else none. */
export function verdictTree(
  verification:
    | {
        /** Each command's own stamp, where the verdict carries one (`VerifyRun.tree`). */
        ran?: readonly object[];
        trees?: readonly (VerifyTreeStamp & { role?: string })[];
      }
    | null
    | undefined,
): VerifyTreeStamp | null {
  const stamps = verification?.trees ?? [];
  const commands = (verification?.ran ?? []) as readonly { tree?: VerifyTreeStamp | null }[];
  return (
    stamps.find((stamp) => stamp.role === 'verify-in') ??
    commands.find((command) => command.tree)?.tree ??
    stamps[0] ??
    null
  );
}

/** `on phased-execution · pe/control-tower · 1d1911ee` — detached and headless said so, never blank. */
export function treeWords(tree: VerifyTreeStamp): string {
  return `on ${tree.repo} · ${tree.branch ?? 'no branch (detached)'} · ${tree.head ? tree.head.slice(0, 8) : 'no head'}`;
}

export function TreeLine({
  tree,
  testId = 'verify-tree',
  className,
}: {
  tree: VerifyTreeStamp;
  testId?: string;
  className?: string;
}) {
  return (
    <span
      className={cn('block min-w-0 font-mono break-all text-ink-muted', className)}
      data-testid={testId}
      title="The repository, branch and commit this verdict ran against"
    >
      {treeWords(tree)}
    </span>
  );
}
