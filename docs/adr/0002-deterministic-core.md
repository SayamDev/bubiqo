# 2. A deterministic core, with a model as an optional adjunct

Date: 2026-09-12

## Status

Accepted

## Context

The obvious way to build "understand this page and suggest what to do" in 2026 is to
send the page to a language model and use what comes back. It is less code, it
generalises to pages nobody anticipated, and it handles phrasing no rule will catch.

It also means: a model dependency, either a paid API or a multi-gigabyte local
download; non-deterministic output that cannot be unit-tested; latency measured in
seconds; a privacy story that requires explaining where the page went; and a cost
story that depends on somebody else's pricing page.

The requirements for this product were explicit that it must be free to run, work
offline, and keep page content local.

## Decision

Make the core **deterministic**: regular expressions, date arithmetic, structured-data
reading, and weighted heuristics. Put the seam for an optional local model *after*
the rules produce their output, where it can add nuance but cannot replace the
deterministic layer or reach past the Action Registry.

## Consequences

**Good:**

- A regex that finds `£2,400.00` is more reliable than a small model asked the same
  question, and it can be tested exhaustively. 139 tests run in under a second.
- Analysis is instant. The panel has no spinner because there is nothing to wait for.
- It works offline, costs nothing, and no page content leaves the device.
- Every suggestion traces to the exact sentence that produced it, which is what makes
  the "why am I seeing this?" disclosure honest rather than generated after the fact.
- The failure mode is *missing* something, not *inventing* something. For a tool whose
  job is reminding you about deadlines, a false negative is a nuisance and a false
  positive is a betrayal.

**Bad:**

- Phrasing the rules don't cover is missed. A commitment written as "consider it done"
  is not detected, where a model would catch it.
- Non-English pages are largely unsupported.
- The rules are a maintenance surface: each new surface means new patterns, and they
  interact in ways that need tests to pin down. Three of the bugs found while building
  this were rules interacting badly.

## Notes

The date parser follows the same principle to its conclusion and refuses ambiguity
outright: `12/03/2026` is 12 March in the UK and 3 December in the US, and there is no
reliable signal on a web page to choose between them, so it parses neither. Nine
months of error in a deadline would poison trust in every other suggestion the product
makes. A missing date costs one reminder.
