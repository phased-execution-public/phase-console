/**
 * The plan's `## Operator errands` TABLE (turn-by-turn phase 2) — the steps a
 * plan already writes for each act only its owner can do, which nothing parsed
 * before 7.1. Hub's plans keep one row per act and end each `- **Human step:**`
 * bullet's text with "(E-N…)", binding the bullet to its row:
 *
 *   | Id | Phase · why | What only the owner can do | Exact steps | Expected | How the agent verifies |
 *
 * Read by the console alone, in JS — prose the console may parse itself; the
 * engine reads only the ids (`errand_refs`, lints F41 and F43). The rules:
 *
 *  - headers are matched by NAME, tolerantly (`ERRAND_HEADERS`), and the second
 *    column is free — "Phase · issues", "Phase · why", whatever the plan wrote —
 *    kept verbatim as `phase`;
 *  - a cell splits on `|` only outside backticks and never on an escaped `\|`;
 *    a row whose closing pipe is missing still reads;
 *  - a command step comes ONLY from an explicit `! cmd` marker (a backticked
 *    span opening with `! `); everything else is prose, kept as one step —
 *    steps are never invented from sentences;
 *  - a command holding a `<placeholder>` is marked `template`: it is shown to
 *    be filled in, never offered as a plain copy;
 *  - the section's preamble "runs from `<dir>`" is kept as a hint;
 *  - a row no bullet names is listed as unbound — a heads-up, which nothing
 *    checks and nothing waits on.
 */

/** One step of a row's "Exact steps": a sentence, a command to run, or both. */
export type ErrandStep = {
  text: string;
  /** The command an explicit `! cmd` marker names, without the `! `. */
  command?: string;
  /** The command holds a `<placeholder>` the person fills in before running it. */
  template?: true;
};

/** One row of the table. */
export type ErrandRow = {
  /** `E-4` — the ref a bullet's "(E-4…)" binds. */
  id: string;
  /** The free second column, verbatim ("22 · hub #105", "before 3 · secret"). */
  phase?: string;
  what: string;
  steps: ErrandStep[];
  expected?: string;
  /** How the agent verifies it, verbatim, and the command when it is a `! cmd`. */
  verifies?: string;
  verifyCommand?: string;
  /** A `- **Human step:**` bullet names it. */
  bound: boolean;
};

export type ErrandsTable = {
  rows: ErrandRow[];
  /** The ids no bullet names, in table order. */
  unbound: string[];
  /** The preamble's "runs from `<dir>`", when it says one. */
  runsFrom?: string;
  /** The second column's header as the plan wrote it. */
  secondHeader?: string;
};

/** The columns the reader knows, each with the header spellings it accepts (lower case, punctuation folded). */
export const ERRAND_HEADERS = Object.freeze({
  id: ['id', 'ref', 'errand'],
  what: ['what only the owner can do', 'what only you can do', 'what the owner does', 'what', 'act', 'task'],
  steps: ['exact steps', 'steps', 'how', 'how to do it'],
  expected: ['expected', 'expect', 'expected result', 'what you should see'],
  verifies: ['how the agent verifies', 'how claude verifies', 'how it is verified', 'how it is checked', 'verify', 'verification', 'check', 'proof'],
} as const);

type Column = keyof typeof ERRAND_HEADERS;

/** A header folded for matching: lower case, bold and backticks dropped, spaces collapsed. */
function folded(header: string): string {
  return header.toLowerCase().replace(/[*`_]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * A table line's cells — split on `|` outside backticks and never on `\|`,
 * the outer pipes dropped (the closing one may be missing), `\|` read as `|`.
 */
export function tableCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '');
  const cells: string[] = [];
  let cell = '';
  let tick = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '\\' && body[i + 1] === '|') { cell += '|'; i++; continue; }
    if (ch === '`') tick = !tick;
    if (ch === '|' && !tick) { cells.push(cell.trim()); cell = ''; continue; }
    cell += ch;
  }
  if (cell.trim()) cells.push(cell.trim());
  return cells;
}

/** The `! cmd` markers of a cell, each as `{at, end, command}`. */
function commandSpans(cell: string): { at: number; end: number; command: string }[] {
  return [...cell.matchAll(/`!\s+([^`]+)`/g)].map((m) => ({ at: m.index!, end: m.index! + m[0].length, command: m[1]!.trim() }));
}

const PLACEHOLDER_RE = /<[A-Za-z][^<>]{0,40}>/;

/** Prose between commands, its joining words dropped ("then", "and", a `;`). */
function lead(prose: string): string {
  return prose.replace(/^[\s,;:—–-]*(?:(?:and\s+)?then\b|and\b)?[\s,;:—–-]*/i, '').replace(/[\s,;:—–-]+$/, '').trim();
}

/**
 * A row's "Exact steps" as steps: each `! cmd` marker is a command step, led by
 * the prose before it; the prose after the last command is a step of its own;
 * a cell with no marker is ONE prose step.
 */
export function errandSteps(cell: string): ErrandStep[] {
  const text = cell.trim();
  if (!text) return [];
  const spans = commandSpans(text);
  if (!spans.length) return [{ text }];
  const steps: ErrandStep[] = [];
  let from = 0;
  for (const span of spans) {
    const before = lead(text.slice(from, span.at));
    steps.push({
      text: before || 'Run this command.',
      command: span.command,
      ...(PLACEHOLDER_RE.test(span.command) ? { template: true as const } : {}),
    });
    from = span.end;
  }
  const rest = lead(text.slice(from));
  if (rest && /[A-Za-z0-9]/.test(rest)) steps.push({ text: rest });
  return steps;
}

/**
 * Read the section's table. `bound` is every E-ref a bullet names; a row
 * outside it is unbound. Undefined when the section holds no table the reader
 * can place — no `Id` column, or no "what" column.
 */
export function parseErrandsTable(section: string, bound: Iterable<string> = []): ErrandsTable | undefined {
  const lines = section.split('\n');
  const start = lines.findIndex((line, i) => /^\s*\|/.test(line) && /^\s*\|?\s*:?-+:?\s*(\||$)/.test(lines[i + 1] ?? ''));
  if (start === -1) return undefined;
  const headers = tableCells(lines[start]!);
  const index: Partial<Record<Column, number>> = {};
  headers.forEach((header, i) => {
    const name = folded(header);
    for (const column of Object.keys(ERRAND_HEADERS) as Column[]) {
      if (index[column] === undefined && (ERRAND_HEADERS[column] as readonly string[]).includes(name)) { index[column] = i; return; }
    }
  });
  if (index.id === undefined || index.what === undefined) return undefined;
  // The free second column: the one right of the id that no known header took.
  const taken = new Set(Object.values(index));
  const second = index.id + 1 < headers.length && !taken.has(index.id + 1) ? index.id + 1 : undefined;
  const refs = new Set([...bound].map((ref) => ref.toUpperCase()));
  const rows: ErrandRow[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!/^\s*\|/.test(line)) break;
    const cells = tableCells(line);
    const id = (cells[index.id] ?? '').replace(/[*`\s]/g, '').toUpperCase();
    if (!/^E-\d+$/.test(id) || rows.some((row) => row.id === id)) continue;
    const at = (column: Column): string => (index[column] === undefined ? '' : (cells[index[column]!] ?? '').trim());
    const verifies = at('verifies');
    const verifyCommand = commandSpans(verifies)[0]?.command;
    rows.push({
      id,
      ...(second !== undefined && cells[second] ? { phase: cells[second]!.trim() } : {}),
      what: at('what'),
      steps: errandSteps(at('steps')),
      ...(at('expected') ? { expected: at('expected') } : {}),
      ...(verifies ? { verifies } : {}),
      ...(verifyCommand ? { verifyCommand } : {}),
      bound: refs.has(id),
    });
  }
  const runsFrom = /runs from\s+`([^`]+)`/i.exec(lines.slice(0, start).join('\n'))?.[1];
  return {
    rows,
    unbound: rows.filter((row) => !row.bound).map((row) => row.id),
    ...(runsFrom ? { runsFrom } : {}),
    ...(second !== undefined ? { secondHeader: headers[second] } : {}),
  };
}
