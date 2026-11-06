# Yiyu Zhu

Full-Stack Software Engineer

[zhuyy8612@gmail.com](mailto:zhuyy8612@gmail.com) · [GitHub portfolio](https://github.com/zhuyy86/leadreview/blob/main/PROFILE.md) · Remote contracts · 20 hours/week · China UTC+8

Builds Node.js and Python applications with persistent state, failure recovery and reproducible tests. Supports AI application integration at China Telecom.

**Stack:** JavaScript / Node.js 24 · Python · SQL / SQLite · HTTP APIs · pandas / openpyxl · Streamlit · pytest · GitHub Actions

## RunLedger Durable Webhook Delivery

Independent project · Node.js 24 · SQLite · Browser console · Nov 2026 · [Source and verification](https://github.com/zhuyy86/leadreview/tree/main/runledger)

Delivers AI job completion events and exposes retries, receiver outages and dead-letter recovery in an operator console.

- Commits events and queue records together. Canonical payloads deduplicate by idempotency key; conflicts return HTTP 409. Expiring leases fence stale worker completions.
- Signs HTTP bodies with HMAC. A persistent inbox deduplicates redelivery after a lost acknowledgment; replay preserves delivery IDs and earlier attempt generations.
- Adds persistent dispatch pause/resume and atomic batch replay with expected-generation checks, idempotent operation receipts and an audit view. Verifies competing operator processes and lost-response recovery.
- Exposes full-ledger search, cursor pages, queue health and replay-aware p50/p95/p99 latency. WAL snapshots restore state; read-only archives preserve completed events, attempts, inbox and replay receipts in verified SQLite files.
- Sixty-three Node.js scenarios cover recovery, archives and HTTP contracts. A 200-request local workload in batches of 20 with two workers deduplicated 100 repeats and delivered 100 unique events. Linux/Windows suites and browser checks pass in CI.

## Selected Projects

**[OrderCheck Order Data Quality Workbench](https://github.com/zhuyy86/ordercheck)** Validates money with Decimal, isolates conflicting order groups and exports a seven-sheet audit workbook. Publishes ZIP reports exclusively and replaces KPI JSON after staging and sync. Seventy-eight tests cover rules, provenance, UI/CLI behavior, invalid KPI input and export failures.

**[PriceWatch Historical Monitoring](https://github.com/zhuyy86/pricewatch)** Commits SQLite snapshots and recoverable export intents together. Incremental CSV history, HTML and alert JSON publish from saved payloads with checksums and durable receipts. Persistent backlog age and failure state support health probes; 76 tests cover recovery and concurrent exporters.

**[LeadReview and API Contract Lab](https://github.com/zhuyy86/leadreview)** Separates AI extraction, deterministic scoring and human review. Generated n8n code is tested without module globals. HTTP/JSON/SSE regression tooling passes 18 self-tests; lead rules have 17 explicit assertions.

## Experience

**China Telecom Innovation Product Operations Center** · Jun 2026-Present

- Support AI application integration: reproduce recognition, configuration and event-delivery failures; adjust conditions and retest to isolate the cause.
- Record expected and actual behavior, reproduction steps and retest results; maintain configuration checks for project support.

## Education and Languages

City University of Hong Kong · MSc, Electronic Information Engineering · Sep 2025-Jun 2026

Sun Yat-sen University · BEng, Aerospace Engineering · Sep 2021-Jun 2025

Native Mandarin · English CET-6 505 · English-medium postgraduate study
