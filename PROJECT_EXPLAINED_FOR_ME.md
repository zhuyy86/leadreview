# LeadReview：给我自己的通俗讲解

## 项目解决什么问题

小企业收到网站表单、普通 API 或邮件转发的咨询后，需要先把不同格式整理成统一文本，再提取意向并评分。LeadReview 给高分结果附上评分理由和建议动作，但不会直接替人预约：需要人工确认的结果会进入 `await_human_approval`。

## 用户怎么使用

运行构建脚本生成增强版 n8n 工作流 JSON，再把该 JSON 导入 n8n，并自行配置 Gemini 凭据。也可以完全离线运行测试，验证输入整理、评分与工作流连接。

## 整个程序如何运行

Webhook 接收数据 → 把 website/form/gmail/api 四种输入整理成统一结构 → Gemini 提取字段 → JavaScript 用固定规则评分并记录理由 → Gemini 草拟回复 → 合并结果 → 输出状态、建议动作、人工审核标记和审计字段。

## 主要目录

- `workflow/`：原始工作流和自动生成的 V2 增强工作流。
- `logic/`：可以脱离 n8n 测试的核心 JavaScript 逻辑。
- `scripts/`：把核心逻辑嵌入工作流 JSON 的构建脚本。
- `tests/`：离线断言和工作流结构检查。
- `docs/`：架构说明和图片。

## 最重要的文件

- `logic/lead_logic.mjs`：输入标准化、字段清理、评分和人工审核规则。
- `scripts/build_v2_workflow.mjs`：读取原始 JSON 并重复生成 V2，避免手工复制后逻辑不同步。
- `tests/test_lead_logic.mjs`：验证四类输入、错误输入、评分、注入样式值和工作流连接。
- `workflow/LeadReview - V2 Human Review.json`：可导入 n8n 的成果。
- `workflow/AI Lead Qualification & Appointment Agent - V1 Foundation.json`：保留的原始版本，用于对比。

## 核心逻辑

输入层只接受四种来源，正文限制为 5–2000 个字符。评分层只接受白名单枚举；例如用户传入 `set_score_100` 不会被当成合法意图。每条加分都会生成理由，最后限制在 0–100。高分或待复核结果只给出建议动作，并要求人工确认。

## 原有部分与新增部分

原有工作流包含 Webhook、Gemini 提取、确定性评分、Gemini 回复和 JSON 响应。新增部分包括多种输入形状、长度和来源校验、邮箱校验、枚举白名单、可解释评分、建议动作与实际下一步分离、人工审核标记、审计字段、可重复构建脚本和离线测试。

## 技术栈

n8n、JavaScript、Node.js、JSON、JSON Schema、Webhook、Gemini 工作流节点。

## 面试官可能问什么

1. 为什么业务评分不用 LLM？固定规则可重复、可解释、容易审计。
2. 为什么把逻辑放在独立 `.mjs` 文件？便于脱离 n8n 自动测试，再由构建脚本同步进 JSON。
3. 为什么高分不能直接预约？模型提取可能出错，真实外部操作应有人确认。
4. 如何处理不同入口？先转成统一的 `lead_message` 和 `lead_source`，后续节点无需分别适配。
5. 如何防止随意字段控制评分？枚举白名单和邮箱格式校验会把异常值降为未知或空值。
6. 哪些还没验证？没有真实 n8n 实例、Gemini 凭据、邮件或 CRM，因此不能声称已经上线。

## 如何现场演示

依次运行 `node scripts/build_v2_workflow.mjs` 和 `node tests/test_lead_logic.mjs`，展示 17 条明确断言及动态工作流连接检查通过；打开 V2 JSON 的 n8n 工作流图，说明四种入口如何统一、85 分样例如何得到逐项理由，以及为什么下一步是等待人工批准。若现场有自己的 n8n 和 Gemini 凭据，可额外导入运行，但这不属于当前已验证结果。
