import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { assertTestDatabase } from "../setup/env";
import { db, pool } from "../../src/db/client";
import { diagnosisRuns, evidenceAssets } from "../../src/db/schema";
import { deleteCases } from "../../src/lib/delete-cases";

assertTestDatabase();
const created: string[] = [];
test.afterEach(async () => { if (created.length) await deleteCases(created.splice(0)); });
test.afterAll(async () => { await pool.end(); });

test("uploads WEBP, displays extracted quotes and reasoning, and switches diagnosis history", async ({ request, page }) => {
  const response = await request.post("/api/cases", { data: { title: `browser-${randomUUID()}`, trace: { statusCode: 429, customerQuestion: "合成浏览器测试：核对限流证据" } } });
  expect(response.status()).toBe(201);
  const { id } = await response.json();
  created.push(id);
  const image = await sharp({ create: { width: 120, height: 80, channels: 3, background: "white" } }).webp().toBuffer();
  const upload = await request.post(`/api/cases/${id}/evidence`, { multipart: { file: { name: "browser.webp", mimeType: "image/webp", buffer: image }, evidenceType: "customer_chat" } });
  expect(upload.status()).toBe(201);
  const asset = await upload.json();
  expect(asset.evidenceType).toBe("customer_chat");
  await db.update(evidenceAssets).set({ extraction: { status: "completed", originalName: "browser.webp", fields: ["http_status_code=429"], observations: [{ name: "http_status_code", value: "429", quote: "HTTP 429", location: "顶部" }] } }).where(eq(evidenceAssets.id, asset.id));
  expect((await request.post(`/api/cases/${id}/complete`)).status()).toBe(200);
  const report = { summary: "观察到限流", root_cause: "候选原因仍需核查", confirmed_evidence: [`image:${asset.id}[0]：HTTP 429`], hypotheses: ["可能是配额不足"], missing_evidence: ["补充配额记录"], next_actions: ["核查上游响应"], customer_message: "正在核查", conclusion_status: "provisional" };
  const [oldRun] = await db.insert(diagnosisRuns).values({ caseId: id, model: "qwen3.7-plus", status: "completed", report, createdAt: new Date(Date.now() - 1000) }).returning({ id: diagnosisRuns.id });
  const [newRun] = await db.insert(diagnosisRuns).values({ caseId: id, model: "qwen3.7-plus", status: "completed", report: { ...report, model_reasoning: "合成分析：先核对状态码，再查看配额。\n<script>window.testInjected=true</script>" } }).returning({ id: diagnosisRuns.id });
  const original = await request.get(`/api/cases/${id}/evidence/${asset.id}`);
  expect(original.status()).toBe(200);
  expect(original.headers()["content-type"]).toBe("image/webp");
  expect(await original.body()).toEqual(image);
  await page.goto(`/cases/${id}?run=${newRun.id}`);
  await expect(page.getByRole("heading", { name: "推断过程", exact: true })).toBeVisible();
  await page.getByText("展开思考过程", { exact: true }).click();
  await expect(page.getByText("合成分析：先核对状态码，再查看配额。", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => "testInjected" in window)).toBe(false);
  await page.getByText("查看识别字段（需结合原图核对）", { exact: true }).click();
  await expect(page.getByText("原文：HTTP 429 · 位置：顶部", { exact: true })).toBeVisible();
  await page.locator(`a[href="/cases/${id}?run=${oldRun.id}"]`).click();
  await expect(page.getByText("本次记录没有保存思考内容", { exact: false })).toBeVisible();
  await expect(page.getByText("合成分析：先核对状态码，再查看配额。", { exact: false })).toHaveCount(0);
});

test("rejects invalid uploads and malformed case IDs through HTTP", async ({ request }) => {
  expect((await request.delete("/api/cases/not-a-uuid")).status()).toBe(400);
  const response = await request.post("/api/cases", { data: { title: `validation-${randomUUID()}`, trace: {} } });
  expect(response.status()).toBe(201);
  const { id } = await response.json();
  created.push(id);
  const invalid = await request.post(`/api/cases/${id}/evidence`, { multipart: { file: { name: "bad.png", mimeType: "image/png", buffer: Buffer.from("not an image") } } });
  expect(invalid.status()).toBe(415);
  const malformed = await request.post(`/api/cases/${id}/evidence`, { multipart: { file: { name: "bad.json", mimeType: "application/json", buffer: Buffer.from("{broken") } } });
  expect(malformed.status()).toBe(400);
});
