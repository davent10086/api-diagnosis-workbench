import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { assertNotAborted, diagnosisModelConfig } from "./diagnosis-model";
import { redact, redactValue } from "./redaction";
import { consumeModelRequestBudget, modelRequestBudgetRemaining } from "./model-budget";

export type AgentStep = { name: string; status: "success" | "error" | "blocked"; summary: string };
export type AgentModel = {
  invoke: (
    messages: BaseMessage[],
    options: { signal?: AbortSignal; allowTools: boolean },
  ) => Promise<AIMessage>;
};
export type AgentResult = {
  answer: string;
  steps: AgentStep[];
  modelCalls: number;
  toolCalls: number;
  stopReason: "answered" | "budget";
  reviewRequired: true;
  modelRequests?: number;
};
const MAX_MODEL_CALLS = 6,
  MAX_TOOL_CALLS = 8;

export function createAgentModel(tools: StructuredToolInterface[]): AgentModel {
  const { apiKey, baseUrl } = diagnosisModelConfig();
  const model = process.env.QWEN_ANALYSIS_MODEL || "qwen3.7-plus";
  const llm = new ChatOpenAI({
    apiKey,
    model,
    streaming: false,
    useResponsesApi: false,
    maxRetries: 0,
    modelKwargs: /^(?:qwen3[.-]|qwen-(?:plus|flash|turbo)(?:-|$))/.test(model)
      ? { enable_thinking: false }
      : {},
    configuration: { baseURL: baseUrl },
  });
  return {
    invoke: async (messages, { signal, allowTools }) => {
      if (modelRequestBudgetRemaining() === 0)
        return new AIMessage({
          content:
            "本轮模型请求预算已用完，包含工具内部的报告生成或重试。请缩小问题范围后继续，当前判断尚待核对。",
          additional_kwargs: { budget_exhausted: true },
        });
      consumeModelRequestBudget();
      return await llm
        .bindTools(tools, { tool_choice: allowTools ? "auto" : "none", parallel_tool_calls: false })
        .invoke(messages, {
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(90000)])
            : AbortSignal.timeout(90000),
          runName: "autonomous_diagnosis_model",
        });
    },
  };
}

const State = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  steps: Annotation<AgentStep[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  modelCalls: Annotation<number>({ reducer: (left, right) => left + right, default: () => 0 }),
  toolCalls: Annotation<number>({ reducer: (left, right) => left + right, default: () => 0 }),
  answer: Annotation<string>(),
  stopReason: Annotation<"answered" | "budget">(),
});

export async function runToolAgent(options: {
  messages: BaseMessage[];
  tools: StructuredToolInterface[];
  signal?: AbortSignal;
  model?: AgentModel;
}): Promise<AgentResult> {
  const { tools, signal } = options;
  assertNotAborted(signal);
  const model = options.model ?? createAgentModel(tools);
  const byName = new Map(tools.map((entry) => [entry.name, entry]));
  if (byName.size !== tools.length) throw new Error("工具名称不可重复。");
  const graph = new StateGraph(State)
    .addNode("think", async (state) => {
      assertNotAborted(signal);
      const allowTools = state.toolCalls < MAX_TOOL_CALLS && state.modelCalls < MAX_MODEL_CALLS - 1;
      const response = await model.invoke(state.messages, { signal, allowTools });
      assertNotAborted(signal);
      if (response.invalid_tool_calls?.length)
        throw new Error("模型返回了无法解析的工具参数，请重试。");
      const calls = response.tool_calls ?? [];
      if (
        calls.length &&
        (!allowTools ||
          calls.length > MAX_TOOL_CALLS ||
          calls.some((call) => !call.id) ||
          new Set(calls.map((call) => call.id)).size !== calls.length)
      ) {
        return {
          modelCalls: 1,
          answer:
            "本轮工具调用已达到上限或模型返回了无效调用。请缩小问题范围后重试；现有输出尚需人工核对。",
          stopReason: "budget" as const,
        };
      }
      if (calls.length) return { messages: [response], modelCalls: 1 };
      const answer =
        typeof response.content === "string"
          ? response.content
          : response.content
              .flatMap((item) => ("text" in item ? [String(item.text)] : []))
              .join("\n");
      if (!answer.trim()) throw new Error("模型既未选择工具，也未返回有效回答，请重试。");
      return {
        messages: [response],
        modelCalls: 1,
        answer: redact(answer).slice(0, 12000),
        stopReason:
          allowTools && !response.additional_kwargs.budget_exhausted
            ? ("answered" as const)
            : ("budget" as const),
      };
    })
    .addNode("act", async (state) => {
      const last = state.messages.at(-1) as AIMessage;
      const messages: ToolMessage[] = [],
        steps: AgentStep[] = [];
      let attempted = 0;
      for (const call of last.tool_calls ?? []) {
        assertNotAborted(signal);
        const entry = byName.get(call.name);
        const blocked = state.toolCalls + attempted >= MAX_TOOL_CALLS || !entry;
        if (blocked) {
          messages.push(
            new ToolMessage({
              tool_call_id: call.id!,
              name: call.name,
              status: "error",
              content: "工具未开放或调用预算已用完；不得声称已执行。",
            }),
          );
          steps.push({
            name: call.name,
            status: "blocked",
            summary: "工具未开放或本轮调用预算已用完",
          });
          attempted += state.toolCalls + attempted < MAX_TOOL_CALLS ? 1 : 0;
          continue;
        }
        attempted++;
        try {
          // Invoke with plain arguments so only this executor constructs trusted
          // ToolMessages; tools cannot bypass the execution log or output budget.
          const output: unknown = await entry.invoke(call.args, { signal });
          assertNotAborted(signal);
          const json = JSON.stringify(redactValue(output)) ?? "null";
          const content =
            json.length <= 12000
              ? json
              : JSON.stringify({
                  truncated: true,
                  preview: json.slice(0, 10000),
                  note: "仅截短模型可见的工具预览，服务端实际证据仍保留。",
                });
          messages.push(
            new ToolMessage({
              tool_call_id: call.id!,
              name: call.name,
              content,
              status: "success",
            }),
          );
          steps.push({ name: call.name, status: "success", summary: "工具执行完成" });
        } catch {
          assertNotAborted(signal);
          messages.push(
            new ToolMessage({
              tool_call_id: call.id!,
              name: call.name,
              content:
                "工具调用失败或参数不符合约束。没有新增可确认事实；请调整参数或向用户索取信息。",
              status: "error",
            }),
          );
          steps.push({ name: call.name, status: "error", summary: "调用失败或参数校验未通过" });
        }
      }
      return { messages, steps, toolCalls: attempted };
    })
    .addEdge(START, "think")
    .addConditionalEdges("think", (state) => (state.answer ? END : "act"))
    .addEdge("act", "think")
    .compile();
  const result = await graph.invoke(
    { messages: options.messages },
    { signal, recursionLimit: 16, runName: "autonomous_diagnosis_agent" },
  );
  return {
    answer: result.answer,
    steps: result.steps,
    modelCalls: result.modelCalls,
    toolCalls: result.toolCalls,
    stopReason: result.stopReason,
    reviewRequired: true,
  };
}
