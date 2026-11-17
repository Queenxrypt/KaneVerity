// Shared data model for the orchestrator.

export type SourceRef =
  | { kind: 'markdown'; file: string; line: number; text: string }
  | { kind: 'html'; url: string; list: number; item: number; quote: string; hash: string };

export interface ExtractedItem {
  /** 1-based position. */
  index: number;
  /** Plain readable text (for display). */
  text: string;
  /** Text converted for Kane: UI labels and values in 'single quotes'. */
  kaneText: string;
  /** Quoted labels/values found in the item, used for matching evidence. */
  labels: string[];
  ref: SourceRef;
}

export type ExtractionMethod = 'data-kv' | 'howto' | 'headings';

export interface Tutorial {
  id: string;
  title: string;
  url: string;
  appStart: string | null;
  method: ExtractionMethod;
  sourceSha256: string | null;
  steps: ExtractedItem[];
  outcomes: ExtractedItem[];
  warnings: string[];
  /** If set, the tutorial must not be run and the reason is shown instead. */
  notRunnable: string | null;
}

export interface OtherPage {
  url: string;
  title: string;
  reason: string;
}

export interface Discovery {
  docsUrl: string;
  appOrigin: string;
  discoveredAt: string;
  tutorials: Tutorial[];
  others: OtherPage[];
  errors: string[];
}

export interface Project {
  docsUrl: string;
  docsOrigin: string;
  appUrl: string;
  appOrigin: string;
  savedAt: string;
}

export type VerificationStatus = 'PASSED' | 'FAILED' | 'BLOCKED' | 'NEEDS_REVIEW';
export type RunState = 'queued' | 'running' | 'finished';

export interface StepResult {
  index: number;
  status: 'passed' | 'failed' | 'not_reached' | 'unknown';
}

export interface OutcomeResult {
  index: number;
  status: 'passed' | 'failed' | 'not_checked';
  /** The Kane assertion matched to this outcome, if any (sanitized). */
  assertion: { query: string; extracted: string | null; passed: boolean } | null;
}

export interface Classification {
  status: VerificationStatus;
  /** Machine-readable reason, e.g. "doc_step_not_found". */
  code: string;
  /** Plain-language explanation shown in the UI. */
  explanation: string;
  /** True only for FAILED results confidently attributed to the documentation. */
  documentationDefect: boolean;
  failedStep: number | null;
  failedOutcome: number | null;
  stepResults: StepResult[];
  outcomeResults: OutcomeResult[];
  /** Notes about why matching was or wasn't confident. Kept for inspection. */
  matchingNotes: string[];
}
