/**
 * A ustar writer, in about a hundred lines, because the alternative is a
 * dependency.
 *
 * This product ships with zero runtime npm dependencies and that is a promise
 * worth more than the convenience of `tar-stream`. What a run bundle actually
 * needs is the smallest possible subset of the format: regular files, one
 * directory level or two, no symlinks, no hard links, no sparse files, no
 * extended headers. That subset is a 512-byte header of fixed-width octal
 * fields followed by the content padded to 512, twice more zeroed at the end —
 * which is short enough to read and therefore short enough to trust.
 *
 * The one rule that is easy to get wrong and impossible to notice: the header
 * checksum is computed with the checksum field itself read as EIGHT SPACES.
 * Sum the header with zeroes there and every archive this writes is refused by
 * every tar on earth, with a message about a corrupt header rather than about
 * arithmetic.
 *
 * The 100-byte name limit is enforced by REFUSING rather than truncating. A
 * truncated name produces a valid archive holding the wrong file, which is the
 * shape of bug that is found by a person months later trying to read evidence.
 * Callers name their own members, so a refusal is a bug in the caller and is
 * caught the first time the bundle is built.
 */

import { gzipSync } from 'node:zlib';

/** Every tar field is a multiple of this. */
export const TAR_BLOCK = 512;

/** The longest name a plain ustar header carries without a prefix field. */
const MAX_NAME = 100;

export type TarMember = {
  /** The path inside the archive, `/`-separated, at most 100 bytes. */
  name: string;
  body: Buffer;
  /** Unix mode; the default is a world-readable regular file. */
  mode?: number;
  /** Seconds since the epoch; the default is now, rounded down. */
  mtime?: number;
};

/** An octal field: `width - 1` digits, zero-padded, then one NUL. */
function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function writeAscii(block: Buffer, text: string, at: number, width: number): void {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > width) throw new Error(`tar: field at ${at} takes ${width} bytes, got ${bytes.length}`);
  bytes.copy(block, at);
}

function header(member: TarMember): Buffer {
  const name = Buffer.from(member.name, 'utf8');
  if (name.length > MAX_NAME) {
    throw new Error(`tar: "${member.name}" is ${name.length} bytes; a member name takes at most 100 bytes`);
  }
  const block = Buffer.alloc(TAR_BLOCK);
  writeAscii(block, member.name, 0, MAX_NAME);
  writeAscii(block, octal(member.mode ?? 0o644, 8), 100, 8);
  writeAscii(block, octal(0, 8), 108, 8); // uid
  writeAscii(block, octal(0, 8), 116, 8); // gid
  writeAscii(block, octal(member.body.length, 12), 124, 12);
  writeAscii(block, octal(member.mtime ?? Math.floor(Date.now() / 1000), 12), 136, 12);
  // The checksum field reads as eight spaces while the checksum is computed.
  block.fill(0x20, 148, 156);
  block[156] = 0x30; // typeflag '0' — a regular file
  writeAscii(block, 'ustar\0', 257, 6);
  writeAscii(block, '00', 263, 2);

  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i += 1) sum += block[i];
  // Six octal digits, a NUL, then a space — the layout every tar reads.
  writeAscii(block, `${octal(sum, 7)} `, 148, 8);
  return block;
}

/** Pad a body to the next whole block; an exact multiple gets nothing. */
function pad(length: number): Buffer {
  const over = length % TAR_BLOCK;
  return over === 0 ? Buffer.alloc(0) : Buffer.alloc(TAR_BLOCK - over);
}

/**
 * The members as one uncompressed ustar archive, ending in the two zero blocks
 * that mark end-of-archive.
 */
export function ustar(members: readonly TarMember[]): Buffer {
  const parts: Buffer[] = [];
  for (const member of members) {
    parts.push(header(member), member.body, pad(member.body.length));
  }
  parts.push(Buffer.alloc(TAR_BLOCK * 2));
  return Buffer.concat(parts);
}

/**
 * The same archive, gzipped.
 *
 * Buffered rather than streamed on purpose: a run bundle is bounded by the
 * caps the collector applies (a journal slice, a log slice, a transcript tail),
 * so it fits in memory by construction — and a buffered body is what this
 * server's `sendBody` takes, with a `content-length` a browser can show a
 * progress bar against.
 */
export function tarGz(members: readonly TarMember[]): Buffer {
  return gzipSync(ustar(members), { level: 6 });
}
