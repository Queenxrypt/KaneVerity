import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.ts';
import { Card, CostSummary, ErrorNote, formatTime, ReadinessStrip, RunCost, RunKindBadge, StatusBadge, statusRuns } from '../components/ui.tsx';
import { dashboardCounts, findings } from '../../../orchestrator/src/status.ts';
import { useHealth } from '../health.tsx';
import type { Discovery, PublicCorrection, PublicRun, VerificationStatus } from '../types.ts';

const ORDER: VerificationStatus[] = ['PASSED', 'FAILED', 'BLOCKED', 'NEEDS_REVIEW'];

export function Dashboard() {
  const { health, loading } = useHealth();
  const [runs, setRuns] = useState<PublicRun[]>([]);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [corrections, setCorrections] = useState<PublicCorrection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [staleTitles, setStaleTitles] = useState<string[]>([]);

  useEffect(() => {
    document.title = 'Dashboard · KaneVerity';
    Promise.all([api.runs(), api.discovery(), api.corrections()])
      .then(([r, d, cs]) => {
        setCorrections(cs);
        setRuns(r);
        setDiscovery(d);
        // Not fatal: the run-start guard still checks every run against the live docs.
        api
          .freshness()
          .then((f) => setStaleTitles(f.tutorials.filter((x) => x.status !== 'current').map((x) => d?.tutorials.find((t) => t.id === x.id)?.title ?? x.id)))
          .catch(() => setStaleTitles([]));
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  // Same rules as the Tutorials page (shared, tested): only verification and retest
  // runs on the current documentation version count; explorations never do.
  const tutorials = discovery?.tutorials ?? [];
  const sruns = statusRuns(runs);
  const counts = dashboardCounts(tutorials, sruns, corrections);
  const found = findings(tutorials, sruns, corrections);
  const titleOf = (id: string) => tutorials.find((t) => t.id === id)?.title ?? id;

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <ErrorNote message={error} />
      {staleTitles.length > 0 && (
        <p data-testid="dashboard-stale" className="rounded-lg border border-review/40 bg-review-soft p-3 text-sm text-review">
          Discovery is out of date for {staleTitles.join(', ')}: the live documentation changed, so the status below is for the version that was discovered.{' '}
          <Link to="/tutorials" className="font-semibold underline">
            Discover again on the Tutorials page
          </Link>
          .
        </p>
      )}

      <Card title="Connected project" actions={<Link to="/connect" className="text-sm font-medium text-brand hover:underline">{health?.project ? 'Change' : 'Connect'}</Link>}>
        {health?.project ? (
          <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-slate-500">Documentation</dt>
            <dd className="font-mono">{health.project.docsUrl}</dd>
            <dt className="text-slate-500">Application</dt>
            <dd className="font-mono">{health.project.appUrl}</dd>
          </dl>
        ) : (
          <p className="text-sm text-slate-600">{loading ? 'Checking connection…' : 'No project connected yet.'}</p>
        )}
        <div className="mt-4 space-y-4">
          <ReadinessStrip health={health} />
          <CostSummary health={health} />
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-2xl font-bold" data-testid="count-discovered">{tutorials.length}</div>
          <div className="text-sm text-slate-600">Tutorials discovered</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-2xl font-bold text-pass" data-testid="count-verified">{counts.verified}</div>
          <div className="text-sm text-slate-600">Verified tutorials</div>
          <div className="mt-1 text-xs text-slate-500">Corrected, approved and passed an independent Kane retest</div>
        </div>
        <Link to="/corrections" className="rounded-lg border border-slate-200 bg-white p-4 hover:border-brand">
          <div className="text-2xl font-bold" data-testid="count-awaiting-review">{counts.awaitingReview}</div>
          <div className="text-sm text-slate-600">Corrections awaiting review</div>
          {counts.awaitingRetest > 0 && <div className="mt-1 text-xs text-review">{counts.awaitingRetest} applied, waiting for a Kane retest</div>}
        </Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {ORDER.map((s) => (
          <div key={s} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-2xl font-bold" data-testid={`count-${s}`}>
              {counts[s]}
            </div>
            <div className="mt-1">
              <StatusBadge status={s} />
            </div>
          </div>
        ))}
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-2xl font-bold" data-testid="count-notRun">{counts.notRun}</div>
          <div className="mt-1 text-xs font-semibold text-slate-600">NOT RUN YET</div>
        </div>
      </div>
      <p className="-mt-2 text-xs text-slate-500">
        Each tutorial counts once, by its latest verification or retest result for the documentation version currently discovered. Exploration runs never count as verification.
      </p>

      <Card title="Open documentation findings">
        {found.open.length === 0 ? (
          <p className="text-sm text-slate-600" data-testid="no-open-findings">No open findings: no tutorial's current result is a FAILED documentation defect.</p>
        ) : (
          <ul className="space-y-3" data-testid="open-findings">
            {found.open.map((f) => (
              <li key={f.run.runId} className="text-sm">
                <span className="font-semibold">{f.tutorial.title}</span>: {runs.find((r) => r.runId === f.run.runId)?.classification?.explanation}
                <div className="mt-1 flex flex-wrap gap-3">
                  <Link to={`/runs/${f.run.runId}`} className="font-medium text-brand hover:underline">View evidence</Link>
                  {f.correction && <Link to={`/corrections/${f.correction.id}`} className="font-medium text-brand hover:underline">Correction in progress</Link>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {found.resolved.length > 0 && (
        <Card title="Resolved findings">
          <ul className="space-y-2 text-sm" data-testid="resolved-findings">
            {found.resolved.map((r) => (
              <li key={r.correction.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-semibold">{titleOf(r.correction.tutorialId)}</span>
                <span className="text-slate-600">corrected and VERIFIED by an independent Kane retest</span>
                {r.run && <Link to={`/runs/${r.run.runId}`} className="text-brand hover:underline">Original finding</Link>}
                <Link to={`/corrections/${r.correction.id}`} className="text-brand hover:underline">Correction</Link>
                {r.retestRunId && <Link to={`/runs/${r.retestRunId}`} className="text-brand hover:underline">Retest</Link>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Recent runs">
        {runs.length === 0 ? (
          <p className="text-sm text-slate-600">
            No runs yet. <Link to="/tutorials" className="text-brand hover:underline">Choose tutorials to verify</Link>.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-2 pr-4">Tutorial</th>
                  <th className="py-2 pr-4">Kind</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Started</th>
                  <th className="py-2 pr-4">Credits</th>
                  <th className="py-2">Run</th>
                </tr>
              </thead>
              <tbody>
                {runs.slice(0, 10).map((r) => (
                  <tr key={r.runId} className="border-t border-slate-100">
                    <td className="py-2 pr-4">{r.tutorial?.title ?? 'Unknown'}</td>
                    <td className="py-2 pr-4">
                      <RunKindBadge kind={r.kind} />
                    </td>
                    <td className="py-2 pr-4">
                      <StatusBadge run={r} />
                    </td>
                    <td className="py-2 pr-4 text-slate-600">{formatTime(r.startedAt ?? r.createdAt)}</td>
                    <td className="py-2 pr-4 text-slate-600"><RunCost run={r} /></td>
                    <td className="py-2">
                      <Link to={`/runs/${r.runId}`} className="font-mono text-xs text-brand hover:underline">
                        {r.runId}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
