/**
 * A plan bullet's `guide:` FILE (turn-by-turn phase 2) — the one place the
 * console reads a guide from disk, kept out of `human-steps.ts`, whose only
 * file read is its own ledger (HS-5). Read for the launch door's ask
 * (`service-runs.ts` `doorGuide`) and for the read-time composition of a plan
 * item (`turn/plan-items.ts`).
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { GUIDE_MAX_BYTES, parseGuide, type Guide } from '../../shared/guide-grammar.js';
import { guideFromWizard, isWizardScript } from './packs.ts';

/**
 * A plan bullet's `guide:` FILE, read for the launch door and for the read-time
 * composition of a plan item (turn-by-turn phase 2): a path relative to the docs
 * root, resolved through `realpath` and refused unless it stays under that root
 * — so a symlink that escapes it is refused as surely as `../` — a regular file
 * of at most `GUIDE_MAX_BYTES`, read by the one grammar, whose secret screen runs
 * on every line. Every refusal is a sentence that names the file and never a
 * value from it; the caller raises the item without a guide. A wizard script is
 * composed into a guide (`turn/packs.ts` `guideFromWizard`).
 */
export function readGuideFile(
  docsRoot: string, rel: string, opts: { lang?: string } = {},
): { ok: true; guide: Guide; text: string } | { ok: false; why: string } {
  const name = String(rel ?? '').trim();
  if (!name || isAbsolute(name) || name.split(/[\\/]/).includes('..')) {
    return { ok: false, why: `the guide "${name.slice(0, 120)}" is not a path under the docs root` };
  }
  let root: string;
  let file: string;
  try {
    root = realpathSync(docsRoot);
    file = realpathSync(join(root, name));
  } catch {
    return { ok: false, why: `the guide ${name} is not a file under the docs root` };
  }
  const inside = relative(root, file);
  if (!inside || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) {
    return { ok: false, why: `the guide ${name} leads outside the docs root (a link that escapes it is refused)` };
  }
  let size: number;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return { ok: false, why: `the guide ${name} is not a file` };
    size = stat.size;
  } catch {
    return { ok: false, why: `the guide ${name} could not be read` };
  }
  if (size > GUIDE_MAX_BYTES) {
    return { ok: false, why: `the guide ${name} is ${size} bytes, and a guide is ${GUIDE_MAX_BYTES} at most` };
  }
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return { ok: false, why: `the guide ${name} could not be read` }; }
  // A wizard (mattpocock's `wizard/template.sh`, measured-console phase 29) is
  // read into the Task guide's shape — its stages, each with its commands, a
  // secret said by where it goes — and held to the same grammar.
  const read = isWizardScript(text)
    ? guideFromWizard(text, name, opts.lang ?? 'en')
    : parseGuide(text, opts.lang ? { lang: opts.lang } : {});
  if (!read.ok) return { ok: false, why: `the guide ${name} was refused: ${read.error}` };
  return { ok: true, guide: read.guide, text };
}
