import { describe, it, expect, beforeEach } from "vitest";
import { Executor } from "@core/executor";
import { buildRegistry } from "@core/actions";
import { analyse, toActionInput } from "@core/analyse";
import { decide, sanitiseParams, assertWellFormed } from "@core/safety";
import { DEFAULT_SETTINGS, type ActionDefinition, type Settings } from "@core/types";
import { makePorts, type TestPorts } from "./fakes";
import { NOW, emailWithDeadline, longEmailThread, invoicePage, maliciousPage } from "./fixtures";

let ports: TestPorts;
let registry: ReadonlyMap<string, ActionDefinition>;
let executor: Executor;

function setup(settings: Settings = DEFAULT_SETTINGS) {
  ports = makePorts(NOW);
  registry = buildRegistry(ports);
  executor = new Executor(registry, ports, settings);
}

beforeEach(() => setup());

const inputFor = (page: typeof emailWithDeadline) => {
  const analysis = analyse(page, registry, { settings: DEFAULT_SETTINGS, now: NOW });
  return { analysis, input: toActionInput(page, analysis) };
};

describe("running a safe action", () => {
  it("creates a reminder, verifies it, and reports done", async () => {
    const { input } = inputFor(emailWithDeadline);
    const outcome = await executor.run("create_reminder", input);

    expect(outcome.status).toBe("done");
    expect(ports.reminders.store.size).toBe(1);
    expect(outcome.undoable).toBe(true);
  });

  it("reminds the day before a deadline, not at the moment it expires", async () => {
    const { input } = inputFor(emailWithDeadline);
    await executor.run("create_reminder", input);
    const reminder = [...ports.reminders.store.values()][0]!;
    // Friday 13 March deadline -> reminder on Thursday 12 March.
    expect(new Date(reminder.dueAt).getDate()).toBe(12);
  });

  it("writes the full detected -> executed -> verified trail to Activity", async () => {
    const { input } = inputFor(emailWithDeadline);
    await executor.run("create_reminder", input);
    expect(ports.activity.kinds()).toEqual(["executed", "verified"]);
  });

  it("produces a real calendar file", async () => {
    const { input } = inputFor(emailWithDeadline);
    const outcome = await executor.run("export_calendar_event", input);
    expect(outcome.status).toBe("done");

    const file = [...ports.calendar.store.values()][0]!;
    expect(file.ics).toContain("BEGIN:VEVENT");
    expect(file.ics).toContain("END:VCALENDAR");
    expect(file.filename).toMatch(/\.ics$/);
  });
});

describe("verification is not decoration", () => {
  it("reports unconfirmed, not done, when the result cannot be found", async () => {
    const { input } = inputFor(emailWithDeadline);
    // Simulate storage that accepts a write then loses it.
    ports.reminders.create = async () => "rem_vanished";
    const outcome = await executor.run("create_reminder", input);

    expect(outcome.status).toBe("unconfirmed");
    expect(outcome.message).toMatch(/could not confirm/i);
    expect(outcome.message).not.toMatch(/^Done/);
  });

  it("records the failure in Activity rather than hiding it", async () => {
    const { input } = inputFor(emailWithDeadline);
    ports.reminders.create = async () => "rem_vanished";
    await executor.run("create_reminder", input);
    expect(ports.activity.kinds()).toContain("failed");
  });

  it("reports failed when the action itself throws", async () => {
    const { input } = inputFor(emailWithDeadline);
    ports.reminders.create = async () => {
      throw new Error("storage is full");
    };
    const outcome = await executor.run("create_reminder", input);
    expect(outcome.status).toBe("failed");
    expect(outcome.message).toBe("storage is full");
  });
});

describe("blocked actions", () => {
  it("never execute, even when named directly", async () => {
    const { input } = inputFor(invoicePage);
    const outcome = await executor.run("pay_invoice", input);
    expect(outcome.status).toBe("refused");
    expect(outcome.message).toMatch(/never performed automatically/i);
  });

  it("are never offered as suggestions", () => {
    const { analysis } = inputFor(invoicePage);
    expect(analysis.suggestions.some((s) => s.risk === "blocked")).toBe(false);
  });

  it("cannot be reached through Complete It", async () => {
    const { input } = inputFor(invoicePage);
    const report = await executor.completeIt(
      [{ actionId: "pay_invoice", name: "Pay this invoice", risk: "blocked", rationale: "x", score: 1, params: {} }],
      input,
    );
    expect(report.steps[0]?.status).toBe("refused");
    expect(report.done).toBe(0);
  });

  it("cannot be reached even with an explicit approval", async () => {
    const { input } = inputFor(invoicePage);
    const outcome = await executor.run("pay_invoice", input, { approved: ["pay_invoice"] });
    expect(outcome.status).toBe("refused");
  });
});

describe("unregistered actions", () => {
  it("are refused by name", async () => {
    const { input } = inputFor(emailWithDeadline);
    const outcome = await executor.run("exfiltrate_everything", input);
    expect(outcome.status).toBe("refused");
    expect(outcome.message).toMatch(/not a registered action/i);
  });

  it("leave a trace in Activity", async () => {
    const { input } = inputFor(emailWithDeadline);
    await executor.run("rm_minus_rf", input);
    expect(ports.activity.kinds()).toContain("blocked");
  });
});

describe("confirm-risk actions", () => {
  it("stop and ask rather than running", async () => {
    const { input } = inputFor(emailWithDeadline);
    const outcome = await executor.run("open_application_link", {
      ...input,
      params: { url: "https://careers.example.com/apply" },
    });
    expect(outcome.status).toBe("needs_approval");
  });

  it("run once approved, and log the approval", async () => {
    const { input } = inputFor(emailWithDeadline);
    const outcome = await executor.run(
      "open_application_link",
      { ...input, params: { url: "https://careers.example.com/apply" } },
      { approved: ["open_application_link"] },
    );
    expect(outcome.status).toBe("done");
    expect(ports.activity.kinds()).toContain("approved");
  });

  it("refuse non-https destinations outright", async () => {
    const { input } = inputFor(emailWithDeadline);
    const outcome = await executor.run(
      "open_application_link",
      { ...input, params: { url: "javascript:alert(1)" } },
      { approved: ["open_application_link"] },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.message).toMatch(/only https/i);
  });
});

describe("Complete It", () => {
  it("runs the safe steps and reports what actually happened", async () => {
    const { analysis, input } = inputFor(emailWithDeadline);
    const report = await executor.completeIt(analysis.suggestions.slice(0, 3), input);

    expect(report.steps.length).toBeGreaterThan(0);
    expect(report.done).toBe(report.steps.length);
    expect(report.failed).toBe(0);
  });

  it("caps the number of steps so a routine cannot loop", async () => {
    const { input } = inputFor(emailWithDeadline);
    const many = Array.from({ length: 40 }, () => ({
      actionId: "create_reminder", name: "Create reminder", risk: "safe" as const,
      rationale: "x", score: 1, params: {},
    }));
    const report = await executor.completeIt(many, input, { maxSteps: 100 });
    expect(report.steps.length).toBeLessThanOrEqual(8);
  });

  it("surfaces confirm steps instead of silently running them", async () => {
    const { input } = inputFor(emailWithDeadline);
    const report = await executor.completeIt(
      [
        { actionId: "create_reminder", name: "Create reminder", risk: "safe", rationale: "x", score: 1, params: {} },
        { actionId: "open_application_link", name: "Open link", risk: "confirm", rationale: "x", score: 1, params: { url: "https://x.example.com" } },
      ],
      input,
    );
    expect(report.done).toBe(1);
    expect(report.needsApproval).toBe(1);
  });
});

describe("undo", () => {
  it("reverses a reminder", async () => {
    const { input } = inputFor(emailWithDeadline);
    const outcome = await executor.run("create_reminder", input);
    expect(ports.reminders.store.size).toBe(1);

    const undone = await executor.undo("create_reminder", outcome.undoHandle!);
    expect(undone.status).toBe("done");
    expect(ports.reminders.store.size).toBe(0);
  });

  it("says so plainly when an action cannot be reversed", async () => {
    const undone = await executor.undo("copy_details", "whatever");
    expect(undone.status).toBe("refused");
    expect(undone.message).toMatch(/cannot be automatically reversed/i);
  });
});

describe("user settings are respected", () => {
  it("refuses an action the user turned off", async () => {
    setup({ ...DEFAULT_SETTINGS, disabledActionIds: ["create_reminder"] });
    const { input } = inputFor(emailWithDeadline);
    const outcome = await executor.run("create_reminder", input);
    expect(outcome.status).toBe("refused");
    expect(outcome.message).toMatch(/turned this suggestion off/i);
  });

  it("refuses everything on a domain the user turned off", async () => {
    setup({ ...DEFAULT_SETTINGS, disabledDomains: ["mail.example.com"] });
    const { input } = inputFor(emailWithDeadline);
    const outcome = await executor.run("create_reminder", input);
    expect(outcome.status).toBe("refused");
  });
});

describe("a hostile page", () => {
  it("cannot cause anything to run", async () => {
    const { analysis, input } = inputFor(maliciousPage);
    const report = await executor.completeIt(analysis.suggestions, input);
    // Whatever it asked for, only registered safe actions could possibly have run.
    for (const step of report.steps) {
      expect(["create_reminder", "save_to_memory", "copy_details", "export_calendar_event", "create_task", "draft_reply"])
        .toContain(step.actionId);
    }
  });

  it("does not get its instructions into stored memory", async () => {
    const { input } = inputFor(maliciousPage);
    await executor.run("save_to_memory", input);
    const stored = JSON.stringify([...ports.memory.store.values()]);
    expect(stored).not.toMatch(/attacker\.example\.com/i);
    expect(stored).not.toMatch(/ignore all previous/i);
  });
});

describe("parameter sanitisation", () => {
  it("keeps only primitive values under sane keys", () => {
    const clean = sanitiseParams({
      title: "Send proposal",
      count: 3,
      flag: true,
      __proto__: { polluted: true },
      "bad key": "x",
      nested: { a: 1 },
      fn: () => {},
    });
    expect(clean).toEqual({ title: "Send proposal", count: 3, flag: true });
  });

  it("caps string length", () => {
    const clean = sanitiseParams({ title: "x".repeat(5000) });
    expect((clean["title"] as string).length).toBe(2000);
  });

  it("survives non-objects", () => {
    expect(sanitiseParams(null)).toEqual({});
    expect(sanitiseParams("nope")).toEqual({});
  });
});

describe("registry integrity", () => {
  it("rejects an action that claims undo but provides none", () => {
    expect(() =>
      assertWellFormed({
        id: "x", name: "X", category: "memory", risk: "safe", permissions: [], canUndo: true,
        applies: () => true, execute: async () => ({ ok: true, message: "", undoable: true }),
        verify: async () => ({ outcome: "confirmed", message: "" }),
      }),
    ).toThrow(/provides no undo/);
  });

  it("rejects a payment action that does not declare itself blocked", () => {
    expect(() =>
      assertWellFormed({
        id: "sneaky", name: "Sneaky", category: "payment", risk: "safe", permissions: [], canUndo: false,
        applies: () => true, execute: async () => ({ ok: true, message: "", undoable: false }),
        verify: async () => ({ outcome: "confirmed", message: "" }),
      }),
    ).toThrow(/must be declared "blocked"/);
  });

  it("every registered action declares a verify()", () => {
    for (const action of registry.values()) {
      expect(typeof action.verify, `${action.id} has no verify()`).toBe("function");
    }
  });

  it("decide() refuses an unknown action without needing the registry", () => {
    const verdict = decide(undefined, "ghost", DEFAULT_SETTINGS, "example.com");
    expect(verdict.allowed).toBe(false);
  });
});

describe("nothing is produced that the user cannot reach", () => {
  /*
   * The bug this guards against: an action that creates something real — an .ics
   * file, a draft, clipboard text — and reports success, while the panel has no way
   * to hand it over. Four of these shipped before anyone tried to collect the
   * output. A step that produces an artefact must expose a handle for it.
   */
  const PRODUCES_SOMETHING = ["create_reminder", "export_calendar_event", "save_to_memory", "create_task", "draft_reply", "copy_details"];

  it("every completed step that produces an artefact exposes a handle for it", async () => {
    const { input } = inputFor(emailWithDeadline);
    for (const actionId of PRODUCES_SOMETHING) {
      const action = registry.get(actionId)!;
      if (!action.applies(input)) continue;
      const outcome = await executor.run(actionId, input);
      if (outcome.status !== "done") continue;
      expect(outcome.handle, `${actionId} completed but handed back nothing to collect`).toBeTruthy();
    }
  });

  it("copy_details hands back the text itself, because the worker cannot reach a clipboard", async () => {
    const { input } = inputFor(emailWithDeadline);
    const outcome = await executor.run("copy_details", input);

    expect(outcome.status).toBe("done");
    expect(outcome.handle).toContain("deadline");
    // The old version said "Copied ... to the clipboard" from a service worker,
    // which has no document and therefore no clipboard. It never happened.
    expect(outcome.message).not.toMatch(/copied/i);
    expect(outcome.message).toMatch(/ready to copy/i);
  });

  it("a calendar export hands back a file that can actually be downloaded", async () => {
    const { input } = inputFor(emailWithDeadline);
    const outcome = await executor.run("export_calendar_event", input);
    const file = await ports.calendar.get(outcome.handle!);
    expect(file?.ics).toContain("BEGIN:VEVENT");
  });

  it("marks a step undoable only when it really can be undone", async () => {
    const { input } = inputFor(emailWithDeadline);
    for (const action of registry.values()) {
      if (action.risk === "blocked" || !action.applies(input)) continue;
      const outcome = await executor.run(action.id, input, { approved: [action.id] });
      if (outcome.status !== "done") continue;
      expect(Boolean(outcome.undoHandle), `${action.id} undo wiring disagrees with canUndo`).toBe(action.canUndo);
    }
  });
});

describe("the draft it writes", () => {
  it("reads as English and never splices the request back in", async () => {
    const { input } = inputFor(emailWithDeadline);
    const outcome = await executor.run("draft_reply", input);
    const draft = [...ports.drafts.store.values()][0]!;

    expect(outcome.status).toBe("done");
    // The request is phrased from the sender's side ("send ME the proposal"), so
    // pasting it into a reply produces nonsense. It must not appear.
    expect(draft.body).not.toMatch(/send me/i);
    expect(draft.body).not.toMatch(/someone asked you/i);
    expect(draft.body).not.toMatch(/ — on /);

    expect(draft.body).toMatch(/^Hi /);
    expect(draft.body).toMatch(/Best,$/);
    expect(draft.body).toMatch(/I'll get this over to you by/);
  });

  it("does not promise a date when none was found", async () => {
    const { input } = inputFor(longEmailThread);
    await executor.run("draft_reply", { ...input, entities: input.entities.filter((e) => e.type !== "deadline") });
    const draft = [...ports.drafts.store.values()][0]!;
    expect(draft.body).toMatch(/come back to you on this shortly/);
  });
});
