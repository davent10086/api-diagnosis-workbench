import { describe, expect, it } from "vitest";
import { knowledgeQueries } from "./diagnosis-retrieval";
import { fuseKnowledgeResults, matchedExcerpt } from "./knowledge-ranking";
import { runRules } from "./rules";

describe("diagnosis search clues", () => {
  it("preserves late errors, numeric status and exact tools despite generic request fields", () => {
    const trace = {
      provider: "aws", route: "bedrock", statusCode: 400,
      clientRequest: { model: "claude", messages: [{ role: "user", content: "hello" }], tools: [{ type: "web_search_20250305" }] },
      upstreamResponse: { error: { type: "ValidationException", message: "tool is not supported" } },
      logs: ["x".repeat(250) + " ThrottlingException 429"],
    };
    const queries = knowledgeQueries(trace, runRules(trace), []).map((q) => q.value);
    expect(queries).toEqual(expect.arrayContaining(["400", "429", "ValidationException", "ThrottlingException", "web_search_20250305"]));
    expect(queries).not.toEqual(expect.arrayContaining(["error"]));
    expect(queries.length).toBeLessThanOrEqual(8);
    expect(knowledgeQueries({ statusCode: 429 }, [], []).map((q) => q.value)).toContain("429");
  });

  it("ignores credentials in objects and text without losing errors on other lines", () => {
    const queries = knowledgeQueries({ clientRequest: { authorization: "Bearer privatecredential", api_key: "secretcredential" }, logs: ["Authorization: Bearer anothercredential\nValidationException"] }, [], []);
    expect(queries.map((q) => q.value)).toContain("ValidationException");
    expect(JSON.stringify(queries)).not.toMatch(/privatecredential|secretcredential|anothercredential/);
  });

  it("retains image summaries and a model clue among many JSON fields", () => {
    const queries = knowledgeQueries({ model: "qwen3.7-plus", clientRequest: { ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field_${i}`, "value"])), tools: [{ type: "web_search_20250305" }] } }, [], [{ status: "completed", summary: "ValidationException" }]);
    expect(queries.map((q) => q.value)).toEqual(expect.arrayContaining(["qwen3.7-plus", "ValidationException", "web_search_20250305"]));
    expect(queries.find((q) => q.value === "qwen3.7-plus")?.kind).toBe("model");
  });
});

const hit = (id: string, body = id) => ({ id, title: id, body, sourceUrl: `https://example.com/${id}`, score: 100 });

describe("retrieval fusion and model excerpts", () => {
  it("includes later queries rather than filling the budget from the first query", () => {
    const result = fuseKnowledgeResults([Array.from({ length: 12 }, (_, i) => hit(`generic-${i}`)), [hit("specific")]], ["generic", "specific"]);
    expect(result.map((h) => h.id)).toContain("specific");
    expect(result).toHaveLength(5);
  });

  it("promotes independent corroboration and deduplicates repeated source sections", () => {
    const shared = hit("shared");
    const result = fuseKnowledgeResults([[hit("first"), shared, shared], [hit("second"), { ...shared, id: "duplicate-id" }]], ["first", "second"]);
    expect(result[0].title).toBe("shared");
    expect(result.filter((h) => h.title === "shared")).toHaveLength(1);
  });

  it("passes a late exact identifier through the complete clue-to-excerpt chain", () => {
    const trace = { statusCode: 400, upstreamResponse: { error: { type: "ValidationException" } }, clientRequest: { tools: [{ type: "web_search_20250305" }] } };
    const queries = knowledgeQueries(trace, runRules(trace), []).map((q) => q.value);
    const body = "background ".repeat(250) + "ValidationException: web_search_20250305 is unsupported on this endpoint.";
    const specific = hit("endpoint-compatibility", body);
    const result = fuseKnowledgeResults(queries.map((q) => body.includes(q) ? [specific] : []), queries);
    expect(result[0].excerpt).toContain("web_search_20250305");
    expect(result[0].excerpt).toContain("ValidationException");
    expect(result[0].excerpt.length).toBeLessThanOrEqual(1200);
  });

  it("centers on exact identifiers before common expanded words", () => {
    const body = "web search ".repeat(250) + "web_search_20250305 is not supported";
    expect(matchedExcerpt(body, ["web_search_20250305"])).toContain("web_search_20250305");
    expect(matchedExcerpt("short document", ["missing"])).toBe("short document");
  });
});
