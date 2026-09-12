import { describe, it, expect } from "vitest";
import { buildJobBrief } from "@core/job-brief";
import { extractEntities } from "@core/entity-engine";
import type { JobBrief, PageContext } from "@core/types";

/**
 * The brief as the pipeline builds it: over the Entities the engine extracted,
 * because that is where the decision about which amount on a page is the salary
 * already lives.
 */
function build(page: PageContext, now = NOW): JobBrief {
  return buildJobBrief(page, extractEntities(page, now), now);
}

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
    const brief = build(
      page({ text: "About the role. You must hold active SC cleared status before starting. We offer a pension." }),
      NOW,
    );
    const blocker = brief.blockers.find((b) => b.rule === "security_clearance");
    expect(blocker?.summary).toBe("Security clearance required");
    expect(blocker?.evidence).toMatch(/SC cleared/);
    expect(brief.verdict).toBe("ruled_out");
  });

  it("flags a citizenship requirement written as a bullet under a heading", () => {
    const brief = build(page({ text: "To Be Eligible, You Must\nBe a British citizen." }));
    expect(brief.blockers.map((b) => b.rule)).toContain("british_citizen");
  });

  it("quotes only the line a bullet blocker sits on", () => {
    const brief = build(
      page({ text: "To Be Eligible, You Must\nBe a British citizen\nHold a valid passport\nBe over 18" }),
      NOW,
    );
    const blocker = brief.blockers.find((b) => b.rule === "british_citizen");
    expect(blocker?.evidence).toBe("Be a British citizen");
  });

  it("flags an inability to sponsor", () => {
    const brief = build(page({ text: "We are unable to sponsor visas for this role." }));
    expect(brief.blockers.map((b) => b.rule)).toContain("right_to_work");
  });

  it("flags a residency period", () => {
    const brief = build(page({ text: "You must have resided in the UK for the last five years." }));
    expect(brief.blockers.map((b) => b.rule)).toContain("uk_residency");
  });

  it("flags a driving licence", () => {
    const brief = build(page({ text: "A full UK driving licence is essential for this post." }));
    expect(brief.blockers.map((b) => b.rule)).toContain("driving_licence");
  });

  it("flags a DBS check", () => {
    const brief = build(page({ text: "This post is subject to an enhanced DBS check." }));
    expect(brief.blockers.map((b) => b.rule)).toContain("dbs_check");
  });

  it("reports each rule once however often the advert repeats it", () => {
    const brief = build(
      page({ text: "Security clearance is required. You will need SC cleared status. DV cleared preferred." }),
      NOW,
    );
    expect(brief.blockers.filter((b) => b.rule === "security_clearance")).toHaveLength(1);
  });

  it("gives no verdict when nothing blocks", () => {
    const brief = build(
      page({ text: "A friendly team looking for someone to help with events. 3 years' experience preferred." }),
      NOW,
    );
    expect(brief.blockers).toHaveLength(0);
    expect(brief.verdict).toBeUndefined();
  });

  it("treats years of experience as no blocker at all", () => {
    const brief = build(page({ text: "You will have 5+ years' commercial experience." }));
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
    const brief = build(
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
    const brief = build(
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
    const brief = build(page({ text: "Paying £55k per annum, depending on experience." }));
    expect(brief.salary?.value).toBe("GBP 55000");
  });

  it("refuses a number that cannot be a salary", () => {
    const brief = build(page({ text: "Interviews start at £9 per hour parking. Apply now." }));
    expect(brief.salary).toBeUndefined();
  });

  it("reads a prose closing date", () => {
    const brief = build(page({ text: "Closing date: 3 October 2026. Apply early." }));
    // core/dates.ts resolves to local time, as it does everywhere else.
    expect(brief.closingDate?.value).toBe(new Date(2026, 9, 3, 9, 0, 0, 0).getTime());
    expect(brief.closingDate?.source).toBe("prose");
  });

  it("leaves the closing date absent when the advert's date is ambiguous", () => {
    const brief = build(page({ text: "Closing date: 03/10/2026." }));
    expect(brief.closingDate).toBeUndefined();
  });

  it("fills a gap in the structured data from prose", () => {
    const brief = build(
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

describe("buildJobBrief — titles", () => {
  it("does not take a page-furniture heading as the job title", () => {
    const brief = build(
      page({
        title: "Full Stack Engineer | MRJ Recruitment | LinkedIn",
        headings: ["Are these results helpful?", "Java fullstack Engineer", "About the job"],
        text: "About the job. We are hiring.",
      }),
      NOW,
    );
    expect(brief.title?.value).toBe("Java fullstack Engineer");
  });
});

describe("buildJobBrief — eligibility quotes", () => {
  it("does not start a section on a sentence that merely contains the word essential", () => {
    const brief = build(
      page({
        text: [
          "Consultancy experience would be helpful, but it is not essential.",
          "Security requirements",
          "The successful candidate must obtain UK security clearance.",
          "Whats on offer",
          "Competitive salary of up to 85,000",
        ].join("\n"),
      }),
      NOW,
    );
    expect(brief.eligibility).not.toContain("Security requirements");
    expect(brief.eligibility).toContain("The successful candidate must obtain UK security clearance.");
    expect(brief.eligibility).not.toContain("Competitive salary of up to 85,000");
  });

  it("collects every eligibility section the advert has", () => {
    const brief = build(
      page({
        text: [
          "Security requirements",
          "You will need clearance.",
          "To Be Eligible, You Must",
          "* Be a British citizen",
          "* Have lived permanently in the UK for the last five years",
          "Whats on offer",
          "* Competitive salary",
        ].join("\n"),
      }),
      NOW,
    );
    expect(brief.eligibility).toContain("You will need clearance.");
    expect(brief.eligibility).toContain("Be a British citizen");
    expect(brief.eligibility).not.toContain("To Be Eligible, You Must");
    expect(brief.eligibility).not.toContain("Competitive salary");
  });

  it("quotes the advert's own eligibility lines", () => {
    const brief = build(
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
    const brief = build(
      page({ headings: ["Essential requirements"], text: ["Essential requirements", ...lines].join("\n") }),
      NOW,
    );
    expect(brief.eligibility.length).toBeLessThanOrEqual(8);
  });

  it("quotes nothing when the advert has no eligibility section", () => {
    const brief = build(page({ text: "We are a friendly team. Come and work with us." }));
    expect(brief.eligibility).toHaveLength(0);
  });

  it("is deterministic", () => {
    const p = page({ text: "You must hold SC cleared status. Salary £50,000 per annum." });
    expect(build(p)).toEqual(build(p));
  });
});
