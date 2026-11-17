import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, type ClassifyInput } from '../src/verify/classify.ts';
import { API_KEY_OUTCOMES, loadFixture, OUTDATED_API_KEY_STEPS, tutorial, type Fixture } from './helpers.ts';
import type { Tutorial } from '../src/types.ts';

function fromFixture(f: Fixture, t: Tutorial, overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    tutorial: t,
    appOrigin: f.appOrigin,
    preflight: { ok: true },
    exitCode: f.exitCode,
    runEnd: f.runEnd,
    progress: f.progress,
    evidenceSteps: f.evidenceSteps,
    failureMessage: f.failureMessage,
    ...overrides,
  };
}

// ---- Real (sanitized) Kane runs ----

test('real: spike example.com run with an explicit title assertion -> PASSED', () => {
  const f = loadFixture('spike-example-pass');
  const t = tutorial(["Go to the home page."], ["the page title contains 'Example'"]);
  const c = classify(fromFixture(f, t));
  assert.equal(c.status, 'PASSED');
  assert.equal(c.outcomeResults[0].status, 'passed');
});

test('real: spike localhost correct path with a confirmation assertion -> PASSED', () => {
  const f = loadFixture('spike-local-correct');
  const t = tutorial(["On the Dashboard, click 'Developer Settings'.", "Click 'API Keys'.", "Click 'Generate Key'."], ['a message confirming that an API key was generated is visible']);
  const c = classify(fromFixture(f, t));
  assert.equal(c.status, 'PASSED');
});

test('real: spike localhost outdated path -> FAILED at documented step 1 (curly quotes in Kane reason)', () => {
  const f = loadFixture('spike-local-outdated');
  const c = classify(fromFixture(f, tutorial(OUTDATED_API_KEY_STEPS, ['a message confirming that an API key was generated is visible'])));
  assert.equal(c.status, 'FAILED');
  assert.equal(c.failedStep, 1);
  assert.equal(c.documentationDefect, true);
  assert.deepEqual(c.stepResults.map((s) => s.status), ['failed', 'not_reached', 'not_reached']);
});

test('real: Step 2 run that clicked through WITHOUT asserting the outcome -> NEEDS_REVIEW, never PASSED', () => {
  const f = loadFixture('acmedesk-apikey-no-asserts');
  const t = tutorial(["On the 'Dashboard', click 'Developer Settings'.", "Click 'API Keys'.", "Click 'Generate Key'."], ["The message 'API key generated successfully' is visible."]);
  const c = classify(fromFixture(f, t));
  assert.equal(f.exitCode, 0);
  assert.equal(f.runEnd.status, 'passed');
  assert.equal(c.status, 'NEEDS_REVIEW');
  assert.equal(c.code, 'outcomes_not_proven');
  assert.equal(c.outcomeResults[0].status, 'not_checked');
});

test('real: AcmeDesk outdated API-key path -> FAILED at step 1 (documentation defect)', () => {
  const f = loadFixture('acmedesk-apikey-outdated');
  const c = classify(fromFixture(f, tutorial(OUTDATED_API_KEY_STEPS, API_KEY_OUTCOMES)));
  assert.equal(c.status, 'FAILED');
  assert.equal(c.code, 'doc_step_not_achievable');
  assert.equal(c.failedStep, 1);
  assert.equal(c.documentationDefect, true);
});

test('real: AcmeDesk run with five passing assertions -> PASSED, each outcome matched to a distinct assertion', () => {
  const f = loadFixture('acmedesk-apikey-asserted');
  const outcomes = [
    'the API keys count on the Dashboard is 1',
    "the text '1 key' is shown below the keys table",
    "the message 'API key generated successfully' is visible",
    "the keys table contains a row with the key 'demo_fake_key_0002'",
    "the text '2 keys' is shown below the keys table",
  ];
  const t = tutorial(["On the 'Dashboard', click 'Developer Settings'.", "Click 'API Keys'.", "Click 'Generate Key'."], outcomes);
  const c = classify(fromFixture(f, t));
  assert.equal(c.status, 'PASSED');
  const queries = c.outcomeResults.map((r) => r.assertion?.query);
  assert.equal(new Set(queries).size, 5, 'each outcome must map to a different assertion');
  assert.ok(c.outcomeResults.every((r) => r.status === 'passed'));
});

test('real: passing run missing one documented outcome check -> NEEDS_REVIEW', () => {
  const f = loadFixture('acmedesk-apikey-asserted');
  const t = tutorial(["Click 'Generate Key'."], ["the message 'API key generated successfully' is visible", "the audit log shows 'Key created by admin'"]);
  const c = classify(fromFixture(f, t));
  assert.equal(c.status, 'NEEDS_REVIEW');
  assert.equal(c.outcomeResults[1].status, 'not_checked');
});

// ---- Create a project: assertion mapping (synthetic memory records) ----

const CREATE_STEPS = ["On the 'Dashboard', click 'Projects' in the sidebar.", "Click 'New project'.", "In 'Project name', enter 'Docs Demo Project'.", "Click 'Create project'."];
const CREATE_OUTCOMES = ["The message 'Project \"Docs Demo Project\" created.' appears.", "'Docs Demo Project' is listed in the projects table."];

function passingRun(memory: Record<string, { query?: string; condition?: string; reasoning?: string; extracted_value?: unknown }>, evidenceAsserts: string[] = []): ClassifyInput {
  const app = 'http://127.0.0.1:5174';
  return {
    tutorial: tutorial(CREATE_STEPS, CREATE_OUTCOMES, 'create-a-project'),
    appOrigin: app,
    preflight: { ok: true },
    exitCode: 0,
    runEnd: { type: 'run_end', status: 'passed', reason_code: 'success.complete', context: { memory } },
    progress: [],
    evidenceSteps: evidenceAsserts.map((s, i) => ({ ordinal: i + 1, id: `0-${i + 1}`, kind: 'assert', status: 'passed', summary: `assert: ${s}`, url: `${app}/projects` })),
  };
}

const MSG = { query: "whether the message 'Project \"Docs Demo Project\" created.' is visible", condition: "the message 'Project \"Docs Demo Project\" created.' appears", reasoning: "value: 'true'; equals 'true' -> PASS", extracted_value: 'true' };
const ROW = { query: "whether 'Docs Demo Project' is listed in the projects table", condition: "'Docs Demo Project' is listed in the projects table", reasoning: "value: 'true'; equals 'true' -> PASS", extracted_value: 'true' };

test('create-a-project: two distinct passing assertions -> PASSED, one per outcome', () => {
  const c = classify(passingRun({ msg: MSG, row: ROW }));
  assert.equal(c.status, 'PASSED');
  assert.match(c.outcomeResults[0].assertion!.query, /created/);
  assert.match(c.outcomeResults[1].assertion!.query, /projects table/);
});

test('create-a-project: only the message was asserted -> NEEDS_REVIEW (the table outcome is not proven by the message check)', () => {
  const c = classify(passingRun({ msg: MSG }));
  assert.equal(c.status, 'NEEDS_REVIEW');
  assert.equal(c.outcomeResults[0].status, 'passed');
  assert.equal(c.outcomeResults[1].status, 'not_checked');
});

test('create-a-project: memory + duplicate evidence assert steps are never combined to fake a second proof', () => {
  // One real check, recorded both in memory and as an evidence assert step.
  const c = classify(passingRun({ msg: MSG }, [MSG.condition]));
  assert.equal(c.status, 'NEEDS_REVIEW');
  assert.ok(c.matchingNotes.some((n) => /Assertion source: 1 Kane memory record/.test(n)));
});

test('create-a-project: message asserted without its exact text -> NEEDS_REVIEW', () => {
  const loose = { ...MSG, query: 'whether a project created confirmation is visible', condition: 'a confirmation that the project was created appears' };
  assert.equal(classify(passingRun({ msg: loose, row: ROW })).status, 'NEEDS_REVIEW');
});

test('create-a-project: two equally good assertions for one outcome (tie) -> NEEDS_REVIEW', () => {
  assert.equal(classify(passingRun({ msg: MSG, msg2: { ...MSG }, row: ROW })).status, 'NEEDS_REVIEW');
});

test('create-a-project: a matched assertion that did not pass -> NEEDS_REVIEW, not PASSED', () => {
  const c = classify(passingRun({ msg: MSG, row: { ...ROW, reasoning: "value: 'false'; equals 'true' -> FAIL" } }));
  assert.equal(c.status, 'NEEDS_REVIEW');
  assert.equal(c.outcomeResults[1].status, 'failed');
});

// ---- Synthetic edge cases ----

const outdated = () => fromFixture(loadFixture('acmedesk-apikey-outdated'), tutorial(OUTDATED_API_KEY_STEPS, API_KEY_OUTCOMES));

test('app unreachable before the run -> BLOCKED, not a defect', () => {
  const c = classify({ ...outdated(), preflight: { ok: false, detail: 'connection failed' } });
  assert.equal(c.status, 'BLOCKED');
  assert.equal(c.documentationDefect, false);
});

test('exit code 2 (auth/setup) -> BLOCKED', () => {
  const c = classify({ ...outdated(), exitCode: 2 });
  assert.equal(c.status, 'BLOCKED');
});

test('exit code 3 (timeout) -> BLOCKED', () => assert.equal(classify({ ...outdated(), exitCode: 3 }).status, 'BLOCKED'));
test('cancelled -> BLOCKED', () => assert.equal(classify({ ...outdated(), cancelled: true }).status, 'BLOCKED'));
test('Kane could not start -> BLOCKED', () => assert.equal(classify({ ...outdated(), spawnError: 'ENOENT' }).status, 'BLOCKED'));
test('no run_end -> BLOCKED', () => assert.equal(classify({ ...outdated(), runEnd: null }).status, 'BLOCKED'));

test('browser error page -> BLOCKED', () => {
  const i = outdated();
  const c = classify({ ...i, evidenceSteps: [{ ...i.evidenceSteps[0], url: 'chrome-error://chromewebdata/' }] });
  assert.equal(c.status, 'BLOCKED');
});

test('exit 0 but status failed -> NEEDS_REVIEW (inconsistent)', () => {
  const c = classify({ ...outdated(), exitCode: 0 });
  assert.equal(c.status, 'NEEDS_REVIEW');
  assert.equal(c.code, 'inconsistent_result');
});

test('non-assertion failure reason (automation problem) -> NEEDS_REVIEW', () => {
  const i = outdated();
  const c = classify({ ...i, runEnd: { ...i.runEnd!, reason_code: 'execution_error.element_not_interactable' } });
  assert.equal(c.status, 'NEEDS_REVIEW');
  assert.equal(c.code, 'failure_not_assertion');
});

test('failure that names two documented steps equally -> NEEDS_REVIEW with notes kept', () => {
  const i = outdated();
  const t = tutorial(["Click 'Settings'.", "Click 'Settings'."], API_KEY_OUTCOMES);
  const c = classify({ ...i, tutorial: t });
  assert.equal(c.status, 'NEEDS_REVIEW');
  assert.equal(c.code, 'failure_not_attributable');
  assert.ok(c.matchingNotes.some((n) => /attribution scores/.test(n)));
});

test('failure naming no documented label -> NEEDS_REVIEW', () => {
  const i = outdated();
  const t = tutorial(["Click 'Billing'.", "Click 'Invoices'."], API_KEY_OUTCOMES);
  assert.equal(classify({ ...i, tutorial: t }).status, 'NEEDS_REVIEW');
});

test('label match contradicted by how far Kane got -> NEEDS_REVIEW', () => {
  const i = outdated();
  const extra = [1, 2, 3].map((n) => ({ ordinal: 10 + n, id: `x${n}`, kind: 'click', status: 'passed', summary: 'click: something', url: 'http://127.0.0.1:5174/' }));
  const c = classify({ ...i, evidenceSteps: [...extra, ...i.evidenceSteps] });
  assert.equal(c.status, 'NEEDS_REVIEW');
  assert.equal(c.code, 'failure_position_mismatch');
});

test('visit outside the app origin on a passing run -> NEEDS_REVIEW', () => {
  const f = loadFixture('acmedesk-apikey-asserted');
  const steps = f.evidenceSteps.map((s, k) => (k === 3 ? { ...s, url: 'https://evil.example/' } : s));
  const t = tutorial(["Click 'Generate Key'."], ["the message 'API key generated successfully' is visible"]);
  const c = classify(fromFixture(f, t, { evidenceSteps: steps }));
  assert.equal(c.status, 'NEEDS_REVIEW');
  assert.equal(c.code, 'left_app_origin');
});

test('failed expected-outcome assertion mapped to one outcome -> FAILED (outcome not met)', () => {
  const i = outdated();
  const evidenceSteps = [
    { ordinal: 1, id: '0-1', kind: 'navigate', status: 'passed', summary: 'navigate', url: 'http://127.0.0.1:5174/' },
    { ordinal: 2, id: '0-2', kind: 'assert', status: 'failed', summary: "assert: the key count shows '2 keys'", url: 'http://127.0.0.1:5174/developer/api-keys' },
  ];
  const c = classify({ ...i, evidenceSteps, runEnd: { ...i.runEnd!, reason: "Expected '2 keys' but saw '1 key'.", reason_code: 'assertion_error.assertion_failed' } });
  assert.equal(c.status, 'FAILED');
  assert.equal(c.code, 'doc_outcome_not_met');
  assert.equal(c.failedOutcome, 3);
});
