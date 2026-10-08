import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { prepareVisionImages } from "./vision-images";

describe("screenshot preparation", () => {
  it("enlarges small screenshots without changing the original bytes", async () => {
    const data = await sharp({ create: { width: 600, height: 820, channels: 3, background: "white" } }).png().toBuffer();
    const original = Buffer.from(data);
    const result = await prepareVisionImages(data);
    expect(result.images).toHaveLength(1);
    expect((await sharp(result.images[0].data).metadata()).width).toBe(1200);
    expect(data).toEqual(original);
  });
  it("tiles long screenshots with overlap and reports omitted regions", async () => {
    const data = await sharp({ create: { width: 300, height: 6000, channels: 3, background: "white" } }).png().toBuffer();
    const result = await prepareVisionImages(data);
    expect(result.images).toHaveLength(8);
    expect(result.warnings.join(" ")).toContain("末尾区域未识别");
    expect((await sharp(result.images[0].data).metadata()).height).toBeLessThanOrEqual(1800);
  });
  it("rejects files that contain a signature but cannot decode as images", async () => {
    await expect(prepareVisionImages(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).rejects.toThrow();
  });
});
