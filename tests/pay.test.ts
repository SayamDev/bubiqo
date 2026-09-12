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

describe("amounts must not be truncated", () => {
  it("reads an unpunctuated figure in full", () => {
    /*
     * "£ 70000" was coming out as GBP 700, because the comma-group branch of the
     * pattern matched three digits and stopped. Wrong by two orders of magnitude,
     * and it applied to invoice totals exactly as much as to salaries.
     */
    expect(amounts("Salary Min : £ 70000")).toContain("GBP 70000");
    expect(amounts("Salary Min : £ 70000")).not.toContain("GBP 700");
  });

  it("reads an unpunctuated invoice total in full", () => {
    expect(amounts("Total amount due £2400")).toContain("GBP 2400");
    expect(amounts("Total amount due £2400")).not.toContain("GBP 240");
  });

  it("still reads a punctuated figure", () => {
    expect(amounts("Total amount due EUR 2,880.00")).toContain("EUR 2880.00");
  });
});

describe("pay split across labelled fields", () => {
  const advert = `Salary Type : Annual Salary\n\nSalary Min : £ 70000\n\nSalary Max : £ 85000\n\nCurrency Type : GBP`;

  it("reads min and max as one range", () => {
    expect(amounts(advert)).toContain("GBP 70000–85000");
  });

  it("does not also list the two ends separately", () => {
    const found = amounts(advert);
    expect(found).not.toContain("GBP 70000");
    expect(found).not.toContain("GBP 85000");
  });
});
