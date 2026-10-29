/**
 * A person's step, deferred at its tool call (measured-console phase 12, B2).
 *
 * Under `humanStepMode: defer` the run's `PreToolUse` hook answers `defer` to
 * the Bash call that carries `phase-outcome.sh <slug> <N> needs-human …`: the
 * CLI ends the turn with `stop_reason: tool_deferred` and keeps the call
 * (`deferred_tool_use`), so the session stops exactly where it asked. The
 * console raises the person's item FROM THE CALL — it runs its own copy of
 * the script with the call's words, so the declaration is the one the script
 * would have written, validated, guarded and probed — and the phase parks as
 * a `needs-human` always has. When the person's check passes, `--resume`
 * fires the same hook again for the same `tool_use_id`, and the hook answers
 * `allow` with `updatedInput` carrying `--resumed-with <the answer>`: the
 * script prints the answer, declares nothing and exits 0, and the session
 * carries on from the call it made.
 *
 * Only a call this module can READ is deferred — one statement, the script and
 * its words, nothing computed, nothing redirected, nothing beside it. Anything
 * else takes the 8.0 path: the call runs, the declaration parks the phase, a
 * resume answers. Never a way to run more than the console's own script.
 */

import { basename } from 'node:path';

import { readShell } from './shell-reading.ts';

/** The shells a declaration is run through; the script is the next word. */
const SHELLS = new Set(['bash', '/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash']);

/** `$PE_SCRIPTS/phase-outcome.sh`, `${PE_SCRIPTS}/…`, `${PE_SCRIPTS:-<dir>}/…` — the boot prompt's spellings. */
const SCRIPTS_WORD = /^(?:\$PE_SCRIPTS|\$\{PE_SCRIPTS(?::-[^}$`]*)?\})\/phase-outcome\.sh$/;

/**
 * The arguments of a `phase-outcome.sh … needs-human` call for THIS phase, as
 * the script would receive them (`<slug> <N> needs-human …`) — or null for a
 * call that is not one, or not one this reader can vouch for.
 */
export function deferableDeclaration(command: unknown, expect: { slug: string; phase: number }): string[] | null {
  if (typeof command !== 'string' || !command.trim() || command.length > 20_000) return null;
  const reading = readShell(command);
  if (reading.commands.length !== 1 || reading.assignments || reading.functions.length || reading.opaque.length
    || reading.heredocs.length || reading.writes.length) return null;
  const [call] = reading.commands;
  if (!call.top || call.substitutions.length || call.runsItsArgument) return null;
  const [shell, script, ...args] = call.words;
  if (!SHELLS.has(shell ?? '') || !script) return null;
  const scripted = SCRIPTS_WORD.test(script) || (basename(script) === 'phase-outcome.sh' && !script.includes('$'));
  if (!scripted) return null;
  // Nothing but the script's own word may be a value only the shell knows.
  if (args.some((word) => word.includes('$') || word.includes('`'))) return null;
  const [slug, phase, status] = args;
  if (slug !== expect.slug || phase !== String(expect.phase) || status !== 'needs-human') return null;
  if (args.includes('--resumed-with')) return null;
  return args;
}

/** One word for a shell, single-quoted: what `updatedInput` appends. */
export function shellWord(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** The longest answer handed back through `--resumed-with`. */
export const RESUMED_WITH_MAX = 2_000;

/** The deferred call, run again on the resume with the person's answer — `allow`'s `updatedInput`. */
export function resumedCommand(command: string, answer: string): string {
  const words = answer.replace(/\s+/g, ' ').trim().slice(0, RESUMED_WITH_MAX) || 'the person’s step is done';
  return `${command.trimEnd()} --resumed-with ${shellWord(words)}`;
}
