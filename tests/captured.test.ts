/**
 * End-to-end tests against text captured from a real browser.
 *
 * The JSON in tests/captured/ is not hand-written. It is the exact output of the
 * page extractor running in Chrome against the demo pages in /fixtures, saved so
 * the whole pipeline can be exercised in CI without a browser.
 *
 * This is what caught the extractor's worst bug: cloneNode() detaches a node, a
 * detached node has no layout, and innerText on a node with no layout silently
 * degrades to textContent — collapsing "Total amount due | EUR 2,880.00" into
 * "Total amount dueEUR 2,880.00" and losing the invoice total. The hand-written
 * fixtures could never have shown that, because a human writing them puts the
 * newlines in by hand.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyse } from "@core/analyse";
import { buildRegistry } from "@core/actions";
import { Executor } from "@core/executor";
import { toActionInput } from "@core/analyse";
import { DEFAULT_SETTINGS, type PageContext } from "@core/types";
import { makePorts } from "./fakes";

const here = dirname(fileURLToPath(import.meta.url));

/** Friday 2026-03-06, 10:00 local — the same instant the other suites use. */
const NOW = new Date(2026, 2, 6, 10, 0, 0).getTime();

function captured(name: string): PageContext {
  return JSON.parse(readFileSync(resolve(here, "captured", `${name}.json`), "utf8")) as PageContext;
}

const ports = makePorts(NOW);
const registry = buildRegistry(ports);
const run = (page: PageContext) => analyse(page, registry, { settings: DEFAULT_SETTINGS, now: NOW });

describe("a real email page", () => {
  const page = captured("email");
  const analysis = run(page);

  it("is recognised as an email", () => {
    expect(analysis.classification.surface).toBe("email");
  });

  it("finds the Friday deadline even though the text wraps mid-phrase", () => {
    // The real page breaks "by\nFriday" across a line. The cue still precedes it.
    const deadline = analysis.entities.find((e) => e.type === "deadline");
    expect(deadline).toBeDefined();
    expect(new Date(deadline!.resolvedAt!).getDay()).toBe(5);
    expect(new Date(deadline!.resolvedAt!).getDate()).toBe(13);
  });

  it("does not mistake Monday for the deadline", () => {
    const deadlines = analysis.entities.filter((e) => e.type === "deadline");
    expect(deadlines.every((d) => new Date(d.resolvedAt!).getDay() !== 1)).toBe(true);
  });

  it("leads with a reminder and explains why", () => {
    expect(analysis.suggestions[0]?.actionId).toBe("create_reminder");
    expect(analysis.suggestions[0]?.rationale).toMatch(/deadline/i);
  });

  it("Complete It runs the safe steps and verifies every one", async () => {
    const executor = new Executor(registry, makePorts(NOW), DEFAULT_SETTINGS);
    const report = await executor.completeIt(
      analysis.suggestions.filter((s) => s.risk === "safe").slice(0, 3),
      toActionInput(page, analysis),
    );
    expect(report.steps.length).toBeGreaterThanOrEqual(2);
    expect(report.done).toBe(report.steps.length);
    expect(report.failed).toBe(0);
  });
});

describe("a real invoice page", () => {
  const analysis = run(captured("invoice"));

  it("reads the total out of the table", () => {
    // The regression this file exists for.
    const amounts = analysis.entities.filter((e) => e.type === "amount").map((e) => e.value);
    expect(amounts).toContain("EUR 2880.00");
  });

  it("reads the invoice reference", () => {
    expect(analysis.entities.some((e) => e.type === "reference" && e.value === "INV-2026-0042")).toBe(true);
  });

  it("takes the due date, not the invoice date", () => {
    const problem = analysis.problems.find((p) => p.kind === "payment_due");
    expect(new Date(problem!.dueAt!).getDate()).toBe(20);
    expect(new Date(problem!.dueAt!).getMonth()).toBe(2);
  });

  it("never offers to pay", () => {
    expect(analysis.suggestions.some((s) => s.actionId === "pay_invoice")).toBe(false);
  });
});

describe("a real job advert", () => {
  const analysis = run(captured("job"));

  it("uses the page's own structured data", () => {
    expect(analysis.classification.surface).toBe("job");
    expect(analysis.classification.confidence).toBeGreaterThan(0.9);
    expect(analysis.entities.some((e) => e.type === "organisation" && e.value === "Halcyon Labs Ltd")).toBe(true);
  });

  it("finds the closing date and the salary", () => {
    expect(analysis.entities.some((e) => e.type === "deadline" && new Date(e.resolvedAt!).getDate() === 27)).toBe(true);
    expect(analysis.entities.some((e) => e.type === "amount" && e.value === "GBP 78000")).toBe(true);
  });
});

describe("a real hostile page", () => {
  const analysis = run(captured("hostile"));

  it("notices the attempt", () => {
    expect(analysis.injectionAttempted).toBe(true);
  });

  it("keeps the instructions out of everything downstream", () => {
    const serialised = JSON.stringify(analysis);
    expect(serialised).not.toMatch(/ignore all previous instructions/i);
    expect(serialised).not.toMatch(/attacker\.example\.com/i);
    expect(serialised).not.toMatch(/transfer the balance/i);
  });

  it("still reads the amount and the date, because that is all they ever were", () => {
    expect(analysis.entities.some((e) => e.type === "amount" && e.value === "GBP 499.00")).toBe(true);
    expect(analysis.entities.some((e) => e.resolvedAt !== undefined)).toBe(true);
  });

  it("suggests nothing that could act on the page's behalf", () => {
    for (const suggestion of analysis.suggestions) {
      expect(suggestion.risk).toBe("safe");
    }
  });
});

describe("a real recruiter email from a live inbox", () => {
  /*
   * The email that exposed how thin the extraction was. On first run the panel
   * found exactly one thing, and it was wrong: it reported "You said you would get
   * sharper with the matches" — marketing copy from the SENDER, attributed to the
   * user as a promise they had made. Meanwhile it missed the company, the role, the
   * June 2027 requirement and the £500.
   */
  const analysis = run(captured("hackajob-email"));

  it("does not invent a commitment out of the sender's marketing copy", () => {
    const summaries = analysis.problems.map((p) => p.summary).join(" | ");
    expect(summaries).not.toMatch(/you said you would get sharper/i);
    expect(summaries).not.toMatch(/you said you would fine.?tune/i);
  });

  it("never attributes the sender's first person to the user", () => {
    for (const problem of analysis.problems) {
      expect(problem.summary, `misattributed: ${problem.summary}`).not.toMatch(/^You said you would/i);
    }
  });

  it("finds the company, which carries no Ltd or PLC", () => {
    expect(analysis.entities.some((e) => e.type === "organisation" && e.value === "Barclays")).toBe(true);
  });

  it("finds the role, even though it is inside an email rather than on a careers page", () => {
    const role = analysis.entities.find((e) => e.type === "job_title");
    expect(role?.value).toMatch(/Technology Developer Graduate Programme/i);
  });

  it("reads 'before June 2027' as a date", () => {
    const june = analysis.entities.find(
      (e) => e.resolvedAt !== undefined && new Date(e.resolvedAt).getFullYear() === 2027 && new Date(e.resolvedAt).getMonth() === 5,
    );
    expect(june, "June 2027 was not parsed").toBeDefined();
  });

  it("reads the £500 referral amount", () => {
    expect(analysis.entities.some((e) => e.type === "amount" && e.value === "GBP 500")).toBe(true);
  });

  it("gets meaningfully more out of the email than it used to", () => {
    // It previously produced one entity of substance. Six is not a lot, but it is
    // the difference between useful and embarrassing.
    expect(analysis.entities.length).toBeGreaterThanOrEqual(6);
  });
});
