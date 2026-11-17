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

export interface CreditEntry {
  runId: string;
  credits: number;
  at: string;
}

export async function creditLedger(): Promise<CreditEntry[]> {
  return (await readJson<CreditEntry[]>(dataPath('credits.json'))) ?? [];
}

export async function addCredits(entry: CreditEntry): Promise<void> {
  const ledger = await creditLedger();
  ledger.push(entry);
  await writeJson(dataPath('credits.json'), ledger);
}

export async function creditsSpent(): Promise<number> {
  return (await creditLedger()).reduce((sum, e) => sum + (Number.isFinite(e.credits) ? e.credits : 0), 0);
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
