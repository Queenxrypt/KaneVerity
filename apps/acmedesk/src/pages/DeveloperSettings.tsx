import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';

export function DeveloperSettings() {
  return (
    <>
      <PageHeader title="Developer Settings" description="Tools for building on the AcmeDesk API." />
      <ul className="link-list" aria-label="Developer tools">
        <li>
          <Link to="/developer/api-keys" className="link-card">
            <span className="link-card-title">API Keys</span>
            <span className="muted">Generate and view keys for the AcmeDesk API.</span>
          </Link>
        </li>
      </ul>
    </>
  );
}
