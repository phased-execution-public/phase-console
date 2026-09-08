/**
 * The pty broker — the process that makes a console restart stop killing
 * terminals.
 *
 * The defect it removes is not one that throws: `service.close()` reached
 * every pty and ended it, so pressing **Restart** ended every shell and every
 * interactive `claude` on the machine. Nothing failed. The work just stopped.
 *
 * So the proof has to be behavioural, and it has to involve real processes:
 *
 *  1. **A real broker, a real pty, and a console that goes away.** Spawn the
 *     broker detached, start a session through it, drop the client the way a
 *     dying console does, and assert the *process* is still there and its
 *     scrollback is still readable from a second client. Against the code as
 *     it was there is no broker to ask, which is the sharpest form the witness
 *     can take.
 *  2. **Two `Terminals` over one broker** — the console's own restart, at the
 *     level the console actually experiences it: mint, close, and adopt from a
 *     fresh registry with the same session id and the same scrollback.
 *  3. **The wall**, because a socket that anyone can drive is a shell anyone
 *     can have.
 *
 * Where `node-pty` did not build, the assertions become the graceful refusal
 * instead — deliberately not a skip, exactly as `terminal.test.ts` does it:
 * "the terminal degrades and the console is unaffected" is a requirement, so
 * it is asserted rather than stepped over.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrokerClient } from '../server/pty/client.ts';
import { brokerPaths, frame } from '../server/pty/protocol.ts';
import { Terminals } from '../server/terminal.ts';
import { sweepBrokers } from './broker-sweep.ts';

const BROKER = fileURLToPath(new URL('../server/pty/broker.ts', import.meta.url));

/**
 * A state directory short enough for `sun_path`.
 *
 * `mkdtemp` under the system temp dir is already what `brokerPaths` falls back
 * to, so this keeps the tests on the primary path rather than exercising only
 * the fallback.
 */
function sandbox(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pcb-'));
  // Retries, because cleanup races the broker's OWN exit-time tidying: a
  // shutdown message is fire-and-forget, so the broker may still be unlinking
  // its socket while rmSync walks the directory — on Linux that surfaces as
  // ENOTEMPTY (CI, ubuntu). `force` alone does not retry that class.
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

/** Wait for a predicate, polling — the honest shape for "a process did a thing". */
async function until(what: () => boolean | Promise<boolean>, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await what()) return true;
    await new Promise((resolve) => { const t = setTimeout(resolve, 25); t.unref?.(); });
  }
  return false;
}

/** Is this pid there at all? `kill(pid, 0)` is a question, not a signal. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/* ================================================================== *
 * 1 — the broker outlives its client
 * ================================================================== */

test('a session survives the console that started it, with its scrollback', async (t) => {
  const box = sandbox();
  t.after(() => box.cleanup());

  const first = new BrokerClient(box.dir, BROKER);
  const hello = await first.connect({ start: true });
  assert.ok(hello, 'the broker did not start — nothing here can be tested against a broker that is not there');

  if (hello.pty !== 'yes') {
    // The graceful-degradation half of exit criterion 4, asserted rather than
    // skipped: no node-pty must mean a refusal with a reason, never a crash.
    await assert.rejects(
      () => first.spawn({ file: '/bin/sh', args: ['-c', 'true'], cwd: box.dir, cols: 80, rows: 24, env: {} }),
      /node-pty|spawn/i,
      'with node-pty absent a spawn must be refused in words, not by throwing something else',
    );
    first.shutdownBroker();
    first.detach();
    return;
  }

  // A session that prints something and then stays: the print is what the
  // scrollback must still hold, the staying is what must survive.
  const handle = await first.spawn({
    file: '/bin/sh',
    args: ['-c', 'echo phase-seven-marker; sleep 30'],
    cwd: box.dir,
    cols: 80,
    rows: 24,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color' },
  });
  const seen: string[] = [];
  handle.onData((chunk) => seen.push(chunk));
  assert.ok(handle.pid > 1, 'a broker session must report the real pid — the console signals it');
  assert.ok(await until(() => seen.join('').includes('phase-seven-marker'), 15_000), 'the pty never produced its output');

  const pid = handle.pid;

  // The console dies. `detach()` is exactly what `Terminals.close()` does now,
  // and destroying the socket is what a killed console does.
  first.detach();
  await new Promise((resolve) => { const timer = setTimeout(resolve, 200); timer.unref?.(); });

  assert.ok(alive(pid), 'THE DEFECT: the session died with the console that started it');

  // A new console, on the same machine, for the same instance.
  const second = new BrokerClient(box.dir, BROKER);
  const back = await second.connect({ start: false });
  assert.ok(back, 'a broker holding a live session must still be there for the next console');
  assert.equal(back.sessions.length, 1, 'the broker must hand back what it is holding');
  assert.equal(back.sessions[0].pid, pid, 'and it must be the same process, not a new one');

  const replayed: string[] = [];
  const adopted = second.adopt(back.sessions[0]);
  adopted.onData((chunk) => replayed.push(chunk));
  assert.ok(
    await until(() => replayed.join('').includes('phase-seven-marker')),
    'the scrollback was not replayed — a reattached terminal would come back blank',
  );

  // The session is not merely a record: it still takes input.
  adopted.write('\n');

  adopted.kill();
  assert.ok(await until(() => !alive(pid)), 'a kill through the broker must actually end the process');
  second.shutdownBroker();
  second.detach();
});

/* ================================================================== *
 * 2 — the console's own restart
 * ================================================================== */

test('a restarted Terminals adopts the sessions the last one left running', async (t) => {
  const box = sandbox();
  t.after(() => box.cleanup());

  const options = {
    allowed: true,
    stateDir: box.dir,
    broker: new BrokerClient(box.dir, BROKER),
  };
  const before = new Terminals(options);
  const minted = await before.mint(undefined, { cols: 80, rows: 24 });

  if (!minted.ok) {
    // No node-pty: the console must still be a console — the refusal is
    // reported, availability says so, and nothing throws.
    assert.equal(minted.status, 503, `an unavailable pty must refuse with 503, not ${minted.status}`);
    assert.equal(before.availability(), 'no');
    before.close();
    return;
  }

  const pid = minted.session.pid;
  const id = minted.sessionId;
  assert.ok(await until(() => alive(pid)));
  assert.equal(before.survivesRestart(), true, 'a broker-backed registry must report that its sessions survive');

  // The console goes down. This is the line the whole phase turns on.
  before.close();
  await new Promise((resolve) => { const timer = setTimeout(resolve, 200); timer.unref?.(); });
  assert.ok(alive(pid), 'THE DEFECT: closing the console killed the terminal it was showing');

  // The console comes back.
  const after = new Terminals({ allowed: true, stateDir: box.dir, broker: new BrokerClient(box.dir, BROKER) });
  const adopted = await after.resume();
  assert.equal(adopted, 1, 'the new console must adopt the session the old one left');

  const state = after.state();
  assert.equal(state.live, 1);
  assert.equal(state.sessions[0].id, id, 'the session id must survive, so a URL that named a terminal still does');
  assert.equal(state.sessions[0].pid, pid);

  // And it is drivable, not just listed: a mint against the adopted id is a
  // reattach, which is what the browser does when it opens the page again.
  const reticket = await after.mint(id);
  assert.equal(reticket.ok, true, 'an adopted session must be re-mintable — otherwise the page cannot reattach');

  assert.equal(after.kill(id), true);
  assert.ok(await until(() => !alive(pid)), 'kill must still end the process after an adoption');
  after.close();
  new BrokerClient(box.dir, BROKER).shutdownBroker();
});

/**
 * 🔴 What Phase 8 hangs on, and what the adoption test above does NOT cover:
 * it mints a bare shell, so nothing there proves a session's `meta` or its
 * `cwd` come back.
 *
 * Both are load-bearing for a resumed session. `#/sessions/<conversation id>`
 * is the address of a foreign session, and the page resolves it by looking for
 * a pty whose `meta.claudeSessionId` is that conversation — so if the broker
 * dropped the meta on the way through, a restart would leave the terminal
 * running (Phase 7's promise, kept) and its ADDRESS pointing at an offer to
 * start a second one. And the cwd is where the session WORKS: one that came
 * back on the console's root after a restart would quietly be looking at a
 * different repository from the one it was in before.
 *
 * `file` is a shell rather than `claude` on purpose — what is under test is the
 * broker's opaque blob and `firstDir`, not the CLI.
 */
test('an adopted session brings back its meta and its directory, not just its pid', async (t) => {
  const box = sandbox();
  t.after(() => box.cleanup());

  const conversation = '11111111-2222-4333-8444-555555555555';
  const home = mkdtempSync(join(tmpdir(), 'pcb-cwd-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const options = {
    allowed: true,
    agentAllowed: true,
    stateDir: box.dir,
    broker: new BrokerClient(box.dir, BROKER),
  };
  const before = new Terminals(options);
  const minted = await before.mint(undefined, { cols: 80, rows: 24 }, {
    kind: 'claude' as const,
    file: process.env.SHELL || '/bin/sh',
    args: [],
    label: 'Resumed: demo · P3',
    meta: { claudeSessionId: conversation },
    cwd: home,
  });

  if (!minted.ok) {
    assert.equal(minted.status, 503, `an unavailable pty must refuse with 503, not ${minted.status}`);
    before.close();
    return;
  }

  const pid = minted.session.pid;
  const id = minted.sessionId;
  assert.equal(minted.session.meta?.claudeSessionId, conversation, 'the mint itself must carry it');
  assert.ok(await until(() => alive(pid)));

  before.close();
  await new Promise((resolve) => { const timer = setTimeout(resolve, 200); timer.unref?.(); });

  const after = new Terminals({
    allowed: true, agentAllowed: true, stateDir: box.dir, broker: new BrokerClient(box.dir, BROKER),
  });
  assert.equal(await after.resume(), 1);

  const session = after.state().sessions[0];
  assert.equal(session.id, id);
  assert.equal(session.kind, 'claude', 'a resumed agent session must not come back as a shell');
  assert.equal(session.meta?.claudeSessionId, conversation,
    'THE ADDRESS: #/sessions/<conversation> resolves through this, and only through this');
  assert.equal(session.cwd, home, 'and it is still in the directory its conversation lives in');
  assert.equal(session.label, 'Resumed: demo · P3');

  after.kill(id);
  assert.ok(await until(() => !alive(pid)));
  after.close();
  new BrokerClient(box.dir, BROKER).shutdownBroker();
});

/* ================================================================== *
 * 3 — a kill still reaches the whole group
 * ================================================================== */

test('killing a session ends its process GROUP, not just the leader', async (t) => {
  const box = sandbox();
  t.after(() => box.cleanup());

  const client = new BrokerClient(box.dir, BROKER);
  const hello = await client.connect({ start: true });
  assert.ok(hello);
  if (hello.pty !== 'yes') {
    client.shutdownBroker();
    client.detach();
    return;
  }

  // A leader with a child that is NOT in the foreground process group — the
  // shape a `claude` session really has (its bash, its MCP servers, its
  // subagents). Signalling the bare pid would leave this one behind, which is
  // the whole reason `signals.ts` exists.
  // `read go` first: the script emits NOTHING until this side releases it, so
  // its output can never beat the onData subscription below — on a loaded
  // runner the immediate-echo form lost the CHILD= line for good (CI,
  // ubuntu). Still `-c` (non-interactive), because an interactive bash-as-sh
  // history-expands the `!` in `$!` and prints `event not found` instead.
  const handle = await client.spawn({
    file: '/bin/sh',
    args: ['-c', 'read go; sleep 60 & echo CHILD=$!; sleep 60'],
    cwd: box.dir,
    cols: 80,
    rows: 24,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  let said = '';
  handle.onData((chunk) => { said += chunk; });
  handle.write('\n');
  // 15s: forking a shell on a loaded CI runner is the slow half of this test —
  // the kill it exists to prove is signal-fast once the child is up.
  assert.ok(await until(() => /CHILD=\d+/.test(said), 15_000), 'the session never reported its background child');
  const child = Number(/CHILD=(\d+)/.exec(said)?.[1]);
  assert.ok(child > 1 && alive(child), 'the background child must actually be running');

  handle.kill();
  assert.ok(await until(() => !alive(handle.pid)), 'the leader survived the kill');
  assert.ok(await until(() => !alive(child)), 'the background child outlived the kill — the group was not reached');

  client.shutdownBroker();
  client.detach();
});

/* ================================================================== *
 * 4 — the connection outlives its own deadlines
 * ================================================================== */

test('a connected socket still works long after the dial and handshake deadlines', async (t) => {
  const box = sandbox();
  t.after(() => box.cleanup());

  const client = new BrokerClient(box.dir, BROKER);
  const hello = await client.connect({ start: true });
  assert.ok(hello);

  // Past `dial`'s 2s deadline AND `greet`'s 5s one. Both used to stay armed
  // after a successful connection and then call `socket.destroy()` on the
  // socket the console was using for every terminal it had open: the console
  // worked for two seconds and went deaf, which reads exactly like a broken
  // pty and is not one. It cost this phase a full suite run to find, because
  // the only visible symptom was one real-shell test failing on the SECOND
  // thing it typed.
  await new Promise((resolve) => { setTimeout(resolve, 5_600); });

  if (hello.pty !== 'yes') {
    // Even with no pty the wire must still be there to say so.
    await assert.rejects(() => client.spawn({
      file: '/bin/sh', args: ['-c', 'true'], cwd: box.dir, cols: 80, rows: 24, env: {},
    }), /node-pty|spawn/i);
    client.shutdownBroker();
    client.detach();
    return;
  }

  const handle = await client.spawn({
    file: '/bin/sh',
    args: ['-c', 'cat'],
    cwd: box.dir,
    cols: 80,
    rows: 24,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  let said = '';
  handle.onData((chunk) => { said += chunk; });
  handle.write('late-marker\n');
  assert.ok(
    await until(() => said.includes('late-marker')),
    'the broker socket went deaf after its own deadlines fired',
  );

  handle.kill();
  client.shutdownBroker();
  client.detach();
});

/* ================================================================== *
 * 5 — the wall
 * ================================================================== */

test('the broker refuses a connection that cannot present the credential', async (t) => {
  const box = sandbox();
  t.after(() => box.cleanup());

  const paths = brokerPaths(box.dir);
  // Mint the credential the way the client does, then start a broker by hand
  // so the test owns both ends.
  writeFileSync(paths.token, `${'a'.repeat(64)}\n`, { mode: 0o600 });
  const child = spawn(process.execPath, [BROKER, '--socket', paths.socket, '--token', paths.token], {
    detached: true, stdio: 'ignore',
  });
  child.unref();
  t.after(() => { try { process.kill(child.pid as number, 'SIGKILL'); } catch { /* already gone */ } });

  assert.ok(
    await until(() => { try { return statSync(paths.socket).isSocket(); } catch { return false; } }),
    'the broker never bound its socket',
  );

  // The mode is the real wall; the credential is the second one.
  assert.equal(statSync(paths.socket).mode & 0o777, 0o600, 'the broker socket must be owner-only');
  assert.equal(statSync(paths.token).mode & 0o777, 0o600, 'the credential must be owner-only');

  const closed = await new Promise<boolean>((resolve) => {
    const socket = createConnection(paths.socket, () => {
      socket.setEncoding('utf8');
      let said = '';
      socket.on('data', (chunk: string) => { said += chunk; });
      socket.on('close', () => resolve(!said));
      socket.write(frame({ t: 'hello', cred: 'b'.repeat(64) }));
      // Naming a session without a handshake must not be answered either.
      socket.write(frame({ t: 'attach', id: 'whatever' }));
      const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 3_000);
      timer.unref?.();
    });
    socket.on('error', () => resolve(true));
  });
  assert.ok(closed, 'a bad credential must be hung up on, having learnt nothing');

  // The right one still works, so the refusal above was the credential and not
  // a broker that refuses everybody.
  const good = new BrokerClient(box.dir, BROKER);
  const hello = await good.connect({ start: false });
  assert.ok(hello, 'the instance itself must still be admitted');
  good.shutdownBroker();
  good.detach();
});

/* ================================================================== *
 * 6 — the seam, and the two worlds it decides
 * ================================================================== */

test('an injected spawn keeps the old ownership, and close still ends those ptys', async () => {
  let killed = 0;
  const terminals = new Terminals({
    allowed: true,
    spawn: () => ({
      pid: 4242,
      onData() {},
      onExit() {},
      write() {},
      resize() {},
      kill() { killed++; },
    }),
  });
  const minted = await terminals.mint();
  assert.equal(minted.ok, true);
  assert.equal(
    terminals.survivesRestart(), false,
    'an in-process pty is this process\'s child and does NOT survive it — the dialog must not claim otherwise',
  );
  terminals.close();
  assert.equal(killed, 1, 'an injected pty is ours, and close() must still end it');
});

test('adopting never starts a broker', async (t) => {
  const box = sandbox();
  t.after(() => box.cleanup());

  const terminals = new Terminals({ allowed: true, stateDir: box.dir, broker: new BrokerClient(box.dir, BROKER) });
  assert.equal(await terminals.resume(), 0, 'there is nothing to adopt, and looking must not create one');
  assert.throws(
    () => statSync(brokerPaths(box.dir).socket),
    'resume() spawned a broker — every Service ever constructed calls it',
  );
  terminals.close();
});

/* ================================================================== *
 * 7 — a disposable instance takes its broker with it
 * ================================================================== */

test('a sandbox sweeps the broker it started, and the session goes with it', async (t) => {
  const box = sandbox();
  t.after(() => box.cleanup());

  const client = new BrokerClient(box.dir, BROKER);
  const hello = await client.connect({ start: true });
  assert.ok(hello);

  const paths = brokerPaths(box.dir);
  const brokerPid = Number(readFileSync(paths.pid, 'utf8').trim());
  assert.ok(brokerPid > 1 && alive(brokerPid), 'the broker must write down which process it is');

  let sessionPid = 0;
  if (hello.pty === 'yes') {
    const handle = await client.spawn({
      file: '/bin/sh', args: ['-c', 'sleep 60'], cwd: box.dir, cols: 80, rows: 24,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    sessionPid = handle.pid;
    assert.ok(alive(sessionPid));
  }

  // A console under test is KILLED rather than shut down, and a broker HOLDING
  // a session never retires on idle — by design, and right in production.
  // Without this sweep every suite run left a real login shell alive forever;
  // six were found after two runs, the oldest 22 minutes old.
  client.detach();
  assert.equal(sweepBrokers(box.dir), 1, 'the sweep must find exactly the broker this sandbox started');

  assert.ok(await until(() => !alive(brokerPid)), 'the broker outlived the sandbox that owned it');
  if (sessionPid) {
    assert.ok(await until(() => !alive(sessionPid)), 'the session was orphaned rather than ended with its broker');
  }
});

/* ================================================================== *
 * 8 — one broker per instance
 * ================================================================== */

test('a second broker on a live socket stands down instead of taking it over', async (t) => {
  const box = sandbox();
  t.after(() => box.cleanup());

  const client = new BrokerClient(box.dir, BROKER);
  assert.ok(await client.connect({ start: true }), 'the first broker must start');
  const paths = brokerPaths(box.dir);
  const credential = readFileSync(paths.token, 'utf8').trim();
  assert.ok(credential.length >= 32, 'the minted credential must be a real secret');

  const second = spawn(process.execPath, [BROKER, '--socket', paths.socket, '--token', paths.token], { stdio: 'ignore' });
  const code = await new Promise<number>((resolve) => { second.on('exit', (value) => resolve(value ?? -1)); });
  assert.equal(code, 0, 'a broker that loses the race must stand down cleanly, not error');

  // And the incumbent is untouched — the loser must never have unlinked a live
  // socket, which would leave every session it holds unreachable.
  const still = new BrokerClient(box.dir, BROKER);
  assert.ok(await still.connect({ start: false }), 'the incumbent must still be answering');
  still.shutdownBroker();
  still.detach();
  client.detach();
});
