# API 排障助手（new-api 排障工作台）

面向使用 [new-api](https://github.com/QuantumNous/new-api) 的中文团队的独立排障工作台。它将客户问题、请求与响应、日志、SSE 事件和截图收集为案件，支持按 Request ID 从 new-api 导入日志；先执行可复现的确定性规则，再可选地结合本地官方知识库与百炼模型生成带证据引用的诊断报告。

## 与 new-api 的关系

本工具围绕 new-api 的模型渠道、上游转发与请求日志设计，用于调查诸如渠道返回 429/5xx、协议转换、流式响应中断和上游参数校验失败的问题。它作为**独立应用**运行，不修改 new-api 的请求处理或计费流程，也不需要部署在同一进程中。

- **未连接 new-api**：仍可手动建立案件、上传证据并运行规则诊断。
- **连接 new-api**：配置服务地址和有日志查看权限的管理员 Access Token 后，可按 Request ID 导入日志；连接方式见[从 new-api 导入日志](#从-new-api-导入日志)。
- **AI 诊断**：另需配置百炼 API Key。它是可选的辅助分析，报告中的假设应结合原始证据复核。

new-api 日志只能提供其实际记录的字段；完整请求体、上游响应体或准确 HTTP 状态码若未记录，仍需手动补充。工具不会将缺失字段推断为已确认事实。

## 功能

- 案件工作台：记录客户描述、服务商、模型、路由、状态码、请求 ID、上游请求 ID 与补充上下文。
- 证据管理：上传 JSON、TXT、PNG、JPEG 等附件；文本在服务端脱敏，图片保留原图并直接用于 AI 诊断。
- 规则诊断：覆盖 429 重试证据、5xx 上游边界、取消/超时、Anthropic SSE 生命周期与索引、请求转换差异、Bedrock 工具兼容性、工具调用生命周期及缓存证据。
- 官方知识库：从本地 Markdown 导入文档，支持中文、英文和 API 技术词检索。
- AI 证据诊断（可选）：提取上传截图中的线索，检索本地知识库，并生成结构化的根因、证据、假设、缺失信息、下一步动作及客户回复建议。
- 本地持久化：案件、规则命中、附件元数据、诊断运行记录与文档引用均保存在 PostgreSQL；附件文件保存于 `storage/`。

删除案件时，附件路径会先与数据库删除一起写入待清理记录，再删除本地文件。文件被占用或清理中断时，worker 每 5 分钟重试；worker 也会清理超过 1 小时、没有数据库记录的托管附件。可手动运行 `npm run evidence:cleanup` 查看清理数量。首次使用此机制需执行 `npm run db:migrate`。

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
npm run dev-all
```

打开 [http://localhost:3000/cases](http://localhost:3000/cases)。默认首页会跳转至案件列表。如果 3000 端口已被 new-api 占用，Next.js 会自动使用其他端口，请以终端显示的地址为准。`dev-all` 同时启动 Web 服务和后台 worker；单独运行 `npm run dev` 时，需在另一终端运行 `npm run worker` 才能处理 AI 诊断任务。

> 数据库是案件工作台运行所必需的。未连接数据库时页面会提示完成迁移并检查 `DATABASE_URL`。

## 配置

`.env.example` 包含以下配置项：

| 变量 | 是否必需 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 是 | PostgreSQL 连接串。 |
| `KNOWLEDGE_BASE_PATH` | 导入知识库时 | 本地官方 Markdown 知识库根目录。 |
| `DASHSCOPE_API_KEY` | AI 诊断时 | 阿里云百炼 API Key，仅在服务端使用；OpenAI 兼容接口继续使用该密钥。 |
| `OPENAI_COMPAT_BASE_URL` | 否 | OpenAI 兼容接口 Base URL，默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`；可配置百炼业务空间专属域名。旧的 `DASHSCOPE_BASE_URL` 若以 `/api/v1` 结尾，会自动转换为对应兼容地址。 |
| `QWEN_ANALYSIS_MODEL` | 否 | 文本诊断模型，默认 `qwen3.7-plus`。 |
| `QWEN_VISION_MODEL` | 否 | 图片信息提取模型，默认 `qwen-vl-max`。 |
| `NEW_API_BASE_URL` | 联动时 | new-api 服务地址，默认本机 `http://127.0.0.1:3000`。 |
| `NEW_API_ACCESS_TOKEN` | 联动时 | 有日志查看权限的管理员 Access Token，仅在服务端使用。 |

请勿提交 `.env.local`、API Key、真实日志或附件。

## 使用流程

1. 在“案件”中新建记录，填写客户问题和可获得的 Trace、请求/响应、日志或 SSE 事件。
2. 上传所需证据；确认文本脱敏结果，并对图片明确确认已脱敏。
3. 运行规则诊断，查看命中的规则、证据与需要补充的信息。
4. 完成案件后，若已配置 DashScope，可选择推理强度运行 AI 诊断。
5. 在诊断报告中核对确定性规则、Trace、图片及知识库引用；将假设与已确认结论区分处理。

未配置 `DASHSCOPE_API_KEY` 不影响案件录入和规则诊断；发起 AI 诊断时会返回明确的配置错误。

### AI 模型兼容范围

当前 AI 调用使用 OpenAI 兼容的 `POST /chat/completions` 协议，**仍由百炼 API Key 鉴权**。已验证的组合是 `qwen3.7-plus` 用于文本诊断、`qwen-vl-max` 用于截图提取。修改 `QWEN_ANALYSIS_MODEL` 或 `QWEN_VISION_MODEL` 可以选择百炼提供的其他模型，但应先验证具体模型的能力，修改 `.env.local` 后重启 Web 服务和 worker。

文本诊断要求模型支持 JSON 对象输出，并能处理 `reasoning_effort` 参数；截图提取要求模型支持 Base64 Data URL 图片输入和 JSON 对象输出。应用还会校验报告字段及证据引用，所以接口返回成功不等于诊断通过。百炼各模型对这些参数的支持范围不同，请参阅[百炼 OpenAI 兼容接口文档](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)。

其他服务商不能只替换 `OPENAI_COMPAT_BASE_URL` 或模型名：当前程序始终发送 `DASHSCOPE_API_KEY`，而且 JSON、图片、推理参数在兼容接口上的行为可能不同。接入其他服务商前，需要增加独立密钥配置和针对该模型的参数适配，并用文本及截图诊断验证完整流程。不要把百炼密钥发送到其他服务商的接口地址。

### 从 new-api 导入日志

在 new-api 后台的安全设置中生成有日志查看权限的管理员 Access Token，并在排障工具的 `.env.local` 中配置 `NEW_API_BASE_URL` 和 `NEW_API_ACCESS_TOKEN`。两项配置仅由排障工具服务端读取，修改后重启服务。

在“新建排障案件”的“案件信息”中填写 Request ID，点击“按 Request ID 导入”。工具会从 new-api 的 `/api/log/` 查询这一条日志，填入模型、请求 ID、上游请求 ID、发生时间，并把日志内容作为排障线索。new-api 日志不包含完整请求体、上游响应体和准确的 HTTP 状态码时，请继续手动补充这些证据；工具不会根据错误日志猜测状态码。

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
npm run dev-all             # 同时启动开发服务器和 worker
npm run dev                 # 仅启动开发服务器
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
npm run evidence:cleanup    # 重试附件删除并清理旧孤儿附件
```

## 验证

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
```

## 测试

复制 `.env.test.example` 为本地 `.env.test`，并将 `DATABASE_URL` 指向数据库名以
`_test` 结尾的 PostgreSQL。测试命令会拒绝其他数据库，`storage-test/` 会在集成
测试前后清理。先执行 `npm run db:migrate`，然后运行 `npm run test:unit`、
`npm run test:integration`、`npm run test:e2e` 或 `npm run test:coverage`。

Playwright 首次使用须执行 `npx playwright install chromium`。真实模型 smoke 默认
跳过；仅在同时设置 `RUN_LIVE_LLM_TESTS=1` 与 `DASHSCOPE_API_KEY` 后运行
`npm run test:live-llm`。它只发送最小 JSON 提示和一张生成的空白测试图片，不上传案件附件、不写数据库。

演示数据包含 Bedrock `web_search_20250305` 工具不兼容、SSE 生命周期异常与 `502 + context canceled` 等排障场景。
## 完整本地验证

在本机启动 `new-api-local` 和 `new-api-local-db` 容器后，运行 `npm run test:full`。命令会在 3002 端口缺少排障工具服务时启动它，并启动测试 worker；普通数据库测试使用独立的 `api_diagnosis_test` 数据库，真实链路使用当前排障工具实例配置的数据库。

真实链路需要 `.env.local` 中的 `DASHSCOPE_API_KEY`、`NEW_API_BASE_URL` 和具有管理员权限的 `NEW_API_ACCESS_TOKEN`。测试会在 new-api 中创建临时用户、令牌和渠道，通过本机模拟上游发出成功、429 和 502 请求，再按 Request ID 导入日志。new-api 容器需能访问 `host.docker.internal`；测试使用本地名为 `new-api-local-db` 的 PostgreSQL 容器保存和清理临时令牌及日志。

每次运行会打印 `full-<UUID>` 标识。若进程被强制中断，可执行 `npm run test:full:cleanup -- full-<UUID>` 补做案件、附件、渠道、用户、令牌与日志清理。诊断还在运行时，等待 worker 结束后重试清理命令。
