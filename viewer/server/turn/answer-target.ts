/**
 * Where a decision's answer is written so its proof can read it (one-pool
 * phase 13, #368; every `^<key>:` shape since 2026-10-20).
 *
 * A plan-born decision with options whose proof reads a FILE — the shape every
 * plan's "the owner answers in owner-answers.md" errand takes — could never
 * pass: nothing the console did wrote the file, so *Send my decision* settled
 * the card while the plan's own proof, and every phase that greps the same
 * file, still read "pending". The answer press now writes the answer where
 * the proof looks, then runs the proof (`ServiceRecovery.answerHumanStep`):
 *
 *   - `cmd:"grep [-flags] '^<key>: …' <file>"` — one line appended, the first
 *     of these the proof's OWN pattern accepts (`answerLineFor`): `<key>:
 *     <option id>`, a plan's own convention ("one `key: value` line each",
 *     the value a lower-case word that a plan's gate tool reads whole), then
 *     `<key>: answered — <option label>[: <note>]` (#368's line);
 *   - `cmd:"test -f|-e|-s <file>"` and `credential:file:<file>` — the file
 *     written with the answer.
 *
 * A pattern is read through `grepMatcher`, a deliberately small translation of
 * grep's BRE and ERE into a JS RegExp; a construct it does not know names no
 * place an answer can go. Anything else names no place either, and the proof
 * is simply run (a decision whose proof the answer cannot satisfy comes back
 * Redo, saying what it read). The file must be in the plan's own handoffs
 * folder, reached through no link — the console writes nowhere else on a
 * press. A value line never carries the person's note: a plan's tools read
 * the value whole, so the note goes to the AI another way
 * (`ServiceRecovery.tellPlanDecision`).
 */

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { cmdOfRef } from '../../shared/proof-words.js';
import { redactSecrets } from '../../shared/human-step-model.js';

/** Where an answer goes, and how — a line its proof's pattern `accepts`, or a whole file. */
export type AnswerTarget =
  | { file: string; mode: 'append-line'; key: string; accepts: (line: string) => boolean }
  | { file: string; mode: 'write' };

/** The words an answer is written from. */
export type AnswerWords = { option?: string; label?: string; note?: string };

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

/** What may sit between a pattern's words: a space, `\s`, `[[:space:]]`, each maybe starred. */
const GAP = String.raw`(?: |\s|\\s\*?|\[\[:space:\]\]\*?| \*)*`;

/** A grep pattern that looks for `<key>: answered` at a line's start — the key, or null. */
export function answeredKeyOf(pattern: string): string | null {
  const shape = new RegExp(String.raw`^\^?${GAP}([A-Za-z0-9_.-]+)${GAP}:${GAP}answered\b`, 'i');
  const m = shape.exec(pattern);
  return m ? m[1]! : null;
}

/** The key a grep pattern looks for at a line's start — `^<key>:` — or null. */
export function keyOf(pattern: string): string | null {
  const m = new RegExp(String.raw`^\^?${GAP}([A-Za-z0-9_.-]+)${GAP}:`).exec(pattern);
  return m ? m[1]! : null;
}

/** The POSIX classes a bracket may name, as a JS class body — the rest are not known here. */
const POSIX_CLASSES: Readonly<Record<string, string>> = Object.freeze({
  space: String.raw`\s`, blank: ' \\t', alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9',
  upper: 'A-Z', lower: 'a-z', xdigit: '0-9A-Fa-f',
});

/** A bracket expression from `at` (its `[`), as a JS class — and where it ends — or null. */
function bracketOf(src: string, at: number): { out: string; next: number } | null {
  let i = at + 1;
  let out = '[';
  if (src[i] === '^') { out += '^'; i++; }
  // A `]` first is a member, never the end.
  if (src[i] === ']') { out += '\\]'; i++; }
  while (i < src.length && src[i] !== ']') {
    if (src.startsWith('[:', i)) {
      const end = src.indexOf(':]', i + 2);
      const named = end < 0 ? undefined : POSIX_CLASSES[src.slice(i + 2, end)];
      if (named === undefined) return null;
      out += named;
      i = end + 2;
      continue;
    }
    if (src.startsWith('[=', i) || src.startsWith('[.', i)) return null;
    const c = src[i]!;
    // A backslash is a member of a POSIX bracket; in a JS class it escapes.
    out += c === '\\' || c === '[' ? `\\${c}` : c;
    i++;
  }
  return i < src.length ? { out: `${out}]`, next: i + 1 } : null;
}

/**
 * A grep pattern as a JS RegExp, matched against one line — or null for any
 * construct this does not know (then no answer is written: the proof decides
 * alone). BRE by default, ERE with `-E`/`egrep`, a fixed string with
 * `-F`/`fgrep`; `-i` folds case, `-w` matches whole words, `-x` whole lines.
 */
export function grepMatcher(
  pattern: string, how: { ere?: boolean; fixed?: boolean; ignoreCase?: boolean; word?: boolean; line?: boolean } = {},
): RegExp | null {
  let src = '';
  if (how.fixed) {
    src = pattern.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
  } else {
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i]!;
      if (c === '\\') {
        const next = pattern[i + 1];
        if (next === undefined) return null;
        i++;
        // In a BRE these are the operators; in an ERE, escaped, they are literals.
        if (!how.ere && '(){}|+?'.includes(next)) { src += next; continue; }
        if ('.*[]^$\\/(){}|+?'.includes(next)) { src += `\\${next}`; continue; }
        if ('sSwWbB'.includes(next) || /[1-9]/.test(next)) { src += `\\${next}`; continue; }
        return null;
      }
      if (c === '[') {
        const bracket = bracketOf(pattern, i);
        if (!bracket) return null;
        src += bracket.out;
        i = bracket.next - 1;
        continue;
      }
      // A BRE's `( ) { } | + ?` are plain characters.
      if (!how.ere && '(){}|+?'.includes(c)) { src += `\\${c}`; continue; }
      src += c;
    }
  }
  if (how.line) src = `^(?:${src})$`;
  else if (how.word) src = `(?<![A-Za-z0-9_])(?:${src})(?![A-Za-z0-9_])`;
  try {
    return new RegExp(src, how.ignoreCase ? 'i' : '');
  } catch {
    return null;
  }
}

/** grep's flags this reads: quiet, case, the dialect, words, lines and what changes no match. */
const KNOWN_FLAGS = /^[qsiyEFGwxnHhlaIo]*$/;

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
  if (lead !== 'grep' && lead !== 'egrep' && lead !== 'fgrep') return null;
  let pattern: string | null = null;
  let flags = '';
  const operands: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!;
    if (pattern === null && operands.length === 0 && word === '-e') { pattern = rest[++i] ?? null; continue; }
    if (operands.length === 0 && /^-[A-Za-z]+$/.test(word)) {
      let letters = word.slice(1);
      // `-qe <pattern>`: the pattern is the next word.
      if (letters.endsWith('e') && pattern === null) {
        letters = letters.slice(0, -1);
        pattern = rest[++i] ?? null;
      }
      // An inverted, counted or listed-absent match, a pattern file, a
      // context or a dialect not read here: no answer line can be known.
      if (!KNOWN_FLAGS.test(letters)) return null;
      flags += letters;
      continue;
    }
    operands.push(word);
  }
  if (pattern === null) pattern = operands.shift() ?? null;
  if (!pattern || operands.length !== 1) return null;
  const file = operands[0]!;
  if (!isAbsolute(file)) return null;
  const key = keyOf(pattern);
  if (!key) return null;
  const matcher = grepMatcher(pattern, {
    ere: flags.includes('E') || lead === 'egrep',
    fixed: flags.includes('F') || lead === 'fgrep',
    ignoreCase: /[iy]/.test(flags),
    word: flags.includes('w'),
    line: flags.includes('x'),
  });
  if (matcher) return { file, mode: 'append-line', key, accepts: (line) => matcher.test(line) };
  // #368's own shape, read by its own grammar where the translation knows less.
  const answered = answeredKeyOf(pattern);
  return answered
    ? { file, mode: 'append-line', key: answered, accepts: (line) => line.toLowerCase().startsWith(`${answered.toLowerCase()}: answered`) }
    : null;
}

/** The line an answer is written as, in #368's shape. */
export function answerLine(key: string | null, answer: { label?: string; note?: string }): string {
  const said = [answer.label, answer.note].filter((part) => typeof part === 'string' && part.trim())
    .map((part) => redactSecrets(String(part)).replace(/[\u0000-\u001f]+/g, ' ').trim()).join(': ');
  return `${key ? `${key}: ` : ''}answered${said ? ` — ${said}` : ''}`.slice(0, 500);
}

/** A value as a plan's answer file spells one: a lower-case word. */
const VALUE_WORD = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * The line an answer is written as — the first the proof's pattern accepts:
 * `<key>: <option id>` (the plan's own convention, read whole by its tools),
 * then `<key>: answered — <label>[: <note>]`. Null when the proof accepts
 * neither: then nothing is written, and the proof decides alone. A `write`
 * target's file holds the answer itself.
 */
export function answerLineFor(target: AnswerTarget, answer: AnswerWords): string | null {
  if (target.mode === 'write') return answerLine(null, answer);
  const candidates = [
    ...(answer.option && VALUE_WORD.test(answer.option) ? [`${target.key}: ${answer.option}`] : []),
    answerLine(target.key, answer),
  ];
  return candidates.find((line) => target.accepts(line)) ?? null;
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
  target: AnswerTarget, dir: string, root: string, answer: AnswerWords,
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
  const line = answerLineFor(target, answer);
  if (line === null) return { ok: false, why: `${target.file}'s check looks for a line this answer cannot say` };
  const at = join(real, name);
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

/** An answer file in words a person reads — `docs/handoffs/<slug>/<file>` where it is one, else its name. */
export function answerFileWords(file: string): string {
  const at = file.lastIndexOf('/docs/handoffs/');
  return at >= 0 ? file.slice(at + 1) : basename(file);
}
