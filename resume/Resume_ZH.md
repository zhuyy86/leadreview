# 朱奕宇

全栈软件工程师

[zhuyy8612@gmail.com](mailto:zhuyy8612@gmail.com) · [GitHub](https://github.com/zhuyy86/leadreview/blob/main/PROFILE.md) · 远程项目合作 · 每周 20 小时 · 中国 UTC+8

用 Node.js 和 Python 开发带有持久化、故障恢复和回归验证的应用。在中国电信参与 AI 应用接入与系统联调。

## RunLedger｜Webhook 投递与故障回放

独立工程项目 · Node.js 24 · SQLite · 浏览器控制台 · 2026.11

[源码与复现](https://github.com/zhuyy86/leadreview/tree/main/runledger)

用于投递 AI 任务完成通知。接收端暂时故障或 Worker 中断时，控制台能查看重试、接管和回放的完整记录。

- 在同一个 SQLite 事务中写入事件和投递任务，避免事件入库后漏发。按幂等键和规范化载荷复用已有投递，同键异载荷返回 HTTP 409。
- 用带有效期的租约认领任务，租约令牌阻止旧 Worker 回写。网络故障、429 和 5xx 按退避策略重试，耗尽预算后进入死信，可从界面回放并保留历史。
- 以稳定投递 ID、时间戳和原始消息生成 HMAC 签名。接收端校验签名并通过持久化收件箱去重，使至少一次投递下的重复请求只登记一次。
- 在本机用两个独立进程争抢同一任务，终止获胜进程后以第 2 次尝试接管原任务。HTTP 实测从 503 重试至死信，再回放至 200，控制台保留各次结果。
- 在 20 路并发提交、两个 Worker 的本地验证中，200 次请求含 100 次重复提交。100 个唯一事件全部送达，接收端记录 100 次处理。

## 其他工程作品

**[OrderCheck｜订单数据质量工作台](https://github.com/zhuyy86/ordercheck)**  以 Decimal 校验金额，按业务复合键隔离内容冲突的整组记录。七工作表 Excel 报告保留来源行、规则和输入哈希，51 项测试验证校验、导出及 Streamlit 与 CLI 的共享逻辑。

**[API Contract Lab｜HTTP 与 SSE 故障回归](https://github.com/zhuyy86/leadreview/blob/main/tools/API_CONTRACT_LAB.md)**  通过本地 HTTP 服务复现非法 JSON、SSE 缺少终止事件及超时。18 项自测覆盖接口契约与重试，输出 HTML 诊断和 JSON 结果。

**[LeadReview｜AI 信息提取与人工审核](https://github.com/zhuyy86/leadreview)**  以确定性规则为 AI 提取结果评分，将拟议动作和审批后动作分开。JavaScript 源模块生成可导入的 n8n 工作流，17 条断言验证评分、非法枚举和生成结果。

## 工作经历

**中国电信｜AI 应用工程与系统集成** · 2026.06 至今

- 沿输入采集、接入配置、识别输出和事件通知复现异常，调整验证条件并复测，区分输入质量、配置和功能行为问题。
- 记录预期与实际行为、复现步骤和复测结果，整理配置核查清单，供系统联调与回归验证使用。

## 教育与语言

香港城市大学 · 理学硕士 电子资讯工程学 · 2025.09–2026.06

中山大学 · 工学学士 航空航天工程 · 2021.09–2025.06

中文母语 · 英语 CET-6 505 分 · 英文授课硕士项目
