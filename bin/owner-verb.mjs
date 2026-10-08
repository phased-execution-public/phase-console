// `phase-console owner status | enroll | lock` — the owner key from a terminal
// (control-tower phase 148, #208; §Architecture 19). Shared by the Pro bin and
// the free tree's: the owner door is in both editions.
//
//   owner status   what the owner door is on this console — no key, a key, the
//                  keys (labels, algorithms, where they were enrolled, when last
//                  used), the owner sessions and the requests waiting.
//   owner enroll   the FIRST key's one-time link, good for ten minutes: open it
//                  in a browser ON THIS MACHINE and enrol a passkey. A console
//                  that has a key already refuses — a later key is enrolled
//                  from a browser signed in as the owner.
//   owner lock     end every owner session on this console now.
//
// Flags: `--console <name|port>` (which console; the default is the one whose
// root holds this directory, else the machine's only one) and `--json`.
// A supervised session's `owner enroll` and `owner lock` are denied at its hook
// (`console-forge`): the owner keys are a person's.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HELP = `phase-console owner status | enroll | lock [--console <name|port>] [--json]

  status   what the owner door is here: unenrolled, enrolled; the keys and the requests waiting
  enroll   print the first owner key's one-time link (ten minutes) — open it in a browser on this machine
  lock     end every owner session now
`;

/** Which console a verb speaks to: a port, a name, or the one whose root holds this directory. Shared with `grants-verb.mjs`. */
export async function resolvePort(root, selector) {
  if (selector !== undefined && /^\d+$/.test(selector)) return { ok: true, port: Number(selector) };
  const instances = await import(pathToFileURL(join(root, 'viewer', 'shared', 'instances.mjs')).href);
  const found = instances.selectInstance(selector, process.cwd());
  if (found.kind !== 'registered' && found.kind !== 'candidate') return { ok: false, message: instances.selectionError(found) };
  const isDefault = found.default === true || (found.kind === 'candidate' && instances.isDefaultRoot(found.root));
  return { ok: true, port: found.port ?? instances.preferredPort(found.root, { isDefault }) };
}

/** One request to the console at the machine, as this app's own client. Shared with `grants-verb.mjs`. */
export async function send(port, method, path, body, agent = 'phase-console/owner') {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'x-phase-console': '1', 'user-agent': agent, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { text }; }
    return { ok: true, status: response.status, body: parsed };
  } catch (error) {
    return { ok: false, error };
  }
}

const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');

function printStatus(body, out) {
  const words = { unenrolled: 'no owner key — every press from this machine counts as a person\'s', enrolled: 'an owner key is enrolled', unlocked: 'an owner key is enrolled, and this request is the owner\'s' };
  out.write(`Owner door: ${body.state} — ${words[body.state] ?? body.state}\n`);
  for (const key of body.keys ?? []) {
    out.write(`  key ${key.label} · ${key.alg} · at ${key.origin} · enrolled ${when(key.createdAt)} · last used ${when(key.lastUsedAt)}\n`);
  }
  const waiting = body.requests ?? [];
  if (waiting.length) {
    out.write(`${waiting.length} request${waiting.length === 1 ? '' : 's'} wait for the owner:\n`);
    for (const request of waiting) out.write(`  ${request.ask}\n`);
  }
  if (body.relyingParty?.refused) out.write(`A passkey cannot be bound here: ${body.relyingParty.refused}\n`);
}

/** @param {string[]} argv the words after `owner` @param {{ root: string }} ctx */
export async function ownerVerb(argv, ctx) {
  const words = [];
  let selector;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i];
    if (word === '--json') json = true;
    else if (word === '--console') { selector = argv[i + 1]; i += 1; }
    else if (word === '--help' || word === '-h') { process.stdout.write(HELP); return 0; }
    else words.push(word);
  }
  const [verb] = words;
  if (!['status', 'enroll', 'lock'].includes(verb ?? '')) {
    process.stderr.write(verb ? `phase-console owner: no verb "${verb}"\n\n${HELP}` : HELP);
    return 2;
  }
  const resolved = await resolvePort(ctx.root, selector);
  if (!resolved.ok) { process.stderr.write(`${resolved.message}\n`); return 2; }
  const press = (word) => {
    if (word === 'status') return ['GET', '/api/owner'];
    if (word === 'enroll') return ['POST', '/api/owner/enroll/link', {}];
    if (word === 'lock') return ['POST', '/api/owner/lock', { all: true }];
    return [];
  };
  const [method, path, body] = press(verb);
  const answer = await send(resolved.port, method, path, body);
  if (!answer.ok) {
    process.stderr.write(`phase-console owner ${verb}: no console answers on 127.0.0.1:${resolved.port} — start it first (${answer.error?.message ?? answer.error}).\n`);
    return 1;
  }
  if (json) process.stdout.write(`${JSON.stringify(answer.body, null, 2)}\n`);
  if (answer.status >= 400) {
    if (!json) process.stderr.write(`phase-console owner ${verb}: ${answer.body?.error ?? `HTTP ${answer.status}`}\n`);
    return 1;
  }
  if (json) return 0;
  if (verb === 'status') printStatus(answer.body, process.stdout);
  else if (verb === 'enroll') {
    process.stdout.write(`Open this link in a browser on this machine within ten minutes (until ${when(answer.body.expiresAt)}), and enrol a passkey — it works once:\n\n  ${answer.body.link}\n\n`);
  } else {
    process.stdout.write(`Ended ${answer.body.ended} owner session${answer.body.ended === 1 ? '' : 's'}. The next high-risk press asks for the owner key again.\n`);
  }
  return 0;
}
