import { describe, it, expect } from "vitest";
import { findSkills, findRequirements } from "@core/job-details";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PageContext } from "@core/types";

const here = dirname(fileURLToPath(import.meta.url));
const advert = (JSON.parse(readFileSync(resolve(here, "captured", "linkedin-tech-lead.json"), "utf8")) as PageContext).text;

describe("skills, on the real advert", () => {
  const names = findSkills(advert).map((s) => s.name);

  it("finds the stack the job is actually built on", () => {
    for (const skill of ["Java", "JavaScript", "React", "TypeScript", "AWS", "GitLab"]) {
      expect(names, `${skill} was missed`).toContain(skill);
    }
  });

  it("does not confuse Java with JavaScript", () => {
    // "JavaScript" contains "Java". Both are named here, and both must survive.
    expect(names).toContain("Java");
    expect(names).toContain("JavaScript");
  });

  it("drops a shorter name that only ever appears inside a longer one", () => {
    // "Go" appears in "Good" and "Going" but is not a language this advert wants.
    expect(findSkills("Good experience. Going forward we use Golang.").map((s) => s.name)).not.toContain("Go");
  });

  it("ranks what the job is about above what it merely touches", () => {
    const ranked = findSkills(advert);
    expect(ranked[0]!.mentions).toBeGreaterThan(1);
  });

  it("invents nothing", () => {
    // The one thing worse than missing a skill is claiming one that is not there.
    for (const name of names) {
      expect(advert.toLowerCase(), `${name} is not in the advert`).toContain(name.toLowerCase());
    }
  });

  it("finds nothing in prose that names no technology", () => {
    expect(findSkills("We are looking for a warm, organised person to join our team.")).toHaveLength(0);
  });
});

describe("requirements, on the real advert", () => {
  const found = findRequirements(advert);
  const summaries = found.map((r) => r.summary);

  it("finds the deal-breakers buried three-quarters of the way down", () => {
    expect(summaries).toContain("Security clearance required");
    expect(summaries).toContain("Must be a British citizen");
    expect(summaries).toContain("UK residency period required");
  });

  it("puts the blocking ones first, because they decide whether to read on", () => {
    expect(found[0]!.blocking).toBe(true);
  });

  it("quotes the sentence, so the claim can be checked", () => {
    const clearance = found.find((r) => r.summary === "Security clearance required")!;
    expect(clearance.evidence).toMatch(/security clearance/i);
    expect(clearance.evidence.length).toBeGreaterThan(20);
  });

  it("separates a blocking condition from a soft one", () => {
    const years = found.find((r) => r.summary === "Minimum years of experience");
    if (years) expect(years.blocking).toBe(false);
  });

  it("finds nothing in an advert with no conditions", () => {
    expect(findRequirements("A friendly team looking for someone to help with events.")).toHaveLength(0);
  });

  it("catches sponsorship restrictions, which rule people out silently", () => {
    expect(findRequirements("We are unable to sponsor visas for this role.").map((r) => r.summary))
      .toContain("Right to work restrictions");
  });
});
