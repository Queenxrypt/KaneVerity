// Local JSON storage under data/ (git-ignored). Writes are atomic (tmp + rename).
//   data/project.json            connected docs + app URLs
//   data/discovery.json          last discovery result
//   data/credits.json            ledger of credits used by orchestrator runs
//   data/runs/<id>/public.json   UI-safe run record (allow-listed fields only)
//   data/runs/<id>/public/       screenshots approved for display
//   data/runs/<id>/private/      raw Kane output, stderr, evidence pack (never served)
//   data/runs/<id>/work/         Kane's working directory for the run (never served)

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * How a run's cost is known:
 *  - reported:  Kane CLI reported credits_consumed in run_end (actual cost)
 *  - estimated: Kane reported no cost but its agent did work; the amount is a
 *               KaneVerity estimate, never presented as an actual cost
 *  - none:      Kane stopped before any agent work (e.g. a setup error); 0
 */
export type CostBasis = 'reported' | 'estimated' | 'none';

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
  const s: CostSummary = { reportedCredits: 0, estimatedCredits: 0, runsReported: 0, runsEstimated: 0, runsWithoutAgentWork: 0 };
  for (const e of ledger) {
    const c = Number.isFinite(e.credits) ? e.credits : 0;
    const b = basisOf(e);
    if (b === 'reported') {
      s.reportedCredits += c;
      s.runsReported++;
    } else if (b === 'estimated') {
      s.estimatedCredits += c;
      s.runsEstimated++;
    } else s.runsWithoutAgentWork++;
  }
  s.reportedCredits = Math.round(s.reportedCredits * 100) / 100;
  s.estimatedCredits = Math.round(s.estimatedCredits * 100) / 100;
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
