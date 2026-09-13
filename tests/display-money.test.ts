import { describe, it, expect } from "vitest";
import { displayMoney } from "../extension/src/sidepanel/format";

describe("displayMoney", () => {
  it("turns the stored format into something a person reads", () => {
    expect(displayMoney("GBP 70000–85000")).toBe("£70,000–85,000");
    expect(displayMoney("GBP 78000")).toBe("£78,000");
  });

  it("keeps the code when there is no symbol for it", () => {
    expect(displayMoney("PLN 120000")).toBe("PLN 120,000");
  });

  it("leaves anything it does not recognise alone", () => {
    expect(displayMoney("Competitive")).toBe("Competitive");
    expect(displayMoney("")).toBe("");
  });

  it("keeps pence where the amount has them", () => {
    expect(displayMoney("EUR 2880.50")).toBe("€2,880.50");
  });
});

describe("the headline on a job advert", () => {
  it("says what the advert is, not that nothing is urgent", async () => {
    const { jobHeadline } = await import("../extension/src/sidepanel/format");
    expect(jobHeadline({ blockers: 0, requirements: 6, hasSalary: true })).toBe("Here is this job, in short");
    expect(jobHeadline({ blockers: 2, requirements: 4, hasSalary: true })).toBe("Two conditions would rule you out");
    expect(jobHeadline({ blockers: 1, requirements: 0, hasSalary: false })).toBe("One condition would rule you out");
  });

  it("says nothing special when the advert gave it nothing", async () => {
    const { jobHeadline } = await import("../extension/src/sidepanel/format");
    expect(jobHeadline({ blockers: 0, requirements: 0, hasSalary: false })).toBeUndefined();
  });
});
