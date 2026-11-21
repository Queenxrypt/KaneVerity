// D3 regression tests using the REAL (sanitized) evidence from Kane exploration
// r20261119-150019-dc9968, where Kane reached the API Keys page by clicking the
// Dashboard summary card recorded as "Clicking 1 API keys".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isActionTarget, labelsIn, supportFor, validateProposal, type Answer, type ExplorationEvidence } from '../src/correct/validate.ts';
import { TESTS_DIR, OUTDATED_API_KEY_DOC } from './helpers.ts';

const fx = JSON.parse(readFileSync(path.join(TESTS_DIR, 'fixtures', 'acmedesk-explore-card-route.json'), 'utf8'));
const ev: ExplorationEvidence = { runId: fx.runId, confirmed: true, steps: fx.evidenceSteps, assertions: fx.assertions, screenshots: fx.screenshots };
const FILE = 'tutorials/generate-an-api-key.md';
const DOC = OUTDATED_API_KEY_DOC;

function proposal(edits: Answer['edits']): Answer {
  return { decision: 'proposal', rationale: 'from exploration', confidence: 'high', evidenceCited: [], edits, explorationQuestion: '' };
}

test('fixture is the real card-route exploration', () => {
  assert.equal(fx.runId, 'r20261119-150019-dc9968');
  assert.equal(fx.evidenceSteps.find((s: { ordinal: number }) => s.ordinal === 3).summary, 'click: Clicking 1 API keys');
  assert.deepEqual(fx.visitedOrigins, ['http://127.0.0.1:5174']);
});

test('labels get roles from their wording', () => {
  assert.deepEqual(labelsIn('On the **Dashboard**, click **API keys**.').map((l) => [l.label, l.role]), [['Dashboard', 'location'], ['API keys', 'target']]);
  assert.deepEqual(labelsIn('In **Project name**, enter `Docs Demo Project`.').map((l) => [l.label, l.role]), [['Project name', 'location'], ['Docs Demo Project', 'value']]);
  assert.deepEqual(labelsIn('Select **Member**.').map((l) => l.role), ['target']);
  assert.deepEqual(labelsIn('**Generate Key** next.').map((l) => l.role), ['target'], 'unrecognised wording is treated as a target (strictest)');
});

test('REJECT: "API keys" as a click target when the only click evidence is "1 API keys"', () => {
  assert.equal(supportFor('API keys', ev, 'target'), null);
  const v = validateProposal(proposal([
    { line: 18, action: 'replace', newText: 'On the **Dashboard**, click **API keys**.' },
    { line: 19, action: 'replace', newText: 'Click **Generate Key**.' },
    { line: 20, action: 'delete', newText: '' },
  ]), DOC, FILE, ev);
  assert.equal(v.ok, false);
  assert.match(v.problems.join(' '), /"API keys" is used as an action target but no distinct, passed Kane click action has exactly that target/);
});

test('REJECT: an assertion that mentions a label never independently supports a click target', () => {
  // A passing outcome assertion mentions "API keys list" - that must not count for "click **API keys**".
  assert.ok(ev.assertions.some((a) => a.isCheck && a.passed && /API keys list/.test(a.query)));
  assert.equal(supportFor('API keys', ev, 'target'), null);
  assert.equal(supportFor('API keys', ev, 'location')?.kind, 'assertion', 'the same mention may support a location ("on the API keys list")');
});

test('REJECT: Developer Settings / API Keys were never clicked in this exploration', () => {
  for (const label of ['Developer Settings', 'API Keys', 'API']) assert.equal(supportFor(label, ev, 'target'), null, label);
});

test('REJECT: case must match exactly for click targets', () => {
  assert.equal(isActionTarget('click: Clicking Generate Key button in the API Keys page', 'generate key', true), false);
  assert.equal(isActionTarget('click: Clicking Generate Key button in the API Keys page', 'Generate Key', true), true);
  assert.equal(supportFor('generate key', ev, 'target'), null);
});

test('REJECT: one click action cannot support two targets (distinct actions required)', () => {
  const v = validateProposal(proposal([
    { line: 18, action: 'replace', newText: 'Click **Generate Key**.' },
    { line: 19, action: 'replace', newText: 'Click **Generate Key**.' },
    { line: 20, action: 'delete', newText: '' },
  ]), DOC, FILE, ev);
  assert.equal(v.ok, false);
  assert.match(v.problems.join(' '), /"Generate Key" is used as an action target but no distinct/);
});

test('ACCEPT (evidence-exact): the card route as Kane actually recorded it', () => {
  const v = validateProposal(proposal([
    { line: 18, action: 'replace', newText: 'On the **Dashboard**, click **1 API keys**.' },
    { line: 19, action: 'replace', newText: 'Click **Generate Key**.' },
    { line: 20, action: 'delete', newText: '' },
  ]), DOC, FILE, ev);
  assert.equal(v.ok, true, v.problems.join(' '));
  assert.deepEqual(v.citations.map((c) => [c.label, c.kind, c.ordinal, c.screenshot]), [
    ['Dashboard', 'assertion', null, null],
    ['1 API keys', 'action', 3, '3.jpg'],
    ['Generate Key', 'action', 4, '4.jpg'],
  ]);
  // Dashboard is supported by the STORED start-page heading value, not by an outcome assertion.
  assert.match(v.citations[0].evidence, /main heading.*= Dashboard/);
});

test('REJECT: the sidebar route cannot be proposed from this evidence', () => {
  const v = validateProposal(proposal([
    { line: 18, action: 'replace', newText: 'On the **Dashboard**, click **Developer Settings**.' },
    { line: 19, action: 'replace', newText: 'Click **API Keys**.' },
    { line: 20, action: 'replace', newText: 'Click **Generate Key**.' },
  ]), DOC, FILE, ev);
  assert.equal(v.ok, false);
  assert.match(v.problems.join(' '), /"Developer Settings" is used as an action target/);
  assert.match(v.problems.join(' '), /"API Keys" is used as an action target/);
});
