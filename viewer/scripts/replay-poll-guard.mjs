#!/usr/bin/env node
/**
 * Replay Claude Code session transcripts through the poll-loop guard
 * (`shared/poll-loop.js`, autopilot-token-drain phase 2) — a local tool for
 * tuning the guard and producing its test fixtures. Dev-only: never shipped
 * (`.github/scripts/assert-tarball.sh` keeps it out of the package), and never
 * pointed at a committed path — transcripts hold whatever their sessions ran.
 *
 *   node viewer/scripts/replay-poll-guard.mjs <transcript.jsonl>...
 *       one session (pass every copy of it) → its call count and each episode's
 *       first refused call, 1-based
 *   node viewer/scripts/replay-poll-guard.mjs --dir <projects-dir>...
 *       every top-level *.jsonl, copies of one session merged across the dirs →
 *       only the sessions the guard would have fired on, then a total
 *   node viewer/scripts/replay-poll-guard.mjs --extract <transcript.jsonl>...
 *       → a sanitised fixture on stdout (see `sanitise`)
 *
 * What a replay reads: the session's OWN tool calls — `tool_use` blocks of
 * `assistant` entries that are not sidechains (a subagent's transcript lives in
 * a separate `subagents/` file, never read here) — merged across copies by
 * `tool_use` id, because a session that switched accounts has its transcript
 * copied, and ordered by timestamp.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { foldDigits, isProbeCommand, replayCalls } from '../shared/poll-loop.js';

/**
 * @typedef {{ id: string, name: string, input: Record<string, unknown>, at: number }} TranscriptCall
 * @typedef {{ dtMs: number, name: string, command?: string, block?: boolean, runInBackground?: boolean }} FixtureCall
 */

/**
 * The main-thread tool calls of one session, merged across copies.
 * @param {string[]} files
 * @returns {TranscriptCall[]}
 */
export function readSession(files) {
  /** @type {Map<string, TranscriptCall>} */
  const calls = new Map();
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"tool_use"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type !== 'assistant' || entry.isSidechain === true) continue;
      const at = Date.parse(entry.timestamp);
      const content = entry.message?.content;
      if (!Number.isFinite(at) || !Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string' || calls.has(block.id)) continue;
        const input = block.input && typeof block.input === 'object' ? block.input : {};
        calls.set(block.id, { id: block.id, name: String(block.name), input, at });
      }
    }
  }
  return [...calls.values()].sort((a, b) => a.at - b.at);
}

/**
 * A fixture's calls as the tracker reads them.
 * @param {FixtureCall[]} calls
 */
export function fixtureCalls(calls) {
  let at = 0;
  return calls.map((call) => {
    at += call.dtMs;
    /** @type {Record<string, unknown>} */
    const input = {};
    if (call.command !== undefined) input.command = call.command;
    if (call.block !== undefined) input.block = call.block;
    if (call.runInBackground !== undefined) input.run_in_background = call.runInBackground;
    return { name: call.name, input, at };
  });
}

/* ---- sanitising --------------------------------------------------------- */

// Built from parts, the way `.github/scripts/scrub.sh` builds its needles, so
// this file never contains what it scrubs.
const HOME_DIR = new RegExp(`/${'Us'}${'ers'}/[^/\\s"'\`]+`, 'g');
const CLAUDE_TMP = /\/private\/tmp\/claude-\d+\/[^/\s"'`]+\/[^/\s"'`]+/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const PATH = /(?:\$HOME|~)?\/?[^\s"'`;|&<>()=]*\/[^\s"'`;|&<>()]*/g;
const DOMAIN = /\b[a-z0-9-]+\.(?:com|org|net|io|dev|ai|xyz|co|app|cloud)\b/i;
const PLACEHOLDER_EMAIL = 'dev@example.com';
const PLACEHOLDER_IP = '192.0.2.1';

/** 0 → a, 25 → z, 26 → ba: a digit-free name for the n-th distinct thing. */
function letters(n) {
  let out = '';
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  } while (n > 0);
  return out;
}

/**
 * Every path to `/tmp/<basename>` (or `/tmp/tasks/<basename>` when it named a
 * task output directory): what the guard reads of a path is its extension and
 * whether it sits under `/tasks/`, never where it lives. A basename with no
 * extension — a branch, a directory — tells the guard nothing and may name the
 * project, so it is renamed too.
 * @param {string} path
 * @param {(name: string) => string} rename
 */
function collapsePath(path, rename) {
  if (path === '/dev/null' || !path.includes('/')) return path;
  const underTasks = path.includes('/tasks/') || /\/tasks\/?$/.test(path);
  let base = path.endsWith('/') ? '' : path.slice(path.lastIndexOf('/') + 1);
  if (base && !base.includes('.')) base = rename(base);
  return `${underTasks ? '/tmp/tasks/' : '/tmp/'}${base}`;
}

/**
 * A command a fixture may keep: a probe, rewritten so nothing about the machine
 * or its people survives — home directories, session scratch paths, every path
 * down to its basename, emails, IPv4 addresses.
 * @param {string} command
 * @param {(name: string) => string} rename
 */
function scrubProbe(command, rename) {
  return command
    .replace(CLAUDE_TMP, '/tmp/claude')
    .replace(HOME_DIR, '$HOME')
    .replace(EMAIL, PLACEHOLDER_EMAIL)
    .replace(IPV4, PLACEHOLDER_IP)
    .replace(PATH, (path) => collapsePath(path, rename));
}

/**
 * The session as a fixture. A tool other than Bash keeps only its name (and a
 * TaskOutput whether it blocks). A Bash probe keeps its command, scrubbed. Any
 * other Bash command — the session's real work, which is none of a fixture's
 * business — becomes `: cmd-<letters>`, named by its digit-folded text so a
 * repeated command stays a repeat and two different ones never merge.
 * @param {TranscriptCall[]} calls
 * @returns {FixtureCall[]}
 */
export function sanitise(calls) {
  /** @type {Map<string, string>} */
  const names = new Map();
  /** @type {Map<string, string>} */
  const paths = new Map();
  /** @param {string} name */
  const rename = (name) => {
    const key = foldDigits(name);
    if (!paths.has(key)) paths.set(key, `name-${letters(paths.size)}`);
    return /** @type {string} */ (paths.get(key));
  };
  let previous = calls.length ? calls[0].at : 0;
  return calls.map((call) => {
    /** @type {FixtureCall} */
    const out = { dtMs: call.at - previous, name: call.name };
    previous = call.at;
    if (call.name === 'Bash') {
      const raw = typeof call.input.command === 'string' ? call.input.command : '';
      if (isProbeCommand(raw.trim())) {
        out.command = scrubProbe(raw.trim(), rename);
      } else {
        const key = foldDigits(raw.trim());
        if (!names.has(key)) names.set(key, `: cmd-${letters(names.size)}`);
        out.command = names.get(key);
      }
      if (call.input.run_in_background === true) out.runInBackground = true;
    } else if (call.name === 'TaskOutput' && typeof call.input.block === 'boolean') {
      out.block = call.input.block;
    }
    return out;
  });
}

/**
 * Refuse a fixture that would change what the guard decides, or still carries
 * something a fixture must not.
 * @param {TranscriptCall[]} raw
 * @param {FixtureCall[]} fixture
 * @returns {string[]} problems, empty when the fixture is safe to write
 */
export function fixtureProblems(raw, fixture) {
  const problems = [];
  const before = replayCalls(raw).verdicts;
  const after = replayCalls(fixtureCalls(fixture)).verdicts;
  for (let i = 0; i < before.length; i++) {
    if (before[i].status !== after[i]?.status || before[i].deny !== after[i]?.deny) {
      problems.push(`call #${i + 1} (${raw[i].name}): sanitising changed the guard's verdict`);
      break;
    }
  }
  for (const [i, call] of fixture.entries()) {
    const command = call.command ?? '';
    if (new RegExp(`/${'Us'}${'ers'}/`).test(command)) problems.push(`call #${i + 1}: a home path survived`);
    for (const ip of command.match(IPV4) ?? []) {
      if (ip !== PLACEHOLDER_IP) problems.push(`call #${i + 1}: an IPv4 address survived`);
    }
    for (const email of command.match(EMAIL) ?? []) {
      if (email !== PLACEHOLDER_EMAIL) problems.push(`call #${i + 1}: an email survived`);
    }
    if (DOMAIN.test(command.replace(PLACEHOLDER_EMAIL, '')))
      problems.push(`call #${i + 1}: a domain name survived`);
  }
  return problems;
}

/* ---- the verbs ---------------------------------------------------------- */

/** @param {TranscriptCall[]} calls */
function describe(calls) {
  const replay = replayCalls(calls);
  const episodes = replay.episodes.map(
    ({ index, at }) => `#${index} @ ${new Date(at).toISOString()} (${calls[index - 1].name})`,
  );
  return {
    replay,
    line: `${calls.length} calls · ${episodes.length ? `episodes ${episodes.join(', ')}` : 'silent'}`,
  };
}

function main(argv) {
  const [verb, ...rest] = argv;
  if (!verb || verb === '--help' || verb === '-h') {
    process.stdout.write(
      'usage: replay-poll-guard.mjs <transcript.jsonl>... | --dir <dir>... | --extract <transcript.jsonl>...\n',
    );
    return verb ? 0 : 2;
  }
  if (verb === '--extract') {
    const raw = readSession(rest);
    const fixture = sanitise(raw);
    const problems = fixtureProblems(raw, fixture);
    if (problems.length) {
      process.stderr.write(`refused:\n  ${problems.join('\n  ')}\n`);
      return 1;
    }
    const id = basename(rest[0] ?? '', '.jsonl').slice(0, 8);
    const lines = fixture.map((call) => `    ${JSON.stringify(call)}`);
    process.stdout.write(
      `{\n  "session": ${JSON.stringify(id)},\n  "calls": [\n${lines.join(',\n')}\n  ]\n}\n`,
    );
    process.stderr.write(`${id}: ${describe(raw).line}\n`);
    return 0;
  }
  if (verb === '--dir') {
    const dirs = [];
    for (let i = 0; i < rest.length; i++) dirs.push(rest[i] === '--dir' ? rest[++i] : rest[i]);
    /** @type {Map<string, string[]>} */
    const sessions = new Map();
    for (const dir of dirs) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue;
        sessions.set(name, [...(sessions.get(name) ?? []), join(dir, name)]);
      }
    }
    let total = 0;
    let firing = 0;
    for (const [name, files] of [...sessions.entries()].sort()) {
      const calls = readSession(files);
      total += calls.length;
      const { replay, line } = describe(calls);
      if (replay.episodes.length) {
        firing += 1;
        process.stdout.write(`${basename(name, '.jsonl')}: ${line}\n`);
      }
    }
    process.stdout.write(`sessions ${sessions.size} · tool calls ${total} · firing ${firing}\n`);
    return 0;
  }
  const calls = readSession(argv);
  process.stdout.write(`${basename(argv[0], '.jsonl')}: ${describe(calls).line}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
