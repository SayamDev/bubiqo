# Bubiqo

**An action layer for the web.**

Bubiqo reads the page you already have open, works out what on it needs your
attention, and completes the useful next steps in one click — without you building
an automation first.

It runs entirely on your machine. Out of the box it makes no network requests at
all.

---

## The problem

Automation tools ask you to build the automation before they can help. You have to
know the task is repetitive, know which tool to reach for, and then spend twenty
minutes wiring boxes together — for something you'll do four more times.

So most people never automate anything. The work that would benefit most is exactly
the work too small to justify the setup.

## Why this is different

Instead of asking you to describe a workflow, Bubiqo identifies useful actions from
the context you're already working in, and lets you complete them with minimal
setup.

You open an email that says *"can you send me the revised proposal by Friday?"*.
Bubiqo has already noticed the deadline, the request, and the meeting mentioned
three lines down. It offers three things. You click **Complete it**. It does them,
checks each one actually worked, and tells you what happened.

You never described a workflow. There wasn't one to describe.

## How it works

```
Page  →  Understand  →  Detect  →  Recommend  →  Complete  →  Verify  →  Remember
```

Everything in that chain is deterministic and local. A regex that finds `£2,400.00`
is more reliable than a small language model asked the same question, runs in under
a millisecond, needs no download, and can be tested exhaustively. That is why the
core is rules rather than a model — the optional model exists to handle nuance the
rules can't reach, never to replace them.

## Key features

| | |
|---|---|
| **Complete it** | Runs the safe suggested steps in order, verifies each, reports what actually happened |
| **Problem Radar** | Deadlines, promises you made, questions aimed at you, forms left half-finished |
| **Why am I seeing this?** | Every suggestion traces to the sentence on the page that produced it |
| **Reminders** | Local, via `chrome.alarms`. Set for the morning *before* a deadline, not the moment it expires |
| **Calendar** | Exports a real `.ics` file. No calendar account, no OAuth, nothing to bill |
| **Memory** | Only what you explicitly save. Inspectable and deletable item by item |
| **Activity** | An append-only log of everything Bubiqo detected, suggested, ran and verified |
| **Undo** | Wherever the action supports it. Where it doesn't, it says so before you click |

## Supported contexts

| Surface | What it finds |
|---|---|
| **Email** | Deadlines, requests aimed at you, commitments you made, people waiting, meetings |
| **Invoice** | Supplier, total, currency, reference, due date |
| **Job advert** | Role, company, salary, closing date, requirements |
| **Any page** | Dates, amounts, references, contacts, half-finished forms |

Booking and meeting pages are on the roadmap, not in this version.

## Privacy

- **Nothing leaves your machine.** Out of the box, zero network requests.
- **No host permissions.** Bubiqo cannot read a page you haven't opened it on. The
  page reader is injected on demand under `activeTab`, which Chrome grants only on a
  user gesture and only for that one tab.
- **No raw content is stored.** Only extracted entities — a date, an amount, a
  reference. Never page text, never email bodies.
- **Password and payment fields are never read.** Not their values, not their labels,
  not whether they're filled.
- **No hidden profile.** Memory contains what you explicitly saved and nothing else.

Full detail in [PRIVACY.md](PRIVACY.md).

## AI

Bubiqo works with no AI at all, and that is the default. There is no bundled model,
no API key, and no account.

An optional local model (via [Ollama](https://ollama.com)) can be pointed at the
seam in `core/` for nuance the rules miss — better summaries of long threads,
softer intent classification. It is genuinely optional: the adapter is not wired up
in this version, and everything in the feature table above works without it.

No paid model API is used, required, or supported as a dependency.

## Cost

Bubiqo cannot generate a bill, and that's structural rather than a promise:

- No paid model API, no calendar API, no mail API.
- Exactly one external service exists — [Frankfurter](https://frankfurter.dev), for
  currency conversion on invoices — it is **off by default**, needs no key and no
  account, and **has no paid tier to reach**.
- When it's on, it sends a currency pair (`EUR` → `GBP`). Never the page, never the
  amount, never anything about you.
- It still goes through `CostGuard`, a cache and a fallback, because "free today" is
  not a promise about next year.

Full audit in [COSTS.md](COSTS.md), service terms in [SERVICES.md](SERVICES.md).

## Security

The two rules that hold the product up are enforced in code, not by convention:

1. **Only registered actions can run.** There is no path from text — page content,
   a typed command, or a model's output — to executing anything not already in the
   registry.
2. **`blocked` means never.** Payments, purchases, credentials and account deletion
   have no execution path at all. Not "after a warning" — no sequence of approvals
   reaches them.

Page content is data, never instruction. A page that tries to issue commands gets
the attempt stripped and you get told. Full detail in [SECURITY.md](SECURITY.md).

## Installation

Bubiqo is not on the Chrome Web Store. Load it from source:

```bash
git clone https://github.com/SayamDev/bubiqo.git
cd bubiqo
npm install
npm run build
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the **`dist`** folder

The Bubiqo icon appears in your toolbar. Click it, or press <kbd>⌘⇧A</kbd> /
<kbd>Ctrl+Shift+A</kbd>, to open the panel on whatever page you're looking at.

Chrome 116 or newer (that's when `chrome.sidePanel` landed).

## Try it without an inbox

The repo ships five ordinary-looking web pages to try it against:

```bash
npm run demo
```

Then open <http://localhost:8123> and follow the list. There's an email with a
deadline, a foreign-currency invoice, a job advert, a half-finished form, and a page
that tries to hijack the assistant.

[CEO-DEMO.md](CEO-DEMO.md) is a four-minute script through them.

## Development

```bash
npm run dev        # rebuild on change (reload the extension in chrome://extensions)
npm run test       # 139 tests
npm run typecheck  # tsc --noEmit, strict
npm run lint
npm run verify     # all four, in order — run this before any commit
npm run icons      # regenerate the icons (pure Python, no image library needed)
```

### How the code is laid out

```
extension/src/
├── core/          pure engines — no chrome.*, no DOM, no React
│   ├── ports.ts   the only seam to the outside world
│   └── …          dates, entities, classification, intent, radar, ranking,
│                  actions, safety, executor, cost guard
├── background/    service worker, chrome-backed ports, the page extractor
├── providers/     the one external service
├── shared/        the typed message protocol
└── sidepanel/     the React UI
```

The rule that matters: **`core/` never touches the browser.** It reaches the outside
world only through `core/ports.ts`. That's why the entire action and safety layer is
tested in Node against in-memory fakes, with no browser, no jsdom and no mocking
library.

The vocabulary the code uses is defined in [CONTEXT.md](CONTEXT.md) — worth five
minutes before reading the source.

## Testing

139 tests, no browser required.

The ones worth knowing about are in `tests/captured.test.ts`. That JSON isn't
hand-written: it's the exact output of the page extractor running in real Chrome
against the demo pages, saved so CI can replay it. It caught the worst bug in the
project — `cloneNode()` detaches a node, a detached node has no layout, and
`innerText` on a node without layout silently degrades to `textContent`, collapsing
`Total amount due | EUR 2,880.00` into `Total amount dueEUR 2,880.00` and losing the
invoice total. Hand-written fixtures could never have shown that, because a human
writing them puts the newlines in by hand.

## Limitations

Stated plainly, because a tool that overstates what it does is worse than one that
does less.

- **Gmail is not integrated.** Bubiqo reads whatever page you open it on, including
  an email in a webmail client, but there is no Gmail-specific adapter in this
  version. Gmail's DOM is obfuscated and changes without notice; doing it properly is
  a maintenance commitment, not a weekend's work.
- **It cannot work while Chrome is closed.** MV3 service workers are terminated
  aggressively. Reminders fire through `chrome.alarms`, which means Chrome has to be
  running. An alarm whose moment passed while Chrome was shut fires on next startup,
  and overdue items surface in the briefing.
- **Ambiguous numeric dates are deliberately not parsed.** `12/03/2026` is 12 March
  in the UK and 3 December in the US, and there is no reliable signal on a web page
  to choose. A confidently wrong deadline is worse than no deadline.
- **The local-model adapter is a seam, not a feature.** The interface is there; the
  Ollama implementation is not wired up.
- **Chrome and Edge only.** `chrome.sidePanel` has no Firefox equivalent — a port
  means redesigning the UI, not recompiling it.
- **Not accessibility-audited by a human.** Built to WCAG 2.2 AA intent — semantic
  markup, visible focus, live regions, nothing signalled by colour alone. The
  keyboard path was driven and fixed: the tablist follows the APG pattern with a
  roving tabindex, arrow/Home/End keys, focus following selection, and no dangling
  `aria-controls`. But it has not been reviewed by a specialist, and not tested with
  a real screen reader on real hardware, which is where the findings that matter
  usually are.

## Roadmap

1. A Gmail adapter, behind the same page-reader seam
2. Wiring up the Ollama adapter for long threads and softer intent
3. Booking and meeting surfaces
4. Teach Me Once — routines offered after you repeat the same steps, never created
   silently
5. Cross-page memory: connecting a job advert to the company page you open later
6. A human accessibility audit before any store listing

## Licence

MIT — see [LICENSE](LICENSE).
