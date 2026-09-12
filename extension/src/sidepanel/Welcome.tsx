/**
 * First run.
 *
 * Bubiqo cannot read anything until the user grants page access, and the old
 * screen simply asked for it — a permission prompt before any explanation of what
 * the thing does. Nobody should be asked to trust a tool that has not yet said
 * what it is for.
 *
 * So: what it does, what it works on, what it will never do, and only then the
 * button. The same content is reachable later from Settings, because an
 * explanation shown once and never again is not documentation.
 */

import { BubbleMark } from "./icons";

const WORKS_ON: readonly { readonly title: string; readonly detail: string }[] = [
  {
    title: "An email asking you for something",
    detail: "Finds the deadline, the request, and what you promised — and offers a reminder before it is due.",
  },
  {
    title: "An invoice or a bill",
    detail: "Pulls out the supplier, the total, the reference and the due date. It will never offer to pay it.",
  },
  {
    title: "A job advert",
    detail: "Saves the role, company, salary and closing date together, so you are not reopening the tab.",
  },
  {
    title: "Anything with a date you will forget",
    detail: "Bookings, renewals, appointments, tickets, course deadlines. If a page states a date, it can hold on to it.",
  },
];

const NEVER: readonly string[] = [
  "Send an email, submit a form, or post anything",
  "Make a payment, or touch a card or password field",
  "Read a page you have not opened it on",
  "Send anything you look at to a server — there isn't one",
];

export function Welcome({ onTurnOn, onSkip }: { onTurnOn: () => void; onSkip: () => void }) {
  return (
    <div className="welcome">
      <BubbleMark className="welcome__mark" />

      <h2 className="welcome__title">Bubiqo reads the page you are on and finds what needs doing.</h2>
      <p className="welcome__lead">
        Open it on an email, an invoice, a job advert — anything with a date or a request buried in
        it — and it will tell you what needs your attention, then do the useful parts in one click.
        No workflows to build.
      </p>

      <h3 className="welcome__heading">Try it on</h3>
      <ul className="welcome__list">
        {WORKS_ON.map((item) => (
          <li key={item.title}>
            <strong>{item.title}</strong>
            <span>{item.detail}</span>
          </li>
        ))}
      </ul>

      <h3 className="welcome__heading">If a page is busy</h3>
      <p className="welcome__lead" style={{ marginBottom: 20 }}>
        Sites like LinkedIn and Indeed put the advert you are reading in the same box as
        twenty-five others. Select the part you care about before opening Bubiqo and it will read
        exactly that — no guessing, on any site.
      </p>

      <h3 className="welcome__heading">It will never</h3>
      <ul className="welcome__never">
        {NEVER.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      <div className="welcome__cta">
        <button className="btn btn--primary" onClick={onTurnOn}>
          Allow Bubiqo to read pages
        </button>
        <p className="why" style={{ marginTop: 10, lineHeight: 1.55 }}>
          Chrome will ask you to confirm. Bubiqo asks here, once, rather than demanding it at install
          before showing you anything. Everything it finds stays on this device, and you can revoke
          this at any time in <code>chrome://extensions</code>.
        </p>
        <button className="btn btn--quiet btn--small" style={{ marginTop: 4 }} onClick={onSkip}>
          Already allowed it? Re-read this page
        </button>
      </div>
    </div>
  );
}

/** The same explanation, reachable from Settings once onboarding is behind you. */
export function WhatItDoes() {
  return (
    <div className="field">
      <span className="field__label">What Bubiqo is for</span>
      <p className="field__help">
        Open the panel on a page that has something buried in it — a deadline, a request, an amount,
        a closing date — and it surfaces what needs doing.
      </p>
      <ul className="welcome__list welcome__list--compact">
        {WORKS_ON.map((item) => (
          <li key={item.title}>
            <strong>{item.title}</strong>
            <span>{item.detail}</span>
          </li>
        ))}
      </ul>
      <p className="field__help" style={{ marginTop: 10, marginBottom: 0 }}>
        It never sends, submits, posts or pays, and it never reads a page you have not opened it on.
      </p>
    </div>
  );
}
