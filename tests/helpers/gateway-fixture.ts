import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";

type ApiResult = { success?: boolean; message?: string; data?: unknown };
type Page<T> = { items: T[] };
type IdName = { id: number; name?: string; username?: string };

export class GatewayFixture {
  private readonly base = process.env.NEW_API_BASE_URL || "http://127.0.0.1:3000";
  private readonly admin = process.env.NEW_API_ACCESS_TOKEN || "";
  private server?: Server;
  private userId?: number;
  private channelId?: number;
  private tokenId?: number;
  private tokenKey?: string;
  readonly label: string;
  readonly model = "gpt-4o-mini";
  private readonly password = `Q9!${randomBytes(14).toString("hex")}z`;
  requestIds: string[] = [];

  constructor(runId?: string) {
    this.label = runId && /^full-[0-9a-f-]{36}$/.test(runId)
      ? `full${runId.slice(5).replaceAll("-", "").slice(0, 12)}`
      : `full${randomBytes(6).toString("hex")}`;
  }

  private async api(path: string, method = "GET", body?: unknown, access = this.admin): Promise<ApiResult> {
    const response = await fetch(new URL(path, this.base), {
      method,
      headers: { Authorization: `Bearer ${access}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json().catch(() => { throw new Error(`new-api ${method} ${path.split("?")[0]} returned invalid JSON (HTTP ${response.status}).`); }) as ApiResult;
    if (!response.ok || !data.success) throw new Error(`new-api ${method} ${path.split("?")[0]} failed (HTTP ${response.status}): ${String(data.message || "unknown").slice(0, 180)}`);
    return data;
  }

  private async find(path: string, property: "name" | "username", value: string, access = this.admin) {
    const page = (await this.api(path, "GET", undefined, access)).data as Page<IdName>;
    const match = page?.items?.find((item) => item[property] === value);
    if (!match?.id) throw new Error(`Created ${property} was not returned by new-api search at ${path.split("?")[0]}.`);
    return match.id;
  }

  private database(statement: string) {
    const result = spawnSync("docker", ["exec", "new-api-local-db", "psql", "-U", "new_api", "-d", "new_api", "-At", "-v", "ON_ERROR_STOP=1", "-c", statement], { encoding: "utf8" });
    if (result.status !== 0) throw new Error("Local new-api database command failed.");
    return result.stdout.trim();
  }

  async setup() {
    if (!this.admin) throw new Error("NEW_API_ACCESS_TOKEN must be an administrator token.");
    this.server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const mode = String(data.messages?.[0]?.content || "success");
      response.setHeader("content-type", "application/json");
      if (mode.includes("rate-limit")) {
        response.writeHead(429);
        response.end(JSON.stringify({ error: { message: "HTTP 429 Too Many Requests: the request rate exceeded the assigned API rate limit (requests or tokens in a short period).", type: "rate_limit_error", code: "rate_limit_exceeded" } }));
      } else if (mode.includes("upstream-error")) {
        response.writeHead(502);
        response.end(JSON.stringify({ error: { message: "HTTP 502 Bad Gateway: the gateway received an invalid response from an upstream server.", type: "server_error", code: "bad_gateway" } }));
      } else {
        response.writeHead(200);
        response.end(JSON.stringify({ id: `chatcmpl-${this.label}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: this.model, choices: [{ index: 0, message: { role: "assistant", content: "synthetic success" }, finish_reason: "stop" }], usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 } }));
      }
    });
    await new Promise<void>((resolve, reject) => this.server!.listen(0, "0.0.0.0", (error?: Error) => error ? reject(error) : resolve()));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Mock upstream port unavailable.");

    await this.api("/api/user/", "POST", { username: this.label, display_name: this.label, password: this.password, role: 1, quota: 100_000, group: "default" });
    this.userId = await this.find(`/api/user/search?keyword=${this.label}`, "username", this.label);
    await this.api("/api/user/manage", "POST", { id: this.userId, action: "add_quota", mode: "add", value: 1_000_000 });
    this.tokenKey = randomBytes(24).toString("hex");
    this.tokenId = Number(this.database(`INSERT INTO tokens (user_id, "key", status, name, created_time, accessed_time, expired_time, remain_quota, unlimited_quota, "group") VALUES (${this.userId}, '${this.tokenKey}', 1, '${this.label}', EXTRACT(EPOCH FROM NOW())::bigint, EXTRACT(EPOCH FROM NOW())::bigint, -1, 0, true, 'default') RETURNING id`).split(/\s+/)[0]);
    if (!Number.isSafeInteger(this.tokenId) || this.tokenId <= 0) throw new Error("Temporary gateway token was not created.");

    await this.api("/api/channel/", "POST", { mode: "single", channel: {
      type: 1, name: this.label, key: "synthetic-key", base_url: `http://host.docker.internal:${address.port}`,
      models: this.model, group: "default", auto_ban: 0, priority: 100_000,
    } });
    this.channelId = await this.find(`/api/channel/search?keyword=${this.label}`, "name", this.label);
  }

  async request(mode: "success" | "rate-limit" | "upstream-error") {
    if (!this.tokenKey) throw new Error("Gateway fixture token unavailable.");
    const response = await fetch(new URL("/v1/chat/completions", this.base), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.tokenKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, messages: [{ role: "user", content: mode }], stream: false }),
      signal: AbortSignal.timeout(30_000),
    });
    const requestId = response.headers.get("x-oneapi-request-id");
    if (!requestId) throw new Error("Gateway response omitted X-Oneapi-Request-Id.");
    this.requestIds.push(requestId);
    if (mode === "success" && response.status !== 200) {
      const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(`Gateway success request returned HTTP ${response.status}: ${String(body.error?.message || "unknown").slice(0, 180)}`);
    }
    if (mode !== "success" && response.status < 400) throw new Error(`Gateway error request unexpectedly returned HTTP ${response.status}.`);
    return requestId;
  }

  async recover() {
    const users = (await this.api(`/api/user/search?keyword=${this.label}`)).data as Page<IdName>;
    this.userId = users?.items?.find((item) => item.username === this.label)?.id ?? this.userId;
    const channels = (await this.api(`/api/channel/search?keyword=${this.label}`)).data as Page<IdName>;
    this.channelId = channels?.items?.find((item) => item.name === this.label)?.id ?? this.channelId;
    const tokenId = this.database(`SELECT id FROM tokens WHERE name = '${this.label}' ORDER BY id DESC LIMIT 1`).split(/\s+/)[0];
    if (tokenId) this.tokenId = Number(tokenId);
  }

  async dispose() {
    const errors: string[] = [];
    const remove = async (path: string, access = this.admin) => {
      try { await this.api(path, "DELETE", undefined, access); }
      catch (error) { errors.push(error instanceof Error ? error.message : "cleanup failed"); }
    };
    if (this.channelId) await remove(`/api/channel/${this.channelId}`);
    if (this.tokenId) {
      try { this.database(`DELETE FROM tokens WHERE id = ${this.tokenId} AND name = '${this.label}'`); }
      catch { errors.push("Gateway token cleanup failed."); }
    }
    if (this.userId) await remove(`/api/user/${this.userId}`);
    if (this.requestIds.some((id) => !/^[A-Za-z0-9_-]{16,80}$/.test(id))) errors.push("Unsafe gateway Request ID; log cleanup refused.");
    else {
      try {
        const requestIds = this.requestIds.length ? ` OR request_id IN (${this.requestIds.map((id) => `'${id}'`).join(",")})` : "";
        this.database(`DELETE FROM logs WHERE username = '${this.label}' OR token_name = '${this.label}'${requestIds}`);
        this.database(`DELETE FROM audit_logs WHERE username = '${this.label}' OR content LIKE '%${this.label}%' OR other::text LIKE '%${this.label}%'`);
      } catch { errors.push("Gateway log cleanup failed; check the local new-api database container."); }
    }
    if (this.server) await promisify(this.server.close.bind(this.server))();
    if (errors.length) throw new Error(errors.join("; "));
  }
}
