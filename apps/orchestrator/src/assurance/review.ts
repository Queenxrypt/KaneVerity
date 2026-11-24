// KaneVerity's own human review of extracted use cases (Assurance B3). Pure.
//
// Rules:
// - Only a decision recorded through KaneVerity's review interface counts. Kane's
//   trust state and any verdict Kane records itself (V1: an automatic "skipped"
//   attributed to "owner") are shown for information and never count as review.
// - A decision applies to one exact use-case version (its content id).
// - Decisions are append-only; the latest one is the current state.
// - Rejecting needs a reason. Approving a use case whose citations have gaps needs
//   an explicit acknowledgement, recorded with the decision.
// - Only an approved use case with intact, current material can go to test design.
// - B4: an approval also has to be written to Kane's store and independently
//   verified there (kane_write entries). Only the latest KaneVerity decision,
//   approved, with a verified Kane record for the same use-case content id and
//   Kane's trust "trusted", qualifies. A Kane approval made outside KaneVerity
//   never counts. Rejections stay in KaneVerity; nothing is archived in Kane.
// - The reviewer name is self-declared (KANEVERITY_REVIEWER), never proof of identity.

export type ReviewDecision = 'approved' | 'rejected';
export type ReviewState = 'awaiting_review' | 'approved' | 'rejected';

export interface ReviewEntry {
  /** Decision id (B4). Entries recorded before B4 have none; see decisionIdOf. */
  id?: string;
  ucCid: string;
  decision: ReviewDecision;
  reason: string | null;
  /** The user explicitly acknowledged citation gaps when approving. */
  acknowledgedGaps: boolean;
  /** Citation summary at the time of the decision. */
  gapsAtDecision: { invalid: number; stepsCited: number; steps: number; outcomesCited: number; outcomes: number; hasGaps: boolean };
  snapshot: number;
  at: string;
  /** Always the KaneVerity review interface: decisions never come from Kane. */
  by: 'kaneverity-review';
  /** Self-declared reviewer name at the time (KANEVERITY_REVIEWER). Not authenticated. */
  reviewer?: string | null;
}

export type KaneWriteState = 'pending' | 'verified' | 'not_written' | 'unknown' | 'written_unverified';

/**
 * One step of writing a KaneVerity approval into Kane's store. Append-only: every
 * state change is a new entry with the same writeId; the last one is current.
 */
export interface KaneWriteEntry {
  type: 'kane_write';
  writeId: string;
  decisionId: string;
  ucCid: string;
  state: KaneWriteState;
  at: string;
  reason: string;
  /** How this state was reached. */
  via: 'write' | 'reconcile' | 'reuse' | 'startup';
  /** Store tip (full hash) and record count just before the write. */
  baseTip: string | null;
  baseRecords: number;
  sourceCid: string | null;
  reqSha256: string | null;
  jobId: string | null;
  /** Kane's record holding the approval, once found in the store. */
  kaneSeq: number | null;
  kaneHash: string | null;
  /** Who Kane recorded ("human:kaneverity:<reviewer>"); compared, never trusted as identity. */
  kaneBy: string | null;
  /** Self-declared reviewer name passed to Kane. */
  reviewer: string;
  /** For via "reuse": the earlier verified write whose Kane record this decision relies on. */
  reusedFromWriteId: string | null;
  by: 'kaneverity-review';
}

export interface ReviewLog {
  tutorialId: string;
  decisions: ReviewEntry[];
  kaneWrites?: KaneWriteEntry[];
}

/** Stable id of a decision (entries from before B4 get "legacy-<n>"). */
export function decisionIdOf(e: ReviewEntry, index: number): string {
  return e.id ?? `legacy-${index + 1}`;
}

/** Current state of every write (last entry per writeId), oldest write first. */
export function currentWrites(entries: KaneWriteEntry[]): KaneWriteEntry[] {
  const byId = new Map<string, KaneWriteEntry>();
  for (const e of entries) if (e.type === 'kane_write' && e.by === 'kaneverity-review') byId.set(e.writeId, e);
  return [...byId.values()];
}

/** A write that blocks every decision and write for the tutorial (pending or unknown). */
export function blockingWrite(entries: KaneWriteEntry[]): KaneWriteEntry | null {
  return currentWrites(entries).find((w) => w.state === 'pending' || w.state === 'unknown') ?? null;
}

export class ReviewError extends Error {}

export const MAX_REASON = 1000;

export function reviewState(entries: ReviewEntry[], ucCid: string): { state: ReviewState; latest: ReviewEntry | null; latestId: string | null; history: ReviewEntry[] } {
  const withIds = entries.map((e, i) => ({ e, id: decisionIdOf(e, i) }));
  const mine = withIds.filter((x) => x.e.ucCid === ucCid && x.e.by === 'kaneverity-review');
  const last = mine[mine.length - 1] ?? null;
  return { state: last ? last.e.decision : 'awaiting_review', latest: last?.e ?? null, latestId: last?.id ?? null, history: mine.map((x) => ({ ...x.e, id: x.id })) };
}

/** Validate a decision request from the review interface. */
export function validateDecision(body: unknown, hasGaps: boolean): { decision: ReviewDecision; reason: string | null; acknowledgedGaps: boolean } {
  if (!body || typeof body !== 'object') throw new ReviewError('A decision is required.');
  const b = body as { decision?: unknown; reason?: unknown; acknowledgeGaps?: unknown };
  if (b.decision !== 'approve' && b.decision !== 'reject') throw new ReviewError('decision must be "approve" or "reject".');
  let reason: string | null = null;
  if (b.reason !== undefined && b.reason !== null) {
    if (typeof b.reason !== 'string') throw new ReviewError('reason must be text.');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(b.reason)) throw new ReviewError('reason contains control characters.');
    const t = b.reason.trim();
    if (t.length > MAX_REASON) throw new ReviewError(`reason is longer than ${MAX_REASON} characters.`);
    reason = t || null;
  }
  if (b.decision === 'reject') {
    if (!reason) throw new ReviewError('Rejecting a use case needs a reason.');
    return { decision: 'rejected', reason, acknowledgedGaps: false };
  }
  const ack = b.acknowledgeGaps === true;
  if (hasGaps && !ack) throw new ReviewError('This use case has citation gaps. Approving it needs an explicit acknowledgement of the gaps.');
  return { decision: 'approved', reason, acknowledgedGaps: hasGaps && ack };
}

/** What the Kane side shows for the latest KaneVerity decision (B4). */
export interface KaneApprovalStatus {
  /** State of the write for the latest decision; "none" when there was no attempt. */
  state: KaneWriteState | 'none';
  /** The verified Kane record is still in the latest retrieval, for this content id, and nothing newer in Kane overrides it. */
  recordInStore: boolean;
  /** Kane's trust in the latest retrieval. */
  kaneTrust: string;
  /** Kane holds an approval for this use case that KaneVerity did not write and verify. */
  externalApproval: boolean;
}

export interface EligibilityInput {
  state: ReviewState;
  /** The snapshot's integrity checks all passed. */
  integrityOk: boolean;
  /** The use case is in the latest snapshot (not superseded or gone). */
  inLatestSnapshot: boolean;
  /** The snapshot was read from the requirements version that is current now. */
  requirementsCurrent: boolean;
  /** B4: the approval as recorded and verified in Kane. */
  kane: KaneApprovalStatus;
}

/** Whether a use case may proceed to test design (B4). Every reason is listed. */
export function designEligibility(i: EligibilityInput): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (i.state === 'awaiting_review') reasons.push('It has not been reviewed in KaneVerity.');
  if (i.state === 'rejected') reasons.push('It was rejected in KaneVerity review.');
  if (!i.integrityOk) reasons.push('The store integrity checks did not pass for this snapshot.');
  if (!i.inLatestSnapshot) reasons.push('It is not in the latest retrieval from the Assurance store.');
  if (!i.requirementsCurrent) reasons.push('Its requirements are no longer the current version.');
  if (i.state === 'approved') {
    const k = i.kane;
    if (k.state === 'none' || k.state === 'not_written') reasons.push('Your approval has not been recorded in Kane yet.');
    else if (k.state === 'pending') reasons.push('Your approval is being written to Kane.');
    else if (k.state === 'unknown') reasons.push("The outcome of writing your approval to Kane is unknown. Check Kane's store.");
    else if (k.state === 'written_unverified') reasons.push('Kane holds an approval that KaneVerity could not verify.');
    else if (!k.recordInStore) reasons.push("Kane's record of your approval is not in the latest retrieval.");
    if (k.kaneTrust !== 'trusted') reasons.push(`Kane does not list it as trusted (Kane trust: ${k.kaneTrust || 'unknown'}).`);
  }
  if (i.kane.externalApproval) reasons.push('Kane holds an approval for it that was not made and verified through KaneVerity; it is not accepted.');
  return { eligible: reasons.length === 0 && i.state === 'approved', reasons };
}
