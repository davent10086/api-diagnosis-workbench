import { describe, expect, it } from "vitest";
import { logPageSchema, toWorkbenchLog } from "./new-api-log";

describe("new-api log import", () => {
  it("maps only available evidence and redacts credentials", () => {
    const parsed = logPageSchema.parse({
      success: true,
      data: {
        total: 1,
        items: [{
          request_id: "req-123",
          upstream_request_id: "up-456",
          model_name: "model-a",
          created_at: 1_700_000_000,
          type: 5,
          channel: 7,
          content: "upstream rejected Authorization: Bearer secret-value",
          is_stream: false,
        }],
      },
    });
    const result = toWorkbenchLog(parsed.data.items[0]);
    expect(result.metadata).toEqual({
      model: "model-a",
      requestId: "req-123",
      upstreamRequestId: "up-456",
      occurredAt: "2023-11-14T22:13:20.000Z",
    });
    expect(result.context).toContain("log_type=error");
    expect(result.context).toContain("[已遮蔽]");
    expect(result.context).not.toContain("secret-value");
    expect(result.metadata).not.toHaveProperty("statusCode");
  });
});
