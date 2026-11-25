// Read-only reader for the test-design part of Kane's local Assurance store (B5).
//
// Kane 0.10.5 writes test design as append-only records (verified on the real store,
// records 4-7, and in Kane's bundled code; docs/ASSURANCE_PLAN.md section 13):
//   nodes[{cid, label: ac|scenario|test|gap, content}]
//   edges[{ecid, type: scoped_to|belongs_to|exercises|automates|verifies|DERIVES, src, dst, props}]
//   names[{cid, slug, by}]                 the short ids (ac-1, sc-1, t-1, gap-1)
//   supersessions[{kind: "node", old, new|null, reason, by} | {kind: "edge", ecid, reason, by}]
//   design_phase {uc_root, generation, phase, completeness, payload_digest}
//   design_generation {uc_root, uc_cid, generation, supersedes_generation, ...}
// Only these shapes are accepted; anything else is reported as a problem, never
// guessed. Nothing is ever written to the store. Kane's own hash checks are done by
// `context fsck`, which the caller runs first; this reader only links the records.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const HEX64 = /^sha256:[a-f0-9]{64}$/;
const COMMIT_FILE = /^([0-9]{6})-([a-f0-9]{12})\.json$/;
const SLUG = /^[a-z]+-[0-9]+$/;
export const DESIGN_LABELS = new Set(['ac', 'scenario', 'test', 'gap']);
export const DESIGN_EDGE_TYPES = new Set(['scoped_to', 'belongs_to', 'exercises', 'automates', 'verifies']);
const PHASES = new Set(['acs', 'scenarios', 'wiring', 'tests']);

export interface DesignRecord {
  seq: number;
  /** 12-hex prefix from the file name. */
  prefix: string;
  /** Full hash: the next record's prev_hash, or the tip hash from `context view` for the last record. */
  hash: string | null;
  prevHash: string | null;
  intentVerb: string | null;
  build: string | null;
  createdBy: string | null;
  designPhase: { ucRoot: string; generation: number; phase: string; completeness: string | null } | null;
  designGeneration: { ucRoot: string; generation: number; supersedesGeneration: number | null } | null;
}

export interface GraphNode {
  cid: string;
  label: string;
  content: Record<string, unknown>;
  /** Record that minted it. */
  seq: number;
}

export interface GraphEdge {
  ecid: string | null;
  type: string;
  src: string;
  dst: string;
  seq: number;
}

export interface DesignGraph {
  problems: string[];
  records: DesignRecord[];
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  /** Superseded node -> its successor (null: retired with no successor), with the record. */
  supersededNodes: Map<string, { next: string | null; seq: number; reason: string }>;
  /** Edge ids retired by a supersession. */
  retiredEdges: Set<string>;
  /** Short id -> the content ids it has named, oldest first. */
  names: Map<string, string[]>;
  /** Content id -> its short id. */
  slugOf: Map<string, string>;
}

const str = (v: unknown) => (typeof v === 'string' ? v : null);
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export async function readDesignGraph(storeDir: string, tipHash: string | null): Promise<DesignGraph> {
  const g: DesignGraph = { problems: [], records: [], nodes: new Map(), edges: [], supersededNodes: new Map(), retiredEdges: new Set(), names: new Map(), slugOf: new Map() };
  const files = (await readdir(path.join(storeDir, 'commits')).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort();
  const raw: { seq: number; prefix: string; c: Record<string, unknown> }[] = [];
  for (const f of files) {
    const m = COMMIT_FILE.exec(f);
    if (!m) {
      g.problems.push(`Unexpected file in commits/: ${f}.`);
      continue;
    }
    try {
      const c = obj(JSON.parse(await readFile(path.join(storeDir, 'commits', f), 'utf8')));
      if (!c) throw new Error('not an object');
      raw.push({ seq: Number(m[1]), prefix: m[2], c });
    } catch {
      g.problems.push(`Commit ${f} is not readable JSON.`);
    }
  }
  raw.forEach((r, i) => {
    if (r.seq !== i + 1 || r.c.seq !== r.seq) g.problems.push(`Commit ${r.seq} is out of sequence.`);
    const prev = str(r.c.prev_hash);
    const next = raw[i + 1] ? str(raw[i + 1].c.prev_hash) : tipHash;
    const hash = next && HEX64.test(next) && next.startsWith(`sha256:${r.prefix}`) ? next : null;
    if (!hash) g.problems.push(`The full hash of record ${r.seq} could not be established.`);
    const dp = obj(r.c.design_phase);
    const dg = obj(r.c.design_generation);
    let designPhase: DesignRecord['designPhase'] = null;
    if (dp) {
      const ucRoot = str(dp.uc_root);
      const phase = str(dp.phase);
      if (!ucRoot || !HEX64.test(ucRoot) || typeof dp.generation !== 'number' || !phase || !PHASES.has(phase)) g.problems.push(`Record ${r.seq} has a design phase in an unexpected shape.`);
      else designPhase = { ucRoot, generation: dp.generation, phase, completeness: str(dp.completeness) };
    }
    let designGeneration: DesignRecord['designGeneration'] = null;
    if (dg) {
      const ucRoot = str(dg.uc_root);
      const sup = dg.supersedes_generation;
      if (!ucRoot || !HEX64.test(ucRoot) || typeof dg.generation !== 'number' || !(sup === null || typeof sup === 'number')) g.problems.push(`Record ${r.seq} has a design generation in an unexpected shape.`);
      else designGeneration = { ucRoot, generation: dg.generation, supersedesGeneration: sup as number | null };
    }
    const cb = obj(r.c.created_by);
    const by = obj(cb?.by);
    g.records.push({
      seq: r.seq,
      prefix: r.prefix,
      hash,
      prevHash: prev,
      intentVerb: str(r.c.intent_verb),
      build: str(cb?.build),
      createdBy: by ? `${String(by.kind)}:${String(by.id)}` : null,
      designPhase,
      designGeneration,
    });

    for (const n of Array.isArray(r.c.nodes) ? r.c.nodes : []) {
      const node = obj(n);
      const cid = str(node?.cid);
      const content = obj(node?.content);
      if (!node || !cid || !HEX64.test(cid) || typeof node.label !== 'string' || !content) {
        g.problems.push(`Record ${r.seq} has a node in an unexpected shape.`);
        continue;
      }
      if (!g.nodes.has(cid)) g.nodes.set(cid, { cid, label: node.label, content, seq: r.seq });
    }
    for (const e of Array.isArray(r.c.edges) ? r.c.edges : []) {
      const edge = obj(e);
      const src = str(edge?.src);
      const dst = str(edge?.dst);
      if (!edge || typeof edge.type !== 'string' || !src || !dst) {
        g.problems.push(`Record ${r.seq} has an edge in an unexpected shape.`);
        continue;
      }
      if (edge.type === 'DERIVES') continue;
      if (!DESIGN_EDGE_TYPES.has(edge.type)) {
        g.problems.push(`Record ${r.seq} has an edge of an unknown type (${edge.type}).`);
        continue;
      }
      g.edges.push({ ecid: str(edge.ecid), type: edge.type, src, dst, seq: r.seq });
    }
    if (r.c.names !== undefined) {
      if (!Array.isArray(r.c.names)) g.problems.push(`Record ${r.seq} has names in an unexpected shape.`);
      for (const nm of Array.isArray(r.c.names) ? r.c.names : []) {
        const n = obj(nm);
        const cid = str(n?.cid);
        const slug = str(n?.slug);
        if (!cid || !HEX64.test(cid) || !slug || !SLUG.test(slug)) {
          g.problems.push(`Record ${r.seq} has a name in an unexpected shape.`);
          continue;
        }
        g.names.set(slug, [...(g.names.get(slug) ?? []), cid]);
        g.slugOf.set(cid, slug);
      }
    }
    if (r.c.supersessions !== undefined && !Array.isArray(r.c.supersessions)) g.problems.push(`Record ${r.seq} has supersessions in an unexpected shape.`);
    for (const s of Array.isArray(r.c.supersessions) ? r.c.supersessions : []) {
      const x = obj(s);
      if (x?.kind === 'node' && str(x.old) && HEX64.test(x.old as string) && (x.new === null || (str(x.new) && HEX64.test(x.new as string)))) {
        g.supersededNodes.set(x.old as string, { next: (x.new as string | null) ?? null, seq: r.seq, reason: str(x.reason) ?? '' });
      } else if (x?.kind === 'edge' && str(x.ecid)) {
        g.retiredEdges.add(x.ecid as string);
      } else {
        g.problems.push(`Record ${r.seq} has a supersession in an unexpected shape.`);
      }
    }
  });
  return g;
}

/** A node is live when no supersession has retired it. */
export function isLive(g: DesignGraph, cid: string): boolean {
  return g.nodes.has(cid) && !g.supersededNodes.has(cid);
}

/** Live edges (not retired; both ends live). */
export function liveEdges(g: DesignGraph): GraphEdge[] {
  return g.edges.filter((e) => !(e.ecid && g.retiredEdges.has(e.ecid)) && isLive(g, e.src) && isLive(g, e.dst));
}

/** What a short id such as "sc-1" names now: the live version, a superseded one, or nothing. */
export function resolveSlug(g: DesignGraph, slug: string): { state: 'live' | 'superseded' | 'unknown'; cid: string | null } {
  const cids = g.names.get(slug);
  if (!cids?.length) return { state: 'unknown', cid: null };
  const live = cids.filter((c) => isLive(g, c));
  if (live.length === 1) return { state: 'live', cid: live[0] };
  if (live.length > 1) return { state: 'unknown', cid: null };
  return { state: 'superseded', cid: cids[cids.length - 1] };
}
