// `phase-console grants list | revoke <id> | revoke-all` — the scoped grants
// from a terminal (control-tower phase 149, #212; §Architecture 19). Shared by
// the Pro bin and the free tree's: a grant is in both editions.
//
//   grants list         every grant this console holds, newest first: the rule,
//                       the scope, who granted it and through which door, until
//                       when, and what it changed — live ones first in the count.
//   grants revoke <id>  end one live grant: exactly what its row says it changed
//                       is undone. It takes authority away, so no owner key is
//                       needed.
//   grants revoke-all   end every live grant.
//
// Flags: `--console <name|port>` (which console; the default is the one whose
// root holds this directory, else the machine's only one), `--reason <words>`
// and `--json`. A supervised session's `grants revoke` and `grants revoke-all`
// are denied at its hook (`console-forge`): a grant is a person's to take back.

import { resolvePort, send } from './owner-verb.mjs';

const HELP = `phase-console grants list | revoke <id> | revoke-all [--console <name|port>] [--reason <words>] [--json]

  list         every grant: the rule, its scope, who gave it, until when, what it changed
  revoke       end one live grant — exactly what it changed is undone
  revoke-all   end every live grant
`;

const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'until revoked');

function printList(body, out) {
  const grants = body.grants ?? [];
  out.write(`${body.live ?? 0} live grant${body.live === 1 ? '' : 's'} of ${grants.length}\n`);
  for (const row of grants) {
    const changed = (row.changed ?? []).map((change) => change.kind).join(', ') || 'nothing';
    out.write(`  ${row.id}  ${row.state.padEnd(7)} ${row.rule} · ${row.scope}${row.slug ? ` · ${row.slug}${row.phase != null ? `#${row.phase}` : ''}` : ''}`
      + ` · by ${row.by}${row.door ? ` (${row.door})` : ''} · ${row.state === 'live' ? when(row.until) : `ended ${when(row.endedAt)}`} · changed: ${changed}\n`);
  }
}

/** @param {string[]} argv the words after `grants` @param {{ root: string }} ctx */
export async function grantsVerb(argv, ctx) {
  const words = [];
  let selector;
  let reason;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i];
    if (word === '--json') json = true;
    else if (word === '--console') { selector = argv[i + 1]; i += 1; }
    else if (word === '--reason') { reason = argv[i + 1]; i += 1; }
    else if (word === '--help' || word === '-h') { process.stdout.write(HELP); return 0; }
    else words.push(word);
  }
  const [verb, id] = words;
  if (!['list', 'revoke', 'revoke-all'].includes(verb ?? '')) {
    process.stderr.write(verb ? `phase-console grants: no verb "${verb}"\n\n${HELP}` : HELP);
    return 2;
  }
  if (verb === 'revoke' && !id) {
    process.stderr.write(`phase-console grants revoke: name the grant — its id is in \`phase-console grants list\`\n`);
    return 2;
  }
  const resolved = await resolvePort(ctx.root, selector);
  if (!resolved.ok) { process.stderr.write(`${resolved.message}\n`); return 2; }
  const press = (word) => {
    if (word === 'list') return ['GET', '/api/permissions/grants'];
    if (word === 'revoke') return ['POST', `/api/permissions/grants/${encodeURIComponent(id)}/revoke`, reason ? { reason } : {}];
    if (word === 'revoke-all') return ['POST', '/api/permissions/grants/revoke-all', reason ? { reason } : {}];
    return [];
  };
  const [method, path, body] = press(verb);
  const answer = await send(resolved.port, method, path, body, 'phase-console/grants');
  if (!answer.ok) {
    process.stderr.write(`phase-console grants ${verb}: no console answers on 127.0.0.1:${resolved.port} — start it first (${answer.error?.message ?? answer.error}).\n`);
    return 1;
  }
  if (json) process.stdout.write(`${JSON.stringify(answer.body, null, 2)}\n`);
  if (answer.status >= 400) {
    if (!json) process.stderr.write(`phase-console grants ${verb}: ${answer.body?.error ?? `HTTP ${answer.status}`}\n`);
    return 1;
  }
  if (json) return 0;
  if (verb === 'list') printList(answer.body, process.stdout);
  else if (verb === 'revoke') process.stdout.write(`Revoked ${answer.body.grant?.id ?? id}: ${answer.body.grant?.rule ?? ''} — what it changed is undone.\n`);
  else process.stdout.write(`Revoked ${answer.body.revoked} live grant${answer.body.revoked === 1 ? '' : 's'}.\n`);
  return 0;
}
