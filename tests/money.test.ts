import { describe, it, expect } from "vitest";
import { readNumber, looksLikeSalary } from "@core/money";
import { extractEntities } from "@core/entity-engine";
import type { PageContext } from "@core/types";

const page = (text: string): PageContext => ({
  url: "https://example.com/x", domain: "example.com", title: "x",
  text, headings: [], fields: [], structuredData: [], links: [], capturedAt: 0,
});
const amounts = (text: string) =>
  extractEntities(page(text), Date.now()).filter((e) => e.type === "amount").map((e) => e.value);

describe("readNumber", () => {
  /*
   * A table, not a handful of cases. The same truncation bug was written three
   * times in three different regexes — "£70000" reading as 700 — because each
   * one re-derived its own number pattern. One reader, one table, and a fourth
   * caller cannot reintroduce it.
   */
  const CASES: [string, number | undefined][] = [
    ["2400", 2400],
    ["70000", 70000],
    ["2,400", 2400],
    ["2,880.00", 2880],
    ["1,234,567", 1234567],
    ["85k", 85000],
    ["85K", 85000],
    ["1.5k", 1500],
    ["2m", 2000000],
    ["0", 0],
    ["", undefined],
    ["abc", undefined],
    ["--", undefined],
  ];

  for (const [input, expected] of CASES) {
    it(`reads ${JSON.stringify(input)} as ${expected}`, () => {
      expect(readNumber(input)).toBe(expected);
    });
  }
});

describe("every way an amount appears on a real page", () => {
  const CASES: [string, string][] = [
    ["Total amount due £2400", "GBP 2400"],
    ["Total amount due £2,400", "GBP 2400"],
    ["Total amount due EUR 2,880.00", "EUR 2880.00"],
    ["Salary Min : £ 70000", "GBP 70000"],
    ["salary of up to 85,000", "GBP 85000"],
    ["Salary up to 85k per annum", "GBP 85000"],
    ["£45,000 – £60,000", "GBP 45000–60000"],
    ["paying £70,000 to £85,000", "GBP 70000–85000"],
  ];

  for (const [text, expected] of CASES) {
    it(`reads ${JSON.stringify(text)}`, () => {
      expect(amounts(text)).toContain(expected);
    });
  }

  it("never truncates an unpunctuated figure", () => {
    for (const text of ["£70000", "£2400", "$150000", "€99000"]) {
      for (const value of amounts(text)) {
        const digits = Number(value.split(" ")[1]);
        expect(digits, `${text} came out as ${value}`).toBeGreaterThan(999);
      }
    }
  });
});

describe("looksLikeSalary", () => {
  it("accepts real pay and rejects hours, percentages and counts", () => {
    expect(looksLikeSalary(85000)).toBe(true);
    expect(looksLikeSalary(37.5)).toBe(false);
    expect(looksLikeSalary(55)).toBe(false);
    expect(looksLikeSalary(5)).toBe(false);
  });
});
