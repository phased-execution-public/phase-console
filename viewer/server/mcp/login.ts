/**
 * Signing in a server THIS console registered — the bridge `claude mcp login`
 * needs and does not have.
 *
 * Every other path in the console hands the CLI its own set:
 * `--strict-mcp-config --mcp-config <file>` for the probe (`health.ts`) and for
 * a run (`runner/spawn.ts`). The sign-in verb structurally cannot, because the
 * subcommand takes a name and no config flag:
 *
 *   claude mcp login [--no-browser] <name>
 *
 * So `<name>` resolved against whatever the CLI itself had configured, and for
 * a server only this console knew about the answer was always the same:
 * `No MCP server named "grafana"`, followed by somebody else's server list,
 * printed inside a terminal pane with no console error and no way forward.
 *
 * ## What this file does instead
 *
 * It makes the name resolvable for the length of the flow, and then puts the
 * registry back:
 *
 *   1. `claude mcp add --transport <t> --scope user <id> <url>` in the TARGET
 *      config dir — a server DEFINITION, which is not a credential;
 *   2. `claude mcp login <id> --no-browser` in the same dir, which now finds it;
 *   3. `claude mcp remove <id> --scope user`, once the flow is over.
 *
 * Measured against `claude` 2.1.258 under a throwaway `CLAUDE_CONFIG_DIR`: step
 * 1 writes `<dir>/.claude.json` at 0600 and step 2 then prints a real
 * authorization URL rather than the "No MCP server named" refusal. The token
 * lands in the CLI's own credential item, keyed `sha256(CLAUDE_CONFIG_DIR)[:8]`
 * (`accounts/credentials.ts`), which is exactly where a session run under that
 * config dir looks for it.
 *
 * ## Why not the two other shapes
 *
 * **Capture the token into our own store.** Add the server to the CLI's user
 * scope, log in, lift the credential across, remove the entry. That makes this
 * console a second writer of the CLI's own credential store, which
 * `credentials.ts` forbids by name and for a reason that has nothing to do with
 * taste: two writers is how two processes corrupt one login.
 *
 * **Drive the OAuth flow ourselves.** The authorization URL the CLI produces
 * carries dynamic client metadata, a PKCE S256 challenge and a localhost
 * callback; doing it here means owning discovery, the callback listener and
 * refresh forever — to end up holding a token the CLI would never read, since
 * it resolves MCP OAuth from its own store and not from `--mcp-config`.
 *
 * ## The rules this file keeps
 *
 * **The definition carries no secret.** Only the id, the transport and the URL,
 * plus whatever non-secret headers the registry holds (`store.ts` keeps no
 * secret at all; values live in the keychain and are spliced in by `config.ts`,
 * which this path deliberately does not use). A server that authenticates by a
 * header we hold has no OAuth flow to start and never reaches here.
 *
 * **A definition we did not write is never removed.** If the operator already
 * has that id in the target config dir, the flow uses it as it stands and
 * leaves it alone afterwards. Cleaning up somebody else's registry entry
 * because we happened to sign in through it is the kind of tidiness that costs
 * an afternoon.
 *
 * **A verb that cannot succeed is not offered.** When there is no path at all —
 * a transport `claude mcp add` does not take, no `claude` on PATH, a bridge the
 * CLI refused — the caller gets the exact commands to run by hand instead of a
 * terminal that will print someone else's server list again. That is the whole
 * complaint in issue #8, and a second unusable button would be the same bug.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { log } from '../log.ts';
import { realExec, type Exec } from '../accounts/credentials.ts';
import { shellQuote } from '../runner/auth.ts';
import { authKind } from './index.ts';
import type { McpServerMeta } from './store.ts';

/**
 * Transports `claude mcp add` accepts.
 *
 * Deliberately a list of what the CLI takes rather than of what the registry
 * holds: `ws` is a transport this console supports and `claude mcp add -t`
 * does not, so a WebSocket server has no bridge and must be told so rather than
 * handed a command that fails on its own flag.
 */
const BRIDGEABLE_TRANSPORTS = new Set(['http', 'sse']);

/** The config dir a flow runs in, and how a person would say it out loud. */
export type McpLoginTarget = {
  /**
   * `CLAUDE_CONFIG_DIR` for the flow, or undefined for the machine's own.
   *
   * Undefined is not a missing value — it is the instruction "inherit", the
   * same one `accounts/credentials.ts` `envFor` gives for the default account,
   * and it is what keeps the sign-in in the same config dir the health probe
   * reads. Naming a dir is how an operator signs a server in for the PROFILE
   * account their runs actually spend.
   */
  configDir?: string;
  /** Whose config dir this is, for the sentence the card shows. */
  accountLabel?: string;
};

/** What the flow will run, resolved once so every caller says the same thing. */
export type McpLoginPlan = {
  id: string;
  /** `CLAUDE_CONFIG_DIR` for every step, or undefined to inherit. */
  configDir?: string;
  accountLabel?: string;
  /** Argv for the three steps, without the leading `claude`. */
  add: string[];
  login: string[];
  remove: string[];
  /** The whole thing as a line an operator can paste. */
  command: string;
  /** Just the login step, for the terminal the console mints. */
  loginCommand: string;
};

/** No path exists for this server — say which commands would, if any. */
export type McpLoginBlock = {
  /** One sentence, shown on the card. */
  reason: string;
  /**
   * What the operator can run instead, in order. Empty when nothing would
   * help — a `ws` server has no `claude mcp add` spelling at all.
   */
  commands: string[];
};

export function isLoginBlock(value: McpLoginPlan | McpLoginBlock): value is McpLoginBlock {
  return 'reason' in value;
}

/**
 * The config dir this console's own children — the health probe among them —
 * run under.
 *
 * Read from an environment rather than from `process.env` directly so a test
 * never depends on the machine's, and resolved to an absolute path so the
 * string can be shown, quoted and compared. `~/.claude` is the CLI's own
 * default and is spelled out here for the same reason `skills.ts` spells it
 * out: a caller that has to say WHICH dir cannot be handed "whatever the CLI
 * would have picked".
 */
export function consoleConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
}

/**
 * Resolve what signing this server in would take — or why it cannot be done.
 *
 * Pure: it runs nothing and touches no disk. That is what lets the route, the
 * card and the tests all ask the same question and get the same answer, and
 * what makes the refusal branch testable without a CLI at all.
 */
export function planMcpLogin(meta: McpServerMeta, target: McpLoginTarget = {}): McpLoginPlan | McpLoginBlock {
  if (meta.transport === 'stdio') {
    return {
      reason: 'A stdio server does not sign in — it needs its environment set, not an OAuth flow.',
      commands: [],
    };
  }
  if (!BRIDGEABLE_TRANSPORTS.has(meta.transport)) {
    return {
      reason:
        `The Claude CLI's \`mcp add\` takes stdio, sse and http, so a ${meta.transport} server cannot be `
        + 'registered with it and cannot be signed in through it. Give it a header this console holds instead.',
      commands: [],
    };
  }
  const url = meta.url?.trim();
  if (!url) {
    return {
      reason: `${meta.id} has no URL, so there is nothing to authorize against.`,
      commands: [],
    };
  }
  // Only an OAuth server has a flow to start. A server that authenticates by a
  // header or an environment value already has its credential — this console's,
  // in the keychain — and `claude mcp login` would have nothing to do for it.
  // Asked through `authKind` rather than re-derived here, because the card gates
  // its button on the same answer and two spellings of "signable" is how one
  // surface offers what the other refuses.
  // `header` or `env` by elimination: `none` is returned only for stdio, which
  // the first guard already sent back, and `oauth` is the case that continues.
  // Spelled without a `none` arm because a branch that cannot be reached is a
  // claim about the code that stops being true the moment someone edits above.
  const kind = authKind(meta);
  if (kind !== 'oauth') {
    return {
      reason:
        `${meta.id} authenticates by a ${kind} value, not OAuth, so there is no sign-in to run. `
        + 'Set the value it needs on this card instead.',
      commands: [],
    };
  }

  const scope = ['--scope', 'user'];
  // The headers are the registry's own, and the registry holds no secret
  // (`store.ts`) — a value that needs one is a `secretRef`, which means the
  // server authenticates by header and never reaches this function. What is
  // left is the kind of non-secret header an endpoint needs to route at all,
  // and dropping it would bridge a definition that cannot connect.
  const headers: string[] = [];
  for (const [name, value] of Object.entries(meta.headers ?? {})) {
    headers.push('--header', `${name}: ${value}`);
  }

  const add = ['mcp', 'add', '--transport', meta.transport, ...scope, ...headers, meta.id, url];
  // `--no-browser` because the console is routinely driven from a phone or over
  // ssh: it prints the authorization URL and takes the pasted callback, which
  // works in a terminal pane and degrades to a copyable command when there is
  // none. A local browser flow would simply hang on those machines.
  const login = ['mcp', 'login', meta.id, '--no-browser'];
  const remove = ['mcp', 'remove', meta.id, ...scope];

  const prefix = target.configDir ? `CLAUDE_CONFIG_DIR=${shellQuote(target.configDir)} ` : '';
  const line = (argv: string[]): string => `${prefix}claude ${argv.map(shellQuote).join(' ')}`;

  return {
    id: meta.id,
    ...(target.configDir ? { configDir: target.configDir } : {}),
    ...(target.accountLabel ? { accountLabel: target.accountLabel } : {}),
    add,
    login,
    remove,
    command: [line(add), line(login), line(remove)].join(' && '),
    loginCommand: line(login),
  };
}

/**
 * What to merge into a step's environment: nothing, or the config dir.
 *
 * `Record<string, string>` rather than `ProcessEnv` because that is what a
 * `LaunchSpec` takes, and because every value here is one we just set — the
 * `string | undefined` of the ambient environment has no meaning in an overlay.
 */
export function loginEnv(plan: McpLoginPlan): Record<string, string> | undefined {
  return plan.configDir ? { CLAUDE_CONFIG_DIR: plan.configDir } : undefined;
}

export type BridgeResult =
  /** We wrote the definition; the caller owes a `unbridge` when the flow ends. */
  | { ok: true; wrote: true }
  /** It was already there — somebody else's, and not ours to remove. */
  | { ok: true; wrote: false }
  /** The CLI would not take it. No terminal should open. */
  | { ok: false; detail: string };

/**
 * Make `<id>` resolvable in the target config dir.
 *
 * Asks first (`claude mcp get`), because the answer decides the lifecycle: an
 * entry that was already there is the operator's and survives us; one we wrote
 * is ours and does not. `get` exiting non-zero is the ordinary "not
 * configured" answer, not a failure — the CLI has no quiet spelling of that
 * question — so it is read as absence and nothing is logged.
 */
export async function bridgeDefinition(plan: McpLoginPlan, exec: Exec = realExec): Promise<BridgeResult> {
  const env = loginEnv(plan);
  const opts = env ? { env: { ...process.env, ...env } } : undefined;

  try {
    await exec('claude', ['mcp', 'get', plan.id], opts);
    return { ok: true, wrote: false };
  } catch {
    /* not configured there — which is the case this whole file exists for */
  }

  try {
    await exec('claude', plan.add, opts);
    return { ok: true, wrote: true };
  } catch (error) {
    const detail = (error as Error).message || 'the Claude CLI would not register the server';
    log.warn('mcp.login.bridge-failed', { server: plan.id, detail });
    return { ok: false, detail };
  }
}

/**
 * Put the registry back, if we were the ones who changed it.
 *
 * Best effort by design, and the same posture `config.ts`'s sweeps take: this
 * runs after a flow that has already succeeded or already failed, and neither
 * outcome is improved by throwing over a registry entry. What it must never do
 * is remove an entry `bridgeDefinition` reported it did not write.
 */
export async function unbridgeDefinition(plan: McpLoginPlan, exec: Exec = realExec): Promise<boolean> {
  const env = loginEnv(plan);
  try {
    await exec('claude', plan.remove, env ? { env: { ...process.env, ...env } } : undefined);
    return true;
  } catch (error) {
    log.warn('mcp.login.unbridge-failed', { server: plan.id, error: (error as Error).message });
    return false;
  }
}
