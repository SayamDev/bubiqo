import { describe, it, expect } from "vitest";
import { resolveDates, describeUrgency, formatDue } from "@core/dates";

/** Friday 2026-03-06, 10:00 local. Every test is relative to this instant. */
const NOW = new Date(2026, 2, 6, 10, 0, 0).getTime();

function only(text: string) {
  const found = resolveDates(text, NOW);
  expect(found.length, `expected exactly one date in ${JSON.stringify(text)}`).toBe(1);
  return new Date(found[0]!.at);
}

describe("resolveDates", () => {
  it("resolves a bare weekday forward to next week when it is today", () => {
    // Today IS Friday, but no time was given, so "Friday" means the next one.
    const d = only("Can you send me the revised proposal by Friday?");
    expect(d.getDate()).toBe(13);
    expect(d.getMonth()).toBe(2);
    expect(d.getHours()).toBe(9);
  });

  it("resolves a bare weekday to the next occurrence", () => {
    const d = only("Let's meet Monday");
    expect(d.getDay()).toBe(1);
    expect(d.getDate()).toBe(9);
  });

  it("honours a time given alongside a weekday", () => {
    const d = only("Interview on Tuesday at 14:30");
    expect(d.getDay()).toBe(2);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
  });

  it("pushes 'next' a further week out", () => {
    const d = only("next Monday");
    expect(d.getDate()).toBe(16);
  });

  it("resolves today and tomorrow", () => {
    expect(only("due today").getDate()).toBe(6);
    expect(only("due tomorrow").getDate()).toBe(7);
  });

  it("reads a pm time correctly", () => {
    const d = only("send it by 5pm tomorrow");
    expect(d.getHours()).toBe(17);
    expect(d.getDate()).toBe(7);
  });

  it("treats 12am as midnight and 12pm as noon", () => {
    expect(only("tomorrow 12am").getHours()).toBe(0);
    expect(only("tomorrow 12pm").getHours()).toBe(12);
  });

  it("parses day-month-year", () => {
    const d = only("The deadline is 12 March 2026.");
    expect(d.getDate()).toBe(12);
    expect(d.getMonth()).toBe(2);
    expect(d.getFullYear()).toBe(2026);
  });

  it("parses month-day-year", () => {
    const d = only("Closes April 3, 2026");
    expect(d.getMonth()).toBe(3);
    expect(d.getDate()).toBe(3);
  });

  it("infers next year for a date already well past", () => {
    const d = only("applications close 4 January");
    expect(d.getFullYear()).toBe(2027);
  });

  it("keeps this year for a date still ahead", () => {
    const d = only("applications close 4 December");
    expect(d.getFullYear()).toBe(2026);
  });

  it("parses ISO dates", () => {
    const d = only("Due 2026-06-01 for review");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5);
    expect(d.getDate()).toBe(1);
  });

  it("parses relative offsets", () => {
    expect(only("in 3 days").getDate()).toBe(9);
    expect(only("in two weeks").getDate()).toBe(20);
  });

  it("refuses ambiguous numeric dates rather than guessing", () => {
    // 12/03/2026 is 12 March in the UK and 3 December in the US. Guessing wrong
    // puts a deadline nine months off, so we decline to parse it at all.
    expect(resolveDates("invoice dated 12/03/2026", NOW)).toHaveLength(0);
  });

  it("rejects impossible clock times instead of wrapping them", () => {
    const d = only("meet at 25:00 tomorrow");
    expect(d.getHours()).toBe(9); // falls back to the default, does not become 01:00
  });

  it("returns dates in chronological order", () => {
    const found = resolveDates("Draft by Monday, final by 20 March 2026, kickoff tomorrow", NOW);
    const times = found.map((f) => f.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("finds nothing in text with no dates", () => {
    expect(resolveDates("Thanks for your help with the report.", NOW)).toHaveLength(0);
  });
});

describe("describeUrgency", () => {
  it("classifies relative to now", () => {
    expect(describeUrgency(NOW - 1000, NOW)).toBe("overdue");
    expect(describeUrgency(NOW + 3600_000, NOW)).toBe("today");
    expect(describeUrgency(NOW + 2 * 86_400_000, NOW)).toBe("soon");
    expect(describeUrgency(NOW + 30 * 86_400_000, NOW)).toBe("later");
  });
});

describe("formatDue", () => {
  it("uses human labels near today", () => {
    expect(formatDue(new Date(2026, 2, 6, 17, 0).getTime(), NOW)).toMatch(/^Today, 17:00$/);
    expect(formatDue(new Date(2026, 2, 7, 9, 0).getTime(), NOW)).toMatch(/^Tomorrow, 09:00$/);
    expect(formatDue(new Date(2026, 2, 10, 9, 0).getTime(), NOW)).toMatch(/^Tuesday, 09:00$/);
  });
});
