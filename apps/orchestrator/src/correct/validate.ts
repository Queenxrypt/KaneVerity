// KaneVerity's checks on Claude's answer. Claude's output is untrusted:
// nothing is applied unless every rule below passes.
//
// D4: a correction can only be proposed when a Kane exploration run has
// confirmed the route (reached every documented outcome with distinct passing
// assertions). D3: every UI label in changed lines must be supported by a
// specific exploration action (or a passing/stored exploration assertion for
// page names and messages), cited by run and step.

import { INJECTION } from '../discovery/extract.ts';
import type { EvidenceStep } from '../kane/evidence.ts';
import type { AssertionRecord } from '../kane/runner.ts';
import { ACTION_KINDS, norm, stepKind } from '../verify/classify.ts';
import { applyEdits, regions, splitLines, stepText, unifiedDiff, sha256 } from './patch.ts';
import type { Citation, ClaudeAttempt, Edit } from './store.ts';

export interface Answer {
  decision: 'proposal' | 'needs_exploration' | 'cannot_determine';
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
  evidenceCited: string[];
  edits: Edit[];
  explorationQuestion: string;
}

/** Structural check of Claude's JSON (independent of --json-schema). */
export function parseAnswer(raw: unknown): { answer: Answer | null; problems: string[] } {
  const p: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { answer: null, problems: ['Answer is not an object.'] };
  const o = raw as Record<string, unknown>;
  const allowed = new Set(['decision', 'rationale', 'confidence', 'evidenceCited', 'edits', 'explorationQuestion']);
  for (const k of Object.keys(o)) if (!allowed.has(k)) p.push(`Unexpected field "${k}".`);
  if (!['proposal', 'needs_exploration', 'cannot_determine'].includes(String(o.decision))) p.push('Invalid decision.');
  if (typeof o.rationale !== 'string' || o.rationale.length > 2000) p.push('Invalid rationale.');
  if (!['high', 'medium', 'low'].includes(String(o.confidence))) p.push('Invalid confidence.');
  if (!Array.isArray(o.evidenceCited) || o.evidenceCited.length > 20 || !o.evidenceCited.every((x) => typeof x === 'string' && x.length <= 300)) p.push('Invalid evidenceCited.');
  if (typeof o.explorationQuestion !== 'string' || o.explorationQuestion.length > 500) p.push('Invalid explorationQuestion.');
  const edits: Edit[] = [];
  if (!Array.isArray(o.edits) || o.edits.length > 20) p.push('Invalid edits.');
  else
    for (const e of o.edits) {
      const x = e as Record<string, unknown>;
      if (!x || typeof x !== 'object' || !Number.isInteger(x.line) || (x.line as number) < 1 || !['replace', 'delete', 'insert_after'].includes(String(x.action)) || typeof x.newText !== 'string' || (x.newText as string).length > 300) {
        p.push('Invalid edit entry.');
        continue;
      }
      edits.push({ line: x.line as number, action: x.action as Edit['action'], newText: x.newText as string });
    }
  if (p.length) return { answer: null, problems: p };
  return { answer: { ...(o as unknown as Answer), edits }, problems: [] };
}

export interface ExplorationEvidence {
  runId: string;
  confirmed: boolean;
  steps: EvidenceStep[];
  assertions: AssertionRecord[];
  screenshots: { ordinal: number; file: string }[];
}

function containsPhrase(haystack: string, phrase: string): boolean {
  const h = norm(haystack).replace(/["']/g, ' ');
  const p = norm(phrase).replace(/["']/g, ' ').trim();
  if (!p) return false;
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(h);
}

/**
 * How a label is used in a step:
 *  - target:   the thing acted on ("click **X**", "select **X**", "open **X**")
 *  - location: where the user is or which field ("On the **X**", "In **X**")
 *  - value:    a quoted value to type or expect (`X`)
 * A bold label whose role can't be recognised is treated as a target (strictest).
 */
export type LabelRole = 'target' | 'location' | 'value';

const TARGET_BEFORE = /\b(?:click|clicks|clicking|select|selects|choose|chooses|open|opens|press|presses|tap|taps)\s+(?:on\s+)?(?:the\s+)?$/i;
const LOCATION_BEFORE = /\b(?:on|in|from|at|within|under|inside)\s+(?:the\s+)?$/i;

export function labelsIn(markdownLine: string): { label: string; kind: 'bold' | 'value'; role: LabelRole }[] {
  const out: { label: string; kind: 'bold' | 'value'; role: LabelRole; at: number }[] = [];
  for (const m of markdownLine.matchAll(/\*\*([^*]+)\*\*/g)) {
    const before = markdownLine.slice(0, m.index ?? 0).replace(/\*\*|`/g, '');
    const role: LabelRole = TARGET_BEFORE.test(before) ? 'target' : LOCATION_BEFORE.test(before) ? 'location' : 'target';
    out.push({ label: m[1].trim(), kind: 'bold', role, at: m.index ?? 0 });
  }
  for (const m of markdownLine.matchAll(/`([^`]+)`/g)) out.push({ label: m[1].trim(), kind: 'value', role: 'value', at: m.index ?? 0 });
  return out.sort((a, b) => a.at - b.at).map(({ label, kind, role }) => ({ label, kind, role }));
}

const CLICK_KINDS = new Set(['click', 'press', 'check', 'uncheck', 'hover']);

/**
 * For click-like actions the label must be the whole target of the action:
 * it must follow the action verb directly (optionally quoted) and must not be
 * followed by another capitalised word. "Clicking API Keys link" supports
 * "API Keys" but not "API"; "Clicking Developer Settings in ..." supports
 * "Developer Settings" but not "Settings".
 */
export function isActionTarget(summary: string, label: string, exactCase = false): boolean {
  if (exactCase && !isActionTarget(summary, label, false)) return false;
  if (exactCase) {
    // Same match, but the recorded target text must equal the label exactly (case-sensitive).
    const want = label.trim().replace(/\s+/g, ' ');
    const escI = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const reI = new RegExp(`\\b(?:clicking|clicked|click|selecting|selected|select|pressing|pressed|press|choosing|tapping|opening)\\s+(?:on\\s+)?(?:the\\s+)?['"\\u2018\\u201c]?(${escI})`, 'gi');
    for (const m of summary.matchAll(reI)) {
      if (m[1].replace(/\s+/g, ' ') !== want) continue;
      // Re-check the "whole target" rule for this exact occurrence.
      if (isActionTarget(summary.slice(m.index ?? 0), label, false)) return true;
    }
    return false;
  }
  const esc = label.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const re = new RegExp(`\\b(?:clicking|clicked|click|selecting|selected|select|pressing|pressed|press|choosing|tapping|opening)\\s+(?:on\\s+)?(?:the\\s+)?(['"\\u2018\\u201c]?)(${esc})`, 'gi');
  for (const m of summary.matchAll(re)) {
    let rest = summary.slice((m.index ?? 0) + m[0].length);
    if (m[1]) {
      if (!/^['"’”]/.test(rest)) continue; // quoted label must close right after
      rest = rest.slice(1);
    }
    const next = /^\s*([A-Za-z0-9]+)/.exec(rest);
    if (!next || /^[a-z]/.test(next[1]) || /^[^\sA-Za-z0-9]/.test(rest)) return true;
  }
  return false;
}

function actionCitation(label: string, ev: ExplorationEvidence, s: EvidenceStep): Citation {
  const shot = ev.screenshots.find((x) => x.ordinal === s.ordinal);
  return { label, kind: 'action', runId: ev.runId, ordinal: s.ordinal, screenshot: shot?.file ?? null, evidence: s.summary.slice(0, 200) };
}

/**
 * Find the specific exploration evidence that supports a label in its role.
 *
 * - target:   ONLY a passed click-like action whose recorded target is exactly
 *             the label (case-sensitive, whole target). Assertions and stored
 *             values never support a target. Actions already used for another
 *             target (usedOrdinals) are skipped, so each target needs its own
 *             distinct action.
 * - location: a stored value equal to the label, a passing assertion that
 *             mentions it, or a click action on exactly that label.
 * - value:    a passed type/fill/select action containing the value, or a
 *             stored/asserted value.
 */
export function supportFor(label: string, ev: ExplorationEvidence, role: LabelRole = 'target', usedOrdinals: Set<number> = new Set()): Citation | null {
  const passedActions = ev.steps.filter((s) => s.status === 'passed' && ACTION_KINDS.has(stepKind(s)));
  const clickOn = (s: EvidenceStep) => CLICK_KINDS.has(stepKind(s)) && isActionTarget(s.summary, label, true);

  if (role === 'target') {
    const action = passedActions.find((s) => clickOn(s) && !usedOrdinals.has(s.ordinal));
    return action ? actionCitation(label, ev, action) : null;
  }

  const assertionSupport = () => {
    const a = ev.assertions.find((r) => (r.isCheck ? r.passed && containsPhrase(r.query, label) : r.extracted !== null && norm(r.extracted) === norm(label)));
    return a ? ({ label, kind: 'assertion', runId: ev.runId, ordinal: null, screenshot: null, evidence: (a.isCheck ? a.query : `${a.query} = ${a.extracted}`).slice(0, 200) } as Citation) : null;
  };

  if (role === 'location') {
    const stored = ev.assertions.find((r) => !r.isCheck && r.extracted !== null && norm(r.extracted) === norm(label));
    if (stored) return { label, kind: 'assertion', runId: ev.runId, ordinal: null, screenshot: null, evidence: `${stored.query} = ${stored.extracted}`.slice(0, 200) };
    const click = passedActions.find(clickOn);
    if (click) return actionCitation(label, ev, click);
    const typed = passedActions.find((s) => !CLICK_KINDS.has(stepKind(s)) && containsPhrase(s.summary, label));
    if (typed) return actionCitation(label, ev, typed);
    return assertionSupport();
  }

  // value
  const typed = passedActions.find((s) => !CLICK_KINDS.has(stepKind(s)) && containsPhrase(s.summary, label));
  if (typed) return actionCitation(label, ev, typed);
  return assertionSupport();
}

function pageOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return null;
  }
}

/**
 * Page-transition safeguard. Using the page URL recorded on each Kane evidence
 * step (the page the action was performed on):
 *  - the first cited click must happen on the exploration's start page;
 *  - for consecutive cited clicks A then B, if B happened on a different page
 *    than A, the step immediately after A must already be on B's page, so the
 *    transition is established by A itself (not by an uncited click or a typed
 *    address in between), and no navigate step may occur between them;
 *  - if A and B are on the same page, no transition is needed (same-page
 *    actions such as a button that updates the current page are legitimate).
 */
export function checkPageTransitions(targets: { label: string; ordinal: number }[], steps: EvidenceStep[]): string[] {
  const problems: string[] = [];
  if (targets.length === 0) return problems;
  const sorted = [...steps].sort((a, b) => a.ordinal - b.ordinal);
  const byOrd = new Map(sorted.map((s) => [s.ordinal, s]));
  const startPage = pageOf(sorted[0]?.url);
  const first = byOrd.get(targets[0].ordinal);
  if (!startPage || !first || pageOf(first.url) !== startPage) {
    problems.push(`"${targets[0].label}" was not clicked on the exploration's start page, so the route's starting point is not established.`);
    return problems;
  }
  for (let i = 0; i + 1 < targets.length; i++) {
    const a = byOrd.get(targets[i].ordinal);
    const b = byOrd.get(targets[i + 1].ordinal);
    const pa = pageOf(a?.url);
    const pb = pageOf(b?.url);
    if (!pa || !pb) {
      problems.push(`The page for "${targets[i].label}" or "${targets[i + 1].label}" was not recorded, so the route cannot be established.`);
      continue;
    }
    if (pa === pb) continue; // same-page action: legitimate
    const between = sorted.filter((s) => s.ordinal > a!.ordinal && s.ordinal < b!.ordinal);
    if (between.some((s) => stepKind(s) === 'navigate')) {
      problems.push(`Between "${targets[i].label}" and "${targets[i + 1].label}" Kane navigated without a click, so that transition is not established by the documented steps.`);
      continue;
    }
    const next = sorted.find((s) => s.ordinal > a!.ordinal);
    if (!next || pageOf(next.url) !== pb) {
      problems.push(`Kane's evidence does not show that clicking "${targets[i].label}" led to the page where "${targets[i + 1].label}" was clicked.`);
    }
  }
  return problems;
}

export interface ProposalCheck {
  ok: boolean;
  problems: string[];
  newText: string | null;
  diff: string;
  citations: Citation[];
  proposedSha256: string | null;
}

export function validateProposal(answer: Answer, originalText: string, file: string, ev: ExplorationEvidence | null): ProposalCheck {
  const problems: string[] = [];
  const fail = (): ProposalCheck => ({ ok: false, problems, newText: null, diff: '', citations: [], proposedSha256: null });
  if (answer.decision !== 'proposal') {
    problems.push('The answer is not a proposal.');
    return fail();
  }
  // D4: hard gate.
  if (!ev || !ev.confirmed) {
    problems.push('No Kane exploration has confirmed the route (every documented outcome reached with distinct passing assertions), so no correction may be proposed.');
    return fail();
  }
  if (answer.edits.length === 0) {
    problems.push('The proposal contains no edits.');
    return fail();
  }
  const reg = regions(originalText, file);
  const seen = new Set<string>();
  for (const e of answer.edits) {
    if (e.line < reg.stepFirst || e.line > reg.stepLast) problems.push(`Line ${e.line} is outside the Steps list (lines ${reg.stepFirst}-${reg.stepLast}); only steps may change.`);
    const key = `${e.line}:${e.action === 'insert_after' ? 'i' : 'rd'}`;
    if (e.action !== 'insert_after' && seen.has(key)) problems.push(`Line ${e.line} is edited more than once.`);
    seen.add(key);
    if (e.action !== 'delete') {
      const t = stepText(e.newText);
      if (!t) problems.push(`Edit for line ${e.line} has empty text.`);
      if (/[\u0000-\u001f<>]/.test(t)) problems.push(`Edit for line ${e.line} contains control characters or HTML.`);
      if (/\]\(|https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|dev|app|co|ai)\b/i.test(t)) problems.push(`Edit for line ${e.line} contains a link or web address.`);
      if (INJECTION.test(t)) problems.push(`Edit for line ${e.line} contains instruction-like wording.`);
    }
  }
  if (problems.length) return fail();

  let newText: string;
  try {
    newText = applyEdits(originalText, answer.edits, file);
  } catch (err) {
    problems.push((err as Error).message);
    return fail();
  }
  // Everything outside the Steps list must be byte-for-byte unchanged, and the
  // expected outcomes must be identical (a correction can never weaken them).
  const before = splitLines(originalText);
  const after = splitLines(newText);
  let next: ReturnType<typeof regions>;
  try {
    next = regions(newText, file);
  } catch (err) {
    problems.push(`Corrected tutorial is not readable: ${(err as Error).message}`);
    return fail();
  }
  const head = (l: string[], upto: number) => l.slice(0, upto - 1).join('\n');
  const tail = (l: string[], from: number) => l.slice(from).join('\n');
  if (head(before, reg.stepFirst) !== head(after, next.stepFirst)) problems.push('Content before the Steps list changed.');
  if (tail(before, reg.stepLast) !== tail(after, next.stepLast)) problems.push('Content after the Steps list changed.');
  if (JSON.stringify(reg.outcomes) !== JSON.stringify(next.outcomes)) problems.push('Expected outcomes changed.');
  if (problems.length) return fail();

  // D3: label evidence + order, for every changed or inserted line.
  const citations: Citation[] = [];
  const orderOrdinals: number[] = [];
  const usedTargets = new Set<number>();
  const targetSeq: { label: string; ordinal: number }[] = [];
  const originalSteps = new Set(reg.steps);
  for (const line of after.slice(next.stepFirst - 1, next.stepLast)) {
    const body = line.replace(/^\d+\.\s/, '');
    // Unchanged original step text (same Markdown) needs no new evidence; everything else does.
    if (originalSteps.has(body)) continue;
    for (const { label, role } of labelsIn(body)) {
      const c = supportFor(label, ev, role, usedTargets);
      if (!c) {
        problems.push(
          role === 'target'
            ? `"${label}" is used as an action target but no distinct, passed Kane click action has exactly that target.`
            : `"${label}" is not supported by any specific Kane exploration action or assertion.`,
        );
      } else {
        citations.push(c);
        if (role === 'target' && c.ordinal !== null) {
          usedTargets.add(c.ordinal);
          orderOrdinals.push(c.ordinal);
          targetSeq.push({ label, ordinal: c.ordinal });
        }
      }
    }
  }
  for (let k = 1; k < orderOrdinals.length; k++) {
    if (orderOrdinals[k] < orderOrdinals[k - 1]) {
      problems.push('The proposed steps are not in the order Kane performed the actions during exploration.');
      break;
    }
  }
  if (problems.length === 0) problems.push(...checkPageTransitions(targetSeq, ev.steps));
  if (citations.length === 0 && problems.length === 0) problems.push('The proposal cites no exploration evidence for its labels.');
  if (problems.length) return fail();
  return { ok: true, problems: [], newText, diff: unifiedDiff(originalText, newText, file), citations, proposedSha256: sha256(newText) };
}

export function attemptFromAnswer(a: Answer | null, base: Partial<ClaudeAttempt>): ClaudeAttempt {
  return {
    at: new Date().toISOString(),
    ok: !!a,
    decision: a?.decision ?? null,
    rationale: a?.rationale ?? '',
    confidence: a?.confidence ?? null,
    evidenceCited: a?.evidenceCited ?? [],
    explorationQuestion: a?.explorationQuestion || null,
    edits: a?.edits ?? [],
    model: null,
    costUsd: null,
    durationMs: null,
    validation: { ok: false, problems: [] },
    error: null,
    ...base,
  };
}
