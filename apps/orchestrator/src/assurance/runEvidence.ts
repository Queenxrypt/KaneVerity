// Post-execution verification of documented outcomes from a Kane evidence pack (B5). Pure.
//
// Evidence format, as Kane 0.10.5 wrote it in KaneVerity's own runs (the 2026-11-21 retest pack,
// docs/ASSURANCE_PLAN.md section 13.8, and the real 2026-11-26 testrun's combined pack, 13.12 and
// 13.13):
//   run.yaml                       status: finalized, environment.producer {name, version},
//                                  run_id, totals; a single pack has environment.run_kind (and
//                                  surfaces); the combined pack of a testrun has merged_from (the
//                                  per-test packs) and environment.run_kind_observed instead
//   tests/<member>/result.yaml     test, status, definition_id, environment.run_kind (combined
//                                  pack: the member's authoritative class), steps[{id, ordinal,
//                                  status, kind (navigate|click|analyze|assert|...), action_id,
//                                  verifies}] — Kane writes each verifies list once with a YAML
//                                  anchor and refers to it with aliases (&ref_0 / *ref_0)
//   tests/<member>/steps/*/step.json  {kind, status, summary, url, action_id, ...}
//   tests/<member>/auteur/execution.json  operations; an ASSERTION operation has
//                                  operation_id (= the step's action_id), assertion_status,
//                                  assertion_tree {status, description, sub_results[{passed,
//                                  operator, expected, store_key, variable_refs}]}; a
//                                  TEXTUAL_ANALYZER operation has query_variable_name,
//                                  query_variable_value and reasoning (the question asked).
//   tests/<member>/logs/<n>-actions.ndjson  the analyze and assert actions (DOM reads).
// Anything missing, unreadable or inconsistent fails closed. The origin is checked from run.yaml
// surfaces (when present) and every step.json url; the network logs are not read.
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
// A small YAML subset reader. It only reads, and it reads only what Kane 0.10.5 writes in the
// pack files KaneVerity checks (run.yaml, tests/<member>/result.yaml; checked on the real
// 2026-11-26 pack): block maps, block lists, flow lists of plain scalars, plain, single- and
// double-quoted scalars, and anchors with aliases (`key: &ref_0` + block, `key: *ref_0`), which
// js-yaml writes for a value it repeats (each step's `verifies` list). Anything else fails
// closed with a YamlError: merge keys, tags, block scalars, flow maps, complex keys, document
// markers, unknown or repeated anchors, a line it cannot place, tab indentation, duplicate keys.
// ---------------------------------------------------------------------------

type Yaml = string | number | boolean | null | Yaml[] | { [k: string]: Yaml };

export class YamlError extends Error {}

const KEY = /^([A-Za-z0-9_.-]+):(?: (.*))?$/;
const ANCHOR_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function scalar(raw: string, line: number): Yaml {
  const v = raw.trim();
  const bad = (what: string) => new YamlError(`unsupported YAML at line ${line}: ${what}`);
  if (v === '' || v === '~' || v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?[0-9]+(\.[0-9]+)?$/.test(v)) return Number(v);
  if (v.startsWith('!')) throw bad('a tag');
  if (/^[|>][-+0-9]*$/.test(v)) throw bad('a block scalar');
  if (v.startsWith('{')) throw bad('a flow map');
  if (/^[%@`]/.test(v)) throw bad('a reserved indicator');
  if (v.startsWith('&') || v.startsWith('*')) throw bad('an anchor or alias in an unsupported position');
  if (v.startsWith('[')) {
    if (!v.endsWith(']')) throw bad('an unclosed flow list');
    const inner = v.slice(1, -1);
    if (/[[\]{}'"&*!]/.test(inner)) throw bad('a flow list with nested, quoted or anchored items');
    if (!inner.trim()) return [];
    return inner.split(',').map((x) => {
      if (!x.trim()) throw bad('an empty flow list item');
      return scalar(x, line);
    });
  }
  if (v.startsWith("'")) {
    if (v.length < 2 || !v.endsWith("'")) throw bad('an unclosed single-quoted string');
    const body = v.slice(1, -1);
    if (/'/.test(body.replace(/''/g, ''))) throw bad('a single-quoted string with an unescaped quote');
    return body.replace(/''/g, "'");
  }
  if (v.startsWith('"')) {
    if (v.length < 2 || !v.endsWith('"')) throw bad('an unclosed double-quoted string');
    try {
      // YAML's double-quoted escapes include JSON's; any other escape fails closed.
      const s = JSON.parse(v);
      if (typeof s !== 'string') throw new Error('not a string');
      return s;
    } catch {
      throw bad('a double-quoted string with an escape KaneVerity does not read');
    }
  }
  if (/ #/.test(v)) throw bad('a comment after a value');
  if (/: /.test(v) || v.endsWith(':')) throw bad('a plain value containing ": "');
  return v;
}

/** Parse the YAML subset above. Throws YamlError on anything outside it (never guesses). */
export function parseYaml(text: string): Yaml {
  const raw = text.split(/\r?\n/);
  const lines: { indent: number; text: string; n: number }[] = [];
  raw.forEach((l, k) => {
    if (!l.trim() || l.trim().startsWith('#')) return;
    const lead = /^[ \t]*/.exec(l)![0];
    if (lead.includes('\t')) throw new YamlError(`unsupported YAML at line ${k + 1}: tab indentation`);
    const t = l.trim();
    if (/^(---|\.\.\.)(\s|$)/.test(t)) throw new YamlError(`unsupported YAML at line ${k + 1}: a document marker`);
    if (/^(-\s+)?<<\s*:/.test(t)) throw new YamlError(`unsupported YAML at line ${k + 1}: a merge key`);
    if (/^(-\s+)?\?(\s|$)/.test(t)) throw new YamlError(`unsupported YAML at line ${k + 1}: a complex key`);
    lines.push({ indent: lead.length, text: t, n: k + 1 });
  });
  const anchors = new Map<string, Yaml>();
  const define = (name: string, value: Yaml, n: number) => {
    if (!ANCHOR_NAME.test(name)) throw new YamlError(`unsupported YAML at line ${n}: an anchor name`);
    if (anchors.has(name)) throw new YamlError(`unsupported YAML at line ${n}: the anchor &${name} is defined twice`);
    anchors.set(name, value);
    return value;
  };
  const alias = (name: string, n: number): Yaml => {
    if (!anchors.has(name)) throw new YamlError(`unsupported YAML at line ${n}: the alias *${name} has no anchor before it`);
    return structuredClone(anchors.get(name)!);
  };
  let i = 0;
  /** A value written after "key: " or "- ": an alias, an anchored inline value, or a scalar. */
  function inline(v: string, n: number): Yaml {
    const a = /^\*(\S+)$/.exec(v);
    if (a) return alias(a[1], n);
    const an = /^&(\S+)\s+(.+)$/.exec(v);
    if (an) return define(an[1], scalar(an[2], n), n);
    return scalar(v, n);
  }
  /** The block that follows a line ending in "key:" or "key: &name" (null when nothing is nested). */
  function nested(parentIndent: number, dashParent: boolean): Yaml {
    if (i < lines.length && (lines[i].indent > parentIndent || (!dashParent && lines[i].indent === parentIndent && isItem(lines[i].text)))) return block(lines[i].indent);
    return null;
  }
  const isItem = (t: string) => t.startsWith('- ') || t === '-';
  function block(indent: number): Yaml {
    if (i >= lines.length) return null;
    if (isItem(lines[i].text)) {
      const arr: Yaml[] = [];
      while (i < lines.length && lines[i].indent === indent && isItem(lines[i].text)) {
        const { n } = lines[i];
        const rest = lines[i].text.slice(1).trim();
        const itemIndent = indent + 2;
        const anchorOnly = /^&(\S+)$/.exec(rest);
        if (!rest || anchorOnly) {
          i++;
          const v = nested(indent, true);
          arr.push(anchorOnly ? define(anchorOnly[1], v, n) : v);
        } else if (isItem(rest)) {
          throw new YamlError(`unsupported YAML at line ${n}: a list nested on the same line`);
        } else if (KEY.test(rest)) {
          // A map item starting on the dash line: read it as a line at itemIndent.
          lines[i] = { indent: itemIndent, text: rest, n };
          arr.push(map(itemIndent));
        } else {
          i++;
          arr.push(inline(rest, n));
        }
      }
      return arr;
    }
    return map(indent);
  }
  function map(indent: number): Yaml {
    const out: { [k: string]: Yaml } = {};
    while (i < lines.length && lines[i].indent === indent && !isItem(lines[i].text)) {
      const { n } = lines[i];
      const m = KEY.exec(lines[i].text);
      if (!m) throw new YamlError(`unsupported YAML at line ${n}: a line that is not "key: value"`);
      if (Object.prototype.hasOwnProperty.call(out, m[1])) throw new YamlError(`unsupported YAML at line ${n}: the key ${m[1]} appears twice`);
      i++;
      const v = m[2]?.trim() ?? '';
      const anchorOnly = /^&(\S+)$/.exec(v);
      if (anchorOnly) out[m[1]] = define(anchorOnly[1], nested(indent, false), n);
      else if (v !== '') out[m[1]] = inline(v, n);
      else out[m[1]] = nested(indent, false);
    }
    return out;
  }
  const doc = block(lines[0]?.indent ?? 0);
  if (i < lines.length) throw new YamlError(`unsupported YAML at line ${lines[i].n}: unexpected indentation or structure`);
  return doc;
}

/** parseYaml for the pack readers: the value, or why the file cannot be read. */
function readYaml(text: string): { value: Yaml; error: string | null } {
  try {
    return { value: parseYaml(text), error: null };
  } catch (err) {
    if (err instanceof YamlError) return { value: null, error: err.message };
    throw err;
  }
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

export interface PackManifest {
  problems: string[];
  /** run.yaml run_id: the pack's own id (Kane 0.10.5: the run's evidence id). */
  runId: string | null;
  /** run.yaml merged_from: the per-test packs a combined pack was merged from (null when absent). */
  mergedFrom: string[] | null;
  /** One per tests/<member>/result.yaml: only the fields that identify the member. */
  members: { name: string; definitionId: string | null; status: string | null }[];
}

/**
 * Which run and which tests a pack holds (combined testrun pack, Kane 0.10.5: run.yaml run_id and
 * merged_from; tests/<member>/result.yaml definition_id and status). Reads nothing else. Pure.
 */
export function readPackManifest(buf: Buffer): PackManifest {
  const res: PackManifest = { problems: [], runId: null, mergedFrom: null, members: [] };
  let entries: Map<string, ZipEntry>;
  try {
    entries = readIndex(buf).entries;
  } catch (err) {
    res.problems.push(`The evidence pack cannot be read: ${(err as Error).message}`);
    return res;
  }
  const text = (name: string) => {
    const e = entries.get(name);
    return e ? readEntry(buf, e).toString('utf8') : null;
  };
  const runY = readYaml(text('run.yaml') ?? '');
  const run = obj(runY.value);
  if (!run) {
    res.problems.push(runY.error ? `run.yaml cannot be read (${runY.error}).` : 'The pack has no readable run.yaml.');
    return res;
  }
  res.runId = str(run.run_id);
  if (run.merged_from !== undefined && run.merged_from !== null) {
    const mf = Array.isArray(run.merged_from) ? run.merged_from : null;
    if (!mf || mf.some((x) => typeof x !== 'string')) res.problems.push('run.yaml merged_from is not a list of pack ids.');
    else res.mergedFrom = mf as string[];
  }
  for (const name of [...entries.keys()].sort()) {
    const m = /^tests\/([^/]+)\/result\.yaml$/.exec(name);
    if (!m) continue;
    const y = readYaml(text(name) ?? '');
    const r = obj(y.value);
    if (!r) res.problems.push(`tests/${m[1]}/result.yaml cannot be read${y.error ? ` (${y.error})` : ''}.`);
    else res.members.push({ name: m[1], definitionId: str(r.definition_id), status: str(r.status) });
  }
  return res;
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
  const runY = readYaml(text('run.yaml') ?? '');
  const run = obj(runY.value);
  const env = obj(run?.environment);
  const producer = obj(env?.producer);
  res.runStatus = str(run?.status);
  res.producer = producer ? `${str(producer.name)} ${str(producer.version)}` : null;
  if (!run) problems.push(runY.error ? `run.yaml cannot be read (${runY.error}).` : 'The pack has no readable run.yaml.');
  if (res.runStatus !== 'finalized') problems.push(`The run is not finalized (status: ${res.runStatus ?? 'missing'}).`);
  if (str(producer?.name) !== 'kane-cli' || str(producer?.version) !== input.pinnedVersion) problems.push(`The pack was not produced by kane-cli ${input.pinnedVersion} (${res.producer ?? 'unknown'}).`);
  for (const s of Array.isArray(env?.surfaces) ? env!.surfaces : []) {
    const o = typeof s === 'string' ? originOf(s) : null;
    if (o && o !== input.appOrigin) problems.push(`The run reached an unexpected origin (${o}).`);
  }

  // Members (one per test), with their result.yaml.
  const members = new Map<string, Record<string, unknown>>();
  for (const name of [...entries.keys()].sort()) {
    const m = /^tests\/([^/]+)\/result\.yaml$/.exec(name);
    if (m) {
      const y = readYaml(text(name) ?? '');
      const r = obj(y.value);
      if (r) members.set(m[1], r);
      else problems.push(`tests/${m[1]}/result.yaml cannot be read${y.error ? ` (${y.error})` : ''}.`);
    }
  }

  // The run kind. A single pack keeps environment.run_kind in run.yaml. Kane 0.10.5's combined
  // (merged) pack moves it to environment.run_kind_observed and writes each member's
  // authoritative class into its result.yaml environment.run_kind, adding run_kind_observed there
  // when the two differ (verified in Kane's merge code). A run is a replay only when every
  // member is; anything missing, unknown or contradictory fails closed.
  const KINDS = ['author', 'replay'];
  const topKind = str(env?.run_kind);
  const observed = str(env?.run_kind_observed);
  const memberKinds = [...members.entries()].map(([name, r]) => {
    const e = obj(r.environment);
    return { name, kind: str(e?.run_kind), observed: str(e?.run_kind_observed) };
  });
  for (const k of [topKind, observed, ...memberKinds.flatMap((m) => [m.kind, m.observed])]) if (k !== null && !KINDS.includes(k)) problems.push(`The pack records an unknown run kind ("${k}").`);
  if (topKind !== null && observed !== null) problems.push('run.yaml records both run_kind and run_kind_observed, so the run kind is ambiguous.');
  for (const m of memberKinds) if (m.kind !== null && m.observed !== null && m.observed !== m.kind) problems.push(`Member ${m.name} is classed as ${m.kind} but was observed as ${m.observed}.`);
  let kind: string | null;
  if (observed !== null || memberKinds.some((m) => m.kind !== null)) {
    const missing = memberKinds.filter((m) => m.kind === null);
    if (missing.length) problems.push(`The pack's members ${missing.map((m) => m.name).join(', ')} record no run kind.`);
    kind = memberKinds.length && !missing.length ? (memberKinds.every((m) => m.kind === 'replay') ? 'replay' : 'author') : null;
    if (observed !== null && kind !== null && observed !== kind) problems.push(`run.yaml says the run was observed as ${observed}, but its members say ${kind}.`);
    if (topKind !== null && kind !== null && topKind !== kind) problems.push(`run.yaml says ${topKind}, but its members say ${kind}.`);
  } else kind = topKind;
  res.runKind = kind;
  // A verification run must be a pure replay: any authored step makes it an authoring run.
  if (input.requireReplay && res.runKind !== 'replay') problems.push(`This run is not a pure replay (run_kind: ${res.runKind ?? 'missing'}): Kane authored steps, so it cannot verify anything.`);
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
