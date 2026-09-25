import { describe, it, expect } from "vitest";
import { buildMoneySummary, labelledAmounts } from "@core/bill";
import type { Entity } from "@core/types";

const NOW = Date.UTC(2026, 8, 25, 9);
const date = (resolvedAt: number): Entity => ({
  type: "date",
  value: new Date(resolvedAt).toISOString(),
  source: "",
  confidence: 0.9,
  sensitivity: "normal" as Entity["sensitivity"],
  resolvedAt,
});

describe("money summary, from the emails people actually get", () => {
  it("Direct Debit reminder: leads with the payment, keeps the balance owed", () => {
    const text = [
      "Your Direct Debit payment is due soon.",
      "Your Direct Debit payment",
      "£48.56",
      "Your current balance is",
      "-£194.27 DR",
    ].join("\n");
    const s = buildMoneySummary("email", text, [date(Date.UTC(2026, 9, 1, 8))], NOW)!;
    expect(s.kind).toBe("bill");
    expect(s.headline.value).toBe("GBP 48.56");
    expect(s.lines.some((l) => l.value === "GBP -194.27 DR")).toBe(true);
    expect(s.dueAt).toBe(Date.UTC(2026, 9, 1, 8));
  });

  it("SumUp payout report: paid out is the headline, fees are a deduction", () => {
    const text = [
      "Your daily payouts report",
      "SumUp processed card payments",
      "Total of all gross card payments before fees and deductions are applied",
      "£214.85",
      "SumUp processing fees",
      "Total of all processing fees for card payments",
      "-£2.24",
      "Deductions",
      "£0.00",
      "Paid out amount",
      "The amount deposited in your payout account",
      "£130.63",
      "To be paid out",
      "Payments still to be paid out.",
      "£81.98",
    ].join("\n");
    const s = buildMoneySummary("email", text, [], NOW)!;
    expect(s.kind).toBe("payout");
    expect(s.headline).toMatchObject({ label: "Paid out amount", value: "GBP 130.63", role: "paid" });
    const byLabel = Object.fromEntries(s.lines.map((l) => [l.label, l]));
    expect(byLabel["SumUp processed card payments"]?.role).toBe("gross");
    expect(byLabel["SumUp processing fees"]).toMatchObject({ value: "GBP -2.24", role: "deduction" });
    expect(byLabel["To be paid out"]?.role).toBe("pending");
  });

  it("freelancer invoice: total due beats the subtotal", () => {
    const text = ["Invoice INV-0042", "Subtotal: £500.00", "VAT (20%): £100.00", "Total due: £600.00", "Due date 10 October 2026"].join("\n");
    const s = buildMoneySummary("invoice", text, [], NOW)!;
    expect(s.kind).toBe("bill");
    expect(s.headline).toMatchObject({ label: "Total due", value: "GBP 600.00" });
    expect(s.lines.map((l) => l.label)).toEqual(["Subtotal", "VAT (20%)"]);
  });

  it("order receipt: the order total, with the discount as a deduction", () => {
    const text = ["Thanks for your order", "Items: £42.98", "Delivery: £3.99", "Discount: -£5.00", "Order total: £41.97"].join("\n");
    const s = buildMoneySummary("email", text, [], NOW)!;
    expect(s.kind).toBe("receipt");
    expect(s.headline.value).toBe("GBP 41.97");
    expect(s.lines.find((l) => l.label === "Discount")?.role).toBe("deduction");
  });

  it("card statement: the balance leads", () => {
    const text = ["Your monthly statement", "Statement balance: £312.40", "Minimum payment: £25.00"].join("\n");
    const s = buildMoneySummary("email", text, [], NOW)!;
    expect(s.kind).toBe("statement");
    expect(s.headline.value).toBe("GBP 312.40");
  });

  it("stays out of ordinary emails and job adverts", () => {
    expect(buildMoneySummary("email", "Lunch on Friday? It's £12 each", [], NOW)).toBeUndefined();
    expect(buildMoneySummary("job", "Salary: £40,000. Payment monthly", [], NOW)).toBeUndefined();
  });

  it("does not use a sentence of prose as a label", () => {
    const lines = labelledAmounts("We have taken the money you owe us from your account today as agreed.\n£10.00");
    expect(lines).toEqual([]);
  });
});
