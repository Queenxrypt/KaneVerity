import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.ts';
import { Card, ConfirmDialog, CostSummary, ErrorNote, latestByTutorial, SourceRef, StatusBadge } from '../components/ui.tsx';
import { useHealth } from '../health.tsx';
import type { Discovery, PublicRun, Tutorial } from '../types.ts';

function safeDocsLink(url: string, docsOrigin: string | undefined): string | null {
  try {
    return docsOrigin && new URL(url).origin === docsOrigin ? url : null;
  } catch {
    return null;
  }
}

function TutorialCard({
  t,
  latest,
  docsOrigin,
  selected,
  onToggle,
  busy,
}: {
  t: Tutorial;
  latest?: PublicRun;
  docsOrigin?: string;
  selected: boolean;
  onToggle: () => void;
  busy: boolean;
}) {
  const active = latest && latest.state !== 'finished';
  const disabled = !!t.notRunnable || !!active || busy;
  const link = safeDocsLink(t.url, docsOrigin);
  return (
    <div className={`rounded-lg border bg-white ${selected ? 'border-brand' : 'border-slate-200'}`} data-testid={`tutorial-${t.id}`}>
      <div className="flex flex-wrap items-start gap-3 p-4">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 accent-[var(--color-brand)]"
          checked={selected}
          disabled={disabled}
          onChange={onToggle}
          aria-label={`Select ${t.title} for verification`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{t.title}</h3>
            {latest && <StatusBadge run={latest} />}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
            <span>{t.steps.length} steps</span>
            <span>{t.outcomes.length} expected outcomes</span>
            <span>extracted via {t.method}</span>
            {link ? (
              <a href={link} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                Open docs page
              </a>
            ) : (
              <span className="font-mono">{t.url}</span>
            )}
            {latest && (
              <Link to={`/runs/${latest.runId}`} className="text-brand hover:underline">
                Latest run
              </Link>
            )}
          </div>
          {t.notRunnable && <p className="mt-2 text-sm text-fail">Cannot be verified: {t.notRunnable}</p>}
          {t.warnings.map((w) => (
            <p key={w} className="mt-2 text-sm text-review">
              Warning: {w}
            </p>
          ))}
        </div>
      </div>
      <details className="border-t border-slate-100">
        <summary className="cursor-pointer px-4 py-2 text-sm font-medium text-slate-700">Extracted steps and expected outcomes</summary>
        <div className="grid gap-4 px-4 pb-4 md:grid-cols-2">
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase text-slate-500">Steps</h4>
            <ol className="space-y-1.5 text-sm">
              {t.steps.map((s) => (
                <li key={s.index} className="flex gap-2">
                  <span className="w-5 shrink-0 text-right text-slate-500">{s.index}.</span>
                  <span className="flex-1">{s.text}</span>
                  <SourceRef ref={s.ref} />
                </li>
              ))}
            </ol>
          </div>
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase text-slate-500">Expected outcomes</h4>
            <ul className="space-y-1.5 text-sm">
              {t.outcomes.map((o) => (
                <li key={o.index} className="flex gap-2">
                  <span className="w-5 shrink-0 text-right text-slate-500">•</span>
                  <span className="flex-1">{o.text}</span>
                  <SourceRef ref={o.ref} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      </details>
    </div>
  );
}

export function Tutorials() {
  const { health, refresh } = useHealth();
  const navigate = useNavigate();
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [runs, setRuns] = useState<PublicRun[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, r] = await Promise.all([api.discovery(), api.runs()]);
      setDiscovery(d);
      setRuns(r);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = 'Tutorials · KaneVerity';
    void load();
  }, [load]);

  async function rediscover() {
    setBusy(true);
    try {
      setDiscovery(await api.discover());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { runIds } = await api.startRuns(selected);
      setConfirm(false);
      setSelected([]);
      await refresh();
      navigate(`/runs/${runIds[0]}`);
    } catch (e) {
      setError((e as Error).message);
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  }

  const latest = latestByTutorial(runs);
  const ready = !!health && health.appReachable && health.docsReachable && health.kane.loggedIn;
  const [lo, hi] = health?.credits.estimatedByKind.verification ?? [12, 35];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Tutorials</h1>
        <div className="flex gap-2">
          <button type="button" onClick={rediscover} disabled={busy || !health?.project} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
            Discover again
          </button>
          <button
            type="button"
            onClick={() => setConfirm(true)}
            disabled={busy || selected.length === 0 || !ready}
            className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            Verify selected ({selected.length})
          </button>
        </div>
      </div>
      {!ready && health && <p className="text-sm text-review">Verification is unavailable until the docs, the app and Kane CLI are all ready (see Dashboard).</p>}
      <ErrorNote message={error} />

      {loading ? (
        <p className="text-sm text-slate-600">Loading…</p>
      ) : !discovery ? (
        <Card>
          <p className="text-sm text-slate-600">
            No tutorials discovered yet. <Link to="/connect" className="text-brand hover:underline">Connect a project</Link> first.
          </p>
        </Card>
      ) : (
        <>
          {discovery.tutorials.length === 0 && <Card>No actionable tutorials were found on the documentation site.</Card>}
          <div className="space-y-3">
            {discovery.tutorials.map((t) => (
              <TutorialCard
                key={t.id}
                t={t}
                latest={latest.get(t.id)}
                docsOrigin={health?.project?.docsOrigin}
                selected={selected.includes(t.id)}
                busy={busy}
                onToggle={() => setSelected((s) => (s.includes(t.id) ? s.filter((x) => x !== t.id) : [...s, t.id]))}
              />
            ))}
          </div>
          {discovery.others.length > 0 && (
            <Card title="Other pages (not verified)">
              <ul className="space-y-1 text-sm">
                {discovery.others.map((o) => (
                  <li key={o.url}>
                    <span className="font-medium">{o.title}</span> <span className="text-slate-500">- {o.reason}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {discovery.errors.length > 0 && (
            <Card title="Discovery notes">
              <ul className="list-disc pl-5 text-sm text-slate-600">
                {discovery.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirm}
        title={`Verify ${selected.length} tutorial${selected.length === 1 ? '' : 's'} with Kane CLI?`}
        confirmLabel="Start verification"
        busy={busy}
        onCancel={() => setConfirm(false)}
        onConfirm={start}
      >
        <p>Kane runs each tutorial in a real browser against the application, one at a time (about 3 minutes each).</p>
        <p>
          Estimated cost: about <strong>{lo}-{hi} credits per tutorial</strong>, so roughly {selected.length * lo}-{selected.length * hi} credits in total. This is an estimate; the actual cost Kane reports is recorded for each run.
        </p>
        <CostSummary health={health} />
      </ConfirmDialog>
    </div>
  );
}
