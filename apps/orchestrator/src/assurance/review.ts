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

export type ReviewDecision = 'approved' | 'rejected';
export type ReviewState = 'awaiting_review' | 'approved' | 'rejected';

export interface ReviewEntry {
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
}

export class ReviewError extends Error {}

export const MAX_REASON = 1000;

export function reviewState(entries: ReviewEntry[], ucCid: string): { state: ReviewState; latest: ReviewEntry | null; history: ReviewEntry[] } {
  const history = entries.filter((e) => e.ucCid === ucCid && e.by === 'kaneverity-review');
  const latest = history[history.length - 1] ?? null;
  return { state: latest ? latest.decision : 'awaiting_review', latest, history };
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

export interface EligibilityInput {
  state: ReviewState;
  /** The snapshot's integrity checks all passed. */
  integrityOk: boolean;
  /** The use case is in the latest snapshot (not superseded or gone). */
  inLatestSnapshot: boolean;
  /** The snapshot was read from the requirements version that is current now. */
  requirementsCurrent: boolean;
}

/** Whether a use case may proceed to test design (B4). Every reason is listed. */
export function designEligibility(i: EligibilityInput): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (i.state === 'awaiting_review') reasons.push('It has not been reviewed in KaneVerity.');
  if (i.state === 'rejected') reasons.push('It was rejected in KaneVerity review.');
  if (!i.integrityOk) reasons.push('The store integrity checks did not pass for this snapshot.');
  if (!i.inLatestSnapshot) reasons.push('It is not in the latest retrieval from the Assurance store.');
  if (!i.requirementsCurrent) reasons.push('Its requirements are no longer the current version.');
  return { eligible: reasons.length === 0 && i.state === 'approved', reasons };
}
