/**
 * Job alert digests: several adverts in one email.
 *
 * Jobright, LinkedIn and Indeed send "your top matches" emails listing five or
 * ten roles, each with a company, a title, pay, where, and an Apply button. Read
 * as one page, that became eight loose amounts and "Organisation: Computer
 * Software" — an industry tag mistaken for an employer. What anyone copying
 * from such an email wants is the list: which role, at whom, for how much.
 *
 * Each listing ends at its call to action, so the text is cut there and every
 * block is read on its own.
 */

export interface Listing {
  readonly title: string;
  readonly company?: string;
  readonly pay?: string;
  readonly where?: string;
}

const CALL_TO_ACTION = /^(?:apply(?: now)?|view (?:job|role)|see (?:job|more)|easy apply)$/i;
const WHERE = /^(?:remote|hybrid|on-?site|in office)\b.*$/i;
const PAY = /[£$€]\s?\d/;
const NOISE = /(?:\d+\s*(?:minutes?|hours?|days?)\s*ago|early applicant|^\d{1,3}%$|match|^·$)/i;
// "Computer Software · Early Stage": an industry and a stage, not a title.
const TAGLINE = /\s·\s/;

export function extractListings(text: string): Listing[] {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const out: Listing[] = [];
  let block: string[] = [];

  for (const line of lines) {
    if (!CALL_TO_ACTION.test(line)) {
      block.push(line);
      continue;
    }
    const listing = readBlock(block);
    if (listing) out.push(listing);
    block = [];
  }

  // A digest has several; one "Apply" on a page is a single advert.
  return out.length >= 2 ? out : [];
}

function readBlock(block: readonly string[]): Listing | undefined {
  // Only the tail of the block belongs to this listing; anything earlier is
  // the email's own header or the previous listing's footer.
  const tail = block.slice(-8);
  const payLine = tail.find((l) => PAY.test(l) && l.length < 40);
  const whereLine = tail.find((l) => WHERE.test(l) && l.length < 30);
  const words = tail.filter(
    (l) => l !== payLine && l !== whereLine && !NOISE.test(l) && !TAGLINE.test(l) && l.length >= 3 && l.length <= 90,
  );
  if (words.length === 0) return undefined;

  // The title is the line right before the pay or place; the company sits above it.
  const anchor = payLine ?? whereLine;
  const anchorAt = anchor ? tail.indexOf(anchor) : tail.length;
  const beforeAnchor = words.filter((l) => tail.indexOf(l) < anchorAt);
  const title = beforeAnchor.at(-1) ?? words[0]!;
  const company = beforeAnchor.length >= 2 ? beforeAnchor.at(-2) : undefined;

  return {
    title,
    ...(company && company !== title ? { company } : {}),
    ...(payLine ? { pay: payLine.replace(/\s*-\s*/g, " – ") } : {}),
    ...(whereLine ? { where: whereLine } : {}),
  };
}

/** One line per listing, "Title at Company · pay · where", for copying. */
export function listingLines(listings: readonly Listing[]): string[] {
  return listings.map((l) =>
    [l.company ? `${l.title} at ${l.company}` : l.title, l.pay, l.where].filter(Boolean).join(" · "),
  );
}
