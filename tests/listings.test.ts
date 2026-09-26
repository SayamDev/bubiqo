import { describe, it, expect } from "vitest";
import { extractListings, listingLines } from "@core/listings";

const JOBRIGHT = [
  "Jobright",
  "Explore this today's top matches, curated to align with your preferences, experiences, and skill sets.",
  "Euphoric",
  "Computer Software · Early Stage",
  "98%",
  "Software Engineer (Applied AI)",
  "£100K/yr - £130K/yr",
  "Remote",
  "9 hours ago · Be an early applicant",
  "APPLY NOW",
  "LSA : London Success Academy",
  "Professional Training & Coaching · Early Stage",
  "97%",
  "Developer Work Placement (Software & Web Development) (Remote)",
  "Remote",
  "10 hours ago · Be an early applicant",
  "APPLY NOW",
  "Bromcom",
  "Information Technology · Growth Stage",
  "95%",
  ".NET Full-Stack Developer",
  "Remote",
  "15 hours ago · Be an early applicant",
  "APPLY NOW",
].join("\n");

describe("job alert digests", () => {
  it("reads each listing: company, title, pay, where", () => {
    const listings = extractListings(JOBRIGHT);
    expect(listings).toHaveLength(3);
    expect(listings[0]).toEqual({
      company: "Euphoric",
      title: "Software Engineer (Applied AI)",
      pay: "£100K/yr – £130K/yr",
      where: "Remote",
    });
    expect(listings[1]).toMatchObject({ company: "LSA : London Success Academy", where: "Remote" });
    expect(listings[2]).toMatchObject({ company: "Bromcom", title: ".NET Full-Stack Developer" });
  });

  it("never takes the industry tag for the employer", () => {
    const text = listingLines(extractListings(JOBRIGHT)).join("\n");
    expect(text).not.toContain("Computer Software");
    expect(text).toContain("Software Engineer (Applied AI) at Euphoric · £100K/yr – £130K/yr · Remote");
  });

  it("leaves a single advert alone", () => {
    expect(extractListings("Data8 Ltd\nBusiness Applications Developer\n£35,000\nApply now")).toEqual([]);
  });
});
