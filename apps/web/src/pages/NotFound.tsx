import { Link } from 'react-router-dom';
import { Card } from '../components/ui.tsx';

export function NotFound() {
  return (
    <Card title="Page not found">
      <Link to="/" className="text-sm text-brand hover:underline">
        Back to the dashboard
      </Link>
    </Card>
  );
}
