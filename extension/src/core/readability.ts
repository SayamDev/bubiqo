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

/*
 * The scoring below follows Mozilla's Readability, the algorithm behind Firefox
 * Reader View, rather than the home-grown version that preceded it. Four signals
 * were missing, and each one targets exactly what was going wrong:
 *
 *   - reject by class and id, so a container named "sidebar" or "promo" never
 *     competes with the article at all;
 *   - comma count, because prose has commas and a list of job cards does not;
 *   - positive and negative class weighting;
 *   - propagate a block's score to its parent, so the container holding many good
 *     paragraphs wins rather than one paragraph inside it.
 *
 * Source: https://webcrawlerapi.com/blog/mozilla-readability-algorithm-readabilityjs
 */

/** Class or id names that mean "this is not the article". */
export const UNLIKELY_CANDIDATE =
  /-ad-|ai2html|banner|breadcrumb|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote|promo|paywall|subscribe|newsletter|recommend|jobs-list|job-card|results-list|search-result|upsell|premium/i;

/** Names that mean "this might well be". */
export const LIKELY_CANDIDATE =
  /and|article|body|column|content|main|mainContent|shadow|post|entry|description|details|job-details|job-description/i;

/**
 * Names that mean "this is the pane holding the one advert being read".
 *
 * A job board shows a list of adverts beside the selected one, and both live
 * inside <main>. Scoring alone picks <main>, because it is the longest block and
 * a parent collects its children's text — so the brief ended up with three
 * salaries belonging to other adverts and an employer called "New", which is the
 * badge on a neighbouring card.
 *
 * Measured September 2026: Indeed's pane is "jobsearch-RightPane" (34,943 chars)
 * against a "mosaic-provider-jobcards" list (5,125); LinkedIn's is
 * "jobs-search__job-details--wrapper" against "jobs-search-results-list".
 */
export const DETAIL_PANE =
  /right-?pane|jobsearch-jobcomponent|\bvjs\b|viewjob|jobs?-details|job-view|details-pane|job-description/i;

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
  /** Commas in the text. Prose has them; a list of links does not. */
  readonly commas?: number;
  /** The element's class and id, joined. Used only to weight, never to decide. */
  readonly signature?: string;
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

  const signature = block.signature ?? "";
  // Readability's first move: a container that calls itself a sidebar, a promo or
  // a results list is not the article, whatever else it scores.
  if (UNLIKELY_CANDIDATE.test(signature) && !LIKELY_CANDIDATE.test(signature)) return 0;

  const density = linkDensity(block);
  if (density > NAVIGATION_LINK_DENSITY) return 0;

  const readable = 1 - density;
  let score = block.textLength * readable * readable;

  /*
   * Commas, from Readability. Prose is punctuated and navigation is not, so this
   * separates an advert from a list of adverts even when both are long and both
   * are mostly text.
   */
  const commas = block.commas ?? 0;
  score *= 1 + Math.min(commas / 12, 1.5);

  // Many links relative to the prose is the shape of a list even when the density
  // check passes, because list items are short.
  const linksPerThousand = (block.linkCount / Math.max(block.textLength, 1)) * 1000;
  if (linksPerThousand > 12) score *= 0.45;

  if (LIKELY_CANDIDATE.test(signature)) score *= 1.25;

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
  const scored = blocks.map((block) => ({ block, score: scoreBlock(block) })).filter((c) => c.score > 0);
  if (scored.length === 0) return undefined;

  /*
   * A pane that names itself as the advert wins outright.
   *
   * Not by weighting — weighting cannot beat a parent that contains the pane and
   * everything else, because the parent is always longer. The page has told us
   * which part is the advert; believing it is better than out-scoring it.
   */
  const panes = scored.filter((c) => DETAIL_PANE.test(c.block.signature ?? ""));
  if (panes.length > 0) {
    /*
     * The widest named pane, not the highest-scoring one. Indeed nests a
     * "jobsearch-JobComponent-description" inside "jobsearch-RightPane"; the inner
     * one scores better because it holds no links, and it starts below the
     * employer's name and the job title. Taking the outer pane keeps the header
     * that answers "whose job is this".
     */
    return panes.reduce((widest, current) =>
      current.block.textLength > widest.block.textLength ? current : widest,
    ).block;
  }

  return scored.reduce((winner, current) => (current.score > winner.score ? current : winner)).block;
}

/**
 * Headings that belong to the page's furniture rather than its content.
 *
 * "Are these results helpful?" is a survey widget, and it was being used to name
 * saved jobs. A heading that asks the reader a question, or names a UI control, is
 * not what the page is about.
 */
/**
 * Lines that are the site talking about itself.
 *
 * Removing them one line at a time, rather than slicing everything above the
 * advert, matters: the block at the top of a job page holds the title, the
 * company, the location and the pay, and an earlier version that sliced from
 * "About the job" threw all of that away to get rid of the upsells sitting
 * between them.
 */
const FURNITURE_LINE: readonly RegExp[] = [
  /^\s*(?:reactivate|upgrade to|try) premium/i,
  /^\s*get (?:ai-powered|personali[sz]ed|more) /i,
  /^\s*take the next step/i,
  /^\s*determine your fit/i,
  /^\s*practice an interview/i,
  /^\s*(?:welcome|hi|hello),\s+[A-Z]/,
  /^\s*(?:are these results|was this helpful)/i,
  /^\s*people you can reach out to/i,
  /^\s*meet the hiring team/i,
  /^\s*(?:job poster|school alumni|show all|see all)\s*$/i,
  /^\s*application (?:status|submitted)\s*$/i,
  /^\s*(?:promoted|promoted by hirer)/i,
  /^\s*over \d[\d,]* applicants/i,
  /^\s*\d+ (?:applicants|people clicked apply)/i,
  /^\s*(?:easily apply|easy apply|apply with indeed|save|share|report this job)\s*$/i,
  /^\s*here.s how the job details align/i,
  /^\s*pulled from the full job description\s*$/i,
  /^\s*(?:jobs for you|jobs based on your preferences|similar jobs|people also viewed)/i,
  /^\s*(?:actively reviewing applicants|be an early applicant)/i,
  /^\s*(?:viewed|saved|applied)\s*[·•]/i,
  /^\s*\d+ (?:min|hour|day|week|month)s? ago\s*$/i,
];

/**
 * Furniture that shares a line with something worth keeping.
 *
 * "Manchester Area, United Kingdom · 1 week ago · Over 100 applicants" is a
 * location and two pieces of site metadata on one line. Dropping the line loses
 * the location; keeping it leaves an applicant count to be read as a number.
 * These are scrubbed from within the line instead.
 */
const FURNITURE_SEGMENT: readonly RegExp[] = [
  /\s*[·•|]\s*(?:over\s+)?\d[\d,]*\+?\s*applicants?\b/gi,
  /\s*[·•|]\s*\d+\s*(?:second|minute|min|hour|day|week|month)s?\s*ago\b/gi,
  /\s*[·•|]\s*(?:promoted(?:\s+by\s+hirer)?|actively reviewing applicants|be an early applicant|easily apply|easy apply)\b/gi,
  /\s*[·•|]\s*reposted\b[^·•|\n]*/gi,
];

/** Where it stops being the advert and becomes the site again. */
const CONTENT_ENDS =
  /^[^\S\n]*(?:similar jobs|people also viewed|more jobs (?:like|from)|jobs you may be interested in|set (?:a )?job alert|show more jobs|related searches|looking for talent|report this job)[^\S\n]*$/im;

/** The smallest run of text still worth treating as the content. */
const MIN_NARROWED_LENGTH = 300;

/**
 * Remove the site's own furniture, keeping everything else.
 *
 * Subtractive on purpose. Slicing from a marker like "About the job" removed the
 * upsells but also removed the header block above them — so a page lost its
 * title, its company and its salary in order to lose an advert for Premium.
 */
export function narrowToContent(text: string): string {
  const kept = text
    .split("\n")
    .filter((line) => !FURNITURE_LINE.some((pattern) => pattern.test(line)))
    .map((line) => {
      let scrubbed = line;
      for (const segment of FURNITURE_SEGMENT) scrubbed = scrubbed.replace(segment, "");
      return scrubbed.replace(/\s*[·•|]\s*$/, "").trimEnd();
    })
    .join("\n");

  const end = CONTENT_ENDS.exec(kept);
  const trimmed = end && end.index >= MIN_NARROWED_LENGTH ? kept.slice(0, end.index) : kept;

  // Never narrow to nothing; a page with no recognisable furniture is unchanged.
  return trimmed.trim().length >= MIN_NARROWED_LENGTH ? trimmed.trim() : text.trim();
}
const FURNITURE_HEADING = new RegExp(
  "^(?:" +
    [
      // Feedback and survey widgets
      "are these", "was this", "how (?:did|was)", "rate\\b", "feedback",
      "jobs for you", "job details", "job post details", "full job description", "your profile",
      // Controls
      "share\\b", "save\\b", "(?:easy\\s+)?apply\\b", "sign in", "log in", "message\\b",
      // Upsells and coaching prompts — these are what named a saved job
      // "Determine your fit and how to stand out".
      "determine your fit", "take the next step", "get personalali?sed", "get ai-powered",
      "practice an interview", "premium", "reactivate", "upgrade",
      // September 2026: LinkedIn's first heading on a job page is now an AI
      // upsell, and it titled a brief "Use AI to assess how you fit".
      "use ai\\b", "assess how you fit",
      // Page sections that are about the site, not the content
      "application status", "people you can reach", "meet the hiring team", "job poster",
      "school alumni", "show all", "create (?:a )?(?:job )?alert", "job alert",
      "similar jobs", "people also", "recommended for you", "more jobs", "jobs? based on",
      // Section names, not titles: falling back to the document title beats
      // naming a job "About the job".
      "about the (?:job|company|role)", "set (?:a )?(?:job )?alert",
      "search\\b", "filters?\\b", "messaging", "notifications", "promoted", "suggested",
    ].join("|") +
    ")\\b",
  "i",
);

/**
 * A greeting is not a title.
 *
 * Checked separately because the list above is joined with a trailing \b, and
 * there is no word boundary after the comma in "Welcome, Sayam" — so it silently
 * never matched, and a job was saved under the user's own greeting.
 */
const GREETING = /^(?:welcome|hi|hey|hello|good (?:morning|afternoon|evening))\s*[,!]/i;

export function isFurnitureHeading(heading: string): boolean {
  const text = heading.trim();
  if (text.length < 3 || text.length > 120) return true;
  if (GREETING.test(text)) return true;
  if (FURNITURE_HEADING.test(text)) return true;
  // A heading that is only a question is asking the reader something, not naming
  // the page — "Are these results helpful?", "Know someone who'd be a good fit?".
  return text.endsWith("?");
}
