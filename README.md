<p align="center">
  <img src="docs/brand/cover.png" alt="Bubiqo — reads the page you are on, and tells you what it actually says" width="100%">
</p>

<p align="center">
  <b>A privacy-first browser extension that reads the page in front of you and tells you what it actually says.</b>
</p>

<p align="center">
  <img alt="477 tests" src="https://img.shields.io/badge/tests-477%20passing-0d6551?style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-241f18?style=flat-square">
  <img alt="Chrome MV3" src="https://img.shields.io/badge/Chrome-MV3-9d5406?style=flat-square">
  <img alt="No host permissions at install" src="https://img.shields.io/badge/host%20permissions-none%20at%20install-a81f42?style=flat-square">
  <img alt="No network" src="https://img.shields.io/badge/page%20data-never%20leaves%20the%20device-0d6551?style=flat-square">
</p>

---

## What it does

Open Bubiqo on a job advert and it gives you the brief the advert buries:

| | |
|---|---|
| **Pay** | £35,000–40,000 · *stated by the site* |
| **Closes** | 10 Jan 2027 · *stated by the site* |
| **Conditions** | DBS check required — *"This post is subject to an enhanced DBS check."* |
| **Asks for** | the eight requirements, quoted in the advert's own words |

Every fact says where it came from — the site's own structured data, or the prose —
because those are different kinds of claim and you should be able to tell them
apart. Nothing is inferred that cannot be quoted.

It also reads **emails** (the deadline, the request, what you promised),
**invoices** (supplier, total, reference, due date) and **anything carrying a date
you would rather not forget**.

## The part that matters

**It never tells you that you cannot apply.**

An advert asking for a DBS check says nothing about whether you hold one, or could
hold one in a fortnight. Earlier versions said *"Ruled out"* — the product claiming
knowledge it has no way of having, and ruling people out of jobs nobody had ruled
them out of. Conditions are now stated as what they are: what the advert asks, with
the sentence it asks in, and a button that says **I have this**. Press it once and
every future advert asking the same thing shows it as met.

## Privacy, as a property of the build

Not a promise in a policy — things you can check in `manifest.json` in thirty seconds:

- **No host permissions at install.** `optional_host_permissions` only, granted per
  site, in the product, after you have seen it work. The install prompt asks for
  nothing about your browsing.
- **No content scripts.** Nothing runs on any page until you open the panel on it.
- **One network call in the entire codebase** — an exchange rate, off by default,
  sending a currency pair and nothing else. CSP pins `connect-src` to that one host.
- **Page text is never stored.** Only extracted entities are, and only what you
  explicitly save.
- **No model, no server, no account.** The analysis is deterministic: regular
  expressions, date arithmetic and structured-data reading. Same page in, same
  answer out — which is why it can be tested exhaustively and why it works offline.

## How it is built

```
extension/src/core/         pure TypeScript — no chrome.*, no DOM, no React
  job-posting.ts            schema.org JobPosting, normalised
  job-brief.ts              the brief: conditions, pay, dates, requirements
  entity-engine.ts          dates, amounts, people, organisations, references
  problem-radar.ts          what has a deadline and needs you
  actions.ts                the Action Registry — nothing outside it can run
  safety.ts                 risk tiers: safe / confirm / blocked
extension/src/background/   the service worker and the injected extractor
extension/src/sidepanel/    the panel — React, no framework beyond it
tests/captured/             real pages, captured through the real extractor
```

**Actions carry a risk tier.** `safe` runs without asking. `confirm` never runs
without approval in the moment. `blocked` — payments, credentials, account deletion
— never runs at all, and exists so the refusal is visible rather than implied.

**Every action verifies itself.** A step reports done only when a check confirms the
result exists. *"We could not confirm"* is a valid outcome and always preferred to a
false success.

## Tested against real pages, not fixtures I wrote

`tests/captured/` holds pages captured through the extension's own extractor —
LinkedIn, Indeed, an NHS Jobs advert, a Greenhouse posting, an Ashby posting. They
are not hand-written, and that is the point: each one has found a fault no invented
fixture would have.

- The NHS advert says *"Disclosure and Barring Service"*, never *"DBS check"* — a
  whole sector's standard wording read as no condition at all.
- Indeed's search page puts the advert in a pane seven levels below `<main>`; the
  extractor never measured it, so a brief carried three other adverts' salaries and
  named the employer *"New"* — a badge on a neighbouring card.
- LinkedIn's first heading is now an AI upsell, and briefs were titled *"Use AI to
  assess how you fit"*.

```bash
npm install
npm run verify     # typecheck, lint, 477 tests, build
npm run dev        # rebuild on change
npm run capture-snippet   # build the fixture-capture console snippet
```

Load `dist/` at `chrome://extensions` → Developer mode → Load unpacked.

## Decisions worth reading

- [ADR 0001](docs/adr/0001-no-host-permissions.md) — asking for page access in the
  product rather than at install, and the amendment after it met a real inbox.
- [ADR 0002](docs/adr/0002-deterministic-core.md) — why there is no model.
- [ADR 0003](docs/adr/0003-structured-data-first-job-reading.md) — reading the
  advert the site published, including the claim the evidence later disproved.
- [CONTEXT.md](CONTEXT.md) — the domain glossary. Code, tests and docs use these
  words and no synonyms.
- [PRIVACY.md](PRIVACY.md) · [SECURITY.md](SECURITY.md)

## Status

Working and unpublished. Not on the Chrome Web Store. Email, invoice and generic
surfaces work; job adverts are the most developed. Non-English pages are largely
unsupported, and the condition rules are UK-centric — both stated in ADR 0002 as
known limits rather than discovered later.

MIT licensed.
