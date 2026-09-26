/**
 * The side panel.
 *
 * Structure follows the question the user is actually asking, in order:
 * what is this? what needs attention? what should I do? — then the quieter
 * surfaces (Memory, Activity, Settings) behind tabs.
 *
 * Accessibility notes, since they are easy to lose in a refactor:
 *  - the tab bar is a real ARIA tablist with roving focus
 *  - every result is announced through a polite live region
 *  - risk is always carried by a word ("Needs your approval"), never by colour
 *  - the only motion is the browser's own, and reduced-motion is honoured in CSS
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { MoneyLine, MoneySummary } from "@core/bill";
import { listingLines, type Listing } from "@core/listings";
import type { BriefField, Entity, EntityType, JobBrief, MemoryItem, Problem, Reminder, Suggestion } from "@core/types";
import type { StepOutcome, CompleteItReport } from "@core/executor";
import type { Briefing, PageFingerprint, PanelState, Request, Response } from "@shared/messages";
import { send } from "@shared/messages";
import { formatDue, describeUrgency } from "@core/dates";
import { CURRENCY_CODES, CURRENCY_NAMES } from "@core/money";
import { BLOCKER_RULES } from "@core/job-brief";
import { riskLabel } from "@core/safety";
import { surfaceChip, attentionHeadline, jobHeadline, urgencyWord, relativeTime, clockTime, displayMoney } from "./format";
import { hasMoved, nextCheckDelay } from "./watch";
import { splitSuggestions } from "@core/ranker";
import {
  BubbleMark,
  ShieldIcon,
  QuietMark,
  ActionIcon,
  HeaderArt,
  BlockMark,
  RefreshMark,
  ShareMark,
  TrashMark,
  ActivityMark,
  BellMark,
  TickMark,
  CopyMark,
  OpenMark,
  KeepMark,
  SunMark,
  MoonMark,
  SurfaceMark,
  DialMark,
  LockMark,
  PaletteMark,
} from "./icons";
import { Welcome, WhatItDoes } from "./Welcome";

type Tab = "now" | "memory" | "activity" | "settings";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "now", label: "Now" },
  { id: "memory", label: "Memory" },
  { id: "activity", label: "Activity" },
  { id: "settings", label: "Settings" },
];

export function App() {
  const [state, setState] = useState<PanelState | undefined>();
  const [briefing, setBriefing] = useState<Briefing | undefined>();
  const [tab, setTab] = useState<Tab>("now");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<CompleteItReport | undefined>();
  /*
   * What each individual card is doing right now.
   *
   * Clicking "Do it" used to change nothing on the card: the result appeared in a
   * "What happened" list below the fold, so from where the user was looking, the
   * button did nothing at all. A click has to be answered where it was made.
   */
  const [cardState, setCardState] = useState<Record<string, "running" | StepOutcome>>({});
  const [announcement, setAnnounce] = useState("");
  /*
   * Errors need to be SEEN, not only announced. Routing them to the visually
   * hidden live region meant a screen reader heard "Nothing has been analysed
   * yet" while a sighted user saw a button that simply did nothing.
   */
  const [error, setError] = useState<string | undefined>();
  /*
   * The intro stays until the user has either run something or dismissed it.
   * localStorage rather than extension storage: it is a per-viewer convenience,
   * not something worth a round trip to the worker.
   */
  const [introDismissed, setIntroDismissed] = useState(() => {
    try {
      return localStorage.getItem("bubiqo.introSeen") === "1";
    } catch {
      return false;
    }
  });

  const dismissIntro = useCallback(() => {
    setIntroDismissed(true);
    try {
      localStorage.setItem("bubiqo.introSeen", "1");
    } catch {
      // Private window, or storage blocked. The intro simply shows again.
    }
  }, []);
  const now = Date.now();

  /*
   * Refs to the tab buttons so keyboard selection can move FOCUS as well as
   * selection. With a roving tabindex, selecting a tab without moving focus
   * strands the user on a button that has just become tabindex="-1" — it is no
   * longer in the tab order, so tabbing away and back lands somewhere else
   * entirely. The APG tabs pattern requires focus to follow.
   */
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    now: null, memory: null, activity: null, settings: null,
  });

  const selectTab = useCallback((next: Tab) => {
    setTab(next);
    /*
     * Focus synchronously. The button is already in the DOM and focus() works on a
     * tabindex="-1" element, so there is nothing to wait for — and deferring to a
     * frame makes focus trail a render behind when arrow keys are held down.
     */
    tabRefs.current[next]?.focus();
  }, []);

  const apply = useCallback((response: Response) => {
    if (response.type === "STATE") setState(response.state);
    if (response.type === "BRIEFING") setBriefing(response.briefing);
    if (response.type === "ERROR") {
      setAnnounce(response.message);
      setError(response.message);
    } else {
      setError(undefined);
    }
  }, []);

  /*
   * The fingerprint of the page as it was when it was last read.
   *
   * Taken from the page, never derived from the analysis: the analysis holds the
   * text of the block that was chosen, while the fingerprint measures the whole
   * document. Comparing one against the other would differ every time and re-read
   * the page forever.
   */
  const lastFingerprint = useRef<PageFingerprint | undefined>(undefined);

  // The timer must not queue a re-read on top of one already running.
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // A page that cannot be read is checked slowly: every check is an injection.
  const readableRef = useRef(true);
  useEffect(() => {
    readableRef.current = state?.unavailableReason === undefined;
  }, [state?.unavailableReason]);

  const analyse = useCallback(async () => {
    setBusy(true);
    setReport(undefined);
    try {
      apply(await send({ type: "ANALYSE_ACTIVE_TAB" }));
      apply(await send({ type: "BRIEFING" }));

      // Record what the page looked like at the moment it was read, so the watcher
      // below has something to compare against.
      const response = await send({ type: "PAGE_FINGERPRINT" });
      if (response.type === "FINGERPRINT" && response.fingerprint) {
        lastFingerprint.current = response.fingerprint;
      }
    } finally {
      setBusy(false);
    }
  }, [apply]);

  useEffect(() => {
    void analyse();
  }, [analyse]);

  /*
   * Results belong to the page they were produced on.
   *
   * "Saved 4 details to Memory" stayed on the Save card after moving to a
   * different email, which read as though the new email had been saved. When
   * the page changes, what was done on the last one is cleared from Now. It is
   * still in Memory and Activity, where it belongs.
   */
  const pageKey = state?.page?.url ?? "";
  const lastPageKey = useRef(pageKey);
  useEffect(() => {
    if (lastPageKey.current === pageKey) return;
    lastPageKey.current = pageKey;
    setCardState({});
    setReport(undefined);
  }, [pageKey]);

  /*
   * A loading skeleton with nothing coming is the worst state to be stuck in: it
   * looks like work in progress forever. If a reply ever arrives with no analysis
   * and no reason why, re-read the page rather than sitting there. This guards the
   * whole class of bug, not just the one that caused it.
   */
  const recovering = useRef(false);
  useEffect(() => {
    if (!state) return;
    if (state.analysis || state.unavailableReason || busy) {
      recovering.current = false;
      return;
    }
    if (recovering.current) return;
    recovering.current = true;
    void analyse();
  }, [state, busy, analyse]);

  /*
   * "system" sets no attribute, so the prefers-color-scheme media query decides.
   * An explicit choice stamps data-theme, which the stylesheet weights above the
   * media query in both directions.
   */
  useEffect(() => {
    const theme = state?.settings.theme ?? "system";
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
  }, [state?.settings.theme]);

  /*
   * Keep the panel in step with the page the user is reading.
   *
   * Three signals, in order of how much they can be trusted:
   *
   *   1. Chrome's own events — a tab switch, a navigation, the panel regaining
   *      focus. These are free and immediate, and they are also incomplete:
   *      chrome.tabs.onUpdated is not dependable for same-document navigation,
   *      which is exactly how a job board switches advert.
   *   2. The page itself, asked for a four-string fingerprint. Dependable, and
   *      the only thing that catches an advert swapped behind the same URL.
   *   3. Nothing at all, when the panel is not visible. A panel nobody is looking
   *      at does not need to keep up with anything.
   *
   * The cadence follows the user rather than the clock: attentive for twenty
   * seconds after any sign of activity, spaced out once they settle. The policy
   * lives in sidepanel/watch.ts, where it is tested without a browser.
   */
  const lastActivityAt = useRef(Date.now());

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const noteActivity = (): void => {
      lastActivityAt.current = Date.now();
    };

    const check = async (): Promise<void> => {
      if (stopped || busyRef.current) return;

      const response = await send({ type: "PAGE_FINGERPRINT" });
      if (response.type !== "FINGERPRINT" || !response.fingerprint) return;

      if (hasMoved(lastFingerprint.current, response.fingerprint)) {
        noteActivity();
        void analyse();
      }
    };

    const schedule = (): void => {
      if (stopped) return;
      const delay = nextCheckDelay(
        {
          lastActivityAt: lastActivityAt.current,
          visible: document.visibilityState === "visible",
          busy: busyRef.current,
          readable: readableRef.current,
        },
        Date.now(),
      );

      // Hidden panel: no timer at all. visibilitychange starts it again.
      if (delay === undefined) return;
      timer = setTimeout(() => void check().finally(schedule), delay);
    };

    const restart = (immediate: boolean): void => {
      noteActivity();
      if (timer) clearTimeout(timer);
      if (immediate) void check().finally(schedule);
      else schedule();
    };

    const onActivated = (): void => {
      noteActivity();
      void analyse();
    };
    const onUpdated = (_id: number, change: chrome.tabs.TabChangeInfo, t: chrome.tabs.Tab): void => {
      if (!t.active) return;
      if (change.status === "complete" || change.url !== undefined) {
        noteActivity();
        void analyse();
      }
    };
    const onVisible = (): void => restart(document.visibilityState === "visible");

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    schedule();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [analyse]);

  /*
   * "I have this" / "I do not have this".
   *
   * Kept in Settings with everything else, so it is local, inspectable and
   * deletable — and it is only ever set by the user pressing the button. Nothing
   * here infers what somebody holds.
   */
  const holdCondition = useCallback(
    async (rule: string, held: boolean) => {
      const current = state?.settings.heldConditions ?? [];
      const next = held ? [...new Set([...current, rule])] : current.filter((id) => id !== rule);
      apply(await send({ type: "SET_SETTINGS", settings: { heldConditions: next } }));
      void analyse();
    },
    [apply, analyse, state?.settings.heldConditions],
  );

  const runAction = useCallback(
    async (actionId: string, approved = false) => {
      setCardState((previous) => ({ ...previous, [actionId]: "running" }));
      try {
        const response = await send({ type: "RUN_ACTION", actionId, approved });
        if (response.type === "STEP") {
          setCardState((previous) => ({ ...previous, [actionId]: response.outcome }));
          setAnnounce(`${response.outcome.name}: ${response.outcome.message}`);
          if (response.outcome.status === "done") apply(await send({ type: "GET_STATE" }));
        } else {
          setCardState((previous) => {
            const next = { ...previous };
            delete next[actionId];
            return next;
          });
          apply(response);
        }
      } catch {
        setCardState((previous) => {
          const next = { ...previous };
          delete next[actionId];
          return next;
        });
        setError("Something went wrong. Try again.");
      }
    },
    [apply],
  );

  const completeIt = useCallback(async (ids: readonly string[] = []) => {
    setBusy(true);
    /*
     * Each card answers for itself.
     *
     * "Complete all" used to leave the three cards untouched and put the results
     * in a list further down, so the cards still said "Do it" for work already
     * done. Now every card spins while the batch runs, then ticks over one after
     * another as its result lands.
     */
    setCardState(Object.fromEntries(ids.map((id) => [id, "running" as const])));
    try {
      const response = await send({ type: "COMPLETE_IT" });
      if (response.type === "REPORT") {
        response.report.steps.forEach((step, index) => {
          setTimeout(() => setCardState((previous) => ({ ...previous, [step.actionId]: step })), 90 * index);
        });
        setTimeout(() => {
          setCardState((previous) => {
            const next = { ...previous };
            for (const id of ids) if (next[id] === "running") delete next[id];
            return next;
          });
        }, 90 * response.report.steps.length);
        setReport(response.report);
        setAnnounce(
          response.report.failed > 0
            ? `${response.report.done} done, ${response.report.failed} could not be completed.`
            : `Done. ${response.report.done} ${response.report.done === 1 ? "action" : "actions"} completed and verified.`,
        );
        apply(await send({ type: "GET_STATE" }));
        apply(await send({ type: "BRIEFING" }));
      } else {
        setCardState({});
        apply(response);
      }
    } catch {
      setCardState({});
      setError("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }, [apply]);

  const undo = useCallback(
    async (actionId: string, handle: string) => {
      const response = await send({ type: "UNDO", actionId, handle });
      if (response.type === "STEP") {
        setAnnounce(response.outcome.message);
        setCardState((previous) => {
          const next = { ...previous };
          delete next[actionId];
          return next;
        });
        setReport((previous) =>
          previous ? { ...previous, steps: previous.steps.filter((s) => s.undoHandle !== handle) } : previous,
        );
      }
      apply(await send({ type: "GET_STATE" }));
    },
    [apply],
  );

  /*
   * These two live in the panel because they need a document, which an MV3 service
   * worker does not have: the Clipboard API and an <a download> both require one.
   * The worker prepares the content; the panel delivers it.
   */
  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setAnnounce("Copied to your clipboard.");
    } catch {
      setAnnounce("Chrome blocked the clipboard. Select the text and copy it manually.");
    }
  }, []);

  const panelActions = useMemo(
    () => ({ apply, showMemory: () => setTab("memory"), copy: copyText }),
    [apply, copyText],
  );

  const downloadCalendar = useCallback(async (handle: string) => {
    const response = await send({ type: "DOWNLOAD_CALENDAR", handle });
    if (response.type !== "CALENDAR_FILE") {
      setAnnounce("That calendar file is no longer available.");
      return;
    }
    const url = URL.createObjectURL(new Blob([response.ics], { type: "text/calendar;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = response.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setAnnounce(`Downloaded ${response.filename}. Open it to add the event to your calendar.`);
  }, []);

  const turnOn = useCallback(async () => {
    /*
     * Requested here, not in the service worker: chrome.permissions.request needs a
     * user gesture in an extension page, and a worker has none.
     *
     * This asks for page access once, in the product, the first time the user tries
     * to use it — rather than declaring host_permissions and putting "read all your
     * data on all websites" in front of them at install, before they have any reason
     * to trust it. Chrome shows its own prompt, and it is revocable at any time.
     */
    try {
      const granted = await chrome.permissions.request({ origins: ["*://*/*"] });
      if (granted) {
        setAnnounce("Bubiqo can now read the pages you open it on.");
        await analyse();
      } else {
        setAnnounce("No problem — Bubiqo stays switched off until you allow it.");
      }
    } catch {
      setAnnounce("Chrome would not show the permission prompt. Try reopening the panel.");
    }
  }, [analyse]);

  const grantSiteAccess = useCallback(async (origin: string) => {
    /*
     * chrome.permissions.request must be called from a user gesture in an
     * extension page. A service worker has no gesture, so this lives here.
     */
    try {
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      setAnnounce(
        granted
          ? `Bubiqo can now read ${new URL(origin).hostname} without being asked each time.`
          : "Left as it was — Bubiqo will keep asking each time.",
      );
      if (granted) await analyse();
    } catch {
      setAnnounce("Chrome would not show the permission prompt. Try clicking the Bubiqo icon instead.");
    }
  }, [analyse]);

  const dismiss = useCallback(
    async (actionId: string) => {
      /*
       * "Not useful" means stop offering this, and it did not.
       *
       * It subtracted 0.3 from the action's score, so anything ranked comfortably
       * above the floor carried on appearing — the button looked broken because
       * it was. Pressing it now turns the action off, which is what the words say,
       * and Settings lists what has been turned off with a way to bring it back.
       */
      const current = state?.settings.disabledActionIds ?? [];
      apply(
        await send({
          type: "SET_SETTINGS",
          settings: { disabledActionIds: [...new Set([...current, actionId])] },
        }),
      );
      await send({ type: "DISMISS_SUGGESTION", actionId });
      setAnnounce("Turned off. You can bring it back in Settings.");
      apply(await send({ type: "ANALYSE_ACTIVE_TAB" }));
    },
    [apply, state?.settings.disabledActionIds],
  );

  const analysis = state?.analysis;
  const hasUsedIt = (state?.activity.length ?? 0) > 0;
  const showIntro = !introDismissed && !hasUsedIt;

  const safeSuggestions = useMemo(
    () => (analysis?.suggestions ?? []).filter((s) => s.risk === "safe").slice(0, 3),
    [analysis],
  );

  /*
   * Only wear a surface accent once there is something to describe. Defaulting to
   * "generic" made the welcome screen — and its primary button — slate grey, which
   * is the colour that means "nothing found here", on the one screen where the
   * product should look like itself.
   */
  const surface = state?.analysis?.classification.surface;

  return (
    <PanelActions.Provider value={panelActions}>
    <div className="app" {...(surface ? { "data-surface": surface } : {})}>
      <Header state={state} />

      <nav className="tabs" aria-label="Bubiqo sections">
        <div className="tabs__list" role="tablist" aria-label="Bubiqo sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            /*
             * aria-controls only on the SELECTED tab. Just one panel is rendered at
             * a time, so pointing the other three at ids with no element in the DOM
             * is a broken ARIA relationship — a screen reader announces a control
             * for something that isn't there.
             */
            {...(tab === t.id ? { "aria-controls": `panel-${t.id}` } : {})}
            tabIndex={tab === t.id ? 0 : -1}
            className="tab"
            ref={(node) => {
              tabRefs.current[t.id] = node;
            }}
            onClick={() => setTab(t.id)}
            onKeyDown={(event) => {
              const index = TABS.findIndex((x) => x.id === tab);
              const go = (next: Tab) => {
                event.preventDefault();
                selectTab(next);
              };
              if (event.key === "ArrowRight") go(TABS[(index + 1) % TABS.length]!.id);
              if (event.key === "ArrowLeft") go(TABS[(index - 1 + TABS.length) % TABS.length]!.id);
              if (event.key === "Home") go(TABS[0]!.id);
              if (event.key === "End") go(TABS[TABS.length - 1]!.id);
            }}
          >
            {t.label}
          </button>
        ))}
        </div>
        <ThemeToggle choice={state?.settings.theme ?? "system"} />
      </nav>

      <p aria-live="polite" className="visually-hidden">{announcement}</p>

      {error && (
        <div className="main" style={{ paddingBottom: 0 }}>
          <p className="notice notice--warn" role="alert">
            <strong>That didn't work.</strong> {error}
          </p>
        </div>
      )}

      <main className="main" id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "now" && (
          <NowTab
            key={pageKey}
            state={state}
            briefing={briefing}
            busy={busy}
            report={report}
            safeSuggestions={safeSuggestions}
            onRun={runAction}
            onCompleteIt={() => void completeIt(safeSuggestions.map((s) => s.actionId))}
            onUndo={undo}
            onRefresh={analyse}
            onCopy={copyText}
            onDownload={downloadCalendar}
            onGrantSite={grantSiteAccess}
            onTurnOn={turnOn}
            onDismiss={dismiss}
            onShowMemory={() => setTab("memory")}
            onHoldCondition={holdCondition}
            onDismissIntro={dismissIntro}
            showIntro={showIntro}
            cardState={cardState}
            now={now}
          />
        )}
        {tab === "memory" && <MemoryTab state={state} onChange={apply} onCopy={copyText} />}
        {tab === "activity" && <ActivityTab state={state} now={now} onChange={apply} />}
        {tab === "settings" && <SettingsTab state={state} onChange={apply} onCopyDiagnostics={copyText} />}
      </main>

      <footer className="footer">
        <ShieldIcon />
        <span>Everything stays on this device. Bubiqo never sends the page anywhere.</span>
        <span className="footer__owner">© {new Date().getFullYear()} Sayam Ajmal</span>
      </footer>
    </div>
    </PanelActions.Provider>
  );
}

// ---------------------------------------------------------------------------

/** The three settings for how much Bubiqo says without being asked. */
const MODES = [
  { id: "quiet", name: "Quiet", what: "Answers when you ask, and otherwise says nothing." },
  { id: "helpful", name: "Helpful", what: "Shows what it is confident about. The middle setting, and the default." },
  { id: "proactive", name: "Proactive", what: "Also raises things you have not asked about but might forget." },
] as const;

/**
 * Light or dark, one press, from anywhere.
 *
 * The choice lived three screens deep in Settings. It is the kind of thing
 * people change at night with the panel already open, so it sits by the name.
 * "System" is still there in Settings; this switches to whichever is not
 * currently showing.
 */
function ThemeToggle({ choice }: { choice: "system" | "light" | "dark" }) {
  const { apply } = useContext(PanelActions);
  const systemDark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  const showingDark = choice === "dark" || (choice === "system" && systemDark);
  const next = showingDark ? "light" : "dark";
  return (
    <button
      className="theme-toggle"
      onClick={async () => apply(await send({ type: "SET_SETTINGS", settings: { theme: next } as never }))}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      {showingDark ? <SunMark className="theme-toggle__mark" /> : <MoonMark className="theme-toggle__mark" />}
      <span className="theme-toggle__word">{showingDark ? "Light" : "Dark"}</span>
    </button>
  );
}

function Header({ state }: { state: PanelState | undefined }) {
  const analysis = state?.analysis;
  const blocked = Boolean(state?.unavailableReason);

  /*
   * The mark turns once each time a page is read.
   *
   * Reading happens on its own now — the panel keeps up with whatever advert is
   * in front of the user — so the one moment the product does its whole job was
   * passing with nothing to show for it. Keyed on analysedAt, which changes once
   * per read, and cleared when the turn finishes so it cannot stack.
   */
  const [scanning, setScanning] = useState(false);
  const lastRead = useRef<number | undefined>(undefined);

  useEffect(() => {
    const at = state?.analysedAt;
    if (at === undefined || at === lastRead.current) return;

    const first = lastRead.current === undefined;
    lastRead.current = at;
    if (first) return; // The arrival animation already covers the first read.

    setScanning(true);
    const timer = setTimeout(() => setScanning(false), 900);
    return () => clearTimeout(timer);
  }, [state?.analysedAt]);

  const firstRun = Boolean(state?.canRequestAccess);

  const headline = firstRun
    ? "Welcome to Bubiqo"
    : blocked
      ? "Nothing to read here"
      : analysis
        ? (analysis.brief
            ? jobHeadline({
                blockers: analysis.brief.blockers.length,
                requirements: analysis.brief.eligibility.length,
                hasSalary: analysis.brief.salary !== undefined,
              })
            : undefined) ??
          (analysis.listings?.length ? `${analysis.listings.length} job matches in this email` : undefined) ??
          (analysis.bill && analysis.problems.length === 0 ? moneyHeadline(analysis.bill) : undefined) ??
          attentionHeadline(
            analysis.problems.length,
            analysis.suggestions.length,
            analysis.problems.length > 0 && analysis.problems.every((p) => p.kind === "eligibility"),
          )
        : "Reading this page…";

  const attention = analysis?.problems.length ?? 0;

  return (
    <header className="header">
      <HeaderArt className="header__art" attention={attention} />
      <div className="brand">
        <img
          className={`brand__mark${analysis || blocked ? "" : " brand__mark--reading"}${scanning ? " brand__mark--scanned" : ""}`}
          /*
           * The 128px asset, drawn at 40. It was the 32px one scaled up, which is
           * soft at 40 and softer again on a high-density screen, where the
           * browser is really drawing 80.
           */
          src="icons/icon-128.png"
          alt=""
          width={40}
          height={40}
        />
        <span className="brand__name">bubiqo</span>
      </div>

      {analysis && !blocked ? (
        <span className="chip">
          <SurfaceMark surface={analysis.classification.surface} className="chip__mark" />
          {surfaceChip(analysis.classification.surface)}
        </span>
      ) : (
        !blocked && state === undefined && <span className="skeleton skeleton--chip" aria-hidden="true" />
      )}

      <h1 className="context__what">{headline}</h1>
      <p className="context__where">
        {firstRun
          ? "One thing to set up, then it works on whatever you open it on."
          : (state?.unavailableReason ?? state?.page?.title ?? state?.page?.domain ?? "")}
      </p>

      {/*
        * Whether Bubiqo is actually doing anything. Without this the panel looks
        * identical whether it is working, finished, or broken — which is most of
        * why it read as "is this even running?".
        */}
      {!firstRun && (
        <p className={`status${analysis ? "" : " status--working"}`} aria-live="polite">
          <span className="status__dot" aria-hidden="true" />
          {analysis
            ? `${analysis.fromSelection ? "Read your selection" : "Read this page"} ${relativeTime(state?.analysedAt ?? Date.now(), Date.now())}`
            : "Reading this page…"}
          {/*
            * Say that it is watching. The panel keeps itself up to date now, and a
            * reader who cannot see that keeps pressing "Re-read this page" —
            * which is what happened.
            */}
          {analysis && <span className="status__watching"> · keeping up with this page</span>}
        </p>
      )}
    </header>
  );
}

// ---------------------------------------------------------------------------

interface NowProps {
  state: PanelState | undefined;
  briefing: Briefing | undefined;
  busy: boolean;
  report: CompleteItReport | undefined;
  safeSuggestions: Suggestion[];
  onRun: (id: string, approved?: boolean) => void;
  onCompleteIt: () => void;
  onUndo: (id: string, handle: string) => void;
  onRefresh: () => void;
  onCopy: (text: string) => void;
  onDownload: (handle: string) => void;
  onGrantSite: (origin: string) => void;
  onTurnOn: () => void;
  onDismiss: (id: string) => void;
  onShowMemory: () => void;
  onHoldCondition: (rule: string, held: boolean) => void;
  onDismissIntro: () => void;
  showIntro: boolean;
  cardState: Record<string, "running" | StepOutcome>;
  now: number;
}

function NowTab(props: NowProps) {
  const { state, briefing, busy, report, safeSuggestions, showIntro, now } = props;
  const analysis = state?.analysis;
  // Single actions report on their own card now; this list is only Complete It.
  const allDone =
    safeSuggestions.length > 0 &&
    safeSuggestions.every((suggestion) => {
      const entry = props.cardState?.[suggestion.actionId];
      return typeof entry === "object" && (entry.status === "done" || entry.status === "unconfirmed");
    });

  const waitingOnYou = (state?.analysis?.suggestions ?? []).filter(
    (suggestion) => suggestion.risk === "confirm" && !(suggestion.actionId in (props.cardState ?? {})),
  ).length;

  // Steps whose card is on screen answer there; the list keeps only the rest.
  const outcomes = (report?.steps ?? []).filter((step) => !(step.actionId in (props.cardState ?? {})));

  if (state?.unavailableReason) {
    return (
      <>
        {/* The welcome explains itself; a one-line reason above it is just noise. */}
        {!state.canRequestAccess && <p className="notice">{state.unavailableReason}</p>}
        {state.canRequestAccess && <Welcome onTurnOn={props.onTurnOn} onSkip={props.onRefresh} />}

      <BriefingBlock briefing={briefing} now={now} />
      </>
    );
  }


  if (!analysis) {
    return (
      <div aria-busy="true" aria-label="Reading this page">
        <span className="skeleton skeleton--line" style={{ display: "block", marginBottom: 14 }} />
        <span className="skeleton skeleton--card" style={{ display: "block" }} />
        <span className="skeleton skeleton--card" style={{ display: "block" }} />
      </div>
    );
  }

  /*
   * One split, from the ranker, rather than the panel re-deriving its own.
   *
   * The panel had been computing "more" against the SAFE suggestions while
   * rendering the first three of any risk, so a confirm-risk card in the top
   * three appeared twice — once as a card and again inside "More actions". Two
   * places deciding the same thing is how they drift apart.
   */
  const { primary, more } = splitSuggestions(analysis.suggestions);

  return (
    <>
      {/*
        * A one-line reminder of what this is, shown until the user has run
        * something. The full explanation is on first run and in Settings; this is
        * for the second and third visit, when "what does this do again?" is a fair
        * question and there is nothing on screen answering it.
        */}
      <MoneyBlock summary={analysis.bill} now={now} />
      <JobBriefBlock brief={analysis.brief} now={now} onHoldCondition={props.onHoldCondition} />
      <ListingsBlock listings={analysis.listings} />

      {showIntro && (
        <div className="intro">
          <BubbleMark className="intro__mark" />
          <span>
            <strong>Bubiqo finds what needs doing on the page you are on.</strong>
            Deadlines, requests, amounts, closing dates — then does the useful parts in one click.
          </span>
          <button className="btn--link btn--link-quiet intro__dismiss" onClick={props.onDismissIntro}>
            Got it
          </button>
        </div>
      )}

      {analysis.injectionAttempted && (
        <p className="notice notice--warn">
          <strong>Heads up.</strong> This page contains text trying to give Bubiqo instructions.
          It was ignored — page content is treated as data, never as commands.
        </p>
      )}

      {state?.conversion && (
        <p className="notice" style={{ marginBottom: 14 }}>
          <strong>
            {state.conversion.from} {state.conversion.amount.toLocaleString("en-GB", { minimumFractionDigits: 2 })}
          </strong>{" "}
          ≈{" "}
          <strong>
            {state.conversion.to} {state.conversion.converted.toLocaleString("en-GB", { minimumFractionDigits: 2 })}
          </strong>
          <br />
          {state.conversion.stale
            ? "Using the last rate Bubiqo fetched — a fresh one wasn't available."
            : `At ${state.conversion.rate} ${state.conversion.to} to the ${state.conversion.from}, from central bank reference rates.`}
        </p>
      )}

      {state?.conversionUnavailable && (
        <p className="notice" style={{ marginBottom: 14 }}>
          {state.conversionUnavailable}
        </p>
      )}

      {analysis.problems.length > 0 && (
        <section className="section" aria-labelledby="problems-title">
          <h2 className="section__title" id="problems-title">
            Needs attention
            <span className="section__count">{analysis.problems.length}</span>
          </h2>
          {analysis.problems.slice(0, 4).map((problem, i) => (
            <ProblemRow key={`${problem.kind}-${i}`} problem={problem} now={now} />
          ))}
        </section>
      )}

      <section className="section" aria-labelledby="suggested-title">
        <h2 className="section__title" id="suggested-title">
          Suggested
          {analysis.suggestions.length > 0 && (
            <span className="section__count">{Math.min(3, analysis.suggestions.length)}</span>
          )}
        </h2>

        {analysis.suggestions.length === 0 ? (
          <div className="empty">
            <QuietMark className="empty__mark" />
            <p className="empty__title">All quiet here</p>
            <p>Bubiqo stays out of the way unless it has something genuinely useful.</p>
            <p style={{ marginTop: 10 }}>
              It has most to say on an email that asks you for something, an invoice, a job advert,
              or anything carrying a date you would rather not forget.
            </p>
          </div>
        ) : (
          <>
            {primary.map((suggestion) => (
              <SuggestionCard
                key={suggestion.actionId}
                suggestion={suggestion}
                batchRan={Boolean(report)}
                busy={busy}
                state={props.cardState[suggestion.actionId]}
                alreadySaved={suggestion.actionId === "save_to_memory" || suggestion.actionId === "copy_details" ? state?.alreadySaved : undefined}
                onRun={props.onRun}
                onUndo={props.onUndo}
                onCopy={props.onCopy}
                onDownload={props.onDownload}
                onDismiss={props.onDismiss}
                onShowMemory={props.onShowMemory}
              />
            ))}

            {more.length > 0 && (
              <details className="why disclosure" style={{ marginTop: 12 }}>
                <summary>More actions ({more.length})</summary>
                <div style={{ marginTop: 8 }}>
                  {more.map((suggestion) => (
                    <SuggestionCard
                      key={suggestion.actionId}
                      suggestion={suggestion}
                      batchRan={Boolean(report)}
                      busy={busy}
                      state={props.cardState[suggestion.actionId]}
                      alreadySaved={suggestion.actionId === "save_to_memory" || suggestion.actionId === "copy_details" ? state?.alreadySaved : undefined}
                      onRun={props.onRun}
                      onUndo={props.onUndo}
                      onCopy={props.onCopy}
                      onDownload={props.onDownload}
                      onDismiss={props.onDismiss}
                      onShowMemory={props.onShowMemory}
                    />
                  ))}
                </div>
              </details>
            )}

            {safeSuggestions.length > 1 && (
              <div className="complete-all" style={{ marginTop: 14 }}>
                <button className="btn btn--primary" onClick={props.onCompleteIt} disabled={busy || allDone}>
                  {allDone ? (
                    <>
                      <TickMark className="btn__mark" />
                      {waitingOnYou > 0 ? `${safeSuggestions.length} done · ${waitingOnYou} needs you` : "All done"}
                    </>
                  ) : busy ? (
                    <>
                      <span className="spinner" aria-hidden="true" />
                      Working…
                    </>
                  ) : (
                    <>
                      <BubbleMark className="btn__mark" />
                      {`Complete all ${safeSuggestions.length}`}
                    </>
                  )}
                </button>
                <p className="why" style={{ marginTop: 6 }}>
                  Runs the {safeSuggestions.length} safe steps above, checks each one worked, and tells you
                  what happened. Nothing is sent and nothing is paid.
                </p>
              </div>
            )}
          </>
        )}

        {outcomes.length > 0 && (
          <Results
            outcomes={outcomes}
            onUndo={props.onUndo}
            onCopy={props.onCopy}
            onDownload={props.onDownload}
          />
        )}
      </section>


            <BriefingBlock briefing={briefing} now={now} />

      {state?.siteOrigin && !state.siteAccessGranted && (
        <section className="section">
          <div className="notice">
            <strong>Reading {new URL(state.siteOrigin).hostname} each time?</strong>
            <p style={{ margin: "6px 0 10px" }}>
              Right now Bubiqo can only read this page when you open it from the toolbar. Allow
              this one site and it will keep up as you move between messages.
            </p>
            <button className="btn btn--small" onClick={() => props.onGrantSite(state.siteOrigin!)}>
              Allow {new URL(state.siteOrigin).hostname}
            </button>
          </div>
        </section>
      )}

      <section className="section reread">
        <button className="btn btn--small" onClick={props.onRefresh} disabled={busy} aria-live="polite">
          <RefreshMark className="btn__mark" />
          {busy ? "Reading this page…" : "Re-read this page"}
        </button>
      </section>
    </>
  );
}

function ProblemRow({ problem, now }: { problem: Problem; now: number }) {
  const modifier =
    problem.kind === "eligibility"
      ? "problem--blocking"
      : problem.urgency === "overdue"
        ? "problem--overdue"
        : problem.urgency === "today"
          ? "problem--today"
          : "";
  return (
    <div className={`problem ${modifier}`}>
      <span className="problem__dot" aria-hidden="true" />
      <div className="problem__body">
        <p className="problem__summary">{problem.summary}</p>
        <p className="problem__meta">
          <span className={`urgency urgency--${problem.kind === "eligibility" ? "overdue" : problem.urgency}`}>
            {problem.kind === "eligibility" ? "Must have" : urgencyWord(problem.urgency)}
          </span>
          {problem.dueAt ? ` · ${formatDue(problem.dueAt, now)}` : ""}
        </p>
      </div>
    </div>
  );
}

/** What the panel shell offers anything deep in the tree: new state, and the way to Memory. */
const PanelActions = createContext<{
  apply: (response: Response) => void;
  showMemory: () => void;
  copy: (text: string) => Promise<void>;
}>({ apply: () => undefined, showMemory: () => undefined, copy: async () => undefined });

/**
 * Copy, undo the copy, and keep the details.
 *
 * Every press answers on the button that was pressed. "Save to Memory" used to
 * run and report its result on a different card, often off screen, so from where
 * the user was looking nothing happened at all. Now it goes Saving, then Saved
 * with a way to see it and a way to take it back.
 *
 * Undoing a copy clears the clipboard. Chrome will not let an extension read what
 * was there before without asking for clipboard access, so "put back what I had"
 * is not on offer, and the label does not pretend otherwise.
 */
function DetailsActions({ text, alreadySaved = false }: { text: string; alreadySaved?: boolean }) {
  const { apply, showMemory, copy } = useContext(PanelActions);
  const [copied, setCopied] = useState<"idle" | "copied" | "cleared">("idle");
  const [save, setSave] = useState<
    { kind: "idle" } | { kind: "saving" } | { kind: "saved"; undo?: string } | { kind: "error"; message: string }
  >({ kind: "idle" });

  const doCopy = async (): Promise<void> => {
    await copy(text);
    setCopied("copied");
  };

  const undoCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText("");
    } catch {
      // The clipboard refused; say nothing changed rather than claim it did.
      return;
    }
    setCopied("cleared");
    setTimeout(() => setCopied((now) => (now === "cleared" ? "idle" : now)), 2400);
  };

  const doSave = async (): Promise<void> => {
    setSave({ kind: "saving" });
    try {
      const response = await send({ type: "RUN_ACTION", actionId: "save_to_memory", approved: false });
      if (response.type === "STEP" && (response.outcome.status === "done" || response.outcome.status === "unconfirmed")) {
        setSave({ kind: "saved", ...(response.outcome.undoHandle ? { undo: response.outcome.undoHandle } : {}) });
        apply(await send({ type: "GET_STATE" }));
      } else {
        setSave({
          kind: "error",
          message: response.type === "STEP" ? response.outcome.message : "Could not save. Try again.",
        });
      }
    } catch {
      setSave({ kind: "error", message: "Could not save. Try again." });
    }
  };

  const undoSave = async (handle: string): Promise<void> => {
    await send({ type: "UNDO", actionId: "save_to_memory", handle });
    setSave({ kind: "idle" });
    apply(await send({ type: "GET_STATE" }));
  };

  return (
    <>
      {copied === "copied" ? (
        <>
          <span className="done-chip" role="status">
            <TickMark className="done-chip__tick" />
            Copied
          </span>
          <button className="tool tool--quiet" onClick={() => void undoCopy()}>
            Undo copy
          </button>
        </>
      ) : (
        <button className="tool" onClick={() => void doCopy()}>
          <CopyMark className="tool__mark" />
          {copied === "cleared" ? "Cleared. Copy again" : "Copy"}
        </button>
      )}

      {save.kind === "saved" ? (
        <span className="done-chip done-chip--saved" role="status">
          <TickMark className="done-chip__tick" />
          Saved to Memory
          <button className="btn--link" onClick={showMemory}>View</button>
          {save.undo && (
            <button className="btn--link btn--link-quiet" onClick={() => void undoSave(save.undo!)}>
              Undo
            </button>
          )}
        </span>
      ) : (
        <button
          className="tool"
          onClick={() => void doSave()}
          disabled={save.kind === "saving"}
          aria-busy={save.kind === "saving"}
        >
          {save.kind === "saving" ? (
            <>
              <span className="spinner" aria-hidden="true" />
              Saving
            </>
          ) : (
            <>
              <KeepMark className="tool__mark" />
              {alreadySaved ? "Save again" : "Save to Memory"}
            </>
          )}
        </button>
      )}

      {save.kind === "error" && (
        <p className="inline-error" role="alert">
          {save.message}
        </p>
      )}
    </>
  );
}

/** "Payout of £130.63", "Bill of £48.56 due", said once, in the header. */
function moneyHeadline(summary: MoneySummary): string {
  const amount = displayMoney(summary.headline.value);
  if (summary.kind === "payout") return `Payout of ${amount}`;
  if (summary.kind === "receipt") return `You paid ${amount}`;
  if (summary.kind === "statement") return `Statement: ${amount}`;
  return `Bill of ${amount} coming up`;
}

/**
 * A job alert, read as the list it is.
 *
 * Each role gets its own row: title first because that is what decides whether
 * it is worth a look, then who, then pay and where as small facts.
 */
function ListingsBlock({ listings }: { listings: readonly Listing[] | undefined }) {
  const { copy } = useContext(PanelActions);
  const [copied, setCopied] = useState(false);
  if (!listings || listings.length === 0) return null;
  return (
    <section className="feature listings" data-surface="job" aria-labelledby="listings-title">
      <header className="feature__band">
        <span className="feature__icon" aria-hidden="true">
          <SurfaceMark surface="job" className="feature__mark" />
        </span>
        <span className="feature__titles">
          <span className="feature__kind" id="listings-title">
            {listings.length} job matches
          </span>
          <span className="feature__from">One line each, pay and place where the email gives them</span>
        </span>
      </header>
      <ol className="listings__list">
        {listings.map((l, i) => (
          <li className="listings__item" key={`${l.title}-${i}`}>
            <p className="listings__title">{l.title}</p>
            {l.company && <p className="listings__company">{l.company}</p>}
            {(l.pay || l.where) && (
              <p className="listings__facts">
                {l.pay && <span className="listings__fact listings__fact--pay">{l.pay}</span>}
                {l.where && <span className="listings__fact">{l.where}</span>}
              </p>
            )}
          </li>
        ))}
      </ol>
      <div className="toolbar money__tools">
        <button
          className={`tool${copied ? " tool--done" : ""}`}
          onClick={async () => {
            await copy(listingLines(listings).join("\n"));
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? <TickMark className="tool__mark" /> : <CopyMark className="tool__mark" />}
          {copied ? "Copied" : "Copy the list"}
        </button>
      </div>
    </section>
  );
}

const MONEY_TITLE: Record<MoneySummary["kind"], string> = {
  bill: "Next bill",
  payout: "Payout",
  receipt: "Receipt",
  statement: "Statement",
};

const amountOf = (value: string): number => Math.abs(Number(value.split(" ")[1] ?? "0")) || 0;

/**
 * The money on this page, read the way its sender meant it.
 *
 * A bill leads with what is leaving and when. A payout leads with what arrived,
 * then shows where the rest of the takings went, as a bar and as a list, so
 * "£214.85 processed, £130.63 paid out" stops being two numbers you have to
 * reconcile yourself.
 */
function MoneyBlock({ summary, now }: { summary: MoneySummary | undefined; now: number }) {
  const { copy } = useContext(PanelActions);
  const [copied, setCopied] = useState(false);
  if (!summary) return null;

  const { kind, headline, lines } = summary;
  const days = summary.dueAt !== undefined ? Math.round((summary.dueAt - now) / 86_400_000) : undefined;
  const dateText =
    summary.dueAt === undefined
      ? undefined
      : new Date(summary.dueAt).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const whenLabel = kind === "bill" ? "Leaves" : kind === "receipt" ? "Paid" : "Report for";
  const inDays =
    kind !== "bill" || days === undefined ? "" : days < 0 ? "" : days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;

  // The breakdown bar: only meaningful when there is a gross to divide.
  const gross = lines.find((l) => l.role === "gross") ?? (headline.role === "gross" ? headline : undefined);
  const all = [headline, ...lines];
  const segments = gross
    ? (["paid", "pending", "deduction"] as const)
        .map((role) => ({
          role,
          total: all.filter((l) => l.role === role).reduce((sum, l) => sum + amountOf(l.value), 0),
        }))
        .filter((seg) => seg.total > 0)
    : [];
  const grossTotal = gross ? amountOf(gross.value) : 0;
  const showBar = segments.length >= 2 && grossTotal > 0;
  const segmentName = { paid: "Paid out", pending: "Still to come", deduction: "Fees and deductions" };

  const tone = (line: MoneyLine): string =>
    / DR$/.test(line.value) || (line.role === "balance" && line.value.includes(" -"))
      ? "money__value--owed"
      : line.role === "deduction" || line.value.includes(" -")
        ? "money__value--out"
        : line.role === "paid"
          ? "money__value--in"
          : "";

  const summaryText = [
    `${MONEY_TITLE[kind]}${summary.from ? `: ${summary.from}` : ""}`,
    `${headline.label}: ${displayMoney(headline.value)}`,
    ...lines.map((l) => `${l.label}: ${displayMoney(l.value)}`),
    dateText ? `${whenLabel}: ${dateText}` : "",
    summary.account ? `Reference: ${summary.account}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <section className={`feature money money--${kind}`} data-surface="invoice" aria-labelledby="money-title">
      <header className="feature__band">
        <span className="feature__icon" aria-hidden="true">
          <SurfaceMark surface="invoice" className="feature__mark" />
        </span>
        <span className="feature__titles">
          <span className="feature__kind" id="money-title">
            {MONEY_TITLE[kind]}
          </span>
          {summary.from && <span className="feature__from">{summary.from}</span>}
        </span>
      </header>

      <div className="money__hero">
        <p className="money__amount">{displayMoney(headline.value)}</p>
        <p className="money__label">{headline.label}</p>
        {dateText && (
          <p className="money__when">
            {whenLabel} {dateText}
            {inDays && <span className="money__in">{inDays}</span>}
          </p>
        )}
      </div>

      {showBar && (
        <figure className="money__bar" aria-label={`Where the ${displayMoney(gross!.value)} went`}>
          <div className="money__track">
            {segments.map((seg) => (
              <span
                key={seg.role}
                className={`money__seg money__seg--${seg.role}`}
                style={{ flexGrow: Math.max(seg.total / grossTotal, 0.02) }}
              />
            ))}
          </div>
          <figcaption className="money__legend">
            {segments.map((seg) => (
              <span key={seg.role} className="money__key">
                <span className={`money__dot money__seg--${seg.role}`} aria-hidden="true" />
                {segmentName[seg.role]} {Math.round((seg.total / grossTotal) * 100)}%
              </span>
            ))}
          </figcaption>
        </figure>
      )}

      {lines.length > 0 && (
        <dl className="money__lines">
          {lines.map((line) => (
            <div className={`money__row${line.role === "gross" ? " money__row--gross" : ""}`} key={`${line.label}-${line.value}`}>
              <dt>{line.label}</dt>
              <dd className={tone(line)}>{displayMoney(line.value)}</dd>
            </div>
          ))}
          {summary.account && (
            <div className="money__row">
              <dt>Reference</dt>
              <dd>{summary.account}</dd>
            </div>
          )}
        </dl>
      )}

      <div className="toolbar money__tools">
        <button
          className={`tool${copied ? " tool--done" : ""}`}
          onClick={async () => {
            await copy(summaryText);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? <TickMark className="tool__mark" /> : <CopyMark className="tool__mark" />}
          {copied ? "Copied" : "Copy details"}
        </button>
      </div>
    </section>
  );
}

function SuggestionCard({
  suggestion,
  busy,
  state,
  alreadySaved,
  onRun,
  onUndo,
  onCopy: _onCopy,
  onDownload,
  onDismiss,
  onShowMemory,
  batchRan = false,
}: {
  suggestion: Suggestion;
  /** "Complete all" has run on this page; approval steps it skipped say so. */
  batchRan?: boolean;
  busy: boolean;
  state?: "running" | StepOutcome;
  alreadySaved?: { id: string; title: string; savedAt: number };
  onRun: (id: string, approved?: boolean) => void;
  onUndo: (id: string, handle: string) => void;
  onCopy: (text: string) => void;
  onDownload: (handle: string) => void;
  onDismiss: (id: string) => void;
  onShowMemory: () => void;
}) {
  const needsApproval = suggestion.risk === "confirm";
  const undoable = suggestion.actionId !== "copy_details" && suggestion.actionId !== "open_application_link";
  const running = state === "running";
  const outcome = typeof state === "object" ? state : undefined;
  const finished = outcome?.status === "done" || outcome?.status === "unconfirmed";

  const tone =
    outcome?.status === "done"
      ? "done"
      : outcome?.status === "failed" || outcome?.status === "refused"
        ? "fail"
        : outcome
          ? "warn"
          : undefined;

  return (
    <article className={`suggestion${outcome ? ` suggestion--${tone}` : ""}${running ? " suggestion--running" : ""}`}>
      <span className="suggestion__icon" data-action={suggestion.actionId} aria-hidden="true">
        <ActionIcon actionId={suggestion.actionId} />
      </span>

      <div className="suggestion__body">
        <div className="suggestion__head">
          <h3 className="suggestion__name">{suggestion.name}</h3>
          {needsApproval && <span className="badge badge--confirm">{riskLabel(suggestion.risk)}</span>}
        </div>

        <p className="suggestion__rationale">{suggestion.rationale}</p>

        {/*
          * Complete all only runs safe steps. The card it skipped used to look
          * exactly as before, which read as "nothing happened". It now says why
          * it is still waiting.
          */}
        {batchRan && needsApproval && !outcome && !running && (
          <p className="still-needs">
            <span className="still-needs__dot" aria-hidden="true" />
            Still needs you. Complete all skipped this because it leaves this page.
          </p>
        )}

        {/*
          * Knowing you already have something is useful WHILE you have it. Saving
          * again is harmless — it refreshes the existing record rather than
          * duplicating — so this is information, not a barrier.
          */}
        {alreadySaved && !outcome && suggestion.actionId === "save_to_memory" && (
          <p className="already">
            <span className="already__tick" aria-hidden="true">✓</span>
            Already in Memory, saved {relativeTime(alreadySaved.savedAt, Date.now())}.{" "}
            <button className="btn--link" onClick={onShowMemory}>
              Show it
            </button>
          </p>
        )}

        {/*
          * A finished action does not need its own controls any more.
          *
          * The card kept a greyed-out "Done" button, a "Why?" link and a full
          * result panel — three pieces of furniture for something already over,
          * and the disabled button was the loudest thing on it. When a step has
          * succeeded the card says so in one line and offers the one thing still
          * worth doing, which is undoing it.
          */}
        {!finished && (
        <div className="suggestion__row">
          <button
            className="btn btn--action"
            onClick={() => onRun(suggestion.actionId, needsApproval)}
            disabled={busy || running || finished}
            aria-describedby={outcome ? `${suggestion.actionId}-result` : undefined}
          >
            {running ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Working…
              </>
            ) : finished ? (
              "Done"
            ) : alreadySaved && suggestion.actionId === "save_to_memory" ? (
              "Save again"
            ) : needsApproval && suggestion.actionId === "open_application_link" ? (
              <>
                <OpenMark className="btn__mark" />
                Open application
              </>
            ) : needsApproval ? (
              "Approve and do it"
            ) : (
              "Do it"
            )}
          </button>

          {/*
            * The disclosure used to repeat the rationale word for word under the
            * heading "What Bubiqo found" — the same sentence twice, which makes the
            * explanation look like padding. It now only carries what the card does
            * not already say.
            */}
          <details className="why suggestion__why">
            <summary>Why?</summary>
            <dl>
              <dt>Risk</dt>
              <dd>
                {riskLabel(suggestion.risk)}
                {suggestion.risk === "safe" && " — reads the page or saves something on this device."}
              </dd>
              <dt>Can it be undone?</dt>
              <dd>
                {undoable
                  ? "Yes — an Undo appears next to the result."
                  : suggestion.actionId === "copy_details"
                    ? "No. The clipboard cannot be put back."
                    : "No. It opens a page in a new tab."}
              </dd>
              <dt>Leaves this device?</dt>
              <dd>No.</dd>
            </dl>
          </details>

          {!outcome && !running && (
            <button
              className="tool tool--quiet suggestion__dismiss"
              onClick={() => onDismiss(suggestion.actionId)}
              title="Stop suggesting this"
            >
              Not useful
            </button>
          )}
  
          {/*
            * The answer to the click, on the card that was clicked. Carries whatever
            * the step produced — the file to download, the text to copy — and the
            * Undo, so the user never has to go looking for the consequence of their
            * own action.
            */}
        </div>
        )}

        {outcome && (
            <div className={`outcome outcome--${tone}${finished ? " outcome--compact" : ""}`} id={`${suggestion.actionId}-result`} role="status">
              <span className={`result__mark result__mark--${tone}`} aria-hidden="true">
                {tone === "done" ? "✓" : tone === "fail" ? "×" : "!"}
              </span>
              <div className="outcome__body">
                <p className="outcome__message">{outcome.message}</p>
                {/*
                  * The details used to live only inside the Copy button: you could
                  * put them on the clipboard but never read them. Show what will be
                  * copied, so the user can check it before it goes anywhere.
                  */}
                {suggestion.actionId === "copy_details" && outcome.handle && <DetailsPreview text={outcome.handle} />}
                <div className="outcome__actions">
                  {suggestion.actionId === "copy_details" && outcome.handle && (
                    <DetailsActions text={outcome.handle} alreadySaved={Boolean(alreadySaved)} />
                  )}
                  {suggestion.actionId === "export_calendar_event" && outcome.handle && (
                    <button className="btn btn--small" onClick={() => onDownload(outcome.handle!)}>
                      Download .ics
                    </button>
                  )}
                  {undoable && outcome.undoHandle && (
                    <button
                      className="btn btn--quiet btn--small"
                      onClick={() => onUndo(outcome.actionId, outcome.undoHandle!)}
                    >
                      Undo
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}


        {/*
          * One obvious thing to press on the left; everything else quiet and to
          * the right. Three controls at the same weight meant none of them read
          * as the action — and "Not useful" sitting alone below looked like a
          * caption rather than a button.
          */}

      </div>
    </article>
  );
}

function Results({
  outcomes,
  onUndo,
  onCopy: _onCopy,
  onDownload,
}: {
  outcomes: readonly StepOutcome[];
  onUndo: (id: string, handle: string) => void;
  onCopy: (text: string) => void;
  onDownload: (handle: string) => void;
}) {
  return (
    <div className="result">
      <h3 className="section__title" style={{ marginTop: 18 }}>What happened</h3>
      {outcomes.map((outcome, i) => {
        const mark =
          outcome.status === "done" ? "✓" : outcome.status === "unconfirmed" ? "!" : outcome.status === "needs_approval" ? "?" : "×";
        const markClass =
          outcome.status === "done" ? "done" : outcome.status === "unconfirmed" || outcome.status === "needs_approval" ? "warn" : "fail";
        return (
          <div className="result__item" key={`${outcome.actionId}-${i}`}>
            <span className={`result__mark result__mark--${markClass}`} aria-hidden="true">{mark}</span>
            <span>
              <strong>{outcome.name}</strong> — {outcome.message}

              {/* Whatever a step produced, this is where the user collects it. */}
              {outcome.actionId === "copy_details" && outcome.handle && (
                <>
                  <DetailsPreview text={outcome.handle} />
                  <span className="outcome__actions">
                    <DetailsActions text={outcome.handle} />
                  </span>
                </>
              )}

              {outcome.actionId === "export_calendar_event" && outcome.handle && (
                <>
                  {" "}
                  <button className="btn btn--small" onClick={() => onDownload(outcome.handle!)}>
                    Download .ics
                  </button>
                </>
              )}

              {outcome.undoable && outcome.undoHandle && (
                <>
                  {" "}
                  <button
                    className="btn btn--quiet btn--small"
                    onClick={() => onUndo(outcome.actionId, outcome.undoHandle!)}
                  >
                    Undo
                  </button>
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The job brief: whether this advert is worth an hour.
 *
 * Blockers first, each with the advert's own sentence under it, because a
 * condition the reader cannot meet makes everything below it irrelevant. Then the
 * facts they would otherwise scroll for, then the advert's eligibility wording
 * quoted behind a disclosure.
 *
 * Every fact says where it came from. "Stated by the site" means the page
 * published it as structured data; "read from the advert" means we matched it out
 * of prose and could be wrong about it. Collapsing that distinction would be the
 * dishonest kind of confidence.
 */

/**
 * One saved item.
 *
 * A saved job used to be a title and a column of type/value pairs, which told the
 * reader almost nothing and read like a database row. What someone goes back to a
 * saved advert for is: what was it, who for, what did it pay, when does it close,
 * what did it ask for, who do I contact, and where do I find it again. That is the
 * order this shows them in.
 */
/**
 * A saved job, as text somebody can paste to another person.
 *
 * Sharing is the one thing a saved advert is for that the panel could not do:
 * the details were kept and there was no way to get them out except by reading
 * them off the screen. Plain text, not a link to anything of ours — what leaves
 * the machine is exactly what is on the card, and nothing else.
 */
export function shareText(item: MemoryItem): string {
  const of = (type: EntityType) => item.entities.find((e) => e.type === type);
  const all = (type: EntityType) => item.entities.filter((e) => e.type === type);

  const lines: string[] = [item.title];

  const employer = of("organisation");
  if (employer) lines.push(employer.value);

  const salary = of("amount");
  if (salary) lines.push(`Pay: ${displayMoney(salary.value)}`);

  const where = of("address");
  if (where) lines.push(`Where: ${where.value}`);

  const closes = of("deadline");
  if (closes?.resolvedAt) lines.push(`Closes: ${new Date(closes.resolvedAt).toDateString()}`);

  const blockers = all("blocker");
  if (blockers.length > 0) lines.push(`Conditions: ${blockers.map((b) => b.value).join(", ")}`);

  const requirements = all("requirement");
  if (requirements.length > 0) {
    lines.push("", "What it asks for:");
    for (const requirement of requirements) lines.push(`• ${requirement.value}`);
  }

  const contacts = [of("email"), of("phone"), of("person")].filter((e): e is Entity => e !== undefined);
  if (contacts.length > 0) lines.push("", `Contact: ${contacts.map((c) => c.value).join(" · ")}`);

  const link = of("url")?.value ?? item.url;
  if (link) lines.push("", link);

  return lines.join("\n");
}

/**
 * One saved item.
 *
 * A saved job used to be a title and a column of type/value pairs, which is a
 * database row rather than something a person can act on. What someone goes back
 * to a saved advert for is: what was it, who for, what did it pay, where, when
 * does it close, what did it ask for, who do I contact, and where do I find it
 * again. That is the order this shows them in.
 */

/**
 * One reminder.
 *
 * Deleting asks first, the same as a saved job does. It did not, and a reminder
 * is the one thing in here whose whole purpose is to exist at a moment in the
 * future: delete it by accident and nothing tells you it is gone until the
 * moment it was meant to fire has passed.
 */
function ReminderCard({
  reminder,
  now,
  onChange,
  delayMs,
}: {
  reminder: Reminder;
  now: number;
  onChange: (response: Response) => void;
  delayMs: number;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="card card--reminder" style={{ animationDelay: `${delayMs}ms` }}>
      <div className="card__head">
        <div>
          <p className="card__title">{reminder.title}</p>
          <p className="card__meta">
            <span className={`due due--${describeUrgency(reminder.dueAt, now)}`}>
              {formatDue(reminder.dueAt, now)}
            </span>
            {" · "}
            {clockTime(reminder.dueAt)}
          </p>
        </div>
        <span className="kind kind--reminder">reminder</span>
      </div>

      <div className="toolbar card__actions">
        {confirming ? (
          <span className="toolbar__confirm" role="group" aria-label="Confirm delete">
            <button
              className="tool tool--danger-solid"
              onClick={async () => {
                setConfirming(false);
                onChange(await send({ type: "DELETE_REMINDER", id: reminder.id }));
              }}
            >
              <TrashMark className="tool__mark" />
              Delete this reminder
            </button>
            <button className="tool tool--quiet" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </span>
        ) : (
          <button
            className="tool tool--icon tool--danger"
            onClick={() => setConfirming(true)}
            aria-label={`Delete reminder: ${reminder.title}`}
            title="Delete"
          >
            <TrashMark className="tool__mark" />
          </button>
        )}
      </div>
    </li>
  );
}

/** "type: value" lines, as copy_details prepares them, laid out as a readable list. */
function DetailsPreview({ text }: { text: string }) {
  const rows = text.split("\n").map((line) => {
    const at = line.indexOf(": ");
    return at > 0 ? { label: line.slice(0, at), value: line.slice(at + 2) } : { label: "", value: line };
  });
  return (
    <dl className={`details${rows.every((row) => !row.label) ? " details--list" : ""}`}>
      {rows.map((row, i) => (
        <div className="details__row" key={`${row.label}-${i}`}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SavedItem({
  item,
  now,
  onChange,
  onCopy,
}: {
  item: MemoryItem;
  now: number;
  onChange: (response: Response) => void;
  onCopy?: (text: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [shared, setShared] = useState<string | undefined>();

  const of = (type: EntityType) => item.entities.find((e) => e.type === type);
  const all = (type: EntityType) => item.entities.filter((e) => e.type === type);

  const employer = of("organisation");
  const salary = of("amount");
  const where = of("address");
  const closes = of("deadline");
  const contract = of("employment_type");
  const pattern = of("working_pattern");
  const link = of("url")?.value ?? item.url;
  const requirements = all("requirement");
  const blockers = all("blocker");
  const contacts = [of("email"), of("phone"), of("person")].filter((e): e is Entity => e !== undefined);

  const isJob = item.kind === "job";
  /*
   * The card was written for job adverts. A saved email or invoice has none of
   * those fields, so it showed a title and nothing else — the details were stored
   * but there was no way to see them. Anything the job layout does not show is
   * listed here instead.
   */
  const shownTypes: readonly EntityType[] = isJob
    ? ["job_title", "organisation", "amount", "address", "deadline", "employment_type", "working_pattern", "url", "requirement", "blocker", "email", "phone", "person"]
    : ["url"];
  const otherDetails = item.entities.filter((e) => !shownTypes.includes(e.type));
  const detailsText = item.entities.filter((e) => e.type !== "currency").map((e) => `${e.type.replace(/_/g, " ")}: ${e.type === "amount" ? displayMoney(e.value) : e.value}`).join("\n");

  const facts: { label: string; value: string }[] = !isJob ? [] : [
    ...(salary ? [{ label: "Pay", value: displayMoney(salary.value) }] : []),
    ...(where ? [{ label: "Where", value: where.value }] : []),
    ...(closes?.resolvedAt ? [{ label: "Closes", value: formatDue(closes.resolvedAt, now) }] : []),
    ...(contract ? [{ label: "Contract", value: contract.value }] : []),
    ...(pattern ? [{ label: "Pattern", value: pattern.value }] : []),
  ];

  const source = (() => {
    try {
      return link ? new URL(link).hostname.replace(/^www\./, "") : undefined;
    } catch {
      return undefined;
    }
  })();

  /*
   * Share where the browser offers it, copy where it does not. navigator.share
   * needs a user gesture and is not present everywhere, and a button that
   * silently does nothing is worse than one that does the plain thing.
   */
  const share = async (): Promise<void> => {
    const text = shareText(item);
    const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

    if (canShare) {
      try {
        await navigator.share({ title: item.title, text });
        setShared("Shared");
        return;
      } catch {
        // Cancelled, or refused. Fall through to copying rather than failing.
      }
    }

    onCopy?.(text);
    setShared("Copied. Paste it anywhere");
    setTimeout(() => setShared(undefined), 2600);
  };

  return (
    <li className="card">
      <div className="card__head">
        <div>
          <p className="card__title">{item.title}</p>
          <p className="card__meta">
            {employer ? <span className="card__employer">{employer.value}</span> : null}
            {employer ? " · " : ""}
            saved {relativeTime(item.savedAt, now)}
            {source ? ` · ${source}` : ""}
          </p>
        </div>
        <span className={`kind kind--${item.kind}`}>
          <SurfaceMark
            surface={item.kind === "job" ? "job" : item.kind === "invoice" ? "invoice" : item.kind === "note" ? "email" : "generic"}
            className="kind__mark"
          />
          {item.kind}
        </span>
      </div>

      {isJob && blockers.length > 0 && (
        <p className="card__verdict">
          <BlockMark className="verdict__mark" />
          Ruled out — {blockers.map((b) => b.value).join(", ")}
        </p>
      )}

      {facts.length > 0 && (
        <dl className="facts">
          {facts.map((fact) => (
            <div className="facts__item" key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {otherDetails.length > 0 && (
        <DetailsPreview
          text={otherDetails.map((e) => `${e.type.replace(/_/g, " ")}: ${e.type === "amount" ? displayMoney(e.value) : e.value}`).join("\n")}
        />
      )}

      {isJob && requirements.length > 0 && (
        <details className="why disclosure" open={requirements.length <= 3}>
          <summary>
            What it asked for
            <span className="section__count">{requirements.length}</span>
          </summary>
          <ul className="bullets">
            {requirements.map((requirement) => (
              <li key={requirement.value}>{requirement.value}</li>
            ))}
          </ul>
        </details>
      )}

      {isJob && contacts.length > 0 && (
        <p className="card__contact">
          <span className="card__contactLabel">Contact</span>
          {contacts.map((contact) => contact.value).join(" · ")}
        </p>
      )}

      <div className="toolbar card__actions">
        {link && (
          <a className="tool" href={link} target="_blank" rel="noreferrer noopener" title={link}>
            <OpenMark className="tool__mark" />
            {isJob ? "Open advert" : "Open page"}
          </a>
        )}
        {detailsText && onCopy && (
          <button
            className={`tool${shared === "Copied" ? " tool--done" : ""}`}
            onClick={() => {
              onCopy(detailsText);
              setShared("Copied");
              setTimeout(() => setShared(undefined), 2000);
            }}
          >
            {shared === "Copied" ? <TickMark className="tool__mark" /> : <CopyMark className="tool__mark" />}
            {shared === "Copied" ? "Copied" : "Copy"}
          </button>
        )}
        <button className="tool" onClick={() => void share()}>
          <ShareMark className="tool__mark" />
          Share
        </button>

        {confirming ? (
          <span className="toolbar__confirm" role="group" aria-label="Confirm delete">
            <button
              className="tool tool--danger-solid"
              onClick={async () => {
                setConfirming(false);
                onChange(await send({ type: "DELETE_MEMORY", id: item.id }));
              }}
            >
              <TrashMark className="tool__mark" />
              Delete for good
            </button>
            <button className="tool tool--quiet" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </span>
        ) : (
          <button
            className="tool tool--icon tool--danger"
            onClick={() => setConfirming(true)}
            aria-label={`Delete ${item.title}`}
            title="Delete"
          >
            <TrashMark className="tool__mark" />
          </button>
        )}
      </div>

      {shared && (
        <p className="card__flash" role="status">
          {shared}
        </p>
      )}
    </li>
  );
}

export function JobBriefBlock({
  brief,
  now,
  onHoldCondition,
}: {
  brief: JobBrief | undefined;
  now: number;
  /** Record that the user does, or no longer does, meet a condition. */
  onHoldCondition?: (rule: string, held: boolean) => void;
}) {
  if (!brief) return null;

  const outstanding = brief.blockers.filter((blocker) => !blocker.held).length;

  const facts: { label: string; field: BriefField<string | number> | undefined; value?: string }[] = [
    { label: "Pay", field: brief.salary, value: brief.salary ? displayMoney(brief.salary.value) : undefined },
    { label: "Closes", field: brief.closingDate, value: brief.closingDate ? formatDue(brief.closingDate.value, now) : undefined },
    { label: "Pattern", field: brief.workingPattern },
    { label: "Where", field: brief.location },
    { label: "Contract", field: brief.employmentType },
  ];
  const shown = facts.filter((fact) => fact.field !== undefined);

  if (brief.blockers.length === 0 && shown.length === 0 && brief.eligibility.length === 0) return null;

  /*
   * Provenance once, as a legend, not repeated under every fact.
   *
   * "Read from the advert" under five consecutive rows is five identical lines of
   * grey text: it stops being information and becomes texture. A dot against each
   * fact, explained once, says the same thing and leaves the facts legible.
   */
  const anyStructured = shown.some((fact) => fact.field?.source === "structured");
  const anyProse = shown.some((fact) => fact.field?.source === "prose");

  return (
    <section className="section feature brief" data-surface="job" aria-labelledby="job-brief-title">
      <div className="feature__band">
        <span className="feature__icon" aria-hidden="true">
          <SurfaceMark surface="job" className="feature__mark" />
        </span>
        <span className="feature__titles">
          <span className="feature__kind">Job advert</span>
        </span>
      </div>
      <div className="brief__head">
        <div className="brief__heading">
          <h2 className="brief__title" id="job-brief-title">
            {brief.title?.value ?? "This job"}
          </h2>
          {brief.organisation && <p className="brief__employer">{brief.organisation.value}</p>}
        </div>
      </div>

      {brief.blockers.length > 0 && (
        /*
         * Conditions the advert sets — never a verdict on the reader.
         *
         * This said "Ruled out". It cannot know: a DBS check can be obtained, a
         * licence can be earned, the reader may already hold either. So it states
         * what the advert asks, quotes where it asks it, and offers one press to
         * say "I have this" — which is remembered, so the next advert asking for
         * the same thing shows it as met.
         */
        <div className={`verdict${outstanding === 0 ? " verdict--met" : ""}`} role="status">
          <p className="verdict__headline">
            {outstanding === 0 ? <TickMark className="verdict__mark" /> : <BlockMark className="verdict__mark" />}
            {outstanding === 0
              ? "You have said you meet everything this asks for"
              : `${outstanding === 1 ? "One condition" : `${outstanding} conditions`} to check before applying`}
          </p>
          <ul className="verdict__list">
            {brief.blockers.map((blocker) => (
              <li key={blocker.rule} className={blocker.held ? "verdict__item--held" : undefined}>
                <span className="verdict__name">
                  {blocker.held && <TickMark className="verdict__held" />}
                  {blocker.summary}
                </span>
                <span className="verdict__quote">“{blocker.evidence}”</span>
                {onHoldCondition && (
                  <button
                    className="btn btn--quiet btn--small verdict__claim"
                    onClick={() => onHoldCondition(blocker.rule, !blocker.held)}
                  >
                    {blocker.held ? "I do not have this" : "I have this"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {shown.length > 0 && (
        <dl className="facts facts--brief">
          {shown.map((fact, index) => (
            <div
              className="facts__item facts__item--enter"
              key={fact.label}
              style={{ animationDelay: `${index * 40}ms` }}
            >
              <dt>
                {fact.label}
                <span
                  className={`source source--${fact.field?.source ?? "prose"}`}
                  aria-label={fact.field?.source === "structured" ? "stated by the site" : "read from the advert"}
                />
              </dt>
              <dd>{fact.value ?? String(fact.field?.value ?? "")}</dd>
            </div>
          ))}
        </dl>
      )}

      {(anyStructured || anyProse) && (
        <p className="legend">
          {anyStructured && (
            <span>
              <span className="source source--structured" aria-hidden="true" /> stated by the site
            </span>
          )}
          {anyProse && (
            <span>
              <span className="source source--prose" aria-hidden="true" /> read from the advert
            </span>
          )}
        </p>
      )}

      {brief.eligibility.length > 0 && (
        <details className="why disclosure brief__needs" open>
          <summary>
            What the advert says it needs
            <span className="section__count">{brief.eligibility.length}</span>
          </summary>
          <ul className="bullets">
            {brief.eligibility.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}


function BriefingBlock({ briefing, now }: { briefing: Briefing | undefined; now: number }) {
  if (!briefing) return null;
  const nothing =
    briefing.overdue.length === 0 &&
    briefing.dueToday.length === 0 &&
    briefing.loose.length === 0 &&
    briefing.upcoming.length === 0;

  if (nothing) return null;

  return (
    <section className="section" aria-labelledby="briefing-title">
      <h2 className="section__title" id="briefing-title">{briefing.greeting}</h2>
      <ul className="list">
        {[...briefing.overdue, ...briefing.dueToday].map((reminder) => (
          <li className="row" key={reminder.id}>
            <div>
              <p className="row__title">{reminder.title}</p>
              <p className="row__meta">
                <span className={`urgency urgency--${reminder.dueAt < now ? "overdue" : "today"}`}>
                  {reminder.dueAt < now ? "Overdue" : "Today"}
                </span>{" "}
                · {formatDue(reminder.dueAt, now)}
              </p>
            </div>
          </li>
        ))}
        {briefing.loose.map((item) => (
          <li className="row" key={item.title}>
            <div>
              <p className="row__title">{item.title}</p>
              <p className="row__meta">{item.why}</p>
            </div>
          </li>
        ))}
        {briefing.upcoming.slice(0, 2).map((reminder) => (
          <li className="row" key={reminder.id}>
            <div>
              <p className="row__title">{reminder.title}</p>
              <p className="row__meta">{formatDue(reminder.dueAt, now)}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------

/**
 * "Clear all" for one collection.
 *
 * Two steps and inline, matching the activity log. A modal for something this
 * recoverable-by-re-saving would be heavier than the action deserves, but a
 * single unguarded click would not be.
 */
function ClearAll({
  count,
  noun,
  request,
  onChange,
}: {
  count: number;
  noun: string;
  request: Request;
  onChange: (r: Response) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (count === 0) return null;

  return (
    <div className="clear-row">
      {confirming ? (
        <>
          <span className="clear-row__ask">
            Delete all {count} {noun}
            {count === 1 ? "" : "s"}?
          </span>
          <button
            className="btn btn--small btn--danger"
            onClick={async () => {
              setConfirming(false);
              onChange(await send(request));
            }}
          >
            Delete all
          </button>
          <button className="btn btn--quiet btn--small" onClick={() => setConfirming(false)}>
            Keep them
          </button>
        </>
      ) : (
        <button className="btn btn--quiet btn--small" onClick={() => setConfirming(true)}>
          Clear all {noun}s
        </button>
      )}
    </div>
  );
}

function MemoryTab({
  state,
  onChange,
  onCopy,
}: {
  state: PanelState | undefined;
  onChange: (r: Response) => void;
  onCopy: (text: string) => void;
}) {
  const memory = state?.memory ?? [];
  const reminders = state?.reminders ?? [];
  const drafts = state?.drafts ?? [];
  const now = Date.now();

  return (
    <>
      {drafts.length > 0 && (
        <section className="section">
          <h2 className="section__title">
            Drafts
            <span className="section__count">{drafts.length}</span>
          </h2>
          <ClearAll count={drafts.length} noun="draft" request={{ type: "CLEAR_DRAFTS" }} onChange={onChange} />
          <ul className="list">
            {drafts.map((draft) => (
              <li className="row" key={draft.id} style={{ display: "block" }}>
                <p className="row__title">{draft.subject}</p>
                <p className="row__meta">Written {relativeTime(draft.createdAt, now)} · nothing has been sent</p>
                <pre
                  style={{
                    margin: "8px 0 0",
                    whiteSpace: "pre-wrap",
                    fontFamily: "inherit",
                    fontSize: "0.8125rem",
                    color: "var(--ink-soft)",
                    background: "var(--sunk)",
                    padding: "10px 12px",
                    borderRadius: "var(--r-card)",
                  }}
                >
                  {draft.body}
                </pre>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button className="btn btn--small" onClick={() => onCopy(draft.body)}>
                    Copy draft
                  </button>
                  <button
                    className="btn btn--quiet btn--small"
                    onClick={async () => onChange(await send({ type: "DELETE_DRAFT", id: draft.id }))}
                  >
                    Delete<span className="visually-hidden"> draft: {draft.subject}</span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="section">
        <h2 className="section__title">
          Reminders
          {reminders.length > 0 && <span className="section__count">{reminders.length}</span>}
        </h2>
        <ClearAll count={reminders.length} noun="reminder" request={{ type: "CLEAR_REMINDERS" }} onChange={onChange} />
        {reminders.length === 0 ? (
          <div className="empty">
            <BellMark className="empty__mark" />
            <p className="empty__title">No reminders yet</p>
            <p>Open Bubiqo on a page that states a date — a closing date, a due date, an appointment
            — and it will offer to hold on to it for you.</p>
          </div>
        ) : (
        /*
         * Reminders are cards too. The Memory tab was half new cards and half old
         * rows, which reads as two different products stacked on one screen.
         */
        <ul className="list list--cards">
            {reminders.map((reminder, index) => (
              <ReminderCard
                key={reminder.id}
                reminder={reminder}
                now={now}
                onChange={onChange}
                delayMs={Math.min(index, 6) * 40}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="section">
        <h2 className="section__title">
          Saved
          {memory.length > 0 && <span className="section__count">{memory.length}</span>}
        </h2>
        <ClearAll count={memory.length} noun="saved item" request={{ type: "CLEAR_MEMORY" }} onChange={onChange} />
        {memory.length === 0 ? (
          <div className="empty">
            <BubbleMark className="empty__mark" />
            <p className="empty__title">Nothing saved yet</p>
            <p>Save details from a page and they land here. Bubiqo only ever remembers
            what you explicitly keep — there is no hidden profile.</p>
          </div>
        ) : (
          <ul className="list list--cards">
            {memory.map((item) => (
              <SavedItem key={item.id} item={item} now={now} onChange={onChange} onCopy={onCopy} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function ActivityTab({
  state,
  now,
  onChange,
}: {
  state: PanelState | undefined;
  now: number;
  onChange: (r: Response) => void;
}) {
  const activity = state?.activity ?? [];
  /*
   * Two steps, not a dialog. The log is the user's own audit trail, so deleting it
   * should be easy — but not so easy that a mis-click erases the record of what
   * Bubiqo did on their behalf.
   */
  const [confirming, setConfirming] = useState(false);

  return (
    <section className="section">
      <h2 className="section__title">
        Everything Bubiqo has done
        {activity.length > 0 && <span className="section__count">{activity.length}</span>}
      </h2>

      {activity.length > 0 && (
        <div className="clear-row">
          {confirming ? (
            <>
              <span className="clear-row__ask">Delete all {activity.length} entries?</span>
              <button
                className="btn btn--small btn--danger"
                onClick={async () => {
                  setConfirming(false);
                  onChange(await send({ type: "CLEAR_ACTIVITY" }));
                }}
              >
                Delete everything
              </button>
              <button className="btn btn--quiet btn--small" onClick={() => setConfirming(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button className="btn btn--quiet btn--small" onClick={() => setConfirming(true)}>
              Clear activity
            </button>
          )}
        </div>
      )}
      {activity.length === 0 ? (
        <div className="empty">
          <p className="empty__title">Nothing yet</p>
          <p>Every detection, suggestion and action will be listed here, with whether it
          was verified.</p>
        </div>
      ) : (
        /*
         * A timeline, not a list of grey lines. Each kind has its own mark and
         * colour, so a glance separates what was noticed from what was done from
         * what was checked — which is the only reason to keep an audit trail.
         */
        <ol className="trail">
          {activity.map((event, index) => (
            <li className={`trail__event trail__event--${event.kind}`} key={event.id} style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}>
              <span className="trail__mark" aria-hidden="true">
                <ActivityMark kind={event.kind} />
              </span>
              <div className="trail__body">
                <p className="trail__summary">{event.summary}</p>
                <p className="trail__meta">
                  <span className={`trail__kind trail__kind--${event.kind}`}>{event.kind}</span>
                  {clockTime(event.at)} · {relativeTime(event.at, now)}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * What Bubiqo read, and what it made of it.
 *
 * This exists because two rounds of fixes were aimed at the wrong layer: the only
 * evidence available was a screenshot of the wrong answer, which cannot tell you
 * whether the parsing is wrong or the extractor read the wrong part of the page.
 * One Copy button turns a report of "it didn't work" into something diagnosable.
 */
function Diagnostics({
  state,
  onCopy,
}: {
  state: PanelState | undefined;
  onCopy: (text: string) => void;
}) {
  const page = state?.page;
  const analysis = state?.analysis;
  const extraction = page?.extraction;

  if (!page || !analysis) return null;

  const report = [
    `URL:        ${page.url}`,
    `TAB TITLE:  ${page.title}`,
    `SURFACE:    ${analysis.classification.surface} (${Math.round(analysis.classification.confidence * 100)}%)`,
    extraction
      ? `READ:       ${extraction.chosenChars} of ${extraction.regionChars} chars, ` +
        `${extraction.candidates} candidates, link density ${extraction.linkDensity}` +
        `${extraction.usedWholeRegion ? " — FELL BACK TO WHOLE REGION" : ""}`
      : "READ:       (no extraction data)",
    `HEADINGS:   ${page.headings.slice(0, 6).join(" | ") || "(none)"}`,
    "",
    "ENTITIES:",
    ...(analysis.entities.length === 0
      ? ["  (none)"]
      : analysis.entities.map((e) => `  ${e.type.padEnd(14)} ${e.value.slice(0, 90)}`)),
    "",
    "FIRST 600 CHARACTERS READ:",
    page.text.slice(0, 600),
  ].join("\n");

  return (
    <div className="field">
      <span className="visually-hidden">What Bubiqo read</span>
      <p className="field__help">
        If it got this page wrong, this says why — whether it read the wrong part of the page, or
        read the right part and misunderstood it. Copy it into a bug report.
      </p>

      <dl className="diag">
        <dt>Read</dt>
        <dd>
          {extraction
            ? `${extraction.chosenChars.toLocaleString()} of ${extraction.regionChars.toLocaleString()} characters` +
              (extraction.usedWholeRegion ? " — whole page, no content block found" : "")
            : "unknown"}
        </dd>
        <dt>Link density</dt>
        <dd>{extraction ? `${Math.round(extraction.linkDensity * 100)}%` : "unknown"}</dd>
        <dt>Understood as</dt>
        <dd>
          {analysis.classification.surface} ({Math.round(analysis.classification.confidence * 100)}%)
        </dd>
        <dt>Details found</dt>
        <dd>{analysis.entities.length}</dd>
      </dl>

      <button className="btn btn--small" style={{ marginTop: 10 }} onClick={() => onCopy(report)}>
        Copy diagnostics
      </button>
    </div>
  );
}

function SettingsTab({
  state,
  onChange,
  onCopyDiagnostics,
}: {
  state: PanelState | undefined;
  onChange: (r: Response) => void;
  onCopyDiagnostics: (text: string) => void;
}) {
  const [confirmingWipe, setConfirmingWipe] = useState(false);
  const settings = state?.settings;
  if (!settings) return <p className="empty">Loading…</p>;

  const held =
    (state?.reminders.length ?? 0) + (state?.memory.length ?? 0) + (state?.drafts.length ?? 0);

  const update = async (partial: Parameters<typeof send>[0] extends never ? never : Record<string, unknown>) => {
    onChange(await send({ type: "SET_SETTINGS", settings: partial as never }));
  };

  return (
    <section className="section">
      <h2 className="section__title">Settings</h2>

      <div className="panel">
        <p className="panel__head">
          <PaletteMark className="panel__mark" />
          Appearance
        </p>
      <fieldset className="field field--group">
        <legend className="visually-hidden">Appearance</legend>
        <p className="field__help">Match your system, or pick one and stay there.</p>
        <div className="segmented" role="radiogroup" aria-label="Appearance">
          {(["system", "light", "dark"] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={settings.theme === choice}
              className="segmented__option"
              onClick={() => void update({ theme: choice })}
            >
              {choice === "system" ? "System" : choice === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </fieldset>
      </div>

      <WhatItDoes />

      <div className="panel">
        <p className="panel__head">
          <DialMark className="panel__mark" />
          How it behaves
        </p>
      <div className="field">
        <span className="field__label">How much should Bubiqo speak up?</span>

        {/*
          * Three cards rather than a dropdown. This is the most characterful
          * decision in the product — how much it says without being asked — and a
          * <select> containing three adjectives made it look like a form field
          * with the meaning hidden until you open it.
          */}
        <div className="modes" role="radiogroup" aria-label="How much should Bubiqo speak up?">
          {MODES.map((choice, index) => (
            <button
              key={choice.id}
              type="button"
              role="radio"
              className="modes__option"
              aria-checked={settings.mode === choice.id}
              /*
               * Roving tabindex plus arrow keys, which is what a radiogroup is
               * expected to do: Tab moves past the whole group, arrows move
               * within it. Without this a keyboard user tabs through three
               * separate controls and a screen reader announces a group whose
               * keys do nothing.
               */
              tabIndex={settings.mode === choice.id ? 0 : -1}
              onKeyDown={(event) => {
                const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
                if (step === 0) return;
                event.preventDefault();

                const next = MODES[(index + step + MODES.length) % MODES.length];
                if (!next) return;
                void update({ mode: next.id });
                const group = event.currentTarget.parentElement;
                const buttons = group?.querySelectorAll<HTMLButtonElement>("[role='radio']");
                buttons?.[(index + step + MODES.length) % MODES.length]?.focus();
              }}
              onClick={() => void update({ mode: choice.id })}
            >
              <span className="modes__dot" aria-hidden="true" />
              <span>
                <span className="modes__name">{choice.name}</span>
                <span className="modes__what">{choice.what}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <div className="switch">
          <input
            id="currency"
            type="checkbox"
            checked={settings.currencyConversion}
            onChange={(e) => void update({ currencyConversion: e.target.checked })}
          />
          <label htmlFor="currency">
            <span className="field__label">Convert foreign currency amounts</span>
            <p className="field__help">
              This is the only feature that uses the internet. When it is on, Bubiqo asks
              api.frankfurter.dev for an exchange rate — it sends a currency pair such as
              “EUR to GBP” and nothing else. Never the page, never the amount, never anything about you.
              It is free, needs no account, and has no paid tier. Off by default.
            </p>
          </label>
        </div>
      </div>

      <label className="field">
        <span className="field__label">Your currency</span>
        <p className="field__help">Used to show what a foreign amount is worth to you.</p>
        {/*
          * A list, not a text field.
          *
          * It accepted any three characters, so "XYZ" was a currency as far as the
          * panel was concerned — and then the rate lookup failed with nothing to
          * explain why. These are the codes core/money.ts actually recognises, so
          * an unusable value cannot be chosen.
          */}
        <select
          value={settings.homeCurrency}
          onChange={(e) => void update({ homeCurrency: e.target.value })}
        >
          {CURRENCY_CODES.map((code) => (
            <option key={code} value={code}>
              {code} — {CURRENCY_NAMES[code]}
            </option>
          ))}
        </select>
      </label>

      </div>

      {(settings.disabledActionIds.length > 0 || settings.heldConditions.length > 0) && (
        <div className="panel">
          <p className="panel__head">
            <TickMark className="panel__mark" />
            What you have told it
          </p>

          {settings.heldConditions.length > 0 && (
            <div className="field">
              <span className="field__label">Conditions you have said you meet</span>
              <p className="field__help">
                An advert asking for these will show them as met rather than as something to check.
              </p>
              <ul className="chips">
                {settings.heldConditions.map((rule) => (
                  <li className="chips__item" key={rule}>
                    {BLOCKER_RULES.find((r) => r.id === rule)?.summary ?? rule}
                    <button
                      className="chips__remove"
                      onClick={() =>
                        void update({ heldConditions: settings.heldConditions.filter((id) => id !== rule) })
                      }
                      aria-label={`I no longer have: ${BLOCKER_RULES.find((r) => r.id === rule)?.summary ?? rule}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {settings.disabledActionIds.length > 0 && (
            <div className="field">
              <span className="field__label">Suggestions you have turned off</span>
              <p className="field__help">Pressing “Not useful” on a card puts it here. Bring it back any time.</p>
              <ul className="chips">
                {settings.disabledActionIds.map((id) => (
                  <li className="chips__item" key={id}>
                    {id.replace(/_/g, " ")}
                    <button
                      className="chips__remove"
                      onClick={() =>
                        void update({ disabledActionIds: settings.disabledActionIds.filter((x) => x !== id) })
                      }
                      aria-label={`Show ${id.replace(/_/g, " ")} again`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="panel">
        <p className="panel__head">
          <ShieldIcon className="panel__mark" />
          What it read
        </p>
        <Diagnostics state={state} onCopy={onCopyDiagnostics} />
      </div>

      <div className="panel panel--danger">
        <p className="panel__head">
          <LockMark className="panel__mark" />
          Your data

        </p>
      <div className="field">
        <p className="field__help">
          Everything Bubiqo knows lives on this device: {state?.reminders.length ?? 0} reminder
          {(state?.reminders.length ?? 0) === 1 ? "" : "s"}, {state?.memory.length ?? 0} saved item
          {(state?.memory.length ?? 0) === 1 ? "" : "s"}, {state?.drafts.length ?? 0} draft
          {(state?.drafts.length ?? 0) === 1 ? "" : "s"}. Deleting it also cancels any scheduled
          reminders. Your settings are kept.
        </p>

        <div className="clear-row">
          {confirmingWipe ? (
            <>
              <span className="clear-row__ask">Delete all {held} items? This cannot be undone.</span>
              <button
                className="btn btn--small btn--danger"
                onClick={async () => {
                  setConfirmingWipe(false);
                  onChange(await send({ type: "DELETE_ALL_DATA" }));
                }}
              >
                Delete everything
              </button>
              <button className="btn btn--quiet btn--small" onClick={() => setConfirmingWipe(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button
              className={`btn btn--small${held === 0 ? "" : " btn--danger-quiet"}`}
              onClick={() => setConfirmingWipe(true)}
              disabled={held === 0}
            >
              {held === 0 ? null : <TrashMark className="btn__mark" />}
              {held === 0 ? "Nothing stored" : "Delete everything Bubiqo has saved"}
            </button>
          )}
        </div>
      </div>
      </div>

      <div className="field">
        <p className="field__help" style={{ marginBottom: 0 }}>
          Bubiqo asks for four permissions: to read the page you are on when you open the panel
          (<code>activeTab</code>), to save your reminders and notes on this device (<code>storage</code>),
          to schedule those reminders (<code>alarms</code>), and to show this panel (<code>sidePanel</code>).
          It has no permission to read any page you have not opened it on.
        </p>
      </div>
    </section>
  );
}
