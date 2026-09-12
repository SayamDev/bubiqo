import { createRoot } from "react-dom/client";
import "../extension/src/sidepanel/styles.css";
import { JobBriefBlock } from "../extension/src/sidepanel/App";
import { analyse } from "@core/analyse";
import { buildRegistry } from "@core/actions";
import { DEFAULT_SETTINGS, type PageContext } from "@core/types";
import techLead from "../tests/captured/linkedin-tech-lead.json";
import indeed from "../tests/captured/indeed-job.json";
import synthetic from "../tests/captured/job.json";

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

createRoot(document.getElementById("root")!).render(
  <div className="app" data-surface="job" style={{ maxWidth: 420, padding: 12 }}>
    <JobBriefBlock brief={brief(techLead)} now={NOW} />
    <JobBriefBlock brief={brief(indeed)} now={NOW} />
    <JobBriefBlock brief={brief(synthetic)} now={NOW} />
  </div>,
);
