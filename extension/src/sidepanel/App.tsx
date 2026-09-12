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
import type { Problem, Suggestion } from "@core/types";
import type { StepOutcome, CompleteItReport } from "@core/executor";
import type { Briefing, PanelState, Response } from "@shared/messages";
import { send } from "@shared/messages";
import { formatDue } from "@core/dates";
import { riskLabel } from "@core/safety";
import { surfaceChip, attentionHeadline, urgencyWord, relativeTime, clockTime } from "./format";
import { BubbleMark, ShieldIcon, QuietMark } from "./icons";

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
  const [steps, setSteps] = useState<StepOutcome[]>([]);
  const [announcement, setAnnounce] = useState("");
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
    if (response.type === "ERROR") setAnnounce(response.message);
  }, []);

  const analyse = useCallback(async () => {
    setBusy(true);
    setReport(undefined);
    setSteps([]);
    try {
      apply(await send({ type: "ANALYSE_ACTIVE_TAB" }));
      apply(await send({ type: "BRIEFING" }));
    } finally {
      setBusy(false);
    }
  }, [apply]);

  useEffect(() => {
    void analyse();
  }, [analyse]);

  // Re-read the page when the user switches tab or navigates, so the panel is
  // never showing a stale answer for a page that is no longer in front of them.
  useEffect(() => {
    const onActivated = () => void analyse();
    const onUpdated = (_id: number, change: chrome.tabs.TabChangeInfo, t: chrome.tabs.Tab) => {
      if (change.status === "complete" && t.active) void analyse();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [analyse]);

  const runAction = useCallback(
    async (actionId: string, approved = false) => {
      setBusy(true);
      try {
        const response = await send({ type: "RUN_ACTION", actionId, approved });
        if (response.type === "STEP") {
          setSteps((previous) => [...previous, response.outcome]);
          setAnnounce(response.outcome.message);
          if (response.outcome.status === "done") apply(await send({ type: "GET_STATE" }));
        } else {
          apply(response);
        }
      } finally {
        setBusy(false);
      }
    },
    [apply],
  );

  const completeIt = useCallback(async () => {
    setBusy(true);
    setSteps([]);
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
        setSteps((previous) => previous.filter((s) => s.undoHandle !== handle));
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

  const analysis = state?.analysis;
  const safeSuggestions = useMemo(
    () => (analysis?.suggestions ?? []).filter((s) => s.risk === "safe").slice(0, 3),
    [analysis],
  );

  return (
    <div className="app">
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

      <main className="main" id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "now" && (
          <NowTab
            state={state}
            briefing={briefing}
            busy={busy}
            steps={steps}
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
            now={now}
          />
        )}
        {tab === "memory" && <MemoryTab state={state} onChange={apply} onCopy={copyText} />}
        {tab === "activity" && <ActivityTab state={state} now={now} />}
        {tab === "settings" && <SettingsTab state={state} onChange={apply} />}
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

  const headline = blocked
    ? "Nothing to read here"
    : analysis
      ? attentionHeadline(analysis.problems.length, analysis.suggestions.length)
      : "Reading this page…";

  return (
    <header className="header">
      <div className="brand">
        <img className="brand__mark" src="icons/icon-32.png" alt="" width={20} height={20} />
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
        {state?.unavailableReason ?? state?.page?.title ?? state?.page?.domain ?? ""}
      </p>
    </header>
  );
}

// ---------------------------------------------------------------------------

interface NowProps {
  state: PanelState | undefined;
  briefing: Briefing | undefined;
  busy: boolean;
  steps: StepOutcome[];
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
  now: number;
}

function NowTab(props: NowProps) {
  const { state, briefing, busy, steps, report, safeSuggestions, now } = props;
  const analysis = state?.analysis;
  const outcomes = report?.steps ?? steps;

  if (state?.unavailableReason) {
    return (
      <>
        <p className="notice">{state.unavailableReason}</p>
        {state.canRequestAccess && (
          <div style={{ marginTop: 14 }}>
            <button className="btn btn--primary" onClick={props.onTurnOn}>
              Allow Bubiqo to read pages
            </button>
            <p className="why" style={{ marginTop: 10, lineHeight: 1.55 }}>
              Chrome will ask you to confirm. Bubiqo asks here, the first time you use it,
              rather than demanding it at install before it has shown you anything. It reads a
              page only while the panel is open on it, everything stays on this device, and you
              can revoke this at any time in <code>chrome://extensions</code>.
            </p>
            <button
              className="btn btn--quiet btn--small"
              style={{ marginTop: 6 }}
              onClick={props.onRefresh}
            >
              Already allowed it? Re-read this page
            </button>
          </div>
        )}
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

  const more = analysis.suggestions.filter((s) => !safeSuggestions.includes(s));

  return (
    <>
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
          <h2 className="section__title" id="problems-title">Needs attention</h2>
          {analysis.problems.slice(0, 4).map((problem, i) => (
            <ProblemRow key={`${problem.kind}-${i}`} problem={problem} now={now} />
          ))}
        </section>
      )}

      <section className="section" aria-labelledby="suggested-title">
        <h2 className="section__title" id="suggested-title">Suggested</h2>

        {analysis.suggestions.length === 0 ? (
          <div className="empty">
            <QuietMark className="empty__mark" />
            <p className="empty__title">All quiet here</p>
            <p>Bubiqo stays out of the way unless it has something genuinely useful.</p>
          </div>
        ) : (
          <>
            {analysis.suggestions.slice(0, 3).map((suggestion) => (
              <SuggestionCard
                key={suggestion.actionId}
                suggestion={suggestion}
                busy={busy}
                onRun={props.onRun}
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
                      onRun={props.onRun}
                    />
                  ))}
                </div>
              </details>
            )}

            {safeSuggestions.length > 1 && (
              <div style={{ marginTop: 14 }}>
                <button className="btn btn--primary" onClick={props.onCompleteIt} disabled={busy}>
                  {busy ? "Working…" : "Complete it"}
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

      <section className="section">
        <button className="btn btn--quiet btn--small" onClick={props.onRefresh} disabled={busy}>
          Re-read this page
        </button>
      </section>
    </>
  );
}

function ProblemRow({ problem, now }: { problem: Problem; now: number }) {
  const modifier =
    problem.urgency === "overdue" ? "problem--overdue" : problem.urgency === "today" ? "problem--today" : "";
  return (
    <div className={`problem ${modifier}`}>
      <span className="problem__dot" aria-hidden="true" />
      <div className="problem__body">
        <p className="problem__summary">{problem.summary}</p>
        <p className="problem__meta">
          <span className={`urgency urgency--${problem.urgency}`}>{urgencyWord(problem.urgency)}</span>
          {problem.dueAt ? ` · ${formatDue(problem.dueAt, now)}` : ""}
        </p>
      </div>
    </div>
  );
}

function SuggestionCard({
  suggestion,
  busy,
  onRun,
}: {
  suggestion: Suggestion;
  busy: boolean;
  onRun: (id: string, approved?: boolean) => void;
}) {
  const needsApproval = suggestion.risk === "confirm";
  return (
    <article className="suggestion">
      <div className="suggestion__head">
        <h3 className="suggestion__name">{suggestion.name}</h3>
        {needsApproval && <span className="badge badge--confirm">{riskLabel(suggestion.risk)}</span>}
      </div>

      <p className="suggestion__rationale">{suggestion.rationale}</p>

      <div className="suggestion__row">
        <button className="btn" onClick={() => onRun(suggestion.actionId, needsApproval)} disabled={busy}>
          {needsApproval ? "Approve and do it" : "Do it"}
        </button>
      </div>

      <details className="why">
        <summary>Why am I seeing this?</summary>
        <dl>
          <dt>What Bubiqo found</dt>
          <dd className="why__quote">{suggestion.rationale}</dd>
          <dt>Risk</dt>
          <dd>{riskLabel(suggestion.risk)}</dd>
          <dt>Can it be undone?</dt>
          <dd>{suggestion.actionId === "copy_details" ? "No — the clipboard can't be put back." : "Yes."}</dd>
        </dl>
      </details>
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
          <h2 className="section__title">Drafts</h2>
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
        <h2 className="section__title">Reminders</h2>
        {reminders.length === 0 ? (
          <p className="empty">No reminders yet. Create one from a page with a date on it.</p>
        ) : (
          <ul className="list">
            {reminders.map((reminder) => (
              <li className="row" key={reminder.id}>
                <div>
                  <p className="row__title">{reminder.title}</p>
                  <p className="row__meta">{formatDue(reminder.dueAt, now)}</p>
                </div>
                <button
                  className="btn btn--quiet btn--small"
                  onClick={async () => onChange(await send({ type: "DELETE_REMINDER", id: reminder.id }))}
                >
                  Delete<span className="visually-hidden"> reminder: {reminder.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section">
        <h2 className="section__title">Saved</h2>
        {memory.length === 0 ? (
          <div className="empty">
            <BubbleMark className="empty__mark" />
            <p className="empty__title">Nothing saved yet</p>
            <p>Save details from a page and they land here. Bubiqo only ever remembers
            what you explicitly keep — there is no hidden profile.</p>
          </div>
        ) : (
          <ul className="list">
            {memory.map((item) => (
              <li className="row" key={item.id}>
                <div>
                  <p className="row__title">{item.title}</p>
                  <p className="row__meta">
                    {item.kind} · {item.entities.length} details · saved {relativeTime(item.savedAt, now)}
                  </p>
                </div>
                <button
                  className="btn btn--quiet btn--small"
                  onClick={async () => onChange(await send({ type: "DELETE_MEMORY", id: item.id }))}
                >
                  Delete<span className="visually-hidden">: {item.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function ActivityTab({ state, now }: { state: PanelState | undefined; now: number }) {
  const activity = state?.activity ?? [];
  return (
    <section className="section">
      <h2 className="section__title">Everything Bubiqo has done</h2>
      {activity.length === 0 ? (
        <div className="empty">
          <p className="empty__title">Nothing yet</p>
          <p>Every detection, suggestion and action will be listed here, with whether it
          was verified.</p>
        </div>
      ) : (
        <ul className="list">
          {activity.map((event) => (
            <li className="row" key={event.id}>
              <div>
                <p className="row__title">{event.summary}</p>
                <p className="row__meta">
                  {clockTime(event.at)} · {event.kind} · {relativeTime(event.at, now)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SettingsTab({ state, onChange }: { state: PanelState | undefined; onChange: (r: Response) => void }) {
  const settings = state?.settings;
  if (!settings) return <p className="empty">Loading…</p>;

  const update = async (partial: Parameters<typeof send>[0] extends never ? never : Record<string, unknown>) => {
    onChange(await send({ type: "SET_SETTINGS", settings: partial as never }));
  };

  return (
    <section className="section">
      <h2 className="section__title">Settings</h2>

      <label className="field">
        <span className="field__label">How proactive should Bubiqo be?</span>
        <p className="field__help">
          Quiet only answers when you ask. Helpful shows what it is confident about. Proactive also surfaces
          things it thinks you might forget.
        </p>
        <select value={settings.mode} onChange={(e) => void update({ mode: e.target.value })}>
          <option value="quiet">Quiet</option>
          <option value="helpful">Helpful</option>
          <option value="proactive">Proactive</option>
        </select>
      </label>

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
        <input
          type="text"
          value={settings.homeCurrency}
          maxLength={3}
          onChange={(e) => void update({ homeCurrency: e.target.value.toUpperCase() })}
        />
      </label>

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
