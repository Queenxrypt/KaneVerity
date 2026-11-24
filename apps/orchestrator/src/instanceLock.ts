// One orchestrator per data folder.
//
// Everything KaneVerity serialises in memory (per-tutorial review locks, the "write in
// progress" refusal, the job queue, the Kane process lock) only protects one process.
// Two orchestrators on the same data folder could append to the same review history
// and start concurrent Kane writes. So each orchestrator takes an exclusive lock file
// in its data folder at startup and keeps checking that it still holds it:
//   - the lock file is created atomically (flag "wx") with this process id and a
//     random token;
//   - a second orchestrator refuses to start while the holder process is alive;
//   - a lock left by a process that no longer exists is taken over;
//   - ownership (the token) is re-checked right after taking the lock, every few
//     seconds, and before every review-history append and Kane approval write
//     (assertInstanceLock). An orchestrator that lost its lock stops writing and exits.
// Limits: a stale lock whose process id was reused by another program reads as held
// (the message says how to clear it), and the lock only covers orchestrators that use
// this code (older builds take no lock).

import { randomBytes } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface InstanceLockInfo {
  pid: number;
  port: number;
  startedAt: string;
  host: string;
  token: string;
}

export class InstanceLockError extends Error {}

export const LOCK_FILE = 'orchestrator.lock';

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(file: string): InstanceLockInfo | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && Number.isInteger(v.pid) && typeof v.token === 'string' ? (v as InstanceLockInfo) : null;
  } catch {
    return null;
  }
}

/** The lock this process holds (null in tests and tools that never take one). */
let held: { file: string; token: string } | null = null;

export interface HeldInstanceLock {
  file: string;
  info: InstanceLockInfo;
  /** True while the lock file still carries this process's token. */
  stillMine(): boolean;
  /** Remove the lock file, only if it is still ours (safe in an exit handler). */
  releaseSync(): void;
}

/** Take the data folder's lock or refuse with a clear message. */
export async function acquireInstanceLock(dataDir: string, port: number, opts: { settleMs?: number } = {}): Promise<HeldInstanceLock> {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, LOCK_FILE);
  const info: InstanceLockInfo = { pid: process.pid, port, startedAt: new Date().toISOString(), host: os.hostname(), token: randomBytes(16).toString('hex') };
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await writeFile(file, JSON.stringify(info, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const other = readLock(file);
      if (!other) {
        // Possibly being written by another orchestrator starting right now.
        if (attempt < 5) {
          await new Promise((r) => setTimeout(r, 100 * attempt));
          continue;
        }
        throw new InstanceLockError(`The orchestrator lock ${file} is unreadable. If no KaneVerity orchestrator is running, delete it and start again.`);
      }
      if (processAlive(other.pid)) {
        throw new InstanceLockError(`Another KaneVerity orchestrator (process ${other.pid}, port ${other.port}, started ${other.startedAt}) is already using this data folder. Stop it first. If it is not running, delete ${file}.`);
      }
      // Stale: its process is gone. Take it over.
      await rm(file, { force: true });
      continue;
    }
    // Two starters taking over the same stale lock: whoever was overwritten finds out here.
    await new Promise((r) => setTimeout(r, opts.settleMs ?? 150));
    const now = readLock(file);
    if (!now || now.token !== info.token) {
      throw new InstanceLockError(`Another KaneVerity orchestrator took this data folder's lock while this one was starting (${file}). Only one orchestrator may use a data folder.`);
    }
    held = { file, token: info.token };
    return {
      file,
      info,
      stillMine: () => readLock(file)?.token === info.token,
      releaseSync: () => {
        if (readLock(file)?.token === info.token) {
          try {
            unlinkSync(file);
          } catch {
            /* already gone */
          }
        }
        if (held?.token === info.token) held = null;
      },
    };
  }
  throw new InstanceLockError(`Could not take the orchestrator lock ${file}.`);
}

/**
 * Before writing shared history or starting a Kane write: refuse unless this process
 * still holds the data folder's lock. A process that never took a lock (tests,
 * one-off tools) is not checked.
 */
export function assertInstanceLock(): void {
  if (!held) return;
  if (readLock(held.file)?.token !== held.token) {
    throw new InstanceLockError('This orchestrator no longer holds the data folder lock (another orchestrator may be using it). Nothing was written.');
  }
}
