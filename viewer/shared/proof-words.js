/**
 * A proof in words (turn-by-turn phase 3, §Architecture 3): every watch-ref
 * scheme the console polls, told as the sentence a person reads — "pull
 * request #12 in acme/app is merged or closed", never the ref itself. The raw
 * ref stays on the item's record, one press away under Raw.
 *
 * The schemes are `server/watch-refs.ts`'s (`WATCH_SCHEMES`); this file reads
 * a ref's SHAPE only to say it — it validates nothing and polls nothing, so a
 * ref it cannot read is still told, as "the check the session named holds".
 * Dependency-free: the server's composer and the page read the same words.
 */

/**
 * How each scheme is said, by the scheme's name in `WATCH_SCHEMES`. Each
 * function takes what the ref names and answers a clause that reads after
 * "the console checks that …".
 * @type {Readonly<Record<string, (parts: Record<string, string>) => string>>}
 */
export const PROOF_SCHEME_WORDS = Object.freeze({
  'gh-run': (p) => `the run ${p.id} in ${p.repo} finishes`,
  'gh-pr': (p) => `pull request #${p.number} in ${p.repo} is merged or closed`,
  date: (p) => `it is ${p.at} or later`,
  lock: (p) => `the lock on Phase ${p.phase} of ${p.slug} is free`,
  phase: (p) => `Phase ${p.phase} of ${p.slug} is done`,
  verify: (p) => `the red checks of Phase ${p.phase} of ${p.slug} pass`,
  cmd: (p) => p.words,
  unit: (p) => `the job ${p.unit} on ${p.host} finishes`,
  credential: (p) => p.words,
});

/** What a ref no scheme reads is told as. */
export const PROOF_UNREAD = 'the check the session named holds';

/** What a `cmd:` ref whose command has no recognised shape is told as. */
export const PROOF_COMMAND = 'a check command passes';

/**
 * An instant in words, on one clock for every reader: `2026-10-20 17:00 UTC`.
 * Null for anything that is not an instant.
 * @param {string|number|null|undefined} at
 * @returns {string|null}
 */
export function instantWords(at) {
  const ms = typeof at === 'number' ? at : Date.parse(String(at ?? ''));
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * A credential named by a proof, in words — read by presence, never its value.
 * @param {string} id
 * @returns {string}
 */
export function credentialWords(id) {
  const colon = id.indexOf(':');
  const scheme = colon > 0 ? id.slice(0, colon) : id;
  const rest = colon > 0 ? id.slice(colon + 1) : '';
  if (id === 'gh') return 'the gh CLI is signed in';
  if (id === 'claude' || id === 'claude-login' || scheme === 'claude') return 'the claude login is signed in';
  if (scheme === 'env' && rest) return `$${rest} is set in the console's environment`;
  if (scheme === 'keychain' && rest) return `the keychain item ${rest} is stored`;
  if (scheme === 'file' && rest) return `the file ${rest} exists`;
  return `${id} is stored`;
}

/**
 * A command a `cmd:` ref runs, told by its shape — the few shapes plans and
 * sessions write — else "a check command passes".
 * @param {string} command
 * @returns {string}
 */
export function commandWords(command) {
  const words = command.trim().split(/\s+/);
  const [lead, verb] = words;
  const last = words[words.length - 1] ?? '';
  if (lead === 'gh' && verb === 'auth' && words[2] === 'status') return 'the gh CLI reads signed in';
  if (lead === 'claude' && verb === 'auth' && words[2] === 'status')
    return 'the claude login reads signed in';
  if ((lead === 'test' || lead === '[') && /^-[efrsd]$/.test(verb ?? '') && words[2]) {
    return `the ${verb === '-d' ? 'folder' : 'file'} ${words[2]} exists`;
  }
  if (lead === 'git' && verb === 'ls-remote') {
    const tag = words.find((word) => word.startsWith('refs/tags/'))?.slice('refs/tags/'.length);
    const named =
      tag ?? (words.includes('--tags') && words.length >= 5 && !last.startsWith('-') ? last : null);
    if (named) return `the tag ${named} is on the remote`;
  }
  if (lead === 'curl') {
    const url = words.find((word) => /^https?:\/\//.test(word.replace(/^['"]|['"]$/g, '')));
    if (url) return `${url.replace(/^['"]|['"]$/g, '')} answers`;
  }
  if (lead === 'npm' && verb === 'view' && words[2] && !words[2].startsWith('-')) {
    return `the package ${words[2]} is on the registry`;
  }
  if (lead === 'grep' && words.length >= 3 && !last.startsWith('-'))
    return `the file ${last} holds what the check looks for`;
  return PROOF_COMMAND;
}

/**
 * A ref read into its scheme and parts, or null when no scheme reads it.
 * @param {string} ref
 * @returns {{ scheme: string, parts: Record<string, string> } | null}
 */
export function proofPartsOf(ref) {
  const text = String(ref ?? '').trim();
  const gh = /^gh:([^#\s]+)#(run|pr)\/(\d+)$/.exec(text);
  if (gh) {
    return gh[2] === 'run'
      ? { scheme: 'gh-run', parts: { repo: gh[1], id: gh[3] } }
      : { scheme: 'gh-pr', parts: { repo: gh[1], number: gh[3] } };
  }
  const date = /^(?:date|until):(.+)$/.exec(text);
  if (date) {
    const at = instantWords(date[1].trim());
    return at ? { scheme: 'date', parts: { at } } : null;
  }
  const lane = /^(lock|phase|verify):([^/\s]+)\/0*(\d+)$/.exec(text);
  if (lane) return { scheme: lane[1], parts: { slug: lane[2], phase: lane[3] } };
  const unit = /^unit:([^/\s]+)\/(.+)$/.exec(text);
  if (unit) return { scheme: 'unit', parts: { host: unit[1], unit: unit[2] } };
  if (text.startsWith('credential:')) {
    const id = text.slice('credential:'.length).trim();
    return id ? { scheme: 'credential', parts: { words: credentialWords(id) } } : null;
  }
  if (text.startsWith('cmd:')) {
    let command = text.slice(4).trim();
    if (command.length >= 2 && /^(["']).*\1$/.test(command)) command = command.slice(1, -1).trim();
    return command ? { scheme: 'cmd', parts: { words: commandWords(command) } } : null;
  }
  return null;
}

/**
 * What a proof ref says has happened, as a clause — "Phase 13 of demo is
 * done". A ref no scheme reads is said as `PROOF_UNREAD`, never echoed.
 * @param {string} ref
 * @returns {string}
 */
export function proofWords(ref) {
  const read = proofPartsOf(ref);
  const say = read ? PROOF_SCHEME_WORDS[read.scheme] : undefined;
  return say && read ? say(read.parts) : PROOF_UNREAD;
}

/**
 * When an act not due yet starts, in words — "when Phase 13 of demo is done",
 * or "at 2026-10-20 17:00 UTC" for a date.
 * @param {string} ref
 * @returns {string}
 */
export function whenWords(ref) {
  const read = proofPartsOf(ref);
  if (read?.scheme === 'date') return `at ${read.parts.at}`;
  return `when ${proofWords(ref)}`;
}

/**
 * The instant a `date:` start names, as ISO, or null for any other ref.
 * @param {string|null|undefined} ref
 * @returns {string|null}
 */
export function startAtOf(ref) {
  const date = /^(?:date|until):(.+)$/.exec(String(ref ?? '').trim());
  const ms = date ? Date.parse(date[1].trim()) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * The gate a proof reads, when it reads one (turn-by-turn phase 5): a `cmd:`
 * ref over a plan's `gate-status.md` or the engine's `--gate-status`. Such an
 * item is done when the GATE is approved, so its press is the gate's Approve —
 * an answer or a note never proves it while the gate stays shut. `phase` is
 * the phase the ref names (`--gate-status 11`, a `| 11 |` row), else null.
 * @param {string|null|undefined} ref
 * @returns {{ phase: number | null } | null}
 */
export function gateProofOf(ref) {
  const text = String(ref ?? '').trim();
  if (!text.startsWith('cmd:') || !/gate-status/.test(text)) return null;
  const named = /--gate-status\s+0*(\d+)/.exec(text) ?? /\|\s*0*(\d+)\s*\|/.exec(text);
  const phase = named ? Number(named[1]) : NaN;
  return { phase: Number.isInteger(phase) && phase > 0 ? phase : null };
}
