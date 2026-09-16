/**
 * May this credential run work? — the question `claude auth status` cannot
 * answer. At CLI 2.1.270 its ten fields name the login and its organisation and
 * nothing about entitlement (chapter 11 ACT-8, [C11-3]), and the class that
 * cost $223.69 — an organisation policy refusing a credential that was signed
 * in, metered and ranked like any other — was only ever discovered by spending
 * a phase on it. So the check is the only thing that can answer: a real
 * one-turn session under the account's own environment, declared as the
 * console's.
 *
 *   claude --print ok --max-turns 1 --output-format stream-json --verbose
 *          --model haiku --strict-mcp-config --max-budget-usd 0.05
 *
 * Unlike the MCP probe (`mcp/health.ts`), which reads `system/init` and ends
 * the child before any model call, this one NEEDS the call: a policy refusal
 * is the API's answer to a request, so the session has to make one. It is
 * therefore a session with a price, and everything about it says so:
 *
 *  - **Declared.** `PE_OWNER=console/entitlement-probe` and the probe flag the
 *    presence hook forwards, so the session registry files it as the console's
 *    own child (`kindOf`: `console/…` → `agent`), keeps it out of every
 *    operator-facing total and never weakly correlates it — the MCP probe's
 *    rule (SLF-2, REG-6).
 *  - **Bounded.** One turn, the cheapest model, a budget cap, `--strict-mcp-
 *    config` with no config so no server starts, a working directory of its
 *    own so no project's CLAUDE.md is read into the turn, one retry instead of
 *    the runner's fifteen, and a clock. A refusal the CLI announces as a
 *    `system/api_retry` with a credential-class `error` ends the session at
 *    once instead of waiting out its retries.
 *  - **Classified by the runner's own words.** The stop is read into the same
 *    `StopSignal` `classify()` judges a phase by, so a probe and a phase can
 *    never disagree about what a refusal is.
 *  - **Ended through `signals.ts`**, like every console child: SIGCONT, SIGTERM
 *    to the group (the CLI runs its SessionEnd hook on it), then the SIGKILL
 *    backstop — after a short grace when the session already answered.
 *
 * This file only runs the session and reports what happened. What the answer
 * MEANS for the breaker is `Accounts.probeEntitlement`'s decision
 * (`accounts/index.ts`), because that is where the learned store is.
 */

import { spawn } from 'node:child_process';

import { log } from '../log.ts';
import { PROBE_FLAG } from '../mcp/health.ts';
import { API_RETRY_ERRORS, type StopSignal } from '../runner/errors.ts';
import { killLadder, type LadderOptions } from '../runner/signals.ts';

/** The probe's name, in the vocabulary the locks and the session registry read. */
export const ENTITLEMENT_PROBE_OWNER = 'console/entitlement-probe';

/** The cheapest model: the question is about the credential, not about any model's quality. */
export const ENTITLEMENT_PROBE_MODEL = 'haiku';

/**
 * The session's own spend cap, in dollars. A one-word answer from the cheapest
 * model costs a fraction of a cent; the cap is there so that a CLI or a model
 * that decides to do more than answer cannot turn a button into a bill.
 */
export const ENTITLEMENT_PROBE_BUDGET_USD = 0.05;

/**
 * How long the console waits for an answer. The CLI's own startup plus one
 * request and ONE retry of it; past this the check says it could not answer
 * rather than holding a person's request open.
 */
export const ENTITLEMENT_PROBE_TIMEOUT_MS = 90_000;

/** Retries of a failed request — one, where the runner allows fifteen: a slow answer is a `skip`, not a wait. */
export const ENTITLEMENT_PROBE_RETRIES = '1';

/** After the answer, how long the CLI gets to leave by itself before the ladder ends it. */
export const ENTITLEMENT_PROBE_EXIT_GRACE_MS = 5_000;

/** SIGTERM's grace before the group is SIGKILLed — the MCP probe's number, for the same one hook. */
export const ENTITLEMENT_PROBE_TERM_GRACE_MS = 3_000;

/** The `system/api_retry` errors that ARE the answer: retrying cannot change them. */
const CREDENTIAL_RETRY_ERRORS: ReadonlySet<string> = new Set(
  (API_RETRY_ERRORS as readonly string[]).filter((error) =>
    ['oauth_org_not_allowed', 'authentication_failed', 'billing_error', 'account_on_hold'].includes(error)),
);

/** How the session ended, as far as the console could tell. */
export type ProbeEnding = 'result' | 'refused-early' | 'exited' | 'timeout' | 'spawn-failed';

export type ProbeSessionOptions = {
  /** The FULL environment the child runs with — the account's env already merged by the caller. */
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs?: number;
  /** Injected in tests so no suite ever spawns a real CLI. */
  spawnFn?: typeof spawn;
  /** The ending's seams, for a test that proves the ladder runs. */
  ladder?: Pick<LadderOptions, 'signal' | 'alive' | 'sleep' | 'killAfterMs'>;
  now?: () => number;
  /** Called once the child is gone, with how it went — a test's wait handle. */
  onEnded?: (how: string) => void;
};

export type ProbeSession = {
  ending: ProbeEnding;
  /** What `classify()` reads — the same shape a phase's stop is judged by. */
  signal: StopSignal;
  argv: string[];
  ms: number;
  costUsd?: number;
  turns?: number;
  cliVersion?: string;
  model?: string;
  sessionId?: string;
  /** Why the session could not run or answer, when it could not. */
  error?: string;
};

/** The argv, in one place — what the handoff records and the test pins. */
export function probeArgv(): string[] {
  return [
    '--print', 'ok',
    '--max-turns', '1',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', ENTITLEMENT_PROBE_MODEL,
    // No config and strict: no MCP server starts, and none of the user's is
    // unioned in. The check is about the credential and nothing else.
    '--strict-mcp-config',
    '--max-budget-usd', String(ENTITLEMENT_PROBE_BUDGET_USD),
  ];
}

/**
 * The environment the child runs with: this process's, minus everything that
 * would make the child claim to be something it is not — a `PE_*`/`PHASE_*`
 * variable the console was started with, or the console's own session id —
 * then the account's env, then the declaration. The same denial rule the
 * engine's `scriptEnv` keeps, for the same reason.
 */
export function probeEnv(accountEnv: NodeJS.ProcessEnv | null, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (/^(?:PE_|PHASE_)/.test(name) || name === 'CLAUDE_CODE_SESSION_ID') continue;
    env[name] = value;
  }
  return {
    ...env,
    ...(accountEnv ?? {}),
    PE_OWNER: ENTITLEMENT_PROBE_OWNER,
    [PROBE_FLAG]: '1',
    CLAUDE_CODE_MAX_RETRIES: ENTITLEMENT_PROBE_RETRIES,
  };
}

/** Bound on the text a signal carries — the refusal sentences are short; a transcript is not wanted. */
const MAX_TEXT = 4_000;

/**
 * Run the one-turn session and report how it ended. Never rejects: a session
 * that cannot run answers `spawn-failed` with the reason, because "the check
 * could not run" and "the credential was refused" are different facts and the
 * caller must be able to tell them apart before it retires an organisation.
 */
export async function runProbeSession(opts: ProbeSessionOptions): Promise<ProbeSession> {
  const now = opts.now ?? Date.now;
  const started = now();
  const argv = probeArgv();
  const spawnFn = opts.spawnFn ?? spawn;

  return new Promise<ProbeSession>((resolve) => {
    let settled = false;
    let buffer = '';
    let stderr = '';
    const said: string[] = [];
    const retryCategories: string[] = [];
    let resultText: string | undefined;
    let subtype: string | undefined;
    let isError: boolean | undefined;
    let terminalReason: string | undefined;
    let costUsd: number | undefined;
    let turns: number | undefined;
    let cliVersion: string | undefined;
    let model: string | undefined;
    let sessionId: string | undefined;
    let exitCode: number | null | undefined;
    let closed = false;
    let child: ReturnType<typeof spawn> | null = null;

    const textOf = (): string =>
      [resultText, ...said, stderr.trim()].filter((part): part is string => Boolean(part)).join('\n').slice(-MAX_TEXT);

    const finish = (ending: ProbeEnding, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ending,
        signal: {
          ...(subtype ? { subtype } : {}),
          ...(exitCode !== undefined ? { code: exitCode } : {}),
          text: textOf(),
          retryCategories: [...retryCategories],
          model: model ?? ENTITLEMENT_PROBE_MODEL,
          ...(isError !== undefined ? { isError } : {}),
          ...(terminalReason ? { terminalReason } : {}),
        },
        argv,
        ms: Math.max(0, now() - started),
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(turns !== undefined ? { turns } : {}),
        ...(cliVersion ? { cliVersion } : {}),
        ...(model ? { model } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(error ? { error } : {}),
      });
      end(ending);
    };

    /**
     * The child's ending, which is bookkeeping once the answer is in hand.
     * A session that answered is given a moment to leave on its own — its
     * SessionEnd hook is the registry's only honest "ended" — and only then
     * laddered; one that did not answer is laddered now.
     */
    const end = (ending: ProbeEnding) => {
      let reported = false;
      const report = (how: string) => {
        if (reported) return;
        reported = true;
        opts.onEnded?.(how);
      };
      const pid = child?.pid;
      if (closed || typeof pid !== 'number' || pid <= 1) {
        report(closed ? 'exited' : 'no-pid');
        return;
      }
      const ladder = () => {
        if (closed) { report('exited'); return; }
        void killLadder(pid, {
          interrupt: false,
          killAfterMs: opts.ladder?.killAfterMs ?? ENTITLEMENT_PROBE_TERM_GRACE_MS,
          ...(opts.ladder?.signal ? { signal: opts.ladder.signal } : {}),
          ...(opts.ladder?.alive ? { alive: opts.ladder.alive } : {}),
          ...(opts.ladder?.sleep ? { sleep: opts.ladder.sleep } : {}),
        }).then((how) => {
          if (how === 'killed') log.warn('accounts.entitlement-probe.sigkill', { pid, note: 'the session ignored SIGTERM through its grace' });
          report(how);
        }, () => report('failed'));
      };
      if (ending === 'result') {
        const grace = setTimeout(ladder, ENTITLEMENT_PROBE_EXIT_GRACE_MS);
        grace.unref?.();
        child?.once('close', () => {
          clearTimeout(grace);
          report('exited');
        });
      } else {
        ladder();
      }
    };

    const timer = setTimeout(
      () => finish('timeout', `no answer within ${Math.round((opts.timeoutMs ?? ENTITLEMENT_PROBE_TIMEOUT_MS) / 1000)} s`),
      opts.timeoutMs ?? ENTITLEMENT_PROBE_TIMEOUT_MS,
    );

    try {
      child = spawnFn('claude', argv, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // A group of its own, so the ladder addresses the CLI and anything it
        // started — the shape every console child keeps.
        detached: true,
      });
    } catch (error) {
      finish('spawn-failed', (error as Error).message);
      return;
    }

    child.on('error', (error: Error) => finish('spawn-failed', error.message));

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-MAX_TEXT);
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let cut = buffer.indexOf('\n');
      while (cut >= 0) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        cut = buffer.indexOf('\n');
        if (!line.startsWith('{')) continue;
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (typeof message.total_cost_usd === 'number' && Number.isFinite(message.total_cost_usd)) {
          costUsd = message.total_cost_usd;
        }
        const type = message.type;
        const sub = typeof message.subtype === 'string' ? message.subtype : undefined;
        if (type === 'system' && sub === 'init') {
          if (typeof message.claude_code_version === 'string' && message.claude_code_version) {
            cliVersion = message.claude_code_version.slice(0, 40);
          }
          if (typeof message.model === 'string' && message.model) model = message.model;
          if (typeof message.session_id === 'string' && message.session_id) sessionId = message.session_id;
          continue;
        }
        if (type === 'system' && sub === 'api_retry') {
          // The documented `error` field and nothing else (SES-7).
          const error = typeof message.error === 'string' ? message.error : '';
          if ((API_RETRY_ERRORS as readonly string[]).includes(error)) retryCategories.push(error);
          if (CREDENTIAL_RETRY_ERRORS.has(error)) {
            const detail = typeof message.message === 'string' ? message.message : error;
            said.push(detail);
            finish('refused-early');
            return;
          }
          continue;
        }
        if (type === 'assistant') {
          const content = (message.message as { content?: unknown } | undefined)?.content;
          if (Array.isArray(content)) {
            for (const block of content as { type?: unknown; text?: unknown }[]) {
              if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) said.push(block.text.trim());
            }
          }
          continue;
        }
        if (type === 'result') {
          subtype = sub;
          isError = message.is_error === true;
          terminalReason = typeof message.terminal_reason === 'string' && message.terminal_reason
            ? message.terminal_reason : undefined;
          if (typeof message.num_turns === 'number') turns = message.num_turns;
          const text = message.result ?? message.error;
          if (typeof text === 'string') resultText = text;
          finish('result');
          return;
        }
      }
    });

    child.on('close', (code: number | null) => {
      closed = true;
      exitCode = code;
      finish('exited', `the CLI exited (${code ?? 'signal'}) before it answered`);
    });
  });
}
