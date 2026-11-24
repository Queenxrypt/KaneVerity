// One orchestrator per data folder (pre-commit review of B4). Unit tests for the lock,
// then real orchestrator processes on a temporary data folder (fake Kane CLI; no Kane
// command runs at startup).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireInstanceLock, assertInstanceLock, InstanceLockError, LOCK_FILE } from '../src/instanceLock.ts';
import { TESTS_DIR } from './helpers.ts';

const sleeper = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const exited = (c: ChildProcess) => new Promise<number | null>((r) => (c.exitCode !== null ? r(c.exitCode) : c.once('exit', (code) => r(code))));

test('the lock: taken atomically, refused while its holder lives, taken over when stale, released only by its owner', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kv-lock-'));
  const file = path.join(dir, LOCK_FILE);

  // Held by another live process: refused, and the file is left as it is.
  const other = sleeper();
  const foreign = JSON.stringify({ pid: other.pid, port: 4999, startedAt: '2026-11-24T00:00:00Z', host: 'h', token: 'f'.repeat(32) });
  await writeFile(file, foreign);
  await assert.rejects(acquireInstanceLock(dir, 4100, { settleMs: 10 }), (e: Error) => e instanceof InstanceLockError && /already using this data folder/.test(e.message) && e.message.includes(String(other.pid)));
  assert.equal(await readFile(file, 'utf8'), foreign, 'a live holder keeps its lock');

  // The holder is gone: the stale lock is taken over.
  other.kill();
  await exited(other);
  const lock = await acquireInstanceLock(dir, 4100, { settleMs: 10 });
  const info = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(info.pid, process.pid);
  assert.equal(info.port, 4100);
  assert.match(info.token, /^[a-f0-9]{32}$/);
  assert.equal(lock.stillMine(), true);
  assertInstanceLock(); // held: no error

  // A second taker in this process sees a live holder (this process) and is refused.
  await assert.rejects(acquireInstanceLock(dir, 4101, { settleMs: 10 }), /already using this data folder/);

  // Lost lock (replaced by someone else): every write path refuses.
  await writeFile(file, JSON.stringify({ ...info, token: 'e'.repeat(32) }));
  assert.equal(lock.stillMine(), false);
  assert.throws(() => assertInstanceLock(), /no longer holds the data folder lock/);
  lock.releaseSync();
  assert.ok(existsSync(file), "release never removes someone else's lock");

  // Unreadable lock: refused with instructions, never overwritten.
  await writeFile(file, 'not json');
  await assert.rejects(acquireInstanceLock(dir, 4100, { settleMs: 10 }), /unreadable/);
  assert.equal(await readFile(file, 'utf8'), 'not json');

  // Own lock released cleanly.
  await rm(file);
  const again = await acquireInstanceLock(dir, 4100, { settleMs: 10 });
  again.releaseSync();
  assert.equal(existsSync(file), false);
  await rm(dir, { recursive: true, force: true });
});

/** Start a real orchestrator process on a data folder; resolves once it listens or exits. */
function startOrchestrator(dataDir: string, port: number) {
  const child = spawn(process.execPath, ['server.ts'], {
    cwd: path.join(TESTS_DIR, '..'),
    env: {
      ...process.env,
      KANEVERITY_DATA_DIR: dataDir,
      KANEVERITY_PORT: String(port),
      KANEVERITY_ASSURANCE_MODE: 'off',
      KANE_CLI_ENTRY: path.join(TESTS_DIR, 'fake-kane-assurance.cjs'),
      KANEVERITY_CLAUDE_EXE: path.join(TESTS_DIR, 'fake-claude.cjs'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', (c) => (out += c));
  child.stderr!.on('data', (c) => (out += c));
  const ready = new Promise<'listening' | 'exited'>((resolve) => {
    const t = setInterval(() => {
      if (/orchestrator on http/.test(out)) {
        clearInterval(t);
        resolve('listening');
      }
    }, 50);
    child.once('exit', () => {
      clearInterval(t);
      resolve('exited');
    });
  });
  return { child, ready, output: () => out };
}

test('two real orchestrators on one data folder: the second refuses to start; a crashed holder is taken over; a lost lock stops the holder', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'kv-two-orch-'));
  const file = path.join(dataDir, LOCK_FILE);
  const a = startOrchestrator(dataDir, 4211);
  try {
    assert.equal(await a.ready, 'listening', a.output());
    assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, a.child.pid);

    // Same data folder, different port: refused before it serves anything.
    const b = startOrchestrator(dataDir, 4212);
    assert.equal(await b.ready, 'exited', b.output());
    assert.equal(b.child.exitCode, 1);
    assert.match(b.output(), /Another KaneVerity orchestrator \(process \d+, port 4211/);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, a.child.pid, 'the refused one did not touch the lock');

    // A hard crash leaves a stale lock; the next orchestrator takes it over.
    a.child.kill('SIGKILL');
    await exited(a.child);
    assert.ok(existsSync(file), 'a crash leaves the lock behind');
    const c = startOrchestrator(dataDir, 4213);
    try {
      assert.equal(await c.ready, 'listening', c.output());
      assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, c.child.pid);

      // Its lock removed under it: it stops (within the 5-second check) instead of writing on.
      await rm(file);
      const code = await Promise.race([exited(c.child), new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 12_000))]);
      assert.equal(code, 1, c.output());
      assert.match(c.output(), /data folder lock is no longer held/);
    } finally {
      if (c.child.exitCode === null) c.child.kill('SIGKILL');
    }
  } finally {
    if (a.child.exitCode === null) a.child.kill('SIGKILL');
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('after an orchestrator is stopped, a new one starts on the same data folder', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'kv-clean-stop-'));
  const a = startOrchestrator(dataDir, 4214);
  try {
    assert.equal(await a.ready, 'listening', a.output());
    assert.ok(existsSync(path.join(dataDir, LOCK_FILE)));
    // A stop from outside: on POSIX SIGTERM runs the exit handler (lock removed); on
    // Windows the process is terminated (lock left stale). Either way the next start works.
    a.child.kill('SIGTERM');
    await exited(a.child);
    const b = startOrchestrator(dataDir, 4215);
    assert.equal(await b.ready, 'listening', b.output());
    b.child.kill('SIGKILL');
    await exited(b.child);
  } finally {
    if (a.child.exitCode === null) a.child.kill('SIGKILL');
    await rm(dataDir, { recursive: true, force: true });
  }
});
