import type { Surface, Urgency } from "@core/types";

/** The small chip above the headline: what kind of page this is. */
export function surfaceChip(surface: Surface): string {
  switch (surface) {
    case "email": return "Email";
    case "invoice": return "Invoice";
    case "job": return "Job advert";
    case "generic": return "Page";
  }
}

/**
 * The headline answers the question the user actually has, which is "is there
 * anything here for me?" — not "what did you classify this as". The chip above it
 * already says that.
 */
export function attentionHeadline(
  problemCount: number,
  suggestionCount: number,
  allEligibility = false,
): string {
  /*
   * An eligibility condition does not "need you" — you cannot do anything about
   * being asked for security clearance. What it needs is checking, before an hour
   * goes into an application you were never eligible for.
   */
  if (allEligibility && problemCount === 1) return "One thing to check first";
  if (allEligibility && problemCount > 1) return `${problemCount} things to check first`;

  if (problemCount === 1) return "One thing needs you";
  if (problemCount > 1) return `${problemCount} things need you`;
  if (suggestionCount > 0) return "Nothing urgent — but I can help";
  return "Nothing needs you here";
}

export function urgencyWord(urgency: Urgency): string {
  switch (urgency) {
    case "overdue": return "Overdue";
    case "today": return "Today";
    case "soon": return "Soon";
    case "later": return "Later";
  }
}

export function relativeTime(at: number, now: number): string {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/**
 * An amount as a person reads it.
 *
 * Amounts are stored as "GBP 70000–85000": a currency code and unpunctuated
 * digits, which is the right shape for comparing and converting and the wrong one
 * for showing anybody. The job brief put that string straight on screen, where it
 * read like a database row.
 *
 * Anything that is not in the stored shape is passed through untouched — a salary
 * the advert wrote as "Competitive" is still the most honest thing to show.
 */
export { displayMoney } from "../core/money";

/**
 * The headline on a job advert.
 *
 * "Nothing urgent — but I can help" sat above a brief holding the pay, the
 * closing date and six requirements. Technically true — nothing was overdue —
 * and useless, because the page plainly had something to say. A job advert gets
 * a headline about the job.
 */
export function jobHeadline(brief: {
  blockers: number;
  requirements: number;
  hasSalary: boolean;
}): string | undefined {
  if (brief.blockers === 1) return "One condition would rule you out";
  if (brief.blockers > 1) {
    const word = ["", "One", "Two", "Three", "Four", "Five", "Six"][brief.blockers] ?? String(brief.blockers);
    return `${word} conditions would rule you out`;
  }

  // Nothing to warn about, but something worth reading: say so plainly.
  if (brief.requirements > 0 || brief.hasSalary) return "Here is this job, in short";

  return undefined;
}
