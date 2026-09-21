const endpoint = process.env.CHUSKY_MCP_URL || "https://chusky-mcp.adesrnd.workers.dev/mcp";
const apiKey = process.env.CHUSKY_MCP_API_KEY;
const userId = process.env.CHUSKY_MCP_USER_ID;

if (!apiKey || !userId) {
  console.log("MCP live smoke skipped: set CHUSKY_MCP_API_KEY and CHUSKY_MCP_USER_ID to run it.");
  process.exit(0);
}

function parseResponse(response, text) {
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = [...text.matchAll(/^data:\s*(.+)$/gm)].at(-1)?.[1];
    return data ? JSON.parse(data) : undefined;
  }
  return text ? JSON.parse(text) : undefined;
}

let nextId = 1;
const unauthenticated = await fetch(endpoint, {
  method: "POST",
  headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "unauthenticated-check", version: "1.0.0" } } }),
});
if (unauthenticated.status !== 401) throw new Error(`Unauthenticated MCP request returned HTTP ${unauthenticated.status}, expected 401`);

async function rpc(method, params) {
  const id = nextId++;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Chusky-User-Id": userId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const body = parseResponse(response, await response.text());
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  if (body?.error) throw new Error(`${method} returned MCP error: ${JSON.stringify(body.error)}`);
  return body?.result;
}

const initialized = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "chusky-live-smoke", version: "1.0.0" },
});
if (!initialized?.serverInfo?.name) throw new Error("MCP initialize response did not contain serverInfo");
const tools = await rpc("tools/list", {});
const names = new Set((tools?.tools || []).map((tool) => tool.name));
for (const expected of ["chusky_agent_templates", "chusky_run_start", "chusky_run_get", "chusky_tools_list", "chusky_skills_search", "chusky_threads_list", "chusky_artifacts_list", "chusky_webhook_create", "chusky_company_usage_get"]) {
  if (!names.has(expected)) throw new Error(`MCP tool missing: ${expected}`);
}
for (const forbidden of ["chusky_approval_approve", "chusky_approval_deny"]) {
  if (names.has(forbidden)) throw new Error(`MCP approval boundary violated: ${forbidden}`);
}
const templateTool = tools?.tools?.find((tool) => tool.name === "chusky_agent_templates");
if (templateTool?.annotations?.readOnlyHint !== true) throw new Error("Read-only tool annotation missing from chusky_agent_templates");
const runTool = tools?.tools?.find((tool) => tool.name === "chusky_run_start");
if (runTool?.annotations?.readOnlyHint !== false || runTool?.annotations?.openWorldHint !== true) throw new Error("Write tool annotations missing from chusky_run_start");
const templates = await rpc("tools/call", { name: "chusky_agent_templates", arguments: {} });
if (!templates?.content?.length) throw new Error("MCP template tool returned no content");
console.log(`MCP live smoke passed: ${names.size} tools, ${initialized.serverInfo.name}, templates readable.`);
