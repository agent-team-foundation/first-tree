/**
 * Serializes asynchronous operations per key while allowing different keys to
 * progress independently.
 */
export class KeyedOperationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  get size(): number {
    return this.tails.size;
  }

  run(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    let queued: Promise<void>;
    queued = next.finally(() => {
      if (this.tails.get(key) === queued) {
        this.tails.delete(key);
      }
    });
    this.tails.set(key, queued);
    return next;
  }
}
