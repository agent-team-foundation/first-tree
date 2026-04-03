/**
 * InputController — push-based async iterable bridge.
 *
 * Bridges imperative `push()` calls to the `AsyncIterable` that
 * the Agent SDK `query()` expects as streaming input.
 */
export class InputController<T> {
  private buffer: T[] = [];
  private waiter: ((value: IteratorResult<T>) => void) | null = null;
  private done = false;

  /** Push a message for the consumer. Buffered if consumer is busy. */
  push(value: T): void {
    if (this.done) return;

    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  /** Signal no more messages will be sent. */
  end(): void {
    if (this.done) return;
    this.done = true;

    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  /** The async iterable consumed by `query()`. */
  get iterable(): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => this.pull(),
      }),
    };
  }

  private pull(): Promise<IteratorResult<T>> {
    // Drain buffer first
    const buffered = this.buffer.shift();
    if (buffered !== undefined) {
      return Promise.resolve({ value: buffered, done: false });
    }

    // Already ended
    if (this.done) {
      return Promise.resolve({ value: undefined as unknown as T, done: true });
    }

    // Wait for next push or end
    return new Promise<IteratorResult<T>>((resolve) => {
      this.waiter = resolve;
    });
  }
}
