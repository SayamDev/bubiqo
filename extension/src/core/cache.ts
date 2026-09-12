/**
 * A small TTL cache with request de-duplication.
 *
 * De-duplication matters as much as the TTL: opening three invoices in the same
 * currency within a second must produce one request, not three. Concurrent callers
 * share the single in-flight promise.
 */

export interface CacheEntry<T> {
  readonly value: T;
  readonly storedAt: number;
  readonly expiresAt: number;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  get(key: string): CacheEntry<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** A value past its TTL, kept for stale-while-revalidate and offline fallback. */
  getStale(key: string): CacheEntry<T> | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: T): void {
    const now = this.now();
    this.entries.set(key, { value, storedAt: now, expiresAt: now + this.ttlMs });
  }

  /**
   * Run `fetcher` at most once per key at a time, caching the result.
   * Concurrent callers wait on the same promise rather than issuing more requests.
   */
  async dedupe(key: string, fetcher: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = fetcher()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
