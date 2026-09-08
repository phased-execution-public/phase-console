/**
 * The last N bytes a terminal printed.
 *
 * Lifted out of `terminal.ts` unchanged when the broker took ownership of
 * ptys: the ring now lives on **both** sides of the socket and the two copies
 * must be the same code, or a reattach after a console restart would render
 * differently from a reattach without one. The broker's copy is the durable
 * one — it is what survives the console — and the console keeps a mirror so a
 * browser attaching to a session it already knows about is answered from
 * memory rather than over a round trip.
 *
 * `terminal.ts` re-exports the class, so every existing import still resolves.
 */

/**
 * Enough scrollback that reattaching feels like the same terminal, bounded so a
 * runaway `yes` cannot eat the console's memory. Counted in bytes, not lines,
 * because a line has no maximum length.
 */
export const SCROLLBACK_BYTES = 200 * 1024;

/**
 * The last N bytes of output, so a reattach shows the terminal you left rather
 * than an empty screen with a live prompt.
 *
 * Whole chunks are evicted rather than bytes: cutting a chunk in half can cut
 * an escape sequence in half, and a terminal fed half a sequence renders the
 * rest of the session in the wrong colour.
 */
export class Scrollback {
  private chunks: string[] = [];
  private size = 0;
  private readonly limit: number;

  // Written out rather than as a parameter property: Node runs this file by
  // stripping types, and `constructor(private x)` is syntax, not a type.
  constructor(limit = SCROLLBACK_BYTES) {
    this.limit = limit;
  }

  push(text: string): void {
    if (!text) return;
    this.chunks.push(text);
    this.size += Buffer.byteLength(text);
    while (this.size > this.limit && this.chunks.length > 1) {
      this.size -= Buffer.byteLength(this.chunks.shift() as string);
    }
  }

  text(): string {
    return this.chunks.join('');
  }

  get bytes(): number {
    return this.size;
  }
}
