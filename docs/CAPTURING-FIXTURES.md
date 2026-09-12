# Capturing a fixture

`tests/captured/*.json` is not hand-written. Each file is the exact output of the real
page extractor running in a real browser against a real page, which is the only reason
those tests are worth anything: a hand-written fixture has the newlines a human thought
were there, and it was exactly that difference which hid the `cloneNode()`/`innerText`
bug that silently dropped an invoice total.

Capturing one used to mean loading the unpacked extension, breaking in the service
worker and copying an object out of the inspector. That is enough friction that nobody
does it, so the fixtures go stale and the rules drift away from the pages they were
written for.

## How

```bash
npm run capture-snippet
```

This bundles `extension/src/background/extract.ts` — the same file the service worker
injects, not a copy of it — into `dist/capture-fixture.js`, about 5KB.

1. Open the page you want to capture. Log in if it needs it; the capture happens in your
   own session.
2. If you want to capture a **selection** rather than the whole page, select the advert
   first. The snippet records whatever is selected, which is how Bubiqo is used in
   practice.
3. Open DevTools, go to the Console, paste the contents of `dist/capture-fixture.js`,
   press Enter.
4. The `PageContext` is now on your clipboard. Save it as
   `tests/captured/<site>-job.json`.
5. Note what it printed. `structuredData: 0` means the page publishes no JSON-LD and the
   Job Brief will be built from prose alone — worth knowing, and worth recording in the
   test you write next.

Then write the test in `tests/captured.test.ts`: what Surface it should be, which
blockers the advert actually states, and that nothing appears which is not on the page.

## What we know so far

Every page captured to date publishes **no** `JobPosting` JSON-LD:

| Page | JSON-LD |
|---|---|
| LinkedIn job, logged in (three captures) | none |
| Indeed job | none |
| Greenhouse-hosted posting (`job-boards.greenhouse.io`) | none |

Only the synthetic `tests/captured/job.json` carries structured data. So
`core/job-posting.ts` is an accuracy win where a site does publish one — many
company-hosted career pages do, because Google for Jobs requires it — and the prose path
in `core/job-brief.ts` is what actually runs on the job boards people use.

Still wanted: a Lever-hosted posting, a Workday posting, an NHS or Civil Service advert
(they state clearance, DBS and residency conditions in the phrasings the blocker rules
were written against), and a company career page that does publish JSON-LD, to exercise
the structured path against something real.

One thing the Greenhouse capture showed that no test yet covers: the extractor took the
whole region, so the captured text runs from the advert straight into the application
form, including the voluntary self-identification lists. The brief reads correctly
anyway, but a blocker rule matching inside that boilerplate would be a false positive
with a quote to back it up, which is the worst kind.
