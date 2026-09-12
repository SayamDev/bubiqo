/**
 * In-memory Ports.
 *
 * Because core/ only ever talks to the browser through Ports, the whole action and
 * safety layer runs in Node against these. No jsdom, no chrome mock, no stubbing
 * library — the seam does the work.
 */

import type {
  ActivityPort, CalendarPort, ClipboardPort, Draft, DraftPort, MemoryPort, Ports, ReminderPort,
  CalendarFile,
} from "@core/ports";
import type { ActivityEvent, MemoryItem, Reminder } from "@core/types";
import { buildIcs, icsFilename } from "@core/ics";

let counter = 0;
const nextId = (prefix: string) => `${prefix}_${++counter}`;

export function resetIds(): void {
  counter = 0;
}

export class FakeReminders implements ReminderPort {
  readonly store = new Map<string, Reminder>();
  async create(input: { title: string; dueAt: number; url?: string }): Promise<string> {
    const id = nextId("rem");
    this.store.set(id, { id, title: input.title, dueAt: input.dueAt, createdAt: 0, fired: false, ...(input.url ? { url: input.url } : {}) });
    return id;
  }
  async get(id: string) { return this.store.get(id); }
  async remove(id: string) { this.store.delete(id); }
  async all() { return [...this.store.values()]; }
}

export class FakeMemory implements MemoryPort {
  readonly store = new Map<string, MemoryItem>();
  async save(item: Omit<MemoryItem, "id" | "savedAt">): Promise<string> {
    const id = nextId("mem");
    this.store.set(id, { ...item, id, savedAt: 0 });
    return id;
  }
  async get(id: string) { return this.store.get(id); }
  async remove(id: string) { this.store.delete(id); }
  async all() { return [...this.store.values()]; }
}

export class FakeDrafts implements DraftPort {
  readonly store = new Map<string, Draft>();
  async save(input: { subject: string; body: string }): Promise<string> {
    const id = nextId("draft");
    this.store.set(id, { id, subject: input.subject, body: input.body, createdAt: 0 });
    return id;
  }
  async get(id: string) { return this.store.get(id); }
  async remove(id: string) { this.store.delete(id); }
  async all() { return [...this.store.values()]; }
}

export class FakeCalendar implements CalendarPort {
  readonly store = new Map<string, CalendarFile>();
  async prepare(input: { title: string; startAt: number; durationMinutes: number; url?: string; notes?: string }): Promise<string> {
    const id = nextId("cal");
    const ics = buildIcs({
      uid: `${id}@bubiqo.local`,
      title: input.title,
      startAt: input.startAt,
      durationMinutes: input.durationMinutes,
      createdAt: 0,
      ...(input.url ? { url: input.url } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    });
    this.store.set(id, { id, filename: icsFilename(input.title), ics });
    return id;
  }
  async get(id: string) { return this.store.get(id); }
  async remove(id: string) { this.store.delete(id); }
  async all() { return [...this.store.values()]; }
}

export class FakeActivity implements ActivityPort {
  readonly events: ActivityEvent[] = [];
  async record(event: Omit<ActivityEvent, "id" | "at">) {
    this.events.push({ ...event, id: nextId("act"), at: 0 });
  }
  async recent(limit: number) { return this.events.slice(-limit); }
  kinds(): string[] { return this.events.map((e) => e.kind); }
}

export class FakeClipboard implements ClipboardPort {
  private last: string | undefined;
  async write(text: string) { this.last = text; }
  async lastWritten() { return this.last; }
}

export interface TestPorts extends Ports {
  readonly reminders: FakeReminders;
  readonly memory: FakeMemory;
  readonly drafts: FakeDrafts;
  readonly calendar: FakeCalendar;
  readonly activity: FakeActivity;
  readonly clipboard: FakeClipboard;
}

export function makePorts(now: number): TestPorts {
  resetIds();
  return {
    reminders: new FakeReminders(),
    memory: new FakeMemory(),
    drafts: new FakeDrafts(),
    calendar: new FakeCalendar(),
    activity: new FakeActivity(),
    clipboard: new FakeClipboard(),
    now: () => now,
  };
}
