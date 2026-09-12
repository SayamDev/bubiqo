/**
 * The Action Registry: the closed set of things Bubiqo can do.
 *
 * Every entry declares its Risk, whether it can be undone, and how to verify it.
 * Verification is not optional decoration — an Action reports success only when its
 * verify() confirms the result actually exists, so "Done" always means done.
 *
 * The registry is built from Ports, so the same definitions run against the real
 * browser in the extension and against in-memory fakes in the tests.
 */

import type { ActionDefinition, ActionInput, ActionResult, Entity, VerificationResult } from "./types";
import type { Ports } from "./ports";
import { assertWellFormed } from "./safety";
import { formatDue } from "./dates";
import { preferredTitle } from "./storage-hygiene";

const ok = (message: string, handle: string | undefined, undoable: boolean): ActionResult =>
  handle === undefined ? { ok: true, message, undoable } : { ok: true, message, handle, undoable };

const failed = (message: string): ActionResult => ({ ok: false, message, undoable: false });

const confirmed = (message: string): VerificationResult => ({ outcome: "confirmed", message });
const unconfirmed = (message: string): VerificationResult => ({ outcome: "unconfirmed", message });

function first(entities: readonly Entity[], type: Entity["type"]): Entity | undefined {
  return entities.find((e) => e.type === type);
}

/** The soonest deadline on the page, or the soonest date if there is no deadline. */
function primaryDate(input: ActionInput): Entity | undefined {
  const dated = input.entities.filter((e) => e.resolvedAt !== undefined);
  const deadlines = dated.filter((e) => e.type === "deadline");
  const pool = deadlines.length > 0 ? deadlines : dated;
  return [...pool].sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0))[0];
}

function paramString(input: ActionInput, key: string, fallback: string): string {
  const value = input.params[key];
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

/**
 * The page's title, fit to store.
 *
 * Never the raw document title: a webmail tab is titled
 * "Subject - your.name@gmail.com - Gmail", so storing it verbatim wrote the
 * user's own email address into every reminder and saved item they made.
 */
function pageTitle(input: ActionInput): string {
  return preferredTitle(input.page);
}

export function buildRegistry(ports: Ports): Map<string, ActionDefinition> {
  const definitions: ActionDefinition[] = [
    // -----------------------------------------------------------------------
    // create_reminder — the workhorse
    // -----------------------------------------------------------------------
    {
      id: "create_reminder",
      name: "Create reminder",
      category: "reminder",
      risk: "safe",
      permissions: ["alarms", "storage"],
      canUndo: true,
      applies: (input) => primaryDate(input) !== undefined,
      execute: async (input) => {
        const date = primaryDate(input);
        if (!date?.resolvedAt) return failed("No date was found on this page to remind you about.");

        const problem = input.problems.find((p) => p.dueAt === date.resolvedAt);
        const title = paramString(input, "title", problem?.summary ?? `Follow up: ${pageTitle(input)}`);

        // Remind the morning before a dated deadline, not at the moment it expires.
        const dayBefore = date.resolvedAt - 86_400_000;
        const dueAt = dayBefore > ports.now() ? dayBefore : date.resolvedAt;

        const id = await ports.reminders.create({ title, dueAt, url: input.page.url });
        return ok(`Reminder set for ${formatDue(dueAt, ports.now())}.`, id, true);
      },
      verify: async (result) => {
        if (!result.handle) return unconfirmed("The reminder was not given an id, so it could not be checked.");
        const stored = await ports.reminders.get(result.handle);
        return stored
          ? confirmed(`Reminder "${stored.title}" is stored and scheduled.`)
          : unconfirmed("We could not confirm the reminder was stored.");
      },
      undo: async (result) => {
        if (!result.handle) return failed("Nothing to undo.");
        await ports.reminders.remove(result.handle);
        return ok("Reminder removed.", undefined, false);
      },
    },

    // -----------------------------------------------------------------------
    // export_calendar_event — a file, never an API
    // -----------------------------------------------------------------------
    {
      id: "export_calendar_event",
      name: "Add to calendar",
      category: "calendar",
      risk: "safe",
      permissions: ["storage"],
      canUndo: true,
      applies: (input) => primaryDate(input) !== undefined,
      execute: async (input) => {
        const date = primaryDate(input);
        if (!date?.resolvedAt) return failed("No date was found on this page to put in a calendar.");

        const title = paramString(input, "title", pageTitle(input));
        const id = await ports.calendar.prepare({
          title,
          startAt: date.resolvedAt,
          durationMinutes: 30,
          url: input.page.url,
          notes: date.source,
        });
        return ok(`Calendar file ready for ${formatDue(date.resolvedAt, ports.now())}.`, id, true);
      },
      verify: async (result) => {
        if (!result.handle) return unconfirmed("No calendar file id was returned.");
        const file = await ports.calendar.get(result.handle);
        if (!file) return unconfirmed("We could not confirm the calendar file was created.");
        return file.ics.includes("BEGIN:VEVENT")
          ? confirmed(`Calendar file "${file.filename}" is ready to download.`)
          : unconfirmed("The calendar file was created but looks malformed.");
      },
      undo: async (result) => {
        if (!result.handle) return failed("Nothing to undo.");
        await ports.calendar.remove(result.handle);
        return ok("Calendar file discarded.", undefined, false);
      },
    },

    // -----------------------------------------------------------------------
    // save_to_memory
    // -----------------------------------------------------------------------
    {
      id: "save_to_memory",
      name: "Save details",
      category: "memory",
      risk: "safe",
      permissions: ["storage"],
      canUndo: true,
      applies: (input) => input.entities.length > 0,
      execute: async (input) => {
        const kind =
          input.page.url && input.params["kind"] === "job"
            ? "job"
            : input.params["kind"] === "invoice"
              ? "invoice"
              : input.params["kind"] === "trip"
                ? "trip"
                : "note";

        /*
         * Only extracted entities are saved, never raw page text. This is the
         * data-minimisation promise in PRIVACY.md expressed as code.
         */
        const id = await ports.memory.save({
          kind,
          title: paramString(input, "title", pageTitle(input)),
          entities: input.entities.filter((e) => e.sensitivity !== "sensitive"),
          url: input.page.url,
        });
        return ok(`Saved ${input.entities.length} details to Memory.`, id, true);
      },
      verify: async (result) => {
        if (!result.handle) return unconfirmed("No memory id was returned.");
        const item = await ports.memory.get(result.handle);
        return item
          ? confirmed(`"${item.title}" is in Memory with ${item.entities.length} details.`)
          : unconfirmed("We could not confirm the details were saved.");
      },
      undo: async (result) => {
        if (!result.handle) return failed("Nothing to undo.");
        await ports.memory.remove(result.handle);
        return ok("Removed from Memory.", undefined, false);
      },
    },

    // -----------------------------------------------------------------------
    // create_task
    // -----------------------------------------------------------------------
    {
      id: "create_task",
      name: "Create task",
      category: "memory",
      risk: "safe",
      permissions: ["storage"],
      canUndo: true,
      applies: (input) => input.problems.some((p) => p.kind === "commitment" || p.kind === "unanswered_question"),
      execute: async (input) => {
        const problem = input.problems.find((p) => p.kind === "commitment" || p.kind === "unanswered_question");
        const title = paramString(input, "title", problem?.summary ?? `Task from ${pageTitle(input)}`);
        const id = await ports.memory.save({
          kind: "task",
          title,
          entities: [],
          url: input.page.url,
          notes: problem?.evidence,
        });
        return ok(`Task created: ${title}`, id, true);
      },
      verify: async (result) => {
        if (!result.handle) return unconfirmed("No task id was returned.");
        const item = await ports.memory.get(result.handle);
        return item ? confirmed(`Task "${item.title}" is saved.`) : unconfirmed("We could not confirm the task was saved.");
      },
      undo: async (result) => {
        if (!result.handle) return failed("Nothing to undo.");
        await ports.memory.remove(result.handle);
        return ok("Task removed.", undefined, false);
      },
    },

    // -----------------------------------------------------------------------
    // draft_reply — prepares text, never sends
    // -----------------------------------------------------------------------
    {
      id: "draft_reply",
      name: "Draft a reply",
      category: "draft",
      risk: "safe",
      permissions: ["storage"],
      canUndo: true,
      applies: (input) =>
        input.problems.some((p) => p.kind === "unanswered_question" || p.kind === "pending_response"),
      execute: async (input) => {
        const person = first(input.entities, "person")?.value;
        const deadline = input.entities.find((e) => e.type === "deadline");

        /*
         * Deliberately does NOT splice the detected request into the reply.
         *
         * A request is phrased from the SENDER's side — "can you send me the
         * proposal" — so pasting it into a reply produces "Thanks for the note, on
         * send me the proposal", which is both ungrammatical and backwards. Writing
         * the other half of that sentence correctly means understanding the
         * request, not pattern-matching it, and getting it wrong in something the
         * user might send is worse than leaving a blank line for them to fill.
         *
         * So: a correct, short opening that commits to the detected deadline, and
         * nothing invented.
         */
        const body = [
          person ? `Hi ${person},` : "Hi,",
          "",
          "Thanks for the note.",
          "",
          deadline?.resolvedAt
            ? `I'll get this over to you by ${formatDue(deadline.resolvedAt, ports.now())}.`
            : "I'll come back to you on this shortly.",
          "",
          "Best,",
        ].join("\n");

        const id = await ports.drafts.save({ subject: `Re: ${pageTitle(input)}`, body });
        return ok("Draft prepared. Nothing has been sent.", id, true);
      },
      verify: async (result) => {
        if (!result.handle) return unconfirmed("No draft id was returned.");
        const draft = await ports.drafts.get(result.handle);
        return draft
          ? confirmed("Draft is saved locally and ready for you to review.")
          : unconfirmed("We could not confirm the draft was saved.");
      },
      undo: async (result) => {
        if (!result.handle) return failed("Nothing to undo.");
        await ports.drafts.remove(result.handle);
        return ok("Draft discarded.", undefined, false);
      },
    },

    // -----------------------------------------------------------------------
    // copy_details — clipboard, deliberately not undoable
    // -----------------------------------------------------------------------
    {
      id: "copy_details",
      name: "Copy the key details",
      category: "extract",
      risk: "safe",
      permissions: [],
      canUndo: false,
      applies: (input) => input.entities.length > 0,
      /*
       * The service worker has no document, and the Clipboard API needs one. So
       * this action PREPARES the text and hands it back; the side panel, which does
       * have a document and the user's gesture, performs the actual write.
       *
       * It previously called a port that only recorded the text in the worker and
       * then reported "Copied to the clipboard" — a success message for something
       * that had not happened. Reporting an unverified success is the one thing
       * this product must never do.
       */
      execute: async (input) => {
        const lines = input.entities
          .filter((e) => e.sensitivity !== "sensitive")
          .slice(0, 12)
          .map((e) => `${e.type.replace(/_/g, " ")}: ${e.value}`);
        if (lines.length === 0) return failed("There was nothing safe to copy from this page.");

        const text = lines.join("\n");
        await ports.clipboard.write(text);
        return ok(`${lines.length} details ready to copy.`, text, false);
      },
      verify: async (result) =>
        result.handle && result.handle.length > 0
          ? confirmed("The details are ready — use Copy to put them on your clipboard.")
          : unconfirmed("There was nothing to copy."),
    },

    // -----------------------------------------------------------------------
    // open_application_link — leaves the machine, so it needs approval
    // -----------------------------------------------------------------------
    {
      id: "open_application_link",
      name: "Open the application page",
      category: "navigation",
      risk: "confirm",
      permissions: [],
      canUndo: false,
      applies: (input) => input.entities.some((e) => e.type === "url"),
      execute: async (input) => {
        const url = paramString(input, "url", first(input.entities, "url")?.value ?? "");
        if (!/^https:\/\//.test(url)) return failed("Refused: only https links are opened.");
        return ok(`Opening ${new URL(url).hostname}.`, url, false);
      },
      verify: async (result) => (result.ok ? confirmed("Link prepared.") : unconfirmed("Link was not prepared.")),
    },

    // -----------------------------------------------------------------------
    // pay_invoice — present so the refusal is visible, never executable
    // -----------------------------------------------------------------------
    {
      id: "pay_invoice",
      name: "Pay this invoice",
      category: "payment",
      risk: "blocked",
      permissions: [],
      canUndo: false,
      applies: () => false,
      execute: async () =>
        failed("Bubiqo never makes payments. Detecting the amount and the due date is where it stops."),
      verify: async () => unconfirmed("Blocked actions are never executed."),
    },
  ];

  const registry = new Map<string, ActionDefinition>();
  for (const definition of definitions) {
    assertWellFormed(definition);
    registry.set(definition.id, definition);
  }
  return registry;
}
