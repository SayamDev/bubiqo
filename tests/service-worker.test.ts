/**
 * Integration tests for the service worker.
 *
 * These drive the worker the way the panel does — by dispatching messages — over a
 * fake chrome.* surface. They cover the wiring that unit tests cannot: message
 * routing, the chrome-backed ports, alarm scheduling, and persistence across a
 * simulated worker restart.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { installFakeChrome, freshState, type FakeState } from "./chrome-fake";
import type { PanelState, Response } from "@shared/messages";
import type { StepOutcome, CompleteItReport } from "@core/executor";

const here = dirname(fileURLToPath(import.meta.url));
const emailPage = JSON.parse(readFileSync(resolve(here, "captured", "email.json"), "utf8")) as unknown;
const invoicePage = JSON.parse(readFileSync(resolve(here, "captured", "invoice.json"), "utf8")) as unknown;

let state: FakeState;
let dispatch: (request: unknown) => Promise<Response>;

/** Load a fresh copy of the worker module against a fresh fake chrome. */
async function bootWorker(page: unknown, url?: string) {
  state = freshState(page, url);
  const chrome = installFakeChrome(state);
  vi.resetModules();
  await import("../extension/src/background/service-worker");
  dispatch = (request) => chrome.runtime.onMessage.dispatch(request) as Promise<Response>;
}

const asState = (r: Response): PanelState => {
  if (r.type !== "STATE") throw new Error(`expected STATE, got ${r.type}`);
  return r.state;
};

/*
 * The service worker reads the real clock, and the captured pages are dated
 * March 2026, so the system time is pinned to the same Friday the other suites
 * use. Without this, every date on those pages is in the past and the briefing
 * has nothing upcoming to report.
 */
const NOW = new Date(2026, 2, 6, 10, 0, 0);

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  await bootWorker(emailPage);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("analysing the active tab", () => {
  it("reads the page and returns a full analysis", async () => {
    const panel = asState(await dispatch({ type: "ANALYSE_ACTIVE_TAB" }));
    expect(panel.analysis?.classification.surface).toBe("email");
    expect(panel.analysis?.suggestions.length).toBeGreaterThan(0);
    expect(panel.page?.title).toContain("Revised proposal");
  });

  it("refuses browser pages politely instead of failing", async () => {
    await bootWorker(emailPage, "chrome://extensions");
    const panel = asState(await dispatch({ type: "ANALYSE_ACTIVE_TAB" }));
    expect(panel.unavailableReason).toMatch(/browser pages/i);
    expect(panel.analysis).toBeUndefined();
  });

  it("respects a site the user switched off", async () => {
    await dispatch({ type: "SET_SETTINGS", settings: { disabledDomains: ["mail.example.com"] } });
    const panel = asState(await dispatch({ type: "ANALYSE_ACTIVE_TAB" }));
    expect(panel.unavailableReason).toMatch(/switched Bubiqo off/i);
  });

  it("asks the user to grant access when Chrome refuses the injection", async () => {
    // The real failure mode: activeTab was never granted for this tab.
    state.denyInjection = true;
    const panel = asState(await dispatch({ type: "ANALYSE_ACTIVE_TAB" }));

    expect(panel.analysis).toBeUndefined();
    expect(panel.canRequestAccess).toBe(true);
    // It must tell the user what to DO, not just that it failed.
    expect(panel.unavailableReason).toMatch(/click the bubiqo icon/i);
  });

  it("never claims there is no page open, which is what a missing tabs permission looked like", async () => {
    /*
     * chrome.tabs.query only populates `url` when the extension holds the `tabs`
     * permission or a host permission. Bubiqo holds neither by design, so the old
     * gate on tab.url made every single page report "There is no page open in this
     * tab" — the bug this test exists to prevent.
     */
    state.activeTab = { id: 1 };
    const panel = asState(await dispatch({ type: "ANALYSE_ACTIVE_TAB" }));
    expect(panel.unavailableReason ?? "").not.toMatch(/no page open/i);
    expect(panel.analysis).toBeDefined();
  });

  it("reports the origin so the panel can offer standing access", async () => {
    const panel = asState(await dispatch({ type: "ANALYSE_ACTIVE_TAB" }));
    expect(panel.siteOrigin).toBe("https://mail.example.com");
    expect(panel.siteAccessGranted).toBe(false);
  });

  it("makes no network request while conversion is off", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("makes no network request on an invoice either, until conversion is switched on", async () => {
    await bootWorker(invoicePage, "https://billing.example.com/i/1");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const panel = asState(await dispatch({ type: "ANALYSE_ACTIVE_TAB" }));
    expect(panel.analysis?.classification.surface).toBe("invoice");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("running an action end to end", () => {
  it("creates a reminder, stores it, and schedules a real alarm", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    const response = await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false });

    expect(response.type).toBe("STEP");
    const outcome = (response as { outcome: StepOutcome }).outcome;
    expect(outcome.status).toBe("done");

    const stored = state.store["bubiqo.reminders"] as Record<string, { title: string; dueAt: number }>;
    expect(Object.keys(stored)).toHaveLength(1);
    expect(state.alarms.size).toBe(1);

    // The alarm and the stored record must agree, or one of them is a lie.
    const [record] = Object.values(stored);
    const [alarmWhen] = [...state.alarms.values()];
    expect(alarmWhen).toBe(record!.dueAt);
  });

  it("refuses a blocked action through the real message path", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    const response = await dispatch({ type: "RUN_ACTION", actionId: "pay_invoice", approved: true });
    const outcome = (response as { outcome: StepOutcome }).outcome;
    expect(outcome.status).toBe("refused");
    expect(state.store["bubiqo.reminders"]).toBeUndefined();
  });

  it("refuses an action that does not exist", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    const response = await dispatch({ type: "RUN_ACTION", actionId: "drop_all_tables", approved: true });
    expect((response as { outcome: StepOutcome }).outcome.status).toBe("refused");
  });

  it("will not act before anything has been analysed", async () => {
    const response = await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false });
    expect(response.type).toBe("ERROR");
  });
});

describe("Complete It through the message path", () => {
  it("runs the safe steps and writes them all to storage", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    const response = await dispatch({ type: "COMPLETE_IT" });

    expect(response.type).toBe("REPORT");
    const report = (response as { report: CompleteItReport }).report;
    expect(report.done).toBeGreaterThanOrEqual(2);
    expect(report.failed).toBe(0);
    expect(report.steps.every((s) => s.status === "done")).toBe(true);
  });

  it("records the whole trail in Activity", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "COMPLETE_IT" });
    const panel = asState(await dispatch({ type: "GET_ACTIVITY" }));
    const kinds = panel.activity.map((a) => a.kind);
    expect(kinds).toContain("executed");
    expect(kinds).toContain("verified");
  });
});

describe("undo through the message path", () => {
  it("removes the reminder and clears its alarm", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    const created = (await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false })) as { outcome: StepOutcome };
    expect(state.alarms.size).toBe(1);

    await dispatch({ type: "UNDO", actionId: "create_reminder", handle: created.outcome.undoHandle! });

    expect(Object.keys(state.store["bubiqo.reminders"] as object)).toHaveLength(0);
    expect(state.alarms.size).toBe(0);
  });
});

describe("persistence across a worker restart", () => {
  it("keeps reminders, because MV3 terminates workers whenever it likes", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false });
    const before = state.store;

    // Restart the worker, keeping the same storage — exactly what Chrome does.
    const chrome = installFakeChrome({ ...state, store: before });
    vi.resetModules();
    await import("../extension/src/background/service-worker");
    const restarted = (r: unknown) => chrome.runtime.onMessage.dispatch(r) as Promise<Response>;

    const panel = asState(await restarted({ type: "GET_REMINDERS" }));
    expect(panel.reminders).toHaveLength(1);
  });
});

describe("memory and settings", () => {
  it("saves and deletes a memory item", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "save_to_memory", approved: false });

    let panel = asState(await dispatch({ type: "GET_MEMORY" }));
    expect(panel.memory).toHaveLength(1);

    panel = asState(await dispatch({ type: "DELETE_MEMORY", id: panel.memory[0]!.id }));
    expect(panel.memory).toHaveLength(0);
  });

  it("never writes raw page text into storage", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "COMPLETE_IT" });
    const everything = JSON.stringify(state.store);
    expect(everything).not.toContain("The board reviews it first thing Monday morning");
  });

  it("round-trips settings", async () => {
    const panel = asState(await dispatch({ type: "SET_SETTINGS", settings: { mode: "proactive" } }));
    expect(panel.settings.mode).toBe("proactive");
    const again = asState(await dispatch({ type: "GET_SETTINGS" }));
    expect(again.settings.mode).toBe("proactive");
  });
});

describe("the briefing", () => {
  it("reports a saved item with a date but no reminder covering it", async () => {
    await bootWorker(invoicePage, "https://billing.example.com/i/1");
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "save_to_memory", approved: false });

    const response = await dispatch({ type: "BRIEFING" });
    expect(response.type).toBe("BRIEFING");
    if (response.type === "BRIEFING") {
      expect(response.briefing.loose.length).toBeGreaterThan(0);
      expect(response.briefing.loose[0]!.why).toMatch(/no reminder/i);
    }
  });
});

describe("calendar download", () => {
  it("hands back a real .ics file", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    const created = (await dispatch({ type: "RUN_ACTION", actionId: "export_calendar_event", approved: false })) as { outcome: StepOutcome };

    const response = await dispatch({ type: "DOWNLOAD_CALENDAR", handle: created.outcome.undoHandle! });
    expect(response.type).toBe("CALENDAR_FILE");
    if (response.type === "CALENDAR_FILE") {
      expect(response.ics).toContain("BEGIN:VCALENDAR");
      expect(response.filename).toMatch(/\.ics$/);
    }
  });
});

describe("results reach the user", () => {
  it("lists a saved draft so it can actually be read", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "draft_reply", approved: false });

    const panel = asState(await dispatch({ type: "GET_DRAFTS" }));
    expect(panel.drafts).toHaveLength(1);
    expect(panel.drafts[0]!.body.length).toBeGreaterThan(20);
  });

  it("deletes a draft on request", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "draft_reply", approved: false });
    let panel = asState(await dispatch({ type: "GET_DRAFTS" }));

    panel = asState(await dispatch({ type: "DELETE_DRAFT", id: panel.drafts[0]!.id }));
    expect(panel.drafts).toHaveLength(0);
  });

  it("hands back a downloadable .ics for a calendar export", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    const created = (await dispatch({ type: "RUN_ACTION", actionId: "export_calendar_event", approved: false })) as { outcome: StepOutcome };

    const response = await dispatch({ type: "DOWNLOAD_CALENDAR", handle: created.outcome.handle! });
    expect(response.type).toBe("CALENDAR_FILE");
    if (response.type === "CALENDAR_FILE") expect(response.ics).toContain("BEGIN:VEVENT");
  });
});
