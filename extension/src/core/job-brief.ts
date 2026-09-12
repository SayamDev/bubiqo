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

import type { Blocker, BriefField, Entity, JobBrief, PageContext } from "./types";
import { readJobPosting } from "./job-posting";
import { resolveDates } from "./dates";
import { looksLikeSalary } from "./money";
import { preferredTitle } from "./storage-hygiene";

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
    /*
     * An NHS advert never says "DBS check". It says "Disclosure and Barring
     * Service Check", and then explains the Rehabilitation of Offenders Act at
     * length. The rule was written against software adverts and read a whole
     * sector's standard wording as no condition at all.
     */
    pattern: /\b(?:DBS(?: check| clearance)?|enhanced DBS|Disclosure and Barring Service|criminal records? (?:check|certificate)s?)\b/i,
    summary: "DBS check required",
  },
];

/** Headings an advert puts its conditions under. */
const ELIGIBILITY_HEADING =
  /\b(?:eligib|essential(?: requirements| criteria)?|you must|what you(?:'|’)?ll need|requirements|security requirements|to apply|person specification)\b/i;

/**
 * Headings that mean the conditions have ended and the sales pitch has resumed.
 *
 * "Whats on offer" is in here without its apostrophe because that is how the
 * heading arrived from a real LinkedIn advert, and the section it ends ran on
 * into nine bullets of pension and holiday before this was noticed.
 */
const SECTION_BREAK =
  /\b(?:what(?:'|’)?s on offer|what we offer|we offer|benefits|package|about (?:us|the company|the team)|how to apply|next steps|salary|our values|equal opportunit)\b/i;

/**
 * Where the advert stops and the application form starts.
 *
 * A Greenhouse-hosted posting extracts as one region: the advert, then the apply
 * form, then the voluntary self-identification survey with its list of medical
 * conditions and its public burden statement. A blocker rule matching inside that
 * boilerplate would produce a false "you are ruled out" with a genuine quote from
 * the page behind it, which is the worst failure this feature has available to it.
 *
 * The markers are the survey's own wording, never the word "apply". NHS Jobs
 * prints "Apply for this job" in the fifth line of the advert, so cutting at the
 * first mention of applying would throw the whole advert away.
 */
const APPLICATION_BOILERPLATE =
  /\b(?:voluntary self[- ]identification|invitation to self[- ]identify|equal employment opportunity information|demographic questions|public burden statement)\b/i;

function advertText(text: string): string {
  const match = APPLICATION_BOILERPLATE.exec(text);
  return match ? text.slice(0, match.index) : text;
}

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

  // Bullet markers are the advert's typography, not its words.
  return line.slice(start, end).replace(/^[-•*\u2022\s]+/, "").trim();
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
function readEligibility(page: PageContext, text: string): string[] {
  const lines = text.split("\n").map((l) => l.trim());
  const headingSet = new Set(page.headings.map((h) => h.trim()));

  /*
   * A heading is short, and does not end in a full stop.
   *
   * Without the punctuation test, "Consultancy experience would be helpful, but
   * it is not essential." opened an eligibility section — it contains the word
   * "essential" and is under eighty characters — and the section then quoted the
   * real heading beneath it back as if it were a requirement.
   */
  const isHeading = (line: string): boolean =>
    line.length > 0 && line.length < 80 && !/[.!?:;]$/.test(line) && !/^[-•*\u2022]/.test(line);

  const opensSection = (line: string): boolean => isHeading(line) && ELIGIBILITY_HEADING.test(line);
  const closesSection = (line: string): boolean =>
    isHeading(line) && (headingSet.has(line) || SECTION_BREAK.test(line) || ELIGIBILITY_HEADING.test(line));

  const out: string[] = [];
  let chars = 0;

  // Every eligibility section, not just the first: an advert routinely states its
  // security requirements under one heading and its citizenship requirements under
  // another, and taking only the first loses half the conditions.
  for (let i = 0; i < lines.length; i += 1) {
    if (!opensSection(lines[i] ?? "")) continue;

    for (const line of lines.slice(i + 1)) {
      if (line.length === 0) continue;
      if (closesSection(line)) break;
      if (out.length >= MAX_ELIGIBILITY_ITEMS || chars >= MAX_ELIGIBILITY_CHARS) break;

      const quote = line.replace(/^[-•*\u2022\s]+/, "").slice(0, MAX_QUOTE);
      if (quote.length === 0 || out.includes(quote)) continue;
      out.push(quote);
      chars += quote.length;
    }
  }

  return out;
}

/**
 * A salary from prose, taken from the amount the Entity engine already chose.
 *
 * An Indeed job page carries four salaries: the advert's own, and three belonging
 * to other adverts in the rail beside it. Picking the first currency match found
 * "£22 - £24 an hour" from a neighbouring card, discarded it as implausible, and
 * then reported no salary at all for an advert that plainly stated one.
 *
 * `extractAmounts` and `preferLabelledAmounts` in core/entity-engine.ts already
 * decide which amount on a page is the one being talked about, and there are tests
 * pinning that decision against real captured pages. Writing a second answer to
 * the same question here would mean two rules disagreeing about the same advert.
 */
/**
 * An Entity's source snippet is a fixed-width window around the match, so it
 * routinely opens mid-word — "pt Manchester – 3 days per week onsite". Shown to a
 * user as the evidence for a salary, that reads like a bug. Drop the fragment.
 */
function tidyQuote(snippet: string): string {
  const trimmed = snippet.trim();
  return /^[a-z]/.test(trimmed) ? trimmed.replace(/^\S+\s+/, "") : trimmed;
}

function readProseSalary(entities: readonly Entity[]): BriefField<string> | undefined {
  for (const amount of entities) {
    if (amount.type !== "amount") continue;

    // "GBP 35000–100000" or "GBP 55000" — the shapes core/money.ts formats.
    const figures = amount.value.match(/\d+(?:\.\d+)?/g) ?? [];
    if (figures.length === 0) continue;
    if (!figures.every((f) => looksLikeSalary(Number(f)))) continue;

    return field(amount.value, "prose", tidyQuote(amount.source), amount.confidence);
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

/**
 * The advert's title from prose.
 *
 * Delegated to `preferredTitle`, which already knows that the first heading on a
 * LinkedIn page is "Are these results helpful?" — a feedback widget — and that
 * the document title is a template ending in the site's own name. Reimplementing
 * that here produced briefs headed "Are these results helpful?" and "Welcome,
 * Sayam".
 */
function readProseTitle(page: PageContext): BriefField<string> | undefined {
  const title = preferredTitle(page).trim();
  return title.length > 2 && title.length < 120 ? field(title, "prose", title, 0.6) : undefined;
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
export function buildJobBrief(page: PageContext, entities: readonly Entity[], now: number): JobBrief {
  const posting = readJobPosting(page.structuredData);
  const text = advertText(page.text);

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
    : readProseSalary(entities);

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
    eligibility: readEligibility(page, text),
    ...(blockers.length > 0 ? { verdict: "ruled_out" as const } : {}),
  };
}
