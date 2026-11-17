import { useEffect, type ReactNode } from 'react';

interface PageHeaderProps {
  /** Visible page heading. Matches the sidebar label so docs and Kane can reference it exactly. */
  title: string;
  description?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  useEffect(() => {
    document.title = `${title} · AcmeDesk`;
  }, [title]);

  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
