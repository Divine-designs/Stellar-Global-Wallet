/**
 * Small in-process cache with an explicit TTL per entry and explicit
 * invalidation (#55/#56/#57). Used for price data, where every value is
 * cheap to recompute and short-lived, so a per-instance cache is enough —
 * unlike sorobanCache.ts there's no correctness reason to share it across
 * instances via Redis.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly defaultTtlMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 5000
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs = this.defaultTtlMs): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      // Evict the oldest insertion; Map iterates in insertion order.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
