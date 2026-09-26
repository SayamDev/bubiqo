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

describe("phone numbers", () => {
  it("drops a bracket that never closes", () => {
    const phones = extractEntities(page("send us a message on WhatsApp (0808 501 5200) or reply"), Date.UTC(2026, 8, 25))
      .filter((e) => e.type === "phone")
      .map((e) => e.value);
    expect(phones).toContain("0808 501 5200");
  });
});

describe("pay written in thousands", () => {
  it("reads £100K/yr - £130K/yr as one range, not a refund", () => {
    const got = amounts("Software Engineer (Applied AI)\n£100K/yr - £130K/yr\nRemote");
    expect(got).toContain("GBP 100000–130000");
    expect(got.some((v) => v.includes("-130"))).toBe(false);
  });
  it("reads a lone £85k as eighty-five thousand", () => {
    expect(amounts("Salary £85k plus bonus")).toContain("GBP 85000");
  });
});
