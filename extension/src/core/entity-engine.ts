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
import { isFurnitureHeading } from "./readability";
import { preferredTitle } from "./storage-hygiene";
import { CURRENCY_CODES, NUMBER_PATTERN, SYMBOL_TO_CODE, formatAmount, formatRange, looksLikeSalary, readNumber } from "./money";


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
  found.push(...extractActionableLinks(page));

  return preferTitleAnchoredOrganisation(preferLabelledAmounts(dedupe(found), page.text));
}

/**
 * The employer beside the title wins.
 *
 * A job page carries other companies — sidebar cards, "people also viewed" — and
 * a legal suffix makes those easy to find, so an Indeed advert from Lowen Talent
 * was credited to "Activate Group Limited" four cards away. When a company was
 * found directly beside the title this page is about, it is the answer and the
 * rest are noise. When none was, everything found stays.
 */
function preferTitleAnchoredOrganisation(entities: Entity[]): Entity[] {
  const anchored = entities.find((e) => e.type === "organisation" && e.source.startsWith("beside "));
  if (!anchored) return entities;
  return entities.filter((e) => e.type !== "organisation" || e === anchored);
}



/**
 * Drop pay figures that belong to a different advert.
 *
 * A job page shows a list of other jobs beside the one being read, and each one
 * carries its own salary — a real Indeed page produced five ranges, four of them
 * from the sidebar. The DOM scoping is supposed to exclude that region and does
 * not always manage it, so this is a second line of defence at the text level.
 *
 * The signal is labelling and repetition: the advert's own pay is announced
 * ("Pay", "Salary", "Total") or stated more than once, in the header and again in
 * a details block. A number that is neither is very likely someone else's.
 *
 * Only ever subtracts when something better exists, so a page with a single
 * unlabelled amount keeps it.
 */
function preferLabelledAmounts(entities: Entity[], text: string): Entity[] {
  const amounts = entities.filter((e) => e.type === "amount");
  if (amounts.length < 2) return entities;

  const LABEL = /\b(?:pay|salary|compensation|package|total|amount due|subtotal|balance|OTE)\b/i;

  const strong = new Set<string>();
  for (const amount of amounts) {
    const labelled = LABEL.test(amount.source);
    const figure = amount.value.split(" ")[1] ?? "";
    const first = figure.split("–")[0] ?? "";
    const repeated = first.length > 2 && text.split(first).length - 1 > 1;
    if (labelled || repeated) strong.add(amount.value);
  }

  if (strong.size === 0) return entities;
  return entities.filter((e) => e.type !== "amount" || strong.has(e.value));
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
    // "(0808 501 5200" — the match can start on a bracket the number never closes.
    let phone = m[0].trim();
    if (phone.startsWith("(") && !phone.includes(")")) phone = phone.slice(1).trim();
    out.push(entity("phone", phone, 0.8, windowAround(text, m.index ?? 0, m[0].length), "personal"));
  }
  return out;
}

function extractAmounts(text: string): Entity[] {
  const out: Entity[] = [];

  /*
   * A pay range is a single fact. Read as two separate amounts it says almost
   * nothing — "GBP 45000" and "GBP 60000" sitting in a list — and on a job advert
   * the range IS the number the reader cares about.
   */
  const rangeSpans: [number, number][] = [];

  /*
   * Job boards often print pay as separate labelled fields rather than a range:
   *   Salary Min : £ 70000
   *   Salary Max : £ 85000
   * Read individually those are two unrelated numbers. Together they are the one
   * fact the reader wants.
   */
  const labelled = (label: string) =>
    new RegExp(String.raw`salary\s*${label}\s*[:-]?\s*[£$€]?\s?(${NUMBER_PATTERN}\s*k?)`, "i").exec(text);

  const minMatch = labelled("min");
  const maxMatch = labelled("max");

  if (minMatch?.[1] && maxMatch?.[1]) {
    const low = readNumber(minMatch[1]);
    const high = readNumber(maxMatch[1]);
    if (low !== undefined && high !== undefined && low > 0 && high >= low) {
      const code = /currency\s*type\s*[:-]?\s*([A-Z]{3})/i.exec(text)?.[1]?.toUpperCase() ?? "GBP";
      out.push(entity("amount", formatRange(code, low, high), 0.9, windowAround(text, minMatch.index, 60)));
      out.push(entity("currency", code, 0.9, windowAround(text, minMatch.index, 60)));
      rangeSpans.push([minMatch.index, minMatch.index + minMatch[0].length]);
      rangeSpans.push([maxMatch.index, maxMatch.index + maxMatch[0].length]);
    }
  }

  // "£100K/yr - £130K/yr", "£45k-£55k": the same range, written in thousands.
  for (const m of text.matchAll(
    /([£$€])\s?(\d{1,3}(?:\.\d)?)\s?[kK](?:\s?\/\s?(?:yr|year|annum))?\s*(?:-|–|—|to)\s*\1?\s?(\d{1,3}(?:\.\d)?)\s?[kK]/g,
  )) {
    rangeSpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    const code = SYMBOL_TO_CODE[m[1] ?? ""] ?? "";
    const low = Math.round(Number(m[2]) * 1000);
    const high = Math.round(Number(m[3]) * 1000);
    if (!(low > 0 && high >= low)) continue;
    out.push(entity("amount", formatRange(code, low, high), 0.95, windowAround(text, m.index ?? 0, m[0].length)));
    out.push(entity("currency", code, 0.95, windowAround(text, m.index ?? 0, m[0].length)));
  }

  for (const m of text.matchAll(
    /([£$€])\s?(\d{1,3}(?:,\d{3})+)\s*(?:-|–|—|to)\s*\1?\s?(\d{1,3}(?:,\d{3})+)/g,
  )) {
    rangeSpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    const code = SYMBOL_TO_CODE[m[1] ?? ""] ?? "";
    const low = readNumber(m[2] ?? "");
    const high = readNumber(m[3] ?? "");
    if (low === undefined || high === undefined) continue;
    out.push(entity("amount", formatRange(code, low, high), 0.95, windowAround(text, m.index ?? 0, m[0].length)));
    out.push(entity("currency", code, 0.95, windowAround(text, m.index ?? 0, m[0].length)));
  }

  // Symbol first: £2,400.00 — but not the two ends of a range already read above.
  /*
   * The first branch must REQUIRE its comma groups.
   *
   * As "\d{1,3}(?:,\d{3})*" it matched three digits and stopped, so an
   * unpunctuated "£ 70000" came out as GBP 700 and "£2400" as GBP 240 — wrong by
   * two orders of magnitude, on invoices as well as salaries.
   */
  /*
   * Statements write balances as "-£194.27", "£-194.27", "(£194.27)" or
   * "£194.27 DR". Dropping the sign turned a debt into what read like money
   * waiting for you, so the sign and any DR/CR marker are kept.
   */
  for (const m of text.matchAll(
    // The sign must touch the symbol: in "£100K/yr - £130K/yr" the spaced dash is
    // the range, not a minus, and reading it as one turned pay into a refund.
    /(?<![\w.])([-−(]?)([£$€¥₹])\s?([-−]?)(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:\.\d{1,2})?)(\)?)(?:\s?(DR|CR)\b)?/g,
  )) {
    // Measured from the symbol: the optional sign and space before it would
    // otherwise start the match just outside a range already read.
    const at = (m.index ?? 0) + m[0].search(/[£$€¥₹]/);
    if (rangeSpans.some(([start, end]) => at >= start && at < end)) continue;
    const code = SYMBOL_TO_CODE[m[2] ?? ""] ?? "";
    const bracketed = m[1] === "(" && m[5] === ")";
    const negative = /[-−]/.test(m[1] ?? "") || /[-−]/.test(m[3] ?? "") || bracketed;
    // "£100K" is a hundred thousand, not a hundred.
    const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 2);
    const thousands = !m[6] && /^\s?[kK](?![a-z])/.test(after);
    const base = Number((m[4] ?? "").replace(/,/g, ""));
    const numeric = `${negative ? "-" : ""}${thousands ? String(Math.round(base * 1000)) : (m[4] ?? "").replace(/,/g, "")}`;
    const marker = m[6] ? ` ${m[6]}` : "";
    const context = windowAround(text, m.index ?? 0, m[0].length);
    const isSalary = SALARY_HINTS.test(context);
    out.push(entity("amount", `${code} ${numeric}${marker}`, isSalary ? 0.85 : 0.95, context));
    out.push(entity("currency", code, 0.95, context));
  }

  /*
   * Pay written without a currency symbol at all.
   *
   * "Competitive salary of up to 85,000", "£85k", "up to 85k per annum", "paying
   * 60-70k". Job adverts very often print the number bare, and requiring a symbol
   * or an ISO code meant the salary — the single most important number on the page
   * — was invisible. The words around it are what make it safe to read: a bare
   * "85,000" anywhere is meaningless, "salary of up to 85,000" is not.
   */
  const PAY_CONTEXT = /\b(?:salary|salaries|paying|pay|package|earn|up to|circa|c\.|from|between|OTE|per annum|p\.?a\.?|annum)\b/i;

  for (const m of text.matchAll(
    /\b(?:salary|paying|pay|package|earn(?:ing)?|OTE)\b[^.\n]{0,40}?(\d{2,3}(?:,\d{3})?)\s*(k\b)?|(?:up to|circa|c\.|from)\s*[£$€]?\s?(\d{2,3}(?:,\d{3})?)\s*(k\b)?/gi,
  )) {
    const raw = m[1] ?? m[3];
    const isK = Boolean(m[2] ?? m[4]);
    if (!raw) continue;

    const context = windowAround(text, m.index ?? 0, m[0].length);
    if (!PAY_CONTEXT.test(context)) continue;

    const numeric = readNumber(isK ? `${raw}k` : raw);
    // A salary is a salary; 55 is an hour count or a percentage, not pay.
    if (numeric === undefined || !looksLikeSalary(numeric)) continue;

    out.push(entity("amount", formatAmount("GBP", numeric), 0.75, context));
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
    /*
     * Nor is a word. "booking platforms would be useful" was producing a
     * reference of PLATFORMS, because the pattern only asked for characters a
     * reference COULD contain. A reference number contains a number.
     */
    if (!/\d/.test(value)) continue;
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

  /*
   * A date can sit behind a deadline cue and still not be a deadline.
   *
   * "your degree completed before June 2027" is an ELIGIBILITY criterion — a fact
   * about whether you qualify — not something you have to do by then. Offering to
   * remind someone about it is noise, and noise is what makes people stop reading
   * the panel. When the surrounding sentence is about meeting a requirement, the
   * date stays an ordinary date.
   */
  const REQUIREMENT_CUES =
    /\b(?:you meet|essential requirement|minimum requirement|eligib\w*|qualif\w*|criteria|provided (?:that|you)|as long as|degree (?:completed|awarded)|graduat\w+ (?:before|by|in)|must have (?:completed|graduated)|requirement with)\b/i;

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

    // The sentence the date sits in, for the eligibility check.
    const sentenceStart = at >= 0 ? Math.max(0, text.lastIndexOf(".", at - 1) + 1) : 0;
    const sentence = at >= 0 ? text.slice(sentenceStart, at + resolved.source.length + 20) : "";

    const isDeadline = DEADLINE_CUES.test(before) && !REQUIREMENT_CUES.test(sentence);

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

/**
 * Could this string be a company name?
 *
 * Shared by every rule that guesses one. Written once because each rule was
 * separately producing its own nonsense: "On-site" from a byline, "Inbox" from a
 * mail client's folder list, "the" and "About" from prose.
 */
function plausibleCompanyName(candidate: string): boolean {
  const name = candidate.trim();
  if (name.length < 2 || name.length > 48) return false;
  if (!/^[A-Z]/.test(name)) return false;
  if (/[.!?,;:]$/.test(name)) return false;
  if (name.split(/\s+/).length > 5) return false;

  const NOT_A_COMPANY =
    /^(?:apply|save|share|posted|full|part|permanent|remote|hybrid|on-?site|about|what|you|the|this|we|our|your|experience|salary|pay|job|jobs|location|benefits|inbox|sent|drafts|archive|spam|starred|snoozed|important|unsubscribe|reply|forward|today|yesterday|tomorrow|leeds|london|manchester|liverpool|birmingham|bristol|glasgow|edinburgh)\b/i;

  return !NOT_A_COMPANY.test(name);
}

function extractOrganisations(page: PageContext): Entity[] {
  const out: Entity[] = [];
  for (const m of page.text.matchAll(
    // [^\S\n] keeps a company name on one line. With \s+ it ran up into the
    // heading above it and came out as "Software Developer\nActivate Group Limited".
    /\b([A-Z][A-Za-z&.'-]{1,24}(?:[^\S\n]+[A-Z][A-Za-z&.'-]{1,24}){0,3})[^\S\n]+(Ltd|Limited|LLC|Inc\.?|PLC|GmbH|Pty|LLP|AB|SA|BV)\b/g,
  )) {
    out.push(entity("organisation", `${m[1]} ${m[2]}`, 0.85, windowAround(page.text, m.index ?? 0, m[0].length)));
  }

  /*
   * Most companies are not written "Acme Ltd" in prose. "a role at Barclays" is far
   * more common, and the preposition is what makes it safe to capture — a bare
   * capitalised word would match half the sentence.
   */
  for (const m of page.text.matchAll(
    /\b(?:role|job|position|opportunity|programme|program|internship|vacancy|working)\s+(?:at|with|for)\s+([A-Z][A-Za-z&.'-]{1,24}(?:\s+[A-Z][A-Za-z&.'-]{1,24}){0,2})\b/g,
  )) {
    const name = (m[1] ?? "").trim();
    if (!plausibleCompanyName(name)) continue;
    out.push(entity("organisation", name, 0.8, windowAround(page.text, m.index ?? 0, m[0].length)));
  }

  /*
   * Job boards print the employer on its own line under the role, separated from
   * the location by a middot or a bullet: "Better Placed · Manchester Area (Hybrid)".
   * No legal suffix, no preposition — so neither of the rules above could see it,
   * and a job advert was being saved with no company at all.
   */
  for (const m of page.text.matchAll(
    // [^\S\n] is "whitespace but not a line break" — without it the name ran
    // up into the heading on the line above and came out as two joined lines.
    /^([A-Z][A-Za-z0-9&.'’-]{1,30}(?:[^\S\n]+[A-Z][A-Za-z0-9&.'’-]{1,30}){0,3})[^\S\n]*[·•][^\S\n]*[A-Z]/gm,
  )) {
    const name = (m[1] ?? "").trim();
    if (!plausibleCompanyName(name)) continue;
    out.push(entity("organisation", name, 0.8, windowAround(page.text, m.index ?? 0, m[0].length)));
  }

  /*
   * The line beside the page's OWN title.
   *
   * Job boards print the employer directly above or below the job title, on its
   * own line, with no legal suffix and no preposition — LinkedIn above ("Better
   * Placed" then "Javascript Developer"), Indeed below ("Graduate Associate
   * Consultant" then "Lowen Talent").
   *
   * Anchored to the title this page is actually about, not to any line that
   * mentions a role. An earlier version scanned for role-like lines and picked up
   * "IPSUM" and "On-site" from sidebar cards and body prose — confidently wrong,
   * which is worse than finding nothing.
   */
  const title = preferredTitle(page);
  if (title.length > 3) {
    const lines = page.text.split("\n");
    const titleLine = lines.findIndex((line) => line.trim().startsWith(title));

    if (titleLine >= 0) {
      for (const neighbour of [lines[titleLine - 1], lines[titleLine + 1]]) {
        const name = (neighbour ?? "").trim();
        if (!plausibleCompanyName(name)) continue;
        // Marked so it can outrank a company found elsewhere on the page.
        out.push(entity("organisation", name, 0.95, `beside "${title}"`));
      }
    }
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
  /*
   * A job advert often arrives inside an email rather than on a careers page, so
   * the role has to be findable in prose too — not only from structured data or a
   * page heading, which an email does not have.
   */
  for (const m of page.text.matchAll(
    /*
     * An advert rarely says "looking for a Full Stack Engineer" — it says
     * "looking for a talented Full Stack Engineer". One optional lowercase
     * adjective is allowed between the article and the role.
     */
    /\b(?:looking for|hiring|recruiting|role[: ]|position[: ]|apply for)\s+(?:a|an|the)?\s*(?:[a-z]+\s+)?([A-Z0-9][A-Za-z0-9]*(?:\s+[A-Z0-9][A-Za-z0-9-]*){1,6})/g,
  )) {
    const title = (m[1] ?? "").trim();
    if (title.length < 6) continue;
    out.push(entity("job_title", title, 0.75, windowAround(page.text, m.index ?? 0, m[0].length)));
  }

  /*
   * The heading is a second, independent name for the role — a job board shows
   * its own card title ("Javascript Developer") while the advert body names the
   * position ("Full Stack Engineer"). Both are worth keeping; an earlier version
   * only fell back to the heading when the prose found nothing, so whichever the
   * reader was actually looking at could be the one discarded.
   */
  {
    const heading = page.headings.find((h) => !isFurnitureHeading(h));
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

/**
 * Links that look like somewhere the user is meant to go next.
 *
 * Narrow on purpose: an email has twenty links and nineteen of them are
 * unsubscribe, preferences and social icons. Only a destination that says it is
 * an application or a payment is worth offering, and offering it is still a
 * confirm-risk action because it leaves the machine.
 */
function extractActionableLinks(page: PageContext): Entity[] {
  const WORTH_OFFERING = /\b(?:apply|application|register|submit|complete|view (?:the )?(?:job|role|invoice)|pay (?:now|invoice)|book)\b/i;
  const NEVER = /\b(?:unsubscribe|preferences|privacy|terms|snooze|refer a friend|chat with)\b/i;

  const out: Entity[] = [];
  for (const link of page.links) {
    if (NEVER.test(link.text)) continue;
    if (!WORTH_OFFERING.test(link.text)) continue;
    out.push(entity("url", link.href, 0.85, link.text, "public"));
    if (out.length >= 3) break;
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
