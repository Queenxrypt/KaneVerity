// Read the parts of a Kane evidence pack that KaneVerity needs: per-step
// status, summary and URL (from step.json), failure messages, and step
// screenshots (as in-memory buffers). Nothing is extracted by archive path.

import { readFile } from 'node:fs/promises';
import { isJpeg, readEntry, readIndex, ZipError } from './zip.ts';

export interface EvidenceStep {
  ordinal: number;
  id: string;
  kind: string;
  status: string;
  summary: string;
  url: string | null;
}

export interface EvidenceScreenshot {
  ordinal: number;
  data: Buffer;
}

export interface EvidenceSummary {
  valid: boolean;
  problems: string[];
  rejectedEntries: string[];
  testCount: number;
  steps: EvidenceStep[];
  failureTitle: string | null;
  failureMessage: string | null;
  screenshots: EvidenceScreenshot[];
}

const MAX_SCREENSHOTS = 40;

function yamlScalar(text: string, key: string): string | null {
  // Small, conservative reader for "key: value" and folded multi-line values in
  // Kane's failure.yaml. Never evaluates anything.
  const m = new RegExp(`^(\\s*)${key}:[ \\t]*(.*)$`, 'm').exec(text);
  if (!m) return null;
  const indent = m[1].length;
  const lines = [m[2]];
  const rest = text.slice(m.index + m[0].length).split('\n').slice(1);
  for (const l of rest) {
    const lead = /^(\s*)/.exec(l)![1].length;
    if (!l.trim() || lead <= indent || /^\s*[a-z_]+:/.test(l)) break;
    lines.push(l.trim());
  }
  return lines.join(' ').replace(/^['"]|['"]$/g, '').trim() || null;
}

export async function readEvidence(packPath: string): Promise<EvidenceSummary> {
  const summary: EvidenceSummary = {
    valid: false,
    problems: [],
    rejectedEntries: [],
    testCount: 0,
    steps: [],
    failureTitle: null,
    failureMessage: null,
    screenshots: [],
  };
  let buf: Buffer;
  try {
    buf = await readFile(packPath);
  } catch {
    summary.problems.push('Evidence pack could not be read.');
    return summary;
  }
  try {
    const { entries, rejected } = readIndex(buf);
    summary.rejectedEntries = rejected;
    if (rejected.length) summary.problems.push(`${rejected.length} unexpected entr${rejected.length === 1 ? 'y was' : 'ies were'} ignored.`);
    const tests = new Set([...entries.keys()].map((n) => /^tests\/([^/]+)\//.exec(n)?.[1]).filter(Boolean));
    summary.testCount = tests.size;

    for (const [name, entry] of entries) {
      const stepJson = /^tests\/[^/]+\/steps\/([0-9]+)-[0-9-]+\/step\.json$/.exec(name);
      if (stepJson) {
        try {
          const s = JSON.parse(readEntry(buf, entry).toString('utf8')) as Record<string, unknown>;
          summary.steps.push({
            ordinal: Number(s.ordinal ?? stepJson[1]),
            id: String(s.id ?? ''),
            kind: String(s.kind ?? ''),
            status: String(s.status ?? ''),
            summary: String(s.summary ?? ''),
            url: typeof s.url === 'string' ? s.url : null,
          });
        } catch {
          summary.problems.push(`Unreadable step record: ${name}`);
        }
        continue;
      }
      const shot = /^tests\/[^/]+\/steps\/([0-9]+)-[0-9-]+\/screenshot\.jpg$/.exec(name);
      if (shot && summary.screenshots.length < MAX_SCREENSHOTS) {
        const data = readEntry(buf, entry);
        if (isJpeg(data)) summary.screenshots.push({ ordinal: Number(shot[1]), data });
        else summary.problems.push(`Screenshot is not a JPEG: ${name}`);
        continue;
      }
      if (/^tests\/[^/]+\/steps\/[^/]+\/failure\.yaml$/.test(name)) {
        const y = readEntry(buf, entry).toString('utf8');
        summary.failureTitle ??= yamlScalar(y, 'title');
        summary.failureMessage ??= yamlScalar(y, 'message');
      }
    }
    summary.steps.sort((a, b) => a.ordinal - b.ordinal);
    summary.screenshots.sort((a, b) => a.ordinal - b.ordinal);
    summary.valid = summary.testCount > 0 && summary.steps.length > 0;
    if (!summary.valid) summary.problems.push('Evidence pack has no step records.');
  } catch (err) {
    summary.problems.push(err instanceof ZipError ? err.message : 'Evidence pack could not be parsed.');
  }
  return summary;
}
