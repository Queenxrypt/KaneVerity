// Deterministic checks of a Kane test design against the documented tutorial (B5). Pure.
//
// What these checks can and cannot prove:
// - They read the design as Kane stored it (criteria, scenarios, tests, gaps, links,
//   the generated test files) and compare it with the requirements KaneVerity
//   generated from the documentation (S1-Sn steps, O1-On outcomes, exact labels).
// - They establish whether each documented outcome is SPECIFIED for independent
//   checking: its own criterion, its own scenario, its own test, a structured check
//   aimed at that criterion, and a step that asserts it. That is a design property.
// - They never treat a design as evidence. A step's wording, an @verifies tag, a
//   `verifies` link, the design-time `check` field and Kane's coverage are not proof
//   that anything was asserted at run time (Kane 0.10.5 derives per-criterion
//   verdicts from the status of tagged steps; docs/ASSURANCE_PLAN.md section 13).
//   Run-time evidence is a separate gate that stays closed in B5.
// - Natural-language steps are checked with exact rules (quoted labels, order,
//   placeholders, tags). Anything these rules cannot judge is left to the human
//   review, which is required for every item.

import { createHash } from 'node:crypto';

export interface DesignItemBase {
  cid: string;
  slug: string | null;
  label: 'ac' | 'scenario' | 'test' | 'gap';
  /** Kane's trust as `context list` shows it (derived, trusted, ...). */
  trust: string | null;
  fresh: string | null;
  mintedSeq: number;
  mintedHash: string | null;
  /** Design generation of the minting record (null when the record has none). */
  generation: number | null;
  /** sha256 of the stored content (canonical JSON). */
  contentSha256: string;
}

export interface AcItem extends DesignItemBase {
  label: 'ac';
  text: string;
  /** Kane's criterion kind (presence, absolute, delta, state-transition, ...), as recorded. */
  kind?: string | null;
  /** Kane's expected answer for the criterion ({kind, operator, operand, baseline}), as recorded. */
  expectedAnswer?: { kind: string | null; operator: string | null; operand: string | null; baseline: unknown } | null;
}

/**
 * The reasons Kane 0.10.5's design committer records when it supersedes a design item (verified
 * in its code). With an evolve, its reason ("--because") replaces the generated one, as
 * "<reason> — evolve by <who> (<tag>)"; only KaneVerity's own evolve instructions are accepted.
 */
const SUCCESSOR_TAGS = ['reuse_of successor', 'same-criteria successor', 'title-matched successor', 'paired test successor', 'AC text-matched successor', 'orphaned criterion'];
const KANE_SUPERSESSION = [
  /^--force redesign of \S+ by \S+( \((reuse_of|same-criteria|title-matched|paired test) successor\))?$/,
  /^AC re-emitted with changed content by \S+ \(text-matched successor\)$/,
  /^orphaned: its scenario \S+ was retired; retired with it by the redesign of \S+ \(\S+\)$/,
];
export function recognisedSupersession(reason: string, evolveInstructions: string[]): boolean {
  if (KANE_SUPERSESSION.some((re) => re.test(reason))) return true;
  for (const ins of evolveInstructions) {
    const prefix = `${ins} \u2014 evolve by `;
    if (!reason.startsWith(prefix)) continue;
    const m = /^(\S+)(?: \((.+)\))?$/.exec(reason.slice(prefix.length));
    if (m && (m[2] === undefined || SUCCESSOR_TAGS.includes(m[2]))) return true;
  }
  return false;
}

/** Check kinds that compare with a captured starting state (Kane: they need a baseline-capture step). */
export const CHANGE_KINDS = ['delta', 'state-transition'];

export interface ScenarioItem extends DesignItemBase {
  label: 'scenario';
  title: string;
  intent: string;
  caseType: string | null;
  /** Live criteria it exercises (content ids). */
  exercises: string[];
  belongsTo: string[];
}

export interface TestStep {
  n: number;
  /** Criterion short ids from "@verifies ac-1, ac-2" on the step heading. */
  tags: string[];
  /** Kane's "## Step N — assert" heading. */
  assertHeading: boolean;
  /** Marked as a baseline capture (objectives `baseline: true`, or text "capture baseline: ..."). */
  baseline: boolean;
  text: string;
}

export interface TestCheck {
  kind: string;
  operator: string | null;
  operand: string | null;
  verifiedAgainst: string | null;
  baseline: unknown;
}

export interface TestItem extends DesignItemBase {
  label: 'test';
  title: string;
  definitionId: string | null;
  check: TestCheck | null;
  /** Live scenarios it automates, and live criteria it verifies (content ids). */
  automates: string[];
  verifies: string[];
  blobSha256: string;
  steps: TestStep[];
  /** The generated *_test.md file for this test, as found on disk (read only). */
  file: { path: string; sha256: string; bodyMatches: boolean; basePin: string | null; id: string | null } | null;
  /** Kane's recording for this test (output-<stem>/), fingerprinted, once an authoring run has made one. */
  recording?: { dir: string; exists: boolean; staging: boolean; sha256: string | null; files: number; resultMd: string | null } | null;
}

export interface GapItem extends DesignItemBase {
  label: 'gap';
  kind: string;
  header: string;
  prompt: string;
  /** The short id the gap points at ("sc-1"), as Kane stored it. */
  ref: string | null;
  /** What that short id names now. A gap is never dropped, whatever this says. */
  refState: 'live' | 'superseded' | 'unknown' | 'none';
  refCid: string | null;
  risk: string | null;
}

export interface DesignRecordInfo {
  seq: number;
  hash: string | null;
  verb: string | null;
  phase: string | null;
  generation: number | null;
  completeness: string | null;
  startsGeneration: number | null;
  supersedesGeneration: number | null;
}

export interface DesignSnapshot {
  snapshot: number;
  tutorialId: string;
  ucCid: string;
  ucSlug: string | null;
  retrievedAt: string;
  /** The use-case retrieval (B3) this design read was taken with. */
  useCaseSnapshot: number;
  cliVersion: string;
  integrity: { ok: boolean; problems: string[] };
  store: { records: number; tipHash: string | null };
  requirements: { version: number; reqSha256: string; docSha256: string } | null;
  sourceCid: string | null;
  /** Design records for this use case, in order. */
  designRecords: DesignRecordInfo[];
  acs: AcItem[];
  scenarios: ScenarioItem[];
  tests: TestItem[];
  gaps: GapItem[];
  /** *_test.md files that belong to no live test of this use case, and are not a superseded test's file. */
  strayTestFiles: { path: string; sha256: string; id: string | null }[];
  /**
   * Files of tests a redesign superseded (Kane keeps them on disk and reports them as replaced;
   * it never deletes them). Identified by the file's pin: its id is the superseded test's short
   * id and its base is that test's definition. Shown, fingerprinted and never run; deleting one
   * needs an explicit, recorded cleanup decision (not part of B5).
   */
  supersededTestFiles?: { path: string; sha256: string; id: string; testCid: string; supersededInSeq: number; successor: string | null }[];
  /** The latest evolve of this use case: what it changed that it must not have (null: none started). */
  evolveScope?: { jobId: string; checked: boolean; late: boolean; problems: string[] } | null;
  /** Every design item a design record of this use case superseded, with Kane's recorded reason. */
  supersessions?: { seq: number; label: string; old: string; next: string | null; reason: string; recognised: boolean }[];
  /** Kane's generated variables file, read only; KaneVerity never writes it. */
  variables: {
    path: string;
    sha256: string | null;
    appUrlDeclared: boolean;
    appUrlHasValue: boolean;
    /** Every *.json in .testmuai/variables/ (Kane loads them all, alphabetically; a later file wins). */
    files?: { name: string; sha256: string }[];
    /** KaneVerity's own run file (.testmuai/variables/kaneverity-run.json), if present: the app_url it sets. */
    runFile?: { sha256: string; appUrl: string | null } | null;
    /**
     * The local file whose app_url Kane uses: Kane loads the global folder, then every local
     * file alphabetically, a later definition winning, and local always over global (0.10.5
     * loader). So this is the effective app_url unless no local file defines it.
     */
    appUrlWinner?: { file: string; value: string | null } | null;
  };
  /** Kane's committed review items for this design's items (B4 records of design items). */
  kaneReviews?: { seq: number; recordHash: string | null; prevHash: string | null; cid: string; resolution: string; by: string; reviewOnly: boolean; itemsInRecord: number; build: string | null }[];
}

export interface RequirementItem {
  item: string;
  index: number;
  text: string;
  labels: string[];
  source: string;
}

export interface Requirements {
  steps: RequirementItem[];
  outcomes: RequirementItem[];
}

export interface Check {
  ok: boolean;
  problems: string[];
  notes: string[];
}

export interface OutcomeMapping {
  outcome: string;
  acCid: string | null;
  acSlug: string | null;
  problem: string | null;
}

export interface OutcomeSpec {
  outcome: string;
  outcomeText: string;
  acCid: string | null;
  acSlug: string | null;
  scenarioCid: string | null;
  testCid: string | null;
  /** The step that asserts it, when one qualifies. */
  assertStep: number | null;
  /** Design-level only: never evidence of an executed assertion. */
  specified: boolean;
  problems: string[];
  evidence: 'not_available';
}

export interface StepClass {
  n: number;
  kind: 'navigation' | 'capture' | 'assertion' | 'other';
  labels: string[];
  /** Labels it acts on (click, open, use ...). */
  actions: string[];
  /** States an assertion (wording or tag). Design-level only, never evidence. */
  asserts: boolean;
  /** Captures or stores something (a baseline, a list, a value). */
  captures: boolean;
}

export interface TestFidelity {
  testCid: string;
  testSlug: string | null;
  ok: boolean;
  problems: string[];
  steps: StepClass[];
  /** Steps outside the documented journey that need an explicit approval. */
  extraSteps: { n: number; textSha256: string; text: string }[];
}

export interface DesignEvaluation {
  generation: Check & { latest: number | null; phasesInLatest: string[] };
  structure: Check;
  mapping: { ok: boolean; entries: OutcomeMapping[]; problems: string[] };
  outcomes: OutcomeSpec[];
  fidelity: TestFidelity[];
  files: Check;
  gaps: { cid: string; slug: string | null; stale: boolean; message: string }[];
}

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Canonical JSON (sorted keys), so fingerprints do not depend on key order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

// ---------------------------------------------------------------------------
// Parsing Kane's generated test (test_md_blob), as written by Kane 0.10.5.
// ---------------------------------------------------------------------------

const STEP_HEADING = /^## Step (\d+)(.*)$/;
const VERIFIES_TAG = /@verifies\s+(.+?)\s*$/;

/** Steps of a generated test body. Objectives' `baseline: true` markers are passed in. */
export function parseTestSteps(body: string, baselineSteps: Set<number> = new Set()): TestStep[] {
  const steps: TestStep[] = [];
  let cur: TestStep | null = null;
  const lines: string[] = [];
  const flush = () => {
    if (cur) {
      cur.text = lines.join(' ').replace(/\s+/g, ' ').trim();
      cur.baseline = cur.baseline || /^capture baseline:/i.test(cur.text);
      steps.push(cur);
    }
    lines.length = 0;
  };
  for (const line of body.split(/\r?\n/)) {
    const m = STEP_HEADING.exec(line);
    if (m) {
      flush();
      const rest = m[2];
      const tag = VERIFIES_TAG.exec(rest);
      const n = Number(m[1]);
      cur = {
        n,
        tags: tag ? tag[1].split(',').map((s) => s.trim()).filter(Boolean) : [],
        assertHeading: /—\s*assert\b|--\s*assert\b/i.test(rest),
        baseline: baselineSteps.has(n),
        text: '',
      };
      continue;
    }
    if (cur && line.trim() && !/^#/.test(line)) lines.push(line.trim());
  }
  flush();
  return steps;
}

/** Step numbers marked `baseline: true` in Kane's objectives YAML (flat list of entries). */
export function baselineStepsFromObjectives(objectives: string): Set<number> {
  const out = new Set<number>();
  for (const chunk of objectives.split(/^\s*-\s+/m)) {
    const step = /^\s*step:\s*(\d+)\s*$/m.exec(chunk);
    if (step && /^\s*baseline:\s*true\s*$/m.test(chunk)) out.add(Number(step[1]));
  }
  return out;
}

const QUOTED = /(?:^|[\s(\[,;:])'([^'\n]+?)'(?=$|[\s.,;:)\]!?])/g;

/** Quoted UI labels in a step: 'like this', with apostrophes inside words ignored. */
export function quotedLabels(text: string): string[] {
  return [...text.matchAll(QUOTED)].map((m) => m[1]);
}

const ACTION_VERB = /\b(click|clicks|clicking|select|selects|open|opens|use|uses|press|presses|tap|taps|choose|chooses|follow|follows|activate|go to|navigate to)\b/i;

/**
 * Quoted labels the step acts on: introduced by an action verb in the same clause
 * ("open 'API Keys'", "use 'Generate Key'"). A label only mentioned ("From
 * 'Developer Settings', ...", "On 'API Keys', ...") is not an action.
 */
export function actionLabels(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(QUOTED)) {
    const before = text.slice(0, m.index! + m[0].indexOf("'"));
    const clause = before.split(/[,.;:]|\bthen\b|'/i).pop() ?? '';
    if (ACTION_VERB.test(clause)) out.push(m[1]);
  }
  return out;
}

const CAPTURE_WORDS = /\b(capture|captures|store|stores|record|records|remember|remembers|save|saves|note down)\b/i;
const ASSERT_WORDS = /\b(assert|assertion|verify|confirm|check that|checks that)\b/i;
const PLACEHOLDERS = /\{\{\s*([^}]+?)\s*\}\}/g;
const STOP = new Set(['the', 'and', 'for', 'are', 'was', 'with', 'that', 'this', 'from', 'after', 'below', 'appears', 'shows', 'its', 'into', 'then']);
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)));

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function generationCheck(s: DesignSnapshot): DesignEvaluation['generation'] {
  const problems: string[] = [];
  const notes: string[] = [];
  const gens = s.designRecords.map((r) => r.generation).filter((g): g is number => g !== null);
  const latest = gens.length ? Math.max(...gens) : null;
  if (latest === null) return { ok: false, problems: ['No test design is recorded for this use case.'], notes, latest: null, phasesInLatest: [] };
  const inLatest = s.designRecords.filter((r) => r.generation === latest);
  const phases = [...new Set(inLatest.map((r) => r.phase).filter((p): p is string => !!p))];
  for (const r of s.designRecords) if (!r.hash) problems.push(`The full hash of design record ${r.seq} is not established.`);
  // Fail closed on a supersession KaneVerity cannot explain (not one of Kane's own recorded reasons).
  for (const x of s.supersessions ?? []) if (!x.recognised) problems.push(`Record #${x.seq} superseded ${x.label} ${x.old}${x.next ? ` with ${x.next}` : ''} for a reason KaneVerity does not recognise ("${x.reason.slice(0, 160)}"), so the design cannot be accepted.`);
  const tests = inLatest.filter((r) => r.phase === 'tests');
  if (!tests.length) problems.push(`Design generation ${latest} has no tests phase: the design is incomplete.`);
  else if (!tests.some((r) => r.completeness === 'complete')) problems.push(`The tests phase of design generation ${latest} is not complete.`);
  if (inLatest.some((r) => r.completeness !== null && r.completeness !== 'complete')) problems.push(`Design generation ${latest} has a phase recorded as ${inLatest.find((r) => r.completeness !== 'complete')?.completeness}.`);
  if (!phases.includes('acs')) {
    const from = s.designRecords.find((r) => r.phase === 'acs')?.generation;
    notes.push(`The criteria phase is recorded only in generation ${from ?? '?'}; generation ${latest} carries those criteria forward. A later "--phase" run may ask for the criteria phase again.`);
  }
  for (const x of [...s.scenarios, ...s.tests]) {
    if (x.generation !== latest) problems.push(`${x.slug ?? x.cid.slice(0, 19)} is live but was made in generation ${x.generation ?? '?'}, not the latest (${latest}).`);
  }
  for (const a of s.acs) {
    if (a.generation === null || a.generation > latest) problems.push(`Criterion ${a.slug ?? a.cid.slice(0, 19)} has no design generation at or before ${latest}.`);
    else if (a.generation < latest) notes.push(`Criterion ${a.slug} comes from generation ${a.generation} and was kept by generation ${latest}.`);
  }
  // Links that must hold for a consistent design.
  const scenarioIds = new Set(s.scenarios.map((x) => x.cid));
  for (const t of s.tests) {
    if (t.automates.length !== 1) problems.push(`Test ${t.slug ?? t.cid.slice(0, 19)} automates ${t.automates.length} live scenarios; it must automate exactly one.`);
    else if (!scenarioIds.has(t.automates[0])) problems.push(`Test ${t.slug ?? t.cid.slice(0, 19)} automates a scenario that is not a live scenario of this use case.`);
  }
  for (const sc of s.scenarios) {
    const n = s.tests.filter((t) => t.automates.includes(sc.cid)).length;
    if (n !== 1) problems.push(`Scenario ${sc.slug ?? sc.cid.slice(0, 19)} has ${n} live tests; it must have exactly one.`);
  }
  return { ok: problems.length === 0, problems, notes, latest, phasesInLatest: phases };
}

function mapOutcomes(s: DesignSnapshot, r: Requirements): DesignEvaluation['mapping'] {
  const entries: OutcomeMapping[] = [];
  const problems: string[] = [];
  for (const o of r.outcomes) {
    const others = r.outcomes.filter((x) => x !== o).flatMap((x) => x.labels);
    const cands = s.acs.filter((ac) => o.labels.every((l) => ac.text.includes(l)) && others.every((l) => !ac.text.includes(l)));
    const ow = words(o.text);
    const scored = cands.map((ac) => ({ ac, score: [...words(ac.text)].filter((w) => ow.has(w)).length })).sort((a, b) => b.score - a.score);
    let pick: AcItem | null = null;
    let problem: string | null = null;
    if (!scored.length) problem = `No criterion matches ${o.item} ("${o.text}").`;
    else if (scored.length === 1 && (o.labels.length > 0 || scored[0].score > 0)) pick = scored[0].ac;
    else if (scored.length > 1 && scored[0].score > scored[1].score && scored[0].score > 0) pick = scored[0].ac;
    else problem = `${o.item} matches more than one criterion (${scored.map((x) => x.ac.slug).join(', ')}).`;
    entries.push({ outcome: o.item, acCid: pick?.cid ?? null, acSlug: pick?.slug ?? null, problem });
    if (problem) problems.push(problem);
  }
  const used = entries.map((e) => e.acCid).filter(Boolean);
  if (new Set(used).size !== used.length) problems.push('Two outcomes map to the same criterion.');
  for (const ac of s.acs) if (!used.includes(ac.cid)) problems.push(`Criterion ${ac.slug} ("${ac.text}") matches no documented outcome.`);
  return { ok: problems.length === 0, entries, problems };
}

function structureCheck(s: DesignSnapshot, r: Requirements): Check {
  const problems: string[] = [];
  const n = r.outcomes.length;
  if (n === 0) problems.push('The requirements have no documented outcomes.');
  const count = (k: number, one: string, many: string) => `${k} live ${k === 1 ? one : many}`;
  if (s.acs.length !== n) problems.push(`Found ${count(s.acs.length, 'criterion', 'criteria')}; ${n} documented outcomes need exactly ${n}, one each.`);
  if (s.scenarios.length !== n) problems.push(`Found ${count(s.scenarios.length, 'scenario', 'scenarios')}; ${n} documented outcomes need ${n} distinct scenarios, one per outcome.`);
  if (s.tests.length !== n) problems.push(`Found ${count(s.tests.length, 'test', 'tests')}; ${n} documented outcomes need ${n} tests, one per scenario.`);
  return { ok: problems.length === 0, problems, notes: [] };
}

function outcomeSpecs(s: DesignSnapshot, r: Requirements, mapping: OutcomeMapping[]): OutcomeSpec[] {
  return r.outcomes.map((o) => {
    const m = mapping.find((x) => x.outcome === o.item)!;
    const spec: OutcomeSpec = { outcome: o.item, outcomeText: o.text, acCid: m.acCid, acSlug: m.acSlug, scenarioCid: null, testCid: null, assertStep: null, specified: false, problems: [], evidence: 'not_available' };
    const p = spec.problems;
    if (!m.acCid) {
      p.push(m.problem ?? `${o.item} has no criterion.`);
      return spec;
    }
    // An outcome with no exact value (O2) is a change from the starting state: its criterion must
    // say so (Kane's kind delta or state-transition), not just that something exists.
    if (!o.labels.length) {
      const ac = s.acs.find((a) => a.cid === m.acCid);
      if (!ac?.kind) p.push(`Criterion ${m.acSlug} records no kind, so it cannot be shown to require a change from the starting state.`);
      else if (!CHANGE_KINDS.includes(ac.kind)) p.push(`Criterion ${m.acSlug} is a ${ac.kind} criterion, but ${o.item} is a change from the starting state (every earlier key kept, a new one added): it must be a delta or state-transition criterion. A redesign from the acs phase can replace it (Kane supersedes a criterion re-sent with the same text and changed content).`);
    }
    const sc = s.scenarios.filter((x) => x.exercises.includes(m.acCid!));
    const own = sc.filter((x) => x.exercises.length === 1);
    if (own.length !== 1) {
      p.push(own.length === 0 ? `No scenario exercises ${m.acSlug} on its own (${sc.length ? `exercised only together with other criteria by ${sc.map((x) => x.slug).join(', ')}` : 'not exercised'}).` : `${own.length} scenarios exercise ${m.acSlug} on its own; exactly one is required.`);
      return spec;
    }
    spec.scenarioCid = own[0].cid;
    const tests = s.tests.filter((t) => t.automates.includes(own[0].cid));
    if (tests.length !== 1) {
      p.push(`Scenario ${own[0].slug} has ${tests.length} tests; exactly one is required.`);
      return spec;
    }
    const t = tests[0];
    spec.testCid = t.cid;
    if (t.verifies.length !== 1 || t.verifies[0] !== m.acCid) p.push(`Test ${t.slug} must verify only ${m.acSlug} (it verifies ${t.verifies.length ? t.verifies.map((c) => s.acs.find((a) => a.cid === c)?.slug ?? c.slice(0, 19)).join(', ') : 'nothing'}).`);
    // The structured check, as designed (design-time metadata, not evidence).
    const c = t.check;
    if (!c) p.push(`Test ${t.slug} has no structured check.`);
    else {
      if (c.verifiedAgainst !== m.acSlug) p.push(`Test ${t.slug}'s structured check is aimed at ${c.verifiedAgainst ?? 'nothing'}, not ${m.acSlug}.`);
      if (o.labels.length) {
        const kindOk = (c.kind === 'presence' && c.operator === 'exists') || (c.kind === 'absolute' && (c.operator === 'equals' || c.operator === 'contains'));
        if (!kindOk) p.push(`Test ${t.slug}'s check (${c.kind} ${c.operator ?? ''}) cannot check an exact value; ${o.item} needs presence/exists or absolute equals/contains.`);
        for (const l of o.labels) if (!(c.operand ?? '').includes(l)) p.push(`Test ${t.slug}'s check does not name the exact value '${l}'.`);
      } else if (!CHANGE_KINDS.includes(c.kind)) {
        p.push(`${o.item} has no exact documented value, so it must be checked as a change against a captured starting state (delta or state-transition); test ${t.slug} uses ${c.kind}.`);
      }
      // The check must say what its criterion says: no contradictory criterion and test.
      const ac = s.acs.find((a) => a.cid === m.acCid);
      if (ac?.kind && c.kind !== ac.kind) p.push(`Test ${t.slug}'s check is ${c.kind}, but its criterion ${m.acSlug} is ${ac.kind}: the criterion and the test contradict each other.`);
    }
    // The step that asserts it: tagged with this criterion only, asserting, with the exact values.
    const tagged = t.steps.filter((st) => st.tags.length > 0);
    const mine = tagged.filter((st) => st.tags.includes(m.acSlug!));
    if (mine.length !== 1) p.push(`Test ${t.slug} needs exactly one step tagged @verifies ${m.acSlug} (found ${mine.length}).`);
    for (const st of tagged) if (st.tags.some((x) => x !== m.acSlug)) p.push(`Test ${t.slug} step ${st.n} is tagged with another criterion (${st.tags.join(', ')}); one test must assert one outcome.`);
    const st = mine[0];
    if (st) {
      if (!ASSERT_WORDS.test(st.text) && !st.assertHeading) p.push(`Test ${t.slug} step ${st.n} does not state an assertion.`);
      const q = quotedLabels(st.text);
      for (const l of o.labels) if (!q.includes(l)) p.push(`Test ${t.slug} step ${st.n} does not quote the exact value '${l}'.`);
      if (!o.labels.length) {
        const base = t.steps.find((x) => x.baseline);
        if (!base) p.push(`Test ${t.slug} captures no baseline before the action, so ${o.item} cannot be compared with the starting state.`);
        else if (base.n >= st.n) p.push(`Test ${t.slug} captures its baseline after the asserting step.`);
      }
      if (!p.length) spec.assertStep = st.n;
    }
    spec.specified = p.length === 0;
    return spec;
  });
}

function fidelityCheck(t: TestItem, r: Requirements): TestFidelity {
  const problems: string[] = [];
  const stepLabels = r.steps.flatMap((x) => x.labels);
  const allowed = new Set([...stepLabels, ...r.outcomes.flatMap((x) => x.labels)]);
  const steps: StepClass[] = [];
  const extraSteps: TestFidelity['extraSteps'] = [];
  if (!t.steps.length) problems.push('The test has no steps.');
  if (t.steps[0] && !t.steps[0].text.includes('{{app_url}}/')) problems.push('Step 1 does not start at the configured application URL ({{app_url}}/).');
  t.steps.forEach((st, i) => {
    if (st.n !== i + 1) problems.push(`Steps are not numbered 1..n in order (found step ${st.n} at position ${i + 1}).`);
    const q = quotedLabels(st.text);
    for (const l of q) if (!allowed.has(l)) problems.push(`Step ${st.n} uses '${l}', which is not a documented label or value.`);
    for (const ph of st.text.matchAll(PLACEHOLDERS)) if (ph[1] !== 'app_url') problems.push(`Step ${st.n} uses the variable {{${ph[1]}}}, which the documentation does not define.`);
    // Kane also substitutes ${column} dataset parameters; none may reach an approved run.
    for (const ph of st.text.matchAll(/\$\{\s*([^}]+?)\s*\}/g)) problems.push(`Step ${st.n} uses the parameter \${${ph[1]}}, which the documentation does not define.`);
    const nav = actionLabels(st.text).filter((l) => stepLabels.includes(l));
    const assertion = st.tags.length > 0 || st.assertHeading || ASSERT_WORDS.test(st.text);
    const captures = st.baseline || CAPTURE_WORDS.test(st.text);
    const kind: StepClass['kind'] = nav.length ? 'navigation' : captures ? 'capture' : assertion ? 'assertion' : 'other';
    steps.push({ n: st.n, kind, labels: q, actions: actionLabels(st.text), asserts: assertion, captures });
    // Anything beyond the documented navigation and the assertion (a capture, or a step
    // that is neither) is an undocumented action: it needs an explicit approval.
    if (captures || kind === 'other') extraSteps.push({ n: st.n, textSha256: sha256(st.text), text: st.text });
  });
  // Every documented step label acted on exactly once, in the documented order.
  let lastPos = -1;
  for (const s of r.steps) {
    for (const l of s.labels) {
      const hits: number[] = [];
      t.steps.forEach((st, i) => actionLabels(st.text).forEach((x, j) => x === l && hits.push(i * 1000 + j)));
      if (hits.length === 0) problems.push(`${s.item} ('${l}') is not acted on in any step.`);
      else if (hits.length > 1) problems.push(`${s.item} ('${l}') is acted on ${hits.length} times; the documented journey does it once.`);
      else {
        if (hits[0] < lastPos) problems.push(`${s.item} ('${l}') is out of the documented order.`);
        lastPos = hits[0];
      }
    }
  }
  return { testCid: t.cid, testSlug: t.slug, ok: problems.length === 0, problems, steps, extraSteps };
}

function filesCheck(s: DesignSnapshot): Check {
  const problems: string[] = [];
  for (const t of s.tests) {
    if (!t.file) problems.push(`No generated test file was found for ${t.slug ?? t.cid.slice(0, 19)}.`);
    else {
      if (!t.file.bodyMatches) problems.push(`${t.file.path} differs from the test Kane stored for ${t.slug}.`);
      if (!t.definitionId || t.file.basePin !== t.definitionId) problems.push(`${t.file.path} is pinned to a different test version (base ${t.file.basePin ?? 'missing'}).`);
    }
  }
  for (const f of s.strayTestFiles) problems.push(`${f.path} belongs to no live test of this use case (${f.id ?? 'no id'}); a run could pick it up.`);
  const ev = s.evolveScope;
  if (ev && !ev.checked) problems.push(`What evolve job ${ev.jobId} changed has not been checked yet, so the design cannot be accepted.`);
  if (ev) for (const p of ev.problems) problems.push(`Evolve job ${ev.jobId}: ${p}`);
  const notes = (s.supersededTestFiles ?? []).map((f) => `${f.path} is the file of ${f.id}, superseded in record #${f.supersededInSeq}${f.successor ? ` by ${f.successor}` : ''}. Kane keeps it on disk; it is never run, and it is fingerprinted so any change blocks a run. Deleting it needs an explicit, recorded cleanup decision.`);
  if (ev?.late) notes.push(`Evolve job ${ev.jobId} was checked only after an orchestrator restart, so later changes may be included in that check.`);
  return { ok: problems.length === 0, problems, notes };
}

export function evaluateDesign(s: DesignSnapshot, r: Requirements): DesignEvaluation {
  const mapping = mapOutcomes(s, r);
  return {
    generation: generationCheck(s),
    structure: structureCheck(s, r),
    mapping,
    outcomes: outcomeSpecs(s, r, mapping.entries),
    fidelity: s.tests.map((t) => fidelityCheck(t, r)),
    files: filesCheck(s),
    gaps: s.gaps.map((g) => ({
      cid: g.cid,
      slug: g.slug,
      stale: g.refState === 'superseded' || g.refState === 'unknown',
      message:
        g.refState === 'superseded'
          ? `Gap ${g.slug} points at ${g.ref}, which has been superseded. The gap is kept and still needs your acknowledgement.`
          : g.refState === 'unknown'
            ? `Gap ${g.slug} points at ${g.ref}, which names nothing in the store. The gap is kept and still needs your acknowledgement.`
            : `Gap ${g.slug}: ${g.header}. ${g.prompt}`,
    })),
  };
}

/** The requirements' steps and outcomes, from the stored line map and Markdown. */
export function requirementsFrom(lineMap: { reqLine: number; item: string; kind: 'step' | 'outcome'; index: number; labels: string[]; source: { kind: string; file?: string; line?: number; url?: string } }[], markdown: string): Requirements {
  const lines = markdown.split('\n');
  const toItem = (e: (typeof lineMap)[number]): RequirementItem => ({
    item: e.item,
    index: e.index,
    // "O1. The message 'API key generated successfully.' appears." -> the sentence.
    text: (lines[e.reqLine - 1] ?? '').replace(/^[SO][0-9]+\.\s*/, '').trim(),
    labels: e.labels,
    source: e.source.kind === 'markdown' ? `${e.source.file}:${e.source.line}` : `${e.source.url}`,
  });
  return {
    steps: lineMap.filter((e) => e.kind === 'step').sort((a, b) => a.index - b.index).map(toItem),
    outcomes: lineMap.filter((e) => e.kind === 'outcome').sort((a, b) => a.index - b.index).map(toItem),
  };
}
