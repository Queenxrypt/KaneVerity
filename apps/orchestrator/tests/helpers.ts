import { readFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import type { ExtractedItem, Tutorial } from '../src/types.ts';
import type { RunEnd } from '../src/kane/ndjson.ts';
import type { EvidenceStep } from '../src/kane/evidence.ts';

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface Fixture {
  name: string;
  exitCode: number;
  appOrigin: string;
  cliVersion: string | null;
  progress: { step: number; status: string; remark: string }[];
  runEnd: RunEnd;
  evidenceSteps: EvidenceStep[];
  failureMessage: string | null;
}

export function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(path.join(TESTS_DIR, 'fixtures', `${name}.json`), 'utf8')) as Fixture;
}

function item(kaneText: string, i: number, file: string): ExtractedItem {
  const labels = [...kaneText.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  return { index: i + 1, text: kaneText.replace(/'/g, ''), kaneText, labels, ref: { kind: 'markdown', file, line: 10 + i, text: kaneText } };
}

export function tutorial(steps: string[], outcomes: string[], id = 'test-tutorial'): Tutorial {
  return {
    id,
    title: 'Test tutorial',
    url: 'http://127.0.0.1:5175/tutorials/' + id,
    appStart: '/',
    method: 'data-kv',
    sourceSha256: null,
    steps: steps.map((s, i) => item(s, i, `tutorials/${id}.md`)),
    outcomes: outcomes.map((o, i) => item(o, i, `tutorials/${id}.md`)),
    warnings: [],
    notRunnable: null,
  };
}

export const OUTDATED_API_KEY_STEPS = ["On the 'Dashboard', click 'Settings'.", "Click 'API'.", "Click 'Create API Key'."];
export const API_KEY_OUTCOMES = [
  "The message 'API key generated successfully.' appears.",
  'The new key is added to the API keys list.',
  "The key count below the list shows '2 keys'.",
];

/** Build a ZIP archive in memory (test-only). method 0 = stored, 8 = deflate. */
export function makeZip(entries: { name: string; data: Buffer | string; method?: 0 | 8; declaredSize?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const method = e.method ?? 8;
    const comp = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(raw);
    const size = e.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** Smallest valid-looking JPEG header for screenshot tests. */
export const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
