/**
 * The guide grammar — ONE parser for the full guide a person's task carries
 * (control-tower phase 130, §Architecture 19, #207). The server reads a guide
 * with it to validate a declaration and a plan bullet; the page reads the
 * stored guide with it to draw one. Nothing else parses a guide.
 *
 * ```markdown
 * <why this matters, in a paragraph>
 *
 * ## Steps
 * 1. <what to do>
 *    ```sh
 *    <a command to copy>
 *    ```
 *    Expect: <what the person should then see>
 *    Warning: <what not to do>
 *    Link: [label](https://…)
 * 2. …
 *
 * ## If it goes wrong
 * - <symptom> — <fix>
 * ```
 *
 * The limits are the door's: at most `GUIDE_MAX_STEPS` steps and
 * `GUIDE_MAX_BYTES` bytes; a link that is not `http`/`https` is refused; and
 * the secret screen runs on EVERY line before anything else is read — a
 * secret-shaped value is refused by its line number and never echoed, so a
 * refusal cannot carry the value into a log, a journal line, a push or a
 * transcript. A guide carries its language; a right-to-left one says so
 * (`dir`), and the page isolates its commands left-to-right.
 *
 * `scripts/turn.env` holds the two limits for the session's door
 * (`phase-outcome.sh --guide`), held equal by `gates-vocab.test.ts`.
 *
 * ⚠️ No imports but the human-step model — the client bundles this module.
 */

import { HIDDEN_CHARS_RE, isOpenableUrl, looksLikeSecret } from './human-step-model.js';

/** The most numbered steps a guide may hold. */
export const GUIDE_MAX_STEPS = 20;

/** The most a guide may weigh, in UTF-8 bytes (24 KB). */
export const GUIDE_MAX_BYTES = 24 * 1024;

/** The shape version a parsed guide carries, so a later grammar can read an older one. */
export const GUIDE_VERSION = 1;

/** The two headings a guide may hold, as a person writes them. */
export const GUIDE_HEADINGS = Object.freeze({ steps: 'Steps', trouble: 'If it goes wrong' });

/** The language a guide is in when it says none. */
export const GUIDE_DEFAULT_LANG = 'en';

/** A BCP 47-shaped language tag: `en`, `fa`, `pt-BR`, `zh-Hant-TW`. */
export const GUIDE_LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** The languages written right-to-left — a guide in one is drawn right-to-left. */
export const RTL_LANGS = Object.freeze(['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'yi', 'dv', 'ckb', 'ug']);

/**
 * @typedef {{ label: string, url: string }} GuideLink
 * @typedef {{ text: string, code?: string, expect?: string, warn?: string, link?: GuideLink }} GuideStep
 * @typedef {{ symptom: string, fix: string }} GuideTrouble
 * @typedef {{ lang: string, dir: 'ltr'|'rtl', summary: string, steps: GuideStep[],
 *             trouble: GuideTrouble[], version: number }} Guide
 * @typedef {{ ok: true, guide: Guide } | { ok: false, error: string, line?: number }} GuideParse
 */

/**
 * @param {string} error @param {number} [line]
 * @returns {GuideParse}
 */
function fail(error, line) {
  return line ? { ok: false, error, line } : { ok: false, error };
}

/**
 * The direction a language is written in.
 * @param {string} lang
 * @returns {'ltr'|'rtl'}
 */
export function guideDirection(lang) {
  return RTL_LANGS.includes(String(lang).split('-')[0].toLowerCase()) ? 'rtl' : 'ltr';
}

/**
 * The link a `Link:` line names — `[label](url)` or a bare URL — or null.
 * @param {string} text
 * @returns {GuideLink|null}
 */
function linkOf(text) {
  const md = /^\[([^\]]*)\]\(\s*([^)\s]+)\s*\)$/.exec(text.trim());
  if (md) return { label: md[1].trim() || md[2], url: md[2] };
  const bare = text.trim();
  return bare ? { label: bare, url: bare } : null;
}

/** Every URL a line links to, inline: `[x](url)` and `<scheme:…>`. @param {string} line */
function inlineLinks(line) {
  return [
    ...[...line.matchAll(/\]\(\s*([^)\s]+)\s*\)/g)].map((m) => m[1]),
    ...[...line.matchAll(/<([A-Za-z][A-Za-z0-9+.-]*:[^>\s]+)>/g)].map((m) => m[1]),
  ];
}

/**
 * Read a guide. Every refusal names what to change and, where it can, the
 * line — never a value from it.
 * @param {unknown} text
 * @param {{ lang?: unknown }} [opts]
 * @returns {GuideParse}
 */
export function parseGuide(text, opts = {}) {
  const raw = String(text ?? '');
  const bytes = new TextEncoder().encode(raw).length;
  if (bytes > GUIDE_MAX_BYTES) {
    return fail(
      `a guide is ${GUIDE_MAX_BYTES} bytes at most, and this one is ${bytes} — say less, or link to the rest`,
    );
  }
  const wanted =
    opts.lang === undefined || opts.lang === null || opts.lang === ''
      ? GUIDE_DEFAULT_LANG
      : String(opts.lang);
  if (!GUIDE_LANG_RE.test(wanted)) return fail("the guide's language is a tag like en, fa or pt-BR");
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  // G6, first: nothing past this point may hold a value worth hiding.
  for (let i = 0; i < lines.length; i++) {
    if (looksLikeSecret(lines[i])) {
      return fail(
        `line ${i + 1} carries a secret-shaped value — a guide says where the person types a secret, never the secret`,
        i + 1,
      );
    }
    // A command or a sentence must read as it runs (control-tower phase 141):
    // an invisible or direction-changing character shows a person one thing
    // and hands the shell another.
    const hidden = HIDDEN_CHARS_RE.exec(lines[i]);
    if (hidden) {
      const code = hidden[0].codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0');
      return fail(
        `line ${i + 1} carries an invisible or direction-changing character (U+${code}) — a guide shows exactly what a person types`,
        i + 1,
      );
    }
  }

  /** @type {string[][]} */
  const paragraphs = [[]];
  /** @type {GuideStep[]} */
  const steps = [];
  /** @type {GuideTrouble[]} */
  const trouble = [];
  /** @type {'why'|'steps'|'trouble'} */
  let section = 'why';
  const seen = new Set();
  /** @type {string[]|null} */
  let fence = null;
  let fenceIndent = 0;
  let fenceAt = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    if (fence) {
      if (/^\s*```\s*$/.test(line)) {
        const step = steps[steps.length - 1];
        const code = fence.join('\n').replace(/\s+$/, '');
        if (code) step.code = step.code ? `${step.code}\n${code}` : code;
        fence = null;
      } else {
        fence.push(line.slice(Math.min(fenceIndent, line.length - line.trimStart().length)));
      }
      continue;
    }
    for (const url of inlineLinks(line)) {
      if (!isOpenableUrl(url))
        return fail(`line ${n} links somewhere a guide may not — http and https only`, n);
    }
    const heading = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const name = heading[1].trim().toLowerCase();
      const next =
        name === GUIDE_HEADINGS.steps.toLowerCase()
          ? 'steps'
          : name === GUIDE_HEADINGS.trouble.toLowerCase()
            ? 'trouble'
            : null;
      if (!next) {
        return fail(
          `line ${n}: a guide has two headings, "## ${GUIDE_HEADINGS.steps}" and "## ${GUIDE_HEADINGS.trouble}"`,
          n,
        );
      }
      if (seen.has(next)) return fail(`line ${n}: "## ${heading[1].trim()}" appears twice`, n);
      if (next === 'steps' && seen.has('trouble')) {
        return fail(`line ${n}: "## ${GUIDE_HEADINGS.steps}" comes before "## ${GUIDE_HEADINGS.trouble}"`, n);
      }
      seen.add(next);
      section = next;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      return fail(
        `line ${n}: a guide has two headings, "## ${GUIDE_HEADINGS.steps}" and "## ${GUIDE_HEADINGS.trouble}"`,
        n,
      );
    }
    const trimmed = line.trim();
    if (section === 'why') {
      if (!trimmed) {
        if (paragraphs[paragraphs.length - 1].length) paragraphs.push([]);
      } else paragraphs[paragraphs.length - 1].push(trimmed);
      continue;
    }
    if (section === 'steps') {
      const numbered = /^(\d{1,3})[.)]\s+(.+)$/.exec(line);
      if (numbered) {
        if (steps.length >= GUIDE_MAX_STEPS) {
          return fail(
            `a guide holds ${GUIDE_MAX_STEPS} steps at most — line ${n} is step ${steps.length + 1}`,
            n,
          );
        }
        steps.push({ text: numbered[2].trim() });
        continue;
      }
      if (!trimmed) continue;
      const step = steps[steps.length - 1];
      if (!step)
        return fail(`line ${n} is under "## ${GUIDE_HEADINGS.steps}" before its first numbered step`, n);
      if (/^```[A-Za-z0-9_+-]*\s*$/.test(trimmed)) {
        fence = [];
        fenceIndent = line.length - line.trimStart().length;
        fenceAt = n;
        continue;
      }
      const field = /^(expect|warning|link):\s*(.*)$/i.exec(trimmed);
      if (field) {
        const word = field[1].toLowerCase();
        const value = field[2].trim();
        if (!value) return fail(`line ${n}: "${field[1]}:" says nothing`, n);
        if (word === 'expect') step.expect = step.expect ? `${step.expect} ${value}` : value;
        else if (word === 'warning') step.warn = step.warn ? `${step.warn} ${value}` : value;
        else {
          const link = linkOf(value);
          if (!link || !isOpenableUrl(link.url)) return fail(`line ${n}: a step links http or https only`, n);
          if (step.link) return fail(`line ${n}: a step carries one link`, n);
          step.link = link;
        }
        continue;
      }
      step.text = `${step.text} ${trimmed}`;
      continue;
    }
    // section === 'trouble'
    if (!trimmed) continue;
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bullet && line.length - line.trimStart().length < 2) {
      const at = bullet[1].search(/\s[—–]\s|\s--\s/);
      trouble.push(
        at < 0
          ? { symptom: bullet[1].trim(), fix: '' }
          : {
              symptom: bullet[1].slice(0, at).trim(),
              fix: bullet[1]
                .slice(at)
                .replace(/^\s*(?:[—–]|--)\s*/, '')
                .trim(),
            },
      );
      continue;
    }
    const last = trouble[trouble.length - 1];
    if (!last) return fail(`line ${n}: "## ${GUIDE_HEADINGS.trouble}" holds "- symptom — fix" lines`, n);
    last.fix = last.fix ? `${last.fix} ${trimmed}` : trimmed;
  }
  if (fence) return fail(`the code block opened on line ${fenceAt} is never closed`, fenceAt);
  if (seen.has('steps') && !steps.length) return fail(`"## ${GUIDE_HEADINGS.steps}" holds no numbered step`);
  const summary = paragraphs
    .filter((p) => p.length)
    .map((p) => p.join(' '))
    .join('\n\n');
  if (!summary && !steps.length) return fail('a guide says why, or lists its steps — this one is empty');
  return {
    ok: true,
    guide: { lang: wanted, dir: guideDirection(wanted), summary, steps, trouble, version: GUIDE_VERSION },
  };
}

/**
 * Every command a guide asks the person to run — each non-blank line of each
 * step's code block that is not a comment. What G4 holds against the run's own
 * policy: a guide with none is never refused for "the AI could do this".
 * @param {Pick<Guide, 'steps'>|null|undefined} guide
 * @returns {string[]}
 */
export function guideCommands(guide) {
  if (!guide || !Array.isArray(guide.steps)) return [];
  return guide.steps.flatMap((step) =>
    String(step.code ?? '')
      .split('\n')
      .map((line) => line.trim().replace(/^\$\s+/, ''))
      .filter((line) => line && !line.startsWith('#')),
  );
}

/**
 * A guide written back in its grammar — what a page copies and what an export
 * prints. `parseGuide(renderGuide(g))` reads `g` again.
 * @param {Guide} guide
 * @returns {string}
 */
export function renderGuide(guide) {
  const out = [];
  if (guide.summary) out.push(guide.summary, '');
  if (guide.steps.length) {
    out.push(`## ${GUIDE_HEADINGS.steps}`);
    guide.steps.forEach((step, index) => {
      out.push(`${index + 1}. ${step.text}`);
      if (step.code) out.push('   ```sh', ...step.code.split('\n').map((l) => `   ${l}`), '   ```');
      if (step.expect) out.push(`   Expect: ${step.expect}`);
      if (step.warn) out.push(`   Warning: ${step.warn}`);
      if (step.link) out.push(`   Link: [${step.link.label}](${step.link.url})`);
    });
    out.push('');
  }
  if (guide.trouble.length) {
    out.push(`## ${GUIDE_HEADINGS.trouble}`);
    for (const t of guide.trouble) out.push(t.fix ? `- ${t.symptom} — ${t.fix}` : `- ${t.symptom}`);
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}
