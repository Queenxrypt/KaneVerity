// Allow-listed Kane Assurance commands (Assurance B2).
//
// Every job kind maps to a fixed argument list. Nothing from documentation or from
// Kane's own output becomes an argument except validated ids, a session id that
// Kane returned and the user's own answers. `next[]` commands from Kane are never
// run. Kane is started directly (node + kane-cli.cjs), never through a shell.

import type { PendingQuestion } from './stream.ts';

export type JobKind = 'ingest' | 'extract' | 'design' | 'resume' | 'list' | 'cover' | 'view' | 'fsck' | 'review';

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
  resume: { kind: 'resume', label: 'Answer and resume', paid: true, writesStore: true, output: 'ndjson' },
  list: { kind: 'list', label: 'List the store', paid: false, writesStore: false, output: 'json' },
  cover: { kind: 'cover', label: 'Read coverage', paid: false, writesStore: false, output: 'ndjson' },
  // B3 read paths (documented as local and free): the view payload and the store check.
  view: { kind: 'view', label: 'Read the store view', paid: false, writesStore: false, output: 'json' },
  fsck: { kind: 'fsck', label: 'Check the store', paid: false, writesStore: false, output: 'json' },
  // B4: write one KaneVerity approval into the store (documented as free; validated in V-B4a).
  review: { kind: 'review', label: 'Record a KaneVerity approval in Kane', paid: false, writesStore: true, output: 'json', internal: true, cancellable: false },
};

/**
 * Flags KaneVerity never passes to Kane: designing unreviewed use cases, archiving
 * without a terminal, and forced redesigns. buildArgs refuses any argument list
 * containing one of them, whatever the job.
 */
export const FORBIDDEN_FLAGS = ['--allow-unreviewed', '--allow-archive', '--force'] as const;

/** Id of one KaneVerity approval write (its private verdict file lives under data/assurance/kane-writes/<id>/). */
export const WRITE_ID_PATTERN = /^w[0-9]{8}-[0-9]{6}-[a-f0-9]{6}$/;
const CONTENT_ID = /^sha256:[a-f0-9]{64}$/;

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
  | { kind: 'design'; tutorialId: string; ucCid: string; useCase: string; max: number; reviewer: string; decisionId: string; acknowledgedPrevious: string | null }
  /** A design session's resume carries the same binding (ucCid, decisionId, reviewer). */
  | { kind: 'resume'; verb: 'extract' | 'design'; sid: string; answers: { id: string; value: string }[]; ucCid?: string; decisionId?: string; reviewer?: string }
  | { kind: 'list'; inferred: boolean }
  | { kind: 'cover' }
  | { kind: 'view' }
  | { kind: 'fsck' }
  | { kind: 'review'; tutorialId: string; writeId: string; ucCid: string; reviewer: string };

/** The exact Kane CLI arguments for a job (after `node kane-cli.cjs`). */
export function buildArgs(p: JobParams): string[] {
  const args = argsFor(p);
  for (const a of args) if ((FORBIDDEN_FLAGS as readonly string[]).includes(a)) throw new CommandError(`KaneVerity never passes ${a} to Kane.`);
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
      return ['design', 'tests', '--use-case', p.useCase, '--mode', 'agent', '--max', String(p.max)];
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
