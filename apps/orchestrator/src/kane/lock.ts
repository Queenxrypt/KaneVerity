// One Kane process at a time, across verification runs and Assurance jobs.
// Kane's Assurance store is single-writer (docs/ASSURANCE_PLAN.md, section 2),
// and credit measurement by balance difference only works when nothing else runs.

export class KaneLock {
  private tail: Promise<void> = Promise.resolve();
  private holderName: string | null = null;

  /** Wait for the lock; the returned function releases it (safe to call twice). */
  async acquire(owner: string): Promise<() => void> {
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => mine);
    await prev;
    this.holderName = owner;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (this.holderName === owner) this.holderName = null;
      release();
    };
  }

  /** Who holds the lock now (for display and tests), or null. */
  holder(): string | null {
    return this.holderName;
  }
}

/** The process-wide lock shared by the run queue and the Assurance job runner. */
export const kaneLock = new KaneLock();
