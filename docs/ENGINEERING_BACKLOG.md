# Engineering handoff

Read this file from the latest `main` before continuing. Commit and push only verified changes; check the remote head first and preserve concurrent work. Project artifacts and bilingual resumes live in this repository.

## 2026-11-06 continuation

Base: `e9f7d97` (RunLedger delivery lab and bilingual resumes). Earlier chat notes mentioned full-ledger filtering, but that implementation was absent from this remote base. This pass implements and verifies it from the committed source.

Completed in the commit containing this entry:

- Replace the 100-row client-side search with whole-database status/search queries and keyset pages. Cursor order is `(created_at DESC, id DESC)` and the token is bound to status, normalized query and limit. Counts and page share a read transaction.
- Add browser Next, Previous and Newest controls, bounded/debounced search and request ordering protection.
- Fix a retry bug: `Retry-After: 120` previously passed through a 10-second cap. Server minimums now remain intact up to 24 hours; longer waits become explicit dead letters for operator review. Add equal jitter to exponential backoff and parse all three HTTP-date forms in UTC.
- Add a Linux/Windows Node.js 24 CI matrix for workflow generation, API contracts, RunLedger tests and the concurrent workload.
- Local verification: existing 17 LeadReview assertions and graph checks, 18 API Contract Lab self-tests, and 16 RunLedger scenarios pass. The 200-request workload delivered 100 unique events and deduplicated 100 repeats on Linux/Node.js 24.22.1, rechecked after code changes (386 ms observed locally; no throughput claim). CI status is separate and must be checked after push.
- Add a reproducible Playwright browser regression. Local launch is blocked by the execution environment's Unix-socket restriction; browser download also returned a truncated archive. A dedicated GitHub Actions job must provide the browser result. Do not mark this scenario passed without a recorded run.

## Next priorities

1. Run browser interaction checks with more than 100 records; verify search, pagination, dead-letter replay, narrow screens and stale-response behavior.
2. Sync verified changes into `PROFILE.md`, both resume Markdown files and the existing PDF/Word exports. Keep local workload scope explicit. Render every final resume page and inspect links.
3. Add actionable operational measurements (oldest due task, retry/lease-expiry counts and delivery latency) before adding new infrastructure.
4. Inspect OrderCheck and PriceWatch current code, CI and transaction boundaries before choosing their next substantive improvement.

## Engineering target and limits

Official requirements rechecked for this pass: [AWS Senior Software Engineer, Job 10569931](https://www.amazon.jobs/en/jobs/10569931/senior-software-engineer-security-services-and-observability-amazon-web-services) emphasizes reliable, observable AI integrations; [Databricks Data + AI Observability, P-1385](https://www.databricks.com/company/careers/engineering---pipeline/senior-software-engineer---data--ai-observability-7897431002) emphasizes correctness, operational excellence and end-to-end product iteration. These inform engineering priorities. They do not establish senior job experience or production scale for this portfolio.

RunLedger remains a loopback, single-machine SQLite demonstration with a built-in receiver. The inbox demonstrates deduplicated receipt; an external receiver must transact its own business effect with its inbox. No hosted deployment, multi-tenant access control or external paid customer has been validated. Filtered pagination is a live view, not a cross-request snapshot. Search and exact matching counts can scan the ledger; no large-data performance claim is made.

No quota state or exact reset time is exposed here. Leave a pushed checkpoint rather than claiming a five-hour limit was consumed. An existing five-hour continuation automation is enabled; do not create duplicate tasks or change Camp 2027 tasks.
