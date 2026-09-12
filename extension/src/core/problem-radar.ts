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

/**
 * Marketing filler that matches the commitment and request patterns but is never
 * something anyone has to act on. Bulk mail is full of it — "I'll get sharper with
 * the matches", "let me know if you have questions", "just hit reply".
 */
const BOILERPLATE =
  /\b(?:get sharper|fine[- ]tune|unsubscribe|hit reply|let me know if|any other questions|get back to you|be in touch|keep you posted|good fit|opted in)\b/i;

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

/**
 * Who wrote the first person in this text?
 *
 * On a page you are READING, "I'll send it over" is the sender speaking, not you.
 * Reporting it as "You said you would send it over" is not a small wording problem:
 * it invents a commitment the user never made, and the first time they see that
 * they stop trusting everything else on the panel.
 *
 * A From: header, or a signed-off message addressed to the reader, means the first
 * person belongs to someone else.
 */
function firstPersonIsTheSender(page: PageContext, surface: Surface): string | undefined {
  if (surface !== "email") return undefined;

  const from = /^\s*from\s*:\s*([^<\n]{2,60})/im.exec(page.text);
  if (from?.[1]) return from[1].trim().replace(/["']/g, "");

  /*
   * Gmail does not render a "From:" header — it shows "Archer
   * <archer@mail-hackajob.com>". A name immediately followed by an address is the
   * same signal, and without this every bulk email's "I'll ..." was being read as
   * something the user had promised.
   */
  const named = /([A-Z][A-Za-z'’-]{1,30}(?:\s+[A-Z][A-Za-z'’-]{1,30})?)\s*<[^@\s>]+@[^>\s]+>/.exec(page.text);
  if (named?.[1]) return named[1].trim();

  // A salutation to someone else plus a sign-off is the same shape.
  if (/^\s*(?:hi|hello|dear|hey)\s+[A-Z][a-z]+/m.test(page.text)) {
    const signoff = /\b(?:kind regards|best regards|regards|thanks|cheers|sincerely)[,!]?\s*\n+\s*([A-Z][a-z]{1,20})/i.exec(page.text);
    if (signoff?.[1]) return signoff[1].trim();
  }
  return undefined;
}

export function scanForProblems(
  page: PageContext,
  surface: Surface,
  entities: readonly Entity[],
  now: number,
): Problem[] {
  const text = page.text;
  const found: Problem[] = [];
  const sender = firstPersonIsTheSender(page, surface);

  // --- Deadlines -----------------------------------------------------------
  for (const e of entities) {
    if (e.type !== "deadline" || e.resolvedAt === undefined) continue;
    const urgency = describeUrgency(e.resolvedAt, now);
    const kind: ProblemKind = surface === "invoice" ? "payment_due" : "deadline";

    /*
     * Quote the clause rather than announcing that a deadline exists. "This page
     * sets a deadline" tells the user nothing they cannot already see; the words
     * that created it are the whole value.
     */
    const summary = kind === "payment_due" ? "This invoice has a payment date." : `Deadline: ${clause(e.source)}`;
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

  // --- Commitments --------------------------------------------------------
  for (const m of text.matchAll(COMMITMENT)) {
    const promise = (m[1] ?? "").trim();
    if (promise.length < 4) continue;
    if (BOILERPLATE.test(promise)) continue;

    if (sender) {
      /*
       * Someone else's promise to you. Still worth surfacing — it is a thing you
       * are waiting on — but at lower confidence and never as your own obligation.
       */
      found.push(problem("pending_response", `${sender} said they would ${promise}.`, "later", 0.5, m[0]));
    } else {
      found.push(problem("commitment", `You said you would ${promise}.`, "soon", 0.7, m[0]));
    }
  }

  // --- Requests aimed at the user ------------------------------------------
  for (const m of text.matchAll(REQUEST)) {
    const ask = ((m[1] ?? m[2]) ?? "").trim();
    if (ask.length < 4) continue;
    if (BOILERPLATE.test(ask)) continue;
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

/**
 * The clause around a date, trimmed to something readable in one line.
 *
 * Deliberately short and stopped at the first sentence break. A longer window ran
 * past the obligation into whatever followed it, which both read badly and put a
 * chunk of page prose into a stored reminder title — the opposite of the
 * data-minimisation this product claims.
 */
function clause(source: string): string {
  const clean = source.replace(/\s+/g, " ").trim();
  const cue =
    /\b(?:by|before|due|deadline|closes?|closing|expires?|no later than|respond by|reply by|apply by|submit by)\b[^.!?;\n]{0,40}/i.exec(
      clean,
    );
  const phrase = (cue?.[0] ?? clean.slice(0, 40)).trim().replace(/[.,;:]+$/, "");
  return phrase.length > 46 ? `${phrase.slice(0, 46).trimEnd()}…` : phrase;
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
