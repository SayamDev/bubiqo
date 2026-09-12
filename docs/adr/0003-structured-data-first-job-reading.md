# 3. Read the job advert the site published, not the one we can infer

Date: 2026-09-12

## Status

Accepted

## Context

Reading a job advert did not work, and the reasons were structural rather than a
collection of missed patterns.

Most job pages publish a schema.org `JobPosting` in a `<script type="application/ld+json">`
block, because Google for Jobs requires it. It states the title, the employer, the
salary, the employment type and the closing date in fields. Bubiqo already collected
those blocks in `background/extract.ts`, and used them for exactly one thing: deciding
that the Surface was `job`. Every fact in them was then discarded and guessed back out
of the page prose, beside a sidebar advertising twenty other roles.

The guessing was also narrow. `core/job-details.ts` held 90 hardcoded technology names
and nine UK-specific requirement rules. Outside UK software roles it returned nothing,
and what it did return — a row of technology chips — answered no question a reader
actually has. Worse, the facts it produced arrived as loose `Entity` values with no
provenance, so nothing could say whether a salary had been stated by the site or
inferred from a sentence. The Problem Radar ended up detecting a blocking condition by
testing whether an Entity's value contained the literal string `"(blocking)"`.

## Decision

Read structured data first. `core/job-posting.ts` normalises a `JobPosting` block —
including the shapes that appear in the wild: a `@graph` wrapper, an array-valued
`@type`, `hiringOrganization` as object or string, `baseSalary` as a `MonetaryAmount`
around a `QuantitativeValue`. `core/job-brief.ts` assembles a **Job Brief** from it,
with prose filling every field the structured data does not supply, and each field
recording which of the two it came from.

The brief answers one question — is this worth an hour — so it holds blockers, salary,
closing date and working pattern. The closed technology vocabulary is deleted, along
with the `skill` and `requirement` Entity types.

The verdict is one-sided: `ruled out` when a blocker rule matched with a quoted
sentence behind it, and otherwise absent. There is no verdict meaning eligible.

## Consequences

**Good:**

- Where a page publishes structured data, the title, employer, salary and closing date
  are exact rather than inferred, and cannot be taken from a neighbouring advert.
- Provenance is visible to the user, so a matched salary is never presented with the
  authority of a published one.
- The eligibility section is quoted rather than classified, so a condition nobody wrote
  a rule for — a registration, a certificate, a shift pattern — still reaches the reader
  without the product asserting anything about it.
- Six blocker rules replace a growing list of pattern-matched "requirements", and each
  one is absolute. An advert asking for five years of experience no longer produces a
  condition, because a good four-year application would still have been read.

**Bad:**

- **The structured path does not fire on the sites that matter most.** LinkedIn (three
  captures), Indeed, a Greenhouse-hosted posting and an NHS Jobs advert all have an
  empty `structuredData`. Whatever those sites serve to crawlers, what the extension
  sees on the page contains no JSON-LD. So prose is not a fallback here; it is the path
  that runs on the job boards people actually use.

  An Ashby-hosted posting does publish one, in full — title, employer, a salary range,
  a nested postal address, an employment type — and `tests/captured/ashby-job.json`
  pins it. So the split is roughly: company career pages hosted on an ATS that cares
  about Google for Jobs, yes; the big aggregators, no.
- The employer is read only from structured data. Naming it from prose is the guess
  that went wrong most often — a job board's own name, or the company advertising
  beside the advert — and it is left to the Entity extractor, which carries its own
  evidence.
- The six blocker rules remain UK-centric and English-only, in the same way the rest of
  the deterministic core is. That is a known limit, not an oversight.

## Follow-up

The JSON-LD-first path is unproven against real pages until fixtures are captured from
a logged-in LinkedIn advert, an Indeed advert, a Greenhouse posting, a Lever posting
and a public-sector advert, recording for each whether `structuredData` is non-empty.
Capturing those needs browser sessions and is tracked as the last task of
`docs/superpowers/plans/2026-09-12-job-brief.md`.
