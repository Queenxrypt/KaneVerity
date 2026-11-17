import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  createSeedState,
  fakeKeyValue,
  type ApiKey,
  type Member,
  type Project,
  type Role,
  type Workspace,
  type WorkspaceState,
} from '../data/seed';

// In-memory store only. No backend, no localStorage: a reload or a new browser
// session always returns to the seed state, which keeps Kane runs repeatable.

interface WorkspaceActions {
  createProject(name: string): Project;
  inviteMember(email: string, role: Role): Member;
  generateApiKey(): ApiKey;
  saveWorkspace(next: Workspace): void;
}

type WorkspaceContextValue = WorkspaceState & WorkspaceActions;

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function nextId(items: { id: number }[]): number {
  return items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WorkspaceState>(createSeedState);

  const value = useMemo<WorkspaceContextValue>(() => {
    return {
      ...state,
      createProject(name) {
        const project: Project = {
          id: nextId(state.projects),
          name,
          status: 'Planning',
          owner: 'You',
        };
        setState((s) => ({ ...s, projects: [...s.projects, project] }));
        return project;
      },
      inviteMember(email, role) {
        const member: Member = {
          id: nextId(state.members),
          name: email.split('@')[0],
          email,
          role,
          status: 'Invited',
        };
        setState((s) => ({ ...s, members: [...s.members, member] }));
        return member;
      },
      generateApiKey() {
        const id = nextId(state.apiKeys);
        const key: ApiKey = {
          id,
          name: `Generated key ${id}`,
          value: fakeKeyValue(id),
          created: 'Just now',
        };
        setState((s) => ({ ...s, apiKeys: [...s.apiKeys, key] }));
        return key;
      },
      saveWorkspace(next) {
        setState((s) => ({ ...s, workspace: next }));
      },
    };
  }, [state]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used inside <WorkspaceProvider>');
  return ctx;
}
