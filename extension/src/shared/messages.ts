/**
 * The typed message protocol between the content script, the side panel and the
 * service worker. One discriminated union, so an unhandled case is a type error.
 */

import type { Analysis, MemoryItem, PageContext, Reminder, Settings, ActivityEvent } from "@core/types";
import type { Draft } from "@core/ports";
import type { StepOutcome, CompleteItReport } from "@core/executor";

export type Request =
  | { type: "ANALYSE_ACTIVE_TAB" }
  | { type: "PAGE_CONTEXT"; page: PageContext }
  | { type: "RUN_ACTION"; actionId: string; approved: boolean }
  | { type: "COMPLETE_IT" }
  | { type: "UNDO"; actionId: string; handle: string }
  | { type: "DISMISS_SUGGESTION"; actionId: string }
  | { type: "GET_STATE" }
  | { type: "GET_SETTINGS" }
  | { type: "SET_SETTINGS"; settings: Partial<Settings> }
  | { type: "GET_MEMORY" }
  | { type: "DELETE_MEMORY"; id: string }
  | { type: "GET_REMINDERS" }
  | { type: "DELETE_REMINDER"; id: string }
  | { type: "GET_ACTIVITY" }
  | { type: "CLEAR_ACTIVITY" }
  | { type: "GET_DRAFTS" }
  | { type: "DELETE_DRAFT"; id: string }
  | { type: "DOWNLOAD_CALENDAR"; handle: string }
  | { type: "BRIEFING" };

export interface PanelState {
  readonly page?: PageContext;
  readonly analysis?: Analysis;
  readonly settings: Settings;
  readonly reminders: readonly Reminder[];
  readonly memory: readonly MemoryItem[];
  readonly drafts: readonly Draft[];
  readonly activity: readonly ActivityEvent[];
  readonly analysedAt?: number;
  /** Set when the active tab cannot be analysed, e.g. a chrome:// page. */
  readonly unavailableReason?: string;
  /** True when the failure is a missing permission the user can grant. */
  readonly canRequestAccess?: boolean;
  /** Whether broad page-read access is currently held. */
  readonly pageAccessGranted?: boolean;
  /** Origin of the page just read, e.g. "https://mail.google.com". */
  readonly siteOrigin?: string;
  /** Whether standing access to that origin has already been granted. */
  readonly siteAccessGranted?: boolean;
  /** Present only on an invoice, only when the user switched conversion on. */
  readonly conversion?: {
    readonly from: string;
    readonly to: string;
    readonly amount: number;
    readonly converted: number;
    readonly rate: number;
    readonly stale: boolean;
  };
  /** Why no converted figure is shown, when one was expected. */
  readonly conversionUnavailable?: string;
}

export interface Briefing {
  readonly greeting: string;
  readonly dueToday: readonly Reminder[];
  readonly overdue: readonly Reminder[];
  readonly upcoming: readonly Reminder[];
  readonly openTasks: readonly MemoryItem[];
  /** "What might I be forgetting?" — saved things with no reminder attached. */
  readonly loose: readonly { title: string; why: string }[];
}

export type Response =
  | { type: "STATE"; state: PanelState }
  | { type: "STEP"; outcome: StepOutcome }
  | { type: "REPORT"; report: CompleteItReport }
  | { type: "BRIEFING"; briefing: Briefing }
  | { type: "CALENDAR_FILE"; filename: string; ics: string }
  | { type: "ERROR"; message: string };

export function send(request: Request): Promise<Response> {
  return chrome.runtime.sendMessage(request) as Promise<Response>;
}
