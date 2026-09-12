/**
 * The safety layer.
 *
 * Two rules hold the product up, and they are enforced here rather than by
 * convention:
 *
 *   1. Only registered Actions can run. There is no path from text — page content,
 *      a user's typed command, or a language model's output — to executing anything
 *      that is not already in the registry.
 *   2. `blocked` means never. Not "never without confirmation": never. A blocked
 *      Action has no execution path at all, so no sequence of approvals reaches it.
 *
 * Rule 2 is what makes the payment and credential guarantees in PRIVACY.md and
 * SECURITY.md true statements about the code rather than promises about intent.
 */

import type { ActionDefinition, Risk, Settings } from "./types";

/**
 * Categories that are permanently off limits, whatever an Action calls itself.
 * Checked at registration time, so a mis-declared Action fails loudly on startup
 * rather than quietly at execution.
 */
const FORBIDDEN_CATEGORIES: readonly string[] = [
  "payment",
  "purchase",
  "transfer",
  "credential",
  "security_setting",
  "account_deletion",
];

export class BlockedActionError extends Error {
  constructor(actionId: string, reason: string) {
    super(`Refused to run "${actionId}": ${reason}`);
    this.name = "BlockedActionError";
  }
}

export class UnknownActionError extends Error {
  constructor(actionId: string) {
    super(`Refused to run "${actionId}": no such registered action.`);
    this.name = "UnknownActionError";
  }
}

export interface PermissionDecision {
  readonly allowed: boolean;
  /** Present when the action may run but the user must approve it first. */
  readonly requiresApproval: boolean;
  readonly reason: string;
}

/**
 * Decide whether an Action may run in this context.
 *
 * Called by the executor before every single execution, including steps inside a
 * every step inside Complete It. There is no "trusted" caller that skips it.
 */
export function decide(
  action: ActionDefinition | undefined,
  actionId: string,
  settings: Settings,
  domain: string,
): PermissionDecision {
  if (!action) {
    return { allowed: false, requiresApproval: false, reason: `"${actionId}" is not a registered action.` };
  }

  if (action.risk === "blocked" || FORBIDDEN_CATEGORIES.includes(action.category)) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: "This kind of action is never performed automatically. You need to do it yourself.",
    };
  }

  if (settings.disabledActionIds.includes(action.id)) {
    return { allowed: false, requiresApproval: false, reason: "You turned this suggestion off." };
  }

  if (settings.disabledDomains.includes(domain)) {
    return { allowed: false, requiresApproval: false, reason: `You turned Bubiqo off for ${domain}.` };
  }

  if (action.risk === "confirm") {
    return { allowed: true, requiresApproval: true, reason: "This changes something outside your machine, so it needs your approval." };
  }

  return { allowed: true, requiresApproval: false, reason: "Safe: this only reads the page or saves something on your machine." };
}

/**
 * Validate an Action at registration time.
 *
 * Throws rather than returning, because a registry containing a mis-declared Action
 * is a broken build, not a runtime condition to handle.
 */
export function assertWellFormed(action: ActionDefinition): void {
  if (FORBIDDEN_CATEGORIES.includes(action.category) && action.risk !== "blocked") {
    throw new Error(
      `Action "${action.id}" is in forbidden category "${action.category}" but declares risk "${action.risk}". ` +
        `Forbidden categories must be declared "blocked".`,
    );
  }
  if (action.canUndo && !action.undo) {
    throw new Error(`Action "${action.id}" claims it can be undone but provides no undo().`);
  }
  if (!action.canUndo && action.undo) {
    throw new Error(`Action "${action.id}" provides undo() but declares canUndo: false.`);
  }
}

/** Human-readable risk label for the UI. Never shows the raw enum. */
export function riskLabel(risk: Risk): string {
  switch (risk) {
    case "safe":
      return "Safe";
    case "confirm":
      return "Needs your approval";
    case "blocked":
      return "Never automatic";
  }
}

/**
 * Validate parameters a model or command bar proposed for an Action.
 *
 * Only string, number and boolean primitives are accepted, and strings are length
 * capped. Nothing structured gets through, so there is nothing to smuggle.
 */
export function sanitiseParams(
  raw: unknown,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (typeof raw !== "object" || raw === null) return out;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z][a-zA-Z0-9_]{0,30}$/.test(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, 2000);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
  }
  return out;
}
