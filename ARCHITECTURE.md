# Architecture

## The rule that shapes everything

**`core/` never touches the browser.**

No `chrome.*`, no DOM, no React, no `Date.now()`. The engines are pure functions over
plain data, and they reach the outside world only through the interfaces in
`core/ports.ts`.

Three things follow from that one constraint:

- The entire action and safety layer is tested in Node against in-memory fakes — no
  browser, no jsdom, no mocking library.
- The same code runs in the service worker, the panel and the tests without change.
- Every browser quirk lives in one directory (`background/`) where it can be seen.

## The pipeline

```
                    Page (untrusted)
                          │
                    ┌─────▼─────┐
                    │  extract  │  injected on demand, activeTab only
                    └─────┬─────┘
                          │  PageContext
                    ┌─────▼─────┐
                    │ sanitise  │  page text is data, never instruction
                    └─────┬─────┘
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   ┌────────────┐  ┌────────────┐  ┌────────────┐
   │  classify  │  │  entities  │  │   intent   │
   │  (Surface) │  │            │  │            │
   └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
         └───────────────┼───────────────┘
                         ▼
                 ┌───────────────┐
                 │ Problem Radar │  deadlines, commitments, questions, forms
                 └───────┬───────┘
                         ▼
                 ┌───────────────┐
                 │  Action Ranker│  at most 3, each with a rationale
                 └───────┬───────┘
                         ▼
                 ┌───────────────┐
                 │  Safety layer │  decide() — every execution, no exceptions
                 └───────┬───────┘
                         ▼
                 ┌───────────────┐
                 │   Executor    │
                 └───────┬───────┘
                         ▼
                 ┌───────────────┐
                 │   Verifier    │  "done" only when confirmed
                 └───────┬───────┘
                         ▼
            ┌────────────┴────────────┐
            ▼                         ▼
     ┌─────────────┐           ┌─────────────┐
     │  Activity   │           │   Memory    │
     └─────────────┘           └─────────────┘
```

Everything from `sanitise` to `Action Ranker` is one pure function: `analyse()`. Same
`PageContext` and same `now` always give the same `Analysis` — which is what makes
the fixture tests meaningful and the panel instant. No network, no model, no waiting.

## Layers

| Directory | May import | Purpose |
|---|---|---|
| `core/` | only `core/` | The engines. Pure. |
| `providers/` | `core/` | External services, behind CostGuard |
| `background/` | `core/`, `providers/`, `shared/` | Service worker, chrome ports, extractor |
| `sidepanel/` | `core/` (types, formatting), `shared/` | React UI |
| `shared/` | `core/` | The typed message protocol |

## Why rules and not a model

The core is deterministic on purpose.

A regex that finds `£2,400.00` is more reliable than a small language model asked the
same question, runs in under a millisecond, needs no download, works offline, costs
nothing, and can be tested exhaustively. Deadlines, amounts, references and dates —
the things that carry most of the product's value — are exactly the cases where rules
beat a 7B model.

The date parser refuses to guess. `12/03/2026` is 12 March in the UK and 3 December
in the US, and there is no reliable signal on a web page to choose between them, so
it parses neither. A confidently wrong deadline destroys trust in every other
suggestion the product makes; a missing one is a nuisance.

The seam for an optional local model exists at the same place the rules produce their
output, so a model can *add* nuance — long-thread summaries, softer intent — without
being able to *replace* the deterministic layer or reach past the Action Registry.

## The Action Registry

The closed set of things Bubiqo can do. Each entry declares:

```ts
interface ActionDefinition {
  id: string;
  risk: "safe" | "confirm" | "blocked";
  permissions: string[];
  canUndo: boolean;
  applies(input): boolean;
  execute(input): Promise<ActionResult>;
  verify(result): Promise<VerificationResult>;
  undo?(result): Promise<ActionResult>;
}
```

`verify` is not optional decoration. An action reports success only when its
verification confirms the result exists, so **"Done" always means done** and
"we could not confirm" is a first-class, expected outcome.

The registry validates itself at construction. An action in a forbidden category that
doesn't declare itself `blocked`, or one that claims `canUndo` without providing
`undo`, throws on startup — a broken build rather than a runtime surprise.

## Ports

```ts
interface Ports {
  reminders: ReminderPort;   // chrome.alarms + storage  |  in-memory Map
  memory:    MemoryPort;     // chrome.storage.local     |  in-memory Map
  drafts:    DraftPort;
  calendar:  CalendarPort;   // .ics generation
  activity:  ActivityPort;
  clipboard: ClipboardPort;
  now:       () => number;   // injected, so tests need no fake timers
}
```

`now` being a port is what makes every date test deterministic: the suite fixes a
Friday in March 2026 and asserts exact calendar days.

## Why the extractor is injected, not declared

A declared content script over `<all_urls>` runs on every page you ever open, for as
long as the extension is installed. Injecting on demand under `activeTab` means
Chrome grants access only on a user gesture, only for the tab in front of you.

The cost is that the function must be entirely self-contained — Chrome serialises it
— so `background/extract.ts` has no imports and duplicates a little shape
information. That is a deliberate trade: a few duplicated field names in exchange for
declaring no host permissions at all.

### The bug that lives in that file

`innerText` is layout-aware, and that is the whole reason to use it: it's what puts
line breaks between table cells and list items, which the parsers depend on. A
**detached** node has no layout, so `innerText` on a plain `cloneNode()` silently
degrades to `textContent` and every one of those breaks disappears — turning an
invoice's `Total amount due | EUR 2,880.00` into `Total amount dueEUR 2,880.00`,
where the word boundary before `EUR` no longer exists and the total is never found.

The cleaned clone is therefore briefly attached off-screen to give it layout, read,
and removed in the same synchronous block. `tests/captured.test.ts` exists to stop
that regressing.

## State and the MV3 lifecycle

MV3 service workers are terminated aggressively and restarted on demand. Nothing is
kept in memory that matters:

- Durable state lives in `chrome.storage.local` and is re-read on each wake.
- `CostGuard` counters are persisted after every request and rehydrated on startup.
- The current `PageContext` is deliberately *not* durable — it exists for one
  analysis and is replaced by the next.

## The build

One Vite build produces a flat, loadable `dist/`:

```
dist/
├── manifest.json
├── service-worker.js
├── sidepanel.html
├── sidepanel.js
├── assets/sidepanel.css
├── chunks/safety.js
└── icons/
```

Output is deliberately **unminified**. In a project whose pitch is that you can audit
what it does, a readable bundle is worth more than a few saved kilobytes.

## Optional local model (the seam)

```
relevant context  →  asUntrustedData()  →  local model  →  proposed action id
                                                                 │
                                                          Action Registry
                                                                 │
                                                          decide() / safety
                                                                 │
                                                             execution
```

The model proposes an **id**. It never produces code, never produces a URL, and never
produces a parameter that isn't run through `sanitiseParams`. If it names something
unregistered, the executor refuses by name.
