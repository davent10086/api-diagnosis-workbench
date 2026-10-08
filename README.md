# new-api 运维排障工具

为 [new-api](https://github.com/QuantumNous/new-api) 运维和技术支持团队提供请求排障、截图分析与诊断记录。独立部署，通过日志接口与 new-api 联动。

## 核心功能

- 按 Request ID 导入 new-api 日志，关联客户问题、请求、响应和截图。
- 规则诊断：排查 429/5xx、超时、SSE 异常和模型/工具参数兼容问题。
- AI 辅助分析：识别截图、检索官方知识库，生成带证据引用的报告。
- 前端展示思考过程，保存诊断历史，支持人工确认、修正和驳回。

## 快速开始

需要 **Node.js 20+** 和 **PostgreSQL 14+**。

```powershell
npm install
Copy-Item .env.example .env.local
```

编辑 `.env.local`：

```dotenv
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/api_diagnosis
NEW_API_BASE_URL=http://127.0.0.1:3000
NEW_API_ACCESS_TOKEN=有日志查看权限的管理员令牌
DASHSCOPE_API_KEY=百炼API密钥
```

`DATABASE_URL` 必填；new-api 联动和 AI 分析按需配置。已验证的模型组合为 `qwen3.7-plus`（诊断）和 `qwen-vl-max`（截图），其他配置见 [.env.example](.env.example)。

创建 `api_diagnosis` 数据库后运行：

```powershell
npm run db:migrate
npm run dev-all
```

按终端地址打开 `/cases`。默认端口为 3000，被 new-api 占用时会自动换端口。`dev-all` 同时启动 Web 服务和后台 worker。

## 使用

新建案件 → 导入日志或上传证据 → 开始诊断 → 查看报告与思考过程 → 人工审核。

可选知识库：设置 `KNOWLEDGE_BASE_PATH` 指向本地官方 Markdown 文档目录，执行 `npm run knowledge:import`。

## 使用提醒

- AI 诊断是辅助判断，结论需结合原始证据确认；缺失的请求、响应和日志应补充。
- 文本在服务端脱敏；截图会原样发送至视觉模型，请先遮盖敏感信息，并核对识别出的请求 ID。
- `.env.local`、密钥、真实日志和附件仅保存在本地。

## 更多

- [使用、配置与测试说明](docs/USAGE.md)
- [测试报告及已知问题](TEST_REPORT_2026-10-08.md)

技术栈：Next.js、React、TypeScript、PostgreSQL、Drizzle ORM、pg-boss；PGroonga 可选。
