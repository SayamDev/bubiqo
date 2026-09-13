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

  it("knows the headings LinkedIn shows in 2026", () => {
    // Captured from a logged-in LinkedIn job page in September 2026. The first
    // heading on the page is now an AI upsell, and the brief came out titled
    // "Use AI to assess how you fit".
    for (const heading of [
      "Use AI to assess how you fit",
      "About the job",
      "About the company",
      "Set alert for similar jobs",
    ]) {
      expect(isFurnitureHeading(heading), heading).toBe(true);
    }
  });

  it("accepts a real title", () => {
    expect(isFurnitureHeading("Javascript Developer")).toBe(false);
    expect(isFurnitureHeading("Senior Software Engineer — Cathcart Technology")).toBe(false);
    expect(isFurnitureHeading("Invoice INV-2026-0042")).toBe(false);
  });
});

describe("removing a site's own furniture", () => {
  it("drops upsells and prompts entirely", async () => {
    const { narrowToContent } = await import("@core/readability");
    const text = [
      "Javascript Developer",
      "Better Placed",
      "Take the next step in your job search",
      "Reactivate Premium: 50% Off",
      "Determine your fit and how to stand out",
      "Meet the hiring team",
      "About the job",
      "x".repeat(400),
    ].join("\n");

    const narrowed = narrowToContent(text);
    expect(narrowed).not.toMatch(/Premium|next step|Determine your fit|hiring team/);
    expect(narrowed).toContain("Javascript Developer");
    expect(narrowed).toContain("Better Placed");
  });

  it("scrubs metadata from a line that also carries something useful", async () => {
    /*
     * "Manchester Area, United Kingdom · 1 week ago · Over 100 applicants" is a
     * location plus two pieces of site chrome. Dropping the line loses the
     * location; keeping it leaves an applicant count to be read as a number.
     */
    const { narrowToContent } = await import("@core/readability");
    const text = `Manchester Area, United Kingdom · 1 week ago · Over 100 applicants\n${"x".repeat(400)}`;
    const narrowed = narrowToContent(text);

    expect(narrowed).toContain("Manchester Area, United Kingdom");
    expect(narrowed).not.toMatch(/applicants|week ago/);
  });

  it("never narrows a page down to nothing", async () => {
    const { narrowToContent } = await import("@core/readability");
    const short = "Reactivate Premium: 50% Off";
    expect(narrowToContent(short)).toBe(short);
  });

  it("leaves an ordinary page untouched", async () => {
    const { narrowToContent } = await import("@core/readability");
    const prose = `Dear Sayam,\n\n${"This is an ordinary email. ".repeat(20)}`;
    expect(narrowToContent(prose)).toBe(prose.trim());
  });
});

describe("Readability's signals, which I should have started from", () => {
  /*
   * These four come from Mozilla's Readability — the algorithm behind Firefox
   * Reader View — rather than from me guessing. Each targets exactly what kept
   * going wrong, and looking them up would have saved several rounds of
   * hand-rolled heuristics that were worse.
   *
   * https://webcrawlerapi.com/blog/mozilla-readability-algorithm-readabilityjs
   */
  const block = (partial: Partial<BlockStats> & { index: number; textLength: number }): BlockStats => ({
    linkTextLength: 0, linkCount: 0, depth: 2, ...partial,
  });

  it("refuses a container that calls itself a sidebar, however well it otherwise scores", () => {
    const sidebar = block({ index: 0, textLength: 5000, commas: 60, signature: "jobs-sidebar scaffold-layout__list" });
    expect(scoreBlock(sidebar)).toBe(0);
  });

  it("refuses promos, upsells and results lists by name", () => {
    for (const signature of ["premium-upsell", "search-results-list", "job-card-container", "promo-banner"]) {
      expect(scoreBlock(block({ index: 0, textLength: 4000, signature })), signature).toBe(0);
    }
  });

  it("keeps a container whose name says it IS the content, even if it also says sidebar", () => {
    // "job-details-sidebar" is where LinkedIn actually puts the advert.
    const s = scoreBlock(block({ index: 0, textLength: 3000, commas: 40, signature: "job-details-sidebar" }));
    expect(s).toBeGreaterThan(0);
  });

  it("prefers punctuated prose to an unpunctuated list of the same length", () => {
    const prose = block({ index: 0, textLength: 3000, commas: 45, signature: "job-description" });
    const list = block({ index: 1, textLength: 3000, commas: 2, signature: "cards" });
    expect(scoreBlock(prose)).toBeGreaterThan(scoreBlock(list));
  });

  it("weights a container that names itself content", () => {
    const named = block({ index: 0, textLength: 3000, commas: 20, signature: "article-content" });
    const anonymous = block({ index: 1, textLength: 3000, commas: 20, signature: "" });
    expect(scoreBlock(named)).toBeGreaterThan(scoreBlock(anonymous));
  });

  it("still ignores class names when the block is plainly navigation", () => {
    // A helpful-sounding name does not rescue something that is 80% links.
    const linky = block({ index: 0, textLength: 3000, linkTextLength: 2400, linkCount: 90, signature: "main-content" });
    expect(scoreBlock(linky)).toBe(0);
  });
});

/*
 * A job board that shows a list of adverts beside the selected one.
 *
 * Measured on uk.indeed.com in September 2026: the card list is
 * "mosaic-provider-jobcards" at 5,125 characters, the detail pane is
 * "jobsearch-RightPane" at 34,943, and <main> holds both. Reading <main> mixed
 * three other adverts' salaries into the brief and named the employer "New" —
 * the badge on a neighbouring card.
 */
describe("a list of adverts beside the one being read", () => {
  const pane = (over: Partial<BlockStats> = {}): BlockStats => ({
    index: 1, textLength: 34943, linkTextLength: 2000, linkCount: 40, depth: 2,
    commas: 300, signature: "jobsearch-RightPane serp-page-6iabie eu4oa1w0", ...over,
  });
  const list = (over: Partial<BlockStats> = {}): BlockStats => ({
    index: 2, textLength: 5125, linkTextLength: 2600, linkCount: 60, depth: 2,
    commas: 30, signature: "mosaic mosaic-provider-jobcards mosaic-provider-hydrated", ...over,
  });
  const main = (over: Partial<BlockStats> = {}): BlockStats => ({
    index: 0, textLength: 40068, linkTextLength: 4600, linkCount: 100, depth: 0,
    commas: 330, signature: "is-i18n", ...over,
  });

  it("reads the pane holding the advert, not the whole page around it", () => {
    const best = pickBestBlock([main(), list(), pane()]);
    expect(best?.index, "the detail pane should win").toBe(1);
  });

  it("scores a card list at nothing", () => {
    expect(scoreBlock(list())).toBe(0);
  });

  it("prefers the pane on LinkedIn's equivalent markup", () => {
    const linkedInPane = pane({ signature: "jobs-search__job-details--wrapper" });
    const linkedInList = list({ signature: "jobs-search-results-list" });
    const best = pickBestBlock([main(), linkedInList, linkedInPane]);
    expect(best?.index).toBe(1);
  });

  it("still reads the whole region on a page that has no detail pane", () => {
    const article = { index: 0, textLength: 3000, linkTextLength: 100, linkCount: 4, depth: 0, commas: 40, signature: "job-description" };
    expect(pickBestBlock([article])?.index).toBe(0);
  });
});

describe("nested detail panes", () => {
  it("takes the outer pane, which still has the job title on it", () => {
    // Indeed nests jobsearch-JobComponent-description inside jobsearch-RightPane.
    // The inner block scores better — it holds no links — but it begins below the
    // job title and the employer's name, which is the half that says whose job
    // this is. Measured September 2026: 34,943 chars outer, 31,804 inner.
    const outer: BlockStats = {
      index: 1, textLength: 34943, linkTextLength: 2000, linkCount: 40, depth: 1,
      commas: 300, signature: "jobsearch-RightPane",
    };
    const inner: BlockStats = {
      index: 2, textLength: 31804, linkTextLength: 0, linkCount: 0, depth: 1,
      commas: 290, signature: "jobsearch-JobComponent-description css-dyse26",
    };
    expect(pickBestBlock([outer, inner])?.index).toBe(1);
  });
});

/*
 * The injected extractor cannot import — Chrome serialises it — so it carries an
 * inlined copy of the scoring rules. That duplication is the cost recorded in
 * ADR 0001, and the failure it invites is drift: the tested copy gets a fix and
 * the copy that actually runs on the page does not.
 *
 * This is the cheapest guard against that. It compares source text, which is
 * crude, and which is the point: it fails the moment the two stop matching.
 */
describe("the injected extractor keeps up with the tested rules", () => {
  it("carries the same UNLIKELY, LIKELY and DETAIL_PANE patterns", async () => {
    const { readFileSync } = await import("node:fs");
    const extract = readFileSync("extension/src/background/extract.ts", "utf8");
    const readability = readFileSync("extension/src/core/readability.ts", "utf8");

    const pattern = (source: string, name: string): string => {
      const match = new RegExp(`${name}\\s*=\\s*\\n?\\s*(/.+/i);`).exec(source);
      if (!match) throw new Error(`${name} not found`);
      return match[1] as string;
    };

    expect(pattern(extract, "UNLIKELY")).toBe(pattern(readability, "UNLIKELY_CANDIDATE"));
    expect(pattern(extract, "LIKELY")).toBe(pattern(readability, "LIKELY_CANDIDATE"));
    expect(pattern(extract, "DETAIL_PANE")).toBe(pattern(readability, "DETAIL_PANE"));
  });
});

describe("LinkedIn keeps inventing upsells", () => {
  it("knows the ones seen in September 2026", () => {
    for (const heading of [
      "Unlock hiring insights on Gamma",
      "Use AI to assess how you fit",
      "See how you compare to other applicants",
    ]) {
      expect(isFurnitureHeading(heading), heading).toBe(true);
    }
  });
});
