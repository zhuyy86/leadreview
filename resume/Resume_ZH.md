# 朱奕宇

全栈软件工程师

[zhuyy8612@gmail.com](mailto:zhuyy8612@gmail.com) · [GitHub 作品集](https://github.com/zhuyy86/leadreview/blob/main/PROFILE.md) · 远程项目合作 · 每周 20 小时 · 中国 UTC+8

用 Node.js 和 Python 开发具备持久化、故障恢复与回归验证的应用，在中国电信参与 AI 应用接入和项目支撑。

**技术栈：** JavaScript / Node.js 24 · Python · SQL / SQLite · HTTP API · pandas / openpyxl · Streamlit · pytest · GitHub Actions

## RunLedger Webhook 投递与故障回放

独立工程项目 · Node.js 24 · SQLite · 浏览器控制台 · 2026.11 · [源码与验证](https://github.com/zhuyy86/leadreview/tree/main/runledger)

用于投递 AI 任务完成通知，通过操作台查看重试、接收端故障与死信恢复过程。

- 在同一事务中提交事件和投递任务。幂等键与规范化载荷复用已有投递，同键异载荷返回 HTTP 409；租约令牌约束 Worker 回写。
- 对 HTTP 原始消息生成 HMAC 签名，以持久化 inbox 去重；验证回执丢失后的再次投递，回放保留投递 ID 和各代尝试记录。
- 实现持久化暂停／恢复派发，以及带预期代次校验、幂等操作回执和审计视图的原子批量回放；验证真实操作进程竞争、响应丢失与页面刷新续接。
- 以索引精确查询活动库及最多 20 个签名归档。检查点压缩保留身份、回执、尝试、审计与指标；在线重打包发布经验证的紧凑候选库。
- 92 项 Node.js 场景覆盖恢复、签名归档、回滚／并发、查询计划与 HTTP 契约。本地 2 万活动／1 万归档夹具的预编译查询 p50 从 9.469／4.003 ms 降至 0.008／0.006 ms。Linux、Windows 和浏览器 CI 通过。

## 其他工程作品

**[OrderCheck 订单数据质量工作台](https://github.com/zhuyy86/ordercheck)** 以 Decimal 校验金额，整组隔离订单冲突，导出七工作表审计报告。ZIP 完整暂存后独占发布，KPI JSON 同步后原子替换，故障保留旧报告。78 项测试覆盖规则、来源追溯、UI/CLI、KPI 异常与导出故障。

**[PriceWatch 历史价格监测](https://github.com/zhuyy86/pricewatch)** 在同一 SQLite 事务中提交快照与可恢复导出意图。CSV 恢复逐块校验并写入原子暂存，HTML 和告警 JSON 使用持久回执，积压时长支持健康探针。78 项测试覆盖进程退出、恢复与并发导出。

**[LeadReview 与 API Contract Lab](https://github.com/zhuyy86/leadreview)** 分离 AI 提取、确定性评分与人工审核，验证 n8n 内嵌代码脱离模块全局变量执行。HTTP/JSON/SSE 工具通过 18 项自测，线索规则以 17 条显式断言验证。

## 工作经历

**中国电信 创新产品运营中心** · 2026.06 至今

- 参与 AI 应用接入与项目支撑，复现识别、配置和事件通知问题，调整验证条件并复测，定位异常环节。
- 记录预期与实际行为、复现步骤和复测结果，维护项目配置核查项，支撑联调与问题跟进。

## 教育与语言

香港城市大学 · 理学硕士 电子资讯工程学 · 2025.09-2026.06

中山大学 · 工学学士 航空航天工程 · 2021.09-2025.06

中文母语 · 英语 CET-6 505 分 · 英文授课硕士项目
