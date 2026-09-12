import { describe, it, expect } from "vitest";
import { amountToConvert } from "@core/currency";
import { analyse } from "@core/analyse";
import { buildRegistry } from "@core/actions";
import { DEFAULT_SETTINGS, type Analysis, type Entity } from "@core/types";
import { makePorts } from "./fakes";
import { NOW, invoicePage, boringPage } from "./fixtures";

const registry = buildRegistry(makePorts(NOW));
const run = (page: Parameters<typeof analyse>[0]) =>
  analyse(page, registry, { settings: DEFAULT_SETTINGS, now: NOW });

function withAmounts(...values: string[]): Analysis {
  const entities: Entity[] = values.map((value) => ({
    type: "amount", value, confidence: 0.9, source: value, sensitivity: "public",
  }));
  return { classification: { surface: "invoice", confidence: 1, rationale: "" },
    entities, intents: [], problems: [], suggestions: [], injectionAttempted: false, fromSelection: false };
}

describe("amountToConvert", () => {
  it("picks the total, not a line item", () => {
    const chosen = amountToConvert(withAmounts("EUR 2400.00", "EUR 480.00", "EUR 2880.00"), "GBP");
    expect(chosen).toEqual({ value: 2880, from: "EUR" });
  });

  it("picks the total off a real invoice", () => {
    expect(amountToConvert(run(invoicePage), "GBP")).toEqual({ value: 2880, from: "EUR" });
  });

  it("returns nothing when everything is already in the user's currency", () => {
    // Avoids a pointless request, and avoids showing "GBP 100 ≈ GBP 100".
    expect(amountToConvert(withAmounts("GBP 100.00", "GBP 250.00"), "GBP")).toBeUndefined();
  });

  it("is case-insensitive about the home currency", () => {
    expect(amountToConvert(withAmounts("EUR 10.00"), "gbp")).toEqual({ value: 10, from: "EUR" });
    expect(amountToConvert(withAmounts("GBP 10.00"), "gbp")).toBeUndefined();
  });

  it("ignores amounts that are not finite or not positive", () => {
    expect(amountToConvert(withAmounts("EUR 0", "EUR nonsense"), "GBP")).toBeUndefined();
  });

  it("returns nothing for a page with no amounts", () => {
    expect(amountToConvert(run(boringPage), "GBP")).toBeUndefined();
  });

  it("mixes currencies by taking the largest regardless of code", () => {
    expect(amountToConvert(withAmounts("USD 50.00", "EUR 900.00"), "GBP")).toEqual({ value: 900, from: "EUR" });
  });
});
