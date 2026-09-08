/**
 * Hash routing, as pure functions.
 *
 * Kept apart from `router.js` because that module owns the `useRoute` hook and
 * therefore pulls in the rendering runtime, and the rendering runtime is a bare
 * specifier the browser resolves from an import map. Nothing in Node can load
 * it — so the routing *rules*, which are exactly what a server-built
 * notification URL has to agree with, were untestable purely by association.
 *
 * They are the same rules either way:
 *   #/plans                    #/plan/<slug>/route
 *   #/plan/<slug>/phase/8      #/plan/<slug>/handoff/7
 *   #/ready  #/stats  #/search?q=…  #/settings  #/source  #/notifications
 */

export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const query = Object.fromEntries(new URLSearchParams(queryPart ?? ''));
  return { segments, query, path: pathPart };
}

/**
 * `path` may arrive in any of the forms this app produces: `plans`, `/plans`,
 * `#/plans`, or the `/#/plans` a server-built notification URL carries (that
 * one has to be a URL path, because a service worker resolves it against the
 * origin). All four mean the same route, and normalising here is what lets
 * `routeFor` on the server stay the single place a destination is decided.
 */
export function toHash(path) {
  return `#/${String(path).replace(/^\/?#?\/?/, '')}`;
}

export function navigate(path, { replace = false } = {}) {
  const target = toHash(path);
  if (location.hash === target) return;
  if (replace) history.replaceState(null, '', target);
  else location.hash = target;
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function planHref(slug, tab = 'route') {
  return `#/plan/${encodeURIComponent(slug)}/${tab}`;
}

export function phaseHref(slug, phase) {
  return `#/plan/${encodeURIComponent(slug)}/phase/${phase}`;
}

export function handoffHref(slug, phase) {
  return `#/plan/${encodeURIComponent(slug)}/handoff/${phase}`;
}

/**
 * A session's own page, or the list.
 *
 * Moved here from `client/src/app/routes.ts` (which re-exports it, so every
 * existing `import { sessionsHref } from '@/app/routes'` is untouched) because
 * `phaseSessionHref` below has to build one and this file is the one place
 * that spells a route. Two spellings of `#/sessions/<id>` is how a deep link
 * survives a rename in one of them and not the other.
 */
export function sessionsHref(id) {
  return id ? `#/sessions/${encodeURIComponent(id)}` : '#/sessions';
}

/**
 * The autopilot lane working a phase — `#/plan/<slug>/run?lane=p<N>`.
 *
 * A lane is `p<N>` on the run page's tab strip (`features/runs/session-panes.
 * ts:laneId`), which until now was component state and therefore unaddressable:
 * the pane you were told to look at could not be linked to.
 */
export function laneHref(slug, phase) {
  return `#/plan/${encodeURIComponent(slug)}/run?lane=p${phase}`;
}

/**
 * Where to send someone who clicks a phase that is genuinely being worked.
 *
 * The RETURN LEG of orphans-P8, which taught a session how to name its phase
 * (`correlate` → the Sessions row's `phaseHref`). This is the other direction,
 * and the rule it exists to enforce is the negative one:
 *
 *   **nothing live ⇒ NO link.** `live` absent means no run, no vouched lock
 *   and no live session was found, and a chip that navigates somewhere on a
 *   phase nothing is running is the same lie as a chip that pulses on one.
 *   The caller anchors the chip only when this answers a string.
 *
 * Which page depends on the witness, because they are different things:
 *
 *   - a `pty` session — one the console itself started and can show you keys
 *     and bytes for — is a SESSION page, `#/sessions/<id>`. That is the shipped
 *     precedent (`qa-launcher.tsx`, `recovery-actions.tsx`).
 *   - an autopilot LANE is a tab on its run page, not a pty. Its console, its
 *     approvals and its replay are there and nowhere else, so it gets
 *     `?lane=p<N>`.
 *
 * (Until Phase 8 the second bullet had a second reason — `#/sessions/<id>`
 * "would resolve to nothing", because the page looked the id up in the pty
 * registry alone. It no longer does: an id that is a CONVERSATION now resolves
 * to the session-presence record and a page offering to resume it. The choice
 * above is unchanged, because it was never really about resolution — a lane's
 * pane is on its run page.)
 *
 * `pty` is therefore a fact the caller must supply and not one this can guess:
 * pass `true` only when the id is known to be in the console's own terminal
 * registry.
 *
 * @param {{slug: string, phase: number, live?: {via?: string, session?: string}|null, pty?: boolean}} args
 * @returns {string|null} the href, or `null` when nothing is live.
 */
export function phaseSessionHref({ slug, phase, live, pty = false }) {
  if (!live || !live.via) return null;
  if (pty && live.session) return sessionsHref(live.session);
  return laneHref(slug, phase);
}
