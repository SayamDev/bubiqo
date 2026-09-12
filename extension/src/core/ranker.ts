/**
 * Turning detections into at most three Suggestions.
 *
 * The cap is a product decision, not a performance one. Fifteen recommendations is
 * the same as none: the user stops reading. Three forces the ranking to be right.
 *
 * Every Suggestion carries a rationale traced to the Entity or Problem that produced
 * it, because a suggestion the user cannot interrogate is one they will not trust.
 */

import type {
  ActionDefinition,
  ActionInput,
  Entity,
  Intent,
  Problem,
  ProactivityMode,
  Settings,
  Suggestion,
  Surface,
  Urgency,
} from "./types";
import { formatDue } from "./dates";

export const MAX_PRIMARY_SUGGESTIONS = 3;

/**
 * How much has to be worth saying before Bubiqo says it.
 *
 * This is what the Quiet / Helpful / Proactive setting actually controls. It was
 * stored and never read, which made it a control that lied — the worst kind,
 * because the user changes it, sees no difference, and concludes the whole panel
 * is decorative.
 */
const FLOOR_BY_MODE: Readonly<Record<ProactivityMode, number>> = {
  quiet: 0.62,     // only what it is confident about, and little of it
  helpful: 0.35,   // the default
  proactive: 0.22, // anything plausibly useful
};

const LIMIT_BY_MODE: Readonly<Record<ProactivityMode, number>> = {
  quiet: 1,
  helpful: 5,
  proactive: 8,
};

const URGENCY_BONUS: Readonly<Record<Urgency, number>> = { overdue: 0.4, today: 0.3, soon: 0.15, later: 0 };

/** Which actions each Surface naturally wants, and how strongly. */
const SURFACE_AFFINITY: Readonly<Record<Surface, Readonly<Record<string, number>>>> = {
  email: { create_reminder: 0.5, draft_reply: 0.45, create_task: 0.4, export_calendar_event: 0.3, save_to_memory: 0.2, copy_details: 0.1 },
  invoice: { create_reminder: 0.55, save_to_memory: 0.45, copy_details: 0.3, export_calendar_event: 0.25, draft_reply: 0.05 },
  /*
   * Opening the application is the obvious next step on a job advert, so its
   * affinity has to clear BOTH the relevance floor and the 0.2 penalty every
   * confirm-risk action carries. At 0.45 it scored 0.25 against a floor of 0.35
   * and was silently never offered, despite the link being extracted correctly.
   */
  job: { save_to_memory: 0.55, create_reminder: 0.45, open_application_link: 0.62, copy_details: 0.35, export_calendar_event: 0.2, create_task: 0.2 },
  generic: { save_to_memory: 0.3, create_reminder: 0.25, copy_details: 0.25, export_calendar_event: 0.2 },
};

export interface RankingContext {
  readonly surface: Surface;
  readonly entities: readonly Entity[];
  readonly problems: readonly Problem[];
  readonly intents: readonly Intent[];
  readonly settings: Settings;
  readonly now: number;
  /** Action ids the user has accepted before, which nudges them up. */
  readonly previouslyAccepted?: readonly string[];
  /** Action ids the user has dismissed here before, which pushes them down. */
  readonly previouslyDismissed?: readonly string[];
}

export function rankSuggestions(
  registry: ReadonlyMap<string, ActionDefinition>,
  input: ActionInput,
  ctx: RankingContext,
): Suggestion[] {
  const suggestions: Suggestion[] = [];

  for (const action of registry.values()) {
    // Blocked actions are never suggested. They exist so the refusal is visible
    // in the UI, not so they can be offered and then denied.
    if (action.risk === "blocked") continue;
    if (ctx.settings.disabledActionIds.includes(action.id)) continue;
    if (!action.applies(input)) continue;

    const affinity = SURFACE_AFFINITY[ctx.surface][action.id] ?? 0.1;
    let score = affinity;

    /*
     * A page can be two things at once. A recruiter email IS an email — it wants a
     * reply, it has a sender — but it also carries a role and a company, and the
     * useful action there is to save the job, which the email affinity ranks low.
     * Surface picks the shape; the entities present can still argue for an action
     * the shape alone would bury.
     */
    const carriesAJob = ctx.entities.some((e) => e.type === "job_title");
    if (carriesAJob && (action.id === "save_to_memory" || action.id === "copy_details")) {
      score += 0.3;
    }

    const { rationale, bonus } = explain(action.id, ctx);
    score += bonus;

    if (ctx.previouslyAccepted?.includes(action.id)) score += 0.15;
    if (ctx.previouslyDismissed?.includes(action.id)) score -= 0.3;

    // Anything needing approval must clearly beat a safe alternative to be offered.
    if (action.risk === "confirm") score -= 0.2;

    if (score < FLOOR_BY_MODE[ctx.settings.mode]) continue;

    suggestions.push({
      actionId: action.id,
      name: action.name,
      risk: action.risk,
      rationale,
      score: Math.min(1, score),
      params: {},
    });
  }

  return suggestions.sort((a, b) => b.score - a.score).slice(0, LIMIT_BY_MODE[ctx.settings.mode]);
}

/** The primary three, and the rest behind "More actions". */
export function splitSuggestions(all: readonly Suggestion[]): { primary: Suggestion[]; more: Suggestion[] } {
  return {
    primary: all.slice(0, MAX_PRIMARY_SUGGESTIONS),
    more: all.slice(MAX_PRIMARY_SUGGESTIONS),
  };
}

/**
 * The "why?" text, plus the urgency weight that comes with it.
 *
 * Written as sentences a person would say. Never "LLM confidence 0.82".
 */
function explain(actionId: string, ctx: RankingContext): { rationale: string; bonus: number } {
  const deadline = ctx.problems.find((p) => p.kind === "deadline" || p.kind === "payment_due");
  const event = ctx.problems.find((p) => p.kind === "upcoming_event");
  const question = ctx.problems.find((p) => p.kind === "unanswered_question");
  const commitment = ctx.problems.find((p) => p.kind === "commitment");
  const waiting = ctx.problems.find((p) => p.kind === "pending_response");

  switch (actionId) {
    case "create_reminder": {
      if (deadline?.dueAt) {
        /*
         * A named deadline earns a flat bonus on top of the urgency weighting.
         * Not forgetting things is the product's core claim (§12), so when a page
         * states a deadline, "create a reminder" leads — a deadline three weeks
         * out is still the thing most likely to be forgotten.
         */
        return {
          rationale: `We found a deadline: “${clip(deadline.evidence)}” — ${formatDue(deadline.dueAt, ctx.now)}.`,
          bonus: 0.25 + URGENCY_BONUS[deadline.urgency],
        };
      }
      if (commitment) return { rationale: `${commitment.summary} A reminder keeps it from slipping.`, bonus: 0.15 };
      return { rationale: "A date on this page looks worth being reminded about.", bonus: 0 };
    }

    case "export_calendar_event": {
      if (event?.dueAt) {
        return {
          rationale: `Something is scheduled here: ${formatDue(event.dueAt, ctx.now)}.`,
          bonus: URGENCY_BONUS[event.urgency],
        };
      }
      return { rationale: "A date and time on this page can go straight into your calendar.", bonus: 0 };
    }

    case "draft_reply": {
      if (question) return { rationale: `${question.summary} A draft gets you most of the way.`, bonus: 0.25 };
      if (waiting) return { rationale: `${waiting.summary}`, bonus: 0.2 };
      return { rationale: "This looks like a message that expects an answer.", bonus: 0 };
    }

    case "create_task": {
      if (commitment) return { rationale: `${commitment.summary}`, bonus: 0.2 };
      if (question) return { rationale: `${question.summary}`, bonus: 0.15 };
      return { rationale: "There is something here worth tracking.", bonus: 0 };
    }

    case "save_to_memory": {
      const role = ctx.entities.find((e) => e.type === "job_title");
      const company = ctx.entities.find((e) => e.type === "organisation");
      if (role) {
        // Name the thing being saved. "7 details" tells the user nothing — and do
        // not promise dates on an advert that states none.
        const hasDate = ctx.entities.some((e) => e.resolvedAt !== undefined);
        const extras = hasDate ? "its dates, pay and requirements" : "the pay and requirements";
        return {
          rationale: company
            ? `Keeps the ${role.value} role at ${company.value}, and ${extras}, in one place.`
            : `Keeps the ${role.value} role, and ${extras}, in one place.`,
          bonus: 0.15,
        };
      }
      if (ctx.surface === "job") return { rationale: "Saving the role keeps the requirements and the closing date together.", bonus: 0.15 };
      if (ctx.surface === "invoice") return { rationale: "Saving the supplier, amount and reference means you won't reopen this page.", bonus: 0.15 };
      return { rationale: `There are ${ctx.entities.length} details here worth keeping.`, bonus: 0 };
    }

    case "copy_details":
      return { rationale: "The key details are ready to paste somewhere else.", bonus: 0 };

    case "open_application_link": {
      const company = ctx.entities.find((e) => e.type === "organisation");
      return {
        rationale: company
          ? `Opens the application for ${company.value} in a new tab. Nothing is submitted.`
          : "Opens the application page in a new tab. Nothing is submitted.",
        bonus: 0,
      };
    }

    default:
      return { rationale: "This looked relevant to what is on the page.", bonus: 0 };
  }
}

function clip(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 90 ? `${clean.slice(0, 90)}…` : clean;
}
