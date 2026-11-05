# Engineering handoff

Read this file from the latest `main` before continuing. Commit and push only verified changes; check the remote head first and preserve concurrent work. Project artifacts and bilingual resumes live in this repository.

## 2026-11-05 continuation

Base: `e9f7d97` (RunLedger delivery lab and bilingual resumes). Earlier chat notes mentioned full-ledger filtering, but that implementation was absent from this remote base. This pass implements and verifies it from the committed source.

Completed in the commit containing this entry:

- Replace the 100-row client-side search with whole-database status/search queries and keyset pages. Cursor order is `(created_at DESC, id DESC)` and the token is bound to status, normalized query and limit. Counts and page share a read transaction.
- Add browser Next, Previous and Newest controls, bounded/debounced search and request ordering protection.
- Fix a retry bug: `Retry-After: 120` previously passed through a 10-second cap. Server minimums now remain intact up to 24 hours; longer waits become explicit dead letters for operator review. Add equal jitter to exponential backoff and parse all three HTTP-date forms in UTC.
- Add a Linux/Windows Node.js 24 CI matrix for workflow generation, API contracts, RunLedger tests and the concurrent workload.
- Local verification: existing 17 LeadReview assertions and graph checks, 18 API Contract Lab self-tests, and 16 RunLedger scenarios pass. The 200-request workload delivered 100 unique events and deduplicated 100 repeats on Linux/Node.js 24.22.1, rechecked after code changes (386 ms observed locally; no throughput claim). CI status is separate and must be checked after push.
- Add a reproducible Playwright browser regression. Local launch is blocked by the execution environment's Unix-socket restriction; browser download also returned a truncated archive. The [first CI run](https://github.com/zhuyy86/leadreview/actions/runs/42042471068) passed the Linux suites and the browser scenario. Windows failed the generated-workflow equality check because CRLF source strings became escaped CRLF inside JSON.

Follow-up fixes after commit `8f8e914`:

- Move the enum sets into the serialized functions: generated n8n nodes previously referenced missing module globals (`SOURCES`, `URGENCY`, `INTENT`, `PROPERTY`). Add four tests that execute the actual embedded code without those globals, including invalid input and approval routing.
- Normalize serialized function line endings and set text attributes while preserving the upstream foundation JSON's bytes. Recheck Windows CI after this commit.

## Next priorities

1. Delivery latency measurement is implemented below. Next add durable backup/restore behavior with recovery checks on a copied SQLite database.
2. Define history retention and the effect of deletion on lifetime counts and percentile populations before adding cleanup.
3. Review snapshot/CSV/report output boundaries in the Python tools and make partial-output failures visible and recoverable.
4. Keep bilingual Markdown, Word and PDF exports synchronized only with verified results. The full-ledger browser scenario and current operational metrics are implemented and covered by CI.

## Engineering target and limits

Official requirements rechecked for this pass: [AWS Senior Software Engineer, Job 10569931](https://www.amazon.jobs/en/jobs/10569931/senior-software-engineer-security-services-and-observability-amazon-web-services) emphasizes reliable, observable AI integrations; [Databricks Data + AI Observability, P-1385](https://www.databricks.com/company/careers/engineering---pipeline/senior-software-engineer---data--ai-observability-7897431002) emphasizes correctness, operational excellence and end-to-end product iteration. These inform engineering priorities. They do not establish senior job experience or production scale for this portfolio.

RunLedger remains a loopback, single-machine SQLite demonstration with a built-in receiver. The inbox demonstrates deduplicated receipt; an external receiver must transact its own business effect with its inbox. No hosted deployment, multi-tenant access control or external paid customer has been validated. Filtered pagination is a live view, not a cross-request snapshot. Search and exact matching counts can scan the ledger; no large-data performance claim is made.

No quota state or exact reset time is exposed here. Leave a pushed checkpoint rather than claiming a five-hour limit was consumed. An existing five-hour continuation automation is enabled; do not create duplicate tasks or change Camp 2027 tasks.

## 2026-11-06 operational and data-quality continuation

Integrated the newer `c0e5241` LeadReview and `495d65a` PriceWatch heads before selecting changes; preserved their pagination, retry-window and transaction fixes.

- Add transactionally consistent queue and attempt measurements, an uncached JSON metrics endpoint and visible queue-health counters. Keep historical failed attempts separate from current delivery status.
- Add live HTTP transport regressions for rate limits, terminal errors, redirects, timeouts and the receiver minimum retry window. RunLedger: 24 scenarios passed locally on Linux, Node.js 24.22.1.
- OrderCheck: 70 tests passed after KPI numeric/CSV boundary improvements. PriceWatch: 53 tests passed after complete alert-policy preflight and clean CLI error handling.
- Browser launch remains blocked locally by the host restriction on Chromium Unix sockets. The browser regression is retained for CI; a local launch failure is not a passing browser result.
- Bilingual resume Markdown, Word and PDF exports are synchronized with verified project behavior. Each language renders to one page; all six PDF hyperlink destinations were checked and fonts are embedded. `scripts/build_resumes.py` provides a repeatable Markdown-to-Word build.
- Published code: [RunLedger metrics and transport](https://github.com/zhuyy86/leadreview/commit/10965e1451b9a5928d3bd40e26c878692e7a6419), [OrderCheck KPI boundaries](https://github.com/zhuyy86/ordercheck/commit/442ad9673d58eec9dac35b9d9df486e9e1e4e625), [PriceWatch alert preflight](https://github.com/zhuyy86/pricewatch/commit/707b1623078b35096001b31f2f87fb7f45a1ad05).
- [PriceWatch CI](https://github.com/zhuyy86/pricewatch/actions/runs/42088624460) passed. The [final resume commit CI](https://github.com/zhuyy86/leadreview/actions/runs/42089892265) passed, including Linux, Windows and the browser scenario. Local Chromium remains restricted; the successful browser result is from CI.
- OrderCheck cloud tests exposed Arrow 26 / NumPy 1.26 incompatibility. [Pin fix d187026](https://github.com/zhuyy86/ordercheck/commit/d1870268950757420483b28318ca3063974dce0d) retains Arrow 25.0.1 from the original lockfile. A clean virtual environment installed the pinned dependencies, passed all 70 tests and passed pip check. The [final CI](https://github.com/zhuyy86/ordercheck/actions/runs/42090175010) passed all 70 tests.

Next: confirm final CI, then measure queue-delivery latency and define durable retention/backup behavior before expanding infrastructure. Keep workload numbers scoped to local validation.

Final published resume/profile checkpoint: [`ed5d6df`](https://github.com/zhuyy86/leadreview/commit/ed5d6dfb28b857320e1add5ddd53da690476712b). All three repositories have successful CI for the delivered code; LeadReview also passed its browser interaction scenario on the final resume checkpoint.

## 2026-11-06 latency continuation

Base: `ed992a7`. Unrelated uncommitted edits in the original checkout were left untouched; this implementation used an isolated worktree.

- Add exact nearest-rank p50/p95/p99, min/mean/max, sample counts and negative-clock exclusions for completed attempts, event-to-delivery age and successful generation duration. The three populations have explicit replay and queue-wait semantics. SQLite computes them within one read transaction.
- Add an on-demand console inspector and refresh control so exact history scans do not run with every overview poll. Extend the browser scenario to exercise this panel.
- Add deterministic regression cases for dead-letter replay, backoff intervals, unfinished attempts, empty populations and backward clock movement. RunLedger: 27 passing scenarios locally. A fixed 1–100 ms population also verifies p50=50, p95=95, p99=99 and max=100, guarding against treating p99 as the maximum.
- Extend the 200-request workload to verify latency sample counts and percentile ordering; retain a timestamped local report in `runledger/docs/verification-workload.json`. Runtime measurements are local observations, not production performance claims.
- Profile, English/Chinese Markdown and existing Word/PDF exports are synchronized. Both languages rendered cleanly to one page, with six verified hyperlink targets each.

Next priorities: backup/restore validation, retained-history policy, then Python partial-output recovery. Do not repeat the implemented latency work or change the sample populations without updating their definitions and tests.

Published latency implementation: [`f008936`](https://github.com/zhuyy86/leadreview/commit/f008936f22174a70e94289aefda30e434c85dd50). Its [Linux, Windows and browser CI](https://github.com/zhuyy86/leadreview/actions/runs/42132970951) passed. The following precision-regression/export checkpoint adds the 100-sample percentile case; inspect its own CI after push.
