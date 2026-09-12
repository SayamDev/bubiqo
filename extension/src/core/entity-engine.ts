/**
 * Entity extraction: turning page text into the structured facts everything
 * downstream reasons about.
 *
 * Deterministic by design. A regex that finds "£2,400.00" is more reliable than a
 * small language model asked the same question, needs no download, runs in under a
 * millisecond, and can be unit-tested exhaustively. The optional local model exists
 * to handle nuance these rules cannot reach, never to replace them.
 */

import type { Entity, EntityType, PageContext, Sensitivity } from "./types";
import { resolveDates } from "./dates";

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  "£": "GBP", "$": "USD", "€": "EUR", "¥": "JPY", "₹": "INR",
};

const CURRENCY_CODES = ["GBP", "USD", "EUR", "JPY", "INR", "CHF", "CAD", "AUD", "SEK", "NOK", "DKK", "PLN"];

/** Words that precede an amount that is a salary rather than a bill. */
const SALARY_HINTS = /\b(?:salary|per annum|p\.?a\.?|pro rata|per year|annum|OTE|package)\b/i;

function entity(
  type: EntityType,
  value: string,
  confidence: number,
  source: string,
  sensitivity: Sensitivity = "public",
  resolvedAt?: number,
): Entity {
  return resolvedAt === undefined
    ? { type, value, confidence, source: source.trim().slice(0, 200), sensitivity }
    : { type, value, confidence, source: source.trim().slice(0, 200), sensitivity, resolvedAt };
}

/** A short window of text around a match, used as the "why?" evidence. */
function windowAround(text: string, index: number, length: number, pad = 60): string {
  return text.slice(Math.max(0, index - pad), Math.min(text.length, index + length + pad)).replace(/\s+/g, " ");
}

export function extractEntities(page: PageContext, now: number): Entity[] {
  const text = page.text;
  const found: Entity[] = [];

  found.push(...extractEmails(text));
  found.push(...extractPhones(text));
  found.push(...extractAmounts(text));
  found.push(...extractReferences(text));
  found.push(...extractDates(text, now));
  found.push(...extractPeople(text));
  found.push(...extractOrganisations(page));
  found.push(...extractJobTitle(page));

  return dedupe(found);
}

function extractEmails(text: string): Entity[] {
  const out: Entity[] = [];
  for (const m of text.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) {
    out.push(entity("email", m[0], 0.98, windowAround(text, m.index ?? 0, m[0].length), "personal"));
  }
  return out;
}

function extractPhones(text: string): Entity[] {
  const out: Entity[] = [];
  // UK and international shapes; deliberately narrow to avoid eating reference numbers.
  for (const m of text.matchAll(/(?:\+\d{1,3}[\s-]?)?(?:\(?0\d{2,4}\)?[\s-]?)\d{3,4}[\s-]?\d{3,4}\b/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) continue;
    out.push(entity("phone", m[0].trim(), 0.8, windowAround(text, m.index ?? 0, m[0].length), "personal"));
  }
  return out;
}

function extractAmounts(text: string): Entity[] {
  const out: Entity[] = [];

  // Symbol first: £2,400.00
  for (const m of text.matchAll(/([£$€¥₹])\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/g)) {
    const code = CURRENCY_SYMBOLS[m[1] ?? ""] ?? "";
    const numeric = (m[2] ?? "").replace(/,/g, "");
    const context = windowAround(text, m.index ?? 0, m[0].length);
    const isSalary = SALARY_HINTS.test(context);
    out.push(entity("amount", `${code} ${numeric}`, isSalary ? 0.85 : 0.95, context));
    out.push(entity("currency", code, 0.95, context));
  }

  // Code first or last: EUR 2400 / 2400 EUR
  const codeAlt = CURRENCY_CODES.join("|");
  for (const m of text.matchAll(new RegExp(`\\b(${codeAlt})\\s?(\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?)\\b`, "g"))) {
    const numeric = (m[2] ?? "").replace(/,/g, "");
    out.push(entity("amount", `${m[1]} ${numeric}`, 0.9, windowAround(text, m.index ?? 0, m[0].length)));
    out.push(entity("currency", m[1] ?? "", 0.9, windowAround(text, m.index ?? 0, m[0].length)));
  }
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?)\\s?(${codeAlt})\\b`, "g"))) {
    const numeric = (m[1] ?? "").replace(/,/g, "");
    out.push(entity("amount", `${m[2]} ${numeric}`, 0.9, windowAround(text, m.index ?? 0, m[0].length)));
    out.push(entity("currency", m[2] ?? "", 0.9, windowAround(text, m.index ?? 0, m[0].length)));
  }

  return out;
}

function extractReferences(text: string): Entity[] {
  const out: Entity[] = [];
  // "Invoice number: INV-2026-0042", "Booking reference ABC123", "Ref: 55912"
  for (const m of text.matchAll(
    /\b(?:invoice|booking|reference|order|confirmation|policy|account|ticket)\s*(?:no\.?|number|ref\.?|reference|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-/]{3,19})\b/gi,
  )) {
    const value = (m[1] ?? "").toUpperCase();
    // A bare year is not a reference number.
    if (/^\d{4}$/.test(value)) continue;
    out.push(entity("reference", value, 0.85, windowAround(text, m.index ?? 0, m[0].length)));
  }
  return out;
}

function extractDates(text: string, now: number): Entity[] {
  const out: Entity[] = [];
  /*
   * A date is a plain date. It is a DEADLINE only when the surrounding words make it
   * an obligation: "by Friday", "due 12 March", "closes on the 3rd". This distinction
   * drives the Problem Radar, so it is kept narrow on purpose.
   */
  const DEADLINE_CUES =
    /\b(?:by|before|due|deadline|closes?|closing|expires?|no later than|submit(?:ted)? by|respond by|reply by|needs? to be|must be)\b/i;

  for (const resolved of resolveDates(text, now)) {
    const at = text.indexOf(resolved.source);
    const context = at >= 0 ? windowAround(text, at, resolved.source.length, 70) : resolved.source;
    /*
     * The cue must come immediately BEFORE the date. Searching the surrounding
     * window instead reads "send it by Friday, the board meets Monday" as TWO
     * deadlines, and reads an invoice's issue date as its due date, because the
     * words "due date" happen to sit nearby. Both were real bugs; see
     * tests/analysis.test.ts.
     */
    const before = at >= 0 ? text.slice(Math.max(0, at - 28), at) : "";
    const isDeadline = DEADLINE_CUES.test(before);

    out.push(
      entity(
        isDeadline ? "deadline" : resolved.hasTime ? "time" : "date",
        new Date(resolved.at).toISOString(),
        resolved.confidence,
        context,
        "public",
        resolved.at,
      ),
    );
  }
  return out;
}

function extractPeople(text: string): Entity[] {
  const out: Entity[] = [];
  // Salutations and sign-offs are the only reliable name signal in free text.
  for (const m of text.matchAll(/\b(?:Hi|Hello|Dear|Hey)\s+([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?)\b/g)) {
    out.push(entity("person", m[1] ?? "", 0.8, windowAround(text, m.index ?? 0, m[0].length), "personal"));
  }
  for (const m of text.matchAll(
    /\b(?:Thanks|Regards|Best|Best regards|Kind regards|Cheers|Sincerely)[,!]?\s*\n+\s*([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?)\b/g,
  )) {
    out.push(entity("person", m[1] ?? "", 0.75, windowAround(text, m.index ?? 0, m[0].length), "personal"));
  }
  return out;
}

function extractOrganisations(page: PageContext): Entity[] {
  const out: Entity[] = [];
  for (const m of page.text.matchAll(
    /\b([A-Z][A-Za-z&.'-]{1,24}(?:\s+[A-Z][A-Za-z&.'-]{1,24}){0,3})\s+(Ltd|Limited|LLC|Inc\.?|PLC|GmbH|Pty|LLP|AB|SA|BV)\b/g,
  )) {
    out.push(entity("organisation", `${m[1]} ${m[2]}`, 0.85, windowAround(page.text, m.index ?? 0, m[0].length)));
  }

  // Structured data is the most reliable source when a page provides it.
  for (const block of page.structuredData) {
    const org = readPath(block, ["hiringOrganization", "name"]) ?? readPath(block, ["provider", "name"]);
    if (typeof org === "string" && org.length > 1) {
      out.push(entity("organisation", org, 0.95, "structured data on the page"));
    }
  }
  return out;
}

function extractJobTitle(page: PageContext): Entity[] {
  const out: Entity[] = [];
  for (const block of page.structuredData) {
    if (block["@type"] === "JobPosting" && typeof block["title"] === "string") {
      out.push(entity("job_title", block["title"], 0.95, "structured data on the page"));
    }
  }
  if (out.length === 0) {
    const heading = page.headings[0];
    if (
      heading &&
      /\b(engineer|developer|designer|manager|analyst|scientist|architect|lead|director|consultant|specialist)\b/i.test(
        heading,
      )
    ) {
      out.push(entity("job_title", heading.trim(), 0.7, heading));
    }
  }
  return out;
}

function readPath(obj: Record<string, unknown>, path: readonly string[]): unknown {
  let cursor: unknown = obj;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/** Same type and value twice is one Entity; the more confident one survives. */
function dedupe(entities: readonly Entity[]): Entity[] {
  const best = new Map<string, Entity>();
  for (const e of entities) {
    const key = `${e.type}::${e.value.toLowerCase()}`;
    const existing = best.get(key);
    if (!existing || e.confidence > existing.confidence) best.set(key, e);
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence);
}

export function entitiesOfType(entities: readonly Entity[], type: EntityType): Entity[] {
  return entities.filter((e) => e.type === type);
}

export function firstOfType(entities: readonly Entity[], type: EntityType): Entity | undefined {
  return entities.find((e) => e.type === type);
}
