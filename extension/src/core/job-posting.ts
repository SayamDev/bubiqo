/**
 * The advert's own account of itself.
 *
 * Job boards, applicant tracking systems and most company career pages publish a
 * schema.org `JobPosting` in a `<script type="application/ld+json">` block so that
 * Google for Jobs can index them. It states the title, the employer, the salary and
 * the closing date exactly, in fields, with no prose in the way.
 *
 * Bubiqo already collected these blocks and used them for one thing: deciding the
 * Surface was `job`. Everything else was then guessed back out of the page text,
 * next to a sidebar advertising twenty other roles. This module reads what the site
 * actually said.
 *
 * Everything here is defensive. JSON-LD in the wild is written by SEO plugins and
 * hand-edited templates: fields arrive as objects where strings are documented,
 * arrays where single values are, and occasionally as `null`. A reader that throws
 * on any of that would take the whole analysis down with it, so nothing here throws
 * and nothing here trusts a type it has not checked.
 */

import { formatAmount, formatRange } from "./money";

export interface JobPosting {
  readonly title?: string;
  readonly organisation?: string;
  readonly location?: string;
  /** Already formatted for display, in the same shape as an amount Entity. */
  readonly salary?: string;
  readonly employmentType?: string;
  /** The closing date as the site stated it, ISO-ish, unparsed. */
  readonly validThrough?: string;
  readonly description?: string;
}

/** A non-empty string, or nothing. Anything else is the wrong shape and is skipped. */
function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  // Numbers arrive as strings often enough that refusing them would lose real salaries.
  if (typeof value === "string" && /^\s*\d+(?:\.\d+)?\s*$/.test(value)) return Number(value);
  return undefined;
}

/** The first element of an array, or the value itself. Schema.org allows either everywhere. */
function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function isJobPosting(block: Record<string, unknown>): boolean {
  const type = block["@type"];
  if (typeof type === "string") return type === "JobPosting";
  if (Array.isArray(type)) return type.some((t) => t === "JobPosting");
  return false;
}

/**
 * Flatten the shapes a page can wrap its blocks in.
 *
 * A single block, an array of blocks, and a `@graph` holding both the WebPage and
 * the JobPosting are all common; Yoast and similar plugins emit the last of these
 * for every page they touch. Recognising only a bare top-level `@type` — which is
 * what the previous code did — reads a `@graph` page as having no structured data
 * at all.
 */
function candidates(blocks: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (!block) continue;
    out.push(block);
    const graph = block["@graph"];
    if (Array.isArray(graph)) {
      for (const node of graph) {
        const nested = obj(node);
        if (nested) out.push(nested);
      }
    }
  }
  return out;
}

/**
 * A `MonetaryAmount`, which nests a `QuantitativeValue` that may hold a range or a
 * single figure. Formatted through core/money.ts so a salary read here and a salary
 * read from prose are the same string.
 */
function readSalary(raw: unknown): string | undefined {
  const amount = obj(raw);
  if (!amount) return undefined;

  const code = str(amount["currency"]) ?? str(amount["currencyCode"]) ?? "GBP";
  const value = obj(first(amount["value"])) ?? amount;

  const low = num(value["minValue"]);
  const high = num(value["maxValue"]);
  if (low !== undefined && high !== undefined) return formatRange(code, low, high);

  const single = num(value["value"]) ?? low ?? high;
  return single === undefined ? undefined : formatAmount(code, single);
}

/** A `Place`, a `PostalAddress`, or a bare string — all three appear in real adverts. */
function readLocation(raw: unknown): string | undefined {
  const direct = str(first(raw));
  if (direct) return direct;

  const place = obj(first(raw));
  if (!place) return undefined;

  const address = obj(place["address"]) ?? place;
  return (
    str(address["addressLocality"]) ??
    str(address["addressRegion"]) ??
    str(address["addressCountry"]) ??
    str(obj(address["addressCountry"])?.["name"])
  );
}

/** `FULL_TIME` is how the schema says it; "Full time" is how a person reads it. */
function readEmploymentType(raw: unknown): string | undefined {
  const value = str(first(raw));
  if (!value) return undefined;
  const spaced = value.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The first JobPosting the page publishes, normalised.
 *
 * Returns `null` when the page publishes none — which, on a logged-in LinkedIn job
 * page, is the usual answer. The brief's prose path exists for exactly that case.
 */
export function readJobPosting(blocks: readonly Record<string, unknown>[]): JobPosting | null {
  const block = candidates(blocks).find(isJobPosting);
  if (!block) return null;

  const organisation =
    str(first(block["hiringOrganization"])) ?? str(obj(first(block["hiringOrganization"]))?.["name"]);

  const posting: JobPosting = {
    ...(str(block["title"]) ? { title: str(block["title"]) as string } : {}),
    ...(organisation ? { organisation } : {}),
    ...(readLocation(block["jobLocation"]) ? { location: readLocation(block["jobLocation"]) as string } : {}),
    ...(readSalary(first(block["baseSalary"])) ? { salary: readSalary(first(block["baseSalary"])) as string } : {}),
    ...(readEmploymentType(block["employmentType"])
      ? { employmentType: readEmploymentType(block["employmentType"]) as string }
      : {}),
    ...(str(block["validThrough"]) ? { validThrough: str(block["validThrough"]) as string } : {}),
    ...(str(block["description"]) ? { description: str(block["description"]) as string } : {}),
  };

  return posting;
}
