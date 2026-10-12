/**
 * The start command, with every capability — composed from the console's own
 * facts, never typed from memory. Settings ▸ Essentials prints it, the launch
 * form offers it to a console started without `--allow-run`, and the
 * Supervisor quotes it.
 *
 * Paths render as `"$HOME/…"`, not absolute: the line works pasted on any
 * account, and a screenshot of a page carries no username.
 */

/**
 * The capability switches the start command composes, in the order every doc
 * lists them — every switch but `--allow-publish`, the one that pushes the work,
 * which stays a deliberate act at the start command a person types.
 *
 * `--allow-mcp` was once missing here and nowhere else — `server/config.ts`
 * parses it, `/api/state` exposes it and the Desktop launcher's own flag set
 * carries it. So a card promising "the exact line for this console" composed a
 * line that turned MCP registration OFF, and `missing` (derived from this same
 * array) never listed `mcp` among the capabilities the console lacks.
 */
export const CAPABILITIES = [
  ['allowWrites', '--allow-writes', 'writes'],
  ['allowRun', '--allow-run', 'runs'],
  ['allowTerminal', '--allow-terminal', 'terminal'],
  ['allowAgent', '--allow-agent', 'agent'],
  ['allowAccounts', '--allow-accounts', 'accounts'],
  ['allowMcp', '--allow-mcp', 'mcp'],
  ['allowWebhooks', '--allow-webhooks', 'webhooks'],
] as const;

/**
 * A path as a paste-anywhere shell word: under the server's home it becomes
 * `"$HOME/…"` (double-quoted so $HOME still expands), elsewhere it is quoted
 * verbatim. Exported for the test that pins "no absolute home paths leak".
 */
export function portablePath(path: string, home: string | undefined): string {
  if (home && (path === home || path.startsWith(`${home}/`))) {
    return `"$HOME${path.slice(home.length)}"`;
  }
  return /^[\w./~-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** The console's default session ceiling — a non-default value is worth pinning. */
const DEFAULT_MAX_SESSIONS = 3;

/** The full-options start line for one console. */
export function composeStartCommand(state: {
  scriptsDir?: string;
  root?: { path?: string };
  port?: number;
  home?: string;
  remoteHosts?: string[];
  remoteUsers?: string[];
  concurrency?: { max?: number };
  defaultSkills?: string[];
}): string {
  const skillRoot = state.scriptsDir?.replace(/\/scripts\/?$/, '');
  const launcher = skillRoot ? `${portablePath(`${skillRoot}/start`, state.home)}` : 'phase-console start';
  return [
    launcher,
    ...(state.root?.path ? [portablePath(state.root.path, state.home)] : []),
    ...(state.port ? [`--port ${state.port}`] : []),
    ...CAPABILITIES.map(([, flag]) => flag),
    // Everything else this console was started with — remote access, the
    // session ceiling, default skills. A pasted line that silently dropped
    // `--remote` disabled someone's phone access; "the exact line" means all
    // of it. Defaults stay unspoken so a plain console composes the plain line.
    ...(state.remoteHosts ?? []).flatMap((host) => ['--remote', host]),
    ...(state.remoteUsers ?? []).flatMap((user) => ['--remote-user', user]),
    ...(typeof state.concurrency?.max === 'number' && state.concurrency.max !== DEFAULT_MAX_SESSIONS
      ? [`--max-sessions ${state.concurrency.max}`]
      : []),
    ...(state.defaultSkills?.length ? [`--default-skills ${state.defaultSkills.join(',')}`] : []),
  ].join(' ');
}
