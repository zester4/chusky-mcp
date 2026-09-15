# Chusky remote MCP server

This Cloudflare Worker exposes a remote, stateless MCP endpoint over Chusky's public `/v1` API. It does not contain an agent runtime, Composio credentials, OAuth/token storage, or a second workflow engine. Chusky remains the orchestrator; Composio continues to own connected accounts and tool execution.

## Tools

- Discover templates and list/create project-scoped company agent profiles.
- Inspect Composio-backed apps and triggers; start Composio OAuth consent flows for a connected toolkit.
- Start durable, policy-governed runs; inspect status, events, and run history; cancel or resume runs.
- Check approval status without approving; list, inspect, cancel, and retry durable tasks.
- Read per-identity usage and company-project run, audit, and monthly usage summaries.

No MCP tool approves an external action. Approval is a human decision made through the authenticated Chusky dashboard or an explicitly authorized host application. Chusky's API checks the project key's scopes, stable end-user identity, agent/project grants, budgets, and approval policy on every request. The server does not expose arbitrary upstream URLs or API paths.

## Local development

From this directory:

```sh
npm install
npm run typecheck
npm test
npm run dev
```

Set `CHUSKY_API_ORIGIN` in a local `.dev.vars` file to the Chusky backend origin (for example `http://localhost:8080`). Never place a project key in Worker configuration or `.dev.vars`; the MCP client supplies it in `Authorization: Bearer …`.

Run the deterministic live smoke check against the deployed Worker after setting
an intentionally limited project key and a test identity. It discovers tools,
asserts that the approval boundary is present, and calls the read-only template
tool; it does not start a business run:

```sh
set CHUSKY_MCP_URL=https://chusky-mcp.adesrnd.workers.dev/mcp
set CHUSKY_MCP_API_KEY=chsk_...
set CHUSKY_MCP_USER_ID=staging-smoke
npm run test:live
```

Keep this key restricted to `agents:read`. For a full staging release test, use
a separate short-lived key and exercise `chusky_run_start`, duplicate the same
idempotency key, verify the durable result, and confirm that a second identity
cannot read the first identity's private run or Composio state. Those checks
require a real Chusky staging backend with Redis, QStash, and Composio configured.

## Deploy

The checked-in `wrangler.jsonc` points at the current Chusky API origin. Confirm the correct production URL, then deploy:

```sh
npx wrangler deploy
```

Configure the MCP client with a project-scoped key created in the Chusky company workspace. The company-project defaults include app and trigger access so existing Composio connections can be used; give the key only the scopes the host actually needs—at minimum `agents:read`, `threads:read`, and `threads:write`; add `company:read` for aggregated run/audit/usage tools, `agents:write`, `apps:read`, `apps:write`, `triggers:read`, `tasks:read`, `tasks:write`, or `usage:read` only if using those tools. `approvals:write` is intentionally excluded from the company-project defaults; an MCP client can inspect status but cannot approve its own external actions. Do not use the root operator key.

Example client configuration (use the MCP URL assigned to your Worker):

```json
{
  "mcpServers": {
    "chusky": {
      "url": "https://chusky-mcp.<your-worker-subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer ${CHUSKY_API_KEY}",
        "X-Chusky-User-Id": "${CHUSKY_END_USER_ID}"
      }
    }
  }
}
```

The host application must provide a stable, non-PII identifier for each customer/end-user. Never expose a project key in browser JavaScript. Chusky scopes durable session state and Composio connected accounts to the supplied identity; if the caller uses a workspace service identity, that workspace's connected accounts must already be linked to the corresponding Chusky identity. OAuth setup and account linking remain in Composio/Chusky, not this MCP Worker.

The `/health` endpoint is a liveness check only and discloses no configuration. `/mcp` accepts only Streamable HTTP MCP; legacy transport is rejected.
