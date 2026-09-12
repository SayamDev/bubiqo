/**
 * Surface classification: deciding what kind of thing the user is looking at.
 *
 * Scores are additive and capped, and every Surface must clear a floor before it
 * beats `generic`. Guessing "invoice" on a blog post is worse than saying nothing:
 * a wrong Surface produces confidently wrong Suggestions, which is exactly the
 * failure mode that makes people uninstall an assistant.
 */

import type { Classification, PageContext, Surface } from "./types";

interface Signal {
  readonly pattern: RegExp;
  readonly weight: number;
  /** Why this mattered, for the user-facing explanation. */
  readonly label: string;
}

const SIGNALS: Readonly<Record<Exclude<Surface, "generic">, readonly Signal[]>> = {
  invoice: [
    { pattern: /\binvoice\b/i, weight: 3, label: "the word “invoice”" },
    { pattern: /\b(?:amount|total)\s+(?:due|payable)\b/i, weight: 3, label: "an amount due" },
    { pattern: /\bdue date\b/i, weight: 2, label: "a due date" },
    { pattern: /\bbill\s*to\b/i, weight: 2, label: "a “bill to” block" },
    { pattern: /\b(?:vat|tax)\b.{0,20}\b(?:no|number|reg)\b/i, weight: 1, label: "a VAT number" },
    { pattern: /\bpayment\s+(?:terms|reference|due)\b/i, weight: 2, label: "payment terms" },
    { pattern: /\bsubtotal\b/i, weight: 1, label: "a subtotal" },
  ],
  job: [
    { pattern: /\bjob\s+(?:description|title|advert|posting|spec)\b/i, weight: 3, label: "a job description" },
    { pattern: /\b(?:apply|application)\s+(?:now|deadline|by|before|closes)\b/i, weight: 3, label: "an application deadline" },
    { pattern: /\b(?:responsibilities|requirements|what you.ll do|about the role)\b/i, weight: 2, label: "a requirements section" },
    { pattern: /\b(?:salary|per annum|pro rata|OTE)\b/i, weight: 2, label: "salary information" },
    { pattern: /\b(?:full[- ]time|part[- ]time|permanent|contract|hybrid|remote)\b/i, weight: 1, label: "a working pattern" },
    { pattern: /\bclosing date\b/i, weight: 2, label: "a closing date" },
  ],
  email: [
    { pattern: /^\s*(?:from|to|cc|subject)\s*:/im, weight: 3, label: "email headers" },
    /*
     * Gmail and friends render no "From:" header. What they do render is a name
     * beside an address, a "to me" line, and an Unsubscribe link — which is why a
     * real recruiter email scored 3 against a floor of 4 and came out "generic".
     */
    { pattern: /[A-Z][A-Za-z'’-]{1,30}\s*<[^@\s>]+@[^>\s]+>/, weight: 3, label: "a sender address" },
    { pattern: /^\s*to me\s*$/im, weight: 2, label: "a “to me” line" },
    { pattern: /\bunsubscribe\b/i, weight: 1, label: "an unsubscribe link" },
    { pattern: /\b(?:hi|hello|dear|hey)\s+[A-Z][a-z]+/,  weight: 2, label: "a salutation" },
    { pattern: /\b(?:kind regards|best regards|regards|thanks,|cheers,|sincerely)\b/i, weight: 2, label: "a sign-off" },
    { pattern: /\b(?:wrote|replied|forwarded message|on .{3,30} wrote:)\b/i, weight: 2, label: "a quoted reply" },
    { pattern: /\breply\b|\bforward\b/i, weight: 1, label: "reply controls" },
  ],
};

/** Below this, we are not confident enough to claim a Surface at all. */
const FLOOR = 4;

export function classify(page: PageContext): Classification {
  const haystack = `${page.title}\n${page.headings.join("\n")}\n${page.text}`;

  // Structured data, where a page offers it, beats any amount of text guessing.
  for (const block of page.structuredData) {
    if (block["@type"] === "JobPosting") {
      return { surface: "job", confidence: 0.97, rationale: "The page declares itself a job posting in its structured data." };
    }
    if (block["@type"] === "Invoice") {
      return { surface: "invoice", confidence: 0.97, rationale: "The page declares itself an invoice in its structured data." };
    }
  }

  let best: { surface: Surface; score: number; labels: string[] } = { surface: "generic", score: 0, labels: [] };

  for (const [surface, signals] of Object.entries(SIGNALS) as [Exclude<Surface, "generic">, readonly Signal[]][]) {
    let score = 0;
    const labels: string[] = [];
    for (const signal of signals) {
      if (signal.pattern.test(haystack)) {
        score += signal.weight;
        labels.push(signal.label);
      }
    }
    if (score > best.score) best = { surface, score, labels };
  }

  if (best.score < FLOOR) {
    return {
      surface: "generic",
      confidence: 0.5,
      rationale: "Nothing on this page identified it as an email, invoice or job advert.",
    };
  }

  // 4 points is the floor, 10 is about as certain as these signals ever get.
  const confidence = Math.min(0.95, 0.55 + (best.score - FLOOR) * 0.06);
  const reasons = best.labels.slice(0, 3).join(", ");
  return {
    surface: best.surface,
    confidence,
    rationale: `This page shows ${reasons}.`,
  };
}
