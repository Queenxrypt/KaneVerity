import { NavLink } from 'react-router-dom';

// Exact labels matter: tutorials and Kane reference these strings verbatim.
// There is intentionally no item labelled just "Settings" or "API".
const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/projects', label: 'Projects', end: false },
  { to: '/team', label: 'Team Members', end: false },
  { to: '/workspace-settings', label: 'Workspace Settings', end: false },
  { to: '/developer', label: 'Developer Settings', end: false },
] as const;

export function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">A</span>
        <span className="brand-name">AcmeDesk</span>
      </div>
      <nav aria-label="Main navigation">
        <ul>
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <p className="demo-note">Demo app with fictional data. Nothing here is real.</p>
    </aside>
  );
}
