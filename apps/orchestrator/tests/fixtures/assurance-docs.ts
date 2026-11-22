// The pause/resume exchange from Kane CLI's official automation.md (0.10.5),
// verbatim apart from shortened payloads ("…" replaced by "...") and line joins.
// Used by the parser tests and the fake Kane Assurance CLI scenarios.

export const DOC_PAUSE = [
  '{"type":"run_start","v":1,"verb":"extract","mode":"agent","trace":"~/.testmuai/kaneai/assurance/x/logs/extract-1.log"}',
  '{"type":"corpus","v":1,"verb":"extract","sources":[{"source_id":"prd-online-store","cid":"sha256:0661"}],"skipped":[]}',
  '{"type":"agent_activity","v":1,"verb":"extract","kind":"decision","label":"asking to resolve an ambiguity"}',
  '{"type":"session_paused","v":1,"verb":"extract","sid":"ext-20260716T140742-prd-online-store","resume":"kane-cli context extract --resume ext-20260716T140742-prd-online-store --mode agent","expires_at":"2026-07-17T14:07:53Z","pending_questions":[{"id":"q1","text":"The PRD conflicts on guest checkout; should I treat checkout as account-required or guest-allowed?","risk":"high","rationale":"Lines L20-L21 say all customers must create an account, but L35 says guest checkout is allowed.","options":[{"label":"Account required","detail":"..."},{"label":"Guest allowed","detail":"..."}],"recommended_index":0,"allow_free_text":true}]}',
  '{"type":"done","v":1,"verb":"extract","status":"paused","exit_code":3}',
];

export const DOC_RESUME = [
  '{"type":"message_sent","v":1,"verb":"extract","sid":"ext-20260716T140742-prd-online-store","chars":115}',
  '{"type":"usage","v":1,"verb":"extract","credits":2.45,"total_credits":2.45}',
  '{"type":"commit","v":1,"verb":"extract","derived":5,"minted":[{"cid":"sha256:6d68","logical_id":"uc-create-an-account-to-order"}]}',
  '{"type":"session_complete","v":1,"verb":"extract","sid":"ext-20260716T140742-prd-online-store"}',
  '{"type":"done","v":1,"verb":"extract","status":"complete","exit_code":0}',
];

/** The documented pause with its session expiry moved to `expiresAt` (the doc's date is in the past). */
export function pauseExpiringAt(expiresAt: string): string[] {
  return DOC_PAUSE.map((l) => l.replace('2026-07-17T14:07:53Z', expiresAt));
}
