/**
 * The transcript both spawn doors are held to (measured-console phase 20, B1).
 *
 * One session, as stream-json frames the CLI prints (shapes as CLI 2.1.270–
 * 2.1.311 measured them, the ones `spawn-protocol.test.ts`'s stub already
 * speaks): a hook, `system/init`, the boot prompt's echo, thinking deltas, a
 * turn calling a skill, a Bash command, a task and a background agent, their
 * results, the agent's own parented call, a retry, a usage warning, the
 * agent's notification, a denied push with its announcement, text deltas, the
 * last words, and a `result` carrying `structured_output` and the
 * authoritative `permission_denials`.
 *
 * The subprocess door reads it from a stub `claude` (`transcriptStub`); the SDK
 * door reads the same frames from a fake `query()` (`spawn-sdk.test.ts`). The
 * echo line's text is whatever the door sent — `__ECHO__` is filled in by both.
 */

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The transcript's path. */
export const TRANSCRIPT = fileURLToPath(new URL('./transcript.ndjson', import.meta.url));

/** The placeholder the echo line carries, quoted as it sits in the JSON. */
const ECHO = '"__ECHO__"';

/** The transcript's lines, the echo carrying `text` — what a `claude` given that boot prompt prints. */
export function transcriptLines(text: string): string[] {
  return readFileSync(TRANSCRIPT, 'utf8').split('\n').filter(Boolean)
    .map((line) => line.replace(ECHO, JSON.stringify(text)));
}

/** The same, parsed: what the SDK's `query()` yields for that session. */
export function transcriptFrames(text: string): Record<string, unknown>[] {
  return transcriptLines(text).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * A `claude` that replays the transcript: it reads the first user line, prints
 * every frame (the echo carrying that line's text), and exits 0 when its stdin
 * closes — as a session whose one turn ended does.
 */
const STUB = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const lines = fs.readFileSync(${JSON.stringify(TRANSCRIPT)}, 'utf8').split('\\n').filter(Boolean);
let buffer = '';
let said = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const index = buffer.indexOf('\\n');
  if (said || index < 0) return;
  said = true;
  const message = JSON.parse(buffer.slice(0, index));
  const text = message.message.content.map((block) => block.text).join('');
  for (const line of lines) process.stdout.write(line.replace(${JSON.stringify(ECHO)}, JSON.stringify(text)) + '\\n');
});
process.stdin.on('end', () => process.exit(0));
`;

/** A directory holding that stub as `claude`, for a PATH. */
export function transcriptStub(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pc-transcript-'));
  const bin = join(dir, 'claude');
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  return dir;
}
