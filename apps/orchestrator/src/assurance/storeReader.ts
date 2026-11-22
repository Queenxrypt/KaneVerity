// Read-only reader for Kane's local Assurance store (Assurance B3).
//
// Kane 0.10.5 documents the commands to inspect a store (list, view, explain, fsck)
// but not the record format. The citation quotes and claims KaneVerity must check
// exist only in the committed records, so this reader reads them, read-only, and
// only accepts exactly the format validated against the real V1 store
// (docs/ASSURANCE_PLAN.md, section 12.2):
//   meta.json      {schema: "assurance/context@1", canonicalizer: "v1"}
//   commits/NNNNNN-<hash12>.json   append-only records with seq, prev_hash,
//                  schema_version, created_by.build, nodes[{cid,label,content}],
//                  edges[{type:"DERIVES", src, dst, props{source_id, source_cid,
//                  anchor, quote, claim?}}]
//   blobs/<2>/<62>  source snapshots
// Anything else is refused, never guessed. Kane's own hash verification is done by
// `context fsck` (the canonicalizer is not documented), which the caller runs first.
// Nothing is ever written to the store.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const SUPPORTED_SCHEMA = 'assurance/context@1';
export const SUPPORTED_CANONICALIZER = 'v1';

export interface StoreUseCase {
  cid: string;
  content: {
    title: string;
    description: string;
    summary: string;
    value: string;
    risk: string;
    actors: string[];
    criteria: string[];
  };
  mintedSeq: number;
  proposalId: string | null;
  citations: { anchor: string; quote: string; claim: string | null; sourceId: string; sourceCid: string; srcCid: string }[];
}

export interface StoreSource {
  cid: string;
  sourceId: string;
  blob: string;
}

export interface KaneVerdict {
  proposalId: string;
  resolution: string;
  /** Who Kane says recorded it (informational only; never a KaneVerity review). */
  attributedTo: string;
}

export interface StoreRead {
  ok: boolean;
  problems: string[];
  records: number;
  /** Hash prefix (12 hex) of the last commit, from its file name. */
  tipPrefix: string | null;
  builds: string[];
  sources: StoreSource[];
  useCases: StoreUseCase[];
  kaneVerdicts: KaneVerdict[];
}

const HEX64 = /^sha256:[a-f0-9]{64}$/;
const COMMIT_FILE = /^([0-9]{6})-([a-f0-9]{12})\.json$/;
const str = (v: unknown) => (typeof v === 'string' ? v : null);

async function readJsonFile(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}

/** Path of a blob inside the store, from its "sha256:<hex>" id (validated). */
export function blobPath(storeDir: string, blob: string): string {
  if (!HEX64.test(blob)) throw new Error('Invalid blob id.');
  const hex = blob.slice('sha256:'.length);
  return path.join(storeDir, 'blobs', hex.slice(0, 2), hex.slice(2));
}

export async function readStore(storeDir: string, pinnedBuild: string): Promise<StoreRead> {
  const problems: string[] = [];
  const out: StoreRead = { ok: false, problems, records: 0, tipPrefix: null, builds: [], sources: [], useCases: [], kaneVerdicts: [] };
  let meta: Record<string, unknown>;
  try {
    meta = (await readJsonFile(path.join(storeDir, 'meta.json'))) as Record<string, unknown>;
  } catch {
    problems.push('The store has no readable meta.json.');
    return out;
  }
  if (meta.schema !== SUPPORTED_SCHEMA || meta.canonicalizer !== SUPPORTED_CANONICALIZER) {
    problems.push(`Unsupported store format (${String(meta.schema)}, canonicalizer ${String(meta.canonicalizer)}); KaneVerity supports ${SUPPORTED_SCHEMA} / ${SUPPORTED_CANONICALIZER}.`);
    return out;
  }

  const files = (await readdir(path.join(storeDir, 'commits')).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort();
  const nodes = new Map<string, { label: string; content: Record<string, unknown>; seq: number; proposalId: string | null }>();
  const edges: { src: string; dst: string; props: Record<string, unknown> }[] = [];
  let prevPrefix: string | null = null;
  const builds = new Set<string>();
  for (let i = 0; i < files.length; i++) {
    const m = COMMIT_FILE.exec(files[i]);
    if (!m) {
      problems.push(`Unexpected file in commits/: ${files[i]}.`);
      continue;
    }
    const seq = Number(m[1]);
    let c: Record<string, unknown>;
    try {
      c = (await readJsonFile(path.join(storeDir, 'commits', files[i]))) as Record<string, unknown>;
    } catch {
      problems.push(`Commit ${files[i]} is not readable JSON.`);
      continue;
    }
    if (c.seq !== seq || seq !== i + 1) problems.push(`Commit ${files[i]} is out of sequence.`);
    if (c.schema_version !== SUPPORTED_SCHEMA) problems.push(`Commit ${seq} has an unsupported schema (${String(c.schema_version)}).`);
    const prev = str(c.prev_hash);
    if (i === 0 ? prev !== null : !prev || !prevPrefix || !prev.startsWith(`sha256:${prevPrefix}`)) problems.push(`Commit ${seq} does not link to the previous commit.`);
    const build = str((c.created_by as Record<string, unknown> | undefined)?.build);
    if (build) builds.add(build);
    if (build !== pinnedBuild) problems.push(`Commit ${seq} was written by Kane ${build ?? 'unknown'}, not the pinned ${pinnedBuild}.`);
    prevPrefix = m[2];
    for (const n of Array.isArray(c.nodes) ? c.nodes : []) {
      const node = n as Record<string, unknown>;
      const cid = str(node.cid);
      if (!cid || !HEX64.test(cid) || typeof node.label !== 'string' || !node.content || typeof node.content !== 'object') {
        problems.push(`Commit ${seq} has a node in an unexpected shape.`);
        continue;
      }
      nodes.set(cid, { label: node.label, content: node.content as Record<string, unknown>, seq, proposalId: str(c.proposal_id) });
    }
    for (const e of Array.isArray(c.edges) ? c.edges : []) {
      const edge = e as Record<string, unknown>;
      if (edge.type !== 'DERIVES') continue;
      const src = str(edge.src);
      const dst = str(edge.dst);
      if (!src || !dst || !edge.props || typeof edge.props !== 'object') {
        problems.push(`Commit ${seq} has a citation in an unexpected shape.`);
        continue;
      }
      edges.push({ src, dst, props: edge.props as Record<string, unknown> });
    }
  }
  out.records = files.length;
  out.tipPrefix = prevPrefix;
  out.builds = [...builds];

  for (const [cid, n] of nodes) {
    if (n.label === 'source') {
      const sourceId = str(n.content.source_id);
      const blob = str(n.content.blob);
      if (!sourceId || !blob || !HEX64.test(blob)) problems.push(`Source node ${cid.slice(0, 19)} is in an unexpected shape.`);
      else out.sources.push({ cid, sourceId, blob });
    } else if (n.label === 'usecase') {
      const c = n.content;
      const criteria = Array.isArray(c.criteria) ? c.criteria.filter((x): x is string => typeof x === 'string') : [];
      const actors = Array.isArray(c.actors) ? c.actors.filter((x): x is string => typeof x === 'string') : [];
      const title = str(c.title);
      if (!title) {
        problems.push(`Use case ${cid.slice(0, 19)} has no title.`);
        continue;
      }
      out.useCases.push({
        cid,
        content: { title, description: str(c.description) ?? '', summary: str(c.summary) ?? '', value: str(c.value) ?? '', risk: str(c.risk) ?? '', actors, criteria },
        mintedSeq: n.seq,
        proposalId: n.proposalId,
        citations: edges
          .filter((e) => e.dst === cid)
          .map((e) => ({
            anchor: str(e.props.anchor) ?? '',
            quote: str(e.props.quote) ?? '',
            claim: str(e.props.claim),
            sourceId: str(e.props.source_id) ?? '',
            sourceCid: str(e.props.source_cid) ?? '',
            srcCid: e.src,
          })),
      });
    }
  }

  // Kane's own review records in proposals/: informational only.
  for (const dir of await readdir(path.join(storeDir, 'proposals')).catch(() => [] as string[])) {
    if (!/^[0-9T]+-[a-z0-9-]+$/.test(dir)) continue;
    const r = await readJsonFile(path.join(storeDir, 'proposals', dir, 'review.json')).catch(() => null);
    if (!Array.isArray(r)) continue;
    for (const v of r) {
      const by = (v as Record<string, unknown>).by as Record<string, unknown> | undefined;
      out.kaneVerdicts.push({ proposalId: dir, resolution: str((v as Record<string, unknown>).resolution) ?? 'unknown', attributedTo: `${str(by?.kind) ?? '?'}:${str(by?.id) ?? '?'}` });
    }
  }

  out.ok = problems.length === 0;
  return out;
}
