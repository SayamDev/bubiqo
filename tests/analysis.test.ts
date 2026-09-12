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

  it("attributes the sender's promise to the sender, not to you", () => {
    /*
     * John wrote "I'll circulate the budget figures". On an email you are READING,
     * the first person is the sender. Reporting that as "You said you would
     * circulate the budget figures" invents an obligation the user never took on.
     */
    const promise = analysis.problems.find((p) => /circulate the budget figures/i.test(p.summary));
    expect(promise).toBeDefined();
    expect(promise!.summary).toMatch(/^John.* said they would/i);
    expect(promise!.summary).not.toMatch(/^You said/i);
    expect(promise!.kind).toBe("pending_response");
  });

  it("still reports a first-person promise as yours when there is no sender", () => {
    const notes = { ...emailWithDeadline, text: "I'll send the deck to the team tomorrow." };
    const own = run(notes).problems.find((p) => p.kind === "commitment");
    expect(own?.summary).toMatch(/^You said you would send the deck/i);
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

describe("the proactivity setting actually changes what is shown", () => {
  /*
   * It was stored and never read — a control that lies. The user changes it, sees
   * no difference, and reasonably concludes the whole panel is decorative.
   */
  const withMode = (mode: "quiet" | "helpful" | "proactive") =>
    analyse(emailWithDeadline, registry, { settings: { ...DEFAULT_SETTINGS, mode }, now: NOW });

  it("offers less on Quiet than on Helpful", () => {
    expect(withMode("quiet").suggestions.length).toBeLessThan(withMode("helpful").suggestions.length);
  });

  it("offers at least as much on Proactive as on Helpful", () => {
    expect(withMode("proactive").suggestions.length).toBeGreaterThanOrEqual(withMode("helpful").suggestions.length);
  });

  it("keeps only pressing problems on Quiet", () => {
    const quiet = withMode("quiet").problems;
    expect(quiet.every((p) => p.urgency === "overdue" || p.urgency === "today")).toBe(true);
    expect(withMode("helpful").problems.length).toBeGreaterThan(quiet.length);
  });

  it("still leads with the most useful thing on Quiet, not a random survivor", () => {
    const quiet = withMode("quiet").suggestions;
    if (quiet.length > 0) expect(quiet[0]!.actionId).toBe(withMode("helpful").suggestions[0]!.actionId);
  });
});

describe("actionable links", () => {
  const withLinks = {
    ...jobPage,
    links: [
      { text: "Apply for this role", href: "https://careers.example.com/apply/123" },
      { text: "Unsubscribe", href: "https://careers.example.com/unsubscribe" },
      { text: "Privacy policy", href: "https://careers.example.com/privacy" },
    ],
  };

  it("recognises an application link", () => {
    const analysis = analyse(withLinks, registry, { settings: DEFAULT_SETTINGS, now: NOW });
    expect(analysis.entities.some((e) => e.type === "url" && e.value.includes("/apply/"))).toBe(true);
  });

  it("ignores unsubscribe and policy links, which every email is full of", () => {
    const analysis = analyse(withLinks, registry, { settings: DEFAULT_SETTINGS, now: NOW });
    const urls = analysis.entities.filter((e) => e.type === "url").map((e) => e.value);
    expect(urls.some((u) => u.includes("unsubscribe"))).toBe(false);
    expect(urls.some((u) => u.includes("privacy"))).toBe(false);
  });

  it("offers opening it only as a confirm-risk action", () => {
    const analysis = analyse(withLinks, registry, { settings: { ...DEFAULT_SETTINGS, mode: "proactive" }, now: NOW });
    const open = analysis.suggestions.find((s) => s.actionId === "open_application_link");
    if (open) expect(open.risk).toBe("confirm");
  });
});

describe("splitting suggestions for display", () => {
  /*
   * The panel used to re-derive this: it listed the first three of any risk as
   * cards, but computed "More actions" against the SAFE ones — so a confirm-risk
   * card in the top three was rendered twice, once as a card and once inside the
   * disclosure. Two places deciding the same thing is how they drift.
   */
  it("never lists the same suggestion twice", async () => {
    const { splitSuggestions } = await import("@core/ranker");
    const analysis = analyse(jobPage, registry, { settings: { ...DEFAULT_SETTINGS, mode: "proactive" }, now: NOW });

    const { primary, more } = splitSuggestions(analysis.suggestions);
    const ids = [...primary, ...more].map((s) => s.actionId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("accounts for every suggestion exactly once", async () => {
    const { splitSuggestions } = await import("@core/ranker");
    const analysis = analyse(emailWithDeadline, registry, { settings: DEFAULT_SETTINGS, now: NOW });

    const { primary, more } = splitSuggestions(analysis.suggestions);
    expect(primary.length + more.length).toBe(analysis.suggestions.length);
  });

  it("keeps a confirm-risk suggestion out of More actions when it is already a card", async () => {
    const { splitSuggestions } = await import("@core/ranker");
    const withConfirm = [
      { actionId: "a", name: "A", risk: "safe" as const, rationale: "x", score: 0.9, params: {} },
      { actionId: "b", name: "B", risk: "confirm" as const, rationale: "x", score: 0.8, params: {} },
      { actionId: "c", name: "C", risk: "safe" as const, rationale: "x", score: 0.7, params: {} },
      { actionId: "d", name: "D", risk: "safe" as const, rationale: "x", score: 0.6, params: {} },
    ];
    const { primary, more } = splitSuggestions(withConfirm);
    expect(primary.map((s) => s.actionId)).toEqual(["a", "b", "c"]);
    expect(more.map((s) => s.actionId)).toEqual(["d"]);
  });
});

describe("the headline", () => {
  it("does not say eligibility conditions 'need you'", async () => {
    /*
     * You cannot act on being asked for security clearance. It needs checking
     * before an hour goes into an application you were never eligible for, which
     * is a different sentence.
     */
    const { attentionHeadline } = await import("../extension/src/sidepanel/format");
    expect(attentionHeadline(3, 2, true)).toBe("3 things to check first");
    expect(attentionHeadline(1, 2, true)).toBe("One thing to check first");
  });

  it("still says 'need you' for things you can act on", async () => {
    const { attentionHeadline } = await import("../extension/src/sidepanel/format");
    expect(attentionHeadline(3, 2, false)).toBe("3 things need you");
    expect(attentionHeadline(1, 0, false)).toBe("One thing needs you");
  });

  it("stays quiet when there is nothing", async () => {
    const { attentionHeadline } = await import("../extension/src/sidepanel/format");
    expect(attentionHeadline(0, 0)).toBe("Nothing needs you here");
    expect(attentionHeadline(0, 2)).toBe("Nothing urgent — but I can help");
  });
});

describe("saying what was found, not that something was", () => {
  it("names the kind of event rather than 'something is scheduled'", () => {
    const page = { ...emailWithDeadline, text: "Are you free for a call on Tuesday at 14:30?" };
    const event = run(page).problems.find((p) => p.kind === "upcoming_event");
    expect(event?.summary).toMatch(/there is a call/i);
    expect(event?.summary).not.toMatch(/something is scheduled/i);
  });

  it("quotes the clause in a reminder's reason, not the window around it", () => {
    /*
     * The evidence field holds a wide slice of surrounding text for the "why?"
     * disclosure. Using it as the reason produced "Northwind account Hi Sayam,
     * Can you send me the revised proposal by" as the justification for offering
     * a reminder.
     */
    const reminder = run(emailWithDeadline).suggestions.find((s) => s.actionId === "create_reminder");
    expect(reminder?.rationale).toMatch(/“by Friday”/);
    expect(reminder?.rationale).not.toMatch(/Hi Sayam|Subject:/);
  });

  it("takes the title and the employer from the top of a selection", () => {
    // A selection carries no headings, so an Indeed advert lost both.
    const selection = `Graduate Associate Consultant - Executive Search
Lowen Talent
Leeds
Lowen Talent is seeking a Graduate Associate Consultant to join our Executive Search team in Leeds.
You will work alongside experienced consultants across the full search lifecycle.`;
    const analysis = run({ ...emailWithDeadline, text: selection, selection, headings: [] });

    expect(analysis.entities.some((e) => e.type === "job_title" && /Graduate Associate Consultant/.test(e.value))).toBe(true);
    expect(analysis.entities.some((e) => e.type === "organisation" && e.value === "Lowen Talent")).toBe(true);
  });
});
