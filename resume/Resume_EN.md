# Yiyu Zhu

Full-Stack Software Engineer

[zhuyy8612@gmail.com](mailto:zhuyy8612@gmail.com) · [GitHub portfolio](https://github.com/zhuyy86/leadreview/blob/main/PROFILE.md) · Remote contracts · 20 hours/week · China UTC+8

Builds Node.js and Python applications with persistent state, failure recovery and reproducible tests. Supports AI application integration at China Telecom.

**Stack:** JavaScript / Node.js 24 · Python · SQL / SQLite · HTTP APIs · pandas / openpyxl · Streamlit · pytest · GitHub Actions

## RunLedger Durable Webhook Delivery

Independent project · Node.js 24 · SQLite · Browser console · Nov 2026 · [Source and verification](https://github.com/zhuyy86/leadreview/tree/main/runledger)

Delivers AI job completion events and exposes retries, receiver outages and dead-letter recovery in an operator console.

- Commits each event and delivery together. Canonical payloads deduplicate under a stable idempotency key; changed payloads return HTTP 409. WAL-aware backups restore queue history and leases to fresh files without overwriting existing data.
- Claims tasks with expiring leases and fences stale worker completions. Retries transient failures with jitter and respects the receiver's Retry-After minimum; replay preserves identity and attempt generations.
- Signs raw messages with HMAC and uses a persistent receiver inbox to deduplicate receipts under at-least-once delivery. Verified redelivery after a lost acknowledgment and restart.
- Adds whole-ledger status/search, cursor pagination and read-transaction metrics for queue health and replay-aware p50/p95/p99 latency. Thirty-five Node.js scenarios verify queue and HTTP behavior.
- Reproduced two-process claim competition and worker termination. Sent 200 local requests in batches of 20 with two workers: 100 repeats deduplicated, 100 unique events delivered and 100 inbox receipts. Linux/Windows and browser checks run in CI.

## Selected Projects

**[OrderCheck Order Data Quality Workbench](https://github.com/zhuyy86/ordercheck)** Validates money with Decimal, isolates conflicting order groups and exports a seven-sheet audit workbook. Publishes complete CLI reports without overwriting existing files. Seventy-four tests cover rules, provenance, UI/CLI behavior, invalid KPI input and export failures.

**[PriceWatch Historical Monitoring](https://github.com/zhuyy86/pricewatch)** Serializes predecessor lookup and snapshot commit in SQLite. Validates complete alert policies before network or output side effects. Fifty-three tests include competing writers, rollback and CLI failures.

**[LeadReview and API Contract Lab](https://github.com/zhuyy86/leadreview)** Separates AI extraction, deterministic scoring and human review. Generated n8n code is tested without module globals. HTTP/JSON/SSE regression tooling passes 18 self-tests; lead rules have 17 explicit assertions.

## Experience

**China Telecom Innovation Product Operations Center** · Jun 2026-Present

- Support AI application integration: reproduce recognition, configuration and event-delivery failures; adjust conditions and retest to isolate the cause.
- Record expected and actual behavior, reproduction steps and retest results; maintain configuration checks for project support.

## Education and Languages

City University of Hong Kong · MSc, Electronic Information Engineering · Sep 2025-Jun 2026

Sun Yat-sen University · BEng, Aerospace Engineering · Sep 2021-Jun 2025

Native Mandarin · English CET-6 505 · English-medium postgraduate study
