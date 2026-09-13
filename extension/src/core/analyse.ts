/**
 * The analysis pipeline, in one place.
 *
 *   Page  ->  sanitise  ->  classify  ->  entities  ->  intents
 *         ->  problems  ->  rank  ->  Suggestions
 *
 * Pure: same PageContext and same `now` always give the same Analysis. That is what
 * makes the fixture tests meaningful and what keeps the side panel instant — no
 * network, no model, no waiting.
 */

import type { ActionDefinition, ActionInput, Analysis, PageContext, Settings } from "./types";
import { sanitise } from "./sanitize";
import { narrowToContent } from "./readability";
import { classify } from "./context-engine";
import { extractEntities } from "./entity-engine";
import { detectIntents } from "./intent-engine";
import { scanForProblems } from "./problem-radar";
import { rankSuggestions } from "./ranker";
import { buildJobBrief } from "./job-brief";

/**
 * Below this a selection is a stray click or a highlighted word, not an
 * instruction about what to read.
 */
const MIN_SELECTION_LENGTH = 120;

export interface AnalyseOptions {
  readonly settings: Settings;
  readonly now: number;
  readonly previouslyAccepted?: readonly string[];
  readonly previouslyDismissed?: readonly string[];
}

export function analyse(
  page: PageContext,
  registry: ReadonlyMap<string, ActionDefinition>,
  options: AnalyseOptions,
): Analysis {
  /*
   * If the user selected something, that is the answer.
   *
   * Everything else in this file is inference about which part of a page the user
   * means, and on a single-page application — a job board, a webmail client —
   * that inference is a losing game: the advert sits among sidebars, upsells and
   * twenty-five other job cards, all in the same container. Guessing produced a
   * salary belonging to a different job and a title taken from an advert for
   * Premium.
   *
   * A selection is not a guess. It works on every site, needs no knowledge of any
   * site's markup, and cannot be broken by a redesign. Automatic detection stays
   * for the ordinary pages where it genuinely works.
   */
  const selected = (page.selection ?? "").trim();
  const fromSelection = selected.length >= MIN_SELECTION_LENGTH;

  const content = fromSelection ? selected : narrowToContent(page.text);

  // Page text is untrusted input. It is cleaned before anything reasons about it.
  const cleaned = sanitise(content);

  /*
   * A selection carries no headings, so the rules that anchor to a page's title
   * had nothing to work with — an Indeed advert lost both its role and its
   * employer that way. When someone selects an advert they start at the top of
   * it, so the first line is the title.
   */
  const firstLine = fromSelection ? (cleaned.text.split("\n")[0] ?? "").trim() : "";
  const headings =
    fromSelection && firstLine.length > 2 && firstLine.length < 120
      ? [firstLine, ...page.headings]
      : page.headings;

  const safePage: PageContext = { ...page, text: cleaned.text, headings };

  const classification = classify(safePage);
  const entities = extractEntities(safePage, options.now);
  const intents = detectIntents(safePage, classification.surface, entities);
  /*
   * The brief is built before problems are scanned, because the eligibility
   * Problems come out of it. Only for job adverts: on an invoice there is nothing
   * for it to say.
   */
  const brief = classification.surface === "job" ? buildJobBrief(safePage, entities, options.now) : undefined;

  const allProblems = scanForProblems(safePage, classification.surface, entities, options.now, brief);

  /*
   * Quiet answers when asked; it does not tap you on the shoulder. Only things
   * that are actually pressing survive. Proactive shows everything found.
   */
  const problems =
    options.settings.mode === "quiet"
      ? allProblems.filter((p) => p.urgency === "overdue" || p.urgency === "today")
      : allProblems;

  const input: ActionInput = { page: safePage, entities, problems, params: {}, ...(brief ? { brief } : {}) };

  const suggestions = rankSuggestions(registry, input, {
    surface: classification.surface,
    entities,
    ...(brief ? { brief } : {}),
    problems,
    intents,
    settings: options.settings,
    now: options.now,
    ...(options.previouslyAccepted ? { previouslyAccepted: options.previouslyAccepted } : {}),
    ...(options.previouslyDismissed ? { previouslyDismissed: options.previouslyDismissed } : {}),
  });

  return {
    classification,
    entities,
    intents,
    problems,
    suggestions,
    injectionAttempted: cleaned.injectionAttempted,
    fromSelection,
    ...(brief ? { brief } : {}),
  };
}

/** Build the ActionInput matching an Analysis, for handing to the Executor. */
export function toActionInput(page: PageContext, analysis: Analysis): ActionInput {
  return {
    page,
    entities: analysis.entities,
    problems: analysis.problems,
    params: {},
    ...(analysis.brief ? { brief: analysis.brief } : {}),
  };
}

/**
 * "What do I need to do?" — the three-tier answer.
 *
 * Required is what someone explicitly asked for or a date demands. Suggested is what
 * follows from that. Optional is everything else worth offering.
 */
export interface TodoAnswer {
  readonly required: readonly string[];
  readonly suggested: readonly string[];
  readonly optional: readonly string[];
}

export function whatDoINeedToDo(analysis: Analysis): TodoAnswer {
  const required = analysis.problems
    .filter((p) => p.kind === "unanswered_question" || p.kind === "commitment" || p.urgency === "overdue")
    .map((p) => p.summary);

  const suggested = analysis.problems
    .filter((p) => (p.kind === "deadline" || p.kind === "payment_due" || p.kind === "upcoming_event") && p.urgency !== "overdue")
    .map((p) => p.summary);

  const optional = analysis.suggestions.slice(0, 3).map((s) => s.name);

  return {
    required: unique(required),
    suggested: unique(suggested),
    optional: unique(optional),
  };
}

/** "What's next?" — the single most useful step, or nothing. */
export function whatsNext(analysis: Analysis): { suggestion: string; why: string } | null {
  const top = analysis.suggestions[0];
  if (!top) return null;
  return { suggestion: top.name, why: top.rationale };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
