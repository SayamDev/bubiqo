import { describe, it, expect } from "vitest";
import { extractEntities } from "@core/entity-engine";
import type { PageContext } from "@core/types";

const page = (text: string): PageContext => ({
  url: "https://www.linkedin.com/jobs/view/1", domain: "www.linkedin.com", title: "x",
  text, headings: [], fields: [], structuredData: [], links: [], capturedAt: 0,
});

const amounts = (text: string) =>
  extractEntities(page(text), Date.now()).filter((e) => e.type === "amount").map((e) => e.value);

describe("pay written without a currency symbol", () => {
  it("reads the salary from the advert that was being missed entirely", () => {
    expect(amounts("Whats on offer\n\nCompetitive salary of up to 85,000\nFlexible 37.5-hour working week"))
      .toContain("GBP 85000");
  });

  it("handles k notation", () => {
    expect(amounts("Salary up to 85k per annum")).toContain("GBP 85000");
    expect(amounts("paying 60k")).toContain("GBP 60000");
  });

  it("does not read a working week as pay", () => {
    // "Flexible 37.5-hour working week" and "Five days" are not salaries.
    expect(amounts("Flexible 37.5-hour working week. Five days of external training."))
      .toHaveLength(0);
  });

  it("does not read a bare number with no pay context", () => {
    expect(amounts("We have 85,000 customers across the UK.")).toHaveLength(0);
  });

  it("ignores numbers too small to be a salary", () => {
    expect(amounts("salary of 55")).toHaveLength(0);
  });

  it("still reads a symbol salary as a range", () => {
    expect(amounts("£45,000 – £60,000 / + Share options")).toContain("GBP 45000–60000");
  });
});
