// Small shared UI pieces. All documentation and Kane text is rendered as plain
// text (React escaping); nothing is ever inserted as HTML.

import { useEffect, useRef, type ReactNode } from 'react';
import { ORCHESTRATOR_DOWN } from '../api.ts';
import type { Health, PublicRun, SourceRef as Ref, VerificationStatus } from '../types.ts';

const STATUS_STYLE: Record<VerificationStatus, { label: string; cls: string; hint: string }> = {
  PASSED: { label: 'PASSED', cls: 'bg-pass-soft text-pass border-pass/30', hint: 'Documented journey and every expected outcome verified by Kane.' },
  FAILED: { label: 'FAILED', cls: 'bg-fail-soft text-fail border-fail/30', hint: 'Evidence shows a documented step or outcome does not match the application.' },
  BLOCKED: { label: 'BLOCKED', cls: 'bg-blocked-soft text-blocked border-blocked/30', hint: 'An external condition prevented a result. Not a documentation defect.' },
  NEEDS_REVIEW: { label: 'NEEDS REVIEW', cls: 'bg-review-soft text-review border-review/30', hint: 'Evidence is inconclusive. Not reported as a documentation defect.' },
};

export function StatusBadge({ run, status, large }: { run?: PublicRun; status?: VerificationStatus | null; large?: boolean }) {
  const size = large ? 'text-sm px-3 py-1' : 'text-xs px-2 py-0.5';
  const s = status ?? run?.classification?.status ?? null;
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

export function Budget({ health }: { health: Health | null }) {
  if (!health) return null;
  const { limit, spent, reserved, available } = health.credits;
  const used = Math.round(spent * 100) / 100;
  const pct = Math.min(100, Math.round(((spent + reserved) / limit) * 100));
  return (
    <div data-testid="budget">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span>
          <span className="font-semibold">{used}</span> of <span className="font-semibold">{limit}</span> KaneVerity credits used
        </span>
        <span className="text-slate-600">{Math.floor(available)} remaining{reserved > 0 ? ` (${reserved} reserved for queued runs)` : ''}</span>
      </div>
      <div className="mt-2 h-2 w-full max-w-md overflow-hidden rounded bg-slate-200" role="progressbar" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-label="KaneVerity credit budget used">
        <div className="h-full bg-brand" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
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
          <button type="button" className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50" onClick={onConfirm} disabled={busy}>
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

/** Latest finished-or-active run per tutorial id. Runs arrive newest first. */
export function latestByTutorial(runs: PublicRun[]): Map<string, PublicRun> {
  const m = new Map<string, PublicRun>();
  for (const r of runs) if (r.tutorial && !m.has(r.tutorial.id)) m.set(r.tutorial.id, r);
  return m;
}
