// Kane 0.10.5 `testrun` structured output (parseTestrunOutput): the real event shapes of a
// three-test authoring run (one pack per test plus a combined pack), the single-pack shape, and
// every fail-closed case. Synthetic ids and paths only. Pure: no Kane, no files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseTestrunOutput } from '../src/assurance/testrunOutput.ts';

const WS = path.resolve('kv-synthetic-workspace');
const FILES = ['.testmuai/tests/generate-key-and-compare-the-list_test.md', '.testmuai/tests/generate-key-and-observe-the-count_test.md', '.testmuai/tests/generate-key-and-observe-the-message_test.md'];
const ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const SRC = ['bbbbbbbb-1111-4222-8333-444444444444', 'cccccccc-1111-4222-8333-444444444444', 'dddddddd-1111-4222-8333-444444444444'];
const abs = (f: string) => path.join(WS, ...f.split('/'));

type Ev = Record<string, unknown>;
/** The event sequence Kane 0.10.5 printed for a three-test authoring run (values synthetic). */
function events(opts: { perTest?: boolean; status?: string } = {}): Ev[] {
  const perTest = opts.perTest ?? true;
  const st = opts.status ?? 'passed';
  const out: Ev[] = [{ type: 'stream_start', cli_version: '0.10.5', surface: 'testrun', pid: 1, v: 1 }, { type: 'testrun_plan', members: FILES.map((f) => ({ path: abs(f), tags: [] })), valid: true, parallel: 1, v: 1 }];
  FILES.forEach((f, i) => {
    out.push({ type: 'testrun_authored_member_start', path: abs(f), session_id: `s-${i}`, log_path: path.join(WS, '.testmuai', 'kaneai', 'sessions', `s-${i}`, 'events.ndjson'), v: 1 });
    out.push({ type: 'testrun_authored_member_end', path: abs(f), test_id: `t-id-${i}`, status: st, duration_s: 100 + i, session_id: `s-${i}`, log_path: 'x', v: 1 });
  });
  out.push({ type: 'testrun_evidence_ingest', status: 'ok', evidence_id: ID, v: 1 });
  out.push({ type: 'coverage', status: 'written', pct: 100, pack: path.join(WS, '.testmuai', 'evidence', `${ID}.evidence`), v: 1 });
  out.push({
    type: 'testrun_summary',
    execution: { id: ID, status: st, evidence_id: ID },
    authored: FILES.map((f, i) => ({ path: abs(f), test_id: `t-id-${i}`, commit_id: `s-${i}`, execution_id: ID, ...(perTest ? { source_execution_id: SRC[i] } : {}), status: st, published: 'yes' })),
    totals: { tests: 3, passed: st === 'passed' ? 3 : 0, failed: st === 'passed' ? 0 : 3, broken: 0, skipped: 0, authored: 3 },
    upload: 'ok',
    cancelled: false,
    v: 1,
  });
  out.push({ type: 'testrun_done', execution_id: ID, overall_status: st, coverage: { status: 'written', pct: 100 }, v: 1 });
  return out;
}
const text = (ev: Ev[]) => ev.map((e) => JSON.stringify(e)).join('\n') + '\n';
const parse = (ev: Ev[] | string, files = FILES) => parseTestrunOutput(typeof ev === 'string' ? ev : text(ev), { workspaceDir: WS, files });
/** Change one event (by type, the nth if several) with a function. */
const edit = (ev: Ev[], type: string, fn: (e: Ev) => void, nth = 0) => {
  const e = ev.filter((x) => x.type === type)[nth];
  fn(e);
  return ev;
};
const failsWith = (ev: Ev[] | string, re: RegExp, files = FILES) => {
  const r = parse(ev, files);
  assert.equal(r.ok, false);
  assert.equal(r.evidenceId, null, 'no pack is accepted');
  assert.equal(r.packFile, null);
  assert.deepEqual(r.testPacks, []);
  assert.deepEqual(r.members, []);
  assert.match(r.problems.join(' '), re);
};

test('the real four-pack shape: the combined pack named by Kane, the three per-test packs, each test associated', () => {
  const r = parse(events());
  assert.equal(r.ok, true, r.problems.join(' '));
  assert.equal(r.evidenceId, ID);
  assert.equal(r.packFile, `${ID}.evidence`);
  assert.deepEqual(r.testPacks, SRC.map((s) => `${s}.evidence`).sort());
  assert.deepEqual(r.members.map((m) => [m.path, m.testId, m.status, m.sourcePack]), FILES.map((f, i) => [f, `t-id-${i}`, 'passed', `${SRC[i]}.evidence`]));
  assert.equal(r.overallStatus, 'passed');
  assert.deepEqual(r.totals, { tests: 3, passed: 3, failed: 0, broken: 0, skipped: 0 });
  // Nothing private is returned: no log or session paths, no absolute paths.
  assert.doesNotMatch(JSON.stringify(r), /kaneai|sessions|events\.ndjson|kv-synthetic-workspace/);
});

test('the single-pack shape (no per-test packs reported) is still accepted', () => {
  const r = parse(events({ perTest: false }));
  assert.equal(r.ok, true, r.problems.join(' '));
  assert.equal(r.packFile, `${ID}.evidence`);
  assert.deepEqual(r.testPacks, []);
  assert.ok(r.members.every((m) => m.sourcePack === null));
});

test('a failed run is parsed (its status is reported, not hidden); the caller decides the verdict', () => {
  const r = parse(events({ status: 'failed' }));
  assert.equal(r.ok, true, r.problems.join(' '));
  assert.equal(r.overallStatus, 'failed');
  assert.ok(r.members.every((m) => m.status === 'failed'));
});

test('fail closed: missing, repeated or malformed events', () => {
  for (const type of ['testrun_done', 'testrun_summary', 'testrun_evidence_ingest', 'coverage', 'testrun_plan']) failsWith(events().filter((e) => e.type !== type), new RegExp(`no ${type} event`));
  const ev = events();
  failsWith([...ev, ev[ev.length - 1]], /2 testrun_done events; exactly one/);
  // 12 events, then the bad line (13).
  failsWith(text(events()) + 'not json {\n', /Line 13 of Kane's output is not a JSON event/);
  failsWith(text(events()) + '["an array"]\n', /not a Kane event/);
  failsWith(text(events()) + '{"no":"type"}\n', /not a Kane event/);
  failsWith('', /no testrun_done event/);
});

test('fail closed: ids that are not valid or do not agree', () => {
  failsWith(edit(events(), 'testrun_done', (e) => (e.execution_id = 'not-a-uuid')), /no valid execution id/);
  failsWith(edit(events(), 'testrun_done', (e) => (e.execution_id = '../../escape')), /no valid execution id/);
  failsWith(edit(events(), 'testrun_done', (e) => delete e.overall_status), /no overall status/);
  failsWith(edit(events(), 'testrun_evidence_ingest', (e) => (e.evidence_id = SRC[0])), /evidence id Kane ingested is not the run id/);
  failsWith(edit(events(), 'testrun_evidence_ingest', (e) => (e.status = 'failed')), /did not ingest the evidence/);
  failsWith(edit(events(), 'testrun_summary', (e) => ((e.execution as Ev).id = SRC[1])), /execution id in testrun_summary/);
  failsWith(edit(events(), 'testrun_summary', (e) => ((e.execution as Ev).evidence_id = SRC[1])), /evidence id in testrun_summary/);
  failsWith(edit(events(), 'testrun_summary', (e) => (((e.authored as Ev[])[2]).execution_id = SRC[2])), /belongs to another run id/);
  failsWith(edit(events(), 'testrun_summary', (e) => (e.cancelled = true)), /cancelled is not false/);
  failsWith(edit(events(), 'testrun_summary', (e) => delete e.totals), /no complete totals/);
  failsWith(edit(events(), 'testrun_summary', (e) => ((e.totals as Ev).tests = 4)), /Kane counted 4 tests; 3 were approved/);
});

test('fail closed: the pack path must be the named pack in the workspace evidence folder', () => {
  failsWith(edit(events(), 'coverage', (e) => (e.pack = path.join(WS, '.testmuai', 'evidence', `${SRC[0]}.evidence`))), /coverage event's evidence pack/);
  failsWith(edit(events(), 'coverage', (e) => (e.pack = path.join(path.dirname(WS), 'elsewhere', `${ID}.evidence`))), /coverage event's evidence pack/);
  failsWith(edit(events(), 'coverage', (e) => (e.pack = path.join(WS, '.testmuai', 'evidence', '..', '..', `${ID}.evidence`))), /coverage event's evidence pack/);
  failsWith(edit(events(), 'coverage', (e) => delete e.pack), /coverage event's evidence pack/);
});

test('fail closed: per-test packs reported for some tests only, twice, or with the combined id', () => {
  failsWith(edit(events(), 'testrun_summary', (e) => delete ((e.authored as Ev[])[1]).source_execution_id), /for some tests but not for others/);
  failsWith(edit(events(), 'testrun_summary', (e) => (((e.authored as Ev[])[1]).source_execution_id = SRC[0])), /same per-test evidence pack/);
  failsWith(edit(events(), 'testrun_summary', (e) => (((e.authored as Ev[])[1]).source_execution_id = ID)), /has the combined pack id/);
  failsWith(edit(events(), 'testrun_summary', (e) => (((e.authored as Ev[])[1]).source_execution_id = 'x/../y')), /not a valid id/);
});

test('fail closed: members must be exactly the approved files, everywhere, once each, consistently', () => {
  const other = abs('.testmuai/tests/something-else_test.md');
  failsWith(edit(events(), 'testrun_plan', (e) => ((e.members as Ev[])[0].path = other)), /run plan is not exactly the approved/);
  failsWith(edit(events(), 'testrun_authored_member_end', (e) => (e.path = other), 1), /finished tests is not exactly the approved/);
  failsWith(edit(events(), 'testrun_summary', (e) => ((e.authored as Ev[])[0].path = other)), /testrun_summary is not exactly the approved/);
  failsWith(edit(events(), 'testrun_summary', (e) => ((e.authored as Ev[])[0].path = path.join(path.dirname(WS), 'outside_test.md'))), /outside the workspace/);
  failsWith(edit(events(), 'testrun_summary', (e) => (e.authored as Ev[]).push({ ...(e.authored as Ev[])[0] })), /more than once/);
  // The first test's member end is missing.
  failsWith(events().filter((e, _i, all) => !(e.type === 'testrun_authored_member_end' && all.indexOf(e) === all.findIndex((x) => x.type === 'testrun_authored_member_end'))), /finished tests is not exactly the approved/);
  failsWith(edit(events(), 'testrun_authored_member_end', (e) => (e.status = 'failed'), 2), /two different statuses/);
  failsWith(edit(events(), 'testrun_authored_member_end', (e) => (e.test_id = 'another'), 0), /two different test ids/);
  failsWith(edit(events(), 'testrun_summary', (e) => delete ((e.authored as Ev[])[0]).test_id), /has no test id/);
  // A run of other files than the ones approved for this run.
  failsWith(events(), /not exactly the approved test files/, FILES.slice(0, 2));
});
