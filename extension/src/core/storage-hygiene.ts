/**
 * What is safe and sensible to persist.
 *
 * Everything here is pure so it can be tested, and it runs before anything
 * reaches chrome.storage. Three jobs:
 *
 *   1. Keep identifying detail out of stored titles. A webmail page title is
 *      "Subject - your.name@gmail.com - Gmail", so saving it verbatim wrote the
 *      user's own email address into every reminder they ever made. PRIVACY.md
 *      says entities only and nothing identifying; this makes that true.
 *   2. Keep stored values bounded. A tracking link can be 700+ characters, and
 *      chrome.storage.local is a 10 MB budget for the whole extension.
 *   3. Give records a fingerprint, so saving the same thing twice updates one
 *      record instead of growing a pile of identical ones.
 */

import type { Entity, MemoryItem } from "./types";

/** Longest single stored string. Generous for a title, mean for a tracking URL. */
export const MAX_VALUE_LENGTH = 320;

/** Webmail and document clients that append their own name to the title. */
const CLIENT_SUFFIX =
  /\s[-–|]\s(?:Gmail|Outlook|Mail|Proton\s?Mail|Yahoo\s?Mail|Fastmail|Google\s+Docs|Google\s+Drive)\s*$/i;

const EMAIL_ANYWHERE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * A title fit to store: no address, no client branding, no runaway length.
 *
 * Falls back to the domain rather than returning an empty string, so a record is
 * never nameless in the list.
 */
export function cleanTitle(rawTitle: string, domain: string): string {
  let title = rawTitle.replace(/\s+/g, " ").trim();

  title = title.replace(CLIENT_SUFFIX, "").replace(SITE_SUFFIX, "");
  // "Subject - someone@example.com" -> "Subject"
  title = title.replace(EMAIL_ANYWHERE, "").replace(/\s[-–|]\s*$/, "").replace(/\s{2,}/g, " ").trim();
  title = title.replace(/^[-–|\s]+|[-–|\s]+$/g, "").trim();

  if (title.length === 0) return domain || "Saved page";
  return title.length > 120 ? `${title.slice(0, 119).trimEnd()}…` : title;
}

/** Site names appended to a tab title by the site itself. */
const SITE_SUFFIX = /\s[-–|]\s(?:LinkedIn|Indeed|Glassdoor|Reed\.co\.uk|Totaljobs|Monster|Otta|Welcome to the Jungle)\s*$/i;

/**
 * The best title for this page.
 *
 * On a single-page app the tab title lags behind what is on screen — LinkedIn was
 * showing a "Javascript Developer" advert while `document.title` still read
 * "Frontend Developer | G.Digital | LinkedIn", the job viewed before it. Saving
 * that would file the advert under the wrong name entirely.
 *
 * The page's own first heading is rendered from what the user is actually looking
 * at, so it wins whenever the tab title carries a site's name.
 */
export function preferredTitle(page: {
  title: string;
  domain: string;
  headings: readonly string[];
}): string {
  const heading = page.headings[0]?.trim();
  const templated = SITE_SUFFIX.test(page.title);

  if (heading && heading.length > 2 && (templated || heading.length > page.title.length)) {
    return cleanTitle(heading, page.domain);
  }
  return cleanTitle(page.title, page.domain);
}

/** A URL short enough to read, for display. Never used to navigate. */
export function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 24 ? `${parsed.pathname.slice(0, 24)}…` : parsed.pathname;
    return `${parsed.hostname}${path === "/" ? "" : path}`;
  } catch {
    return url.length > 60 ? `${url.slice(0, 60)}…` : url;
  }
}

/**
 * Trim an entity down to something worth keeping.
 *
 * The `source` snippet exists to explain a live suggestion; once an item is in
 * Memory the explanation has served its purpose, so it is dropped rather than
 * persisted. That is both smaller and less page text on disk.
 */
export function trimForStorage(entity: Entity): Entity {
  const value =
    entity.value.length > MAX_VALUE_LENGTH ? `${entity.value.slice(0, MAX_VALUE_LENGTH - 1)}…` : entity.value;

  return {
    type: entity.type,
    value,
    confidence: entity.confidence,
    source: "",
    sensitivity: entity.sensitivity,
    ...(entity.resolvedAt === undefined ? {} : { resolvedAt: entity.resolvedAt }),
  };
}

/**
 * What makes two saved items "the same thing".
 *
 * Pressing Do it twice on one page should not leave two identical records. The
 * page and the kind identify it; the title is included so two different items
 * saved from one page stay distinct.
 */
export function memoryFingerprint(item: Pick<MemoryItem, "kind" | "title" | "url">): string {
  return `${item.kind}::${(item.url ?? "").split("?")[0]}::${item.title.toLowerCase()}`;
}

/** Same idea for reminders: one per thing, at one time. */
export function reminderFingerprint(input: { title: string; dueAt: number }): string {
  // To the minute: two clicks a second apart mean one reminder, not two.
  return `${input.title.toLowerCase()}::${Math.floor(input.dueAt / 60_000)}`;
}
