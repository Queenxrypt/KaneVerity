// Parser for Kane Assurance's agent-mode NDJSON stream (Assurance B2).
//
// Built only from the documented 0.10.5 contract (docs/ASSURANCE_PLAN.md section 2;
// Kane's automation.md and assurance-parsing.md):
// - envelope {"type", "v": 1, "verb", ...}, one object per line; the vocabulary is
//   open, so unknown event types are counted and kept, never fatal;
// - non-JSON lines before the stream (older releases) are skipped;
// - exactly one terminal `done{status, exit_code, next?}`; a stream that ends
//   without it is a crash: outcome unknown;
// - `session_paused` is the pause deliverable (questions, or `crashed: true`, or
//   `held`), and exit 3 means paused for these commands only;
// - `usage` carries per-turn `credits` and a running `total_credits`;
// - `next[]` entries are objects {cmd, why, title} or plain strings: display only.

export type DoneStatus = 'complete' | 'paused' | 'error' | 'refused' | 'interrupted' | 'aborted';

export interface QuestionOption {
  label: string;
  detail: string | null;
  /** The option needs a typed value with the pick. */
  input: boolean;
}

export interface PendingQuestion {
  id: string;
  text: string;
  risk: string | null;
  rationale: string | null;
  options: QuestionOption[];
  recommendedIndex: number | null;
  allowFreeText: boolean;
}

export interface StreamPause {
  sid: string;
  expiresAt: string | null;
  questions: PendingQuestion[];
  /** A crash-paused session: no questions; resuming re-enters the conversation. */
  crashed: boolean;
  /** A held-for-review pause: the number of items held. */
  held: number | null;
}

export interface NextCommand {
  cmd: string;
  why: string | null;
  title: string | null;
}

export interface ParsedAssuranceStream {
  verb: string | null;
  events: number;
  unknownTypes: string[];
  nonJsonLines: number;
  /** Lines after the stream started that were not JSON (a contract break). */
  invalidLines: number;
  done: { status: string; exitCode: number | null; next: NextCommand[] } | null;
  pause: StreamPause | null;
  sessionComplete: string | null;
  credits: { lastTotal: number | null; sumOfTurns: number; turns: number };
  ingested: { sourceId: string; status: string; cid: string | null }[];
  commits: { counts: Record<string, number>; minted: { cid: string; logicalId: string }[]; proposalId: string | null }[];
  receipts: { phase: string | null; committed: number; rejected: unknown[]; warnings: unknown[] }[];
  warnings: { code: string | null; message: string }[];
  errors: { code: string | null; message: string }[];
  held: { count: number; reason: string | null }[];
  gateRefused: { message: string | null; next: NextCommand[] } | null;
  messages: string[];
  /** Coverage reads (`cover`/`cover gaps` in agent mode): the one payload event. */
  coverage: unknown;
  gaps: unknown;
}

const KNOWN = new Set([
  'ingested', 'run_start', 'corpus', 'source_start', 'source_skipped', 'plan', 'assumed_default', 'agent_activity', 'agent_message', 'warning',
  'lock_steal', 'usage', 'validate_failed', 'degraded', 'held', 'update_held', 'commit', 'receipt', 'variables_declared', 'variables_summary',
  'message_sent', 'panel_resolved', 'ask_deferred', 'session_paused', 'session_complete', 'gate_refused', 'phase_entry_override', 'error', 'done',
  'coverage', 'gaps', 'stream_start',
]);

export function emptyAssuranceStream(): ParsedAssuranceStream {
  return {
    verb: null,
    events: 0,
    unknownTypes: [],
    nonJsonLines: 0,
    invalidLines: 0,
    done: null,
    pause: null,
    sessionComplete: null,
    credits: { lastTotal: null, sumOfTurns: 0, turns: 0 },
    ingested: [],
    commits: [],
    receipts: [],
    warnings: [],
    errors: [],
    held: [],
    gateRefused: null,
    messages: [],
    coverage: null,
    gaps: null,
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function nextList(v: unknown): NextCommand[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((n) => (typeof n === 'string' ? { cmd: n, why: null, title: null } : n && typeof n === 'object' ? { cmd: str((n as Record<string, unknown>).cmd) ?? '', why: str((n as Record<string, unknown>).why), title: str((n as Record<string, unknown>).title) } : null))
    .filter((n): n is NextCommand => !!n && !!n.cmd);
}

function questions(v: unknown): PendingQuestion[] {
  if (!Array.isArray(v)) return [];
  const out: PendingQuestion[] = [];
  for (const q of v) {
    if (!q || typeof q !== 'object') continue;
    const o = q as Record<string, unknown>;
    const id = str(o.id);
    const text = str(o.text);
    if (!id || !text) continue;
    const options = Array.isArray(o.options)
      ? o.options
          .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as Record<string, unknown>).label === 'string')
          .map((x) => ({ label: x.label as string, detail: str(x.detail), input: x.input === true }))
      : [];
    const rec = num(o.recommended_index);
    out.push({ id, text, risk: str(o.risk), rationale: str(o.rationale), options, recommendedIndex: rec !== null && rec >= 0 && rec < options.length ? rec : null, allowFreeText: o.allow_free_text === true });
  }
  return out;
}

/** Feed one stdout line into the parsed state. */
export function applyAssuranceLine(s: ParsedAssuranceStream, raw: string): void {
  const line = raw.trim();
  if (!line) return;
  let ev: Record<string, unknown>;
  try {
    if (!line.startsWith('{')) throw new Error('not JSON');
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    ev = parsed as Record<string, unknown>;
  } catch {
    // Before the first event: tolerated prefix (documented for older releases).
    if (s.events === 0) s.nonJsonLines++;
    else s.invalidLines++;
    return;
  }
  const type = str(ev.type);
  if (!type) {
    s.invalidLines++;
    return;
  }
  s.events++;
  if (!s.verb && typeof ev.verb === 'string') s.verb = ev.verb;
  if (!KNOWN.has(type) && !s.unknownTypes.includes(type)) s.unknownTypes.push(type);

  switch (type) {
    case 'done':
      s.done = { status: str(ev.status) ?? 'unknown', exitCode: num(ev.exit_code), next: nextList(ev.next) };
      break;
    case 'session_paused':
      s.pause = {
        sid: str(ev.sid) ?? '',
        expiresAt: str(ev.expires_at),
        questions: questions(ev.pending_questions),
        crashed: ev.crashed === true,
        held: num(ev.held),
      };
      break;
    case 'session_complete':
      s.sessionComplete = str(ev.sid);
      break;
    case 'usage': {
      const c = num(ev.credits);
      const t = num(ev.total_credits);
      if (c !== null) {
        s.credits.sumOfTurns = Math.round((s.credits.sumOfTurns + c) * 100) / 100;
        s.credits.turns++;
      }
      if (t !== null) s.credits.lastTotal = t;
      break;
    }
    case 'ingested':
      s.ingested.push({ sourceId: str(ev.source_id) ?? '', status: str(ev.status) ?? 'unknown', cid: str(ev.cid) });
      break;
    case 'commit': {
      const counts: Record<string, number> = {};
      for (const [k, v] of Object.entries(ev)) if (typeof v === 'number' && k !== 'v') counts[k] = v;
      const minted = Array.isArray(ev.minted)
        ? ev.minted
            .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
            .map((m) => ({ cid: str(m.cid) ?? '', logicalId: str(m.logical_id) ?? '' }))
            .filter((m) => m.logicalId)
        : [];
      s.commits.push({ counts, minted, proposalId: str(ev.proposal_id) });
      break;
    }
    case 'receipt':
      s.receipts.push({
        phase: str(ev.phase),
        committed: Array.isArray(ev.committed) ? ev.committed.length : 0,
        rejected: Array.isArray(ev.rejected) ? ev.rejected : [],
        warnings: Array.isArray(ev.warnings) ? ev.warnings : [],
      });
      break;
    case 'warning':
      s.warnings.push({ code: str(ev.code), message: str(ev.message) ?? '' });
      break;
    case 'error':
      s.errors.push({ code: str(ev.code), message: str(ev.message) ?? '' });
      break;
    case 'held':
    case 'update_held':
      s.held.push({ count: num(ev.count) ?? 0, reason: str(ev.reason) });
      break;
    case 'gate_refused':
      s.gateRefused = { message: str(ev.message) ?? str(ev.reason), next: nextList(ev.next) };
      break;
    case 'agent_message': {
      const t = str(ev.text);
      if (t) s.messages.push(t);
      break;
    }
    case 'coverage':
      s.coverage = ev;
      break;
    case 'gaps':
      s.gaps = ev;
      break;
    default:
      break; // agent_activity, run_start (its trace path is private), and unknown types
  }
}

export function parseAssuranceStream(stdout: string): ParsedAssuranceStream {
  const s = emptyAssuranceStream();
  for (const line of stdout.split(/\r?\n/)) applyAssuranceLine(s, line);
  return s;
}

export type JobOutcome = 'complete' | 'paused' | 'refused' | 'error' | 'interrupted' | 'crashed';

/**
 * The job's outcome from the stream AND the process exit code. Both must agree:
 * a `done` that contradicts the exit code is treated as an error, never trusted.
 */
export function outcomeOf(s: ParsedAssuranceStream, exitCode: number | null, killed: boolean): { outcome: JobOutcome; reason: string } {
  if (killed) return { outcome: 'interrupted', reason: 'The job was stopped before Kane finished (timeout or cancel). Its outcome is unknown.' };
  if (!s.done) {
    return {
      outcome: 'crashed',
      reason: `Kane ended without its final "done" event (exit code ${exitCode ?? 'none'}). The outcome is unknown: check Kane's sessions before retrying anything paid.`,
    };
  }
  const st = s.done.status;
  const ec = s.done.exitCode;
  if (ec !== null && exitCode !== null && ec !== exitCode) {
    return { outcome: 'error', reason: `Kane's final event (exit ${ec}) disagrees with the process exit code (${exitCode}). The result is not trusted.` };
  }
  const code = exitCode ?? ec;
  if (st === 'complete' && code === 0) return { outcome: 'complete', reason: 'Kane completed.' };
  if (st === 'paused' && code === 3) {
    if (s.pause && s.pause.sid) return { outcome: 'paused', reason: s.pause.crashed ? 'Kane paused after a crash; the session can be resumed.' : s.pause.held ? `Kane is holding ${s.pause.held} item(s) for review.` : `Kane is waiting for ${s.pause.questions.length} answer(s).` };
    return { outcome: 'error', reason: 'Kane reported a pause but sent no session to resume.' };
  }
  if (st === 'refused' || code === 2) {
    const why = s.errors.map((e) => (e.code ? `${e.code}: ${e.message}` : e.message)).filter(Boolean).join(' ') || s.gateRefused?.message || 'Kane refused the command.';
    return { outcome: 'refused', reason: why };
  }
  if (st === 'interrupted' || st === 'aborted') return { outcome: 'interrupted', reason: `Kane reported "${st}".` };
  const why = s.errors.map((e) => (e.code ? `${e.code}: ${e.message}` : e.message)).filter(Boolean).join(' ');
  return { outcome: 'error', reason: why || `Kane finished with status "${st}" and exit code ${code ?? 'none'}.` };
}
