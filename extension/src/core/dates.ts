/**
 * Deterministic date resolution.
 *
 * Every function takes `now` explicitly. Nothing here reads the clock, so the same
 * input always produces the same output and the tests need no faked timers.
 *
 * Resolution is deliberately conservative: an expression that could mean several
 * things resolves to nothing rather than to a guess. A missed deadline is a nuisance;
 * a confidently wrong one destroys trust in every other suggestion.
 */

const WEEKDAYS: Readonly<Record<string, number>> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTHS: Readonly<Record<string, number>> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10,
  december: 11, dec: 11,
};

const DAY_MS = 86_400_000;

export interface ResolvedDate {
  /** Epoch ms, local time. */
  readonly at: number;
  /** The text this came from. */
  readonly source: string;
  readonly confidence: number;
  /** True when a clock time was given, not just a day. */
  readonly hasTime: boolean;
}

function atLocal(y: number, m: number, d: number, hh = 9, mm = 0): number {
  return new Date(y, m, d, hh, mm, 0, 0).getTime();
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Parse a clock time appearing near a date phrase: "5pm", "17:30", "9.30am". */
function parseTime(text: string): { hh: number; mm: number } | null {
  const m = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i.exec(text);
  if (m) {
    let hh = Number(m[1]);
    const mm = m[2] ? Number(m[2]) : 0;
    const meridiem = (m[3] ?? "").toLowerCase();
    if (hh > 12 || mm > 59) return null;
    if (meridiem === "pm" && hh !== 12) hh += 12;
    if (meridiem === "am" && hh === 12) hh = 0;
    return { hh, mm };
  }
  const m24 = /\b(\d{1,2}):(\d{2})\b/.exec(text);
  if (m24) {
    const hh = Number(m24[1]);
    const mm = Number(m24[2]);
    if (hh > 23 || mm > 59) return null;
    return { hh, mm };
  }
  return null;
}

/**
 * Find a clock time attached to a date phrase.
 *
 * "Friday at 5pm" puts the time after the phrase; "5pm tomorrow" puts it before.
 * Text after the phrase wins, because that is the far more common phrasing and
 * reading backwards risks stealing a time that belonged to an earlier date.
 */
function timeNear(text: string, index: number, length: number): { hh: number; mm: number } | null {
  const after = text.slice(index + length, index + length + 30);
  const before = text.slice(Math.max(0, index - 24), index);
  return parseTime(after) ?? parseTime(before);
}

/**
 * Resolve every date expression found in `text`, relative to `now`.
 *
 * Bare weekday names ("Friday") resolve forward: the next occurrence, or today if
 * today is that weekday and a time later than now was given.
 */
export function resolveDates(text: string, now: number): ResolvedDate[] {
  const out: ResolvedDate[] = [];
  const seen = new Set<number>();

  const push = (at: number, source: string, confidence: number, hasTime: boolean) => {
    // Same instant from two phrasings is one date; keep the more confident.
    if (seen.has(at)) return;
    seen.add(at);
    out.push({ at, source, confidence, hasTime });
  };

  const today = new Date(now);

  // "today", "tomorrow", "tonight"
  for (const m of text.matchAll(/\b(today|tonight|tomorrow)\b([^.!?\n]{0,30})/gi)) {
    const word = (m[1] ?? "").toLowerCase();
    const time = timeNear(text, m.index ?? 0, (m[1] ?? "").length);
    const offset = word === "tomorrow" ? 1 : 0;
    const base = new Date(startOfDay(now) + offset * DAY_MS);
    const hh = time ? time.hh : word === "tonight" ? 19 : 9;
    push(
      atLocal(base.getFullYear(), base.getMonth(), base.getDate(), hh, time?.mm ?? 0),
      m[0].trim(),
      0.9,
      time !== null,
    );
  }

  // "by Friday", "next Tuesday", "on Monday at 14:30"
  for (const m of text.matchAll(
    /\b(?:(next|this)\s+)?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thu|friday|fri|saturday|sat)\b([^.!?\n]{0,30})/gi,
  )) {
    const qualifier = (m[1] ?? "").toLowerCase();
    const dayName = (m[2] ?? "").toLowerCase();
    const target = WEEKDAYS[dayName];
    if (target === undefined) continue;
    const time = timeNear(text, m.index ?? 0, m[0].length - (m[3] ?? "").length);

    let delta = (target - today.getDay() + 7) % 7;
    // A bare weekday meaning "today" only counts if a later time was given.
    if (delta === 0 && !time) delta = 7;
    if (qualifier === "next" && delta < 7) delta += 7;

    const d = new Date(startOfDay(now) + delta * DAY_MS);
    push(
      atLocal(d.getFullYear(), d.getMonth(), d.getDate(), time?.hh ?? 9, time?.mm ?? 0),
      m[0].trim(),
      time ? 0.85 : 0.75,
      time !== null,
    );
  }

  // "12 March 2026", "12 Mar", "March 12, 2026"
  for (const m of text.matchAll(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b\.?,?\s*(\d{4})?([^.!?\n]{0,20})/gi,
  )) {
    const day = Number(m[1]);
    const month = MONTHS[(m[2] ?? "").toLowerCase()];
    if (month === undefined || day < 1 || day > 31) continue;
    const time = parseTime(m[4] ?? "");
    const year = m[3] ? Number(m[3]) : inferYear(month, day, now);
    push(atLocal(year, month, day, time?.hh ?? 9, time?.mm ?? 0), m[0].trim(), 0.9, time !== null);
  }

  for (const m of text.matchAll(
    /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?!\d),?\s*(\d{4})?([^.!?\n]{0,20})/gi,
  )) {
    const month = MONTHS[(m[1] ?? "").toLowerCase()];
    const day = Number(m[2]);
    if (month === undefined || day < 1 || day > 31) continue;
    const time = parseTime(m[4] ?? "");
    const year = m[3] ? Number(m[3]) : inferYear(month, day, now);
    push(atLocal(year, month, day, time?.hh ?? 9, time?.mm ?? 0), m[0].trim(), 0.9, time !== null);
  }

  // "in 3 days", "in two weeks"
  for (const m of text.matchAll(
    /\bin\s+(\d{1,3}|one|two|three|four|five|six|seven|ten)\s+(day|days|week|weeks|month|months)\b/gi,
  )) {
    const n = wordToNumber(m[1] ?? "");
    if (n === null) continue;
    const unit = (m[2] ?? "").toLowerCase();
    const days = unit.startsWith("week") ? n * 7 : unit.startsWith("month") ? n * 30 : n;
    const d = new Date(startOfDay(now) + days * DAY_MS);
    push(atLocal(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0), m[0].trim(), 0.8, false);
  }

  /*
   * Month and year with no day: "before June 2027", "closes March 2027".
   * Resolved to the FIRST of that month, which is the conservative reading of a
   * requirement like "completed before June 2027" — being early is never wrong.
   * Skipped when a day number precedes it, or "12 March 2026" would be counted
   * twice, once correctly and once as the 1st.
   */
  for (const m of text.matchAll(
    /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\.?\s+(\d{4})\b/gi,
  )) {
    const month = MONTHS[(m[1] ?? "").toLowerCase()];
    if (month === undefined) continue;

    const preceding = text.slice(Math.max(0, (m.index ?? 0) - 6), m.index ?? 0);
    if (/\d\s*(?:st|nd|rd|th)?\s*$/.test(preceding)) continue;

    push(atLocal(Number(m[2]), month, 1, 9, 0), m[0].trim(), 0.7, false);
  }

  // ISO 8601: 2026-03-12
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    if (mo < 0 || mo > 11 || d < 1 || d > 31) continue;
    push(atLocal(y, mo, d, 9, 0), m[0], 0.95, false);
  }

  /*
   * Ambiguous numeric dates (12/03/2026) are deliberately NOT parsed. UK and US
   * readings differ by nine months and there is no reliable signal on a web page to
   * choose between them, so a wrong deadline is likelier than a useful one.
   */

  return out.sort((a, b) => a.at - b.at);
}

function inferYear(month: number, day: number, now: number): number {
  const d = new Date(now);
  const thisYear = atLocal(d.getFullYear(), month, day);
  // A date already well past is much likelier to mean next year than this one.
  return thisYear < startOfDay(now) - 7 * DAY_MS ? d.getFullYear() + 1 : d.getFullYear();
}

function wordToNumber(word: string): number | null {
  const numeric = Number(word);
  if (Number.isFinite(numeric)) return numeric;
  const words: Readonly<Record<string, number>> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10,
  };
  return words[word.toLowerCase()] ?? null;
}

export function describeUrgency(dueAt: number, now: number): "overdue" | "today" | "soon" | "later" {
  if (dueAt < now) return "overdue";
  const days = (startOfDay(dueAt) - startOfDay(now)) / DAY_MS;
  if (days === 0) return "today";
  if (days <= 3) return "soon";
  return "later";
}

/** "Friday, 09:00" / "in 3 days" style label for the UI. */
export function formatDue(dueAt: number, now: number): string {
  const days = (startOfDay(dueAt) - startOfDay(now)) / DAY_MS;
  const time = new Date(dueAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Tomorrow, ${time}`;
  if (days === -1) return `Yesterday, ${time}`;
  if (days < 0) return `${Math.abs(days)} days ago`;
  if (days <= 6) {
    const weekday = new Date(dueAt).toLocaleDateString("en-GB", { weekday: "long" });
    return `${weekday}, ${time}`;
  }
  return new Date(dueAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
