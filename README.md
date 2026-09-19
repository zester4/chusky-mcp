# Chusky remote MCP server

This Cloudflare Worker exposes a remote, stateless MCP endpoint over Chusky's public `/v1` API. It does not contain an agent runtime, Composio credentials, or a second workflow engine. Chusky remains the orchestrator; Composio continues to own connected accounts and tool execution.

Version `0.2.0` supports two authentication modes:

- Private/server-to-server mode: `Authorization: Bearer chsk_...` plus `X-Chusky-User-Id`.
- Interactive MCP mode: OAuth 2.1 authorization-code flow with S256 PKCE, dynamic client registration, encrypted provider grants, and standard protected-resource/authorization-server discovery. OAuth requires a Cloudflare KV binding named `OAUTH_KV`.

## Tools

- Discover templates and list/create project-scoped company agent profiles.
- Inspect Composio-backed apps and triggers; start Composio OAuth consent flows for a connected toolkit.
- Start durable, policy-governed runs; inspect status, events, and run history; cancel or resume runs.
- Check approval status without approving; list, inspect, cancel, and retry durable tasks.
- Read per-identity usage and company-project run, audit, and monthly usage summaries.
- Discover Chusky tools and trusted skills, revisit threads, inspect approvals, and retrieve artifact/file metadata.
- Manage agent profiles, triggers, and webhook targets when the caller has the `mcp:manage` scope.

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

For OAuth development, create a KV namespace and bind it as `OAUTH_KV` in `wrangler.jsonc`:

```sh
npx wrangler kv namespace create CHUSKY_MCP_OAUTH
```

The OAuth authorize page verifies the submitted project key against Chusky, stores the key only inside the provider's encrypted grant, and issues a short-lived MCP access token. Do not use a root operator key.

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

Configure the MCP client with a project-scoped key created in the Chusky company workspace. OAuth scopes are `mcp:read`, `mcp:run`, `mcp:manage`, and `mcp:company`; the underlying Chusky project scopes remain authoritative. `approvals:write` is intentionally excluded from the MCP surface: an MCP client can inspect status but cannot approve its own external actions. Do not use the root operator key.

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

For general MCP clients, paste the `/mcp` URL and let the client follow OAuth discovery. The client receives a `401` challenge, discovers the protected-resource metadata and authorization server, completes PKCE, and opens the Chusky consent page. For private agents that support custom headers, the shorter configuration above remains supported.

The `/health` endpoint is a liveness check only and discloses no configuration. `/mcp` accepts Streamable HTTP MCP in both the current modern wire mode and the stateless 2025-era compatibility mode. The Worker bounds upstream calls to 25 seconds, returns structured MCP content with readable text fallback, annotates tools as read-only/destructive/idempotent where applicable, and reports protocol errors without logging credentials or tool arguments.
