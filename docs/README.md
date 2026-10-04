# Documentation

Every document under `docs/`, by topic. The root [README](../README.md) has the overview,
[`SPEC.md`](../SPEC.md) is the contract, and [`DECISIONS.md`](../DECISIONS.md) holds the ADRs.

| Document                                                                   | What it covers                                                                                     |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`architecture.md`](./architecture.md)                                     | Ports and adapters, the call pipeline, and where each concern lives.                               |
| [`ledger.md`](./ledger.md)                                                 | The `llm_calls` and `llm_call_payloads` tables, what each column holds, retention and queries.     |
| [`log-events.md`](./log-events.md)                                         | Every log event the library emits, with its level and fields.                                      |
| [`multi-runtime.md`](./multi-runtime.md)                                   | Running on the web, in workers and under Temporal; which packages are runtime-agnostic.            |
| [`grounded-structured.md`](./grounded-structured.md)                       | Grounding first, structured output second: the two-call pattern and the opt-in single call.        |
| [`structured-output-validation.md`](./structured-output-validation.md)     | Validating `result.output` with your own schema library.                                           |
| [`error-classification-design.md`](./error-classification-design.md)       | How HTTP status, structured bodies and message text become `LlmError` kinds (ADR-028).             |
| [`thinking-token-distribution.md`](./thinking-token-distribution.md)       | Measured Gemini thinking-token spend per model and effort; the evidence behind the budget warning. |
| [`model-config-provider-evidence.md`](./model-config-provider-evidence.md) | The public-doc and live-probe evidence behind each built-in model descriptor.                      |

[`archive/`](./archive) holds plans, proposals and research snapshots that were executed or
superseded. They describe the code as it was when they were written.
