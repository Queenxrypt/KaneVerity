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

export type RunKindName = 'verification' | 'exploration' | 'retest';

/**
 * Kane Assurance commands (B2+). Off by default: nothing starts Kane Assurance
 * until the validation runs are approved and this is switched on explicitly.
 *   off  - no Assurance command runs at all
 *   free - only commands that use no credits (land files, list, cover)
 *   all  - every allow-listed command, each still needing an explicit confirmation
 */
export type AssuranceMode = 'off' | 'free' | 'all';
function assuranceMode(v: string | undefined): AssuranceMode {
  return v === 'free' || v === 'all' ? v : 'off';
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
    /**
     * Estimated cost range per run kind, shown before a run is confirmed.
     * Estimates only (from observed runs on this demo), never limits. The upper
     * bound also labels the estimate recorded when Kane reports no cost for a
     * run that did agent work. Actual Kane-reported costs are recorded separately.
     */
    estimatedCreditsByKind: Record<RunKindName, [number, number]>;
  };
  /**
   * D1: the only folder corrections may write to (the local demo docs source).
   * Files are addressed by their docs source reference, e.g. "tutorials/x.md".
   */
  docsContentDir: string;
  claude: { exe: string | null; maxBudgetUsd: number; timeoutMs: number };
  discovery: { maxPages: number; maxBytes: number; timeoutMs: number };
  assurance: {
    mode: AssuranceMode;
    /** Kane CLI version every Assurance job checks before running (B1-B6 pin). */
    pinnedVersion: string;
    /** Folder holding the local Assurance store (.context/) and .testmuai/. */
    workspaceDir: string;
    /** A job still running after this long is stopped. */
    timeoutMs: number;
    /** Longest free-text answer to a Kane question. */
    maxAnswerLength: number;
  };
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

/** Locate the Claude Code executable so it can be started directly (no shell). */
export function resolveClaudeExe(): string | null {
  const candidates = [
    process.env.KANEVERITY_CLAUDE_EXE,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe') : undefined,
    path.join('/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude'),
    path.join('/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude'),
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
    estimatedCreditsByKind: {
      verification: [12, 35],
      retest: [12, 35],
      // More agent actions (store heading, find the route, assert every outcome).
      exploration: [20, 40],
    },
  },
  docsContentDir: process.env.KANEVERITY_DOCS_CONTENT_DIR || path.join(REPO_ROOT, 'apps', 'docs', 'content'),
  claude: { exe: resolveClaudeExe(), maxBudgetUsd: 1, timeoutMs: 180_000 },
  discovery: { maxPages: 50, maxBytes: 1_000_000, timeoutMs: 10_000 },
  assurance: {
    mode: assuranceMode(process.env.KANEVERITY_ASSURANCE_MODE),
    pinnedVersion: '0.10.5',
    workspaceDir: path.join(process.env.KANEVERITY_DATA_DIR || path.join(REPO_ROOT, 'data'), 'assurance', 'workspace'),
    timeoutMs: Number(process.env.KANEVERITY_ASSURANCE_TIMEOUT_MS) || 30 * 60_000,
    maxAnswerLength: 500,
  },
};

/** Estimated credit range for a run kind (an estimate, never a limit). */
export function estimateRange(kind: RunKindName = 'verification'): [number, number] {
  return config.kane.estimatedCreditsByKind[kind] ?? config.kane.estimatedCreditsByKind.verification;
}

/** Estimate recorded when Kane reports no cost for a run that did agent work (upper bound of its kind). */
export function unreportedEstimate(kind: RunKindName = 'verification'): number {
  return estimateRange(kind)[1];
}
