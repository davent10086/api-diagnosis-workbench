# API 排障助手

本地运行的中文 API 排障工作台。用于组织截图、JSON/TXT 日志和客户描述，先做脱敏与确定性规则检查，再结合本地官方文档生成可追溯诊断。默认不需要外部模型或数据库即可演示。

## 启动

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

打开 `http://localhost:3000/cases`。新建案件页可演示“编辑请求体 → 脱敏确认 → 运行规则 → 查看报告”。

## PostgreSQL 初始化

确保本机 PostgreSQL 已启动，创建数据库后填写 `.env.local` 的 `DATABASE_URL`：

```powershell
createdb api_diagnosis
npm run db:migrate
npm run db:seed
```

### 数据库要求

需要本机 PostgreSQL 且已安装 PGroonga 扩展；仓库当前不提供 Docker Compose 配置。`.env.local` 填写数据库连接后，初始化结构与演示数据：

```powershell
npm run db:migrate
npm run db:seed
```

PGroonga 索引由 `0001_pgroonga_search.sql` 创建，可直接对中文、英文和 API 技术 token 使用 `&@` 检索。

### 导入官方知识库

在 `.env.local` 设置 `KNOWLEDGE_BASE_PATH` 后执行：

```powershell
npm run knowledge:import
```

导入器解析每篇 Markdown 的 `source` frontmatter，按标题切块并写入 `document_chunks`。`/knowledge` 调用 PGroonga 搜索接口，优先命中错误码、协议字段和 SSE 事件；`embedding` 字段保留为后续配置千问 Embedding 后的语义召回接口。

迁移使用 Drizzle；当 PostgreSQL 安装了 PGroonga 时会自动创建全文索引。未安装时应用仍可运行，知识库改用 PostgreSQL 基础包含匹配；`embedding` 为可空预留字段，因此不依赖 pgvector。截图应存入 `storage/`，数据库仅存路径、哈希和提取元数据。

## AI 证据诊断

案件完成后，可在案件详情中点击“运行 AI 诊断”。服务端会编排以下受控能力：

- 对已确认脱敏的 PNG/JPEG 截图调用 `VISION_MODEL` 提取错误码、请求 ID、时间与日志线索；
- 根据 Trace、规则命中和图片线索检索本地官方知识库；
- 以 `ANALYSIS_MODEL` 生成带证据、待验证假设、缺失证据和下一步动作的结构化报告；
- 将每次运行、报告和官方文档引用保存到数据库，模型失败时仍保留确定性规则结果并可重试。

模型请求仅在服务端发起，且只包含已脱敏的最小必要证据。图片在上传时必须由操作人确认已脱敏，未确认的图片不会发送给模型。未配置 `OPENAI_BASE_URL` 或 `OPENAI_API_KEY` 时，案件仍可使用原有规则诊断；AI 诊断会返回明确的配置错误。

## 检查

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
```

内置演示案例包括 Bedrock `web_search_20250305` 不兼容、SSE 生命周期异常、`502 + context canceled`。
