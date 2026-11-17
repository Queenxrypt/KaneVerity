// Orchestrator configuration. Secrets are never stored here: Kane authentication
// lives in Kane's own profile, and .env only holds machine settings.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

try {
  process.loadEnvFile(path.join(REPO_ROOT, '.env'));
} catch {
  // .env is optional.
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface Config {
  host: string;
  port: number;
  /** Origins allowed to call mutating API routes (the KaneVerity UI). */
  uiOrigins: string[];
  /** Hosts accepted in the Host header (DNS-rebinding protection). */
  allowedHosts: string[];
  /**
   * MVP restriction: live verification runs only against these exact origins
   * (the controlled local AcmeDesk demo and its docs). Arbitrary third-party
   * documentation is not supported for live execution yet.
   */
  allowedDocsOrigins: string[];
  allowedAppOrigins: string[];
  dataDir: string;
  kane: {
    entry: string | null;
    timeoutSec: number;
    maxSteps: number;
    graceMs: number;
    testedVersion: string;
    estimatedCreditsPerRun: number;
  };
  credits: { hardLimit: number };
  discovery: { maxPages: number; maxBytes: number; timeoutMs: number };
}

/** Locate Kane CLI's JS entry so it can be run with `node` directly (no shell). */
export function resolveKaneEntry(): string | null {
  const rel = path.join('@testmuai', 'kane-cli', 'bin', 'kane-cli.cjs');
  const candidates = [
    process.env.KANE_CLI_ENTRY,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', rel) : undefined,
    path.join('/usr/local/lib/node_modules', rel),
    path.join('/usr/lib/node_modules', rel),
    process.env.HOME ? path.join(process.env.HOME, '.npm-global', 'lib', 'node_modules', rel) : undefined,
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

export const config: Config = {
  host: '127.0.0.1',
  port: Number(process.env.KANEVERITY_PORT) || 4000,
  uiOrigins: list(process.env.KANEVERITY_UI_ORIGINS, ['http://127.0.0.1:5173', 'http://localhost:5173']),
  allowedHosts: ['127.0.0.1:4000', 'localhost:4000'],
  allowedDocsOrigins: list(process.env.KANEVERITY_ALLOWED_DOCS_ORIGINS, ['http://127.0.0.1:5175']),
  allowedAppOrigins: list(process.env.KANEVERITY_ALLOWED_APP_ORIGINS, ['http://127.0.0.1:5174']),
  dataDir: process.env.KANEVERITY_DATA_DIR || path.join(REPO_ROOT, 'data'),
  kane: {
    entry: resolveKaneEntry(),
    timeoutSec: 300,
    maxSteps: 30,
    graceMs: 60_000,
    testedVersion: '0.10.5',
    estimatedCreditsPerRun: 35,
  },
  credits: { hardLimit: Number(process.env.KANEVERITY_CREDIT_LIMIT) || 100 },
  discovery: { maxPages: 50, maxBytes: 1_000_000, timeoutMs: 10_000 },
};
