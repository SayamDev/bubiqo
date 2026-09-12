/**
 * The page extractor.
 *
 * This function is injected into the active tab with chrome.scripting.executeScript
 * under the `activeTab` permission, which is granted only by a user gesture and only
 * for that one tab. Bubiqo therefore declares NO host permissions: it cannot read a
 * page you did not explicitly point it at, and it is not running on every tab you
 * open.
 *
 * It must be entirely self-contained — no imports, no closure variables — because
 * Chrome serialises it and runs it in the page's own world.
 */

/**
 * Kept in step with core/types.ts PageContext; duplicated because of serialisation.
 *
 * The block-scoring helpers are inlined below for the same reason: Chrome
 * serialises this function, so it cannot import. They are a copy of
 * core/readability.ts, which is where the tested versions live.
 */
export function extractPageContext(): {
  url: string;
  domain: string;
  title: string;
  text: string;
  headings: string[];
  fields: { label: string; type: string; filled: boolean; required: boolean }[];
  structuredData: Record<string, unknown>[];
  links: { text: string; href: string }[];
  extraction: {
    candidates: number; chosenChars: number; regionChars: number;
    linkDensity: number; usedWholeRegion: boolean;
  };
  selection?: string;
  capturedAt: number;
} {
  const MAX_TEXT = 24_000;

  // --- inlined from core/readability.ts (an injected function cannot import) ---
  const MIN_CONTENT_LENGTH = 280;
  const NAVIGATION_LINK_DENSITY = 0.45;

  // Mirrors core/readability.ts, where the tested versions live.
  const UNLIKELY =
    /-ad-|ai2html|banner|breadcrumb|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote|promo|paywall|subscribe|newsletter|recommend|jobs-list|job-card|results-list|search-result|upsell|premium/i;
  const LIKELY =
    /and|article|body|column|content|main|mainContent|shadow|post|entry|description|details|job-details|job-description/i;

  const scoreBlock = (b: {
    textLength: number; linkTextLength: number; linkCount: number; depth: number;
    commas: number; signature: string;
  }): number => {
    if (b.textLength < MIN_CONTENT_LENGTH) return 0;
    if (UNLIKELY.test(b.signature) && !LIKELY.test(b.signature)) return 0;

    const density = b.textLength === 0 ? 1 : Math.min(1, b.linkTextLength / b.textLength);
    if (density > NAVIGATION_LINK_DENSITY) return 0;

    const readable = 1 - density;
    let score = b.textLength * readable * readable;
    score *= 1 + Math.min(b.commas / 12, 1.5);

    const linksPerThousand = (b.linkCount / Math.max(b.textLength, 1)) * 1000;
    if (linksPerThousand > 12) score *= 0.45;
    if (LIKELY.test(b.signature)) score *= 1.25;

    return score * (1 / (1 + b.depth * 0.08));
  };

  // --- end inlined ---

  /*
   * Find the region, then find the CONTENT inside it.
   *
   * Taking <main> wholesale is what broke this on LinkedIn: <main> there holds the
   * search filters, a list of twenty-five other jobs, a feedback survey and the
   * advert being read, and all of it was analysed together. That is where "Easy
   * Apply GBV Ltd", a £55 salary and dates from other people's job cards came
   * from.
   *
   * Link density separates them. A results list is almost entirely link text;
   * prose is almost none. The scoring lives in core/readability.ts, tested with
   * numbers; everything here just measures the DOM and hands them over.
   */
  const region =
    document.querySelector("main") ??
    document.querySelector("[role='main']") ??
    document.querySelector("article") ??
    document.body;

  const MIN_CANDIDATE_TEXT = 280;
  const candidates: HTMLElement[] = [];
  const stats: {
    index: number; textLength: number; linkTextLength: number; linkCount: number; depth: number;
    commas: number; signature: string;
  }[] = [];

  const measure = (el: HTMLElement, depth: number) => {
    const text = (el.textContent ?? "").trim();
    if (text.length < MIN_CANDIDATE_TEXT) return;

    const anchors = el.querySelectorAll("a");
    let linkTextLength = 0;
    anchors.forEach((a) => {
      linkTextLength += (a.textContent ?? "").trim().length;
    });

    stats.push({
      index: candidates.length,
      textLength: text.length,
      linkTextLength,
      linkCount: anchors.length,
      depth,
      commas: (text.match(/[,，、]/g) ?? []).length,
      // Class and id are how a page names its own regions. Readability leans on
      // this heavily, and it is the signal that tells a sidebar from an article
      // without knowing anything about the site.
      signature: `${el.className || ""} ${el.id || ""}`,
    });
    candidates.push(el);
  };

  measure(region as HTMLElement, 0);
  // Two levels of children is enough to separate a pane from its page without
  // walking into individual paragraphs.
  const walk = (el: Element, depth: number) => {
    if (depth > 3) return;
    for (const child of Array.from(el.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (/^(SCRIPT|STYLE|NAV|HEADER|FOOTER|ASIDE|FORM)$/.test(child.tagName)) continue;
      measure(child, depth);
      walk(child, depth + 1);
    }
  };
  walk(region, 1);

  /*
   * Propagate upward, as Readability does. A container holding several good
   * paragraphs is a better answer than the best single paragraph inside it,
   * because the paragraph alone loses the heading and the byline.
   */
  const scored = stats.map((b) => ({ block: b, score: scoreBlock(b) }));
  for (const child of scored) {
    if (child.score <= 0) continue;
    for (const other of scored) {
      if (other === child) continue;
      if (other.block.depth < child.block.depth && other.block.textLength >= child.block.textLength) {
        other.score += child.score * 0.25;
      }
    }
  }

  const best = scored.reduce<{ block: (typeof stats)[number]; score: number } | undefined>(
    (winner, current) => (current.score > (winner?.score ?? 0) ? current : winner),
    undefined,
  )?.block;
  const root = best ? (candidates[best.index] ?? region) : region;

  const extraction = {
    candidates: stats.length,
    chosenChars: best?.textLength ?? (region.textContent ?? "").trim().length,
    regionChars: (region.textContent ?? "").trim().length,
    linkDensity: best && best.textLength > 0 ? Math.round((best.linkTextLength / best.textLength) * 100) / 100 : 1,
    usedWholeRegion: !best || candidates[best.index] === region,
  };

  const isHidden = (el: Element): boolean => {
    const style = window.getComputedStyle(el);
    return style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
  };

  /*
   * Strip the furniture, then read the text.
   *
   * The subtlety: innerText is layout-aware — it is what gives us the line breaks
   * between table cells and list items that the parsers depend on. A DETACHED node
   * has no layout, so innerText on a plain cloneNode() silently degrades to
   * textContent and every one of those breaks disappears. That turns an invoice's
   * "Total amount due | EUR 2,880.00" into "Total amount dueEUR 2,880.00", where
   * the word boundary before EUR no longer exists and the total is never found.
   *
   * So the cleaned clone is briefly attached off-screen to give it layout, read,
   * and removed in the same synchronous block — the page never sees it.
   */
  const NOISE = "script, style, noscript, svg, nav, header, footer, aside, iframe, [aria-hidden='true']";
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(NOISE).forEach((el) => el.remove());

  let rawText: string;
  const stage = document.createElement("div");
  stage.setAttribute("aria-hidden", "true");
  stage.style.cssText = "position:absolute;left:-99999px;top:0;width:800px;pointer-events:none;";
  try {
    stage.appendChild(clone);
    document.body.appendChild(stage);
    rawText = clone.innerText || clone.textContent || "";
  } catch {
    rawText = clone.textContent ?? "";
  } finally {
    stage.remove();
  }

  const text = rawText
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT);

  const headings = Array.from(root.querySelectorAll("h1, h2, h3"))
    .filter((el) => !isHidden(el))
    .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 0)
    .slice(0, 25);

  const labelFor = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string => {
    if (el.labels?.[0]?.textContent) return el.labels[0].textContent.replace(/\s+/g, " ").trim();
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    return el.getAttribute("placeholder") ?? el.getAttribute("name") ?? el.type ?? "field";
  };

  const fields = Array.from(
    root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"),
  )
    // Never look at password or payment fields. Not their labels, not their state.
    .filter((el) => {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (type === "password" || type === "hidden") return false;
      const name = `${el.getAttribute("name") ?? ""} ${el.getAttribute("autocomplete") ?? ""}`.toLowerCase();
      return !/(card|cvc|cvv|ccnum|credit|security-code|account-number|sortcode|iban)/.test(name);
    })
    .map((el) => ({
      label: labelFor(el).slice(0, 80),
      type: (el.getAttribute("type") ?? el.tagName.toLowerCase()).toLowerCase(),
      filled: "value" in el ? String(el.value ?? "").trim().length > 0 : false,
      required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
    }))
    .slice(0, 40);

  const structuredData: Record<string, unknown>[] = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach((node) => {
    try {
      const parsed: unknown = JSON.parse(node.textContent ?? "");
      const blocks = Array.isArray(parsed) ? parsed : [parsed];
      for (const block of blocks) {
        if (typeof block === "object" && block !== null) structuredData.push(block as Record<string, unknown>);
      }
    } catch {
      // Malformed JSON-LD is common and harmless; skip it.
    }
  });

  /*
   * Visible links. An email that says "Apply to Barclays" carries its destination
   * in the href and nowhere in the text, so without this the application link is
   * invisible — and the whole confirm-risk tier had nothing that could ever use it.
   * https only, and the anchor text is what the user actually saw.
   */
  const links = Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))
    .filter((a) => /^https:\/\//i.test(a.href))
    .map((a) => ({ text: (a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80), href: a.href }))
    .filter((l) => l.text.length > 0)
    .slice(0, 25);

  /*
   * The user's selection is the most reliable statement of what they mean.
   *
   * Capped generously: a job description runs to several thousand characters, and
   * the old 2 000 limit would have truncated exactly the case this exists for.
   */
  const selection = window.getSelection()?.toString().trim().slice(0, 16_000);

  return {
    url: location.href,
    domain: location.hostname,
    title: document.title,
    text,
    headings,
    fields,
    structuredData: structuredData.slice(0, 10),
    links,
    extraction,
    capturedAt: Date.now(),
    ...(selection ? { selection } : {}),
  };
}
