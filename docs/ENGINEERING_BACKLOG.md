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

1. Define an archive/aggregation contract before enabling cleanup. Read-only retention candidate accounting is implemented; idempotency keys, inbox receipts, replay history and latency sample populations must remain explicit.
2. Extend monitoring of export backlog/age and define a payload-retention policy. PriceWatch transactional export recovery, OrderCheck ZIP publication and KPI JSON replacement are implemented.
3. Consider a checksum manifest verification workflow for trusted offline snapshots; current maintenance output fingerprints the produced file but does not authenticate its origin.
4. Keep bilingual exports synchronized with verified behavior. Latency measurement and new-file backup/restore are implemented below.

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

Published latency implementation: [`f008936`](https://github.com/zhuyy86/leadreview/commit/f008936f22174a70e94289aefda30e434c85dd50). Its [Linux, Windows and browser CI](https://github.com/zhuyy86/leadreview/actions/runs/42132970951) passed. The [precision-regression/export checkpoint 138e8be](https://github.com/zhuyy86/leadreview/commit/138e8befb290e84896a5398f7a7c9b07c97fcba2) adds the 100-sample percentile case. Its [Linux, Windows and browser CI](https://github.com/zhuyy86/leadreview/actions/runs/42133459345) all passed. The current suite contains 27 scenarios.

## 2026-11-06 WAL backup and recovery continuation

Base: `3539eff`. Add `runledger/maintenance.mjs` with backup/restore CLI commands and a reusable snapshot function. The source opens read-only; a pinned read transaction captures committed WAL state while an independent writer continues. Validate schema columns, SQLite integrity and foreign keys before and after copying. Produce a standalone DELETE-journal database, file-sync it, then publish with a same-filesystem exclusive hard link. Existing targets and sidecars remain untouched; staging is removed on failure. JSON output records the snapshot checksum, size, page count and row counts.

Eight recovery scenarios passed, bringing RunLedger to 35 local scenarios. They verify WAL-backed replay/history/inbox/idempotency recovery, in-flight lease reclamation and stale-token fencing, concurrent WAL writes excluded from the pinned snapshot, competing publishers, overwrite/sidecar rejection, malformed or foreign-key-invalid sources and a CLI backup/restore round trip. Preserve the existing Linux/Windows/browser CI checks and inspect their post-push result.

Profile and bilingual exports are updated with the validated recovery capability; both languages rendered to one page with six verified hyperlink targets each. Limits: point-in-time local snapshots, no in-place replacement, no encrypted/authenticated backups, no zero-loss guarantee, no history cleanup policy yet. Next implement retention design and Python output recovery rather than repeating backup or latency work.


Published recovery implementation: [`f6b17c0`](https://github.com/zhuyy86/leadreview/commit/f6b17c0b652d8260fa17ea3d1b25ba099557f7c4). Its [Linux, Windows and browser CI](https://github.com/zhuyy86/leadreview/actions/runs/42135095677) all passed.

## 2026-11-06 OrderCheck report publication continuation

Review found that direct exclusive writing prevented overwrites but could leave a partial final ZIP after disk-write failure, blocking a same-name retry. [OrderCheck b648294](https://github.com/zhuyy86/ordercheck/commit/b64829493a5176e868b68b64238651cd8b76f076) now stages in the target directory, flushes and file-syncs the complete bytes, then publishes with an exclusive hard link. Cleanup runs on ordinary write/sync/publication failure. Existing reports and dangling symlinks are preserved, and competing writers cannot mix or overwrite payloads.

All 74 tests passed locally on Linux / Python 3.12, including four new publication regressions and the existing CLI ZIP round trip. [GitHub CI](https://github.com/zhuyy86/ordercheck/actions/runs/42135404906) passed all 74 tests for this commit. Scope: CLI ZIP outputs only; KPI JSON replacement remains a separate recovery task. Unsupported hard-link filesystems fail closed; abrupt process termination may leave a staging file; no whole-directory fsync or universal power-loss guarantee.

Bilingual Markdown, Word and PDF exports now include the verified report-publication behavior and 74-test count. Both final PDFs were visually reviewed at one page each; all six hyperlink destinations in each were verified. Leave the original checkout edits untouched. Resume from retained-history semantics and KPI JSON publication, not completed latency, backup or CLI ZIP work.


## 2026-11-06 retention preview and KPI recovery

Base: `e3e9bfb`. Rechecked remote main for all three repositories before editing; no newer changes were present. Original uncommitted LeadReview documentation was left untouched.

- Add a read-only `retention-plan --source ... --before epoch_milliseconds` maintenance command. A single read transaction inspects the schema/integrity and reports candidate delivered records, attempt counts and logical UTF-8 payload bytes. Eligibility uses successful current-generation completion strictly before the cutoff. Recent replay, unfinished/missing history and all queued/in-flight/dead work are protected. All idempotency identities/digests and inbox receipts must be retained. No deletion or automatic cleanup is enabled.
- Five new scenarios verify protected states, no WAL writes, unchanged metrics/idempotency/inbox behavior, replay cutoff boundaries, empty populations, multibyte payload size and actual CLI validation. RunLedger now passes 40 scenarios locally on Node.js 24.22.1.
- [OrderCheck KPI recovery 63a64ba](https://github.com/zhuyy86/ordercheck/commit/63a64bae66c7d9376f8a8435a0ff790eb49f71bf) stages and syncs a complete JSON file before atomic replacement. Ordinary write/sync/replace failure preserves existing output and cleans staging. Reject input CSV aliases as output. Four added regressions cover faults/retry, alias protection and competing writers. All 78 tests passed locally on Linux / Python 3.12; a real subprocess round trip verified Chinese store names and a Decimal total of 0.30.
- Profile, bilingual Markdown and Word/PDF exports include these verified changes. Each final PDF was rendered and visually checked at one page, with six verified hyperlink targets. Post-push CI results must be recorded below.

Limits: retention is a preview, not archiving or cleanup. Attempt removal would change exact metrics and needs an explicit archive/aggregation design first. Payload bytes are logical size, not freed disk capacity. KPI concurrent replacement is last-successful-writer-wins, without revision conflict detection. Abrupt termination can leave staging files; no universal power-loss durability promise. Next prioritize PriceWatch publication consistency, then a preserved-history archive design.


Published checkpoint: [`ab15a22`](https://github.com/zhuyy86/leadreview/commit/ab15a22175ead721d68edf7426ab1921bb5a999e). [Linux, Windows and browser CI](https://github.com/zhuyy86/leadreview/actions/runs/42165984831) all passed. [OrderCheck KPI CI](https://github.com/zhuyy86/ordercheck/actions/runs/42165697025) passed all 78 tests at `63a64ba`.

Next-step evidence: an offline temporary-directory fault probe against PriceWatch `707b162` injected `sqlite3.OperationalError` from `save_snapshot`. The CLI returned 1 but the CSV already contained a header and one product row. No network calls or repository outputs were used. The CLI currently appends CSV before committing history; merely moving statements cannot make the filesystem and SQLite one transaction. Prioritize a persisted run/export intent with recoverable, idempotent artifact publication and fault tests before claiming consistent multi-output recovery. PriceWatch is unchanged in this checkpoint; its last 53-test result is not a validation of this unresolved boundary.


## 2026-11-06 export coordination and operator controls

[PriceWatch export queue 9e3d372](https://github.com/zhuyy86/pricewatch/commit/9e3d3726eef2f1b0c86f85fcb2511d47095ac13e) fixes the previously reproduced snapshot/CSV boundary through persisted export intents. Snapshots, output bytes/checksums and the original comparison commit together. CSV intents store incremental rows plus one imported baseline; publication reconstructs history in commit order. Recovery detects a file already published before process exit and records its receipt. Status exposes progress and errors. All 72 local tests passed; [Linux and Windows CI](https://github.com/zhuyy86/pricewatch/actions/runs/42180563113) passed. Nineteen additions cover faults, a real process exit, migration, checksums, concurrency, alias protection and real CLI/HTTP collection through alerts.

Add persistent RunLedger dispatch pause/resume with optimistic revisions, API contracts, queue-health visibility and console controls. Nine added tests verify admission while paused, finishing in-flight work, expiry/fencing after resume, replay, two-connection conflicts, restart/backup/legacy migration, HTTP validation and live two-worker draining. All 49 Node.js scenarios pass locally. The 200-request workload still delivers 100 unique events and deduplicates 100 repeats. Extend browser coverage through pause, reload, queued replay, resume and mobile controls. CI is checked after publishing.

Next in this active delivery: audited, idempotent batch dead-letter replay, then synchronize profile and final bilingual exports with the full verified result. Artifact publication is per file with a durable pending state across the batch; same-database exporters cooperate under SQLite locking. CSV rebuilding scans retained history. Dispatch pause affects future claims while active requests finish.


Dispatch checkpoint: [`ec91075`](https://github.com/zhuyy86/leadreview/commit/ec910758ac88df032e54eb691bf49973f624e85c). [Linux, Windows and browser CI](https://github.com/zhuyy86/leadreview/actions/runs/42181098299) passed.

Add all-or-nothing batch replay with expected-generation checks, canonical target identity, idempotent operation keys and durable audit receipts. The console supports selection across pages, tab-session recovery after an acknowledgment loss, retrying the recorded operation and viewing recent replay actions. Eight added Node.js scenarios verify atomic selection conflicts, rollback after a trigger interrupts the second update, two real operator processes competing under one key, completed-delivery retries, restart and backup persistence, limits and HTTP contracts. The full local suite now passes 57 scenarios. The browser regression adds a two-record batch whose first response is deliberately lost, reloads the page and retries the same saved key, then checks one action, one generation transition per target and the mobile audit view. Post-push CI and final bilingual exports follow this checkpoint.


Batch replay checkpoint: [`db55430`](https://github.com/zhuyy86/leadreview/commit/db55430b44b3c4a94e752ee94ef0ed89054fba5c). [Linux, Windows and browser CI](https://github.com/zhuyy86/leadreview/actions/runs/42181955582) passed. Both browser scenarios cover pause/reload/replay/resume and a lost batch acknowledgment followed by tab reload, same-key retry and audit inspection at a mobile viewport. Final profile and resume sources reflect 57 RunLedger scenarios, 78 OrderCheck tests and 72 PriceWatch tests. Both final Word exports were rendered to PDF and visually reviewed. English and Chinese each retain one page and six verified hyperlink targets.


Current continuation priorities: add export backlog age/health reporting, design archive/retention semantics that retain replay/idempotency receipts, and measure larger recovery workloads with explicit local scope. Completed in this delivery: PriceWatch transactional export recovery, persistent dispatch controls, audited atomic batch replay and their HTTP/browser recovery paths. Existing licenses and source attribution remain present.


[PriceWatch workload 9c8336b](https://github.com/zhuyy86/pricewatch/commit/9c8336b4f8ed752260b4df724e1677cedf0cd916) adds a reproducible 500-snapshot / 20-product local exercise: 1,500 export intents, 10,000 CSV rows, zero duplicate contributions after an interrupted publication receipt, and 868,216 bytes for both the final CSV and its stored incremental payloads. Two bounded recovery passes drain the backlog. The timestamped report is in `pricewatch/docs/recovery-workload.json`; CI runs a 20-snapshot variant. Windows completed all functional assertions but exposed a verification connection still holding the temporary database at cleanup. [Explicit-close fix c0e0d39](https://github.com/zhuyy86/pricewatch/commit/c0e0d39b9bfef0385f2633a20f2051eaa6912d7e) addresses that resource lifetime; inspect its final CI.

Add pinned screenshot artifact capture for desktop, mobile and recovered batch-audit views to the existing browser CI. Profile and bilingual exports are synchronized; visual and hyperlink checks are complete for both one-page PDFs. Confirm the new CI and inspect the captured console views before recording the final handoff.


## Final verified delivery checkpoint 2026-11-06

- [Latest console fix 50e9b3e](https://github.com/zhuyy86/leadreview/commit/50e9b3e608bde3f081f66e2a91a2ebcf297be61e) passed [Linux, Windows and both browser scenarios](https://github.com/zhuyy86/leadreview/actions/runs/42184539166). The selected-column heading now uses its accessible label at mobile width. Captures focus on the recovered event, its two generations, dispatch control and the saved batch audit. Desktop and two mobile PNGs were downloaded from that run, checksum-verified and visually reviewed; the published dashboard images use these captures.
- [Verified final resumes afefc57](https://github.com/zhuyy86/leadreview/commit/afefc57730534347243602d9fb38a021bbf94d80) synchronize English/Chinese Markdown, Word and PDF with the new operator and export recovery paths. Each language was rendered and checked at one page with six matching links.
- [PriceWatch resource-lifetime fix c0e0d39](https://github.com/zhuyy86/pricewatch/commit/c0e0d39b9bfef0385f2633a20f2051eaa6912d7e) passed [72 tests plus the recovery workload on Linux and Windows](https://github.com/zhuyy86/pricewatch/actions/runs/42182909296). The local 500-run record remains the larger correctness/storage exercise; cloud CI uses 20 runs.
- [Runner-browser selection b71ab90](https://github.com/zhuyy86/leadreview/commit/b71ab90e535f7388c6440d019fb848f664c8cc81) uses installed Chrome when available, retaining Chromium installation as fallback. This followed a dependency-install stall in the initial capture job. Browser availability is checked at runtime; the [official runner manifest](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md) documents the image software.

This delivery adds 17 RunLedger scenarios and 19 PriceWatch cases, plus a second browser recovery scenario and a bounded recovery workload in CI. Current verified totals: RunLedger 57, PriceWatch 72; OrderCheck remains at its earlier 78-test checkpoint. Published work spans transactional export recovery, persistent dispatch, atomic audited batch replay, visual QA and bilingual artifacts. Next priorities are export backlog age/health, preserved-history archival semantics and bounded-memory recovery at larger retained-history sizes. Scope remains local SQLite and cooperating exporters; multi-file progress is represented by durable per-file receipts.


## 2026-11-06 export health and delivered-history archive

- [PriceWatch export health 02a92ef](https://github.com/zhuyy86/pricewatch/commit/02a92ef9b554fde1d54509df3a02483b6aeda21e) persists enqueue, last-attempt and publication times on every export intent. One status transaction reports oldest backlog age, failed items, future timestamps, maximum pending attempts and the latest success. `--require-healthy-exports` gives monitoring scripts a stable exit code while using saved state only. Old databases add nullable observation columns in place. Four new regressions bring the suite to 76; a local 50-run recovery check published 150 intents and 500 CSV rows with zero duplicate contributions.
- [RunLedger archive ebd1bfb](https://github.com/zhuyy86/leadreview/commit/ebd1bfb241547cf399f6980b7e86a8dd049913fb) creates a standalone SQLite archive from a pinned read snapshot. Eligibility uses current-generation successful completion strictly before the cutoff. The archive preserves event identity/idempotency, delivery state, every attempt generation, matching inbox receipts and complete related replay-operation receipts, plus explicit nearest-rank latency population definitions. Integrity/foreign-key validation, fsync, exclusive publication and competing-writer tests cover the artifact boundary.
- Six archive scenarios cover strict cutoffs, recent replay, mixed audit batches, a ledger predating operator receipts, one-winner publication, malformed sources, source-state preservation and CLI validation. RunLedger passes 63 Node.js scenarios locally on Node.js 24.22.1. Source cleanup remains a separate policy; the archive records preservation evidence while the source continues serving deduplication, metrics and audit queries.
- Updated profile and bilingual Markdown/Word/PDF describe only verified local behavior. Each export is rebuilt, rendered, visually reviewed and link-checked before the final checkpoint.
- [PriceWatch CI 42199017767](https://github.com/zhuyy86/pricewatch/actions/runs/42199017767) passed 76 tests and the bounded recovery workload on Linux and Windows. [RunLedger CI 42199523383](https://github.com/zhuyy86/leadreview/actions/runs/42199523383) passed Linux, Windows and both browser scenarios at the archive implementation commit. The final local suite also passed 67 repository-wide Node scenarios and the 200-request workload delivered 100 unique events while deduplicating 100 submissions.

Next priorities: stream large CSV recovery projections with bounded transient memory; add a signed checksum manifest workflow for trusted offline archives/backups; measure archive creation on a larger retained-history fixture with explicit local scope.

Completed follow-through:

- [PriceWatch streaming projection 77c1d19](https://github.com/zhuyy86/pricewatch/commit/77c1d19b8017ea3d9dfa8c00b650f0a902140ef2) removes full-history byte joining from recurring CSV enqueue and recovery. Persisted chunks are checksum-verified incrementally; recovery writes each chunk directly to the staged file while retaining final SHA/size validation, external-edit detection, fsync and atomic replacement. Two guard tests block both `_materialize` and whole-file reads on the CSV path and detect corrupted final-size metadata. All 78 tests and the 500-run/1,500-intent/10,000-row workload passed locally; [Linux and Windows CI 42200689271](https://github.com/zhuyy86/pricewatch/actions/runs/42200689271) passed.
- [RunLedger archive workload 16ab309](https://github.com/zhuyy86/leadreview/commit/16ab3093830069d7630ed3295a64e2ddec8db17e) adds a parameterized preservation exercise and a 100-delivery Linux/Windows CI gate. The recorded 500-delivery local run archived the strict older half: 250 deliveries, 275 attempts, 63 inbox receipts and 25 replay receipts in a 274,432-byte SQLite artifact. It verified row counts, integrity, foreign keys, metric metadata, SHA-256, unchanged source metrics and duplicate ingestion behavior. [CI 42201001714](https://github.com/zhuyy86/leadreview/actions/runs/42201001714) passed Linux, Windows and both browser regressions.

Next priorities: signed checksum-manifest verification for trusted offline files, source cleanup semantics with archive-aware query federation, and larger-history indexing measurements before any scale claim.


## 2026-11-06 authenticated offline artifacts

- [RunLedger signed manifests a29c696](https://github.com/zhuyy86/leadreview/commit/a29c6967f91f7a980fdb80221406cabb597dfaf8) adds `sign-manifest` and `verify-manifest` commands for standalone backups and delivered-history archives. The HMAC-SHA256 document canonically binds basename, artifact kind, exact bytes, SHA-256, creation time and freshly inspected metadata. Backup metadata contains ledger row counts; archive metadata contains its strict cutoff, table counts, identity contract and exact metric populations.
- Signing requires a separate 32–4,096-byte key file, rejects symbolic links and path/inode aliases, observes stable file identity across inspection and hashing, syncs staging and publishes through an exclusive hard link. Verification authenticates the manifest before checking name/size/hash and then repeats SQLite integrity, foreign-key, schema and metadata checks.
- Seven added scenarios cover backup and archive manifests, artifact edits, signed-metadata edits, wrong keys, renamed substitution, weak keys, hard-link aliases, competing publishers, existing-output preservation and strict CLI shapes. RunLedger passes 70 Node.js scenarios locally on Node.js 24.22.1. The symmetric key holder can create manifests, so provenance depends on separate key custody; encryption and public-key attribution remain outside this contract.
- Profile and bilingual source/export artifacts are synchronized after the implementation CI completes. Next priorities are archive-aware cross-file queries, explicit source cleanup checkpoints and retained-history index measurements.
- [Implementation CI 42238109303](https://github.com/zhuyy86/leadreview/actions/runs/42238109303) passed Linux, Windows and both browser scenarios at `a29c696`, including the new manifest regressions. Both bilingual exports remain one-page Letter documents with six verified hyperlinks each after rendering and visual inspection.


## 2026-11-06 verified cross-archive history lookup

- [RunLedger cross-file lookup ef1bad3](https://github.com/zhuyy86/leadreview/commit/ef1bad35d83fbcfab63914b044b0abf753de4a60) adds `locate-history` for exact delivery ID, event ID or idempotency-key queries across the active ledger and 1-20 archive/manifest pairs. Each archive passes HMAC authentication, filename/size/SHA binding, SQLite integrity, foreign-key, schema and metadata checks before its rows join the result.
- Duplicate delivery records merge into one result with all active/archive locations and artifact evidence. Differences in identity, event type, timestamps, status, generation, attempt count or retry budget raise a conflict. Stable file observations cover verification and query, while unique archive/manifest paths and paired CLI arguments bound the request.
- Five added regressions cover exact identity variants, prefix exclusion, active/archive deduplication, unsigned substitution, signed conflicting copies, path/count limits and CLI contracts. RunLedger passes 75 scenarios and the repository passes 79 Node.js tests locally on Node.js 24.22.1.
- Rechecked the local 200-request delivery workload: 100 unique deliveries, 100 deduplicated submissions and zero duplicate receiver effects. The 500-delivery archive workload again produced 250 eligible deliveries, 275 attempts, 63 inbox receipts and 25 replay receipts in a 274,432-byte artifact.
- [Implementation CI 42284283545](https://github.com/zhuyy86/leadreview/actions/runs/42284283545) passed the Linux and Windows suites plus both browser recovery scenarios at `ef1bad3`.
- Profile and bilingual Markdown/Word/PDF now carry the verified cross-file behavior. Next priorities: define source-cleanup checkpoints that preserve idempotency and receiver receipts, then measure retained-history indexes with explicit local scope.


## 2026-11-07 signed archive checkpoints

- [RunLedger archive checkpoints 05d8339](https://github.com/zhuyy86/leadreview/commit/05d83396a7800040404170749755971329f41d22) adds `checkpoint-archive` and `list-checkpoints`. Registration authenticates the archive manifest, pins a source write transaction and uses set comparisons across events, deliveries, every attempt generation, inbox receipts and replay-operation receipts. Any missing or changed row rolls back the checkpoint.
- The durable record stores artifact and manifest SHA-256 values, signed cutoff/counts, manifest creation time and registration time. Artifact SHA is the idempotency key. Repeated requests revalidate source rows; two real CLI processes racing to register the same archive return one new record and one duplicate result. Online backup preserves the checkpoint table.
- Manifest verification now hashes the exact bytes it authenticated and observes stable manifest identity during verification. Checkpoint registration also rejects source/artifact/manifest/key inode aliases and observes stable archive and manifest identities through the locked comparison.
- Six added scenarios cover full replay/inbox/operator preservation, repeated registration, post-checkpoint source drift, a separately signed divergent archive, legacy ledgers, backup persistence, concurrent CLI processes, listing and strict argument shapes. RunLedger passes 81 scenarios and the repository passes 85 Node.js tests locally on Node.js 24.22.1.
- The local 200-request workload again delivered 100 unique events from 200 submissions with zero duplicate receiver effects. The 500-delivery archive workload produced 250 eligible histories, 275 attempts, 63 inbox receipts and 25 replay receipts in a 274,432-byte artifact. Timings remain local observations.
- [Implementation CI 42321406922](https://github.com/zhuyy86/leadreview/actions/runs/42321406922) passed the Linux and Windows suites plus both browser recovery scenarios at `05d8339`.
- Source rows and live metric populations remain intact. Next priorities: design a checkpoint-consuming cleanup command with explicit retained identities/inbox/metric semantics, then measure active and archived lookup indexes on larger local fixtures.
