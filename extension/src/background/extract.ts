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

/** Kept in step with core/types.ts PageContext; duplicated because of serialisation. */
export function extractPageContext(): {
  url: string;
  domain: string;
  title: string;
  text: string;
  headings: string[];
  fields: { label: string; type: string; filled: boolean; required: boolean }[];
  structuredData: Record<string, unknown>[];
  links: { text: string; href: string }[];
  selection?: string;
  capturedAt: number;
} {
  const MAX_TEXT = 24_000;

  // Prefer the semantic content region; fall back to body only if there isn't one.
  const root =
    document.querySelector("main") ??
    document.querySelector("[role='main']") ??
    document.querySelector("article") ??
    document.body;

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

  const selection = window.getSelection()?.toString().trim().slice(0, 2000);

  return {
    url: location.href,
    domain: location.hostname,
    title: document.title,
    text,
    headings,
    fields,
    structuredData: structuredData.slice(0, 10),
    links,
    capturedAt: Date.now(),
    ...(selection ? { selection } : {}),
  };
}
