# API Contract Lab

A standalone, dependency-free Node.js integration regression tool, developed with Codex assistance in November 2026. It complements LeadReview with repeatable interface acceptance checks and failure diagnostics.

## What it demonstrates

- Configurable HTTP status, nested JSON type/value and latency contracts.
- SSE data parsing, CRLF/multiline support and missing terminal-event detection.
- Bounded concurrency, request timeout and a 1 MiB response-body limit.
- Explicit retry policy for 429/502/503/504. POST replay requires opt-in to avoid silently duplicating paid inference requests.
- Credentials supplied through environment-variable header mappings. JSON and HTML reports omit URLs, request/response bodies and headers.
- Local HTTP fault fixtures verify successful responses, broken JSON, authentication errors, rate limits, incomplete streams and timeouts.
- CLI returns failure for a failing real suite; intentionally failing demo fixtures illustrate diagnostics.

## Run

Node.js 20+; no npm install required. From this repository:

```sh
node tools/api-contract-lab.mjs --selftest
node tools/api-contract-lab.mjs --demo
node tools/api-contract-lab.mjs --run suite.json report
```

The last two commands create `contract-report.html/json` or `report.html/json`.

Example suite:

```json
{
  "concurrency": 2,
  "cases": [{
    "name": "Chat response shape",
    "url": "https://your-authorized-service.example/v1/chat/completions",
    "method": "POST",
    "headerEnv": {"Authorization": "CONTRACT_LAB_AUTH"},
    "body": {"model": "your-test-model", "messages": [{"role": "user", "content": "Say hello"}]},
    "timeoutMs": 10000,
    "checks": [{"path": "choices.0.message.content", "type": "string"}]
  }]
}
```

Set `CONTRACT_LAB_AUTH` to the full authorization header value in your own environment. Never put real secrets in the suite file. Case names are included in reports and should not contain sensitive data.

## Verification and implementation details

18 local self-tests passed. The seven-case mock demo has four passing contracts and three deliberately failing fixtures. This checks complete SSE responses rather than incremental time-to-first-token behavior. It does not validate semantic model quality or full JSON Schema. Retry-After HTTP dates are not supported; waits use bounded numeric seconds. 

## Delivery example

For a real project, agree the authorized test endpoints, models, error contract, response fields, latency limits and acceptance criteria first. Adapt the suite, reproduce defects, deliver a patch with regression evidence, then hand over the report and execution instructions.
