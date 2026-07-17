# OpenRouter free-route evaluation

The live evaluation route was process-scoped to:

- provider: `openrouter`
- endpoint: `https://openrouter.ai/api/v1/`
- model: `openrouter/free`
- credential: non-empty process placeholder only; never written to the repo or evidence

`openrouter/free` is a router, not a fixed model. It may select different
eligible free models for different requests, including models with materially
different tool-call, JSON-argument, coding, latency, and reasoning behavior.
The observed qualification runs therefore record the route, not a single
model score.

## Current local evidence

- The public SDK -> Gateway -> Manager -> Docker model loop passed: real
  `write_file` and `artifact_publish`, artifact byte verification, Manager and
  Gateway restart, SDK event replay, usage records, provider-secret absence in
  tool containers, and scoped cleanup.
- The exact pushed-SHA one-agent corpus passed 13/16 tasks. The three failures
  were a code task that stopped after writing, a repeated-context task that
  answered without tool calls, and a browser task that omitted close; process
  restart, cold snapshot restore, Docker tools, artifacts, and cleanup passed.
- The corrected ten-agent runner executed two rounds of ten concurrent tasks.
  Two exact-SHA attempts each passed 19/20 assertions. One attempt omitted
  `browser_close`; the other ended a browser task with an unavailable session.
  Cross-user workspace-volume isolation and scoped cleanup passed in both.

These results demonstrate a working route integration and expose the free
router's variance. They do not qualify `openrouter/free` as a fixed model or
as a verified alpha provider lane.

## Comparison reference

The supplied GPT-5.6 Luna reference metrics are fixed-model benchmark numbers:

| Category | Benchmark | GPT-5.6 Luna |
| --- | --- | ---: |
| Reasoning | GPQA Diamond | 91.1% |
| Reasoning | HLE | 37.2% |
| Reasoning | AA-LCR | 74.0% |
| Reasoning | GDPval-AA | 54.6% |
| Reasoning | CritPt | 20.6% |
| Coding | SciCode | 52.5% |
| Knowledge | AA-Omniscience Accuracy | 41.5% |
| Knowledge | AA-Omniscience Non-Hallucination Rate | 9.9% |

No equivalent benchmark suite was run against the random free router. A small
local corpus and a fixed-model benchmark are not apples-to-apples, so this
repository makes no claim that `openrouter/free` matches, exceeds, or maps to
the GPT-5.6 Luna percentages.
