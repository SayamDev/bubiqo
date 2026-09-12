# Job Brief — rebuilding how Bubiqo reads a job advert

Date: 2026-09-12
Status: Design, approved in outline

## Problem

Reading a job advert does not work. Three causes, all structural rather than
incidental:

1. **The best data on the page is thrown away.** `background/extract.ts` harvests
   every `application/ld+json` block, and `core/context-engine.ts` uses it for one
   thing only: deciding that the Surface is `job`. A schema.org `JobPosting` carries
   `title`, `hiringOrganization`, `baseSalary`, `employmentType`, `jobLocation` and
   `validThrough` — exact values, stated by the site. All of it is discarded, and the
   same facts are then guessed back out of prose.
2. **The JSON-LD reader is shallow.** Only a top-level `@type` of `"JobPosting"` is
   recognised. A `@graph` wrapper or an array-valued `@type` — both common — reads as
   nothing.
3. **The job-specific extraction is a closed English tech vocabulary.** `core/job-details.ts`
   holds 90 hardcoded technology names and 9 UK-specific requirement rules. Outside
   UK software roles it returns empty, and the `skill` chips it produces do not answer
   any question the reader has.

Underneath all three: the advert's facts arrive as loose `Entity` values with no
provenance, so nothing can say whether a salary was stated by the site or inferred
from a sentence.

## What this is for

One question: **is this advert worth an hour of my time?**

Not a tracking record, not CV matching. The things that answer it are the
deal-breakers (clearance, citizenship, sponsorship, residency, DBS, licence), the
money, the closing date, and the working pattern. A tag cloud of technologies does
not answer it and is removed.

## Decisions

| Decision | Choice |
|---|---|
| Primary data source | schema.org `JobPosting` JSON-LD where the page has one |
| Fallback | Prose rules, first-class — not an afterthought |
| Skills | Removed entirely, with the `skill` Entity type |
| Verdict | Emitted **only** as `ruled_out`, only when a blocking rule matched with quoted evidence |
| Blockers | Closed rules for absolutes, plus quoted bullets from the advert's own eligibility section |

### Why prose is first-class, not a fallback

Every real captured page in `tests/captured/` — `linkedin-real-page.json`,
`linkedin-tech-lead.json`, `linkedin-job.json`, `indeed-job.json` — has
`structuredData: []`. Only the synthetic `job.json` carries JSON-LD. Whatever these
sites serve to crawlers, what the extension actually sees on a logged-in LinkedIn job
page contains no JSON-LD at all.

So the structured path is the accurate path where it exists, and on the most common
site in the product's actual use it fires never. A design that treats prose as a
degraded mode would be a design that does not work on LinkedIn.

**The plan must open with a capture step:** record fresh fixtures through the real
extractor from a logged-in LinkedIn advert, an Indeed advert, a Greenhouse-hosted
posting, a Lever-hosted posting, and a public-sector advert, and record for each
whether `structuredData` is non-empty. Build against that evidence, not against this
assumption.

## Architecture

```
PageContext
   ├── readJobPosting(structuredData)  ──> JobPosting | null      exact, from the site
   └── readProseSignals(text, headings) ──> partial fields        rules + eligibility section
                    │
                    └──> buildJobBrief(...) ──> JobBrief
```

Three units, each independently testable:

**`core/job-posting.ts`** — pure, no DOM, no page knowledge. Turns raw JSON-LD blocks
into a normalised `JobPosting` or `null`. Handles `@graph` unwrapping, array-valued
`@type`, `hiringOrganization` as object or string, `baseSalary` as `MonetaryAmount`
with a nested `QuantitativeValue`, and `validThrough` as an ISO date. Never throws:
malformed input yields `null` or a partial object, never an exception.

**`core/job-brief.ts`** — assembles the `JobBrief`. Field by field, the structured
value wins where present and the prose value fills the gap. Holds the blocker rules
and the eligibility-section reader. If it passes roughly 200 lines the rules move to
`core/job-blockers.ts`; the brief assembly and the rule vocabulary are separate
concerns and should not share a file once either grows.

**`core/analyse.ts`** — wires it in. The brief is built only when the Surface is
`job`, and before problems are scanned, because the Problem Radar now takes its
blocking-requirement input from the brief.

Revised pipeline:

```
sanitise -> classify -> entities -> [brief, when surface is job] -> intents -> problems -> rank
```

## Data model

Added to `core/types.ts`, which is where the domain model lives.

```ts
export type BriefSource = "structured" | "prose";

/** A single fact in a Brief, carrying where it came from. */
export interface BriefField<T> {
  readonly value: T;
  readonly source: BriefSource;
  /** The sentence it was read from, or the JSON-LD property path. */
  readonly evidence: string;
  readonly confidence: number;
}

/** A condition that rules the reader out. Never inferred without a quote. */
export interface Blocker {
  readonly summary: string;   // in our words
  readonly evidence: string;  // in the advert's words
  readonly rule: string;      // rule id, so a match is traceable in tests and in the UI
}

export interface JobBrief {
  readonly title?: BriefField<string>;
  readonly organisation?: BriefField<string>;
  readonly location?: BriefField<string>;
  readonly salary?: BriefField<string>;
  readonly closingDate?: BriefField<number>;     // epoch ms
  readonly employmentType?: BriefField<string>;
  readonly workingPattern?: BriefField<string>;  // on-site days, hybrid, remote
  readonly blockers: readonly Blocker[];
  /** The advert's own eligibility bullets, quoted, capped. */
  readonly eligibility: readonly string[];
  /** Present only when a blocking rule matched. There is no positive verdict. */
  readonly verdict?: "ruled_out";
}
```

`Analysis` gains `readonly brief?: JobBrief`.

Money and dates are not re-implemented: salary formatting goes through `core/money.ts`
and `core/currency.ts`, and `closingDate` through `core/dates.ts` — which refuses
ambiguous dates, so an unparseable closing date is absent rather than wrong.

## Blocker rules

Carried over from `job-details.ts` and restructured, each with a stable `rule` id:
security clearance, British citizenship, UK residency period, right-to-work and
sponsorship, driving licence, DBS check. Each rule owns its id, its pattern, its
summary, and a real advert sentence in its test.

Only these produce `blocking: true`. Years-of-experience, degree and on-site days are
facts, not blockers: years and degree become eligibility lines, on-site days becomes
`workingPattern`.

### The eligibility section

Rules cannot know every blocker. So: find the advert's own eligibility heading —
`eligib`, `essential`, `you must`, `to apply`, `security requirements` — in
`page.headings` or as a short line in the text, and quote the lines beneath it up to
the next heading. Capped at 8 items and 400 characters, each line trimmed to 180.

These are quoted, never classified. They surface a blocker nobody wrote a rule for
without ever asserting one.

## Verdict

`verdict` is `"ruled_out"` when at least one blocker matched, and absent otherwise.
There is no "apply" and no "check first".

This follows ADR 0002 to its conclusion: the failure mode must be missing something,
not inventing something. Telling someone they are eligible when they are not is the
one error that costs them a real opportunity, and no rule set here is good enough to
earn that claim.

## What is removed

- `core/job-details.ts`, and `tests/job-details.test.ts` with it.
- `extractSkillsAndRequirements` in `core/entity-engine.ts`.
- The `skill` and `requirement` members of `EntityType`.
- The skills chip section in `sidepanel/App.tsx`.
- The string-sniffing in `core/problem-radar.ts:169`, which detects a blocking
  requirement by testing whether an Entity's value contains the literal `"(blocking)"`.
  It takes `JobBrief.blockers` instead.

Stored Memory items written by earlier versions may hold Entities of the retired
types. The read path must tolerate them rather than crash; confirm against
`core/storage-hygiene.ts` during implementation.

## Panel

The skills chips are replaced by a Brief section, shown only for the `job` Surface:
blockers first, each with its quoted sentence and a `ruled out` marker; then salary,
closing date, working pattern, location; then the eligibility quotes behind a
disclosure. Fields read from JSON-LD are marked as stated by the site, fields from
prose as read from the advert — the distinction is the honest part and the user
should see it.

Note: `Briefing` already exists in the panel and means the reminders digest. The new
type is `JobBrief` and its section is the Job Brief; the two names must not be
conflated in code or in the UI.

## Testing

- `tests/job-posting.test.ts` — `@graph`, array `@type`, nested and string
  `hiringOrganization`, `baseSalary` shapes, missing fields, malformed JSON, hostile
  input. Assert it never throws.
- `tests/job-brief.test.ts` — one case per blocker rule using a real advert sentence;
  structured-beats-prose precedence; prose-only assembly; eligibility extraction and
  its caps; no blockers means no verdict.
- `tests/captured.test.ts` — updated to assert briefs rather than skill entities,
  against the freshly captured fixtures.
- `tests/context-menu.test.ts`, `tests/selection.test.ts` — updated for the removed
  entity types.
- Determinism: same PageContext and same `now` produce an identical brief.

`npm run verify` must pass before anything is considered done.

## Documentation

- `CONTEXT.md` gains **Job Brief** as a domain term, and the Entity section notes
  that job facts now live in the Brief.
- New ADR: structured-data-first reading, with the captured evidence about JSON-LD
  absence on real pages recorded in it.
