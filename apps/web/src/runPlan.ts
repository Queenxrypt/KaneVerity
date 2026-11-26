// The wording of the paid-run confirmations, built only from the backend's run plan (the exact
// tests the run will give Kane, from the same selection the job uses when it starts). No
// selection logic lives here. Pure, no React: the orchestrator's tests import it too.

export type RunPhase = 'authoring' | 'verification';

export interface RunPlan {
  /** The exact tests this run gives Kane, as the backend selected them. */
  tests: { slug: string | null; testCid: string; testFile: string | null }[];
  /** False when the run cannot start now; reason says why. */
  available: boolean;
  reason: string;
}

/** The selected tests' short ids, in the backend's order (content id when a test has none). */
export function planSlugs(plan: RunPlan): string[] {
  return plan.tests.map((t) => t.slug ?? t.testCid.slice(0, 19));
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** What the confirmation says the run will do: exactly the selected tests. */
export function confirmText(phase: RunPhase, plan: RunPlan, testsInDesign: number): string {
  const s = planSlugs(plan);
  const n = s.length;
  if (phase === 'authoring') {
    const skipped = testsInDesign - n;
    return `The authoring run records ${n === 1 ? 'one test' : `${n} tests`} in a browser: ${list(s)}.${skipped > 0 ? ` ${skipped === 1 ? 'One test has' : `${skipped} tests have`} an approved, current recording and ${skipped === 1 ? 'is' : 'are'} not recorded again.` : ''} It uses Kane credits. Its result is AUTHORED at best, never VERIFIED: you review the recordings next.`;
  }
  return `The verification run replays ${n === 1 ? 'one approved recording' : `all ${n} approved recordings`} in a browser, with no re-recording: ${list(s)}. It uses Kane credits. It is VERIFIED only if Kane replayed every step and the evidence reads each documented outcome from the page.`;
}

/** The label of the button that starts the paid run. */
export function startLabel(phase: RunPhase, plan: RunPlan): string {
  return `Start the ${phase} run of ${list(planSlugs(plan))} (uses credits)`;
}

/** The confirmed list, as the start request sends it: the test content ids the dialog showed. */
export function confirmedIds(plan: RunPlan): string[] {
  return plan.tests.map((t) => t.testCid);
}

/**
 * The page's explanation when the backend refused an authoring run because the tests it would
 * record changed after the confirmation (null for any other error). The page reloads the design
 * after every refused request, so the person sees the new list and confirms again.
 */
export function selectionChangedNote(message: string): string | null {
  if (!/the tests to record changed since this confirmation/.test(message)) return null;
  return `${message} The list below has been refreshed: open the authoring run again to review it and confirm.`;
}
