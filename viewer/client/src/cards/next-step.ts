/**
 * What a press answered that is a NEXT STEP, not a result (one-pool phase 13,
 * #368). A projected item is pressed through the inbox row's generic
 * `perform`, which used to read only `outcome` and `detail` into a toast — so a
 * *Sign this server in* whose answer was a terminal to finish the sign-in in,
 * or *Open a merge errand tree* whose answer was where the trees stand, said
 * "done" and left the card exactly as it was. This reads a verb's answer the
 * way the verb's own page does (Settings ▸ MCP's sign-in, the run page's
 * errand tree) and keeps what it says on the card it was pressed on, until
 * the card goes or another press replaces it.
 *
 * Pure reading plus a tiny store — no fetch, no query: the press itself is
 * `data/press.ts`'s.
 */

import { useSyncExternalStore } from 'react';
import type { InboxAction } from '@/data/api';

/** A next step: words to read, where to go, commands to run, paths to work in. */
export interface NextStep {
  words: string;
  /** A place the person is taken to at once — the sign-in's terminal. */
  href?: string;
  /** Commands to run by hand, kept on the card (a toast is gone before anyone reads a command). */
  commands?: string[];
  /** Where the work happens — an errand tree's checkouts. */
  paths?: string[];
}

type LoginAnswer = {
  mode?: string;
  terminal?: { sessionId?: string };
  command?: string;
  commands?: string[];
  detail?: string;
};

type TreeAnswer = { tree?: { dir?: string; mounts?: { dir?: string; path?: string }[] }; adopted?: boolean };

/**
 * The next step a press answered, or null when its answer is a result. `href`
 * is built by the caller's router (`sessionHref`), so this file names no route.
 */
export function nextStepOf(
  action: Pick<InboxAction, 'verb' | 'endpoint'>,
  result: unknown,
  sessionHref: (id: string) => string,
): NextStep | null {
  if (!result || typeof result !== 'object') return null;
  if (/\/api\/mcp\/[^/]+\/login$/.test(action.endpoint)) {
    const started = result as LoginAnswer;
    if (started.mode === 'embedded' && started.terminal?.sessionId) {
      return {
        words: 'Finish the sign-in in the terminal that just opened, then check the server again.',
        href: sessionHref(started.terminal.sessionId),
      };
    }
    if (started.mode === 'external')
      return {
        words: 'A terminal opened on the machine — finish the sign-in there, then check the server again.',
      };
    const commands = started.commands?.length ? started.commands : started.command ? [started.command] : [];
    if (commands.length) {
      return {
        words: `${started.detail ? `${started.detail.replace(/\.$/, '')}. ` : ''}No sign-in could start here — run this in a terminal on the machine, then check the server again.`,
        commands,
      };
    }
    return null;
  }
  if (/\/errand-tree$/.test(action.endpoint) || action.verb === 'errand-tree') {
    const answer = result as TreeAnswer;
    const dir = answer.tree?.dir;
    if (!dir) return null;
    const mounts = (answer.tree?.mounts ?? [])
      .map((mount) => mount.dir ?? mount.path)
      .filter((path): path is string => Boolean(path));
    return {
      words: `${answer.adopted ? 'The errand tree stands' : 'The errand tree is ready'} at ${dir}. Next: merge origin/main there, land the result, then press Recover & continue.`,
      paths: [dir, ...mounts.filter((path) => path !== dir)],
    };
  }
  const told = result as { outcome?: string; detail?: string; next?: string };
  if (typeof told.next === 'string' && told.next.trim()) return { words: told.next.trim() };
  // A recover that found a person is needed says what next in its detail: it
  // stays on the card, not in a toast.
  if ((told.outcome === 'errand' || told.outcome === 'nothing-to-do') && told.detail)
    return { words: told.detail };
  return null;
}

/* ---- the store: one next step per item, until it is replaced or cleared ---- */

const steps = new Map<string, NextStep>();
const listeners = new Set<() => void>();
const tell = () => {
  for (const listener of listeners) listener();
};

/** Keep `step` on the item `id`, or clear it with null. */
export function setNextStep(id: string, step: NextStep | null): void {
  if (step) steps.set(id, step);
  else steps.delete(id);
  tell();
}

/** The next step kept on an item, read live. */
export function useNextStep(id: string): NextStep | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => steps.get(id),
    () => undefined,
  );
}
