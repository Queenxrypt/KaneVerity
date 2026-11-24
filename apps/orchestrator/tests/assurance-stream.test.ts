// Assurance B2 units: the NDJSON stream parser (built from the documented 0.10.5
// examples), outcome rules, allow-listed commands, answer validation and the lock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeOf, parseAssuranceStream } from '../src/assurance/stream.ts';
import { buildArgs, parseBalance, parseIngestReceipt, sourceIdFor, validateAnswers } from '../src/assurance/commands.ts';
import { KaneLock } from '../src/kane/lock.ts';
import { DOC_PAUSE, DOC_RESUME } from './fixtures/assurance-docs.ts';


test('parses the documented pause exchange: questions, options, recommendation, session', () => {
  const s = parseAssuranceStream(DOC_PAUSE.join('\n'));
  assert.equal(s.verb, 'extract');
  assert.equal(s.done?.status, 'paused');
  assert.equal(s.pause?.sid, 'ext-20260716T140742-prd-online-store');
  assert.equal(s.pause?.expiresAt, '2026-07-17T14:07:53Z');
  assert.deepEqual(s.pause?.questions.map((q) => [q.id, q.risk, q.options.map((o) => o.label), q.recommendedIndex, q.allowFreeText]), [['q1', 'high', ['Account required', 'Guest allowed'], 0, true]]);
  assert.deepEqual(outcomeOf(s, 3, false).outcome, 'paused');
  assert.deepEqual(s.unknownTypes, []);
});

test('parses the documented resume: usage credits, commit with minted ids, completion', () => {
  const s = parseAssuranceStream(DOC_RESUME.join('\n'));
  assert.equal(s.credits.lastTotal, 2.45);
  assert.equal(s.credits.sumOfTurns, 2.45);
  assert.deepEqual(s.commits[0].minted.map((m) => m.logicalId), ['uc-create-an-account-to-order']);
  assert.equal(s.commits[0].counts.derived, 5);
  assert.equal(s.sessionComplete, 'ext-20260716T140742-prd-online-store');
  assert.equal(outcomeOf(s, 0, false).outcome, 'complete');
});

test('open vocabulary: unknown events are counted, never fatal; non-JSON prefix tolerated', () => {
  const s = parseAssuranceStream(['landed prd (prd.md) - new source', '{"type":"brand_new_event","v":1,"verb":"extract","x":1}', ...DOC_RESUME].join('\n'));
  assert.equal(s.nonJsonLines, 1, 'a prose prefix before the stream is skipped (documented for older releases)');
  assert.deepEqual(s.unknownTypes, ['brand_new_event']);
  assert.equal(outcomeOf(s, 0, false).outcome, 'complete');
  const broken = parseAssuranceStream([...DOC_RESUME.slice(0, 2), 'garbage after start', ...DOC_RESUME.slice(2)].join('\n'));
  assert.equal(broken.invalidLines, 1, 'a non-JSON line inside the stream is a contract break, recorded');
});

test('outcome rules: no done = crash; exit code must agree; refusals; error codes; held and crash pauses', () => {
  assert.equal(outcomeOf(parseAssuranceStream(DOC_PAUSE.slice(0, 3).join('\n')), 1, false).outcome, 'crashed');
  assert.equal(outcomeOf(parseAssuranceStream(''), 0, false).outcome, 'crashed', 'exit 0 without done is still a crash');
  assert.equal(outcomeOf(parseAssuranceStream(DOC_RESUME.join('\n')), 1, false).outcome, 'error', 'done says 0, process says 1: not trusted');
  assert.equal(outcomeOf(parseAssuranceStream(DOC_RESUME.join('\n')), null, true).outcome, 'interrupted');
  const refused = parseAssuranceStream(['{"type":"error","v":1,"verb":"design","code":"UC_UNREVIEWED","message":"use-case not reviewed"}', '{"type":"done","v":1,"verb":"design","status":"refused","exit_code":2,"next":[{"cmd":"kane-cli context review","why":"review first","title":"Review"},"kane-cli context list"]}'].join('\n'));
  const r = outcomeOf(refused, 2, false);
  assert.equal(r.outcome, 'refused');
  assert.match(r.reason, /UC_UNREVIEWED/);
  assert.deepEqual(refused.done?.next.map((n) => n.cmd), ['kane-cli context review', 'kane-cli context list'], 'next entries in both documented shapes');
  const err = parseAssuranceStream(['{"type":"error","v":1,"verb":"extract","code":"EXTRACT_LOCKED","message":"another extraction is live"}', '{"type":"done","v":1,"verb":"extract","status":"error","exit_code":1}'].join('\n'));
  assert.match(outcomeOf(err, 1, false).reason, /EXTRACT_LOCKED/);
  const crashPause = parseAssuranceStream(['{"type":"session_paused","v":1,"verb":"design","sid":"des-1","resume":"x","crashed":true}', '{"type":"done","v":1,"verb":"design","status":"paused","exit_code":3}'].join('\n'));
  assert.equal(crashPause.pause?.crashed, true);
  assert.equal(outcomeOf(crashPause, 3, false).outcome, 'paused');
  const noSid = parseAssuranceStream('{"type":"done","v":1,"verb":"extract","status":"paused","exit_code":3}');
  assert.equal(outcomeOf(noSid, 3, false).outcome, 'error', 'a pause with no session cannot be resumed');
});

test('malformed questions and options are dropped; a bad recommended index is ignored', () => {
  const s = parseAssuranceStream(
    '{"type":"session_paused","v":1,"verb":"extract","sid":"s1","pending_questions":[{"id":"q1"},{"text":"no id"},{"id":"q2","text":"Pick","options":[{"label":"A"},{"nolabel":1},"x",{"label":"B","input":true}],"recommended_index":7}]}\n{"type":"done","v":1,"verb":"extract","status":"paused","exit_code":3}',
  );
  assert.deepEqual(s.pause?.questions.map((q) => [q.id, q.options.map((o) => [o.label, o.input]), q.recommendedIndex, q.allowFreeText]), [['q2', [['A', false], ['B', true]], null, false]]);
});

// A design job's binding (V2): tutorial, exact content id, decision and self-declared reviewer.
const DESIGN = { kind: 'design' as const, tutorialId: 'generate-an-api-key', ucCid: 'sha256:' + 'd'.repeat(64), reviewer: 'test-reviewer', decisionId: 'd20261124-000000-aaaaaa', acknowledgedPrevious: null };

test('allow-listed commands: exact arguments, validated ids', () => {
  assert.deepEqual(buildArgs({ kind: 'ingest', tutorialId: 'generate-an-api-key' }), ['context', 'ingest', 'requirements/generate-an-api-key.md', '--as', 'kv-generate-an-api-key', '--mode', 'ci', '--local']);
  assert.deepEqual(buildArgs({ kind: 'extract', tutorialId: 'generate-an-api-key' }), ['context', 'extract', '--mode', 'agent', '--local', '--source', 'kv-generate-an-api-key']);
  assert.deepEqual(buildArgs({ ...DESIGN, useCase: 'uc-generate-a-key', max: 1 }), ['design', 'tests', '--use-case', 'uc-generate-a-key', '--mode', 'agent', '--max', '1']);
  // The binding is validated too (it never reaches the argument list).
  assert.throws(() => buildArgs({ ...DESIGN, useCase: 'uc-1', max: 1, ucCid: 'uc-1' }), /content id/);
  assert.throws(() => buildArgs({ ...DESIGN, useCase: 'uc-1', max: 1, reviewer: 'me@example.org' }), /reviewer/);
  assert.throws(() => buildArgs({ ...DESIGN, useCase: 'uc-1', max: 1, tutorialId: '../x' }), /tutorial/);
  assert.deepEqual(buildArgs({ kind: 'resume', verb: 'extract', sid: 'ext-1', answers: [{ id: 'q1', value: '1' }, { id: 'q2', value: 'free words' }] }), ['context', 'extract', '--resume', 'ext-1', '--mode', 'agent', '--answer', 'q1=1', '--answer', 'q2=free words']);
  assert.deepEqual(buildArgs({ kind: 'list', inferred: true }), ['context', 'list', '--json', '--inferred']);
  assert.deepEqual(buildArgs({ kind: 'cover' }), ['cover', '--mode', 'agent']);
  for (const bad of ['../x', 'A', 'a_b', '']) assert.throws(() => sourceIdFor(bad), bad);
  for (const uc of ['uc', '--force', 'uc-x; rm', 'UC-X', 'uc-x --allow-unreviewed']) assert.throws(() => buildArgs({ ...DESIGN, useCase: uc, max: 1 }), uc);
  for (const max of [0, 9, 1.5, NaN]) assert.throws(() => buildArgs({ ...DESIGN, useCase: 'uc-a-b', max }), String(max));
  for (const sid of ['', '--mode', 'a b', 'x'.repeat(200)]) assert.throws(() => buildArgs({ kind: 'resume', verb: 'extract', sid, answers: [] }), sid);
  assert.throws(() => buildArgs({ kind: 'resume', verb: 'extract', sid: 's', answers: [{ id: '--force', value: '1' }] }));
  assert.throws(() => buildArgs({ kind: 'resume', verb: 'reconcile' as never, sid: 's', answers: [] }));
});

test('answers are validated against the questions Kane actually asked', () => {
  const qs = parseAssuranceStream(DOC_PAUSE.join('\n')).pause!.questions;
  assert.deepEqual(validateAnswers(qs, { q1: 1 }, 500), [{ id: 'q1', value: '1' }]);
  assert.deepEqual(validateAnswers(qs, { q1: '  Account required, per the update  ' }, 500), [{ id: 'q1', value: 'Account required, per the update' }]);
  for (const [bad, re] of [
    [{}, /no answer/],
    [{ q1: 3 }, /option from 1 to 2/],
    [{ q1: 0 }, /option from 1 to 2/],
    [{ q1: 1, q9: 1 }, /did not ask/],
    [{ q1: 'two\nlines' }, /single line/],
    [{ q1: 'x'.repeat(501) }, /longer than 500/],
    [{ q1: '   ' }, /empty/],
    [{ q1: [1] }, /unsupported/],
    [null, /must be an object/],
  ] as [unknown, RegExp][]) {
    assert.throws(() => validateAnswers(qs, bad, 500), re, JSON.stringify(bad));
  }
  const strict = [{ ...qs[0], allowFreeText: false, options: [{ label: 'A', detail: null, input: false }, { label: 'URL', detail: null, input: true }] }];
  assert.throws(() => validateAnswers(strict, { q1: 'words' }, 500), /does not accept free text/);
  assert.throws(() => validateAnswers(strict, { q1: 2 }, 500), /needs a typed value/);
  assert.deepEqual(validateAnswers(strict, { q1: { option: 2, text: 'https://staging.example.com' } }, 500), [{ id: 'q1', value: 'https://staging.example.com' }]);
  assert.throws(() => validateAnswers(strict, { q1: { option: 1, text: 'x' } }, 500), /does not take a typed value/);
});

test('ingest receipts and balance output (best effort, as documented and observed)', () => {
  assert.deepEqual(parseIngestReceipt('created  prd-online-store  source sha256:0661  blob sha256:3db8\nguidance line'), [{ status: 'created', sourceId: 'prd-online-store', source: 'sha256:0661' }]);
  assert.deepEqual(parseIngestReceipt('nothing recognisable'), []);
  assert.equal(parseBalance('credits: 10989.5863'), 10989.5863);
  assert.equal(parseBalance('no number here'), null);
});

test('the Kane lock runs holders one at a time, in order', async () => {
  const lock = new KaneLock();
  const order: string[] = [];
  const job = async (name: string, ms: number) => {
    const release = await lock.acquire(name);
    order.push(`start ${name}`);
    assert.equal(lock.holder(), name);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`end ${name}`);
    release();
    release(); // a second release is harmless
  };
  await Promise.all([job('run', 30), job('assurance', 5), job('run2', 1)]);
  assert.deepEqual(order, ['start run', 'end run', 'start assurance', 'end assurance', 'start run2', 'end run2']);
  assert.equal(lock.holder(), null);
});
