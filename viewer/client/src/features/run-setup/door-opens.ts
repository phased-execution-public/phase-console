/**
 * The links the launch door showed in full (control-tower phase 139, #216) —
 * the only ones a launch from it may open on the machine.
 *
 * A plan's `auto-open: host` step opens at the launch door, on the host, behind
 * `--allow-terminal` or `--allow-agent` — what §Architecture 12's safety floor
 * promised since phase 41 — and only once a person has SEEN the link whole.
 * The door draws each such link in full, and records it here while it is on
 * screen; the launch sends exactly these back (`autoOpen`), and the server
 * opens a step only when its link is one of them. Every other door — converge,
 * a webhook, the CLI — sends nothing, so nothing opens there.
 */

const shown = new Map<string, readonly string[]>();

/** The start route's own cap on `autoOpen` (`api/routes.ts`) — past it, a launch would be refused whole. */
export const AUTO_OPEN_MAX = 20;

/** The route's cap on one link — a longer one would refuse the launch whole, so it is never sent. */
export const AUTO_OPEN_LINK_MAX = 2048;

/** The door drew these links for this plan (an empty list: it no longer does) — once each, at most the cap. */
export function showAtDoor(slug: string, urls: readonly string[]): void {
  const once = [...new Set(urls)].filter((url) => url.length <= AUTO_OPEN_LINK_MAX).slice(0, AUTO_OPEN_MAX);
  if (once.length) shown.set(slug, once);
  else shown.delete(slug);
}

/** What the launch of this plan may ask the machine to open. */
export function shownAtDoor(slug: string): string[] {
  return [...(shown.get(slug) ?? [])];
}
