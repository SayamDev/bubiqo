/**
 * CostGuard: the reason this product cannot generate a bill.
 *
 * Bubiqo's primary defence against cost is architectural — it uses no paid model
 * API, no calendar API, no mail API, and stores everything locally, so the vast
 * majority of the product has no billable surface at all. CostGuard exists for the
 * narrow remainder: any external provider the product ever talks to.
 *
 * The rule it enforces: Bubiqo's own ceiling always sits well below the provider's
 * free allowance, so usage stops long before anything could ever be charged. A
 * provider with no paid tier at all still passes through here, because "free today"
 * is not a guarantee about next year, and the guard is what makes that survivable.
 *
 * Every refusal is a fallback, never an error: the caller degrades to cached or
 * locally computed data and the user keeps working.
 */

export interface ProviderBudget {
  readonly id: string;
  /** What the provider itself allows, as documented. Recorded for the audit trail. */
  readonly providerLimitPerDay: number | "unpublished";
  /** Our own ceiling. Must be meaningfully below the provider's. */
  readonly safetyLimitPerDay: number;
  readonly safetyLimitPerHour: number;
  /** Cache lifetime in ms. Longer cache means fewer requests means more headroom. */
  readonly cacheTtlMs: number;
}

export interface ProviderUsage {
  day: string;
  hour: string;
  requestsToday: number;
  requestsThisHour: number;
  cacheHits: number;
  cacheMisses: number;
  failures: number;
  lastFailureAt?: number;
  /** Set when the guard has been tripped and must stay shut for the day. */
  emergencyStop: boolean;
}

export interface Decision {
  readonly allowed: boolean;
  /** Shown to the user if it matters. Always plain English, never a quota number. */
  readonly reason: string;
}

function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function hourKey(now: number): string {
  return new Date(now).toISOString().slice(0, 13);
}

export function emptyUsage(now: number): ProviderUsage {
  return {
    day: dayKey(now),
    hour: hourKey(now),
    requestsToday: 0,
    requestsThisHour: 0,
    cacheHits: 0,
    cacheMisses: 0,
    failures: 0,
    emergencyStop: false,
  };
}

/** Consecutive failures after which the provider is left alone until tomorrow. */
const FAILURE_STOP_THRESHOLD = 5;

export class CostGuard {
  private readonly usage = new Map<string, ProviderUsage>();

  constructor(
    private readonly budgets: ReadonlyMap<string, ProviderBudget>,
    private readonly now: () => number,
  ) {}

  /** Restore counters persisted across service-worker restarts. */
  hydrate(id: string, usage: ProviderUsage): void {
    this.usage.set(id, usage);
  }

  snapshot(id: string): ProviderUsage {
    return this.rollOver(id);
  }

  /** Roll the daily and hourly counters forward when the clock has moved on. */
  private rollOver(id: string): ProviderUsage {
    const now = this.now();
    const existing = this.usage.get(id) ?? emptyUsage(now);

    if (existing.day !== dayKey(now)) {
      // A new day clears everything, including an emergency stop.
      const fresh = emptyUsage(now);
      this.usage.set(id, fresh);
      return fresh;
    }
    if (existing.hour !== hourKey(now)) {
      existing.hour = hourKey(now);
      existing.requestsThisHour = 0;
    }
    this.usage.set(id, existing);
    return existing;
  }

  canRequest(id: string): Decision {
    const budget = this.budgets.get(id);
    if (!budget) {
      return { allowed: false, reason: `"${id}" is not a registered provider.` };
    }

    const usage = this.rollOver(id);

    if (usage.emergencyStop) {
      return { allowed: false, reason: "Live lookups are paused for today after repeated failures. Everything else still works." };
    }
    if (usage.requestsThisHour >= budget.safetyLimitPerHour) {
      return { allowed: false, reason: "Live lookups are paused for a little while to stay inside the free limit. Everything else still works." };
    }
    if (usage.requestsToday >= budget.safetyLimitPerDay) {
      return { allowed: false, reason: "Live lookups are paused until tomorrow to stay inside the free limit. Everything else still works." };
    }
    return { allowed: true, reason: "Within the safety budget." };
  }

  recordRequest(id: string): void {
    const usage = this.rollOver(id);
    usage.requestsToday += 1;
    usage.requestsThisHour += 1;
  }

  recordCacheHit(id: string): void {
    this.rollOver(id).cacheHits += 1;
  }

  recordCacheMiss(id: string): void {
    this.rollOver(id).cacheMisses += 1;
  }

  recordFailure(id: string): void {
    const usage = this.rollOver(id);
    usage.failures += 1;
    usage.lastFailureAt = this.now();
    if (usage.failures >= FAILURE_STOP_THRESHOLD) usage.emergencyStop = true;
  }

  recordSuccess(id: string): void {
    // A success clears the failure run; only consecutive failures trip the stop.
    this.rollOver(id).failures = 0;
  }

  /** Operator-facing only. Never shown in the ordinary UI. */
  diagnostics(): Record<string, ProviderUsage & { budget: ProviderBudget | undefined }> {
    const out: Record<string, ProviderUsage & { budget: ProviderBudget | undefined }> = {};
    for (const id of this.budgets.keys()) {
      out[id] = { ...this.rollOver(id), budget: this.budgets.get(id) };
    }
    return out;
  }
}
