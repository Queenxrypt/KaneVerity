// Exploration modes and the page-transition safeguard (no Kane runs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildExplorationObjective, EXPLORATION_MODES, isExplorationMode } from '../src/correct/explore.ts';
import { checkPageTransitions, validateProposal, type Answer, type ExplorationEvidence } from '../src/correct/validate.ts';
import type { EvidenceStep } from '../src/kane/evidence.ts';
import { API_KEY_OUTCOMES, OUTDATED_API_KEY_STEPS, TESTS_DIR, tutorial, OUTDATED_API_KEY_DOC } from './helpers.ts';

const APP = 'http://127.0.0.1:5174';
const FILE = 'tutorials/generate-an-api-key.md';
const DOC = OUTDATED_API_KEY_DOC;
// Every label that appears anywhere in the AcmeDesk UI navigation or API-key flow.
const APP_LABELS = ['Dashboard', 'Projects', 'Team Members', 'Workspace Settings', 'Developer Settings', 'API Keys', 'API keys', 'Generate Key', 'Settings', 'API'];

// ---------- modes ----------

test('modes are allow-listed; the main-navigation rule names no application labels', () => {
  assert.deepEqual(Object.keys(EXPLORATION_MODES).sort(), ['default', 'main-navigation']);
  assert.equal(EXPLORATION_MODES['main-navigation'].label, 'Explore using the main navigation menu');
  const rule = EXPLORATION_MODES['main-navigation'].rule!;
  for (const l of APP_LABELS) assert.ok(!new RegExp(`\\b${l}\\b`).test(rule), `rule must not contain "${l}"`);
  assert.equal(EXPLORATION_MODES.default.rule, null);
});

test('isExplorationMode rejects unknown and prototype keys', () => {
  for (const ok of ['default', 'main-navigation']) assert.equal(isExplorationMode(ok), true);
  for (const bad of ['sidebar', 'Main-Navigation', '__proto__', 'constructor', 'toString', '', null, undefined, 1, {}]) assert.equal(isExplorationMode(bad), false, String(bad));
});

test('default objective is unchanged; main-navigation adds exactly the fixed rule in the rules section', () => {
  const t = tutorial(OUTDATED_API_KEY_STEPS, API_KEY_OUTCOMES, 'generate-an-api-key');
  const d = buildExplorationObjective(APP, t).objective.split('\n');
  const m = buildExplorationObjective(APP, t, 'main-navigation').objective.split('\n');
  assert.deepEqual(buildExplorationObjective(APP, t, 'default').objective.split('\n'), d, 'default mode is the existing template');
  assert.equal(m.length, d.length + 1);
  const rule = EXPLORATION_MODES['main-navigation'].rule!;
  assert.equal(m.filter((l) => l === rule).length, 1);
  assert.ok(m.indexOf(rule) < m.findIndex((l) => l.startsWith('1. ')), 'rule sits with the KaneVerity rules, before the steps');
  assert.deepEqual(m.filter((l) => l !== rule), d, 'nothing else changes');
  assert.throws(() => buildExplorationObjective(APP, t, 'bogus' as never));
});

// ---------- page transitions ----------

const step = (ordinal: number, kind: string, summary: string, page: string | null, status = 'passed'): EvidenceStep => ({ ordinal, id: `0-${ordinal}`, kind, status, summary, url: page === null ? null : `${APP}${page}` });

const SIDEBAR_STEPS: EvidenceStep[] = [
  step(1, 'navigate', `navigate: Navigate to ${APP}/`, '/'),
  step(2, 'analyze', 'analyze: the main heading of the starting page', '/'),
  step(3, 'click', 'click: Clicking Developer Settings in the main navigation menu', '/'),
  step(4, 'click', 'click: Clicking API Keys link', '/developer'),
  step(5, 'click', 'click: Clicking Generate Key button', '/developer/api-keys'),
  step(6, 'assert', "assert: the message 'API key generated successfully.' appears", '/developer/api-keys'),
];

function ev(steps: EvidenceStep[]): ExplorationEvidence {
  return {
    runId: 'r20261119-000000-abcdef',
    confirmed: true,
    steps,
    assertions: [{ key: 'start_page_heading', query: 'the main heading of the starting page', extracted: 'Dashboard', passed: false, isCheck: false }],
    screenshots: steps.map((s) => ({ ordinal: s.ordinal, file: `${s.ordinal}.jpg` })),
  };
}

const SIDEBAR_PROPOSAL: Answer = {
  decision: 'proposal',
  rationale: 'sidebar route',
  confidence: 'high',
  evidenceCited: [],
  explorationQuestion: '',
  edits: [
    { line: 18, action: 'replace', newText: 'On the **Dashboard**, click **Developer Settings**.' },
    { line: 19, action: 'replace', newText: 'Click **API Keys**.' },
    { line: 20, action: 'replace', newText: 'Click **Generate Key**.' },
  ],
};

test('ACCEPT: sidebar route with page transitions established by each click; the final same-page click is legitimate', () => {
  const v = validateProposal(SIDEBAR_PROPOSAL, DOC, FILE, ev(SIDEBAR_STEPS));
  assert.equal(v.ok, true, v.problems.join(' '));
  assert.deepEqual(v.citations.filter((c) => c.kind === 'action').map((c) => [c.label, c.ordinal]), [['Developer Settings', 3], ['API Keys', 4], ['Generate Key', 5]]);
});

test('ACCEPT: same-page clicks need no transition (e.g. two buttons on one page)', () => {
  const steps = [step(1, 'navigate', 'navigate', '/'), step(2, 'click', 'click: Clicking Generate Key button', '/'), step(3, 'click', 'click: Clicking Copy Key button', '/')];
  assert.deepEqual(checkPageTransitions([{ label: 'Generate Key', ordinal: 2 }, { label: 'Copy Key', ordinal: 3 }], steps), []);
});

test('REJECT: the first cited click did not happen on the start page', () => {
  const steps = [step(1, 'navigate', 'navigate', '/'), step(2, 'click', 'click: Clicking Projects', '/'), step(3, 'click', 'click: Clicking API Keys link', '/projects')];
  const p = checkPageTransitions([{ label: 'API Keys', ordinal: 3 }], steps);
  assert.match(p.join(' '), /"API Keys" was not clicked on the exploration's start page/);
});

test('REJECT: page changed between two cited clicks but not because of the first one (an uncited click caused it)', () => {
  const steps = [
    step(1, 'navigate', 'navigate', '/'),
    step(2, 'click', 'click: Clicking Developer Settings', '/'), // A: stays on "/"
    step(3, 'click', 'click: Clicking Help', '/'), // uncited click that actually navigates
    step(4, 'click', 'click: Clicking API Keys link', '/developer'), // B happens on /developer
  ];
  const p = checkPageTransitions([{ label: 'Developer Settings', ordinal: 2 }, { label: 'API Keys', ordinal: 4 }], steps);
  assert.match(p.join(' '), /does not show that clicking "Developer Settings" led to the page where "API Keys" was clicked/);
});

test('REJECT: a navigate step (typed address) between two cited clicks', () => {
  const steps = [
    step(1, 'navigate', 'navigate', '/'),
    step(2, 'click', 'click: Clicking Developer Settings', '/'),
    step(3, 'navigate', `navigate: Navigate to ${APP}/developer`, '/developer'),
    step(4, 'click', 'click: Clicking API Keys link', '/developer'),
  ];
  const p = checkPageTransitions([{ label: 'Developer Settings', ordinal: 2 }, { label: 'API Keys', ordinal: 4 }], steps);
  assert.match(p.join(' '), /navigated without a click/);
});

test('REJECT: missing page URLs mean the route cannot be established', () => {
  const steps = [step(1, 'navigate', 'navigate', '/'), step(2, 'click', 'click: Clicking Developer Settings', '/'), step(3, 'click', 'click: Clicking API Keys link', null)];
  assert.match(checkPageTransitions([{ label: 'Developer Settings', ordinal: 2 }, { label: 'API Keys', ordinal: 3 }], steps).join(' '), /was not recorded/);
});

test('validateProposal applies the transition check (sidebar labels but broken transition -> rejected)', () => {
  // After "Developer Settings" the next recorded step is still on "/", then "API Keys"
  // is clicked on /developer: the evidence does not show the first click caused that change.
  const broken: EvidenceStep[] = [
    step(1, 'navigate', `navigate: Navigate to ${APP}/`, '/'),
    step(2, 'analyze', 'analyze: the main heading of the starting page', '/'),
    step(3, 'click', 'click: Clicking Developer Settings in the main navigation menu', '/'),
    step(4, 'analyze', 'analyze: the page after the click', '/'),
    step(5, 'click', 'click: Clicking API Keys link', '/developer'),
    step(6, 'click', 'click: Clicking Generate Key button', '/developer/api-keys'),
  ];
  const v = validateProposal(SIDEBAR_PROPOSAL, DOC, FILE, ev(broken));
  assert.equal(v.ok, false);
  assert.match(v.problems.join(' '), /does not show that clicking "Developer Settings" led to the page where "API Keys" was clicked/);
});

test('real card-route exploration still passes the transition check (/ -> /developer/api-keys via the card click)', () => {
  const fx = JSON.parse(readFileSync(path.join(TESTS_DIR, 'fixtures', 'acmedesk-explore-card-route.json'), 'utf8'));
  assert.deepEqual(checkPageTransitions([{ label: '1 API keys', ordinal: 3 }, { label: 'Generate Key', ordinal: 4 }], fx.evidenceSteps), []);
});
