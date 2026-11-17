import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { useWorkspace } from '../state/workspace';

export function Dashboard() {
  const { workspace, projects, members, apiKeys } = useWorkspace();

  const summary = [
    { label: 'Projects', value: projects.length, to: '/projects', testId: 'count-projects' },
    { label: 'Team members', value: members.length, to: '/team', testId: 'count-members' },
    { label: 'API keys', value: apiKeys.length, to: '/developer/api-keys', testId: 'count-api-keys' },
  ];

  return (
    <>
      <PageHeader title="Dashboard" description={`Welcome to ${workspace.name}.`} />
      <section aria-label="Workspace summary" className="summary">
        {summary.map((item) => (
          <Link key={item.label} to={item.to} className="summary-card">
            <span className="summary-value" data-testid={item.testId}>
              {item.value}
            </span>
            <span className="summary-label">{item.label}</span>
          </Link>
        ))}
      </section>
    </>
  );
}
