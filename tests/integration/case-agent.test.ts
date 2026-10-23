import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db/client";
import { apiTraces, cases, diagnosisRuns } from "@/db/schema";
import { deleteCases } from "@/lib/delete-cases";
import { runToolAgent } from "@/lib/tool-agent";
import { POST } from "@/app/api/cases/[id]/agent/route";
vi.mock("@/lib/tool-agent", () => ({ runToolAgent: vi.fn() }));
const created: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  if (created.length) await deleteCases(created.splice(0));
});

describe("case agent context (real PostgreSQL)", () => {
  it("binds actual case evidence without changing case status or creating a confirmed diagnosis", async () => {
    const [item] = await db
      .insert(cases)
      .values({ title: "synthetic agent context", status: "completed" })
      .returning({ id: cases.id });
    created.push(item.id);
    await db
      .insert(apiTraces)
      .values({
        caseId: item.id,
        statusCode: 429,
        customerQuestion: "合成排障问题",
        logs: ["Authorization: Bearer synthetic-secret"],
      });
    vi.mocked(runToolAgent).mockImplementationOnce(async ({ messages, tools }) => {
      expect(JSON.stringify(messages)).not.toContain("synthetic-secret");
      expect(tools.some((entry) => entry.name === "search_request_logs")).toBe(false);
      const rules = await tools.find((entry) => entry.name === "run_diagnosis_rules")!.invoke({});
      expect(rules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            evidence: expect.arrayContaining([expect.stringContaining("429")]),
          }),
        ]),
      );
      return {
        answer: "已读取当前案件规则，仍待核对。",
        steps: [{ name: "run_diagnosis_rules", status: "success", summary: "工具执行完成" }],
        toolCalls: 1,
        modelCalls: 2,
        stopReason: "answered",
        reviewRequired: true,
      };
    });
    const response = await POST(
      new Request("http://test/agent", {
        method: "POST",
        body: JSON.stringify({ message: "核对这次请求" }),
      }),
      { params: Promise.resolve({ id: item.id }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ toolCalls: 1, reviewRequired: true });
    expect(await db.select().from(diagnosisRuns).where(eq(diagnosisRuns.caseId, item.id))).toEqual(
      [],
    );
    const [saved] = await db.select().from(cases).where(eq(cases.id, item.id));
    expect(saved.status).toBe("completed");
  });
  it("returns 404 for a missing case before invoking the model", async () => {
    const response = await POST(
      new Request("http://test/agent", {
        method: "POST",
        body: JSON.stringify({ message: "分析" }),
      }),
      { params: Promise.resolve({ id: randomUUID() }) },
    );
    expect(response.status).toBe(404);
    expect(runToolAgent).not.toHaveBeenCalled();
  });
});
