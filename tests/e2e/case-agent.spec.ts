import { test, expect } from "@playwright/test";
import { assertTestDatabase } from "../setup/env";
import { deleteCases } from "../../src/lib/delete-cases";
import { pool } from "../../src/db/client";

assertTestDatabase();
const created: string[] = [];
test.afterEach(async () => {
  if (created.length) await deleteCases(created.splice(0));
});
test.afterAll(async () => {
  await pool.end();
});

test("agent can answer directly and then choose a tool on a follow-up", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/cases", {
    data: { title: "synthetic autonomous agent", trace: { statusCode: 429 } },
  });
  const { id } = await response.json();
  created.push(id);
  await request.post(`/api/cases/${id}/complete`);
  let count = 0;
  await page.route(`**/api/cases/${id}/agent`, (route) => {
    count++;
    return route.fulfill({
      json:
        count === 1
          ? {
              answer: "429 通常表示限流。",
              steps: [],
              modelCalls: 1,
              toolCalls: 0,
              stopReason: "answered",
              reviewRequired: true,
            }
          : {
              answer: "实际规则观察到 429，根因尚需核对。",
              steps: [{ name: "run_diagnosis_rules", status: "success", summary: "工具执行完成" }],
              modelCalls: 2,
              toolCalls: 1,
              stopReason: "answered",
              reviewRequired: true,
            },
    });
  });
  await page.goto(`/cases/${id}`);
  await page.getByLabel("向自主排障助手提问").fill("429 是什么？");
  const first = page.waitForRequest(`**/api/cases/${id}/agent`);
  await page.getByRole("button", { name: "开始自主分析", exact: true }).click();
  expect((await first).postDataJSON().logScope).toBeUndefined();
  await expect(page.getByText("本轮直接回答，未调用工具", { exact: false })).toBeVisible();
  await page.getByLabel("向自主排障助手提问").fill("请检查本案规则。");
  const second = page.waitForRequest(`**/api/cases/${id}/agent`);
  await page.getByRole("button", { name: "开始自主分析", exact: true }).click();
  const body = (await second).postDataJSON();
  expect(body.history).toEqual([
    { role: "user", content: "429 是什么？" },
    { role: "assistant", content: "429 通常表示限流。" },
  ]);
  await page.getByText("查看本轮工具执行记录", { exact: true }).click();
  await expect(page.getByText("检查规则 · 完成 · 工具执行完成", { exact: true })).toBeVisible();
});

test("log lookup requires an explicit scope and changing accounts clears the conversation", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/cases", {
    data: { title: "synthetic agent scope", trace: { statusCode: 429 } },
  });
  const { id } = await response.json();
  created.push(id);
  await request.post(`/api/cases/${id}/complete`);
  await page.route(`**/api/cases/${id}/agent`, (route) =>
    route.fulfill({
      json: {
        answer: "已在 alice 范围内查询，结果待核对。",
        steps: [{ name: "search_request_logs", status: "success", summary: "工具执行完成" }],
        toolCalls: 1,
        modelCalls: 2,
        stopReason: "answered",
        reviewRequired: true,
      },
    }),
  );
  await page.goto(`/cases/${id}`);
  await page.getByText("需要查询 new-api 日志时，先确认客户账号", { exact: true }).click();
  await page.getByLabel("Agent 查询的客户账号").fill("alice");
  await page.getByLabel("已核对该账号，允许 Agent 在此账号范围内查询日志").check();
  await page.getByLabel("向自主排障助手提问").fill("查找昨天的错误请求。");
  const searching = page.waitForRequest(`**/api/cases/${id}/agent`);
  await page.getByRole("button", { name: "开始自主分析", exact: true }).click();
  expect((await searching).postDataJSON().logScope).toMatchObject({
    username: "alice",
    scopeConfirmed: true,
  });
  await expect(
    page.getByText("已在 alice 范围内查询，结果待核对。", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Agent 查询的客户账号").fill("bob");
  await expect(page.getByText("已在 alice 范围内查询，结果待核对。", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByLabel("已核对该账号，允许 Agent 在此账号范围内查询日志"),
  ).not.toBeChecked();
});
