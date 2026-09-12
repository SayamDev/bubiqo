/**
 * Intent: what the user is probably trying to DO about this Surface.
 *
 * Surface answers "what is this page". Intent answers "why is the user on it",
 * which is what decides whether to offer "draft a reply" or "save this job".
 * Always held with a confidence; never asserted.
 */

import type { Entity, Intent, IntentKind, PageContext, Surface } from "./types";

interface Rule {
  readonly kind: IntentKind;
  readonly test: (ctx: { text: string; surface: Surface; entities: readonly Entity[] }) => boolean;
  readonly confidence: number;
  readonly rationale: string;
}

const RULES: readonly Rule[] = [
  {
    kind: "replying",
    confidence: 0.8,
    rationale: "Someone has asked you a direct question.",
    test: ({ text, surface }) =>
      surface === "email" && /\?\s*$|\?\s|\bcan you\b|\bcould you\b|\bwould you\b|\blet me know\b/im.test(text),
  },
  {
    kind: "following_up",
    confidence: 0.75,
    rationale: "The thread contains a promise that does not look closed.",
    test: ({ text }) => /\bi(?:'| a)?ll\s+(?:send|get|follow|come|revert|share|update)\b|\bi will\s+(?:send|get|share)\b/i.test(text),
  },
  {
    kind: "paying",
    confidence: 0.85,
    rationale: "This is an invoice with an amount payable.",
    test: ({ surface, entities }) => surface === "invoice" && entities.some((e) => e.type === "amount"),
  },
  {
    kind: "applying",
    confidence: 0.85,
    rationale: "This is a job advert you are reading.",
    test: ({ surface }) => surface === "job",
  },
  {
    kind: "scheduling",
    confidence: 0.8,
    rationale: "A specific date and time were mentioned.",
    test: ({ entities, text }) =>
      entities.some((e) => e.type === "time" || e.type === "date") &&
      /\b(?:meeting|call|interview|appointment|catch[- ]?up|standup|session)\b/i.test(text),
  },
  {
    kind: "completing",
    confidence: 0.7,
    rationale: "A deadline was detected on this page.",
    test: ({ entities }) => entities.some((e) => e.type === "deadline"),
  },
  {
    kind: "researching",
    confidence: 0.4,
    rationale: "No stronger signal than reading the page.",
    test: () => true,
  },
];

export function detectIntents(page: PageContext, surface: Surface, entities: readonly Entity[]): Intent[] {
  const ctx = { text: page.text, surface, entities };
  const intents: Intent[] = [];

  for (const rule of RULES) {
    if (rule.test(ctx)) {
      intents.push({ kind: rule.kind, confidence: rule.confidence, rationale: rule.rationale });
    }
  }

  // "researching" is the floor, not a finding: drop it if anything real fired.
  const real = intents.filter((i) => i.kind !== "researching");
  return (real.length > 0 ? real : intents).sort((a, b) => b.confidence - a.confidence).slice(0, 3);
}
