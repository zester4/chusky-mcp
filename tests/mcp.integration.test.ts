import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("MCP public contract keeps OAuth, identity, limits, and curated tools wired", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  for (const contract of [
    "OAuthProvider", "clientRegistrationEndpoint", "allowPlainPKCE: false", "refreshTokenTTL",
    "mcp:read", "mcp:run", "mcp:manage", "mcp:company", "structuredContent", "MCP_MAX_UPSTREAM_MS",
    "chusky_tools_list", "chusky_skills_search", "chusky_skill_read", "chusky_artifacts_list",
    "chusky_artifact_get", "chusky_file_get", "chusky_approvals_list", "chusky_threads_list",
    "chusky_agent_update", "chusky_trigger_create", "chusky_webhook_create",
  ]) assert.match(source, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), contract);
  assert.match(source, /idempotencyKey: z\.string\(\)\.min\(8\)\.max\(200\)/);
  assert.match(source, /legacy: "stateless"/);
  assert.match(source, /onerror:/);
  assert.doesNotMatch(source, /chusky_approval_(approve|deny)/);

  const registeredTools = [...source.matchAll(/registerTool\("([^"]+)"/g)].map((match) => match[1]);
  assert.equal(registeredTools.length, 63, "the public catalog should remain intentionally curated");
  for (const toolName of registeredTools) {
    assert.match(readme, new RegExp(`\\b${toolName}\\b`), `README is missing ${toolName}`);
  }
});
