// Fixed demo data. Every fresh browser session starts from exactly this state,
// so Kane runs are deterministic. Nothing here is real: names are fictional,
// emails use the reserved example.com domain, and API keys are fake placeholders.

export type Role = 'Admin' | 'Member' | 'Viewer';

export interface Project {
  id: number;
  name: string;
  status: 'Active' | 'Planning';
  owner: string;
}

export interface Member {
  id: number;
  name: string;
  email: string;
  role: Role;
  status: 'Active' | 'Invited';
}

export interface ApiKey {
  id: number;
  name: string;
  /** Fake demo value. Never a real credential. */
  value: string;
  created: string;
}

export interface Workspace {
  name: string;
  timezone: string;
}

export interface WorkspaceState {
  workspace: Workspace;
  projects: Project[];
  members: Member[];
  apiKeys: ApiKey[];
}

/** Prefix that marks every AcmeDesk key as a demo value, not a usable secret. */
export const FAKE_KEY_PREFIX = 'demo_fake_key_';

export function fakeKeyValue(n: number): string {
  return `${FAKE_KEY_PREFIX}${String(n).padStart(4, '0')}`;
}

export const TIMEZONES = ['UTC', 'Europe/London', 'America/New_York', 'Asia/Kolkata'] as const;

export const ROLES: Role[] = ['Admin', 'Member', 'Viewer'];

/** Returns a fresh copy so in-memory changes never mutate the seed. */
export function createSeedState(): WorkspaceState {
  return {
    workspace: { name: 'Acme Demo Workspace', timezone: 'UTC' },
    projects: [
      { id: 1, name: 'Website Redesign', status: 'Active', owner: 'Alex Rivera' },
      { id: 2, name: 'Mobile App Launch', status: 'Active', owner: 'Sam Chen' },
      { id: 3, name: 'Customer Portal', status: 'Planning', owner: 'Jordan Lee' },
    ],
    members: [
      { id: 1, name: 'Alex Rivera', email: 'alex.rivera@example.com', role: 'Admin', status: 'Active' },
      { id: 2, name: 'Sam Chen', email: 'sam.chen@example.com', role: 'Member', status: 'Active' },
      { id: 3, name: 'Jordan Lee', email: 'jordan.lee@example.com', role: 'Viewer', status: 'Active' },
    ],
    apiKeys: [{ id: 1, name: 'Default key', value: fakeKeyValue(1), created: 'Seeded' }],
  };
}
