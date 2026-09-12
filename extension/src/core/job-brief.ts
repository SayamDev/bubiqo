/**
 * Is this advert worth an hour of my time?
 *
 * That is the only question a job advert gets read to settle, and the things that
 * answer it are the deal-breakers, the money, the closing date and the working
 * pattern. An earlier version of this file answered a different question — it
 * matched 90 hardcoded technology names and showed them as chips — which told a
 * reader nothing they could act on, and returned nothing at all for any job
 * outside UK software.
 *
 * Two sources, in order of trust:
 *
 *   1. The site's own `JobPosting` structured data, where it publishes one. Exact.
 *   2. The advert's prose. Necessary, not a degraded mode: every real captured page
 *      in tests/captured/ has empty structuredData, so on a logged-in LinkedIn job
 *      page this is the only path there is.
 *
 * Each field records which of the two it came from, because a salary the site
 * published and a salary matched out of a sentence are different kinds of claim
 * and the reader is entitled to tell them apart.
 */

import type { Blocker, BriefField, JobBrief, PageContext } from "./types";
import { readJobPosting } from "./job-posting";
import { resolveDates } from "./dates";
import { NUMBER_PATTERN, SYMBOL_TO_CODE, formatAmount, formatRange, looksLikeSalary, readNumber } from "./money";

interface BlockerRule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly summary: string;
}

/**
 * The conditions that end an application before it starts.
 *
 * Six rules, and deliberately only six. Every one of them is absolute: no amount
 * of relevant experience compensates for not holding clearance or not being
 * allowed to work in the country. Years of experience, a degree and a number of
 * office days are none of them — they are preferences, and an advert that asks
 * for five years will still read a good four-year application. Those are facts
 * elsewhere in the brief, not blockers.
 *
 * Adverts bury these three-quarters of the way down, under a heading like
 * "Security requirements" or "To Be Eligible, You Must", which is exactly why
 * they are worth lifting to the top.
 */
export const BLOCKER_RULES: readonly BlockerRule[] = [
  {
    id: "security_clearance",
    pattern: /\b(?:security clearance|SC cleared|DV cleared|developed vetting|BPSS|NPPV|counter[- ]terrorist check)\b/i,
    summary: "Security clearance required",
  },
  {
    id: "british_citizen",
    // Stated as a bare bullet — "Be a British citizen" — so requiring an adjacent
    // "must" missed the phrasing adverts actually use.
    pattern: /\bBritish citizen(?:ship)?\b|\bsole British national\b|\bmust be (?:a )?UK citizen\b/i,
    summary: "Must be a British citizen",
  },
  {
    id: "uk_residency",
    pattern: /\b(?:lived|resided) (?:permanently |continuously )?in the UK for (?:the last |at least )?[\w-]+ years?\b/i,
    summary: "UK residency period required",
  },
  {
    id: "right_to_work",
    pattern: /\b(?:right to work|work permit|visa sponsorship is not|cannot sponsor|no sponsorship|unable to sponsor)\b/i,
    summary: "Right to work restrictions",
  },
  {
    id: "driving_licence",
    pattern: /\b(?:full|valid|clean)\s+(?:UK\s+)?driving licence\b/i,
    summary: "Driving licence required",
  },
  {
    id: "dbs_check",
    pattern: /\b(?:DBS check|enhanced DBS|criminal record check)\b/i,
    summary: "DBS check required",
  },
];

/** Headings an advert puts its conditions under. */
const ELIGIBILITY_HEADING =
  /\b(?:eligib|essential(?: requirements| criteria)?|you must|what you(?:'|’)?ll need|requirements|security requirements|to apply|person specification)\b/i;

/** Headings that mean the conditions have ended and the sales pitch has resumed. */
const SECTION_BREAK =
  /\b(?:what we offer|benefits|package|about (?:us|the company|the team)|how to apply|next steps|salary|our values|equal opportunit)\b/i;

const MAX_ELIGIBILITY_ITEMS = 8;
const MAX_ELIGIBILITY_CHARS = 400;
const MAX_QUOTE = 180;

function field<T>(value: T, source: "structured" | "prose", evidence: string, confidence: number): BriefField<T> {
  return { value, source, evidence: evidence.replace(/\s+/g, " ").trim().slice(0, MAX_QUOTE), confidence };
}

/**
 * The line, then the sentence, containing a match.
 *
 * Line first because adverts state eligibility as bullets with no full stops: a
 * sentence-only window starting at the previous "." swallowed the entire section
 * above the bullet and quoted it back as evidence.
 */
function quoteAround(text: string, index: number, length: number): string {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const lineEndRaw = text.indexOf("\n", index);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  const line = text.slice(lineStart, lineEnd);

  const inLine = index - lineStart;
  const before = line.slice(0, inLine);
  const sentenceStart = Math.max(before.lastIndexOf(". "), before.lastIndexOf("! "), before.lastIndexOf("? "));
  const start = sentenceStart === -1 ? 0 : sentenceStart + 2;

  const after = line.slice(inLine + length);
  const stop = after.search(/[.!?](?:\s|$)/);
  const end = stop === -1 ? line.length : inLine + length + stop + 1;

  return line.slice(start, end).trim();
}

function findBlockers(text: string): Blocker[] {
  const found: Blocker[] = [];
  for (const rule of BLOCKER_RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    found.push({
      rule: rule.id,
      summary: rule.summary,
      evidence: quoteAround(text, match.index, match[0].length).slice(0, MAX_QUOTE),
    });
  }
  return found;
}

/**
 * The advert's own conditions, quoted rather than classified.
 *
 * No rule set knows every blocker — a first aid certificate, a specific
 * registration, a shift pattern. Quoting the section the advert itself labelled
 * as its requirements surfaces those without ever asserting one, which is the
 * honest half of this feature: the rules above claim, and this only shows.
 */
function readEligibility(page: PageContext): string[] {
  const lines = page.text.split("\n").map((l) => l.trim());
  const headingSet = new Set(page.headings.map((h) => h.trim()));

  const startsSection = (line: string): boolean =>
    line.length > 0 && line.length < 80 && ELIGIBILITY_HEADING.test(line);

  const start = lines.findIndex(startsSection);
  if (start === -1) return [];

  const out: string[] = [];
  let chars = 0;

  for (const line of lines.slice(start + 1)) {
    if (line.length === 0) continue;
    // A new heading ends the section: either one the page declared, or one of the
    // headings that always mean the requirements are over.
    if (line.length < 80 && (headingSet.has(line) || SECTION_BREAK.test(line))) break;
    if (out.length >= MAX_ELIGIBILITY_ITEMS || chars >= MAX_ELIGIBILITY_CHARS) break;

    const quote = line.replace(/^[-•*•\s]+/, "").slice(0, MAX_QUOTE);
    if (quote.length === 0) continue;
    out.push(quote);
    chars += quote.length;
  }

  return out;
}

const SYMBOLS = Object.keys(SYMBOL_TO_CODE).map((s) => `\\${s}`).join("");
/*
 * A "k" suffix has to be tried before the plain number pattern. Alternation is
 * first-match, and `\d+` happily matches the "55" of "£55k" and stops — which
 * read as a salary of fifty-five pounds and was then discarded as implausible,
 * losing a salary the advert had stated plainly.
 */
const AMOUNT = String.raw`\d+(?:\.\d+)?\s*[kKmM]\b|${NUMBER_PATTERN}`;
const SALARY_RANGE = new RegExp(
  String.raw`([${SYMBOLS}])\s?(${AMOUNT})\s*(?:-|–|—|to)\s*[${SYMBOLS}]?\s?(${AMOUNT})`,
);
const SALARY_SINGLE = new RegExp(String.raw`([${SYMBOLS}])\s?(${AMOUNT})`);

/**
 * A salary from prose, or nothing.
 *
 * `looksLikeSalary` is the guard that matters: an advert's text is full of
 * currency amounts that are not the salary — a £9 parking charge, a £500 referral
 * bonus — and quoting one of those as the pay is worse than saying nothing.
 */
function readProseSalary(text: string): BriefField<string> | undefined {
  const range = SALARY_RANGE.exec(text);
  if (range) {
    const code = SYMBOL_TO_CODE[range[1] ?? ""] ?? "GBP";
    const low = readNumber(range[2] ?? "");
    const high = readNumber(range[3] ?? "");
    if (low !== undefined && high !== undefined && looksLikeSalary(low) && looksLikeSalary(high)) {
      return field(formatRange(code, low, high), "prose", quoteAround(text, range.index, range[0].length), 0.8);
    }
  }

  const single = SALARY_SINGLE.exec(text);
  if (single) {
    const code = SYMBOL_TO_CODE[single[1] ?? ""] ?? "GBP";
    const value = readNumber(single[2] ?? "");
    if (value !== undefined && looksLikeSalary(value)) {
      return field(formatAmount(code, value), "prose", quoteAround(text, single.index, single[0].length), 0.7);
    }
  }

  return undefined;
}

const WORKING_PATTERNS: readonly { readonly pattern: RegExp; readonly label: (m: RegExpExecArray) => string }[] = [
  {
    pattern: /\b(\d+)\s*days?\s*(?:a week\s*|per week\s*)?(?:on[- ]?site|in (?:the )?office)\b/i,
    label: (m) => `${m[1]} days on-site`,
  },
  { pattern: /\bfully on[- ]?site\b/i, label: () => "Fully on-site" },
  { pattern: /\bfully remote\b|\b100% remote\b/i, label: () => "Fully remote" },
  { pattern: /\bhybrid\b/i, label: () => "Hybrid" },
  { pattern: /\bremote\b/i, label: () => "Remote" },
];

function readWorkingPattern(text: string): BriefField<string> | undefined {
  for (const { pattern, label } of WORKING_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    return field(label(match), "prose", quoteAround(text, match.index, match[0].length), 0.7);
  }
  return undefined;
}

/**
 * A closing date from prose, anchored to the words that name one.
 *
 * Anchored deliberately: an advert is full of dates — when it was posted, when
 * the company was founded — and the only one worth acting on is the one it calls
 * a closing date. core/dates.ts refuses ambiguous numeric dates, so "03/10/2026"
 * yields nothing rather than a date six months wrong.
 */
function readProseClosingDate(text: string, now: number): BriefField<number> | undefined {
  const anchor = /\b(?:closing date|applications? close|deadline for applications|apply by)\b/i.exec(text);
  if (!anchor) return undefined;

  const window = text.slice(anchor.index, anchor.index + 160);
  const [resolved] = resolveDates(window, now);
  if (!resolved) return undefined;

  return field(resolved.at, "prose", quoteAround(text, anchor.index, anchor[0].length), resolved.confidence);
}

/** An ISO date from `validThrough`, or nothing. Never a guess. */
function readStructuredDate(raw: string): number | undefined {
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : undefined;
}

function readProseTitle(page: PageContext): BriefField<string> | undefined {
  const heading = page.headings.find((h) => h.trim().length > 2 && h.trim().length < 120);
  return heading ? field(heading.trim(), "prose", heading, 0.6) : undefined;
}

/**
 * The brief for one advert.
 *
 * Field by field: the site's own statement wins where it exists, prose fills the
 * rest, and anything neither source supports is absent rather than guessed.
 *
 * `organisation` is read only from structured data. Naming the employer out of
 * prose is the guess that went wrong most often before — a job board's own name,
 * or the company advertising in the sidebar — and the Entity extractor already
 * offers organisations with their own evidence.
 */
export function buildJobBrief(page: PageContext, now: number): JobBrief {
  const posting = readJobPosting(page.structuredData);
  const text = page.text;

  const structuredClosing = posting?.validThrough ? readStructuredDate(posting.validThrough) : undefined;

  const title = posting?.title ? field(posting.title, "structured", "JobPosting.title", 0.95) : readProseTitle(page);

  const organisation = posting?.organisation
    ? field(posting.organisation, "structured", "JobPosting.hiringOrganization", 0.95)
    : undefined;

  const location = posting?.location
    ? field(posting.location, "structured", "JobPosting.jobLocation", 0.9)
    : undefined;

  const salary = posting?.salary
    ? field(posting.salary, "structured", "JobPosting.baseSalary", 0.95)
    : readProseSalary(text);

  const closingDate =
    structuredClosing !== undefined
      ? field(structuredClosing, "structured", "JobPosting.validThrough", 0.95)
      : readProseClosingDate(text, now);

  const employmentType = posting?.employmentType
    ? field(posting.employmentType, "structured", "JobPosting.employmentType", 0.9)
    : undefined;

  const workingPattern = readWorkingPattern(text);

  const blockers = findBlockers(text);

  return {
    ...(title ? { title } : {}),
    ...(organisation ? { organisation } : {}),
    ...(location ? { location } : {}),
    ...(salary ? { salary } : {}),
    ...(closingDate ? { closingDate } : {}),
    ...(employmentType ? { employmentType } : {}),
    ...(workingPattern ? { workingPattern } : {}),
    blockers,
    eligibility: readEligibility(page),
    ...(blockers.length > 0 ? { verdict: "ruled_out" as const } : {}),
  };
}
