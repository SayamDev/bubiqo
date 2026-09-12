import { describe, it, expect } from "vitest";
import { readJobPosting } from "@core/job-posting";

describe("readJobPosting", () => {
  it("reads a plain JobPosting block", () => {
    const posting = readJobPosting([{
      "@type": "JobPosting",
      title: "Senior Frontend Engineer",
      hiringOrganization: { "@type": "Organization", name: "Halcyon Labs Ltd" },
      jobLocation: "London",
      validThrough: "2026-03-27",
    }]);
    expect(posting?.title).toBe("Senior Frontend Engineer");
    expect(posting?.organisation).toBe("Halcyon Labs Ltd");
    expect(posting?.location).toBe("London");
    expect(posting?.validThrough).toBe("2026-03-27");
  });

  it("unwraps a @graph wrapper", () => {
    const posting = readJobPosting([{
      "@context": "https://schema.org",
      "@graph": [{ "@type": "WebPage" }, { "@type": "JobPosting", title: "Data Engineer" }],
    }]);
    expect(posting?.title).toBe("Data Engineer");
  });

  it("accepts an array-valued @type", () => {
    const posting = readJobPosting([{ "@type": ["JobPosting", "Thing"], title: "Nurse" }]);
    expect(posting?.title).toBe("Nurse");
  });

  it("reads a hiringOrganization given as a bare string", () => {
    const posting = readJobPosting([{ "@type": "JobPosting", hiringOrganization: "Pentland" }]);
    expect(posting?.organisation).toBe("Pentland");
  });

  it("formats a baseSalary range", () => {
    const posting = readJobPosting([{
      "@type": "JobPosting",
      baseSalary: {
        "@type": "MonetaryAmount",
        currency: "GBP",
        value: { "@type": "QuantitativeValue", minValue: 45000, maxValue: 60000, unitText: "YEAR" },
      },
    }]);
    expect(posting?.salary).toBe("GBP 45000–60000");
  });

  it("formats a single baseSalary value", () => {
    const posting = readJobPosting([{
      "@type": "JobPosting",
      baseSalary: { "@type": "MonetaryAmount", currency: "GBP", value: { value: 52000 } },
    }]);
    expect(posting?.salary).toBe("GBP 52000");
  });

  it("reads a nested jobLocation address", () => {
    const posting = readJobPosting([{
      "@type": "JobPosting",
      jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "Leeds" } },
    }]);
    expect(posting?.location).toBe("Leeds");
  });

  it("reads the first of several job locations", () => {
    const posting = readJobPosting([{
      "@type": "JobPosting",
      jobLocation: [
        { "@type": "Place", address: { addressLocality: "Bristol" } },
        { "@type": "Place", address: { addressLocality: "Cardiff" } },
      ],
    }]);
    expect(posting?.location).toBe("Bristol");
  });

  it("reads employment type given as an array", () => {
    const posting = readJobPosting([{ "@type": "JobPosting", employmentType: ["FULL_TIME", "PART_TIME"] }]);
    expect(posting?.employmentType).toBe("Full time");
  });

  it("returns null when no block is a JobPosting", () => {
    expect(readJobPosting([{ "@type": "Article", title: "Not a job" }])).toBeNull();
    expect(readJobPosting([])).toBeNull();
  });

  it("skips a field whose value is the wrong shape rather than stringifying it", () => {
    const posting = readJobPosting([{ "@type": "JobPosting", title: { nested: "object" }, hiringOrganization: { name: "Real Ltd" } }]);
    expect(posting).not.toBeNull();
    expect(posting?.title).toBeUndefined();
    expect(posting?.organisation).toBe("Real Ltd");
  });

  it("never throws on hostile or malformed input", () => {
    const hostile: Record<string, unknown>[] = [
      { "@type": "JobPosting", title: { nested: "object" } },
      { "@type": "JobPosting", baseSalary: "not an object" },
      { "@type": "JobPosting", baseSalary: { value: { minValue: "nonsense" } } },
      { "@type": "JobPosting", jobLocation: 42 },
      { "@graph": "not an array" },
      {},
    ];
    for (const block of hostile) expect(() => readJobPosting([block])).not.toThrow();
  });
});
