// Test-design review (Assurance B5): read Kane's test design, check it against the
// documentation, record KaneVerity's own review, approve the application URL value,
// and show whether the design is ready for test execution.
//
// What it runs in Kane, each behind its own gates: the free reads of a use-case retrieval (B3:
// context fsck, list, view), free approval writes of design items (context review), a free dry
// run, and, only in Assurance mode "all" with an explicit paid confirmation, the authoring and
// verification test runs, the one evolve and the one corrective evolve of a use-case version.
// It never changes anything Kane generated (.context, .testmuai, including Kane's variables
// file); it writes only its own run variables file. Evidence is judged after a run, from Kane's
// structured output and its combined evidence pack; a recording is approved per test, and only
// when its own recorded check meets the outcome evidence rules. See docs/ASSURANCE_PLAN.md
// section 13 (13.12 and 13.13 for the real testrun format and the Phase A rules).
//
// Integrity rules:
// - A design read is accepted only when the use-case retrieval it is based on passed
//   its integrity checks, and the design graph in the records agrees with what
//   `context list` and `context view` show (items, short ids, trust, links).
// - Every review decision binds to fingerprints of what was reviewed (content ids,
//   content hashes, the minting record and its hash, the generated test file, the
//   requirements, the variables file). When any of them changes, the decision is
//   stale and no longer counts. Decisions are append-only; history is read
//   fail-closed and is never rewritten.
// - Gaps are never dropped. A gap that points at a superseded or unknown item is
//   shown as stale and needs an explicit acknowledgement that says so.

import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config, reviewerSetting } from '../config.ts';
import { assertInstanceLock } from '../instanceLock.ts';
import { dataPath, readJson, writeJson } from '../store.ts';
import type { Project } from '../types.ts';
import { findLeaks, scrub, scrubDeep } from '../verify/redact.ts';
import {
  baselineStepsFromObjectives,
  canonical,
  evaluateDesign,
  parseTestSteps,
  recognisedSupersession,
  requirementsFrom,
  sha256,
  type AcItem,
  type DesignEvaluation,
  type DesignRecordInfo,
  type DesignSnapshot,
  type GapItem,
  type ScenarioItem,
  type TestCheck,
  type TestItem,
} from './designCheck.ts';
import { DESIGN_EDGE_TYPES, DESIGN_LABELS, isLive, readDesignGraph, resolveSlug, type DesignGraph } from './designGraph.ts';
import { buildArgs, CommandError, correctiveEvolveAcknowledgement, correctiveEvolveInstruction, evolveAcknowledgement, evolveInstruction, kaneUserFor, type CorrectiveInputs, type CorrectiveKeep, type EvolveInputs, type EvolveScopePrint } from './commands.ts';
import { jobStdoutPath, usedCorrectiveEvolve, usedEvolve, type AssuranceJobs, type JobRecord } from './jobs.ts';
import { MAX_REASON, type KaneWriteState } from './review.ts';
import { readPackManifest, requirementFor, verifyPack, type PackVerification } from './runEvidence.ts';
import { AssuranceError } from './service.ts';
import { parseTestrunOutput } from './testrunOutput.ts';
import { isTutorialId, readVersion } from './store.ts';
import { UC_HEX, type AssuranceUseCases, type UseCaseSnapshot } from './usecases.ts';

export type DesignReviewKind = 'ac' | 'scenario' | 'test' | 'gap' | 'mapping' | 'extra_step' | 'app_url' | 'recording';
const ITEM_KINDS = new Set<DesignReviewKind>(['ac', 'scenario', 'test', 'gap', 'mapping', 'extra_step', 'recording']);

export interface DesignReviewEntry {
  id: string;
  at: string;
  /** Always KaneVerity's own review interface. */
  by: 'kaneverity-design-review';
  /** Self-declared (KANEVERITY_REVIEWER), never proof of identity. */
  reviewer: string;
  kind: DesignReviewKind;
  /** Item content id, an outcome ("O1") for a mapping, "<test cid>#<step>" or "app_url". */
  target: string;
  decision: 'approved' | 'rejected' | 'acknowledged';
  reason: string | null;
  ucCid: string;
  designSnapshot: number;
  /** What was reviewed, exactly; the decision counts only while this still matches. */
  binding: Record<string, unknown>;
  bindingSha256: string;
}

/** KaneVerity's run variables file: sorts after Kane's assurance.json, so its app_url wins (Kane 0.10.5 loader). */
export const RUN_VARIABLES_FILE = 'kaneverity-run.json';
const snapDir = (t: string) => dataPath('assurance', 'designs', t);
const logFile = (t: string) => dataPath('assurance', 'design-reviews', `${t}.json`);
const pad = (n: number) => String(n).padStart(4, '0');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const str = (v: unknown) => (typeof v === 'string' ? v : null);

function newId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `r${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
}

/** A free-text reason: one paragraph, no control characters, bounded. */
function cleanReason(v: unknown, required: boolean): string | null {
  if (v === undefined || v === null || v === '') {
    if (required) throw new AssuranceError(400, 'A reason is required for this decision.');
    return null;
  }
  if (typeof v !== 'string') throw new AssuranceError(400, 'reason must be text.');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) throw new AssuranceError(400, 'reason contains control characters.');
  const t = v.trim();
  if (t.length > MAX_REASON) throw new AssuranceError(400, `reason is longer than ${MAX_REASON} characters.`);
  if (required && !t) throw new AssuranceError(400, 'A reason is required for this decision.');
  return t || null;
}

// ---------------------------------------------------------------------------
// Reading the generated files (read only)
// ---------------------------------------------------------------------------

/** Every *_test.md under the workspace (as `testrun` would select them), skipping the store. */
async function findTestFiles(root: string, dir = root, depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['.context', 'node_modules', '.git'].includes(e.name)) continue;
      // Kane's recordings (output-<stem>/ and its .staging copy) are fingerprinted separately.
      if (e.name.startsWith('output-') || e.name.endsWith('.staging')) continue;
      out.push(...(await findTestFiles(root, full, depth + 1)));
    } else if (e.isFile() && e.name.endsWith('_test.md')) out.push(full);
  }
  return out.sort();
}

/**
 * The app_url Kane will use, from the workspace's local variables files (Kane 0.10.5 loader,
 * chunk-TPCW5OU5 `Y`/`P` and the planner's `I`): the global folder is loaded first, then every
 * local *.json alphabetically, each entry that is an object with a "value" key overriding the
 * previous one; so a local definition always beats a global one, and the last local file wins.
 * Unreadable files are skipped, as Kane does. Null when no local file defines app_url (then a
 * global value would apply, which KaneVerity never accepts).
 */
export function effectiveLocalAppUrl(files: { name: string; text: string }[]): { file: string; value: string | null } | null {
  let winner: { file: string; value: string | null } | null = null;
  for (const f of [...files].filter((x) => x.name.endsWith('.json')).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    let v: unknown;
    try {
      v = JSON.parse(f.text);
    } catch {
      continue;
    }
    const e = v && typeof v === 'object' ? (v as Record<string, unknown>).app_url : undefined;
    if (e && typeof e === 'object' && 'value' in (e as object)) {
      const val = (e as { value: unknown }).value;
      winner = { file: f.name, value: typeof val === 'string' ? val : val === undefined || val === null ? null : String(val) };
    }
  }
  return winner;
}

/** Kane 0.10.5 keeps a test's recording next to it: <dir>/output-<stem>/ (Result.md, .internal/...). */
export function recordingDirFor(testPath: string): string {
  const dir = path.posix.dirname(testPath);
  const stem = path.posix.basename(testPath).replace(/_test\.md$/, '');
  return `${dir}/output-${stem}`;
}

export interface RecordingTree {
  dir: string;
  exists: boolean;
  /** Kane's in-progress copy (output-<stem>.staging) is present: a recording is being replaced. */
  staging: boolean;
  /** sha256 over every file's relative path and sha256 (sorted); null when absent. */
  sha256: string | null;
  files: number;
  /** Kane's Result.md (the recorded steps, as Kane wrote them), for human review. */
  resultMd: string | null;
}

/** Fingerprint a recording tree, read only. */
export async function recordingTree(ws: string, testPath: string): Promise<RecordingTree> {
  const dir = recordingDirFor(testPath);
  const abs = path.join(ws, ...dir.split('/'));
  const staging = !!(await readdir(abs + '.staging').catch(() => null));
  const entries: { path: string; sha256: string }[] = [];
  const walk = async (d: string, rel: string, depth: number) => {
    if (depth > 12 || entries.length > 5000) return;
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.isSymbolicLink()) {
        entries.push({ path: rel + e.name, sha256: 'symlink' });
        continue;
      }
      if (e.isDirectory()) await walk(path.join(d, e.name), rel + e.name + '/', depth + 1);
      else if (e.isFile()) entries.push({ path: rel + e.name, sha256: createHash('sha256').update(await readFile(path.join(d, e.name))).digest('hex') });
    }
  };
  const exists = !!(await readdir(abs).catch(() => null));
  if (exists) await walk(abs, '', 0);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const result = exists ? await readFile(path.join(abs, 'Result.md'), 'utf8').catch(() => null) : null;
  return { dir, exists, staging, sha256: exists ? sha256(canonical(entries)) : null, files: entries.length, resultMd: result === null ? null : result.slice(0, 20000) };
}

function parseTestFile(text: string): { id: string | null; base: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return { id: null, base: null, body: text };
  const fm = m[1];
  return { id: /^\s+id:\s*(\S+)\s*$/m.exec(fm)?.[1] ?? null, base: /^\s+base:\s*(\S+)\s*$/m.exec(fm)?.[1] ?? null, body: text.slice(m[0].length) };
}

// ---------------------------------------------------------------------------
// Assembling a design snapshot from the records, Kane's list/view and the files
// ---------------------------------------------------------------------------

interface ListRow {
  id: string;
  cid: string;
  label: string;
  title: string;
  trust: string;
  fresh: string;
}

export async function assembleDesign(input: {
  ucSnap: UseCaseSnapshot;
  ucCid: string;
  graph: DesignGraph;
  listStdout: string;
  viewStdout: string;
  workspaceDir: string;
  number: number;
  /** KaneVerity's own evolve instructions for this use case (their supersessions are recognised). */
  evolveInstructions?: string[];
}): Promise<DesignSnapshot> {
  const { ucSnap, ucCid, graph: g, workspaceDir } = input;
  const problems: string[] = [];
  if (!ucSnap.integrity.ok) problems.push('The use-case retrieval this design read is based on failed its integrity checks.');
  problems.push(...g.problems);
  const uc = ucSnap.useCases.find((u) => u.cid === ucCid);
  if (!uc) problems.push('The approved use case is not in the latest use-case retrieval.');

  const rows: ListRow[] = [];
  for (const line of input.listStdout.split(/\r?\n/).filter((l) => l.trim())) {
    try {
      const r = JSON.parse(line);
      if (typeof r.cid === 'string' && typeof r.label === 'string' && DESIGN_LABELS.has(r.label)) rows.push(r);
    } catch {
      problems.push('context list returned a line that is not JSON.');
    }
  }
  let view: { nodes?: { cid: string; label?: string; slug?: string; trust?: string; superseded?: boolean }[]; edges?: { type?: string; src: string; dst: string }[] } = {};
  try {
    view = JSON.parse(input.viewStdout);
  } catch {
    problems.push('context view did not return JSON.');
  }

  // The design graph of this use case, from the records.
  const rawEdges = g.edges.filter((e) => !(e.ecid && g.retiredEdges.has(e.ecid)));
  const liveOut = (src: string, type: string) => rawEdges.filter((e) => e.src === src && e.type === type && isLive(g, e.dst)).map((e) => e.dst);
  const scenarioCids = new Set([...g.nodes.values()].filter((n) => n.label === 'scenario' && rawEdges.some((e) => e.src === n.cid && e.type === 'belongs_to' && e.dst === ucCid)).map((n) => n.cid));
  const liveScenarios = [...scenarioCids].filter((c) => isLive(g, c));
  const liveAcs = [...g.nodes.values()].filter((n) => n.label === 'ac' && isLive(g, n.cid) && rawEdges.some((e) => e.src === n.cid && e.type === 'scoped_to' && (e.dst === ucCid || scenarioCids.has(e.dst)))).map((n) => n.cid);
  // Tests: every live test automating a scenario of this use case, live or not (so an
  // orphaned test is reported, not hidden).
  const liveTests = [...g.nodes.values()].filter((n) => n.label === 'test' && isLive(g, n.cid) && rawEdges.some((e) => e.src === n.cid && e.type === 'automates' && scenarioCids.has(e.dst))).map((n) => n.cid);
  const ucItemCids = new Set([...scenarioCids, ...liveAcs, ...liveTests]);
  const liveGaps = [...g.nodes.values()]
    .filter((n) => n.label === 'gap' && isLive(g, n.cid))
    .filter((n) => n.content.uc === ucCid || (typeof n.content.ref === 'string' && (g.names.get(n.content.ref) ?? []).some((c) => ucItemCids.has(c))))
    .map((n) => n.cid);

  const recordOf = (seq: number) => g.records[seq - 1];
  const generationOf = (seq: number) => {
    const r = recordOf(seq);
    return r?.designPhase?.generation ?? r?.designGeneration?.generation ?? null;
  };
  const base = (cid: string) => {
    const n = g.nodes.get(cid)!;
    const row = rows.find((r) => r.cid === cid);
    return { cid, slug: g.slugOf.get(cid) ?? null, trust: row?.trust ?? null, fresh: row?.fresh ?? null, mintedSeq: n.seq, mintedHash: recordOf(n.seq)?.hash ?? null, generation: generationOf(n.seq), contentSha256: sha256(canonical(n.content)) };
  };

  const acs: AcItem[] = liveAcs.map((cid) => {
    const c = g.nodes.get(cid)!.content;
    const ea = c.expected_answer && typeof c.expected_answer === 'object' && !Array.isArray(c.expected_answer) ? (c.expected_answer as Record<string, unknown>) : null;
    return {
      ...base(cid),
      label: 'ac' as const,
      text: str(c.text) ?? '',
      kind: str(c.kind),
      expectedAnswer: ea ? { kind: str(ea.kind), operator: str(ea.operator), operand: typeof ea.operand === 'string' ? ea.operand : ea.operand === undefined ? null : JSON.stringify(ea.operand), baseline: ea.baseline ?? null } : null,
    };
  });
  const scenarios: ScenarioItem[] = liveScenarios.map((cid) => {
    const c = g.nodes.get(cid)!.content;
    return { ...base(cid), label: 'scenario' as const, title: str(c.title) ?? '', intent: str(c.intent) ?? '', caseType: str(c.case_type), exercises: liveOut(cid, 'exercises').sort(), belongsTo: liveOut(cid, 'belongs_to') };
  });

  // Generated test files on disk (read only).
  const files = await Promise.all(
    (await findTestFiles(workspaceDir)).map(async (full) => {
      const buf = await readFile(full);
      const parsed = parseTestFile(buf.toString('utf8'));
      return { path: path.relative(workspaceDir, full).split(path.sep).join('/'), sha256: createHash('sha256').update(buf).digest('hex'), ...parsed };
    }),
  );
  const claimed = new Set<string>();
  const tests: TestItem[] = liveTests.map((cid) => {
    const c = g.nodes.get(cid)!.content;
    const blob = str(c.test_md_blob) ?? '';
    const chk = c.check && typeof c.check === 'object' && !Array.isArray(c.check) ? (c.check as Record<string, unknown>) : null;
    const check: TestCheck | null = chk
      ? { kind: str(chk.kind) ?? '', operator: str(chk.operator), operand: typeof chk.operand === 'string' ? chk.operand : chk.operand === undefined ? null : JSON.stringify(chk.operand), verifiedAgainst: str(chk.verified_against), baseline: chk.baseline ?? null }
      : null;
    const b = base(cid);
    const mine = files.filter((f) => !!b.slug && f.id === b.slug);
    if (mine.length > 1) problems.push(`More than one test file claims ${b.slug}: ${mine.map((f) => f.path).join(', ')}.`);
    const f = mine.length === 1 ? mine[0] : null;
    if (f) claimed.add(f.path);
    return {
      ...b,
      label: 'test' as const,
      title: str(c.title) ?? '',
      definitionId: str(c.definitionId),
      check,
      automates: liveOut(cid, 'automates'),
      verifies: liveOut(cid, 'verifies').sort(),
      blobSha256: sha256(blob),
      steps: parseTestSteps(blob, baselineStepsFromObjectives(str(c.objectives_blob) ?? '')),
      file: f ? { path: f.path, sha256: f.sha256, bodyMatches: f.body === blob, basePin: f.base, id: f.id } : null,
    };
  });
  // A file Kane kept for a test that a redesign of THIS use case superseded: its pin names that
  // superseded test exactly (short id and definition). Anything else unclaimed is stray.
  const supersededTests = [...g.nodes.values()].filter((n) => n.label === 'test' && g.supersededNodes.has(n.cid) && g.edges.some((e) => e.src === n.cid && e.type === 'automates' && scenarioCids.has(e.dst)));
  const supersededTestFiles: NonNullable<DesignSnapshot['supersededTestFiles']> = [];
  for (const f of files.filter((x) => !claimed.has(x.path))) {
    const hits = supersededTests.filter((n) => !!f.id && g.slugOf.get(n.cid) === f.id && !!f.base && str(n.content.definitionId) === f.base);
    if (hits.length !== 1) continue;
    const sup = g.supersededNodes.get(hits[0].cid)!;
    supersededTestFiles.push({ path: f.path, sha256: f.sha256, id: f.id!, testCid: hits[0].cid, supersededInSeq: sup.seq, successor: sup.next ? (g.slugOf.get(sup.next) ?? sup.next) : null });
    claimed.add(f.path);
  }
  const strayTestFiles = files.filter((f) => !claimed.has(f.path)).map((f) => ({ path: f.path, sha256: f.sha256, id: f.id }));
  // Every design item of this use case that any record superseded, with Kane's reason. Only a
  // design record of this use case may supersede them; any other record's supersession (an
  // execution's exec-supersede, another use case's design) is unrecognised and blocks.
  const ofThisUc = (seq: number) => {
    const r = g.records[seq - 1];
    return r?.designPhase?.ucRoot === ucCid || r?.designGeneration?.ucRoot === ucCid;
  };
  const allEdges = g.edges;
  const ucScenarios = new Set([...g.nodes.values()].filter((n) => n.label === 'scenario' && allEdges.some((e) => e.src === n.cid && e.type === 'belongs_to' && e.dst === ucCid)).map((n) => n.cid));
  const belongsHere = (cid: string): boolean => {
    const n = g.nodes.get(cid);
    if (!n || !DESIGN_LABELS.has(n.label)) return false;
    if (n.label === 'scenario') return ucScenarios.has(cid);
    if (n.label === 'test') return allEdges.some((e) => e.src === cid && e.type === 'automates' && ucScenarios.has(e.dst));
    if (n.label === 'ac') return allEdges.some((e) => e.src === cid && e.type === 'scoped_to' && (e.dst === ucCid || ucScenarios.has(e.dst)));
    return n.content.uc === ucCid;
  };
  const supersessions: NonNullable<DesignSnapshot['supersessions']> = [...g.supersededNodes.entries()]
    .filter(([cid]) => belongsHere(cid))
    .map(([cid, x]) => ({ seq: x.seq, label: g.nodes.get(cid)!.label, old: g.slugOf.get(cid) ?? cid, next: x.next ? (g.slugOf.get(x.next) ?? x.next) : null, reason: x.reason, recognised: ofThisUc(x.seq) && recognisedSupersession(x.reason, input.evolveInstructions ?? []) }))
    .sort((a, b) => a.seq - b.seq || a.old.localeCompare(b.old));
  for (const t of tests) t.recording = t.file ? await recordingTree(workspaceDir, t.file.path) : null;

  const gaps: GapItem[] = liveGaps.map((cid) => {
    const c = g.nodes.get(cid)!.content;
    const q = c.question && typeof c.question === 'object' ? (c.question as Record<string, unknown>) : {};
    const ref = str(c.ref);
    const res = ref ? resolveSlug(g, ref) : { state: 'none' as const, cid: null };
    return { ...base(cid), label: 'gap' as const, kind: str(c.kind) ?? '', header: str(q.header) ?? '', prompt: str(q.prompt) ?? '', ref, refState: res.state, refCid: res.cid, risk: str(c.risk) };
  });

  // Cross-checks against what Kane lists and shows.
  const included = [...acs, ...scenarios, ...tests, ...gaps];
  for (const it of included) {
    const row = rows.find((r) => r.cid === it.cid);
    if (!row) problems.push(`${it.slug ?? it.cid.slice(0, 19)} is live in the records but context list does not show it.`);
    else if (row.label !== it.label || row.id !== it.slug) problems.push(`${it.slug ?? it.cid.slice(0, 19)}: context list shows it as ${row.label} ${row.id}.`);
    const vn = view.nodes?.find((n) => n.cid === it.cid);
    if (!vn || vn.superseded === true) problems.push(`${it.slug ?? it.cid.slice(0, 19)} is live in the records but context view does not show it as live.`);
    else if (row && vn.trust !== row.trust) problems.push(`${it.slug}: the trust differs between context view and context list.`);
  }
  for (const r of rows) if (!isLive(g, r.cid)) problems.push(`context list shows ${r.label} ${r.id}, which is not live in the records.`);
  const ids = new Set(included.map((x) => x.cid).concat(ucCid));
  const key = (e: { type?: string; src: string; dst: string }) => `${e.type}|${e.src}|${e.dst}`;
  const mineEdges = new Set(rawEdges.filter((e) => DESIGN_EDGE_TYPES.has(e.type) && isLive(g, e.src) && isLive(g, e.dst) && ids.has(e.src) && ids.has(e.dst)).map(key));
  const viewEdges = new Set((view.edges ?? []).filter((e) => typeof e.type === 'string' && DESIGN_EDGE_TYPES.has(e.type) && ids.has(e.src) && ids.has(e.dst)).map(key));
  if ([...mineEdges].some((k) => !viewEdges.has(k)) || [...viewEdges].some((k) => !mineEdges.has(k))) problems.push('The design links in the records differ from those context view shows.');

  // Design records for this use case.
  const designRecords: DesignRecordInfo[] = g.records
    .filter((r) => r.designPhase?.ucRoot === ucCid || r.designGeneration?.ucRoot === ucCid)
    .map((r) => ({
      seq: r.seq,
      hash: r.hash,
      verb: r.intentVerb,
      phase: r.designPhase?.phase ?? null,
      generation: r.designPhase?.generation ?? r.designGeneration?.generation ?? null,
      completeness: r.designPhase?.completeness ?? null,
      startsGeneration: r.designGeneration?.generation ?? null,
      supersedesGeneration: r.designGeneration?.supersedesGeneration ?? null,
    }));
  for (const r of g.records) if (r.build !== config.assurance.pinnedVersion) problems.push(`Record ${r.seq} was written by Kane ${r.build ?? 'unknown'}, not the pinned ${config.assurance.pinnedVersion}.`);

  // Kane's generated variables file: read, fingerprinted, never written.
  const varsRel = '.testmuai/variables/assurance.json';
  const varsBuf = await readFile(path.join(workspaceDir, ...varsRel.split('/'))).catch(() => null);
  let appUrlDeclared = false;
  let appUrlHasValue = false;
  if (varsBuf) {
    try {
      const v = JSON.parse(varsBuf.toString('utf8')) as Record<string, { value?: unknown }>;
      appUrlDeclared = !!v && typeof v === 'object' && 'app_url' in v;
      appUrlHasValue = appUrlDeclared && typeof v.app_url?.value === 'string' && v.app_url.value !== '';
    } catch {
      problems.push(`${varsRel} is not readable JSON.`);
    }
  }
  // Every variables file Kane will load (it reads them all, alphabetically; a later file wins),
  // and KaneVerity's own run file, the only file KaneVerity ever writes there.
  const varDir = path.join(workspaceDir, '.testmuai', 'variables');
  const varFiles: { name: string; sha256: string }[] = [];
  let runFile: { sha256: string; appUrl: string | null } | null = null;
  const localTexts: { name: string; text: string }[] = [];
  for (const name of (await readdir(varDir).catch(() => [] as string[])).filter((n) => n.endsWith('.json')).sort()) {
    const b = await readFile(path.join(varDir, name)).catch(() => null);
    if (!b) continue;
    const h = createHash('sha256').update(b).digest('hex');
    varFiles.push({ name, sha256: h });
    localTexts.push({ name, text: b.toString('utf8') });
    if (name === RUN_VARIABLES_FILE) {
      let appUrl: string | null = null;
      try {
        const v = JSON.parse(b.toString('utf8')) as Record<string, { value?: unknown }>;
        appUrl = typeof v?.app_url?.value === 'string' ? v.app_url.value : null;
      } catch {
        problems.push(`.testmuai/variables/${RUN_VARIABLES_FILE} is not readable JSON.`);
      }
      runFile = { sha256: h, appUrl };
    }
  }
  return {
    snapshot: input.number,
    tutorialId: ucSnap.tutorialId,
    ucCid,
    ucSlug: uc?.logicalId ?? null,
    retrievedAt: new Date().toISOString(),
    useCaseSnapshot: ucSnap.snapshot,
    cliVersion: config.assurance.pinnedVersion,
    integrity: { ok: problems.length === 0, problems },
    store: { records: ucSnap.store.records, tipHash: ucSnap.store.tipHash ?? null },
    requirements: ucSnap.requirements,
    sourceCid: ucSnap.source?.cid ?? null,
    designRecords,
    acs,
    scenarios,
    tests,
    gaps,
    strayTestFiles,
    supersededTestFiles,
    supersessions,
    variables: { path: varsRel, sha256: varsBuf ? createHash('sha256').update(varsBuf).digest('hex') : null, appUrlDeclared, appUrlHasValue, files: varFiles, runFile, appUrlWinner: effectiveLocalAppUrl(localTexts) },
    kaneReviews: (ucSnap.kaneReviews ?? [])
      .filter((k) => included.some((x) => x.cid === k.ucCid))
      .map((k) => ({ seq: k.seq, recordHash: k.recordHash, prevHash: k.prevHash, cid: k.ucCid, resolution: k.resolution, by: k.by, reviewOnly: k.reviewOnly, itemsInRecord: k.itemsInRecord, build: k.build })),
  };
}

// ---------------------------------------------------------------------------
// Protected paths (B5 evolve): a walk that fails closed
// ---------------------------------------------------------------------------

/** The filesystem calls the protected walk uses (injectable for tests). */
export interface WalkIo {
  lstat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  readdir(p: string): Promise<string[]>;
  readFile(p: string): Promise<Buffer>;
}
const NODE_IO: WalkIo = { lstat: (p) => lstat(p), readdir: (p) => readdir(p), readFile: (p) => readFile(p) };

/**
 * Every file under root, with its sha256, as "<tag>/<relative path>". No depth limit, symbolic
 * links (and Windows junctions) are never followed, and nothing is skipped silently: an
 * unreadable folder or file, a symbolic link, or anything that is neither a file nor a folder is
 * reported as a problem. A missing root is empty (the folder does not exist yet).
 */
export async function walkProtected(root: string, tag: string, io: WalkIo = NODE_IO): Promise<{ files: { path: string; sha256: string }[]; problems: string[] }> {
  const files: { path: string; sha256: string }[] = [];
  const problems: string[] = [];
  const rel = (full: string) => path.relative(root, full).split(path.sep).join('/');
  const name = (full: string) => (full === root ? `${tag}/` : `${tag}/${rel(full)}`);
  let st: Awaited<ReturnType<WalkIo['lstat']>>;
  try {
    st = await io.lstat(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { files, problems };
    return { files, problems: [`${name(root)} cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'}).`] };
  }
  if (st.isSymbolicLink()) return { files, problems: [`${name(root)} is a symbolic link; it is not followed.`] };
  if (!st.isDirectory()) return { files, problems: [`${name(root)} is not a folder.`] };
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = (await io.readdir(dir)).sort();
    } catch (err) {
      problems.push(`${name(dir)} cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'}).`);
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e);
      let es: Awaited<ReturnType<WalkIo['lstat']>>;
      try {
        es = await io.lstat(full);
      } catch (err) {
        problems.push(`${name(full)} cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'}).`);
        continue;
      }
      if (es.isSymbolicLink()) problems.push(`${name(full)} is a symbolic link; it is not followed.`);
      else if (es.isDirectory()) stack.push(full);
      else if (es.isFile()) {
        try {
          files.push({ path: name(full), sha256: createHash('sha256').update(await io.readFile(full)).digest('hex') });
        } catch (err) {
          problems.push(`${name(full)} cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'}).`);
        }
      } else problems.push(`${name(full)} is not a regular file or folder.`);
    }
  }
  files.sort((x, y) => x.path.localeCompare(y.path));
  return { files, problems };
}

// ---------------------------------------------------------------------------
// Bindings: exactly what a decision was made on
// ---------------------------------------------------------------------------

export function bindingFor(kind: DesignReviewKind, target: string, s: DesignSnapshot, ev: DesignEvaluation, appOrigin: string | null): Record<string, unknown> | null {
  const common = { ucCid: s.ucCid, requirements: s.requirements, sourceCid: s.sourceCid };
  const minted = (x: { mintedSeq: number; mintedHash: string | null }) => ({ seq: x.mintedSeq, hash: x.mintedHash });
  if (kind === 'ac') {
    const a = s.acs.find((x) => x.cid === target);
    return a ? { ...common, cid: a.cid, contentSha256: a.contentSha256, minted: minted(a), mappedOutcome: ev.mapping.entries.find((m) => m.acCid === a.cid)?.outcome ?? null } : null;
  }
  if (kind === 'scenario') {
    const x = s.scenarios.find((y) => y.cid === target);
    return x ? { ...common, cid: x.cid, contentSha256: x.contentSha256, minted: minted(x), exercises: x.exercises } : null;
  }
  if (kind === 'test') {
    const t = s.tests.find((y) => y.cid === target);
    return t ? { ...common, cid: t.cid, contentSha256: t.contentSha256, minted: minted(t), definitionId: t.definitionId, blobSha256: t.blobSha256, file: t.file && { path: t.file.path, sha256: t.file.sha256, basePin: t.file.basePin }, automates: t.automates, verifies: t.verifies } : null;
  }
  if (kind === 'gap') {
    const x = s.gaps.find((y) => y.cid === target);
    return x ? { ...common, cid: x.cid, contentSha256: x.contentSha256, minted: minted(x), ref: x.ref, refState: x.refState, refCid: x.refCid } : null;
  }
  if (kind === 'mapping') {
    // One decision per documented outcome: which criterion stands for it. It is bound to the
    // outcome's text and to that criterion's exact content, so a different match (or a
    // changed criterion) makes the decision stale.
    const m = ev.mapping.entries.find((x) => x.outcome === target);
    const ac = m?.acCid ? s.acs.find((x) => x.cid === m.acCid) : null;
    return m ? { ...common, outcome: m.outcome, acCid: m.acCid, acContentSha256: ac?.contentSha256 ?? null, problem: m.problem } : null;
  }
  if (kind === 'extra_step') {
    const [testCid, n] = target.split('#');
    const t = s.tests.find((y) => y.cid === testCid);
    const f = ev.fidelity.find((y) => y.testCid === testCid)?.extraSteps.find((y) => String(y.n) === n);
    return t && f ? { ...common, testCid, n: f.n, textSha256: f.textSha256, blobSha256: t.blobSha256 } : null;
  }
  if (kind === 'recording') {
    // A recorded test (after an authoring run): bound to the exact test file and the exact recording tree.
    const t = s.tests.find((y) => y.cid === target);
    return t && t.file && t.recording?.exists ? { ...common, testCid: t.cid, definitionId: t.definitionId, testFile: { path: t.file.path, sha256: t.file.sha256 }, recording: { dir: t.recording.dir, sha256: t.recording.sha256, files: t.recording.files, staging: t.recording.staging } } : null;
  }
  if (kind === 'app_url') return target === 'app_url' && appOrigin ? { ucCid: s.ucCid, variable: 'app_url', value: appOrigin, projectAppOrigin: appOrigin, variablesFile: { path: s.variables.path, sha256: s.variables.sha256 } } : null;
  return null;
}

export interface DecisionStatus {
  state: 'none' | 'approved' | 'rejected' | 'acknowledged';
  /** The decision was made on content that has changed since; it does not count. */
  stale: boolean;
  entryId: string | null;
  at: string | null;
  reason: string | null;
  value?: string | null;
}

export function decisionStatus(entries: DesignReviewEntry[], kind: DesignReviewKind, target: string, current: Record<string, unknown> | null): DecisionStatus {
  const mine = entries.filter((e) => e.kind === kind && e.target === target && e.by === 'kaneverity-design-review');
  const last = mine[mine.length - 1];
  if (!last) return { state: 'none', stale: false, entryId: null, at: null, reason: null };
  const stale = !current || sha256(canonical(current)) !== last.bindingSha256;
  return { state: last.decision, stale, entryId: last.id, at: last.at, reason: last.reason, ...(kind === 'app_url' ? { value: str(last.binding.value) } : {}) };
}

export interface ReadinessItem {
  id: string;
  label: string;
  ok: boolean;
  reason: string;
}

/** One step of writing a KaneVerity approval of a design item to Kane (the B4 pattern). Append-only. */
export interface DesignKaneWrite {
  type: 'kane_write';
  writeId: string;
  kind: 'ac' | 'scenario' | 'test';
  /** The item's exact content id. */
  target: string;
  /** The KaneVerity decision (review entry id) this write records. */
  decisionId: string;
  state: KaneWriteState;
  via: 'write' | 'reconcile' | 'reuse' | 'startup';
  at: string;
  reason: string;
  baseTip: string | null;
  baseRecords: number;
  jobId: string | null;
  kaneSeq: number | null;
  kaneHash: string | null;
  kaneBy: string | null;
  reviewer: string;
  by: 'kaneverity-design-review';
}

/** A free dry run of the approved tests, bound to what it planned. */
export interface DryRunEntry {
  id: string;
  at: string;
  jobId: string | null;
  state: 'passed' | 'failed' | 'unknown';
  reason: string;
  files: string[];
  unresolved: string[];
  binding: Record<string, unknown>;
  bindingSha256: string;
}

/** KaneVerity wrote its run variables file (the approved app_url). */
export interface RunVariablesEntry {
  id: string;
  at: string;
  reviewer: string;
  value: string;
  sha256: string;
  appUrlEntryId: string;
}

export interface ExecutionTarget {
  outcome: string;
  outcomeText: string;
  labels: string[];
  acCid: string;
  acSlug: string;
  testCid: string;
  testSlug: string;
  definitionId: string;
}

/**
 * Version of the post-run check (checkRun). A finished run's result records the version that
 * made it; a free re-check is allowed only with a newer version, once per version.
 * 1: one new evidence pack expected. 2: the combined pack Kane names in its output (Kane 0.10.5
 * writes one pack per test plus a combined pack), with every association checked. 3: Kane's YAML
 * anchors and aliases read (the real result.yaml writes each step's verifies list that way), the run
 * kind read from each member, and subset authoring runs.
 */
export const RUN_CHECKER_VERSION = 3;

/** One approved test in a run: its file, Kane's member, its per-test pack, its recording and its member in the combined pack. */
export interface ExecutionMember {
  outcome: string;
  testSlug: string;
  testCid: string;
  testFile: string;
  /** From Kane's output (testrun_summary.authored). */
  kaneTestId: string | null;
  kaneStatus: string | null;
  durationS: number | null;
  /** The per-test evidence pack Kane reported (file name), or null in a single-pack run. */
  testPack: string | null;
  /** The member folder in the combined pack with this test's definition id, and its status. */
  packMember: string | null;
  packMemberStatus: string | null;
  recording: { path: string; sha256: string | null; exists: boolean; staging: boolean };
}

export interface ExecutionResult {
  /** AUTHORED: an authoring run that left a recording and changed nothing else. Never a verification. */
  verdict: 'AUTHORED' | 'VERIFIED' | 'NOT_VERIFIED';
  /** Recording trees after the run. */
  recordings: { path: string; sha256: string | null; exists: boolean; staging: boolean }[];
  mutation: string[];
  /** The combined evidence pack that was verified (file name in .testmuai/evidence). */
  evidenceFile: string | null;
  verification: PackVerification | null;
  problems: string[];
  /** Missing on results made before version 2 (they count as version 1). */
  checker?: number;
  /** Every pack the run left, as checked: the combined pack and the per-test packs (never changed or removed). */
  packs?: { name: string; role: 'combined' | 'test'; sha256: string; bytes: number }[];
  members?: ExecutionMember[];
  /** What Kane's structured output reported (testrun_done, testrun_summary totals). */
  kaneRun?: { overallStatus: string | null; totals: { tests: number; passed: number; failed: number; broken: number; skipped: number } | null } | null;
  /** sha256 of Kane's saved output (the job's stdout.ndjson) when it was checked. */
  outputSha256?: string | null;
}

/** One test run of the approved design. Append-only: every state change is a new entry. */
export interface ExecutionEntry {
  executionId: string;
  /** authoring: Kane records the steps (first run); verification: a pure replay of approved recordings. */
  phase: 'authoring' | 'verification';
  jobId: string | null;
  at: string;
  /** rechecked: a finished run's evidence checked again by a newer checker version (Kane not run). */
  state: 'started' | 'refused' | 'unknown' | 'finished' | 'reconciled' | 'rechecked';
  reason: string;
  reviewer: string;
  readinessSha256: string;
  /** On a re-check: the result it replaces as current (that entry stays in the log). */
  recheckOf?: { at: string; state: string; verdict: string; checker: number; problems: string[] };
  targets: ExecutionTarget[];
  pre: { testFiles: { path: string; sha256: string }[]; /** The test files Kane was given (absent: all of testFiles). An authoring run may run only the tests without an approved, current recording; testFiles still fingerprints every live test. */ runFiles?: string[]; /** Superseded tests' files kept on disk (never run), as checked before the run. */ supersededFiles?: { path: string; sha256: string }[]; variables: { name: string; sha256: string }[]; recordings: { path: string; sha256: string | null; exists: boolean; staging: boolean }[]; storeRecords: number; storeTip: string | null; evidenceFiles: string[]; designSnapshot: number };
  result: ExecutionResult | null;
  by: 'kaneverity-design-review';
}

/** B5: what an evolve changed that it must not have (existing records, requirements, docs, test files). Append-only. */
export interface EvolveCheckEntry {
  jobId: string;
  at: string;
  jobState: string;
  /** Checked at start-up, after a restart: changes made after the run may be included. */
  late: boolean;
  problems: string[];
}

interface FullLog {
  tutorialId: string;
  entries: DesignReviewEntry[];
  kaneWrites: DesignKaneWrite[];
  dryRuns: DryRunEntry[];
  runVariables: RunVariablesEntry[];
  executions: ExecutionEntry[];
  evolveChecks: EvolveCheckEntry[];
}

/** Current state of each write (last entry per writeId). */
export function currentDesignWrites(entries: DesignKaneWrite[]): DesignKaneWrite[] {
  const m = new Map<string, DesignKaneWrite>();
  for (const e of entries) if (e.type === 'kane_write' && e.by === 'kaneverity-design-review') m.set(e.writeId, e);
  return [...m.values()];
}

const runCidsOf = (tests: { cid: string }[]) => new Set(tests.map((x) => x.cid));

/** The test files an execution gave Kane (an authoring run may run fewer than it fingerprints). */
export function runFilesOf(x: ExecutionEntry): string[] {
  return x.pre.runFiles ?? x.pre.testFiles.map((f) => f.path);
}

/** The recording an execution's result shows for a test file it ran (null: not run, or not recorded). */
function resultRecording(x: ExecutionEntry, file: string): ExecutionResult['recordings'][number] | null {
  const i = x.pre.testFiles.findIndex((f) => f.path === file);
  return i >= 0 && runFilesOf(x).includes(file) ? (x.result?.recordings[i] ?? null) : null;
}

/**
 * May this test's current recording be approved (and does an approval of it still count)? Judged
 * per test, from the latest authoring run that ran this exact test file, so a later run of other
 * tests never replaces it, and a later failed run of this test does. That run must be AUTHORED,
 * list this exact recording and test file, have been checked by the current checker version, and
 * its own evidence for this test's outcome must pass the outcome rules (the same DOM rules a
 * verification applies, except the replay requirement): a recording whose recorded check cannot
 * verify is never approved, so no verification is paid for that is bound to fail.
 */
export function recordingProof(test: TestItem, execs: ExecutionEntry[]): { ok: boolean; reason: string; executionId: string | null; needsRecheck?: boolean } {
  const no = (reason: string, executionId: string | null = null, needsRecheck = false) => ({ ok: false, reason, executionId, ...(needsRecheck ? { needsRecheck } : {}) });
  if (!test.file || !test.recording?.exists) return no('no recording yet (run the authoring run first)');
  if (test.recording.staging) return no('Kane is replacing the recording (output .staging present)');
  const run = execs.filter((e) => e.phase === 'authoring' && !!e.result && runFilesOf(e).includes(test.file!.path)).pop() ?? null;
  if (!run) return no('no checked authoring run of this test file produced it');
  const r = run.result!;
  if (r.verdict !== 'AUTHORED') return no(`the latest authoring run of this test (${run.executionId}) is ${r.verdict}`, run.executionId);
  const rec = resultRecording(run, test.file.path);
  if (!rec || rec.path !== test.recording.dir || rec.sha256 !== test.recording.sha256 || !rec.exists || rec.staging) return no(`the recording is not the one that run (${run.executionId}) produced (it changed since)`, run.executionId);
  const pre = run.pre.testFiles.find((f) => f.path === test.file!.path);
  if (!pre || pre.sha256 !== test.file.sha256) return no('the test file changed since that run', run.executionId);
  const v = r.checker ?? 1;
  if (v < RUN_CHECKER_VERSION) return no(`that run's evidence was checked by checker version ${v}; re-check it (free) with version ${RUN_CHECKER_VERSION} first`, run.executionId, true);
  const tg = run.targets.find((x) => x.testCid === test.cid);
  if (!tg) return no('that run did not run this test as approved', run.executionId);
  const o = r.verification?.outcomes.find((x) => x.outcome === tg.outcome) ?? null;
  if (!o?.verified) return no(`the recorded check of ${tg.outcome} does not meet the evidence rules (${o?.problems.join(' ') || 'no evidence for it'})`, run.executionId);
  return { ok: true, reason: '', executionId: run.executionId };
}

/**
 * The tests an authoring run records now, and why it cannot start (beyond the readiness gates).
 * The one source of the selection: the job uses it when it starts, and the page shows it in the
 * paid-run confirmation, so the two never differ. A test with an approved, current recording is
 * not recorded again; a test whose recording only needs the free re-check refuses the run.
 */
export function authoringSelection<T extends { cid: string; slug: string | null }>(tests: T[], recordings: { testCid: string; slug: string | null; ok: boolean; recording: { exists: boolean } | null; proof: { needsRecheck?: boolean } }[]): { tests: T[]; refusal: string | null } {
  const selected = tests.filter((x) => !recordings.find((r) => r.testCid === x.cid)?.ok);
  if (!selected.length) return { tests: [], refusal: 'every test already has an approved, current recording, so nothing needs recording. Run the verification.' };
  const ids = runCidsOf(selected);
  const recheckFirst = recordings.filter((r) => ids.has(r.testCid) && r.proof.needsRecheck && r.recording?.exists);
  if (recheckFirst.length) {
    const one = recheckFirst.length === 1;
    return { tests: selected, refusal: `${recheckFirst.map((r) => r.slug).join(', ')} already ${one ? 'has a recording' : 'have recordings'} from a run checked by an older checker version. Re-check that run (free) first, then review the recordings; Kane would record ${one ? 'it' : 'them'} again otherwise.` };
  }
  return { tests: selected, refusal: null };
}

/**
 * Why an authoring run's confirmation no longer matches the tests it would record (null: it
 * matches). The confirmed content ids are compared as a set with the backend's selection.
 */
export function selectionConflict(tests: { cid: string; slug: string | null }[], selected: { cid: string; slug: string | null }[], confirmed: string[]): string | null {
  const now = selected.map((x) => x.cid).sort();
  const asked = [...confirmed].sort();
  if (JSON.stringify(now) === JSON.stringify(asked)) return null;
  const name = (c: string) => tests.find((x) => x.cid === c)?.slug ?? `an unknown test (${c.slice(0, 19)}…)`;
  return `the tests to record changed since this confirmation (confirmed: ${asked.map(name).sort().join(', ') || 'none'}; now: ${selected.map((x) => x.slug ?? name(x.cid)).sort().join(', ') || 'none'}). Nothing ran and no credits were used. Review the current list and confirm again.`;
}

/** What a checked run's result means, in one sentence (finished runs and re-checks). */
export function executionReason(phase: ExecutionEntry['phase'], result: ExecutionResult): string {
  const why = [...result.mutation, ...result.problems].join(' ') || 'see the outcomes.';
  if (result.verdict === 'VERIFIED') return 'Every documented outcome has its own DOM-evidenced, passed assertion in a pure replay, and nothing was changed.';
  if (result.verdict === 'AUTHORED') return 'Kane recorded the steps. Review each recording, approve it, run the dry run again, then run the verification. This run verifies nothing.';
  return `${phase === 'authoring' ? 'Authoring failed' : 'Not verified'}: ${why}`;
}

/** Current state of each execution (last entry per executionId), oldest first. */
export function currentExecutions(entries: ExecutionEntry[]): ExecutionEntry[] {
  const m = new Map<string, ExecutionEntry>();
  for (const e of entries) if (e.by === 'kaneverity-design-review') m.set(e.executionId, e);
  return [...m.values()];
}

/** The Kane side of one item's approval: written, verified, still the item's latest record. */
export function kaneApprovalOf(snap: DesignSnapshot, target: string, decision: DecisionStatus, writes: DesignKaneWrite[], active: Set<string>): { ok: boolean; state: KaneWriteState | 'none'; reason: string; write: DesignKaneWrite | null } {
  const mine = currentDesignWrites(writes).filter((w) => w.target === target);
  const w = [...mine].reverse().find((x) => x.decisionId === decision.entryId) ?? null;
  let state: KaneWriteState | 'none' = w ? w.state : 'none';
  if (state === 'pending' && w && !active.has(w.writeId)) state = 'unknown';
  const item = [...snap.acs, ...snap.scenarios, ...snap.tests].find((x) => x.cid === target);
  const records = (snap.kaneReviews ?? []).filter((k) => k.cid === target);
  const last = records[records.length - 1];
  const claimed = new Set(mine.filter((x) => x.kaneSeq !== null).map((x) => x.kaneSeq));
  const external = records.some((k) => k.resolution === 'approved' && !claimed.has(k.seq));
  let reason = '';
  if (decision.state !== 'approved' || decision.stale) reason = 'it is not approved in KaneVerity (current decision)';
  else if (state === 'none' || state === 'not_written') reason = 'the approval has not been written to Kane';
  else if (state === 'pending') reason = 'the approval is being written to Kane';
  else if (state === 'unknown') reason = "the outcome of writing the approval to Kane is unknown; check Kane's store (reconcile)";
  else if (state === 'written_unverified') reason = 'Kane holds an approval KaneVerity could not verify';
  else if (!item || item.trust !== 'trusted') reason = `Kane does not list it as trusted (${item?.trust ?? 'missing'})`;
  else if (!last || !w || last.seq !== w.kaneSeq || last.recordHash !== w.kaneHash || last.resolution !== 'approved') reason = "the verified record is not the item's latest record in Kane";
  if (!reason && external) reason = 'Kane holds an approval of it that KaneVerity did not write and verify';
  return { ok: !reason, state, reason, write: w };
}

export interface PreExecutionInput {
  integrityOk: boolean;
  integrityProblems: string[];
  fresh: { ok: boolean; reason: string };
  useCase: { eligible: boolean; reasons: string[] };
  ev: DesignEvaluation;
  statuses: { kind: DesignReviewKind; target: string; label: string; status: DecisionStatus; required: 'approved' | 'acknowledged' }[];
  appUrl: { status: DecisionStatus; proposed: string | null; runFileValue: string | null };
  kaneApprovals: { label: string; ok: boolean; reason: string }[];
  dryRun: { ok: boolean; reason: string };
  busy: string | null;
  /** Verification readiness only: every test's recording reviewed and approved (current). */
  recordings?: { ok: boolean; reason: string };
}

/**
 * Pre-execution readiness: may the approved tests be run (once, with a paid confirmation)?
 * Pure. Run-time evidence is NOT a pre-execution gate: it is what the run produces, and it
 * is checked after the run (post-execution verification) before anything is VERIFIED.
 */
export function computeReadiness(i: PreExecutionInput): { ready: boolean; items: ReadinessItem[] } {
  const items: ReadinessItem[] = [];
  const add = (id: string, label: string, ok: boolean, reason: string) => items.push({ id, label, ok, reason: ok ? '' : reason });
  const { ev } = i;
  const describe = (list: typeof i.statuses) => list.map((s) => `${s.label}: ${s.status.stale ? `the ${s.status.state} decision is stale (what was reviewed has changed)` : s.status.state === 'none' ? 'not reviewed' : s.status.state}.`).join(' ');
  add('integrity', 'Design read passed its integrity checks', i.integrityOk, i.integrityProblems.join(' ') || 'Read the design again.');
  add('fresh', 'Design read is current (store, requirements and documentation)', i.fresh.ok, i.fresh.reason);
  add('use_case', 'Use case approved in KaneVerity and verified in Kane', i.useCase.eligible, i.useCase.reasons.join(' ') || 'The use case is not approved and verified.');
  add('generation', 'Design generation is complete and consistent', ev.generation.ok, ev.generation.problems.join(' '));
  add('structure', 'One criterion, one scenario and one test per documented outcome', ev.structure.ok, ev.structure.problems.join(' '));
  const maps = i.statuses.filter((s) => s.kind === 'mapping');
  const badMaps = maps.filter((s) => s.status.stale || s.status.state !== 'approved');
  add('mapping', 'Each outcome-to-criterion mapping approved (current)', ev.mapping.ok && maps.length > 0 && badMaps.length === 0, [ev.mapping.ok ? '' : ev.mapping.problems.join(' '), describe(badMaps)].filter(Boolean).join(' ') || 'No mapping.');
  add('outcomes', 'Each outcome is specified for an independent assertion', ev.outcomes.length > 0 && ev.outcomes.every((o) => o.specified), ev.outcomes.filter((o) => !o.specified).map((o) => `${o.outcome}: ${o.problems.join(' ')}`).join(' '));
  add('fidelity', 'Every test follows the documented journey', ev.fidelity.length > 0 && ev.fidelity.every((f) => f.ok), ev.fidelity.filter((f) => !f.ok).map((f) => `${f.testSlug}: ${f.problems.join(' ')}`).join(' ') || 'There are no tests.');
  add('files', 'Generated test files match the tests Kane stored', ev.files.ok, ev.files.problems.join(' '));
  const others = i.statuses.filter((s) => s.kind !== 'mapping');
  const bad = others.filter((s) => s.status.stale || s.status.state !== s.required);
  add('reviews', 'Criteria, scenarios, tests, extra steps and gaps reviewed in KaneVerity (current)', others.length > 0 && bad.length === 0, describe(bad) || 'Nothing to review.');
  const kaBad = i.kaneApprovals.filter((k) => !k.ok);
  add('kane_approvals', 'Criteria, scenarios and tests approved in Kane and verified (exact content ids)', i.kaneApprovals.length > 0 && kaBad.length === 0, kaBad.map((k) => `${k.label}: ${k.reason}.`).join(' ') || 'There is nothing to approve in Kane.');
  const au = i.appUrl.status;
  const appOk = au.state === 'approved' && !au.stale && !!i.appUrl.proposed && au.value === i.appUrl.proposed && i.appUrl.runFileValue === au.value;
  add(
    'app_url',
    'Application URL approved and set for the run',
    appOk,
    au.state === 'none' ? 'The app_url value has not been approved.' : au.stale ? 'The app_url approval is stale (the project URL or the variables file changed).' : au.value !== i.appUrl.proposed ? 'The approved app_url value is not the project application URL.' : `The app_url Kane would use is not the approved value from KaneVerity's run variables file (${RUN_VARIABLES_FILE}): write it (and remove any later local file that defines app_url), then read the design again.`,
  );
  if (i.recordings) add('recordings', 'Every recorded test reviewed and approved (exact recording and test file)', i.recordings.ok, i.recordings.reason);
  add('dry_run', i.recordings ? 'Free dry run after the recording approvals passed, with no unresolved variables' : 'Free dry run of these exact tests passed, with no unresolved variables', i.dryRun.ok, i.dryRun.reason);
  add('idle', 'No design, review write, dry run or test run is active, and no earlier run is unresolved', !i.busy, i.busy ?? '');
  return { ready: items.every((x) => x.ok), items };
}

/** What a dry run is bound to: the exact tests (content, definition, file bytes) and every variables file. */
export function dryRunBinding(s: DesignSnapshot): Record<string, unknown> {
  return {
    tests: s.tests.map((t) => ({ cid: t.cid, definitionId: t.definitionId, path: t.file?.path ?? null, sha256: t.file?.sha256 ?? null, recording: t.recording?.sha256 ?? null })).sort((a, b) => String(a.path).localeCompare(String(b.path))),
    variables: s.variables.files ?? [],
    // Superseded tests' kept files: never run, but a change to one needs a new dry run (and so blocks the run).
    ...(s.supersededTestFiles?.length ? { supersededFiles: s.supersededTestFiles.map((f) => ({ path: f.path, sha256: f.sha256 })).sort((a, b) => a.path.localeCompare(b.path)) } : {}),
  };
}

/** Read the dry run's NDJSON: the plan's members and every unresolved variable. */
export function parseDryRun(stdout: string, files: string[]): { ok: boolean; unresolved: string[]; problems: string[] } {
  const problems: string[] = [];
  const unresolved = new Set<string>();
  type Plan = { members?: { path?: unknown; unresolved?: { name?: unknown }[] }[] };
  let plan = null as Plan | null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'testrun_plan') plan = e as unknown as Plan;
    if (e.type === 'warning' && e.code === 'unresolved_variables' && Array.isArray(e.variables)) for (const v of e.variables as { name?: unknown }[]) if (typeof v.name === 'string') unresolved.add(v.name);
    if (e.type === 'error') problems.push(`Kane reported an error: ${String(e.message ?? e.code ?? 'unknown')}`);
  }
  if (!plan || !Array.isArray(plan.members)) problems.push('The dry run did not report a plan.');
  else {
    const norm = (p: string) => p.replace(/\\/g, '/');
    const members = plan.members;
    for (const f of files) if (!members.some((m) => typeof m.path === 'string' && norm(m.path).endsWith(f))) problems.push(`The plan does not include ${f}.`);
    if (plan.members.length !== files.length) problems.push(`The plan has ${plan.members.length} members; ${files.length} tests were given.`);
    for (const m of plan.members) for (const u of m.unresolved ?? []) if (typeof u.name === 'string') unresolved.add(u.name);
  }
  return { ok: problems.length === 0 && unresolved.size === 0, unresolved: [...unresolved].sort(), problems };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const writeDir = (writeId: string) => dataPath('assurance', 'kane-writes', writeId);
const newWriteId = () => newId().replace(/^r/, 'w');
const newExecutionId = () => newId().replace(/^r/, 'x');

export class AssuranceDesigns {
  private locks = new Map<string, Promise<unknown>>();
  private usecases: AssuranceUseCases;
  private jobs: AssuranceJobs;
  /** Design-item writes running in this process; a pending write not listed here is unknown. */
  private activeWrites = new Set<string>();
  private writing = new Set<string>();
  private finishing = new Set<string>();

  /** The latest update handling of each job still in progress (see the constructor). */
  private updating = new Map<string, Promise<unknown>>();

  constructor(usecases: AssuranceUseCases, jobs: AssuranceJobs) {
    this.usecases = usecases;
    this.jobs = jobs;
    // Use-case decisions and writes wait while a design-item write or a test run is unresolved.
    usecases.setExternalBusy((t) => this.ownBusy(t));
    jobs.setRunPreflight((j) => this.runPreflight(j));
    jobs.setEvolveSpawnCheck((j) => this.evolveSpawnCheck(j));
    // Each job update's handling is tracked (synchronously), so a design read can wait for an
    // evolve's end-of-run check instead of racing it.
    jobs.on('update', (id: string) => {
      const run = this.onJobUpdate(id).catch(() => undefined);
      this.updating.set(id, run);
      void run.finally(() => {
        if (this.updating.get(id) === run) this.updating.delete(id);
      });
    });
  }

  private async serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === run) this.locks.delete(key);
    }
  }

  private params(tutorialId: unknown, ucHex: unknown): { t: string; cid: string } {
    if (!isTutorialId(tutorialId)) throw new AssuranceError(404, 'Tutorial not found.');
    if (typeof ucHex !== 'string' || !UC_HEX.test(ucHex)) throw new AssuranceError(404, 'Use case not found.');
    return { t: tutorialId, cid: `sha256:${ucHex}` };
  }

  /** After a restart: a design-item write that was pending has an unknown outcome. Nothing is retried. */
  async init(): Promise<void> {
    for (const j of await this.jobs.list().catch(() => [] as JobRecord[])) {
      if (j.kind !== 'evolve' || j.state === 'queued' || j.state === 'running' || !j.tutorialId) continue;
      await this.checkEvolve(j, true).catch((err) => console.error(`[orchestrator] the evolve check of ${j.jobId} failed: ${(err as Error).message}`));
    }
    for (const f of await readdir(dataPath('assurance', 'design-reviews')).catch(() => [] as string[])) {
      const t = f.replace(/\.json$/, '');
      if (!f.endsWith('.json') || !isTutorialId(t)) continue;
      let l: FullLog;
      try {
        l = await this.log(t);
      } catch (err) {
        console.error(`[orchestrator] ${(err as Error).message}`);
        continue;
      }
      // A run that was started when the orchestrator stopped has no known result. Its job was
      // marked interrupted before this service existed, so its update was never seen.
      for (const x of currentExecutions(l.executions)) {
        if (x.state !== 'started') continue;
        const job = x.jobId ? await this.jobs.get(x.jobId).catch(() => null) : null;
        if (job && (job.state === 'queued' || job.state === 'running')) continue;
        await this.appendTo(t, 'executions', { ...x, at: new Date().toISOString(), state: 'unknown', reason: `The orchestrator stopped while this run was ${x.jobId ? `in progress (job ${x.jobId}${job ? `, ${job.state}` : ''})` : 'being started'}. Its outcome is unknown; it is never re-run automatically. Reconcile it.` });
      }
      for (const w of currentDesignWrites(l.kaneWrites)) {
        if (w.state !== 'pending' || this.activeWrites.has(w.writeId)) continue;
        await this.appendTo(t, 'kaneWrites', { ...w, state: 'unknown', via: 'startup', at: new Date().toISOString(), reason: "The orchestrator stopped while this approval was being written to Kane, so the outcome is unknown. Check Kane's store (reconcile) before doing anything else." });
      }
    }
  }

  private async snapshots(t: string): Promise<string[]> {
    return (await readdir(snapDir(t)).catch(() => [] as string[])).filter((f) => /^snapshot-[0-9]{4}\.json$/.test(f)).sort();
  }

  /** The latest design read for this use case; an unreadable one fails closed. */
  async latest(t: string, cid: string): Promise<DesignSnapshot | null> {
    const files = await this.snapshots(t);
    for (let i = files.length - 1; i >= 0; i--) {
      const s = await readJson<DesignSnapshot>(path.join(snapDir(t), files[i]));
      if (!s) throw new AssuranceError(500, `The design read ${files[i]} cannot be read. Read the design again.`);
      if (s.ucCid === cid) return s;
    }
    return null;
  }

  /** The whole history, read fail-closed: only a missing file is an empty history. */
  private async log(t: string): Promise<FullLog> {
    const damaged = () => new AssuranceError(500, `The design review history for this tutorial cannot be read, so nothing was shown or changed. Check data/assurance/design-reviews/${t}.json; KaneVerity never rewrites a history it cannot read.`);
    let parsed: unknown;
    for (let attempt = 1; ; attempt++) {
      try {
        parsed = JSON.parse(await readFile(logFile(t), 'utf8'));
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (code === 'ENOENT') return { tutorialId: t, entries: [], kaneWrites: [], dryRuns: [], runVariables: [], executions: [], evolveChecks: [] };
        if ((err instanceof SyntaxError || ['EBUSY', 'EPERM', 'EACCES'].includes(code)) && attempt < 10) {
          await new Promise((r) => setTimeout(r, 20 * attempt));
          continue;
        }
        throw damaged();
      }
    }
    const l = parsed as Partial<FullLog> | null;
    if (!l || typeof l !== 'object' || l.tutorialId !== t || !Array.isArray(l.entries)) throw damaged();
    for (const k of ['kaneWrites', 'dryRuns', 'runVariables', 'executions', 'evolveChecks'] as const) if (l[k] !== undefined && !Array.isArray(l[k])) throw damaged();
    for (const e of l.entries) if (!e || typeof e !== 'object' || typeof e.bindingSha256 !== 'string' || typeof e.kind !== 'string' || typeof e.target !== 'string') throw damaged();
    return { tutorialId: t, entries: l.entries, kaneWrites: l.kaneWrites ?? [], dryRuns: l.dryRuns ?? [], runVariables: l.runVariables ?? [], executions: l.executions ?? [], evolveChecks: l.evolveChecks ?? [] };
  }

  private guard() {
    try {
      assertInstanceLock();
    } catch (err) {
      throw new AssuranceError(503, (err as Error).message);
    }
  }

  /** Append only: everything stored is kept exactly and the new entry goes last. */
  private async appendTo<K extends 'entries' | 'kaneWrites' | 'dryRuns' | 'runVariables' | 'executions' | 'evolveChecks'>(t: string, key: K, e: FullLog[K][number]) {
    this.guard();
    const l = await this.log(t);
    (l[key] as unknown[]).push(e);
    await writeJson(logFile(t), l);
  }

  private async appOrigin(): Promise<string | null> {
    const p = await readJson<Project>(dataPath('project.json'));
    return p?.appOrigin ?? null;
  }

  /** Why design review, writes and runs must wait now (this service's own state). */
  private async ownBusy(t: string): Promise<string | null> {
    if (this.writing.has(t)) return 'An approval of a design item is being written to Kane.';
    const l = await this.log(t);
    const w = currentDesignWrites(l.kaneWrites).find((x) => x.state === 'pending' || x.state === 'unknown');
    if (w) return w.state === 'pending' && this.activeWrites.has(w.writeId) ? 'An approval of a design item is being written to Kane.' : `Writing the approval of a design item to Kane has an unknown outcome (write ${w.writeId}). Check Kane's store first (reconcile).`;
    const active = (await this.jobs.list(t)).find((j) => (j.kind === 'dryrun' || j.kind === 'testrun') && (j.state === 'queued' || j.state === 'running'));
    if (active) return `A ${active.kind === 'testrun' ? 'test run' : 'dry run'} is ${active.state} (job ${active.jobId}).`;
    const x = currentExecutions(l.executions).find((e) => e.state === 'started' || e.state === 'unknown');
    if (x) return x.state === 'unknown' ? `Test run ${x.executionId} ended without a known result. Reconcile it first (it is never run again automatically).` : `Test run ${x.executionId} has not been checked yet.`;
    return null;
  }

  private async busy(t: string): Promise<string | null> {
    return (await this.usecases.busyReason(t)) ?? (await this.ownBusy(t));
  }

  private async waitJob(started: JobRecord, maxMs: number): Promise<JobRecord> {
    let job = started;
    const until = Date.now() + maxMs;
    while ((job.state === 'queued' || job.state === 'running') && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      job = await this.jobs.get(started.jobId);
    }
    return job;
  }

  /** A fresh design read (free reads). Caller holds the tutorial's design lock. */
  private async retrieveLocked(t: string, cid: string): Promise<DesignSnapshot> {
    const ucSnap = await this.usecases.retrieve(t);
    const listStdout = await readFile(jobStdoutPath(ucSnap.jobs.list), 'utf8').catch(() => '');
    const viewStdout = await readFile(jobStdoutPath(ucSnap.jobs.view), 'utf8').catch(() => '');
    const graph = await readDesignGraph(path.join(config.assurance.workspaceDir, '.context'), ucSnap.store.tipHash ?? null);
    const files = await this.snapshots(t);
    const n = files.length ? Number(files[files.length - 1].slice(9, 13)) + 1 : 1;
    const evolveInstructions = (await this.jobs.list(t)).flatMap((j) => (j.params.kind === 'evolve' && j.params.ucCid === cid ? [j.params.instruction] : []));
    const snap = await assembleDesign({ ucSnap, ucCid: cid, graph, listStdout, viewStdout, workspaceDir: config.assurance.workspaceDir, number: n, evolveInstructions });
    snap.evolveScope = await this.evolveScopeFor(t, cid);
    snap.correctiveKeep = await this.correctiveKeepFor(t, cid);
    await mkdir(snapDir(t), { recursive: true });
    await writeFile(path.join(snapDir(t), `snapshot-${pad(n)}.json`), JSON.stringify(snap, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    return snap;
  }

  /** Read the design with free, read-only Kane commands (a fresh use-case retrieval). */
  async retrieve(tutorialId: unknown, ucHex: unknown): Promise<DesignSnapshot> {
    const { t, cid } = this.params(tutorialId, ucHex);
    return this.serial(`design:${t}`, async () => {
      const busy = await this.usecases.busyReason(t);
      if (busy) throw new AssuranceError(409, `${busy} The design cannot be read until it has finished.`);
      if (this.writing.has(t)) throw new AssuranceError(409, 'An approval of a design item is being written to Kane.');
      return this.retrieveLocked(t, cid);
    });
  }

  private async context(t: string, cid: string) {
    const snap = await this.latest(t, cid);
    if (!snap) return null;
    const req = snap.requirements ? await readVersion(t, snap.requirements.version) : null;
    const requirements = req && req.intact ? requirementsFrom(req.meta.lineMap, req.markdown) : { steps: [], outcomes: [] };
    const ev = evaluateDesign(snap, requirements);
    if (!req || !req.intact) ev.structure.problems.unshift('The requirements this design was read with cannot be read intact.');
    if (!req || !req.intact) ev.structure.ok = false;
    const log = await this.log(t);
    const origin = await this.appOrigin();
    return { snap, requirements, ev, log, entries: log.entries, origin };
  }

  /** Every decision the design needs, with its current status. */
  private statuses(snap: DesignSnapshot, ev: DesignEvaluation, entries: DesignReviewEntry[], origin: string | null) {
    const out: { kind: DesignReviewKind; target: string; label: string; status: DecisionStatus; required: 'approved' | 'acknowledged' }[] = [];
    const push = (kind: DesignReviewKind, target: string, label: string, required: 'approved' | 'acknowledged') => out.push({ kind, target, label, required, status: decisionStatus(entries, kind, target, bindingFor(kind, target, snap, ev, origin)) });
    for (const m of ev.mapping.entries) push('mapping', m.outcome, `Mapping ${m.outcome} → ${m.acSlug ?? 'no criterion'}`, 'approved');
    for (const a of snap.acs) push('ac', a.cid, `Criterion ${a.slug}`, 'approved');
    for (const x of snap.scenarios) push('scenario', x.cid, `Scenario ${x.slug}`, 'approved');
    for (const x of snap.tests) push('test', x.cid, `Test ${x.slug}`, 'approved');
    for (const f of ev.fidelity) for (const e of f.extraSteps) push('extra_step', `${f.testCid}#${e.n}`, `Extra step ${e.n} of ${f.testSlug}`, 'approved');
    for (const g of snap.gaps) push('gap', g.cid, `Gap ${g.slug}`, 'acknowledged');
    return out;
  }

  /** Pre-execution readiness for the latest design read, plus what the UI shows with it. */
  private async readinessFor(t: string, cid: string) {
    const c = await this.context(t, cid);
    if (!c) return null;
    const { snap, ev, log, entries, origin } = c;
    const ucView = await this.usecases.view(t);
    const uc = ucView.useCases.find((u) => u.cid === cid);
    const latestUc = ucView.snapshot;
    const freshOk = !!latestUc && latestUc.snapshot === snap.useCaseSnapshot && latestUc.requirementsCurrent === true;
    const freshReason = !latestUc ? 'No use-case retrieval exists.' : latestUc.snapshot !== snap.useCaseSnapshot ? 'The Assurance store has been read again since this design read. Read the design again.' : 'The requirements are no longer current for the documentation.';
    const statuses = this.statuses(snap, ev, entries, origin);
    // The value Kane will use: the last local definition (local always beats global). It must be
    // KaneVerity's run file, so neither a later local file nor the global folder decides it.
    const winner = snap.variables.appUrlWinner ?? null;
    const appUrl = { status: decisionStatus(entries, 'app_url', 'app_url', bindingFor('app_url', 'app_url', snap, ev, origin)), proposed: origin, runFileValue: winner && winner.file === RUN_VARIABLES_FILE ? winner.value : null, winnerFile: winner?.file ?? null };
    const kaneApprovals = statuses
      .filter((s) => s.kind === 'ac' || s.kind === 'scenario' || s.kind === 'test')
      .map((s) => ({ label: s.label, target: s.target, kind: s.kind, ...kaneApprovalOf(snap, s.target, s.status, log.kaneWrites, this.activeWrites) }));
    const dr = log.dryRuns[log.dryRuns.length - 1] ?? null;
    const drCurrent = !!dr && dr.bindingSha256 === sha256(canonical(dryRunBinding(snap)));
    const dryRun = !dr
      ? { ok: false, reason: 'No dry run yet.' }
      : !drCurrent
        ? { ok: false, reason: 'The tests or the variables files changed since the last dry run. Run it again.' }
        : dr.state !== 'passed'
          ? { ok: false, reason: `The last dry run did not pass: ${dr.reason}${dr.unresolved.length ? ` Unresolved variables: ${dr.unresolved.join(', ')}.` : ''}` }
          : { ok: true, reason: '' };
    const busy = await this.busy(t);
    const base: PreExecutionInput = {
      integrityOk: snap.integrity.ok,
      integrityProblems: snap.integrity.problems,
      fresh: { ok: freshOk, reason: freshReason },
      useCase: uc ? { eligible: uc.design.eligible, reasons: uc.design.reasons } : { eligible: false, reasons: ['The use case is not in the latest retrieval.'] },
      ev,
      statuses,
      appUrl,
      kaneApprovals,
      dryRun,
      busy,
    };
    // Authoring readiness: may Kane record the approved tests (first run)?
    const readiness = computeReadiness(base);
    // Verification readiness: additionally, every recording approved (exact recording and test
    // file, made by an AUTHORED run), and a passed dry run made after the last approval.
    // Per test: its own decision (bound to its exact recording and test file) and its own proof
    // (from the latest authoring run of that test), so recordings made by different runs count.
    const execs = currentExecutions(log.executions);
    const recordings = snap.tests.map((x) => {
      const st = decisionStatus(entries, 'recording', x.cid, bindingFor('recording', x.cid, snap, ev, origin));
      const proof = recordingProof(x, execs);
      const why = !x.recording?.exists ? 'no recording yet (run the authoring run first)' : x.recording.staging ? 'Kane is replacing the recording (output .staging present)' : st.state === 'none' ? 'not reviewed' : st.stale ? 'the approval is stale (the recording or the test file changed)' : st.state !== 'approved' ? st.state : !proof.ok ? proof.reason : '';
      return { testCid: x.cid, slug: x.slug, recording: x.recording ?? null, status: st, proof, ok: !why, reason: why };
    });
    const lastApproval = recordings.map((r) => r.status.at).filter((a): a is string => !!a).sort().pop() ?? null;
    const recOk = recordings.length > 0 && recordings.every((r) => r.ok);
    const dryAfter = dryRun.ok && !!dr && !!lastApproval && dr.at > lastApproval;
    const verificationReadiness = computeReadiness({
      ...base,
      recordings: { ok: recOk, reason: recordings.filter((r) => !r.ok).map((r) => `${r.slug}: ${r.reason}.`).join(' ') },
      dryRun: dryAfter ? dryRun : { ok: false, reason: !dryRun.ok ? dryRun.reason : 'Run the dry run again after the recording approvals.' },
    });
    return { ...c, statuses, appUrl, kaneApprovals, dryRun: { latest: dr, current: drCurrent, ...dryRun }, busy, freshOk, readiness, verificationReadiness, recordings };
  }

  /** The latest design read with its checks, reviews, readiness and test runs (UI-safe). */
  async view(tutorialId: unknown, ucHex: unknown, note: string | null = null) {
    const { t, cid } = this.params(tutorialId, ucHex);
    const reviewer = reviewerSetting();
    const base = { tutorialId: t, ucCid: cid, mode: config.assurance.mode, reviewer: { label: reviewer.label, problem: reviewer.problem, selfDeclared: true as const }, note };
    const r = await this.readinessFor(t, cid);
    if (!r) return scrubDeep({ ...base, design: null });
    const { snap, requirements, ev, log, statuses, appUrl, kaneApprovals, dryRun, busy, freshOk, readiness, verificationReadiness, recordings } = r;
    const execs = currentExecutions(log.executions);
    const lastExec = execs[execs.length - 1] ?? null;
    // Kane is still running this run's job: it can be watched, never reconciled.
    const lastJob = lastExec?.jobId && lastExec.state === 'started' ? await this.jobs.get(lastExec.jobId).catch(() => null) : null;
    const kaneRunning = !!lastJob && (lastJob.state === 'queued' || lastJob.state === 'running');
    const recheckWhy = lastExec && (lastExec.state === 'finished' || lastExec.state === 'rechecked') ? await this.recheckBlock(t, lastExec, execs) : 'Only a finished run can be re-checked.';
    const res = lastExec?.result ?? null;
    // What each paid run would run now, from the same selection the job uses when it starts.
    const selection = authoringSelection(snap.tests, recordings);
    const notReady = (items: { ok: boolean; label: string; reason: string }[]) => items.filter((x) => !x.ok).map((x) => `${x.label}: ${x.reason}`).join(' | ');
    const authoringPlan = { tests: selection.tests.map((x) => ({ slug: x.slug, testCid: x.cid, testFile: x.file?.path ?? null })), available: readiness.ready && !selection.refusal, reason: !readiness.ready ? notReady(readiness.items) : (selection.refusal ?? '') };
    const verificationPlan = { tests: snap.tests.map((x) => ({ slug: x.slug, testCid: x.cid, testFile: x.file?.path ?? null })), available: verificationReadiness.ready, reason: verificationReadiness.ready ? '' : notReady(verificationReadiness.items) };
    const pub = scrubDeep({
      ...base,
      design: {
        snapshot: snap.snapshot,
        retrievedAt: snap.retrievedAt,
        useCaseSnapshot: snap.useCaseSnapshot,
        integrity: snap.integrity,
        store: snap.store,
        requirements: snap.requirements,
        designRecords: snap.designRecords,
        acs: snap.acs,
        scenarios: snap.scenarios,
        tests: snap.tests,
        gaps: snap.gaps,
        strayTestFiles: snap.strayTestFiles,
        supersededTestFiles: snap.supersededTestFiles ?? [],
        supersessions: snap.supersessions ?? [],
        variables: snap.variables,
      },
      documented: requirements,
      evaluation: ev,
      reviews: statuses.map((s) => ({ kind: s.kind, target: s.target, label: s.label, required: s.required, ...s.status })),
      kaneApprovals: kaneApprovals.map((k) => ({ label: k.label, target: k.target, kind: k.kind, ok: k.ok, state: k.state, reason: k.reason, kaneSeq: k.write?.kaneSeq ?? null, writeId: k.write?.writeId ?? null })),
      appUrl: { proposed: appUrl.proposed, ...appUrl.status, declaredByKane: snap.variables.appUrlDeclared, fileHasValue: snap.variables.appUrlHasValue, runFile: RUN_VARIABLES_FILE, runFileValue: appUrl.runFileValue, writesKaneFile: false as const },
      dryRun: { ok: dryRun.ok, reason: dryRun.reason, current: dryRun.current, latest: dryRun.latest ? { id: dryRun.latest.id, at: dryRun.latest.at, state: dryRun.latest.state, reason: dryRun.latest.reason, unresolved: dryRun.latest.unresolved, files: dryRun.latest.files } : null },
      readiness,
      verificationReadiness,
      authoringPlan,
      verificationPlan,
      recordings: recordings.map((x) => ({ testCid: x.testCid, slug: x.slug, dir: x.recording?.dir ?? null, exists: !!x.recording?.exists, staging: !!x.recording?.staging, sha256: x.recording?.sha256 ?? null, files: x.recording?.files ?? 0, resultMd: x.recording?.resultMd ?? null, state: x.status.state, stale: x.status.stale, at: x.status.at, ok: x.ok, reason: x.reason, evidence: { ok: x.proof.ok, reason: x.proof.reason, executionId: x.proof.executionId } })),
      execution: lastExec
        ? { executionId: lastExec.executionId, phase: lastExec.phase, jobId: lastExec.jobId, state: lastExec.state, at: lastExec.at, reason: lastExec.reason, verdict: lastExec.result?.verdict ?? null, mutation: lastExec.result?.mutation ?? [], problems: lastExec.result?.problems ?? [], outcomes: lastExec.result?.verification?.outcomes ?? [], packOk: lastExec.result?.verification?.packOk ?? null, runKind: lastExec.result?.verification?.runKind ?? null, packProblems: lastExec.result?.verification?.problems ?? [], kaneRunning, canReconcile: lastExec.state === 'unknown' || (lastExec.state === 'started' && !kaneRunning && lastJob?.state !== 'complete' && !this.finishing.has(lastExec.jobId ?? '')),
            // What the run left, as checked (pack names, workspace-relative test paths, statuses; no logs or pack contents).
            checker: res ? res.checker ?? 1 : null,
            evidenceFile: res?.evidenceFile ?? null,
            testPacks: (res?.packs ?? []).filter((p) => p.role === 'test').map((p) => p.name),
            members: (res?.members ?? []).map((m) => ({ outcome: m.outcome, testSlug: m.testSlug, testFile: m.testFile, kaneStatus: m.kaneStatus, durationS: m.durationS, testPack: m.testPack, packMemberStatus: m.packMemberStatus, recording: { path: m.recording.path, exists: m.recording.exists, sha256: m.recording.sha256 } })),
            kaneRun: res?.kaneRun ?? null,
            recheckOf: lastExec.recheckOf ? { at: lastExec.recheckOf.at, verdict: lastExec.recheckOf.verdict, checker: lastExec.recheckOf.checker, problems: lastExec.recheckOf.problems } : null,
            canRecheck: recheckWhy === null,
            recheckReason: recheckWhy ?? '' }
        : null,
      canReview: snap.integrity.ok && freshOk && !busy && !!reviewer.label,
    });
    const leaks = findLeaks(pub);
    if (leaks.length) throw new AssuranceError(500, `Design withheld: sensitive data detected (${leaks.join(', ')}).`);
    return pub;
  }

  /** Common checks before any decision is recorded. */
  private async preDecision(t: string, cid: string) {
    const reviewer = reviewerSetting();
    if (!reviewer.label) throw new AssuranceError(409, reviewer.problem ?? 'No reviewer is set.');
    const busy = await this.busy(t);
    if (busy) throw new AssuranceError(409, `${busy} Design review is locked until it finishes.`);
    const c = await this.context(t, cid);
    if (!c) throw new AssuranceError(409, 'Read the design first.');
    if (!c.snap.integrity.ok) throw new AssuranceError(409, 'The latest design read failed its integrity checks, so nothing in it can be reviewed. Read the design again.');
    const latestUc = await this.usecases.latest(t);
    if (!latestUc || latestUc.snapshot !== c.snap.useCaseSnapshot) throw new AssuranceError(409, 'The Assurance store has been read again since this design read. Read the design again before reviewing.');
    return { ...c, reviewer: reviewer.label };
  }

  /** Record one KaneVerity decision on an item, an outcome's mapping, an extra step or a gap. */
  async review(tutorialId: unknown, ucHex: unknown, body: unknown): Promise<DesignReviewEntry> {
    const { t, cid } = this.params(tutorialId, ucHex);
    const b = (body && typeof body === 'object' ? body : {}) as { kind?: unknown; target?: unknown; decision?: unknown; reason?: unknown; acknowledgeStale?: unknown };
    if (typeof b.kind !== 'string' || !ITEM_KINDS.has(b.kind as DesignReviewKind)) throw new AssuranceError(400, 'kind must be one of ac, scenario, test, gap, mapping, extra_step, recording.');
    if (typeof b.target !== 'string' || b.target.length > 200) throw new AssuranceError(400, 'target is required.');
    const kind = b.kind as DesignReviewKind;
    const target = b.target;
    return this.serial(`design:${t}`, async () => {
      const { snap, ev, origin, reviewer, log } = await this.preDecision(t, cid);
      const binding = bindingFor(kind, target, snap, ev, origin);
      if (!binding) throw new AssuranceError(404, kind === 'recording' ? 'That test has no recording in the latest design read.' : 'That item is not in the latest design read.');
      let decision: DesignReviewEntry['decision'];
      if (kind === 'gap') {
        if (b.decision !== 'acknowledge') throw new AssuranceError(400, 'A gap can only be acknowledged; it is never dismissed.');
        const g = snap.gaps.find((x) => x.cid === target)!;
        const stale = g.refState === 'superseded' || g.refState === 'unknown';
        if (stale && b.acknowledgeStale !== true) throw new AssuranceError(400, `This gap points at ${g.ref}, which is ${g.refState === 'superseded' ? 'superseded' : 'unknown'}. Acknowledging it needs acknowledgeStale: true.`);
        decision = 'acknowledged';
      } else {
        if (b.decision !== 'approve' && b.decision !== 'reject') throw new AssuranceError(400, 'decision must be "approve" or "reject".');
        decision = b.decision === 'approve' ? 'approved' : 'rejected';
        if (decision === 'approved' && kind === 'mapping') {
          const m = ev.mapping.entries.find((x) => x.outcome === target)!;
          if (!m.acCid || m.problem) throw new AssuranceError(409, `The mapping for ${target} cannot be approved: ${m.problem ?? 'no criterion matches it.'}`);
        }
        if (decision === 'approved' && kind === 'recording') {
          // Only a recording the latest authoring run of THIS test produced (AUTHORED, unchanged
          // since, same test file), whose recorded check meets the outcome evidence rules.
          const tf = snap.tests.find((x) => x.cid === target)!;
          const proof = recordingProof(tf, currentExecutions(log.executions));
          if (!proof.ok) throw new AssuranceError(409, `This recording cannot be approved: ${proof.reason}.`);
          if (!tf.recording!.resultMd) throw new AssuranceError(409, "Kane's Result.md is missing from the recording, so its steps cannot be reviewed.");
        }
        if (decision === 'approved' && kind === 'test') {
          const tf = snap.tests.find((x) => x.cid === target)!;
          if (!tf.file || !tf.file.bodyMatches || tf.file.basePin !== tf.definitionId) throw new AssuranceError(409, "This test's generated file does not match the test Kane stored, so it cannot be approved.");
        }
      }
      const reason = cleanReason(b.reason, decision !== 'approved');
      const entry: DesignReviewEntry = { id: newId(), at: new Date().toISOString(), by: 'kaneverity-design-review', reviewer, kind, target, decision, reason, ucCid: cid, designSnapshot: snap.snapshot, binding, bindingSha256: sha256(canonical(binding)) };
      await this.appendTo(t, 'entries', entry);
      return entry;
    });
  }

  /**
   * Approve the value KaneVerity will give Kane's app_url variable. Only the connected
   * project's application URL is accepted, and only on this machine. Kane's generated
   * variables file is never written.
   */
  async approveAppUrl(tutorialId: unknown, ucHex: unknown, body: unknown): Promise<DesignReviewEntry> {
    const { t, cid } = this.params(tutorialId, ucHex);
    const b = (body && typeof body === 'object' ? body : {}) as { value?: unknown; confirm?: unknown; reason?: unknown };
    return this.serial(`design:${t}`, async () => {
      const { snap, ev, origin, reviewer } = await this.preDecision(t, cid);
      if (!origin) throw new AssuranceError(409, 'Connect a project first.');
      if (b.confirm !== true) throw new AssuranceError(400, 'Approving the app_url value needs confirm: true.');
      if (typeof b.value !== 'string' || b.value !== origin) throw new AssuranceError(400, `The app_url value must be the connected application URL, exactly: ${origin}`);
      let u: URL;
      try {
        u = new URL(b.value);
      } catch {
        throw new AssuranceError(400, 'The app_url value is not a URL.');
      }
      if (!['http:', 'https:'].includes(u.protocol) || !LOOPBACK.has(u.hostname) || u.origin !== b.value) throw new AssuranceError(400, 'The app_url value must be a local application origin (http://127.0.0.1:<port> or localhost), with no path.');
      if (!snap.variables.appUrlDeclared) throw new AssuranceError(409, "Kane's design does not declare an app_url variable.");
      const binding = bindingFor('app_url', 'app_url', snap, ev, origin)!;
      const entry: DesignReviewEntry = { id: newId(), at: new Date().toISOString(), by: 'kaneverity-design-review', reviewer, kind: 'app_url', target: 'app_url', decision: 'approved', reason: cleanReason(b.reason, false), ucCid: cid, designSnapshot: snap.snapshot, binding, bindingSha256: sha256(canonical(binding)) };
      await this.appendTo(t, 'entries', entry);
      return entry;
    });
  }

  /**
   * Write KaneVerity's run variables file with the approved app_url. It is the only file
   * KaneVerity writes in Kane's folders; Kane loads every variables file alphabetically and a
   * later file wins, so this sets app_url without touching Kane's assurance.json. Needs
   * {confirm: true}. A design read is needed afterwards (the variables changed).
   */
  async writeRunVariables(tutorialId: unknown, ucHex: unknown, body: unknown): Promise<RunVariablesEntry> {
    const { t, cid } = this.params(tutorialId, ucHex);
    const b = (body && typeof body === 'object' ? body : {}) as { confirm?: unknown };
    return this.serial(`design:${t}`, async () => {
      const { snap, ev, origin, log, reviewer } = await this.preDecision(t, cid);
      if (b.confirm !== true) throw new AssuranceError(400, 'Writing the run variables file needs confirm: true.');
      const st = decisionStatus(log.entries, 'app_url', 'app_url', bindingFor('app_url', 'app_url', snap, ev, origin));
      if (st.state !== 'approved' || st.stale || !origin || st.value !== origin || !st.entryId) throw new AssuranceError(409, 'Approve the app_url value first (current approval of the connected application URL).');
      const file = path.join(config.assurance.workspaceDir, '.testmuai', 'variables', RUN_VARIABLES_FILE);
      const existing = await readFile(file).catch(() => null);
      if (existing) {
        const h = createHash('sha256').update(existing).digest('hex');
        if (!log.runVariables.some((r) => r.sha256 === h)) throw new AssuranceError(409, `${RUN_VARIABLES_FILE} exists but was not written by KaneVerity. It is not overwritten.`);
      }
      const content = JSON.stringify({ app_url: { value: origin, secret: false, description: 'Set by KaneVerity from the app_url value approved in design review.' } }, null, 2) + '\n';
      this.guard();
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, 'utf8');
      const entry: RunVariablesEntry = { id: newId(), at: new Date().toISOString(), reviewer, value: origin, sha256: createHash('sha256').update(content).digest('hex'), appUrlEntryId: st.entryId };
      await this.appendTo(t, 'runVariables', entry);
      return entry;
    });
  }

  /** Record a KaneVerity approval of one criterion, scenario or test in Kane, and verify it there. */
  async kaneWrite(tutorialId: unknown, ucHex: unknown, body: unknown): Promise<DesignKaneWrite> {
    const { t, cid } = this.params(tutorialId, ucHex);
    const target = (body && typeof body === 'object' ? (body as { target?: unknown }).target : undefined) as unknown;
    if (typeof target !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(target)) throw new AssuranceError(400, 'target must be the content id of a criterion, scenario or test.');
    if (this.writing.has(t)) throw new AssuranceError(409, 'An approval of a design item is being written to Kane.');
    return this.serial(`design:${t}`, async () => {
      const reviewer = reviewerSetting();
      if (!reviewer.label) throw new AssuranceError(409, reviewer.problem ?? 'No reviewer is set.');
      if (config.assurance.mode === 'off') throw new AssuranceError(403, 'Kane Assurance commands are switched off, so the approval cannot be written to Kane now.');
      const busy = await this.busy(t);
      if (busy) throw new AssuranceError(409, busy);
      // Fresh read, then every condition the decision was made under.
      const fresh = await this.retrieveLocked(t, cid);
      if (!fresh.integrity.ok) throw new AssuranceError(409, `Not written to Kane: the design read failed its integrity checks (${fresh.integrity.problems.join(' ')}).`);
      const c = (await this.context(t, cid))!;
      const item = [...c.snap.acs, ...c.snap.scenarios, ...c.snap.tests].find((x) => x.cid === target);
      if (!item) throw new AssuranceError(404, 'That criterion, scenario or test is not in the current design (exact content id).');
      const kind = item.label as 'ac' | 'scenario' | 'test';
      const st = decisionStatus(c.entries, kind, target, bindingFor(kind, target, c.snap, c.ev, c.origin));
      if (st.state !== 'approved' || st.stale || !st.entryId) throw new AssuranceError(409, 'Only an item whose current KaneVerity decision is an approval can be recorded in Kane.');
      if (kind === 'ac') {
        const m = c.ev.mapping.entries.find((x) => x.acCid === target);
        const ms = m ? decisionStatus(c.entries, 'mapping', m.outcome, bindingFor('mapping', m.outcome, c.snap, c.ev, c.origin)) : null;
        if (!m || !ms || ms.state !== 'approved' || ms.stale) throw new AssuranceError(409, "Approve this criterion's outcome mapping first.");
      }
      const prior = currentDesignWrites(c.log.kaneWrites).filter((w) => w.target === target && w.decisionId === st.entryId);
      if (prior.some((w) => w.state === 'verified')) throw new AssuranceError(409, 'This approval is already recorded in Kane and verified.');
      if (prior.some((w) => w.state === 'written_unverified')) throw new AssuranceError(409, 'Kane already holds a record for this approval that KaneVerity could not verify. It is not written again.');
      if (item.trust !== 'derived') throw new AssuranceError(409, `Kane lists this item as "${item.trust}", so an approval is not written (only items waiting for review take a verdict).`);
      if ((c.snap.kaneReviews ?? []).some((k) => k.cid === target && k.resolution === 'approved')) throw new AssuranceError(409, 'Kane already holds an approval record for this item that KaneVerity did not verify. It is not written again.');
      this.guard();
      const writeId = newWriteId();
      const pending: DesignKaneWrite = { type: 'kane_write', writeId, kind, target, decisionId: st.entryId, state: 'pending', via: 'write', at: new Date().toISOString(), reason: 'Writing the approval to Kane.', baseTip: c.snap.store.tipHash, baseRecords: c.snap.store.records, jobId: null, kaneSeq: null, kaneHash: null, kaneBy: null, reviewer: reviewer.label, by: 'kaneverity-design-review' };
      this.activeWrites.add(writeId);
      this.writing.add(t);
      try {
        await this.appendTo(t, 'kaneWrites', pending);
        let job: JobRecord;
        try {
          await mkdir(writeDir(writeId), { recursive: true });
          await writeFile(path.join(writeDir(writeId), 'verdicts.json'), JSON.stringify([{ ref: target, resolution: 'approved', reason: `KaneVerity design decision ${st.entryId}, write ${writeId}. Reviewer self-declared as ${reviewer.label}.` }], null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
          job = await this.jobs.startReview({ tutorialId: t, writeId, ucCid: target, reviewer: reviewer.label });
        } catch (err) {
          const e: DesignKaneWrite = { ...pending, state: 'not_written', at: new Date().toISOString(), reason: `Kane was not started: ${scrub((err as Error).message)}` };
          await this.appendTo(t, 'kaneWrites', e);
          return e;
        }
        await this.appendTo(t, 'kaneWrites', { ...pending, jobId: job.jobId, at: new Date().toISOString(), reason: 'Kane is recording the approval.' });
        const done = await this.waitJob(job, config.assurance.timeoutMs + 30_000);
        return await this.settle(t, cid, { ...pending, jobId: job.jobId }, done, 'write');
      } catch (err) {
        const e: DesignKaneWrite = { ...pending, state: 'unknown', at: new Date().toISOString(), reason: `The write was interrupted (${scrub((err as Error).message)}). Its outcome is unknown; check Kane's store.` };
        await this.appendTo(t, 'kaneWrites', e);
        return e;
      } finally {
        this.activeWrites.delete(writeId);
        this.writing.delete(t);
      }
    });
  }

  /** Settle a design-item write with an unknown outcome by reading Kane's store. Never writes again. */
  async reconcileKaneWrite(tutorialId: unknown, ucHex: unknown, body: unknown): Promise<DesignKaneWrite> {
    const { t, cid } = this.params(tutorialId, ucHex);
    const target = (body && typeof body === 'object' ? (body as { target?: unknown }).target : undefined) as unknown;
    if (typeof target !== 'string') throw new AssuranceError(400, 'target is required.');
    if (config.assurance.mode === 'off') throw new AssuranceError(403, "Kane Assurance commands are switched off, so Kane's store cannot be checked now.");
    if (this.writing.has(t)) throw new AssuranceError(409, 'An approval of a design item is being written to Kane.');
    return this.serial(`design:${t}`, async () => {
      const w = currentDesignWrites((await this.log(t)).kaneWrites).filter((x) => x.target === target).pop();
      const state = w && w.state === 'pending' && !this.activeWrites.has(w.writeId) ? 'unknown' : w?.state;
      if (!w || state !== 'unknown') throw new AssuranceError(409, 'There is no write with an unknown outcome to check for this item.');
      if (w.jobId) {
        const job = await this.jobs.get(w.jobId).catch(() => null);
        if (job && (job.state === 'queued' || job.state === 'running')) throw new AssuranceError(409, 'Kane is still running this write. Check again when it has finished.');
      }
      return this.settle(t, cid, { ...w, state: 'unknown' }, null, 'reconcile');
    });
  }

  /** Decide a design-item write's state from Kane's store. Only an exact match is "verified". */
  private async settle(t: string, cid: string, w: DesignKaneWrite, job: JobRecord | null, via: 'write' | 'reconcile'): Promise<DesignKaneWrite> {
    const record = async (state: KaneWriteState, reason: string, extra: Partial<DesignKaneWrite> = {}) => {
      const e: DesignKaneWrite = { ...w, ...extra, state, via, at: new Date().toISOString(), reason };
      await this.appendTo(t, 'kaneWrites', e);
      return e;
    };
    if (job && ['queued', 'running'].includes(job.state)) return record('unknown', "Kane did not finish within the time allowed. The outcome is unknown; check Kane's store.");
    let post: DesignSnapshot;
    try {
      post = await this.retrieveLocked(t, cid);
    } catch (err) {
      return record('unknown', `Kane's store could not be read after the write (${scrub((err as Error).message)}). The outcome is unknown.`);
    }
    let outputConfirms: boolean | null = null;
    if (job) {
      const out = await readFile(jobStdoutPath(job.jobId), 'utf8').catch(() => '');
      try {
        const objs = out.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
        outputConfirms = objs.length === 1 && objs[0].cid === w.target && objs[0].resolution === 'approved';
      } catch {
        outputConfirms = false;
      }
    }
    const approvals = (post.kaneReviews ?? []).filter((k) => k.seq > w.baseRecords && k.cid === w.target && k.resolution === 'approved');
    if (!approvals.length) {
      if (!post.integrity.ok) return record('unknown', `Kane's store failed its integrity checks after the write (${post.integrity.problems.join(' ')}). The outcome is unknown.`);
      if (outputConfirms) return record('unknown', 'Kane reported the approval, but no approval record for this item is in its store. The outcome is unknown.');
      const unchanged = post.store.records === w.baseRecords && post.store.tipHash === w.baseTip;
      return record('not_written', unchanged ? `Kane did not record the approval; its store is unchanged.${job ? ` ${job.reason}` : ''}` : "Kane's store holds no approval record for this item after the write, so it was not written.");
    }
    const r = approvals[0];
    const after = [...post.acs, ...post.scenarios, ...post.tests].find((x) => x.cid === w.target);
    const expectedBy = `human:${kaneUserFor(w.reviewer)}`;
    const problems: string[] = [];
    if (!post.integrity.ok) problems.push(`the store failed its integrity checks (${post.integrity.problems.join(' ')})`);
    if (approvals.length !== 1) problems.push('Kane holds more than one new approval for this item');
    if (r.seq !== w.baseRecords + 1 || post.store.records !== w.baseRecords + 1) problems.push(`the approval is not the single next record (record #${r.seq}; the store has ${post.store.records} records, ${w.baseRecords} before)`);
    if (!r.reviewOnly || r.itemsInRecord !== 1) problems.push('the record holds more than this one approval');
    if (r.prevHash !== w.baseTip) problems.push('the record does not follow the store tip the write started from');
    if (r.by !== expectedBy) problems.push(`Kane recorded it as "${r.by}", not "${expectedBy}"`);
    if (r.build !== config.assurance.pinnedVersion) problems.push(`it was written by Kane ${r.build ?? 'unknown'}, not ${config.assurance.pinnedVersion}`);
    if (!r.recordHash) problems.push("the record's hash could not be confirmed");
    if (!after) problems.push('the item (same content id) is no longer in the design');
    else if (after.trust !== 'trusted') problems.push(`Kane lists it as "${after.trust}", not trusted`);
    if (via === 'write' && outputConfirms === false) problems.push("Kane's output did not confirm this exact approval");
    const found = { kaneSeq: r.seq, kaneHash: r.recordHash, kaneBy: r.by };
    if (via === 'write' && job && job.state !== 'complete') return record('unknown', `Kane wrote an approval record (#${r.seq}), but its process did not finish normally (${job.reason.replace(/\.$/, '')}). Check Kane's store to confirm it.`, found);
    if (problems.length) return record('written_unverified', `Kane holds an approval record (#${r.seq}) that KaneVerity could not verify: ${problems.join('; ')}.`, found);
    return record('verified', `Verified in Kane: record #${r.seq} approves this exact item, recorded as ${r.by}; Kane lists it as trusted.`, found);
  }

  /**
   * B5: start exactly one `maintain evolve` of this use case (paid: mode "all", the paid
   * confirmation and the exact acknowledgement). KaneVerity builds the instruction itself, from
   * the approved requirements and a fresh design read (never from the request). Every gate a
   * test design has is applied (fresh reads, approved and verified use case, current
   * requirements, nothing in progress or unknown, a complete design to replace); the result is
   * judged afterwards by the free B5 design read, like any design.
   */
  async evolve(tutorialId: unknown, ucHex: unknown, body: unknown): Promise<JobRecord> {
    const { t, cid } = this.params(tutorialId, ucHex);
    const b = (body && typeof body === 'object' ? body : {}) as { confirm?: unknown; acknowledgement?: unknown; instruction?: unknown; because?: unknown; corrective?: unknown };
    // Only KaneVerity's own instruction is ever passed: a request that brings its own text is refused.
    if (b.instruction !== undefined || b.because !== undefined) throw new AssuranceError(400, "The evolve instruction is built by KaneVerity from the approved requirements; a request cannot supply one.");
    if (b.corrective !== undefined && b.corrective !== true) throw new AssuranceError(400, 'corrective must be true when given.');
    if (b.corrective === true) return this.correctiveEvolve(t, cid, b);
    const words = evolveAcknowledgement(cid);
    if (b.acknowledgement !== words) throw new AssuranceError(400, `An evolve needs this exact acknowledgement in "acknowledgement": "${words}"`);
    // Checked before any Kane read, so a refused request costs nothing.
    if (config.assurance.mode !== 'all') throw new AssuranceError(403, 'An evolve uses Kane credits, so it needs Assurance mode "all". Nothing was started.');
    const paidOk = !!b.confirm && typeof b.confirm === 'object' && (b.confirm as { paid?: unknown }).paid === true;
    if (!paidOk) throw new AssuranceError(400, 'An evolve uses Kane credits. Confirm it explicitly ({"confirm": {"paid": true}}).');
    return this.serial(`design:${t}`, async () => {
      // Exactly one evolve per use-case version: another (whatever became of the first) needs a separate decision.
      const earlier = usedEvolve(await this.jobs.list(t), cid);
      if (earlier) throw new AssuranceError(409, `Not started: an evolve of this use case was already started (job ${earlier.jobId}, ${earlier.state}). KaneVerity starts one evolve per use-case version; another needs a separate, recorded decision.`);
      const own = await this.ownBusy(t);
      if (own) throw new AssuranceError(409, `Not started: ${own}`);
      // The gates a test design has (fresh use-case read included), for this exact version.
      const gate = await this.usecases.evolveChecks(t, cid);
      // A fresh design read, then the instruction from what it shows.
      const snap = await this.retrieveLocked(t, cid);
      if (!snap.integrity.ok) throw new AssuranceError(409, `Not started: the design read failed its integrity checks (${snap.integrity.problems.join(' ')}).`);
      if (!snap.requirements || !gate.fresh.requirements || snap.requirements.reqSha256 !== gate.fresh.requirements.reqSha256) throw new AssuranceError(409, 'Not started: the design read and the use-case read do not name the same requirements.');
      const bad = (why: string) => new AssuranceError(409, `Not started: ${why}`);
      const why = { reason: '' };
      const inputs = await this.evolveInputsFrom(t, cid, snap, gate.ucNow.logicalId, why);
      if (!inputs) throw bad(why.reason);
      let instruction: string;
      try {
        instruction = evolveInstruction(inputs);
      } catch (err) {
        if (err instanceof CommandError) throw bad(err.message);
        throw err;
      }
      this.guard();
      const scope = await this.scopePrint();
      if (scope.problems?.length) throw new AssuranceError(409, `Not started: what the evolve must not change cannot be fingerprinted cleanly: ${scope.problems.join(' ')}`);
      return this.jobs.startEvolve({ tutorialId: t, ucCid: cid, useCase: gate.ucNow.logicalId, reviewer: gate.reviewer, decisionId: gate.decisionId, inputs, instruction, acknowledgement: words, scope, requirements: gate.fresh.requirements, confirm: b.confirm });
    });
  }

  /**
   * B5: the one corrective evolve of this use-case version (section 13.13; paid: mode "all", the
   * paid confirmation and its own exact acknowledgement, which names the tests it replaces). It is
   * the only exception to "one evolve per use-case version", and only after that evolve completed
   * and passed its check, the recording review approved the tests to keep (with their proof) and
   * rejected the ones to replace. Every gate and fingerprint of a plain evolve applies, plus what it
   * must keep: exact content ids, the kept tests' files and every recording.
   */
  private async correctiveEvolve(t: string, cid: string, b: { confirm?: unknown; acknowledgement?: unknown }): Promise<JobRecord> {
    const slugs = await this.rejectedRecordings(t, cid);
    if (!slugs.length) throw new AssuranceError(409, 'Not started: no recording is rejected, so there is nothing for a corrective evolve to replace.');
    const words = correctiveEvolveAcknowledgement(cid, slugs);
    if (b.acknowledgement !== words) throw new AssuranceError(400, `A corrective evolve needs this exact acknowledgement in "acknowledgement": "${words}"`);
    // Checked before any Kane read, so a refused request costs nothing.
    if (config.assurance.mode !== 'all') throw new AssuranceError(403, 'A corrective evolve uses Kane credits, so it needs Assurance mode "all". Nothing was started.');
    const paidOk = !!b.confirm && typeof b.confirm === 'object' && (b.confirm as { paid?: unknown }).paid === true;
    if (!paidOk) throw new AssuranceError(400, 'A corrective evolve uses Kane credits. Confirm it explicitly ({"confirm": {"paid": true}}).');
    return this.serial(`design:${t}`, async () => {
      const jobs = await this.jobs.list(t);
      const first = usedEvolve(jobs, cid);
      const firstCheck = first ? (await this.log(t)).evolveChecks.filter((x) => x.jobId === first.jobId).pop() : undefined;
      if (!first || first.state !== 'complete' || !firstCheck || firstCheck.problems.length) throw new AssuranceError(409, `Not started: a corrective evolve follows only this use case's one evolve, completed and checked with no problems${first ? ` (job ${first.jobId} is ${first.state}${firstCheck ? `, ${firstCheck.problems.length} problems` : ', not checked'})` : ' (none was run)'}.`);
      const again = usedCorrectiveEvolve(jobs, cid);
      if (again) throw new AssuranceError(409, `Not started: the corrective evolve of this use case was already started (job ${again.jobId}, ${again.state}). There is one per use-case version.`);
      const own = await this.ownBusy(t);
      if (own) throw new AssuranceError(409, `Not started: ${own}`);
      const gate = await this.usecases.evolveChecks(t, cid, { corrective: true });
      const snap = await this.retrieveLocked(t, cid);
      if (!snap.integrity.ok) throw new AssuranceError(409, `Not started: the design read failed its integrity checks (${snap.integrity.problems.join(' ')}).`);
      if (!snap.requirements || !gate.fresh.requirements || snap.requirements.reqSha256 !== gate.fresh.requirements.reqSha256) throw new AssuranceError(409, 'Not started: the design read and the use-case read do not name the same requirements.');
      const bad = (why: string) => new AssuranceError(409, `Not started: ${why}`);
      const why = { reason: '' };
      const inputs = await this.evolveInputsFrom(t, cid, snap, gate.ucNow.logicalId, why);
      if (!inputs) throw bad(why.reason);
      const corrective = await this.correctiveFrom(t, cid, snap, gate.ucNow.logicalId, why);
      if (!corrective) throw bad(why.reason);
      // The acknowledgement names the tests this exact read replaces.
      if (correctiveEvolveAcknowledgement(cid, corrective.inputs.replace.map((r) => r.test)) !== words) throw bad('the rejected recordings changed since the acknowledgement was given.');
      let instruction: string;
      try {
        instruction = correctiveEvolveInstruction(corrective.inputs);
      } catch (err) {
        if (err instanceof CommandError) throw bad(err.message);
        throw err;
      }
      this.guard();
      const scope = await this.scopePrint();
      if (scope.problems?.length) throw new AssuranceError(409, `Not started: what the evolve must not change cannot be fingerprinted cleanly: ${scope.problems.join(' ')}`);
      return this.jobs.startEvolve({ tutorialId: t, ucCid: cid, useCase: gate.ucNow.logicalId, reviewer: gate.reviewer, decisionId: gate.decisionId, inputs, instruction, acknowledgement: words, scope, corrective, requirements: gate.fresh.requirements, confirm: b.confirm });
    });
  }

  /**
   * The evolve instruction's inputs, from a design read and the requirements it names: three
   * documented steps with one label each, O1/O3 with one exact value and O2 with none, each
   * outcome mapped to its own live criterion, O2's criterion text as stored, the live scenarios
   * and tests to replace. Null (with the reason) when the design does not allow it.
   */
  private async evolveInputsFrom(t: string, cid: string, snap: DesignSnapshot, useCase: string, why: { reason: string }): Promise<EvolveInputs | null> {
    const no = (r: string) => {
      why.reason = r;
      return null;
    };
    const c = await this.context(t, cid);
    if (!c || c.snap.snapshot !== snap.snapshot) return no('the design read changed while the evolve was being prepared.');
    const req = c.requirements;
    if (req.steps.length !== 3 || req.steps.some((x) => x.labels.length !== 1)) return no('the requirements do not have exactly three documented steps with one label each.');
    const out = (item: string) => req.outcomes.find((o) => o.item === item);
    const o1 = out('O1');
    const o2 = out('O2');
    const o3 = out('O3');
    if (req.outcomes.length !== 3 || !o1 || !o2 || !o3 || o1.labels.length !== 1 || o2.labels.length !== 0 || o3.labels.length !== 1) return no('the requirements do not have the three documented outcomes this evolve is written for.');
    const mapped = (item: string) => c.ev.mapping.entries.find((m) => m.outcome === item);
    const m1 = mapped('O1');
    const m2 = mapped('O2');
    const m3 = mapped('O3');
    if (!c.ev.mapping.ok || !m1?.acSlug || !m2?.acSlug || !m3?.acSlug) return no(`each documented outcome must map to exactly one live criterion first (${c.ev.mapping.problems.join(' ') || 'no mapping'}).`);
    const o2Criterion = snap.acs.find((x) => x.cid === m2.acCid);
    if (!o2Criterion?.text) return no("O2's criterion has no text in the store.");
    const scenarios = snap.scenarios.map((x) => x.slug).filter((x): x is string => !!x);
    const tests = snap.tests.map((x) => x.slug).filter((x): x is string => !!x);
    if (scenarios.length !== snap.scenarios.length || tests.length !== snap.tests.length) return no('a live scenario or test has no short id.');
    return {
      useCase,
      steps: [req.steps[0].labels[0], req.steps[1].labels[0], req.steps[2].labels[0]],
      o1: { text: o1.text, label: o1.labels[0], criterion: m1.acSlug },
      o2: { text: o2.text, criterion: m2.acSlug, criterionText: o2Criterion.text },
      o3: { text: o3.text, label: o3.labels[0], criterion: m3.acSlug },
      replace: { scenarios, tests },
    };
  }

  /**
   * The corrective evolve's inputs and what it must keep, from a design read and KaneVerity's
   * recording decisions (section 13.13). Every live test must have a current recording decision:
   * a rejection (to replace) or an approval with its proof (to keep, exactly). Null with the
   * reason when the design does not allow it.
   */
  private async correctiveFrom(t: string, cid: string, snap: DesignSnapshot, useCase: string, why: { reason: string }): Promise<{ inputs: CorrectiveInputs; keep: CorrectiveKeep } | null> {
    const no = (r: string) => {
      why.reason = r;
      return null;
    };
    const r = await this.readinessFor(t, cid);
    if (!r || r.snap.snapshot !== snap.snapshot) return no('the design read changed while the corrective evolve was being prepared.');
    const req = r.requirements;
    if (req.steps.length !== 3 || req.steps.some((x) => x.labels.length !== 1)) return no('the requirements do not have exactly three documented steps with one label each.');
    if ([...snap.acs, ...snap.scenarios, ...snap.tests].some((x) => !x.slug) || snap.tests.some((x) => !x.file || !x.recording?.exists)) return no('a live item has no short id, or a live test has no file or recording.');
    const replace: CorrectiveInputs['replace'] = [];
    const kept: TestItem[] = [];
    for (const x of snap.tests) {
      const rec = r.recordings.find((y) => y.testCid === x.cid)!;
      if (rec.status.state === 'rejected' && !rec.status.stale) {
        const o = r.ev.outcomes.find((y) => y.testCid === x.cid);
        const sc = snap.scenarios.find((s) => x.automates.includes(s.cid));
        const ro = o ? req.outcomes.find((q) => q.item === o.outcome) : undefined;
        if (!o?.acSlug || !sc?.slug || !ro) return no(`the rejected test ${x.slug} is not tied to exactly one outcome, criterion and scenario.`);
        const requirement = requirementFor(ro.text, ro.labels);
        if (requirement !== 'baseline_change' && ro.labels.length !== 1) return no(`${ro.item} needs exactly one documented value.`);
        replace.push({ test: x.slug!, scenario: sc.slug, outcome: o.outcome, criterion: o.acSlug, requirement, label: requirement === 'baseline_change' ? null : ro.labels[0] });
      } else if (rec.ok) kept.push(x);
      else return no(`every test needs a current recording decision first: ${x.slug} is ${rec.reason || rec.status.state} (approve the recordings to keep, reject the ones to replace).`);
    }
    if (!replace.length) return no('no recording is rejected, so there is nothing to correct.');
    if (!kept.length) return no('no test has an approved recording to keep; a corrective evolve keeps at least one test as it is.');
    replace.sort((a, b) => a.test.localeCompare(b.test));
    const pick = (xs: { slug: string | null; cid: string }[]) => xs.map((x) => ({ slug: x.slug!, cid: x.cid })).sort((a, b) => a.slug.localeCompare(b.slug));
    const keep: CorrectiveKeep = {
      criteria: pick(snap.acs),
      scenarios: pick(snap.scenarios),
      tests: pick(kept),
      rejected: pick(snap.tests.filter((x) => replace.some((y) => y.test === x.slug))),
      testFiles: kept.map((x) => ({ path: x.file!.path, sha256: x.file!.sha256 })).sort((a, b) => a.path.localeCompare(b.path)),
      recordings: snap.tests.map((x) => ({ testFile: x.file!.path, dir: x.recording!.dir, sha256: x.recording!.sha256 })).sort((a, b) => a.dir.localeCompare(b.dir)),
    };
    const inputs: CorrectiveInputs = { useCase, steps: [req.steps[0].labels[0], req.steps[1].labels[0], req.steps[2].labels[0]], replace, keep: { criteria: keep.criteria.map((x) => x.slug), scenarios: keep.scenarios.map((x) => x.slug), tests: keep.tests.map((x) => x.slug) } };
    return { inputs, keep };
  }

  /** The tests the recording review rejected (current decisions), from the latest design read; no Kane read. */
  private async rejectedRecordings(t: string, cid: string): Promise<string[]> {
    const r = await this.readinessFor(t, cid);
    if (!r) return [];
    return r.recordings.filter((x) => x.status.state === 'rejected' && !x.status.stale).map((x) => x.slug!).filter(Boolean).sort();
  }

  /**
   * The last check before Kane is spawned for an evolve (called by the job runner after the design
   * preflight). Fails closed; never changes the job:
   * - the job equals its record on disk (parameters and arguments);
   * - its arguments are exactly what buildArgs makes from its parameters (instruction and
   *   acknowledgement included);
   * - the store on disk still ends at the design read's tip with the same records and passes its
   *   hash chain, the requirements are intact and the same, and the instruction rebuilt from that
   *   read is the stored one (same use case, same inputs);
   * - what the evolve must not change was fingerprinted before it started, with no problem.
   */
  private async evolveSpawnCheck(j: JobRecord): Promise<string | null> {
    const p = j.params;
    if (p.kind !== 'evolve' || !j.tutorialId || j.tutorialId !== p.tutorialId) return 'the job is not an evolve of a tutorial.';
    const disk = await readJson<JobRecord>(dataPath('assurance', 'jobs', j.jobId, 'job.json'));
    if (!disk || canonical(disk.params) !== canonical(p) || canonical(disk.args) !== canonical(j.args) || disk.kind !== 'evolve') return 'the job record on disk does not match the job that was queued (its parameters or arguments changed).';
    let rebuilt: string[];
    try {
      rebuilt = buildArgs(p);
    } catch (err) {
      return `its arguments are not valid any more (${(err as Error).message})`;
    }
    if (canonical(rebuilt) !== canonical(j.args)) return 'its stored arguments are not exactly what its parameters give.';
    const expectedAck = p.corrective ? correctiveEvolveAcknowledgement(p.ucCid, p.corrective.inputs.replace.map((r) => r.test)) : evolveAcknowledgement(p.ucCid);
    if (p.acknowledgement !== expectedAck) return 'the acknowledgement is not the exact words for this use-case version.';
    const snap = await this.latest(p.tutorialId, p.ucCid).catch(() => null);
    if (!snap || !snap.integrity.ok) return 'there is no integrity-checked design read of this use case.';
    if (snap.ucSlug !== p.useCase) return `the design read names the use case ${snap.ucSlug ?? 'nothing'}, not ${p.useCase}.`;
    const storeDir = path.join(config.assurance.workspaceDir, '.context');
    const graph = await readDesignGraph(storeDir, snap.store.tipHash);
    if (graph.problems.length || graph.records.length !== snap.store.records) return `the store changed since the design read (${graph.problems[0] ?? `${graph.records.length} records, ${snap.store.records} read`}).`;
    const req = snap.requirements ? await readVersion(p.tutorialId, snap.requirements.version) : null;
    if (!req || !req.intact || req.meta.reqSha256 !== snap.requirements!.reqSha256) return 'the requirements the design read names are not intact and the same.';
    const why = { reason: '' };
    const inputs = await this.evolveInputsFrom(p.tutorialId, p.ucCid, snap, p.useCase, why);
    if (!inputs) return why.reason;
    if (canonical(inputs) !== canonical(p.inputs)) return 'the instruction inputs from a fresh read of the store differ from the stored ones.';
    let fresh: string;
    try {
      if (p.corrective) {
        // The corrective evolve: its inputs and what it must keep, rebuilt from this read and the
        // recording decisions, must be exactly the stored ones (same tests, ids, files, recordings).
        const again = await this.correctiveFrom(p.tutorialId, p.ucCid, snap, p.useCase, why);
        if (!again) return why.reason;
        if (canonical(again) !== canonical(p.corrective)) return 'what the corrective evolve replaces or keeps, rebuilt from a fresh read, differs from the stored one.';
        fresh = correctiveEvolveInstruction(again.inputs);
      } else fresh = evolveInstruction(inputs);
    } catch (err) {
      return (err as Error).message;
    }
    if (fresh !== p.instruction) return 'the instruction rebuilt from a fresh read differs from the stored one.';
    if (!p.scope) return 'what the evolve must not change was not fingerprinted.';
    if (p.scope.problems?.length) return `what the evolve must not change could not be fingerprinted cleanly (${p.scope.problems[0]}).`;
    return null;
  }

  /** Fingerprints of what an evolve may not change: existing store records, requirements (KaneVerity's and the workspace copy), the documentation, existing test files. */
  private async scopePrint(): Promise<EvolveScopePrint> {
    const ws = config.assurance.workspaceDir;
    const problems: string[] = [];
    const tree = async (root: string, tag: string) => {
      const r = await walkProtected(root, tag);
      problems.push(...r.problems);
      return r.files;
    };
    return {
      commits: await tree(path.join(ws, '.context', 'commits'), 'commits'),
      blobs: await tree(path.join(ws, '.context', 'blobs'), 'blobs'),
      requirements: [...(await tree(dataPath('assurance', 'requirements'), 'data/assurance/requirements')), ...(await tree(path.join(ws, 'requirements'), 'workspace/requirements'))],
      docs: await tree(config.docsContentDir, 'docs'),
      testFiles: (await walkProtected(path.join(ws, '.testmuai', 'tests'), '.testmuai/tests').then((r) => (problems.push(...r.problems), r.files))).sort((x, y) => x.path.localeCompare(y.path)),
      problems,
    };
  }

  /** After an evolve ends: what it changed that it must not have. Recorded once per job, append-only. */
  private async checkEvolve(j: JobRecord, late: boolean): Promise<void> {
    const p = j.params;
    if (p.kind !== 'evolve' || !j.tutorialId) return;
    const t = j.tutorialId;
    await this.serial(`evolve-check:${t}`, async () => {
      if ((await this.log(t)).evolveChecks.some((c) => c.jobId === j.jobId)) return;
      const problems: string[] = [];
      if (!p.scope) problems.push('no fingerprint was taken before it started.');
      else {
        const now = await this.scopePrint();
        const cmp = (label: string, before: { path: string; sha256: string }[], after: { path: string; sha256: string }[], allowNew: boolean) => {
          const at = new Map(after.map((x) => [x.path, x.sha256]));
          for (const x of before) {
            const n = at.get(x.path);
            if (n === undefined) problems.push(`${label} ${x.path} is gone.`);
            else if (n !== x.sha256) problems.push(`${label} ${x.path} was changed.`);
          }
          if (!allowNew) {
            const was = new Set(before.map((x) => x.path));
            for (const x of after) if (!was.has(x.path)) problems.push(`${label} ${x.path} was added.`);
          }
        };
        // New store records, blobs and test files are what a design writes; nothing else may change.
        for (const x of now.problems ?? []) problems.push(`After the run: ${x}`);
        if (p.scope.problems?.length) for (const x of p.scope.problems) problems.push(`Before the run: ${x}`);
        if (!p.scope.blobs) problems.push('the store blobs were not fingerprinted before it started.');
        cmp('Store record', p.scope.commits, now.commits, true);
        cmp('Store blob', p.scope.blobs ?? [], now.blobs ?? [], true);
        cmp('Requirements file', p.scope.requirements, now.requirements, false);
        cmp('Documentation file', p.scope.docs, now.docs, false);
        cmp('Test file', p.scope.testFiles, now.testFiles, true);
      }
      if (p.corrective) {
        // The corrective evolve keeps exactly what it said: every recording as it was (the rejected
        // ones are preserved too), the kept items live with the same content ids, and the rejected
        // tests superseded. Kept test files are covered above (no existing test file may change).
        const k = p.corrective.keep;
        const ws = config.assurance.workspaceDir;
        for (const r of k.recordings) {
          const now = await recordingTree(ws, r.testFile).catch(() => null);
          if (!now || now.dir !== r.dir || !now.exists || now.staging || now.sha256 !== r.sha256) problems.push(`The recording ${r.dir} changed; a corrective evolve keeps every recording as it is.`);
        }
        for (const f of k.testFiles) if (!(p.scope?.testFiles ?? []).some((x) => x.path === f.path && x.sha256 === f.sha256)) problems.push(`The kept test file ${f.path} was not fingerprinted before the run.`);
        const g = await readDesignGraph(path.join(ws, '.context'), null);
        // Without Kane's view, only the last record's full hash is unknown (the next design read
        // establishes it through `context view`); every other problem counts.
        const tipOnly = `The full hash of record ${g.records.length} could not be established.`;
        for (const x of g.problems) if (x !== tipOnly) problems.push(`The store after the run: ${x}`);
        for (const x of [...k.criteria, ...k.scenarios, ...k.tests]) {
          if (!g.nodes.has(x.cid)) problems.push(`${x.slug} (${x.cid.slice(0, 19)}…) is not in the store after the run.`);
          else if (g.supersededNodes.has(x.cid)) problems.push(`${x.slug} was superseded, but the corrective evolve had to keep it exactly as it is.`);
        }
        for (const x of k.rejected) if (!g.supersededNodes.has(x.cid)) problems.push(`${x.slug} was not replaced.`);
      }
      await this.appendTo(t, 'evolveChecks', { jobId: j.jobId, at: new Date().toISOString(), jobState: j.state, late, problems });
    });
  }

  /** The latest evolve of this use case that Kane ran, with its check (null: none). */
  private async evolveScopeFor(t: string, cid: string): Promise<DesignSnapshot['evolveScope']> {
    // Every evolve Kane ran for this use case (the one evolve and, if any, the corrective one): each
    // must have been checked, and any problem in any of them blocks the design.
    const jobs = await this.jobs.list(t);
    const used = [usedEvolve(jobs, cid), usedCorrectiveEvolve(jobs, cid)].filter((x): x is JobRecord => !!x);
    if (!used.length) return null;
    const out = { jobId: used[used.length - 1].jobId, checked: true, late: false, problems: [] as string[] };
    for (const u of used) {
      // Wait for this process's own end-of-run check if it is still running; if the evolve has ended
      // and no check was ever recorded (it failed, or the orchestrator stopped first), record one now,
      // marked late (same lock and once-per-job guard as the start-up recovery).
      await this.updating.get(u.jobId);
      if (u.state !== 'queued' && u.state !== 'running' && !(await this.log(t)).evolveChecks.some((x) => x.jobId === u.jobId)) await this.checkEvolve(u, true);
      const c = (await this.log(t)).evolveChecks.filter((x) => x.jobId === u.jobId).pop();
      if (!c) out.checked = false;
      if (c?.late) out.late = true;
      for (const p of c?.problems ?? []) out.problems.push(u.jobId === out.jobId ? p : `(job ${u.jobId}) ${p}`);
    }
    return out;
  }

  /**
   * The content ids a corrective evolve kept from an earlier generation (section 13.13): only when
   * it ended, was checked, and its check found no problem. B5 then accepts exactly these items as
   * live though they were made before the latest generation; nothing else is exempted.
   */
  private async correctiveKeepFor(t: string, cid: string): Promise<string[] | null> {
    const c = usedCorrectiveEvolve(await this.jobs.list(t), cid);
    if (!c || c.params.kind !== 'evolve' || !c.params.corrective || c.state !== 'complete') return null;
    const check = (await this.log(t)).evolveChecks.filter((x) => x.jobId === c.jobId).pop();
    if (!check || check.problems.length) return null;
    const k = c.params.corrective.keep;
    return [...k.criteria, ...k.scenarios, ...k.tests].map((x) => x.cid);
  }

  /** A free dry run of the approved tests' exact files (fresh design read first). */
  async dryRun(tutorialId: unknown, ucHex: unknown): Promise<DryRunEntry> {
    const { t, cid } = this.params(tutorialId, ucHex);
    return this.serial(`design:${t}`, async () => {
      const reviewer = reviewerSetting();
      if (!reviewer.label) throw new AssuranceError(409, reviewer.problem ?? 'No reviewer is set.');
      if (config.assurance.mode === 'off') throw new AssuranceError(403, 'Kane Assurance commands are switched off.');
      const busy = await this.busy(t);
      if (busy) throw new AssuranceError(409, busy);
      const fresh = await this.retrieveLocked(t, cid);
      const c = (await this.context(t, cid))!;
      if (!fresh.integrity.ok) throw new AssuranceError(409, 'The design read failed its integrity checks. Nothing was planned.');
      if (!c.ev.files.ok || fresh.tests.some((x) => !x.file)) throw new AssuranceError(409, `The test files are not exactly the tests Kane stored: ${c.ev.files.problems.join(' ')}`);
      const files = fresh.tests.map((x) => x.file!.path).sort();
      const binding = dryRunBinding(fresh);
      const base: DryRunEntry = { id: newId(), at: new Date().toISOString(), jobId: null, state: 'unknown', reason: '', files, unresolved: [], binding, bindingSha256: sha256(canonical(binding)) };
      let job: JobRecord;
      try {
        job = await this.jobs.startDryRun({ tutorialId: t, files });
      } catch (err) {
        if (err instanceof AssuranceError) throw err;
        throw new AssuranceError(400, (err as Error).message);
      }
      const done = await this.waitJob(job, config.assurance.timeoutMs + 30_000);
      const out = await readFile(jobStdoutPath(done.jobId), 'utf8').catch(() => '');
      let entry: DryRunEntry;
      if (done.state !== 'complete') entry = { ...base, jobId: done.jobId, state: done.state === 'queued' || done.state === 'running' ? 'unknown' : 'failed', reason: `The dry run did not finish normally: ${done.reason}` };
      else {
        const p = parseDryRun(out, files);
        entry = { ...base, jobId: done.jobId, state: p.ok ? 'passed' : 'failed', unresolved: p.unresolved, reason: p.ok ? 'Planned; every test file and variable resolved. Nothing ran.' : [...p.problems, p.unresolved.length ? `Unresolved variables: ${p.unresolved.join(', ')}.` : ''].filter(Boolean).join(' ') };
      }
      await this.appendTo(t, 'dryRuns', entry);
      return entry;
    });
  }

  /** Fingerprints of what a run depends on, from disk (no Kane). */
  private async diskFingerprints(files: string[], kept: string[] = []) {
    const ws = config.assurance.workspaceDir;
    const hashOf = async (f: string) => {
      const b = await readFile(path.join(ws, ...f.split('/'))).catch(() => null);
      return { path: f, sha256: b ? createHash('sha256').update(b).digest('hex') : 'missing' };
    };
    const testFiles: { path: string; sha256: string }[] = [];
    for (const f of files) testFiles.push(await hashOf(f));
    // Superseded tests' files Kane kept (never run): fingerprinted so a change is seen.
    const supersededFiles: { path: string; sha256: string }[] = [];
    for (const f of kept) supersededFiles.push(await hashOf(f));
    const varDir = path.join(ws, '.testmuai', 'variables');
    const variables: { name: string; sha256: string }[] = [];
    for (const name of (await readdir(varDir).catch(() => [] as string[])).filter((n) => n.endsWith('.json')).sort()) {
      const b = await readFile(path.join(varDir, name)).catch(() => null);
      if (b) variables.push({ name, sha256: createHash('sha256').update(b).digest('hex') });
    }
    const allTests = (await findTestFiles(ws)).map((p) => path.relative(ws, p).split(path.sep).join('/')).sort();
    const recordings = await Promise.all(files.map(async (p) => {
      const r = await recordingTree(ws, p);
      return { path: r.dir, sha256: r.sha256, exists: r.exists, staging: r.staging };
    }));
    return { testFiles, supersededFiles, variables, allTests, recordings };
  }

  private async evidenceFiles(): Promise<string[]> {
    const dir = path.join(config.assurance.workspaceDir, '.testmuai', 'evidence');
    return (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.evidence')).sort();
  }

  /**
   * Run the approved tests (paid). Every pre-execution gate is re-checked on a fresh read
   * first, and again (by fingerprint) right before Kane starts. Never retried.
   */
  async execute(tutorialId: unknown, ucHex: unknown, body: unknown): Promise<ExecutionEntry> {
    const { t, cid } = this.params(tutorialId, ucHex);
    const b = (body && typeof body === 'object' ? body : {}) as { confirm?: unknown; phase?: unknown };
    if (b.phase !== 'authoring' && b.phase !== 'verification') throw new AssuranceError(400, 'phase must be "authoring" (Kane records the approved tests) or "verification" (a pure replay of the approved recordings).');
    const phase = b.phase;
    // Checked before any Kane read, so a refused request costs nothing.
    if (config.assurance.mode !== 'all') throw new AssuranceError(403, 'Running the tests uses Kane credits, so it needs Assurance mode "all". Nothing was started.');
    const paidOk = !!b.confirm && typeof b.confirm === 'object' && (b.confirm as { paid?: unknown }).paid === true;
    if (!paidOk) throw new AssuranceError(400, 'Running the tests uses Kane credits. Confirm it explicitly ({"confirm": {"paid": true}}).');
    // An authoring run is bound to the exact tests the person confirmed (the page's list, from the
    // view's authoringPlan): their content ids, each once, in any order. Checked here for shape, and
    // against the backend's own fresh selection right before the run is recorded and Kane starts.
    let confirmedTests: string[] | null = null;
    if (phase === 'authoring') {
      const ct = (b.confirm as { tests?: unknown }).tests;
      if (!Array.isArray(ct) || ct.length > 20 || ct.some((x) => typeof x !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(x)) || new Set(ct).size !== ct.length) throw new AssuranceError(400, 'An authoring run needs the exact tests you confirmed: {"confirm": {"paid": true, "tests": ["<test content id>", ...]}}, each once, as the page lists them. Nothing was started.');
      confirmedTests = ct as string[];
    }
    const reviewer = reviewerSetting();
    if (!reviewer.label) throw new AssuranceError(409, reviewer.problem ?? 'No reviewer is set.');
    return this.serial(`design:${t}`, async () => {
      const busy = await this.busy(t);
      if (busy) throw new AssuranceError(409, `Not started: ${busy}`);
      // First against the latest design read, which is what the page's list came from: a changed
      // selection is refused before any Kane process starts (not even the free reads below).
      if (phase === 'authoring' && confirmedTests) {
        const shown = await this.readinessFor(t, cid);
        if (shown) {
          const sel = authoringSelection(shown.snap.tests, shown.recordings);
          const conflict = sel.refusal ? null : selectionConflict(shown.snap.tests, sel.tests, confirmedTests);
          if (conflict) throw new AssuranceError(409, `Not started (authoring): ${conflict}`);
        }
      }
      await this.retrieveLocked(t, cid);
      const r = (await this.readinessFor(t, cid))!;
      const gates = phase === 'verification' ? r.verificationReadiness : r.readiness;
      if (!gates.ready) throw new AssuranceError(409, `Not started (${phase}): ${gates.items.filter((x) => !x.ok).map((x) => `${x.label}: ${x.reason}`).join(' | ')}`);
      const { snap, ev } = r;
      // Which tests Kane runs: a verification always replays every approved test; an authoring run
      // records only the tests without an approved, current recording (one approved and kept is
      // never recorded again). Every live test is still fingerprinted before and after the run.
      const selection = authoringSelection(snap.tests, r.recordings);
      if (phase === 'authoring' && selection.refusal) throw new AssuranceError(409, `Not started (authoring): ${selection.refusal}`);
      // The confirmation must name exactly the tests this run would record now (order does not matter).
      if (phase === 'authoring' && confirmedTests) {
        const conflict = selectionConflict(snap.tests, selection.tests, confirmedTests);
        if (conflict) throw new AssuranceError(409, `Not started (authoring): ${conflict}`);
      }
      const runTests = phase === 'verification' ? snap.tests : selection.tests;
      const runCids = new Set(runTests.map((x) => x.cid));
      const targets: ExecutionTarget[] = ev.outcomes.filter((o) => runCids.has(o.testCid!)).map((o) => {
        const tst = snap.tests.find((x) => x.cid === o.testCid)!;
        const req = r.requirements.outcomes.find((x) => x.item === o.outcome)!;
        return { outcome: o.outcome, outcomeText: o.outcomeText, labels: req.labels, acCid: o.acCid!, acSlug: o.acSlug!, testCid: tst.cid, testSlug: tst.slug ?? '', definitionId: tst.definitionId ?? '', requirement: requirementFor(o.outcomeText, req.labels) };
      });
      const files = snap.tests.map((x) => x.file!.path).sort();
      const runFiles = runTests.map((x) => x.file!.path).sort();
      if (targets.length !== runTests.length) throw new AssuranceError(409, 'Not started: the tests to run and the documented outcomes they verify are not one-to-one.');
      const kept = (snap.supersededTestFiles ?? []).map((f) => f.path).sort();
      const disk = await this.diskFingerprints(files, kept);
      for (const f of snap.supersededTestFiles ?? []) if (disk.supersededFiles.find((d) => d.path === f.path)?.sha256 !== f.sha256) throw new AssuranceError(409, `Not started: the superseded test file ${f.path} changed since the checks. Read the design again.`);
      const pre: ExecutionEntry['pre'] = { testFiles: disk.testFiles, runFiles, supersededFiles: disk.supersededFiles, variables: disk.variables, recordings: disk.recordings, storeRecords: snap.store.records, storeTip: snap.store.tipHash, evidenceFiles: await this.evidenceFiles(), designSnapshot: snap.snapshot };
      // A verification run replays exactly the approved recordings, unchanged since the design read.
      if (phase === 'verification') for (const rec of disk.recordings) if (!rec.exists || rec.staging || !snap.tests.some((x) => x.recording?.dir === rec.path && x.recording.sha256 === rec.sha256)) throw new AssuranceError(409, `Not started: the recording ${rec.path} is missing or changed since the checks.`);
      const readinessSha256 = sha256(canonical({ phase, pre: { ...pre, evidenceFiles: undefined }, targets, decisions: r.statuses.map((s) => s.status.entryId), writes: r.kaneApprovals.map((k) => k.write?.writeId ?? null), dryRun: r.dryRun.latest?.id ?? null }));
      const started: ExecutionEntry = { executionId: newExecutionId(), phase, jobId: null, at: new Date().toISOString(), state: 'started', reason: phase === 'authoring' ? `Starting the authoring run of ${runTests.map((x) => x.slug).join(', ')} (Kane records the steps; this run cannot verify anything).` : 'Starting the verification run (a pure replay of the approved recordings).', reviewer: reviewer.label!, readinessSha256, targets, pre, result: null, by: 'kaneverity-design-review' };
      this.guard();
      await this.appendTo(t, 'executions', started);
      let job: JobRecord;
      try {
        job = await this.jobs.startTestRun({ tutorialId: t, ucCid: cid, files: runFiles, reviewer: reviewer.label!, readinessSha256, requirements: snap.requirements, confirm: b.confirm });
      } catch (err) {
        const refused: ExecutionEntry = { ...started, at: new Date().toISOString(), state: 'refused', reason: `Kane was not started: ${scrub((err as Error).message)}` };
        await this.appendTo(t, 'executions', refused);
        throw err;
      }
      const running: ExecutionEntry = { ...started, jobId: job.jobId, at: new Date().toISOString(), reason: `Kane is running the tests (job ${job.jobId}).` };
      await this.appendTo(t, 'executions', running);
      return running;
    });
  }

  /** Right before Kane starts a test run: nothing it depends on may have changed (fingerprints; no Kane read). */
  private async runPreflight(j: JobRecord): Promise<string | null> {
    if (j.params.kind !== 'testrun' || !j.tutorialId) return 'this is not a design test run.';
    const p = j.params;
    let l: FullLog;
    try {
      l = await this.log(j.tutorialId);
    } catch {
      return 'the design review history cannot be read.';
    }
    const x = currentExecutions(l.executions).find((e) => e.readinessSha256 === p.readinessSha256 && e.state === 'started');
    if (!x) return 'there is no started test run bound to this job.';
    if (this.writing.has(j.tutorialId) || currentDesignWrites(l.kaneWrites).some((w) => w.state === 'pending' || w.state === 'unknown')) return 'an approval write to Kane is in progress or has an unknown outcome.';
    const disk = await this.diskFingerprints(x.pre.testFiles.map((f) => f.path), (x.pre.supersededFiles ?? []).map((f) => f.path));
    if (canonical(disk.testFiles) !== canonical(x.pre.testFiles)) return 'a test file changed since the checks.';
    if (canonical(disk.supersededFiles) !== canonical(x.pre.supersededFiles ?? [])) return 'a superseded test file changed since the checks.';
    if (canonical(disk.variables) !== canonical(x.pre.variables)) return 'a variables file changed since the checks.';
    if (canonical(disk.allTests) !== canonical([...x.pre.testFiles.map((f) => f.path), ...(x.pre.supersededFiles ?? []).map((f) => f.path)].sort())) return 'the set of test files in the workspace changed (a run could select a file that was not checked).';
    if (canonical(disk.recordings) !== canonical(x.pre.recordings)) return 'a recording changed since the checks.';
    if (canonical([...p.files].sort()) !== canonical(runFilesOf(x))) return 'the test files given to Kane are not the ones the checks were made for.';
    return null;
  }

  private async onJobUpdate(id: string) {
    let j: JobRecord;
    try {
      j = await this.jobs.get(id);
    } catch {
      return;
    }
    if (j.kind === 'evolve' && j.state !== 'queued' && j.state !== 'running' && j.tutorialId) {
      await this.checkEvolve(j, false).catch((err) => console.error(`[orchestrator] the evolve check of ${id} failed: ${(err as Error).message}`));
      return;
    }
    if (j.kind !== 'testrun' || j.state === 'queued' || j.state === 'running' || !j.tutorialId || this.finishing.has(id)) return;
    this.finishing.add(id);
    const t = j.tutorialId;
    try {
      await this.serial(`design:${t}`, async () => {
        const x = currentExecutions((await this.log(t)).executions).find((e) => e.jobId === id);
        if (!x || x.state !== 'started') return;
        const p = j.params.kind === 'testrun' ? j.params : null;
        if (!p) return;
        if (j.state === 'refused') {
          await this.appendTo(t, 'executions', { ...x, at: new Date().toISOString(), state: 'refused', reason: j.reason });
          return;
        }
        if (j.state !== 'complete') {
          await this.appendTo(t, 'executions', { ...x, at: new Date().toISOString(), state: 'unknown', reason: `The run did not finish normally (${j.reason}). Its outcome is unknown; it is never re-run automatically. Reconcile it to check what it left.` });
          return;
        }
        const result = await this.checkRun(t, x, j);
        await this.appendTo(t, 'executions', { ...x, at: new Date().toISOString(), state: 'finished', reason: executionReason(x.phase, result), result });
      });
    } finally {
      this.finishing.delete(id);
    }
  }

  /** Post-execution verification: no mutation, a valid pack, and independent evidence for every outcome. */
  private async checkRun(t: string, x: ExecutionEntry, job: JobRecord | null): Promise<ExecutionResult> {
    const mutation: string[] = [];
    const problems: string[] = [];
    const ws = config.assurance.workspaceDir;
    const disk = await this.diskFingerprints(x.pre.testFiles.map((f) => f.path), (x.pre.supersededFiles ?? []).map((f) => f.path));
    for (const f of x.pre.testFiles) if (disk.testFiles.find((d) => d.path === f.path)?.sha256 !== f.sha256) mutation.push(`${f.path} changed during the run.`);
    for (const f of x.pre.supersededFiles ?? []) if (disk.supersededFiles.find((d) => d.path === f.path)?.sha256 !== f.sha256) mutation.push(`The superseded test file ${f.path} changed during the run.`);
    if (canonical(disk.allTests) !== canonical([...x.pre.testFiles.map((f) => f.path), ...(x.pre.supersededFiles ?? []).map((f) => f.path)].sort())) mutation.push('Test files were added or removed during the run.');
    if (canonical(disk.variables) !== canonical(x.pre.variables)) mutation.push('A variables file changed during the run.');
    // A verification run is a pure replay: the approved recordings must be exactly as before.
    if (x.phase === 'verification') for (const rec of x.pre.recordings) {
      const now = disk.recordings.find((d) => d.path === rec.path);
      if (!now || now.sha256 !== rec.sha256 || now.staging) mutation.push(`The recording ${rec.path} changed during the run (Kane re-recorded steps).`);
    }
    // An authoring run of some tests leaves every other test's recording exactly as it was.
    const runFiles = runFilesOf(x);
    x.pre.testFiles.forEach((f, i) => {
      if (runFiles.includes(f.path)) return;
      const before = x.pre.recordings[i];
      const now = disk.recordings[i];
      if (!before || !now || canonical(before) !== canonical(now)) mutation.push(`The recording ${before?.path ?? now?.path ?? f.path} changed during the run, though its test was not in the run.`);
    });
    // The store: only execution records may be added, chained to the tip the run started from.
    const commits = (await readdir(path.join(ws, '.context', 'commits')).catch(() => [] as string[])).filter((f) => /^[0-9]{6}-[a-f0-9]{12}\.json$/.test(f)).sort();
    if (commits.length < x.pre.storeRecords) mutation.push('Records disappeared from the store.');
    for (const f of commits.slice(x.pre.storeRecords)) {
      try {
        const c = JSON.parse(await readFile(path.join(ws, '.context', 'commits', f), 'utf8')) as Record<string, unknown>;
        const empty = (k: string) => !Array.isArray(c[k]) || (c[k] as unknown[]).length === 0;
        if (c.intent_verb !== 'execution' || !empty('nodes') || !empty('supersessions') || !empty('review')) mutation.push(`Record ${f.slice(0, 6)} is not an execution record (${String(c.intent_verb)}): the run changed the design.`);
      } catch {
        mutation.push(`Record ${f} cannot be read.`);
      }
    }
    // Kane's structured output names the combined pack and every per-test pack (Kane 0.10.5
    // writes one pack per test plus one combined pack). The pack is never guessed from the folder.
    const files = runFiles;
    const evDir = path.join(ws, '.testmuai', 'evidence');
    let stdout: string | null = null;
    if (!job || job.jobId !== x.jobId) problems.push('The run has no job record bound to it.');
    else {
      stdout = await readFile(jobStdoutPath(job.jobId), 'utf8').catch(() => null);
      if (stdout === null) problems.push("Kane's saved output for this run cannot be read.");
    }
    const outputSha256 = stdout === null ? null : createHash('sha256').update(stdout).digest('hex');
    const report = stdout === null ? null : parseTestrunOutput(stdout, { workspaceDir: ws, files });
    if (report) problems.push(...report.problems);
    const after = await this.evidenceFiles();
    const added = after.filter((n) => !x.pre.evidenceFiles.includes(n));
    const packs: NonNullable<ExecutionResult['packs']> = [];
    let verification: PackVerification | null = null;
    let evidenceFile: string | null = null;
    let manifest: ReturnType<typeof readPackManifest> | null = null;
    if (report?.ok && job) {
      const before = problems.length;
      const expected = [report.packFile!, ...report.testPacks];
      for (const n of expected) if (!added.includes(n)) problems.push(x.pre.evidenceFiles.includes(n) ? `The evidence pack ${n} that Kane reported existed before the run.` : `The evidence pack ${n} that Kane reported is not in the evidence folder.`);
      for (const n of added) if (!expected.includes(n)) problems.push(`The run left an evidence pack Kane did not report (${n}).`);
      // Every pack was written while this run's job ran (not before it started, not after it ended).
      const from = Date.parse(job.startedAt ?? '') - 2000;
      const to = (job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) + 2000;
      let combined: Buffer | null = null;
      for (const n of expected.filter((e) => added.includes(e))) {
        const s = await stat(path.join(evDir, n)).catch(() => null);
        const b = s?.isFile() ? await readFile(path.join(evDir, n)).catch(() => null) : null;
        if (!s || !b) {
          problems.push(`The evidence pack ${n} cannot be read.`);
          continue;
        }
        if (!(s.mtimeMs >= from && s.mtimeMs <= to)) problems.push(`The evidence pack ${n} was not written during this run's job.`);
        packs.push({ name: n, role: n === report.packFile ? 'combined' : 'test', sha256: createHash('sha256').update(b).digest('hex'), bytes: b.length });
        if (n === report.packFile) combined = b;
      }
      const origin = await this.appOrigin();
      if (problems.length === before && (!combined || !origin)) problems.push('The evidence pack or the project URL cannot be read.');
      if (problems.length === before && combined && origin) {
        // The combined pack itself: Kane's run id, exactly the per-test packs it was merged from,
        // and exactly one member per approved test (by definition id).
        manifest = readPackManifest(combined);
        problems.push(...manifest.problems);
        if (manifest.runId !== report.evidenceId) problems.push('The combined pack does not carry the run id Kane reported (run.yaml run_id).');
        const merged = [...(manifest.mergedFrom ?? [])].sort();
        const reported = report.testPacks.map((n) => n.replace(/\.evidence$/, '')).sort();
        if (JSON.stringify(merged) !== JSON.stringify(reported)) problems.push(reported.length ? 'The combined pack was not merged from exactly the per-test packs Kane reported (run.yaml merged_from).' : 'The pack lists packs it was merged from, but Kane reported no per-test packs.');
        for (const tg of x.targets) {
          const n = manifest.members.filter((m) => m.definitionId === tg.definitionId).length;
          if (n !== 1) problems.push(n === 0 ? `The combined pack has no member for test ${tg.testSlug}.` : `The combined pack has ${n} members for test ${tg.testSlug}.`);
        }
        if (manifest.members.some((m) => !x.targets.some((tg) => tg.definitionId === m.definitionId))) problems.push('The combined pack has a member that is not one of the approved tests.');
        if (manifest.members.length !== x.targets.length) problems.push(`The combined pack has ${manifest.members.length} members; ${x.targets.length} tests were approved.`);
        if (problems.length === before) {
          evidenceFile = report.packFile;
          verification = verifyPack(combined, { appOrigin: origin, pinnedVersion: config.assurance.pinnedVersion, targets: x.targets, requireReplay: x.phase === 'verification' });
        }
      }
    }

    // Each approved test, end to end: the design read's test file, Kane's member, its per-test
    // pack, its recording (same order as the files) and its member in the combined pack.
    const members: ExecutionMember[] = [];
    const snap = await readJson<DesignSnapshot>(path.join(snapDir(t), `snapshot-${pad(x.pre.designSnapshot)}.json`)).catch(() => null);
    if (!snap) problems.push('The design read this run was checked against cannot be read.');
    else {
      for (const tg of x.targets) {
        const test = snap.tests.find((s) => s.cid === tg.testCid);
        const file = test?.file?.path ?? null;
        const i = file && files.includes(file) ? x.pre.testFiles.findIndex((f) => f.path === file) : -1;
        if (!test || !file || i < 0) {
          problems.push(`Test ${tg.testSlug} is not one of the files this run was given.`);
          continue;
        }
        if (test.file!.sha256 !== x.pre.testFiles[i].sha256) problems.push(`Test ${tg.testSlug}'s file is not the one the design read checked.`);
        const km = report?.ok ? report.members.find((m) => m.path === file) ?? null : null;
        const pm = manifest?.members.filter((m) => m.definitionId === tg.definitionId) ?? [];
        members.push({ outcome: tg.outcome, testSlug: tg.testSlug, testCid: tg.testCid, testFile: file, kaneTestId: km?.testId ?? null, kaneStatus: km?.status ?? null, durationS: km?.durationS ?? null, testPack: km?.sourcePack ?? null, packMember: pm.length === 1 ? pm[0].name : null, packMemberStatus: pm.length === 1 ? pm[0].status : null, recording: disk.recordings[i] });
      }
      if (new Set(members.map((m) => m.testFile)).size !== members.length || members.length !== files.length || new Set(x.targets.map((tg) => tg.testCid)).size !== x.targets.length) problems.push('The approved tests and the files this run was given are not one-to-one.');
    }

    // Kane's own result: every test passed, nothing failed or broke.
    const passed = !!report?.ok && report.overallStatus === 'passed' && !!report.totals && report.totals.failed === 0 && report.totals.broken === 0 && report.members.every((m) => m.status === 'passed') && members.length > 0 && members.every((m) => m.packMemberStatus === 'passed');
    if (report?.ok && !passed && evidenceFile) problems.push(`Kane did not report every test as passed (overall status: ${report.overallStatus ?? 'missing'}).`);
    const clean = mutation.length === 0 && problems.length === 0;
    let verdict: ExecutionResult['verdict'];
    if (x.phase === 'authoring') {
      // An authoring run never verifies. It is AUTHORED only if it left a complete recording per test.
      x.pre.testFiles.forEach((f, i) => {
        const rec = disk.recordings[i];
        if (runFiles.includes(f.path) && (!rec || !rec.exists || rec.staging)) problems.push(`No complete recording at ${rec?.path ?? f.path} after the authoring run.`);
      });
      verdict = clean && problems.length === 0 && passed && !!verification?.packOk ? 'AUTHORED' : 'NOT_VERIFIED';
    } else verdict = clean && passed && !!verification?.verified && verification.runKind === 'replay' ? 'VERIFIED' : 'NOT_VERIFIED';
    return { verdict, mutation, evidenceFile, verification, problems, recordings: disk.recordings, checker: RUN_CHECKER_VERSION, packs, members, kaneRun: report?.ok ? { overallStatus: report.overallStatus, totals: report.totals } : null, outputSha256 };
  }

  /** Why a run cannot be re-checked now (cheap checks only), or null when it can. */
  private async recheckBlock(t: string, x: ExecutionEntry, execs: ExecutionEntry[]): Promise<string | null> {
    if (execs[execs.length - 1]?.executionId !== x.executionId) return 'Only the latest run can be re-checked.';
    if ((x.state !== 'finished' && x.state !== 'rechecked') || !x.result) return 'Only a finished run with a result can be re-checked.';
    // A VERIFIED result is never re-checked. An AUTHORED one may be, by a newer checker: version 3
    // is the first that reads Kane 0.10.5's real result.yaml, so an earlier AUTHORED result has no
    // usable outcome evidence for the recording review (its re-check can only confirm or fail it).
    if (x.result.verdict === 'VERIFIED') return 'This run is already VERIFIED.';
    if (x.result.verdict === 'AUTHORED' && x.phase !== 'authoring') return 'Only an authoring run can be AUTHORED.';
    const v = x.result.checker ?? 1;
    if (v >= RUN_CHECKER_VERSION) return `This run's evidence was already checked by the current checker (version ${v}). A re-check needs a newer checker version.`;
    if (!x.jobId) return 'The run has no job.';
    const job = await this.jobs.get(x.jobId).catch(() => null);
    if (!job) return "The run's job record cannot be read.";
    if (job.kind !== 'testrun' || job.state !== 'complete' || (job.exitCode !== 0 && job.exitCode !== 1)) return `The run's job did not complete normally (${job.state}, exit ${job.exitCode ?? 'none'}).`;
    const busy = await this.busy(t);
    if (busy) return busy;
    return null;
  }

  /**
   * Check a finished run's evidence again with a newer checker version. Kane is not run and the
   * job is not changed: it reads the job's saved output, the packs it left and the recordings,
   * bound to the fingerprints saved when the run was checked. Allowed once per checker version.
   * Refused, with nothing recorded, when anything the run left or depended on has changed.
   */
  async recheckExecution(tutorialId: unknown, ucHex: unknown, executionId: unknown): Promise<ExecutionEntry> {
    const { t } = this.params(tutorialId, ucHex);
    if (typeof executionId !== 'string' || !/^x[0-9]{8}-[0-9]{6}-[a-f0-9]{6}$/.test(executionId)) throw new AssuranceError(404, 'Test run not found.');
    const reviewer = reviewerSetting();
    if (!reviewer.label) throw new AssuranceError(409, reviewer.problem ?? 'No reviewer is set.');
    return this.serial(`design:${t}`, async () => {
      const execs = currentExecutions((await this.log(t)).executions);
      const x = execs.find((e) => e.executionId === executionId);
      if (!x) throw new AssuranceError(404, 'Test run not found.');
      const block = await this.recheckBlock(t, x, execs);
      if (block) throw new AssuranceError(409, `Not re-checked: ${block}`);
      const job = (await this.jobs.get(x.jobId!))!;
      const prior = x.result!;
      const result = await this.checkRun(t, x, job);
      // Bound to what was saved when the run was checked: nothing it left may have changed.
      const drift: string[] = [...result.mutation];
      if (canonical(result.recordings) !== canonical(prior.recordings)) drift.push('A recording changed since the run was checked.');
      if (prior.outputSha256 && result.outputSha256 !== prior.outputSha256) drift.push("Kane's saved output changed since the run was checked.");
      for (const p of prior.packs ?? []) if (result.packs?.find((q) => q.name === p.name)?.sha256 !== p.sha256) drift.push(`The evidence pack ${p.name} changed since the run was checked.`);
      if (drift.length) throw new AssuranceError(409, `Not re-checked (nothing was recorded): ${drift.join(' ')}`);
      const e: ExecutionEntry = { ...x, at: new Date().toISOString(), state: 'rechecked', reason: `Re-checked from what the run left (checker version ${RUN_CHECKER_VERSION}); Kane was not run again. ${executionReason(x.phase, result)}`, result, recheckOf: { at: x.at, state: x.state, verdict: prior.verdict, checker: prior.checker ?? 1, problems: prior.problems } };
      this.guard();
      await this.appendTo(t, 'executions', e);
      return e;
    });
  }

  /** Settle a run that ended without a known result: check what it left. It is never run again. */
  async reconcileExecution(tutorialId: unknown, ucHex: unknown, executionId: unknown): Promise<ExecutionEntry> {
    const { t } = this.params(tutorialId, ucHex);
    if (typeof executionId !== 'string' || !/^x[0-9]{8}-[0-9]{6}-[a-f0-9]{6}$/.test(executionId)) throw new AssuranceError(404, 'Test run not found.');
    return this.serial(`design:${t}`, async () => {
      const x = currentExecutions((await this.log(t)).executions).find((e) => e.executionId === executionId);
      if (!x) throw new AssuranceError(404, 'Test run not found.');
      if (x.state !== 'unknown' && x.state !== 'started') throw new AssuranceError(409, 'Only a run without a known result can be reconciled.');
      const job = x.jobId ? await this.jobs.get(x.jobId).catch(() => null) : null;
      if (job && (job.state === 'queued' || job.state === 'running')) throw new AssuranceError(409, 'Kane is still running these tests.');
      const result = await this.checkRun(t, x, job);
      // A run that did not finish normally is never VERIFIED, whatever it left.
      const final: ExecutionResult = { ...result, verdict: 'NOT_VERIFIED', problems: [...result.problems, 'The run did not finish normally, so its result cannot be accepted as VERIFIED.'] };
      const e: ExecutionEntry = { ...x, at: new Date().toISOString(), state: 'reconciled', reason: 'Reconciled: what the run left was checked. It was not run again.', result: final };
      await this.appendTo(t, 'executions', e);
      return e;
    });
  }
}
