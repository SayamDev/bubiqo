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
   * Narrow before reasoning. Block scoring chooses a region of the DOM; this
   * removes the site's own furniture from inside it — upsells, applicant counts,
   * the hiring team — which is what put a Premium heading on a saved job and a
   * skill in an advert that never mentioned it.
   */
  const content = narrowToContent(page.text);

  // Page text is untrusted input. It is cleaned before anything reasons about it.
  const cleaned = sanitise(content);
  const safePage: PageContext = { ...page, text: cleaned.text };

  const classification = classify(safePage);
  const entities = extractEntities(safePage, options.now);
  const intents = detectIntents(safePage, classification.surface, entities);
  const allProblems = scanForProblems(safePage, classification.surface, entities, options.now);

  /*
   * Quiet answers when asked; it does not tap you on the shoulder. Only things
   * that are actually pressing survive. Proactive shows everything found.
   */
  const problems =
    options.settings.mode === "quiet"
      ? allProblems.filter((p) => p.urgency === "overdue" || p.urgency === "today")
      : allProblems;

  const input: ActionInput = { page: safePage, entities, problems, params: {} };

  const suggestions = rankSuggestions(registry, input, {
    surface: classification.surface,
    entities,
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
  };
}

/** Build the ActionInput matching an Analysis, for handing to the Executor. */
export function toActionInput(page: PageContext, analysis: Analysis): ActionInput {
  return { page, entities: analysis.entities, problems: analysis.problems, params: {} };
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
