import { describe, expect, it } from "vitest";
import { isManagedStoragePath, storageFilePath } from "@/lib/storage";

describe("isolated storage paths", () => {
  it("uses the configured test root and refuses traversal targets", () => {
    const previous = process.env.STORAGE_ROOT;
    process.env.STORAGE_ROOT = "storage-test";
    try {
      expect(storageFilePath("asset.png")).toBe("storage-test\\asset.png");
      expect(isManagedStoragePath("storage-test/asset.png")).toBe(true);
      expect(isManagedStoragePath("../storage/asset.png")).toBe(false);
    } finally { process.env.STORAGE_ROOT = previous; }
  });
});
