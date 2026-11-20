---
'@gullabs/xai': minor
---

The xAI client no longer lets the ambient `OPENAI_*` environment reach a call. The `openai` SDK client it
builds now pins `organization: null`, `project: null`, `adminAPIKey: null`, `webhookSecret: null` and
`logLevel: 'off'` (they used to default from `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, `OPENAI_ADMIN_KEY`,
`OPENAI_WEBHOOK_SECRET` and `OPENAI_LOG`), and drops the default headers the SDK parses from
`OPENAI_CUSTOM_HEADERS`, so an `OpenAI-Organization`, `OpenAI-Project` or custom header from the
environment is no longer sent to `https://api.x.ai/v1`.

What a host must change: nothing, unless it relied on those variables to add headers to xAI calls (they
never belonged there). Known gap: a malformed `OPENAI_CUSTOM_HEADERS` still makes the SDK constructor throw,
so `buildXaiClient` fails while it is set; moving the xAI client to an isolated transport is a BACKLOG item.
