// Citation validation (Assurance B3). Pure: no file or Kane access.
//
// Kane cites requirements lines with an anchor ("L37-L39") and an exact quote.
// KaneVerity checks every citation against the requirements text Kane actually
// read (the source blob), maps it to requirements items (S1…, O1…) through the B1
// line map, and from there to the documentation file and line. Every documented
// step and outcome is reported as cited or NOT cited: a missing citation is a
// visible gap, never treated as verified.

import type { LineMapEntry } from './requirements.ts';

export interface KaneCitation {
  anchor: string;
  quote: string;
  /** The criterion text this citation supports, when Kane recorded one. */
  claim: string | null;
  sourceId: string;
  sourceCid: string;
}

export type CitationProblem = 'bad_anchor' | 'out_of_range' | 'quote_mismatch' | 'wrong_source' | 'empty_quote';

export interface CheckedCitation extends KaneCitation {
  ok: boolean;
  problems: CitationProblem[];
  /** 1-based requirements lines the anchor covers. */
  lines: [number, number] | null;
  /** Requirements items the quote evidences ("S1", "O2"); empty for KaneVerity's framing text. */
  items: string[];
  /** Documentation references of those items. */
  docRefs: string[];
  /** The quote evidences only KaneVerity's own framing (no documentation line). */
  framingOnly: boolean;
}

export interface ItemCoverage {
  item: string;
  kind: 'step' | 'outcome';
  docRef: string;
  /** Valid citations that evidence this item. */
  citedBy: number;
  /** Every exact label of the item appears (case-sensitive) in the use case's text. */
  labelsNamed: boolean;
  missingLabels: string[];
}

export interface CitationReport {
  citations: CheckedCitation[];
  coverage: ItemCoverage[];
  summary: {
    total: number;
    valid: number;
    invalid: number;
    stepsCited: number;
    steps: number;
    outcomesCited: number;
    outcomes: number;
    /** Any invalid citation or any documented item without a valid citation. */
    hasGaps: boolean;
  };
}

const ANCHOR = /^L([1-9][0-9]{0,5})-L([1-9][0-9]{0,5})$/;

function docRefOf(e: LineMapEntry): string {
  return e.source.kind === 'markdown' ? `${e.source.file}:${e.source.line}` : `${e.source.url} (list ${e.source.list}, item ${e.source.item})`;
}

/**
 * Check Kane's citations against the requirements text Kane read.
 * `useCaseText` is the use case's own description and criteria, used only to report
 * whether documented labels are named (naming a label is not a citation).
 */
export function checkCitations(opts: {
  requirementsMarkdown: string;
  lineMap: LineMapEntry[];
  expectedSourceId: string;
  expectedSourceCid: string;
  citations: KaneCitation[];
  useCaseText: string;
}): CitationReport {
  const lines = opts.requirementsMarkdown.replace(/\n$/, '').split('\n');
  const checked: CheckedCitation[] = opts.citations.map((c) => {
    const problems: CitationProblem[] = [];
    if (c.sourceId !== opts.expectedSourceId || c.sourceCid !== opts.expectedSourceCid) problems.push('wrong_source');
    const m = ANCHOR.exec(c.anchor);
    let range: [number, number] | null = null;
    if (!m) problems.push('bad_anchor');
    else {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a > b || b > lines.length) problems.push('out_of_range');
      else range = [a, b];
    }
    const quote = c.quote.trim();
    if (!quote) problems.push('empty_quote');
    let items: string[] = [];
    if (range && quote) {
      const inRange = lines.slice(range[0] - 1, range[1]);
      // The quote must appear exactly within the cited lines.
      if (!inRange.some((l) => l.includes(quote)) && !inRange.join('\n').includes(quote)) problems.push('quote_mismatch');
      else {
        // Items evidenced: mapped lines inside the range whose text the quote actually covers.
        items = opts.lineMap
          .filter((e) => e.reqLine >= range![0] && e.reqLine <= range![1])
          .filter((e) => {
            const text = lines[e.reqLine - 1] ?? '';
            return text.includes(quote) || quote.includes(text.trim());
          })
          .map((e) => e.item);
      }
    }
    const ok = problems.length === 0;
    const docRefs = ok ? opts.lineMap.filter((e) => items.includes(e.item)).map(docRefOf) : [];
    return { ...c, ok, problems, lines: range, items: ok ? items : [], docRefs, framingOnly: ok && items.length === 0 };
  });

  const coverage: ItemCoverage[] = opts.lineMap.map((e) => {
    const missingLabels = e.labels.filter((l) => !opts.useCaseText.includes(l));
    return {
      item: e.item,
      kind: e.kind,
      docRef: docRefOf(e),
      citedBy: checked.filter((c) => c.ok && c.items.includes(e.item)).length,
      labelsNamed: missingLabels.length === 0,
      missingLabels,
    };
  });
  const steps = coverage.filter((c) => c.kind === 'step');
  const outcomes = coverage.filter((c) => c.kind === 'outcome');
  const invalid = checked.filter((c) => !c.ok).length;
  const uncited = coverage.filter((c) => c.citedBy === 0).length;
  return {
    citations: checked,
    coverage,
    summary: {
      total: checked.length,
      valid: checked.length - invalid,
      invalid,
      stepsCited: steps.filter((s) => s.citedBy > 0).length,
      steps: steps.length,
      outcomesCited: outcomes.filter((o) => o.citedBy > 0).length,
      outcomes: outcomes.length,
      hasGaps: invalid > 0 || uncited > 0,
    },
  };
}
