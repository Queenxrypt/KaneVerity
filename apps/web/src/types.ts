// UI-side view of the orchestrator's public (allow-listed, scrubbed) records.
// Core types are imported type-only from the orchestrator, so they can't drift.
import type { Classification, Discovery, ExtractedItem, Project, RunState, SourceRef, Tutorial, VerificationStatus } from '../../orchestrator/src/types.ts';

export type { Classification, Discovery, ExtractedItem, Project, RunState, SourceRef, Tutorial, VerificationStatus };
import type { Citation, CorrectionState, Edit, VerificationCheck } from '../../orchestrator/src/correct/store.ts';
export type { Citation, CorrectionState, Edit, VerificationCheck };

export interface PublicCorrection {
  id: string;
  createdAt: string;
  updatedAt: string;
  state: CorrectionState;
  stateReason: string;
  runId: string;
  tutorialId: string;
  tutorialTitle: string;
  file: string;
  failedStep: number | null;
  attempts: { at: string; decision: string | null; rationale: string; confidence: string | null; evidenceCited: string[]; explorationQuestion: string | null; model: string | null; costUsd: number | null; validation: { ok: boolean; problems: string[] }; error: string | null }[];
  explorationRunId: string | null;
  exploration: { confirmed: boolean; reason: string; mode?: string } | null;
  explorations: { runId: string; mode: string; startedAt: string; confirmed: boolean | null }[];
  proposal: { edits: Edit[]; diff: string; proposedSha256: string; citations: Citation[] } | null;
  approvedAt: string | null;
  appliedAt: string | null;
  retestRunId: string | null;
  retestRuns?: string[];
  verification: { verified: boolean; checks: VerificationCheck[] } | null;
  restoredAt: string | null;
  log: { at: string; event: string; detail: string }[];
}

/** Is a discovered tutorial still what the live docs page shows? */
export interface TutorialFreshness {
  id: string;
  status: 'current' | 'stale' | 'unavailable';
  discoveredSha256: string | null;
  liveSha256: string | null;
  reason: string | null;
}

export interface FreshnessReport {
  checkedAt: string;
  discoveredAt: string | null;
  tutorials: TutorialFreshness[];
}

export interface Health {
  project: Project | null;
  docsReachable: boolean;
  appReachable: boolean;
  kane: { installed: boolean; loggedIn: boolean };
  /** KaneVerity's own Kane run costs. No limit, no account balance. */
  credits: {
    reportedCredits: number;
    estimatedCredits: number;
    runsReported: number;
    runsEstimated: number;
    runsWithoutAgentWork: number;
    pendingRuns: number;
    /** Estimated range per run kind, shown before a run. Estimates only, never limits. */
    estimatedByKind: Record<'verification' | 'exploration' | 'retest', [number, number]>;
  };
  liveVerificationScope: { docs: string[]; app: string[]; note: string };
  explorationModes: { id: string; label: string; rule: string | null }[];
}

export interface PublicRun {
  runId: string;
  kind?: 'verification' | 'exploration' | 'retest';
  correctionId?: string | null;
  explorationMode?: string | null;
  assertions?: { query: string; extracted: string | null; passed: boolean; isCheck: boolean }[];
  visitedOrigins?: string[];
  state: RunState;
  tutorial?: Pick<Tutorial, 'id' | 'title' | 'url' | 'method' | 'steps' | 'outcomes' | 'sourceSha256'>;
  appStartUrl?: string;
  objective?: string;
  objectiveMapping?: { objectiveLine: number; kind: 'step' | 'outcome'; index: number }[];
  createdAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  exitCode?: number | null;
  cliVersion?: string | null;
  durationSec?: number | null;
  credits?: number | null;
  costBasis?: 'reported' | 'estimated' | 'none' | 'not_started' | null;
  estimatedCredits?: number | null;
  kane?: { status: string | null; reasonCode: string | null; reason: string | null; summary: string | null; triage: string | null };
  progress?: { step: number; status: string; remark: string }[];
  evidence?: {
    found: boolean;
    valid: boolean;
    problems: string[];
    steps: { ordinal: number; kind: string; status: string; summary: string; url: string | null }[];
    screenshots: { ordinal: number; file: string }[];
    withheldScreenshots: number;
    runReference: string;
    kaneValidation: { status: 'valid' | 'invalid' | 'not_run'; packStatus: string | null; warnings: number; errors: number };
  };
  classification: Classification | null;
  warnings: string[];
}
