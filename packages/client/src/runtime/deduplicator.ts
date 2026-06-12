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

  /**
   * Drop every recorded id that starts with `prefix`. Used by the runtime
   * when a chat is LRU-evicted: the in-flight entries for that chat won't
   * be acked (no handler will run `finishTurn`), and the server will
   * resend the same `(chatId, messageId)` pairs against a fresh session.
   * Leaving the keys in the dedup set would cause the resend to be
   * mis-classified as a duplicate — and (post-#1-fix) re-acked, which
   * would shortcut the documented recovery path. Dropping the keys
   * synchronously with eviction keeps "dedup hit = previous turn already
   * handled this" as a true statement at the call site.
   *
   * O(n) over the recorded set — n is bounded by the deduplicator's
   * capacity (1000 by default) and LRU eviction is a per-chat event, so
   * the linear scan is fine.
   */
  dropByPrefix(prefix: string): void {
    if (this.order.length === 0) return;
    const kept: string[] = [];
    for (const id of this.order) {
      if (id.startsWith(prefix)) {
        this.seen.delete(id);
      } else {
        kept.push(id);
      }
    }
    this.order.length = 0;
    this.order.push(...kept);
  }

  /** Drop one recorded id if present. */
  drop(id: string): void {
    if (!this.seen.delete(id)) return;
    const index = this.order.indexOf(id);
    if (index >= 0) this.order.splice(index, 1);
  }

  get size(): number {
    return this.seen.size;
  }
}
