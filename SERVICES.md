# External services

One entry. That is the point of the document.

---

## Frankfurter

**Role:** converts a foreign-currency invoice total into your own currency.
**Status:** optional, **off by default**.

| | |
|---|---|
| Documentation | <https://frankfurter.dev> |
| API base | `https://api.frankfurter.dev` |
| Endpoint used | `GET /v2/rate/{base}/{quote}` |
| Authentication | None. No API key, no account, no sign-up |
| Pricing | Free. **No paid tier exists** |
| Quotas | None published — *"there are no monthly or daily caps"* |
| Rate limits | Rate-limited to prevent abuse; no figures published |
| Commercial use | Permitted |
| Data source | Daily reference rates from central banks |
| Update frequency | Daily on working days |
| Terms verified | 12 September 2026, against the primary source |

### What we send

```
GET https://api.frankfurter.dev/v2/rate/EUR/GBP
```

A currency pair. Nothing else — not the page, not the amount, not an identifier, no
cookie, no header of ours. There is no conversion endpoint, which suits us: we ask
for a rate and do the multiplication locally.

### Our own limits

| | |
|---|---|
| Cache TTL | 12 hours (rates publish daily, so this costs nothing in accuracy) |
| Ceiling | 40/hour, 200/day |
| De-duplication | Concurrent callers share one in-flight request |
| Emergency stop | 5 consecutive failures pauses the provider until the next day |

Normal use is one or two requests a day, because of the cache. The ceiling exists to
make abuse impossible, not because we expect to approach it.

### Failure behaviour

| Situation | What happens |
|---|---|
| Cached rate available | Served; no request |
| Past TTL, network fine | One request, cached |
| Past TTL, network down | Stale rate, labelled as stale |
| No cache, network down | "The exchange rate could not be fetched." The amount shows as printed |
| Malformed response | Refused — a wrong number on an invoice is worse than no number |
| Rate ≤ 0 | Refused, same reasoning |
| Our ceiling reached | Stale rate if there is one, otherwise a plain-English pause message |

### Attribution

Frankfurter is open source and free to use, including commercially. Bubiqo links to
it in the setting that enables it.

### If it disappeared

Delete `extension/src/providers/frankfurter.ts` and the setting. Nothing else in the
product depends on it. Every other feature is local computation.

---

## Services considered and rejected

| Service | Why not |
|---|---|
| Gmail API | OAuth, a Cloud project, quota units, and Google's stated intention to charge above standard daily thresholds. The product must not depend on a threshold that is planned to become billable |
| Google Calendar API | OAuth and a consent screen, to do something a 2KB `.ics` file does offline |
| OpenAI / Anthropic / Gemini | Per-token billing and an API key. The brief requires the product to work without any of them, and it does |
| Exchange-rate APIs with free tiers | A "free tier" is a paid product with a trial attached. Frankfurter has no paid tier at all, which is a stronger guarantee than a generous quota |
| Any analytics vendor | Nothing to gain, a privacy promise to break |

## Rules for adding a service

If a future contributor wants to add one, all of these must hold:

1. The current pricing, quota and terms have been read from the **primary source**,
   and the verification date is recorded in COSTS.md.
2. It is genuinely useful — not added to make the project look technical.
3. It goes behind an adapter in `providers/`, never called directly.
4. It goes through `CostGuard` with a ceiling well below any billable threshold.
5. It is cached, and concurrent calls are de-duplicated.
6. It has a fallback that keeps the product usable when the service is gone.
7. It is documented here and in COSTS.md, including what is sent.
8. If it could ever bill anyone, it is off by default and says so in the UI.

And the standing rule: never rotate accounts or IPs, never use unofficial endpoints,
never work around a rate limit. If the free path doesn't support the feature, the
feature doesn't ship.
