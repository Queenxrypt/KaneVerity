import { NavLink, Outlet } from 'react-router-dom';
import { useHealth } from './health.tsx';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/connect', label: 'Connect', end: false },
  { to: '/tutorials', label: 'Tutorials', end: false },
  { to: '/corrections', label: 'Corrections', end: false },
];

export function App() {
  const { error } = useHealth();
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-8 gap-y-2 px-4 py-3">
          <div>
            <span className="text-lg font-bold">KaneVerity</span>
            <span className="ml-2 text-sm text-slate-500">Documentation you can trust.</span>
          </div>
          <nav aria-label="Main" className="flex flex-wrap gap-1">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) => `rounded-md px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-brand-soft text-brand' : 'text-slate-700 hover:bg-slate-100'}`}
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      {error && (
        <div role="alert" className="border-b border-fail/30 bg-fail-soft">
          <div className="mx-auto max-w-6xl px-4 py-2 text-sm text-fail">{error}</div>
        </div>
      )}
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
