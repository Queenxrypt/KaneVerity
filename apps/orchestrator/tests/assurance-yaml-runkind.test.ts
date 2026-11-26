// Kane 0.10.5's real evidence structures (the 2026-11-26 combined pack, reproduced with synthetic
// values): YAML anchors and aliases in result.yaml, every unsupported YAML feature failing closed,
// and the run kind read from each member of a combined pack, with its consistency checks. Pure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeZip } from './helpers.ts';
import { buildPack, goodMembers } from './design-fixture.ts';
import { parseYaml, readPackManifest, verifyPack, YamlError, type OutcomeTarget } from '../src/assurance/runEvidence.ts';

const ORIGIN = 'http://127.0.0.1:5174';
const defs = { message: 'sha256:' + '1'.repeat(64), list: 'sha256:' + '2'.repeat(64), count: 'sha256:' + '3'.repeat(64) };
const c = (n: number) => 'sha256:' + String(n).padStart(64, '0');
const TARGETS: OutcomeTarget[] = [
  { outcome: 'O1', outcomeText: "The message 'API key generated successfully.' appears.", labels: ['API key generated successfully.'], acCid: c(3), acSlug: 'ac-3', testCid: c(12), testSlug: 't-2', definitionId: defs.message },
  { outcome: 'O2', outcomeText: 'The new key is added to the API keys list.', labels: [], acCid: c(4), acSlug: 'ac-4', testCid: c(13), testSlug: 't-3', definitionId: defs.list },
  { outcome: 'O3', outcomeText: "The key count below the list shows '2 keys'.", labels: ['2 keys'], acCid: c(2), acSlug: 'ac-2', testCid: c(14), testSlug: 't-4', definitionId: defs.count },
];
type PackOpts = Parameters<typeof buildPack>[0];
const pack = (o: Partial<PackOpts> = {}) => buildPack({ members: goodMembers(defs, ORIGIN), appOrigin: ORIGIN, ...o }, makeZip);
const verify = (buf: Buffer, requireReplay = true) => verifyPack(buf, { appOrigin: ORIGIN, pinnedVersion: '0.10.5', targets: TARGETS, requireReplay });

// The steps block of a real result.yaml member (synthetic ids), exactly as js-yaml writes it.
const REAL_STEPS = [
  'steps:',
  '  - id: 0-1',
  '    ordinal: 1',
  '    status: passed',
  '    kind: navigate',
  '    duration_ms: 0',
  '    action_id: a1',
  '  - id: 0-3',
  '    ordinal: 3',
  '    status: passed',
  '    duration_ms: 5400',
  '  - id: 2-1',
  '    ordinal: 6',
  '    status: passed',
  '    kind: click',
  '    action_id: a6',
  '    verifies: &ref_0',
  '      - ac-2',
  '  - id: 2-2',
  '    ordinal: 7',
  '    status: passed',
  '    kind: analyze',
  '    action_id: a7',
  '    verifies: *ref_0',
  '  - id: 2-3',
  '    ordinal: 8',
  '    status: passed',
  '    kind: assert',
  '    action_id: a8',
  '    verifies: *ref_0',
  '',
].join('\n');

test('YAML: anchors and aliases are read as Kane 0.10.5 writes result.yaml (every step kept, every verifies list read)', () => {
  const y = parseYaml(REAL_STEPS) as { steps: Record<string, unknown>[] };
  assert.equal(y.steps.length, 5, 'no step is lost after the anchored list');
  assert.deepEqual(y.steps.map((s) => [s.ordinal, s.kind ?? null, s.verifies ?? null]), [[1, 'navigate', null], [3, null, null], [6, 'click', ['ac-2']], [7, 'analyze', ['ac-2']], [8, 'assert', ['ac-2']]]);
  // An alias is a copy, never a shared object.
  (y.steps[3].verifies as string[]).push('changed');
  assert.deepEqual(y.steps[4].verifies, ['ac-2']);
  // Anchors on inline values and on list items, and aliases in a list.
  assert.deepEqual(parseYaml('a: &x hello\nb: *x\nc:\n  - &y [p, q]\n  - *y\n  - &z\n    k: 1\n  - *z\n'), { a: 'hello', b: 'hello', c: [['p', 'q'], ['p', 'q'], { k: 1 }, { k: 1 }] });
  // A map anchored on a key, then aliased.
  assert.deepEqual(parseYaml('m: &m\n  x: 1\n  y: [a]\nn: *m\n'), { m: { x: 1, y: ['a'] }, n: { x: 1, y: ['a'] } });
});

test('YAML: the scalars Kane writes still read the same (quotes, numbers, null, flow lists, timestamps, empty input)', () => {
  assert.deepEqual(parseYaml("evidence: '0.1'\nversion: 0.10.5\nn: 3\nf: 1.5\nz: null\nt: ~\nb: true\ns: 'it''s'\nd: \"a \\\"q\\\" \\u00e9\"\nl: [ac-3, ac-4]\ne: []\nts: 2026-11-26T11:23:28.163Z\nempty:\n"), { evidence: '0.1', version: '0.10.5', n: 3, f: 1.5, z: null, t: null, b: true, s: "it's", d: 'a "q" é', l: ['ac-3', 'ac-4'], e: [], ts: '2026-11-26T11:23:28.163Z', empty: null });
  assert.equal(parseYaml(''), null);
  assert.deepEqual(parseYaml('# a comment\nk: v\n'), { k: 'v' });
});

test('YAML: every unsupported feature fails closed with YamlError, never a guess', () => {
  const cases: [string, RegExp][] = [
    ['a: &x\n  k: 1\nb:\n  <<: *x\n', /merge key/],
    ['a: !!str 5\n', /a tag/],
    ['a: |\n  text\n', /block scalar/],
    ['a: >-\n  text\n', /block scalar/],
    ['a: {b: 1}\n', /flow map/],
    ['---\na: 1\n', /document marker/],
    ['a: 1\n...\n', /document marker/],
    ['? a\n: 1\n', /complex key/],
    ['a: *nope\n', /alias \*nope has no anchor/],
    ['a: *x\nb: &x 1\n', /alias \*x has no anchor/],
    ['a: &x 1\nb: &x 2\n', /anchor &x is defined twice/],
    ['a:\n\tb: 1\n', /tab indentation/],
    ['a: 1\n    b: 2\n', /unexpected indentation/],
    ['steps:\n  - id: 1\n    v: &r\n      - ac-1\n   bad: 2\n', /unexpected indentation|not "key: value"/],
    ['a: 1\na: 2\n', /appears twice/],
    ['just text\n', /not "key: value"/],
    ['a: b #c\n', /comment after a value/],
    ['a: b: c\n', /containing ": "/],
    ["a: ['x, y']\n", /flow list with nested, quoted or anchored items/],
    ['a: [[1]]\n', /flow list with nested/],
    ['- - a\n', /nested on the same line/],
    ["a: 'open\n", /unclosed single-quoted/],
    ['a: "\\x41"\n', /escape KaneVerity does not read/],
    ['- &a b: 1\n', /containing ": "|anchor or alias/],
    ['a: %x\n', /reserved indicator/],
  ];
  for (const [text, re] of cases) assert.throws(() => parseYaml(text), (e: unknown) => e instanceof YamlError && re.test((e as Error).message), JSON.stringify(text));
});

test("verifyPack and the manifest: a result.yaml or run.yaml KaneVerity cannot read is a pack problem, never skipped", () => {
  const bad = makeZip([{ name: 'run.yaml', data: "status: finalized\nenvironment:\n  producer:\n    name: kane-cli\n    version: 0.10.5\n  run_kind: replay\n" }, { name: 'tests/m/result.yaml', data: `definition_id: ${defs.message}\nsteps:\n  - id: 1\n    note: |\n      x\n` }]);
  const v = verify(bad, false);
  assert.equal(v.packOk, false);
  assert.match(v.problems.join(' '), /tests\/m\/result\.yaml cannot be read \(unsupported YAML at line 4: a block scalar\)/);
  assert.match(readPackManifest(bad).problems.join(' '), /tests\/m\/result\.yaml cannot be read \(unsupported YAML/);
  const badRun = makeZip([{ name: 'run.yaml', data: 'run_id: x\nrun_id: y\n' }]);
  assert.match(verify(badRun, false).problems.join(' '), /run\.yaml cannot be read \(unsupported YAML at line 2: the key run_id appears twice\)/);
  assert.match(readPackManifest(badRun).problems.join(' '), /run\.yaml cannot be read/);
});

test('real shape: a combined pack with anchored verifies lists and per-member run kinds verifies with the unchanged outcome rules', () => {
  const v = verify(pack({ layout: 'combined', anchors: true, runKind: 'replay' }));
  assert.equal(v.packOk, true, v.problems.join(' '));
  assert.equal(v.runKind, 'replay');
  assert.equal(v.verified, true, JSON.stringify(v.outcomes.map((o) => o.problems)));
  assert.deepEqual(v.outcomes.map((o) => [o.outcome, o.basis]), [['O1', 'dom_value'], ['O2', 'dom_baseline_change'], ['O3', 'dom_value']]);
  // The same pack read for authoring: author everywhere, the outcome evidence is still judged.
  const a = verify(pack({ layout: 'combined', anchors: true, runKind: 'author' }), false);
  assert.equal(a.runKind, 'author');
  assert.equal(a.packOk, true, a.problems.join(' '));
  assert.ok(a.outcomes.every((o) => o.verified), 'an authoring pack with strong evidence passes the outcome rules');
});

test('real shape: the recorded checks the review rejected stay rejected (a yes/no result, a text locator, no list read after the action)', () => {
  const weak = pack({
    layout: 'combined',
    anchors: true,
    runKind: 'replay',
    members: (() => {
      const m = goodMembers(defs, ORIGIN);
      // O1 as recorded on 2026-11-26: "true" from a locator made of the asserted text.
      m[0].ops = [{ ...(m[0].ops[0] as object), assertion_tree: { status: 'passed', description: 'the message appears', sub_results: [{ passed: true, operator: 'equals', expected: 'true', store_key: 'success_message', variable_refs: { '{{success_message}}': 'true' } }] } }];
      m[0].actions = [{ ...(m[0].actions[0] as object), output_value: 'true', action_params: { ...((m[0].actions[0] as { action_params: object }).action_params), locators: ['internal:text="API key generated"i'] } }];
      // O2 as recorded: only the read before the action, then a yes/no and a count.
      m[1].actions = m[1].actions.filter((x) => Number((x as { step: number }).step) < 5);
      return m;
    })(),
  });
  const v = verify(weak);
  assert.equal(v.packOk, true);
  assert.equal(v.verified, false);
  assert.match(v.outcomes[0].problems.join(' '), /yes\/no result/);
  assert.match(v.outcomes[1].problems.join(' '), /no analyzer action in the action log read|no full read of the same list .* after the action/);
  assert.equal(v.outcomes[2].verified, true);
});

test('run kind: a replay only when every member is; missing, unknown or contradictory kinds fail closed', () => {
  const kind = (o: Partial<PackOpts>, requireReplay = true) => verify(pack({ layout: 'combined', anchors: true, ...o }), requireReplay);
  // One member authored: the whole run is an authoring run, and a verification is refused.
  let v = kind({ runKind: 'replay', memberKinds: ['replay', 'author', 'replay'], observedKind: 'author' });
  assert.equal(v.runKind, 'author');
  assert.equal(v.verified, false);
  assert.match(v.problems.join(' '), /not a pure replay \(run_kind: author\)/);
  // run_kind_observed and the members disagree.
  v = kind({ runKind: 'replay', observedKind: 'author' });
  assert.match(v.problems.join(' '), /observed as author, but its members say replay/);
  assert.equal(v.packOk, false);
  // A member without a run kind.
  v = kind({ runKind: 'replay', memberKinds: ['replay', null, 'replay'] });
  assert.equal(v.runKind, null);
  assert.match(v.problems.join(' '), /record no run kind/);
  // Both run_kind and run_kind_observed in run.yaml.
  v = kind({ runKind: 'replay', topKind: 'replay' });
  assert.match(v.problems.join(' '), /both run_kind and run_kind_observed/);
  // An unknown kind.
  v = kind({ runKind: 'replay', memberKinds: ['replay', 'healed', 'replay'] });
  assert.match(v.problems.join(' '), /unknown run kind \("healed"\)/);
  // A member classed replay but observed as authored.
  v = kind({ runKind: 'replay', memberObserved: [null, 'author', null] });
  assert.match(v.problems.join(' '), /classed as replay but was observed as author/);
  assert.equal(v.verified, false);
  // No run kind anywhere in a combined pack.
  v = kind({ runKind: 'replay', memberKinds: [null, null, null], observedKind: null });
  assert.equal(v.runKind, null);
  assert.equal(v.verified, false);
  // The single-pack layout keeps reading run.yaml's run_kind.
  assert.equal(verify(pack({ runKind: 'replay' })).runKind, 'replay');
  assert.equal(verify(pack({ runKind: 'author' }), false).runKind, 'author');
});
