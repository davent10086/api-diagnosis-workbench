# 诊断工作流架构

项目采用 LangChain 模型与工具接口、LangGraph 状态图编排。当前是确定性排障工作流：节点与执行顺序由代码定义，模型分析证据并生成报告，建议操作不会自动执行。

## 入口与流程

`POST /api/cases/:id/diagnosis` 将案件放入 pg-boss 队列，Worker 调用 `runDiagnosis()`。PostgreSQL advisory lock 保证同一案件不会被两个 Worker 同时处理。

LangGraph 的执行顺序：

```text
START → prepare → images → retrieval → model → validate
      → adjudicate → validate_and_persist → END
```

| 节点                 | 职责                                                |
| -------------------- | --------------------------------------------------- |
| prepare              | 加载 Trace 与附件、读取文本、运行确定性规则         |
| images               | 提取图片证据、记录未读取图片、补充图片规则          |
| retrieval            | 调用标准知识库 Tool，检索候选资料                   |
| model                | 调用 LangChain 模型生成结构化报告，保存模型结果断点 |
| validate             | 校验证据引用是否存在，拒绝虚构引用                  |
| adjudicate           | 检查根因证据、缺失材料与人工确认阻断项              |
| validate_and_persist | 事务保存报告、案件状态与引用                        |

`src/lib/diagnosis-graph.ts` 定义类型化共享状态、节点和边；`src/lib/diagnosis.ts` 注入节点业务逻辑和数据库步骤记录。节点通过状态传递证据与输出；凭证、数据库连接、锁及 AbortSignal 不放入状态。失败会终止后续节点，记录失败节点并释放案件锁；取消信号在节点入口、模型请求及工具调用间传递。

## 模型接口

`src/lib/diagnosis-model.ts` 使用 `@langchain/openai` 的 `ChatOpenAI` 调用百炼 OpenAI 兼容接口，诊断与图片识别共用该适配层。继续使用 `DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL` / `OPENAI_COMPAT_BASE_URL`、`QWEN_ANALYSIS_MODEL` 和 `QWEN_VISION_MODEL`；不需要新增 OpenAI 密钥。

模型调用显式使用 Chat Completions、非流式输出，保留 Qwen 的 `enable_thinking`、`reasoning_effort` 和 JSON 输出参数。百炼独立的 `reasoning_content` 在传输边界保留，报告正文不能伪造该字段。Zod 校验和中文输出修复保持在报告层；传输层保留最多三次的既有重试策略，禁用 SDK 内部重试，避免重试次数叠加。

## 工具接口

`src/lib/diagnosis-tools.ts` 使用 `@langchain/core/tools` 的 `tool()` 定义六个标准工具；`src/lib/diagnosis-tool-schemas.ts` 定义共享的 Trace、规则和证据参数 schema。`createDiagnosisTools()` 返回当前案件的工具集合，每个工具都有名称、描述和 Zod 参数校验，支持普通 `.invoke()` 和标准 ToolCall / ToolMessage 调用。

| 工具名                         | 参数                                | 输出                                               |
| ------------------------------ | ----------------------------------- | -------------------------------------------------- |
| `run_diagnosis_rules`          | Trace；可选图片和已有规则           | 确定性规则结果；图片派生结果保留待核对标记         |
| `read_diagnosis_text_evidence` | 可选附件 ID 列表，最多五个          | 已脱敏的 JSON / TXT / LOG 文本与截断标记           |
| `extract_diagnosis_images`     | 图片附件 ID 列表，最多五个          | 按输入顺序返回图片识别结果，保留失败及无法辨认状态 |
| `search_diagnosis_knowledge`   | 最多八个检索词、可选提供商          | 文档、来源、匹配片段与检索状态                     |
| `generate_diagnosis_report`    | Trace、规则、图片、文本与知识库证据 | 中文结构化报告与提供商独立的思考内容               |
| `validate_diagnosis_evidence`  | 报告及实际证据集合                  | `{ valid: true }`；无效引用抛出错误                |

文件工具仅接受当前案件附件 ID。服务器在加载案件附件后绑定其元数据，解析实际存储路径，检查管理目录、文件类型与脱敏状态；工具参数不能传入文件路径。省略文本附件 ID 时读取当前案件前五份符合条件的文本。重复 ID、跨案件 ID、未批准附件及超出数量上限的输入会被拒绝。模型、推理强度和恢复断点也由服务端绑定，不能通过报告生成工具参数覆盖。

prepare 节点调用文本读取与规则工具，images 节点调用图片识别及图片规则工具，retrieval、model、validate 节点分别调用对应工具。所有工具已实际接入工作流。底层文件读取预算、图片缓存及并发、PGroonga / PostgreSQL 检索、模型重试和报告校验继续复用原实现。知识库不可用时记录降级状态；取消信号传入文件工具与模型工具，取消执行不会被当成普通检索失败而吞掉。

工具当前由明确的工作流节点调度，没有绑定给模型自主选择。证据校验通过仅代表引用存在，结论裁定和人工审核仍在后续流程中执行。将来若需要自主排查，可在模型与工具节点间增加有次数上限的条件循环，并继续保留证据校验和人工审核。

诊断前的请求定位另外提供第七个标准 Tool `search_request_logs`，由 `createRequestLogTool()` 绑定已核对的客户账号与硬筛选条件。独立的 LangGraph 检索图负责线索提取、时间容错、分页预算和候选排序，人工确认后再导入上述诊断流程。详见[时间容错与请求定位](REQUEST_LOCATION.md)。

## 持久化与恢复

持久化沿用 PostgreSQL 的 `diagnosis_runs`、`diagnosis_workflow_steps` 和 pg-boss。相同已完成 job 的重复投递返回已有结果；Worker 中断后重用正在运行的诊断，并复用已保存的模型结果。准备、图片和检索仍会重新执行。当前没有接入 LangGraph checkpointer，`thread_id` 仅标识本次诊断，不代表支持任意节点恢复。

## 验证

`npm run typecheck`、`npm run lint` 和 `npm run test:unit` 包含真实 StateGraph 的状态传递、校验失败拦截、取消行为、六个 Tool 的参数与输出、附件访问范围、标准 ToolCall 格式及百炼适配层契约测试。集成测试使用独立的 `_test` 数据库，覆盖案件锁、重复投递、断点恢复和报告保存。普通测试使用模拟模型响应，不发送真实证据至模型。

框架接口参考：[LangGraph Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api)、[ChatOpenAI](https://docs.langchain.com/oss/javascript/integrations/chat/openai)、[LangChain Tools](https://docs.langchain.com/oss/javascript/langchain/tools)。
