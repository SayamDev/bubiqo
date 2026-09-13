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

describe("buildJobBrief — wording outside software adverts", () => {
  it("flags a DBS check written as the NHS writes it", () => {
    const brief = build(page({ text: "Disclosure and Barring Service Check\nThis post is subject to the Rehabilitation of Offenders Act." }));
    expect(brief.blockers.map((b) => b.rule)).toContain("dbs_check");
  });

  it("flags a criminal record certificate", () => {
    const brief = build(page({ text: "Applicants must present a criminal record certificate from each country." }));
    expect(brief.blockers.map((b) => b.rule)).toContain("dbs_check");
  });

  it("flags a driving licence written with a word in the middle", () => {
    const brief = build(page({ text: "Car user with use of a car and full UK Valid Driving Licence" }));
    expect(brief.blockers.map((b) => b.rule)).toContain("driving_licence");
  });

  it("does not read a welcome to sponsored applicants as a restriction", () => {
    const brief = build(
      page({
        text: "Applications from job seekers who require current Skilled worker sponsorship to work in the UK are welcome.",
      }),
    );
    expect(brief.blockers.map((b) => b.rule)).not.toContain("right_to_work");
  });
});

describe("buildJobBrief — the application form is not the advert", () => {
  const advert = "About the role. We build things. Salary £45,000 – £60,000 per annum.";
  const form = [
    "Voluntary Self-Identification",
    "For government reporting purposes, we ask candidates to respond to the below self-identification survey.",
    "Please note a criminal record check forms no part of this survey.",
    "PUBLIC BURDEN STATEMENT: this survey should take about 5 minutes to complete.",
  ].join("\n");

  it("does not read a blocker out of the equal-opportunities boilerplate", () => {
    const brief = build(page({ text: `${advert}\n${form}` }));
    expect(brief.blockers).toHaveLength(0);
    expect(brief.verdict).toBeUndefined();
  });

  it("still reads the advert above it", () => {
    const brief = build(page({ text: `${advert}\n${form}` }));
    expect(brief.salary?.value).toBe("GBP 45000–60000");
  });

  it("keeps an advert that merely mentions applying early on", () => {
    // NHS Jobs puts "Apply for this job" in the fifth line. Cutting there would
    // throw the entire advert away.
    const brief = build(
      page({ text: "Nursing Associate\nThe closing date is 17 September 2026\nApply for this job\nJob summary\nAn enhanced DBS check is required." }),
    );
    expect(brief.blockers.map((b) => b.rule)).toContain("dbs_check");
  });
});

describe("buildJobBrief — an advert with no structured data still says enough", () => {
  const advert = [
    "Senior Prompt Engineer - AI - Full-time",
    "OVI Ltd",
    "Reading, England, United Kingdom",
    "Permanent, Full-time",
    "Hybrid",
    "What's Offered • Competitive salary of £55,000–£60,000. • Permanent position with equity.",
  ].join("\n");

  it("names the employer from the advert when the site publishes none", () => {
    const brief = build(page({ headings: ["Senior Prompt Engineer"], text: advert }));
    expect(brief.organisation?.value).toBe("OVI Ltd");
    expect(brief.organisation?.source).toBe("prose");
  });

  it("reads the contract type from the advert", () => {
    const brief = build(page({ text: advert }));
    expect(brief.employmentType?.value).toBe("Permanent");
    expect(brief.employmentType?.source).toBe("prose");
  });

  it("keeps the structured employment type when there is one", () => {
    const brief = build(
      page({
        structuredData: [{ "@type": "JobPosting", employmentType: "FULL_TIME" }],
        text: advert,
      }),
    );
    expect(brief.employmentType?.value).toBe("Full time");
    expect(brief.employmentType?.source).toBe("structured");
  });

  it("does not invent a contract type the advert never states", () => {
    const brief = build(page({ text: "We are hiring a gardener. Apply now." }));
    expect(brief.employmentType).toBeUndefined();
  });
});

describe("buildJobBrief — finding the employer where job boards put it", () => {
  it("takes it from the document title, between the role and the site", () => {
    const brief = build(
      page({
        title: "Senior Prompt Engineer - AI - Full-time | OVI | LinkedIn",
        text: "OVI\nSenior Prompt Engineer - AI - Full-time\nReading, England\nPermanent",
      }),
    );
    expect(brief.organisation?.value).toBe("OVI");
  });

  it("takes it from the first line when the advert opens with it", () => {
    const brief = build(
      page({
        title: "Job Advert",
        text: "Central and North West London NHS Foundation Trust\nNursing Associate - School Nursing\nThe closing date is 17 September 2026",
      }),
    );
    expect(brief.organisation?.value).toBe("Central and North West London NHS Foundation Trust");
  });

  it("does not mistake a place for an employer", () => {
    const brief = build(
      page({
        title: "Product Manager - Integration - Swindon SN38 - Indeed.com",
        text: "Product Manager - Integration\nSwindon SN38\n£47,200 - £70,800 a year",
      }),
    );
    expect(brief.organisation?.value).not.toBe("Swindon SN38");
  });

  it("says nothing when the advert names no employer", () => {
    const brief = build(page({ title: "Jobs", text: "We are hiring a gardener. £25,000 a year." }));
    expect(brief.organisation).toBeUndefined();
  });
});

/*
 * An Indeed search page with the advert in its pane, captured 13 September 2026.
 *
 * Reported from the extension: the brief was headed "JOB POST DETAILS" with
 * "PROJECT MANAGER" shown as the employer, and the saved record read
 * "JOB TITLE: Job Post Details / ORGANISATION: Project Manager". The employer,
 * EdenCare, appears twice on the page and neither was used.
 */
describe("buildJobBrief — an Indeed pane, which names things its own way", () => {
  const indeedPane = page({
    title: "Edencare Support Services Project Manager Job in Bolton (with Salaries) | Indeed United Kingdom",
    headings: ["Job Post Details", "Project Manager - job post", "Job details", "Pay", "Job type", "Location", "Full job description"],
    text: [
      "Return to Search Result",
      "Job Post Details",
      "Project Manager",
      "- job post",
      "Edencare",
      "53 Thicketford Road, Bolton BL2 2LS",
      "From £33,900 a year - Full-time",
      "Apply with Indeed",
      "Full job description",
      "About EdenCare Support Services Ltd",
      "EdenCare Support Services Ltd provides high-quality, person-centred care and support.",
      "Person Specification",
      "Knowledge, Skills, Experience and Qualifications",
      "Essential",
      "· Proven experience of leading and managing projects in health, social care or a related regulated environment.",
    ].join("\n"),
  });

  it("names the job, not the pane's own heading", () => {
    const brief = build(indeedPane);
    expect(brief.title?.value).toBe("Project Manager");
  });

  it("names the employer, not the job title", () => {
    const brief = build(indeedPane);
    expect(brief.organisation?.value).toMatch(/EdenCare/i);
    expect(brief.organisation?.value).not.toBe("Project Manager");
  });

  it("reads the salary the advert states", () => {
    expect(build(indeedPane).salary?.value).toBe("GBP 33900");
  });

  it("reads the address the advert gives", () => {
    expect(build(indeedPane).location?.value).toContain("Bolton BL2 2LS");
  });
});

describe("buildJobBrief — quoting without cutting words in half", () => {
  it("ends a long eligibility line at a word", () => {
    const long =
      "Experience of capturing stakeholder needs, assessing, defining and justifying those needs to arrive at an agreed schedule of requirements using appropriate communication and engagement channels across the organisation.";
    const brief = build(page({ headings: ["Essential"], text: `Essential\n${long}` }));
    const quote = brief.eligibility[0] ?? "";
    expect(quote.length).toBeLessThanOrEqual(181);
    expect(quote.endsWith("…")).toBe(true);
    // "…and enga" was what the panel showed.
    expect(quote).not.toMatch(/\benga…$/);
  });
});
