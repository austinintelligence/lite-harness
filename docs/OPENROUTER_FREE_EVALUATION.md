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
- The latest one-agent corpus passed 14/16 tasks. The failures were a malformed
  browser tool argument and a hallucinated context block ID during the approval
  task; process restart, cold snapshot restore, Docker tools, artifacts, and
  cleanup passed.
- The ten-agent run executed two rounds of ten concurrent tasks. It passed
  14/20 task assertions; cross-user workspace-volume isolation and cleanup
  passed. The failed assertions included invalid JSON tool arguments and model
  turns that stopped before the requested verification.

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
