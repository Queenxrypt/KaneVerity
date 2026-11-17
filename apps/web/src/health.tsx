import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import type { Health } from './types.ts';

interface HealthState {
  health: Health | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const HealthContext = createContext<HealthState | null>(null);

export function HealthProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setHealth(await api.health());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  return <HealthContext.Provider value={{ health, error, loading, refresh }}>{children}</HealthContext.Provider>;
}

export function useHealth(): HealthState {
  const ctx = useContext(HealthContext);
  if (!ctx) throw new Error('useHealth must be used inside <HealthProvider>');
  return ctx;
}
