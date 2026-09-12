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

describe("a real LinkedIn job advert", () => {
  /*
   * The page that made someone call this pointless, and fairly. It said "Nothing
   * needs you here" on the single most obvious job-advert page on the internet.
   *
   * The cause was overfitting: the job signals had been written against a fixture
   * I wrote myself, using my own phrasing — "job description", "requirements",
   * "salary:". A real advert says "About the job", "What you'll be doing",
   * "You'll ideally have", and prints a bare "£45,000 – £60,000". Exactly one of
   * six signals fired, against a floor of four.
   */
  const page = captured("linkedin-job");
  const analysis = run(page);

  it("is recognised as a job advert", () => {
    expect(analysis.classification.surface).toBe("job");
    expect(analysis.classification.confidence).toBeGreaterThan(0.8);
  });

  it("reads the pay as a range, not as two loose numbers", () => {
    const amounts = analysis.entities.filter((e) => e.type === "amount").map((e) => e.value);
    expect(amounts).toContain("GBP 45000–60000");
    // The two ends of the range must not also appear on their own.
    expect(amounts).not.toContain("GBP 45000");
    expect(amounts).not.toContain("GBP 60000");
  });

  it("finds the employer from the byline, which carries no legal suffix", () => {
    expect(analysis.entities.some((e) => e.type === "organisation" && e.value === "Better Placed")).toBe(true);
  });

  it("does not let a company name run across a line break", () => {
    for (const e of analysis.entities.filter((x) => x.type === "organisation")) {
      expect(e.value, `"${e.value}" spans lines`).not.toMatch(/\n/);
    }
  });

  it("finds the role", () => {
    expect(analysis.entities.some((e) => e.type === "job_title" && /Javascript Developer/i.test(e.value))).toBe(true);
  });

  it("offers something useful even though the advert states no deadline", () => {
    expect(analysis.suggestions.length).toBeGreaterThan(0);
    expect(analysis.suggestions.map((s) => s.actionId)).toContain("save_to_memory");
  });

  it("offers to open the application, as a confirm-risk step", () => {
    const open = analysis.suggestions.find((s) => s.actionId === "open_application_link");
    expect(open, "the Apply link was captured but never offered").toBeDefined();
    expect(open!.risk).toBe("confirm");
  });

  it("does not promise dates on an advert that states none", () => {
    const save = analysis.suggestions.find((s) => s.actionId === "save_to_memory")!;
    expect(save.rationale).not.toMatch(/dates/i);
    expect(save.rationale).toMatch(/Better Placed/);
  });

  it("files it under the role on screen, not the stale tab title", async () => {
    /*
     * LinkedIn is a single-page app: document.title still read "Frontend
     * Developer | G.Digital | LinkedIn" — the job viewed BEFORE this one — while a
     * different advert was on screen. Saving that files it under the wrong name.
     */
    const { preferredTitle } = await import("@core/storage-hygiene");
    expect(preferredTitle(page)).toBe("Javascript Developer");
    expect(preferredTitle(page)).not.toMatch(/LinkedIn|G\.Digital/);
  });
});

describe("the real advert that was reported as capturing nothing", () => {
  const analysis = run(captured("linkedin-tech-lead"));

  it("reads the pay range from the labelled min and max fields", () => {
    expect(analysis.entities.some((e) => e.type === "amount" && e.value === "GBP 70000–85000")).toBe(true);
  });

  it("never truncates a figure", () => {
    // "£ 70000" was reading as GBP 700. Wrong by two orders of magnitude.
    for (const amount of analysis.entities.filter((e) => e.type === "amount")) {
      const digits = Number(amount.value.split(" ")[1]!.split("–")[0]);
      expect(digits, `${amount.value} looks truncated`).toBeGreaterThan(999);
    }
  });

  it("finds the role from the prose, not from the stale tab title", () => {
    expect(analysis.entities.some((e) => e.type === "job_title" && /Technical Lead/i.test(e.value))).toBe(true);
  });

  it("is recognised as a job advert", () => {
    expect(analysis.classification.surface).toBe("job");
  });
});

describe("a real LinkedIn page, furniture and all", () => {
  /*
   * This fixture is the full page as a user actually pasted it: the company link,
   * applicant counts, two Premium upsells, an interview-practice prompt, the
   * application status, the hiring team — and then, 800 characters in, the advert.
   *
   * Reading all of it produced a saved job titled "Determine your fit and how to
   * stand out" (a Premium heading), a skill of Python in an advert that never
   * mentions Python, and a salary of GBP 55 where the page says £45,000–£60,000.
   */
  const page = captured("linkedin-real-page");
  const analysis = run(page);

  it("titles the job from the advert, not from an upsell heading", async () => {
    const { preferredTitle } = await import("@core/storage-hygiene");
    const title = preferredTitle(page);
    expect(title).toBe("Javascript Developer");
    expect(title).not.toMatch(/determine your fit|next step|hiring team|results helpful/i);
  });

  it("reads the salary the advert states", () => {
    const amounts = analysis.entities.filter((e) => e.type === "amount").map((e) => e.value);
    expect(amounts).toContain("GBP 45000–60000");
    expect(amounts).not.toContain("GBP 55");
  });

  it("briefs the salary the advert states", () => {
    expect(analysis.brief?.salary?.value).toBe("GBP 45000–60000");
  });

  it("quotes every blocker it reports from the page itself", () => {
    for (const blocker of analysis.brief?.blockers ?? []) {
      expect(page.text, `${blocker.rule} was not quoted from the page`).toContain(blocker.evidence);
    }
  });

  it("invents no dates", () => {
    // "741 days ago" and "11 days ago" appeared from LinkedIn's own furniture.
    expect(analysis.entities.filter((e) => e.resolvedAt !== undefined)).toHaveLength(0);
  });

  it("does not mistake a word for a reference number", () => {
    // "booking platforms would be useful" produced a reference of PLATFORMS.
    const references = analysis.entities.filter((e) => e.type === "reference").map((e) => e.value);
    expect(references).not.toContain("PLATFORMS");
    for (const reference of references) expect(reference).toMatch(/\d/);
  });

  it("removes the furniture but keeps the header block", async () => {
    /*
     * Subtractive, not a slice. An earlier version cut everything above "About
     * the job", which removed the upsells and the title, company, location and
     * salary along with them — the header block is content, it just has adverts
     * sitting under it.
     */
    const { narrowToContent } = await import("@core/readability");
    const narrowed = narrowToContent(page.text);

    expect(narrowed).not.toMatch(/Reactivate Premium|Over 100 applicants|Meet the hiring team|Determine your fit/);
    expect(narrowed).toContain("Javascript Developer");
    expect(narrowed).toContain("Better Placed");
    expect(narrowed).toContain("About the job");
    expect(narrowed.length).toBeLessThan(page.text.length);
  });

  it("still keeps the whole advert", () => {
    expect(analysis.entities.length).toBeGreaterThanOrEqual(6);
  });
});

describe("a real Indeed page, sidebar and all", () => {
  /*
   * Indeed shows a list of other jobs beside the one being read, each with its own
   * company and its own salary. Reading the page produced five pay ranges — four
   * of them belonging to other adverts — and credited the job to a company from
   * the sidebar, under the title "Welcome, Sayam", which is the site's greeting.
   */
  const page = captured("indeed-job");
  const analysis = run(page);

  it("does not name the job after the site's greeting", async () => {
    const { preferredTitle } = await import("@core/storage-hygiene");
    const title = preferredTitle(page);
    expect(title).not.toMatch(/welcome|jobs for you|job details/i);
    expect(title).toMatch(/Graduate Associate Consultant/);
  });

  it("reads only this advert's salary, not the sidebar's", () => {
    const amounts = analysis.entities.filter((e) => e.type === "amount").map((e) => e.value);
    expect(amounts).toContain("GBP 35000–100000");
    // These belong to other jobs in the list beside it.
    expect(amounts).not.toContain("GBP 55000");
    expect(amounts).not.toContain("GBP 29680–32099");
    expect(amounts).not.toContain("GBP 22");
  });

  it("credits the job to the right employer", () => {
    const companies = analysis.entities.filter((e) => e.type === "organisation").map((e) => e.value);
    expect(companies).toContain("Lowen Talent");
    expect(companies).not.toContain("Activate Group Limited");
    expect(companies).not.toContain("IPSUM");
  });

  it("finds the right-to-work condition", () => {
    expect(analysis.brief?.blockers.some((b) => b.rule === "right_to_work")).toBe(true);
    expect(analysis.brief?.verdict).toBe("ruled_out");
  });

  it("is recognised as a job advert", () => {
    expect(analysis.classification.surface).toBe("job");
  });
});

describe("nothing a job page teaches breaks an invoice", () => {
  /*
   * The salary and company rules were added for job boards. An invoice is the
   * page most likely to be damaged by them: it legitimately carries several
   * amounts, and dropping its subtotal or VAT would be a regression introduced in
   * the name of fixing something else.
   */
  const analysis = run(captured("invoice"));

  it("keeps the subtotal, the VAT and the total", () => {
    const amounts = analysis.entities.filter((e) => e.type === "amount").map((e) => e.value);
    expect(amounts).toContain("EUR 2400.00");
    expect(amounts).toContain("EUR 480.00");
    expect(amounts).toContain("EUR 2880.00");
  });

  it("still names the supplier", () => {
    expect(analysis.entities.some((e) => e.type === "organisation" && /Brightfold/.test(e.value))).toBe(true);
  });

  it("still reads the due date, not the invoice date", () => {
    const problem = analysis.problems.find((p) => p.kind === "payment_due");
    expect(new Date(problem!.dueAt!).getDate()).toBe(20);
  });
});

/*
 * A real NHS Jobs advert, captured with tools/make-capture-snippet.mjs.
 *
 * Public-sector adverts state their conditions in wording no software advert uses
 * — "Disclosure and Barring Service", "Certificate of Sponsorship", a driving
 * licence written as "full UK Valid Driving Licence" — and the blocker rules had
 * been written against software adverts only. The named contact's email and phone
 * are redacted: they are published on the page, but no test needs them.
 */
describe("a real NHS Jobs advert", () => {
  const page = captured("nhs-job");
  const analysis = run(page);

  it("is recognised as a job advert", () => {
    expect(analysis.classification.surface).toBe("job");
  });

  it("reads the salary the advert states", () => {
    expect(analysis.brief?.salary?.value).toBe("GBP 28392–31157");
  });

  it("reads the closing date", () => {
    expect(analysis.brief?.closingDate?.value).toBe(new Date(2026, 8, 17, 9, 0, 0, 0).getTime());
  });

  it("flags the DBS check, however the advert words it", () => {
    expect(analysis.brief?.blockers.map((b) => b.rule)).toContain("dbs_check");
  });

  it("flags the driving licence, however the advert words it", () => {
    expect(analysis.brief?.blockers.map((b) => b.rule)).toContain("driving_licence");
  });

  it("quotes every blocker from the page itself", () => {
    for (const blocker of analysis.brief?.blockers ?? []) {
      expect(page.text, `${blocker.rule} was not quoted from the page`).toContain(blocker.evidence);
    }
  });

  it("does not claim the reader is ruled out by sponsorship this advert welcomes", () => {
    // "Applications from job seekers who require sponsorship are welcome" is the
    // opposite of a restriction, and reporting it as one would be a lie with a
    // quote behind it.
    const rightToWork = analysis.brief?.blockers.find((b) => b.rule === "right_to_work");
    expect(rightToWork, rightToWork?.evidence).toBeUndefined();
  });
});

/*
 * A real Ashby-hosted posting — the first captured page that actually publishes a
 * schema.org JobPosting, and therefore the only end-to-end evidence that the
 * structured path works on a real site rather than on a fixture we wrote.
 *
 * The JSON-LD's `description` is omitted from the fixture: it is 30KB of escaped
 * HTML duplicating the page text, and nothing reads it. The employer logo URL is
 * shortened. Everything else is exactly as captured.
 */
describe("a real Ashby posting, which publishes structured data", () => {
  const page = captured("ashby-job");
  const analysis = run(page);

  it("is recognised as a job advert from its structured data alone", () => {
    expect(analysis.classification.surface).toBe("job");
    expect(analysis.classification.confidence).toBeGreaterThan(0.9);
  });

  it("takes the title and employer the site published", () => {
    expect(analysis.brief?.title?.value).toBe("AI Systems Engineer, Codex Agents");
    expect(analysis.brief?.title?.source).toBe("structured");
    expect(analysis.brief?.organisation?.value).toBe("OpenAI");
  });

  it("takes the salary from the published range, not from the page's own '$230K – $385K'", () => {
    expect(analysis.brief?.salary?.value).toBe("USD 230000–385000");
    expect(analysis.brief?.salary?.source).toBe("structured");
  });

  it("reads the location out of the nested postal address", () => {
    expect(analysis.brief?.location?.value).toBe("San Francisco");
  });

  it("renders the employment type as a person would write it", () => {
    expect(analysis.brief?.employmentType?.value).toBe("Full time");
  });

  it("reports no closing date, because the posting states none", () => {
    expect(analysis.brief?.closingDate).toBeUndefined();
  });

  it("reports no blocker from the fair-chance and background-check wording", () => {
    // "arrest or conviction records", "criminal history" and "background checks"
    // are a statement of the employer's obligations, not a condition on the
    // reader. Reporting one as a blocker would rule someone out of a job nobody
    // ruled them out of.
    expect(analysis.brief?.blockers).toHaveLength(0);
    expect(analysis.brief?.verdict).toBeUndefined();
  });
});

/*
 * A logged-in LinkedIn job page, captured September 2026 — the state of the site
 * as it actually is, not as it was when the earlier LinkedIn fixtures were taken.
 *
 * It found a regression the moment it landed: LinkedIn's first heading is now an
 * AI upsell, "Use AI to assess how you fit", and the brief was titled with it.
 */
describe("a logged-in LinkedIn job page, 2026", () => {
  const page = captured("linkedin-prompt-engineer");
  const analysis = run(page);

  it("is recognised as a job advert", () => {
    expect(analysis.classification.surface).toBe("job");
  });

  it("publishes no structured data, so the brief is built from prose", () => {
    expect(page.structuredData).toHaveLength(0);
    expect(analysis.brief?.salary?.source).toBe("prose");
  });

  it("names the job rather than LinkedIn's upsell", () => {
    // Falls back to the document title once every heading is furniture. The
    // employer rides along after the pipe, which beats "Use AI to assess how you
    // fit" by a distance.
    expect(analysis.brief?.title?.value).toContain("Senior Prompt Engineer");
    expect(analysis.brief?.title?.value).not.toMatch(/use ai|assess how you fit/i);
  });

  it("reads the salary out of the advert's own bullet", () => {
    expect(analysis.brief?.salary?.value).toBe("GBP 55000–60000");
  });

  it("reads the working pattern", () => {
    expect(analysis.brief?.workingPattern?.value).toBe("Hybrid");
  });

  it("reports no blocker, because this advert states none", () => {
    expect(analysis.brief?.blockers).toHaveLength(0);
    expect(analysis.brief?.verdict).toBeUndefined();
  });
});

/*
 * A real Indeed job page, captured September 2026 from a logged-in session.
 *
 * This one corrects a conclusion drawn earlier from `indeed-job.json`, which has
 * no structured data: Indeed's /viewjob page publishes a complete JobPosting —
 * title, employer, a GBP salary range, a nested postal address, an employment
 * type given as an array, and a validThrough date. So the structured path fires
 * on an aggregator after all, and every field in this brief comes from it.
 */
describe("a real Indeed viewjob page, 2026", () => {
  const page = captured("indeed-viewjob");
  const analysis = run(page);

  it("publishes a JobPosting", () => {
    expect(page.structuredData.map((b) => b["@type"])).toContain("JobPosting");
  });

  it("takes every headline fact from what the site published", () => {
    expect(analysis.brief?.title?.value).toBe("Business Applications Developer");
    expect(analysis.brief?.organisation?.value).toBe("Data8 Ltd");
    expect(analysis.brief?.location?.value).toBe("Chester");
    expect(analysis.brief?.salary?.value).toBe("GBP 35000–40000");
    for (const field of [analysis.brief?.title, analysis.brief?.organisation, analysis.brief?.salary]) {
      expect(field?.source).toBe("structured");
    }
  });

  it("reads an employmentType given as an array", () => {
    // Indeed sends ["FULL_TIME"], where the schema documents a bare string.
    expect(analysis.brief?.employmentType?.value).toBe("Full time");
  });

  it("reads the closing date the site published", () => {
    expect(analysis.brief?.closingDate?.value).toBe(Date.parse("2027-01-10T22:49:19.595Z"));
    expect(analysis.brief?.closingDate?.source).toBe("structured");
  });

  it("still reads the working pattern out of prose, which the posting does not state", () => {
    expect(analysis.brief?.workingPattern?.value).toBe("Hybrid");
    expect(analysis.brief?.workingPattern?.source).toBe("prose");
  });
});
