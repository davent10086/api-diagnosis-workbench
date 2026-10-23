import { afterEach, describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createAgentModel, runToolAgent } from "./tool-agent";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const messages = [new HumanMessage("请按需要分析。")];
const call = (name: string, id = "call-1", args: Record<string, unknown> = {}) =>
  new AIMessage({ content: "", tool_calls: [{ name, id, args, type: "tool_call" }] });

describe("autonomous tool graph", () => {
  it("allows a direct answer without executing any tools", async () => {
    const execute = vi.fn(async () => ({ result: "unused" }));
    const tools = [
      tool(execute, { name: "inspect", description: "检查证据", schema: z.object({}) }),
    ];
    const invoke = vi.fn().mockResolvedValue(new AIMessage("429 通常表示限流，具体来源仍需核对。"));
    const result = await runToolAgent({ messages, tools, model: { invoke } });
    expect(result).toMatchObject({
      toolCalls: 0,
      modelCalls: 1,
      steps: [],
      stopReason: "answered",
      reviewRequired: true,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(invoke.mock.calls[0][1].allowTools).toBe(true);
  });
  it("executes only model-selected tools and lets the model finish after observing results", async () => {
    const inspect = vi.fn(async () => ({ status: 429 })),
      unused = vi.fn();
    const tools = [
      tool(inspect, { name: "inspect", description: "检查证据", schema: z.object({}) }),
      tool(unused, { name: "unused", description: "无需调用", schema: z.object({}) }),
    ];
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(call("inspect"))
      .mockResolvedValueOnce(new AIMessage("读取到 429，仍需核对来源。"));
    const result = await runToolAgent({ messages, tools, model: { invoke } });
    expect(result.toolCalls).toBe(1);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(unused).not.toHaveBeenCalled();
    expect(invoke.mock.calls[1][0].at(-1)).toBeInstanceOf(ToolMessage);
    expect(result.steps).toEqual([{ name: "inspect", status: "success", summary: "工具执行完成" }]);
  });
  it("returns unknown tool and validation failures as observations instead of executing arbitrary code", async () => {
    const execute = vi.fn();
    const tools = [
      tool(execute, {
        name: "inspect",
        description: "检查证据",
        schema: z.object({ id: z.string() }).strict(),
      }),
    ];
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(call("shell"))
      .mockResolvedValueOnce(call("inspect", "call-2", { id: 42 }))
      .mockResolvedValueOnce(new AIMessage("工具未能完成，需要补充信息。"));
    const result = await runToolAgent({ messages, tools, model: { invoke } });
    expect(result.steps.map((step) => step.status)).toEqual(["blocked", "error"]);
    expect(execute).not.toHaveBeenCalled();
    expect(result.toolCalls).toBe(2);
  });
  it("bounds the total calls across tool batches and forces the final response to disable tools", async () => {
    const execute = vi.fn(async () => "完成");
    const tools = [
      tool(execute, { name: "inspect", description: "检查证据", schema: z.object({}) }),
    ];
    const batch = (prefix: string) =>
      new AIMessage({
        content: "",
        tool_calls: Array.from({ length: 5 }, (_, index) => ({
          name: "inspect",
          id: `${prefix}-${index}`,
          args: {},
          type: "tool_call" as const,
        })),
      });
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(batch("first"))
      .mockResolvedValueOnce(batch("second"))
      .mockResolvedValueOnce(new AIMessage("已达预算，仅能给出初步判断。"));
    const result = await runToolAgent({ messages, tools, model: { invoke } });
    expect(execute).toHaveBeenCalledTimes(8);
    expect(result.toolCalls).toBe(8);
    expect(result.steps.filter((step) => step.status === "blocked")).toHaveLength(2);
    expect(invoke.mock.calls[2][1].allowTools).toBe(false);
    expect(result.stopReason).toBe("budget");
  });
  it("caps repeated model turns at six even when the provider ignores tool_choice none", async () => {
    const execute = vi.fn(async () => "完成");
    const tools = [
      tool(execute, { name: "inspect", description: "检查证据", schema: z.object({}) }),
    ];
    const invoke = vi.fn().mockImplementation(async () => call("inspect"));
    const result = await runToolAgent({ messages, tools, model: { invoke } });
    expect(invoke).toHaveBeenCalledTimes(6);
    expect(execute).toHaveBeenCalledTimes(5);
    expect(result.stopReason).toBe("budget");
  });
  it("never exposes raw tool errors or secrets to the model and limits large tool previews", async () => {
    const tools = [
      tool(
        async () => {
          throw new Error("Authorization: Bearer private-server-token");
        },
        { name: "fail", description: "失败", schema: z.object({}) },
      ),
      tool(async () => ({ content: "x".repeat(20000), secret: "private" }), {
        name: "large",
        description: "大结果",
        schema: z.object({}),
      }),
    ];
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(call("fail"))
      .mockResolvedValueOnce(call("large", "call-2"))
      .mockResolvedValueOnce(new AIMessage("需要核对。"));
    await runToolAgent({ messages, tools, model: { invoke } });
    const seen = invoke.mock.calls[2][0];
    expect(JSON.stringify(seen)).not.toContain("private-server-token");
    const last = seen.at(-1) as ToolMessage;
    expect(String(last.content).length).toBeLessThan(12000);
    expect(JSON.parse(String(last.content)).truncated).toBe(true);
  });
  it("propagates cancellation without executing the next tool", async () => {
    const controller = new AbortController();
    const execute = vi.fn();
    const invoke = vi.fn(async () => {
      controller.abort();
      return call("inspect");
    });
    await expect(
      runToolAgent({
        messages,
        tools: [tool(execute, { name: "inspect", description: "检查", schema: z.object({}) })],
        model: { invoke },
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("agent model provider contract", () => {
  it("advertises tools using automatic selection and supports a no-tool response", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "test-key");
    vi.stubEnv("OPENAI_COMPAT_BASE_URL", "https://example.test/v1");
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "可以直接解释，无需工具。" },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const model = createAgentModel([
      tool(async () => "完成", {
        name: "inspect",
        description: "检查案件证据",
        schema: z.object({}),
      }),
    ]);
    await expect(model.invoke(messages, { allowTools: true })).resolves.toBeInstanceOf(AIMessage);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload).toMatchObject({
      tool_choice: "auto",
      parallel_tool_calls: false,
      enable_thinking: false,
      tools: [{ type: "function", function: { name: "inspect", description: "检查案件证据" } }],
    });
    await model.invoke(messages, { allowTools: false });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).tool_choice).toBe("none");
  });
  it("parses real provider tool_calls and feeds tool observations back on the next request", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "test-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-provider",
                    type: "function",
                    function: { name: "inspect", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "证据已读取，仍需人工核对。" },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await runToolAgent({
      messages,
      tools: [
        tool(async () => ({ status: 429 }), {
          name: "inspect",
          description: "检查证据",
          schema: z.object({}),
        }),
      ],
    });
    expect(result.toolCalls).toBe(1);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call-provider",
      content: '{"status":429}',
    });
  });
});
