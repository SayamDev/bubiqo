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
| NHS Jobs advert (`jobs.nhs.uk`) | none |
| Ashby-hosted posting (`jobs.ashbyhq.com`) | **a full JobPosting** |

The Ashby posting is the exception, and it is the one that proves the structured path is
worth having: title, employer, a `MonetaryAmount` salary range, a nested postal address
and an employment type, all stated by the site. It is committed as
`tests/captured/ashby-job.json`, and its test asserts the published salary wins over the
page's own "$230K – $385K".

So
`core/job-posting.ts` is an accuracy win where a site does publish one — many
company-hosted career pages do, because Google for Jobs requires it — and the prose path
in `core/job-brief.ts` is what actually runs on the job boards people use.

The NHS capture is committed as `tests/captured/nhs-job.json`, and it earned its place
immediately: the advert says "Disclosure and Barring Service Check", never "DBS check",
so the rule written against software adverts read a whole sector's standard wording as
no condition at all. Fixed, with the advert's phrasing pinned in a test.

Still wanted: a Lever-hosted posting, a Workday posting, and a Civil Service advert
(civilservicejobs.service.gov.uk sits behind a bot check, so it needs a human). LinkedIn
and Indeed captures have to come from a logged-in session — the fixtures in the repo for
those two predate this work.

The Greenhouse capture showed the extractor taking the whole region, so the text runs
from the advert straight into the application form and its voluntary self-identification
survey. `core/job-brief.ts` now stops reading at that survey's own wording — never at the
word "apply", because NHS Jobs prints "Apply for this job" in the fifth line of the
advert. A blocker matched inside that boilerplate would have been a false "you are ruled
out" with a genuine page quote behind it.
