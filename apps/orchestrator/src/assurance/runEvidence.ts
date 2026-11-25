// Post-execution verification of documented outcomes from a Kane evidence pack (B5). Pure.
//
// Evidence format, as Kane 0.10.5 wrote it in KaneVerity's own runs (2026-11-21 retest pack;
// docs/ASSURANCE_PLAN.md section 13.8):
//   run.yaml                       status: finalized, environment.producer {name, version},
//                                  environment.surfaces [urls]
//   tests/<member>/result.yaml     test, status, definition_id, steps[{id, ordinal, status,
//                                  kind (navigate|click|analyze|assert|...), action_id, ...}]
//   tests/<member>/steps/*/step.json  {kind, status, summary, url, action_id, ...}
//   tests/<member>/auteur/execution.json  operations; an ASSERTION operation has
//                                  operation_id (= the step's action_id), assertion_status,
//                                  assertion_tree {status, description, sub_results[{passed,
//                                  operator, expected, store_key, variable_refs}]}; a
//                                  TEXTUAL_ANALYZER operation has query_variable_name,
//                                  query_variable_value and reasoning (the question asked).
// Kane's code (0.10.5) reads a member's per-criterion steps from result.yaml `verifies`; the
// testrun pack layout itself has not been seen yet, so anything missing fails closed.
//
// What counts: for each documented outcome, a passed ASSERTION operation, in the member whose
// definition_id is the approved test's, on an `assert` step tagged with that outcome's criterion
// only, with the observed value recorded and matching the documented value. Never: a step's
// status, its wording, an @verifies tag alone, a `verifies` link or Kane's coverage.

import { readEntry, readIndex, type ZipEntry } from '../kane/zip.ts';

/**
 * What an outcome's evidence must show, from how the documentation states it:
 * - status_region: a message ("The message '…' appears"): the exact text, read from the
 *   DOM of an ARIA status or alert region (role=status / role=alert);
 * - element_value: an exact value ("shows '2 keys'"): the exact text, read from the DOM of a
 *   structurally located element (never a locator made of the asserted text);
 * - baseline_change: no exact value ("the new key is added to the list"): in one execution's
 *   action log, a full read of the list before the action and a full read of the same list
 *   afterwards (same locator). Every key from before must still be there, at least one key must
 *   be new, and the asserted value must be one of the new keys.
 */
export type OutcomeRequirement = 'status_region' | 'element_value' | 'baseline_change';

export function requirementFor(outcomeText: string, labels: string[]): OutcomeRequirement {
  if (!labels.length) return 'baseline_change';
  return /\bmessage\b/i.test(outcomeText) ? 'status_region' : 'element_value';
}

export interface OutcomeTarget {
  outcome: string;
  outcomeText: string;
  /** Exact documented values ('API key generated successfully.', '2 keys'); empty for O2. */
  labels: string[];
  acCid: string;
  acSlug: string;
  testCid: string;
  testSlug: string;
  definitionId: string;
  /** Defaults to requirementFor(outcomeText, labels). */
  requirement?: OutcomeRequirement;
}

export interface OutcomeEvidence {
  outcome: string;
  verified: boolean;
  problems: string[];
  /** How it was established: a DOM-read value, or a DOM-read value compared with a DOM-read baseline. */
  basis: 'dom_value' | 'dom_baseline_change' | null;
  evidence: {
    member: string;
    stepOrdinal: number;
    actionId: string;
    assertionId: string | null;
    operator: string | null;
    expected: string | null;
    observed: string | null;
    /** The analyzer action that read the value from the page (logs/*-actions.ndjson). */
    locator: string | null;
    domCode: string | null;
    /** O2 only: the full list read before the action and the full list read afterwards. */
    baseline: { locator: string; logFile: string; beforeStep: number; before: string[]; afterStep: number; after: string[]; added: string[] } | null;
  } | null;
}

export interface PackVerification {
  packOk: boolean;
  problems: string[];
  producer: string | null;
  runStatus: string | null;
  /** run.yaml environment.run_kind: "author" if any step was authored, else "replay" (Kane 0.10.5). */
  runKind: string | null;
  outcomes: OutcomeEvidence[];
  verified: boolean;
}

interface AnalyzeAction {
  /** The member's log file it came from (one execution's actions log). */
  file: string;
  step: number;
  key: string;
  output: string | null;
  status: string | null;
  code: string;
  locators: string[];
}

const BOOLEAN = /^(true|false)$/i;
/** A locator built from text (Playwright internal:text / has-text): it finds the element by the very text being checked. */
const TEXT_LOCATOR = /internal:text=|:has-text\(|text=/i;
const STATUS_LOCATOR = /internal:role=(status|alert)\b/i;
const READS_TEXT = /\b(innerText|textContent)\b/;
const READS_LIST = /\b(querySelectorAll|rows|cells|children|innerText|textContent)\b/;

/**
 * A list read's value as keys: a JSON array of strings, or one key per line. Malformed,
 * empty, blank or repeated entries make it unusable (null): the comparison would be ambiguous.
 */
export function parseKeyList(v: string | null): string[] | null {
  if (v === null) return null;
  const t = v.trim();
  // An object (or any other JSON value) is not a list of keys.
  if (!t || t.startsWith('{')) return null;
  let items: unknown[];
  if (t.startsWith('[')) {
    try {
      const j = JSON.parse(t);
      if (!Array.isArray(j)) return null;
      items = j;
    } catch {
      return null;
    }
  } else items = t.split(/\r?\n/);
  const keys: string[] = [];
  for (const x of items) {
    if (typeof x !== 'string' || !x.trim()) return null;
    keys.push(x.trim());
  }
  return keys.length && new Set(keys).size === keys.length ? keys : null;
}

/**
 * O2: the full list before and after the action, read in the same execution (the same action
 * log) through the same locator as the asserted value. Returns the comparison, or why it fails.
 */
function compareLists(actions: AnalyzeAction[], a: AnalyzeAction, locator: string, observed: string): { beforeStep: number; before: string[]; afterStep: number; after: string[]; added: string[] } | string {
  const reads = actions.filter((b) => b !== a && b.key !== a.key && b.locators.join(' | ') === locator && b.status === 'success' && !!b.code && READS_LIST.test(b.code));
  const other = actions.filter((b) => b !== a && b.key !== a.key && b.file !== a.file && b.locators.join(' | ') === locator);
  const same = reads.filter((b) => b.file === a.file);
  const beforeReads = same.filter((b) => b.step < a.step);
  const afterReads = same.filter((b) => b.step >= a.step);
  if (!beforeReads.length) return `no full read of the same list (${locator}) before step ${a.step} in the same execution${other.length ? ` (a read of it exists only in another execution's log)` : ''}`;
  if (!afterReads.length) return `no full read of the same list (${locator}) after the action in the same execution, so it cannot be shown that every earlier key is still there`;
  const parsed = (xs: AnalyzeAction[]) => xs.map((b) => ({ b, keys: parseKeyList(b.output) }));
  const pb = parsed(beforeReads);
  const pa = parsed(afterReads);
  const bad = [...pb, ...pa].find((x) => !x.keys);
  if (bad) return `the list read "${bad.b.key}" at step ${bad.b.step} is empty, malformed or repeats a key (${JSON.stringify(bad.b.output)})`;
  const sig = (k: string[]) => JSON.stringify([...k].sort());
  if (new Set(pb.map((x) => sig(x.keys!))).size !== 1) return 'the reads of the list before the action disagree, so the original list is ambiguous';
  if (new Set(pa.map((x) => sig(x.keys!))).size !== 1) return 'the reads of the list after the action disagree, so the resulting list is ambiguous';
  const before = pb[pb.length - 1].keys!;
  const lastBefore = pb[pb.length - 1].b;
  const after = pa[pa.length - 1].keys!;
  const lastAfter = pa[pa.length - 1].b;
  const lost = before.filter((k) => !after.includes(k));
  if (lost.length) return `keys from before the action are missing afterwards (${lost.map((k) => JSON.stringify(k)).join(', ')}), so the list was replaced, not added to`;
  const added = after.filter((k) => !before.includes(k));
  if (!added.length) return 'the list is unchanged after the action: no key was added';
  if (before.includes(observed)) return `the value ${JSON.stringify(observed)} was already in the list before the action`;
  if (!added.includes(observed)) return `the asserted value ${JSON.stringify(observed)} is not one of the keys added to the list (${added.map((k) => JSON.stringify(k)).join(', ')})`;
  return { beforeStep: lastBefore.step, before, afterStep: lastAfter.step, after, added };
}

/**
 * One outcome's evidence: the passed ASSERTION on its tagged assert step, the analyzer action
 * that read the asserted value from the DOM (cross-checked), and the requirement's DOM rule.
 */
function evaluateOutcome(t: OutcomeTarget, member: string, tagged: Record<string, unknown>[], ops: Record<string, unknown>[], actions: AnalyzeAction[], out: OutcomeEvidence) {
  const p = out.problems;
  const req = t.requirement ?? requirementFor(t.outcomeText, t.labels);
  const reasons: string[] = [];
  for (const st of tagged.filter((s) => s.kind === 'assert' && s.status === 'passed')) {
    const op = ops.find((o) => o.command === 'ASSERTION' && o.operation_id === st.action_id);
    if (!op) {
      reasons.push(`step ${String(st.ordinal)} has no ASSERTION record`);
      continue;
    }
    const tree = obj(op.assertion_tree);
    const subs = (Array.isArray(tree?.sub_results) ? tree!.sub_results : []).map(obj).filter((x): x is Record<string, unknown> => !!x);
    if (str(op.assertion_status) !== 'true' || str(tree?.status) !== 'passed' || !subs.length || !subs.every((s) => s.passed === true)) {
      reasons.push(`the assertion on step ${String(st.ordinal)} did not pass`);
      continue;
    }
    for (const sub of subs) {
      const expected = str(sub.expected);
      const refs = obj(sub.variable_refs);
      const observed = refs ? (Object.values(refs).map(str).find((x) => x !== null) ?? null) : null;
      const storeKey = str(sub.store_key);
      if (observed === null || !storeKey) {
        reasons.push('the assertion recorded no observed value');
        continue;
      }
      const reads = actions.filter((a) => a.key === storeKey);
      const a = reads[reads.length - 1];
      if (!a) {
        reasons.push(`no analyzer action in the action log read "${storeKey}"`);
        continue;
      }
      if (a.output !== observed) {
        reasons.push(`the action log's value for "${storeKey}" (${JSON.stringify(a.output)}) differs from the assertion's (${JSON.stringify(observed)})`);
        continue;
      }
      if (a.status !== 'success' || !a.code) {
        reasons.push(`"${storeKey}" was not read by a successful DOM operation`);
        continue;
      }
      if (!a.locators.length) {
        reasons.push(`"${storeKey}" was read without a recorded locator`);
        continue;
      }
      const locator = a.locators.join(' | ');
      const structural = a.locators.every((l) => !TEXT_LOCATOR.test(l) && !t.labels.some((lb) => l.includes(lb)));
      if (req === 'status_region' || req === 'element_value') {
        if (BOOLEAN.test(observed)) {
          reasons.push(`"${storeKey}" is a yes/no result (${observed}), not the observed text`);
          continue;
        }
        if (!t.labels.every((l) => observed === l)) {
          reasons.push(`the observed text ${JSON.stringify(observed)} is not exactly ${t.labels.map((l) => `'${l}'`).join(', ')}`);
          continue;
        }
        if (!READS_TEXT.test(a.code)) {
          reasons.push(`the DOM operation for "${storeKey}" does not read the element's text`);
          continue;
        }
        if (!structural) {
          reasons.push(`the element was located by its text (${locator}), so the check does not establish where the text was`);
          continue;
        }
        if (req === 'status_region' && !a.locators.some((l) => STATUS_LOCATOR.test(l))) {
          reasons.push(`the message was not read from a status region (role=status or role=alert); locator: ${locator}`);
          continue;
        }
        out.basis = 'dom_value';
        out.evidence = { member, stepOrdinal: Number(st.ordinal) || 0, actionId: String(st.action_id), assertionId: str(tree?.assertion_id), operator: str(sub.operator), expected, observed, locator, domCode: a.code, baseline: null };
        return;
      }
      // baseline_change: the asserted value is a new key, and the same list (same locator, same
      // execution's action log) was read in full before and after: nothing lost, something added.
      if (BOOLEAN.test(observed) || !observed.trim()) {
        reasons.push(`"${storeKey}" is a yes/no or empty result (${JSON.stringify(observed)}); a before/after comparison needs the new value itself`);
        continue;
      }
      if (!structural || !READS_LIST.test(a.code)) {
        reasons.push(`the list was not read by a structural DOM operation (${locator})`);
        continue;
      }
      const cmp = compareLists(actions, a, locator, observed);
      if (typeof cmp === 'string') {
        reasons.push(cmp);
        continue;
      }
      out.basis = 'dom_baseline_change';
      out.evidence = { member, stepOrdinal: Number(st.ordinal) || 0, actionId: String(st.action_id), assertionId: str(tree?.assertion_id), operator: str(sub.operator), expected, observed, locator, domCode: a.code, baseline: { locator, logFile: a.file, ...cmp } };
      return;
    }
  }
  p.push(`${t.outcome} is not established by DOM evidence on a passed assert step of ${t.testSlug} tagged ${t.acSlug}${reasons.length ? `: ${[...new Set(reasons)].join('; ')}` : ''}.`);
}

// ---------------------------------------------------------------------------
// A small YAML subset reader (maps, block lists, flow lists, quoted scalars). It only reads.
// ---------------------------------------------------------------------------

type Yaml = string | number | boolean | null | Yaml[] | { [k: string]: Yaml };

function scalar(raw: string): Yaml {
  const v = raw.trim();
  if (v === '' || v === '~' || v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?[0-9]+(\.[0-9]+)?$/.test(v)) return Number(v);
  if (v.startsWith('[') && v.endsWith(']')) return v.slice(1, -1).split(',').map((x) => scalar(x)).filter((x) => x !== null);
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

export function parseYaml(text: string): Yaml {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
  let i = 0;
  function block(indent: number): Yaml {
    if (i >= lines.length) return null;
    if (lines[i].text.startsWith('- ') || lines[i].text === '-') {
      const arr: Yaml[] = [];
      while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
        const rest = lines[i].text.slice(1).trim();
        const itemIndent = indent + 2;
        if (!rest) {
          i++;
          arr.push(block(lines[i]?.indent ?? itemIndent));
        } else if (/^[A-Za-z0-9_.-]+:( |$)/.test(rest)) {
          // A map item starting on the dash line: treat it as a line at itemIndent.
          lines[i] = { indent: itemIndent, text: rest };
          arr.push(map(itemIndent));
        } else {
          i++;
          arr.push(scalar(rest));
        }
      }
      return arr;
    }
    return map(indent);
  }
  function map(indent: number): Yaml {
    const obj: { [k: string]: Yaml } = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
      const m = /^([A-Za-z0-9_.-]+):(?: (.*))?$/.exec(lines[i].text);
      if (!m) {
        i++;
        continue;
      }
      i++;
      if (m[2] !== undefined && m[2].trim() !== '') obj[m[1]] = scalar(m[2]);
      else if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && lines[i].text.startsWith('- ')))) obj[m[1]] = block(lines[i].indent);
      else obj[m[1]] = null;
    }
    return obj;
  }
  return block(lines[0]?.indent ?? 0);
}

const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);

function originOf(u: string): string | null {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** Every operation object in Kane's execution.json, wherever it is nested. */
function operations(v: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(v)) v.forEach((x) => operations(x, out));
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.command === 'string' && typeof o.operation_id === 'string') out.push(o);
    for (const x of Object.values(o)) operations(x, out);
  }
  return out;
}

export function verifyPack(buf: Buffer, input: { appOrigin: string; pinnedVersion: string; targets: OutcomeTarget[]; requireReplay?: boolean }): PackVerification {
  const problems: string[] = [];
  const res: PackVerification = { packOk: false, problems, producer: null, runStatus: null, runKind: null, outcomes: [], verified: false };
  let entries: Map<string, ZipEntry>;
  try {
    entries = readIndex(buf).entries;
  } catch (err) {
    problems.push(`The evidence pack cannot be read: ${(err as Error).message}`);
    res.outcomes = input.targets.map((t) => ({ outcome: t.outcome, verified: false, problems: ['No readable evidence.'], basis: null, evidence: null }));
    return res;
  }
  const text = (name: string) => {
    const e = entries.get(name);
    return e ? readEntry(buf, e).toString('utf8') : null;
  };

  // The run as a whole: finalized, produced by the pinned Kane, only the application's origin.
  const run = obj(parseYaml(text('run.yaml') ?? ''));
  const env = obj(run?.environment);
  const producer = obj(env?.producer);
  res.runStatus = str(run?.status);
  res.producer = producer ? `${str(producer.name)} ${str(producer.version)}` : null;
  if (!run) problems.push('The pack has no readable run.yaml.');
  if (res.runStatus !== 'finalized') problems.push(`The run is not finalized (status: ${res.runStatus ?? 'missing'}).`);
  if (str(producer?.name) !== 'kane-cli' || str(producer?.version) !== input.pinnedVersion) problems.push(`The pack was not produced by kane-cli ${input.pinnedVersion} (${res.producer ?? 'unknown'}).`);
  res.runKind = str(env?.run_kind);
  // A verification run must be a pure replay: any authored step makes it an authoring run.
  if (input.requireReplay && res.runKind !== 'replay') problems.push(`This run is not a pure replay (run_kind: ${res.runKind ?? 'missing'}): Kane authored steps, so it cannot verify anything.`);
  for (const s of Array.isArray(env?.surfaces) ? env!.surfaces : []) {
    const o = typeof s === 'string' ? originOf(s) : null;
    if (o && o !== input.appOrigin) problems.push(`The run reached an unexpected origin (${o}).`);
  }

  // Members (one per test), with their result.yaml.
  const members = new Map<string, Record<string, unknown>>();
  for (const name of entries.keys()) {
    const m = /^tests\/([^/]+)\/result\.yaml$/.exec(name);
    if (m) {
      const r = obj(parseYaml(text(name) ?? ''));
      if (r) members.set(m[1], r);
      else problems.push(`tests/${m[1]}/result.yaml cannot be read.`);
    }
  }
  // Every step's URL must be on the application's origin.
  for (const name of entries.keys()) {
    if (!/^tests\/[^/]+\/steps\/[^/]+\/step\.json$/.test(name)) continue;
    try {
      const sj = JSON.parse(text(name) ?? '{}');
      const o = typeof sj.url === 'string' && sj.url ? originOf(sj.url) : null;
      if (typeof sj.url === 'string' && sj.url && !/^(about:|data:)/.test(sj.url) && o !== input.appOrigin) problems.push(`A step in ${name.split('/')[1]} was on an unexpected origin (${o ?? 'not a web page'}).`);
    } catch {
      problems.push(`${name} is not readable JSON.`);
    }
  }
  res.packOk = problems.length === 0;

  // Analyzer actions per member, from every logs/*-actions.ndjson (the DOM reads Kane ran).
  const actionLog = (member: string): AnalyzeAction[] => {
    const out: AnalyzeAction[] = [];
    for (const name of [...entries.keys()].filter((n) => n.startsWith(`tests/${member}/logs/`) && n.endsWith('-actions.ndjson')).sort()) {
      for (const line of (text(name) ?? '').split('\n')) {
        if (!line.trim()) continue;
        let o: Record<string, unknown>;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (o.action_type !== 'analyze') continue;
        const params = obj(o.action_params) ?? {};
        const key = str(o.output_variable) ?? str(params.key);
        if (!key) continue;
        out.push({ file: name.split('/').pop()!, step: Number(o.step) || 0, key, output: str(o.output_value), status: str(o.status), code: str(params.code_js) ?? '', locators: Array.isArray(params.locators) ? (params.locators as unknown[]).filter((x): x is string => typeof x === 'string') : [] });
      }
    }
    return out;
  };

  const usedMembers = new Set<string>();
  res.outcomes = input.targets.map((t): OutcomeEvidence => {
    const p: string[] = [];
    const out: OutcomeEvidence = { outcome: t.outcome, verified: false, problems: p, basis: null, evidence: null };
    const mine = [...members.entries()].filter(([, r]) => str(r.definition_id) === t.definitionId);
    if (mine.length !== 1) {
      p.push(mine.length === 0 ? `No evidence for test ${t.testSlug} as approved (definition ${t.definitionId.slice(0, 19)}…).` : `More than one member claims test ${t.testSlug}.`);
      return out;
    }
    const [member, result] = mine[0];
    if (usedMembers.has(member)) p.push(`Test ${t.testSlug}'s evidence is shared with another outcome.`);
    usedMembers.add(member);
    if (str(result.status) !== 'passed') p.push(`Test ${t.testSlug} did not pass (status: ${str(result.status) ?? 'missing'}).`);
    const steps = (Array.isArray(result.steps) ? result.steps : []).map(obj).filter((x): x is Record<string, unknown> => !!x);
    const tagged = steps.filter((s) => Array.isArray(s.verifies) && (s.verifies as unknown[]).includes(t.acSlug));
    if (!tagged.length) {
      p.push(`No step of test ${t.testSlug} is tagged in the evidence with ${t.acSlug}.`);
      return out;
    }
    if (steps.some((s) => Array.isArray(s.verifies) && (s.verifies as unknown[]).some((v) => v !== t.acSlug))) p.push(`Test ${t.testSlug} also carries steps tagged with other criteria; one test must assert one outcome.`);
    let exec: unknown = null;
    try {
      exec = JSON.parse(text(`tests/${member}/auteur/execution.json`) ?? 'null');
    } catch {
      /* reported below */
    }
    if (!exec) {
      p.push(`Test ${t.testSlug} has no readable execution record (auteur/execution.json).`);
      return out;
    }
    const ops = operations(exec);
    const actions = actionLog(member);
    evaluateOutcome(t, member, tagged, ops, actions, out);
    out.verified = p.length === 0 && res.packOk;
    if (!res.packOk) p.push('The pack itself did not pass its checks.');
    return out;
  });
  res.verified = res.packOk && res.outcomes.length > 0 && res.outcomes.every((o) => o.verified);
  return res;
}
