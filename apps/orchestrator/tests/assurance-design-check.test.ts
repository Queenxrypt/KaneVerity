// Assurance B5: the deterministic design checks and the readiness gate, as pure
// functions. Fixtures follow the real 0.10.5 shapes (docs/ASSURANCE_PLAN.md section 13).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionLabels, evaluateDesign, parseTestSteps, quotedLabels, recognisedSupersession, type DesignSnapshot, type Requirements, type TestItem } from '../src/assurance/designCheck.ts';
import { computeReadiness, decisionStatus, type DesignReviewEntry, type PreExecutionInput } from '../src/assurance/designs.ts';

const REQ: Requirements = {
  steps: [
    { item: 'S1', index: 1, text: "In the left navigation menu, click 'Developer Settings'.", labels: ['Developer Settings'], source: 'tutorials/x.md:18' },
    { item: 'S2', index: 2, text: "Click 'API Keys'.", labels: ['API Keys'], source: 'tutorials/x.md:19' },
    { item: 'S3', index: 3, text: "Click 'Generate Key'.", labels: ['Generate Key'], source: 'tutorials/x.md:20' },
  ],
  outcomes: [
    { item: 'O1', index: 1, text: "The message 'API key generated successfully.' appears.", labels: ['API key generated successfully.'], source: 'tutorials/x.md:24' },
    { item: 'O2', index: 2, text: 'The new key is added to the API keys list.', labels: [], source: 'tutorials/x.md:25' },
    { item: 'O3', index: 3, text: "The key count below the list shows '2 keys'.", labels: ['2 keys'], source: 'tutorials/x.md:26' },
  ],
};
const c = (n: number) => 'sha256:' + String(n).padStart(64, '0');
const base = (cid: string, slug: string, generation = 1, seq = 4) => ({ cid, slug, trust: 'derived', fresh: 'fresh', mintedSeq: seq, mintedHash: 'sha256:' + 'f'.repeat(64), generation, contentSha256: 'x' });
const NAV = "## Step 1\n\nStart at {{app_url}}/ and open 'Developer Settings'.\n\n## Step 2\n\nOpen 'API Keys'.\n";

function testItem(cid: string, slug: string, scenario: string, ac: string, body: string, check: TestItem['check']): TestItem {
  return { ...base(cid, slug, 2, 10), label: 'test', title: slug, definitionId: 'sha256:' + 'd'.repeat(64), check, automates: [scenario], verifies: [ac], blobSha256: 'b', steps: parseTestSteps(body, /capture baseline:/.test(body) ? new Set([3]) : new Set()), file: { path: `.testmuai/tests/${slug}_test.md`, sha256: 'f', bodyMatches: true, basePin: 'sha256:' + 'd'.repeat(64), id: slug } };
}

/** A complete three-pair design (generation 2), optionally altered. */
function snapshot(alter: (s: DesignSnapshot) => void = () => {}): DesignSnapshot {
  const s: DesignSnapshot = {
    snapshot: 1,
    tutorialId: 't',
    ucCid: c(99),
    ucSlug: 'uc-1',
    retrievedAt: '',
    useCaseSnapshot: 1,
    cliVersion: '0.10.5',
    integrity: { ok: true, problems: [] },
    store: { records: 10, tipHash: null },
    requirements: null,
    sourceCid: null,
    designRecords: [
      { seq: 4, hash: 'h4', verb: 'design', phase: 'acs', generation: 1, completeness: 'complete', startsGeneration: 1, supersedesGeneration: null },
      { seq: 8, hash: 'h8', verb: 'design', phase: 'scenarios', generation: 2, completeness: 'complete', startsGeneration: 2, supersedesGeneration: 1 },
      { seq: 9, hash: 'h9', verb: 'design', phase: 'wiring', generation: 2, completeness: 'complete', startsGeneration: null, supersedesGeneration: null },
      { seq: 10, hash: 'h10', verb: 'design', phase: 'tests', generation: 2, completeness: 'complete', startsGeneration: null, supersedesGeneration: null },
    ],
    acs: [
      { ...base(c(1), 'ac-1'), label: 'ac', text: 'After generating the key, the new key appears in the API keys list.', kind: 'delta' },
      { ...base(c(2), 'ac-2'), label: 'ac', text: "After generating the key, the key count below the list shows '2 keys'.", kind: 'absolute' },
      { ...base(c(3), 'ac-3'), label: 'ac', text: "After generating the key, the message 'API key generated successfully.' appears.", kind: 'presence' },
    ],
    scenarios: [
      { ...base(c(11), 'sc-2', 2, 8), label: 'scenario', title: 'msg', intent: '', caseType: 'happy', exercises: [c(3)], belongsTo: [c(99)] },
      { ...base(c(12), 'sc-3', 2, 8), label: 'scenario', title: 'list', intent: '', caseType: 'happy', exercises: [c(1)], belongsTo: [c(99)] },
      { ...base(c(13), 'sc-4', 2, 8), label: 'scenario', title: 'count', intent: '', caseType: 'happy', exercises: [c(2)], belongsTo: [c(99)] },
    ],
    tests: [
      testItem(c(21), 't-2', c(11), c(3), `${NAV}\n## Step 3 @verifies ac-3\n\nUse 'Generate Key', then assert the message 'API key generated successfully.' appears.\n`, { kind: 'presence', operator: 'exists', operand: 'API key generated successfully.', verifiedAgainst: 'ac-3', baseline: null }),
      testItem(c(22), 't-3', c(12), c(1), `${NAV}\n## Step 3\n\ncapture baseline: the rows of the API keys list\n\n## Step 4 @verifies ac-1\n\nUse 'Generate Key', then assert the list has one row more than the baseline.\n`, { kind: 'delta', operator: 'changed-by', operand: '1', verifiedAgainst: 'ac-1', baseline: 'rows' }),
      testItem(c(23), 't-4', c(13), c(2), `${NAV}\n## Step 3 @verifies ac-2\n\nUse 'Generate Key', then assert the key count below the list shows '2 keys'.\n`, { kind: 'absolute', operator: 'equals', operand: '2 keys', verifiedAgainst: 'ac-2', baseline: null }),
    ],
    gaps: [],
    strayTestFiles: [],
    variables: { path: '.testmuai/variables/assurance.json', sha256: 'v', appUrlDeclared: true, appUrlHasValue: false },
  };
  alter(s);
  return s;
}
const testBody = (s: DesignSnapshot, i: number, body: string) => (s.tests[i].steps = parseTestSteps(body));

test('a complete three-pair design is specified for every outcome (design level only, never evidence)', () => {
  const ev = evaluateDesign(snapshot(), REQ);
  assert.equal(ev.structure.ok, true);
  assert.equal(ev.generation.ok, true, ev.generation.problems.join(' '));
  assert.deepEqual(ev.outcomes.map((o) => [o.outcome, o.specified, o.evidence]), [['O1', true, 'not_available'], ['O2', true, 'not_available'], ['O3', true, 'not_available']]);
  assert.deepEqual(ev.fidelity.map((f) => f.ok), [true, true, true]);
  // The baseline capture is an undocumented action: it is listed for approval.
  assert.deepEqual(ev.fidelity[1].extraSteps.map((x) => x.n), [3]);
});

test('labels: quoted labels, possessives ignored; an action needs a verb in the same clause', () => {
  assert.deepEqual(quotedLabels("On 'API Keys', use 'Generate Key'; the user's key list"), ['API Keys', 'Generate Key']);
  assert.deepEqual(actionLabels("From 'Developer Settings', open 'API Keys' and store the list."), ['API Keys']);
  assert.deepEqual(actionLabels("On 'API Keys', use 'Generate Key', then assert the message 'API key generated successfully.' appears."), ['Generate Key']);
});

test('fidelity: order, repeats, undocumented labels and variables, start URL', () => {
  const s = snapshot((x) => {
    testBody(x, 0, "## Step 1\n\nOpen 'API Keys' at {{other}}.\n\n## Step 2\n\nOpen 'Developer Settings', then click 'Settings'.\n\n## Step 3 @verifies ac-3\n\nUse 'Generate Key', use 'Generate Key' again, then assert the message 'API key generated successfully.' appears.\n");
  });
  const f = evaluateDesign(s, REQ).fidelity[0];
  const p = f.problems.join(' | ');
  assert.equal(f.ok, false);
  assert.match(p, /Step 1 does not start at the configured application URL/);
  assert.match(p, /\{\{other\}\}/);
  assert.match(p, /'Settings', which is not a documented label/);
  // 'API Keys' (S2) is opened before 'Developer Settings' (S1).
  assert.match(p, /S2 \('API Keys'\) is out of the documented order/);
  assert.match(p, /S3 \('Generate Key'\) is acted on 2 times/);
});

test('outcomes: prose without a tag, a tag for several criteria, a check aimed elsewhere, O2 without a baseline', () => {
  const ev = evaluateDesign(
    snapshot((x) => {
      testBody(x, 0, `${NAV}\n## Step 3\n\nUse 'Generate Key'. The message 'API key generated successfully.' appears.\n`);
      testBody(x, 1, `${NAV}\n## Step 3 @verifies ac-1, ac-2\n\nUse 'Generate Key', then assert the list has one more row.\n`);
      x.tests[2].check = { kind: 'presence', operator: 'exists', operand: 'key count', verifiedAgainst: 'ac-2', baseline: null };
    }),
    REQ,
  );
  const o = Object.fromEntries(ev.outcomes.map((x) => [x.outcome, x.problems.join(' | ')]));
  assert.match(o.O1, /exactly one step tagged @verifies ac-3 \(found 0\)/);
  assert.match(o.O2, /tagged with another criterion \(ac-1, ac-2\)/);
  assert.match(o.O2, /captures no baseline/);
  assert.match(o.O3, /does not name the exact value '2 keys'/);
  assert.ok(ev.outcomes.every((x) => !x.specified));
});

test('O2 needs a before/after criterion, and every check must say what its criterion says', () => {
  const o2 = (alter: (s: DesignSnapshot) => void) => evaluateDesign(snapshot(alter), REQ).outcomes.find((x) => x.outcome === 'O2')!;
  // The real store's ac-1 (presence) cannot stand for "every earlier key kept, a new one added".
  let o = o2((x) => (x.acs[0].kind = 'presence'));
  assert.equal(o.specified, false);
  assert.match(o.problems.join(' '), /ac-1 is a presence criterion, but O2 is a change from the starting state/);
  assert.match(o.problems.join(' '), /the criterion and the test contradict each other/, 'its delta test contradicts it too');
  // A criterion with no recorded kind cannot be shown to require a change.
  o = o2((x) => (x.acs[0].kind = null));
  assert.match(o.problems.join(' '), /records no kind/);
  // A count check is no longer enough for O2: it cannot show that every earlier key is still listed.
  o = o2((x) => {
    x.acs[0].kind = 'count';
    x.tests[1].check = { ...x.tests[1].check!, kind: 'count' };
  });
  assert.match(o.problems.join(' '), /it must be a delta or state-transition criterion/);
  assert.match(o.problems.join(' '), /checked as a change against a captured starting state \(delta or state-transition\); test t-3 uses count/);
  // state-transition is accepted for both, when they agree.
  o = o2((x) => {
    x.acs[0].kind = 'state-transition';
    x.tests[1].check = { ...x.tests[1].check!, kind: 'state-transition' };
  });
  assert.equal(o.specified, true, o.problems.join(' '));
  // An exact-value outcome whose check disagrees with its criterion is refused too.
  const ev = evaluateDesign(snapshot((x) => (x.tests[2].check = { kind: 'presence', operator: 'exists', operand: '2 keys', verifiedAgainst: 'ac-2', baseline: null })), REQ);
  assert.match(ev.outcomes.find((x) => x.outcome === 'O3')!.problems.join(' '), /check is presence, but its criterion ac-2 is absolute/);
});

test('files: a superseded test file Kane kept is noted, never stray; any other unclaimed file blocks', () => {
  let ev = evaluateDesign(snapshot((x) => (x.supersededTestFiles = [{ path: '.testmuai/tests/old_test.md', sha256: 'a'.repeat(64), id: 't-1', testCid: c(31), supersededInSeq: 10, successor: null }])), REQ);
  assert.equal(ev.files.ok, true, ev.files.problems.join(' '));
  assert.match(ev.files.notes.join(' '), /old_test\.md is the file of t-1, superseded in record #10.*never run.*explicit, recorded cleanup decision/);
  ev = evaluateDesign(snapshot((x) => (x.strayTestFiles = [{ path: '.testmuai/tests/other_test.md', sha256: 'b'.repeat(64), id: 't-9' }])), REQ);
  assert.equal(ev.files.ok, false);
  assert.match(ev.files.problems.join(' '), /other_test\.md belongs to no live test/);
});

test('structure and mapping: one scenario for all outcomes, an extra criterion, an ambiguous match', () => {
  let ev = evaluateDesign(snapshot((x) => {
    x.scenarios = [{ ...x.scenarios[0], exercises: [c(1), c(2), c(3)] }];
    x.tests = [{ ...x.tests[0], automates: [c(11)] }];
  }), REQ);
  assert.equal(ev.structure.ok, false);
  assert.match(ev.outcomes[0].problems.join(' '), /exercised only together with other criteria by sc-2/);
  ev = evaluateDesign(snapshot((x) => x.acs.push({ ...base(c(4), 'ac-4'), label: 'ac', text: 'The page loads quickly.' })), REQ);
  assert.match(ev.mapping.problems.join(' '), /ac-4 .* matches no documented outcome/);
  ev = evaluateDesign(snapshot((x) => x.acs.push({ ...base(c(5), 'ac-5'), label: 'ac', text: 'The new key appears in the API keys list again.' })), REQ);
  assert.equal(ev.mapping.ok, false);
});

test('generation: an incomplete tests phase, an orphaned test, an item from an older generation', () => {
  let ev = evaluateDesign(snapshot((x) => (x.designRecords[3].completeness = 'partial')), REQ);
  assert.equal(ev.generation.ok, false);
  ev = evaluateDesign(snapshot((x) => (x.tests[0].automates = [])), REQ);
  assert.match(ev.generation.problems.join(' '), /t-2 automates 0 live scenarios/);
  ev = evaluateDesign(snapshot((x) => (x.tests[0].generation = 1)), REQ);
  assert.match(ev.generation.problems.join(' '), /t-2 is live but was made in generation 1/);
  ev = evaluateDesign(snapshot((x) => (x.designRecords[2].hash = null)), REQ);
  assert.match(ev.generation.problems.join(' '), /full hash of design record 9/);
});

test('generation: only an item a checked corrective evolve kept, by its exact content id, may come from an older generation', () => {
  // Kept by exact content id: accepted, with a note.
  let ev = evaluateDesign(snapshot((x) => ((x.tests[0].generation = 1), (x.correctiveKeep = [x.tests[0].cid]))), REQ);
  assert.equal(ev.generation.ok, true, ev.generation.problems.join(' '));
  assert.match(ev.generation.notes.join(' '), /t-2 comes from generation 1 and was kept, unchanged, by the corrective evolve/);
  // Any other older item still blocks, even with a keep list.
  ev = evaluateDesign(snapshot((x) => ((x.tests[0].generation = 1), (x.tests[1].generation = 1), (x.correctiveKeep = [x.tests[0].cid]))), REQ);
  assert.match(ev.generation.problems.join(' '), /t-3 is live but was made in generation 1/);
  // No keep list (no checked corrective evolve): blocks.
  ev = evaluateDesign(snapshot((x) => ((x.tests[0].generation = 1), (x.correctiveKeep = null))), REQ);
  assert.match(ev.generation.problems.join(' '), /t-2 is live but was made in generation 1/);
});

test('files: a changed body, a different pin, a missing file and a stray file all block', () => {
  const ev = evaluateDesign(
    snapshot((x) => {
      x.tests[0].file!.bodyMatches = false;
      x.tests[1].file!.basePin = 'sha256:' + 'e'.repeat(64);
      x.tests[2].file = null;
      x.strayTestFiles = [{ path: '.testmuai/tests/old_test.md', sha256: 's', id: 't-1' }];
    }),
    REQ,
  );
  assert.equal(ev.files.problems.length, 4);
});

test('gaps: never dropped; a reference to a superseded or unknown item is stale', () => {
  const ev = evaluateDesign(
    snapshot((x) => {
      x.gaps = [
        { ...base(c(31), 'gap-1'), label: 'gap', kind: 'incomplete', header: 'Application URL', prompt: '?', ref: 'sc-1', refState: 'superseded', refCid: c(40), risk: 'high' },
        { ...base(c(32), 'gap-2'), label: 'gap', kind: 'incomplete', header: 'X', prompt: '?', ref: 'zz-9', refState: 'unknown', refCid: null, risk: null },
        { ...base(c(33), 'gap-3'), label: 'gap', kind: 'incomplete', header: 'Y', prompt: '?', ref: 'sc-2', refState: 'live', refCid: c(11), risk: null },
      ];
    }),
    REQ,
  );
  assert.deepEqual(ev.gaps.map((g) => [g.slug, g.stale]), [['gap-1', true], ['gap-2', true], ['gap-3', false]]);
});

test('decisions: a decision is stale when what it was made on no longer matches its fingerprint', () => {
  const entry = { id: 'r1', at: '', by: 'kaneverity-design-review', reviewer: 'r', kind: 'test', target: c(21), decision: 'approved', reason: null, ucCid: c(99), designSnapshot: 1, binding: { a: 1 }, bindingSha256: 'ffd3ea3b8b6eba1d6e5bf3a8fcd5b84f5c0d7d6a3d1e6e1f4f3fbf1dd3c1c2a0' } as DesignReviewEntry;
  assert.equal(decisionStatus([entry], 'test', c(21), { a: 1 }).stale, true, 'a hash that does not match the binding is stale');
  assert.equal(decisionStatus([], 'test', c(21), { a: 1 }).state, 'none');
});

/** Every pre-execution input satisfied, for a complete three-pair design. */
function readyInput(alter: (i: PreExecutionInput) => void = () => {}): PreExecutionInput {
  const ok = { state: 'approved' as const, stale: false, entryId: 'x', at: '', reason: null };
  const ack = { ...ok, state: 'acknowledged' as const };
  const i: PreExecutionInput = {
    integrityOk: true,
    integrityProblems: [],
    fresh: { ok: true, reason: '' },
    useCase: { eligible: true, reasons: [] },
    ev: evaluateDesign(snapshot(), REQ),
    statuses: [
      ...['O1', 'O2', 'O3'].map((o) => ({ kind: 'mapping' as const, target: o, label: `Mapping ${o}`, status: ok, required: 'approved' as const })),
      { kind: 'ac', target: c(1), label: 'Criterion ac-1', status: ok, required: 'approved' },
      { kind: 'test', target: c(21), label: 'Test t-2', status: ok, required: 'approved' },
      { kind: 'gap', target: c(31), label: 'Gap gap-1', status: ack, required: 'acknowledged' },
    ],
    appUrl: { status: { ...ok, value: 'http://127.0.0.1:5174' }, proposed: 'http://127.0.0.1:5174', runFileValue: 'http://127.0.0.1:5174' },
    kaneApprovals: [
      { label: 'Criterion ac-1', ok: true, reason: '' },
      { label: 'Test t-2', ok: true, reason: '' },
    ],
    dryRun: { ok: true, reason: '' },
    busy: null,
  };
  alter(i);
  return i;
}
const gate = (i: PreExecutionInput, id: string) => computeReadiness(i).items.find((x) => x.id === id)!;

test('pre-execution: a fully approved design with no run evidence is ready (evidence is checked after the run, not before)', () => {
  const r = computeReadiness(readyInput());
  assert.equal(r.ready, true, r.items.filter((x) => !x.ok).map((x) => `${x.id}: ${x.reason}`).join(' | '));
  assert.equal(r.items.some((x) => x.id === 'evidence'), false, 'run-time evidence is not a pre-execution gate');
});

test('pre-execution: a missing or rejected Kane approval, an unwritten app_url, a failed dry run, staleness or an unresolved job each block', () => {
  let i = readyInput((x) => (x.kaneApprovals[1] = { label: 'Test t-2', ok: false, reason: 'the approval has not been written to Kane' }));
  assert.equal(computeReadiness(i).ready, false);
  assert.match(gate(i, 'kane_approvals').reason, /Test t-2: the approval has not been written to Kane/);
  i = readyInput((x) => (x.statuses[4] = { ...x.statuses[4], status: { ...x.statuses[4].status, state: 'rejected' } }));
  assert.equal(gate(i, 'reviews').ok, false);
  i = readyInput((x) => (x.appUrl.runFileValue = null));
  assert.match(gate(i, 'app_url').reason, /run variables file/);
  i = readyInput((x) => (x.appUrl.status = { state: 'none', stale: false, entryId: null, at: null, reason: null }));
  assert.match(gate(i, 'app_url').reason, /has not been approved/);
  i = readyInput((x) => (x.dryRun = { ok: false, reason: 'Unresolved variables: app_url.' }));
  assert.equal(computeReadiness(i).ready, false);
  assert.match(gate(i, 'dry_run').reason, /app_url/);
  i = readyInput((x) => (x.statuses[0] = { ...x.statuses[0], status: { ...x.statuses[0].status, stale: true } }));
  assert.match(gate(i, 'mapping').reason, /Mapping O1: the approved decision is stale/);
  i = readyInput((x) => (x.fresh = { ok: false, reason: 'The requirements are no longer current for the documentation.' }));
  assert.equal(gate(i, 'fresh').ok, false);
  i = readyInput((x) => (x.busy = 'Test run x1 ended without a known result. Reconcile it first.'));
  assert.match(gate(i, 'idle').reason, /Reconcile it first/);
  i = readyInput((x) => (x.ev = evaluateDesign(snapshot((s) => (s.tests[0].file!.bodyMatches = false)), REQ)));
  assert.equal(gate(i, 'files').ok, false, 'a stale test-file fingerprint blocks');
});

test("supersessions: only reasons Kane's committer writes, or KaneVerity's own evolve instruction, are recognised", () => {
  const ins = 'Design exactly three scenario/test pairs for uc-1.';
  // Kane's own reasons (0.10.5 committer).
  for (const r of [
    '--force redesign of uc-1 by design-agent',
    '--force redesign of uc-1 by design-agent (reuse_of successor)',
    '--force redesign of uc-1 by design-agent (title-matched successor)',
    '--force redesign of uc-1 by design-agent (same-criteria successor)',
    '--force redesign of uc-1 by design-agent (paired test successor)',
    'AC re-emitted with changed content by design-agent (text-matched successor)',
    'orphaned: its scenario sc-2 was retired; retired with it by the redesign of uc-1 (design-agent)',
    // An evolve: KaneVerity's own instruction as the reason, with or without a Kane tag.
    `${ins} — evolve by design-agent`,
    `${ins} — evolve by design-agent (AC text-matched successor)`,
    `${ins} — evolve by design-agent (orphaned criterion)`,
  ])
    assert.equal(recognisedSupersession(r, [ins]), true, r);
  // Anything else is not.
  for (const r of [
    '',
    'cleaned up by hand',
    '--force redesign of uc-1 by design-agent (made up successor)',
    '--force redesign of uc-1 by design-agent (reuse_of successor) and more',
    `${ins} — evolve by design-agent (made up successor)`,
    `Another instruction — evolve by design-agent`,
    `${ins} - evolve by design-agent`,
    `${ins} — evolve by design agent`,
  ])
    assert.equal(recognisedSupersession(r, [ins]), false, r);
  // Without a recorded KaneVerity instruction, no evolve reason is recognised.
  assert.equal(recognisedSupersession(`${ins} — evolve by design-agent`, []), false);
});

test('a supersession that is not recognised blocks the design generation', () => {
  const ev = evaluateDesign(snapshot((x) => (x.supersessions = [{ seq: 10, label: 'test', old: 't-1', next: null, reason: 'exec-supersede of an edited file', recognised: false }])), REQ);
  assert.equal(ev.generation.ok, false);
  assert.match(ev.generation.problems.join(' '), /Record #10 superseded test t-1 for a reason KaneVerity does not recognise \("exec-supersede of an edited file"\)/);
  const ok = evaluateDesign(snapshot((x) => (x.supersessions = [{ seq: 8, label: 'scenario', old: 'sc-1', next: 'sc-2', reason: '--force redesign of uc-1 by design-agent (reuse_of successor)', recognised: true }])), REQ);
  assert.equal(ok.generation.problems.some((p) => /does not recognise/.test(p)), false);
});
