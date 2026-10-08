import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { cases, evidenceAssets } from "@/db/schema";
import { POST } from "@/app/api/cases/[id]/evidence/route";
import { GET } from "@/app/api/cases/[id]/evidence/[assetId]/route";
import { deleteCases } from "@/lib/delete-cases";

describe("image upload and review", () => {
  const created: string[] = [];
  afterEach(async () => { if (created.length) await deleteCases(created); created.length = 0; });
  it("preserves the user evidence category and serves the original WEBP only for its case", async () => {
    const [item] = await db.insert(cases).values({ title: "image review" }).returning({ id: cases.id });
    const [other] = await db.insert(cases).values({ title: "other case" }).returning({ id: cases.id });
    created.push(item.id, other.id);
    const data = Uint8Array.from(Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=", "base64"));
    const form = new FormData();
    form.set("file", new File([data], "customer.webp", { type: "image/webp" }));
    form.set("evidenceType", "customer_chat");
    const response = await POST(new Request("http://test", { method: "POST", body: form }) as never, { params: Promise.resolve({ id: item.id }) });
    expect(response.status).toBe(201);
    const body = await response.json() as { id: string; evidenceType: string };
    expect(body.evidenceType).toBe("customer_chat");
    const [saved] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, body.id));
    expect(saved.extraction).toMatchObject({ originalName: "customer.webp", mimeType: "image/webp" });
    const original = await GET(new Request("http://test"), { params: Promise.resolve({ id: item.id, assetId: body.id }) });
    expect(original.headers.get("Content-Type")).toBe("image/webp");
    expect(Buffer.from(await original.arrayBuffer())).toEqual(Buffer.from(data));
    expect((await GET(new Request("http://test"), { params: Promise.resolve({ id: other.id, assetId: body.id }) })).status).toBe(404);
  });
});
