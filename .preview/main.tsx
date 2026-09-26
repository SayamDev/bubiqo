/**
 * The whole side panel, rendered outside Chrome.
 *
 * The panel talks to the service worker through chrome.runtime.sendMessage, so a
 * small fake of that surface is enough to render every screen — Now, Memory,
 * Activity, Settings — against real captured pages. Without this, the only way to
 * look at Activity or Settings was to load the extension in a browser, which is
 * how they ended up unreviewed.
 */
import { createRoot } from "react-dom/client";
import "../extension/src/sidepanel/styles.css";
import { analyse, toActionInput } from "@core/analyse";
import { buildRegistry } from "@core/actions";
import { briefToEntities } from "@core/job-brief";
import { DEFAULT_SETTINGS, type PageContext } from "@core/types";
import indeedViewjob from "../tests/captured/indeed-viewjob.json";
import nhs from "../tests/captured/nhs-job.json";

const NOW = Date.now();

const noPorts = {
  storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, keys: async () => [] },
  clock: { now: () => NOW },
  alarms: { schedule: async () => {}, cancel: async () => {} },
  downloads: { save: async () => "ok" },
  clipboard: { write: async () => {} },
  rates: { convert: async () => undefined },
} as never;

const registry = buildRegistry(noPorts);
// ?bill shows a Direct Debit reminder, the shape of the E.ON email.
const billPage = {
  url: "https://mail.google.com/mail/u/0/#inbox/demo",
  domain: "mail.google.com",
  title: "A reminder about your Direct Debit payment.",
  text: "Bill scheduled for payment. E.ON Next bill £48.56. Account number: A-48F4A034. Your Direct Debit payment is due soon. We'll take your payment of £48.56 on 1 October. Your current balance is -£194.27 DR. Send us a message on WhatsApp (0808 501 5200). E.ON Next Energy Limited",
  headings: ["Your Direct Debit payment is due soon."],
  fields: [],
  structuredData: [],
  links: [],
} as unknown as PageContext;
const payoutPage = {
  ...billPage,
  title: "Daily Payout Report",
  text: "Your daily payouts report\nDear ajmal butt,\nThis is an overview of your processed card payments as of 24/09/2026.\nSumUp processed card payments\nTotal of all gross card payments before fees and deductions are applied\n£214.85\nSumUp processing fees\nTotal of all processing fees for card payments\n-£2.24\nDeductions\nTotal of refunds, chargebacks, loan repayments and subscriptions\n£0.00\nPaid out amount\nThe amount deposited in your payout account\n£130.63\nTo be paid out\nPayments still to be paid out. Fees and deductions will be applied before payout\n£81.98\nSumUp Payments Limited",
} as unknown as PageContext;
const digestPage = {
  ...billPage,
  title: "Your job matches for Software Engineer (Applied AI)",
  text: "Jobright\nExplore this today's top matches, curated to align with your preferences.\nEuphoric\nComputer Software · Early Stage\n98%\nSoftware Engineer (Applied AI)\n£100K/yr - £130K/yr\nRemote\n9 hours ago · Be an early applicant\nAPPLY NOW\nLSA : London Success Academy\nProfessional Training & Coaching · Early Stage\n97%\nDeveloper Work Placement (Software & Web Development) (Remote)\nRemote\n10 hours ago · Be an early applicant\nAPPLY NOW\nBromcom\nInformation Technology · Growth Stage\n95%\n.NET Full-Stack Developer\nRemote\n15 hours ago · Be an early applicant\nAPPLY NOW",
} as unknown as PageContext;
const page = location.search.includes("digest") ? digestPage : location.search.includes("payout") ? payoutPage : location.search.includes("bill") ? billPage : (indeedViewjob as unknown as PageContext);
const analysis = analyse(page, registry, { settings: DEFAULT_SETTINGS, now: NOW });

const savedFrom = (raw: unknown, id: string, minutesAgo: number) => {
  const p = raw as PageContext;
  const a = analyse(p, registry, { settings: DEFAULT_SETTINGS, now: NOW });
  return {
    id,
    kind: "job" as const,
    title: a.brief?.title?.value ?? p.title,
    entities: briefToEntities(a.brief!, a.entities, p.url),
    url: p.url,
    savedAt: NOW - minutesAgo * 60_000,
  };
};

const state = {
  page,
  analysis,
  settings: DEFAULT_SETTINGS,
  reminders: [
    { id: "r1", title: "Apply: Business Applications Developer", dueAt: NOW + 36 * 3600_000, createdAt: NOW, source: "job" },
  ],
  memory: [savedFrom(indeedViewjob, "m1", 3), savedFrom(nhs, "m2", 140)],
  drafts: [],
  activity: [
    { id: "a1", kind: "detected", at: NOW - 60_000, summary: "Read a job advert at uk.indeed.com" },
    { id: "a2", kind: "suggested", at: NOW - 55_000, summary: "Suggested: Save details" },
    { id: "a3", kind: "executed", at: NOW - 40_000, summary: "Save details — saved 12 details to Memory" },
    { id: "a4", kind: "verified", at: NOW - 39_000, summary: "Confirmed: the item is in Memory" },
    { id: "a5", kind: "detected", at: NOW - 3 * 3600_000, summary: "Read a job advert at jobs.nhs.uk" },
  ],
  analysedAt: NOW - 20_000,
  siteOrigin: "https://uk.indeed.com",
  siteAccessGranted: true,
  pageAccessGranted: true,
};

const briefing = { greeting: "Good afternoon", overdue: [], dueToday: [], loose: [], upcoming: state.reminders };

// The fake worker: enough of chrome.* for the panel to run and be looked at.
(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    sendMessage: async (request: { type: string }) => {
      if (request.type === "BRIEFING") return { type: "BRIEFING", briefing };
      if (request.type === "PAGE_FINGERPRINT") return { type: "FINGERPRINT" };
      // So the finished state of a suggestion card can be looked at.
      if (request.type === "RUN_ACTION" && (request as { actionId: string }).actionId === "copy_details") {
        const step = await registry.get("copy_details")!.execute(toActionInput(page, analysis));
        return {
          type: "STEP",
          outcome: { actionId: "copy_details", name: "Copy the key details", status: "done", message: step.message, handle: step.handle },
        };
      }
      if (request.type === "RUN_ACTION")
        return {
          type: "STEP",
          outcome: {
            actionId: (request as { actionId: string }).actionId,
            name: "Save details",
            status: "done",
            message: "Saved 12 details to Memory.",
            undoHandle: "x1",
          },
        };
      if (request.type === "COMPLETE_IT") {
        await new Promise((r) => setTimeout(r, 700));
        const steps = analysis.suggestions
          .filter((x) => x.risk === "safe")
          .slice(0, 3)
          .map((x) => ({ actionId: x.actionId, name: x.name, risk: "safe", status: "done", message: `${x.name}: done.`, undoable: true, undoHandle: "u" }));
        return { type: "REPORT", report: { steps, done: steps.length, needsApproval: 0, failed: 0 } };
      }
      if (request.type === "SET_SETTINGS") {
        Object.assign(state, { settings: { ...state.settings, ...(request as { settings: object }).settings } });
        return { type: "STATE", state: { ...state } };
      }
      if (request.type === "CALENDAR_FILE") return { type: "ERROR", message: "not in preview" };
      return { type: "STATE", state };
    },
  },
  tabs: { onActivated: { addListener() {}, removeListener() {} }, onUpdated: { addListener() {}, removeListener() {} }, query: async () => [] },
  permissions: { contains: async () => true, request: async () => true },
};

const { App } = await import("../extension/src/sidepanel/App");
createRoot(document.getElementById("root")!).render(<App />);
