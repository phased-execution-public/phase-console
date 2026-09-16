/**
 * The prefix this page is served under.
 *
 * A console's page is reached two ways: at the console's own origin
 * (`http://127.0.0.1:4123/`), where the prefix is `/`, and through a proxy that
 * mounts every console of a machine under one origin at `/c/<id>/` (the fleet
 * supervisor, zero-touch phase 18). Under a mount, every absolute path the
 * client asks for — `/api/…`, `/events`, `/ws/…` — has to carry the prefix or it
 * reaches the proxy instead of the console. The prefix is read once, from the
 * location the page loaded at: the client routes by hash, so the path never
 * changes under a running page.
 *
 * Two things deliberately stay absolute. The content-hashed `/assets/…` a build
 * references are served at the proxy's root, from whichever console holds that
 * exact file. And `/sw.js` is never asked for under a mount at all
 * (`lib/pwa.ts`): the root belongs to the proxy's own worker, and a console's
 * page registering one there would take it.
 */

const MOUNT = /^\/c\/[^/]+\//;

/** `/c/<id>/` for a path under a mount, else `/`. */
export function baseFor(pathname: string): string {
  return MOUNT.exec(pathname)?.[0] ?? '/';
}

/** This page's prefix. */
export const BASE: string = typeof window === 'undefined' ? '/' : baseFor(window.location.pathname);

/** Is this page a console served under a mount rather than at its own origin? */
export const MOUNTED: boolean = BASE !== '/';

/**
 * An absolute console path (`/api/state`) as this page must ask for it. A path
 * that does not start with a single `/` — a full URL, a protocol-relative one,
 * a relative one — is returned untouched.
 */
export function consolePath(path: string, base: string = BASE): string {
  if (base === '/' || !path.startsWith('/') || path.startsWith('//')) return path;
  return `${base}${path.slice(1)}`;
}
