// Run-kind-aware tutorial status (shared by the Dashboard and the Tutorials page).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctionForRun, countsAsVerification, dashboardCounts, findings, tutorialStatus, type StatusCorrection, type StatusRun } from '../src/status.ts';
import type { VerificationStatus } from '../src/types.ts';

const OLD = 'a'.repeat(64); // outdated document version
const NEW = 'b'.repeat(64); // corrected document version

const run = (runId: string, at: string, kind: StatusRun['kind'], status: VerificationStatus | null, sha: string, defect = false, tid = 'api'): StatusRun => ({
  runId,
  kind,
  state: status ? 'finished' : 'running',
  createdAt: at,
  startedAt: at,
  tutorial: { id: tid, sourceSha256: sha },
  classification: status ? { status, documentationDefect: defect } : null,
});
const corr = (state: string, extra: Partial<StatusCorrection> = {}): StatusCorrection => ({ id: 'c1', state, runId: 'r-fail', tutorialId: 'api', updatedAt: '2026-11-21T10:00:00Z', retestRunId: null, proposal: { proposedSha256: NEW }, ...extra });

// The real API-key history, in order.
const FAIL = run('r-fail', '2026-11-17T20:31:00Z', 'verification', 'FAILED', OLD, true);
const EXPLORE1 = run('r-ex1', '2026-11-19T15:00:00Z', 'exploration', 'PASSED', OLD);
const EXPLORE2 = run('r-ex2', '2026-11-19T15:45:00Z', 'exploration', 'PASSED', OLD);
const RETEST = run('r-retest', '2026-11-21T15:19:00Z', 'retest', 'PASSED', NEW);

test('AUDIT BUG: an exploration run never counts as verification, even when it is the latest run', () => {
  // Before the retest, the latest runs were explorations that PASSED. The tutorial's
  // status must still be the FAILED verification, never PASSED.
  const s = tutorialStatus({ id: 'api', sourceSha256: OLD }, [EXPLORE2, EXPLORE1, FAIL], [corr('route_confirmed')]);
  assert.equal(s.status, 'FAILED');
  assert.equal(s.run?.runId, 'r-fail');
  assert.equal(s.openFinding, true);
  assert.equal(s.verified, false);
  assert.equal(countsAsVerification(EXPLORE1), false);
  assert.equal(countsAsVerification(RETEST), true);
  assert.equal(countsAsVerification({ ...FAIL, kind: undefined }), true, 'older runs without a kind are verifications');
  assert.equal(countsAsVerification(run('r-q', '2026-11-22T00:00:00Z', 'verification', null, OLD)), false, 'unfinished runs do not count');
});

test('only explorations -> not run yet (no status), not PASSED', () => {
  const s = tutorialStatus({ id: 'api', sourceSha256: OLD }, [EXPLORE1, EXPLORE2], []);
  assert.equal(s.status, null);
  assert.equal(s.run, null);
});

test('verified correction + PASSED retest on the current version -> VERIFIED, finding resolved', () => {
  const runs = [RETEST, EXPLORE2, EXPLORE1, FAIL];
  const cs = [corr('verified', { retestRunId: 'r-retest' })];
  const s = tutorialStatus({ id: 'api', sourceSha256: NEW }, runs, cs);
  assert.equal(s.status, 'PASSED');
  assert.equal(s.run?.runId, 'r-retest');
  assert.equal(s.verified, true);
  assert.equal(s.openFinding, false);
  const f = findings([{ id: 'api', sourceSha256: NEW }], runs, cs);
  assert.equal(f.open.length, 0, 'AUDIT BUG: the resolved finding is not shown as current');
  assert.deepEqual(f.resolved.map((x) => [x.correction.id, x.run?.runId, x.retestRunId]), [['c1', 'r-fail', 'r-retest']]);
});

test('AUDIT BUG: results for an earlier documentation version do not define the current status', () => {
  // Discovery now shows the corrected version, but only the old FAILED run exists.
  const s = tutorialStatus({ id: 'api', sourceSha256: NEW }, [FAIL, EXPLORE1], [corr('applied')]);
  assert.equal(s.status, null);
  assert.equal(s.resultForEarlierVersion, true);
  assert.equal(s.latestRun?.runId, 'r-fail');
  assert.equal(s.openFinding, false, 'no current FAILED result');
});

test('restoring a VERIFIED correction invalidates VERIFIED: the original version shows its FAILED result again', () => {
  const runs = [RETEST, EXPLORE1, FAIL];
  const s = tutorialStatus({ id: 'api', sourceSha256: OLD }, runs, [corr('restored', { retestRunId: 'r-retest' })]);
  assert.equal(s.verified, false);
  assert.equal(s.status, 'FAILED');
  assert.equal(s.openFinding, true);
  assert.equal(findings([{ id: 'api', sourceSha256: OLD }], runs, [corr('restored', { retestRunId: 'r-retest' })]).resolved.length, 0);
});

test('VERIFIED requires: state verified, a retest, the same document version and a PASSED current result', () => {
  const t = { id: 'api', sourceSha256: NEW };
  const runs = [RETEST, FAIL];
  assert.equal(tutorialStatus(t, runs, [corr('applied', { retestRunId: 'r-retest' })]).verified, false, 'not verified state');
  assert.equal(tutorialStatus(t, runs, [corr('verified', { retestRunId: null })]).verified, false, 'no retest');
  assert.equal(tutorialStatus(t, runs, [corr('verified', { retestRunId: 'r-retest', proposal: { proposedSha256: 'c'.repeat(64) } })]).verified, false, 'other version');
  // A later verification of the same version that FAILED wins over the old retest.
  const later = run('r-later', '2026-11-22T09:00:00Z', 'verification', 'FAILED', NEW, true);
  const s = tutorialStatus(t, [later, ...runs], [corr('verified', { retestRunId: 'r-retest' })]);
  assert.equal(s.status, 'FAILED');
  assert.equal(s.verified, false);
  assert.equal(s.openFinding, true);
});

test('BLOCKED and NEEDS REVIEW are never open documentation findings', () => {
  for (const st of ['BLOCKED', 'NEEDS_REVIEW'] as const) {
    const s = tutorialStatus({ id: 'api', sourceSha256: OLD }, [run('r', '2026-11-20T00:00:00Z', 'verification', st, OLD, false)], []);
    assert.equal(s.status, st);
    assert.equal(s.openFinding, false);
  }
});

test('Dashboard counts use the same rules, plus verified and awaiting-review counts', () => {
  const tutorials = [
    { id: 'api', sourceSha256: NEW },
    { id: 'proj', sourceSha256: OLD },
    { id: 'team', sourceSha256: OLD },
    { id: 'ws', sourceSha256: OLD },
  ];
  const runs = [RETEST, EXPLORE2, EXPLORE1, FAIL, run('r-proj', '2026-11-17T21:13:00Z', 'verification', 'PASSED', OLD, false, 'proj'), run('r-ws-ex', '2026-11-20T00:00:00Z', 'exploration', 'PASSED', OLD, false, 'ws')];
  const cs = [corr('verified', { retestRunId: 'r-retest' }), corr('proposed', { id: 'c2', tutorialId: 'ws', runId: 'x' })];
  const c = dashboardCounts(tutorials, runs, cs);
  assert.equal(c.PASSED, 2);
  assert.equal(c.FAILED, 0);
  assert.equal(c.notRun, 2, 'team never ran; ws only has an exploration');
  assert.equal(c.verified, 1);
  assert.equal(c.awaitingReview, 1);
  for (const t of tutorials) {
    const s = tutorialStatus(t, runs, cs);
    assert.equal(s.status === 'PASSED', ['api', 'proj'].includes(t.id), t.id);
  }
});

test('correctionForRun links the original failed run to its correction', () => {
  const cs = [corr('verified', { retestRunId: 'r-retest' })];
  assert.equal(correctionForRun('r-fail', cs)?.id, 'c1');
  assert.equal(correctionForRun('r-retest', cs), null);
});
