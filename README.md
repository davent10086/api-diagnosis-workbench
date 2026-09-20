# API 排障助手

面向中文团队的本地 API 排障工作台。它将客户问题、请求与响应、日志、SSE 事件和截图收集为案件，先执行可复现的确定性规则，再可选地结合本地官方知识库与通义千问生成带证据引用的诊断报告。

## 功能

- 案件工作台：记录客户描述、服务商、模型、路由、状态码、请求 ID、上游请求 ID 与补充上下文。
- 证据管理：上传 JSON、TXT、PNG、JPEG 等附件；文本在服务端脱敏，图片须由操作人确认已脱敏后才可用于 AI 诊断。
- 规则诊断：覆盖 429 重试证据、5xx 上游边界、取消/超时、Anthropic SSE 生命周期与索引、请求转换差异、Bedrock 工具兼容性、工具调用生命周期及缓存证据。
- 官方知识库：从本地 Markdown 导入文档，支持中文、英文和 API 技术词检索。
- AI 证据诊断（可选）：提取已确认脱敏截图中的线索，检索本地知识库，并生成结构化的根因、证据、假设、缺失信息、下一步动作及客户回复建议。
- 本地持久化：案件、规则命中、附件元数据、诊断运行记录与文档引用均保存在 PostgreSQL；附件文件保存于 `storage/`。

## 技术栈

Next.js 15、React 19、TypeScript、Tailwind CSS、Drizzle ORM、PostgreSQL、PGroonga（可选）与 pg-boss。

## 前置条件

- Node.js 20 或更高版本
- PostgreSQL 14 或更高版本
- 可选：PGroonga 扩展。未安装时，知识库会退回到 PostgreSQL 基础包含匹配。
- 可选：阿里云百炼 DashScope API Key，用于 AI 诊断。

## 快速开始

安装依赖并创建本地配置：

```powershell
npm install
Copy-Item .env.example .env.local
```

创建数据库后，在 `.env.local` 中设置 `DATABASE_URL`：

```powershell
createdb api_diagnosis
npm run db:migrate
npm run db:seed
npm run dev
```

打开 [http://localhost:3000/cases](http://localhost:3000/cases)。默认首页会跳转至案件列表。

> 数据库是案件工作台运行所必需的。未连接数据库时页面会提示完成迁移并检查 `DATABASE_URL`。

## 配置

`.env.example` 包含以下配置项：

| 变量 | 是否必需 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 是 | PostgreSQL 连接串。 |
| `KNOWLEDGE_BASE_PATH` | 导入知识库时 | 本地官方 Markdown 知识库根目录。 |
| `DASHSCOPE_API_KEY` | AI 诊断时 | 阿里云百炼 DashScope API Key，仅在服务端使用。 |
| `DASHSCOPE_BASE_URL` | 否 | DashScope API 地址，默认 `https://dashscope.aliyuncs.com/api/v1`。 |
| `QWEN_ANALYSIS_MODEL` | 否 | 文本诊断模型，默认 `qwen3.7-plus`。 |
| `QWEN_VISION_MODEL` | 否 | 图片信息提取模型，默认 `qwen-vl-max`。 |

请勿提交 `.env.local`、API Key、真实日志或附件。

## 使用流程

1. 在“案件”中新建记录，填写客户问题和可获得的 Trace、请求/响应、日志或 SSE 事件。
2. 上传所需证据；确认文本脱敏结果，并对图片明确确认已脱敏。
3. 运行规则诊断，查看命中的规则、证据与需要补充的信息。
4. 完成案件后，若已配置 DashScope，可选择推理强度运行 AI 诊断。
5. 在诊断报告中核对确定性规则、Trace、图片及知识库引用；将假设与已确认结论区分处理。

未配置 `DASHSCOPE_API_KEY` 不影响案件录入和规则诊断；发起 AI 诊断时会返回明确的配置错误。

## 知识库

将官方文档以 Markdown 形式置于 `KNOWLEDGE_BASE_PATH` 指向的目录，并在文档 frontmatter 中提供 `source`。执行：

```powershell
npm run knowledge:import
```

导入器按标题切分内容并写入 `document_chunks`。访问 `/knowledge` 可搜索已导入内容。`embedding` 是预留字段，当前实现不依赖 pgvector 或外部 Embedding 服务。

如需清空已导入知识库：

```powershell
npm run knowledge:clean
```

## AI 诊断与数据边界

AI 请求由服务端直接发送至 DashScope，输入仅包含案件中的最小必要证据。仅状态为已脱敏的 PNG/JPEG 图片会被发送给视觉模型；每次最多处理 5 张图片，并发提取数为 2。模型输出会经过结构校验和证据引用校验，不能引用未提供的规则、Trace、图片或知识库条目。

诊断失败或被取消时，已完成的规则诊断和案件数据会保留，案件可再次诊断。请在向外部模型传输任何资料前，确认其符合组织的数据安全要求。

## 常用命令

```powershell
npm run dev                 # 开发服务器
npm run build               # 生产构建
npm run start               # 启动生产服务器
npm run lint                # ESLint 检查
npm run typecheck           # TypeScript 检查
npm run test                # 运行 Vitest 测试
npm run db:generate         # 生成 Drizzle 迁移
npm run db:migrate          # 执行数据库迁移
npm run db:seed             # 写入演示数据
npm run knowledge:import    # 导入本地 Markdown 知识库
npm run knowledge:clean     # 清空已导入知识库
npm run worker              # 启动后台 worker
```

## 验证

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
```

演示数据包含 Bedrock `web_search_20250305` 工具不兼容、SSE 生命周期异常与 `502 + context canceled` 等排障场景。
