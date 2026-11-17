import { Link, useLocation } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';

// Old or mistyped URLs (for example a link from outdated docs) land here with a
// clear message instead of a blank page, which gives Kane readable evidence.
export function NotFound() {
  const { pathname } = useLocation();
  return (
    <>
      <PageHeader title="Page not found" description={`There is no page at ${pathname}.`} />
      <p>
        <Link to="/">Go to Dashboard</Link>
      </p>
    </>
  );
}
