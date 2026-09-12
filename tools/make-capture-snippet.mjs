/**
 * Build the fixture-capture snippet.
 *
 * tests/captured/*.json is the exact output of the real page extractor running in
 * a real browser — that is the whole point of it, and it is what caught the
 * cloneNode()/innerText bug that no hand-written fixture could have shown. But
 * capturing a new one meant loading the extension, hitting a breakpoint and
 * copying an object out of a DevTools inspector, which is enough friction that
 * nobody does it and the fixtures go stale.
 *
 * This bundles the extractor — the same file the service worker injects, not a
 * copy of it — into one self-contained snippet that can be pasted into the
 * DevTools console of any page. Paste it, and the PageContext for that page is on
 * the clipboard, ready to save into tests/captured/.
 *
 * Run: npm run capture-snippet
 */

import { build } from "esbuild";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const entry = `
import { extractPageContext } from "${resolve(root, "extension/src/background/extract.ts").replace(/\\/g, "/")}";

const context = extractPageContext();
const json = JSON.stringify(context, null, 2);

console.log(
  "%cBubiqo capture",
  "font-weight:bold",
  {
    url: context.url,
    chars: context.text.length,
    headings: context.headings.length,
    structuredData: context.structuredData.length,
    selection: context.selection ? context.selection.length + " chars selected" : "none",
  },
);

if (context.structuredData.length === 0) {
  console.warn("No JSON-LD on this page. The brief will be built from prose alone — worth recording.");
}

/*
 * \`copy\` is a DevTools console built-in and does not exist when the snippet is
 * run any other way — from an automated browser, say. Fall back to leaving the
 * capture on \`window\` so it can still be read out.
 */
if (typeof copy === "function") {
  copy(json);
  console.log("PageContext copied to the clipboard. Save it as tests/captured/<name>.json");
} else {
  globalThis.__bubiqoCapture = json;
  console.log("PageContext left at window.__bubiqoCapture — no clipboard outside the DevTools console.");
}
`;

const result = await build({
  stdin: { contents: entry, resolveDir: root, sourcefile: "capture.ts", loader: "ts" },
  bundle: true,
  format: "iife",
  target: "chrome116",
  write: false,
  // Minified because this gets pasted into a console by hand, and a 4KB paste is
  // manageable where an 8KB one is not.
  minify: true,
  // `copy()` is a DevTools console built-in, not a page global — esbuild must not
  // try to resolve it.
  define: {},
});

const code = result.outputFiles[0].text;

mkdirSync(resolve(root, "dist"), { recursive: true });
writeFileSync(resolve(root, "dist/capture-fixture.js"), code);

console.log(`Wrote dist/capture-fixture.js (${code.length} bytes)`);
console.log("Paste its contents into the DevTools console of the page you want to capture.");
