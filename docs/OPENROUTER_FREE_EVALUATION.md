# Historical OpenRouter free-route evaluation

> This is an archival experiment, not a current qualification instruction.
> Do not rerun it for Windows-local alpha and do not require an OpenRouter key.
> The verified local route is Hermes `gpt-5.6-luna` through
> `http://127.0.0.1:8645/v1`.

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

## Observed free-route roster

The operator-supplied OpenRouter catalog for this experiment exposed the
following eligible pool at capture time. The pool is dynamic and this list is
not a promise that every request will use every entry:

| Provider | Observed models |
| --- | --- |
| Cohere | `north-mini-code-20260617` |
| Google | `Gemma 4 26B A4B`; `Gemma 4 31B` |
| Meta Llama | `Llama 3.2 3B Instruct`; `Llama 3.3 70B Instruct` |
| Nous Research | `Hermes 3 405B Instruct` |
| Nvidia | `llama-nemotron-embed-vl-1b-v2-20260224`; `llama-nemotron-rerank-vl-1b-v2`; `Nemotron 3 Nano 30B A3B`; `nemotron-3-nano-omni-30b-a3b-reasoning-20260428`; `Nemotron 3 Super`; `Nemotron 3 Ultra`; `nemotron-3.5-content-safety-20260604`; `nemotron-nano-12b-v2-vl`; `nemotron-nano-9b-v2` |
| OpenAI | `gpt-oss-20b` |
| Poolside | `Laguna M.1`; `Laguna XS 2.1` |
| Qwen | `Qwen3 Coder 480B A35B`; `Qwen3 Next 80B A3B Instruct` |
| Tencent | `Hy3` |
| Venice | `Uncensored` |

The local Hermes proxy was also exercised with `gpt-5.6-luna`. Its text-only
smoke passed, but its OpenAI-compatible chat endpoint returned `finish_reason:
stop` with no `tool_calls` even when `tool_choice: required` was sent. The
Hermes tool-dependent vertical and corpus runs therefore fail closed and are
not used as OpenRouter results; the OpenRouter route is the intentional
tool-capable model qualification lane for this experiment.

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
