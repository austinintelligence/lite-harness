# Providers and credentials

Agent Runtime speaks one normalized model protocol. Model Registry filters
routes by required capabilities before cost scoring. A frozen Route Plan names
the selected model, fallbacks, registry generation, and credential profile.

Direct alpha adapters:

- OpenAI and explicitly allowlisted OpenAI-compatible HTTP endpoints
- Anthropic Messages HTTP endpoint
- Deterministic fake provider for tests and offline demos

Manager resolves `LITE_HARNESS_CREDENTIAL_PROFILE` through the credential
broker. The current local composition accepts a provider key from Manager's
environment; it never serializes the key into run state or Docker. Production
deployments should supply a keychain-backed broker with refresh single-flight.

Fallback occurs only for typed retryable failures and only before a tool call
becomes externally visible. Model IDs, prices, capabilities, and context limits
are operator/discovery data, not hard-coded aliases disguised as compatibility.
