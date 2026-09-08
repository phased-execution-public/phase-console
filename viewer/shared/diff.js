/**
 * The unified-diff parser — ONE of them, for both rails.
 *
 * It lived in `server/review.ts` and served one caller: the phase review
 * window, where the server parses `git diff` and hands the client a structured
 * `DiffFile[]`. Phase 8's `GET /api/repo/diff` answers differently and
 * deliberately — a raw `patch.text` plus git's own `--numstat` file list —
 * because a browse surface pages one file at a time and the numstat spine is
 * what tells the truth about the files whose hunks were never read.
 *
 * That left Phase 9 needing to parse a unified diff **in the browser**, and the
 * plan's instruction for that seam is *generalize, don't duplicate*. So the
 * parser moved here, where the server imports it (`review.ts`) and the client
 * imports it (`lib/diff.ts`) and there is exactly one implementation of a format
 * that has not changed in twenty years.
 *
 * Hand-written, and it has to be: no new dependency for this, because a diff
 * renderer pulled off npm is a supply-chain decision made on a rendering
 * convenience.
 *
 * Plain JS with JSDoc, like every other module here — `shared/` is imported by a
 * TypeScript server, a TypeScript client and bare `node`, and only the first two
 * would survive a `.ts` file.
 *
 * @typedef {'add'|'del'|'context'|'meta'} DiffLineKind
 * @typedef {{ kind: DiffLineKind, text: string, oldLine?: number, newLine?: number }} DiffLine
 * @typedef {{ header: string, lines: DiffLine[] }} DiffHunk
 * @typedef {'added'|'deleted'|'modified'|'renamed'} DiffFileStatus
 * @typedef {{ path: string, oldPath?: string, status: DiffFileStatus,
 *             additions: number, deletions: number, binary: boolean,
 *             hunks: DiffHunk[], truncated?: boolean }} DiffFile
 */

/** Per-file line cap: enough to review, small enough that one file cannot bury the page. */
export const MAX_HUNK_LINES = 1500;

/**
 * Parse a unified diff into files and hunks.
 *
 * Paths come from the `---`/`+++` lines rather than the `diff --git` header,
 * because the header is genuinely ambiguous for a path containing a space
 * (`diff --git a/x y b/x y` has four readings) while the marker lines have
 * exactly one prefix to strip.
 *
 * @param {string} text
 * @param {number} [maxHunkLines]
 * @returns {DiffFile[]}
 */
export function parseUnifiedDiff(text, maxHunkLines = MAX_HUNK_LINES) {
  /** @type {DiffFile[]} */
  const files = [];
  /** @type {DiffFile | null} */
  let file = null;
  /** @type {DiffHunk | null} */
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  let lineBudget = 0;

  const flushFile = () => {
    if (file) files.push(file);
    file = null;
    hunk = null;
  };

  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      flushFile();
      file = {
        path: gitHeaderPath(raw),
        status: 'modified',
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: [],
      };
      lineBudget = maxHunkLines;
      continue;
    }
    if (!file) continue;

    if (raw.startsWith('new file mode')) {
      file.status = 'added';
      continue;
    }
    if (raw.startsWith('deleted file mode')) {
      file.status = 'deleted';
      continue;
    }
    if (raw.startsWith('rename from ')) {
      file.oldPath = raw.slice('rename from '.length);
      file.status = 'renamed';
      continue;
    }
    if (raw.startsWith('rename to ')) {
      file.path = raw.slice('rename to '.length);
      file.status = 'renamed';
      continue;
    }
    if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
      file.binary = true;
      continue;
    }
    if (raw.startsWith('--- ')) {
      const p = markerPath(raw.slice(4));
      if (p === null) file.status = 'added';
      else if (!file.oldPath && file.status === 'renamed') file.oldPath = p;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = markerPath(raw.slice(4));
      if (p === null) file.status = 'deleted';
      else file.path = p;
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
      if (!m) continue;
      oldLine = Number(m[1]);
      newLine = Number(m[3]);
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    // `\ No newline at end of file` is about the line before it, not a line of
    // its own — kept as meta so the renderer can show it without counting it.
    if (raw.startsWith('\\')) {
      hunk.lines.push({ kind: 'meta', text: raw });
      continue;
    }

    if (lineBudget <= 0) {
      file.truncated = true;
      continue;
    }
    lineBudget -= 1;

    if (raw.startsWith('+')) {
      file.additions += 1;
      hunk.lines.push({ kind: 'add', text: raw.slice(1), newLine });
      newLine += 1;
    } else if (raw.startsWith('-')) {
      file.deletions += 1;
      hunk.lines.push({ kind: 'del', text: raw.slice(1), oldLine });
      oldLine += 1;
    } else if (raw.startsWith(' ') || raw === '') {
      hunk.lines.push({ kind: 'context', text: raw.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  flushFile();
  return files;
}

/**
 * `diff --git a/x b/x` → `x`, best-effort; the marker lines correct it after.
 * @param {string} line
 * @returns {string}
 */
export function gitHeaderPath(line) {
  const rest = line.slice('diff --git '.length);
  const half = Math.floor(rest.length / 2);
  const a = rest.slice(0, half).trim();
  return a.startsWith('a/') ? a.slice(2) : a;
}

/**
 * `a/foo` → `foo`; `/dev/null` → null (the file is being created or removed).
 * @param {string} value
 * @returns {string | null}
 */
export function markerPath(value) {
  const cut = value.split('\t')[0].trim();
  if (cut === '/dev/null') return null;
  if (cut.startsWith('a/') || cut.startsWith('b/')) return cut.slice(2);
  return cut;
}
