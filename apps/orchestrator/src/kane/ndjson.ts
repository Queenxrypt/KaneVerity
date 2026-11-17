// Kane CLI --agent output: one JSON object per line on stdout.
// Shapes confirmed from real Kane CLI 0.10.5 runs (see tests/fixtures).

export interface ProgressEvent {
  step: number;
  status: 'running' | 'done' | 'failed' | string;
  remark: string;
}

export interface MemoryRecord {
  query?: string;
  condition?: string;
  human_description?: string;
  extracted_value?: unknown;
  expected_value?: unknown;
  operator?: string;
  reasoning?: string;
  step?: number;
  analyzer_type?: string;
}

export interface RunEnd {
  type: 'run_end';
  status: 'passed' | 'failed' | string;
  summary?: string;
  one_liner?: string;
  reason?: string;
  reason_code?: string;
  result_code?: number;
  duration?: number;
  credits_consumed?: number;
  credits?: number;
  final_state?: Record<string, unknown>;
  context?: { memory?: Record<string, MemoryRecord> };
  [key: string]: unknown;
}

export interface ParsedStream {
  cliVersion: string | null;
  packPath: string | null;
  progress: ProgressEvent[];
  runEnd: RunEnd | null;
  /** Count of lines that were not valid JSON objects. */
  badLines: number;
}

export function emptyStream(): ParsedStream {
  return { cliVersion: null, packPath: null, progress: [], runEnd: null, badLines: 0 };
}

/** Apply one stdout line to the parsed state. Returns the parsed object, if any. */
export function applyLine(state: ParsedStream, line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    state.badLines++;
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    state.badLines++;
    return null;
  }
  const ev = obj as Record<string, unknown>;
  const type = typeof ev.type === 'string' ? ev.type : null;
  if (type === 'stream_start' && typeof ev.cli_version === 'string') state.cliVersion = ev.cli_version;
  else if (type === 'coverage' && typeof ev.pack === 'string') state.packPath = ev.pack;
  else if (type === 'run_end') state.runEnd = ev as RunEnd;
  else if (!type && typeof ev.step === 'number') {
    state.progress.push({ step: ev.step, status: String(ev.status ?? ''), remark: String(ev.remark ?? '') });
  }
  return ev;
}

export function parseAll(text: string): ParsedStream {
  const state = emptyStream();
  for (const line of text.split(/\r?\n/)) applyLine(state, line);
  return state;
}
