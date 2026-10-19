/**
 * Where a decision's answer is written so its proof can read it (one-pool
 * phase 13, #368).
 *
 * A plan-born decision with options whose proof reads a FILE — the shape every
 * plan's "the owner answers in owner-answers.md" errand takes — could never
 * pass: nothing the console did wrote the file, so *Send my decision* settled
 * the card while the plan's own proof, and every phase that greps the same
 * file, still read "pending". The answer press now writes the answer where
 * the proof looks, then runs the proof (`ServiceRecovery.answerHumanStep`):
 *
 *   - `cmd:"grep [-flags] '^<key>: answered' <file>"` — one line appended,
 *     `<key>: answered — <option label>[: <note>]`;
 *   - `cmd:"test -f|-e|-s <file>"` and `credential:file:<file>` — the file
 *     written with the answer.
 *
 * Anything else names no place an answer can go, and the proof is simply run
 * (a decision whose proof the answer cannot satisfy comes back Redo, saying
 * what it read). The file must be in the plan's own handoffs folder, reached
 * through no link — the console writes nowhere else on a press.
 */

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { cmdOfRef } from '../../shared/proof-words.js';
import { redactSecrets } from '../../shared/human-step-model.js';

/** Where an answer goes, and how. */
export type AnswerTarget =
  | { file: string; mode: 'append-line'; key: string }
  | { file: string; mode: 'write' };

/**
 * A command split into words as the shell reads them — quotes removed,
 * backslashes honoured — or null when it is not one plain command (a pipe, a
 * chain, a redirect, a substitution).
 */
export function shellWords(command: string): string[] | null {
  const out: string[] = [];
  let word = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '\\' && i + 1 < command.length && '"\\$`'.includes(command[i + 1]!)) { word += command[++i]; continue; }
      if (c === '"') { quote = null; continue; }
      if (c === '$' || c === '`') return null;
      word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === '\\' && i + 1 < command.length) { word += command[++i]; started = true; continue; }
    if (/\s/.test(c)) {
      if (started) { out.push(word); word = ''; started = false; }
      continue;
    }
    if ('|&;<>()$`'.includes(c)) return null;
    word += c;
    started = true;
  }
  if (quote) return null;
  if (started) out.push(word);
  return out;
}

/** A grep pattern that looks for `<key>: answered` at a line's start — the key, or null. */
export function answeredKeyOf(pattern: string): string | null {
  const gap = String.raw`(?: |\s|\\s\*?|\[\[:space:\]\]\*?| \*)*`;
  const shape = new RegExp(String.raw`^\^?${gap}([A-Za-z0-9_.-]+)${gap}:${gap}answered\b`, 'i');
  const m = shape.exec(pattern);
  return m ? m[1]! : null;
}

/** The place a proof reads an answer from, or null when it names none. */
export function answerTargetOf(proof: string | undefined | null): AnswerTarget | null {
  const ref = String(proof ?? '').trim();
  if (ref.startsWith('credential:file:')) {
    const file = ref.slice('credential:file:'.length).trim();
    return isAbsolute(file) ? { file, mode: 'write' } : null;
  }
  if (!ref.startsWith('cmd:')) return null;
  const words = shellWords(cmdOfRef(ref.slice(4)));
  if (!words?.length) return null;
  const [lead, ...rest] = words;
  if ((lead === 'test' || lead === '[') && rest.length >= 2 && /^-[efs]$/.test(rest[0]!)) {
    const file = rest[1]!;
    if (lead === '[' && rest[2] !== ']') return null;
    if (rest.length > (lead === '[' ? 3 : 2)) return null;
    return isAbsolute(file) ? { file, mode: 'write' } : null;
  }
  if (lead !== 'grep' && lead !== 'egrep') return null;
  let pattern: string | null = null;
  const operands: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!;
    if (pattern === null && operands.length === 0 && word === '-e') { pattern = rest[++i] ?? null; continue; }
    if (operands.length === 0 && /^-[A-Za-z]+$/.test(word)) {
      if (/[fmABCd]/.test(word.slice(1))) return null;
      continue;
    }
    operands.push(word);
  }
  if (pattern === null) pattern = operands.shift() ?? null;
  if (!pattern || operands.length !== 1) return null;
  const file = operands[0]!;
  const key = answeredKeyOf(pattern);
  return key && isAbsolute(file) ? { file, mode: 'append-line', key } : null;
}

/** The line an answer is written as. */
export function answerLine(key: string | null, answer: { label?: string; note?: string }): string {
  const said = [answer.label, answer.note].filter((part) => typeof part === 'string' && part.trim())
    .map((part) => redactSecrets(String(part)).replace(/[\u0000-\u001f]+/g, ' ').trim()).join(': ');
  return `${key ? `${key}: ` : ''}answered${said ? ` — ${said}` : ''}`.slice(0, 500);
}

/**
 * Write an answer where its proof reads it — only under `dir`, the plan's OWN
 * handoffs folder (`docs/handoffs/<slug>/`), where a plan keeps the files a
 * person's answers go to: a proof naming any other file is never written,
 * however it is spelled. The file is opened with `O_NOFOLLOW` after its folder
 * was resolved inside `dir`, so a link in its place is refused rather than
 * followed; `append-line` adds one line, and `write` only CREATES the file —
 * an existing one is never overwritten (its proof already holds if it exists).
 * Answers the file written, relative to `root`, or why nothing was.
 */
export function writeAnswer(
  target: AnswerTarget, dir: string, root: string, answer: { label?: string; note?: string },
): { ok: true; file: string } | { ok: false; why: string } {
  const file = resolve(target.file);
  let allowed: string;
  try { allowed = realpathSync(dir); } catch { return { ok: false, why: `the plan's handoffs folder ${relative(root, dir) || dir} does not exist` }; }
  const folder = dirname(file);
  let real: string;
  try { real = realpathSync(folder); } catch { return { ok: false, why: `${relative(root, folder) || folder} does not exist` }; }
  const rel = relative(allowed, real);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, why: `${target.file} is not in the plan's own handoffs folder, and the console writes an answer nowhere else` };
  }
  const name = basename(file);
  if (!name || name === '.' || name === '..') return { ok: false, why: `${target.file} names no file` };
  const at = join(real, name);
  const line = target.mode === 'append-line' ? answerLine(target.key, answer) : answerLine(null, answer);
  let fd: number | null = null;
  try {
    const flags = target.mode === 'append-line'
      ? constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW
      : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    fd = openSync(at, flags, 0o644);
    const size = fstatSync(fd).size;
    let lead = '';
    if (target.mode === 'append-line' && size > 0) {
      const last = Buffer.alloc(1);
      const read = openSync(at, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { readSync(read, last, 0, 1, size - 1); } finally { closeSync(read); }
      if (last.toString('utf8') !== '\n') lead = '\n';
    }
    writeSync(fd, `${lead}${line}\n`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ELOOP') return { ok: false, why: `${target.file} is a link, and the console writes an answer through no link` };
    if (code === 'EEXIST') return { ok: false, why: `${target.file} exists already, and the console never overwrites a file with an answer` };
    return { ok: false, why: `${target.file} could not be written — ${String((error as Error)?.message ?? error).slice(0, 120)}` };
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return { ok: true, file: relative(realpathSync(root), at) || at };
}
