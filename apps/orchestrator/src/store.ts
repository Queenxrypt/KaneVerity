// Local JSON storage under data/ (git-ignored). Writes are atomic (tmp + rename).
//   data/project.json            connected docs + app URLs
//   data/discovery.json          last discovery result
//   data/credits.json            ledger of credits used by orchestrator runs
//   data/runs/<id>/public.json   UI-safe run record (allow-listed fields only)
//   data/runs/<id>/public/       screenshots approved for display
//   data/runs/<id>/private/      raw Kane output, stderr, evidence pack (never served)
//   data/runs/<id>/work/         Kane's working directory for the run (never served)

import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.ts';

export const RUN_ID_PATTERN = /^r[0-9]{8}-[0-9]{6}-[a-f0-9]{6}$/;

export function dataPath(...parts: string[]): string {
  return path.join(config.dataDir, ...parts);
}

export function runDir(runId: string, ...parts: string[]): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error('Invalid run id');
  return dataPath('runs', runId, ...parts);
}

// Writes to one file are queued so they land in call order, and each uses its own
// temporary file. On Windows, replacing a file by rename fails with
// EPERM/EBUSY/EACCES while another request is reading it (the UI polls records);
// measured here, that can last most of a second. Before this fix such a failure
// silently lost the write and could leave a correction stuck in "analyzing".
// Now the rename is retried (~1.7s), and if it still can't replace the file the
// data is copied over it in place, so a write is never lost.
const writeQueues = new Map<string, Promise<void>>();
let tmpSeq = 0;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 15;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function writeAtomic(file: string, data: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  await writeFile(tmp, data, 'utf8');
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(tmp, file);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (!RENAME_RETRY_CODES.has(code)) throw err;
        if (attempt >= RENAME_ATTEMPTS) {
          // Last resort: overwrite in place (not atomic; readJson re-reads a partial file).
          await copyFile(tmp, file);
          return;
        }
        await sleep(Math.min(25 * attempt, 150));
      }
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  // Serialize now: callers may keep changing the object after this call.
  const data = JSON.stringify(value, null, 2) + '\n';
  const next = (writeQueues.get(file) ?? Promise.resolve()).catch(() => undefined).then(() => writeAtomic(file, data));
  writeQueues.set(file, next);
  try {
    await next;
  } finally {
    if (writeQueues.get(file) === next) writeQueues.delete(file);
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch (err) {
      // A file caught mid-overwrite (see writeAtomic), or briefly locked by that
      // in-place copy on Windows (EBUSY/EPERM/EACCES), is re-read briefly. A missing
      // file (ENOENT) or one that stays invalid still reads as null.
      const code = (err as NodeJS.ErrnoException).code ?? '';
      const transient = err instanceof SyntaxError || RENAME_RETRY_CODES.has(code);
      if (transient && attempt < 10) {
        await sleep(20 * attempt);
        continue;
      }
      return null;
    }
  }
}

/**
 * How a run's cost is known:
 *  - reported:  Kane CLI reported credits_consumed in run_end (actual cost)
 *  - estimated: Kane reported no cost but its agent did work; the amount is a
 *               KaneVerity estimate, never presented as an actual cost
 *  - none:      Kane stopped before any agent work (e.g. a setup error); 0
 *  - measured:  Kane reported no cost, but the account balance was read before and
 *               after (one Kane process at a time), so the difference is the cost
 *  - unknown:   agent work may have happened, but neither a reported cost nor a
 *               balance difference is available; never presented as free
 */
export type CostBasis = 'reported' | 'estimated' | 'none' | 'measured' | 'unknown';

export interface CreditEntry {
  runId: string;
  credits: number;
  /** Older entries (before basis was recorded) have no basis and are treated as reported. */
  basis?: CostBasis;
  kind?: string;
  at: string;
  note?: string;
}

export interface CostSummary {
  /** Sum of credits Kane actually reported. */
  reportedCredits: number;
  /** Sum of KaneVerity estimates for runs where Kane reported no cost. */
  estimatedCredits: number;
  runsReported: number;
  runsEstimated: number;
  runsWithoutAgentWork: number;
  /** Sum of costs measured from the balance before and after a job. */
  measuredCredits: number;
  runsMeasured: number;
  /** Jobs whose cost could not be determined (shown, never counted as 0). */
  runsUnknownCost: number;
}

export function basisOf(e: CreditEntry): CostBasis {
  if (e.basis) return e.basis;
  // Legacy entry: 0 with a correction note means Kane did no agent work.
  return e.credits === 0 ? 'none' : 'reported';
}

export async function creditLedger(): Promise<CreditEntry[]> {
  return (await readJson<CreditEntry[]>(dataPath('credits.json'))) ?? [];
}

export async function addCredits(entry: CreditEntry): Promise<void> {
  const ledger = await creditLedger();
  ledger.push(entry);
  await writeJson(dataPath('credits.json'), ledger);
}

export function summarizeCosts(ledger: CreditEntry[]): CostSummary {
  const s: CostSummary = { reportedCredits: 0, estimatedCredits: 0, runsReported: 0, runsEstimated: 0, runsWithoutAgentWork: 0, measuredCredits: 0, runsMeasured: 0, runsUnknownCost: 0 };
  for (const e of ledger) {
    const c = Number.isFinite(e.credits) ? e.credits : 0;
    const b = basisOf(e);
    if (b === 'reported') {
      s.reportedCredits += c;
      s.runsReported++;
    } else if (b === 'estimated') {
      s.estimatedCredits += c;
      s.runsEstimated++;
    } else if (b === 'measured') {
      s.measuredCredits += c;
      s.runsMeasured++;
    } else if (b === 'unknown') {
      s.runsUnknownCost++;
    } else s.runsWithoutAgentWork++;
  }
  s.reportedCredits = Math.round(s.reportedCredits * 100) / 100;
  s.estimatedCredits = Math.round(s.estimatedCredits * 100) / 100;
  s.measuredCredits = Math.round(s.measuredCredits * 100) / 100;
  return s;
}

export function newRunId(now = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
  return `r${date}-${time}-${rand}`;
}
