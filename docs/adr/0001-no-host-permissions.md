# 1. Ask for page access in the product, not at install

Date: 2026-09-12

## Status

Accepted, then **amended** after the extension met a real inbox. The original
decision — rely on `activeTab` alone — turned out to be impossible for a side panel.
See Amendment below.

## Context

Bubiqo has to read the page the user is looking at. The conventional way for a Chrome
extension to do that is to declare a content script in the manifest:

```json
"content_scripts": [{ "matches": ["<all_urls>"], "js": ["content.js"] }]
```

This is what most page-reading extensions do. It is simple, the script is always
present, and there is no injection latency.

It also means the extension runs code on **every page the user ever opens**, for as
long as it is installed, and Chrome tells the user so at install time: *"Read and
change all your data on all websites."*

For a product whose central claim is privacy, that install prompt is the claim being
contradicted at the only moment the user is paying attention.

## Decision

Declare **no host permissions and no content scripts.** Read the page by injecting the
extractor on demand with `chrome.scripting.executeScript` under `activeTab`.

`activeTab` is granted by Chrome only on a user gesture, and only for the tab that
gesture happened in. Opening the side panel is that gesture.

## Consequences

**Good:**

- The extension is *incapable* of reading a page the user hasn't opened it on. This is
  a property of the permission model, not of our code being well-behaved.
- The install prompt is four narrow permissions rather than "all your data on all
  websites".
- Nothing runs on pages the user never invoked it on: no CPU, no memory, no risk.
- The privacy claims in PRIVACY.md are verifiable from `manifest.json` alone.

**Bad:**

- The injected function must be entirely self-contained — Chrome serialises it — so
  it cannot import from `core/` and duplicates a little shape information. This is
  the cost, and it is paid in one file (`background/extract.ts`).
- **`activeTab` expires when the tab changes.** The panel cannot re-read as the user
  moves between messages in a webmail client, which is the single most common way
  this product is used. This was not obvious until the extension ran against a real
  inbox. The answer is `optional_host_permissions`: the user may grant one named
  site standing access, from a prompt that appears only after a read has already
  worked there. The default — nothing granted — is preserved, and the decision
  stays the user's rather than the manifest's.
- No passive background monitoring is possible. A feature like "watch my inbox and
  tell me when something arrives" cannot be built this way. That is a real capability
  given up, and it was given up deliberately: it is the same capability that makes
  those extensions worth attacking.
- Injection costs a few milliseconds per analysis, which is not perceptible next to
  the panel opening.

## Alternatives considered

- **Declared content script on `<all_urls>`.** Rejected: the install prompt, and the
  standing capability.
- **Declared content script on a narrow allowlist** (`mail.google.com`, etc.).
  Rejected: it makes the product work on a fixed list of sites, when the whole pitch
  is that it works on whatever page you happen to be reading.

## Amendment (2026-09-12)

`activeTab` cannot work for this product, and no amount of care in the code changes
that. **A Chrome side panel never receives the `activeTab` grant.** Chrome grants it
for an action click, a context-menu click, a keyboard command or an omnibox
suggestion; when the action opens a side panel, the grant does not reach the panel.

So the original decision shipped an extension that could not read any page at all,
and — worse — told the user to "click the Bubiqo icon", advice that could never work.
It took running it against a real inbox to find, because the test fake had been
written to match the intended design rather than the browser's actual behaviour.

The decision is therefore amended, keeping as much of the original intent as the
platform allows:

- `optional_host_permissions`, not `host_permissions`. **Nothing is granted at
  install**, so the install prompt still asks for nothing about browsing.
- The panel requests access itself, on first use, from a user gesture. Chrome shows
  its own confirmation naming what is being asked.
- Revocable at `chrome://extensions`.

What survives is the part that mattered: the user decides, having seen the product
work, rather than being confronted with "read and change all your data on all
websites" at install before Bubiqo has shown them anything. What is lost is the
stronger claim that Bubiqo is structurally incapable of reading other pages. It is
now capable, and constrained by behaviour and by the code rather than by the
permission model. That is a genuinely weaker guarantee and is stated as such in
PRIVACY.md rather than papered over.
