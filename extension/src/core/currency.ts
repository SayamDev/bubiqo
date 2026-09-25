/**
 * Choosing which amount on a page is worth converting.
 *
 * Pure, so it can be tested: the service worker owns the network call, this owns
 * the decision. An invoice usually carries several amounts — a line item, a
 * subtotal, the VAT and the total — and the one a person cares about is the
 * largest, which is the total.
 */

import type { Analysis } from "./types";

export interface ConvertibleAmount {
  readonly value: number;
  readonly from: string;
}

/**
 * The largest amount whose currency differs from the user's own, or nothing.
 *
 * Returns nothing when every amount is already in the user's currency — the point
 * is to avoid a pointless network request, not to show "GBP 100 ≈ GBP 100".
 */
export function amountToConvert(analysis: Analysis, homeCurrency: string): ConvertibleAmount | undefined {
  const home = homeCurrency.trim().toUpperCase();
  let best: ConvertibleAmount | undefined;

  for (const entity of analysis.entities) {
    if (entity.type !== "amount") continue;

    const [code, raw] = entity.value.split(" ");
    if (!code || !raw) continue;
    if (code.toUpperCase() === home) continue;

    // A balance owed ("-194.27") is still that much money to convert.
    const value = Math.abs(Number(raw));
    if (!Number.isFinite(value) || value <= 0) continue;

    if (!best || value > best.value) best = { value, from: code.toUpperCase() };
  }

  return best;
}
