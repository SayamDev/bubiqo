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
const jobPage = JSON.parse(readFileSync(resolve(here, "captured", "linkedin-prompt-engineer.json"), "utf8")) as unknown;
const secondJobPage = JSON.parse(readFileSync(resolve(here, "captured", "indeed-viewjob.json"), "utf8")) as unknown;

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

  it("asks for permission when Chrome refuses the injection", async () => {
    /*
     * The real failure mode, and the one that shipped: a side panel never receives
     * activeTab, so injection is refused until the user grants page access. The
     * panel must offer that, not advise clicking an icon — which can never work.
     */
    state.denyInjection = true;
    const panel = asState(await dispatch({ type: "ANALYSE_ACTIVE_TAB" }));

    expect(panel.analysis).toBeUndefined();
    expect(panel.canRequestAccess).toBe(true);
    expect(panel.pageAccessGranted).toBe(false);
    expect(panel.unavailableReason).toMatch(/permission to read/i);
    // Advice that cannot work is worse than no advice.
    expect(panel.unavailableReason).not.toMatch(/click the bubiqo icon/i);
  });

  it("reads the page once permission has been granted", async () => {
    state.denyInjection = true;
    expect(asState(await dispatch({ type: "ANALYSE_ACTIVE_TAB" })).analysis).toBeUndefined();

    // What the panel's "Allow Bubiqo to read pages" button does.
    const granted = await (globalThis as unknown as { chrome: { permissions: { request(o: { origins: string[] }): Promise<boolean> } } })
      .chrome.permissions.request({ origins: ["*://*/*"] });
    expect(granted).toBe(true);

    const panel = asState(await dispatch({ type: "ANALYSE_ACTIVE_TAB" }));
    expect(panel.analysis?.classification.surface).toBe("email");
    expect(panel.unavailableReason).toBeUndefined();
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

  it("reads the page itself rather than refusing, if nothing has been analysed yet", async () => {
    /*
     * Refusing here was technically correct and practically useless: the user
     * pressed a button next to a suggestion that was on their screen. If the
     * analysis is missing — usually because the worker restarted — the right
     * answer is to go and get it, not to explain why we cannot.
     */
    const response = await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false });
    expect(response.type).toBe("STEP");
    if (response.type === "STEP") expect(response.outcome.status).toBe("done");
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

describe("surviving a service-worker restart", () => {
  it("Complete It still works after the worker has been terminated", async () => {
    /*
     * MV3 terminates a service worker after roughly thirty seconds idle. Reading a
     * page, pausing to actually read it, then pressing "Complete it" takes longer
     * than that — so the in-memory analysis was gone and the button did nothing.
     */
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });

    // Restart the worker, keeping storage — exactly what Chrome does.
    const chrome = installFakeChrome({ ...state, store: state.store });
    vi.resetModules();
    await import("../extension/src/background/service-worker");
    const afterRestart = (r: unknown) => chrome.runtime.onMessage.dispatch(r) as Promise<Response>;

    const response = await afterRestart({ type: "COMPLETE_IT" });
    expect(response.type).toBe("REPORT");
    if (response.type === "REPORT") expect(response.report.done).toBeGreaterThan(0);
  });

  it("never answers a button press with a bare 'nothing has been analysed'", async () => {
    const chrome = installFakeChrome(freshState(emailPage));
    vi.resetModules();
    await import("../extension/src/background/service-worker");
    const fresh = (r: unknown) => chrome.runtime.onMessage.dispatch(r) as Promise<Response>;

    const response = await fresh({ type: "COMPLETE_IT" });
    // It re-reads rather than refusing; and if it truly cannot, it says what to do.
    if (response.type === "ERROR") expect(response.message).toMatch(/Re-read this page/i);
    else expect(response.type).toBe("REPORT");
  });
});

describe("clearing the activity log", () => {
  it("erases it on request", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false });
    expect(asState(await dispatch({ type: "GET_ACTIVITY" })).activity.length).toBeGreaterThan(0);

    const cleared = asState(await dispatch({ type: "CLEAR_ACTIVITY" }));
    expect(cleared.activity).toHaveLength(0);
  });

  it("clears the log without touching reminders or memory", async () => {
    // The audit trail is the user's to delete; what it describes is not.
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false });
    await dispatch({ type: "RUN_ACTION", actionId: "save_to_memory", approved: false });

    const after = asState(await dispatch({ type: "CLEAR_ACTIVITY" }));
    expect(after.activity).toHaveLength(0);
    expect(after.reminders).toHaveLength(1);
    expect(after.memory).toHaveLength(1);
  });
});

describe("pressing the same button repeatedly", () => {
  it("does not leave a pile of identical reminders", async () => {
    /*
     * Reported from real use: five clicks left five identical rows, all titled
     * with the Gmail page title, all for the same date. Unbounded growth against
     * a 10 MB quota, and the list becomes unusable long before that.
     */
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    for (let i = 0; i < 5; i++) {
      await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false });
    }

    const panel = asState(await dispatch({ type: "GET_REMINDERS" }));
    expect(panel.reminders).toHaveLength(1);
  });

  it("does not leave a pile of identical saved items", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    for (let i = 0; i < 4; i++) {
      await dispatch({ type: "RUN_ACTION", actionId: "save_to_memory", approved: false });
    }

    const panel = asState(await dispatch({ type: "GET_MEMORY" }));
    expect(panel.memory).toHaveLength(1);
  });

  it("still reports success each time, rather than looking broken", async () => {
    // Deduping must not make the second press look like a failure.
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    const first = (await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false })) as { outcome: StepOutcome };
    const second = (await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false })) as { outcome: StepOutcome };
    expect(first.outcome.status).toBe("done");
    expect(second.outcome.status).toBe("done");
  });
});

describe("what actually gets written to storage", () => {
  it("never writes the user's email address into a stored title", async () => {
    state.pageResult = {
      ...(emailPage as Record<string, unknown>),
      title: "Barclays wants you to apply - asfcit15sayamajmal@gmail.com - Gmail",
    };
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false });
    await dispatch({ type: "RUN_ACTION", actionId: "save_to_memory", approved: false });

    const written = JSON.stringify(state.store);
    expect(written).not.toMatch(/asfcit15sayamajmal@gmail\.com/);
    expect(written).not.toMatch(/ - Gmail/);
  });

  it("does not persist the explanatory page snippets attached to entities", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "save_to_memory", approved: false });

    const memory = asState(await dispatch({ type: "GET_MEMORY" })).memory;
    expect(memory[0]!.entities.every((e) => e.source === "")).toBe(true);
  });
});

describe("deleting everything", () => {
  it("removes reminders, memory, drafts and activity in one go", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false });
    await dispatch({ type: "RUN_ACTION", actionId: "save_to_memory", approved: false });
    await dispatch({ type: "RUN_ACTION", actionId: "draft_reply", approved: false });

    const wiped = asState(await dispatch({ type: "DELETE_ALL_DATA" }));
    expect(wiped.reminders).toHaveLength(0);
    expect(wiped.memory).toHaveLength(0);
    expect(wiped.drafts).toHaveLength(0);
    expect(wiped.activity).toHaveLength(0);
  });

  it("cancels the scheduled alarms too", async () => {
    /*
     * Clearing the records alone leaves orphaned alarms that outlive the data they
     * referred to. Harmless, because the handler finds no record — but it makes
     * "delete everything" not quite true, and untrue is the thing to avoid.
     */
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false });
    expect(state.alarms.size).toBe(1);

    await dispatch({ type: "DELETE_ALL_DATA" });
    expect(state.alarms.size).toBe(0);
  });

  it("clears the badge, so nothing claims attention that no longer exists", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false });
    state.badge = "1";

    await dispatch({ type: "DELETE_ALL_DATA" });
    expect(state.badge).toBe("");
  });

  it("keeps settings, because a data reset is not a preferences reset", async () => {
    await dispatch({ type: "SET_SETTINGS", settings: { mode: "proactive", theme: "dark" } });
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false });

    const wiped = asState(await dispatch({ type: "DELETE_ALL_DATA" }));
    expect(wiped.settings.mode).toBe("proactive");
    expect(wiped.settings.theme).toBe("dark");
  });

  it("forgets which suggestions were accepted or dismissed", async () => {
    // Otherwise ranking still carries a shadow of data the user asked to delete.
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false });
    await dispatch({ type: "DISMISS_SUGGESTION", actionId: "draft_reply" });

    await dispatch({ type: "DELETE_ALL_DATA" });
    expect(state.store["bubiqo.accepted"]).toBeUndefined();
    expect(state.store["bubiqo.dismissed"]).toBeUndefined();
  });
});

describe("clearing one collection at a time", () => {
  it("clears reminders and cancels their alarms, leaving memory alone", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false });
    await dispatch({ type: "RUN_ACTION", actionId: "save_to_memory", approved: false });
    expect(state.alarms.size).toBe(1);

    const after = asState(await dispatch({ type: "CLEAR_REMINDERS" }));
    expect(after.reminders).toHaveLength(0);
    expect(after.memory).toHaveLength(1);
    expect(state.alarms.size).toBe(0);
    expect(state.badge).toBe("");
  });

  it("clears memory, leaving reminders alone", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false });
    await dispatch({ type: "RUN_ACTION", actionId: "save_to_memory", approved: false });

    const after = asState(await dispatch({ type: "CLEAR_MEMORY" }));
    expect(after.memory).toHaveLength(0);
    expect(after.reminders).toHaveLength(1);
  });

  it("clears drafts", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "draft_reply", approved: false });
    expect(asState(await dispatch({ type: "CLEAR_DRAFTS" })).drafts).toHaveLength(0);
  });
});

describe("knowing a page is already saved", () => {
  it("reports it while the item exists", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    expect(asState(await dispatch({ type: "GET_STATE" })).alreadySaved).toBeUndefined();

    await dispatch({ type: "RUN_ACTION", actionId: "save_to_memory", approved: false });
    const panel = asState(await dispatch({ type: "ANALYSE_ACTIVE_TAB" }));
    expect(panel.alreadySaved).toBeDefined();
    expect(panel.alreadySaved!.title).toBeTruthy();
  });

  it("forgets immediately once the item is deleted, keeping no tombstone", async () => {
    /*
     * Deliberate product decision. Telling someone "you saved this before" about
     * something they deleted would mean retaining a record of every deletion —
     * exactly the shadow data that "delete" is supposed to remove. Knowing you
     * already have something is useful WHILE you have it, and not after.
     */
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "save_to_memory", approved: false });
    const saved = asState(await dispatch({ type: "GET_MEMORY" })).memory[0]!;

    await dispatch({ type: "DELETE_MEMORY", id: saved.id });
    const panel = asState(await dispatch({ type: "ANALYSE_ACTIVE_TAB" }));

    expect(panel.alreadySaved).toBeUndefined();
    expect(JSON.stringify(state.store)).not.toContain(saved.id);
  });

  it("saving again refreshes the one record rather than adding another", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "save_to_memory", approved: false });
    await dispatch({ type: "RUN_ACTION", actionId: "save_to_memory", approved: false });
    expect(asState(await dispatch({ type: "GET_MEMORY" })).memory).toHaveLength(1);
  });
});

describe("the panel must never lose the analysis it is showing", () => {
  /*
   * The stuck-skeleton bug, reported twice. MV3 terminates the worker after about
   * thirty seconds idle, so by the time a user reads the panel and changes a
   * setting, the in-memory analysis is usually gone. Every message that was not
   * itself an analysis then returned a state with no analysis, and the panel fell
   * back to its loading skeleton with nothing left to pull it out.
   *
   * One test per message that goes through baseState, because it was never about
   * settings specifically — that was just the easiest way to hit it.
   */
  const SURVIVES: { label: string; request: unknown }[] = [
    { label: "SET_SETTINGS", request: { type: "SET_SETTINGS", settings: { mode: "proactive" } } },
    { label: "GET_SETTINGS", request: { type: "GET_SETTINGS" } },
    { label: "GET_MEMORY", request: { type: "GET_MEMORY" } },
    { label: "GET_REMINDERS", request: { type: "GET_REMINDERS" } },
    { label: "GET_ACTIVITY", request: { type: "GET_ACTIVITY" } },
    { label: "GET_DRAFTS", request: { type: "GET_DRAFTS" } },
    { label: "CLEAR_ACTIVITY", request: { type: "CLEAR_ACTIVITY" } },
    { label: "CLEAR_REMINDERS", request: { type: "CLEAR_REMINDERS" } },
    { label: "CLEAR_MEMORY", request: { type: "CLEAR_MEMORY" } },
    { label: "DISMISS_SUGGESTION", request: { type: "DISMISS_SUGGESTION", actionId: "draft_reply" } },
  ];

  for (const { label, request } of SURVIVES) {
    it(`keeps the analysis across ${label}, even after the worker restarted`, async () => {
      await dispatch({ type: "ANALYSE_ACTIVE_TAB" });

      // The worker is terminated. Session storage survives; memory does not.
      const chrome = installFakeChrome({ ...state, store: state.store, session: state.session });
      vi.resetModules();
      await import("../extension/src/background/service-worker");
      const after = (r: unknown) => chrome.runtime.onMessage.dispatch(r) as Promise<Response>;

      const panel = asState(await after(request));
      expect(panel.analysis, `${label} came back with no analysis`).toBeDefined();
      expect(panel.page, `${label} came back with no page`).toBeDefined();
    });
  }
});

/*
 * Switching advert without a page load.
 *
 * Reported from the extension: click a different advert on a job board, press
 * "Complete all", and the details saved belong to the advert you were reading
 * before. A job board changes advert with history.pushState — the tab's URL
 * changes, the document does not reload, and chrome.tabs.onUpdated fires without
 * status "complete", so the panel never re-read.
 *
 * The panel listening harder is half a fix. The worker holds the analysis that
 * actions run against, so the worker is where this has to be caught: before
 * acting, what is stored must still describe the page in front of the user.
 */
describe("the page changed under the panel", () => {
  it("re-reads before completing, rather than acting on the advert before it", async () => {
    await bootWorker(jobPage, "https://uk.indeed.com/jobs?q=x&vjs=1");
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });

    // The user clicks a different advert: same document, new URL, new content.
    state.activeTab = { id: 1, url: "https://uk.indeed.com/jobs?q=x&vjs=2" };
    state.pageResult = secondJobPage;

    const response = await dispatch({ type: "COMPLETE_IT" });
    expect(response.type).toBe("REPORT");

    const panel = asState(await dispatch({ type: "GET_STATE" }));
    expect(panel.page?.url).toBe("https://uk.indeed.com/jobs?q=x&vjs=2");
    expect(panel.analysis?.brief?.title?.value).toBe("Business Applications Developer");
  });

  it("does not re-read when the page has not changed", async () => {
    await bootWorker(jobPage, "https://uk.indeed.com/jobs?q=x&vjs=1");
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });

    const before = state.injections;
    await dispatch({ type: "COMPLETE_IT" });
    expect(state.injections, "the page was read again for no reason").toBe(before);
  });
});

describe("the page fingerprint", () => {
  it("answers without disturbing the analysis the panel is showing", async () => {
    await bootWorker(jobPage, "https://uk.indeed.com/jobs?q=x&vjs=1");
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    const before = asState(await dispatch({ type: "GET_STATE" }));

    const response = await dispatch({ type: "PAGE_FINGERPRINT" });
    expect(response.type).toBe("FINGERPRINT");

    const after = asState(await dispatch({ type: "GET_STATE" }));
    expect(after.page?.url).toBe(before.page?.url);
    expect(after.analysis?.brief?.title?.value).toBe(before.analysis?.brief?.title?.value);
  });

  it("returns nothing rather than an error when the page cannot be read", async () => {
    await bootWorker(jobPage);
    state.denyInjection = true;
    const response = await dispatch({ type: "PAGE_FINGERPRINT" });
    expect(response.type).toBe("FINGERPRINT");
    expect((response as { fingerprint?: unknown }).fingerprint).toBeUndefined();
  });
});
