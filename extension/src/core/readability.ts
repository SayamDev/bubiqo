/**
 * Choosing which part of a page is actually the content.
 *
 * Reading `<main>` wholesale works on a simple page and fails badly on an
 * application. On a LinkedIn jobs page, `<main>` holds the search filters, a list
 * of twenty-five other jobs, a feedback survey AND the advert being read — so the
 * analysis was run over all of it at once. That produced a company called "Easy
 * Apply GBV Ltd", a salary of £55, dates from other people's job cards, and items
 * filed under the survey's heading, "Are these results helpful?".
 *
 * The signal that separates them is link density. A list of results is almost
 * entirely link text; prose is almost none. That one ratio distinguishes a
 * navigation region from something worth reading, on any site, without knowing
 * anything about the site.
 *
 * This module is pure so the choice can be tested with numbers. The DOM walking
 * that produces those numbers stays in background/extract.ts and does no thinking.
 */

export interface BlockStats {
  /** Index of the candidate, so the caller can map a choice back to its element. */
  readonly index: number;
  readonly textLength: number;
  /** How much of that text sits inside anchors. */
  readonly linkTextLength: number;
  /** Anchors in the block. Many short links is the shape of navigation. */
  readonly linkCount: number;
  /** Nesting depth from the root, to prefer the outermost block that scores well. */
  readonly depth: number;
}

/** Below this a block is a fragment, not the content. */
const MIN_CONTENT_LENGTH = 280;

/** Above this proportion of link text, a block is navigation whatever its size. */
const NAVIGATION_LINK_DENSITY = 0.45;

export function linkDensity(block: BlockStats): number {
  if (block.textLength === 0) return 1;
  return Math.min(1, block.linkTextLength / block.textLength);
}

/**
 * How much this block looks like the thing the user came to read.
 *
 * Length matters, but link density matters more, so it is applied as a square —
 * a block that is half links scores a quarter of its length, and a results list
 * never beats an advert no matter how many results it holds.
 */
export function scoreBlock(block: BlockStats): number {
  if (block.textLength < MIN_CONTENT_LENGTH) return 0;

  const density = linkDensity(block);
  if (density > NAVIGATION_LINK_DENSITY) return 0;

  const readable = 1 - density;
  let score = block.textLength * readable * readable;

  // Many links relative to the prose is the shape of a list even when the density
  // check passes, because list items are short.
  const linksPerThousand = (block.linkCount / Math.max(block.textLength, 1)) * 1000;
  if (linksPerThousand > 12) score *= 0.45;

  // A shallower block containing the same text is the better answer: it keeps the
  // heading and the byline that a deeper one would have cropped off.
  score *= 1 / (1 + block.depth * 0.08);

  return score;
}

/**
 * The best candidate, or nothing if none of them look like content.
 *
 * Returning nothing is a real answer: the caller falls back to the whole region,
 * which is the right behaviour on a simple page that has no sub-structure.
 */
export function pickBestBlock(blocks: readonly BlockStats[]): BlockStats | undefined {
  let best: BlockStats | undefined;
  let bestScore = 0;

  for (const block of blocks) {
    const score = scoreBlock(block);
    if (score > bestScore) {
      bestScore = score;
      best = block;
    }
  }
  return best;
}

/**
 * Headings that belong to the page's furniture rather than its content.
 *
 * "Are these results helpful?" is a survey widget, and it was being used to name
 * saved jobs. A heading that asks the reader a question, or names a UI control, is
 * not what the page is about.
 */
const FURNITURE_HEADING =
  /^(?:are these|was this|how (?:did|was)|rate\b|feedback|share\b|save\b|(?:easy\s+)?apply\b|sign in|log in|create (?:a )?(?:job )?alert|job alert|similar jobs|people also|recommended for you|more jobs|jobs? based on|search\b|filters?\b|messaging|notifications|promoted|suggested)\b/i;

export function isFurnitureHeading(heading: string): boolean {
  const text = heading.trim();
  if (text.length < 3 || text.length > 120) return true;
  if (FURNITURE_HEADING.test(text)) return true;
  // A heading that is only a question is asking the reader something, not naming
  // the page — "Are these results helpful?", "Know someone who'd be a good fit?".
  return text.endsWith("?");
}
