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

import type { Blocker, BriefField, Entity, EntityType, JobBrief, PageContext, Sensitivity } from "./types";
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

/**
 * Headings an advert puts its conditions under.
 *
 * Every one of these is taken from an advert seen in the wild. A list built from
 * the phrasings I would have chosen myself covered "Requirements" and "Essential"
 * and missed "About you", "What you'll bring" and "You may be a good fit if you" —
 * which is how most adverts outside the public sector actually word it, and why
 * the panel showed no requirements at all on them.
 */
const ELIGIBILITY_HEADING =
  /\b(?:eligib|essential(?: requirements| criteria)?|you must|what you(?:'|’)?ll (?:need|bring|have)|you(?:'|’)?ll ideally have|requirements|security requirements|to apply|person specification|about you|who you are|we(?:'|’)?re looking for|you (?:may|might) be a good fit|ideal candidate|skills? and experience|qualifications|selection criteria|what we(?:'|’)?re looking for)\b/i;

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

/** Requirements kept on a saved job. Enough to judge it by, short of a transcript. */
const MAX_SAVED_REQUIREMENTS = 8;

/**
 * A quote cut to length, at a word.
 *
 * Slicing at exactly 180 characters ended an eligibility line mid-word — the panel
 * showed "...using appropriate communication and enga" — which reads like a bug
 * whatever the text behind it says.
 */
function clip(text: string, limit = MAX_QUOTE): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;

  const cut = trimmed.slice(0, limit - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function field<T>(value: T, source: "structured" | "prose", evidence: string, confidence: number): BriefField<T> {
  return { value, source, evidence: clip(evidence.replace(/\s+/g, " ")), confidence };
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
      evidence: clip(quoteAround(text, match.index, match[0].length)),
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
  /*
   * A colon is how an advert writes a heading — "Essential:", "You'll ideally
   * have:" — so rejecting it lost the requirements on a LinkedIn advert entirely.
   * A full stop still disqualifies: that is a sentence, and it was a sentence
   * containing the word "essential" that used to open a section wrongly.
   */
  const isHeading = (line: string): boolean =>
    line.length > 0 && line.length < 80 && !/[.!?;]$/.test(line) && !/^[-•*\u2022]/.test(line);

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

      const quote = clip(line.replace(/^[-•*\u2022\s]+/, ""));
      if (quote.length === 0 || out.includes(quote)) continue;
      /*
       * "Experience:", "Desirable:", "Knowledge and Skills:" — an advert groups
       * its requirements under sub-labels, and listing those as requirements puts
       * a row of bare words among the real ones.
       */
      if (/:$/.test(quote) && quote.length < 40) continue;
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

/**
 * The contract type, in the advert's own words.
 *
 * Only where the advert states it. A page with no structured data was showing the
 * reader two facts — salary and working pattern — when it had plainly said
 * "Permanent, Full-time" at the top.
 */
const EMPLOYMENT_TYPES: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\bpermanent\b/i, label: "Permanent" },
  { pattern: /\bfixed[- ]term\b/i, label: "Fixed term" },
  { pattern: /\btemporary\b/i, label: "Temporary" },
  { pattern: /\bapprenticeship\b/i, label: "Apprenticeship" },
  { pattern: /\binternship\b/i, label: "Internship" },
  { pattern: /\bfull[- ]time\b/i, label: "Full time" },
  { pattern: /\bpart[- ]time\b/i, label: "Part time" },
  { pattern: /\b(?:contract|freelance)\b/i, label: "Contract" },
];

function readProseEmploymentType(text: string): BriefField<string> | undefined {
  for (const { pattern, label } of EMPLOYMENT_TYPES) {
    const match = pattern.exec(text);
    if (!match) continue;
    return field(label, "prose", quoteAround(text, match.index, match[0].length), 0.7);
  }
  return undefined;
}

/**
 * The employer, from the Entity the engine already chose.
 *
 * Same reasoning as the salary: `preferTitleAnchoredOrganisation` in
 * core/entity-engine.ts already decides which of the names on a page is the
 * employer, with tests behind it. A second answer here would disagree with it.
 */
function readProseOrganisation(
  page: PageContext,
  text: string,
  entities: readonly Entity[],
  jobTitle: string | undefined,
): BriefField<string> | undefined {
  // The employer is never the role. A panel showed "ORGANISATION: Project Manager".
  const isTheJobTitle = (name: string): boolean =>
    jobTitle !== undefined && name.toLowerCase() === jobTitle.toLowerCase();

  const organisation = entities.find((e) => e.type === "organisation" && !isTheJobTitle(e.value));
  if (organisation) {
    return field(organisation.value, "prose", tidyQuote(organisation.source), organisation.confidence);
  }

  const fromTitle = organisationFromTitle(page.title);
  if (fromTitle && !isTheJobTitle(fromTitle)) return field(fromTitle, "prose", page.title, 0.75);

  const fromOpening = organisationFromOpeningLines(text);
  if (fromOpening && !isTheJobTitle(fromOpening)) return field(fromOpening, "prose", fromOpening, 0.7);

  return undefined;
}

/** Sites whose name is appended to every page title. */
const JOB_SITE = /^(?:linkedin|indeed(?:\.com)?|glassdoor|reed(?:\.co\.uk)?|totaljobs|cv-library|monster|ziprecruiter|jobsite|adzuna|otta|welcome to the jungle)$/i;

/** A postcode, a "City, Country", a distance — the things that are places, not employers. */
const LOOKS_LIKE_A_PLACE =
  /\b[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d?[A-Z]{0,2}\b|\b\d+\s*min\b|\bremote\b|\bhybrid\b|,\s*(?:england|scotland|wales|northern ireland|united kingdom|uk|usa)\b/i;

/** Words that only appear in the name of an organisation. */
const ORGANISATION_SUFFIX =
  /\b(?:Ltd|Limited|PLC|LLP|LLC|Inc|GmbH|N\.?V|S\.?A|Group|Holdings|Trust|Society|Foundation|University|College|Council|Partnership|Recruitment|Technologies|Consulting|Solutions|Associates|NHS)\b/;

/**
 * The employer, from the document title.
 *
 * Job boards write the title as "<role> | <employer> | <site>" — a LinkedIn advert
 * reads "Senior Prompt Engineer - AI - Full-time | OVI | LinkedIn". Splitting on
 * the pipe and dropping the site's own name leaves the employer, and it is stated
 * by the page rather than guessed from prose.
 *
 * Pipes only. Indeed uses dashes — "Product Manager - Integration - Swindon SN38 -
 * Indeed.com" — where the same rule would return a postcode as the employer.
 */
function organisationFromTitle(title: string): string | undefined {
  const parts = title.split("|").map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length < 3) return undefined;

  const candidate = parts[parts.length - 2] ?? "";
  if (JOB_SITE.test(candidate) || LOOKS_LIKE_A_PLACE.test(candidate)) return undefined;
  return candidate.length > 1 && candidate.length < 80 ? candidate : undefined;
}

/**
 * The employer, from the top of the advert.
 *
 * An NHS advert opens with "Central and North West London NHS Foundation Trust"
 * and never repeats it in a form the Entity extractor recognises. Only lines
 * carrying a word that belongs to an organisation's name qualify, so a job title
 * or a location on the same lines is not mistaken for one.
 */
function organisationFromOpeningLines(text: string): string | undefined {
  // "About EdenCare Support Services Ltd" is a heading about the employer, not the
  // employer's name. Every advert that has this line writes it this way.
  const lines = text.split("\n").map((l) => l.trim().replace(/^About\s+/i, ""));

  for (const line of lines.slice(0, 60)) {
    if (line.length < 3 || line.length > 90) continue;
    if (LOOKS_LIKE_A_PLACE.test(line)) continue;
    if (ORGANISATION_SUFFIX.test(line)) return line;
  }
  return undefined;
}

/** A UK postcode, which is how an advert states an address it means literally. */
const POSTCODE_LINE = /^[^\n]{0,80}\b[A-Z]{1,2}\d{1,2}[A-Z]?\s+\d[A-Z]{2}\b[^\n]{0,20}$/m;

/**
 * Where the job is.
 *
 * The Entity engine's address extractor is written for invoices and misses the way
 * a job board prints one — "53 Thicketford Road, Bolton BL2 2LS" on a line of its
 * own — so a postcode line is read directly when it has nothing.
 */
function readProseLocation(text: string, entities: readonly Entity[]): BriefField<string> | undefined {
  const address = entities.find((e) => e.type === "address");
  if (address) return field(address.value, "prose", tidyQuote(address.source), address.confidence);

  /*
   * A labelled line. Ashby prints "Location" and then the place on the next line;
   * Indeed prints "Job address" the same way. Reading the label is exact, where
   * guessing which capitalised phrase in an advert is a place is not.
   */
  const lines = text.split("\n").map((l) => l.trim());
  for (const [index, line] of lines.entries()) {
    if (!/^(?:location|job address|office location|based in)\s*:?$/i.test(line)) continue;
    const value = lines.slice(index + 1).find((l) => l.length > 1 && l.length < 90);
    if (value) return field(value, "prose", `${line}: ${value}`, 0.8);
  }

  const match = POSTCODE_LINE.exec(text);
  return match ? field(match[0].trim(), "prose", match[0].trim(), 0.7) : undefined;
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
  // Indeed appends "- job post" to the advert's heading.
  const title = preferredTitle(page).replace(/\s*[-–]\s*job post\s*$/i, "").trim();
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
    : readProseOrganisation(page, text, entities, title?.value);

  const location = posting?.location
    ? field(posting.location, "structured", "JobPosting.jobLocation", 0.9)
    : readProseLocation(text, entities);

  const salary = posting?.salary
    ? field(posting.salary, "structured", "JobPosting.baseSalary", 0.95)
    : readProseSalary(entities);

  const closingDate =
    structuredClosing !== undefined
      ? field(structuredClosing, "structured", "JobPosting.validThrough", 0.95)
      : readProseClosingDate(text, now);

  const employmentType = posting?.employmentType
    ? field(posting.employmentType, "structured", "JobPosting.employmentType", 0.9)
    : readProseEmploymentType(text);

  /*
   * A title that ends with the employer's name repeats what the brief shows
   * beside it: "Senior Prompt Engineer - AI - Full-time | OVI" under a heading
   * that already says OVI. Job boards build titles that way, so trim it.
   */
  const trimmedTitle =
    title && organisation
      ? (() => {
          const withoutEmployer = title.value
            .replace(new RegExp(`\\s*[|–—-]\\s*${organisation.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "")
            .trim();
          return withoutEmployer.length > 2 ? { ...title, value: withoutEmployer } : title;
        })()
      : title;

  const workingPattern = readWorkingPattern(text);

  const blockers = findBlockers(text);

  return {
    ...(trimmedTitle ? { title: trimmedTitle } : {}),
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


/**
 * The Brief as Entities, for saving and copying.
 *
 * Memory stores Entities, and saving every Entity on the page put three other
 * adverts' salaries and an employer called "New" — a badge on a neighbouring card
 * — into a saved job. These are the facts the Brief actually stands behind, each
 * carrying the evidence it was read from.
 */
export function briefToEntities(brief: JobBrief, entities: readonly Entity[] = [], url?: string): Entity[] {
  const out: Entity[] = [];

  const add = (
    type: EntityType,
    value: string | undefined,
    field: BriefField<unknown> | undefined,
    extra: { resolvedAt?: number } = {},
  ): void => {
    if (!value || !field) return;
    out.push({
      type,
      value,
      confidence: field.confidence,
      source: field.evidence,
      sensitivity: "public" as Sensitivity,
      ...extra,
    });
  };

  add("job_title", brief.title?.value, brief.title);
  add("organisation", brief.organisation?.value, brief.organisation);
  add("amount", brief.salary?.value, brief.salary);
  add("address", brief.location?.value, brief.location);
  if (brief.closingDate) {
    add("deadline", new Date(brief.closingDate.value).toISOString().slice(0, 10), brief.closingDate, {
      resolvedAt: brief.closingDate.value,
    });
  }

  for (const blocker of brief.blockers) {
    out.push({
      type: "blocker",
      value: blocker.summary,
      confidence: 0.9,
      source: blocker.evidence,
      sensitivity: "public",
    });
  }

  /*
   * The requirements, in the advert's own words.
   *
   * A saved job held the headline facts and nothing about what it actually asked
   * for, which is most of what a reader goes back to a saved advert to check.
   */
  for (const requirement of brief.eligibility.slice(0, MAX_SAVED_REQUIREMENTS)) {
    out.push({
      type: "requirement",
      value: requirement,
      confidence: 0.8,
      source: requirement,
      sensitivity: "public",
    });
  }

  /*
   * Who to contact, where the advert names someone. Public-sector adverts almost
   * always do, and it is the thing a reader needs at the moment they act.
   */
  const contactTypes: readonly EntityType[] = ["email", "phone", "person"];
  for (const type of contactTypes) {
    const contact = entities.find((e) => e.type === type && e.sensitivity !== "sensitive");
    if (contact) out.push(contact);
  }

  /*
   * A way back to the advert. Saving the facts and not the link meant the user
   * could not reopen the thing they had saved.
   */
  if (url) {
    out.push({ type: "url", value: url, confidence: 1, source: "the page this was saved from", sensitivity: "public" });
  }

  return out;
}
