/**
 * How often to ask the page whether it has changed.
 *
 * The panel has to notice when the user clicks a different advert, and the only
 * dependable way to know is to ask the page. The question is how often, and a
 * fixed timer answers it badly in both directions: too slow and the panel lags
 * behind the user, too fast and the extension does needless work every second of
 * every hour the panel is open.
 *
 * So the cadence follows the user. Anything that suggests they are moving around
 * — a tab switch, a navigation, the panel regaining focus, a change actually
 * found — starts a burst of attentive checking, because someone who just clicked
 * an advert is likely to click another. When nothing has happened for a while the
 * checks space out, and while the panel is not visible they stop altogether.
 *
 * Pure, so the policy can be tested without a browser.
 */

/** While the user appears to be moving around. */
export const ATTENTIVE_MS = 900;

/** Once they have settled on one page. */
export const SETTLED_MS = 6_000;

/** How long attentive checking lasts after the last sign of activity. */
export const ATTENTIVE_WINDOW_MS = 20_000;

export interface WatchState {
  /** When something last suggested the user was moving around. */
  readonly lastActivityAt: number;
  /** Whether the panel is on screen at all. */
  readonly visible: boolean;
  /** Whether a read is already running. */
  readonly busy: boolean;
  /**
   * Whether the last read succeeded. A browser page, or a site the user has not
   * granted access to, cannot be read however often it is asked — and asking
   * means an injection attempt every time.
   */
  readonly readable: boolean;
}

/**
 * Milliseconds until the next check, or `undefined` for "do not check".
 *
 * Returning nothing is a real answer: a hidden panel is not being read by anyone,
 * and a check that lands while a read is already running would only queue work
 * behind it.
 */
export function nextCheckDelay(state: WatchState, now: number): number | undefined {
  if (!state.visible) return undefined;

  /*
   * An unreadable page is checked slowly rather than never: the user may grant
   * access, or move to a page that can be read, and the tab events do not always
   * say so.
   */
  if (!state.readable) return SETTLED_MS;

  const sinceActivity = now - state.lastActivityAt;
  if (state.busy) return ATTENTIVE_MS;

  return sinceActivity < ATTENTIVE_WINDOW_MS ? ATTENTIVE_MS : SETTLED_MS;
}

/** Whether a fingerprint describes a different page from the one that was read. */
export function hasMoved(
  before: { url: string; title: string; heading: string; length: number } | undefined,
  now: { url: string; title: string; heading: string; length: number },
): boolean {
  if (!before) return false;

  return (
    now.url !== before.url ||
    now.title !== before.title ||
    now.heading !== before.heading ||
    /*
     * A page redrawn at almost exactly the same size is not a different advert.
     * Job boards rewrite a character or two — a relative timestamp, an applicant
     * count — without the content changing, and re-reading on that would mean
     * re-reading constantly on a page nobody has touched.
     */
    Math.abs(now.length - before.length) > 40
  );
}
