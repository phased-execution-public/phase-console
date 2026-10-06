/**
 * What a shell line EXECUTES — the only words a permission rule may match
 * (control-tower phase 107, #189, #186).
 *
 * The approval judge matched its rules against the RAW command, split at `;`,
 * `&&`, `|` and newlines. So the body of a quoted here-doc, a `python3 -c`
 * payload and a quoted argument were all read as shell: a `python3 - <<'EOF'`
 * that rewrote a handoff whose TEXT mentioned `git push -u origin …` raised a
 * person's card — "the command carries a substitution the row cannot vouch
 * for", for the markdown backticks in the handoff — and parked a release phase.
 * Nothing in that command pushed anything.
 *
 * This reads a line the way bash does, on `splitStatements` (`liveness.ts`, the
 * in-turn wait guard's own splitter), and answers with the simple commands it
 * would run:
 *
 *   - a quoted string is ONE word of the command that receives it — data;
 *   - a here-doc body is data to the command reading it, unless a SHELL reads
 *     it (`bash <<EOF`, `cat <<EOF | sh`) — then it is split like any line; an
 *     UNQUOTED body's `$( … )` and backticks are code either way, because the
 *     shell expands them before the command ever sees the text;
 *   - `$( … )`, backtick and `<( … )` bodies are commands of their own;
 *   - a group's body (`( … )`, `{ … }`) and a compound's (`if`, `while`,
 *     `until`, `for`, `case`) are split again;
 *   - a SHELL's `-c` payload and an `eval`'s words are read again as a line,
 *     and a lead that runs what it is handed elsewhere (`ssh`, `xargs`, `find
 *     -exec`, `docker exec`, `git submodule foreach`, `watch`, …) offers every
 *     suffix of its words — a rule matching any of them matches the payload;
 *   - assignments, wrappers and runners in front of a lead are stepped over
 *     (`FOO=1 sudo -u ops git push` is a `git push`), and the unpeeled words
 *     are kept beside them, so a rule about the wrapper still sees it.
 *
 * What it cannot see it NAMES rather than guesses (`opaque`): an `eval` of a
 * value only the shell knows, a command word that is itself an expansion
 * (`$CMD …`), a shell reading a program from a pipe, a shell running a FILE
 * on a line that also carries a data here-doc (`cat > r.sh <<'EOF' … EOF;
 * bash r.sh` — the file may be the one this very line wrote), text that never
 * closes what it opened, nesting past the bound. A script the line merely
 * runs (`bash scripts/build.sh --note "…"`) is a file the judge does not open,
 * like one the Write tool made: its ARGUMENTS stay data. A caller that must never be weaker than the raw reading — the deny
 * wall — matches the raw segments as well whenever `opaque` is not empty.
 *
 * Reading spawns nothing and evaluates nothing: it is a parser over text.
 */

import { basename, executes, leadWords, shellWords, splitStatements, type HereDoc, type Statement } from './liveness.ts';

/** How deep groups, substitutions, compounds and payloads are taken apart. */
const MAX_DEPTH = 8;
/** How many words of a lead that runs its argument are offered as suffixes. */
const SUFFIX_WORDS = 40;

/** Where a command sat: the line itself, or inside something the shell runs. */
export type ShellCommandFrom = 'line' | 'substitution' | 'heredoc' | 'payload' | 'eval' | 'group' | 'compound';

export type ShellCommand = {
  /** Its words with quotes resolved and redirections dropped — what the program is handed. */
  words: string[];
  /** The same command from its real lead: assignments, wrappers and runners stepped over. */
  lead: string[];
  from: ShellCommandFrom;
  /** A statement of the line itself — not inside a substitution, group, compound or payload. */
  top: boolean;
  /** The bodies of the `$( … )`, backtick and `<( … )` substitutions in its own words. */
  substitutions: string[];
  /**
   * A parameter expansion in its words (`$X`, `${X}`, `"$@"`) outside single
   * quotes — a value only the shell knows. `$?` is not one: it reads the last
   * exit status and names nothing.
   */
  expands: boolean;
  /** Its lead runs what it is handed (`xargs`, `ssh`, `find -exec`, a shell's `-c` …). */
  runsItsArgument: boolean;
  /** One of the suffixes offered for such a lead, not a command written as such. */
  suffix?: boolean;
};

export type ShellOpaqueKind = 'eval' | 'dynamic' | 'stdin' | 'script' | 'malformed' | 'nesting';

export type ShellReading = {
  commands: ShellCommand[];
  /** Statements that only assign (`rc=$?`, `HEAD=$(git rev-parse HEAD)`): they run nothing but their substitutions. */
  assignments: number;
  /** Their words (`rc=$?`, `PATH=/x:$PATH`) — an assignment may change what a later command of the line runs. */
  assigned: string[];
  /** Names the line defines as shell functions (`git() { … }`), which shadow the command of that name. */
  functions: string[];
  /** Executed text this reader could not resolve, and what made it so. */
  opaque: { kind: ShellOpaqueKind; text: string }[];
  /** Every here-doc met, quoted or not, and whether a shell read it. */
  heredocs: HereDoc[];
  /**
   * The targets of the output redirections of every statement the shell runs
   * (`> f`, `>> f`, `2> f`, `&> f`, glued or not) — what the line writes besides
   * what its programs write (control-tower phase 129). A duplication (`2>&1`)
   * names no file.
   */
  writes: string[];
};

const SHELL_LEAD = /^(bash|sh|zsh|dash|ksh|fish)$/;
/** Leads that run a FILE in the current shell. */
const SOURCE_LEAD = /^(source|\.)$/;
/** Words that stand before a statement's command inside a compound without being it. */
const RESERVED_LEAD = new Set(['then', 'do', 'else', 'elif', '!', '{', '}']);
const COMPOUND_OPENERS = new Set(['if', 'while', 'until', 'for', 'select', 'case']);
const COMPOUND_CLOSERS = /^(fi|done|esac)\b/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
/** A parameter expansion other than `$?` — after single quotes and substitutions are masked. */
const EXPANSION = /\$(?:\{|[A-Za-z_@*#!0-9-])/;

/**
 * Words with the redirections taken off: `>`, `>>`, `2>`, `&>`, `<` with their
 * target or glued to it, a duplication (`2>&1`), and a here-doc or here-string
 * operator with its delimiter or its string — which are data.
 */
export function withoutRedirections(words: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] ?? '';
    if (/^\d*<<-?$/.test(w) || /^\d*<<<$/.test(w)) { i += 1; continue; }
    if (/^\d*<<[<-]?./.test(w)) continue;
    if (/^(?:\d*|&)(?:>>?|<)&?\d*$/.test(w)) {
      if (!/&\d+$/.test(w)) i += 1;
      continue;
    }
    if (/^(?:\d*|&)(?:>>?|<)/.test(w)) continue;
    kept.push(w);
  }
  return kept;
}

/** The targets of the OUTPUT redirections among a statement's words — the files `withoutRedirections` drops with them. */
export function redirectionTargets(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] ?? '';
    if (/^\d*<</.test(w)) continue;
    const bare = /^(?:\d*|&)>>?\|?$/.exec(w);
    if (bare) {
      if (words[i + 1] !== undefined) out.push(words[i + 1] ?? '');
      i += 1;
      continue;
    }
    const glued = /^(?:\d*|&)>>?\|?(.+)$/.exec(w);
    if (glued && !/^&\d*-?$/.test(glued[1] ?? '')) out.push(glued[1] ?? '');
  }
  return out.filter(Boolean);
}

/** The statement's text with substitutions and single-quoted spans blanked — for the expansion test. */
function unquotedText(statement: Pick<Statement, 'text' | 'substitutions' | 'quotes'>): string {
  let out = statement.text;
  const spans = [
    ...statement.substitutions.map((s) => ({ start: s.start, end: s.end })),
    ...statement.quotes.filter((q) => statement.text[q.start] === "'").map((q) => ({ start: q.start, end: q.end })),
  ];
  for (const span of spans) {
    if (span.start < 0 || span.end > out.length) continue;
    out = out.slice(0, span.start) + ' '.repeat(span.end - span.start) + out.slice(span.end);
  }
  return out.replace(/\$\?/g, '  ');
}

/**
 * An UNQUOTED here-doc body as the inside of double quotes, which it reads
 * like: a backslash still quotes `$`, a backtick, a backslash and a newline;
 * before anything else — `"` included — it is a literal backslash; and a `"`
 * is a literal quote. So an escaped `\$(cmd)` stays text and `$(cmd)` stays code.
 */
function asDoubleQuoted(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i] ?? '';
    if (c === '\\') {
      const next = body[i + 1];
      if (next === '$' || next === '`' || next === '\\' || next === '\n') {
        out += c + next;
        i += 1;
      } else {
        out += '\\\\';
      }
      continue;
    }
    out += c === '"' ? '\\"' : c;
  }
  return `"${out}"`;
}

/** The substitutions an UNQUOTED here-doc body runs. */
function bodySubstitutions(body: string): string[] {
  try {
    const [statement] = splitStatements(asDoubleQuoted(body));
    return statement?.substitutions.map((s) => s.body) ?? [];
  } catch {
    return [];
  }
}

/** Read one line. Never throws: what cannot be read is `opaque`. */
export function readShell(command: string): ShellReading {
  const reading: ShellReading = {
    commands: [], assignments: 0, assigned: [], functions: [], opaque: [], heredocs: [], writes: [],
  };
  if (typeof command === 'string' && command.trim()) readLine(command, 'line', 0, reading);
  return reading;
}

function readLine(text: string, from: ShellCommandFrom, depth: number, out: ShellReading): void {
  if (depth > MAX_DEPTH) {
    out.opaque.push({ kind: 'nesting', text: text.slice(0, 400) });
    return;
  }
  const docs: HereDoc[] = [];
  let statements: Statement[];
  try {
    statements = splitStatements(text, 0, docs);
  } catch {
    out.opaque.push({ kind: 'malformed', text: text.slice(0, 400) });
    return;
  }
  out.heredocs.push(...docs);
  for (const doc of docs) {
    // A code body is already among the statements; a quoted one is literal.
    if (doc.code || doc.quoted) continue;
    for (const body of bodySubstitutions(doc.body)) readLine(body, 'heredoc', depth + 1, out);
  }
  for (const statement of statements) readStatement(statement, statement.fromHeredoc ? 'heredoc' : from, depth, out);
}

/**
 * The statement with each of its own substitutions (`$( … )`, backticks,
 * `<( … )`) standing as ONE word, `$(…)`: their bodies are read as commands of
 * their own, and the command around them is handed a value only the shell
 * computes — which is all a reader of its words may assume.
 */
function maskSubstitutions(statement: Statement): string {
  let out = '';
  let cursor = 0;
  for (const sub of [...statement.substitutions].sort((a, b) => a.start - b.start)) {
    if (sub.start < cursor || sub.end > statement.text.length) continue;
    out += `${statement.text.slice(cursor, sub.start)}$(…)`;
    cursor = sub.end;
  }
  return out + statement.text.slice(cursor);
}

function readStatement(statement: Statement, from: ShellCommandFrom, depth: number, out: ShellReading): void {
  if (statement.malformed) out.opaque.push({ kind: 'malformed', text: statement.text.slice(0, 400) });
  // `name() { … }` / `function name { … }`: the body is read below as a
  // group; the NAME is what the rest of the line will call instead.
  const fn = /^\s*(?:function\s+([^\s(){}<>|&;]+)|([^\s(){}<>|&;=]+)\s*\(\s*\))/.exec(statement.text);
  if (fn) out.functions.push(fn[1] ?? fn[2] ?? '');
  for (const sub of statement.substitutions) readLine(sub.body, 'substitution', depth + 1, out);
  if (statement.inner !== undefined) {
    readLine(statement.inner, 'group', depth + 1, out);
    return;
  }

  // The reserved words a compound's body begins its statements with.
  let text = maskSubstitutions(statement);
  for (;;) {
    const head = /^(\S+)\s+([\s\S]*)$/.exec(text.trim());
    if (!head || !RESERVED_LEAD.has(head[1] ?? '')) break;
    text = head[2] ?? '';
  }
  const first = /^(\S+)/.exec(text.trim())?.[1] ?? '';
  if (COMPOUND_OPENERS.has(first)) {
    readCompound(first, text.trim(), depth, out);
    return;
  }
  if (COMPOUND_CLOSERS.test(text.trim()) || RESERVED_LEAD.has(text.trim())) return;

  const raw = shellWords(text);
  out.writes.push(...redirectionTargets(raw));
  const words = withoutRedirections(raw);
  if (!words.length) return;
  if (words.every((w) => ASSIGNMENT.test(w))) {
    out.assignments += 1;
    out.assigned.push(...words);
    return;
  }
  const lead = withoutRedirections(leadWords(text));
  const leadWord = basename(lead[0] ?? '');
  const top = from === 'line' && depth === 0;
  const runs = executes(text);
  const masked = unquotedText({ ...statement, text: statement.text });
  out.commands.push({
    words, lead: lead.length ? lead : words, from, top,
    substitutions: statement.substitutions.map((s) => s.body),
    expands: EXPANSION.test(masked),
    runsItsArgument: runs,
  });

  // A command word only the shell knows.
  if (!leadWord || leadWord.startsWith('$') || leadWord.includes('`')) {
    out.opaque.push({ kind: 'dynamic', text: text.slice(0, 400) });
    return;
  }
  if (leadWord === 'coproc' && lead.length > 1) {
    // `coproc [NAME] command`: the shell runs the command (in the background),
    // so it is a command of the line — a NAME only ever precedes a compound.
    const rest = text.trim().replace(/^coproc\s+/, '');
    const named = /^[A-Za-z_][A-Za-z0-9_]*\s+(?=[{(])/.exec(rest);
    readLine(named ? rest.slice(named[0].length) : rest, 'compound', depth + 1, out);
    return;
  }
  if (leadWord === 'eval') {
    const payload = lead.slice(1).join(' ');
    if (EXPANSION.test(masked) || statement.substitutions.length) out.opaque.push({ kind: 'eval', text: text.slice(0, 400) });
    readLine(payload, 'eval', depth + 1, out);
    return;
  }
  if (SHELL_LEAD.test(leadWord)) {
    const c = lead.findIndex((w, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
    if (c > 0 && lead[c + 1] !== undefined) {
      readLine(lead[c + 1] ?? '', 'payload', depth + 1, out);
      return;
    }
    // A shell with no `-c` reads its program from its input — a here-doc
    // (already split) or a pipe, whose text is not in this line — or from a
    // script file, which this judge does not open. That file may be one this
    // very line wrote from a here-doc's DATA, which the shell then runs.
    if (statement.text.includes('<<') || statement.fromHeredoc) return;
    if (lead.slice(1).every((w) => w.startsWith('-') || w === '/dev/stdin')) {
      out.opaque.push({ kind: 'stdin', text: text.slice(0, 400) });
    } else if (wroteData(out)) {
      out.opaque.push({ kind: 'script', text: text.slice(0, 400) });
    }
    return;
  }
  if (SOURCE_LEAD.test(leadWord) && lead.length > 1 && wroteData(out)) {
    out.opaque.push({ kind: 'script', text: text.slice(0, 400) });
    return;
  }
  if (runs) {
    // `ssh host cmd…`, `xargs git push …`, `find . -exec … \;`: every suffix is
    // a candidate command — matching can only ever grow from it.
    const bounded = lead.slice(0, SUFFIX_WORDS);
    for (let i = 1; i < bounded.length; i += 1) {
      const rest = bounded.slice(i);
      out.commands.push({
        words: rest, lead: rest, from: 'payload', top: false, substitutions: [], expands: false,
        runsItsArgument: false, suffix: true,
      });
    }
  }
}

/** Does the line carry a here-doc whose body is DATA — text a later command may run as a file? */
function wroteData(out: ShellReading): boolean {
  return out.heredocs.some((doc) => !doc.code);
}

/** `if`/`while`/`until` bodies, `for`/`select` loops and `case` arms, split again. */
function readCompound(opener: string, text: string, depth: number, out: ShellReading): void {
  if (opener === 'case') {
    // `case WORD in pat) cmds ;; pat) cmds ;; esac` — each arm's commands.
    const inAt = /\sin\s/.exec(text);
    if (!inAt) {
      out.opaque.push({ kind: 'malformed', text: text.slice(0, 400) });
      return;
    }
    const body = text.slice(inAt.index + inAt[0].length).replace(/\besac\s*$/, '');
    for (const arm of body.split(/;;&?|;&/)) {
      const close = arm.indexOf(')');
      const commands = close >= 0 ? arm.slice(close + 1) : arm;
      if (commands.trim()) readLine(commands, 'compound', depth + 1, out);
    }
    return;
  }
  let body = text.slice(opener.length);
  if (opener === 'for' || opener === 'select') {
    // The loop's header names words, not commands — but a substitution in it
    // runs, and `splitStatements` has already handed those to the caller.
    const doAt = /(?:;|\n|\s)\s*do\b/.exec(body);
    body = doAt ? body.slice(doAt.index) : '';
  }
  if (body.trim()) readLine(body, 'compound', depth + 1, out);
}

/**
 * The text a permission rule is matched against for one Bash call: each
 * command the line runs, its words joined, from its own words and from its
 * real lead. Data — a quoted here-doc's body, a `python3 -c` payload, a quoted
 * argument — is never one of them.
 */
export function executedTexts(reading: ShellReading): string[] {
  const out = new Set<string>();
  for (const command of reading.commands) {
    out.add(command.words.join(' '));
    out.add(command.lead.join(' '));
    const git = gitCanonical(command.lead);
    if (git) out.add(git.join(' '));
  }
  out.delete('');
  return [...out];
}

/**
 * `git -C dir -c k=v --no-pager push …` as `git push …`: git's own options
 * before its verb, stepped over, so a rule written `Bash(git push:*)` sees the
 * push it names. Null when the words are not git's or carry no such option.
 */
export function gitCanonical(words: readonly string[]): string[] | null {
  if (basename(words[0] ?? '') !== 'git') return null;
  let i = 1;
  while (i < words.length && (words[i] ?? '').startsWith('-')) {
    const flag = words[i] ?? '';
    i += flag === '-C' || flag === '-c' || flag === '--git-dir' || flag === '--work-tree' || flag === '--namespace' ? 2 : 1;
  }
  return i > 1 && i < words.length ? ['git', ...words.slice(i)] : null;
}
