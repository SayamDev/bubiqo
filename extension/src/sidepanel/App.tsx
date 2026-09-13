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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BriefField, Entity, EntityType, JobBrief, MemoryItem, Problem, Reminder, Suggestion } from "@core/types";
import type { StepOutcome, CompleteItReport } from "@core/executor";
import type { Briefing, PageFingerprint, PanelState, Request, Response } from "@shared/messages";
import { send } from "@shared/messages";
import { formatDue, describeUrgency } from "@core/dates";
import { CURRENCY_CODES, CURRENCY_NAMES } from "@core/money";
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
  BriefcaseMark,
  BlockMark,
  RefreshMark,
  ShareMark,
  TrashMark,
  ActivityMark,
  BellMark,
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

  const completeIt = useCallback(async () => {
    setBusy(true);
    setCardState({});
    try {
      const response = await send({ type: "COMPLETE_IT" });
      if (response.type === "REPORT") {
        setReport(response.report);
        setAnnounce(
          response.report.failed > 0
            ? `${response.report.done} done, ${response.report.failed} could not be completed.`
            : `Done. ${response.report.done} ${response.report.done === 1 ? "action" : "actions"} completed and verified.`,
        );
        apply(await send({ type: "GET_STATE" }));
        apply(await send({ type: "BRIEFING" }));
      } else {
        apply(response);
      }
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
       * Respecting "no" is what earns the right to keep suggesting. Recorded
       * locally, used only to push that action down the ranking on future pages.
       */
      await send({ type: "DISMISS_SUGGESTION", actionId });
      setAnnounce("Noted — Bubiqo will stop leading with that.");
      apply(await send({ type: "ANALYSE_ACTIVE_TAB" }));
    },
    [apply],
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
    <div className="app" {...(surface ? { "data-surface": surface } : {})}>
      <Header state={state} />

      <nav className="tabs" role="tablist" aria-label="Bubiqo sections">
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
            state={state}
            briefing={briefing}
            busy={busy}
            report={report}
            safeSuggestions={safeSuggestions}
            onRun={runAction}
            onCompleteIt={completeIt}
            onUndo={undo}
            onRefresh={analyse}
            onCopy={copyText}
            onDownload={downloadCalendar}
            onGrantSite={grantSiteAccess}
            onTurnOn={turnOn}
            onDismiss={dismiss}
            onShowMemory={() => setTab("memory")}
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
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------

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
          <span className="chip__dot" aria-hidden="true" />
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
  onDismissIntro: () => void;
  showIntro: boolean;
  cardState: Record<string, "running" | StepOutcome>;
  now: number;
}

function NowTab(props: NowProps) {
  const { state, briefing, busy, report, safeSuggestions, showIntro, now } = props;
  const analysis = state?.analysis;
  // Single actions report on their own card now; this list is only Complete It.
  const outcomes = report?.steps ?? [];

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
                busy={busy}
                state={props.cardState[suggestion.actionId]}
                alreadySaved={suggestion.actionId === "save_to_memory" ? state?.alreadySaved : undefined}
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
                      busy={busy}
                      state={props.cardState[suggestion.actionId]}
                      alreadySaved={suggestion.actionId === "save_to_memory" ? state?.alreadySaved : undefined}
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
                <button className="btn btn--primary" onClick={props.onCompleteIt} disabled={busy}>
                  {busy ? (
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

      <JobBriefBlock brief={analysis?.brief} now={now} />

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

function SuggestionCard({
  suggestion,
  busy,
  state,
  alreadySaved,
  onRun,
  onUndo,
  onCopy,
  onDownload,
  onDismiss,
  onShowMemory,
}: {
  suggestion: Suggestion;
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
          * Knowing you already have something is useful WHILE you have it. Saving
          * again is harmless — it refreshes the existing record rather than
          * duplicating — so this is information, not a barrier.
          */}
        {alreadySaved && !outcome && (
          <p className="already">
            <span className="already__tick" aria-hidden="true">✓</span>
            Already in Memory, saved {relativeTime(alreadySaved.savedAt, Date.now())}.{" "}
            <button className="btn--link" onClick={onShowMemory}>
              Show it
            </button>
          </p>
        )}

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
            ) : alreadySaved ? (
              "Save again"
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
              className="btn--link btn--link-quiet suggestion__dismiss"
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
          {outcome && (
            <div className={`outcome outcome--${tone}`} id={`${suggestion.actionId}-result`} role="status">
              <span className={`result__mark result__mark--${tone}`} aria-hidden="true">
                {tone === "done" ? "✓" : tone === "fail" ? "×" : "!"}
              </span>
              <div className="outcome__body">
                <p className="outcome__message">{outcome.message}</p>
                <div className="outcome__actions">
                  {suggestion.actionId === "copy_details" && outcome.handle && (
                    <button className="btn btn--small" onClick={() => onCopy(outcome.handle!)}>
                      Copy
                    </button>
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
        </div>

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
  onCopy,
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
                  {" "}
                  <button className="btn btn--small" onClick={() => onCopy(outcome.handle!)}>
                    Copy
                  </button>
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

      <div className="card__actions">
        {confirming ? (
          <>
            <button
              className="btn btn--small btn--danger"
              onClick={async () => {
                setConfirming(false);
                onChange(await send({ type: "DELETE_REMINDER", id: reminder.id }));
              }}
            >
              Delete this reminder
            </button>
            <button className="btn btn--quiet btn--small" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button
            className="btn btn--quiet btn--small btn--icon"
            onClick={() => setConfirming(true)}
            aria-label={`Delete reminder: ${reminder.title}`}
            title="Delete"
          >
            <TrashMark className="btn__mark" />
          </button>
        )}
      </div>
    </li>
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

  const facts: { label: string; value: string }[] = [
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
    setShared("Copied — paste it anywhere");
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
        <span className={`kind kind--${item.kind}`}>{item.kind}</span>
      </div>

      {blockers.length > 0 && (
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

      {requirements.length > 0 && (
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

      {contacts.length > 0 && (
        <p className="card__contact">
          <span className="card__contactLabel">Contact</span>
          {contacts.map((contact) => contact.value).join(" · ")}
        </p>
      )}

      <div className="card__actions">
        {link && (
          <a className="btn btn--small" href={link} target="_blank" rel="noreferrer noopener" title={link}>
            Open the advert
          </a>
        )}
        <button className="btn btn--quiet btn--small" onClick={() => void share()}>
          <ShareMark className="btn__mark" />
          Share
        </button>

        {confirming ? (
          <>
            <button
              className="btn btn--small btn--danger"
              onClick={async () => {
                setConfirming(false);
                onChange(await send({ type: "DELETE_MEMORY", id: item.id }));
              }}
            >
              Delete for good
            </button>
            <button className="btn btn--quiet btn--small" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button
            className="btn btn--quiet btn--small btn--icon"
            onClick={() => setConfirming(true)}
            aria-label={`Delete ${item.title}`}
            title="Delete"
          >
            <TrashMark className="btn__mark" />
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

export function JobBriefBlock({ brief, now }: { brief: JobBrief | undefined; now: number }) {
  if (!brief) return null;

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
    <section className="section brief" aria-labelledby="job-brief-title">
      <div className="brief__head">
        <BriefcaseMark className="brief__mark" />
        <div className="brief__heading">
          <h2 className="brief__title" id="job-brief-title">
            {brief.title?.value ?? "This job"}
          </h2>
          {brief.organisation && <p className="brief__employer">{brief.organisation.value}</p>}
        </div>
      </div>

      {brief.blockers.length > 0 && (
        <div className="verdict" role="status">
          <p className="verdict__headline">
            <BlockMark className="verdict__mark" />
            Ruled out — {brief.blockers.length === 1 ? "one condition" : `${brief.blockers.length} conditions`} you would
            have to meet
          </p>
          <ul className="verdict__list">
            {brief.blockers.map((blocker) => (
              <li key={blocker.rule}>
                <span className="verdict__name">{blocker.summary}</span>
                <span className="verdict__quote">“{blocker.evidence}”</span>
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
          {(
            [
              { id: "quiet", name: "Quiet", what: "Answers when you ask, and otherwise says nothing." },
              { id: "helpful", name: "Helpful", what: "Shows what it is confident about. The middle setting, and the default." },
              { id: "proactive", name: "Proactive", what: "Also raises things you have not asked about but might forget." },
            ] as const
          ).map((choice) => (
            <button
              key={choice.id}
              type="button"
              role="radio"
              className="modes__option"
              aria-checked={settings.mode === choice.id}
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
