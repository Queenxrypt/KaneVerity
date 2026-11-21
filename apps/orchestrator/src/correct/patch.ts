// Applying, diffing and writing corrections. All writes are guarded by the
// file fingerprint: if the file is not exactly what was reviewed, nothing is
// written.

import { createHash } from 'node:crypto';
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';
import { parseDoc } from '../../../docs/src/markdown.ts';
import type { Edit } from './store.ts';

export class PatchError extends Error {}

export const DOC_FILE_PATTERN = /^(tutorials|guides)\/[a-z0-9-]+\.md$/;

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** D1: resolve a docs source reference inside the allow-listed content folder only. */
export function docsFilePath(file: string, contentDir = config.docsContentDir): string {
  if (!DOC_FILE_PATTERN.test(file)) throw new PatchError(`Not a documentation source file: ${file}`);
  const root = path.resolve(contentDir);
  const full = path.resolve(root, file);
  if (!full.startsWith(root + path.sep)) throw new PatchError('Path escapes the documentation folder.');
  return full;
}

export function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

export function numbered(text: string): string {
  return splitLines(text)
    .map((l, i) => `${String(i + 1).padStart(3, ' ')}| ${l}`)
    .join('\n');
}

/** First and last line (1-based) of the Steps list, and the outcome lines. */
export function regions(text: string, file: string): { stepFirst: number; stepLast: number; outcomeLines: number[]; outcomes: string[]; steps: string[] } {
  const doc = parseDoc(text, file);
  if (doc.steps.length === 0) throw new PatchError('The tutorial has no Steps list.');
  return {
    stepFirst: doc.steps[0].line,
    stepLast: doc.steps[doc.steps.length - 1].line,
    outcomeLines: doc.outcomes.map((o) => o.line),
    outcomes: doc.outcomes.map((o) => o.text),
    steps: doc.steps.map((s) => s.text),
  };
}

/** Normalise Claude's step text: drop any leading number, trim. */
export function stepText(raw: string): string {
  return raw.replace(/^\s*\d+[.)]\s*/, '').trim();
}

/**
 * Apply edits (ORIGINAL line numbers) inside the Steps list and renumber it.
 * Callers must validate edits first (validate.ts).
 */
export function applyEdits(text: string, edits: Edit[], file: string): string {
  const lines = splitLines(text);
  const { stepFirst, stepLast } = regions(text, file);
  const replace = new Map<number, string>();
  const del = new Set<number>();
  const insert = new Map<number, string[]>();
  for (const e of edits) {
    if (e.line < stepFirst || e.line > stepLast) throw new PatchError(`Line ${e.line} is outside the Steps list.`);
    if (e.action === 'replace') replace.set(e.line, stepText(e.newText));
    else if (e.action === 'delete') del.add(e.line);
    else insert.set(e.line, [...(insert.get(e.line) ?? []), stepText(e.newText)]);
  }
  const out: string[] = [];
  const stepLines: number[] = [];
  lines.forEach((l, i) => {
    const n = i + 1;
    const inSteps = n >= stepFirst && n <= stepLast;
    if (inSteps && !del.has(n)) {
      if (replace.has(n)) {
        stepLines.push(out.length);
        out.push(`0. ${replace.get(n)}`);
      } else {
        if (/^\d+\.\s/.test(l)) stepLines.push(out.length);
        out.push(l);
      }
    } else if (!inSteps) {
      out.push(l);
    }
    for (const t of insert.get(n) ?? []) {
      stepLines.push(out.length);
      out.push(`0. ${t}`);
    }
  });
  stepLines.forEach((idx, k) => {
    out[idx] = out[idx].replace(/^\d+\.\s/, `${k + 1}. `);
  });
  return out.join('\n');
}

/** Minimal unified diff (LCS). Tutorials are small, so O(n*m) is fine. */
export function unifiedDiff(a: string, b: string, name: string, context = 3): string {
  const A = splitLines(a);
  const B = splitLines(b);
  const n = A.length;
  const m = B.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  type Op = { t: ' ' | '-' | '+'; s: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) ops.push({ t: ' ', s: A[i], ai: i++, bi: j++ });
    // Prefer deletions before additions (conventional, easier to read).
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push({ t: '-', s: A[i], ai: i++, bi: j });
    else ops.push({ t: '+', s: B[j], ai: i, bi: j++ });
  }
  const changed = ops.map((o, k) => (o.t !== ' ' ? k : -1)).filter((k) => k >= 0);
  if (changed.length === 0) return '';
  const out = [`--- a/${name}`, `+++ b/${name}`];
  let k = 0;
  while (k < changed.length) {
    let start = Math.max(0, changed[k] - context);
    let end = Math.min(ops.length - 1, changed[k] + context);
    while (k + 1 < changed.length && changed[k + 1] - context <= end + 1) {
      k++;
      end = Math.min(ops.length - 1, changed[k] + context);
    }
    const hunk = ops.slice(start, end + 1);
    const aStart = hunk[0].ai + 1;
    const bStart = hunk[0].bi + 1;
    const aLen = hunk.filter((o) => o.t !== '+').length;
    const bLen = hunk.filter((o) => o.t !== '-').length;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const o of hunk) out.push(`${o.t}${o.s}`);
    k++;
    start = end;
  }
  return out.join('\n');
}

/** Write `next` only if the file currently has fingerprint `expectedSha`. Keeps a backup. */
export async function guardedWrite(file: string, expectedSha: string, next: string, backupDir: string): Promise<void> {
  const full = docsFilePath(file);
  const current = await readFile(full, 'utf8');
  if (sha256(current) !== expectedSha) throw new PatchError('The documentation file changed since it was reviewed. Nothing was written.');
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, `backup-${Date.now()}.md`), current, 'utf8');
  const tmp = `${full}.${process.pid}.kvtmp`;
  await writeFile(tmp, next, 'utf8');
  await rename(tmp, full);
}

export async function readDocFile(file: string): Promise<string> {
  return readFile(docsFilePath(file), 'utf8');
}
