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

import type { LineMapEntry } from '../../orchestrator/src/assurance/requirements.ts';
export type { LineMapEntry };

/** Assurance B1: one stored requirements version (metadata). */
export interface RequirementsVersionMeta {
  tutorialId: string;
  version: number;
  format: string;
  title: string;
  docSha256: string;
  reqSha256: string;
  createdAt: string;
  supersedes: number | null;
  file: string;
}

export type RequirementsState = 'none' | 'current' | 'stale';

export interface RequirementsSummary {
  tutorialId: string;
  title: string;
  state: RequirementsState;
  reasons: string[];
  latest: RequirementsVersionMeta | null;
  versionCount: number;
  freshness: 'current' | 'stale' | 'unavailable';
}

export interface RequirementsDetail {
  tutorialId: string;
  title: string;
  docsUrl: string;
  appStart: string | null;
  state: RequirementsState;
  reasons: string[];
  freshness: TutorialFreshness;
  canGenerate: boolean;
  cannotGenerateReason: string | null;
  versions: RequirementsVersionMeta[];
  shown: (RequirementsVersionMeta & { lineMap: LineMapEntry[]; markdown: string; intact: boolean; isLatest: boolean }) | null;
  preview: { markdown: string; reqSha256: string; docSha256: string; lineMap: LineMapEntry[] } | null;
}

import type { CheckedCitation, CitationReport, ItemCoverage } from '../../orchestrator/src/assurance/citations.ts';
import type { KaneWriteState, ReviewEntry, ReviewState } from '../../orchestrator/src/assurance/review.ts';
export type { CheckedCitation, CitationReport, ItemCoverage, KaneWriteState, ReviewEntry, ReviewState };

/** Assurance B4: the latest KaneVerity decision as recorded and verified in Kane. */
export interface KaneApprovalView {
  state: KaneWriteState | 'none';
  writeId: string | null;
  decisionId: string | null;
  kaneSeq: number | null;
  kaneHash: string | null;
  /** What Kane recorded as "by" (compared, never proof of identity). */
  kaneBy: string | null;
  /** Self-declared reviewer name passed to Kane. */
  reviewer: string | null;
  via: 'write' | 'reconcile' | 'reuse' | 'startup' | null;
  reason: string | null;
  at: string | null;
  recordInStore: boolean;
  externalApproval: boolean;
  trustedButRejected: boolean;
  canWrite: boolean;
  canReconcile: boolean;
}

/** One approval write and every step of it (the log keeps each step; nothing is merged away). */
export interface KaneWriteGroup {
  writeId: string;
  decisionId: string;
  reviewer: string;
  /** Current state (a pending write not running now shows as unknown). */
  state: KaneWriteState;
  kaneSeq: number | null;
  kaneHash: string | null;
  steps: {
    step: 'started' | 'kane_running' | 'verified' | 'not_written' | 'unknown' | 'written_unverified';
    via: 'write' | 'reconcile' | 'reuse' | 'startup';
    at: string;
    reason: string;
    kaneSeq: number | null;
    kaneHash: string | null;
  }[];
}

/** Assurance B3: one extracted use case with KaneVerity's review state (UI-safe). */
export interface UseCaseView {
  cid: string;
  logicalId: string;
  title: string;
  description: string;
  summary: string;
  value: string;
  risk: string;
  actors: string[];
  criteria: { text: string; citations: number[] }[];
  kaneTrust: string;
  fresh: string;
  mintedSeq: number;
  proposalId: string | null;
  citationReport: CitationReport;
  kaneVerdicts: { resolution: string; attributedTo: string; countsAsReview: false }[];
  review: { state: ReviewState; history: ReviewEntry[] };
  kane: KaneApprovalView;
  kaneWrites: KaneWriteGroup[];
  design: { eligible: boolean; reasons: string[] };
  /** V2: the latest test-design attempt and whether a new one can start (paid; mode "all"). */
  testDesign?: {
    latestJob: { jobId: string; kind: string; state: string; reason: string; createdAt: string } | null;
    blockedBy: string | null;
    needsAcknowledgement: string | null;
    canStart: boolean;
  };
}

export interface UseCasesResponse {
  tutorialId: string;
  mode: AssuranceMode;
  /** Self-declared reviewer (KANEVERITY_REVIEWER); never authenticated. */
  reviewer: { label: string | null; problem: string | null; selfDeclared: true };
  /** A write in progress or with an unknown outcome locks decisions and writes. */
  locked: { state: string; ucCid: string } | null;
  /** The outcome of the last action (decision, write or reconcile). */
  note: string | null;
  snapshot: null | {
    snapshot: number;
    retrievedAt: string;
    cliVersion: string;
    integrity: { ok: boolean; problems: string[] };
    store: { records: number; tipPrefix: string | null; tipHash: string | null };
    fsck: { ok: boolean; issues: number };
    requirements: { version: number; reqSha256: string; docSha256: string } | null;
    requirementsCurrent: boolean;
  };
  useCases: UseCaseView[];
}

/** Assurance B2: Kane Assurance jobs (UI-safe view). */
export type AssuranceMode = 'off' | 'free' | 'all';
export type JobKind = 'ingest' | 'extract' | 'design' | 'resume' | 'list' | 'cover' | 'view' | 'fsck';
export type JobState = 'queued' | 'running' | 'complete' | 'paused' | 'answered' | 'refused' | 'error' | 'crashed' | 'interrupted' | 'cancelled' | 'abandoned' | 'expired';

export interface AssuranceStatus {
  mode: AssuranceMode;
  pinnedVersion: string;
  kaneFound: boolean;
  kinds: { kind: JobKind; label: string; paid: boolean; enabled: boolean }[];
}

export interface JobQuestion {
  id: string;
  text: string;
  risk: string | null;
  rationale: string | null;
  options: { label: string; detail: string | null; input: boolean }[];
  recommendedIndex: number | null;
  allowFreeText: boolean;
}

export interface PublicJob {
  jobId: string;
  kind: JobKind;
  label: string;
  paid: boolean;
  tutorialId: string | null;
  state: JobState;
  reason: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  cliVersion: string | null;
  doneStatus: string | null;
  next: string[];
  params: Record<string, unknown>;
  pause: { expiresAt: string | null; questions: JobQuestion[]; crashed: boolean; held: number | null } | null;
  parentJobId: string | null;
  resumedBy: string | null;
  requirements: { version: number; reqSha256: string; docSha256: string } | null;
  credits: { amount: number | null; basis: 'reported' | 'measured' | 'unknown' | 'estimated' | 'none' | null; reportedTotal: number | null; measured: number | null };
  summary: { ingested: { sourceId: string; status: string }[]; commits: { counts: Record<string, number>; minted: string[] }[]; warnings: string[]; errors: string[]; held: number; messages: string[]; unknownEventTypes: string[]; nonJsonLines: number; invalidLines: number };
}

export type JobAnswer = number | string | { option: number; text: string };

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
    measuredCredits: number;
    runsMeasured: number;
    runsUnknownCost: number;
    assuranceJobsReported: number;
    assuranceCreditsReported: number;
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

// ---------------------------------------------------------------------------
// Assurance B5: test-design review (GET/POST /api/assurance/designs/:t/:uc).
// ---------------------------------------------------------------------------

export interface DesignItemBaseView {
  cid: string;
  slug: string | null;
  trust: string | null;
  mintedSeq: number;
  mintedHash: string | null;
  generation: number | null;
}
export interface DesignAcView extends DesignItemBaseView {
  label: 'ac';
  text: string;
}
export interface DesignScenarioView extends DesignItemBaseView {
  label: 'scenario';
  title: string;
  intent: string;
  exercises: string[];
}
export interface DesignTestStepView {
  n: number;
  tags: string[];
  assertHeading: boolean;
  baseline: boolean;
  text: string;
}
export interface DesignTestView extends DesignItemBaseView {
  label: 'test';
  title: string;
  definitionId: string | null;
  check: { kind: string; operator: string | null; operand: string | null; verifiedAgainst: string | null } | null;
  automates: string[];
  verifies: string[];
  steps: DesignTestStepView[];
  file: { path: string; sha256: string; bodyMatches: boolean; basePin: string | null } | null;
}
export interface DesignGapView extends DesignItemBaseView {
  label: 'gap';
  kind: string;
  header: string;
  prompt: string;
  ref: string | null;
  refState: 'live' | 'superseded' | 'unknown' | 'none';
}
export interface DesignCheckView {
  ok: boolean;
  problems: string[];
  notes: string[];
}
export interface DesignOutcomeView {
  outcome: string;
  outcomeText: string;
  acSlug: string | null;
  scenarioCid: string | null;
  testCid: string | null;
  assertStep: number | null;
  specified: boolean;
  problems: string[];
  evidence: 'not_available';
}
export interface DesignFidelityView {
  testCid: string;
  testSlug: string | null;
  ok: boolean;
  problems: string[];
  steps: { n: number; kind: 'navigation' | 'capture' | 'assertion' | 'other'; labels: string[]; actions: string[]; asserts: boolean; captures: boolean }[];
  extraSteps: { n: number; text: string }[];
}
export interface DesignDecisionView {
  kind: 'ac' | 'scenario' | 'test' | 'gap' | 'mapping' | 'extra_step' | 'recording';
  target: string;
  label: string;
  required: 'approved' | 'acknowledged';
  state: 'none' | 'approved' | 'rejected' | 'acknowledged';
  stale: boolean;
  at: string | null;
  reason: string | null;
}
export interface DesignOutcomeEvidenceView {
  outcome: string;
  verified: boolean;
  problems: string[];
  basis: 'dom_value' | 'dom_baseline_change' | null;
  evidence: {
    member: string;
    stepOrdinal: number;
    actionId: string;
    assertionId: string | null;
    operator: string | null;
    expected: string | null;
    observed: string | null;
    locator: string | null;
    domCode: string | null;
    baseline: { locator: string; logFile: string; beforeStep: number; before: string[]; afterStep: number; after: string[]; added: string[] } | null;
  } | null;
}
/** Kane's recording of one test (output-<test>/): what an AUTHORED run recorded, for review. */
export interface DesignRecordingView {
  testCid: string;
  slug: string | null;
  dir: string | null;
  exists: boolean;
  staging: boolean;
  sha256: string | null;
  files: number;
  resultMd: string | null;
  state: 'none' | 'approved' | 'rejected' | 'acknowledged';
  stale: boolean;
  at: string | null;
  ok: boolean;
  reason: string;
}
export interface DesignExecutionView {
  executionId: string;
  phase: 'authoring' | 'verification';
  jobId: string | null;
  state: 'started' | 'refused' | 'unknown' | 'finished' | 'reconciled';
  at: string;
  reason: string;
  verdict: 'AUTHORED' | 'VERIFIED' | 'NOT_VERIFIED' | null;
  mutation: string[];
  problems: string[];
  outcomes: DesignOutcomeEvidenceView[];
  packOk: boolean | null;
  runKind: string | null;
  packProblems: string[];
  /** Kane is still running this run (it is watched, never reconciled). */
  kaneRunning: boolean;
  canReconcile: boolean;
}
export interface DesignReviewResponse {
  tutorialId: string;
  ucCid: string;
  mode: AssuranceMode;
  reviewer: { label: string | null; problem: string | null; selfDeclared: true };
  note: string | null;
  design: null | {
    snapshot: number;
    retrievedAt: string;
    useCaseSnapshot: number;
    integrity: { ok: boolean; problems: string[] };
    store: { records: number; tipHash: string | null };
    requirements: { version: number; reqSha256: string; docSha256: string } | null;
    designRecords: { seq: number; hash: string | null; phase: string | null; generation: number | null; completeness: string | null; supersedesGeneration: number | null }[];
    acs: DesignAcView[];
    scenarios: DesignScenarioView[];
    tests: DesignTestView[];
    gaps: DesignGapView[];
    strayTestFiles: { path: string; id: string | null }[];
    supersededTestFiles?: { path: string; sha256: string; id: string; testCid: string; supersededInSeq: number; successor: string | null }[];
    supersessions?: { seq: number; label: string; old: string; next: string | null; reason: string; recognised: boolean }[];
    variables: { path: string; sha256: string | null; appUrlDeclared: boolean; appUrlHasValue: boolean };
  };
  documented?: { steps: { item: string; text: string; labels: string[]; source: string }[]; outcomes: { item: string; text: string; labels: string[]; source: string }[] };
  evaluation?: {
    generation: DesignCheckView & { latest: number | null; phasesInLatest: string[] };
    structure: DesignCheckView;
    mapping: { ok: boolean; entries: { outcome: string; acCid: string | null; acSlug: string | null; problem: string | null }[]; problems: string[] };
    outcomes: DesignOutcomeView[];
    fidelity: DesignFidelityView[];
    files: DesignCheckView;
    gaps: { cid: string; slug: string | null; stale: boolean; message: string }[];
  };
  reviews?: DesignDecisionView[];
  appUrl?: { proposed: string | null; state: 'none' | 'approved'; stale: boolean; value?: string | null; at: string | null; declaredByKane: boolean; fileHasValue: boolean; runFile: string; runFileValue: string | null; winnerFile?: string | null; writesKaneFile: false };
  kaneApprovals?: { label: string; target: string; kind: string; ok: boolean; state: string; reason: string; kaneSeq: number | null; writeId: string | null }[];
  dryRun?: { ok: boolean; reason: string; current: boolean; latest: { id: string; at: string; state: 'passed' | 'failed' | 'unknown'; reason: string; unresolved: string[]; files: string[] } | null };
  execution?: DesignExecutionView | null;
  readiness?: { ready: boolean; items: { id: string; label: string; ok: boolean; reason: string }[] };
  verificationReadiness?: { ready: boolean; items: { id: string; label: string; ok: boolean; reason: string }[] };
  recordings?: DesignRecordingView[];
  canReview?: boolean;
}
