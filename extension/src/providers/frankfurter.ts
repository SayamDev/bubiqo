/**
 * Currency conversion via Frankfurter (https://frankfurter.dev).
 *
 * The only external service Bubiqo ever contacts, and it is OFF by default.
 *
 * Why this one, verified against the primary source on 2026-09-12:
 *   - "It requires no API key."
 *   - "There are no quotas... there are no monthly or daily caps."
 *   - No paid tier exists; it is free for commercial use.
 *   - Data is daily reference rates sourced from central banks.
 *
 * A service with no paid tier cannot bill anyone, so the cost risk here is
 * structurally zero. It still goes through CostGuard and the cache, because
 * "free today" is not a promise about next year, and because being a good
 * citizen of a free service means not hammering it.
 *
 * What is sent: a currency pair, e.g. EUR and GBP. Never page content, never an
 * amount, never anything identifying. The multiplication happens locally — the
 * API has no conversion endpoint, which suits us: the rate is all we ask for.
 */

import type { CostGuard } from "@core/cost-guard";
import { TtlCache } from "@core/cache";

export const FRANKFURTER_PROVIDER_ID = "frankfurter";

/**
 * Rates are published once per working day, so a 12-hour cache costs nothing in
 * accuracy and removes almost every request.
 */
export const FRANKFURTER_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

export interface ConversionResult {
  readonly amount: number;
  readonly from: string;
  readonly to: string;
  readonly converted: number;
  readonly rate: number;
  /** True when this came from cache past its TTL because a live rate was unavailable. */
  readonly stale: boolean;
  readonly fetchedAt: number;
}

export interface ConversionUnavailable {
  readonly unavailable: true;
  /** Plain English, safe to show the user. */
  readonly reason: string;
}

export type ConversionOutcome = ConversionResult | ConversionUnavailable;

export function isUnavailable(outcome: ConversionOutcome): outcome is ConversionUnavailable {
  return "unavailable" in outcome;
}

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export class FrankfurterProvider {
  private readonly cache: TtlCache<number>;

  constructor(
    private readonly guard: CostGuard,
    private readonly fetcher: Fetcher,
    private readonly now: () => number,
    private readonly enabled: () => boolean,
  ) {
    this.cache = new TtlCache<number>(FRANKFURTER_CACHE_TTL_MS, now);
  }

  async convert(amount: number, from: string, to: string): Promise<ConversionOutcome> {
    const base = from.toUpperCase();
    const quote = to.toUpperCase();

    if (base === quote) {
      return { amount, from: base, to: quote, converted: amount, rate: 1, stale: false, fetchedAt: this.now() };
    }

    if (!this.enabled()) {
      return { unavailable: true, reason: "Currency conversion is switched off. You can turn it on in settings." };
    }

    const key = `${base}:${quote}`;

    const cached = this.cache.get(key);
    if (cached) {
      this.guard.recordCacheHit(FRANKFURTER_PROVIDER_ID);
      return this.result(amount, base, quote, cached.value, false, cached.storedAt);
    }

    const verdict = this.guard.canRequest(FRANKFURTER_PROVIDER_ID);
    if (!verdict.allowed) {
      // Stale data beats no data: show yesterday's rate and say that it is old.
      const stale = this.cache.getStale(key);
      if (stale) return this.result(amount, base, quote, stale.value, true, stale.storedAt);
      return { unavailable: true, reason: verdict.reason };
    }

    this.guard.recordCacheMiss(FRANKFURTER_PROVIDER_ID);

    try {
      const rate = await this.cache.dedupe(key, async () => {
        this.guard.recordRequest(FRANKFURTER_PROVIDER_ID);
        const response = await this.fetcher(`https://api.frankfurter.dev/v2/rate/${base}/${quote}`);
        if (!response.ok) throw new Error(`Frankfurter returned ${response.status}`);
        return readRate(await response.json(), quote);
      });
      this.guard.recordSuccess(FRANKFURTER_PROVIDER_ID);
      return this.result(amount, base, quote, rate, false, this.now());
    } catch {
      this.guard.recordFailure(FRANKFURTER_PROVIDER_ID);
      const stale = this.cache.getStale(key);
      if (stale) return this.result(amount, base, quote, stale.value, true, stale.storedAt);
      return { unavailable: true, reason: "The exchange rate could not be fetched. The amount is shown as it appears on the page." };
    }
  }

  private result(amount: number, from: string, to: string, rate: number, stale: boolean, fetchedAt: number): ConversionResult {
    return { amount, from, to, rate, converted: Math.round(amount * rate * 100) / 100, stale, fetchedAt };
  }
}

/**
 * Read the rate out of a response we do not control.
 *
 * Handles both the documented shape and a bare `{ "GBP": 0.85 }`, and throws on
 * anything else rather than letting a malformed payload become a wrong number on
 * an invoice.
 */
function readRate(payload: unknown, quote: string): number {
  if (typeof payload !== "object" || payload === null) throw new Error("Unexpected response shape.");
  const record = payload as Record<string, unknown>;

  const rates = record["rates"];
  if (typeof rates === "object" && rates !== null) {
    const value = (rates as Record<string, unknown>)[quote];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }

  const direct = record[quote];
  if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) return direct;

  throw new Error(`No usable rate for ${quote} in the response.`);
}
