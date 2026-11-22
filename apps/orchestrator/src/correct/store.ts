// Correction records under data/corrections/<id>/ (git-ignored):
//   record.json     full private record
//   original.md     the tutorial as it was when the correction started
//   proposed.md     the validated proposal (if any)
//   backup-*.md     file contents saved before each write
//   package-<n>/    exact copy of what Claude was given (audit)

import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { dataPath, readJson, writeJson } from '../store.ts';

export const CORRECTION_ID_PATTERN = /^c[0-9]{8}-[0-9]{6}-[a-f0-9]{6}$/;

export type CorrectionState =
  | 'analyzing' // Claude is reviewing the finding
  | 'needs_exploration' // Claude (or the D4 gate) says Kane must explore first
  | 'exploring' // Kane exploration run in progress
  | 'route_confirmed' // exploration reached every documented outcome; Claude may be asked again
  | 'route_uncertain' // exploration did not confirm the route: no correction may be proposed
  | 'cannot_determine' // Claude could not determine a correction from the evidence
  | 'proposal_rejected' // Claude proposed edits that failed KaneVerity's checks
  | 'proposed' // a validated proposal awaits human review
  | 'rejected' // the human rejected the proposal
  | 'applied' // approved and written; a Kane retest needs its own confirmation
  | 'retesting' // approved, applied, Kane retest in progress
  | 'verified' // retest met every VERIFIED requirement
  | 'not_verified' // retest did not meet them: the issue stays open
  | 'restored' // the original document was restored
  | 'closed' // closed by the user after an error; nothing was written
  | 'error';

export interface Citation {
  label: string;
  kind: 'action' | 'assertion';
  runId: string;
  /** Evidence step ordinal for actions. */
  ordinal: number | null;
  /** Approved screenshot for that step, if any. */
  screenshot: string | null;
  /** The evidence text that contains the label. */
  evidence: string;
}

export interface ClaudeAttempt {
  at: string;
  ok: boolean;
  decision: 'proposal' | 'needs_exploration' | 'cannot_determine' | null;
  rationale: string;
  confidence: string | null;
  evidenceCited: string[];
  explorationQuestion: string | null;
  edits: Edit[];
  model: string | null;
  costUsd: number | null;
  durationMs: number | null;
  /** KaneVerity's validation of the answer. */
  validation: { ok: boolean; problems: string[] };
  error: string | null;
}

export interface Edit {
  line: number;
  action: 'replace' | 'delete' | 'insert_after';
  newText: string;
}

export interface VerificationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CorrectionRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  state: CorrectionState;
  stateReason: string;
  runId: string;
  tutorialId: string;
  tutorialTitle: string;
  tutorialUrl: string;
  appStart: string | null;
  /** Docs source reference, e.g. "tutorials/generate-an-api-key.md". */
  file: string;
  failedStep: number | null;
  originalSha256: string;
  attempts: ClaudeAttempt[];
  /** The exploration whose evidence is used for the next Claude review (the latest one). */
  explorationRunId: string | null;
  exploration: { confirmed: boolean; reason: string; mode?: string } | null;
  /** Every exploration started for this correction, oldest first (audit trail; runs are never deleted). */
  explorations?: { runId: string; mode: string; startedAt: string; confirmed: boolean | null }[];
  proposal: { edits: Edit[]; diff: string; proposedSha256: string; citations: Citation[] } | null;
  approvedAt: string | null;
  appliedAt: string | null;
  retestRunId: string | null;
  /** Every retest run started for this correction, oldest first (a retest may be tried again from not_verified). */
  retestRuns?: string[];
  verification: { verified: boolean; checks: VerificationCheck[] } | null;
  restoredAt: string | null;
  log: { at: string; event: string; detail: string }[];
}

export function newCorrectionId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const d = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const t = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `c${d}-${t}-${randomBytes(3).toString('hex')}`;
}

export function correctionPath(id: string, ...parts: string[]): string {
  if (!CORRECTION_ID_PATTERN.test(id)) throw new Error('Invalid correction id');
  return dataPath('corrections', id, ...parts);
}

export async function saveCorrection(rec: CorrectionRecord): Promise<void> {
  rec.updatedAt = new Date().toISOString();
  await writeJson(correctionPath(rec.id, 'record.json'), rec);
}

export async function loadCorrection(id: string): Promise<CorrectionRecord | null> {
  if (!CORRECTION_ID_PATTERN.test(id)) return null;
  return readJson<CorrectionRecord>(correctionPath(id, 'record.json'));
}

export async function listCorrections(): Promise<CorrectionRecord[]> {
  let names: string[] = [];
  try {
    names = await readdir(dataPath('corrections'));
  } catch {
    return [];
  }
  const out: CorrectionRecord[] = [];
  for (const n of names.filter((x) => CORRECTION_ID_PATTERN.test(x)).sort().reverse()) {
    const r = await loadCorrection(n);
    if (r) out.push(r);
  }
  return out;
}

export function logEvent(rec: CorrectionRecord, event: string, detail = ''): void {
  rec.log.push({ at: new Date().toISOString(), event, detail: detail.slice(0, 500) });
}
