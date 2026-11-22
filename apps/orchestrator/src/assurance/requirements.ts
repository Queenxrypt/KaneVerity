// Requirements generator (Assurance B1). Turns one discovered tutorial into a
// deterministic Markdown requirements document for Kane Assurance to ingest later.
//
// Rules (docs/ASSURANCE_PLAN.md, section 7.1):
// - Only the documented steps and expected outcomes, in order, with their exact
//   UI labels and values ('quoted', as KaneVerity already sends them to Kane).
// - Every item carries its source reference and the document fingerprint.
// - The application URL appears only as the {{app_url}} placeholder.
// - Nothing else: no answer key, application source, secrets or project files.
// - Deterministic: the same tutorial always gives byte-identical output (no
//   timestamps), so the requirements fingerprint identifies the content.
//
// Documentation text is untrusted input. It is inserted as data only: one line
// per item, table cells escaped, Kane variable syntax neutralised.

import { createHash } from 'node:crypto';
import { contentFingerprint } from '../discovery/freshness.ts';
import type { ExtractedItem, SourceRef, Tutorial } from '../types.ts';

export const REQUIREMENTS_FORMAT = 'kaneverity-requirements/1';
export const APP_URL_VARIABLE = '{{app_url}}';
/** Longest item accepted. Discovery already limits items; this is a second guard. */
export const MAX_ITEM_LENGTH = 1000;

export class RequirementsError extends Error {}

export interface LineMapEntry {
  /** 1-based line in the requirements document. */
  reqLine: number;
  /** "S1" for step 1, "O2" for expected outcome 2. */
  item: string;
  kind: 'step' | 'outcome';
  index: number;
  /** Where the item came from in the documentation. */
  source: { kind: 'markdown'; file: string; line: number; text: string } | { kind: 'html'; url: string; list: number; item: number; quote: string };
  /** Exact UI labels and values in the item, in order. */
  labels: string[];
}

export interface GeneratedRequirements {
  format: string;
  tutorialId: string;
  title: string;
  docSha256: string;
  reqSha256: string;
  markdown: string;
  lineMap: LineMapEntry[];
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** One line of plain text: no control characters or line breaks. */
function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Untrusted documentation text, made safe to place in the document:
 * - the application origin becomes the {{app_url}} placeholder;
 * - any other {{...}} is neutralised so documentation can't declare a Kane variable.
 */
function safeText(s: string, appOrigin: string | null): string {
  let t = oneLine(s);
  if (appOrigin) t = t.split(appOrigin).join(APP_URL_VARIABLE);
  // Neutralise every "{{" / "}}" except the placeholder KaneVerity inserted itself.
  const parts = t.split(APP_URL_VARIABLE).map((p) => p.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }'));
  return parts.join(APP_URL_VARIABLE);
}

/** A Markdown table cell: pipes and backslashes escaped. */
function cell(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function sourceOf(ref: SourceRef, appOrigin: string | null): LineMapEntry['source'] {
  return ref.kind === 'markdown'
    ? { kind: 'markdown', file: ref.file, line: ref.line, text: safeText(ref.text, appOrigin) }
    : { kind: 'html', url: ref.url, list: ref.list, item: ref.item, quote: safeText(ref.quote, appOrigin) };
}

function sourceLabel(src: LineMapEntry['source']): string {
  return src.kind === 'markdown' ? `${src.file}:${src.line}` : `${src.url} (list ${src.list}, item ${src.item})`;
}

function checkItem(it: ExtractedItem, what: string) {
  if (!it.kaneText || !oneLine(it.kaneText)) throw new RequirementsError(`${what} is empty.`);
  if (it.kaneText.length > MAX_ITEM_LENGTH) throw new RequirementsError(`${what} is longer than ${MAX_ITEM_LENGTH} characters.`);
}

/** The documentation page's origin-relative start path, for the requirements. */
function startPath(appStart: string | null): string {
  if (!appStart) return '/';
  // Only a relative path on the application origin is ever accepted (as discovery does).
  if (!appStart.startsWith('/') || appStart.startsWith('//') || /[\s\\]/.test(appStart)) throw new RequirementsError('The tutorial start path is not a relative path on the application.');
  return appStart;
}

export function generateRequirements(t: Tutorial, appOrigin: string | null): GeneratedRequirements {
  if (t.notRunnable) throw new RequirementsError(`This tutorial cannot be verified: ${t.notRunnable}`);
  if (t.steps.length === 0) throw new RequirementsError('The tutorial has no documented steps.');
  if (t.outcomes.length === 0) throw new RequirementsError('The tutorial has no documented expected outcome.');
  t.steps.forEach((s, i) => checkItem(s, `Step ${i + 1}`));
  t.outcomes.forEach((o, i) => checkItem(o, `Expected outcome ${i + 1}`));

  const docSha256 = contentFingerprint(t);
  const title = safeText(t.title || t.id, appOrigin);
  const start = startPath(t.appStart);
  const lines: string[] = [];
  const lineMap: LineMapEntry[] = [];
  const push = (...ls: string[]) => lines.push(...ls);
  const firstSource = t.steps[0].ref;

  push(`# Requirements: ${title}`, '');
  push(
    'KaneVerity generated these requirements from a published tutorial. They describe one use case:',
    'a user completes the documented task by following the documented steps exactly, in order,',
    'and every documented expected outcome is then observable in the application.',
    '',
  );

  push('## Source', '');
  push(`- Tutorial id: ${t.id}`);
  push(`- Documentation page: ${safeText(t.url, appOrigin)}`);
  if (firstSource.kind === 'markdown') push(`- Source file: ${firstSource.file}`);
  push(`- Document fingerprint (SHA-256): ${docSha256}`);
  push(`- Extraction method: ${t.method}`);
  push(`- Requirements format: ${REQUIREMENTS_FORMAT}`, '');

  push('## Application', '');
  push(`- The application under test is ${APP_URL_VARIABLE}.`);
  push(`- The journey starts at ${APP_URL_VARIABLE}${start === '/' ? '/' : start} in a fresh browser session.`, '');

  push('## Use case', '');
  push(`As a user of the application, I can complete "${title}" by following the documented steps in order, and observe every documented expected outcome.`, '');

  push('## Documented steps', '');
  push('Follow these steps exactly as written, in this order. Quoted text is an exact UI label or value: do not paraphrase or replace it.', '');
  t.steps.forEach((s, i) => {
    const item = `S${i + 1}`;
    const src = sourceOf(s.ref, appOrigin);
    push(`${item}. ${safeText(s.kaneText, appOrigin)}`);
    lineMap.push({ reqLine: lines.length, item, kind: 'step', index: i + 1, source: src, labels: s.labels.map((l) => safeText(l, appOrigin)) });
  });
  push('');

  push('## Expected outcomes', '');
  push('Each outcome is a separate acceptance criterion. It must be observed in the application after the steps: completing the steps alone does not prove it.', '');
  t.outcomes.forEach((o, i) => {
    const item = `O${i + 1}`;
    const src = sourceOf(o.ref, appOrigin);
    push(`${item}. ${safeText(o.kaneText, appOrigin)}`);
    lineMap.push({ reqLine: lines.length, item, kind: 'outcome', index: i + 1, source: src, labels: o.labels.map((l) => safeText(l, appOrigin)) });
  });
  push('');

  push('## Exact labels and values', '');
  push('| Item | Exact labels and values, in order |', '|---|---|');
  for (const e of lineMap) push(`| ${e.item} | ${e.labels.length ? e.labels.map((l) => cell(`'${l}'`)).join(', ') : '(none)'} |`);
  push('');

  push('## Rules', '');
  push('- Do not add steps, labels, routes or outcomes that are not documented above.');
  push('- If a documented label or step does not exist in the application, that step fails. Do not look for an alternative route.');
  push(`- Use no address, account or value that is not listed here. The only variable is ${APP_URL_VARIABLE}.`, '');

  push('## Source references', '');
  push('| Item | Source | Documented text |', '|---|---|---|');
  for (const e of lineMap) push(`| ${e.item} | ${cell(sourceLabel(e.source))} | ${cell(e.source.kind === 'markdown' ? e.source.text : e.source.quote)} |`);

  const markdown = lines.join('\n') + '\n';
  return { format: REQUIREMENTS_FORMAT, tutorialId: t.id, title, docSha256, reqSha256: sha256(markdown), markdown, lineMap };
}
