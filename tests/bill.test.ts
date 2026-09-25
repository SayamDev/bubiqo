import { describe, it, expect } from "vitest";
import { buildBillSummary } from "@core/bill";
import type { Entity } from "@core/types";

const NOW = Date.UTC(2026, 8, 25, 9);
const e = (type: Entity["type"], value: string, source: string, resolvedAt?: number): Entity => ({
  type,
  value,
  source,
  confidence: 0.9,
  sensitivity: "normal" as Entity["sensitivity"],
  ...(resolvedAt !== undefined ? { resolvedAt } : {}),
});

describe("bill summary", () => {
  const entities = [
    e("amount", "GBP 48.56", "Your Direct Debit payment of £48.56 will be taken"),
    e("amount", "GBP -194.27 DR", "Your current balance is -£194.27 DR"),
    e("date", "2026-10-01T08:00:00.000Z", "on 1 October", Date.UTC(2026, 9, 1, 8)),
    e("reference", "A-48F4A034", "Account number: A-48F4A034"),
    e("organisation", "E.ON Next Energy Limited", "E.ON Next Energy Limited"),
  ];

  it("separates the payment from the balance", () => {
    const bill = buildBillSummary("email", "A reminder about your Direct Debit payment", entities, NOW);
    expect(bill?.payment).toBe("GBP 48.56");
    expect(bill?.balance).toBe("GBP -194.27 DR");
    expect(bill?.dueAt).toBe(Date.UTC(2026, 9, 1, 8));
    expect(bill?.account).toBe("A-48F4A034");
    expect(bill?.supplier).toBe("E.ON Next Energy Limited");
  });

  it("stays out of ordinary emails", () => {
    expect(buildBillSummary("email", "Lunch on Friday?", entities, NOW)).toBeUndefined();
  });

  it("needs an amount", () => {
    expect(buildBillSummary("invoice", "Invoice", entities.filter((x) => x.type !== "amount"), NOW)).toBeUndefined();
  });
});
