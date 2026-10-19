// `phase-console mcp …` — the MCP registry from a terminal (one-pool phase 19, #363). Both
// editions, like the MCP section itself: each verb is one request to the console at this machine,
// and the writes are behind that console's `--allow-mcp`, as the page's are.
//
//   mcp list                      every registered server: status, transport, what it still needs
//   mcp add --manual <json|file|->
//                                 register any server by hand (POST /api/mcp, `source: manual`):
//                                 a JSON object with `label`, `transport` (stdio, http, sse, ws),
//                                 `command` and `args` or `url`, and any of `id`, `env`, `headers`,
//                                 `secretRefs`, `secrets`, `vars`, `alwaysLoad`, `timeoutMs`;
//                                 a path to a file holding one, or `-` to read it from stdin
//   mcp fill <id> (NAME=<value>… | --from-file <json> | --stdin)
//                                 give a value to each `${VAR}` its configuration writes and nothing
//                                 supplies (PATCH /api/mcp/<id> `vars`) — held where a secret is
//
// Flags: `--console <name|port>` (which console; the default is the one whose root holds this
// directory, else the machine's only one) and `--json`.
//
// A SECRET NEVER RIDES ARGV. Every process of this user can read another's command line (`ps`), so
// a JSON given inline that carries `secrets` or `vars` is refused, and so is a `NAME=<value>`
// shaped like a token or a URL with a password in it: put it in a file only you can read, or pipe it.

import { existsSync, readFileSync } from 'node:fs';

import { resolvePort, send } from './owner-verb.mjs';

const HELP = `phase-console mcp list | add --manual <json|file|-> | fill <id> … [--console <name|port>] [--json]

  list                      every registered server: status, transport, what it still needs
  add --manual <json|file|->
                            register any server by hand — a JSON object:
                              {"label": "Obs", "transport": "stdio", "command": "npx", "args": ["-y", "obs-mcp"]}
                              {"label": "Docs", "transport": "http", "url": "https://docs.example/mcp"}
                            optional: id, env, headers, secretRefs, secrets, vars, alwaysLoad, timeoutMs
  fill <id> NAME=<value>…   give each \${VAR} its configuration writes a value (held like a secret)
  fill <id> --from-file <json> | --stdin
                            the same, from a JSON object {"NAME": "value"} in a file or on stdin

A secret never goes on the command line: secrets and vars come from a file only you can read
(chmod 600) or from stdin.
`;

/** Shaped like a secret: a token, or a URL with a password in it. */
const SECRET_SHAPED = /^(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|[A-Za-z0-9_-]{40,})$|:\/\/[^/\s:@]+:[^/\s@]+@/;

export const SECRET_IN_ARGV = 'a secret never goes on the command line, where every process on this machine can read it — '
  + 'put it in a file only you can read (chmod 600 <file>) and pass the file, or pipe it in with - / --stdin';

/** Parse the words after `mcp`. */
export function parseMcpArgs(argv) {
  const out = { words: [], flags: {}, json: false, stdin: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const word = String(argv[i] ?? '');
    const at = word.startsWith('--') ? word.indexOf('=') : -1;
    const [name, inline] = at > 0 ? [word.slice(0, at), word.slice(at + 1)] : [word, undefined];
    if (name === '--json') out.json = true;
    else if (name === '--stdin') out.stdin = true;
    else if (name === '--help' || name === '-h') out.help = true;
    else if (name === '--manual' || name === '--console' || name === '--from-file') {
      const value = inline ?? argv[i + 1];
      if (inline === undefined) i += 1;
      out.flags[name.slice(2)] = value;
    } else out.words.push(word);
  }
  return out;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The manual registration: inline JSON, a file holding it, or stdin (`-`). Inline JSON may not
 * carry a value meant to be secret; a file or a pipe may.
 */
export async function manualBody(source, { read = (path) => readFileSync(path, 'utf8'), stdin = readStdin, exists = existsSync } = {}) {
  if (source === undefined || source === '') return { error: 'give --manual a JSON object, a file holding one, or - for stdin' };
  const trimmed = String(source).trim();
  const inline = trimmed.startsWith('{');
  let text;
  if (inline) text = trimmed;
  else if (trimmed === '-') text = await stdin();
  else if (exists(trimmed)) {
    try { text = read(trimmed); } catch { return { error: `${trimmed} could not be read — check the path and that you may read it` }; }
  } else return { error: `${trimmed} is neither a JSON object nor a file — write the object in braces, or name a file` };
  let body;
  try { body = JSON.parse(text); } catch (error) { return { error: `that is not JSON: ${error.message}` }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'the registration is one JSON object' };
  if (inline && (hasValues(body.secrets) || hasValues(body.vars))) return { error: SECRET_IN_ARGV };
  return { body: { ...body, source: 'manual' } };
}

const hasValues = (value) => Boolean(value && typeof value === 'object' && Object.keys(value).length);

/** `NAME=value` words, a JSON file or stdin → the `vars` object, or the reason it cannot be. */
export async function fillVars(parsed, words, { read = (path) => readFileSync(path, 'utf8'), stdin = readStdin } = {}) {
  const from = parsed.flags['from-file'];
  if ((from || parsed.stdin) && words.length) return { error: 'give the values ONE way — NAME=<value> words, --from-file or --stdin' };
  if (from || parsed.stdin) {
    let text;
    try { text = from ? read(from) : await stdin(); } catch { return { error: `${from} could not be read` }; }
    try {
      const vars = JSON.parse(text);
      if (!vars || typeof vars !== 'object' || Array.isArray(vars)) throw new Error('not an object');
      return { vars };
    } catch { return { error: 'the values are one JSON object, {"NAME": "value"}' }; }
  }
  if (!words.length) return { error: 'name each variable and its value: phase-console mcp fill <id> NAME=<value>' };
  const vars = {};
  for (const word of words) {
    const at = word.indexOf('=');
    if (at <= 0) return { error: `write each one as NAME=<value> — "${word}" has no =` };
    const value = word.slice(at + 1);
    if (SECRET_SHAPED.test(value)) return { error: SECRET_IN_ARGV };
    vars[word.slice(0, at)] = value;
  }
  return { vars };
}

/** One server as a line. */
export function serverLine(server) {
  const needs = server.needsConfig?.length ? ` · needs ${server.needsConfig.map((name) => `\${${name}}`).join(', ')}` : '';
  const off = server.enabled ? '' : ' · switched off';
  return `${server.id}  ${server.status}  ${server.transport}  ${server.url ?? server.command ?? ''}${off}${needs}`;
}

function refusal(answer, err) {
  if (!answer.ok) {
    err.write(`phase-console mcp: no console answered (${answer.error?.message ?? answer.error}) — is it running? phase-console doctor\n`);
    return 1;
  }
  if (answer.status >= 400) {
    err.write(`phase-console mcp: ${answer.body?.error ?? `the console answered ${answer.status}`}\n`);
    return 1;
  }
  return 0;
}

/** @param {string[]} argv the words after `mcp` @param {{ root: string, out?: NodeJS.WritableStream, err?: NodeJS.WritableStream }} ctx */
export async function mcpVerb(argv, ctx) {
  const out = ctx.out ?? process.stdout;
  const err = ctx.err ?? process.stderr;
  const parsed = parseMcpArgs(argv);
  const [sub, ...words] = parsed.words;
  if (parsed.help || !sub || sub === 'help') {
    out.write(HELP);
    return sub || parsed.help ? 0 : 2;
  }
  const where = await resolvePort(ctx.root, parsed.flags.console);
  if (!where.ok) {
    err.write(`phase-console mcp: ${where.message}\n`);
    return 2;
  }
  const port = where.port;

  if (sub === 'list') {
    const answer = await send(port, 'GET', '/api/mcp', undefined, 'phase-console/mcp');
    const failed = refusal(answer, err);
    if (failed) return failed;
    if (parsed.json) out.write(`${JSON.stringify(answer.body, null, 2)}\n`);
    else if (!answer.body.servers?.length) out.write('No MCP server is registered on this console.\n');
    else for (const server of answer.body.servers) out.write(`${serverLine(server)}\n`);
    return 0;
  }

  if (sub === 'add') {
    if (parsed.flags.manual === undefined) {
      err.write('phase-console mcp add: give the registration with --manual <json|file|-> — the catalog is on the page\n');
      return 2;
    }
    const made = await manualBody(parsed.flags.manual);
    if (made.error) { err.write(`phase-console mcp add: ${made.error}\n`); return 2; }
    const answer = await send(port, 'POST', '/api/mcp', made.body, 'phase-console/mcp');
    const failed = refusal(answer, err);
    if (failed) return failed;
    const server = answer.body.server;
    if (parsed.json) out.write(`${JSON.stringify(server, null, 2)}\n`);
    else {
      out.write(`registered ${server.id} — a plan names it ${server.id}, a permission rule mcp__${server.id}\n`);
      if (server.needsConfig?.length) out.write(`it still needs ${server.needsConfig.map((name) => `\${${name}}`).join(', ')}: phase-console mcp fill ${server.id} ${server.needsConfig.map((name) => `${name}=<value>`).join(' ')}\n`);
      if (server.auth?.kind === 'oauth') out.write(`it signs in with OAuth: press Sign in on its row, Settings ▸ MCP servers\n`);
    }
    return 0;
  }

  if (sub === 'fill') {
    const [id, ...pairs] = words;
    if (!id) { err.write('phase-console mcp fill: name the server — phase-console mcp fill <id> NAME=<value>\n'); return 2; }
    const made = await fillVars(parsed, pairs);
    if (made.error) { err.write(`phase-console mcp fill: ${made.error}\n`); return 2; }
    const answer = await send(port, 'PATCH', `/api/mcp/${encodeURIComponent(id)}`, { vars: made.vars }, 'phase-console/mcp');
    const failed = refusal(answer, err);
    if (failed) return failed;
    const server = answer.body.server;
    if (parsed.json) out.write(`${JSON.stringify(server, null, 2)}\n`);
    else out.write(server?.needsConfig?.length
      ? `held — ${id} still needs ${server.needsConfig.map((name) => `\${${name}}`).join(', ')}\n`
      : `held — ${id} has every value it refers to; re-checking it now\n`);
    return 0;
  }

  err.write(`phase-console mcp: no verb ${sub} — list, add --manual or fill\n${HELP}`);
  return 2;
}
