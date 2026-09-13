import { describe, it, expect } from "vitest";
import { nextCheckDelay, hasMoved, ATTENTIVE_MS, SETTLED_MS, ATTENTIVE_WINDOW_MS } from "../extension/src/sidepanel/watch";

const NOW = 1_000_000;
const print = (over: Partial<{ url: string; title: string; heading: string; length: number }> = {}) => ({
  url: "https://uk.indeed.com/jobs?q=x&vjs=1",
  title: "Product Manager - Indeed.com",
  heading: "Product Manager",
  length: 7473,
  ...over,
});

describe("how often to check", () => {
  it("checks attentively while the user is moving around", () => {
    expect(nextCheckDelay({ lastActivityAt: NOW - 1_000, visible: true, busy: false, readable: true }, NOW)).toBe(ATTENTIVE_MS);
  });

  it("spaces the checks out once they have settled", () => {
    const settled = NOW - ATTENTIVE_WINDOW_MS - 1;
    expect(nextCheckDelay({ lastActivityAt: settled, visible: true, busy: false, readable: true }, NOW)).toBe(SETTLED_MS);
  });

  it("slows down on a page it cannot read, rather than hammering it", () => {
    expect(nextCheckDelay({ lastActivityAt: NOW, visible: true, busy: false, readable: false }, NOW)).toBe(SETTLED_MS);
  });

  it("does not check at all while the panel is hidden", () => {
    expect(nextCheckDelay({ lastActivityAt: NOW, visible: false, busy: false, readable: true }, NOW)).toBeUndefined();
  });

  it("comes back quickly after a read finishes rather than giving up", () => {
    expect(nextCheckDelay({ lastActivityAt: NOW - 60_000, visible: true, busy: true, readable: true }, NOW)).toBe(ATTENTIVE_MS);
  });
});

describe("whether the page has moved", () => {
  it("says no before anything has been read", () => {
    expect(hasMoved(undefined, print())).toBe(false);
  });

  it("notices a different advert at a new URL", () => {
    expect(hasMoved(print(), print({ url: "https://uk.indeed.com/jobs?q=x&vjs=2" }))).toBe(true);
  });

  it("notices a different advert behind the same URL", () => {
    expect(hasMoved(print(), print({ heading: "Business Applications Developer" }))).toBe(true);
  });

  it("ignores a page rewriting a couple of characters", () => {
    // "2 days ago" becoming "3 days ago", an applicant count ticking up.
    expect(hasMoved(print(), print({ length: 7482 }))).toBe(false);
  });

  it("notices a genuine change of content at the same URL and title", () => {
    expect(hasMoved(print(), print({ length: 12000 }))).toBe(true);
  });
});
