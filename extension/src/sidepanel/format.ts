import type { Surface, Urgency } from "@core/types";

/** Headline for the detected Surface. Plain words, never jargon. */
export function surfaceHeadline(surface: Surface): string {
  switch (surface) {
    case "email": return "Email detected";
    case "invoice": return "Invoice detected";
    case "job": return "Job advert detected";
    case "generic": return "Nothing urgent here";
  }
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
