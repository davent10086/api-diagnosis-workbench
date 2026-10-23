import { describe, expect, it, vi } from "vitest";
import {
  consumeModelRequestBudget,
  modelRequestBudgetRemaining,
  withModelRequestBudget,
} from "./model-budget";
import { createAgentModel } from "./tool-agent";
import { HumanMessage } from "@langchain/core/messages";
import { openAICompatibleCompletion } from "./diagnosis-model";

describe("per-turn total model request budget", () => {
  it("enforces a shared budget across nested calls", async () => {
    await withModelRequestBudget(2, async (budget) => {
      consumeModelRequestBudget();
      await Promise.resolve();
      consumeModelRequestBudget();
      expect(modelRequestBudgetRemaining()).toBe(0);
      expect(budget.used).toBe(2);
      expect(consumeModelRequestBudget).toThrow("预算已用完");
      expect(budget.used).toBe(2);
    });
    expect(modelRequestBudgetRemaining()).toBe(Infinity);
  });
  it("isolates concurrent turns rather than sharing a global counter", async () => {
    const used = await Promise.all(
      [1, 2].map((limit) =>
        withModelRequestBudget(limit, async (budget) => {
          for (let i = 0; i < limit; i++) {
            await Promise.resolve();
            consumeModelRequestBudget();
          }
          return budget.used;
        }),
      ),
    );
    expect(used).toEqual([1, 2]);
  });
  it("stops decision requests after inner tools have exhausted the total budget", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "test-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await withModelRequestBudget(1, async () => {
        consumeModelRequestBudget();
        const result = await createAgentModel([]).invoke([new HumanMessage("继续")], {
          allowTools: true,
        });
        expect(result.additional_kwargs.budget_exhausted).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
      });
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
  it("counts provider retries made inside tools against the same total budget", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "test-key");
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ error: { code: "Throttling", message: "rate limited" } }, { status: 429 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await withModelRequestBudget(1, async (budget) => {
        await expect(
          openAICompatibleCompletion("qwen3.7-plus", [{ role: "user", content: "合成测试" }], {}),
        ).rejects.toThrow("模型请求预算已用完");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(budget.used).toBe(1);
      });
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});
