import { createRoot } from "react-dom/client";
import "../extension/src/sidepanel/styles.css";
import { JobBriefBlock, SavedItem } from "../extension/src/sidepanel/App";
import { analyse } from "@core/analyse";
import { briefToEntities } from "@core/job-brief";
import { buildRegistry } from "@core/actions";
import { DEFAULT_SETTINGS, type PageContext } from "@core/types";
import indeedViewjob from "../tests/captured/indeed-viewjob.json";
import linkedin from "../tests/captured/linkedin-prompt-engineer.json";
import nhs from "../tests/captured/nhs-job.json";

const NOW = new Date(2026, 2, 6, 10, 0, 0).getTime();
const ports = {
  storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, keys: async () => [] },
  clock: { now: () => NOW },
  alarms: { schedule: async () => {}, cancel: async () => {} },
  downloads: { save: async () => "ok" },
  clipboard: { write: async () => {} },
  rates: { convert: async () => undefined },
} as never;
const registry = buildRegistry(ports);
const brief = (page: unknown) =>
  analyse(page as PageContext, registry, { settings: DEFAULT_SETTINGS, now: NOW }).brief;

const savedFrom = (raw: unknown, id: string) => {
  const page = raw as PageContext;
  const a = analyse(page, registry, { settings: DEFAULT_SETTINGS, now: NOW });
  return {
    id,
    kind: "job" as const,
    title: a.brief?.title?.value ?? page.title,
    entities: briefToEntities(a.brief!, a.entities, page.url),
    url: page.url,
    savedAt: NOW - 3 * 60 * 1000,
  };
};

createRoot(document.getElementById("root")!).render(
  <div className="app" data-surface="job" style={{ maxWidth: 420, padding: 12 }}>
    <JobBriefBlock brief={brief(indeedViewjob)} now={NOW} />
    <JobBriefBlock brief={brief(linkedin)} now={NOW} />
    <JobBriefBlock brief={brief(nhs)} now={NOW} />

    <h2 className="section__title" style={{ marginTop: 24 }}>Saved</h2>
    <ul className="list list--cards">
      <SavedItem item={savedFrom(indeedViewjob, "a")} now={NOW} onChange={() => {}} />
      <SavedItem item={savedFrom(nhs, "b")} now={NOW} onChange={() => {}} />
    </ul>
  </div>,
);
