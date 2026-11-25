// B5 post-execution verification: independent, DOM-evidenced assertions for O1, O2 and O3 from a
// Kane evidence pack (0.10.5 shape, including logs/0-actions.ndjson). Pure; packs built in memory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeZip } from './helpers.ts';
import { analyzeAction, assertionOp, buildPack, goodMembers, LOCATORS, type PackMember } from './design-fixture.ts';
import { requirementFor, verifyPack, type OutcomeTarget } from '../src/assurance/runEvidence.ts';

const ORIGIN = 'http://127.0.0.1:5174';
const defs = { message: 'sha256:' + '1'.repeat(64), list: 'sha256:' + '2'.repeat(64), count: 'sha256:' + '3'.repeat(64) };
const c = (n: number) => 'sha256:' + String(n).padStart(64, '0');
const TARGETS: OutcomeTarget[] = [
  { outcome: 'O1', outcomeText: "The message 'API key generated successfully.' appears.", labels: ['API key generated successfully.'], acCid: c(3), acSlug: 'ac-3', testCid: c(21), testSlug: 't-2', definitionId: defs.message },
  { outcome: 'O2', outcomeText: 'The new key is added to the API keys list.', labels: [], acCid: c(1), acSlug: 'ac-1', testCid: c(22), testSlug: 't-3', definitionId: defs.list },
  { outcome: 'O3', outcomeText: "The key count below the list shows '2 keys'.", labels: ['2 keys'], acCid: c(2), acSlug: 'ac-2', testCid: c(23), testSlug: 't-4', definitionId: defs.count },
];
const pack = (alter: (m: PackMember[]) => void = () => {}, opts: { runStatus?: string; producerVersion?: string; surfaces?: string[]; runKind?: string } = {}) => {
  const members = goodMembers(defs, ORIGIN);
  alter(members);
  return buildPack({ members, appOrigin: ORIGIN, ...opts }, makeZip);
};
const verify = (buf: Buffer, requireReplay = true) => verifyPack(buf, { appOrigin: ORIGIN, pinnedVersion: '0.10.5', targets: TARGETS, requireReplay });
const why = (r: ReturnType<typeof verify>, i: number) => r.outcomes[i].problems.join(' | ');

test('the requirement of each outcome follows from how the documentation states it', () => {
  assert.deepEqual(TARGETS.map((t) => requirementFor(t.outcomeText, t.labels)), ['status_region', 'baseline_change', 'element_value']);
});

test('three independent assertions with DOM-read values satisfy verification', () => {
  const r = verify(pack());
  assert.equal(r.packOk, true, r.problems.join(' '));
  assert.equal(r.verified, true, JSON.stringify(r.outcomes.map((o) => o.problems)));
  assert.deepEqual(r.outcomes.map((o) => [o.outcome, o.basis]), [['O1', 'dom_value'], ['O2', 'dom_baseline_change'], ['O3', 'dom_value']]);
  assert.equal(r.outcomes[0].evidence!.locator, LOCATORS.status);
  assert.deepEqual(r.outcomes[1].evidence!.baseline, { locator: LOCATORS.list, logFile: '0-actions.ndjson', beforeStep: 3, before: ['demo_fake_key_0001'], afterStep: 5, after: ['demo_fake_key_0001', 'demo_fake_key_0002'], added: ['demo_fake_key_0002'] });
  assert.equal(r.outcomes[2].evidence!.observed, '2 keys');
});

test('a verification run must be a pure replay: an authoring run verifies nothing', () => {
  const r = verify(pack(undefined, { runKind: 'author' }));
  assert.equal(r.verified, false);
  assert.match(r.problems.join(' '), /not a pure replay \(run_kind: author\)/);
  assert.equal(verify(pack(undefined, { runKind: 'author' }), false).verified, true, 'the same evidence is complete; only the replay rule refuses it');
});

test('O1: a yes/no check, a text locator or a region that is not a status region cannot pass', () => {
  // The real 0.10.5 shape: a boolean DOM comparison found by the message's own text.
  let r = verify(pack((m) => {
    m[0].ops = [assertionOp('m-5', 'success_message', 'true', 'true')];
    m[0].actions = [analyzeAction(5, 'success_message', 'true', "el(23).innerText.trim() === 'API key generated successfully.'", ['internal:text="API key generated"i'])];
  }));
  assert.equal(r.outcomes[0].verified, false);
  assert.match(why(r, 0), /yes\/no result/);
  r = verify(pack((m) => (m[0].actions = [analyzeAction(5, 'success_message', 'API key generated successfully.', 'el(23).innerText.trim()', ['internal:text="API key generated"i'])])));
  assert.match(why(r, 0), /located by its text/);
  r = verify(pack((m) => (m[0].actions = [analyzeAction(5, 'success_message', 'API key generated successfully.', 'el(23).innerText.trim()', ['internal:testid=[data-testid="api-key-status"s]'])])));
  assert.match(why(r, 0), /not read from a status region/);
  r = verify(pack((m) => {
    m[0].ops = [assertionOp('m-5', 'success_message', 'API key generated', 'API key generated')];
    m[0].actions = [analyzeAction(5, 'success_message', 'API key generated', 'el(23).innerText.trim()', [LOCATORS.status])];
  }));
  assert.match(why(r, 0), /is not exactly 'API key generated successfully\.'/);
  assert.equal(r.verified, false);
});

const ROWS = "Array.from(el(25).querySelectorAll('tbody tr')).map((r) => r.cells[1].innerText.trim()).join('\\n')";
const NEW_KEY = "Array.from(el(25).querySelectorAll('tbody tr')).pop().cells[1].innerText.trim()";
/** O2 with these list reads (before at step 3, the asserted new key and the after read at step 5). */
const o2 = (actions: Record<string, unknown>[], otherLogs?: PackMember['otherLogs']) =>
  verify(pack((m) => {
    m[1].actions = actions;
    if (otherLogs) m[1].otherLogs = otherLogs;
  }));
const before = (v: string, step = 3, loc = LOCATORS.list, key = 'keys_before') => analyzeAction(step, key, v, ROWS, [loc]);
const after = (v: string, step = 5, loc = LOCATORS.list, key = 'keys_after') => analyzeAction(step, key, v, ROWS, [loc]);
const newKey = (v = 'demo_fake_key_0002') => analyzeAction(5, 'new_key', v, NEW_KEY, [LOCATORS.list]);

test('O2: a new key, with every earlier key still listed, passes (JSON or one key per line)', () => {
  let r = o2([before('demo_fake_key_0001'), newKey(), after('demo_fake_key_0001\ndemo_fake_key_0002')]);
  assert.equal(r.outcomes[1].verified, true, why(r, 1));
  r = o2([before('["demo_fake_key_0001","demo_fake_key_0003"]'), newKey(), after('["demo_fake_key_0003","demo_fake_key_0001","demo_fake_key_0002"]')]);
  assert.equal(r.outcomes[1].verified, true, why(r, 1));
  assert.deepEqual(r.outcomes[1].evidence!.baseline!.added, ['demo_fake_key_0002']);
  // Two before reads (or two after reads) that agree are fine.
  r = o2([before('demo_fake_key_0001', 2, LOCATORS.list, 'keys_0'), before('demo_fake_key_0001'), newKey(), after('demo_fake_key_0001\ndemo_fake_key_0002')]);
  assert.equal(r.outcomes[1].verified, true, why(r, 1));
});

test('O2: a changed list that loses an earlier key, or an unchanged list, cannot pass', () => {
  let r = o2([before('demo_fake_key_0001'), newKey(), after('demo_fake_key_0002')]);
  assert.equal(r.outcomes[1].verified, false);
  assert.match(why(r, 1), /keys from before the action are missing afterwards \("demo_fake_key_0001"\)/);
  r = o2([before('demo_fake_key_0001\ndemo_fake_key_0002'), newKey(), after('demo_fake_key_0001\ndemo_fake_key_0002')]);
  assert.match(why(r, 1), /the list is unchanged after the action/);
  r = o2([before('demo_fake_key_0001'), newKey('demo_fake_key_0009'), after('demo_fake_key_0001\ndemo_fake_key_0002')]);
  assert.match(why(r, 1), /action log's value|not one of the keys added/);
  r = verify(pack((m) => {
    m[1].ops = [assertionOp('l-5', 'new_key', 'demo_fake_key_0001', 'demo_fake_key_0001')];
    m[1].actions = [before('demo_fake_key_0001'), newKey('demo_fake_key_0001'), after('demo_fake_key_0001\ndemo_fake_key_0002')];
  }));
  assert.match(why(r, 1), /already in the list before the action/);
});

test('O2: missing, malformed, ambiguous or incomplete before/after evidence cannot pass', () => {
  let r = o2([newKey(), after('demo_fake_key_0001\ndemo_fake_key_0002')]);
  assert.match(why(r, 1), /no full read of the same list .* before step 5/);
  r = o2([before('demo_fake_key_0001'), newKey()]);
  assert.match(why(r, 1), /no full read of the same list .* after the action/);
  r = o2([before('demo_fake_key_0001', 6), newKey(), after('demo_fake_key_0001\ndemo_fake_key_0002')]);
  assert.match(why(r, 1), /lost|missing afterwards|disagree|no full read/, 'a "before" read after the new value is not a before read');
  for (const bad of ['', '   ', '[1, 2]', '["a", ""]', 'demo_fake_key_0001\ndemo_fake_key_0001', '{"keys": []}', '[not json']) {
    r = o2([before(bad), newKey(), after('demo_fake_key_0001\ndemo_fake_key_0002')]);
    assert.equal(r.outcomes[1].verified, false, bad);
    assert.match(why(r, 1), /empty, malformed or repeats a key|no full read/, bad);
  }
  r = o2([before('demo_fake_key_0001'), newKey(), after('demo_fake_key_0001\ndemo_fake_key_0002\ndemo_fake_key_0002')]);
  assert.match(why(r, 1), /malformed or repeats a key/);
  r = o2([before('demo_fake_key_0001', 2, LOCATORS.list, 'keys_0'), before('demo_fake_key_0003'), newKey(), after('demo_fake_key_0001\ndemo_fake_key_0002')]);
  assert.match(why(r, 1), /before the action disagree/);
  r = o2([before('demo_fake_key_0001'), newKey(), after('demo_fake_key_0001\ndemo_fake_key_0002'), after('demo_fake_key_0001', 6, LOCATORS.list, 'keys_later')]);
  assert.match(why(r, 1), /after the action disagree/);
  // Presence alone (a yes/no) is not the new value.
  r = verify(pack((m) => {
    m[1].ops = [assertionOp('l-5', 'new_key', 'true', 'true')];
    m[1].actions = [before('demo_fake_key_0001'), analyzeAction(5, 'new_key', 'true', NEW_KEY, [LOCATORS.list]), after('demo_fake_key_0001\ndemo_fake_key_0002')];
  }));
  assert.match(why(r, 1), /yes\/no or empty result/);
});

test('O2: before/after reads of a different list, or from a different execution, cannot pass', () => {
  const other = 'internal:role=table[name="Other"i]';
  let r = o2([before('demo_fake_key_0001', 3, other), newKey(), after('demo_fake_key_0001\ndemo_fake_key_0002')]);
  assert.match(why(r, 1), /no full read of the same list .* before step 5/);
  r = o2([before('demo_fake_key_0001'), newKey(), after('demo_fake_key_0001\ndemo_fake_key_0002', 5, other)]);
  assert.match(why(r, 1), /no full read of the same list .* after the action/);
  // The before read only in another execution's action log (logs/1-actions.ndjson).
  r = o2([newKey(), after('demo_fake_key_0001\ndemo_fake_key_0002')], { '1-actions.ndjson': [before('demo_fake_key_0001')] });
  assert.equal(r.outcomes[1].verified, false);
  assert.match(why(r, 1), /exists only in another execution's log/);
  r = o2([before('demo_fake_key_0001'), newKey()], { '1-actions.ndjson': [after('demo_fake_key_0001\ndemo_fake_key_0002')] });
  assert.match(why(r, 1), /after the action in the same execution/);
});

test('O3: only the exact count read from a structurally located element passes', () => {
  let r = verify(pack((m) => {
    m[2].ops = [assertionOp('c-5', 'api_keys_count', '2 keys', '3 keys', true)];
    m[2].actions = [analyzeAction(5, 'api_keys_count', '3 keys', 'el(41).innerText.trim()', [LOCATORS.count])];
  }));
  assert.match(why(r, 2), /not exactly '2 keys'/);
  r = verify(pack((m) => (m[2].actions = [analyzeAction(5, 'api_keys_count', '2 keys', 'el(41).innerText.trim()', ['internal:text="2 keys"'])])));
  assert.match(why(r, 2), /located by its text/);
  r = verify(pack((m) => (m[2].actions = [analyzeAction(5, 'api_keys_count', '2 keys', 'return "2 keys"', [LOCATORS.count])])));
  assert.match(why(r, 2), /does not read the element's text/);
});

test("the action log must agree with the assertion, and a step's status or tag is never enough", () => {
  let r = verify(pack((m) => (m[2].actions = [analyzeAction(5, 'api_keys_count', '1 key', 'el(41).innerText.trim()', [LOCATORS.count])])));
  assert.match(why(r, 2), /action log's value .* differs from the assertion's/);
  r = verify(pack((m) => (m[2].actions = [])));
  assert.match(why(r, 2), /no analyzer action in the action log/);
  r = verify(pack((m) => (m[0].ops = [])));
  assert.match(why(r, 0), /has no ASSERTION record/);
  r = verify(pack((m) => (m[2].actions = [analyzeAction(5, 'api_keys_count', '2 keys', '', [LOCATORS.count])])));
  assert.match(why(r, 2), /not read by a successful DOM operation/);
  r = verify(pack((m) => (m[2].actions = [analyzeAction(5, 'api_keys_count', '2 keys', 'el(41).innerText.trim()', [])])));
  assert.match(why(r, 2), /without a recorded locator/);
});

test('evidence must be tied to the exact approved test and criterion, one test per outcome', () => {
  let r = verify(pack((m) => (m[0].definitionId = 'sha256:' + 'f'.repeat(64))));
  assert.match(why(r, 0), /No evidence for test t-2 as approved/);
  r = verify(pack((m) => (m[0].steps[4].verifies = ['ac-3', 'ac-1'])));
  assert.match(why(r, 0), /also carries steps tagged with other criteria/);
  r = verify(pack((m) => (m[0].steps[4].verifies = ['ac-1'])));
  assert.match(why(r, 0), /No step of test t-2 is tagged in the evidence with ac-3/);
  r = verify(pack((m) => (m[0].status = 'failed')));
  assert.match(why(r, 0), /did not pass/);
});

test('the pack itself must be finalized, from the pinned Kane, and stay on the application origin', () => {
  assert.match(verify(pack(undefined, { runStatus: 'open' })).problems.join(' '), /not finalized/);
  assert.match(verify(pack(undefined, { producerVersion: '0.10.8' })).problems.join(' '), /not produced by kane-cli 0\.10\.5/);
  assert.match(verify(pack(undefined, { surfaces: ['https://elsewhere.example/'] })).problems.join(' '), /unexpected origin/);
  const r = verify(pack((m) => (m[1].steps[0].url = 'https://elsewhere.example/login')));
  assert.equal(r.packOk, false);
  assert.equal(r.verified, false);
  assert.equal(verify(Buffer.from('not a zip')).verified, false);
});
