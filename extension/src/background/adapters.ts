/**
 * Chrome-backed implementations of the Ports.
 *
 * This is the only place in the product that touches chrome.storage and
 * chrome.alarms. Everything above it is pure, which is what makes the engines
 * testable and what keeps the browser's quirks contained in one file.
 */

import type {
  ActivityPort, CalendarPort, CalendarFile, ClipboardPort, Draft, DraftPort,
  MemoryPort, Ports, ReminderPort,
} from "@core/ports";
import type { ActivityEvent, MemoryItem, Reminder } from "@core/types";
import { buildIcs, icsFilename } from "@core/ics";

const KEYS = {
  reminders: "bubiqo.reminders",
  memory: "bubiqo.memory",
  drafts: "bubiqo.drafts",
  calendar: "bubiqo.calendar",
  activity: "bubiqo.activity",
  settings: "bubiqo.settings",
  usage: "bubiqo.usage",
  accepted: "bubiqo.accepted",
  dismissed: "bubiqo.dismissed",
} as const;

/** Activity is a rolling window, not an archive: old events are dropped. */
const ACTIVITY_LIMIT = 200;

export async function readCollection<T>(key: string): Promise<Record<string, T>> {
  const stored = await chrome.storage.local.get(key);
  const value = stored[key];
  return typeof value === "object" && value !== null ? (value as Record<string, T>) : {};
}

async function writeCollection<T>(key: string, value: Record<string, T>): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

class ChromeReminders implements ReminderPort {
  async create(input: { title: string; dueAt: number; url?: string }): Promise<string> {
    const id = newId("rem");
    const all = await readCollection<Reminder>(KEYS.reminders);
    all[id] = {
      id, title: input.title, dueAt: input.dueAt, createdAt: Date.now(), fired: false,
      ...(input.url ? { url: input.url } : {}),
    };
    await writeCollection(KEYS.reminders, all);

    /*
     * chrome.alarms will not schedule in the past. A reminder whose moment has
     * already gone still belongs in storage — the briefing shows it as overdue —
     * so only the alarm is skipped, never the record.
     */
    if (input.dueAt > Date.now()) {
      await chrome.alarms.create(id, { when: input.dueAt });
    }
    return id;
  }

  async get(id: string): Promise<Reminder | undefined> {
    return (await readCollection<Reminder>(KEYS.reminders))[id];
  }

  async remove(id: string): Promise<void> {
    const all = await readCollection<Reminder>(KEYS.reminders);
    delete all[id];
    await writeCollection(KEYS.reminders, all);
    await chrome.alarms.clear(id);
  }

  async all(): Promise<Reminder[]> {
    return Object.values(await readCollection<Reminder>(KEYS.reminders)).sort((a, b) => a.dueAt - b.dueAt);
  }
}

class ChromeMemory implements MemoryPort {
  async save(item: Omit<MemoryItem, "id" | "savedAt">): Promise<string> {
    const id = newId("mem");
    const all = await readCollection<MemoryItem>(KEYS.memory);
    all[id] = { ...item, id, savedAt: Date.now() };
    await writeCollection(KEYS.memory, all);
    return id;
  }
  async get(id: string) { return (await readCollection<MemoryItem>(KEYS.memory))[id]; }
  async remove(id: string) {
    const all = await readCollection<MemoryItem>(KEYS.memory);
    delete all[id];
    await writeCollection(KEYS.memory, all);
  }
  async all() {
    return Object.values(await readCollection<MemoryItem>(KEYS.memory)).sort((a, b) => b.savedAt - a.savedAt);
  }
}

class ChromeDrafts implements DraftPort {
  async save(input: { subject: string; body: string }): Promise<string> {
    const id = newId("draft");
    const all = await readCollection<Draft>(KEYS.drafts);
    all[id] = { id, subject: input.subject, body: input.body, createdAt: Date.now() };
    await writeCollection(KEYS.drafts, all);
    return id;
  }
  async get(id: string) { return (await readCollection<Draft>(KEYS.drafts))[id]; }
  async remove(id: string) {
    const all = await readCollection<Draft>(KEYS.drafts);
    delete all[id];
    await writeCollection(KEYS.drafts, all);
  }
  async all() {
    return Object.values(await readCollection<Draft>(KEYS.drafts)).sort((a, b) => b.createdAt - a.createdAt);
  }
}

class ChromeCalendar implements CalendarPort {
  async prepare(input: { title: string; startAt: number; durationMinutes: number; url?: string; notes?: string }): Promise<string> {
    const id = newId("cal");
    const ics = buildIcs({
      uid: `${id}@bubiqo.local`,
      title: input.title,
      startAt: input.startAt,
      durationMinutes: input.durationMinutes,
      createdAt: Date.now(),
      ...(input.url ? { url: input.url } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    });
    const all = await readCollection<CalendarFile>(KEYS.calendar);
    all[id] = { id, filename: icsFilename(input.title), ics };
    await writeCollection(KEYS.calendar, all);
    return id;
  }
  async get(id: string) { return (await readCollection<CalendarFile>(KEYS.calendar))[id]; }
  async remove(id: string) {
    const all = await readCollection<CalendarFile>(KEYS.calendar);
    delete all[id];
    await writeCollection(KEYS.calendar, all);
  }
  async all() {
    return Object.values(await readCollection<CalendarFile>(KEYS.calendar));
  }
}

class ChromeActivity implements ActivityPort {
  async record(event: Omit<ActivityEvent, "id" | "at">): Promise<void> {
    const stored = await chrome.storage.local.get(KEYS.activity);
    const list: ActivityEvent[] = Array.isArray(stored[KEYS.activity]) ? stored[KEYS.activity] : [];
    list.push({ ...event, id: newId("act"), at: Date.now() });
    await chrome.storage.local.set({ [KEYS.activity]: list.slice(-ACTIVITY_LIMIT) });
  }
  async recent(limit: number): Promise<ActivityEvent[]> {
    const stored = await chrome.storage.local.get(KEYS.activity);
    const list: ActivityEvent[] = Array.isArray(stored[KEYS.activity]) ? stored[KEYS.activity] : [];
    return list.slice(-limit).reverse();
  }
}

/**
 * Clipboard from a service worker.
 *
 * A worker has no document, so the write is performed by the side panel and this
 * port records what was handed over. verify() reports honestly that the handover
 * happened rather than claiming to have read the system clipboard back.
 */
class RecordingClipboard implements ClipboardPort {
  private last: string | undefined;
  async write(text: string): Promise<void> {
    this.last = text;
    await chrome.storage.session?.set?.({ "bubiqo.clipboard": text }).catch(() => undefined);
  }
  async lastWritten(): Promise<string | undefined> {
    return this.last;
  }
}

export const STORAGE_KEYS = KEYS;

export function createPorts(): Ports {
  return {
    reminders: new ChromeReminders(),
    memory: new ChromeMemory(),
    drafts: new ChromeDrafts(),
    calendar: new ChromeCalendar(),
    activity: new ChromeActivity(),
    clipboard: new RecordingClipboard(),
    now: () => Date.now(),
  };
}
