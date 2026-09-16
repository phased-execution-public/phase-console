/**
 * Secrets and environments for accounts — the one file that touches credentials.
 *
 * Two distinct jobs, kept together because they share the same discipline:
 *
 *  1. Holding the secrets THIS console owns: the pasted `claude setup-token`
 *     values behind `token` accounts. macOS gets the keychain (a service name
 *     of our own, `phase-console-account-<id>`); everywhere else a 0600 file
 *     under the account's directory.
 *
 *  2. READING the credentials the Claude CLI owns, so the usage poller can ask
 *     the same endpoint `/usage` asks. Reading only: the CLI holds locks
 *     around its own credential writes and refreshes tokens on its own
 *     schedule — a second writer is how two processes corrupt one login. The
 *     service names are the CLI's own scheme: `Claude Code-credentials` for
 *     the machine login, `Claude Code-credentials-<first 8 hex of
 *     sha256(CLAUDE_CONFIG_DIR)>` for a redirected profile.
 *
 * Every process this module spawns goes through an injectable `Exec`, because
 * tests must never talk to a real keychain — and neither may CI.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { log } from '../log.ts';
import { ACCOUNTS_DIR, profileConfigDir, type AccountMeta } from './store.ts';

export type Exec = (
  file: string,
  args: string[],
  opts?: {
    env?: NodeJS.ProcessEnv;
    /**
     * Written to the child's stdin and closed. This is how a secret reaches
     * `security` without ever appearing in argv — see `keychainStore`.
     */
    input?: string;
  },
) => Promise<{ stdout: string }>;

const EXEC_TIMEOUT_MS = 20_000;

export const realExec: Exec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024, ...(opts?.env ? { env: opts.env } : {}) },
      (error, stdout) => {
        if (error) reject(error);
        else resolve({ stdout: String(stdout) });
      },
    );
    if (opts?.input !== undefined) {
      // `end()` before the child has drained is fine — the pipe buffers, and a
      // secret is far below the pipe capacity. A child that exits without
      // reading gives us EPIPE, which is the exec failure, not a crash.
      child.stdin?.on('error', () => { /* the exec callback reports it */ });
      child.stdin?.end(opts.input);
    }
  });

/**
 * The one sentence a caller may see when the keychain will not take a secret.
 *
 * Fixed on purpose, and deliberately not derived from the underlying error.
 * `execFile` rejects with `Command failed: <the whole argv>` plus the child's
 * stderr, and that message travelled all the way to the browser as an HTTP
 * error body. While the secret rode in argv that error PRINTED THE TOKEN; it
 * does not any more (see `keychainStore`), but a message assembled from a
 * failing process is exactly the wrong thing to promise never carries one.
 * So nothing from the child is forwarded — only this.
 */
export const KEYCHAIN_STORE_FAILED =
  'the macOS keychain refused to store the secret — unlock the login keychain and try again';

/** The one sentence for a secret whose shape the keychain protocol cannot carry. */
export const SECRET_MUST_BE_ONE_LINE =
  'a secret must be a single line — this value contains a line break';

/**
 * Put one secret in the login keychain, without it ever entering argv.
 *
 * `security add-generic-password -w <value>` is the obvious spelling and it is
 * the bug: argv is world-readable to every process of the same user through
 * `ps` / `/proc/<pid>/cmdline`, including — for MCP servers — the
 * `npx -y <third-party>@latest` processes this console itself launches.
 *
 * `-w` with NO value makes `security` prompt for the password instead, and it
 * reads those prompts from stdin. It asks TWICE ("password data for new item",
 * "retype password for new item") and compares, so the value is fed twice; a
 * single copy fails the comparison, and `security` then re-prompts and stores
 * whatever it reads next — which is EOF, i.e. an empty secret, with exit 0.
 * Both lines are therefore required, and both are verified by the tests.
 *
 * A value containing a newline cannot survive a line-oriented prompt, so it is
 * refused up front rather than silently truncated at the break.
 *
 * The one writer for both registries: `accounts/` stores pasted setup-tokens
 * here, `mcp/` stores bearer headers and API keys, and neither should own a
 * second copy of this reasoning.
 */
export async function keychainStore(exec: Exec, service: string, secret: string): Promise<void> {
  if (/[\r\n]/.test(secret)) throw new Error(SECRET_MUST_BE_ONE_LINE);
  try {
    await exec(
      'security',
      [
        // `-U` updates in place, so re-pasting a rotated secret is not an error.
        'add-generic-password', '-U',
        '-s', service,
        '-a', process.env.USER ?? 'phase-console',
        '-w',
      ],
      { input: `${secret}\n${secret}\n` },
    );
  } catch {
    // Nothing from the child crosses this line. See KEYCHAIN_STORE_FAILED.
    throw new Error(KEYCHAIN_STORE_FAILED);
  }
}

/** The CLI's keychain service for a given (possibly redirected) config dir. */
export function claudeKeychainService(configDir: string | null): string {
  if (!configDir) return 'Claude Code-credentials';
  const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

/** Our own keychain service for a token account's secret. */
export function consoleKeychainService(accountId: string): string {
  return `phase-console-account-${accountId}`;
}

function tokenFile(accountId: string, dir: string = ACCOUNTS_DIR): string {
  return join(dir, accountId, 'token');
}

export class Credentials {
  private readonly exec: Exec;
  private readonly platform: NodeJS.Platform;
  private readonly home: string;
  /** Where this instance's token files and profile logins live — another console's, for a process reading its registrations. */
  private readonly accountsDir: string;

  constructor(
    exec: Exec = realExec,
    platform: NodeJS.Platform = process.platform,
    home: string = homedir(),
    accountsDir: string = ACCOUNTS_DIR,
  ) {
    this.exec = exec;
    this.platform = platform;
    this.home = home;
    this.accountsDir = accountsDir;
  }

  /* ---------------- token accounts: secrets we own ---------------- */

  async storeToken(accountId: string, token: string): Promise<void> {
    if (this.platform === 'darwin') {
      await keychainStore(this.exec, consoleKeychainService(accountId), token);
      return;
    }
    if (/[\r\n]/.test(token)) throw new Error(SECRET_MUST_BE_ONE_LINE);
    mkdirSync(join(this.accountsDir, accountId), { recursive: true, mode: 0o700 });
    writeFileSync(tokenFile(accountId, this.accountsDir), `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  async readToken(accountId: string): Promise<string | null> {
    if (this.platform === 'darwin') {
      try {
        const { stdout } = await this.exec('security', [
          'find-generic-password', '-s', consoleKeychainService(accountId), '-w',
        ]);
        return stdout.trim() || null;
      } catch {
        return null;
      }
    }
    try {
      return readFileSync(tokenFile(accountId, this.accountsDir), 'utf8').trim() || null;
    } catch {
      return null;
    }
  }

  async deleteToken(accountId: string): Promise<void> {
    if (this.platform === 'darwin') {
      try {
        await this.exec('security', ['delete-generic-password', '-s', consoleKeychainService(accountId)]);
      } catch { /* never stored, or already gone — same outcome */ }
      return;
    }
    try { unlinkSync(tokenFile(accountId, this.accountsDir)); } catch { /* same */ }
  }

  /**
   * Drop the CLI's HASHED keychain item for a console-minted profile dir.
   *
   * The "never write the CLI's own store" rule protects shared logins — the
   * plain `Claude Code-credentials` item. The hashed item exists only because
   * this console created the profile directory, and once that directory is
   * gone its hash can never come up again: the item is unreachable dead
   * weight, not a shared credential. Best effort, darwin only.
   */
  async deleteProfileCredential(configDir: string): Promise<void> {
    if (this.platform !== 'darwin') return;
    const service = claudeKeychainService(configDir);
    // Belt and braces: refuse the plain service name however this was called.
    if (service === claudeKeychainService(null)) return;
    try {
      await this.exec('security', ['delete-generic-password', '-s', service]);
    } catch { /* never stored, or already gone — same outcome */ }
  }

  /* ---------------- the environment a child runs under ---------------- */

  /**
   * What to merge into a child's env so it runs AS this account.
   *
   * `null` means "inherit" — the default account is whatever the machine's
   * own `claude` is signed into, and saying nothing is exactly right. A token
   * account must NOT also set `CLAUDE_CONFIG_DIR`: the token outranks the
   * stored login in the CLI's precedence, and the default config dir is what
   * keeps its session transcripts portable to and from the machine login.
   *
   * **A token's reach is the whole child process tree** (ACT-12). The
   * environment is inherited by everything the CLI launches — every stdio MCP
   * server, `npx -y <third-party>@latest` among them — and there is no route to
   * the CLI its grandchildren cannot read. So the runner scopes what a token
   * account's run may attach (`runner-attempt.ts` `tokenScoped`: only the
   * stdio servers the plan declares; remote transports inherit nothing) and
   * journals it as `run.token-scope`.
   */
  async envFor(account: AccountMeta | null): Promise<NodeJS.ProcessEnv | null> {
    if (!account || account.kind === 'default') return null;
    if (account.kind === 'profile') {
      return { CLAUDE_CONFIG_DIR: profileConfigDir(account.id, this.accountsDir) };
    }
    const token = await this.readToken(account.id);
    if (!token) {
      log.warn('accounts.token.missing', { account: account.id });
      return null;
    }
    return { CLAUDE_CODE_OAUTH_TOKEN: token };
  }

  /** The config dir a child under this env would use — for transcript porting. */
  configDirFor(account: AccountMeta | null): string {
    if (account?.kind === 'profile') return profileConfigDir(account.id, this.accountsDir);
    return join(this.home, '.claude');
  }

  /**
   * WHERE this account's credential lives — the keychain item on macOS, the
   * file elsewhere — spelled as a string and never read. It is the input to the
   * machine-wide learned store's fingerprint (`learned.ts`): stable across
   * consoles and restarts, because two instances registering the machine login
   * as `default` name the same item, while two profiles are two directories and
   * therefore two credentials. A token account's locator is OUR keychain
   * service (or its 0600 file), which is what the secret is stored under.
   */
  credentialLocator(account: AccountMeta | null): string {
    if (account?.kind === 'token') {
      return this.platform === 'darwin'
        ? `keychain:${consoleKeychainService(account.id)}`
        : `file:${tokenFile(account.id, this.accountsDir)}`;
    }
    const configDir = account?.kind === 'profile' ? profileConfigDir(account.id, this.accountsDir) : null;
    return this.platform === 'darwin'
      ? `keychain:${claudeKeychainService(configDir)}`
      : `file:${join(configDir ?? join(this.home, '.claude'), '.credentials.json')}`;
  }

  /* ---------------- the CLI's credentials: read-only ---------------- */

  /**
   * The OAuth blob the CLI keeps for a login — enough to call the usage
   * endpoint. `configDir === null` reads the machine login.
   *
   * A profile whose hashed keychain item is missing answers `null` rather
   * than falling back to the plain service name: the plain item is a
   * DIFFERENT account's credential, and a wrong answer here would render one
   * account's meters under another's name.
   */
  async readClaudeOauth(configDir: string | null): Promise<ClaudeOauth | null> {
    if (this.platform === 'darwin') {
      try {
        const { stdout } = await this.exec('security', [
          'find-generic-password', '-s', claudeKeychainService(configDir), '-w',
        ]);
        return parseOauth(stdout);
      } catch {
        return null;
      }
    }
    try {
      const file = join(configDir ?? join(this.home, '.claude'), '.credentials.json');
      return parseOauth(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Who a config dir is signed in as, from the CLI's own `.claude.json`.
   * The machine login keeps that file at `~/.claude.json`; a redirected
   * profile keeps it inside its config dir.
   */
  readIdentity(configDir: string | null): { email?: string; org?: string; orgId?: string } | null {
    const file = configDir ? join(configDir, '.claude.json') : join(this.home, '.claude.json');
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        oauthAccount?: { emailAddress?: string; organizationName?: string; organizationUuid?: string };
      };
      const account = parsed?.oauthAccount;
      if (!account) return null;
      return {
        ...(typeof account.emailAddress === 'string' && account.emailAddress ? { email: account.emailAddress } : {}),
        ...(typeof account.organizationName === 'string' && account.organizationName ? { org: account.organizationName } : {}),
        // The same value `claude auth status` reports as `orgId` (verified
        // equal on 2.1.270) — the key the breaker hangs an entitlement on,
        // readable without a probe. It is a machine-wide learned fact, never
        // a view field: the browser sees it hashed.
        ...(typeof account.organizationUuid === 'string' && account.organizationUuid ? { orgId: account.organizationUuid } : {}),
      };
    } catch {
      return null;
    }
  }
}

export type ClaudeOauth = {
  accessToken: string;
  /** Epoch milliseconds, when the CLI recorded one. */
  expiresAt?: number;
  subscriptionType?: string;
};

function parseOauth(raw: string): ClaudeOauth | null {
  try {
    const parsed = JSON.parse(raw.trim()) as { claudeAiOauth?: Record<string, unknown> };
    const oauth = parsed?.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      ...(typeof oauth.expiresAt === 'number' ? { expiresAt: oauth.expiresAt } : {}),
      ...(typeof oauth.subscriptionType === 'string' && oauth.subscriptionType
        ? { subscriptionType: oauth.subscriptionType }
        : {}),
    };
  } catch {
    return null;
  }
}
