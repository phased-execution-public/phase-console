/**
 * The console's classifier, asked from a shell (measured-console phase 6, C4).
 *
 * `scripts/guard-hook.sh` is the run's LOCAL `PreToolUse` command hook — the
 * second layer beside the HTTP one, which is the console's and answers nothing
 * while the console is down. It pipes the hook's input here, and this answers
 * what the HTTP hook's own guards would: a write to a protected file or a
 * test's deletion (`protectedFileCall`), and a forged gate approval
 * (`gateForgeCall`) — the deterministic denies, which need no run, no card and
 * no person. Anything else is the HTTP hook's to decide, so it answers `{}`:
 * no decision, and the other hooks' and the CLI's own rules stand.
 *
 * `PE_MAY_DELETE_TESTS=yes` (the runner sets it for a phase whose plan section
 * says `- **May delete tests:** yes`) lifts the test half, as the HTTP hook's
 * own read of the phase does. Input that does not parse is a deny: the hook
 * blocks on failure, and a guard that cannot read the call cannot clear it.
 */
import { GATE_FORGE_RULE, gateForgeCall, PROTECTED_FILE_RULE, protectedFileCall } from './approvals.ts';

export type GuardAnswer = Record<string, unknown>;

/** What the local hook answers for one hook input. */
export function guardAnswer(raw: string, env: NodeJS.ProcessEnv = process.env): GuardAnswer {
  let body: { tool_name?: unknown; tool_input?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return deny('blocked by the console\'s local guard: the hook input did not parse');
  }
  const toolName = typeof body?.tool_name === 'string' ? body.tool_name : '';
  const input = body?.tool_input;
  const guarded = protectedFileCall(toolName, input, { mayDeleteTests: env.PE_MAY_DELETE_TESTS === 'yes' });
  if (guarded) return deny(`blocked by the console (rule: ${PROTECTED_FILE_RULE}): ${guarded}.`);
  const forged = gateForgeCall(toolName, input);
  if (forged) return deny(`blocked by the console (rule: ${GATE_FORGE_RULE}): ${forged}.`);
  return {};
}

function deny(reason: string): GuardAnswer {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

if (import.meta.main) {
  const chunks: Buffer[] = [];
  process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
  process.stdin.on('end', () => {
    process.stdout.write(`${JSON.stringify(guardAnswer(Buffer.concat(chunks).toString('utf8')))}\n`);
  });
}
