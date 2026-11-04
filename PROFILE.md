# ZHU YIYU · 朱奕宇

**Full-Stack Development · AI Workflows · APIs & Data Systems**

I build software that connects user-facing workflows, business rules, data storage and external services. My work focuses on turning complex requirements into clear modules, explicit interfaces and repeatable delivery, with particular attention to data consistency, failure handling and regression testing.

**Open to remote development contracts and ongoing collaboration · 20 hours/week**  
[Email](mailto:zhuyy8612@gmail.com) · [English résumé](resume/Resume_EN.md) · [中文简历](resume/Resume_ZH.md) · [English PDF](resume/Resume_EN.pdf) · [中文 PDF](resume/Resume_ZH.pdf)

## Engineering focus

- **Application architecture:** separate presentation, domain rules, data access and integration boundaries; reuse core logic across interactive and command-line workflows.
- **Data correctness:** define validation contracts, preserve identifiers, use precise monetary arithmetic, isolate conflicting records and retain provenance for review.
- **Integration reliability:** make HTTP and streaming contracts explicit; handle timeouts, bounded concurrency, retry policy and incomplete responses deliberately.
- **AI workflow engineering:** combine model-driven processing with deterministic validation, explainable decisions and explicit review states.
- **Delivery quality:** keep execution reproducible through configuration, automated regression checks, diagnostic reports and clear handover documentation.

## Selected engineering projects

### [OrderCheck — Order Data Validation & Review](https://github.com/zhuyy86/ordercheck)

**Python · pandas · openpyxl · Streamlit · Decimal · pytest**

A layered order-processing application covering ingestion, field mapping, business validation, exception review and report generation.

- Shared processing logic supports both the interactive workbench and command-line batch execution.
- Configurable contracts validate required fields, dates and monetary values while preserving text identifiers and source-row information.
- Cross-file duplicate detection separates exact duplicates from conflicting business records; conflicting groups enter review together.
- Input hashes, applied rules, mappings and change history accompany CSV, Excel and ZIP outputs, making each batch traceable and reproducible.
- A 51-test baseline covers parsing, validation, conflicts, edge cases and exports; browser checks cover upload, review and download.

### [PriceWatch — Transactional Price History & Change Detection](https://github.com/zhuyy86/pricewatch)

**Python · Requests · BeautifulSoup · YAML · SQLite · pytest**

A configurable monitoring pipeline that turns extracted product listings into persistent history and actionable change events.

- Source-specific SQLite snapshots maintain independent comparison histories for different sources.
- Atomic snapshot writes keep incomplete runs from becoming the reference state for future comparisons.
- Stable product keys support added, removed, price and availability change events across successive snapshots.
- Configurable price thresholds and minimum reductions produce structured alert output; escaped HTML reports support review.
- A 27-test baseline covers extraction, storage and history behavior, supported by offline fixtures and repeatable demos.

### [LeadReview — Explainable AI Intake & Routing](https://github.com/zhuyy86/leadreview)

**JavaScript · Node.js · n8n · JSON · Webhooks**

A modular intake and qualification workflow with a clear boundary between AI processing and business decisions.

- Normalize website, form, email-shaped and API inputs into a consistent internal contract.
- Validate source fields and message constraints before applying allowlisted scoring rules and explainable decision reasons.
- Keep proposed actions separate from approved next actions through explicit review states.
- Maintain business logic outside the workflow JSON; generate the importable workflow reproducibly from the source module.
- Offline assertions and workflow graph checks verify input behavior, scoring, connections and embedded-source consistency.

### [API Contract Lab — HTTP & Streaming Regression](https://github.com/zhuyy86/leadreview/blob/main/tools/API_CONTRACT_LAB.md)

**Node.js · HTTP · JSON · Server-Sent Events · Fault Fixtures**

A dependency-free integration regression tool for service interfaces and streaming responses.

- Configurable contracts check response status, nested JSON types and values, and latency limits.
- SSE parsing covers multiline data, CRLF handling and missing terminal events.
- Bounded concurrency, request timeouts, response-size limits and explicit retry rules make failure behavior predictable.
- POST retries require explicit opt-in; environment-based credentials stay outside suite definitions and generated reports.
- Eighteen local self-tests cover successful responses, malformed JSON, authentication errors, rate limits, incomplete streams and timeouts.

## Professional background

**China Telecom · AI application integration and technical delivery**

My professional work includes end-to-end application validation, fault reproduction, integration troubleshooting and technical documentation. This experience informs how I translate operational requirements into testable behavior, communicate defects and verify fixes across system boundaries.

## Working together

I am interested in full-stack product development, AI application workflows, API integrations, data-processing services and developer tooling. I work well with written requirements, documented interfaces, reviewable changes and milestone-based delivery. Email is my preferred first contact.

## 中文介绍

面向全栈开发、AI 应用和系统集成方向，关注从用户操作、业务规则、数据处理到服务接口的完整链路。项目重点包括模块分层、数据一致性、接口契约、异常处理、自动化回归和可复现交付。

在中国电信参与 AI 应用集成、端到端验证、故障复现与技术交付，能够将业务问题整理为可复现的测试条件、接口与配置检查项以及修复验证记录。接受远程项目合作和持续开发协作，每周可投入 20 小时，优先通过邮件沟通。

---

The portfolio includes independent open-source extensions and developer tooling. Project repositories retain their source records, licenses and contribution details.
