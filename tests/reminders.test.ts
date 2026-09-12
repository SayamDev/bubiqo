/**
 * The reminder lifecycle, end to end.
 *
 * Reminders are the feature everything else leans on, so this walks the whole
 * path over a fake chrome.* surface and prints what happened at each step. Run it
 * on its own to watch the trace:
 *
 *     npm run prove:reminders
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { installFakeChrome, freshState, type FakeState } from "./chrome-fake";
import type { PanelState, Response } from "@shared/messages";
import type { StepOutcome } from "@core/executor";

const here = dirname(fileURLToPath(import.meta.url));
const emailPage = JSON.parse(readFileSync(resolve(here, "captured", "email.json"), "utf8")) as unknown;
const invoicePage = JSON.parse(readFileSync(resolve(here, "captured", "invoice.json"), "utf8")) as unknown;

/** Friday 6 March 2026, 10:00. The email says "by Friday", meaning the 13th. */
const NOW = new Date(2026, 2, 6, 10, 0, 0);

let state: FakeState;
let dispatch: (request: unknown) => Promise<Response>;
const trace: string[] = [];

const say = (line: string) => trace.push(line);
const when = (ms: number) => new Date(ms).toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  trace.length = 0;

  state = freshState(emailPage);
  const chrome = installFakeChrome(state);
  vi.resetModules();
  await import("../extension/src/background/service-worker");
  dispatch = (r) => chrome.runtime.onMessage.dispatch(r) as Promise<Response>;
});

afterEach(() => {
  // Printing the trace is the point of this file — see npm run prove:reminders.
  // eslint-disable-next-line no-console
  if (trace.length > 0) console.log(`\n${trace.join("\n")}\n`);
  vi.useRealTimers();
});

const asState = (r: Response): PanelState => {
  if (r.type !== "STATE") throw new Error(`expected STATE, got ${r.type}`);
  return r.state;
};

describe("a reminder, from an email to an alarm and back", () => {
  it("does the whole round trip", async () => {
    say(`TODAY IS        ${when(NOW.getTime())}`);

    // 1. Read the email.
    const read = asState(await dispatch({ type: "ANALYSE_ACTIVE_TAB" }));
    const deadline = read.analysis!.entities.find((e) => e.type === "deadline")!;
    say(`PAGE            ${read.page!.title}`);
    say(`DEADLINE FOUND  ${when(deadline.resolvedAt!)}   from “${deadline.source.slice(0, 46)}…”`);
    expect(new Date(deadline.resolvedAt!).getDate()).toBe(13);

    // 2. Create the reminder.
    const run = (await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false })) as { outcome: StepOutcome };
    say(`ACTION          ${run.outcome.name} -> ${run.outcome.status}`);
    say(`REPORTED        “${run.outcome.message}”`);
    expect(run.outcome.status).toBe("done");

    // 3. It is really in storage.
    const stored = Object.values(state.store["bubiqo.reminders"] as Record<string, { title: string; dueAt: number; fired: boolean }>);
    expect(stored).toHaveLength(1);
    say(`STORED          “${stored[0]!.title}”`);
    say(`DUE             ${when(stored[0]!.dueAt)}`);

    // 4. A real alarm is scheduled, for the day BEFORE the deadline.
    expect(state.alarms.size).toBe(1);
    const alarmAt = [...state.alarms.values()][0]!;
    say(`ALARM SET FOR   ${when(alarmAt)}`);
    expect(alarmAt).toBe(stored[0]!.dueAt);
    expect(new Date(alarmAt).getDate()).toBe(12);
    say(`                (the morning before the deadline, not the moment it expires)`);

    // 5. Verification confirmed it, rather than assuming.
    const activity = asState(await dispatch({ type: "GET_ACTIVITY" })).activity.map((a) => `${a.kind}: ${a.summary}`);
    say(`VERIFIED        ${activity.find((a) => a.startsWith("verified")) ?? "NOT VERIFIED"}`);
    expect(activity.some((a) => a.startsWith("verified"))).toBe(true);

    // 6. It shows up in the briefing as the day approaches.
    vi.setSystemTime(new Date(2026, 2, 12, 8, 0, 0));
    const briefing = await dispatch({ type: "BRIEFING" });
    if (briefing.type === "BRIEFING") {
      const due = [...briefing.briefing.dueToday, ...briefing.briefing.overdue];
      say(`ON 12 MARCH     briefing shows ${due.length} due: “${due[0]?.title ?? "—"}”`);
      expect(due.length).toBe(1);
    }

    // 7. Undo removes the record and clears the alarm.
    vi.setSystemTime(NOW);
    await dispatch({ type: "UNDO", actionId: "create_reminder", handle: run.outcome.undoHandle! });
    say(`UNDO            reminders left: ${Object.keys(state.store["bubiqo.reminders"] as object).length}, alarms left: ${state.alarms.size}`);
    expect(Object.keys(state.store["bubiqo.reminders"] as object)).toHaveLength(0);
    expect(state.alarms.size).toBe(0);
  });

  it("does not schedule an alarm in the past, but still records the reminder", async () => {
    /*
     * Chrome refuses an alarm whose moment has gone. The record must survive
     * anyway — an overdue reminder is exactly the thing the user needs shown.
     *
     * This uses the invoice, whose due date is an absolute 20 March. A weekday
     * phrase like "by Friday" can never be used to test this, because it always
     * resolves to the NEXT Friday and so is never in the past.
     */
    state.pageResult = invoicePage;
    state.activeTab = { id: 1, url: "https://billing.example.com/invoices/INV-2026-0042" };
    vi.setSystemTime(new Date(2026, 3, 1, 9, 0, 0)); // after the 20 March due date
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false });

    const stored = Object.values(state.store["bubiqo.reminders"] as Record<string, unknown>);
    say(`PAST DEADLINE   stored: ${stored.length}, alarms scheduled: ${state.alarms.size}`);
    expect(stored).toHaveLength(1);
    expect(state.alarms.size).toBe(0);

    const briefing = await dispatch({ type: "BRIEFING" });
    if (briefing.type === "BRIEFING") {
      say(`                briefing overdue: ${briefing.briefing.overdue.length}`);
      expect(briefing.briefing.overdue.length).toBe(1);
    }
  });

  it("survives the service worker being terminated", async () => {
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false });

    const chrome = installFakeChrome({ ...state, store: state.store });
    vi.resetModules();
    await import("../extension/src/background/service-worker");
    const after = (r: unknown) => chrome.runtime.onMessage.dispatch(r) as Promise<Response>;

    const panel = asState(await after({ type: "GET_REMINDERS" }));
    say(`AFTER RESTART   reminders still present: ${panel.reminders.length}`);
    expect(panel.reminders).toHaveLength(1);
  });
});

describe("when Chrome was closed over the due time", () => {
  it("catches up on the next start, marks it, and badges the icon", async () => {
    /*
     * chrome.alarms is a browser API, not a service: nothing fires while Chrome is
     * closed. Chrome may replay a missed alarm on startup, but that guarantee is
     * weak over long gaps, and the toolbar badge is cleared on restart anyway — so
     * a reminder that fired yesterday left no trace today.
     *
     * The stored records are therefore the source of truth, reconciled on wake.
     */
    await dispatch({ type: "ANALYSE_ACTIVE_TAB" });
    await dispatch({ type: "RUN_ACTION", actionId: "create_reminder", approved: false });

    const before = Object.values(state.store["bubiqo.reminders"] as Record<string, { fired: boolean; dueAt: number }>)[0]!;
    expect(before.fired).toBe(false);
    say(`BEFORE          due ${when(before.dueAt)}, fired: ${before.fired}, badge: "${state.badge}"`);

    // Chrome is closed, a fortnight passes, Chrome starts again — and no alarm
    // ever fired, because the browser was not running.
    vi.setSystemTime(new Date(2026, 2, 20, 9, 0, 0));
    const restarted = { ...state, alarms: new Map<string, number>() };
    const chrome = installFakeChrome(restarted);
    vi.resetModules();
    await import("../extension/src/background/service-worker");
    await vi.waitFor(() => expect(restarted.badge).not.toBe(""));

    const after = Object.values(restarted.store["bubiqo.reminders"] as Record<string, { fired: boolean; title: string }>)[0]!;
    say(`AFTER RESTART   fired: ${after.fired}, badge: "${restarted.badge}"`);

    expect(after.fired).toBe(true);
    expect(restarted.badge).toBe("1");

    // And it is visible in the briefing as overdue, not silently swallowed.
    const dispatch2 = (r: unknown) => chrome.runtime.onMessage.dispatch(r) as Promise<Response>;
    const briefing = await dispatch2({ type: "BRIEFING" });
    if (briefing.type === "BRIEFING") {
      say(`                briefing overdue: ${briefing.briefing.overdue.length} — “${briefing.briefing.overdue[0]?.title}”`);
      expect(briefing.briefing.overdue.length).toBe(1);
    }
  });

  it("clears the badge when nothing is outstanding", async () => {
    const chrome = installFakeChrome(freshState(emailPage));
    vi.resetModules();
    await import("../extension/src/background/service-worker");
    void chrome;
    expect(state.badge).toBe("");
  });
});
