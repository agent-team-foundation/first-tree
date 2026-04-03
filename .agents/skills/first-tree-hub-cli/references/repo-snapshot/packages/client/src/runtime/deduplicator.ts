/**
 * Deduplicator — bounded set of recently seen IDs.
 *
 * Used to deduplicate at-least-once delivered messages at the dispatch layer.
 * When capacity is reached, the oldest entries are evicted (FIFO).
 */
export class Deduplicator {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private readonly capacity: number;

  constructor(capacity = 1000) {
    this.capacity = capacity;
  }

  /**
   * Check if `id` has been seen. If not, record it and return `false`.
   * If already seen, return `true` (duplicate).
   */
  isDuplicate(id: string): boolean {
    if (this.seen.has(id)) return true;

    // Evict oldest if at capacity
    if (this.order.length >= this.capacity) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }

    this.seen.add(id);
    this.order.push(id);
    return false;
  }

  get size(): number {
    return this.seen.size;
  }
}
