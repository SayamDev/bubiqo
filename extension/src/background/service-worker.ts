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
import { memoryFingerprint, preferredTitle } from "@core/storage-hygiene";
import { buildRegistry } from "@core/actions";
import { Executor } from "@core/executor";
import { CostGuard, emptyUsage, type ProviderBudget, type ProviderUsage } from "@core/cost-guard";
import { DEFAULT_SETTINGS, type Analysis, type PageContext, type Reminder, type Settings } from "@core/types";
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

/**
 * The most recent analysis.
 *
 * Held in memory AND mirrored to chrome.storage.session, because an MV3 service
 * worker is terminated after roughly thirty seconds idle. Reading a page, pausing
 * to actually read it, then pressing "Complete it" is a completely ordinary thing
 * to do — and it took longer than the worker's lifetime, so `current` was gone and
 * the button did nothing.
 *
 * storage.session is the right home: it survives worker restarts, is cleared when
 * the browser closes, and never touches disk — so a page analysis does not outlive
 * the browsing session that produced it.
 */
let current: { page: PageContext; analysis: Analysis } | undefined;

const CURRENT_KEY = "bubiqo.current";

async function setCurrent(value: { page: PageContext; analysis: Analysis } | undefined): Promise<void> {
  current = value;
  try {
    if (value) await chrome.storage.session.set({ [CURRENT_KEY]: value });
    else await chrome.storage.session.remove(CURRENT_KEY);
  } catch {
    // storage.session can be unavailable; the in-memory copy still works.
  }
}

/** Re-read the analysis after a worker restart. */
async function loadCurrent(): Promise<{ page: PageContext; analysis: Analysis } | undefined> {
  if (current) return current;
  try {
    const stored = await chrome.storage.session.get(CURRENT_KEY);
    const value = stored[CURRENT_KEY] as { page: PageContext; analysis: Analysis } | undefined;
    if (value?.page && value.analysis) current = value;
    return current;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const READ_SELECTION_MENU = "bubiqo-read-selection";

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

  /*
   * The one path that cannot fail.
   *
   * Everything else in this extension has to work out which part of a page the
   * user means, and on a job board or a webmail client that inference loses: the
   * advert sits in the same container as the sidebar and twenty-five other
   * adverts. Chrome hands the selected text straight to a context-menu handler —
   * no injection, no page permission, no markup to understand, nothing to break
   * when a site is redesigned.
   *
   * It is also a real user gesture, so it may open the side panel, which the
   * panel cannot do for itself.
   */
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: READ_SELECTION_MENU,
      title: "Read this with Bubiqo",
      contexts: ["selection"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== READ_SELECTION_MENU || !info.selectionText) return;
  void readSelection(info.selectionText, tab);
});

/**
 * Analyse text the user chose, with no access to the page at all.
 *
 * The PageContext is assembled from what Chrome gives us: the selection as the
 * text, the tab's own title and url. There is no extraction step, so there is
 * nothing for a site's markup to break.
 */
async function readSelection(selectionText: string, tab?: chrome.tabs.Tab): Promise<void> {
  const settings = await getSettings();

  let domain = "";
  try {
    domain = tab?.url ? new URL(tab.url).hostname : "";
  } catch {
    domain = "";
  }

  const page: PageContext = {
    url: tab?.url ?? "",
    domain,
    title: tab?.title ?? "",
    text: selectionText,
    headings: [],
    fields: [],
    structuredData: [],
    links: [],
    selection: selectionText,
    capturedAt: Date.now(),
  };

  const analysis = analyse(page, registry, {
    settings,
    now: Date.now(),
    previouslyAccepted: await readIdList(STORAGE_KEYS.accepted),
    previouslyDismissed: await readIdList(STORAGE_KEYS.dismissed),
  });

  await setCurrent({ page, analysis });

  // A context-menu click is a user gesture, so the panel may be opened here.
  if (tab?.id !== undefined) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch {
      // Older Chrome, or the panel is already open. Nothing to do.
    }
  }
}

chrome.runtime.onStartup.addListener(() => {
  void restoreUsage();
void catchUpOnReminders();
  void catchUpOnReminders();
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

/**
 * Reconcile reminders whose moment passed while Chrome was not running.
 *
 * chrome.alarms is a browser API, not a service: nothing fires while Chrome is
 * closed. Relying on Chrome to replay a missed alarm on startup is not enough
 * either — the guarantee is weak for long gaps, and the toolbar badge is cleared
 * when the browser restarts regardless, so a reminder that DID fire yesterday
 * left no trace today.
 *
 * So the stored records are the source of truth and this walks them on every
 * wake: anything due and not yet marked is marked, logged, and counted into the
 * badge. Nothing is missed; at worst it is late, and it says so by showing as
 * overdue.
 */
async function catchUpOnReminders(): Promise<void> {
  const now = Date.now();
  const all = await readCollection<Reminder>(STORAGE_KEYS.reminders);

  let changed = false;
  let outstanding = 0;

  for (const reminder of Object.values(all)) {
    if (reminder.dueAt > now) continue;
    outstanding += 1;

    if (!reminder.fired) {
      (all[reminder.id] as Reminder & { fired: boolean }).fired = true;
      changed = true;
      await ports.activity.record({
        kind: "detected",
        summary: `Reminder due: ${reminder.title}`,
      });
    }
  }

  if (changed) await chrome.storage.local.set({ [STORAGE_KEYS.reminders]: all });

  await chrome.action.setBadgeText({ text: outstanding === 0 ? "" : outstanding > 9 ? "9+" : String(outstanding) });
  if (outstanding > 0) await chrome.action.setBadgeBackgroundColor({ color: "#B45309" });
}

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
    await setCurrent(undefined);
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
    await setCurrent(undefined);
    return { ...(await baseState(settings)), unavailableReason: unavailable };
  }

  if (settings.disabledDomains.some((d) => page.domain.includes(d))) {
    await setCurrent(undefined);
    return { ...(await baseState(settings)), unavailableReason: "You've switched Bubiqo off for this site." };
  }

  const analysis = analyse(page, registry, {
    settings,
    now: Date.now(),
    previouslyAccepted: await readIdList(STORAGE_KEYS.accepted),
    previouslyDismissed: await readIdList(STORAGE_KEYS.dismissed),
  });
  await setCurrent({ page, analysis });

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

  /*
   * Have we already got this page? Derived live from Memory, never from a record
   * of what was deleted. Telling someone "you saved this before" about something
   * they removed would mean keeping a tombstone of every deletion, which is the
   * opposite of what deleting should do.
   */
  const savedAlready = (await ports.memory.all()).find(
    (item) =>
      memoryFingerprint(item) ===
      memoryFingerprint({ kind: item.kind, title: preferredTitle(page), url: page.url }),
  );

  const state: PanelState = {
    ...(await baseState(settings)),
    page,
    analysis,
    analysedAt: Date.now(),
    ...(savedAlready
      ? { alreadySaved: { id: savedAlready.id, title: savedAlready.title, savedAt: savedAlready.savedAt } }
      : {}),
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

/**
 * The state every reply is built from.
 *
 * It carries the CURRENT analysis if there is one. Without that, any message that
 * is not itself an analysis — changing a setting, deleting a reminder — returned a
 * state with no analysis, and the panel fell back to its loading skeleton and sat
 * there, because nothing ever asked it to read the page again.
 */
async function baseState(settings: Settings): Promise<PanelState> {
  /*
   * Restore the analysis from session storage before building anything.
   *
   * Reading the in-memory `current` directly was the bug: MV3 terminates the
   * worker constantly, so any message that was not itself an analysis — changing
   * a setting, deleting a reminder, clearing a list — came back with no analysis
   * attached, and the panel fell back to its loading skeleton with nothing left
   * to pull it out of there.
   */
  await loadCurrent();

  return {
    ...(current ? { page: current.page, analysis: current.analysis } : {}),
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
// Noticing a page without being asked
// ---------------------------------------------------------------------------

/*
 * Chrome does not allow an extension to open its own side panel: sidePanel.open()
 * requires a user gesture, and there is no navigation hook that counts. So the
 * honest answer to "I forget it is installed" is a count on the toolbar icon,
 * not a panel that appears over what you were reading.
 *
 * This is OPT-IN, and deliberately so. The default promise is that Bubiqo reads a
 * page only while the panel is open on it, and background scanning would make
 * that untrue. Choosing Proactive in Settings is the user changing that promise
 * knowingly. Nothing scanned this way is stored — the count is derived and thrown
 * away.
 */
let scanTimer: number | undefined;

async function glanceAtTab(tabId: number): Promise<void> {
  const settings = await getSettings();
  if (settings.mode !== "proactive") return;
  if (!(await hasPageAccess())) return;

  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: extractPageContext });
    const page = injection?.result as PageContext | undefined;
    if (!page || blockedUrl(page.url)) return;
    if (settings.disabledDomains.some((d) => page.domain.includes(d))) return;

    const analysis = analyse(page, registry, { settings, now: Date.now() });
    const worthSaying = analysis.problems.filter((p) => p.confidence >= 0.7).length;

    await chrome.action.setBadgeText({ text: worthSaying === 0 ? "" : String(Math.min(worthSaying, 9)) });
    if (worthSaying > 0) await chrome.action.setBadgeBackgroundColor({ color: "#B45309" });
  } catch {
    // No access to this tab, or a privileged page. Nothing to say.
  }
}

/** Debounced, because a single navigation fires several updates. */
function scheduleGlance(tabId: number): void {
  if (scanTimer !== undefined) clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    void glanceAtTab(tabId);
  }, 900) as unknown as number;
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === "complete" && tab.active) scheduleGlance(tabId);
});

chrome.tabs.onActivated.addListener((info) => {
  scheduleGlance(info.tabId);
});

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

    case "GET_STATE": {
      await loadCurrent();
      return { type: "STATE", state: await baseState(settings) };
    }

    case "RUN_ACTION": {
      const ctx = (await loadCurrent()) ?? (await analyseActiveTab(), await loadCurrent());
      if (!ctx) return { type: "ERROR", message: "Bubiqo lost track of this page. Press “Re-read this page” and try again." };
      const outcome = await executor.run(request.actionId, toActionInput(ctx.page, ctx.analysis), {
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
      /*
       * Re-read the page if the worker restarted since the panel last analysed it.
       * Erroring here is useless to the user: they pressed a button on suggestions
       * that are still on screen, so the right answer is to make it work.
       */
      const ctx = (await loadCurrent()) ?? (await analyseActiveTab(), await loadCurrent());
      if (!ctx) {
        return { type: "ERROR", message: "Bubiqo lost track of this page. Press “Re-read this page” and try again." };
      }
      const report = await executor.completeIt(
        ctx.analysis.suggestions.filter((s) => s.risk === "safe").slice(0, 3),
        toActionInput(ctx.page, ctx.analysis),
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

    case "DELETE_ALL_DATA": {
      /*
       * Everything Bubiqo holds, gone, in one place — rather than the user being
       * told to paste commands into a service-worker console, which is not a
       * product answer.
       *
       * Scheduled alarms are cleared too. Clearing the records alone leaves
       * orphaned alarms that outlive the data they referred to; they are harmless
       * because the handler finds no record, but leaving them behind is untidy and
       * makes "delete everything" not quite true.
       *
       * Settings are deliberately kept: a data reset is not a preferences reset,
       * and silently resetting someone's theme and proactivity would be a surprise.
       */
      await chrome.alarms.clearAll();
      await chrome.storage.local.remove([
        STORAGE_KEYS.reminders,
        STORAGE_KEYS.memory,
        STORAGE_KEYS.drafts,
        STORAGE_KEYS.calendar,
        STORAGE_KEYS.activity,
        STORAGE_KEYS.accepted,
        STORAGE_KEYS.dismissed,
      ]);
      await chrome.action.setBadgeText({ text: "" });
      await setCurrent(undefined);
      return { type: "STATE", state: await baseState(settings) };
    }

    case "CLEAR_REMINDERS": {
      // Cancel the alarms as well, or they outlive the records they referred to.
      for (const reminder of await ports.reminders.all()) await chrome.alarms.clear(reminder.id);
      await chrome.storage.local.set({ [STORAGE_KEYS.reminders]: {} });
      await chrome.action.setBadgeText({ text: "" });
      return { type: "STATE", state: await baseState(settings) };
    }

    case "CLEAR_MEMORY":
      await chrome.storage.local.set({ [STORAGE_KEYS.memory]: {} });
      return { type: "STATE", state: await baseState(settings) };

    case "CLEAR_DRAFTS":
      await chrome.storage.local.set({ [STORAGE_KEYS.drafts]: {} });
      return { type: "STATE", state: await baseState(settings) };

    case "CLEAR_ACTIVITY":
      await ports.activity.clear();
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
void catchUpOnReminders();
