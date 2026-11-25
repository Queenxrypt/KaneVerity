// Allow-listed Kane Assurance commands (Assurance B2).
//
// Every job kind maps to a fixed argument list. Nothing from documentation or from
// Kane's own output becomes an argument except validated ids, a session id that
// Kane returned and the user's own answers. `next[]` commands from Kane are never
// run. Kane is started directly (node + kane-cli.cjs), never through a shell.

import type { PendingQuestion } from './stream.ts';

export type JobKind = 'ingest' | 'extract' | 'design' | 'resume' | 'list' | 'cover' | 'view' | 'fsck' | 'review' | 'dryrun' | 'testrun' | 'evolve';

export interface JobKindInfo {
  kind: JobKind;
  label: string;
  /** Calls the KaneAI agent and uses credits (docs: extract, design, their resumes). */
  paid: boolean;
  /** Writes to the single-writer store. */
  writesStore: boolean;
  /** How the output is read. */
  output: 'ndjson' | 'text' | 'json';
  /** Started only by KaneVerity's own workflow (B4 approval write), never from the jobs API. */
  internal?: boolean;
  /** False: never stopped from the jobs API (an approval write would only become "unknown"). */
  cancellable?: boolean;
}

export const JOB_KINDS: Record<JobKind, JobKindInfo> = {
  ingest: { kind: 'ingest', label: 'Land requirements in the Assurance store', paid: false, writesStore: true, output: 'text' },
  extract: { kind: 'extract', label: 'Extract use cases', paid: true, writesStore: true, output: 'ndjson' },
  // V2 safety: started only through the use-case design endpoint, after fresh checks (usecases.ts).
  design: { kind: 'design', label: 'Design tests for a use case', paid: true, writesStore: true, output: 'ndjson', internal: true },
  // B5: one documented `maintain evolve` of an approved use case, with KaneVerity's own reason
  // (built from the approved requirements and the store, never user text). Paid; started only
  // from the design service after its fresh checks; never stopped from the jobs API.
  evolve: { kind: 'evolve', label: 'Re-design a use case (evolve)', paid: true, writesStore: true, output: 'ndjson', internal: true, cancellable: false },
  resume: { kind: 'resume', label: 'Answer and resume', paid: true, writesStore: true, output: 'ndjson' },
  list: { kind: 'list', label: 'List the store', paid: false, writesStore: false, output: 'json' },
  cover: { kind: 'cover', label: 'Read coverage', paid: false, writesStore: false, output: 'ndjson' },
  // B3 read paths (documented as local and free): the view payload and the store check.
  view: { kind: 'view', label: 'Read the store view', paid: false, writesStore: false, output: 'json' },
  fsck: { kind: 'fsck', label: 'Check the store', paid: false, writesStore: false, output: 'json' },
  // B4: write one KaneVerity approval into the store (documented as free; validated in V-B4a).
  review: { kind: 'review', label: 'Record a KaneVerity approval in Kane', paid: false, writesStore: true, output: 'json', internal: true, cancellable: false },
  // B5: plan and preflight the approved tests without running them (documented: "Plan + validate
  // only, execute nothing"; checked on a disposable copy: no file written). Free.
  dryrun: { kind: 'dryrun', label: 'Check the approved tests (dry run)', paid: false, writesStore: false, output: 'text', internal: true },
  // B5: run the approved tests. Paid (browser agent). Started only from the design execution
  // endpoint after every pre-execution gate passed; never stopped from the jobs API.
  testrun: { kind: 'testrun', label: 'Run the approved tests', paid: true, writesStore: true, output: 'text', internal: true, cancellable: false },
};

/**
 * Flags KaneVerity never passes to Kane: designing unreviewed use cases, archiving
 * without a terminal, and forced redesigns. buildArgs refuses any argument list
 * containing one of them, whatever the job.
 */
export const FORBIDDEN_FLAGS = ['--allow-unreviewed', '--allow-archive', '--force'] as const;

/**
 * The one recorded exception to FORBIDDEN_FLAGS (B5 redesign, ASSURANCE_PLAN section 13.10):
 * a forced redesign of a use case that already has a complete design, entering at one of these
 * phases. Kane retires only the use case's live scenarios and tests (and blocker gaps); records
 * are never rewritten. Only a design job with an explicit, acknowledged `redesign` gets it.
 */
export const REDESIGN_PHASES = ['acs', 'scenarios'] as const;
export type RedesignPhase = (typeof REDESIGN_PHASES)[number];
export const isRedesignPhase = (v: unknown): v is RedesignPhase => typeof v === 'string' && (REDESIGN_PHASES as readonly string[]).includes(v);

/**
 * What KaneVerity's evolve instruction is built from: the approved requirements (outcome texts,
 * exact labels, step labels) and the store (the short ids of the criteria mapped to each
 * outcome, the O2 criterion's exact text, the live scenario and test to replace). Never user text.
 */
export interface EvolveInputs {
  useCase: string;
  steps: [string, string, string];
  o1: { text: string; label: string; criterion: string };
  o2: { text: string; criterion: string; criterionText: string };
  o3: { text: string; label: string; criterion: string };
  replace: { scenarios: string[]; tests: string[] };
}
const DESIGN_SLUG = /^[a-z]+-[0-9]+$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f"]{1,200}$/;
/**
 * Kane 0.10.5 caps the agent's opening message at 8 KiB, measured as a JSON envelope of
 * "[kane] evolve started on …", "Because: <reason>" and its own two-line guidance; KaneVerity's
 * own cap is far below that (tested against Kane's installed size function).
 */
export const MAX_EVOLVE_INSTRUCTION_BYTES = 1200;

function checkEvolveInputs(i: EvolveInputs): void {
  const bad = (what: string) => new CommandError(`Invalid evolve instruction input: ${what}.`);
  if (!LOGICAL_ID.test(i.useCase)) throw bad('use case');
  if (!Array.isArray(i.steps) || i.steps.length !== 3 || !i.steps.every((x) => SAFE_TEXT.test(x))) throw bad('steps');
  for (const [k, o] of [['O1', i.o1], ['O3', i.o3]] as const) if (!SAFE_TEXT.test(o.text) || !SAFE_TEXT.test(o.label) || !DESIGN_SLUG.test(o.criterion)) throw bad(k);
  if (!SAFE_TEXT.test(i.o2.text) || !SAFE_TEXT.test(i.o2.criterionText) || !DESIGN_SLUG.test(i.o2.criterion)) throw bad('O2');
  if (new Set([i.o1.criterion, i.o2.criterion, i.o3.criterion]).size !== 3) throw bad('one criterion per outcome');
  for (const x of [...i.replace.scenarios, ...i.replace.tests]) if (!DESIGN_SLUG.test(x)) throw bad('items to replace');
  if (!i.replace.scenarios.length || !i.replace.tests.length || i.replace.scenarios.length > 8 || i.replace.tests.length > 8) throw bad('items to replace');
}

/**
 * The reason KaneVerity passes to `maintain evolve --because`. Kane 0.10.5 adds it to the agent's
 * opening message as "Because: <reason>" (it names the use case as the evolve target).
 * Deterministic: the same inputs always give the same text.
 */
export function evolveInstruction(i: EvolveInputs): string {
  checkEvolveInputs(i);
  const [s1, s2, s3] = i.steps;
  const list = (xs: string[]) => xs.join(', ');
  // Two sentences, as Kane asks for a reason ("a sentence or two"); every constraint is kept.
  const text = [
    `Design exactly three scenario/test pairs for ${i.useCase}, one per documented outcome, each scenario exercising one criterion and each test verifying only that criterion with one matching structured check: O1 keeps ${i.o1.criterion} (presence of '${i.o1.label}'); O2 re-sends ${i.o2.criterion} with exactly the text "${i.o2.criterionText}" as a delta criterion whose test captures baseline: the full API keys list before '${s3}', then asserts every baseline key is still listed and at least one new key appears; O3 keeps ${i.o3.criterion} (absolute, equals '${i.o3.label}').`,
    `Use only the documented steps '${s1}', '${s2}', '${s3}' in that order, add no other UI elements or steps, and replace ${list(i.replace.scenarios)} and ${list(i.replace.tests)} without reusing them.`,
  ].join(' ');
  if (Buffer.byteLength(text, 'utf8') > MAX_EVOLVE_INSTRUCTION_BYTES) throw new CommandError('The evolve instruction is too long.');
  return text;
}

/**
 * What an evolve may not change (fingerprints, sha256): existing store records and blobs,
 * requirements, documentation, existing test files. `problems`: anything the walk could not
 * fingerprint (an unreadable file or folder, a symbolic link, an unexpected entry); an evolve
 * with any is never started.
 */
export interface EvolveScopePrint {
  commits: { path: string; sha256: string }[];
  blobs?: { path: string; sha256: string }[];
  requirements: { path: string; sha256: string }[];
  docs: { path: string; sha256: string }[];
  testFiles: { path: string; sha256: string }[];
  problems?: string[];
}

/** The exact words the user must send to approve the evolve (bound to the use-case version). */
export function evolveAcknowledgement(ucCid: string): string {
  return `I approve one evolve of use case ${ucCid.replace(/^sha256:/, '').slice(0, 12)} with KaneVerity's instruction: Kane re-designs it in a new generation, supersedes what it replaces, and no record is deleted.`;
}

/** The exact words the user must send to approve a forced redesign (bound to the use-case version and phase). */
export function redesignAcknowledgement(ucCid: string, phase: RedesignPhase): string {
  return `I approve a forced redesign of use case ${ucCid.replace(/^sha256:/, '').slice(0, 12)} from the ${phase} phase: Kane supersedes its live scenarios and tests, and no record is deleted.`;
}

/** Id of one KaneVerity approval write (its private verdict file lives under data/assurance/kane-writes/<id>/). */
export const WRITE_ID_PATTERN = /^w[0-9]{8}-[0-9]{6}-[a-f0-9]{6}$/;
const CONTENT_ID = /^sha256:[a-f0-9]{64}$/;
/** A generated test file, workspace-relative, as Kane writes them (.testmuai/tests/<name>_test.md). */
export const TEST_FILE = /^\.testmuai\/tests\/[a-z0-9][a-z0-9._-]{0,150}_test\.md$/;

function testFiles(files: string[]): string[] {
  if (!Array.isArray(files) || files.length === 0 || files.length > 20) throw new CommandError('A run needs 1 to 20 test files.');
  for (const f of files) if (typeof f !== 'string' || !TEST_FILE.test(f) || f.includes('..')) throw new CommandError('Invalid test file path.');
  if (new Set(files).size !== files.length) throw new CommandError('A test file is listed twice.');
  return files;
}

export function isJobKind(v: unknown): v is JobKind {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(JOB_KINDS, v);
}

export class CommandError extends Error {}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Kane logical ids look like "uc-create-an-account-to-order" (docs). */
const LOGICAL_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
/** Session ids look like "ext-20260716T140742-prd-online-store" (docs). */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const QUESTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** The Assurance source id KaneVerity uses for a tutorial's requirements. */
export function sourceIdFor(tutorialId: string): string {
  if (!SLUG.test(tutorialId) || tutorialId.length > 80) throw new CommandError('Invalid tutorial id.');
  return `kv-${tutorialId}`;
}

/** Workspace-relative path of a tutorial's requirements file. */
export function requirementsFileFor(tutorialId: string): string {
  sourceIdFor(tutorialId);
  return `requirements/${tutorialId}.md`;
}

export type JobParams =
  | { kind: 'ingest'; tutorialId: string }
  | { kind: 'extract'; tutorialId: string }
  /**
   * Design is bound to one tutorial, one exact use-case version (ucCid), the Kane logical
   * id that version had at the fresh pre-start read (useCase), the KaneVerity decision it
   * relies on, and the self-declared reviewer passed to Kane as USER.
   */
  | { kind: 'design'; tutorialId: string; ucCid: string; useCase: string; max: number; reviewer: string; decisionId: string; acknowledgedPrevious: string | null; /** B5: the acknowledged forced redesign, or absent. */ redesign?: { phase: RedesignPhase; acknowledgement: string } | null }
  /** A design session's resume carries the same binding (ucCid, decisionId, reviewer). */
  | { kind: 'resume'; verb: 'extract' | 'design'; sid: string; answers: { id: string; value: string }[]; ucCid?: string; decisionId?: string; reviewer?: string }
  | { kind: 'list'; inferred: boolean }
  | { kind: 'cover' }
  | { kind: 'view' }
  | { kind: 'fsck' }
  | { kind: 'review'; tutorialId: string; writeId: string; ucCid: string; reviewer: string }
  /** B5: the approved tests' files (workspace-relative), planned only. */
  | { kind: 'dryrun'; tutorialId: string; files: string[] }
  /**
   * B5: `maintain evolve <use case> --because <instruction> --mode agent --answer evolve:<use case>=1`.
   * The instruction is rebuilt from its inputs (evolveInstruction) before Kane starts; any other
   * text is refused. The answer is Kane's own documented confirmation (1 = go ahead).
   */
  | { kind: 'evolve'; tutorialId: string; ucCid: string; useCase: string; reviewer: string; decisionId: string; inputs: EvolveInputs; instruction: string; acknowledgement: string; /** What the evolve must not change, fingerprinted before it starts. */ scope?: EvolveScopePrint }
  /** B5: the approved tests' files, bound to the use case and the readiness fingerprint checked before Kane starts. */
  | { kind: 'testrun'; tutorialId: string; ucCid: string; files: string[]; reviewer: string; readinessSha256: string };

/** The exact Kane CLI arguments for a job (after `node kane-cli.cjs`). */
export function buildArgs(p: JobParams): string[] {
  const args = argsFor(p);
  // The only exception: an acknowledged forced redesign passes --force, once, as
  // "--force --phase <acs|scenarios>" at the very end of a design command.
  const redesign = p.kind === 'design' && p.redesign ? p.redesign : null;
  const tail = redesign ? args.slice(-3) : [];
  const allowed = redesign !== null && isRedesignPhase(redesign.phase) && redesign.acknowledgement === redesignAcknowledgement(p.kind === 'design' ? p.ucCid : '', redesign.phase) && tail[0] === FORBIDDEN_FLAGS[2] && tail[1] === '--phase' && tail[2] === redesign.phase;
  args.forEach((a, i) => {
    if (!(FORBIDDEN_FLAGS as readonly string[]).includes(a)) return;
    if (allowed && a === FORBIDDEN_FLAGS[2] && i === args.length - 3) return;
    throw new CommandError(`KaneVerity never passes ${a} to Kane.`);
  });
  return args;
}

/** A reviewer name (KANEVERITY_REVIEWER): a short plain handle; no email addresses, spaces or paths. */
export const REVIEWER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** The Kane USER value for a reviewer: "kaneverity:<reviewer>" (self-declared, not authenticated). */
export function kaneUserFor(reviewer: string): string {
  if (!REVIEWER_PATTERN.test(reviewer)) throw new CommandError('Invalid reviewer name.');
  return `kaneverity:${reviewer}`;
}

/** Workspace-relative path of an approval write's private verdict file. */
export function verdictFileFor(writeId: string): string {
  if (!WRITE_ID_PATTERN.test(writeId)) throw new CommandError('Invalid write id.');
  return `../kane-writes/${writeId}/verdicts.json`;
}

function argsFor(p: JobParams): string[] {
  switch (p.kind) {
    case 'ingest':
      // --mode ci lands the file only: no extraction, no credits (docs).
      return ['context', 'ingest', requirementsFileFor(p.tutorialId), '--as', sourceIdFor(p.tutorialId), '--mode', 'ci', '--local'];
    case 'extract':
      return ['context', 'extract', '--mode', 'agent', '--local', '--source', sourceIdFor(p.tutorialId)];
    case 'design':
      sourceIdFor(p.tutorialId);
      if (!CONTENT_ID.test(p.ucCid)) throw new CommandError('Invalid use-case content id.');
      kaneUserFor(p.reviewer);
      if (!LOGICAL_ID.test(p.useCase) || p.useCase.length > 120) throw new CommandError('Invalid use-case reference.');
      if (!Number.isInteger(p.max) || p.max < 1 || p.max > 8) throw new CommandError('max must be a whole number from 1 to 8.');
      if (p.redesign && !isRedesignPhase(p.redesign.phase)) throw new CommandError('A forced redesign may start only at the acs or scenarios phase.');
      return ['design', 'tests', '--use-case', p.useCase, '--mode', 'agent', '--max', String(p.max), ...(p.redesign ? [FORBIDDEN_FLAGS[2], '--phase', p.redesign.phase] : [])];
    case 'evolve': {
      // Documented: maintain evolve [ref] --because <reason> --mode agent --answer evolve:<use-case>=1|2.
      sourceIdFor(p.tutorialId);
      if (!CONTENT_ID.test(p.ucCid)) throw new CommandError('Invalid use-case content id.');
      kaneUserFor(p.reviewer);
      if (!LOGICAL_ID.test(p.useCase) || p.useCase.length > 120 || p.inputs?.useCase !== p.useCase) throw new CommandError('Invalid use-case reference.');
      if (p.acknowledgement !== evolveAcknowledgement(p.ucCid)) throw new CommandError('The evolve was not acknowledged with the exact words.');
      if (p.instruction !== evolveInstruction(p.inputs)) throw new CommandError("The evolve instruction is not KaneVerity's own (it does not match its inputs).");
      return ['maintain', 'evolve', p.useCase, '--because', p.instruction, '--mode', 'agent', '--answer', `evolve:${p.useCase}=1`];
    }
    case 'resume': {
      if (!SESSION_ID.test(p.sid)) throw new CommandError('Invalid session id.');
      const base = p.verb === 'extract' ? ['context', 'extract'] : p.verb === 'design' ? ['design', 'tests'] : null;
      if (!base) throw new CommandError('Only extract and design sessions can be resumed here.');
      const args = [...base, '--resume', p.sid, '--mode', 'agent'];
      for (const a of p.answers) {
        if (!QUESTION_ID.test(a.id)) throw new CommandError('Invalid question id.');
        args.push('--answer', `${a.id}=${a.value}`);
      }
      return args;
    }
    case 'list':
      return ['context', 'list', '--json', ...(p.inferred ? ['--inferred'] : [])];
    case 'cover':
      return ['cover', '--mode', 'agent'];
    case 'view':
      // Documented: "--json prints the computed view payload as JSON and exit (no HTML)".
      return ['context', 'view', '--json'];
    case 'fsck':
      // Documented: verifies the full record chain; exit 1 on any issue.
      return ['context', 'fsck', '--json'];
    case 'review':
      // Documented: verdicts from a file, applied all together or not at all. --mode ci
      // never archives, whatever the flags (help). Validated on a disposable copy (V-B4a).
      sourceIdFor(p.tutorialId);
      if (!CONTENT_ID.test(p.ucCid)) throw new CommandError('Invalid use-case content id.');
      kaneUserFor(p.reviewer);
      return ['context', 'review', '--verdicts', verdictFileFor(p.writeId), '--mode', 'ci', '--json'];
    case 'dryrun':
      // Documented: "--dry-run  Plan + validate only, execute nothing"; --agent: NDJSON on stdout.
      sourceIdFor(p.tutorialId);
      return ['testrun', 'run', ...testFiles(p.files), '--dry-run', '--agent'];
    case 'testrun':
      // Documented flags only. --no-adaptive-heal: a replay miss is terminal instead of
      // re-authoring (it does not stop a first run from authoring, nor local records).
      // The hidden --local / --no-testmd-sync are not used (see ASSURANCE_PLAN section 13.8).
      sourceIdFor(p.tutorialId);
      if (!CONTENT_ID.test(p.ucCid)) throw new CommandError('Invalid use-case content id.');
      kaneUserFor(p.reviewer);
      if (!/^[a-f0-9]{64}$/.test(p.readinessSha256)) throw new CommandError('Invalid readiness fingerprint.');
      return ['testrun', 'run', ...testFiles(p.files), '--agent', '--headless', '--no-adaptive-heal'];
  }
}

/** One line of the user's own text: control characters and line breaks refused. */
function cleanAnswerText(v: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v)) throw new CommandError('Answers must be a single line of text.');
  const t = v.trim();
  if (!t) throw new CommandError('An answer is empty.');
  if (t.length > max) throw new CommandError(`An answer is longer than ${max} characters.`);
  return t;
}

/**
 * Validate the user's answers against the questions Kane actually asked.
 * An answer is an option number (1-based, as Kane's --answer takes it) or, where
 * the question allows it, free text. Every question must be answered.
 */
export function validateAnswers(questions: PendingQuestion[], raw: unknown, maxText: number): { id: string; value: string }[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CommandError('answers must be an object of question id to answer.');
  const given = raw as Record<string, unknown>;
  for (const id of Object.keys(given)) if (!questions.some((q) => q.id === id)) throw new CommandError(`Kane did not ask a question "${id.slice(0, 64)}".`);
  return questions.map((q) => {
    const v = given[q.id];
    if (v === undefined || v === null || v === '') throw new CommandError(`Question "${q.id}" has no answer.`);
    if (typeof v === 'number') {
      if (!Number.isInteger(v) || v < 1 || v > q.options.length) throw new CommandError(`Question "${q.id}": choose an option from 1 to ${q.options.length}.`);
      if (q.options[v - 1].input) throw new CommandError(`Question "${q.id}": that option needs a typed value.`);
      return { id: q.id, value: String(v) };
    }
    if (typeof v === 'object' && !Array.isArray(v)) {
      // An option that needs a typed value: {option, text}.
      const o = v as { option?: unknown; text?: unknown };
      if (typeof o.option !== 'number' || !Number.isInteger(o.option) || o.option < 1 || o.option > q.options.length || !q.options[o.option - 1].input) {
        throw new CommandError(`Question "${q.id}": that option does not take a typed value.`);
      }
      if (typeof o.text !== 'string') throw new CommandError(`Question "${q.id}": the typed value is missing.`);
      return { id: q.id, value: cleanAnswerText(o.text, maxText) };
    }
    if (typeof v === 'string') {
      if (!q.allowFreeText) throw new CommandError(`Question "${q.id}" does not accept free text; choose an option.`);
      return { id: q.id, value: cleanAnswerText(v, maxText) };
    }
    throw new CommandError(`Question "${q.id}": unsupported answer.`);
  });
}

/** Parse `context ingest --mode ci` receipts ("created  <id>  source sha256:…  blob sha256:…"). Best effort. */
export function parseIngestReceipt(stdout: string): { status: string; sourceId: string; source: string | null }[] {
  const out: { status: string; sourceId: string; source: string | null }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(created|unchanged|versioned)\s+(\S+)\s+source\s+(sha256:\S+)/.exec(line.trim());
    if (m) out.push({ status: m[1], sourceId: m[2], source: m[3] });
  }
  return out;
}

/** Parse `kane-cli balance` output ("credits: 10989.5863", as observed). Best effort. */
export function parseBalance(stdout: string): number | null {
  const m = /credits?\s*:\s*([0-9]+(?:\.[0-9]+)?)/i.exec(stdout);
  return m ? Number(m[1]) : null;
}
