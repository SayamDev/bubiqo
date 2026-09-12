# Costs

**Verified: 12 September 2026.**

Bubiqo is free to run and free to use, and that is structural rather than a promise.
There is no server to pay for, no model API, and no service with a paid tier
anywhere in the dependency graph.

## The audit

Every external dependency, and whether it could ever produce a charge.

| Dependency | Purpose | Free allowance | Our safety limit | Billing risk | Fallback |
|---|---|---:|---:|---|---|
| [Frankfurter](https://frankfurter.dev) | Currency conversion on invoices | No quota; no daily or monthly cap | 40/hour, 200/day | **None — no paid tier exists** | Cached rate, then stale rate, then the amount as printed |
| `chrome.storage.local` | Reminders, memory, settings | Browser-provided | — | None | — |
| `chrome.alarms` | Scheduling reminders | Browser-provided | — | None | Overdue items surface in the briefing |
| `.ics` generation | Calendar export | Local, RFC 5545 | — | None | — |

That is the complete list. There is no other network call in the product.

## Services deliberately not used

The absences matter more than the presences:

| Not used | What it would have cost |
|---|---|
| OpenAI / Anthropic / Gemini API | Per-token charges, an API key, a billing account |
| Google Calendar API | OAuth, a consent screen, quota, a Cloud project |
| Gmail API | OAuth, quota units, and Google's stated intention to charge above standard thresholds |
| Any hosted backend | Servers, a database, egress |
| Analytics | A vendor, and a privacy problem |

Calendar support is a `.ics` file, which every calendar application on every platform
imports. That replaces the entire Google Calendar integration with about eighty lines
of RFC 5545 and no account.

## Frankfurter, in detail

Verified against <https://frankfurter.dev> on 12 September 2026:

- *"It requires no API key."*
- *"There are no quotas... there are no monthly or daily caps."*
- No paid tier exists, and it is free for commercial use.
- Rates come from central bank reference data, published daily.

**A service with no paid tier cannot bill anyone.** The cost risk here is genuinely
zero, not merely small.

It still goes through `CostGuard`, a 12-hour cache and a fallback chain, for two
reasons that have nothing to do with our bill:

1. Being a good citizen of a free service means not hammering it.
2. "Free today" is not a promise about next year. If their terms ever change, the
   guard is already in the path rather than being something we'd have to add under
   pressure.

Our ceiling — 40/hour, 200/day — is far above any plausible personal use (rates are
cached 12 hours, so a normal day is one or two requests) and far below anything that
could be called abuse.

## How CostGuard behaves

```
request → cache hit?  → yes: serve, no request made
                      → no ↓
        → within our hourly and daily ceiling?
                      → no:  serve a stale rate, or say so plainly
                      → yes ↓
        → request → success: cache it
                  → failure: stale rate, or say so plainly
                             5 consecutive failures → stop until tomorrow
```

A refusal is never an error. The user sees:

> Live lookups are paused for a little while to stay inside the free limit.
> Everything else still works.

And everything else genuinely does: every feature except the converted figure is
local, so a blocked provider costs you one line of an invoice display and nothing
else.

This is tested directly — under the limit, at the ceiling, on roll-over, on
consecutive failures, on a malformed payload, and with concurrent callers
de-duplicated into one request. See `tests/cost-guard.test.ts`.

## If every external service vanished

Bubiqo would keep working. Classification, entity extraction, deadline detection,
the Problem Radar, suggestions, Complete It, reminders, calendar export, memory,
activity and undo are all local computation. You would lose the converted currency
figure on a foreign invoice. That is the entire blast radius.

## Cost to users

Nothing. No subscription, no account, no sign-in, no trial, no upsell. There is
nowhere in the product to enter a payment detail, and nowhere for one to go.
