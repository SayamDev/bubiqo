/**
 * The service worker: the extension's only long-lived component.
 *
 * It owns the Ports, the registry and the executor, routes messages from the side
 * panel, and fires reminder alarms. It holds no page content: a PageContext lives
 * only as long as it takes to analyse it.
 *
 * MV3 service workers are terminated aggressively and restarted on demand. Nothing
 * here keeps state in memory that matters — everything durable is in chrome.storage,
 * re-read on each wake.
 */

import { analyse, toActionInput } from "@core/analyse";
import { amountToConvert } from "@core/currency";
import { buildRegistry } from "@core/actions";
import { Executor } from "@core/executor";
import { CostGuard, emptyUsage, type ProviderBudget, type ProviderUsage } from "@core/cost-guard";
import { DEFAULT_SETTINGS, type Analysis, type PageContext, type Settings } from "@core/types";
import type { Briefing, PanelState, Request, Response } from "@shared/messages";
import { createPorts, readCollection, STORAGE_KEYS } from "./adapters";
import { extractPageContext } from "./extract";
import {
  FrankfurterProvider,
  FRANKFURTER_PROVIDER_ID,
  FRANKFURTER_CACHE_TTL_MS,
  isUnavailable,
} from "../providers/frankfurter";

const ports = createPorts();
const registry = buildRegistry(ports);

/**
 * Deliberately conservative. Frankfurter publishes no quota at all, so this ceiling
 * is not protecting us from a bill — there is no paid tier to reach. It is here so
 * the product is a good citizen of a free service, and so that if their terms ever
 * change, the guard is already in the path. See COSTS.md.
 */
const BUDGETS = new Map<string, ProviderBudget>([
  [
    FRANKFURTER_PROVIDER_ID,
    {
      id: FRANKFURTER_PROVIDER_ID,
      providerLimitPerDay: "unpublished",
      safetyLimitPerDay: 200,
      safetyLimitPerHour: 40,
      cacheTtlMs: FRANKFURTER_CACHE_TTL_MS,
    },
  ],
]);

const guard = new CostGuard(BUDGETS, () => Date.now());

/**
 * Currency conversion. Constructed once; whether it may actually reach the network
 * is decided per call by `enabled`, which re-reads the setting each time, so turning
 * the setting off takes effect immediately rather than at the next worker restart.
 */
let currencySettingEnabled = DEFAULT_SETTINGS.currencyConversion;

const currency = new FrankfurterProvider(
  guard,
  async (url) => {
    const response = await fetch(url, { credentials: "omit", cache: "no-store" });
    return { ok: response.ok, status: response.status, json: () => response.json() as Promise<unknown> };
  },
  () => Date.now(),
  () => currencySettingEnabled,
);

/** The most recent analysis, kept only until the next one replaces it. */
let current: { page: PageContext; analysis: Analysis } | undefined;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  void restoreUsage();
});

async function restoreUsage(): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.usage);
  const usage = stored[STORAGE_KEYS.usage] as Record<string, ProviderUsage> | undefined;
  for (const id of BUDGETS.keys()) {
    guard.hydrate(id, usage?.[id] ?? emptyUsage(Date.now()));
  }
}

async function persistUsage(): Promise<void> {
  const snapshot: Record<string, ProviderUsage> = {};
  for (const id of BUDGETS.keys()) snapshot[id] = guard.snapshot(id);
  await chrome.storage.local.set({ [STORAGE_KEYS.usage]: snapshot });
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener((alarm) => {
  void fireReminder(alarm.name);
});

async function fireReminder(id: string): Promise<void> {
  const reminder = await ports.reminders.get(id);
  if (!reminder || reminder.fired) return;

  const all = await readCollection<Record<string, unknown>>(STORAGE_KEYS.reminders);
  const record = all[id];
  if (record) {
    record["fired"] = true;
    await chrome.storage.local.set({ [STORAGE_KEYS.reminders]: all });
  }

  await ports.activity.record({ kind: "detected", summary: `Reminder due: ${reminder.title}` });

  /*
   * A badge, not a notification. The `notifications` permission would widen the
   * manifest for something the badge already conveys, and a badge cannot be
   * mistaken for the page doing something.
   */
  const due = (await ports.reminders.all()).filter((r) => r.dueAt <= Date.now() && !r.fired).length + 1;
  await chrome.action.setBadgeText({ text: due > 9 ? "9+" : String(due) });
  await chrome.action.setBadgeBackgroundColor({ color: "#B45309" });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const value = stored[STORAGE_KEYS.settings];
  const settings =
    typeof value === "object" && value !== null ? { ...DEFAULT_SETTINGS, ...(value as Settings) } : DEFAULT_SETTINGS;
  currencySettingEnabled = settings.currencyConversion;
  return settings;
}

async function setSettings(partial: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...partial };
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  return next;
}

async function readIdList(key: string): Promise<string[]> {
  const stored = await chrome.storage.local.get(key);
  return Array.isArray(stored[key]) ? (stored[key] as string[]) : [];
}

async function pushIdList(key: string, id: string): Promise<void> {
  const list = await readIdList(key);
  list.push(id);
  await chrome.storage.local.set({ [key]: list.slice(-100) });
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Pages the extension cannot and should not read.
 *
 * Takes the URL the EXTRACTOR reported, not one from chrome.tabs.query.
 * chrome.tabs.query only populates `url` when the extension holds the `tabs`
 * permission or a host permission, and Bubiqo deliberately holds neither — so
 * that field is always undefined here. Gating on it made every page look like
 * "there is no page open in this tab", which is exactly what it did.
 */
function blockedUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (/^(chrome|edge|about|devtools|view-source):/i.test(url)) {
    return "Bubiqo can't read browser pages like this one. Open an ordinary web page and try again.";
  }
  if (/^https:\/\/chromewebstore\.google\.com/i.test(url)) {
    return "Chrome does not let extensions read the Web Store.";
  }
  return undefined;
}

/** Do we currently hold permission to read pages at all? */
async function hasPageAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: ["*://*/*"] });
  } catch {
    return false;
  }
}

async function analyseActiveTab(): Promise<PanelState> {
  const settings = await getSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    current = undefined;
    return { ...(await baseState(settings)), unavailableReason: "No active tab." };
  }

  /*
   * Inject FIRST, then look at the URL the page itself reported.
   *
   * We cannot know the URL beforehand without widening permissions, and we do not
   * need to: injection is what requires permission, and it either succeeds — in
   * which case the page tells us where it is — or it throws.
   */
  let page: PageContext;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageContext,
    });
    if (!injection?.result) throw new Error("no result");
    page = injection.result as PageContext;
  } catch (error) {
    current = undefined;

    /*
     * Two very different failures arrive here, and telling them apart matters:
     * a privileged page can NEVER be read, so "click the icon" would be a lie,
     * while a missing activeTab grant is fixed by exactly that. Chrome's error
     * text is the only signal available, because without the `tabs` permission we
     * cannot see the URL to check it ourselves.
     */
    const message = error instanceof Error ? error.message : "";
    const privileged = /chrome:\/\/|chrome-extension:\/\/|edge:\/\/|about:|devtools|extensions gallery|Web Store/i.test(message);

    if (privileged) {
      return {
        ...(await baseState(settings)),
        unavailableReason: "Bubiqo can't read browser pages like this one. Open an ordinary web page and try again.",
      };
    }

    /*
     * The real reason this happens, and it took a real inbox to find it:
     *
     * a side panel never receives `activeTab`. Chrome grants that permission for an
     * action click, a context-menu click or a keyboard command — but when the action
     * opens a side panel, the grant does not reach the panel. So an extension whose
     * entire UI is a side panel cannot read anything on activeTab alone, and telling
     * the user to "click the icon" is advice that can never work.
     *
     * The permission is therefore requested explicitly, in the product, at the
     * moment the user first tries to use it — not silently at install time. They see
     * Chrome's own prompt, they can say no, and they can revoke it later.
     */
    return {
      ...(await baseState(settings)),
      unavailableReason: "Bubiqo needs your permission to read the pages you open it on.",
      canRequestAccess: true,
      pageAccessGranted: await hasPageAccess(),
    };
  }

  const unavailable = blockedUrl(page.url);
  if (unavailable) {
    current = undefined;
    return { ...(await baseState(settings)), unavailableReason: unavailable };
  }

  if (settings.disabledDomains.some((d) => page.domain.includes(d))) {
    current = undefined;
    return { ...(await baseState(settings)), unavailableReason: "You've switched Bubiqo off for this site." };
  }

  const analysis = analyse(page, registry, {
    settings,
    now: Date.now(),
    previouslyAccepted: await readIdList(STORAGE_KEYS.accepted),
    previouslyDismissed: await readIdList(STORAGE_KEYS.dismissed),
  });
  current = { page, analysis };

  if (analysis.injectionAttempted) {
    await ports.activity.record({
      kind: "blocked",
      summary: "This page tried to give Bubiqo instructions. They were ignored.",
    });
  }

  /*
   * Whether the user has granted standing access to this site.
   *
   * Without it, activeTab only lasts until the tab changes, so switching to
   * another email leaves the panel stale — the user has to click the icon again.
   * With it, the panel can re-read on every tab switch. It is opt-in per site and
   * the panel offers it only after a read has already succeeded, so the user is
   * agreeing to something they have seen work.
   */
  let siteOrigin: string | undefined;
  let siteAccessGranted = false;
  try {
    siteOrigin = new URL(page.url).origin;
    siteAccessGranted = await chrome.permissions.contains({ origins: [`${siteOrigin}/*`] });
  } catch {
    siteOrigin = undefined;
  }

  const state: PanelState = {
    ...(await baseState(settings)),
    page,
    analysis,
    analysedAt: Date.now(),
    ...(siteOrigin ? { siteOrigin, siteAccessGranted } : {}),
  };

  /*
   * Conversion is the only thing here that can touch the network, so it is last,
   * it is opt-in, and a failure degrades the panel by one line rather than
   * failing the analysis.
   */
  if (settings.currencyConversion && analysis.classification.surface === "invoice") {
    const amount = amountToConvert(analysis, settings.homeCurrency);
    if (amount) {
      const outcome = await currency.convert(amount.value, amount.from, settings.homeCurrency);
      await persistUsage();
      if (!isUnavailable(outcome)) {
        return {
          ...state,
          conversion: {
            from: outcome.from,
            to: outcome.to,
            amount: outcome.amount,
            converted: outcome.converted,
            rate: outcome.rate,
            stale: outcome.stale,
          },
        };
      }
      return { ...state, conversionUnavailable: outcome.reason };
    }
  }

  return state;
}

async function baseState(settings: Settings): Promise<PanelState> {
  return {
    settings,
    reminders: await ports.reminders.all(),
    memory: await ports.memory.all(),
    drafts: await ports.drafts.all(),
    activity: await ports.activity.recent(40),
  };
}

// ---------------------------------------------------------------------------
// Briefing — "what might I be forgetting?"
// ---------------------------------------------------------------------------

async function buildBriefing(): Promise<Briefing> {
  const now = Date.now();
  const reminders = await ports.reminders.all();
  const memory = await ports.memory.all();
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);

  const hour = new Date(now).getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Before you finish";

  /*
   * The forgetting check: something saved with a date attached but no reminder
   * covering it. This is the §44 feature, and it works entirely off what the user
   * explicitly saved — nothing is inferred from browsing.
   */
  const loose: { title: string; why: string }[] = [];
  for (const item of memory) {
    const dated = item.entities.find((e) => e.resolvedAt && e.resolvedAt > now);
    if (!dated?.resolvedAt) continue;
    const covered = reminders.some((r) => Math.abs(r.dueAt - dated.resolvedAt!) < 2 * 86_400_000);
    if (!covered) {
      loose.push({
        title: item.title,
        why: `You saved this with a date, but there's no reminder for it.`,
      });
    }
  }

  return {
    greeting,
    overdue: reminders.filter((r) => r.dueAt < now),
    dueToday: reminders.filter((r) => r.dueAt >= now && r.dueAt <= endOfDay.getTime()),
    upcoming: reminders.filter((r) => r.dueAt > endOfDay.getTime()).slice(0, 5),
    openTasks: memory.filter((m) => m.kind === "task").slice(0, 5),
    loose: loose.slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((request: Request, _sender, sendResponse: (r: Response) => void) => {
  void handle(request)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({ type: "ERROR", message: error instanceof Error ? error.message : "Something went wrong." });
    });
  return true; // keeps the channel open for the async reply
});

async function handle(request: Request): Promise<Response> {
  const settings = await getSettings();
  const executor = new Executor(registry, ports, settings);

  switch (request.type) {
    case "ANALYSE_ACTIVE_TAB":
      return { type: "STATE", state: await analyseActiveTab() };

    case "GET_STATE":
      return {
        type: "STATE",
        state: current
          ? { ...(await baseState(settings)), page: current.page, analysis: current.analysis }
          : await baseState(settings),
      };

    case "RUN_ACTION": {
      if (!current) return { type: "ERROR", message: "Nothing has been analysed yet." };
      const outcome = await executor.run(request.actionId, toActionInput(current.page, current.analysis), {
        approved: request.approved ? [request.actionId] : [],
      });
      if (outcome.status === "done") await pushIdList(STORAGE_KEYS.accepted, request.actionId);

      /*
       * Navigation is the one action whose effect lives outside both the worker and
       * the panel, so the worker performs it here rather than in core/, which must
       * stay free of chrome.*. It only runs after decide() approved the step and the
       * user approved the confirm-risk prompt, and the action itself has already
       * rejected anything that is not https.
       */
      if (request.actionId === "open_application_link" && outcome.status === "done" && outcome.handle) {
        await chrome.tabs.create({ url: outcome.handle, active: true });
      }

      await persistUsage();
      return { type: "STEP", outcome };
    }

    case "COMPLETE_IT": {
      if (!current) return { type: "ERROR", message: "Nothing has been analysed yet." };
      const report = await executor.completeIt(
        current.analysis.suggestions.filter((s) => s.risk === "safe").slice(0, 3),
        toActionInput(current.page, current.analysis),
      );
      for (const step of report.steps) {
        if (step.status === "done") await pushIdList(STORAGE_KEYS.accepted, step.actionId);
      }
      return { type: "REPORT", report };
    }

    case "UNDO":
      return { type: "STEP", outcome: await executor.undo(request.actionId, request.handle) };

    case "DISMISS_SUGGESTION":
      await pushIdList(STORAGE_KEYS.dismissed, request.actionId);
      return { type: "STATE", state: await baseState(settings) };

    case "GET_SETTINGS":
      return { type: "STATE", state: await baseState(settings) };

    case "SET_SETTINGS": {
      const next = await setSettings(request.settings);
      return { type: "STATE", state: { ...(await baseState(next)), settings: next } };
    }

    case "GET_MEMORY":
    case "GET_REMINDERS":
    case "GET_ACTIVITY":
      return { type: "STATE", state: await baseState(settings) };

    case "GET_DRAFTS":
      return { type: "STATE", state: await baseState(settings) };

    case "DELETE_DRAFT":
      await ports.drafts.remove(request.id);
      return { type: "STATE", state: await baseState(settings) };

    case "DELETE_MEMORY":
      await ports.memory.remove(request.id);
      return { type: "STATE", state: await baseState(settings) };

    case "DELETE_REMINDER":
      await ports.reminders.remove(request.id);
      await chrome.action.setBadgeText({ text: "" });
      return { type: "STATE", state: await baseState(settings) };

    case "DOWNLOAD_CALENDAR": {
      const file = await ports.calendar.get(request.handle);
      if (!file) return { type: "ERROR", message: "That calendar file is no longer available." };
      return { type: "CALENDAR_FILE", filename: file.filename, ics: file.ics };
    }

    case "BRIEFING":
      return { type: "BRIEFING", briefing: await buildBriefing() };

    case "PAGE_CONTEXT":
      return { type: "ERROR", message: "Page context is collected by the panel, not pushed." };
  }
}

void restoreUsage();
