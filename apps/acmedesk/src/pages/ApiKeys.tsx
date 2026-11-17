import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { StatusMessage } from '../components/StatusMessage';
import type { ApiKey } from '../data/seed';
import { useWorkspace } from '../state/workspace';

export function ApiKeys() {
  const { apiKeys, generateApiKey } = useWorkspace();
  const [latest, setLatest] = useState<ApiKey | null>(null);

  return (
    <>
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link to="/developer">Developer Settings</Link> <span aria-hidden="true">/</span> <span>API Keys</span>
      </nav>
      <PageHeader
        title="API Keys"
        description="Keys for the AcmeDesk API. All keys in this demo are fake and cannot be used anywhere."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setLatest(generateApiKey())}>
            Generate Key
          </button>
        }
      />

      <StatusMessage testId="api-key-status">
        {latest && (
          <>
            <strong>API key generated successfully.</strong>{' '}
            <span>
              New key: <code data-testid="api-key-value">{latest.value}</code> (demo value, not a real credential)
            </span>
          </>
        )}
      </StatusMessage>

      <table className="table" aria-label="API keys list">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Key</th>
            <th scope="col">Created</th>
          </tr>
        </thead>
        <tbody>
          {apiKeys.map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td>
                <code>{k.value}</code>
              </td>
              <td>{k.created}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small" data-testid="api-key-count">
        {apiKeys.length} {apiKeys.length === 1 ? 'key' : 'keys'}
      </p>
    </>
  );
}
