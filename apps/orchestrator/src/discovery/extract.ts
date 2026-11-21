// Extract tutorials from a documentation page. Documentation is UNTRUSTED:
// extracted text is normalised, length-limited and checked for foreign URLs
// before it can ever reach Kane.
//
// Strategies, in order:
//   1. data-kv markers (AcmeDesk Docs): exact source file, line and text
//   2. schema.org HowTo JSON-LD (parsed as data, never executed) for steps,
//      with outcomes from strategy 3
//   3. headings + lists: a "Steps"-like heading followed by an <ol>, and an
//      "Expected outcome"-like heading followed by a list

import { createHash } from 'node:crypto';
import type { ExtractedItem, ExtractionMethod, OtherPage, SourceRef, Tutorial } from '../types.ts';
import { foreignUrlsInText } from '../urls.ts';
import { attr, findAll, findFirst, headingLevel, labelledText, parseHtml, textOf, walk, isElement, type Element } from './html.ts';

export const LIMITS = { maxItemChars: 300, maxSteps: 20, maxOutcomes: 10, maxJsonLdBytes: 100_000 };

const STEP_HEADING = /^(steps|procedure|instructions|how to\b.*|step-by-step.*)$/i;
const OUTCOME_HEADING = /^(expected (outcome|result)s?|results?|what you should see|verify( the result)?|verification)$/i;
export const INJECTION = /\b(ignore|disregard|forget)\b[^.]{0,40}\b(previous|prior|above|earlier|all)\b[^.]{0,20}\b(instructions?|rules?|steps?)\b|\bsystem prompt\b|\byou are now\b|\bnew instructions?\b|\boverride\b[^.]{0,30}\brules?\b/i;

export type PageResult = { kind: 'tutorial'; tutorial: Tutorial } | { kind: 'other'; page: OtherPage };

/** Remove control characters and collapse whitespace. */
export function cleanText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Convert one Markdown item (from data-source-text) into plain and Kane text. */
export function fromMarkdownItem(md: string): { text: string; kaneText: string; labels: string[] } {
  const labels: string[] = [];
  let s = cleanText(md);
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'); // images -> alt text
  s = s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 ($2)'); // links -> text (url) so URL checks still see it
  const kane = s
    .replace(/\*\*([^*]+)\*\*/g, (_m, l: string) => (labels.push(l.trim()), `'${l.trim()}'`))
    .replace(/`([^`]+)`/g, (_m, v: string) => (labels.push(v.trim()), `'${v.trim()}'`));
  const plain = s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
  return { text: cleanText(plain), kaneText: cleanText(kane), labels };
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function titleOf(doc: ReturnType<typeof parseHtml>): string {
  const h1 = findFirst(doc, (e) => e.tagName === 'h1');
  if (h1) return cleanText(textOf(h1));
  const t = findFirst(doc, (e) => e.tagName === 'title');
  return t ? cleanText(textOf(t)) : '';
}

function slugFromUrl(url: string): string {
  const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? 'page';
  return last.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 80) || 'page';
}

// ---------- strategy 1: data-kv ----------

function fromDataKv(root: Element, pageUrl: string): { steps: ExtractedItem[]; outcomes: ExtractedItem[] } | null {
  const stepEls = findAll(root, (e) => attr(e, 'data-kv') === 'step');
  const outcomeEls = findAll(root, (e) => attr(e, 'data-kv') === 'outcome');
  if (stepEls.length === 0 && outcomeEls.length === 0) return null;
  const toItem = (el: Element, i: number): ExtractedItem => {
    const md = attr(el, 'data-source-text');
    const conv = md !== null ? fromMarkdownItem(md) : labelledText(el);
    const file = attr(el, 'data-source-file');
    const line = Number(attr(el, 'data-source-line'));
    const ref: SourceRef =
      file && Number.isInteger(line) && line > 0
        ? { kind: 'markdown', file: cleanText(file), line, text: cleanText(md ?? conv.text) }
        : { kind: 'html', url: pageUrl, list: 1, item: i + 1, quote: conv.text, hash: hash(conv.text) };
    return { index: i + 1, text: conv.text, kaneText: conv.kaneText, labels: conv.labels, ref };
  };
  return { steps: stepEls.map(toItem), outcomes: outcomeEls.map(toItem) };
}

// ---------- strategy 3: headings + lists ----------

function listItemsAfterHeading(root: Element, headingRe: RegExp, wantOrdered: boolean | null, pageUrl: string): ExtractedItem[] {
  const nodes = [...walk(root)].filter(isElement);
  let listCounter = 0;
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    if (el.tagName === 'ol' || el.tagName === 'ul') listCounter++;
    const level = headingLevel(el);
    if (!level || !headingRe.test(cleanText(textOf(el)))) continue;
    let counter = listCounter;
    for (let j = i + 1; j < nodes.length; j++) {
      const next = nodes[j];
      const nextLevel = headingLevel(next);
      if (nextLevel && nextLevel <= level) break;
      if (next.tagName === 'ol' || next.tagName === 'ul') {
        counter++;
        if (wantOrdered === true && next.tagName !== 'ol') continue;
        const lis = next.childNodes.filter((c): c is Element => isElement(c) && c.tagName === 'li');
        return lis.map((li, k) => {
          const conv = labelledText(li);
          return {
            index: k + 1,
            text: conv.text,
            kaneText: conv.kaneText,
            labels: conv.labels,
            ref: { kind: 'html', url: pageUrl, list: counter, item: k + 1, quote: conv.text, hash: hash(conv.text) },
          };
        });
      }
    }
  }
  return [];
}

// ---------- strategy 2: schema.org HowTo ----------

function howToSteps(doc: ReturnType<typeof parseHtml>, pageUrl: string): ExtractedItem[] {
  const scripts = findAll(doc, (e) => e.tagName === 'script' && (attr(e, 'type') ?? '').toLowerCase() === 'application/ld+json');
  for (const s of scripts) {
    const raw = s.childNodes.map((c) => ('value' in c ? (c as { value: string }).value : '')).join('');
    if (raw.length > LIMITS.maxJsonLdBytes) continue;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    const candidates = Array.isArray(data) ? data : [data];
    for (const c of candidates) {
      if (!c || typeof c !== 'object') continue;
      const obj = c as Record<string, unknown>;
      if (obj['@type'] !== 'HowTo' || !Array.isArray(obj.step)) continue;
      const texts = (obj.step as unknown[])
        .map((st) => (typeof st === 'string' ? st : st && typeof st === 'object' ? String((st as Record<string, unknown>).text ?? (st as Record<string, unknown>).name ?? '') : ''))
        .map(cleanText)
        .filter(Boolean);
      return texts.map((t, k) => ({
        index: k + 1,
        text: t,
        kaneText: t,
        labels: [],
        ref: { kind: 'html' as const, url: pageUrl, list: 0, item: k + 1, quote: t, hash: hash(t) },
      }));
    }
  }
  return [];
}

// ---------- validation ----------

/** Apply the same text cleaning to every item, whichever strategy produced it. */
function normaliseItems(items: ExtractedItem[]): ExtractedItem[] {
  return items.map((it) => ({
    ...it,
    text: cleanText(it.text),
    kaneText: cleanText(it.kaneText),
    labels: it.labels.map(cleanText).filter(Boolean),
    ref: it.ref.kind === 'html' ? { ...it.ref, quote: cleanText(it.ref.quote) } : { ...it.ref, text: cleanText(it.ref.text) },
  }));
}

function validate(t: Tutorial, appOrigin: string): void {
  const problems: string[] = [];
  if (t.steps.length > LIMITS.maxSteps) problems.push(`More than ${LIMITS.maxSteps} steps.`);
  if (t.outcomes.length > LIMITS.maxOutcomes) problems.push(`More than ${LIMITS.maxOutcomes} expected outcomes.`);
  for (const [kind, items] of [['Step', t.steps], ['Outcome', t.outcomes]] as const) {
    for (const it of items) {
      if (!it.kaneText) problems.push(`${kind} ${it.index} is empty.`);
      if (it.kaneText.length > LIMITS.maxItemChars) problems.push(`${kind} ${it.index} is longer than ${LIMITS.maxItemChars} characters.`);
      const foreign = foreignUrlsInText(it.text, appOrigin);
      if (foreign.length) problems.push(`${kind} ${it.index} references an address outside the application (${foreign[0]}).`);
      if (INJECTION.test(it.text)) t.warnings.push(`${kind} ${it.index} contains wording that looks like instructions to an automation agent.`);
    }
  }
  if (problems.length && !t.notRunnable) t.notRunnable = problems.join(' ');
}

/** Extract one page. `appOrigin` is used only to validate step text. */
export function extractPage(html: string, pageUrl: string, appOrigin: string): PageResult {
  const doc = parseHtml(html);
  const title = titleOf(doc) || slugFromUrl(pageUrl);
  const root = findFirst(doc, (e) => e.tagName === 'main') ?? findFirst(doc, (e) => e.tagName === 'article') ?? findFirst(doc, (e) => e.tagName === 'body');
  if (!root) return { kind: 'other', page: { url: pageUrl, title, reason: 'Empty page.' } };

  const article = findFirst(root, (e) => e.tagName === 'article');
  const docType = article ? attr(article, 'data-doc-type') : null;

  let method: ExtractionMethod;
  let steps: ExtractedItem[];
  let outcomes: ExtractedItem[];
  const kv = fromDataKv(root, pageUrl);
  if (kv) {
    method = 'data-kv';
    ({ steps, outcomes } = kv);
  } else {
    const howto = howToSteps(doc, pageUrl);
    if (howto.length) {
      method = 'howto';
      steps = howto;
    } else {
      method = 'headings';
      steps = listItemsAfterHeading(root, STEP_HEADING, true, pageUrl);
    }
    outcomes = listItemsAfterHeading(root, OUTCOME_HEADING, null, pageUrl);
  }

  if (steps.length === 0) {
    const reason = docType && docType !== 'tutorial' ? `Marked as a ${docType} page with no steps.` : 'No numbered steps found (not an actionable tutorial).';
    return { kind: 'other', page: { url: pageUrl, title, reason } };
  }

  const tutorial: Tutorial = {
    id: (article && attr(article, 'data-tutorial-id')) || slugFromUrl(pageUrl),
    title,
    url: pageUrl,
    appStart: article ? attr(article, 'data-app-start') : null,
    method,
    sourceSha256: article ? attr(article, 'data-source-sha256') : null,
    steps: normaliseItems(steps),
    outcomes: normaliseItems(outcomes),
    warnings: [],
    notRunnable: null,
  };
  tutorial.id = tutorial.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 80);
  if (outcomes.length === 0) tutorial.notRunnable = 'No expected outcome is documented, so the result could not be verified.';
  validate(tutorial, appOrigin);
  return { kind: 'tutorial', tutorial };
}
