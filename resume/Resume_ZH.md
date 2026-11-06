# 朱奕宇

全栈软件工程师

[zhuyy8612@gmail.com](mailto:zhuyy8612@gmail.com) · [GitHub 作品集](https://github.com/zhuyy86/leadreview/blob/main/PROFILE.md) · 远程项目合作 · 每周 20 小时 · 中国 UTC+8

用 Node.js 和 Python 开发具备持久化、故障恢复与回归验证的应用，在中国电信参与 AI 应用接入和项目支撑。

**技术栈：** JavaScript / Node.js 24 · Python · SQL / SQLite · HTTP API · pandas / openpyxl · Streamlit · pytest · GitHub Actions

## RunLedger Webhook 投递与故障回放

独立工程项目 · Node.js 24 · SQLite · 浏览器控制台 · 2026.11 · [源码与验证](https://github.com/zhuyy86/leadreview/tree/main/runledger)

用于投递 AI 任务完成通知，通过操作台查看重试、接收端故障与死信恢复过程。

- 在同一 SQLite 事务中写入事件与投递任务。幂等键和规范化载荷复用已有投递，同键异载荷返回 HTTP 409。WAL 快照备份与新文件恢复保留租约、幂等键和历史，不覆盖已有文件。
- 通过租约认领任务，租约令牌阻止旧 Worker 回写。临时故障按带抖动的退避策略重试，遵守接收端 Retry-After 最小等待；人工回放保留投递 ID 和各代尝试记录。
- 对原始消息生成 HMAC 签名，接收端以持久化 inbox 去重。验证至少一次投递下回执丢失、重启与再次投递只登记一次收件。
- 实现全量记录搜索、状态筛选、游标分页，以及读事务中的队列健康和区分回放代次的 p50/p95/p99 延迟观测；35 项 Node.js 场景覆盖队列与 HTTP 行为。
- 复现两个独立进程争抢任务及 Worker 终止接管。两 Worker、20 路分批并发的本地验证提交 200 次请求：100 次重复提交被去重，100 个唯一事件送达并形成 100 条收件记录。CI 运行 Linux、Windows 和浏览器检查。

## 其他工程作品

**[OrderCheck 订单数据质量工作台](https://github.com/zhuyy86/ordercheck)** 以 Decimal 校验金额，整组隔离订单冲突，导出七工作表审计报告。70 项测试覆盖规则、来源追溯、UI/CLI 和 KPI 异常输入。

**[PriceWatch 历史价格监测](https://github.com/zhuyy86/pricewatch)** 在 SQLite 中串行执行前驱读取与快照提交；抓取和写入前校验全部告警规则。53 项测试包含竞争写入、事务回滚和 CLI 错误处理。

**[LeadReview 与 API Contract Lab](https://github.com/zhuyy86/leadreview)** 分离 AI 提取、确定性评分与人工审核，验证 n8n 内嵌代码脱离模块全局变量执行。HTTP/JSON/SSE 工具通过 18 项自测，线索规则以 17 条显式断言验证。

## 工作经历

**中国电信 创新产品运营中心** · 2026.06 至今

- 参与 AI 应用接入与项目支撑，复现识别、配置和事件通知问题，调整验证条件并复测，定位异常环节。
- 记录预期与实际行为、复现步骤和复测结果，维护项目配置核查项，支撑联调与问题跟进。

## 教育与语言

香港城市大学 · 理学硕士 电子资讯工程学 · 2025.09-2026.06

中山大学 · 工学学士 航空航天工程 · 2021.09-2025.06

中文母语 · 英语 CET-6 505 分 · 英文授课硕士项目
