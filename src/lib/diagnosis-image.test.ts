import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractImage, extractImages } from "./diagnosis-image";
import { IMAGE_EXTRACTION_VERSION } from "./image-evidence";
import { openAICompatibleCompletion } from "./diagnosis-model";
import { readFile } from "node:fs/promises";

const saved = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("./vision-images", () => ({ prepareVisionImages: vi.fn(async (data: Buffer) => ({ images: [{ data, mime: "image/png", label: "整图" }], warnings: [] })) }));
vi.mock("@/db/client", () => ({ db: { update: () => ({ set: saved }) } }));
vi.mock("./diagnosis-model", async (original) => ({ ...await original<typeof import("./diagnosis-model")>(), openAICompatibleCompletion: vi.fn() }));

const asset = { id: "image-a", filePath: "screenshot.png", extraction: { originalName: "客户截图.png", mimeType: "image/png", size: 10 } };
const response = JSON.stringify({ summary: "错误截图", fields: [{ name: "http_status_code", value: 429, quote: "HTTP 429", location: "顶部" }] });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readFile).mockResolvedValue(Buffer.from("image"));
  vi.mocked(openAICompatibleCompletion).mockResolvedValue(response);
  saved.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
});

describe("image extraction lifecycle", () => {
  it("retains upload metadata and records cache provenance", async () => {
    const result = await extractImage(asset);
    expect(result.status).toBe("completed");
    expect(saved).toHaveBeenCalledWith({ extraction: expect.objectContaining({ originalName: "客户截图.png", mimeType: "image/png", size: 10, version: IMAGE_EXTRACTION_VERSION, fileHash: createHash("sha256").update("image").digest("hex") }) });
  });
  it("reuses a matching cache but refreshes changed images, models and prompt versions", async () => {
    const result = await extractImage(asset);
    vi.mocked(openAICompatibleCompletion).mockClear();
    await extractImage({ ...asset, extraction: result });
    expect(openAICompatibleCompletion).not.toHaveBeenCalled();
    for (const change of [{ version: "old" }, { model: "old-model" }, { fileHash: "old-hash" }]) {
      await extractImage({ ...asset, extraction: { ...result, ...change } });
    }
    expect(openAICompatibleCompletion).toHaveBeenCalledTimes(3);
  });
  it("marks empty results unreadable and preserves metadata on failures", async () => {
    vi.mocked(openAICompatibleCompletion).mockResolvedValueOnce('{"summary":"","fields":[]}');
    expect((await extractImage(asset)).status).toBe("unreadable");
    vi.mocked(openAICompatibleCompletion).mockRejectedValueOnce(new Error("upstream failed"));
    expect((await extractImage(asset)).status).toBe("failed");
    expect(saved).toHaveBeenLastCalledWith({ extraction: expect.objectContaining({ originalName: "客户截图.png", status: "failed" }) });
  });
  it("propagates cancellation without overwriting stored extraction", async () => {
    const controller = new AbortController();
    vi.mocked(openAICompatibleCompletion).mockImplementationOnce(async () => { controller.abort(); throw new DOMException("cancelled", "AbortError"); });
    await expect(extractImage(asset, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(saved).not.toHaveBeenCalled();
  });
  it("keeps results aligned with image IDs even if requests finish out of order", async () => {
    vi.mocked(openAICompatibleCompletion).mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(response), 15))).mockResolvedValueOnce('{"summary":"另一张图","fields":["request_id=second"]}');
    const result = await extractImages([asset, { ...asset, id: "image-b" }], 2);
    expect(result[0].fields).toEqual(["http_status_code=429"]);
    expect(result[1].fields).toEqual(["request_id=second"]);
  });
});
