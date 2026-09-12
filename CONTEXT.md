# Context

The domain glossary for Bubiqo. Terms here are the canonical vocabulary: code, issues,
tests and docs use these words and no synonyms. No implementation detail lives here.

## Page Context

What Bubiqo understands about the page the user is currently looking at: its title, URL,
domain, visible text, headings, forms and structured data. A Page Context is derived
once per analysis and is never stored in full.

Not to be confused with **Memory**, which is what the user has explicitly chosen to keep.

## Surface

The kind of thing a page is: `email`, `invoice`, `job`, or `generic`. A Page Context is
classified into exactly one Surface, with a confidence. Surface is the coarse answer to
"what is the user looking at"; **Intent** is the finer answer to "what are they trying
to do about it".

## Entity

A single fact extracted from a Page Context: a date, an amount, a deadline, a person, an
organisation, a reference. Every Entity carries a type, a value, a confidence, the text
it came from, and a sensitivity level.

Entities are the only form in which page content is ever persisted. Raw page text and raw
email bodies are not stored.

Job-specific facts — salary, closing date, eligibility conditions — live in the **Job
Brief** rather than as Entities, because they need provenance and an Entity does not
carry one.

## Intent

What the user is likely trying to do on this Surface — applying, replying, scheduling,
paying, booking, reviewing, following up. Always held with a confidence, never asserted
as certain.

## Problem

Something detected that may need the user's attention and has a time dimension: a
deadline, a commitment the user made, an unanswered question, an upcoming event, an
unfinished form. Problems are what the **Problem Radar** reports.

A Problem is not an error. It is a thing the user might otherwise forget.

## Job Brief

The answer to the one question a job advert is read to settle: is this worth an hour
of my time. It holds the conditions that would rule the reader out, the salary, the
closing date and the working pattern, and it is derived only for the `job` Surface.

Every fact in a Job Brief records where it came from — the site's own structured data,
or the advert's prose — because those are different kinds of claim and the reader is
entitled to tell them apart.

A Job Brief's verdict is one-sided. It says `ruled out`, with the advert's own sentence
behind it, or it says nothing. There is no verdict meaning "you are eligible".

Not to be confused with **Briefing**, which is the daily digest of Reminders.

## Action

A registered, named operation Bubiqo can perform, such as `create_reminder` or
`export_calendar_event`. Every Action declares a **Risk**, whether it can be undone, and
how to **verify** it afterwards. Actions are the only things that can be executed:
nothing outside the registry can run.

## Risk

An Action's safety classification, one of three:

- **safe** — read, extract, summarise, save locally, create a reminder, prepare calendar
  data, draft. Runs without asking.
- **confirm** — send, submit, upload, post, change something outside the user's machine.
  Never runs without explicit approval in the moment.
- **blocked** — purchases, payments, credentials, security settings, account deletion,
  anything irreversible and destructive. Never runs. Not "runs after a warning": never.

## Suggestion

An Action offered to the user for this Page Context, carrying a **rationale** — the
plain-English reason it is being suggested, traced to the Entity or Problem that produced
it. A Suggestion with no rationale is a bug.

## Complete It

The signature interaction: take the safe Suggestions for this Page Context, run them in
order, verify each, and report what actually happened. Confirm-risk steps pause for
approval; blocked-risk steps are never included.

## Routine *(planned — not in this version)*

A saved sequence of Actions bound to a trigger Surface, created only after the user has
explicitly agreed to save one. A Routine has a maximum step count, an allowed Action
list, and a failure policy. Routines are never created silently from observed behaviour —
the user is always asked.

## Goal *(planned — not in this version)*

A short-lived plan the user has named ("apply for this job"), holding an ordered set of
steps and their completion state. A Goal spans pages; it ends when completed or dropped.

## Memory

Structured information the user has explicitly saved — a job, an invoice, a trip, a
contact. Memory is local, inspectable, and deletable item by item. Nothing enters Memory
without a user action.

Memory is never inferred. There is no hidden profile.

## Verification

The check performed after an Action runs, confirming the expected result actually exists.
An Action is only reported as done when its Verification passes. "We could not confirm"
is a valid and expected outcome, and is always preferred to a false success.

## Activity

The append-only local record of what was detected, suggested, approved, executed and
verified, with timestamps. It is the user's audit trail over their own extension.
