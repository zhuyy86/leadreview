# Yiyu Zhu

Full-Stack Software Engineer

[zhuyy8612@gmail.com](mailto:zhuyy8612@gmail.com) · [GitHub](https://github.com/zhuyy86/leadreview/blob/main/PROFILE.md) · Remote contracts · 20 hours/week · China UTC+8

Builds Node.js and Python applications with persistent state, failure recovery, and reproducible regression tests. Works on AI application integration at China Telecom.

## RunLedger | Durable Webhook Delivery

Independent project · Node.js 24 · SQLite · Browser console · Nov 2026

[Source and test steps](https://github.com/zhuyy86/leadreview/tree/main/runledger)

Delivers AI job completion notifications and lets an operator trace attempts, recover from receiver outages, and replay dead-letter deliveries from a browser.

- Writes the event and delivery in one SQLite transaction. A repeated idempotency key returns the existing delivery for the same canonical payload and HTTP 409 for a changed payload.
- Claims jobs with expiring leases and fences stale worker writes with a lease token. Retries network errors, 429s, and 5xx responses with backoff. Manual replay retains prior attempts and the original delivery ID.
- Signs the stable delivery ID, timestamp, and raw message with HMAC. A persistent receiver inbox records each ID once under at-least-once delivery.
- Ran a two-process claim race and killed the winning process. A new lease reclaimed the same delivery as attempt two. A local HTTP fault test reached dead letter after 503s and returned 200 on replay with its history intact.
- Sent 200 requests in local batches of 20 concurrent submissions with two workers. Deduplicated 100 repeat submissions and verified 100 unique deliveries and 100 receiver effects.

## Selected Projects

**[OrderCheck | Order Data Quality Workbench](https://github.com/zhuyy86/ordercheck)**  Validates amounts with Decimal and quarantines conflicting groups by business key. A seven-sheet Excel report records source rows, rules, and input hashes. A 51-test suite covers validation, export, and the shared Streamlit and CLI logic.

**[API Contract Lab | HTTP and SSE Regression](https://github.com/zhuyy86/leadreview/blob/main/tools/API_CONTRACT_LAB.md)**  Exercises malformed JSON, missing SSE termination, and timeouts against a local HTTP server. Eighteen self-tests cover contract and retry behavior, with HTML diagnostics and JSON output.

**[LeadReview | AI Extraction and Human Review](https://github.com/zhuyy86/leadreview)**  Scores model-extracted information with deterministic rules and separates proposed actions from approved actions. A JavaScript source module generates the importable n8n workflow, backed by 17 assertions.

## Experience

**China Telecom | AI Application Engineering and Systems Integration** · Jun 2026–Present

- Reproduce integration failures across input collection, configuration, recognition output, and event delivery. Adjust test conditions and retest to isolate the cause.
- Document expected and actual behavior, reproduction steps, and retest results. Maintain configuration checks for integration and regression testing.

## Education and Languages

City University of Hong Kong · MSc, Electronic Information Engineering · Sep 2025–Jun 2026

Sun Yat-sen University · BEng, Aerospace Engineering · Sep 2021–Jun 2025

Native Mandarin · English CET-6 505 · English-medium postgraduate study
