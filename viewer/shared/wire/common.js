/**
 * The wire's shared shapes (measured-console phase 32, §Architecture 10).
 *
 * `shared/wire/` is the ONE source of the HTTP surface's types: one file per
 * route family, each a JSDoc-typed ES module that the server imports for the
 * bodies its handlers send and the client for the bodies its fetches read
 * (`import type { … } from '@shared/wire/<family>.js'`). Each family exports
 * `WIRE_ROUTES` — every route it owns, by the id `client/src/data/surface.ts`
 * gives it (`GET /api/state`, `supervisor GET /api/fleet/turn`), naming the
 * typedef its response is and, for a write, the typedef it takes.
 * `viewer/test/wire-parity.test.ts` holds the set to the surface registry in
 * both directions and every typedef to a route.
 *
 * This file holds the shapes many families answer with, and no routes; a shape no route reaches is deleted, not kept here in case. A
 * typedef's name is unique across `shared/wire/`.
 */

/**
 * A body the route answers with but nobody reads as a shape: a hook's or a
 * stream's acknowledgement, a file, a redirect. Its route says why.
 * @typedef {unknown} WireOpaque
 */

export {};
