/**
 * Ports: the seam between the pure engines and the browser.
 *
 * Everything in core/ talks to the outside world only through these interfaces.
 * The service worker supplies real implementations backed by chrome.alarms and
 * chrome.storage; the tests supply in-memory fakes. That is what lets the entire
 * action and safety layer be tested in Node with no browser and no mocking library.
 */

import type { ActivityEvent, MemoryItem, Reminder } from "./types";

export interface ReminderPort {
  create(input: { title: string; dueAt: number; url?: string }): Promise<string>;
  get(id: string): Promise<Reminder | undefined>;
  remove(id: string): Promise<void>;
  all(): Promise<Reminder[]>;
}

export interface MemoryPort {
  save(item: Omit<MemoryItem, "id" | "savedAt">): Promise<string>;
  get(id: string): Promise<MemoryItem | undefined>;
  remove(id: string): Promise<void>;
  all(): Promise<MemoryItem[]>;
}

export interface Draft {
  readonly id: string;
  readonly subject: string;
  readonly body: string;
  readonly createdAt: number;
}

export interface DraftPort {
  save(input: { subject: string; body: string }): Promise<string>;
  get(id: string): Promise<Draft | undefined>;
  remove(id: string): Promise<void>;
  all(): Promise<Draft[]>;
}

export interface CalendarFile {
  readonly id: string;
  readonly filename: string;
  readonly ics: string;
}

/**
 * Calendar export prepares a file and hands it to the user. It never talks to a
 * calendar service, which is why the product needs no Google Calendar API and
 * cannot incur a cost.
 */
export interface CalendarPort {
  prepare(input: { title: string; startAt: number; durationMinutes: number; url?: string; notes?: string }): Promise<string>;
  get(id: string): Promise<CalendarFile | undefined>;
  remove(id: string): Promise<void>;
  all(): Promise<CalendarFile[]>;
}

export interface ActivityPort {
  record(event: Omit<ActivityEvent, "id" | "at">): Promise<void>;
  recent(limit: number): Promise<ActivityEvent[]>;
}

export interface ClipboardPort {
  write(text: string): Promise<void>;
  /** What was last written, so verification can confirm rather than assume. */
  lastWritten(): Promise<string | undefined>;
}

export interface Ports {
  readonly reminders: ReminderPort;
  readonly memory: MemoryPort;
  readonly drafts: DraftPort;
  readonly calendar: CalendarPort;
  readonly activity: ActivityPort;
  readonly clipboard: ClipboardPort;
  /** Injected so every engine is deterministic under test. */
  readonly now: () => number;
}
