# Checking that reminders really work

Reminders are the feature everything else leans on, so here are three ways to
satisfy yourself they do, in increasing order of effort.

## 1. Run the trace

```bash
npm run prove:reminders
```

It walks a reminder from an email to a scheduled alarm and back, over a fake
`chrome.*` surface, and prints each step:

```
TODAY IS        Friday 6 March at 10:00
PAGE            Revised proposal — Northwind account
DEADLINE FOUND  Friday 13 March at 09:00   from “…Can you send me the revised proposal by Friday…”
ACTION          Create reminder -> done
REPORTED        “Reminder set for Thursday, 09:00.”
STORED          “Deadline: by Friday”
DUE             Thursday 12 March at 09:00
ALARM SET FOR   Thursday 12 March at 09:00
                (the morning before the deadline, not the moment it expires)
VERIFIED        verified: Reminder "Deadline: by Friday" is stored and scheduled.
ON 12 MARCH     briefing shows 1 due: “Deadline: by Friday”
UNDO            reminders left: 0, alarms left: 0
```

It also covers the two awkward cases: a deadline that has already passed (the
record is kept, no alarm is scheduled, and it shows as overdue), and the service
worker being terminated mid-life (the reminder survives).

## 2. Look inside your own installed copy

Go to `chrome://extensions`, find Bubiqo, click **service worker**, and in the
console:

```js
// Everything Bubiqo is holding for you
await chrome.storage.local.get("bubiqo.reminders")

// The alarms Chrome has actually scheduled
await chrome.alarms.getAll()
```

The `dueAt` on a stored reminder and the `scheduledTime` on its alarm should be
the same number. If they ever disagree, one of them is lying to you — there is a
test asserting they cannot.

## 3. Watch one fire

Alarms are scheduled for the morning before a deadline, so the honest way to see
one fire without waiting is to schedule one by hand. In the same service worker
console:

```js
const id = "demo_" + Date.now();
const dueAt = Date.now() + 70_000;                 // Chrome's minimum is ~1 minute
const all = (await chrome.storage.local.get("bubiqo.reminders"))["bubiqo.reminders"] ?? {};
all[id] = { id, title: "Reminder demo", dueAt, createdAt: Date.now(), fired: false };
await chrome.storage.local.set({ "bubiqo.reminders": all });
await chrome.alarms.create(id, { when: dueAt });
```

Then leave Chrome open. After about a minute the Bubiqo toolbar icon takes an
amber badge, and the reminder appears in **Memory → Reminders** and in the
briefing at the bottom of the **Now** tab.

Delete it from the Memory tab when you are done.

## Does a reminder still reach you after you close things?

| You close | Does it still fire? |
|---|---|
| The side panel | **Yes.** Alarms are handled by the extension's background worker, which has nothing to do with the panel being open. You get an amber badge on the toolbar icon. |
| The tab, or every tab | **Yes.** Same reason — reminders are not attached to a page. |
| Chrome itself | **Not while it is closed**, and no extension can. `chrome.alarms` is a browser API, not a server. But nothing is lost: the moment Chrome next opens, Bubiqo reconciles every stored reminder against the clock, marks anything whose time passed, badges the icon, and shows it in the briefing as overdue. |

That last row is reconciled from the **stored records**, not from trusting Chrome
to replay a missed alarm. Chrome's replay guarantee is weak over long gaps, and the
toolbar badge is cleared on restart anyway — so a reminder that fired yesterday
would otherwise have left no trace today. `npm run prove:reminders` covers this
case directly:

```
BEFORE          due Thursday 12 March at 09:00, fired: false, badge: ""
AFTER RESTART   fired: true, badge: "1"
                briefing overdue: 1 — "Deadline: by Friday"
```

Bubiqo is therefore **late, never silent**. If your machine was off for a week,
you find out the moment you open Chrome.

## What reminders cannot do

Stated plainly, because a tool that overstates itself is worse than one that does
less:

- **Nothing fires while Chrome is closed.** No extension can do otherwise. What
  Bubiqo guarantees instead is that it catches up on the next start — see the
  table above. If you need to be interrupted while the browser is shut, you need
  a phone alarm, not a browser extension, and this will not pretend otherwise.
- **Chrome's minimum alarm interval is about a minute.** Nothing can be scheduled
  more precisely than that.
- **There is no notification, by design.** A badge on the toolbar icon says the
  same thing without the extension asking for the `notifications` permission.
