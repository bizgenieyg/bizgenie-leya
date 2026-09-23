let wake: ((at: Date) => void) | null = null;

export function registerJobWake(callback: (at: Date) => void): () => void {
  wake = callback;
  return () => { if (wake === callback) wake = null; };
}

/** Called after a durable job is committed; a restart rediscovers it from the database. */
export function scheduleWake(at: Date): void { wake?.(at); }
