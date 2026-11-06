# LeadReview

> **Featured project · [RunLedger](runledger)** — Follow an AI completion event through durable queuing, signed delivery, 503 retries and dead-letter replay. Includes full-ledger search, preserved-history archives, 63 verification scenarios and a reproducible 200-request workload.
### Structured lead intake, deterministic decisions & API regression

A JavaScript business-workflow project that separates input normalization, scoring and review routing from workflow orchestration. The repository also includes **API Contract Lab**, a standalone HTTP/JSON/SSE regression tool.

[Developer profile & résumé](PROFILE.md) · [Workflow walkthrough](PROJECT_EXPLAINED_FOR_ME.md) · [API Contract Lab](tools/API_CONTRACT_LAB.md) · [Test report](TEST_REPORT.md) · [Source & license](UPSTREAM.md)

## Lead intake & decision workflow

**Normalize → AI extraction → Deterministic rules → Explain → Route for review**

- Define the model-extraction stage separately from deterministic scoring and business routing.
- Normalize website, form, email-shaped and API payloads into a consistent contract.
- Validate sources, field shapes, message lengths and scoring inputs.
- Apply deterministic business rules with explicit reasons for each score.
- Separate `proposed_action` from `next_action` so the routing contract can express a human-review step.
- Keep reusable logic in source modules, then generate importable n8n workflow JSON reproducibly.
- Verify workflow connections and embedded-source consistency alongside logic assertions.

### Architecture

```text
Website / Form / Email-shaped / API payload
                    |
          Normalization & validation
                    |
          Deterministic scoring core
                    |
      Reasons / Proposed action / Review route
                    |
        Generated n8n workflow artifact
```

### Build & verify

```sh
node scripts/build_v2_workflow.mjs
node tests/test_lead_logic.mjs
```

The recorded delivery passed **17 explicit logic assertions**, workflow graph checks and **four generated-node execution tests**. The latter run the embedded JavaScript without module globals, covering all four intake sources, invalid input and approval routing. Function serialization normalizes LF line endings so Linux and Windows produce the same JSON. Import the generated JSON into n8n and configure the model credentials when connecting the workflow to an environment.

## API Contract Lab

A dependency-free Node.js tool for checking integration behavior before and after API changes.

- Configurable HTTP status, nested JSON type/value and latency contracts.
- SSE parsing with CRLF, multiline data and terminal-event checks.
- Bounded concurrency, timeouts and response-size limits.
- Transient-error retries with explicit opt-in for POST replay.
- Environment-supplied authorization headers and sanitized HTML/JSON reports.
- Local HTTP fault fixtures covering malformed JSON, authentication failures, rate limits, incomplete streams and timeouts.

```sh
node tools/api-contract-lab.mjs --selftest
node tools/api-contract-lab.mjs --demo
```

**18 local self-tests passed.** The seven-case mock demonstration includes four passing contracts and three deliberately failing cases to show diagnostic output. See the [tool documentation](tools/API_CONTRACT_LAB.md) for configuration and behavior.

## Stack

JavaScript · Node.js · HTTP · JSON · SSE · n8n workflow JSON · deterministic validation

## Development & attribution

Independent portfolio work developed with Codex assistance. LeadReview extends an MIT-licensed lead-qualification workflow; original notices and the source record remain in [LICENSE](LICENSE) and [UPSTREAM.md](UPSTREAM.md). API Contract Lab is an additional integration-testing module.
