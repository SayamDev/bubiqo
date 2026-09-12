/**
 * Problem Radar: the part that stops you forgetting things.
 *
 * A Problem is not an error. It is something with a time dimension that the user
 * would be annoyed to miss: a deadline, a promise they made, a question aimed at
 * them, an event approaching, a form left half-finished.
 *
 * Precision matters more than recall here. Five accurate warnings a week get read;
 * twenty noisy ones get ignored, and then the accurate one is ignored too.
 */

import type { Entity, PageContext, Problem, ProblemKind, Surface, Urgency } from "./types";
import { describeUrgency } from "./dates";

/** First person future promises: "I'll send the deck", "I will get back to you". */
const COMMITMENT = /\b(?:I['’]?ll|I will|I'?m going to|I shall)\s+([a-z][a-z' ]{2,60}?)(?=[.,;!?\n]|$)/gi;

/** Requests aimed at the reader. */
const REQUEST =
  /\b(?:can|could|would|will)\s+you\s+([a-z][a-z' ]{2,60}?)(?=[?.,;!\n]|$)|\bplease\s+([a-z][a-z' ]{2,60}?)(?=[.,;!?\n]|$)/gi;

/** Someone waiting on the reader. */
const WAITING =
  /\b(?:waiting|awaiting|chasing|following up|any update|did you get a chance|gentle reminder|as discussed)\b[^.!?\n]{0,80}/gi;

const MEETING_WORDS = /\b(?:meeting|call|interview|appointment|catch[- ]?up|standup|session|webinar)\b/i;

function problem(
  kind: ProblemKind,
  summary: string,
  urgency: Urgency,
  confidence: number,
  evidence: string,
  dueAt?: number,
): Problem {
  const trimmed = evidence.replace(/\s+/g, " ").trim().slice(0, 240);
  return dueAt === undefined
    ? { kind, summary, urgency, confidence, evidence: trimmed }
    : { kind, summary, urgency, confidence, evidence: trimmed, dueAt };
}

export function scanForProblems(
  page: PageContext,
  surface: Surface,
  entities: readonly Entity[],
  now: number,
): Problem[] {
  const text = page.text;
  const found: Problem[] = [];

  // --- Deadlines -----------------------------------------------------------
  for (const e of entities) {
    if (e.type !== "deadline" || e.resolvedAt === undefined) continue;
    const urgency = describeUrgency(e.resolvedAt, now);
    const kind: ProblemKind = surface === "invoice" ? "payment_due" : "deadline";
    const summary =
      kind === "payment_due"
        ? "An invoice on this page has a payment date."
        : "This page sets a deadline.";
    found.push(problem(kind, summary, urgency, e.confidence, e.source, e.resolvedAt));
  }

  // --- Upcoming events -----------------------------------------------------
  if (MEETING_WORDS.test(text)) {
    for (const e of entities) {
      if (e.type !== "time" || e.resolvedAt === undefined) continue;
      if (e.resolvedAt < now) continue;
      found.push(
        problem("upcoming_event", "Something is scheduled on this page.", describeUrgency(e.resolvedAt, now), 0.75, e.source, e.resolvedAt),
      );
    }
  }

  // --- Commitments the user made ------------------------------------------
  for (const m of text.matchAll(COMMITMENT)) {
    const promise = (m[1] ?? "").trim();
    if (promise.length < 4) continue;
    found.push(problem("commitment", `You said you would ${promise}.`, "soon", 0.7, m[0]));
  }

  // --- Requests aimed at the user ------------------------------------------
  for (const m of text.matchAll(REQUEST)) {
    const ask = ((m[1] ?? m[2]) ?? "").trim();
    if (ask.length < 4) continue;
    found.push(problem("unanswered_question", `Someone asked you to ${ask}.`, "soon", 0.75, m[0]));
  }

  // --- Someone waiting -----------------------------------------------------
  for (const m of text.matchAll(WAITING)) {
    found.push(problem("pending_response", "Someone appears to be waiting on you.", "soon", 0.6, m[0]));
  }

  // --- Unfinished forms ----------------------------------------------------
  const required = page.fields.filter((f) => f.required);
  const emptyRequired = required.filter((f) => !f.filled);
  if (required.length >= 2 && emptyRequired.length > 0 && emptyRequired.length < required.length) {
    // Partly filled is the interesting case: a form never started is not forgotten work.
    found.push(
      problem(
        "unfinished_form",
        `This form has ${emptyRequired.length} required field${emptyRequired.length === 1 ? "" : "s"} left.`,
        "today",
        0.8,
        emptyRequired.map((f) => f.label).join(", "),
      ),
    );
  }

  return rank(dedupe(found));
}

function dedupe(problems: readonly Problem[]): Problem[] {
  const seen = new Map<string, Problem>();
  for (const p of problems) {
    const key = `${p.kind}::${p.summary.toLowerCase()}::${p.dueAt ?? ""}`;
    const existing = seen.get(key);
    if (!existing || p.confidence > existing.confidence) seen.set(key, p);
  }
  return [...seen.values()];
}

const URGENCY_ORDER: Readonly<Record<Urgency, number>> = { overdue: 0, today: 1, soon: 2, later: 3 };

function rank(problems: readonly Problem[]): Problem[] {
  return [...problems].sort((a, b) => {
    const byUrgency = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
    if (byUrgency !== 0) return byUrgency;
    return b.confidence - a.confidence;
  });
}
