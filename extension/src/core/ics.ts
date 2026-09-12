/**
 * iCalendar (RFC 5545) generation.
 *
 * Calendar support is a file, not an API. Every calendar application on every
 * platform imports .ics, so this replaces a Google Calendar integration entirely:
 * no OAuth, no quota, no consent screen, and nothing that can ever be billed.
 */

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** RFC 5545 UTC timestamp: 20260313T090000Z */
export function toIcsTimestamp(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** Escape per RFC 5545 §3.3.11. Order matters: backslash first. */
function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** RFC 5545 §3.1: lines are folded at 75 octets, continuations start with a space. */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) {
    parts.push(` ${rest.slice(0, 74)}`);
    rest = rest.slice(74);
  }
  if (rest.length > 0) parts.push(` ${rest}`);
  return parts.join("\r\n");
}

export interface IcsEvent {
  readonly uid: string;
  readonly title: string;
  readonly startAt: number;
  readonly durationMinutes: number;
  readonly url?: string;
  readonly notes?: string;
  readonly createdAt: number;
}

export function buildIcs(event: IcsEvent): string {
  const end = event.startAt + event.durationMinutes * 60_000;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Bubiqo//Action Layer//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${toIcsTimestamp(event.createdAt)}`,
    `DTSTART:${toIcsTimestamp(event.startAt)}`,
    `DTEND:${toIcsTimestamp(end)}`,
    `SUMMARY:${escapeText(event.title)}`,
  ];
  if (event.url) lines.push(`URL:${escapeText(event.url)}`);
  if (event.notes) lines.push(`DESCRIPTION:${escapeText(event.notes)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");

  // RFC 5545 requires CRLF line endings.
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** Safe filename for the exported event. */
export function icsFilename(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "event";
  return `${slug}.ics`;
}
