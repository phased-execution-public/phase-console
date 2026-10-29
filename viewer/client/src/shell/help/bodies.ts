/**
 * The guide's PROSE — one markdown file per section, imported with Vite's `?raw`.
 * (The `<id>.fa.md` twins beside them are the repository's Persian docs; the
 * console does not import them.)
 *
 * Its own module so that `sections.ts` (which the sheet's section list needs
 * the moment it opens) carries only the metadata. The text itself is ~60 KB of
 * string that nobody reads until a section's cards are drawn.
 *
 * Imported only by `section.tsx`, which is itself behind the sheet's `lazy()`.
 */

import concepts from '@/content/guide/concepts.md?raw';
import quickStart from '@/content/guide/quick-start.md?raw';
import running from '@/content/guide/running.md?raw';
import destinations from '@/content/guide/destinations.md?raw';
import tower from '@/content/guide/tower.md?raw';
import run from '@/content/guide/run.md?raw';
import autopilot from '@/content/guide/autopilot.md?raw';
import halts from '@/content/guide/halts.md?raw';
import sessions from '@/content/guide/sessions.md?raw';
import notifications from '@/content/guide/notifications.md?raw';
import yourTurn from '@/content/guide/your-turn.md?raw';
import permissions from '@/content/guide/permissions.md?raw';
import mcp from '@/content/guide/mcp.md?raw';
import settings from '@/content/guide/settings.md?raw';
import insights from '@/content/guide/insights.md?raw';
import mobile from '@/content/guide/mobile.md?raw';
import troubleshooting from '@/content/guide/troubleshooting.md?raw';
import reference from '@/content/guide/reference.md?raw';

/** Section id → its markdown body. Keyed by the same ids `sections.ts` declares. */
export const HELP_BODIES: Readonly<Record<string, string>> = Object.freeze({
  concepts,
  'quick-start': quickStart,
  running,
  destinations,
  tower,
  run,
  autopilot,
  halts,
  sessions,
  notifications,
  'your-turn': yourTurn,
  permissions,
  mcp,
  settings,
  insights,
  mobile,
  troubleshooting,
  reference,
});
