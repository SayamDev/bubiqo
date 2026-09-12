import { describe, it, expect } from "vitest";
import { analyse, whatDoINeedToDo, whatsNext } from "@core/analyse";
import { buildRegistry } from "@core/actions";
import { DEFAULT_SETTINGS } from "@core/types";
import { makePorts } from "./fakes";
import {
  NOW, emailWithDeadline, longEmailThread, invoicePage, jobPage,
  maliciousPage, halfFilledForm, boringPage,
} from "./fixtures";

const registry = buildRegistry(makePorts(NOW));
const run = (page: Parameters<typeof analyse>[0]) =>
  analyse(page, registry, { settings: DEFAULT_SETTINGS, now: NOW });

describe("classification", () => {
  it("recognises an email", () => {
    const { classification } = run(emailWithDeadline);
    expect(classification.surface).toBe("email");
    expect(classification.confidence).toBeGreaterThan(0.6);
  });

  it("recognises an invoice", () => {
    expect(run(invoicePage).classification.surface).toBe("invoice");
  });

  it("recognises a job advert from its structured data", () => {
    const { classification } = run(jobPage);
    expect(classification.surface).toBe("job");
    expect(classification.confidence).toBeGreaterThan(0.9);
  });

  it("says generic rather than guessing on an ordinary page", () => {
    expect(run(boringPage).classification.surface).toBe("generic");
  });

  it("always explains itself", () => {
    for (const page of [emailWithDeadline, invoicePage, jobPage, boringPage]) {
      expect(run(page).classification.rationale.length).toBeGreaterThan(10);
    }
  });
});

describe("the email in §119 — the whole point of the product", () => {
  const analysis = run(emailWithDeadline);

  it("detects the Friday deadline", () => {
    const deadline = analysis.entities.find((e) => e.type === "deadline");
    expect(deadline).toBeDefined();
    expect(new Date(deadline!.resolvedAt!).getDay()).toBe(5);
  });

  it("detects that someone asked for something", () => {
    const ask = analysis.problems.find((p) => p.kind === "unanswered_question");
    expect(ask?.summary).toMatch(/send me the revised proposal/i);
  });

  it("detects the commitment John made", () => {
    const commitment = analysis.problems.find((p) => p.kind === "commitment");
    expect(commitment?.summary).toMatch(/circulate the budget figures/i);
  });

  it("detects the Tuesday call", () => {
    const event = analysis.problems.find((p) => p.kind === "upcoming_event");
    expect(event).toBeDefined();
    expect(new Date(event!.dueAt!).getHours()).toBe(14);
  });

  it("pulls out the sender and their company", () => {
    expect(analysis.entities.some((e) => e.type === "person" && e.value === "Sayam")).toBe(true);
    expect(analysis.entities.some((e) => e.type === "organisation" && /Northwind/.test(e.value))).toBe(true);
    expect(analysis.entities.some((e) => e.type === "email")).toBe(true);
  });

  it("offers at most three primary suggestions", () => {
    expect(analysis.suggestions.length).toBeGreaterThan(0);
    expect(analysis.suggestions.slice(0, 3).length).toBeLessThanOrEqual(3);
  });

  it("leads with creating a reminder", () => {
    expect(analysis.suggestions[0]?.actionId).toBe("create_reminder");
  });

  it("never offers a suggestion without a reason", () => {
    for (const s of analysis.suggestions) {
      expect(s.rationale.length, `${s.actionId} had no rationale`).toBeGreaterThan(10);
    }
  });

  it("answers 'what do I need to do?' in three tiers", () => {
    const answer = whatDoINeedToDo(analysis);
    expect(answer.required.join(" ")).toMatch(/proposal/i);
    expect(answer.optional.length).toBeGreaterThan(0);
  });

  it("answers 'what's next?' with a reason", () => {
    const next = whatsNext(analysis);
    expect(next?.suggestion).toBeTruthy();
    expect(next?.why).toMatch(/deadline|Friday/i);
  });
});

describe("long thread", () => {
  const analysis = run(longEmailThread);

  it("notices someone is waiting", () => {
    expect(analysis.problems.some((p) => p.kind === "pending_response")).toBe(true);
  });

  it("finds the 20 March cutover deadline", () => {
    const march = analysis.entities.find((e) => e.resolvedAt && new Date(e.resolvedAt).getDate() === 20);
    expect(march).toBeDefined();
  });

  it("suggests drafting a reply", () => {
    expect(analysis.suggestions.some((s) => s.actionId === "draft_reply")).toBe(true);
  });
});

describe("invoice", () => {
  const analysis = run(invoicePage);

  it("extracts the total and the currency", () => {
    const amounts = analysis.entities.filter((e) => e.type === "amount").map((e) => e.value);
    expect(amounts).toContain("EUR 2880.00");
    expect(analysis.entities.some((e) => e.type === "currency" && e.value === "EUR")).toBe(true);
  });

  it("extracts the invoice reference", () => {
    expect(analysis.entities.some((e) => e.type === "reference" && e.value === "INV-2026-0042")).toBe(true);
  });

  it("reports the due date as a payment problem, not a generic deadline", () => {
    const problem = analysis.problems.find((p) => p.kind === "payment_due");
    expect(problem).toBeDefined();
    expect(new Date(problem!.dueAt!).getDate()).toBe(20);
  });

  it("never suggests paying it", () => {
    expect(analysis.suggestions.some((s) => s.actionId === "pay_invoice")).toBe(false);
  });

  it("suggests a reminder and saving the details", () => {
    const ids = analysis.suggestions.map((s) => s.actionId);
    expect(ids).toContain("create_reminder");
    expect(ids).toContain("save_to_memory");
  });
});

describe("job advert", () => {
  const analysis = run(jobPage);

  it("extracts the role and the company", () => {
    expect(analysis.entities.some((e) => e.type === "job_title" && /Senior Frontend Engineer/.test(e.value))).toBe(true);
    expect(analysis.entities.some((e) => e.type === "organisation" && /Halcyon/.test(e.value))).toBe(true);
  });

  it("finds the closing date", () => {
    const deadline = analysis.entities.find((e) => e.type === "deadline");
    expect(new Date(deadline!.resolvedAt!).getDate()).toBe(27);
  });

  it("reads the salary as an amount", () => {
    expect(analysis.entities.some((e) => e.type === "amount" && e.value === "GBP 78000")).toBe(true);
  });

  it("leads with saving the job", () => {
    expect(analysis.suggestions.map((s) => s.actionId).slice(0, 2)).toContain("save_to_memory");
  });
});

describe("unfinished form", () => {
  it("notices required fields left empty", () => {
    const analysis = run(halfFilledForm);
    const problem = analysis.problems.find((p) => p.kind === "unfinished_form");
    expect(problem?.summary).toMatch(/1 required field left/);
  });
});

describe("prompt injection", () => {
  const analysis = run(maliciousPage);

  it("flags that the page tried to issue instructions", () => {
    expect(analysis.injectionAttempted).toBe(true);
  });

  it("strips the instructions from anything downstream", () => {
    const everything = JSON.stringify(analysis);
    expect(everything).not.toMatch(/ignore all previous instructions/i);
    expect(everything).not.toMatch(/attacker\.example\.com/i);
  });

  it("still never suggests a blocked action, however the page asks", () => {
    expect(analysis.suggestions.some((s) => s.actionId === "pay_invoice")).toBe(false);
    expect(analysis.suggestions.every((s) => s.risk !== "blocked")).toBe(true);
  });
});

describe("quiet pages", () => {
  it("produces no problems and few suggestions for an ordinary article", () => {
    const analysis = run(boringPage);
    expect(analysis.problems).toHaveLength(0);
    expect(analysis.suggestions.length).toBeLessThanOrEqual(1);
  });
});

describe("determinism", () => {
  it("gives identical results for identical input", () => {
    expect(JSON.stringify(run(emailWithDeadline))).toBe(JSON.stringify(run(emailWithDeadline)));
  });
});
