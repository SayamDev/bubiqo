/**
 * The domain model, in code. Every name here is defined in /CONTEXT.md and is
 * used with exactly that meaning throughout the codebase.
 *
 * Nothing in core/ may import from `chrome.*`, the DOM, or React. The engines are
 * pure functions over plain data so they can be tested in Node and reused from the
 * service worker, the content script and the side panel alike. Adapters at the
 * edges do the talking to the browser.
 */

// ---------------------------------------------------------------------------
// Page Context
// ---------------------------------------------------------------------------

/** The kind of thing a page is. Exactly one per Page Context. */
export type Surface = "email" | "invoice" | "job" | "generic";

/** A form field observed on the page, used to spot unfinished work. */
export interface ObservedField {
  readonly label: string;
  readonly type: string;
  readonly filled: boolean;
  readonly required: boolean;
}

/**
 * What Bubiqo understands about the page the user is looking at right now.
 * Derived per analysis, never persisted in full.
 */
export interface PageContext {
  readonly url: string;
  readonly domain: string;
  readonly title: string;
  /** Visible text, already truncated and stripped by the content adapter. */
  readonly text: string;
  readonly headings: readonly string[];
  readonly fields: readonly ObservedField[];
  /** JSON-LD / microdata found on the page, if any. */
  readonly structuredData: readonly Record<string, unknown>[];
  /** Visible links, so an "apply" or "pay" destination can be recognised. */
  readonly links: readonly { readonly text: string; readonly href: string }[];
  /**
   * What the extractor decided, so a bad reading can be diagnosed instead of
   * guessed at. Two rounds of fixes were aimed at the wrong layer because the only
   * evidence available was a screenshot of the result.
   */
  readonly extraction?: {
    readonly candidates: number;
    readonly chosenChars: number;
    readonly regionChars: number;
    readonly linkDensity: number;
    readonly usedWholeRegion: boolean;
  };
  /** Text the user had selected when analysis ran, if any. */
  readonly selection?: string;
  readonly capturedAt: number;
}

export interface Classification {
  readonly surface: Surface;
  readonly confidence: number;
  /** Plain-English reason, shown to the user on request. */
  readonly rationale: string;
}

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

export type EntityType =
  | "person"
  | "organisation"
  | "date"
  | "time"
  | "deadline"
  | "address"
  | "phone"
  | "email"
  | "amount"
  | "currency"
  | "reference"
  | "job_title"
  | "skill"
  | "requirement"
  | "url";

/**
 * How careful we must be with an Entity's value.
 * `sensitive` entities are never written to Activity and never leave the device.
 */
export type Sensitivity = "public" | "personal" | "sensitive";

export interface Entity {
  readonly type: EntityType;
  readonly value: string;
  readonly confidence: number;
  /** The snippet of page text this came from, for the "why?" explanation. */
  readonly source: string;
  readonly sensitivity: Sensitivity;
  /** Epoch ms, present only for date/time/deadline entities that resolved. */
  readonly resolvedAt?: number;
}

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

export type IntentKind =
  | "applying"
  | "replying"
  | "scheduling"
  | "paying"
  | "booking"
  | "researching"
  | "completing"
  | "reviewing"
  | "following_up"
  | "saving"
  | "organising"
  | "planning";

export interface Intent {
  readonly kind: IntentKind;
  readonly confidence: number;
  readonly rationale: string;
}

// ---------------------------------------------------------------------------
// Problem
// ---------------------------------------------------------------------------

export type ProblemKind =
  | "deadline"
  | "commitment"
  | "unanswered_question"
  | "pending_response"
  | "upcoming_event"
  | "unfinished_form"
  | "payment_due"
  | "eligibility";

export type Urgency = "overdue" | "today" | "soon" | "later";

export interface Problem {
  readonly kind: ProblemKind;
  /** One line, in the user's language, no jargon. */
  readonly summary: string;
  readonly urgency: Urgency;
  readonly confidence: number;
  /** The exact page text that triggered this. Shown under "why?". */
  readonly evidence: string;
  readonly dueAt?: number;
}

// ---------------------------------------------------------------------------
// Action, Risk, Suggestion
// ---------------------------------------------------------------------------

/** See CONTEXT.md. `blocked` means never, not "after a warning". */
export type Risk = "safe" | "confirm" | "blocked";

export interface ActionResult {
  readonly ok: boolean;
  /** Shown to the user verbatim. Must be plain English. */
  readonly message: string;
  /** Opaque handle the verifier and the undo path use to find what was made. */
  readonly handle?: string;
  readonly undoable: boolean;
}

export type VerificationOutcome = "confirmed" | "unconfirmed" | "failed";

export interface VerificationResult {
  readonly outcome: VerificationOutcome;
  readonly message: string;
}

export interface ActionInput {
  readonly page: PageContext;
  readonly entities: readonly Entity[];
  readonly problems: readonly Problem[];
  readonly params: Readonly<Record<string, string | number | boolean>>;
}

/**
 * A registered operation. The registry is a closed set: nothing outside it can be
 * executed, and in particular nothing a language model proposes can be executed
 * unless it names a registered id and passes validation.
 */
export interface ActionDefinition {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly risk: Risk;
  /** Chrome permissions this action needs. Checked before execution. */
  readonly permissions: readonly string[];
  readonly canUndo: boolean;
  /** Whether this action makes sense for the given context at all. */
  readonly applies: (input: ActionInput) => boolean;
  readonly execute: (input: ActionInput) => Promise<ActionResult>;
  readonly verify: (result: ActionResult) => Promise<VerificationResult>;
  readonly undo?: (result: ActionResult) => Promise<ActionResult>;
}

export interface Suggestion {
  readonly actionId: string;
  readonly name: string;
  readonly risk: Risk;
  /** Plain English. A Suggestion with no rationale is a bug. */
  readonly rationale: string;
  readonly score: number;
  readonly params: Readonly<Record<string, string | number | boolean>>;
}

// ---------------------------------------------------------------------------
// Analysis — the whole output of one pass over a page
// ---------------------------------------------------------------------------

export interface Analysis {
  readonly classification: Classification;
  readonly entities: readonly Entity[];
  readonly intents: readonly Intent[];
  readonly problems: readonly Problem[];
  readonly suggestions: readonly Suggestion[];
  /** True when page content tried to issue instructions. See core/sanitize.ts. */
  readonly injectionAttempted: boolean;
}

// ---------------------------------------------------------------------------
// Memory, Activity, Reminders
// ---------------------------------------------------------------------------

export type MemoryKind = "job" | "invoice" | "trip" | "task" | "contact" | "note";

export interface MemoryItem {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly title: string;
  /** Extracted entities only. Never raw page or email bodies. */
  readonly entities: readonly Entity[];
  readonly url?: string;
  readonly savedAt: number;
  readonly notes?: string;
}

export type ActivityKind =
  | "detected"
  | "suggested"
  | "approved"
  | "executed"
  | "verified"
  | "failed"
  | "undone"
  | "blocked";

export interface ActivityEvent {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly at: number;
  readonly summary: string;
  readonly actionId?: string;
}

export interface Reminder {
  readonly id: string;
  readonly title: string;
  readonly dueAt: number;
  readonly url?: string;
  readonly createdAt: number;
  readonly fired: boolean;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** How proactive the extension is allowed to be. Default is "helpful". */
export type ProactivityMode = "quiet" | "helpful" | "proactive";

/** What the panel looks like. "system" follows the OS. */
export type ThemeChoice = "system" | "light" | "dark";

export interface Settings {
  readonly mode: ProactivityMode;
  readonly theme: ThemeChoice;
  readonly disabledDomains: readonly string[];
  readonly disabledActionIds: readonly string[];
  readonly currencyConversion: boolean;
  readonly homeCurrency: string;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: "helpful",
  theme: "system",
  disabledDomains: [],
  disabledActionIds: [],
  currencyConversion: false,
  homeCurrency: "GBP",
};
