import { describe, it, expect } from "vitest";
import { pickBestBlock, scoreBlock, linkDensity, isFurnitureHeading, type BlockStats } from "@core/readability";

const block = (partial: Partial<BlockStats> & { index: number; textLength: number }): BlockStats => ({
  linkTextLength: 0,
  linkCount: 0,
  depth: 2,
  ...partial,
});

describe("choosing the content on a real jobs page", () => {
  /*
   * Numbers taken from the shape of a LinkedIn jobs page, which is what broke:
   * <main> holds the filter bar, a list of 25 other jobs, a feedback survey and
   * the advert being read. Reading all of it produced a company called "Easy
   * Apply GBV Ltd" and a salary of £55.
   */
  const wholeMain = block({ index: 0, textLength: 9400, linkTextLength: 3900, linkCount: 180, depth: 0 });
  const resultsList = block({ index: 1, textLength: 5200, linkTextLength: 3400, linkCount: 150, depth: 2 });
  const filterBar = block({ index: 2, textLength: 320, linkTextLength: 240, linkCount: 22, depth: 2 });
  const jobDetail = block({ index: 3, textLength: 3100, linkTextLength: 180, linkCount: 6, depth: 2 });
  const surveyWidget = block({ index: 4, textLength: 300, linkTextLength: 60, linkCount: 3, depth: 3 });

  const candidates = [wholeMain, resultsList, filterBar, jobDetail, surveyWidget];

  it("picks the advert, not the list of other jobs", () => {
    expect(pickBestBlock(candidates)?.index).toBe(jobDetail.index);
  });

  it("scores the results list at zero — it is almost all link text", () => {
    expect(scoreBlock(resultsList)).toBe(0);
    expect(linkDensity(resultsList)).toBeGreaterThan(0.45);
  });

  it("rejects the filter bar as a fragment", () => {
    expect(scoreBlock(filterBar)).toBe(0);
  });

  it("beats the whole of main, which mixes everything together", () => {
    expect(scoreBlock(jobDetail)).toBeGreaterThan(scoreBlock(wholeMain));
  });

  it("prefers prose to a longer block with the same readable text", () => {
    const linky = block({ index: 9, textLength: 6000, linkTextLength: 2600, linkCount: 90, depth: 2 });
    expect(scoreBlock(jobDetail)).toBeGreaterThan(scoreBlock(linky));
  });
});

describe("simple pages", () => {
  it("returns nothing when no candidate looks like content, so the caller falls back", () => {
    expect(pickBestBlock([block({ index: 0, textLength: 90 })])).toBeUndefined();
    expect(pickBestBlock([])).toBeUndefined();
  });

  it("takes an ordinary article", () => {
    const article = block({ index: 0, textLength: 4200, linkTextLength: 300, linkCount: 8, depth: 1 });
    expect(pickBestBlock([article])?.index).toBe(0);
  });

  it("prefers the outer of two blocks holding the same text", () => {
    const outer = block({ index: 0, textLength: 3000, linkTextLength: 100, linkCount: 4, depth: 1 });
    const inner = block({ index: 1, textLength: 2900, linkTextLength: 100, linkCount: 4, depth: 5 });
    expect(pickBestBlock([outer, inner])?.index).toBe(0);
  });
});

describe("headings that are furniture, not titles", () => {
  it("rejects the survey widget that was naming saved jobs", () => {
    // Items were being filed under this, which is a feedback prompt, not a title.
    expect(isFurnitureHeading("Are these results helpful?")).toBe(true);
  });

  it("rejects UI controls and list headers", () => {
    for (const heading of [
      "Save", "Easy Apply", "Similar jobs", "People also viewed",
      "Jobs based on your preferences", "Create job alert", "Messaging",
    ]) {
      expect(isFurnitureHeading(heading), heading).toBe(true);
    }
  });

  it("rejects anything phrased as a question to the reader", () => {
    expect(isFurnitureHeading("Know someone who'd be a good fit?")).toBe(true);
  });

  it("accepts a real title", () => {
    expect(isFurnitureHeading("Javascript Developer")).toBe(false);
    expect(isFurnitureHeading("Senior Software Engineer — Cathcart Technology")).toBe(false);
    expect(isFurnitureHeading("Invoice INV-2026-0042")).toBe(false);
  });
});
