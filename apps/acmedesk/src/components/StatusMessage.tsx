import type { ReactNode } from 'react';

interface StatusMessageProps {
  /** Stable hook for automation and tests, e.g. "api-key-status". */
  testId: string;
  tone?: 'success' | 'error';
  children?: ReactNode;
}

/**
 * Persistent inline confirmation or error.
 *
 * The live region container is always rendered, so screen readers and
 * automation see content appear inside an existing role="status"/"alert"
 * element. Messages never auto-dismiss: they stay until the next action
 * replaces them, giving Kane time to observe the outcome.
 */
export function StatusMessage({ testId, tone = 'success', children }: StatusMessageProps) {
  const isError = tone === 'error';
  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      data-testid={testId}
      className={children ? `status status-${tone}` : 'status-empty'}
    >
      {children}
    </div>
  );
}
