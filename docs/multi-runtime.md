# Multi-Runtime Integration

This is the recommended first-pass pattern for hosts that run `any-llm` in both request/response
code and worker/orchestrator code. Keep the shared helpers in your application until real
duplication proves a library helper is warranted. That is why the repo does not currently export
`createRuntimeClientFactory()` or `buildCallMetadata()`.

## Design rules

- construct clients per runtime, not via ambient globals;
- pass auth on every call;
- let web routes decide whether library retry middleware is appropriate;
- let Temporal or another orchestrator own external retries;
- give every external retry of one operation the same `externalId` (the library never deduplicates
  provider calls, and every attempt is a billed ledger row);
- persist host-specific typed context in a sidecar keyed by `attemptId` when needed.

## Application-local metadata helper

`metadata` is caller-owned, low-cardinality JSON (see `docs/ledger.md`) — the library does not
constrain its shape. That freedom is easy to lose track of across a codebase: without a shared
convention, different call sites drift toward ad hoc field names (`tenant`, `tenantId`, `tid`, ...)
for the same concept, which makes cross-call-site queries and dashboards harder to write. Define one
`AnyLlmMetadata` shape per host and route every call site through it, rather than inlining a fresh
metadata object literal at each call site:

```ts
type AnyLlmMetadata = {
  tenantId: string
  orgId?: string
  workspaceId?: string
  route?: string
  workflowId?: string
  reportId?: string
  jobType?: string
  operationId?: string
}

function buildAnyLlmMetadata(input: AnyLlmMetadata) {
  return input
}
```

That one-helper-per-host convention is enough for most hosts — it is what keeps `metadata` queryable
later without adding library surface. If this shape stabilizes across multiple repos, it can graduate
into a library helper later.

Set `operationId` once for a workflow operation and reuse it on every correlated call in that flow
(including the grounded-then-structured pattern from `docs/grounded-structured.md`).

## Shared wiring

```ts
import { createClient, composeProviders, retryMiddleware } from '@gullabs/any-llm'
import { googleProvider } from '@gullabs/google'
import { drizzleUsageSink } from '@gullabs/drizzle'

function baseClientConfig(db: DbLike) {
  return {
    ...composeProviders([googleProvider()]),
    sink: drizzleUsageSink({ db }),
  }
}
```

## Web route client

HTTP handlers often want short in-process retries for retryable provider failures:

```ts
function makeWebClient(db: DbLike) {
  return createClient({
    ...baseClientConfig(db),
    middleware: [
      retryMiddleware({
        maxAttempts: 2,
      }),
    ],
  })
}

async function handleRoute(req: Request, db: DbLike) {
  const client = makeWebClient(db)
  const auth = { apiKey: await loadRouteApiKey(req) }

  return client.generate(
    {
      provider: 'google',
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Summarize this' }] }],
      callSiteId: 'http-summary',
      externalId: req.headers.get('x-request-id') ?? undefined,
      metadata: buildAnyLlmMetadata({
        tenantId: 'tenant_123',
        route: '/api/reports/summary',
        operationId: `op-${Date.now()}`,
      }),
    },
    { auth, signal: req.signal },
  )
}
```

## Temporal worker client

Externally retried activities should usually skip library retry middleware. Let the orchestrator
own retry timing and give every retry of one activity the same `externalId`. The library never
deduplicates provider calls: each activity retry is a billed provider call and writes its own ledger
row with its own freshly minted `attemptId`. Query by `externalId` to see every attempt of one
operation and what it cost (`select * from llm_calls where external_id = $1 order by created_at`).

### Testing note: replay writes new rows

A replayed or retried activity that calls the library again writes new rows, so
`sink.records.length` after a replay counts every attempt. `RecordingSink`
(`packages/testing/src/recording-sink.ts`) pushes every record it receives unless it is built with
`dedupeOn: 'attemptId'`, which drops a repeat of an `attemptId` as `onConflictDoNothing` does;
`drizzleUsageSink` (`packages/drizzle/src/sink.ts`) dedupes only a sink re-delivering the same record
(same `attemptId`, via the `attempt_id` primary key). Use `new RecordingSink({ dedupeOn: 'attemptId' })`
in a host test to see what the ledger would hold, and assert on `externalId` and row counts accordingly.

```ts
function makeWorkerClient(db: DbLike) {
  return createClient(baseClientConfig(db))
}

export async function runReportActivity(
  input: {
    workflowId: string
    reportId: string
    prompt: string
    attemptKey: string
  },
  db: DbLike,
) {
  const client = makeWorkerClient(db)
  const auth = { apiKey: await loadWorkerApiKey(input.reportId) }

  return client.generate(
    {
      provider: 'google',
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: input.prompt }] }],
      callSiteId: 'worker-report',
      externalId: input.reportId,
      metadata: buildAnyLlmMetadata({
        tenantId: 'tenant_123',
        workflowId: input.workflowId,
        reportId: input.reportId,
        jobType: 'brand-report',
        operationId: input.attemptKey,
      }),
    },
    { auth },
  )
}
```

## Migrating off ambient/singleton auth

Some hosts arrive at `any-llm` with an existing pattern: a client or credential is constructed once
at process boot — often in a startup/instrumentation file — and stashed in a module-level variable
or on `globalThis`. Downstream code then reads that singleton implicitly instead of receiving a
credential as an argument. This is common when a host started with a single API key for a single
tenant and never needed per-call scoping.

```ts
// startup.ts — runs once at process boot
let ambientClient: SomeSdkClient | undefined

export function registerAmbientClient() {
  ambientClient = createSomeSdkClient({ apiKey: process.env.PROVIDER_API_KEY })
}

// deep in some unrelated module
export async function summarize(prompt: string) {
  if (!ambientClient) throw new Error('client not registered')
  return ambientClient.generate(prompt)
}
```

This pattern is incompatible with `any-llm`'s per-call auth contract. `auth` is passed explicitly as
an argument to every `generate()`/`runStructured()` call and is never read from a module-level
variable, `globalThis`, or process environment. That is a deliberate library invariant, not an
oversight: passing `auth` per call is precisely what makes per-tenant and per-request credential
resolution possible. A host holding onto a boot-time singleton cannot pass a real per-request or
per-tenant credential into `any-llm`, because the singleton was only ever populated with the one
value available at process start.

Migrating off this pattern:

- Delete the boot-time singleton registration entirely; nothing in `any-llm` needs it.
- In web routes, resolve the credential per request — from the session, a tenant config lookup, or
  request context — and pass it as the `auth` argument on each call, as shown in
  `makeWebClient`/`handleRoute` above.
- In worker or queue runtimes (Temporal activities and similar), pass the credential as an explicit
  argument into the activity or job, sourced from the workflow's or job's own input, rather than
  reading it from worker-level environment or config inside the activity body. See
  `makeWorkerClient`/`runReportActivity` above.
- This migration can happen incrementally, call site by call site. Each `generate()`/`runStructured()`
  call already takes `auth` independently, so there is no big-bang cutover: hosts can move one route
  or activity at a time while the rest of the codebase still reads from the old singleton.

## Retry ownership

Use library retry middleware when:

- the caller is synchronous;
- a short retry loop is cheaper than handing control back to a queue;
- multiple durable attempt rows within one logical call are desirable.

Do not use library retry middleware when:

- Temporal, a job queue, or another orchestrator already retries the unit of work;
- you need durable sleeps or calendar-time rescheduling;
- you want every retry of one operation to share one `externalId` and be counted by the host, not by
  in-process attempt numbers.

## Sidecar persistence

If your host needs typed context rows, write them after the call using `result.attemptId` or
`LlmError.attemptId`:

```ts
await db.insert(llmCallContext).values({
  attemptId: result.attemptId,
  workflowId: input.workflowId,
  reportId: input.reportId,
  jobType: 'brand-report',
})
```

That keeps `llm_calls` canonical while preserving domain-specific queryability.
