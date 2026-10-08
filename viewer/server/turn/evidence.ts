/**
 * What a person attaches to an item — the evidence store (control-tower phase
 * 133, #210, §Architecture 19).
 *
 * A note, an image or a file a person attaches to their turn, so a check (and,
 * from phase 134, the checking session) can read what they did rather than
 * take their word for it. Four rules, each a test in `turn-evidence.test.ts`:
 *
 *   EV-1  bounded — one piece is at most `EVIDENCE_MAX_BYTES`, and one attempt
 *         holds at most `EVIDENCE_PER_ATTEMPT` pieces;
 *   EV-2  screened — text (a note, or a file that reads as text) passes the
 *         secret screen every declaration passes, or is refused whole; an
 *         image is held to the magic bytes of the type it claims;
 *   EV-3  stored by content hash, 0600 in a 0700 directory, under the
 *         instance's state (`turn-evidence/`) — outside every tree a session
 *         reads, never pushed and never journalled: the ledger keeps its
 *         record (`sha256:<hex>`, the kind, the size), never its bytes;
 *   EV-4  swept — the `turn-evidence` retention sink ages it out and caps the
 *         directory (`retention.ts`).
 *
 * Nothing here knows an item or a route: `service-recovery.ts`'s `attach`
 * screens and stores through it, and the ledger records what it answered.
 */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { looksLikeSecret } from '../../shared/human-step-model.js';

/** The store's directory, under the instance's state. */
export const EVIDENCE_DIR = 'turn-evidence';

/** What a person may attach — `probe-output` is the console's own word (phase 134), never a person's. */
export const EVIDENCE_KINDS = Object.freeze(['note', 'image', 'file'] as const);
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * One piece, at most: 160 KB. A request body is 256 KB at the router, and a
 * file arrives base64 inside it — so this is the most a body can carry, said
 * in the store's own words before the router's refusal says it in its own.
 */
export const EVIDENCE_MAX_BYTES = 160 * 1024;

/** The most pieces one attempt holds — a check's evidence, not an archive. */
export const EVIDENCE_PER_ATTEMPT = 6;

/** The images a person may attach, each with the bytes it must open with. */
const IMAGE_MAGIC: Readonly<Record<string, (bytes: Buffer) => boolean>> = Object.freeze({
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
});

/** A piece of evidence that passed the screen: its bytes, and what the ledger will say about it. */
export type ScreenedEvidence = { kind: EvidenceKind; bytes: Buffer; mime: string; name?: string };

/** What the store answers: where the bytes are, by hash — never the bytes. */
export type StoredEvidence = { ref: string; kind: EvidenceKind; bytes: number; mime: string; name?: string };

export type EvidenceRefusal = { refused: true; status: 400 | 413; error: string };

/** The sentence every text refusal says — the value is never echoed. */
export const EVIDENCE_SECRET_REFUSAL =
  'This looks like it carries a secret (a token, a password or a one-time code). Evidence is kept and read by the '
  + 'console, so a secret never goes in it — put the value where the item says, then attach what shows it worked, not the value.';

/** A file name as the ledger may show it: its last segment, plain characters, 120 at most. */
function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = basename(raw.trim()).replace(/[^A-Za-z0-9._ -]+/g, '_').slice(0, 120);
  return name && name !== '.' && name !== '..' ? name : undefined;
}

/** Decoded base64, or null when the text is not base64 at all. */
function fromBase64(raw: unknown): Buffer | null {
  if (typeof raw !== 'string') return null;
  const compact = raw.replace(/\s+/g, '');
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  return Buffer.from(compact, 'base64');
}

/** Bytes that read as text: valid UTF-8 with no NUL. */
function readsAsText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

/** Does text carry a secret — the whole of it, or any one line? */
function textCarriesSecret(text: string): boolean {
  return looksLikeSecret(text) || text.split(/\r?\n/).some((line) => looksLikeSecret(line));
}

/**
 * Hold one offered piece to the store's rules (EV-1, EV-2): a known kind, a
 * size under the bound, text through the secret screen, an image that is the
 * image it says it is. Answers the bytes to store, or the refusal a route says.
 */
export function screenEvidence(input: Record<string, unknown>): ScreenedEvidence | EvidenceRefusal {
  const kind = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';
  if (!(EVIDENCE_KINDS as readonly string[]).includes(kind)) {
    return { refused: true, status: 400, error: `Evidence is one of ${EVIDENCE_KINDS.join(', ')}.` };
  }
  const tooBig = (bytes: number): EvidenceRefusal | null => (bytes > EVIDENCE_MAX_BYTES
    ? { refused: true, status: 413, error: `One piece of evidence is at most ${EVIDENCE_MAX_BYTES / 1024} KB — this is ${Math.ceil(bytes / 1024)} KB.` }
    : null);
  const name = cleanName(input.name);
  if (kind === 'note') {
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text) return { refused: true, status: 400, error: 'A note needs its text.' };
    const bytes = Buffer.from(text, 'utf8');
    const big = tooBig(bytes.length);
    if (big) return big;
    if (textCarriesSecret(text)) return { refused: true, status: 400, error: EVIDENCE_SECRET_REFUSAL };
    return { kind: 'note', bytes, mime: 'text/plain; charset=utf-8', ...(name ? { name } : {}) };
  }
  const text = typeof input.text === 'string' ? input.text : null;
  const bytes = text !== null && kind === 'file' ? Buffer.from(text, 'utf8') : fromBase64(input.data);
  if (!bytes || !bytes.length) {
    return { refused: true, status: 400, error: kind === 'image' ? 'An image arrives as base64 `data`.' : 'A file arrives as base64 `data` or as `text`.' };
  }
  const big = tooBig(bytes.length);
  if (big) return big;
  const mime = typeof input.mime === 'string' ? input.mime.trim().toLowerCase() : '';
  if (kind === 'image') {
    const opens = IMAGE_MAGIC[mime];
    if (!opens) return { refused: true, status: 400, error: `An image is one of ${Object.keys(IMAGE_MAGIC).join(', ')}.` };
    if (!opens(bytes)) return { refused: true, status: 400, error: `That is not a ${mime} — its first bytes say otherwise.` };
    return { kind: 'image', bytes, mime, ...(name ? { name } : {}) };
  }
  // A file: screened as text whenever it reads as text, whatever it claims to be.
  const asText = readsAsText(bytes);
  if (asText !== null && textCarriesSecret(asText)) return { refused: true, status: 400, error: EVIDENCE_SECRET_REFUSAL };
  const fileMime = asText !== null ? 'text/plain; charset=utf-8' : 'application/octet-stream';
  return { kind: 'file', bytes, mime: fileMime, ...(name ? { name } : {}) };
}

/** Is this answer a refusal? */
export function isEvidenceRefusal(value: ScreenedEvidence | EvidenceRefusal): value is EvidenceRefusal {
  return 'refused' in value;
}

/**
 * Store one screened piece under its content hash (EV-3): `<dir>/<sha256>`,
 * 0600 in a 0700 directory. The same bytes twice are one file — written once,
 * and answered as the same ref.
 */
export function storeEvidence(dir: string, piece: ScreenedEvidence): StoredEvidence {
  const hash = createHash('sha256').update(piece.bytes).digest('hex');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, hash);
  if (!existsSync(path)) {
    writeFileSync(path, piece.bytes, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return { ref: `sha256:${hash}`, kind: piece.kind, bytes: piece.bytes.length, mime: piece.mime, ...(piece.name ? { name: piece.name } : {}) };
}

/**
 * The bytes of one stored piece, by its ref (control-tower phase 134, #211) —
 * the checking session's reader, and no route's: the checker is handed what a
 * person attached for the attempt it judges, and nothing else reads the store.
 * Null for a ref that is not `sha256:<64 hex>`, a piece the sweep took, or bytes
 * whose hash no longer matches their name (a store is trusted by content).
 */
export function readEvidence(dir: string, ref: string): Buffer | null {
  const match = /^sha256:([0-9a-f]{64})$/.exec(ref);
  if (!match) return null;
  try {
    const bytes = readFileSync(join(dir, match[1]!));
    return createHash('sha256').update(bytes).digest('hex') === match[1] ? bytes : null;
  } catch {
    return null;
  }
}
