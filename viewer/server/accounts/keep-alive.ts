/**
 * Keep-alive — a login-backed account's access token is renewed through the
 * CLI's OWN refresh before it lapses (control-tower phase 91, #147 ask 1,
 * operator decision 12), never by this console writing a credential.
 *
 * Measured on this machine with Claude Code 2.1.283 on 2026-09-26, before any
 * of this was built:
 *
 *  - `claude auth status` renews NOTHING. Under a profile whose access token had
 *    lapsed 21.7 hours earlier it answered `loggedIn: true` in under a second,
 *    from the stored blob, and the blob's expiry and both tokens were unchanged
 *    after it. (`resolveToken` used to call it as "the refresh"; it was not.)
 *  - A `claude -p` START renews: the CLI refreshes the OAuth token at startup,
 *    before any model call. Named with a model no account serves, the start is
 *    refused locally (`claude-code:unrecognized_model`, exit 1, `total_cost_usd`
 *    0, no API time) AFTER the refresh is written — so the call spends nothing.
 *    The same profile's expiry moved from 21.7 h past to 8 h ahead, and both
 *    the access and the refresh token rotated. The CLI wrote them, under its
 *    own lock: this console still never writes the CLI's store.
 *  - The CLI refreshes only inside its own window: a token with 102 minutes
 *    left was not renewed by the same call. So keep-alive asks just before the
 *    lapse (`KEEP_ALIVE_LEAD_MS`), and reads the blob back to learn whether the
 *    renewal happened, rather than trusting the call's exit code — which is 1
 *    by design.
 *
 * A setup-token (`claude setup-token`) is the other half of the unattended
 * path: it has no refresh and no expiry field, and lasts a year from when it
 * was made. Its login state is read from its age (`tokenLoginState`).
 */

import type { AuthState } from './index.ts';
import type { ClaudeOauth, Exec } from './credentials.ts';
import type { AccountKind } from './store.ts';

/**
 * The model the renewal names. Not a model any account serves, so the CLI
 * refuses the start before a model call — after its startup refresh (measured).
 */
export const KEEP_ALIVE_MODEL = 'phase-console-keep-alive';

/**
 * How long before the access token's expiry keep-alive asks. Inside the CLI's
 * own refresh window (a token 102 minutes out was not renewed; one past its
 * expiry always was) — and a renewal the CLI judged not due yet is asked again
 * once the token is past it (`not-due`).
 */
export const KEEP_ALIVE_LEAD_MS = 4 * 60_000;

/** How often the facade looks for a login that is due. */
export const KEEP_ALIVE_TICK_MS = 60_000;

/** A setup-token's life, as `claude setup-token` issues it: one year. */
export const SETUP_TOKEN_LIFETIME_MS = 365 * 24 * 3_600_000;

/** How long before a setup-token's year is up its account reads `expiring` and a person is told. */
export const SETUP_TOKEN_WARN_MS = 14 * 24 * 3_600_000;

/** What one renewal did. */
export type RenewalOutcome = 'renewed' | 'not-due' | 'failed' | 'no-login';

export type Renewal = {
  outcome: RenewalOutcome;
  reason: string;
  /** The access token's expiry before and after the call, epoch ms. */
  before?: number;
  after?: number;
};

/** The renewal's argv — a `-p` start the CLI refuses after refreshing. */
export function keepAliveArgv(): string[] {
  return [
    '-p', 'keep-alive',
    '--model', KEEP_ALIVE_MODEL,
    '--max-turns', '1',
    '--strict-mcp-config',
    '--output-format', 'json',
  ];
}

/**
 * The environment the renewal runs under: the account's own config dir (none
 * for the machine login), as a probe the presence hook registers nothing for,
 * and with none of the calling session's channels — an outcome file, a lock
 * owner, a session id or another account's token must not reach it.
 */
export function keepAliveEnv(base: NodeJS.ProcessEnv, configDir: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith('PE_') || key.startsWith('CLAUDE_CODE_') || key === 'CLAUDE_CONFIG_DIR') continue;
    env[key] = value;
  }
  env.PE_SESSION_KIND = 'probe';
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

/**
 * When a blob is due for renewal — `KEEP_ALIVE_LEAD_MS` before its access
 * token lapses — or null when nothing can renew it (no blob, no expiry, no
 * refresh token).
 */
export function keepAliveDueAt(oauth: ClaudeOauth | null): number | null {
  if (!oauth?.canRefresh || !oauth.expiresAt) return null;
  return oauth.expiresAt - KEEP_ALIVE_LEAD_MS;
}

/**
 * Ask the CLI to renew one login and read back what it did. The call exits 1
 * by design (the model is refused), so the answer is the blob's, never the
 * exit code's: a later expiry or a new access token is `renewed`; the same
 * blob on a token that has not lapsed is `not-due` (the CLI judged it fresh);
 * the same blob on a lapsed token is `failed` — the CLI could not renew it.
 */
export async function renewLogin(deps: {
  exec: Exec;
  configDir: string | null;
  read: () => Promise<ClaudeOauth | null>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}): Promise<Renewal> {
  const now = deps.now ?? Date.now;
  const before = await deps.read();
  if (!before) return { outcome: 'no-login', reason: 'there is no Claude login here to renew' };
  try {
    await deps.exec('claude', keepAliveArgv(), { env: keepAliveEnv(deps.env ?? process.env, deps.configDir) });
  } catch {
    // Expected: the start is refused after the refresh (measured). Whether the
    // refresh happened is the blob's to say.
  }
  const after = await deps.read();
  const span = { ...(before.expiresAt ? { before: before.expiresAt } : {}), ...(after?.expiresAt ? { after: after.expiresAt } : {}) };
  if (after && (after.accessToken !== before.accessToken || (after.expiresAt ?? 0) > (before.expiresAt ?? 0))) {
    return { outcome: 'renewed', reason: 'the CLI renewed the login', ...span };
  }
  const lapsed = !after || (after.expiresAt !== undefined && after.expiresAt <= now());
  if (!lapsed) return { outcome: 'not-due', reason: 'the CLI judged the access token fresh enough to keep', ...span };
  return {
    outcome: 'failed',
    reason: after?.canRefresh
      ? 'the CLI could not renew the login — its refresh was refused, or it could not reach the sign-in service'
      : 'the CLI could not renew the login — it holds nothing to renew it with',
    ...span,
  };
}

/**
 * A setup-token account's login state, from its age: `ok` for most of its
 * year, `expiring` in the last `SETUP_TOKEN_WARN_MS`, `expired` past it. An
 * unreadable creation date is no evidence of a lapse. Never `unknown` — the
 * word a token account used to read, because nothing here looked.
 */
export function tokenLoginState(createdAtMs: number, nowMs: number): AuthState {
  if (!Number.isFinite(createdAtMs)) return 'ok';
  const ends = createdAtMs + SETUP_TOKEN_LIFETIME_MS;
  if (nowMs >= ends) return 'expired';
  if (nowMs >= ends - SETUP_TOKEN_WARN_MS) return 'expiring';
  return 'ok';
}

/** When a setup-token made at `createdAtMs` stops working. */
export function tokenExpiresAt(createdAtMs: number): string | undefined {
  return Number.isFinite(createdAtMs) ? new Date(createdAtMs + SETUP_TOKEN_LIFETIME_MS).toISOString() : undefined;
}

/**
 * The exact fix for a login that can no longer be renewed, as a person types
 * it. A path under the home directory is written `$HOME/…`, so the sentence
 * pastes on any account and a screenshot of it carries no user name.
 */
export function loginFix(kind: AccountKind, configDir: string | null, name: string, home: string): string {
  if (kind === 'token') return `run \`claude setup-token\`, then paste the new token for ${name} under Settings ▸ Accounts`;
  if (!configDir) return 'run `claude auth login` in a terminal on this machine';
  const dir = home && configDir.startsWith(`${home}/`) ? `$HOME/${configDir.slice(home.length + 1)}` : configDir;
  return `run \`CLAUDE_CONFIG_DIR=${dir} claude auth login\` in a terminal on this machine`;
}

/**
 * The unattended path, offered on every login-backed account: a setup-token
 * does not lapse between sessions, so a run left alone for days does not stop
 * for a renewal nobody was there to make.
 */
export const UNATTENDED_OFFER = 'For runs left alone for days, add a long-lived token for this login: run '
  + '`claude setup-token`, sign in as the same person, and paste the token under Add account ▸ Token. '
  + 'It lasts a year and never needs renewing between sessions.';
