import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.ts';
import { Budget, Card, ErrorNote, formatTime, latestByTutorial, ReadinessStrip, StatusBadge } from '../components/ui.tsx';
import { useHealth } from '../health.tsx';
import type { Discovery, PublicRun, VerificationStatus } from '../types.ts';

const ORDER: VerificationStatus[] = ['PASSED', 'FAILED', 'BLOCKED', 'NEEDS_REVIEW'];

export function Dashboard() {
  const { health, loading } = useHealth();
  const [runs, setRuns] = useState<PublicRun[]>([]);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Dashboard · KaneVerity';
    Promise.all([api.runs(), api.discovery()])
      .then(([r, d]) => {
        setRuns(r);
        setDiscovery(d);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const latest = latestByTutorial(runs);
  const counts = Object.fromEntries(ORDER.map((s) => [s, 0])) as Record<VerificationStatus, number>;
  for (const r of latest.values()) if (r.classification) counts[r.classification.status]++;
  const finding = runs.find((r) => r.classification?.status === 'FAILED' && r.classification.documentationDefect);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <ErrorNote message={error} />

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
          <Budget health={health} />
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-2xl font-bold">{discovery?.tutorials.length ?? 0}</div>
          <div className="text-sm text-slate-600">Tutorials discovered</div>
        </div>
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
      </div>
      <p className="-mt-2 text-xs text-slate-500">Counts use the latest run of each tutorial.</p>

      {finding && finding.tutorial && (
        <Card title="Latest documentation finding">
          <p className="text-sm">
            <span className="font-semibold">{finding.tutorial.title}</span>: {finding.classification?.explanation}
          </p>
          <Link to={`/runs/${finding.runId}`} className="mt-2 inline-block text-sm font-medium text-brand hover:underline">
            View evidence
          </Link>
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
                      <StatusBadge run={r} />
                    </td>
                    <td className="py-2 pr-4 text-slate-600">{formatTime(r.startedAt ?? r.createdAt)}</td>
                    <td className="py-2 pr-4 text-slate-600">{r.credits ?? '–'}</td>
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
