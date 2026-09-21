import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { OAuthProvider, type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { allowedApiPath, configuredApiOrigin, requestIdentity, requireMcpScope, type McpIdentity } from "./security.js";

export type Env = Cloudflare.Env & {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
};
type ApiFailure = Error & { status?: number; code?: string };
type OAuthProps = { apiKey: string; userId: string; scopes: string[] };

const OAUTH_SCOPES = ["mcp:read", "mcp:run", "mcp:manage", "mcp:company"] as const;
const MCP_MAX_UPSTREAM_MS = 25_000;
const MCP_VERSION = "0.3.0";

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
  if (!allowedApiPath(path)) throw new Error("Invalid internal Chusky API path.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${identity.apiKey}`);
  headers.set("X-Chusky-User-Id", identity.userId);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("Chusky API request timed out"), MCP_MAX_UPSTREAM_MS);
  let response: Response;
  try {
    // Cloudflare Workers only supports `follow` and `manual` for fetch redirects.
    // Keep redirects blocked so an upstream cannot move this adapter outside the
    // trusted Chusky API origin; a manual 3xx is handled as an API failure below.
    response = await fetch(new URL(path, origin), { ...init, headers, redirect: "manual", signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Chusky API request timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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
  const raw = JSON.stringify(value);
  const structuredContent = raw.length <= 24_000
    ? value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { data: value }
    : { truncated: true, message: "Result exceeded the MCP response limit; request a narrower result." };
  const text = JSON.stringify(structuredContent);
  return { structuredContent, content: [{ type: "text" as const, text }] };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Chusky operation failed.";
  return { isError: true, content: [{ type: "text" as const, text: message.slice(0, 500) }] };
}

function jsonBody(value: unknown): string { return JSON.stringify(value); }
function key(base: string | undefined, suffix: string): string {
  return `${base ?? crypto.randomUUID()}:${suffix}`.slice(0, 255);
}

function scope(identity: McpIdentity, required: string): void {
  requireMcpScope(identity, required);
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] ?? character));
}

const oauthCss = `
  :root { color-scheme: light; --background: oklch(0.985 0.002 90); --foreground: oklch(0.12 0.01 60); --card: oklch(1 0 0); --muted: oklch(0.45 0.02 60); --border: oklch(0.88 0.01 90); --amber: #f6a400; --font-sans: "Instrument Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --font-display: "Instrument Serif", Georgia, serif; --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
  * { box-sizing: border-box; }
  body { margin: 0; min-width: 320px; min-height: 100vh; background: var(--background); color: var(--foreground); font-family: var(--font-sans); }
  .page { width: min(1040px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 48px; }
  .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 28px; }
  .brand { display: inline-flex; align-items: center; gap: 10px; color: var(--foreground); font-family: var(--font-display); font-size: 22px; font-weight: 600; letter-spacing: -.04em; }
  .brand-mark { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; background: var(--foreground); color: var(--background); font-family: var(--font-display); font-size: 16px; font-weight: 600; letter-spacing: -.05em; }
  .trust-label { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-family: var(--font-mono); font-size: 10px; font-weight: 600; letter-spacing: .03em; }
  .trust-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--amber); box-shadow: 0 0 0 3px color-mix(in srgb, var(--amber) 18%, transparent); }
  .card { display: grid; grid-template-columns: minmax(0, .88fr) minmax(0, 1.12fr); overflow: hidden; border: 1px solid var(--border); border-radius: 20px; background: var(--card); box-shadow: 0 24px 70px rgba(31, 28, 22, .09), 0 3px 12px rgba(31, 28, 22, .04); }
  .intro { padding: 54px 48px; background: color-mix(in srgb, var(--background) 72%, var(--card)); border-right: 1px solid var(--border); }
  .eyebrow { margin: 0 0 16px; color: var(--muted); font-family: var(--font-mono); font-size: 10px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; }
  h1 { max-width: 390px; margin: 0; color: var(--foreground); font-family: var(--font-display); font-size: clamp(32px, 4vw, 48px); font-weight: 500; line-height: .98; letter-spacing: -.055em; }
  .intro-copy { max-width: 390px; margin: 18px 0 30px; color: var(--muted); font-size: 14px; line-height: 1.7; }
  .requester { display: flex; align-items: center; gap: 13px; padding: 14px; border: 1px solid color-mix(in srgb, var(--foreground) 12%, transparent); border-radius: 10px; background: var(--card); }
  .requester-mark { display: grid; flex: 0 0 auto; place-items: center; width: 38px; height: 38px; border-radius: 10px; background: color-mix(in srgb, var(--amber) 16%, var(--card)); color: var(--foreground); font-family: var(--font-display); font-size: 18px; font-weight: 600; }
  .requester-label { margin: 0 0 3px; color: var(--muted); font-family: var(--font-mono); font-size: 9px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
  .requester-name { margin: 0; overflow: hidden; color: var(--foreground); font-size: 14px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .permission-heading { margin: 34px 0 12px; color: var(--foreground); font-family: var(--font-mono); font-size: 10px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; }
  .permissions { display: grid; gap: 10px; margin: 0; padding: 0; color: var(--muted); font-size: 12px; line-height: 1.5; list-style: none; }
  .permissions li { padding-left: 18px; position: relative; }
  .permissions li::before { content: ""; position: absolute; left: 1px; top: .55em; width: 7px; height: 7px; border-radius: 50%; background: var(--amber); }
  .form-panel { padding: 54px 52px 48px; }
  .form-header { margin-bottom: 28px; }
  .form-header h2 { margin: 0 0 8px; color: var(--foreground); font-family: var(--font-display); font-size: 28px; font-weight: 500; letter-spacing: -.04em; }
  .form-header p { max-width: 520px; margin: 0; color: var(--muted); font-size: 13px; line-height: 1.65; }
  .field { margin-top: 21px; }
  label { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; color: var(--foreground); font-size: 12px; font-weight: 650; }
  .label-hint { color: var(--muted); font-family: var(--font-mono); font-size: 9px; font-weight: 600; }
  input { display: block; width: 100%; height: 46px; padding: 0 13px; border: 1px solid color-mix(in srgb, var(--foreground) 18%, transparent); border-radius: 8px; outline: none; background: var(--card); color: var(--foreground); font: inherit; font-size: 13px; transition: border-color .16s ease, box-shadow .16s ease; }
  input::placeholder { color: color-mix(in srgb, var(--muted) 64%, transparent); }
  input:hover { border-color: color-mix(in srgb, var(--foreground) 32%, transparent); }
  input:focus { border-color: var(--amber); box-shadow: 0 0 0 3px color-mix(in srgb, var(--amber) 18%, transparent); }
  .field-help { margin: 8px 0 0; color: var(--muted); font-size: 11px; line-height: 1.55; }
  .security-note { display: flex; gap: 11px; margin-top: 26px; padding: 13px 14px; border: 1px solid color-mix(in srgb, var(--amber) 30%, var(--border)); border-radius: 10px; background: color-mix(in srgb, var(--amber) 9%, var(--card)); color: var(--muted); font-size: 11px; line-height: 1.6; }
  .security-note strong { display: block; margin-bottom: 2px; color: var(--foreground); font-size: 11px; }
  .security-icon { flex: 0 0 auto; width: 18px; height: 18px; margin-top: 1px; border: 2px solid var(--amber); border-radius: 50%; }
  .actions { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin-top: 30px; }
  .button { min-height: 45px; padding: 0 18px; border: 1px solid transparent; border-radius: 10px; font: inherit; font-size: 13px; font-weight: 750; cursor: pointer; }
  .button-primary { background: var(--foreground); color: var(--background); box-shadow: 0 5px 12px rgba(31, 28, 22, .14); }
  .button-primary:hover { background: color-mix(in srgb, var(--foreground) 86%, var(--amber)); }
  .button-primary:focus-visible { outline: 3px solid color-mix(in srgb, var(--amber) 38%, transparent); outline-offset: 2px; }
  .footer { margin-top: 18px; color: var(--muted); font-family: var(--font-mono); font-size: 9px; line-height: 1.6; text-align: center; }
  .error-card { max-width: 660px; margin: 64px auto 0; padding: 42px; border: 1px solid var(--border); border-radius: 20px; background: var(--card); box-shadow: 0 18px 48px rgba(31, 28, 22, .08); }
  .error-card h1 { font-size: 34px; }
  .error-card p { color: var(--muted); font-size: 14px; line-height: 1.65; }
  .error-message { margin: 22px 0; padding: 14px 16px; border: 1px solid color-mix(in srgb, #b42318 20%, var(--border)); border-radius: 10px; background: color-mix(in srgb, #b42318 5%, var(--card)); color: #923f46 !important; font-size: 13px !important; }
  .success-card { max-width: 660px; margin: 64px auto 0; padding: 42px; border: 1px solid color-mix(in srgb, var(--amber) 34%, var(--border)); border-radius: 20px; background: var(--card); box-shadow: 0 18px 48px rgba(31, 28, 22, .08); }
  .success-card h1 { font-size: 34px; }
  .success-card p { color: var(--muted); font-size: 14px; line-height: 1.65; }
  .success-badge { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 18px; color: var(--foreground); font-family: var(--font-mono); font-size: 10px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; }
  .success-badge::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--amber); }
  .continue-link { display: inline-flex; align-items: center; min-height: 44px; margin-top: 12px; padding: 0 16px; border-radius: 8px; background: var(--foreground); color: var(--background); font-size: 13px; font-weight: 650; text-decoration: none; }
  @media (max-width: 760px) { .page { width: min(100% - 20px, 560px); padding-top: 18px; } .topbar { margin-bottom: 18px; } .card { display: block; border-radius: 18px; } .intro { padding: 30px 24px; border-right: 0; border-bottom: 1px solid #e7ebf1; } .form-panel { padding: 30px 24px 28px; } h1 { font-size: 34px; } .permission-heading { margin-top: 26px; } .error-card { margin-top: 28px; padding: 28px 22px; } }
  @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
`;

const oauthHeaders = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function oauthShell(content: string, title: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${oauthCss}</style></head><body><div class="page"><header class="topbar"><div class="brand"><span class="brand-mark" aria-hidden="true">C</span><span>Chusky</span></div><div class="trust-label"><span class="trust-dot" aria-hidden="true"></span>Secure connection</div></header>${content}</div></body></html>`;
}

function oauthErrorResponse(message: string, status = 400): Response {
  const content = `<main class="error-card"><p class="eyebrow">Connection interrupted</p><h1>We couldn't connect Chusky</h1><p class="error-message">${escapeHtml(message)}</p><p>Close this window and retry from your MCP client. If the problem continues, ask your workspace administrator to verify the project key and connection settings.</p></main>`;
  return new Response(oauthShell(content, "Chusky connection error"), { status, headers: oauthHeaders });
}

function oauthCompletionResponse(redirectTo: string): Response {
  const safeRedirect = escapeHtml(redirectTo);
  const content = `<main class="success-card"><div class="success-badge">Access approved</div><h1>You're connected.</h1><p>Chusky has approved this MCP connection. We’re returning you to your MCP client now.</p><p>If the window does not continue automatically, use the button below.</p><a class="continue-link" href="${safeRedirect}">Continue to your MCP client</a><meta http-equiv="refresh" content="0;url=${safeRedirect}"></main>`;
  return new Response(oauthShell(content, "Chusky connection approved"), { headers: { ...oauthHeaders, "Cache-Control": "no-store" } });
}

function authQuery(request: Request, form?: FormData): URL {
  const url = new URL(request.url);
  if (!form) return url;
  url.search = "";
  for (const name of ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "resource"]) {
    const value = form.get(name);
    if (typeof value === "string" && value) url.searchParams.set(name, value);
  }
  return url;
}

async function renderAuthorize(request: Request, env: Env): Promise<Response> {
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    return oauthErrorResponse(error instanceof Error ? error.message : "Invalid OAuth authorization request.");
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) return oauthErrorResponse("Unknown OAuth client.");
  const fields = ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "resource"]
    .map((name) => hidden(name, new URL(request.url).searchParams.get(name) ?? ""))
    .join("");
  const clientName = client.clientName || "Your MCP client";
  const requestedScopes = oauthRequest.scope.length ? oauthRequest.scope : ["mcp:read"];
  const scopeLabels: Record<string, string> = {
    "mcp:read": "Read your Chusky agent profiles, runs, and results",
    "mcp:run": "Start and monitor durable agent work",
    "mcp:manage": "Manage agent profiles, triggers, and webhooks",
    "mcp:company": "View bounded company-level usage and run status",
  };
  const permissionMarkup = requestedScopes
    .map((scopeName) => `<li>${escapeHtml(scopeLabels[scopeName] ?? scopeName)}</li>`)
    .join("");
  const requesterInitial = escapeHtml(clientName.trim().charAt(0).toUpperCase() || "A");
  const content = `<main class="card"><section class="intro"><p class="eyebrow">Authorization request</p><h1>Give your agent a governed way to work.</h1><p class="intro-copy">Chusky connects your MCP client to durable agents, business tools, and approved workflows—while keeping your workspace policy in control.</p><div class="requester"><div class="requester-mark" aria-hidden="true">${requesterInitial}</div><div><p class="requester-label">Requesting application</p><p class="requester-name">${escapeHtml(clientName)}</p></div></div><p class="permission-heading">This connection can</p><ul class="permissions">${permissionMarkup}</ul></section><section class="form-panel"><div class="form-header"><h2>Connect to Chusky</h2><p>Confirm the project and identity this agent should use. Your key is verified against Chusky and stored only inside the encrypted OAuth grant.</p></div><form method="post" action="/authorize">${fields}<div class="field"><label for="key">Project API key <span class="label-hint">starts with chsk_</span></label><input id="key" name="chusky_api_key" type="password" autocomplete="off" placeholder="Enter your project-scoped key" required pattern="chsk_[A-Za-z0-9_-]{16,500}" aria-describedby="key-help"><p id="key-help" class="field-help">Use a project key with only the scopes this agent needs. Never use the root operator key.</p></div><div class="field"><label for="user">Workspace identity <span class="label-hint">non-PII</span></label><input id="user" name="chusky_user_id" autocomplete="organization" placeholder="e.g. acme-production" required maxlength="200" pattern="[A-Za-z0-9._:@/-]+" aria-describedby="user-help"><p id="user-help" class="field-help">Use a stable service, workspace, or customer identity. The same identity keeps runs and connected apps properly isolated.</p></div><div class="security-note"><span class="security-icon" aria-hidden="true"></span><div><strong>Your access stays scoped</strong> Chusky applies project permissions, budgets, approvals, and identity isolation to every request. External actions can still require human approval.</div></div><div class="actions"><button class="button button-primary" type="submit">Allow access</button></div></form><p class="footer">You can revoke this connection from your MCP client or Chusky workspace settings.</p></section></main>`;
  return new Response(oauthShell(content, `Connect ${clientName} to Chusky`), { headers: oauthHeaders });
}

async function authorize(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") return renderAuthorize(request, env);
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  const form = await request.formData();
  const key = String(form.get("chusky_api_key") ?? "").trim();
  const userId = String(form.get("chusky_user_id") ?? "").trim();
  const identityRequest = new Request(request.url, { headers: { Authorization: `Bearer ${key}`, "X-Chusky-User-Id": userId } });
  const identity = requestIdentity(identityRequest);
  if (!identity) return oauthErrorResponse("Enter a valid project-scoped Chusky key and stable identity.");
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(new Request(authQuery(request, form)));
    await chusky(env, identity, "/v1/agents/templates");
  } catch (error) {
    return oauthErrorResponse(error instanceof Error ? error.message : "The Chusky key could not be verified.");
  }
  const requested = oauthRequest.scope.length ? oauthRequest.scope : ["mcp:read"];
  if (requested.some((item) => !(OAUTH_SCOPES as readonly string[]).includes(item))) return oauthErrorResponse("The client requested an unsupported Chusky scope.");
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) return oauthErrorResponse("Unknown OAuth client.");
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: identity.userId,
    metadata: { clientName: client.clientName },
    scope: requested,
    props: { apiKey: identity.apiKey, userId: identity.userId, scopes: requested },
  });
  return oauthCompletionResponse(redirectTo);
}

function createServer(env: Env, identity: McpIdentity): McpServer {
  const server = new McpServer({ name: "chusky", version: MCP_VERSION });
  const writeTools = new Set([
    "chusky_composio_connect_app", "chusky_agent_create", "chusky_agent_update", "chusky_agent_delete", "chusky_run_start", "chusky_run_cancel",
    "chusky_run_resume", "chusky_task_cancel", "chusky_task_retry", "chusky_mission_start", "chusky_mission_pause", "chusky_mission_resume", "chusky_mission_cancel", "chusky_mission_event", "chusky_mission_step_complete", "chusky_mission_replan", "chusky_thread_update", "chusky_trigger_create",
    "chusky_trigger_update", "chusky_trigger_delete", "chusky_webhook_create", "chusky_webhook_update",
    "chusky_webhook_delete", "chusky_webhook_delivery_retry",
  ]);
  const registerTool = server.registerTool.bind(server) as (...args: any[]) => unknown;
  (server as unknown as { registerTool: typeof server.registerTool }).registerTool = ((name: string, options: Record<string, unknown>, callback: (...args: any[]) => unknown) => registerTool(name, {
    ...options,
    outputSchema: options.outputSchema ?? z.record(z.string(), z.unknown()),
    annotations: writeTools.has(name)
      ? { readOnlyHint: false, destructiveHint: /cancel|delete|disconnect/.test(name), idempotentHint: /cancel|update|delete/.test(name), openWorldHint: true }
      : { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, callback)) as typeof server.registerTool;

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
      scope(identity, "mcp:manage");
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
      scope(identity, "mcp:manage");
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
      idempotencyKey: z.string().min(8).max(200),
    },
  }, async ({ input, agentId, metadata, budget, tools, idempotencyKey }) => {
    try {
      scope(identity, "mcp:run");
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
    try { scope(identity, "mcp:run"); return result(await chusky(env, identity, `/v1/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: "{}" })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_run_resume", {
    title: "Resume a Chusky run",
    description: "Resume a failed, cancelled, or approval-paused run. Approval is not granted by resuming; pending actions still require the configured human approval.",
    inputSchema: { threadId: z.string().min(1).max(200), runId: z.string().min(1).max(200) },
  }, async ({ threadId, runId }) => {
    try { scope(identity, "mcp:run"); return result(await chusky(env, identity, `/v1/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/resume`, { method: "POST", body: "{}" })); }
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
    try { scope(identity, "mcp:run"); return result(await chusky(env, identity, `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST", body: "{}" })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_task_retry", {
    title: "Retry a Chusky task",
    description: "Retry a failed or otherwise retryable durable task under its original Chusky policy.",
    inputSchema: { taskId: z.string().min(1).max(200) },
  }, async ({ taskId }) => {
    try { scope(identity, "mcp:run"); return result(await chusky(env, identity, `/v1/tasks/${encodeURIComponent(taskId)}/retry`, { method: "POST", body: "{}" })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_missions_list", {
    title: "List autonomous Chusky missions",
    description: "List bounded autonomous missions for this Chusky identity, including honest lifecycle state, checkpoints, next actions, and budget consumption.",
    inputSchema: {},
  }, async () => {
    try { return result(await chusky(env, identity, "/v1/missions")); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_mission_get", {
    title: "Get autonomous mission status",
    description: "Read one mission's durable checkpoint, next action, budget, and bounded event history.",
    inputSchema: { missionId: z.string().min(1).max(200) },
  }, async ({ missionId }) => {
    try { return result(await chusky(env, identity, `/v1/missions/${encodeURIComponent(missionId)}`)); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_mission_start", {
    title: "Start an autonomous Chusky mission",
    description: "Start durable, bounded multi-step work that continues across model turns and service restarts. Provide a verifiable definition of done and explicit limits; external actions still follow Chusky policy and approval.",
    inputSchema: {
      title: z.string().min(1).max(240),
      objective: z.string().min(1).max(8000),
      definitionOfDone: z.string().min(1).max(4000),
      maxDurationSeconds: z.number().int().min(60).max(2_592_000).optional(),
      maxSteps: z.number().int().min(1).max(1000).optional(),
      maxToolCalls: z.number().int().min(1).max(10_000).optional(),
      maxCost: z.number().min(0).max(10_000).optional(),
      steps: z.array(z.object({ id: z.string().max(160).optional(), title: z.string().min(1).max(240), objective: z.string().min(1).max(4000), dependsOn: z.array(z.string().max(160)).max(20).optional(), retryLimit: z.number().int().min(0).max(20).optional() })).max(100).optional(),
      idempotencyKey: z.string().min(8).max(200),
    },
  }, async ({ title, objective, definitionOfDone, maxDurationSeconds, maxSteps, maxToolCalls, maxCost, steps, idempotencyKey }) => {
    try {
      scope(identity, "mcp:run");
      return result(await chusky(env, identity, "/v1/missions", {
        method: "POST",
        headers: { "Idempotency-Key": key(idempotencyKey, "mission") },
        body: jsonBody({ title, objective, definitionOfDone, maxDurationSeconds, maxSteps, maxToolCalls, maxCost, steps }),
      }));
    } catch (error) { return failure(error); }
  });

  for (const action of ["pause", "resume", "cancel"] as const) {
    const toolName = `chusky_mission_${action}`;
    server.registerTool(toolName, {
      title: `${action[0].toUpperCase()}${action.slice(1)} an autonomous mission`,
      description: `${action[0].toUpperCase()}${action.slice(1)} an owned autonomous mission without losing its durable checkpoint.`,
      inputSchema: { missionId: z.string().min(1).max(200) },
    }, async ({ missionId }: { missionId: string }) => {
      try { scope(identity, "mcp:run"); return result(await chusky(env, identity, `/v1/missions/${encodeURIComponent(missionId)}/${action}`, { method: "POST", body: "{}" })); }
      catch (error) { return failure(error); }
    });
  }

  server.registerTool("chusky_mission_event", {
    title: "Resume a mission from a provider event",
    description: "Resume exactly one mission waiting for the matching provider and stable provider event id. Duplicate delivery is harmless.",
    inputSchema: { missionId: z.string().min(1).max(200), provider: z.string().min(1).max(120), providerEventId: z.string().min(1).max(240) },
  }, async ({ missionId, provider, providerEventId }) => {
    try { scope(identity, "mcp:run"); return result(await chusky(env, identity, `/v1/missions/${encodeURIComponent(missionId)}/events`, { method: "POST", body: jsonBody({ provider, providerEventId }) })); }
    catch (error) { return failure(error); }
  });

  const missionStepSchema = z.object({ id: z.string().max(160).optional(), title: z.string().min(1).max(240), objective: z.string().min(1).max(4000), dependsOn: z.array(z.string().max(160)).max(20).optional(), retryLimit: z.number().int().min(0).max(20).optional() });
  server.registerTool("chusky_mission_step_complete", {
    title: "Complete a Chusky mission step",
    description: "Record a verified result for one mission step and advance to the next dependency-ready step.",
    inputSchema: { missionId: z.string().min(1).max(200), stepId: z.string().min(1).max(160), result: z.string().min(1).max(12000) },
  }, async ({ missionId, stepId, result: stepResult }) => {
    try { scope(identity, "mcp:run"); return result(await chusky(env, identity, `/v1/missions/${encodeURIComponent(missionId)}/steps/${encodeURIComponent(stepId)}/complete`, { method: "POST", body: jsonBody({ result: stepResult }) })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_mission_replan", {
    title: "Replan a Chusky mission",
    description: "Replace the unfinished mission plan after verified information changes. Completed steps remain protected and dependencies are validated.",
    inputSchema: { missionId: z.string().min(1).max(200), reason: z.string().min(1).max(2000), steps: z.array(missionStepSchema).min(1).max(100) },
  }, async ({ missionId, reason, steps }) => {
    try { scope(identity, "mcp:run"); return result(await chusky(env, identity, `/v1/missions/${encodeURIComponent(missionId)}/replan`, { method: "POST", body: jsonBody({ reason, steps }) })); }
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
      scope(identity, "mcp:company");
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
      scope(identity, "mcp:company");
      const query = after === undefined ? "" : `?after=${encodeURIComponent(String(after))}`;
      return result(await chusky(env, identity, `/v1/company/audit-events${query}`));
    } catch (error) { return failure(error); }
  });

  server.registerTool("chusky_company_usage_get", {
    title: "Get company project usage",
    description: "Read monthly completed-run and model-cost totals aggregated across identities using this company project key.",
    inputSchema: {},
  }, async () => {
    try { scope(identity, "mcp:company"); return result(await chusky(env, identity, "/v1/company/usage")); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_tools_list", {
    title: "Discover Chusky tools",
    description: "List native Chusky tools and, when a query is supplied, matching Composio tools available to this identity.",
    inputSchema: { query: z.string().max(200).optional(), source: z.enum(["native", "composio"]).optional(), toolkit: z.string().max(100).optional(), limit: z.number().int().min(1).max(100).optional() },
  }, async ({ query, source, toolkit, limit }) => {
    try {
      scope(identity, "mcp:read");
      const params = new URLSearchParams();
      if (query) params.set("query", query); if (source) params.set("source", source); if (toolkit) params.set("toolkit", toolkit); if (limit) params.set("limit", String(limit));
      return result(await chusky(env, identity, `/v1/tools${params.size ? `?${params}` : ""}`));
    } catch (error) { return failure(error); }
  });

  server.registerTool("chusky_skills_search", {
    title: "Search Chusky skills",
    description: "Search the trusted Chusky skill catalogue so an agent can select the right workflow guidance before starting a run.",
    inputSchema: { query: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional() },
  }, async ({ query, limit }) => {
    try { scope(identity, "mcp:read"); const params = new URLSearchParams(); if (query) params.set("query", query); if (limit) params.set("limit", String(limit)); return result(await chusky(env, identity, `/v1/skills${params.size ? `?${params}` : ""}`)); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_skill_read", {
    title: "Read a Chusky skill file",
    description: "Read a bounded file from a named trusted Chusky skill. Use this for workflow instructions, not arbitrary filesystem access.",
    inputSchema: { name: z.string().min(1).max(120), path: z.string().min(1).max(300).optional(), maxChars: z.number().int().min(500).max(30_000).optional() },
  }, async ({ name, path, maxChars }) => {
    try { scope(identity, "mcp:read"); const params = new URLSearchParams({ path: path ?? "SKILL.md" }); if (maxChars) params.set("maxChars", String(maxChars)); return result(await chusky(env, identity, `/v1/skills/${encodeURIComponent(name)}/files/read?${params}`)); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_agent_get", {
    title: "Get a Chusky agent profile",
    description: "Read one project-scoped agent profile, including its template and policy grants.",
    inputSchema: { agentId: z.string().min(1).max(200) },
  }, async ({ agentId }) => {
    try { scope(identity, "mcp:read"); return result(await chusky(env, identity, `/v1/agents/${encodeURIComponent(agentId)}`)); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_agent_update", {
    title: "Update a Chusky agent profile",
    description: "Update an existing company agent profile. Chusky continues to enforce the template and project policy boundaries.",
    inputSchema: { agentId: z.string().min(1).max(200), template: z.string().min(2).max(100).optional(), name: z.string().min(1).max(80).optional(), instructions: z.string().min(1).max(6000).optional() },
  }, async ({ agentId, template, name, instructions }) => {
    try { scope(identity, "mcp:manage"); return result(await chusky(env, identity, `/v1/agents/${encodeURIComponent(agentId)}`, { method: "PATCH", body: jsonBody({ template, name, instructions }) })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_agent_delete", {
    title: "Delete a Chusky agent profile",
    description: "Delete an owned company agent profile. Running tasks are not silently approved or cancelled by this operation.",
    inputSchema: { agentId: z.string().min(1).max(200) },
  }, async ({ agentId }) => {
    try { scope(identity, "mcp:manage"); return result(await chusky(env, identity, `/v1/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_threads_list", {
    title: "List Chusky conversations",
    description: "List durable conversations for this identity so an external agent can revisit an existing task instead of creating a duplicate.",
    inputSchema: { includeArchived: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(300).optional() },
  }, async ({ includeArchived, limit, cursor }) => {
    try { scope(identity, "mcp:read"); const params = new URLSearchParams(); if (includeArchived) params.set("includeArchived", "true"); if (limit) params.set("limit", String(limit)); if (cursor) params.set("cursor", cursor); return result(await chusky(env, identity, `/v1/threads${params.size ? `?${params}` : ""}`)); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_thread_get", {
    title: "Get a Chusky conversation",
    description: "Read metadata for one durable Chusky conversation before continuing work in its thread.",
    inputSchema: { threadId: z.string().min(1).max(200) },
  }, async ({ threadId }) => {
    try { scope(identity, "mcp:read"); return result(await chusky(env, identity, `/v1/threads/${encodeURIComponent(threadId)}`)); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_thread_update", {
    title: "Update a Chusky conversation",
    description: "Rename or archive an owned Chusky conversation so external agents can keep their work organized without deleting history.",
    inputSchema: { threadId: z.string().min(1).max(200), title: z.string().max(120).optional(), archived: z.boolean().optional() },
  }, async ({ threadId, title, archived }) => {
    try { scope(identity, "mcp:manage"); return result(await chusky(env, identity, `/v1/threads/${encodeURIComponent(threadId)}`, { method: "PATCH", body: jsonBody({ title, archived }) })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_approvals_list", {
    title: "List pending Chusky approvals",
    description: "List pending human approvals for this identity. This tool cannot approve or deny an action.",
    inputSchema: {},
  }, async () => {
    try { scope(identity, "mcp:read"); return result(await chusky(env, identity, "/v1/approvals")); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_artifacts_list", {
    title: "List Chusky artifacts",
    description: "List generated reports, files, websites, and other deliverables owned by this identity.",
    inputSchema: { type: z.string().max(80).optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(300).optional() },
  }, async ({ type, limit, cursor }) => {
    try { scope(identity, "mcp:read"); const params = new URLSearchParams(); if (type) params.set("type", type); if (limit) params.set("limit", String(limit)); if (cursor) params.set("cursor", cursor); return result(await chusky(env, identity, `/v1/artifacts${params.size ? `?${params}` : ""}`)); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_artifact_get", {
    title: "Get a Chusky artifact",
    description: "Read metadata for one generated artifact. Use the returned delivery information through the authenticated Chusky API.",
    inputSchema: { artifactId: z.string().min(1).max(200) },
  }, async ({ artifactId }) => {
    try { scope(identity, "mcp:read"); return result(await chusky(env, identity, `/v1/artifacts/${encodeURIComponent(artifactId)}`)); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_file_get", {
    title: "Get a Chusky file",
    description: "Get metadata and a short-lived private download URL for a verified uploaded file.",
    inputSchema: { fileId: z.string().min(1).max(200) },
  }, async ({ fileId }) => {
    try { scope(identity, "mcp:read"); return result(await chusky(env, identity, `/v1/files/${encodeURIComponent(fileId)}`)); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_trigger_create", {
    title: "Create a Chusky trigger",
    description: "Create an event trigger for a connected Composio toolkit. The connected account and Chusky policy remain authoritative.",
    inputSchema: { slug: z.string().min(2).max(150), connectedAccountId: z.string().min(1).max(200).optional(), triggerConfig: z.record(z.string(), z.unknown()).optional() },
  }, async ({ slug, connectedAccountId, triggerConfig }) => {
    try { scope(identity, "mcp:manage"); return result(await chusky(env, identity, "/v1/triggers", { method: "POST", body: jsonBody({ slug, connectedAccountId, triggerConfig }) })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_trigger_update", {
    title: "Enable or disable a Chusky trigger",
    description: "Change the enabled state of an owned event trigger.",
    inputSchema: { triggerId: z.string().min(1).max(200), enabled: z.boolean() },
  }, async ({ triggerId, enabled }) => {
    try { scope(identity, "mcp:manage"); return result(await chusky(env, identity, `/v1/triggers/${encodeURIComponent(triggerId)}`, { method: "PATCH", body: jsonBody({ enabled }) })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_trigger_delete", {
    title: "Delete a Chusky trigger",
    description: "Delete an owned Composio event trigger.",
    inputSchema: { triggerId: z.string().min(1).max(200) },
  }, async ({ triggerId }) => {
    try { scope(identity, "mcp:manage"); return result(await chusky(env, identity, `/v1/triggers/${encodeURIComponent(triggerId)}`, { method: "DELETE" })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_webhooks_list", {
    title: "List Chusky webhooks",
    description: "List enabled outbound webhook targets owned by this identity without returning webhook secrets.",
    inputSchema: {},
  }, async () => {
    try { scope(identity, "mcp:read"); return result(await chusky(env, identity, "/v1/webhooks")); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_webhook_create", {
    title: "Create a Chusky webhook",
    description: "Create an HTTPS webhook target for durable Chusky events. The returned secret is shown only once by the Chusky API.",
    inputSchema: { url: z.string().url().max(2000), idempotencyKey: z.string().min(8).max(200).optional() },
  }, async ({ url, idempotencyKey }) => {
    try { scope(identity, "mcp:manage"); return result(await chusky(env, identity, "/v1/webhooks", { method: "POST", headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined, body: jsonBody({ url }) })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_webhook_update", {
    title: "Enable or disable a Chusky webhook",
    description: "Change the enabled state of an owned webhook target.",
    inputSchema: { webhookId: z.string().min(1).max(200), enabled: z.boolean() },
  }, async ({ webhookId, enabled }) => {
    try { scope(identity, "mcp:manage"); return result(await chusky(env, identity, `/v1/webhooks/${encodeURIComponent(webhookId)}`, { method: "PATCH", body: jsonBody({ enabled }) })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_webhook_delete", {
    title: "Delete a Chusky webhook",
    description: "Disable and remove an owned webhook target.",
    inputSchema: { webhookId: z.string().min(1).max(200) },
  }, async ({ webhookId }) => {
    try { scope(identity, "mcp:manage"); return result(await chusky(env, identity, `/v1/webhooks/${encodeURIComponent(webhookId)}`, { method: "DELETE" })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_webhook_deliveries_list", {
    title: "List Chusky webhook deliveries",
    description: "Inspect bounded delivery status for an owned webhook without exposing its secret or payload.",
    inputSchema: { webhookId: z.string().min(1).max(200) },
  }, async ({ webhookId }) => {
    try { scope(identity, "mcp:read"); return result(await chusky(env, identity, `/v1/webhooks/${encodeURIComponent(webhookId)}/deliveries`)); }
    catch (error) { return failure(error); }
  });

  server.registerTool("chusky_webhook_delivery_retry", {
    title: "Retry a Chusky webhook delivery",
    description: "Requeue an owned failed webhook delivery. This does not change the original event or webhook secret.",
    inputSchema: { webhookId: z.string().min(1).max(200), deliveryId: z.string().min(1).max(200) },
  }, async ({ webhookId, deliveryId }) => {
    try { scope(identity, "mcp:manage"); return result(await chusky(env, identity, `/v1/webhooks/${encodeURIComponent(webhookId)}/deliveries/${encodeURIComponent(deliveryId)}/retry`, { method: "POST", body: "{}" })); }
    catch (error) { return failure(error); }
  });

  return server;
}

const mcpHandlerOptions = {
  route: "/mcp",
  legacy: "stateless" as const,
  corsOptions: false as const,
  responseMode: "auto" as const,
  onerror: (error: Error) => console.error("MCP protocol error", { name: error.name }),
};

async function serveWithApiKey(request: Request, env: Env, ctx: ExecutionContext, identity: McpIdentity): Promise<Response> {
  const handler = createMcpHandler(() => createServer(env, identity), mcpHandlerOptions);
  return handler(request, env, ctx);
}

const oauthApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const handler = createMcpHandler((mcpContext) => {
      const props = (mcpContext.authInfo?.extra?.props ?? (ctx as ExecutionContext & { props?: unknown }).props) as Partial<OAuthProps> | undefined;
      if (!props?.apiKey || !props.userId || !Array.isArray(props.scopes)) throw new Error("OAuth identity was not attached to the MCP request.");
      return createServer(env, { apiKey: props.apiKey, userId: props.userId, scopes: props.scopes });
    }, mcpHandlerOptions);
    return handler(request, env, ctx);
  },
};

const oauthProvider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: oauthApiHandler,
  defaultHandler: {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === "/authorize") return authorize(request, env);
      return new Response("Not found", { status: 404 });
    },
  },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  allowPlainPKCE: false,
  allowImplicitFlow: false,
  refreshTokenTTL: 30 * 24 * 60 * 60,
  scopesSupported: [...OAUTH_SCOPES],
  resourceMetadata: {
    scopes_supported: [...OAUTH_SCOPES],
    resource_name: "Chusky agent orchestration",
  },
  clientIdMetadataDocumentEnabled: true,
  onError: ({ code, status }) => {
    console.error("MCP OAuth error", { code, status });
  },
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "chusky-mcp", version: MCP_VERSION, oauth: Boolean(env.OAUTH_KV) });
    if (!configuredApiOrigin(env.CHUSKY_API_ORIGIN)) return Response.json({ error: "Chusky API origin is not configured." }, { status: 500 });
    if (url.pathname !== "/mcp" && !url.pathname.startsWith("/.well-known/") && url.pathname !== "/authorize" && !url.pathname.startsWith("/oauth/")) return new Response("Not found", { status: 404 });
    const identity = requestIdentity(request);
    if (identity) return serveWithApiKey(request, env, ctx, identity);
    if (!env.OAUTH_KV && (url.pathname === "/authorize" || url.pathname.startsWith("/oauth/"))) return Response.json({ error: "OAuth is not configured: bind OAUTH_KV before enabling OAuth clients." }, { status: 503 });
    return oauthProvider.fetch(request, env, ctx);
  },
};
