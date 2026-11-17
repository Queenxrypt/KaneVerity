// UI-side view of the orchestrator's public (allow-listed, scrubbed) records.
// Core types are imported type-only from the orchestrator, so they can't drift.
import type { Classification, Discovery, ExtractedItem, Project, RunState, SourceRef, Tutorial, VerificationStatus } from '../../orchestrator/src/types.ts';

export type { Classification, Discovery, ExtractedItem, Project, RunState, SourceRef, Tutorial, VerificationStatus };

export interface Health {
  project: Project | null;
  docsReachable: boolean;
  appReachable: boolean;
  kane: { installed: boolean; loggedIn: boolean };
  credits: { limit: number; spent: number; reserved: number; available: number };
  liveVerificationScope: { docs: string[]; app: string[]; note: string };
}

export interface PublicRun {
  runId: string;
  state: RunState;
  tutorial?: Pick<Tutorial, 'id' | 'title' | 'url' | 'method' | 'steps' | 'outcomes'>;
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
