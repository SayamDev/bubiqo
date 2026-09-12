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
