import { test, expect } from "@playwright/test";
import type { LocationResult } from "../../src/lib/request-location-types";

const result: LocationResult = {
  status: "incomplete",
  username: "alice",
  originalTime: "2026-10-22 18:30",
  interpretedTime: "2026-10-22T10:30:00.000Z",
  timezoneOffsetMinutes: 480,
  clues: [{ field: "username", value: "alice", reliability: "confirmed", source: "operator" }],
  rounds: [
    {
      start: 1792663200,
      end: 1792670400,
      label: "可能混淆上午与下午",
      page: 1,
      fetched: 1,
      total: 101,
      complete: false,
    },
  ],
  candidates: [
    {
      requestId: "req-located",
      upstreamRequestId: "up-a",
      model: "claude-sonnet",
      channel: 2,
      occurredAt: "2026-10-21T22:30:00.000Z",
      timestamp: 1792621800,
      content: "HTTP 429",
      isStream: true,
      useTime: 2,
      type: 5,
      score: 30,
      matches: ["模型匹配：claude", "错误内容包含：429"],
      conflicts: ["与客户时间相差 -720 分钟"],
      timeDifferenceMinutes: -720,
      imported: {
        metadata: {
          requestId: "req-located",
          upstreamRequestId: "up-a",
          model: "claude-sonnet",
          occurredAt: "2026-10-21T22:30:00.000Z",
        },
        context: "new-api request_id=req-located\ncontent=HTTP 429",
      },
    },
  ],
  groups: [],
  followUp: "请核对实际时间和错误内容，确认是否为该次请求。",
  notices: ["仅覆盖部分日志，不能认定没有其他候选。"],
  scanned: 1,
  requests: 1,
  stopReason: "budget",
};

test("locates and confirms a candidate while preserving the original question and a separate request review", async ({
  page,
}) => {
  await page.route("**/api/integrations/new-api/search", (route) =>
    route.fulfill({ json: result }),
  );
  await page.route("**/api/cases/workbench", (route) =>
    route.fulfill({ json: { id: "locator-test" }, status: 201 }),
  );
  await page.route("**/api/cases/locator-test/complete", (route) =>
    route.fulfill({ json: { success: true } }),
  );
  await page.goto("/cases/new");
  const question = "客户说昨天下午 claude 返回429，时间可能记错。";
  await page.locator("textarea").first().fill(question);
  await page.getByRole("button", { name: "时间不准或没有 Request ID？按特征查找" }).click();
  await page.getByLabel("已确认的客户账号", { exact: true }).fill("alice");
  await page.getByLabel("客户原始时间（可不准确）").fill("2026-10-22 18:30");
  const locate = page.getByRole("button", { name: "按特征定位请求", exact: true });
  await expect(locate).toBeDisabled();
  await page.getByLabel("已核对客户账号；所有查询固定在该账号范围内").check();
  const searching = page.waitForRequest("**/api/integrations/new-api/search");
  await locate.click();
  expect((await searching).postDataJSON()).toMatchObject({
    username: "alice",
    scopeConfirmed: true,
    question,
  });
  await expect(page.getByText("检索未完成，以下仅为部分结果", { exact: true })).toBeVisible();
  await expect(page.getByText("需核对：与客户时间相差 -720 分钟", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认此请求并导入" }).click();
  await expect(page.getByRole("button", { name: "已确认并导入" })).toBeDisabled();
  const saving = page.waitForRequest("**/api/cases/workbench");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  const payload = (await saving).postDataJSON();
  expect(payload.question).toBe(question);
  expect(payload.metadata).toMatchObject({
    requestId: "req-located",
    occurredAt: "2026-10-21T22:30:00.000Z",
    statusCode: "",
  });
  const audit = JSON.parse(payload.advanced.context.split("request_location_review=")[1]);
  expect(audit).toMatchObject({
    locationStatus: "human_confirmed",
    rootCauseConfirmed: false,
    originalTime: "2026-10-22 18:30",
    searchStatus: "incomplete",
  });
  expect(audit.rounds).toHaveLength(1);
});

test("changing the customer account invalidates candidates and requires scope confirmation again", async ({
  page,
}) => {
  await page.route("**/api/integrations/new-api/search", (route) =>
    route.fulfill({ json: result }),
  );
  await page.goto("/cases/new");
  await page.getByRole("button", { name: "时间不准或没有 Request ID？按特征查找" }).click();
  await page.getByLabel("已确认的客户账号", { exact: true }).fill("alice");
  await page.getByLabel("已核对客户账号；所有查询固定在该账号范围内").check();
  await page.getByRole("button", { name: "按特征定位请求", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认此请求并导入" })).toBeVisible();
  await page.getByLabel("已确认的客户账号", { exact: true }).fill("bob");
  await expect(page.getByRole("button", { name: "确认此请求并导入" })).toHaveCount(0);
  await expect(page.getByLabel("已核对客户账号；所有查询固定在该账号范围内")).not.toBeChecked();
  await expect(page.getByRole("button", { name: "按特征定位请求", exact: true })).toBeDisabled();
});
