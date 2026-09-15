import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { configuredApiOrigin, requestIdentity, type McpIdentity } from "./security.js";

export type Env = Cloudflare.Env;
type ApiFailure = Error & { status?: number; code?: string };

function apiError(status: number, code?: string): ApiFailure {
  const known = code && /^[a-z0-9_]{1,80}$/i.test(code) ? code : "request_failed";
  const error = new Error(`Chusky request failed (HTTP ${status}; ${known}). Check API-key scopes, user identity, and workspace policy.`) as ApiFailure;
  error.status = status;
  error.code = known;
  return error;
}

async function chusky<T>(env: Env, identity: McpIdentity, path: string, init: RequestInit = {}): Promise<T> {
  const origin = configuredApiOrigin(env.CHUSKY_API_ORIGIN);
  if (!origin) throw new Error("Chusky API origin is not configured as a trusted HTTPS origin.");
  if (!path.startsWith("/v1/") || path.startsWith("//") || path.includes("\\")) throw new Error("Invalid internal Chusky API path.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${identity.apiKey}`);
  headers.set("X-Chusky-User-Id", identity.userId);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(new URL(path, origin), { ...init, headers, redirect: "error" });
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error("Chusky returned a response larger than the MCP limit.");
  let data: unknown;
  try { data = text ? JSON.parse(text) : undefined; } catch { throw new Error("Chusky returned an invalid JSON response."); }
  if (!response.ok) {
    const body = data as { error?: { code?: unknown } } | undefined;
    throw apiError(response.status, typeof body?.error?.code === "string" ? body.error.code : undefined);
  }
  return data as T;
}

function result(value: unknown) {
  let text = JSON.stringify(value);
  if (text.length > 24_000) text = `${text.slice(0, 23_900)}… [truncated; request a narrower result]`;
  return { content: [{ type: "text" as const, text }] };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Chusky operation failed.";
  return { isError: true, content: [{ type: "text" as const, text: message.slice(0, 500) }] };
}

function jsonBody(value: unknown): string { return JSON.stringify(value); }
function key(base: string | undefined, suffix: string): string {
  return `${base ?? crypto.randomUUID()}:${suffix}`.slice(0, 255);
}

function createServer(env: Env, identity: McpIdentity): McpServer {
  const server = new McpServer({ name: "chusky", version: "0.1.0" });

  server.registerTool("chusky_agent_templates", {
    title: "List Chusky agent templates",
    description: "List specialist business agent templates and their allowed tool categories.",
    inputSchema: {},
  }, async () => {
    try { return result(await chusky(env, identity, "/v1/agents/templates")); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_agents_list", {
    title: "List company agents",
    description: "List agent profiles available to this scoped Chusky project.",
    inputSchema: {},
  }, async () => {
    try { return result(await chusky(env, identity, "/v1/agents")); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_composio_apps_list", {
    title: "List Composio app connections",
    description: "List available connected app toolkits for this Chusky user identity. Authentication, OAuth, and connected-account tokens remain managed by Composio.",
    inputSchema: {},
  }, async () => {
    try {
      const [toolkits, accounts] = await Promise.all([
        chusky(env, identity, "/v1/apps"),
        chusky(env, identity, "/v1/apps/connections"),
      ]);
      return result({ toolkits, connectedAccounts: accounts });
    } catch (error) { return failure(error); }
  });

  server.registerTool("chusky_composio_connect_app", {
    title: "Connect a Composio app",
    description: "Ask Composio to start its existing OAuth consent flow for a toolkit. Returns a short-lived authorization URL; a human must complete provider consent. Chusky never receives or stores the provider password.",
    inputSchema: { toolkit: z.string().min(1).max(100), alias: z.string().min(1).max(160).optional() },
  }, async ({ toolkit, alias }) => {
    try {
      return result(await chusky(env, identity, `/v1/apps/${encodeURIComponent(toolkit)}/connect`, { method: "POST", body: jsonBody({ ...(alias ? { alias } : {}) }) }));
    } catch (error) { return failure(error); }
  });

  server.registerTool("chusky_triggers_list", {
    title: "List Composio triggers",
    description: "List existing event triggers attached to this Chusky user identity.",
    inputSchema: {},
  }, async () => {
    try { return result(await chusky(env, identity, "/v1/triggers")); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_agent_create", {
    title: "Create a company agent profile",
    description: "Create a profile from a supported template. Project scopes and template tool grants remain enforced by Chusky.",
    inputSchema: {
      template: z.string().min(2).max(100),
      name: z.string().min(1).max(80).optional(),
      instructions: z.string().min(1).max(6000).optional(),
    },
  }, async ({ template, name, instructions }) => {
    try {
      return result(await chusky(env, identity, "/v1/agents", { method: "POST", body: jsonBody({ template, name, instructions }) }));
    } catch (error) { return failure(error); }
  });

  server.registerTool("chusky_run_start", {
    title: "Start a durable Chusky task",
    description: "Start a background business task using a saved agent or template. Chusky enforces project and agent tool scopes, budgets, and approval rules. External Composio actions require approval.",
    inputSchema: {
      input: z.string().min(1).max(30_000),
      agentId: z.string().min(2).max(120).optional(),
      metadata: z.record(z.string(), z.unknown()).optional().refine((value) => value === undefined || (Object.keys(value).length <= 40 && JSON.stringify(value).length <= 8_000), "metadata must be at most 40 fields and 8 KB"),
      budget: z.object({
        duration: z.enum(["5m", "30m", "1h", "3h", "6h", "3d", "1w"]).optional(),
        maxToolCalls: z.number().int().min(1).max(100).optional(),
        maxCost: z.number().min(0).max(1000).optional(),
      }).optional(),
      tools: z.object({
        allow: z.array(z.string().min(1).max(120)).max(100).optional(),
        deny: z.array(z.string().min(1).max(120)).max(100).optional(),
        requireApproval: z.array(z.string().min(1).max(120)).max(100).optional(),
      }).optional(),
      idempotencyKey: z.string().min(8).max(200).optional(),
    },
  }, async ({ input, agentId, metadata, budget, tools, idempotencyKey }) => {
    try {
      const thread = await chusky<{ id: string }>(env, identity, "/v1/threads", {
        method: "POST",
        headers: { "Idempotency-Key": key(idempotencyKey, "thread") },
        body: jsonBody({ metadata: { source: "mcp", ...(metadata ?? {}) } }),
      });
      const run = await chusky(env, identity, `/v1/threads/${encodeURIComponent(thread.id)}/runs`, {
        method: "POST",
        headers: { "Idempotency-Key": key(idempotencyKey, "run") },
        body: jsonBody({ input, agentId, metadata, budget, tools, wait: false }),
      });
      return result({ threadId: thread.id, run });
    } catch (error) { return failure(error); }
  });

  server.registerTool("chusky_run_get", {
    title: "Get Chusky run status",
    description: "Get the current status and result of a durable run you started.",
    inputSchema: { threadId: z.string().min(1).max(200), runId: z.string().min(1).max(200) },
  }, async ({ threadId, runId }) => {
    try { return result(await chusky(env, identity, `/v1/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}`)); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_runs_list", {
    title: "List runs in a Chusky thread",
    description: "List durable runs belonging to a thread, newest first.",
    inputSchema: { threadId: z.string().min(1).max(200), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(300).optional() },
  }, async ({ threadId, limit, cursor }) => {
    try {
      const query = new URLSearchParams();
      if (limit) query.set("limit", String(limit));
      if (cursor) query.set("cursor", cursor);
      return result(await chusky(env, identity, `/v1/threads/${encodeURIComponent(threadId)}/runs${query.size ? `?${query}` : ""}`));
    } catch (error) { return failure(error); }
  });

  server.registerTool("chusky_run_events", {
    title: "Read Chusky run events",
    description: "Read progress events for a durable run after an optional timestamp in milliseconds.",
    inputSchema: { threadId: z.string().min(1).max(200), runId: z.string().min(1).max(200), after: z.number().int().nonnegative().optional() },
  }, async ({ threadId, runId, after }) => {
    try {
      const query = after === undefined ? "" : `?after=${encodeURIComponent(String(after))}`;
      return result(await chusky(env, identity, `/v1/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/events${query}`));
    } catch (error) { return failure(error); }
  });

  server.registerTool("chusky_run_cancel", {
    title: "Cancel a Chusky run",
    description: "Cancel a queued or running task. This does not approve or execute any pending external action.",
    inputSchema: { threadId: z.string().min(1).max(200), runId: z.string().min(1).max(200) },
  }, async ({ threadId, runId }) => {
    try { return result(await chusky(env, identity, `/v1/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: "{}" })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_run_resume", {
    title: "Resume a Chusky run",
    description: "Resume a failed, cancelled, or approval-paused run. Approval is not granted by resuming; pending actions still require the configured human approval.",
    inputSchema: { threadId: z.string().min(1).max(200), runId: z.string().min(1).max(200) },
  }, async ({ threadId, runId }) => {
    try { return result(await chusky(env, identity, `/v1/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/resume`, { method: "POST", body: "{}" })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_approval_status", {
    title: "Check Chusky approval status",
    description: "Check whether a pending action has been approved or denied. This read-only tool intentionally cannot make approval decisions.",
    inputSchema: { approvalId: z.string().min(1).max(200) },
  }, async ({ approvalId }) => {
    try {
      const approval = await chusky<Record<string, unknown>>(env, identity, `/v1/approvals/${encodeURIComponent(approvalId)}`);
      const { id, status, toolSlug, expiresAt } = approval;
      return result({ id, status, toolSlug, expiresAt });
    } catch (error) { return failure(error); }
  });

  server.registerTool("chusky_tasks_list", {
    title: "List Chusky tasks",
    description: "List durable task executions for this Chusky end-user identity.",
    inputSchema: { limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(300).optional() },
  }, async ({ limit, cursor }) => {
    try {
      const query = new URLSearchParams();
      if (limit) query.set("limit", String(limit));
      if (cursor) query.set("cursor", cursor);
      return result(await chusky(env, identity, `/v1/tasks${query.size ? `?${query}` : ""}`));
    } catch (error) { return failure(error); }
  });

  server.registerTool("chusky_task_get", {
    title: "Get Chusky task status",
    description: "Get status, checkpoint, and result for a durable task.",
    inputSchema: { taskId: z.string().min(1).max(200) },
  }, async ({ taskId }) => {
    try { return result(await chusky(env, identity, `/v1/tasks/${encodeURIComponent(taskId)}`)); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_task_cancel", {
    title: "Cancel a Chusky task",
    description: "Cancel a queued or running durable task.",
    inputSchema: { taskId: z.string().min(1).max(200) },
  }, async ({ taskId }) => {
    try { return result(await chusky(env, identity, `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST", body: "{}" })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_task_retry", {
    title: "Retry a Chusky task",
    description: "Retry a failed or otherwise retryable durable task under its original Chusky policy.",
    inputSchema: { taskId: z.string().min(1).max(200) },
  }, async ({ taskId }) => {
    try { return result(await chusky(env, identity, `/v1/tasks/${encodeURIComponent(taskId)}/retry`, { method: "POST", body: "{}" })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_usage_get", {
    title: "Get Chusky usage",
    description: "Read usage information for this Chusky end-user identity.",
    inputSchema: {},
  }, async () => {
    try { return result(await chusky(env, identity, "/v1/usage")); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_company_runs_list", {
    title: "List company runs",
    description: "List recent status-only run summaries shared across callers of this company project. Prompts, outputs, and connected-account data are not included.",
    inputSchema: { limit: z.number().int().min(1).max(100).optional() },
  }, async ({ limit }) => {
    try {
      const query = limit ? `?limit=${encodeURIComponent(String(limit))}` : "";
      return result(await chusky(env, identity, `/v1/company/runs${query}`));
    } catch (error) { return failure(error); }
  });

  server.registerTool("chusky_company_audit_list", {
    title: "List company audit events",
    description: "Read recent project-key and workspace change events. Audit entries exclude request bodies, prompts, secrets, and provider payloads.",
    inputSchema: { after: z.number().int().nonnegative().optional() },
  }, async ({ after }) => {
    try {
      const query = after === undefined ? "" : `?after=${encodeURIComponent(String(after))}`;
      return result(await chusky(env, identity, `/v1/company/audit-events${query}`));
    } catch (error) { return failure(error); }
  });

  server.registerTool("chusky_company_usage_get", {
    title: "Get company project usage",
    description: "Read monthly completed-run and model-cost totals aggregated across identities using this company project key.",
    inputSchema: {},
  }, async () => {
    try { return result(await chusky(env, identity, "/v1/company/usage")); }
    catch (error) { return failure(error); }
  });

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "chusky-mcp" });
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    if (!configuredApiOrigin(env.CHUSKY_API_ORIGIN)) return Response.json({ error: "Chusky API origin is not configured." }, { status: 500 });
    const identity = requestIdentity(request);
    if (!identity) return Response.json({ error: "Provide a project-scoped Chusky API key and stable X-Chusky-User-Id." }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
    const handler = createMcpHandler(() => createServer(env, identity), {
      route: "/mcp",
      legacy: "reject",
      corsOptions: false,
    });
    return handler(request, env, ctx);
  },
};
