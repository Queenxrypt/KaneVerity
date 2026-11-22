import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basisOf, summarizeCosts, type CreditEntry } from '../src/store.ts';
import { estimateRange, unreportedEstimate } from '../src/config.ts';

test('legacy ledger entries (no basis) keep their meaning: >0 reported, 0 = no agent work', () => {
  const legacy: CreditEntry[] = [
    { runId: 'r1', credits: 0, at: '', note: 'Corrected: Kane exited at setup (exit 2) before any agent work' },
    { runId: 'r2', credits: 11.72, at: '' },
    { runId: 'r3', credits: 21.39, at: '' },
  ];
  assert.deepEqual(legacy.map(basisOf), ['none', 'reported', 'reported']);
  assert.deepEqual(summarizeCosts(legacy), { reportedCredits: 33.11, estimatedCredits: 0, runsReported: 2, runsEstimated: 0, runsWithoutAgentWork: 1, measuredCredits: 0, runsMeasured: 0, runsUnknownCost: 0 });
});

test('reported and estimated costs are summed separately, never mixed', () => {
  const ledger: CreditEntry[] = [
    { runId: 'a', credits: 12.5, basis: 'reported', at: '' },
    { runId: 'b', credits: 35, basis: 'estimated', at: '' },
    { runId: 'c', credits: 0, basis: 'none', at: '' },
    { runId: 'd', credits: 20.25, basis: 'reported', at: '' },
  ];
  const s = summarizeCosts(ledger);
  assert.equal(s.reportedCredits, 32.75);
  assert.equal(s.estimatedCredits, 35);
  assert.equal(s.runsReported, 2);
  assert.equal(s.runsEstimated, 1);
  assert.equal(s.runsWithoutAgentWork, 1);
});

test('estimates per run kind: exploration 20-40, verification and retest 12-35 (estimates only)', () => {
  assert.deepEqual(estimateRange('exploration'), [20, 40]);
  assert.deepEqual(estimateRange('verification'), [12, 35]);
  assert.deepEqual(estimateRange('retest'), [12, 35]);
  assert.deepEqual(estimateRange(), [12, 35], 'default is verification');
  // A run that did agent work but got no Kane-reported cost is labelled with its kind's upper bound.
  assert.equal(unreportedEstimate('exploration'), 40);
  assert.equal(unreportedEstimate('verification'), 35);
  assert.equal(unreportedEstimate('retest'), 35);
});

test('summary has no limit, remaining or balance fields', () => {
  const s = summarizeCosts([]);
  for (const k of ['limit', 'available', 'remaining', 'balance', 'hardLimit']) assert.equal(k in s, false, k);
});
