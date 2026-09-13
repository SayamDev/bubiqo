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
  /** A condition that rules the reader out. Carries the advert's own sentence. */
  | "blocker"
  /** Something the advert asks for, quoted in its own words. */
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
// Job Brief
// ---------------------------------------------------------------------------

/** Whether a fact was stated by the site in structured data, or read from prose. */
export type BriefSource = "structured" | "prose";

/**
 * A single fact in a Brief, carrying where it came from.
 *
 * The provenance is not decoration. A salary the site published in its own
 * JobPosting block is a different kind of claim from a salary matched out of a
 * sentence beside a sidebar, and the user is entitled to know which they are
 * looking at before they act on it.
 */
export interface BriefField<T> {
  readonly value: T;
  readonly source: BriefSource;
  /** The sentence it was read from, or the JSON-LD property it came out of. */
  readonly evidence: string;
  readonly confidence: number;
}

/**
 * A condition that rules the reader out of applying.
 *
 * Never inferred without a quote: `summary` is our words, `evidence` is the
 * advert's, and `rule` names the rule that fired so a match can be traced in a
 * test and explained in the panel.
 */
export interface Blocker {
  readonly summary: string;
  readonly evidence: string;
  readonly rule: string;
}

/**
 * The answer to the only question a job advert is read to settle: is this worth
 * an hour of my time.
 *
 * Not a tracking record and not a CV match. Deal-breakers, money, closing date,
 * working pattern — and the advert's own eligibility wording, quoted rather than
 * classified, so a condition nobody wrote a rule for still reaches the reader.
 */
export interface JobBrief {
  readonly title?: BriefField<string>;
  readonly organisation?: BriefField<string>;
  readonly location?: BriefField<string>;
  readonly salary?: BriefField<string>;
  /** Epoch ms. Absent rather than wrong when the advert's date is ambiguous. */
  readonly closingDate?: BriefField<number>;
  readonly employmentType?: BriefField<string>;
  /** On-site days, hybrid, or remote. */
  readonly workingPattern?: BriefField<string>;
  readonly blockers: readonly Blocker[];
  /** The advert's own eligibility lines, quoted verbatim and capped. */
  readonly eligibility: readonly string[];
  /**
   * Present only when a blocking rule matched. There is deliberately no positive
   * verdict: telling someone they are eligible when they are not is the one error
   * that costs them a real opportunity, and these rules are not good enough to
   * earn that claim.
   */
  readonly verdict?: "ruled_out";
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
  /**
   * The Job Brief, on a job advert.
   *
   * Actions that save or copy prefer it to the raw Entity list, because the Entity
   * list is everything found on the page and the Brief is what the page is about.
   * A saved job read "CURRENCY GBP / AMOUNT ×3 / ORGANISATION New" — three of
   * those amounts belonged to other adverts and "New" was a badge.
   */
  readonly brief?: JobBrief;
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
  /**
   * Whether this came from text the user selected rather than the whole page.
   *
   * Selecting is the one unambiguous way to say which part of a page you mean,
   * and it cannot be broken by a site redesign.
   */
  readonly fromSelection: boolean;
  /** Present only for the `job` Surface. See core/job-brief.ts. */
  readonly brief?: JobBrief;
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
