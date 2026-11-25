// Test-design records in the shape Kane 0.10.5 wrote them (real store, records 4-7),
// plus a forced redesign (generation 2) as Kane's committer would record it:
// supersessions of the old scenario and test, three one-outcome scenarios, three
// tests. Test-only; nothing here touches a real store.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const cidOf = (label: string, content: unknown) => `sha256:${sha(label + JSON.stringify(content))}`;
const by = { kind: 'ai', id: 'design-agent' };

export const AC_TEXT = {
  list: 'After generating the key, the new key appears in the API keys list.',
  count: "After generating the key, the key count below the list shows '2 keys'.",
  message: "After generating the key, the message 'API key generated successfully.' appears.",
};

/** The criteria as Kane 0.10.5 recorded them in the real store (record #4). */
export const AC_GEN1 = {
  list: { text: AC_TEXT.list, kind: 'presence', risk: 'high', derived: true, expected_answer: { kind: 'presence', operator: 'exists', operand: 'the newly generated key in the API keys list', baseline: null } },
  count: { text: AC_TEXT.count, kind: 'absolute', risk: 'high', derived: true, expected_answer: { kind: 'absolute', operator: 'equals', operand: '2 keys', baseline: null } },
  message: { text: AC_TEXT.message, kind: 'presence', risk: 'high', derived: true, expected_answer: { kind: 'presence', operator: 'exists', operand: 'API key generated successfully.', baseline: null } },
};
/** O2's criterion re-sent by a redesign from the acs phase: the same text, now a before/after (delta) criterion. */
export const AC_LIST_DELTA = { text: AC_TEXT.list, kind: 'delta', risk: 'high', derived: true, expected_answer: { kind: 'delta', operator: 'changed-by', operand: '1', baseline: 'the keys in the API keys list before generating' } };

export interface DesignIds {
  ac1: string; // list (O2)
  ac2: string; // count (O3)
  ac3: string; // message (O1)
  sc1: string;
  t1: string;
  gap1: string;
  definitionId1: string;
  t1Body: string;
}

export const T1_BODY = `# Generate an API key and check the documented outcomes

> From a fresh browser session at {{app_url}}/, follow 'Developer Settings', 'API Keys', and 'Generate Key' in order, then observe the success message, newly listed key, and the '2 keys' count below the list.

## Step 1

In a fresh browser session, start at {{app_url}}/ and open 'Developer Settings' from the left navigation menu.

## Step 2

From 'Developer Settings', open 'API Keys' and store the current API keys list entries as pre_generation_keys.

## Step 3 @verifies ac-1, ac-2, ac-3

On 'API Keys', use 'Generate Key', then assert the message 'API key generated successfully.' appears, an entry not in pre_generation_keys is present in the API keys list, and the key count below the list shows '2 keys'.
`;

function test(title: string, body: string, check: Record<string, unknown>, objectives: string) {
  const definitionId = `sha256:${sha('def' + body)}`;
  return { content: { title, check, definitionId, derived: true, test_md_blob: body, objectives_blob: objectives }, definitionId };
}

/** Generation 1 (records 4-7 after the use-case records): one scenario, one test, one gap. */
export function generation1(uc: string): { records: Record<string, unknown>[]; ids: DesignIds } {
  const a1 = AC_GEN1.list;
  const a2 = AC_GEN1.count;
  const a3 = AC_GEN1.message;
  const ac1 = cidOf('ac', a1);
  const ac2 = cidOf('ac', a2);
  const ac3 = cidOf('ac', a3);
  const scC = { title: 'Generate an API key through documented navigation', intent: 'Follow the documented steps.', case_type: 'happy', derived: true };
  const sc1 = cidOf('scenario', scC);
  const t = test('Generate an API key and check the documented outcomes', T1_BODY, { kind: 'presence', operator: 'exists', operand: 'the newly generated key in the API keys list', baseline: null, verified_against: 'ac-1', expected_mode: 'authored' }, 'objectives:\n  - objective: x\n    step: 1\n');
  const t1 = cidOf('test', t.content);
  const gapC = { kind: 'incomplete', question: { header: 'Application URL', prompt: 'What is the application base URL to use for {{app_url}}/?' }, derived: true, uc, risk: 'high', ref: 'sc-1' };
  const gap1 = cidOf('gap', gapC);
  const phase = (p: string) => ({ design_phase: { uc_root: uc, generation: 1, phase: p, completeness: 'complete', payload_digest: 'sha256:' + '0'.repeat(64) }, intent_verb: 'design', created_by: { build: '0.10.5', by } });
  const e = (type: string, src: string, dst: string) => ({ ecid: `sha256:${sha(type + src + dst)}`, type, src, dst, props: {} });
  return {
    ids: { ac1, ac2, ac3, sc1, t1, gap1, definitionId1: t.definitionId, t1Body: T1_BODY },
    records: [
      { ...phase('acs'), design_generation: { uc_root: uc, uc_cid: uc, generation: 1, supersedes_generation: null }, nodes: [{ cid: ac1, label: 'ac', content: a1 }, { cid: ac2, label: 'ac', content: a2 }, { cid: ac3, label: 'ac', content: a3 }], edges: [e('scoped_to', ac1, uc), e('scoped_to', ac2, uc), e('scoped_to', ac3, uc)], names: [{ cid: ac1, slug: 'ac-1', by }, { cid: ac2, slug: 'ac-2', by }, { cid: ac3, slug: 'ac-3', by }] },
      { ...phase('scenarios'), nodes: [{ cid: sc1, label: 'scenario', content: scC }], edges: [e('belongs_to', sc1, uc)], names: [{ cid: sc1, slug: 'sc-1', by }] },
      { ...phase('wiring'), nodes: [], edges: [e('exercises', sc1, ac1), e('exercises', sc1, ac2), e('exercises', sc1, ac3)] },
      { ...phase('tests'), nodes: [{ cid: gap1, label: 'gap', content: gapC }, { cid: t1, label: 'test', content: t.content }], edges: [e('automates', t1, sc1), e('verifies', t1, ac1), e('verifies', t1, ac2), e('verifies', t1, ac3)], names: [{ cid: gap1, slug: 'gap-1', by }, { cid: t1, slug: 't-1', by }] },
    ],
  };
}

const NAV = "## Step 1\n\nIn a fresh browser session, start at {{app_url}}/ and open 'Developer Settings' from the left navigation menu.\n\n## Step 2\n\nOpen 'API Keys'.\n";

export const GEN2_BODIES = {
  message: `# Check the success message\n\n> One outcome.\n\n${NAV}\n## Step 3 @verifies ac-3\n\nUse 'Generate Key', then assert the message 'API key generated successfully.' appears.\n`,
  list: `# Check the new key in the list\n\n> One outcome.\n\n${NAV}\n## Step 3\n\ncapture baseline: the rows of the API keys list\n\n## Step 4 @verifies ac-4\n\nUse 'Generate Key', then assert every key captured in the baseline is still in the API keys list and exactly one new key was added.\n`,
  count: `# Check the key count\n\n> One outcome.\n\n${NAV}\n## Step 3 @verifies ac-2\n\nUse 'Generate Key', then assert the key count below the list shows '2 keys'.\n`,
};

/**
 * A forced redesign: generation 2 with three one-outcome scenario/test pairs. By default it
 * starts at the acs phase (the planned command) and re-sends O2's criterion with the same text
 * as a delta criterion, so Kane supersedes ac-1 with ac-4 ("AC re-emitted with changed content
 * (text-matched successor)"); ac-2 and ac-3 are re-sent unchanged (the same content ids, no new
 * nodes). With from: 'scenarios', criteria are not touched and ac-1 stays a presence criterion.
 * With acText, O2's criterion is re-sent with different text: Kane adds it and keeps ac-1 live.
 */
export function generation2(uc: string, g1: DesignIds, opts: { bodies?: Partial<typeof GEN2_BODIES>; checks?: Partial<Record<'message' | 'list' | 'count', Record<string, unknown>>>; from?: 'acs' | 'scenarios'; acText?: string } = {}) {
  const from = opts.from ?? 'acs';
  const newAc = from === 'acs' ? (opts.acText ? { ...AC_LIST_DELTA, text: opts.acText } : AC_LIST_DELTA) : null;
  const ac4 = newAc ? cidOf('ac', newAc) : null;
  const listAc = ac4 ?? g1.ac1;
  const listSlug = ac4 ? 'ac-4' : 'ac-1';
  const bodies = { ...GEN2_BODIES, ...(ac4 ? {} : { list: GEN2_BODIES.list.replace('@verifies ac-4', '@verifies ac-1') }), ...opts.bodies };
  const scen = (title: string) => ({ title, intent: 'One documented outcome.', case_type: 'happy', derived: true });
  const s2 = scen('Success message after generating a key');
  const s3 = scen('New key added to the list');
  const s4 = scen('Key count after generating a key');
  const sc2 = cidOf('scenario', s2);
  const sc3 = cidOf('scenario', s3);
  const sc4 = cidOf('scenario', s4);
  const tm = test('Check the success message', bodies.message, opts.checks?.message ?? { kind: 'presence', operator: 'exists', operand: 'API key generated successfully.', baseline: null, verified_against: 'ac-3', expected_mode: 'authored' }, 'objectives:\n  - objective: a\n    step: 1\n');
  const tl = test('Check the new key in the list', bodies.list, opts.checks?.list ?? { kind: 'delta', operator: 'changed-by', operand: '1', baseline: 'rows of the API keys list', verified_against: listSlug, expected_mode: 'authored' }, 'objectives:\n  - objective: a\n    step: 1\n  - objective: capture\n    step: 3\n    baseline: true\n');
  const tc = test('Check the key count', bodies.count, opts.checks?.count ?? { kind: 'absolute', operator: 'equals', operand: '2 keys', baseline: null, verified_against: 'ac-2', expected_mode: 'authored' }, 'objectives:\n  - objective: a\n    step: 1\n');
  const t2 = cidOf('test', tm.content);
  const t3 = cidOf('test', tl.content);
  const t4 = cidOf('test', tc.content);
  const phase = (p: string) => ({ design_phase: { uc_root: uc, generation: 2, phase: p, completeness: 'complete', payload_digest: 'sha256:' + '1'.repeat(64) }, intent_verb: 'design', created_by: { build: '0.10.5', by } });
  const e = (type: string, src: string, dst: string) => ({ ecid: `sha256:${sha(type + src + dst)}`, type, src, dst, props: {} });
  const sup = (old: string) => ({ kind: 'node', old, new: null, reason: '--force redesign of uc-1 by design-agent', by });
  const genStart = { design_generation: { uc_root: uc, uc_cid: uc, generation: 2, supersedes_generation: 1, because: 'forced redesign (--force)' } };
  const acsRecord = newAc
    ? [
        {
          ...phase('acs'),
          ...genStart,
          nodes: [{ cid: ac4!, label: 'ac', content: newAc }],
          edges: [e('scoped_to', ac4!, uc)],
          // Kane supersedes a live criterion re-sent with the same text (normalised) and changed content.
          supersessions: newAc.text === AC_TEXT.list ? [{ kind: 'node', old: g1.ac1, new: ac4, reason: 'AC re-emitted with changed content by design-agent (text-matched successor)', by }] : [],
          names: [{ cid: ac4!, slug: 'ac-4', by }],
        },
      ]
    : [];
  return {
    ids: { sc2, sc3, sc4, t2, t3, t4, ac4, listAc, defs: { message: tm.definitionId, list: tl.definitionId, count: tc.definitionId }, bodies },
    records: [
      ...acsRecord,
      { ...phase('scenarios'), ...(newAc ? {} : genStart), nodes: [{ cid: sc2, label: 'scenario', content: s2 }, { cid: sc3, label: 'scenario', content: s3 }, { cid: sc4, label: 'scenario', content: s4 }], edges: [e('belongs_to', sc2, uc), e('belongs_to', sc3, uc), e('belongs_to', sc4, uc)], supersessions: [sup(g1.sc1)], names: [{ cid: sc2, slug: 'sc-2', by }, { cid: sc3, slug: 'sc-3', by }, { cid: sc4, slug: 'sc-4', by }] },
      { ...phase('wiring'), nodes: [], edges: [e('exercises', sc2, g1.ac3), e('exercises', sc3, listAc), e('exercises', sc4, g1.ac2)] },
      {
        ...phase('tests'),
        nodes: [{ cid: t2, label: 'test', content: tm.content }, { cid: t3, label: 'test', content: tl.content }, { cid: t4, label: 'test', content: tc.content }],
        edges: [e('automates', t2, sc2), e('verifies', t2, g1.ac3), e('automates', t3, sc3), e('verifies', t3, listAc), e('automates', t4, sc4), e('verifies', t4, g1.ac2)],
        supersessions: [sup(g1.t1)],
        names: [{ cid: t2, slug: 't-2', by }, { cid: t3, slug: 't-3', by }, { cid: t4, slug: 't-4', by }],
      },
    ],
  };
}

/** Append a record with a correct hash chain (fake-hashes.json, as the fake Kane CLI keeps it). */
export async function appendRecord(storeDir: string, rec: Record<string, unknown>) {
  const hashes = JSON.parse(await readFile(path.join(storeDir, 'fake-hashes.json'), 'utf8'));
  const seq = (await readdir(path.join(storeDir, 'commits'))).length + 1;
  const body = JSON.stringify({ seq, prev_hash: hashes[String(seq - 1)], ts: new Date().toISOString(), proposal_id: null, nodes: [], edges: [], review: [], supersessions: [], source_head_moves: {}, schema_version: 'assurance/context@1', parents: [hashes[String(seq - 1)]], ...rec });
  const hex = sha(body);
  await writeFile(path.join(storeDir, 'commits', `${String(seq).padStart(6, '0')}-${hex.slice(0, 12)}.json`), body);
  hashes[String(seq)] = `sha256:${hex}`;
  await writeFile(path.join(storeDir, 'fake-hashes.json'), JSON.stringify(hashes));
  return seq;
}

/** A generated *_test.md file as Kane writes it (frontmatter pin + body). */
export async function writeTestFile(workspace: string, name: string, slug: string, definitionId: string, body: string) {
  const dir = path.join(workspace, '.testmuai', 'tests');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}_test.md`), `---\nassurance:\n  id: ${slug}\n  base: ${definitionId}\n---\n${body}`);
}

export async function writeVariables(workspace: string, value = '') {
  const dir = path.join(workspace, '.testmuai', 'variables');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'assurance.json'), JSON.stringify({ app_url: { value, secret: false, description: 'Base URL of the application under test.' } }, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Evidence packs in the shape Kane 0.10.5 wrote them (KaneVerity's 2026-11-21 retest pack):
// run.yaml (environment.run_kind), tests/<member>/result.yaml, steps/<n>-0-<n>/step.json,
// auteur/execution.json (ASSERTION operations), logs/0-actions.ndjson (the analyzer actions:
// output_variable, output_value, action_params {code_js, locators, analyzer_type}).
// ---------------------------------------------------------------------------

export interface PackStep {
  ordinal: number;
  kind: string;
  status?: string;
  actionId: string;
  verifies?: string[];
  url?: string;
}

export interface PackMember {
  name: string;
  definitionId: string;
  status?: string;
  steps: PackStep[];
  /** Operations in auteur/execution.json (ASSERTION, ...). */
  ops: Record<string, unknown>[];
  /** Lines of logs/0-actions.ndjson. */
  actions: Record<string, unknown>[];
  /** Other action logs of the member (another execution), by file name, e.g. "1-actions.ndjson". */
  otherLogs?: Record<string, Record<string, unknown>[]>;
}

/** An analyzer action as Kane logs it: the DOM code it ran, its locators and what it returned. */
export function analyzeAction(step: number, key: string, output: string, codeJs: string, locators: string[], status = 'success'): Record<string, unknown> {
  return { action_id: `an-${key}-${step}`, step, action_type: 'analyze', action_instruction: `Reading ${key}`, output_variable: key, output_value: output, status, action_params: { key, analyzer_type: 'textual_visual', code_js: codeJs, locators, operator: 'equals', transforms: [] } };
}

/** A passed (or failed) ASSERTION on one step, comparing the stored value with an expected one. */
export function assertionOp(actionId: string, storeKey: string, expected: string, observed: string, passed = true): Record<string, unknown> {
  return {
    operation_id: actionId,
    command: 'ASSERTION',
    status: passed ? 'success' : 'failed',
    assertion_status: passed ? 'true' : 'false',
    assertion_tree: { assertion_id: `assert_${actionId}`, status: passed ? 'passed' : 'failed', description: storeKey, sub_results: [{ description: storeKey, passed, operator: 'equals', transforms: [], json_path: null, expected, extracted_value: `{{${storeKey}}}`, store_key: storeKey, variable_refs: { [`{{${storeKey}}}`]: observed } }] },
  };
}

export function buildPack(opts: { members: PackMember[]; runStatus?: string; producerVersion?: string; surfaces?: string[]; appOrigin: string; runKind?: string }, makeZip: (e: { name: string; data: string; method?: 0 | 8 }[]) => Buffer): Buffer {
  const entries: { name: string; data: string; method?: 0 | 8 }[] = [];
  entries.push({
    name: 'run.yaml',
    data: [
      "evidence: '0.1'",
      'run_id: 00000000-0000-0000-0000-000000000001',
      `status: ${opts.runStatus ?? 'finalized'}`,
      'environment:',
      '  producer:',
      '    name: kane-cli',
      `    version: ${opts.producerVersion ?? '0.10.5'}`,
      '  surfaces:',
      ...(opts.surfaces ?? [opts.appOrigin + '/']).map((s) => `    - ${s}`),
      `  run_kind: ${opts.runKind ?? 'replay'}`,
      'totals:',
      `  tests: ${opts.members.length}`,
      '',
    ].join('\n'),
  });
  for (const m of opts.members) {
    const lines = ["evidence: '0.1'", `test: ${m.name}`, `status: ${m.status ?? 'passed'}`, `definition_id: ${m.definitionId}`, 'steps:'];
    for (const s of m.steps) {
      lines.push(`  - id: 0-${s.ordinal}`, `    ordinal: ${s.ordinal}`, `    status: ${s.status ?? 'passed'}`, `    kind: ${s.kind}`, `    action_id: ${s.actionId}`);
      if (s.verifies) lines.push(`    verifies: [${s.verifies.join(', ')}]`);
      entries.push({ name: `tests/${m.name}/steps/${s.ordinal}-0-${s.ordinal}/step.json`, data: JSON.stringify({ kind: s.kind, status: s.status ?? 'passed', summary: `${s.kind}: step ${s.ordinal}`, url: s.url ?? opts.appOrigin + '/developer/api-keys', action_id: s.actionId, ordinal: s.ordinal, id: `0-${s.ordinal}` }) });
    }
    entries.push({ name: `tests/${m.name}/result.yaml`, data: lines.join('\n') + '\n' });
    entries.push({ name: `tests/${m.name}/auteur/execution.json`, data: JSON.stringify({ status: 'success', instructions: [{ status: 'success', children: m.ops }] }) });
    entries.push({ name: `tests/${m.name}/logs/0-actions.ndjson`, data: m.actions.map((a) => JSON.stringify(a)).join('\n') + '\n' });
    for (const [file, lines] of Object.entries(m.otherLogs ?? {})) entries.push({ name: `tests/${m.name}/logs/${file}`, data: lines.map((a) => JSON.stringify(a)).join('\n') + '\n' });
  }
  return makeZip(entries);
}

export const LOCATORS = {
  status: 'internal:role=status',
  list: 'internal:role=table[name="API keys list"i]',
  count: 'internal:testid=[data-testid="api-key-count"s]',
};

/**
 * The three gen-2 tests passing with strong DOM evidence: O1 the exact message read from the
 * status region, O2 a new key: the whole list read before and after (nothing lost, one added), O3 the exact
 * count read from the count element.
 */
export function goodMembers(defs: { message: string; list: string; count: string }, origin: string, listSlug = 'ac-4'): PackMember[] {
  const nav = (n: string): PackStep[] => [
    { ordinal: 1, kind: 'navigate', actionId: `${n}-1`, url: origin + '/' },
    { ordinal: 2, kind: 'click', actionId: `${n}-2` },
    { ordinal: 3, kind: 'click', actionId: `${n}-3` },
    { ordinal: 4, kind: 'click', actionId: `${n}-4` },
  ];
  const rows = "Array.from(el(25).querySelectorAll('tbody tr')).map((r) => r.cells[1].innerText.trim()).join('\\n')";
  return [
    {
      name: 'check-the-success-message-aaaa',
      definitionId: defs.message,
      steps: [...nav('m'), { ordinal: 5, kind: 'assert', actionId: 'm-5', verifies: ['ac-3'] }],
      ops: [assertionOp('m-5', 'success_message', 'API key generated successfully.', 'API key generated successfully.')],
      actions: [analyzeAction(5, 'success_message', 'API key generated successfully.', 'el(23).innerText.trim()', [LOCATORS.status])],
    },
    {
      name: 'check-the-new-key-in-the-list-bbbb',
      definitionId: defs.list,
      steps: [...nav('l'), { ordinal: 5, kind: 'assert', actionId: 'l-5', verifies: [listSlug] }],
      ops: [assertionOp('l-5', 'new_key', 'demo_fake_key_0002', 'demo_fake_key_0002')],
      // The whole list before the action (step 3), the new key and the whole list after it (step 5).
      actions: [
        analyzeAction(3, 'keys_before', 'demo_fake_key_0001', rows, [LOCATORS.list]),
        analyzeAction(5, 'new_key', 'demo_fake_key_0002', "Array.from(el(25).querySelectorAll('tbody tr')).pop().cells[1].innerText.trim()", [LOCATORS.list]),
        analyzeAction(5, 'keys_after', 'demo_fake_key_0001\ndemo_fake_key_0002', rows, [LOCATORS.list]),
      ],
    },
    {
      name: 'check-the-key-count-cccc',
      definitionId: defs.count,
      steps: [...nav('c'), { ordinal: 5, kind: 'assert', actionId: 'c-5', verifies: ['ac-2'] }],
      ops: [assertionOp('c-5', 'api_keys_count', '2 keys', '2 keys')],
      actions: [analyzeAction(5, 'api_keys_count', '2 keys', 'el(41).innerText.trim()', [LOCATORS.count])],
    },
  ];
}
