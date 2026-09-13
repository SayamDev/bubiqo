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
import { analyse } from "@core/analyse";
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
const page = indeedViewjob as unknown as PageContext;
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
      if (request.type === "CALENDAR_FILE") return { type: "ERROR", message: "not in preview" };
      return { type: "STATE", state };
    },
  },
  tabs: { onActivated: { addListener() {}, removeListener() {} }, onUpdated: { addListener() {}, removeListener() {} }, query: async () => [] },
  permissions: { contains: async () => true, request: async () => true },
};

const { App } = await import("../extension/src/sidepanel/App");
createRoot(document.getElementById("root")!).render(<App />);
