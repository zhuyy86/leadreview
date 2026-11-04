# YIYU ZHU

Full-Stack Software Engineer | AI Applications, Data Systems & APIs

China | UTC+8 | zhuyy8612@gmail.com | https://github.com/zhuyy86

Remote contracts | 20 hours/week | Available now

## PROFILE

Builds verifiable business applications with Python, JavaScript and Node.js, separating input adapters, domain rules, persistence and interfaces through explicit contracts. Engineering work covers order validation, transactional snapshots, AI workflow rules and HTTP/SSE regression, with an emphasis on consistency, failure isolation and traceable decisions. At China Telecom, contributes to AI application integration by investigating interactions between input quality, configuration, platform state and event delivery.

## TECHNICAL CAPABILITIES

**Application engineering**: Python, JavaScript, Node.js, Streamlit, HTML, CLI; input normalization, configurable business rules, explainable scoring, shared application cores

**Data & integration**: pandas, openpyxl, SQLite, CSV/XLSX, JSON/YAML, Requests, BeautifulSoup; snapshots, transactions, change detection, HTTP/JSON, SSE, MQTT

**Quality & delivery**: pytest, Node.js self-tests, browser verification, Git; contract validation, bounded concurrency, timeouts/retries, exception isolation, audit metadata, HTML/JSON reporting

## PROJECTS

Independent engineering portfolio | Open-source extensions and purpose-built tools using AI-assisted implementation, testing and documentation

### OrderCheck | Order Data Quality Workbench

Python · pandas · openpyxl · Streamlit · Decimal · pytest | Sep 2026

https://github.com/zhuyy86/ordercheck

- Separated CSV/XLSX adapters, field mapping, JSON rules and reporting around a shared core used by Streamlit and CLI, establishing consistent ingestion, validation and result contracts.

- Used Decimal for monetary precision and preserved text identifiers; distinguished duplicates from conflicting records by composite business key, quarantining conflict groups and recording row provenance and decisions.

- Exported rules, input hashes and review reasons in seven-sheet Excel reports; 51 tests and browser checks verified parsing boundaries, exports and consistent behavior across both entry points.

### API Contract Lab | Interface Contracts & Failure Regression

Node.js · HTTP/JSON · SSE · HTML/JSON Reporting | Nov 2026

https://github.com/zhuyy86/leadreview/blob/main/tools/API_CONTRACT_LAB.md

- Decomposed API acceptance into HTTP status, nested JSON, SSE events and terminal semantics, combining timeout and latency budgets to verify response structure, stream completeness and timing constraints.

- Bound concurrency and retried explicit transient failures with controlled POST replay; injected authorization through environment variables and excluded secrets and response bodies from reports.

- Used localhost HTTP fault fixtures for malformed JSON, missing stream termination, timeouts and retries; 18 self-tests verified detection and execution behavior, producing HTML diagnostics and machine-readable JSON.

### PriceWatch | Persistent Snapshots & Change Monitoring

Python · Requests · BeautifulSoup · YAML · SQLite · pytest | Sep 2026

https://github.com/zhuyy86/pricewatch

- Modeled SQLite runs and product snapshots with source-isolated history; linked observations through URL-first identities with normalized-name fallback for repeatable comparisons.

- Rejected duplicate keys before writes and used transactions for snapshot integrity; modeled added, unobserved, price-change and availability-change events separately to preserve observation semantics.

- Generated escaped HTML reports while retaining CSV output; 27 tests covered parsing, source isolation, transactions and history comparison, with two-run and browser verification of the complete data path.

### LeadReview | Explainable Rules & Workflow Routing

JavaScript · Node.js · JSON · n8n Workflow | Sep 2026

https://github.com/zhuyy86/leadreview

- Designed a layered workflow from input normalization through AI extraction, deterministic rules and human review; constrained multi-source payloads with allowlists, length limits, email checks and scoring enums.

- Decoupled business scoring from AI extraction and exposed itemized reasons; separated proposed_action from next_action and used explicit review states to control business routing.

- Extracted core JavaScript into testable modules and reproducibly generated n8n workflow JSON; 17 assertions and dynamic connection checks covered invalid enums, scoring, references and embedded-source consistency.

## EXPERIENCE

### China Telecom

AI Application Engineering & Systems Integration | Jun 2026–Present

- Contribute to AI application integration and end-to-end validation across input collection, platform configuration, inference output and event delivery; document reproduction conditions, expected behavior and observed failures.

- Investigate recognition failures, association inconsistencies and delayed events by examining input quality, connection state and platform parameters; adjust validation conditions and retest to isolate configuration, input and functional issues.

- Document integration procedures, configuration checks and fault-reproduction steps, retaining retest results to support system debugging, regression verification and reusable technical knowledge.

## EDUCATION & LANGUAGES

City University of Hong Kong | MSc, Electronic Information Engineering | Sep 2025–Jun 2026

Sun Yat-sen University | BEng, Aerospace Engineering | Sep 2021–Jun 2025

Native Mandarin | English: CET-6 505; English-medium postgraduate education; written technical and asynchronous collaboration
