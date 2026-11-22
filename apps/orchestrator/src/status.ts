// Tutorial verification status: the single rule set used by the Dashboard and the
// Tutorials page (and tested here). Pure functions with no Node imports, so the
// web app can import them directly.
//
// Rules:
// - Only finished verification and retest runs count. Exploration runs never count:
//   they only look for the current route for a correction.
// - A result applies to one version of the documentation. The status of a tutorial
//   comes from the latest counting run on the version discovery currently shows.
//   Older results are kept as history but marked as for an earlier version.
// - VERIFIED needs a correction in state "verified" for this exact version, and the
//   current result must be PASSED. Restoring the original invalidates it.
// - A finding is open while the current result is a FAILED documentation defect.
//   It is resolved once a correction for it reaches VERIFIED.

import type { VerificationStatus } from './types.ts';

export type RunKind = 'verification' | 'exploration' | 'retest';

export const RUN_KIND_LABEL: Record<RunKind, string> = {
  verification: 'Verification',
  exploration: 'Exploration',
  retest: 'Retest',
};

export interface StatusRun {
  runId: string;
  kind?: RunKind | null;
  state: string;
  createdAt: string;
  startedAt?: string | null;
  tutorial: { id: string; title?: string; sourceSha256?: string | null };
  classification: { status: VerificationStatus; documentationDefect: boolean } | null;
}

export interface StatusCorrection {
  id: string;
  state: string;
  runId: string;
  tutorialId: string;
  updatedAt: string;
  retestRunId?: string | null;
  proposal?: { proposedSha256: string } | null;
}

export interface StatusTutorial {
  id: string;
  title?: string;
  sourceSha256: string | null;
}

export interface TutorialStatus {
  /** Status for the documentation version discovery shows; null if it has not been run. */
  status: VerificationStatus | null;
  /** The run that decided `status`. */
  run: StatusRun | null;
  /** The latest counting run on any version (may be for an earlier version). */
  latestRun: StatusRun | null;
  /** True when the only results are for an earlier version of the documentation. */
  resultForEarlierVersion: boolean;
  verified: boolean;
  /** The verified correction behind `verified`. */
  verifiedBy: StatusCorrection | null;
  /** The most recently updated correction for this tutorial, in any state. */
  correction: StatusCorrection | null;
  /** The current result is a FAILED documentation defect that no verified correction resolves. */
  openFinding: boolean;
}

export function runKind(r: Pick<StatusRun, 'kind'>): RunKind {
  return r.kind ?? 'verification';
}

/** Only finished verification and retest runs with a classification count towards status. */
export function countsAsVerification(r: StatusRun): boolean {
  const k = runKind(r);
  return (k === 'verification' || k === 'retest') && r.state === 'finished' && r.classification !== null;
}

const newestFirst = <T>(xs: T[], at: (x: T) => string): T[] => [...xs].sort((a, b) => at(b).localeCompare(at(a)));

export function tutorialStatus(t: StatusTutorial, runs: StatusRun[], corrections: StatusCorrection[]): TutorialStatus {
  const counting = newestFirst(runs.filter((r) => r.tutorial.id === t.id && countsAsVerification(r)), (r) => r.startedAt ?? r.createdAt);
  const latestRun = counting[0] ?? null;
  const run = t.sourceSha256 ? counting.find((r) => r.tutorial.sourceSha256 === t.sourceSha256) ?? null : latestRun;
  const status = run?.classification?.status ?? null;
  const mine = newestFirst(corrections.filter((c) => c.tutorialId === t.id), (c) => c.updatedAt);
  const verifiedBy =
    status === 'PASSED' && t.sourceSha256
      ? mine.find((c) => c.state === 'verified' && !!c.retestRunId && c.proposal?.proposedSha256 === t.sourceSha256) ?? null
      : null;
  return {
    status,
    run,
    latestRun,
    resultForEarlierVersion: !!latestRun && !run,
    verified: !!verifiedBy,
    verifiedBy,
    correction: mine[0] ?? null,
    openFinding: status === 'FAILED' && run?.classification?.documentationDefect === true && !verifiedBy,
  };
}

export interface Findings {
  open: { tutorial: StatusTutorial; run: StatusRun; correction: StatusCorrection | null }[];
  resolved: { correction: StatusCorrection; run: StatusRun | null; retestRunId: string | null }[];
}

/** Open findings (current FAILED documentation defects) and resolved ones (verified corrections). */
export function findings(tutorials: StatusTutorial[], runs: StatusRun[], corrections: StatusCorrection[]): Findings {
  const open: Findings['open'] = [];
  for (const t of tutorials) {
    const s = tutorialStatus(t, runs, corrections);
    if (s.openFinding && s.run) {
      const correction = corrections.find((c) => c.runId === s.run!.runId) ?? null;
      open.push({ tutorial: t, run: s.run, correction });
    }
  }
  const resolved = newestFirst(corrections.filter((c) => c.state === 'verified'), (c) => c.updatedAt).map((c) => ({
    correction: c,
    run: runs.find((r) => r.runId === c.runId) ?? null,
    retestRunId: c.retestRunId ?? null,
  }));
  return { open, resolved };
}

export type DashboardCounts = Record<VerificationStatus, number> & {
  notRun: number;
  verified: number;
  awaitingReview: number;
  awaitingRetest: number;
};

export function dashboardCounts(tutorials: StatusTutorial[], runs: StatusRun[], corrections: StatusCorrection[]): DashboardCounts {
  const counts: DashboardCounts = { PASSED: 0, FAILED: 0, BLOCKED: 0, NEEDS_REVIEW: 0, notRun: 0, verified: 0, awaitingReview: 0, awaitingRetest: 0 };
  for (const t of tutorials) {
    const s = tutorialStatus(t, runs, corrections);
    if (s.status) counts[s.status]++;
    else counts.notRun++;
    if (s.verified) counts.verified++;
  }
  counts.awaitingReview = corrections.filter((c) => c.state === 'proposed').length;
  counts.awaitingRetest = corrections.filter((c) => c.state === 'applied' || c.state === 'not_verified').length;
  return counts;
}

/** The correction started from this run, if any (most recent first). */
export function correctionForRun(runId: string, corrections: StatusCorrection[]): StatusCorrection | null {
  return newestFirst(corrections.filter((c) => c.runId === runId), (c) => c.updatedAt)[0] ?? null;
}

/** States in which a correction no longer blocks "Propose correction" from this run. */
export const CORRECTION_CLOSED_STATES = ['rejected', 'closed', 'restored'];
