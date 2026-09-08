/**
 * "What is an argument list" — one definition, two gates.
 *
 * `never-push.test.ts` scans `server/` for git argv; `issues-readonly.test.ts`
 * scans it for `gh` argv. They must agree about what an argv IS, and the way to
 * guarantee that is one function rather than two that look alike. This file is
 * deliberately not a `*.test.ts`, so importing it registers no tests — the
 * second gate used to import the first and silently re-run its eleven.
 *
 * The holes this scanner has had, both found by mutating and both closed here
 * rather than in either caller:
 *
 *  - **A variable among the arguments.** The push somebody would actually write
 *    is `['push', 'origin', branch]`, and requiring an array of *only* string
 *    literals made that invisible. So the span between an unnested `[` and its
 *    `]` is taken whole and its string literals read out.
 *  - **Quote style.** This repository's lint settles on single quotes, so a
 *    double-quoted `["push", …]` looks like a formatting slip and was invisible
 *    to a single-quote gate — which is exactly the state a hurried edit arrives
 *    in. All three styles are read.
 *
 *  - **A `return` in front of it.** A `[` directly after an identifier, `)` or
 *    `]` is an index access (`record['push']`) and is skipped — but a KEYWORD
 *    is not an identifier, and `return ['push', 'origin', 'main']` ends in `n`.
 *    Both gates went green over a returned argv (QA round 2), which is the
 *    shape a helper that BUILDS an argv naturally has. The keywords below are
 *    the ones a `[` can legally follow in an expression position.
 */

export type Argv = { file: string; line: number; args: string[] };

const STRING = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\$]|\\.)*`/g;

/**
 * Words that may precede a `[` and still leave it an ARRAY LITERAL.
 *
 * Anything else ending in an identifier character is an index access. Written
 * out rather than "any keyword", because the list that matters is short and a
 * wrong entry here re-opens the hole it was added to close.
 */
const KEYWORDS = new Set([
  'return', 'of', 'in', 'typeof', 'instanceof', 'yield', 'await', 'case',
  'do', 'else', 'new', 'delete', 'void', 'throw',
  // `export default ['push', …]` — a module whose whole body is an argv.
  'default',
]);

export function argvLiterals(source: string, file = '<source>'): Argv[] {
  const out: Argv[] = [];
  const re = /\[([^[\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const head = source.slice(0, m.index).replace(/\s+$/, '');
    const before = head.slice(-1);
    // An index access reads a property; it executes nothing. A keyword in front
    // of the bracket means the bracket opens an array.
    if (/[A-Za-z0-9_$)\]]/.test(before) && !KEYWORDS.has(/[A-Za-z_$][\w$]*$/.exec(head)?.[0] ?? '')) {
      continue;
    }
    const args = (m[1].match(STRING) ?? []).map((s) => s.slice(1, -1));
    if (!args.length) continue;
    out.push({ file, line: source.slice(0, m.index).split('\n').length, args });
  }
  return out;
}
