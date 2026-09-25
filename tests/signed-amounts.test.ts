import { describe, it, expect } from "vitest";
import { extractEntities } from "@core/entity-engine";
import type { PageContext } from "@core/types";

const page = (text: string): PageContext =>
  ({
    url: "https://example.com/bill",
    domain: "example.com",
    title: "Your statement",
    text,
    headings: [],
    fields: [],
    structuredData: [],
    links: [],
  }) as unknown as PageContext;

const amounts = (text: string) =>
  extractEntities(page(text), Date.UTC(2026, 8, 25))
    .filter((e) => e.type === "amount")
    .map((e) => e.value);

describe("amounts on statements keep their sign", () => {
  it("reads a leading minus", () => {
    expect(amounts("Your current balance is -£194.27")).toContain("GBP -194.27");
  });
  it("reads a minus after the symbol", () => {
    expect(amounts("Balance: £-50.00")).toContain("GBP -50.00");
  });
  it("reads bracketed amounts as negative", () => {
    expect(amounts("Adjustment (£12.00) applied")).toContain("GBP -12.00");
  });
  it("keeps DR and CR markers", () => {
    expect(amounts("Your current balance is -£194.27 DR")).toContain("GBP -194.27 DR");
    expect(amounts("Balance £20.00 CR")).toContain("GBP 20.00 CR");
  });
  it("leaves ordinary amounts alone", () => {
    expect(amounts("Total due £2,880.00")).toContain("GBP 2880.00");
  });
});
