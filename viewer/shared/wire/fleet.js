/**
 * The wire of fleet — a console's own `/api/fleet…` routes (the freeze, the
 * machine profile, the relay to the supervisor) and every route the fleet
 * supervisor (`viewer/fleet/`, 127.0.0.1:4100) answers itself: the census, the
 * merged inbox, turn, queue and detections, the verbs, the hold, the machine
 * switch, the direct door, the push register and the lock-screen answers
 * (measured-console phase 32).
 */

/**
 * A console's freeze, as `GET /api/fleet` reads it: the state `/api/state`
 * carries, and whether this console may press Freeze at all.
 * @typedef {object} FleetFreezeView
 * @property {import('./state.js').FleetState} fleet - the panic button's state
 * @property {boolean} allowRun - the freeze is run-class: off, the button would be theatre
 */

/**
 * What a freeze or a thaw answers (a 409 carries `error` and `fleet` instead).
 * @typedef {object} FleetFreezeAnswer
 * @property {import('./state.js').FleetState} fleet - the state after the press
 * @property {number} runs - how many runs the press held (a freeze) or let go (a thaw)
 */

/**
 * A freeze's or a thaw's body: who pressed, when the caller names it.
 * @typedef {{ by?: string }} FleetFreezeBody
 */


/**
 * Every route this family owns → the typedef its response is (and, for a write, the one it takes).
 * @type {Readonly<Record<string, { response: string, body?: string }>>}
 */
export const WIRE_ROUTES = Object.freeze({
  'GET /api/fleet': { response: 'FleetFreezeView' },
  'POST /api/fleet/freeze': { response: 'FleetFreezeAnswer', body: 'FleetFreezeBody' },
  'POST /api/fleet/thaw': { response: 'FleetFreezeAnswer', body: 'FleetFreezeBody' },
  'GET /api/fleet/profile': { response: 'FleetProfileView' },
});
