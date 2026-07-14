# Testing and model-backed evaluation

Credential-free unit, contract, and failure tests continue to use deterministic
fakes. They do not choose or contact a model. Process-adapter tests use local
JSONL fixtures and are also intentionally model-free.

All model-backed harness tests and evaluations on the maintainer workstation
run through the gitignored `.env.hermes.local` policy using:

- `LITE_HARNESS_PROVIDER=openai-compatible`
- `LITE_HARNESS_PROVIDER_BASE_URL=http://127.0.0.1:8645/v1`
- `LITE_HARNESS_MODEL=gpt-5.6-luna`
- a non-empty local placeholder in `LITE_HARNESS_PROVIDER_API_KEY`

Hermes owns upstream OAuth. Lite-Harness must not discover, export, modify, or
persist the upstream OpenAI credential. Run the live conformance smoke with
`pnpm test:hermes`. Wrap any future model-backed Node test or evaluation with
`node scripts/with-hermes-model.mjs node <script> [...args]` so the local policy
overrides ambient direct-provider variables for that invocation only.

`pnpm evaluate:pxpipe` is deliberately excluded: it renders local text and
measures PNG size/latency without calling a model. Credentialed pxpipe quality
evaluation, when added, must use the Hermes wrapper.
