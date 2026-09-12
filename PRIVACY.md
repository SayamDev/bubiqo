# Privacy

Bubiqo is local-first in the literal sense: **out of the box it makes no network
requests at all.** Not analytics, not telemetry, not a version check.

## What leaves your device

Nothing, unless you switch on currency conversion.

If you do, one request goes to `api.frankfurter.dev` carrying a currency pair:

```
GET https://api.frankfurter.dev/v2/rate/EUR/GBP
```

That is the entire payload. Not the page, not the amount, not the invoice, not an
identifier, not a cookie. The multiplication happens on your machine. The result is
cached for 12 hours, so opening five euro invoices in a day makes one request.

It is off by default, and the setting explains exactly this before you turn it on.

## What is stored, and where

Everything is in `chrome.storage.local` on this device. It is never synced, never
uploaded, and never shared between profiles.

| Stored | Not stored |
|---|---|
| Reminders you created | Page text |
| Memory items you explicitly saved | Email bodies |
| Extracted entities — a date, an amount, a reference | Passwords or payment details |
| Drafts you asked for | Browser history |
| Activity log (rolling, last 200 events) | Cookies or session tokens |
| Your settings | Anything from a page you didn't act on |

### Page content is not retained

A `PageContext` exists for as long as it takes to analyse it and is then replaced by
the next one. It is never written to storage.

When you save something to Memory, what's saved is the **extracted entities** — the
due date, the total, the reference — not the page it came from. This is enforced in
`core/actions.ts` rather than being a policy:

```ts
entities: input.entities.filter((e) => e.sensitivity !== "sensitive"),
```

## What is never read

- **Password fields.** Excluded before extraction, by input type.
- **Payment fields.** Anything whose name or autocomplete hints at a card number,
  CVC, IBAN, sort code or account number is excluded the same way.
- **Hidden fields.**
- **Any page you haven't opened the panel on.** Bubiqo declares no host permissions.
  The page reader is injected on demand under `activeTab`, which Chrome grants only
  on a user gesture and only for the tab in front of you.

That last point is the one worth dwelling on. Most extensions that read pages declare
a content script over `<all_urls>`, which means they run on every page you visit for
as long as they're installed. Bubiqo can't: it has no permission to.

## Email

There is no Gmail integration and no mailbox scanning. If you open the panel while
reading an email, Bubiqo reads that page the same way it reads any other — locally,
once, on your gesture. It does not walk your inbox, does not run in the background,
and does not modify any mail state.

## No profile, no inference

Memory contains what you explicitly saved. Bubiqo does not build a picture of you
from your browsing, does not infer anything sensitive, and has no hidden store.

The one piece of learning it does is narrow and local: it remembers which suggestions
you've accepted and dismissed (action ids, nothing else, last 100) so that ranking
improves. That never causes anything to run — it only reorders what's offered.

## AI

No AI runs by default. There is no bundled model, no API key and no account.

If a local model via Ollama is configured in future, it runs on your machine and
nothing reaches a third party. If you ever choose to point Bubiqo at a hosted model,
that would be an explicit opt-in with a consent screen naming the provider and what
would be sent — but no such integration exists in this version, so today the question
doesn't arise.

## Deleting your data

- **One item:** Memory tab → Delete, next to any reminder or saved item.
- **Everything:** remove the extension at `chrome://extensions`. Chrome deletes its
  storage with it. There is no server copy, because there is no server.

You can inspect everything Bubiqo holds without trusting this document: open
`chrome://extensions`, find Bubiqo, click **service worker**, and run
`chrome.storage.local.get(console.log)` in the console.

## Analytics

There are none. No usage counting, no crash reporting, no install ping. The
suggestion feedback ("useful / not useful") is stored locally and used for local
ranking only.

## Permissions in plain English

| Permission | What it lets Bubiqo do |
|---|---|
| `activeTab` | Read the page in front of you, when you open the panel |
| `scripting` | Put the page reader into that one tab, for that one read |
| `storage` | Keep your reminders and notes on this device |
| `alarms` | Let a reminder go off at the right time |
| `sidePanel` | Show the panel |
