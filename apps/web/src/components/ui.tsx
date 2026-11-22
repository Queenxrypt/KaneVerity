// Small shared UI pieces. All documentation and Kane text is rendered as plain
// text (React escaping); nothing is ever inserted as HTML.

import { useEffect, useRef, type ReactNode } from 'react';
import { ORCHESTRATOR_DOWN } from '../api.ts';
import type { Health, PublicRun, SourceRef as Ref, TutorialFreshness, VerificationStatus } from '../types.ts';
import { RUN_KIND_LABEL, type RunKind, type StatusRun } from '../../../orchestrator/src/status.ts';

const STATUS_STYLE: Record<VerificationStatus, { label: string; cls: string; hint: string }> = {
  PASSED: { label: 'PASSED', cls: 'bg-pass-soft text-pass border-pass/30', hint: 'Documented journey and every expected outcome verified by Kane.' },
  FAILED: { label: 'FAILED', cls: 'bg-fail-soft text-fail border-fail/30', hint: 'Evidence shows a documented step or outcome does not match the application.' },
  BLOCKED: { label: 'BLOCKED', cls: 'bg-blocked-soft text-blocked border-blocked/30', hint: 'An external condition prevented a result. Not a documentation defect.' },
  NEEDS_REVIEW: { label: 'NEEDS REVIEW', cls: 'bg-review-soft text-review border-review/30', hint: 'Evidence is inconclusive. Not reported as a documentation defect.' },
};

export function StatusBadge({ run, status, large }: { run?: PublicRun; status?: VerificationStatus | null; large?: boolean }) {
  const size = large ? 'text-sm px-3 py-1' : 'text-xs px-2 py-0.5';
  const s = status ?? run?.classification?.status ?? null;
  if (!status && run?.kind === 'exploration' && run.state === 'finished') {
    // An exploration result is never a verification status.
    return (
      <span title="Exploration result: it only looks for the current route for a correction and never counts as verification." className={`inline-flex items-center rounded-full border border-dashed border-slate-400 font-semibold tracking-wide text-slate-600 ${size}`}>
        EXPLORED
      </span>
    );
  }
  if (!s) {
    const state = run?.state ?? 'queued';
    return <span className={`inline-flex items-center rounded-full border font-semibold tracking-wide bg-brand-soft text-brand border-brand/30 ${size}`}>{state === 'running' ? 'RUNNING' : 'QUEUED'}</span>;
  }
  const st = STATUS_STYLE[s];
  return (
    <span title={st.hint} className={`inline-flex items-center rounded-full border font-semibold tracking-wide ${st.cls} ${size}`}>
      {st.label}
    </span>
  );
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-slate-200 bg-white p-5 ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex items-start justify-between gap-3">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Collapsible({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="rounded-lg border border-slate-200 bg-white">
      <summary className="cursor-pointer select-none px-5 py-3 text-sm font-semibold">{title}</summary>
      <div className="border-t border-slate-200 px-5 py-4">{children}</div>
    </details>
  );
}

export function SourceRef({ ref: r }: { ref: Ref }) {
  if (r.kind === 'markdown') {
    return (
      <code className="whitespace-nowrap rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700" title={r.text}>
        {r.file}:{r.line}
      </code>
    );
  }
  return (
    <code className="whitespace-nowrap rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700" title={r.quote}>
      list {r.list}, item {r.item}
    </code>
  );
}

function Check({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string }) {
  const icon = ok === null ? '…' : ok ? '✓' : '✕';
  const cls = ok === null ? 'text-slate-500' : ok ? 'text-pass' : 'text-fail';
  return (
    <div className="flex items-center gap-2 text-sm" title={detail}>
      <span aria-hidden="true" className={`font-bold ${cls}`}>
        {icon}
      </span>
      <span>{label}</span>
      <span className="sr-only">{ok === null ? 'unknown' : ok ? 'ok' : 'not ok'}</span>
    </div>
  );
}

export function ReadinessStrip({ health }: { health: Health | null }) {
  const h = health;
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2" data-testid="readiness">
      <Check ok={h ? h.docsReachable : null} label="Docs reachable" />
      <Check ok={h ? h.appReachable : null} label="App reachable" />
      <Check ok={h ? h.kane.installed && h.kane.loggedIn : null} label="Kane CLI logged in" detail="Checked by exit code only; no account details are shown." />
    </div>
  );
}

/**
 * KaneVerity's own Kane run costs: actual (reported by Kane) and estimated
 * (Kane reported none) are shown separately. No limit and no account balance.
 */
export function CostSummary({ health }: { health: Health | null }) {
  if (!health) return null;
  const c = health.credits;
  return (
    <div data-testid="cost-summary" className="text-sm">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span>
          <span className="font-semibold">{c.reportedCredits}</span> credits used by KaneVerity's Kane runs <span className="text-slate-500">(reported by Kane for {c.runsReported} run{c.runsReported === 1 ? '' : 's'}: verifications, explorations and retests)</span>
        </span>
        {c.runsEstimated > 0 && (
          <span className="text-review">
            + about {c.estimatedCredits} estimated for {c.runsEstimated} run{c.runsEstimated === 1 ? '' : 's'} where Kane reported no cost
          </span>
        )}
        {c.runsWithoutAgentWork > 0 && (
          <span className="text-slate-500">
            {c.runsWithoutAgentWork} run{c.runsWithoutAgentWork === 1 ? '' : 's'} stopped before Kane did any agent work (0 credits)
          </span>
        )}
        {c.runsMeasured > 0 && (
          <span>
            + <span className="font-semibold">{c.measuredCredits}</span> measured from the balance for {c.runsMeasured} Assurance job{c.runsMeasured === 1 ? '' : 's'}
          </span>
        )}
        {c.runsUnknownCost > 0 && (
          <span className="text-review">
            {c.runsUnknownCost} job{c.runsUnknownCost === 1 ? '' : 's'} with an unknown cost (Kane reported none and the balance could not be compared)
          </span>
        )}
        {c.pendingRuns > 0 && <span className="text-slate-500">{c.pendingRuns} run{c.pendingRuns === 1 ? '' : 's'} in progress, cost not known yet</span>}
      </div>
    </div>
  );
}

/** Per-run cost, labelled by how it is known. */
export function RunCost({ run }: { run: { state?: string; credits?: number | null; costBasis?: string | null; estimatedCredits?: number | null } }) {
  if (run.state !== 'finished') return <span className="text-slate-500">cost not known yet</span>;
  if (run.costBasis === 'reported' || (run.costBasis == null && run.credits != null)) return <span>{run.credits} credits (reported by Kane)</span>;
  if (run.costBasis === 'estimated') return <span className="text-review">about {run.estimatedCredits ?? '?'} credits (estimate: Kane reported no cost)</span>;
  if (run.costBasis === 'not_started') return <span className="text-slate-500">0 credits (Kane did not start)</span>;
  return <span className="text-slate-500">0 credits (stopped before Kane did any agent work)</span>;
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  busy,
  confirmDisabled,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  /** Keeps the confirm button disabled (for example until an explicit acknowledgement is ticked). */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onCancel={onCancel} className="m-auto w-full max-w-lg rounded-lg border border-slate-200 p-0 backdrop:bg-slate-900/40">
      <div className="p-6">
        <h2 className="text-lg font-semibold">{title}</h2>
        <div className="mt-3 space-y-2 text-sm text-slate-700">{children}</div>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50" onClick={onConfirm} disabled={busy || confirmDisabled}>
            {busy ? 'Starting…' : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  // The global banner already shows "orchestrator not reachable"; don't repeat it.
  if (!message || message === ORCHESTRATOR_DOWN) return null;
  return (
    <div role="alert" className="rounded-md border border-fail/30 bg-fail-soft px-4 py-3 text-sm text-fail">
      {message}
    </div>
  );
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/** Public runs in the shape the shared status rules use (runs without a tutorial are skipped). */
export function statusRuns(runs: PublicRun[]): StatusRun[] {
  return runs.filter((r) => !!r.tutorial).map((r) => ({ ...r, createdAt: r.createdAt ?? '', tutorial: r.tutorial! }));
}

export function RunKindBadge({ kind }: { kind?: RunKind | null }) {
  const k = kind ?? 'verification';
  const cls = k === 'verification' ? 'border-slate-300 text-slate-700' : k === 'retest' ? 'border-brand/40 text-brand' : 'border-dashed border-slate-400 text-slate-500';
  const hint =
    k === 'exploration'
      ? 'Exploration: looks for the current route for a correction. Never counts as verification.'
      : k === 'retest'
        ? 'Retest: independent Kane verification of an approved correction.'
        : 'Verification: Kane follows the tutorial as documented.';
  return (
    <span data-testid="run-kind" title={hint} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {RUN_KIND_LABEL[k]}
    </span>
  );
}

export function VerifiedBadge() {
  return (
    <span data-testid="verified-badge" title="A human-approved correction for this exact documentation version passed every condition of an independent Kane retest." className="inline-flex items-center rounded-full border border-pass/40 bg-pass px-2 py-0.5 text-xs font-bold tracking-wide text-white">
      VERIFIED
    </span>
  );
}

export function FreshnessNote({ f }: { f: TutorialFreshness | undefined }) {
  if (!f || f.status === 'current') return null;
  return (
    <span data-testid="stale-badge" title={f.reason ?? ''} className="inline-flex items-center rounded-full border border-review/40 bg-review-soft px-2 py-0.5 text-xs font-semibold text-review">
      {f.status === 'stale' ? 'STALE: discover again' : 'LIVE PAGE UNAVAILABLE'}
    </span>
  );
}
