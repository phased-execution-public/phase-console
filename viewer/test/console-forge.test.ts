/**
 * CF-1..6 (control-tower phase 129, #218) — a session cannot press its own
 * console.
 *
 * A session the console supervises runs as the operator's own OS user, and the
 * console's write guard is a capability flag, its header and a same-origin test
 * applied only when a request carries an Origin. So one `curl` from a `Bash`
 * call could answer the session's own approval card, strike a deny rule, raise
 * its run to `bypass`, approve a manual gate through `/api/write`, or prove a
 * person's step by a person's word — and `gate-forge` walled only the gate
 * file. The hook guard `console-forge` walls the paths a session takes:
 *
 * CF-1  An HTTP client the shell would run (`curl`, `wget`, `http`, `xh`)
 *       against a console's address, with a mutating method and a path in
 *       `AUTHORITY_ROUTES`, is denied before it runs — on every profile,
 *       journalled `phase.tool-denied {rule: 'console-forge', verb}`, with the
 *       declaration to make instead.
 * CF-2  The same presses through the CLI twins (`phase-console run
 *       approve|deny`, `supervisor set`).
 * CF-3  A wrapper — an interpreter's payload, an `eval`, a script piped into a
 *       shell, a URL in a variable — whose text carries a console address and
 *       a fenced path.
 * CF-4  A `Write`, `Edit` or `NotebookEdit`, or a `Bash` redirection, into the
 *       console's state or config directories — but never the session's own
 *       run tree or its memory, which can live under the state directory.
 * CF-5  Nothing a session legitimately does: reads, `/hooks/*`, its own
 *       message token, the skill's scripts, the operational verbs; and the
 *       table is held to the routes and CLI verbs that exist.
 * CF-6  A press the plan's `permission.destructive` row names for the running
 *       phase passes, as phase 107's auto-grant reads the row.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SKILL_DIR } from '../server/config.ts';
import { Service } from '../server/service.ts';
import { handleApi } from '../server/api/routes.ts';
import { CONSOLE_FORGE_RULE } from '../server/runner/approvals.ts';
import {
  AUTHORITY_ROUTES, AUTHORITY_VERBS, CONSOLE_FILES_VERB, authorityCliOf, authorityRouteOf,
} from '../shared/door-model.js';
import { configDir, stateHome } from '../shared/instances.mjs';
import { OPERATOR_VERBS } from '../shared/verb-model.js';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const flags = { port: 0, host: '127.0.0.1', open: false, allowWrites: false, scriptsDir: SCRIPTS, logFile: null };

type Noted = { event: string; data: Record<string, unknown>; phase?: number };
type Answer = { permissionDecision: string; permissionDecisionReason: string };

/**
 * A service driving one supervised run (`r1`, plan `demo`, phase 2), the way
 * `hook-decisions.test.ts` stands one up: reached by run id through `runners`.
 */
function supervised(profile = 'bypass', extra: Record<string, unknown> = {}) {
  const service = new Service(flags as never);
  const noted: Noted[] = [];
  (service as unknown as { runners: Map<string, unknown> }).runners.set('demo', {
    busy: () => true,
    current: () => ({ id: 'r1', slug: 'demo', activePhase: 2, permissionProfile: profile, phases: {}, ...extra }),
    note: (event: string, data: Record<string, unknown>, phase?: number) => noted.push({ event, data, phase }),
    noteWaitDenied: () => {},
    park: () => {},
    isSpending: () => false,
  });
  const decide = async (tool_name: string, tool_input: Record<string, unknown>, more: Record<string, unknown> = {}) =>
    ((await service.decideToolUse({ tool_name, tool_input, ...more }, 'r1')) as { hookSpecificOutput: Answer })
      .hookSpecificOutput;
  return { service, noted, decide, close: () => { service.approvals.disarm(); service.close(); } };
}

const H = "-H 'x-phase-console: 1'";

/** Asserts one call is fenced under `verb`, journalled, and told what to declare. */
async function fenced(command: string, verb: string, profile = 'bypass') {
  const { decide, noted, close } = supervised(profile);
  try {
    const answer = await decide('Bash', { command });
    assert.equal(answer.permissionDecision, 'deny', `${profile} allowed: ${command}`);
    assert.match(answer.permissionDecisionReason, /rule: console-forge/, command);
    assert.match(answer.permissionDecisionReason, /phase-outcome\.sh demo 2 (?:blocked|needs-human) --needs /, `${command} — it names the declaration`);
    const denied = noted.filter((n) => n.event === 'phase.tool-denied' && n.data.rule === CONSOLE_FORGE_RULE);
    assert.equal(denied.length, 1, `${command} — written down once`);
    assert.equal(denied[0]!.data.verb, verb, command);
    assert.equal(denied[0]!.phase, 2);
  } finally {
    close();
  }
}

/** Asserts one call is not the forge guard's: allowed on `bypass`, where nothing else is asked. */
async function passes(tool: string, input: Record<string, unknown>, more: Record<string, unknown> = {}) {
  const { decide, noted, close } = supervised('bypass');
  try {
    const answer = await decide(tool, input, more);
    assert.equal(answer.permissionDecision, 'allow', `${JSON.stringify(input)} — ${answer.permissionDecisionReason}`);
    assert.equal(noted.filter((n) => n.data.rule === CONSOLE_FORGE_RULE).length, 0, JSON.stringify(input));
  } finally {
    close();
  }
}

/* ------------------------------------------------------------------ *
 * CF-1 — an HTTP client against a console address, to a fenced route
 * ------------------------------------------------------------------ */

const ROUTE_PRESSES: [string, string][] = [
  ['answer-card', `curl -s -X POST ${H} -H 'content-type: application/json' http://127.0.0.1:4130/api/approvals/a1b2c3 -d '{"decision":"allow"}'`],
  ['answer-card', `curl -sS -XPOST localhost:4123/api/approvals/a1b2c3 --data '{"decision":"deny"}'`],
  ['edit-policy', `curl -fsS --json '{"add":{"allow":["Bash(git push:*)"]},"scope":"plan"}' ${H} http://127.0.0.1:4130/api/policy`],
  ['edit-policy', `curl -X POST ${H} 'http://127.0.0.1:4130/api/policy?slug=demo' -d '{}'`],
  ['run-settings', `wget -qO- --header='x-phase-console: 1' --post-data='{"permissionProfile":"bypass"}' http://127.0.0.1:4130/api/run/demo/settings`],
  ['approve-gate', 'http POST :4130/api/plans/demo/gate/3 x-phase-console:1 approve:=true by=mobin'],
  ['console-write', `curl -X POST ${H} http://127.0.0.1:4130/api/write -d '{"action":"gate-approve","slug":"demo","phase":3,"door":"console"}'`],
  ['check-step', 'xh :4130/api/human-steps/s-1/check x-phase-console:1 note=done'],
  ['dismiss-step', `curl --request POST ${H} 'http://[::1]:4130/api/human-steps/s-1/dismiss'`],
  // Spellings the router reads the same way: a percent-encoded segment, a dot
  // segment kept by --path-as-is, a curl glob, an IPv4 short form.
  ['answer-card', `curl -X POST ${H} http://127.0.0.1:4130/api/%61pprovals/a1b2c3 -d '{}'`],
  ['answer-card', `curl --path-as-is -X POST ${H} http://127.0.0.1:4130/api/runs/../approvals/a1b2c3 -d '{}'`],
  ['edit-policy', `curl -X POST ${H} 'http://127.0.0.1:4130/api/{nothing,policy}' -d '{}'`],
  ['answer-card', `curl -X POST ${H} http://127.1:4130/api/approvals/a1 -d '{}'`],
  // With the console's own header, through any address at all — and without
  // one (a header read from a file), any name for a host on a console's port.
  ['run-settings', `curl -X POST ${H} https://box.tail1234.ts.net/c/f922d743-pe-hub/api/run/demo/settings -d '{}'`],
  ['answer-card', "curl -X POST -H @headers.txt http://localhost.:4130/api/approvals/a1 -d '{}'"],
  ['edit-policy', "curl -X POST -H @headers.txt http://kubernetes.docker.internal:4130/api/policy -d '{}'"],
  // Wrapped, piped, and with a method only the shell knows.
  ['answer-card', `env -u CLAUDECODE timeout 30 curl -X POST ${H} http://127.0.0.1:4130/api/approvals/a1`],
  ['answer-card', `cd /tmp && curl -s -X POST ${H} http://127.0.0.1:4130/api/approvals/a1 | jq .`],
  ['answer-card', `curl -X "$METHOD" ${H} http://127.0.0.1:4130/api/approvals/a1`],
  // How each client really reads its words: curl's --next starts a fresh
  // request, its [] globs expand, a URL may carry userinfo, a console may be
  // the proxy; httpie posts a body it reads from its input or a file.
  ['edit-policy', `curl -s http://127.0.0.1:4130/api/runs --next -d '{}' ${H} http://127.0.0.1:4130/api/policy`],
  ['edit-policy', `curl -X POST ${H} 'http://127.0.0.1:4130/api/[o-p]olicy' -d '{}'`],
  ['edit-policy', `curl -X POST ${H} 'me@127.0.0.1:4130/api/policy' -d '{}'`],
  ['edit-policy', "curl -x http://127.0.0.1:4130 -X POST -H @headers.txt http://anything/api/policy -d '{}'"],
  ['edit-policy', "http_proxy=http://127.0.0.1:4130 curl -X POST -H @headers.txt http://anything/api/policy -d '{}'"],
  ['edit-policy', "echo '{}' | http :4130/api/policy x-phase-console:1"],
  ['edit-policy', 'http :4130/api/policy x-phase-console:1 @body.json'],
  // Behind a lead the shell reader does not peel, and a line handed over as one word.
  ['edit-policy', `caffeinate -i curl -X POST ${H} http://127.0.0.1:4130/api/policy -d '{}'`],
  ['answer-card', `arch -arm64 curl -X POST ${H} http://127.0.0.1:4130/api/approvals/a1 -d '{}'`],
  ['edit-policy', `gtimeout 5 curl -X POST ${H} http://127.0.0.1:4130/api/policy -d '{}'`],
  ['edit-policy', `script -qec "curl -X POST ${H} http://127.0.0.1:4130/api/policy -d {}" /dev/null`],
  ['answer-card', 'caffeinate node /x/console/bin/phase-console.mjs run approve a1'],
];

test('CF-1: an HTTP client pressing a fenced route of a console is denied before it runs, and says what to declare', async () => {
  for (const [verb, command] of ROUTE_PRESSES) await fenced(command, verb);
});


test('CF-1: on every profile — the guard is outside the policy, so no profile, strike or allow rule reaches it', async () => {
  for (const profile of ['guarded', 'trusted', 'bypass']) {
    await fenced(`curl -X POST ${H} http://127.0.0.1:4130/api/approvals/a1 -d '{"decision":"allow"}'`, 'answer-card', profile);
    await fenced('phase-console run approve a1', 'answer-card', profile);
  }
});

test('CF-1: the same call from a terminal the console does not drive is not the guard\'s', async () => {
  const service = new Service(flags as never);
  try {
    const reply = (await service.decideToolUse({
      tool_name: 'Bash', tool_input: { command: `curl -X POST ${H} http://127.0.0.1:4130/api/approvals/a1 -d '{}'` },
    }, null)) as { hookSpecificOutput: Answer };
    assert.doesNotMatch(reply.hookSpecificOutput.permissionDecisionReason ?? '', /console-forge/);
  } finally {
    service.close();
  }
});

/* ------------------------------------------------------------------ *
 * CF-2 — the CLI twins
 * ------------------------------------------------------------------ */

test('CF-2: the CLI twins of a fenced route are fenced, however the CLI is reached', async () => {
  for (const command of [
    'phase-console run approve a1b2c3',
    'node /home/x/work/pe-hub/console/bin/phase-console.mjs run deny a1b2c3 --reason "not needed"',
    'phase-console run --json --console pe-hub approve a1b2c3',
    'npx phase-console run approve a1b2c3',
    'node "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/console/bin/phase-console.mjs" run approve a1',
    'bash ~/work/pe-hub/phased-execution/bin/phase-console run approve a1b2c3',
  ]) {
    await fenced(command, 'answer-card');
  }
});

/* ------------------------------------------------------------------ *
 * CF-3 — a wrapper whose text carries a console address and a fenced path
 * ------------------------------------------------------------------ */

test('CF-3: a wrapper carrying a console address and a fenced path is denied — its method is unreadable, so any', async () => {
  for (const [verb, command] of [
    ['answer-card', `python3 -c "import urllib.request as u; u.urlopen(u.Request('http://127.0.0.1:4130/api/approvals/a1', data=b'{}', headers={'x-phase-console': '1'}))"`],
    ['edit-policy', `node -e "fetch('http://localhost:4130/api/policy', {method: 'POST', headers: {'x-phase-console': '1'}, body: '{}'})"`],
    ['run-settings', "python3 - <<'EOF'\nimport json, urllib.request\nreq = urllib.request.Request('http://127.0.0.1:4130/api/run/demo/settings', data=json.dumps({'permissionProfile': 'bypass'}).encode(), headers={'x-phase-console': '1'})\nurllib.request.urlopen(req)\nEOF"],
    ['answer-card', `URL=http://127.0.0.1:4130/api/approvals/a1; curl -X POST ${H} "$URL"`],
    ['edit-policy', `eval "curl -X POST ${H} http://127.0.0.1:4130/api/policy"`],
    ['console-write', `bash -c 'curl -X POST -H "x-phase-console: 1" http://127.0.0.1:4130/api/write -d {}'`],
    ['answer-card', `cat <<'EOF' | bash\ncurl -X POST ${H} http://127.0.0.1:4130/api/approvals/a1\nEOF`],
    ['answer-card', 'CLI=phase-console; $CLI run approve a1'],
    // An interpreter's method is unreadable, so naming a fenced route is enough.
    ['edit-policy', `python3 -c "import urllib.request,json;print(json.load(urllib.request.urlopen('http://127.0.0.1:4130/api/policy')))"`],
    ['run-settings', `node -e "fetch('http://127.0.0.1:4130/api/run/demo/settings').then(r=>r.json()).then(console.log)"`],
    ['edit-policy', `python3 -c "import urllib.request as u; u.urlopen('http://127.0.0.1:4130/api/policy', b'{}')"`],
    // A request written onto a socket by hand, and a URL a client reads from its input.
    ['answer-card', "printf 'POST /api/approvals/a1 HTTP/1.1\\r\\nHost: localhost\\r\\nx-phase-console: 1\\r\\n\\r\\n' | nc 127.0.0.1 4130"],
    ['edit-policy', "exec 3<>/dev/tcp/127.0.0.1/4130; printf 'POST /api/policy HTTP/1.1\\r\\n\\r\\n' >&3"],
    ['answer-card', 'echo http://127.0.0.1:4130/api/approvals/a1 | xargs curl -X POST -H @headers.txt'],
    // A shell fed a here-string or a process substitution; awk's system(); an
    // alias the line defines; a command line inside one argument.
    ['edit-policy', `bash <<< "curl -X POST ${H} http://127.0.0.1:4130/api/policy -d {}"`],
    ['edit-policy', `bash <(echo "curl -X POST ${H} http://127.0.0.1:4130/api/policy -d {}")`],
    ['edit-policy', `awk 'BEGIN { system("curl -X POST -H x-phase-console:1 http://127.0.0.1:4130/api/policy -d x") }'`],
    ['edit-policy', `shopt -s expand_aliases; alias c=curl\nc -X POST ${H} http://127.0.0.1:4130/api/policy -d {}`],
    ['edit-policy', `git -c alias.p='!curl -X POST -H "x-phase-console: 1" http://127.0.0.1:4130/api/policy -d {}' p`],
    ['edit-policy', `git rebase --exec 'curl -X POST -H "x-phase-console: 1" http://127.0.0.1:4130/api/policy -d {}' HEAD~1`],
    ['edit-policy', `rg --pre 'curl -X POST -H "x-phase-console: 1" http://127.0.0.1:4130/api/policy -d' x .`],
    // …behind a wrapper or an assignment inside that one argument.
    ['edit-policy', `git -c core.pager='env curl -X POST -H "x-phase-console: 1" http://127.0.0.1:4130/api/policy -d x' log`],
    ['edit-policy', `rg --pre 'TOKEN=x nice curl -X POST -H "x-phase-console: 1" http://127.0.0.1:4130/api/policy -d x' pat f.txt`],
    ['edit-policy', `curl --request-target /api/policy -X POST ${H} http://127.0.0.1:4130/`],
  ] as [string, string][]) {
    await fenced(command, verb);
  }
});

/* ------------------------------------------------------------------ *
 * CF-4 — the console's own files
 * ------------------------------------------------------------------ */

const STATE = stateHome();
const CONFIG = configDir();
const ACCOUNT = join(STATE, 'instances', 'f922d743-pe-hub', 'accounts', 'supp', 'config');

test('CF-4: a write into the console\'s state or config directories is denied the same way', async () => {
  for (const [tool, input, more] of [
    ['Write', { file_path: join(CONFIG, 'autopilot.json'), content: '{"deny":[]}' }],
    ['Edit', { file_path: join(STATE, 'instances', 'f922d743-pe-hub', 'approvals', 'pending.json'), old_string: 'a', new_string: 'b' }],
    ['NotebookEdit', { notebook_path: join(STATE, 'scratch.ipynb'), new_source: 'x' }],
    ['Write', { file_path: join(ACCOUNT, 'settings.json'), content: '{}' }],
    ['Bash', { command: `echo '{"deny":[]}' > ${CONFIG}/autopilot.json` }],
    ['Bash', { command: `printf x >> '${join(STATE, 'runs', 'f922d743-pe-hub', 'demo', 'run-r1.json')}'` }],
    ['Bash', { command: `jq . policy.json | tee ${join(CONFIG, 'plans', 'demo.json')}` }],
    ['Bash', { command: `: > ${join(STATE, 'fleet', 'fleet.token')}` }],
    ['Bash', { command: 'echo x > autopilot.json' }, { cwd: CONFIG }],
    // Programs that write, move, link or remove the files they name.
    ['Bash', { command: `cp /tmp/mine.json ${join(CONFIG, 'autopilot.json')}` }],
    ['Bash', { command: `mv ${join(CONFIG, 'autopilot.json')} /tmp/` }],
    ['Bash', { command: `ln -s ${join(CONFIG, 'autopilot.json')} /tmp/policy.json` }],
    ['Bash', { command: `sed -i '' 's/deny/allow/' ${join(CONFIG, 'autopilot.json')}` }],
    ['Bash', { command: `rm -f ${join(STATE, 'approvals', 'pending.json')}` }],
    // …into the top of the directory itself.
    ['Bash', { command: `cp /tmp/autopilot.json ${CONFIG}` }],
    ['Bash', { command: `cp -t ${CONFIG} /tmp/autopilot.json` }],
    ['Bash', { command: `mv /tmp/pending.json ${STATE}/` }],
  ] as [string, Record<string, unknown>, Record<string, unknown>?][]) {
    const { decide, noted, close } = supervised('bypass');
    try {
      const answer = await decide(tool, input, more ?? {});
      assert.equal(answer.permissionDecision, 'deny', `${tool} ${JSON.stringify(input)}`);
      assert.match(answer.permissionDecisionReason, /rule: console-forge/);
      assert.equal(noted.find((n) => n.data.rule === CONSOLE_FORGE_RULE)?.data.verb, CONSOLE_FILES_VERB);
    } finally {
      close();
    }
  }
});

test('CF-4: a write is judged where its links lead — a link into the console\'s files is the files', async (t) => {
  const outside = mkdtempSync(join(tmpdir(), 'pc-forge-link-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(CONFIG, { recursive: true });
  writeFileSync(join(CONFIG, 'autopilot.json'), '{}');
  symlinkSync(join(CONFIG, 'autopilot.json'), join(outside, 'policy.json'));
  symlinkSync(join(CONFIG, 'not-yet.json'), join(outside, 'dangling.json'));
  symlinkSync(CONFIG, join(outside, 'config'));
  for (const [tool, input] of [
    ['Write', { file_path: join(outside, 'policy.json'), content: '{"deny":[]}' }],
    ['Write', { file_path: join(outside, 'dangling.json'), content: '{}' }],
    ['Edit', { file_path: join(outside, 'config', 'autopilot.json'), old_string: 'a', new_string: 'b' }],
    ['Bash', { command: `echo '{}' > ${join(outside, 'policy.json')}` }],
  ] as [string, Record<string, unknown>][]) {
    const { decide, close } = supervised('bypass');
    try {
      assert.equal((await decide(tool, input)).permissionDecision, 'deny', `${tool} ${JSON.stringify(input)}`);
    } finally {
      close();
    }
  }
});

test('CF-4: the session\'s own run tree and memory may live under the state directory, and stay writable', async () => {
  for (const [tool, input] of [
    ['Write', { file_path: join(ACCOUNT, 'projects', '-repo', 'memory', 'project_demo.md'), content: 'x' }],
    ['Edit', { file_path: join(STATE, 'runs', 'f922d743-pe-hub', 'demo', 'worktrees', 'r1', 'app', 'src', 'x.ts'), old_string: 'a', new_string: 'b' }],
    ['Bash', { command: `echo '- [Demo](project_demo.md)' >> ${join(ACCOUNT, 'projects', '-repo', 'memory', 'MEMORY.md')}` }],
    ['Write', { file_path: '/repo/docs/handoffs/demo/phase-02-x.md', content: 'x' }],
    ['Bash', { command: `cat ${CONFIG}/autopilot.json` }],
    ['Bash', { command: `ls -la ${STATE} > /tmp/state-listing.txt 2>&1` }],
    ['Bash', { command: `cp ${join(CONFIG, 'autopilot.json')} /tmp/policy-backup.json` }],
    ['Bash', { command: `sed -n 1p ${join(CONFIG, 'autopilot.json')}` }],
  ] as [string, Record<string, unknown>][]) {
    await passes(tool, input);
  }
});

/* ------------------------------------------------------------------ *
 * CF-5 — nothing a session legitimately does
 * ------------------------------------------------------------------ */

test('CF-5: reads, the hooks, the session\'s own doors, the skill\'s scripts and the operational verbs all pass', async () => {
  for (const command of [
    'curl -s http://127.0.0.1:4130/api/runs',
    'curl -s -H "x-phase-console: 1" http://127.0.0.1:4130/api/approvals',
    'curl -sI http://127.0.0.1:4130/api/policy',
    'curl -X GET http://127.0.0.1:4130/api/policy',
    'wget -qO- http://127.0.0.1:4130/api/run/demo/settings',
    'http :4130/api/human-steps',
    'curl -s -X POST -H "Authorization: Bearer $PE_HOOK_TOKEN" http://127.0.0.1:4130/hooks/declaration -d @decl.json',
    `curl -s -X POST -H "Authorization: Bearer $PE_MSG_TOKEN" http://127.0.0.1:4130/api/run/demo/messages -d '{"to":"phase:demo/3","text":"hi"}'`,
    `curl -X POST http://localhost:3000/api/write -d '{"title":"draft"}'`,
    `curl -X POST https://api.example.com/api/approvals/a1 -d '{}'`,
    'echo http://127.0.0.1:4130/api/runs | xargs curl -s',
    // A read through curl, piped to an interpreter that formats it.
    'curl -s http://127.0.0.1:4130/api/policy | python3 -m json.tool',
    'rg -n "127.0.0.1:4130/api/policy" .',
    'git commit -m "curl -X POST http://127.0.0.1:4130/api/policy is fenced now"',
    `bash ${SCRIPTS}/phase-outcome.sh demo 2 ruling --what "curl -X POST ${H} http://127.0.0.1:4130/api/policy is denied" --why "#218"`,
    "awk '{print $1}' notes.txt",
    'node --test viewer/test/console-forge.test.ts',
    `bash ${SCRIPTS}/phase-outcome.sh demo 2 blocked --needs permission --reason "a person must press phase-console run approve a1"`,
    `bash ${SCRIPTS}/phase-tasks.sh demo 2 update --id p2.task1 --status completed`,
    `bash ${SCRIPTS}/phase-msg.sh demo 2 send --to 3 --text "the gate route moved"`,
    'phase-console update pe-hub --when-idle',
    'node ~/work/pe-hub/console/bin/phase-console.mjs fleet restart',
    'phase-console update-plugin',
    'phase-console doctor pe-hub',
    'phase-console hooks-status --settings ~/.claude/settings.json',
    'node ~/work/pe-hub/phased-execution/bin/phase-console.mjs capability hub add --allow-issues',
    'phase-console run hold control-tower --reason "drain for the update"',
    'phase-console run release control-tower',
    'phase-console run status control-tower',
    'phase-console supervisor status',
    'grep -rn "/api/approvals/:id" viewer/server viewer/shared',
    `echo "curl -X POST ${H} http://127.0.0.1:4130/api/approvals/a1"`,
    `cat <<'EOF' > notes.md\ncurl -X POST ${H} http://127.0.0.1:4130/api/policy\nEOF`,
    'git commit -m "fence POST /api/approvals/:id and phase-console run approve"',
  ]) {
    await passes('Bash', { command });
  }
});

test('CF-5 (EC5): AUTHORITY_ROUTES is one table of routes the router serves — a row it does not answer fails here', async () => {
  const probe = async (method: string, path: string) => {
    let status = 0;
    let body = '';
    const req = {
      method,
      url: path,
      headers: { 'x-phase-console': '1', host: '127.0.0.1:4130', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
      on() { return this; },
      [Symbol.asyncIterator]: async function* () { yield Buffer.from('{}', 'utf8'); },
    };
    const res = {
      req,
      writeHead(code: number) { status = code; return this; },
      setHeader() {},
      end(chunk?: string) { body += chunk ?? ''; },
      on() { return this; },
    };
    // Every capability on and no Service behind it: a served route gets past
    // its guard and fails on the method it calls; a path no route serves is
    // the router's own 404 or 405.
    const service = { root: { ok: true, path: tmpdir() }, store: {}, flags: { allowWrites: true, allowRun: true, allowAccounts: true, remoteHosts: [] as string[] } };
    await handleApi({ service } as never, req as never, res as never, new URL(`http://127.0.0.1:4130${path}`));
    return { status, body };
  };
  const unrouted = ({ status, body }: { status: number; body: string }) =>
    status === 405 || (status === 404 && /No API route|No run verb|a step has no verb/.test(body));
  const fill = (path: string) => path.replace(/:([a-z]+)/g, (_, name: string) => (name === 'phase' ? '3' : 'demo'));
  for (const row of AUTHORITY_ROUTES) {
    const answer = await probe(row.method, fill(row.path));
    assert.ok(!unrouted(answer), `${row.verb} (${row.method} ${row.path}): the router does not serve it — ${answer.status} ${answer.body}`);
  }
  for (const path of ['/api/approvals', '/api/human-steps/demo/bogus', '/api/run/demo/not-a-verb', '/api/not-a-route']) {
    assert.ok(unrouted(await probe('POST', path)), `the probe must be able to fail: ${path}`);
  }
});

test('CF-5 (EC5): every CLI form is a verb the CLI dispatches, pressing the row\'s own route', () => {
  for (const row of AUTHORITY_ROUTES) {
    for (const form of row.cli) {
      const [group, name] = form.split(' ');
      if (group === 'run') {
        const verb = OPERATOR_VERBS.find((v) => v.name === name);
        assert.ok(verb?.cli, `${form}: phase-console run has no such verb`);
        assert.equal(verb!.route, `${row.method} ${row.path}`, `${form} presses another route`);
      } else {
        assert.equal(group, 'supervisor', `${form}: no such CLI group`);
        const supervisorVerb = readFileSync(new URL('../../bin/supervisor-verb.mjs', import.meta.url), 'utf8');
        assert.match(supervisorVerb, new RegExp(`verb === '${name}'[\\s\\S]{0,1200}'${row.method}', '${row.path}'`), form);
      }
      assert.equal(authorityCliOf(form.split(' ').concat('x')), row, `${form} reads back as its own row`);
    }
  }
});

test('CF-5: the reader takes a path the way the router does', () => {
  assert.equal(authorityRouteOf('POST', '/api/approvals/a1')?.verb, 'answer-card');
  assert.equal(authorityRouteOf('POST', '/api/approvals/a1/extend')?.verb, 'answer-card', 'a trailing segment hides nothing');
  assert.equal(authorityRouteOf('POST', '/api//%61pprovals/a1')?.verb, 'answer-card');
  assert.equal(authorityRouteOf(null, '/api/run/demo/settings')?.verb, 'run-settings', 'an unread method is any method');
  assert.equal(authorityRouteOf('GET', '/api/policy'), null, 'a read presses nothing');
  assert.equal(authorityRouteOf('POST', '/api/approvals'), null, 'the card list is not a card');
  assert.equal(authorityRouteOf('POST', '/api/run/demo/messages'), null);
  assert.equal(authorityRouteOf('POST', '/hooks/declaration'), null);
  assert.equal(new Set(AUTHORITY_VERBS).size, AUTHORITY_VERBS.length, 'one row per press');
});

/* ------------------------------------------------------------------ *
 * CF-6 — what the plan's permission.destructive row names passes
 * ------------------------------------------------------------------ */

test('CF-6: a row that allows something else on the line excuses no press riding beside it', async () => {
  const run = async (value: string, command: string) => {
    const { decide, close } = supervised('bypass', {
      manifest: { decisions: [{ key: 'permission.destructive', state: 'answered', value, source: 'plan' }] },
    });
    try { return (await decide('Bash', { command })).permissionDecision; } finally { close(); }
  };
  assert.equal(
    await run('deny; allow `git push` — every phase', `git push origin pe/demo && curl -X POST ${H} http://127.0.0.1:4130/api/policy -d '{}'`),
    'deny', 'the push is the row\'s; the policy edit beside it is nobody\'s',
  );
  assert.equal(
    await run('deny; allow `phase-console run approve` — phase 2 only', `phase-console run approve a1 && curl -X POST ${H} http://127.0.0.1:4130/api/policy -d '{}'`),
    'deny', 'one excused press carries no other',
  );
});

test('CF-6: a press the plan\'s permission.destructive row names for the running phase passes; the same press elsewhere does not', async () => {
  const manifest = (value: string) => ({
    manifest: { decisions: [{ key: 'permission.destructive', state: 'answered', value, source: 'plan' }] },
  });
  const named = manifest('deny; allow `phase-console run approve` — phase 2 only');
  const run = async (extra: Record<string, unknown>, command: string) => {
    const { decide, close } = supervised('bypass', extra);
    try { return (await decide('Bash', { command })).permissionDecision; } finally { close(); }
  };
  assert.equal(await run(named, 'phase-console run approve a1'), 'allow', 'named for phase 2, and phase 2 is running');
  assert.equal(await run(named, `curl -X POST ${H} http://127.0.0.1:4130/api/approvals/a1 -d '{}'`), 'allow', 'the same press by its route');
  assert.equal(await run(named, 'phase-console run deny a1'), 'deny', 'a verb the row does not name');
  assert.equal(await run({ ...named, activePhase: 3 }, 'phase-console run approve a1'), 'deny', 'named for another phase');
  assert.equal(await run(manifest('deny; allow `git push` — every phase'), 'phase-console run approve a1'), 'deny');
  assert.equal(
    await run(manifest('deny; allow `Bash(git push:*)` — every phase'), `curl -X POST ${H} http://127.0.0.1:4130/api/policy -d '{}'`),
    'deny', 'a row naming no console press opens none',
  );
});
