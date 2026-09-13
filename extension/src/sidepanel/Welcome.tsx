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

import { BubbleMark, SurfaceMark } from "./icons";

/**
 * What it works on.
 *
 * Four bordered paragraphs of grey text told the reader what the product does in
 * the least interesting way available. Each surface now carries its own mark and
 * its own colour — the same colours the panel uses when it actually recognises
 * one of them, so this doubles as a legend rather than being decoration.
 */
const WORKS_ON: readonly {
  readonly surface: "email" | "invoice" | "job" | "date";
  readonly title: string;
  readonly detail: string;
}[] = [
  {
    surface: "email",
    title: "An email asking you for something",
    detail: "Finds the deadline, the request, and what you promised — and offers a reminder before it is due.",
  },
  {
    surface: "invoice",
    title: "An invoice or a bill",
    detail: "Pulls out the supplier, the total, the reference and the due date. It will never offer to pay it.",
  },
  {
    surface: "job",
    title: "A job advert",
    detail: "The role, the pay, the closing date — and the conditions that would rule you out, quoted from the advert.",
  },
  {
    surface: "date",
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

      <h2 className="welcome__title">Select what matters. Bubiqo does the rest.</h2>
      <p className="welcome__lead">
        Highlight an email, an invoice, a job advert — anything with a date or a request buried in
        it — then <strong>right-click and choose “Read this with Bubiqo”</strong>. It finds what
        needs your attention and does the useful parts in one click.
      </p>
      <p className="welcome__lead">
        Selecting is the reliable way, because it reads exactly what you chose and nothing else.
        Busy sites like LinkedIn and Indeed put the advert you are reading in the same box as
        twenty-five others; selecting removes all doubt. On an ordinary page you can just open the
        panel and it will read the page itself.
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
      <ul className="surfaces">
        {WORKS_ON.map((item, index) => (
          <li className={`surfaces__item surfaces__item--${item.surface}`} key={item.title} style={{ animationDelay: `${index * 50}ms` }}>
            <span className="surfaces__mark" aria-hidden="true">
              <SurfaceMark surface={item.surface} />
            </span>
            <div>
              <strong>{item.title}</strong>
              <span>{item.detail}</span>
            </div>
          </li>
        ))}
      </ul>
      <p className="field__help" style={{ marginTop: 10, marginBottom: 0 }}>
        It never sends, submits, posts or pays, and it never reads a page you have not opened it on.
      </p>
    </div>
  );
}
