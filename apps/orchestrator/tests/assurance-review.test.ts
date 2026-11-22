// Assurance B3 units: citation checks and KaneVerity's own review rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCitations, type KaneCitation } from '../src/assurance/citations.ts';
import { designEligibility, reviewState, validateDecision, type ReviewEntry } from '../src/assurance/review.ts';
import { generateRequirements } from '../src/assurance/requirements.ts';
import { tutorial } from './helpers.ts';

const APP = 'http://127.0.0.1:5174';
// A small tutorial in the same shape as the API-key one.
const T = tutorial(["In the left navigation menu, click 'Developer Settings'.", "Click 'API Keys'.", "Click 'Generate Key'."], ["The message 'API key generated successfully.' appears.", 'The new key is added to the API keys list.', "The key count below the list shows '2 keys'."], 'generate-an-api-key');
T.steps.forEach((s, i) => (s.labels = [['Developer Settings'], ['API Keys'], ['Generate Key']][i]));
T.outcomes.forEach((o, i) => (o.labels = [['API key generated successfully.'], [], ['2 keys']][i]));
const REQ = generateRequirements(T, APP);
const lines = REQ.markdown.split('\n');
const lineOf = (item: string) => REQ.lineMap.find((e) => e.item === item)!.reqLine;
const SRC = { sourceId: 'kv-generate-an-api-key', sourceCid: 'sha256:' + 'a'.repeat(64) };
const cite = (a: number, b: number, quote: string, claim: string | null = null): KaneCitation => ({ anchor: `L${a}-L${b}`, quote, claim, ...SRC });
const UC_TEXT = "Open 'Developer Settings', then 'API Keys', then 'Generate Key'; see 'API key generated successfully.' and '2 keys'.";
const check = (citations: KaneCitation[], useCaseText = UC_TEXT) => checkCitations({ requirementsMarkdown: REQ.markdown, lineMap: REQ.lineMap, expectedSourceId: SRC.sourceId, expectedSourceCid: SRC.sourceCid, citations, useCaseText });

// The V1 pattern: every outcome cited, steps not cited, one framing citation.
const V1_LIKE = [
  cite(lineOf('O1'), lineOf('O1'), lines[lineOf('O1') - 1], 'The message appears.'),
  cite(lineOf('O2'), lineOf('O2'), lines[lineOf('O2') - 1]),
  cite(lineOf('O1'), lineOf('O3'), lines[lineOf('O2') - 1]),
  cite(lineOf('O3'), lineOf('O3'), lines[lineOf('O3') - 1]),
  cite(18, 19, '- The journey starts at {{app_url}}/ in a fresh browser session.', 'Select the three labels in order.'),
];

test('V1 pattern: outcomes are cited and traced to documentation lines; uncited steps are visible gaps', () => {
  const r = check(V1_LIKE);
  assert.equal(r.summary.valid, 5);
  assert.equal(r.summary.outcomesCited, 3);
  assert.equal(r.summary.stepsCited, 0, 'no step is cited');
  assert.equal(r.summary.hasGaps, true, 'uncited steps are gaps, never silently verified');
  assert.deepEqual(r.coverage.filter((c) => c.citedBy === 0).map((c) => c.item), ['S1', 'S2', 'S3']);
  assert.ok(r.coverage.filter((c) => c.kind === 'step').every((c) => c.labelsNamed), 'labels are named even though not cited');
  assert.deepEqual(r.citations[2].items, ['O2'], 'a range citation evidences only the line it quotes');
  assert.deepEqual(r.citations[0].docRefs, [`tutorials/generate-an-api-key.md:${REQ.lineMap.find((e) => e.item === 'O1')!.source.kind === 'markdown' ? (REQ.lineMap.find((e) => e.item === 'O1')!.source as { line: number }).line : 0}`]);
  assert.equal(r.citations[4].framingOnly, true, 'the journey line is KaneVerity framing, not documentation');
});

test('fully cited use case has no gaps', () => {
  const all = REQ.lineMap.map((e) => cite(e.reqLine, e.reqLine, lines[e.reqLine - 1]));
  const r = check(all);
  assert.equal(r.summary.hasGaps, false);
  assert.equal(r.summary.stepsCited, 3);
  assert.equal(r.summary.outcomesCited, 3);
});

test('invalid, missing and mismatched citations are rejected and never count', () => {
  const O1 = lineOf('O1');
  const bad = [
    { ...cite(O1, O1, lines[O1 - 1]), anchor: 'line 37' }, // bad anchor
    cite(O1, 9999, lines[O1 - 1]), // out of range
    cite(O1 + 1, O1 + 1, lines[O1 - 1]), // quote is not on the cited line
    { ...cite(O1, O1, lines[O1 - 1]), sourceId: 'kv-other' }, // another source
    { ...cite(O1, O1, lines[O1 - 1]), sourceCid: 'sha256:' + 'b'.repeat(64) }, // another source version
    cite(O1, O1, '   '), // empty quote
    cite(O1, O1 - 1, lines[O1 - 1]), // reversed range
  ];
  const r = check(bad);
  assert.deepEqual(r.citations.map((c) => c.problems), [['bad_anchor'], ['out_of_range'], ['quote_mismatch'], ['wrong_source'], ['wrong_source'], ['empty_quote'], ['out_of_range']]);
  assert.ok(r.citations.every((c) => !c.ok && c.items.length === 0 && c.docRefs.length === 0));
  assert.equal(r.summary.outcomesCited, 0, 'invalid citations evidence nothing');
  assert.equal(r.summary.invalid, 7);
  assert.equal(r.summary.hasGaps, true);
  const none = check([]);
  assert.equal(none.summary.total, 0);
  assert.equal(none.summary.hasGaps, true, 'no citations at all is a gap');
});

test('a label that is not named exactly (case-sensitive) is reported', () => {
  const r = check(V1_LIKE, "open 'developer settings' then 'API Keys' then 'Generate Key'");
  assert.deepEqual(r.coverage.find((c) => c.item === 'S1')!.missingLabels, ['Developer Settings']);
});

const entry = (decision: 'approved' | 'rejected', extra: Partial<ReviewEntry> = {}): ReviewEntry => ({
  ucCid: 'sha256:' + 'c'.repeat(64),
  decision,
  reason: decision === 'rejected' ? 'wrong' : null,
  acknowledgedGaps: false,
  gapsAtDecision: { invalid: 0, stepsCited: 0, steps: 3, outcomesCited: 3, outcomes: 3, hasGaps: true },
  snapshot: 1,
  at: '2026-11-22T00:00:00Z',
  by: 'kaneverity-review',
  ...extra,
});

test("REGRESSION: Kane's own \"skipped\" verdict attributed to the owner never counts as review", () => {
  const cid = 'sha256:' + 'c'.repeat(64);
  // Anything not recorded by KaneVerity's review interface is ignored, whatever it claims.
  const kaneLike = { ...entry('approved'), by: 'human:owner' } as unknown as ReviewEntry;
  assert.equal(reviewState([kaneLike], cid).state, 'awaiting_review');
  assert.equal(reviewState([], cid).state, 'awaiting_review');
  const e = designEligibility({ state: reviewState([kaneLike], cid).state, integrityOk: true, inLatestSnapshot: true, requirementsCurrent: true });
  assert.equal(e.eligible, false);
  assert.match(e.reasons.join(' '), /not been reviewed in KaneVerity/);
});

test('explicit approval and rejection; latest decision wins; history kept', () => {
  const cid = 'sha256:' + 'c'.repeat(64);
  const h = [entry('approved'), entry('rejected', { at: '2026-11-22T01:00:00Z' })];
  const s = reviewState(h, cid);
  assert.equal(s.state, 'rejected');
  assert.equal(s.history.length, 2);
  assert.equal(reviewState([...h, entry('approved', { at: '2026-11-22T02:00:00Z' })], cid).state, 'approved');
  assert.equal(reviewState(h, 'sha256:' + 'd'.repeat(64)).state, 'awaiting_review', 'a decision applies to one exact use-case version');
});

test('decision validation: reject needs a reason; approving with gaps needs an acknowledgement', () => {
  assert.throws(() => validateDecision({ decision: 'reject' }, false), /needs a reason/);
  assert.throws(() => validateDecision({ decision: 'reject', reason: '   ' }, false), /needs a reason/);
  assert.deepEqual(validateDecision({ decision: 'reject', reason: ' Steps not cited ' }, true), { decision: 'rejected', reason: 'Steps not cited', acknowledgedGaps: false });
  assert.throws(() => validateDecision({ decision: 'approve' }, true), /explicit acknowledgement/);
  assert.throws(() => validateDecision({ decision: 'approve', acknowledgeGaps: 'yes' }, true), /explicit acknowledgement/);
  assert.deepEqual(validateDecision({ decision: 'approve', acknowledgeGaps: true }, true), { decision: 'approved', reason: null, acknowledgedGaps: true });
  assert.deepEqual(validateDecision({ decision: 'approve' }, false), { decision: 'approved', reason: null, acknowledgedGaps: false });
  for (const bad of [null, {}, { decision: 'approved' }, { decision: 'trust' }, { decision: 'reject', reason: 5 }, { decision: 'reject', reason: 'x'.repeat(1001) }, { decision: 'reject', reason: 'a\u0000b' }]) {
    assert.throws(() => validateDecision(bad, false), JSON.stringify(bad));
  }
});

test('only an approved use case with intact, current material may go to test design', () => {
  const ok = { state: 'approved' as const, integrityOk: true, inLatestSnapshot: true, requirementsCurrent: true };
  assert.deepEqual(designEligibility(ok), { eligible: true, reasons: [] });
  for (const [change, re] of [
    [{ state: 'awaiting_review' }, /not been reviewed/],
    [{ state: 'rejected' }, /rejected/],
    [{ integrityOk: false }, /integrity/],
    [{ inLatestSnapshot: false }, /latest retrieval/],
    [{ requirementsCurrent: false }, /no longer the current/],
  ] as [object, RegExp][]) {
    const e = designEligibility({ ...ok, ...change });
    assert.equal(e.eligible, false, JSON.stringify(change));
    assert.match(e.reasons.join(' '), re);
  }
});
