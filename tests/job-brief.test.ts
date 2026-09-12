import { describe, it, expect } from "vitest";
import { buildJobBrief } from "@core/job-brief";
import type { PageContext } from "@core/types";

const NOW = Date.UTC(2026, 8, 12);

function page(over: Partial<PageContext> = {}): PageContext {
  return {
    url: "https://example.com/job",
    domain: "example.com",
    title: "A job",
    text: "",
    headings: [],
    fields: [],
    structuredData: [],
    links: [],
    capturedAt: NOW,
    ...over,
  };
}

describe("buildJobBrief — blockers", () => {
  it("flags security clearance with the advert's own sentence", () => {
    const brief = buildJobBrief(
      page({ text: "About the role. You must hold active SC cleared status before starting. We offer a pension." }),
      NOW,
    );
    const blocker = brief.blockers.find((b) => b.rule === "security_clearance");
    expect(blocker?.summary).toBe("Security clearance required");
    expect(blocker?.evidence).toMatch(/SC cleared/);
    expect(brief.verdict).toBe("ruled_out");
  });

  it("flags a citizenship requirement written as a bullet under a heading", () => {
    const brief = buildJobBrief(page({ text: "To Be Eligible, You Must\nBe a British citizen." }), NOW);
    expect(brief.blockers.map((b) => b.rule)).toContain("british_citizen");
  });

  it("quotes only the line a bullet blocker sits on", () => {
    const brief = buildJobBrief(
      page({ text: "To Be Eligible, You Must\nBe a British citizen\nHold a valid passport\nBe over 18" }),
      NOW,
    );
    const blocker = brief.blockers.find((b) => b.rule === "british_citizen");
    expect(blocker?.evidence).toBe("Be a British citizen");
  });

  it("flags an inability to sponsor", () => {
    const brief = buildJobBrief(page({ text: "We are unable to sponsor visas for this role." }), NOW);
    expect(brief.blockers.map((b) => b.rule)).toContain("right_to_work");
  });

  it("flags a residency period", () => {
    const brief = buildJobBrief(page({ text: "You must have resided in the UK for the last five years." }), NOW);
    expect(brief.blockers.map((b) => b.rule)).toContain("uk_residency");
  });

  it("flags a driving licence", () => {
    const brief = buildJobBrief(page({ text: "A full UK driving licence is essential for this post." }), NOW);
    expect(brief.blockers.map((b) => b.rule)).toContain("driving_licence");
  });

  it("flags a DBS check", () => {
    const brief = buildJobBrief(page({ text: "This post is subject to an enhanced DBS check." }), NOW);
    expect(brief.blockers.map((b) => b.rule)).toContain("dbs_check");
  });

  it("reports each rule once however often the advert repeats it", () => {
    const brief = buildJobBrief(
      page({ text: "Security clearance is required. You will need SC cleared status. DV cleared preferred." }),
      NOW,
    );
    expect(brief.blockers.filter((b) => b.rule === "security_clearance")).toHaveLength(1);
  });

  it("gives no verdict when nothing blocks", () => {
    const brief = buildJobBrief(
      page({ text: "A friendly team looking for someone to help with events. 3 years' experience preferred." }),
      NOW,
    );
    expect(brief.blockers).toHaveLength(0);
    expect(brief.verdict).toBeUndefined();
  });

  it("treats years of experience as no blocker at all", () => {
    const brief = buildJobBrief(page({ text: "You will have 5+ years' commercial experience." }), NOW);
    expect(brief.blockers).toHaveLength(0);
  });
});

describe("buildJobBrief — structured beats prose", () => {
  const structured = [
    {
      "@type": "JobPosting",
      title: "Senior Frontend Engineer",
      hiringOrganization: { name: "Halcyon Labs Ltd" },
      baseSalary: { currency: "GBP", value: { minValue: 45000, maxValue: 60000 } },
      validThrough: "2026-10-01",
    },
  ];

  it("prefers the site's own statement of the facts", () => {
    const brief = buildJobBrief(
      page({
        structuredData: structured,
        title: "Jobs | ExampleBoard",
        headings: ["Junior Developer"],
        text: "Salary £30,000 – £35,000 for a Junior Developer at SomeoneElse Ltd.",
      }),
      NOW,
    );
    expect(brief.title?.value).toBe("Senior Frontend Engineer");
    expect(brief.title?.source).toBe("structured");
    expect(brief.organisation?.value).toBe("Halcyon Labs Ltd");
    expect(brief.salary?.value).toBe("GBP 45000–60000");
    expect(brief.closingDate?.value).toBe(Date.UTC(2026, 9, 1));
    expect(brief.closingDate?.source).toBe("structured");
  });

  it("falls back to prose when there is no structured data", () => {
    const brief = buildJobBrief(
      page({
        headings: ["Senior Frontend Engineer"],
        text: "Senior Frontend Engineer\nSalary £45,000 – £60,000 per annum. Hybrid, 2 days on-site.",
      }),
      NOW,
    );
    expect(brief.title?.value).toBe("Senior Frontend Engineer");
    expect(brief.title?.source).toBe("prose");
    expect(brief.salary?.value).toBe("GBP 45000–60000");
    expect(brief.salary?.source).toBe("prose");
    expect(brief.workingPattern?.value).toMatch(/2 days on-site/i);
  });

  it("reads a single prose salary written with a k suffix", () => {
    const brief = buildJobBrief(page({ text: "Paying £55k per annum, depending on experience." }), NOW);
    expect(brief.salary?.value).toBe("GBP 55000");
  });

  it("refuses a number that cannot be a salary", () => {
    const brief = buildJobBrief(page({ text: "Interviews start at £9 per hour parking. Apply now." }), NOW);
    expect(brief.salary).toBeUndefined();
  });

  it("reads a prose closing date", () => {
    const brief = buildJobBrief(page({ text: "Closing date: 3 October 2026. Apply early." }), NOW);
    // core/dates.ts resolves to local time, as it does everywhere else.
    expect(brief.closingDate?.value).toBe(new Date(2026, 9, 3, 9, 0, 0, 0).getTime());
    expect(brief.closingDate?.source).toBe("prose");
  });

  it("leaves the closing date absent when the advert's date is ambiguous", () => {
    const brief = buildJobBrief(page({ text: "Closing date: 03/10/2026." }), NOW);
    expect(brief.closingDate).toBeUndefined();
  });

  it("fills a gap in the structured data from prose", () => {
    const brief = buildJobBrief(
      page({
        structuredData: [{ "@type": "JobPosting", title: "Support Worker" }],
        text: "Support Worker. Salary £24,000 – £27,000 per annum. Fully on-site.",
      }),
      NOW,
    );
    expect(brief.title?.source).toBe("structured");
    expect(brief.salary?.value).toBe("GBP 24000–27000");
    expect(brief.salary?.source).toBe("prose");
  });
});

describe("buildJobBrief — eligibility quotes", () => {
  it("quotes the advert's own eligibility lines", () => {
    const brief = buildJobBrief(
      page({
        headings: ["To Be Eligible, You Must"],
        text: [
          "About the role. We build things.",
          "To Be Eligible, You Must",
          "Hold a current first aid certificate",
          "Be available for weekend shifts",
          "What we offer",
          "A pension and 25 days holiday",
        ].join("\n"),
      }),
      NOW,
    );
    expect(brief.eligibility).toContain("Hold a current first aid certificate");
    expect(brief.eligibility).toContain("Be available for weekend shifts");
    expect(brief.eligibility).not.toContain("A pension and 25 days holiday");
  });

  it("caps the quotes", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Requirement number ${i}`);
    const brief = buildJobBrief(
      page({ headings: ["Essential requirements"], text: ["Essential requirements", ...lines].join("\n") }),
      NOW,
    );
    expect(brief.eligibility.length).toBeLessThanOrEqual(8);
  });

  it("quotes nothing when the advert has no eligibility section", () => {
    const brief = buildJobBrief(page({ text: "We are a friendly team. Come and work with us." }), NOW);
    expect(brief.eligibility).toHaveLength(0);
  });

  it("is deterministic", () => {
    const p = page({ text: "You must hold SC cleared status. Salary £50,000 per annum." });
    expect(buildJobBrief(p, NOW)).toEqual(buildJobBrief(p, NOW));
  });
});
